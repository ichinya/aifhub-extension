// Read-only runner metrics collector (issue #230, stage 1). Aggregates
// per-request delivery snapshots, execution run records and opt-in QA results
// into a single `aifhub.runner_metrics.v1` file for the existing
// `exchange evaluation --runner-metrics` consumer. The collector never takes a
// lock, never contacts a delivery host, and never mutates execution/QA/delivery
// state: its only write is the explicitly requested observational output file.
// Metrics are never material input for execution or QA decisions.
import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { canonical, digest, identifier, portablePath, storeFor, requireValue, WorkflowError } from './workflow-state-store.mjs';
import { executionId } from './execution-task-source.mjs';
import { DELIVERY_LIMITS, TRANSPORT_KEYS, deliveryPaths, deliveryStore, requestUuid } from './host-delivery-store.mjs';
import { RUN_SCHEMA, decode } from './execution-records.mjs';
import { validateHistoricalRun } from './execution-transactions.mjs';
import { QA_LIMITS, qaStore } from './qa-manifest-store.mjs';
import { allDeclaredRoots } from './qa-manifest-inputs.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { readProviderFile, writeProviderFile } from './provider-files.mjs';
import { RUNNER_METRICS_COVERAGES, RUNNER_METRICS_REASON_CODES, RUNNER_METRICS_UNKNOWNS } from './workflow-exchange.mjs';

const RUNNER_METRICS_SCHEMA = 'aifhub.runner_metrics.v1';
const QA_RESULT_SCHEMA = 'aifhub.qa-result.v1';
const COLLECTOR_ID = 'aifhub-extension';
const EXTENSION_MANIFEST = 'extension.json';
const HEX64 = /^[a-f0-9]{64}$/;
const STATE_ROOT = '.ai-factory/state';
const DEFAULT_QA_ROOT = '.ai-factory/qa';
const DEFAULT_OUTPUT = `${STATE_ROOT}/<change>/runner-metrics.json`;
const MAX_ENTRIES = 1000;
const MAX_CONFIG_BYTES = 256 * 1024;
// Everything a runner metrics file cannot observe in v1, regardless of flags:
// phase instrumentation, tokens/cost/tool accounting and model-request totals
// all lack a producer until the stage-2 follow-up. `checks` is added only when
// the checks block itself is unavailable (opt-out or unreadable QA store).
const BASE_UNKNOWNS = Object.freeze(RUNNER_METRICS_UNKNOWNS.filter((value) => value !== 'checks'));
// Read errors that mean the scan observed a moving target (a concurrent writer)
// versus a member whose persisted content fails validation: the former is a
// scan-level inconsistency, the latter a per-member skip. Both degrade the
// collection honestly; neither silently narrows the reported sample.
const RACE_CODES = Object.freeze(new Set(['file-changed', 'unsupported-file', 'delivery-request-missing']));

const exec = promisify(execFile);

function collectorError(code) {
  const error = new Error(code);
  error.collectorCode = code;
  return error;
}

function note(notes, code) {
  notes.add(code);
}

function noteList(notes) {
  return [...notes].sort().map((code) => ({ code }));
}

const isLegacyRun = (run) => run.schema !== RUN_SCHEMA || Boolean(run.legacy);
const withinCi = (file, root) => {
  const lower = file.toLowerCase();
  return lower === root.toLowerCase() || lower.startsWith(`${root.toLowerCase()}/`);
};

function parseArguments(args) {
  const parsed = { changeId: undefined, runId: undefined, includeQa: false, output: undefined };
  let jsonOutput = false;
  let invalid = false;
  const seen = new Set();
  for (let index = 0; index < args.length && !invalid; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) { invalid = true; break; }
    seen.add(flag);
    if (flag === '--json') jsonOutput = true;
    else if (flag === '--include-qa') parsed.includeQa = true;
    else if (flag === '--change' && args[index + 1] && !args[index + 1].startsWith('--')) parsed.changeId = args[++index];
    else if (flag === '--run' && args[index + 1] && !args[index + 1].startsWith('--')) parsed.runId = args[++index];
    else if (flag === '--output' && args[index + 1] && !args[index + 1].startsWith('--')) parsed.output = args[++index];
    else invalid = true;
  }
  if (invalid || !parsed.changeId) throw collectorError('invalid_arguments');
  return { ...parsed, jsonOutput };
}

