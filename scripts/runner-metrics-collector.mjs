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
import { canonical, digest, fields, identifier, portablePath, storeFor, requireValue, WorkflowError } from './workflow-state-store.mjs';
import { executionId } from './execution-task-source.mjs';
import { DELIVERY_LIMITS, TRANSPORT_KEYS, deliveryPaths, deliveryStore, requestUuid } from './host-delivery-store.mjs';
import { RUN_SCHEMA, decode, validateLedger } from './execution-records.mjs';
import { validateHistoricalRun } from './execution-transactions.mjs';
import { QA_LIMITS, qaStore } from './qa-manifest-store.mjs';
import { allDeclaredRoots } from './qa-manifest-inputs.mjs';
import { QA_RERUN_REASON_CODES } from './qa-manifest-record.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { readProviderFile, writeProviderFile } from './provider-files.mjs';
import { RUNNER_METRICS_COVERAGES, RUNNER_METRICS_REASON_CODES, RUNNER_METRICS_UNKNOWNS, validateRunnerMetrics } from './workflow-exchange.mjs';

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
// cost/tool accounting, unlogged requests, coordinator accounting and billing
// still lack any producer. `checks` is added only when the checks block itself
// is unavailable (opt-out or unreadable QA store). Stage-2 (#270) producers
// cover the measurable phases, tokens/tool_calls/model_requests and the
// tools/dedup stubs, so those markers are removed per-record by the coverage
// rules below — never wholesale.
const BASE_UNKNOWNS = Object.freeze(RUNNER_METRICS_UNKNOWNS.filter((value) =>
  !['checks', 'setup_ms', 'checks_ms', 'snapshot_hash_ms', 'run_elapsed', 'tokens', 'tool_calls', 'model_requests'].includes(value)));
const USAGE_TOKEN_DIMENSIONS = Object.freeze(['input', 'output', 'total', 'cache_read', 'cache_write', 'reasoning']);
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

// Git reads repository location from the environment; a bogus GIT_DIR (or
// work-tree/index override) can make even an existing repository answer
// "not a git repository", which would silently skip the ignored/tracked
// checks. The collector always asks git about the pristine project root, so
// those overrides are stripped for every call.
function gitEnv() {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS']) delete env[key];
  return env;
}

async function gitInWorkTree(root) {
  let verdict;
  try {
    verdict = await exec('git', ['rev-parse', '--is-inside-work-tree'],
      { cwd: root, env: gitEnv(), windowsHide: true, maxBuffer: 64 * 1024, timeout: 10000 });
  } catch (error) {
    if (error?.code !== 128) throw error;
    // Exit 128 has two very different meanings: an honest "no repository
    // here" (no .git entry — tracked checks are vacuous) versus a repository
    // entry git refuses to read (corrupt .git directory or gitfile, blocked
    // by permissions — the ignored/tracked status is unverifiable and the
    // guard must fail closed). The message is locale-dependent; the presence
    // of the .git entry is not.
    let dotGit = null;
    try { dotGit = await lstat(path.join(root, '.git')); } catch (statError) {
      if (statError?.code !== 'ENOENT') throw error;
    }
    if (dotGit !== null) throw error;
    return false;
  }
  return verdict.stdout.toString('utf8').trim() === 'true';
}

async function defaultTrackedCheck(root, output) {
  if (!await gitInWorkTree(root)) return false;
  // Inside a repository the check is authoritative and fail-closed: a failing
  // git call propagates so the guard rejects instead of assuming "untracked".
  const { stdout } = await exec('git', ['ls-files', '--cached', '-z', '--', output],
    { cwd: root, env: gitEnv(), windowsHide: true, maxBuffer: 1024 * 1024, timeout: 10000 });
  return stdout.split('\0').some((entry) => entry.length > 0);
}