// `paths.qa` follows the same configuration approach as the active-change
// resolver: a flat `paths:` block in .ai-factory/config.yaml with a safe
// default. A malformed or missing config falls back to the default QA root;
// the output guard only needs the root, never parses further structure.
async function readConfiguredQaRoot(root) {
  try {
    const bytes = await readProviderFile(root, '.ai-factory/config.yaml', MAX_CONFIG_BYTES);
    if (bytes === null) return DEFAULT_QA_ROOT;
    const paths = {};
    let inPaths = false;
    for (const line of bytes.toString('utf8').split(/\r?\n/)) {
      if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
      if (inPaths && /^\S/.test(line)) inPaths = false;
      if (!inPaths) continue;
      const match = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/);
      if (match) paths[match[1]] = match[2].trim();
    }
    return typeof paths.qa === 'string' && paths.qa.length > 0 ? safeQaRoot(paths.qa) : DEFAULT_QA_ROOT;
  } catch { return DEFAULT_QA_ROOT; }
}

// A configured value that fails the portable-path check falls back to the
// default QA root, exactly like a malformed or missing config section.
function safeQaRoot(value) {
  try { portablePath(value); return value; } catch { return DEFAULT_QA_ROOT; }
}

async function resolveQaRoot(root) {
  return readConfiguredQaRoot(root);
}

// Declared QA input roots only exist while the change is enrolled. The guard
// is fail-closed: an enrolled change whose manifest cannot be read — or whose
// enrollment exists while the manifest pointer is missing (the producer writes
// enrollment.json before manifest.json, so a crashed publication leaves
// exactly that state) — leaves the safety of the destination unverifiable, and
// every output path is rejected until QA custody is consistent again. Only a
// change with neither enrollment nor manifest is unenrolled and contributes no
// declared roots.
async function declaredQaRoots(root, changeId, qaRoot) {
  const readPointer = async (name) => {
    try { return await readProviderFile(root, `${qaRoot}/${changeId}/${name}`, MAX_CONFIG_BYTES); }
    catch { throw collectorError('runner_metrics_output_rejected'); }
  };
  const enrollment = await readPointer('enrollment.json');
  const pointer = await readPointer('manifest.json');
  if (enrollment === null && pointer === null) return [];
  if (pointer === null) throw collectorError('runner_metrics_output_rejected');
  try {
    const store = await qaStore({ rootDir: root, changeId, qaDir: `${qaRoot}/${changeId}` });
    const manifest = await store.manifest();
    return allDeclaredRoots(manifest.payload);
  } catch { throw collectorError('runner_metrics_output_rejected'); }
}

async function gitInWorkTree(root) {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--is-inside-work-tree'],
      { cwd: root, windowsHide: true, maxBuffer: 64 * 1024, timeout: 10000 });
    return stdout.toString('utf8').trim() === 'true';
  } catch (error) {
    // Only git's own "not a repository" verdict means tracked checks are
    // vacuous. Every other failure (spawn error, permissions, dubious
    // ownership, corrupt repository) leaves the ignored/tracked status
    // unverifiable and must fail closed instead of skipping the checks.
    const stderr = String(error?.stderr ?? '');
    if (error?.code === 128 && /not a git repository/i.test(stderr)) return false;
    throw error;
  }
}

async function defaultTrackedCheck(root, output) {
  if (!await gitInWorkTree(root)) return false;
  // Inside a repository the check is authoritative and fail-closed: a failing
  // git call propagates so the guard rejects instead of assuming "untracked".
  const { stdout } = await exec('git', ['ls-files', '--cached', '-z', '--', output],
    { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 10000 });
  return stdout.split('\0').some((entry) => entry.length > 0);
}

async function outputActuallyIgnored(root, output) {
  const outcome = await exec('git', ['check-ignore', '-q', '--', output],
    { cwd: root, windowsHide: true, maxBuffer: 64 * 1024, timeout: 10000 })
    .then(() => true, (error) => {
      if (error.code === 1) return false; // git's own verdict: not ignored
      throw error; // git failed: cannot verify the destination is safe
    });
  return outcome;
}

// Known control FILE namespaces keep prefix semantics: writing below them
// would materialize a shadow directory over a control file and break every
// later reader/writer of that file. This covers status.json of every change,
// the project-wide execution lock, the active-change pointer and the exchange
// namespace. Mirrors the assertAuxiliaryPaths boundary
// (scripts/execution-task-source.mjs).
function stateNamespaceConflict(output) {
  const parts = output.slice(STATE_ROOT.length + 1).split('/');
  if (parts.length < 2) return true; // no file directly in the state root
  if (withinCi(output, `${STATE_ROOT}/exchange`)) return true;
  const head = parts[0].toLowerCase();
  if (head === 'execution-write.lock' || head === 'current.yaml') return true;
  const second = parts[1].toLowerCase();
  if (second === 'execution' || second === 'delivery') return true;
  if (second === 'status.json') return true;
  return false;
}

// General barrier behind the name rules: an output must never nest below an
// existing non-directory entry (a control file created after the rules above
// were written, or any other root-level file such as current.yaml). Unreadable
// ancestors fail closed as well.
async function assertNoFileShadow(root, output, lstatEntry) {
  const parts = output.split('/');
  let probe = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    probe = probe ? `${probe}/${parts[index]}` : parts[index];
    let info;
    try { info = await lstatEntry(path.join(root, probe)); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw collectorError('runner_metrics_output_rejected');
    }
    if (!info.isDirectory()) throw collectorError('runner_metrics_output_rejected');
  }
}

// The output must land in the fully gitignored `.ai-factory/state/**` area so
// it can never surface as an untracked changed path in a QA snapshot, and it
// must not collide with any control namespace a later reader depends on.
// Every reject happens before the first write; every unverifiable safety
// property (unreadable QA manifest, failing git check, negated gitignore rule)
// rejects as well instead of assuming the destination is safe.
async function resolveOutputPath(root, changeId, requested, options) {
  const output = requested ?? DEFAULT_OUTPUT.replace('<change>', changeId);
  const rejected = () => collectorError('runner_metrics_output_rejected');
  try { portablePath(output); } catch { throw rejected(); }
  if (!output.startsWith(`${STATE_ROOT}/`)) throw rejected();
  if (stateNamespaceConflict(output)) throw rejected();
  await assertNoFileShadow(root, output, (filename) => lstat(filename));
  const qaRoot = await resolveQaRoot(root);
  if (withinCi(output, qaRoot)) throw rejected();
  for (const declared of await declaredQaRoots(root, changeId, qaRoot)) {
    if (withinCi(output, declared)) throw rejected();
  }
  try {
    if (await gitInWorkTree(root)) {
      if (!await outputActuallyIgnored(root, output)) throw rejected();
    }
    if (await (options.trackedCheck ?? defaultTrackedCheck)(root, output)) throw rejected();
  } catch (error) {
    if (error?.collectorCode) throw error;
    throw rejected();
  }
  return output;
}