async function outputActuallyIgnored(root, output) {
  const outcome = await exec('git', ['check-ignore', '-q', '--', output],
    { cwd: root, env: gitEnv(), windowsHide: true, maxBuffer: 64 * 1024, timeout: 10000 })
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
function stateNamespaceConflict(output, changeId) {
  const parts = output.slice(STATE_ROOT.length + 1).split('/');
  if (parts.length < 2) return true; // no file directly in the state root
  if (parts[0].toLowerCase() !== changeId.toLowerCase()) return true; // another change runtime namespace
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

// The leaf itself is part of the boundary: the only pre-existing content a
// metrics destination may hold is a previous runner-metrics output. Anything
// else already sitting at the path (review receipts, tracer decisions,
// plan-compliance receipts, unrelated files) must not be silently replaced.
async function assertLeafIsMetricsOutput(root, output) {
  let info;
  try { info = await lstat(path.join(root, output)); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw collectorError('runner_metrics_output_rejected');
  }
  if (!info.isFile()) throw collectorError('runner_metrics_output_rejected');
  try {
    const bytes = await readProviderFile(root, output, 4 * 1024 * 1024);
    const parsed = bytes === null ? null : parseStrictJson(bytes.toString('utf8'));
    if (parsed?.schema !== RUNNER_METRICS_SCHEMA) throw collectorError('runner_metrics_output_rejected');
  } catch (error) {
    if (error?.collectorCode) throw error;
    throw collectorError('runner_metrics_output_rejected');
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
  if (stateNamespaceConflict(output, changeId)) throw rejected();
  await assertNoFileShadow(root, output, (filename) => lstat(filename));
  await assertLeafIsMetricsOutput(root, output);
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
  // Run records are rewritten on every transition, so like the delivery
  // members each scanned file gets a digest before/after its content read: a
  // record updated mid-scan (stable name, new revision) must not survive as a
  // silently mixed slice.
  const digestPass = async (entries) => {
    const map = new Map();
    for (const entry of entries) {
      try { map.set(entry.name, { ok: true, value: await fileDigest(store, `${folder}/${entry.name}`) }); } catch (error) {
        map.set(entry.name, { ok: false, code: error?.code ?? 'unknown' });
      }
    }
    return map;
  };
  const stableDigests = (first, second) => {
    for (const [name, initial] of first) {
      const final = second.get(name);
      if (!initial.ok || !final?.ok || initial.value !== final.value) return false;
    }
    return true;
  };
  const first = await listEntries(store, folder);
  const before = await digestPass(first);
  const { runs, skipped: firstSkipped } = await readBatch(first);
  let skipped = firstSkipped;
  const after = await digestPass(first);
  let race = !stableDigests(before, after);
  // Same completeness rule as the delivery members: a run published mid-scan
  // is read and joins attribution instead of silently narrowing the sample,
  // and any listing change marks the scan inconsistent.
  const second = await listEntries(store, folder);
  const late = second.filter((entry) => !first.some((entry2) => entry2.name === entry.name));
  for (const entry of first) {
    if (!second.some((entry2) => entry2.name === entry.name)) race = true;
  }
  if (late.length > 0) {
    race = true;
    const lateBefore = await digestPass(late);
    const more = await readBatch(late);
    skipped += more.skipped;
    runs.push(...more.runs);
    const lateAfter = await digestPass(late);
    if (!stableDigests(lateBefore, lateAfter)) race = true;
  }
  if (race) note(notes, 'scan_inconsistent');
  return { runs, scanned: second.length, skipped, race };
}

// The fix-attempts ledger is a declared input (#270, R12): a single targeted
// read of the change's ledger file — never a recursive inventory walk. The
// digest-before/after pattern mirrors scanRuns; an observed change degrades
// the scan instead of mixing ledger snapshots. Ledger failures are not
// delivery/run members: they carry their own notes and never zero out
// successfully read QA counts.
async function scanLedger(store, changeId, runId, notes, ledgerReader) {
  const relative = `${STATE_ROOT}/${changeId}/execution/fix-attempts.json`;
  const read = ledgerReader ?? (() => store.bytes(relative));
  let bytes;
  try { bytes = await read(); } catch { note(notes, 'ledger_unreadable'); return { status: 'unreadable', attempts: null }; }
  if (bytes === null) {
    // Absence is confirmed with a second read: a ledger created between the
    // two reads is a moving target (scan_inconsistent), never an honest
    // absence — the SHALL scenario "created/deleted/changed between reads"
    // covers all three directions.
    let confirm;
    try { confirm = await read(); } catch { note(notes, 'ledger_unreadable'); return { status: 'unreadable', attempts: null }; }
    if (confirm !== null) { note(notes, 'scan_inconsistent'); return { status: 'race', attempts: null }; }
    note(notes, 'ledger_absent');
    return { status: 'absent', attempts: null };
  }
  const before = digest(bytes);
  let ledger;
  try { ledger = validateLedger(decode(bytes.toString('utf8'))); } catch { note(notes, 'ledger_invalid'); note(notes, 'member_skipped'); return { status: 'invalid', attempts: null }; }
  let after;
  try { after = await read(); } catch { note(notes, 'ledger_unreadable'); return { status: 'unreadable', attempts: null }; }
  if (after === null || digest(after) !== before) { note(notes, 'scan_inconsistent'); return { status: 'race', attempts: null }; }
  const attempts = runId === undefined ? ledger.attempts : ledger.attempts.filter((attempt) => attempt.run_id === runId);
  return { status: 'ok', attempts };
}

// Stage-2 measured phases (#270): per-record producers with per-record
// coverage. `values` are per-record measurements or null (absent timing,
// incomplete interval, inverted stamps); a scalar is published as a sum only
// when every relevant record carries a measured value and the set is
// non-empty — partial coverage stays null behind its marker (R7).
function measuredPhaseSum(values) {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) {
    if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
    total += value;
  }
  return Number.isSafeInteger(total) ? total : null;
}

const timingComplete = (timing) => Boolean(timing) && timing.complete === true
  && Number.isSafeInteger(timing.elapsed_ms) && timing.elapsed_ms >= 0;
const setupMsOf = (run) => timingComplete(run.timings?.setup) ? run.timings.setup.elapsed_ms : null;
// run_elapsed_ms is a measured envelope over run-record stamps: last − first
// across mutating commands. It includes idle time between commands and is
// never a compute sum; a single stamp or an inverted clock pair yields null.
const runElapsedOf = (run) => {
  const stamps = run.timings?.stamps;
  if (!Array.isArray(stamps) || stamps.length < 2) return null;
  const first = Date.parse(stamps[0].at);
  const last = Date.parse(stamps[stamps.length - 1].at);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return last - first;
};
// The checks interval measures the verifier process of a host-observed run
// (contract SHALL): a timing attached to an agent-authored/imported record is
// not attributable to any verifier and contributes nothing to the sum — the
// coverage stays broken behind its marker (review round 2). The snapshot-hash
// timing, by contrast, measures the record's own binding work, which every
// bound record genuinely performs.
const qaChecksMsOf = (record) => record.execution?.kind === 'host-observed'
  && timingComplete(record.metadata?.timings?.checks) ? record.metadata.timings.checks.elapsed_ms : null;
const qaSnapshotMsOf = (record) => timingComplete(record.metadata?.timings?.snapshot_hash) ? record.metadata.timings.snapshot_hash.elapsed_ms : null;

// Usage aggregation (#270, R9): overwrite per accounting key is already
// guaranteed by the single resolved image per UUID. Scope comes from the
// persisted `usage_scope` sibling, never from a digest guess. Every sampled
// record must carry usage; each dimension is summed only under full coverage.
function aggregateUsage(validMembers, membersSkipped) {
  const markers = new Set(['tokens', 'tool_calls', 'model_requests']);
  const result = { tokens: null, tool_calls: null, model_requests: null };
  if (membersSkipped > 0) return { result, markers }; // unprovable completeness: stay conservative
  if (validMembers.length === 0) return { result, markers };
  const sampled = validMembers.map((member) => member.record);
  const withUsage = sampled.filter((record) => record.usage && record.usage_scope);
  if (withUsage.length !== sampled.length) return { result, markers };
  const scopes = new Set(withUsage.map((record) => record.usage_scope));
  if (scopes.size !== 1) return { result, markers };
  const scope = [...scopes][0];
  const dimValue = (usage, path) => {
    let value = usage;
    for (const key of path) { value = value?.[key]; }
    return value === undefined ? null : value;
  };
  const dims = [...USAGE_TOKEN_DIMENSIONS.map((d) => ['tokens', d]), ['tool_calls'], ['model_requests']];
  let sources = withUsage.map((record) => ({ usage: record.usage }));
  if (scope === 'response') {
    // Response-scoped accounting: records without a host id are not
    // attributable (coverage is unprovable), copies of one response are
    // counted once and must agree — a contradiction nulls the affected sums.
    const responses = new Map();
    for (const record of withUsage) {
      const id = record.target.kind === 'message' ? record.host.message_id : record.host.completion_id;
      if (typeof id !== 'string' || id.length === 0) return { result, markers };
      const key = `${record.host.namespace_digest ?? ''}|${record.target.kind}|${id}`;
      const existing = responses.get(key);
      if (existing && canonical(existing) !== canonical(record.usage)) return { result, markers };
      responses.set(key, record.usage);
    }
    sources = [...responses.values()].map((usage) => ({ usage }));
  }
  const tokens = {};
  let tokensCovered = true;
  for (const dimension of USAGE_TOKEN_DIMENSIONS) {
    const path = ['tokens', dimension];
    let sum = 0;
    let covered = true;
    for (const { usage } of sources) {
      const value = dimValue(usage, path);
      if (value === null || !Number.isSafeInteger(value) || value < 0) { covered = false; break; }
      sum += value;
    }
    tokens[dimension] = covered && Number.isSafeInteger(sum) ? sum : null;
    if (!covered) tokensCovered = false;
  }
  const flat = (path) => {
    let sum = 0;
    let covered = true;
    for (const { usage } of sources) {
      const value = dimValue(usage, path);
      if (value === null || !Number.isSafeInteger(value) || value < 0) { covered = false; break; }
      sum += value;
    }
    return covered && Number.isSafeInteger(sum) ? sum : null;
  };
  // A tokens block is published only when at least one dimension carries a
  // measured sum; fully unknown dimensions stay null behind the marker.
  const measuredDims = USAGE_TOKEN_DIMENSIONS.filter((d) => tokens[d] !== null);
  result.tokens = measuredDims.length > 0 ? tokens : null;
  result.tool_calls = flat(['tool_calls']);
  result.model_requests = flat(['model_requests']);
  if (USAGE_TOKEN_DIMENSIONS.some((d) => tokens[d] === null)) markers.add('tokens'); else markers.delete('tokens');
  if (result.tool_calls === null) markers.add('tool_calls'); else markers.delete('tool_calls');
  if (result.model_requests === null) markers.add('model_requests'); else markers.delete('model_requests');
  return { result, markers };
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
const isoTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const intMs = (value) => Number.isSafeInteger(value) && value >= 0;
// Closed-shape validation of the optional stage-2 metadata (#270). Malformed
// metadata throws: the QA block is all-or-nothing, exactly like stage 1.
function validateQaMetadata(metadata) {
  fields(metadata, ['recorded_at'], ['rerun_reason', 'execution_run_id', 'timings']);
  requireValue(isoTime(metadata.recorded_at), 'invalid-qa-result');
  // The producer writes only the five causal rerun codes; a forged record
  // carrying an outcome code (e.g. 'passed') in rerun_reason is malformed
  // metadata, not a causal sample (review: validate by the producer subset).
  if (metadata.rerun_reason !== undefined) requireValue(QA_RERUN_REASON_CODES.includes(metadata.rerun_reason), 'invalid-qa-result');
  if (metadata.execution_run_id !== undefined) identifier(metadata.execution_run_id);
  if (metadata.timings !== undefined) {
    const timings = metadata.timings;
    fields(timings, [], ['checks', 'snapshot_hash']);
    for (const [key, withOperations] of [['checks', false], ['snapshot_hash', true]]) {
      const timing = timings[key];
      if (timing === undefined) continue;
      fields(timing, ['started_at', 'ended_at', 'elapsed_ms', 'complete', ...(withOperations ? ['operations'] : [])]);
      requireValue(isoTime(timing.started_at) && isoTime(timing.ended_at) && intMs(timing.elapsed_ms)
        && typeof timing.complete === 'boolean'
        && (!withOperations || intMs(timing.operations)), 'invalid-qa-result');
    }
  }
}
function qaDependency(record) {
  requireValue(record && typeof record === 'object' && !Array.isArray(record), 'invalid-qa-result');
  requireValue(record.schema === QA_RESULT_SCHEMA, 'invalid-qa-result');
  identifier(record.check_id);
  identifier(record.wave_id);
  requireValue(typeof record.manifest_digest === 'string' && HEX64.test(record.manifest_digest), 'invalid-qa-result');
  requireValue(record.supersedes === null || record.supersedes === undefined || typeof record.supersedes === 'string', 'invalid-qa-result');
  requireValue(record.binding_code === null || record.binding_code === undefined
    || (typeof record.binding_code === 'string' && record.binding_code.length > 0), 'invalid-qa-result');
  if (record.metadata !== undefined) validateQaMetadata(record.metadata);
  const fingerprint = record.input_fingerprints?.[record.check_id];
  requireValue(typeof fingerprint === 'string' && HEX64.test(fingerprint), 'invalid-qa-result');
  return { check_id: record.check_id, manifest_digest: record.manifest_digest, wave_id: record.wave_id, input_fingerprint: fingerprint };
}

// Pure projection of the checks block: repeated-check counts from superseding
// qa-results, reason counts restricted to the closed allow-list (open binding
// codes collapse into `unknown`, absent evidence contributes nothing), and the
// bounded dependency list (ids and digests only, never paths).
export function projectChecks(qaRecords, { deliveryMembers = [], runs = [], ledgerAttempts = [] } = {}, notes = new Set()) {
  const reasons = new Map();
  const bump = (code) => reasons.set(code, (reasons.get(code) ?? 0) + 1);
  let repeated = 0;
  const dependencies = new Map();
  for (const record of qaRecords) {
    const dependency = qaDependency(record);
    if (record.supersedes !== null && record.supersedes !== undefined) repeated += 1;
    // One reason sample per record. An explicit causal rerun_reason outranks
    // the indirect binding_code; ledger outcomes are a separate source below
    // — "reasons are counters by source", never deduplicated across sources.
    if (typeof record.metadata?.rerun_reason === 'string') {
      bump(record.metadata.rerun_reason);
    } else if (typeof record.binding_code === 'string' && record.binding_code.length > 0) {
      bump(RUNNER_METRICS_REASON_CODES.includes(record.binding_code) ? record.binding_code : 'unknown');
    } else if (record.supersedes !== null && record.supersedes !== undefined) {
      // A corrective rerun without any recorded reason is an unknown-cause
      // sample: the collector covers it with `unknown` exactly as documented.
      bump('unknown');
    }
    if (!dependencies.has(dependency.check_id)) dependencies.set(dependency.check_id, dependency);
  }
  for (const member of deliveryMembers) if (member.record.recovery) bump(member.record.recovery.type);
  for (const run of runs) if (run.recovery) bump(run.recovery.reason);
  // Ledger outcomes (#270): each attempt contributes exactly one outcome
  // sample over the current snapshot. Hypothesis/check/environment/inputs and
  // paths never leave the project-internal ledger file.
  for (const attempt of ledgerAttempts) bump(attempt.outcome);
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
    const ledgerScan = await scanLedger(store, changeId, runId, notes, options.ledgerReader);
    if (runId !== undefined && scan.members.size === 0 && runScan.runs.length === 0) note(notes, 'run_filter_empty');
    const validMembers = [...scan.members.values()].filter((member) => member.ok);
    const membersSkipped = scan.members.size - validMembers.length + runScan.skipped + scan.unreadableNames;
    if (membersSkipped > 0) note(notes, 'member_skipped');
    // Ledger failures degrade through their own notes; they never enter
    // provenance.members_skipped and never zero out read QA counts.
    const ledgerDegraded = ['invalid', 'unreadable', 'race'].includes(ledgerScan.status);
    const degraded = membersSkipped > 0 || scan.race || runScan.race || ledgerDegraded;

    // Snapshot dedup is implicit: each UUID contributes its single resolved
    // image exactly once; revisions are never summed and per-counter maxima
    // are never combined. An open interval is a crashed operation the producer
    // has not counted yet, so the collector adds one without mutating state.
    const transport = Object.fromEntries(TRANSPORT_KEYS.map((key) => [key, 0]));
    for (const member of validMembers) {
      for (const key of TRANSPORT_KEYS) transport[key] += member.record.transport[key];
    }
    transport.incomplete_intervals += validMembers.filter((member) => member.record.interval !== null).length;

    // Stage-2 usage accounting (#270): what the host reported, aggregated only
    // under provable coverage (R9). `cost`/`billing`/`unlogged_requests`/
    // `coordinator_accounting` keep their markers — no source exists.
    const usage = aggregateUsage(validMembers, membersSkipped);

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
    // Stage-2 measured phases (#270): setup and run_elapsed sum over the
    // sampled non-legacy run records; checks and snapshot_hash sum over the
    // sampled qa records. Partial coverage stays null behind its marker. A
    // skipped run record makes the sampled scope unprovable — one measured
    // run next to one damaged record must never publish a sum, exactly like
    // aggregateUsage stays conservative under members_skipped.
    const timingScopeProvable = runScan.skipped === 0;
    const measuredRuns = runScan.runs.filter((run) => !isLegacyRun(run));
    const runElapsedValues = measuredRuns.map((run) => runElapsedOf(run));
    // An inverted stamp pair (last before first across processes) is per-record
    // null — it must never reach the intOrNull contract as a negative number.
    const phases = {
      setup_ms: timingScopeProvable ? measuredPhaseSum(measuredRuns.map((run) => setupMsOf(run))) : null,
      checks_ms: null,
      snapshot_hash_ms: null,
      wait_ms: null,
      run_elapsed_ms: timingScopeProvable
        ? measuredPhaseSum(runElapsedValues.map((value) => (value !== null && value >= 0 ? value : null)))
        : null,
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
    let qaRecords = [];
    if (parsed.includeQa) {
      const qaRoot = await resolveQaRoot(root);
      try {
        const qStore = await qaStore({ rootDir: root, changeId, qaDir: `${qaRoot}/${changeId}` });
        qaRecords = await qStore.results();
        qaScanned = qaRecords.length;
        checks = projectChecks(qaRecords, { deliveryMembers: validMembers, runs: runScan.runs,
          ledgerAttempts: ledgerScan.attempts ?? [] }, notes);
      } catch {
        checks = null;
        qaScanned = null;
        qaRecords = [];
        note(notes, 'qa_results_unreadable');
      }
    }
    phases.checks_ms = measuredPhaseSum(qaRecords.map((record) => qaChecksMsOf(record)));
    phases.snapshot_hash_ms = measuredPhaseSum(qaRecords.map((record) => qaSnapshotMsOf(record)));

    // Per-record unknown/zero honesty (#270): a marker leaves only when every
    // relevant record in the selected scope carries the measurement. An empty
    // relevant set has nothing to observe and keeps the marker.
    const unknowns = new Set(BASE_UNKNOWNS);
    if (checks === null) unknowns.add('checks');
    if (phases.setup_ms === null) unknowns.add('setup_ms');
    if (phases.run_elapsed_ms === null) unknowns.add('run_elapsed');
    if (phases.checks_ms === null) unknowns.add('checks_ms');
    if (phases.snapshot_hash_ms === null) unknowns.add('snapshot_hash_ms');
    for (const marker of usage.markers) unknowns.add(marker);

    const registryImage = [...scan.members.keys()].sort().map((uuid) => {
      const member = scan.members.get(uuid);
      return { request_uuid: uuid, record_digest: member.ok ? member.recordDigest : null };
    });
    // Stage-2 stub blocks (#270, owner decision 3 / shape 2B): published with
    // null members until real producers exist — zero-init is forbidden.
    const toolsStub = { observed_calls: null, failed_calls: null, elapsed_ms: null };
    const dedupStub = { lookups: null, hits: null, misses: null, input_bytes: null, output_bytes: null };
    const timingSurface = measuredRuns.some((run) => run.timings !== undefined)
      || qaRecords.some((record) => record.metadata?.timings !== undefined);
    const metrics = {
      schema: RUNNER_METRICS_SCHEMA,
      run_id: runIds.size === 1 ? [...runIds][0] : null,
      tokens: usage.result.tokens,
      tool_calls: usage.result.tool_calls,
      model_requests: usage.result.model_requests,
      transport,
      attribution,
      requests,
      checks,
      phases,
      tools: toolsStub,
      dedup: dedupStub,
      provenance: {
        requests_scanned: scan.requestScanned,
        journals_scanned: scan.journalScanned,
        runs_scanned: runScan.scanned,
        qa_results_scanned: qaScanned,
        members_skipped: membersSkipped,
        ledger_attempts_scanned: ledgerScan.status === 'ok' ? ledgerScan.attempts.length : null,
        registry_digest: digest(canonical(registryImage)),
        collector: { id: COLLECTOR_ID, version: await collectorVersion(root) }
      },
      unknowns: [...unknowns].sort(),
      // Coverage declares the successfully read scope; the +timings variants
      // add "a timing surface was observed in the sample" (per-record
      // completeness stays in unknowns).
      coverage: checks !== null
        ? (timingSurface ? RUNNER_METRICS_COVERAGES[3] : RUNNER_METRICS_COVERAGES[1])
        : (timingSurface ? RUNNER_METRICS_COVERAGES[2] : RUNNER_METRICS_COVERAGES[0])
    };
    // Final self-check before the single write: the aggregate must satisfy the
    // same runtime contract the export gate applies (per-record safe integers
    // can still overflow into an unsafe sum). An unpublishable aggregate is a
    // hard failure, never a silently written collected file.
    try { validateRunnerMetrics(metrics); } catch (error) {
      if (error?.exchangeCode === 'invalid_runner_metrics') throw collectorError('runner_metrics_aggregate_unrepresentable');
      throw error;
    }
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