async function listEntries(store, relative) {
  let filename;
  try { filename = await store.target(relative); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  let entries;
  try { entries = await readdir(filename, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  requireValue(entries.length <= MAX_ENTRIES, 'too-many-files');
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function fileDigest(store, relative) {
  const bytes = await store.bytes(relative);
  return bytes === null ? null : digest(bytes);
}

// The race/skip classification is exported for the injection test: read errors
// that mean "the file moved under us" degrade the whole scan
// (scan_inconsistent), errors that mean "this member's bytes fail validation"
// skip only that member (member_skipped). The store spells the concurrent
// modification code `file-changed` (scripts/workflow-state-store.mjs).
export function classifyMemberError(code) {
  return RACE_CODES.has(code) ? 'scan_inconsistent' : 'member_skipped';
}

async function listUnion(store, folder) {
  const requestEntries = await listEntries(store, `${folder}/requests`);
  const journalEntries = await listEntries(store, `${folder}/delivery-journals`);
  const union = new Set();
  let unreadableNames = 0;
  for (const entry of [...requestEntries, ...journalEntries]) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) { unreadableNames += 1; continue; }
    try { requestUuid(entry.name.slice(0, -5)); } catch { unreadableNames += 1; continue; }
    union.add(entry.name.slice(0, -5));
  }
  return { union, requestScanned: requestEntries.length, journalScanned: journalEntries.length, unreadableNames };
}

// Delivery member semantics mirror `loadRequest`: the journal wins on a higher
// revision, equal revisions must agree byte-for-byte (a conflict skips the
// member), and journal-only members from an interrupted writer stay in the
// union. Nothing is ever materialized back into the registry. The directory
// union is re-listed after the content pass: a request that appears (or a
// listing entry that disappears) mid-scan marks the whole scan inconsistent
// instead of publishing a silently narrowed registry, and late-appearing
// members are still read so `requests.total` does not under-report.
async function scanMembers(delivery, store, changeId, runId, notes, memberReader) {
  const folder = `${STATE_ROOT}/${changeId}/execution`;
  const readMember = memberReader ?? ((change, uuid) => delivery.loadRequest(change, uuid));
  const first = await listUnion(store, folder);
  const uuids = [...first.union].sort();
  const digestPass = async (scope) => {
    const map = new Map();
    for (const uuid of scope) {
      const { request, journal } = deliveryPaths(changeId, uuid);
      try {
        map.set(uuid, { ok: true, value: [await fileDigest(store, request), await fileDigest(store, journal)] });
      } catch (error) {
        map.set(uuid, { ok: false, code: error?.code ?? 'unknown' });
      }
    }
    return map;
  };
  const before = await digestPass(uuids);
  const members = new Map();
  let race = false;
  for (const uuid of uuids) {
    try {
      const record = await readMember(changeId, uuid);
      members.set(uuid, { ok: true, record, recordDigest: digest(record) });
    } catch (error) {
      const code = error?.code ?? 'unknown';
      const classification = classifyMemberError(code);
      if (classification === 'scan_inconsistent') race = true;
      members.set(uuid, { ok: false, race: classification === 'scan_inconsistent', code });
    }
  }
  const after = await digestPass(uuids);
  for (const uuid of uuids) {
    const initial = before.get(uuid);
    const second = after.get(uuid);
    const stable = initial?.ok && second?.ok
      && initial.value[0] === second.value[0] && initial.value[1] === second.value[1];
    if (!stable || members.get(uuid).race) race = true;
  }
  // Late writers: reconcile the directory listing itself.
  const second = await listUnion(store, folder);
  const late = [...second.union].filter((uuid) => !first.union.has(uuid)).sort();
  for (const uuid of first.union) {
    if (!second.union.has(uuid)) race = true; // listing entry vanished mid-scan
  }
  if (late.length > 0) {
    race = true;
    const lateBefore = await digestPass(late);
    for (const uuid of late) {
      try {
        const record = await readMember(changeId, uuid);
        members.set(uuid, { ok: true, record, recordDigest: digest(record) });
      } catch (error) {
        const code = error?.code ?? 'unknown';
        members.set(uuid, { ok: false, race: classifyMemberError(code) === 'scan_inconsistent', code });
      }
    }
    const lateAfter = await digestPass(late);
    for (const uuid of late) {
      const initial = lateBefore.get(uuid);
      const final = lateAfter.get(uuid);
      const stable = initial?.ok && final?.ok
        && initial.value[0] === final.value[0] && initial.value[1] === final.value[1];
      if (!stable) race = true;
    }
  }
  if (race) note(notes, 'scan_inconsistent');
  if (runId !== undefined) {
    for (const [uuid, member] of members) {
      // A skipped member has no readable slot, so it cannot be attributed to
      // another run and stays in the sample as a conservative upper bound.
      if (member.ok && member.record.slot.run_id !== runId) members.delete(uuid);
    }
  }
  // Scanned counters reflect the final listing (the observed end state of the
  // registry), not the sum of both passes: a stable unreadable name counts
  // once, and a late-appearing member is included in the scanned counts just
  // like it is included in `requests.total`.
  return {
    members,
    requestScanned: second.requestScanned,
    journalScanned: second.journalScanned,
    race,
    unreadableNames: second.unreadableNames
  };
}

async function scanRuns(store, changeId, runId, notes, runReader) {
  const folder = `${STATE_ROOT}/${changeId}/execution/runs`;
  const readRun = runReader ?? (async (id, filename) => {
    const text = await store.textFile(filename);
    requireValue(text !== null, 'invalid-state');
    const record = decode(text);
    await validateHistoricalRun(store, record);
    requireValue(record.run_id === id && record.change_id === changeId, 'invalid-run-catalogue');
    return record;
  });
  const readBatch = async (entries) => {
    const runs = [];
    let skipped = 0;
    for (const entry of entries) {
      const fail = () => { skipped += 1; note(notes, 'member_skipped'); };
      if (!entry.isFile() || !entry.name.endsWith('.json')) { fail(); continue; }
      const id = entry.name.slice(0, -5);
      try {
        identifier(id);
        const record = await readRun(id, `${folder}/${entry.name}`);
        if (runId !== undefined && record.run_id !== runId) continue;
        runs.push(record);
      } catch { fail(); }
    }
    return { runs, skipped };
  };
  const first = await listEntries(store, folder);
  const { runs, skipped } = await readBatch(first);
  // Same completeness rule as the delivery members: a run published mid-scan
  // is read and joins attribution instead of silently narrowing the sample,
  // and any listing change marks the scan inconsistent.
  const second = await listEntries(store, folder);
  let race = false;
  const late = second.filter((entry) => !first.some((entry2) => entry2.name === entry.name));
  for (const entry of first) {
    if (!second.some((entry2) => entry2.name === entry.name)) race = true;
  }
  if (late.length > 0) {
    race = true;
    const more = await readBatch(late);
    runs.push(...more.runs);
  }
  if (race) note(notes, 'scan_inconsistent');
  return { runs, scanned: second.length, skipped, race };
}

function pendingObservedMs(validMembers) {
  // Dwell of the `pending` phase across recorded delivery history. This is a
  // host-wait observation from timestamps the producer already wrote — not
  // compute time and not human review time.
  let total = 0;
  for (const member of validMembers) {
    const record = member.record;
    for (let index = 0; index < record.history.length; index += 1) {
      if (record.history[index].phase !== 'pending') continue;
      const start = Date.parse(record.history[index].at);
      const end = index + 1 < record.history.length
        ? Date.parse(record.history[index + 1].at)
        : Date.parse(record.updated_at);
      total += Math.max(0, end - start);
    }
  }
  return total;
}

// Structural validation of exactly the qa-result fields the projection
// consumes. The QA store already guarantees checksum integrity; anything that
// fails here fails the whole opt-in block (all-or-nothing), because a partial
// per-member recovery would duplicate store invariants.
function qaDependency(record) {
  requireValue(record && typeof record === 'object' && !Array.isArray(record), 'invalid-qa-result');
  requireValue(record.schema === QA_RESULT_SCHEMA, 'invalid-qa-result');
  identifier(record.check_id);
  identifier(record.wave_id);
  requireValue(typeof record.manifest_digest === 'string' && HEX64.test(record.manifest_digest), 'invalid-qa-result');
  requireValue(record.supersedes === null || record.supersedes === undefined || typeof record.supersedes === 'string', 'invalid-qa-result');
  requireValue(record.binding_code === null || record.binding_code === undefined
    || (typeof record.binding_code === 'string' && record.binding_code.length > 0), 'invalid-qa-result');
  const fingerprint = record.input_fingerprints?.[record.check_id];
  requireValue(typeof fingerprint === 'string' && HEX64.test(fingerprint), 'invalid-qa-result');
  return { check_id: record.check_id, manifest_digest: record.manifest_digest, wave_id: record.wave_id, input_fingerprint: fingerprint };
}

// Pure projection of the checks block: repeated-check counts from superseding
// qa-results, reason counts restricted to the closed allow-list (open binding
// codes collapse into `unknown`, absent evidence contributes nothing), and the
// bounded dependency list (ids and digests only, never paths).
export function projectChecks(qaRecords, { deliveryMembers = [], runs = [] } = {}, notes = new Set()) {
  const reasons = new Map();
  const bump = (code) => reasons.set(code, (reasons.get(code) ?? 0) + 1);
  let repeated = 0;
  const dependencies = new Map();
  for (const record of qaRecords) {
    const dependency = qaDependency(record);
    if (record.supersedes !== null && record.supersedes !== undefined) repeated += 1;
    if (typeof record.binding_code === 'string' && record.binding_code.length > 0) {
      bump(RUNNER_METRICS_REASON_CODES.includes(record.binding_code) ? record.binding_code : 'unknown');
    }
    if (!dependencies.has(dependency.check_id)) dependencies.set(dependency.check_id, dependency);
  }
  for (const member of deliveryMembers) if (member.record.recovery) bump(member.record.recovery.type);
  for (const run of runs) if (run.recovery) bump(run.recovery.reason);
  let entries = [...dependencies.values()].sort((a, b) => (a.check_id < b.check_id ? -1 : a.check_id > b.check_id ? 1 : 0));
  if (entries.length > QA_LIMITS.checks) {
    entries = entries.slice(0, QA_LIMITS.checks);
    note(notes, 'dependencies_truncated');
  }
  return {
    results: qaRecords.length,
    repeated,
    reasons: [...reasons.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([code, count]) => ({ code, count })),
    dependencies: entries
  };
}

async function collectorVersion(root) {
  try {
    const bytes = await readProviderFile(root, EXTENSION_MANIFEST, 1024 * 1024);
    if (bytes === null) return 'unknown';
    const manifest = parseStrictJson(bytes.toString('utf8'));
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch { return 'unknown'; }
}

export async function collectRunnerMetrics(options = {}) {
  const notes = new Set();
  try {
    const root = path.resolve(options.rootDir ?? process.cwd());
    const args = options.argv ?? [];
    const parsed = parseArguments(args);
    let changeId;
    let runId;
    try {
      changeId = executionId(parsed.changeId);
      runId = parsed.runId === undefined ? undefined : identifier(parsed.runId);
    } catch (error) {
      if (error instanceof WorkflowError) throw collectorError('invalid_arguments');
      throw error;
    }
    const output = await resolveOutputPath(root, changeId, parsed.output, options);
    const store = await storeFor(root);
    const delivery = await deliveryStore({ rootDir: root });
    const scan = await scanMembers(delivery, store, changeId, runId, notes, options.memberReader);
    const runScan = await scanRuns(store, changeId, runId, notes, options.runReader);
    if (runId !== undefined && scan.members.size === 0 && runScan.runs.length === 0) note(notes, 'run_filter_empty');
    const validMembers = [...scan.members.values()].filter((member) => member.ok);
    const membersSkipped = scan.members.size - validMembers.length + runScan.skipped + scan.unreadableNames;
    if (membersSkipped > 0) note(notes, 'member_skipped');
    const degraded = membersSkipped > 0 || scan.race || runScan.race;

    // Snapshot dedup is implicit: each UUID contributes its single resolved
    // image exactly once; revisions are never summed and per-counter maxima
    // are never combined. An open interval is a crashed operation the producer
    // has not counted yet, so the collector adds one without mutating state.
    const transport = Object.fromEntries(TRANSPORT_KEYS.map((key) => [key, 0]));
    for (const member of validMembers) {
      for (const key of TRANSPORT_KEYS) transport[key] += member.record.transport[key];
    }
    transport.incomplete_intervals += validMembers.filter((member) => member.record.interval !== null).length;

    // Response dedup: one host id observed by several UUIDs is one host-side
    // response serving repeated local operations. It never reduces the
    // transport counters of any UUID, and body digests never dedupe requests.
    const hostIds = new Map();
    for (const member of validMembers) {
      const record = member.record;
      const id = record.target.kind === 'message' ? record.host.message_id : record.host.completion_id;
      if (typeof id !== 'string' || id.length === 0) continue;
      const key = `${record.host.namespace_digest ?? ''}|${record.target.kind}|${id}`;
      hostIds.set(key, (hostIds.get(key) ?? 0) + 1);
    }
    const duplicateResponses = [...hostIds.values()].reduce((sum, count) => sum + (count >= 2 ? count - 1 : 0), 0);

    const requests = {
      total: scan.members.size,
      verified: validMembers.filter((member) => member.record.phase === 'verified').length,
      retried: validMembers.filter((member) => member.record.transport.retry_creates > 0).length,
      recovered: validMembers.filter((member) => member.record.transport.verified_recoveries > 0).length,
      incomplete: validMembers.filter((member) => member.record.phase !== 'verified' || member.record.interval !== null).length,
      duplicate_responses: duplicateResponses,
      by_kind: {
        message: validMembers.filter((member) => member.record.target.kind === 'message').length,
        completion: validMembers.filter((member) => member.record.target.kind === 'completion').length
      }
    };

    // Execution attribution across the sampled runs: with more than one run
    // the per-run fields are intentionally null (a run-level aggregate cannot
    // name a single coordinator/worker); legacy records carry no run kind.
    const runIds = new Set();
    for (const member of validMembers) runIds.add(member.record.slot.run_id);
    for (const run of runScan.runs) runIds.add(run.run_id);
    const taskIds = new Set();
    for (const member of validMembers) taskIds.add(member.record.slot.task_id);
    for (const run of runScan.runs) {
      if (run.task_id !== null && run.task_id !== undefined) taskIds.add(run.task_id);
      // Batch runs carry their task vocabulary in the manifest/items map, not
      // in run.task_id (which is null there); counting from the run record
      // keeps `attribution.tasks` independent of delivery coverage.
      if (run.kind === 'batch') for (const taskId of Object.keys(run.items ?? {})) taskIds.add(taskId);
    }
    const singleRun = runIds.size === 1 ? runScan.runs.find((run) => run.run_id === [...runIds][0]) ?? null : null;
    const attribution = {
      coordinator: singleRun ? singleRun.owner : null,
      worker: singleRun ? singleRun.worker : null,
      role: singleRun ? singleRun.role : null,
      run_kind: singleRun && !isLegacyRun(singleRun) ? singleRun.kind : null,
      runs: runIds.size,
      tasks: taskIds.size
    };

    // Derived record-span durations: names are deliberately not measurable
    // duration names (`run_wall_ms` is banned). Spans come from run-record
    // timestamps, not from any phase instrumentation, and exclude legacy
    // records without timestamps as well as records with an inverted clock
    // (updated_at before created_at, e.g. a backward clock adjustment) whose
    // span would be negative and therefore unusable.
    const spanRuns = runScan.runs.filter((run) => !isLegacyRun(run)
      && Date.parse(run.updated_at) >= Date.parse(run.created_at));
    const phases = {
      setup_ms: null,
      checks_ms: null,
      snapshot_hash_ms: null,
      wait_ms: null,
      run_elapsed_ms: null,
      run_record_span_ms: spanRuns.length
        ? Math.max(...spanRuns.map((run) => Date.parse(run.updated_at))) - Math.min(...spanRuns.map((run) => Date.parse(run.created_at)))
        : null,
      workers_span_sum_ms: spanRuns.length
        ? spanRuns.reduce((sum, run) => sum + (Date.parse(run.updated_at) - Date.parse(run.created_at)), 0)
        : null,
      pending_observed_ms: pendingObservedMs(validMembers),
      transport_ms: transport.transport_ms,
      recovery_ms: transport.recovery_ms
    };

    let checks = null;
    let qaScanned = null;
    if (parsed.includeQa) {
      const qaRoot = await resolveQaRoot(root);
      try {
        const qStore = await qaStore({ rootDir: root, changeId, qaDir: `${qaRoot}/${changeId}` });
        const records = await qStore.results();
        qaScanned = records.length;
        checks = projectChecks(records, { deliveryMembers: validMembers, runs: runScan.runs }, notes);
      } catch {
        checks = null;
        qaScanned = null;
        note(notes, 'qa_results_unreadable');
      }
    }

    const unknowns = new Set(BASE_UNKNOWNS);
    if (checks === null) unknowns.add('checks');

    const registryImage = [...scan.members.keys()].sort().map((uuid) => {
      const member = scan.members.get(uuid);
      return { request_uuid: uuid, record_digest: member.ok ? member.recordDigest : null };
    });
    const metrics = {
      schema: RUNNER_METRICS_SCHEMA,
      run_id: runIds.size === 1 ? [...runIds][0] : null,
      tokens: null,
      transport,
      attribution,
      requests,
      checks,
      phases,
      provenance: {
        requests_scanned: scan.requestScanned,
        journals_scanned: scan.journalScanned,
        runs_scanned: runScan.scanned,
        qa_results_scanned: qaScanned,
        members_skipped: membersSkipped,
        registry_digest: digest(canonical(registryImage)),
        collector: { id: COLLECTOR_ID, version: await collectorVersion(root) }
      },
      unknowns: [...unknowns].sort(),
      coverage: parsed.includeQa ? RUNNER_METRICS_COVERAGES[1] : RUNNER_METRICS_COVERAGES[0]
    };
    await writeProviderFile(root, output, metrics);
    const qaUnreadable = notes.has('qa_results_unreadable');
    return {
      ok: !(degraded || qaUnreadable),
      outcome: degraded || qaUnreadable ? 'degraded' : 'collected',
      written: output,
      notes: noteList(notes),
      errors: [],
      metrics
    };
  } catch (error) {
    const code = error?.collectorCode ?? 'runner_metrics_collect_failed';
    return { ok: false, outcome: 'failed', written: null, notes: noteList(notes), errors: [{ code }] };
  }
}

export async function runCollectorCommand(argv = process.argv.slice(2), options = {}) {
  const jsonOutput = argv.includes('--json');
  const result = await collectRunnerMetrics({ ...options, argv });
  const exitCode = result.outcome === 'failed' ? 2 : result.ok ? 0 : 1;
  const errors = result.errors ?? [];
  const output = jsonOutput
    ? `${JSON.stringify({ ok: result.ok, outcome: result.outcome, written: result.written, notes: result.notes, errors, metrics: result.metrics ?? null }, null, 2)}\n`
    : `Runner metrics: ${result.outcome}\n${errors.map((error) => error.code).join('\n')}${errors.length ? '\n' : ''}${result.notes.length ? `notes: ${result.notes.map((entry) => entry.code).join(', ')}\n` : ''}${result.written ? `written: ${result.written}\n` : ''}`;
  (options.stdout ?? process.stdout).write(output);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCollectorCommand();
}
