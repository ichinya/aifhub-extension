// Producer adapter for trusted completion-hook observations (#227). The adapter
// supplies registry-backed evidence only; verification, readiness and archive
// authority stay with their existing owners.
import { open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { digest, canonical, identifier, portablePath, requireValue, storeFor, WorkflowError } from './workflow-state-store.mjs';
import { qaStore, qaTarget, qaFailure, sorted, withinCi, jsonValue, QA_LIMITS } from './qa-manifest-store.mjs';
import { observeQaSnapshot, checkFingerprints } from './qa-manifest-inputs.mjs';
import { createGateResult, renderGateResultBlock } from './aif-gate-result.mjs';
import { recordBoundEvidence } from './qa-manifest-record.mjs';

export const OBSERVED_RUN_SCHEMA = 'aifhub.observed-run.v1';
export const OBSERVATION_RECORD_SCHEMA = 'aifhub.observation.v1';
export const OBSERVED_CHECK_RECEIPT_SCHEMA = 'aifhub.observed-check.v1';
// Process outcomes (completed/failed/timeout/cancelled) and availability outcomes
// (unsupported/missing-report) stay distinct. The consumer treats every
// non-completed outcome as non-PASS, so the adapter must never mask a negative
// outcome into a `warn` gate status: a publish accepts any non-`fail` gate.
export const OBSERVED_OUTCOMES = Object.freeze(['completed', 'failed', 'timeout', 'cancelled', 'unsupported', 'missing-report']);
const SHA = /^[a-f0-9]{64}$/;
// Recorder materialization forbids the QA control namespaces (the same list the
// bound recorder enforces). Entries inside them stay receipt-catalog-only.
const RECORDER_CONTROL_NAMES = Object.freeze(['manifest.json', 'enrollment.json', 'publication.json', 'qa.lock',
  'waves', 'results', 'bodies', 'artifacts', 'publications', 'journals', 'verify.md', 'rules.md',
  'review.md', 'security.md', 'gates']);
// Caller options that belong to the bound recorder only; the observation contract
// never lets them leak into a bound record.
const RECORDER_ONLY_OPTIONS = Object.freeze(['artifacts', 'supersedes', 'force', 'markdown', 'gate',
  'checkId', 'resultId', 'receiptPath', 'execution']);

// Deterministic replay key: a crash after installing the result must not grow a
// second corrective record (a random id would auto-supersede the open tip).
export function observedResultId(runId) {
  identifier(runId);
  return `observed-${digest(runId).slice(0, 16)}`;
}

function observationPaths(qa, runId) {
  identifier(runId);
  const dir = `${qa}/artifacts/observations`;
  return { dir, lock: `${dir}/observations.lock`, record: `${dir}/${runId}.json`,
    receipt: `${dir}/receipts/${runId}.json`, reports: `${dir}/reports` };
}

// Strict closed-shape validation of the versioned producer envelope. Unknown
// fields, malformed digests and inconsistent declarations are typed rejections
// before any state is touched; low-level path/identifier failures are remapped so
// every envelope rejection stays inside the observation code family.
const ENVELOPE_FIELDS = Object.freeze(['schema', 'run_id', 'check_id', 'covered_checks', 'change_id', 'manifest_digest',
  'command', 'effective_cwd', 'worktree_identity', 'snapshot_digest', 'fingerprints_digest',
  'modules_digest', 'outcome', 'exit_code', 'report_path', 'report_sha256', 'artifacts']);
const COMMAND_FIELDS = Object.freeze(['argv', 'cwd', 'definition']);
const NO_EXIT_OUTCOMES = Object.freeze(['timeout', 'cancelled']);
const REPORT_FREE_OUTCOMES = Object.freeze(['timeout', 'cancelled', 'missing-report']);

function validateEnvelope(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'observation-envelope-invalid', true);
  // An unsupported capability is an adapter-level blocker detected before strict
  // validation: no verifier launch, no receipt, no registry record.
  if (value.schema === OBSERVED_RUN_SCHEMA && value.outcome === 'unsupported') return null;
  try {
    requireValue(Object.keys(value).every(k => ENVELOPE_FIELDS.includes(k))
      && ENVELOPE_FIELDS.every(k => Object.hasOwn(value, k)), 'observation-envelope-invalid', true);
    requireValue(value.schema === OBSERVED_RUN_SCHEMA, 'observation-envelope-invalid', true);
    identifier(value.run_id); identifier(value.check_id); identifier(value.change_id);
    requireValue(Array.isArray(value.covered_checks) && value.covered_checks.length === 1
      && value.covered_checks[0] === value.check_id, 'observation-multi-check', true);
    requireValue(OBSERVED_OUTCOMES.includes(value.outcome), 'observation-envelope-invalid', true);
    for (const key of ['manifest_digest', 'snapshot_digest', 'fingerprints_digest', 'modules_digest'])
      requireValue(SHA.test(value[key]), 'observation-envelope-invalid', true);
    requireValue(value.command && typeof value.command === 'object' && !Array.isArray(value.command), 'observation-envelope-invalid', true);
    requireValue(Object.keys(value.command).every(k => COMMAND_FIELDS.includes(k))
      && COMMAND_FIELDS.every(k => Object.hasOwn(value.command, k)), 'observation-envelope-invalid', true);
    requireValue(Array.isArray(value.command.argv) && value.command.argv.length > 0
      && value.command.argv.every(a => typeof a === 'string' && a.length > 0 && !a.includes('\0')), 'observation-envelope-invalid', true);
    requireValue(typeof value.command.cwd === 'string', 'observation-envelope-invalid', true);
    requireValue(value.command.definition === null || typeof value.command.definition === 'string', 'observation-envelope-invalid', true);
    requireValue(typeof value.effective_cwd === 'string' && value.effective_cwd.length > 0, 'observation-envelope-invalid', true);
    for (const p of [value.effective_cwd, value.command.cwd]) if (p !== '.') portablePath(p);
    if (value.command.definition) portablePath(value.command.definition);
    requireValue(typeof value.worktree_identity === 'string' && value.worktree_identity.length > 0, 'observation-envelope-invalid', true);
    requireValue(value.exit_code === null || (Number.isInteger(value.exit_code)
      && value.exit_code >= 0 && value.exit_code <= 255), 'observation-envelope-invalid', true);
    requireValue(typeof value.report_path === 'string' && value.report_path.length > 0, 'observation-envelope-invalid', true);
    portablePath(value.report_path);
    requireValue(value.report_sha256 === null || SHA.test(value.report_sha256), 'observation-envelope-invalid', true);
    requireValue(value.artifacts && typeof value.artifacts === 'object' && !Array.isArray(value.artifacts)
      && Object.keys(value.artifacts).length <= QA_LIMITS.refs, 'observation-envelope-invalid', true);
    for (const [relative, hash] of Object.entries(value.artifacts)) {
      portablePath(relative);
      requireValue(SHA.test(hash), 'observation-envelope-invalid', true);
    }
    jsonValue(value);
  } catch (error) {
    if (error instanceof WorkflowError && ['invalid-input', 'unsafe-path', 'invalid-json-value'].includes(error.code))
      throw new WorkflowError('observation-envelope-invalid', true);
    throw error;
  }
  if (NO_EXIT_OUTCOMES.includes(value.outcome)) {
    requireValue(value.exit_code === null && value.report_sha256 === null
      && Object.keys(value.artifacts).length === 0, 'observation-envelope-invalid', true);
  } else {
    requireValue(Number.isInteger(value.exit_code), 'observation-envelope-invalid', true);
    if (value.outcome === 'missing-report') {
      requireValue(value.exit_code === 0 && value.report_sha256 === null
        && Object.keys(value.artifacts).length === 0, 'observation-envelope-invalid', true);
    } else {
      requireValue(SHA.test(value.report_sha256) && value.artifacts[value.report_path] === value.report_sha256,
        'observation-declared-mismatch', true);
      requireValue(value.outcome !== 'completed' || value.exit_code === 0, 'observation-envelope-invalid', true);
      requireValue(value.outcome !== 'failed' || (value.exit_code > 0), 'observation-envelope-invalid', true);
    }
  }
  return value;
}

function registryEnvelope(record) {
  return Buffer.from(`${JSON.stringify({ checksum: digest(record), record }, null, 2)}\n`);
}

// Tolerant read used by lookup: a missing or corrupted record simply confirms
// nothing on the consumer side.
async function readRegistryRecord(store, paths) {
  const data = await store.bytes(paths.record);
  if (data === null) return null;
  let envelope;
  try { envelope = JSON.parse(data.toString('utf8')); } catch { return null; }
  if (!envelope?.record || envelope.checksum !== digest(envelope.record)) return null;
  return envelope.record;
}

// Strict read used inside the custody window: a corrupted record is destroyed
// evidence, not an absent one — fail closed and keep the bytes on disk.
async function loadRegistryRecord(store, paths) {
  const data = await store.bytes(paths.record);
  if (data === null) return null;
  let envelope;
  try { envelope = JSON.parse(data.toString('utf8')); } catch { throw new WorkflowError('observation-registry-tampered', true); }
  requireValue(envelope?.record && envelope.checksum === digest(envelope.record), 'observation-registry-tampered', true);
  return envelope.record;
}

// Exclusive custody write: `wx` first-write-wins; canonical orphan bytes from a
// crashed earlier attempt are adopted, anything else fails closed.
async function writeExclusive(store, relative, data, conflictCode = 'observation-incomplete') {
  const filename = await store.target(relative, true);
  let handle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await store.bytes(relative);
    requireValue(existing !== null && existing.equals(data), conflictCode, true);
    return 'adopted';
  }
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  return 'written';
}

// Registry records only ever move forward (absent -> pending -> complete) under
// the registry lock; a crash between the unlink and the rewrite leaves no record,
// so `lookup` fails closed instead of exposing a half-written observation.
async function saveRegistryRecord(store, paths, record) {
  await store.remove(paths.record).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return writeExclusive(store, paths.record, registryEnvelope(record));
}

function registryView(record) {
  return { run_id: record.run_id, check_id: record.check_id, result_id: record.result_id,
    receipt_sha256: record.receipt_sha256, receipt_path: record.receipt_path,
    worktree_identity: record.worktree_identity, exit_code: record.exit_code, outcome: record.outcome };
}

// Injectable host-owned observation registry. Only complete records are visible:
// pending intents and orphan bytes never confirm a check on the consumer side.
export function observationRegistry(rootDir, changeId, options = {}) {
  const target = qaTarget({ ...options, rootDir, changeId });
  async function lookup(runId) {
    try { identifier(runId); } catch { return null; }
    const store = await storeFor(rootDir);
    const record = await readRegistryRecord(store, observationPaths(target.qa, runId));
    return record && record.state === 'complete' ? registryView(record) : null;
  }
  return { lookup, qa: target.qa };
}

// One injectable transport, two call shapes: the adapter's documented contract is
// callback-style spawn(file, argv, options, callback); the snapshot consumers
// (filesystemSnapshot, and any direct evaluateQaBinding caller) expect the
// promisified {stdout} shape, so the adapter wraps its transport for them.
const promiseExecFile = exec => (file, args, opts) => new Promise((resolve, reject) => {
  exec(file, args, opts, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
    resolve({ stdout, stderr });
  });
});

// Launch the manifest-attested invocation. Transport contract: callback-style
// spawn(file, argv, options, callback), invoked asynchronously, returning a
// child-like handle with an optional kill(). The two observed stop causes are
// this adapter's own deadline (timeout) and the external abort signal
// (cancelled); the error object alone never classifies the outcome. A
// synchronous launch failure or a synchronous callback is normalized here —
// the caller never sees a raw transport error or a TDZ window.
function runVerifier(envelope, store, transport) {
  const root = store.root;
  const cwd = envelope.effective_cwd === '.' ? root : path.resolve(root, envelope.effective_cwd);
  const relative = path.relative(root, cwd);
  requireValue(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), 'observation-target-mismatch', true);
  // Bounded default (10 minutes): a hung transport is stopped by the deadline
  // with the full stop/bounded-cancellation contract, while real verification
  // runs far exceed short fixture defaults (Devin PR review).
  const timeoutMs = Number.isInteger(transport.timeoutMs) && transport.timeoutMs > 0 ? transport.timeoutMs : 600000;
  const spawn = transport.execFile ?? execFile;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let deadline = null;
    const stopDeadline = () => { if (deadline !== null) { clearTimeout(deadline); deadline = null; } };
    const settle = finish => { if (settled) return; settled = true; stopDeadline(); finish(); };
    const child = (() => {
      try {
        return spawn(envelope.command.argv[0], envelope.command.argv.slice(1), {
          cwd, killSignal: 'SIGTERM', windowsHide: true, env: transport.environment,
          // Verbose verifiers must not lose recorded evidence to the 1 MiB
          // default stdio buffer (Devin PR review); bytes are discarded, the
          // receipt binds digests instead.
          maxBuffer: QA_LIMITS.blob,
          ...(transport.signal ? { signal: transport.signal } : {}),
        }, error => {
          if (timedOut) return settle(() => resolve({ outcome: 'timeout', exit_code: null, stop: 'timeout' }));
          if (error?.code === 'ABORT_ERR') return settle(() => resolve({ outcome: 'cancelled', exit_code: null, stop: 'cancelled' }));
          if (typeof error?.code === 'number') return settle(() => resolve({ outcome: 'failed', exit_code: error.code, stop: 'exit' }));
          if (error) return settle(() => reject(new WorkflowError('observation-exec-failed', true)));
          settle(() => resolve({ outcome: 'completed', exit_code: 0, stop: null }));
        });
      } catch { return null; }
    })();
    if (child === null) { reject(new WorkflowError('observation-exec-failed', true)); return; }
    if (!settled) deadline = setTimeout(() => {
      timedOut = true;
      // Bounded cancellation: a transport without a stop mechanism refuses typed
      // instead of leaving the ingestion pending forever (it would hold the
      // registry lock); a failing stop is normalized; a killed transport gets one
      // bounded grace window before the run fails closed.
      if (typeof child?.kill !== 'function')
        return settle(() => reject(new WorkflowError('observation-stop-unsupported', true)));
      try { child.kill('SIGTERM'); }
      catch { return settle(() => reject(new WorkflowError('observation-exec-failed', true))); }
      deadline = setTimeout(() => settle(() => reject(new WorkflowError('observation-exec-failed', true))), timeoutMs);
    }, timeoutMs);
  });
}

// The adapter authors the only honest gate block: `pass` exclusively for a
// completed zero-exit run. Every negative outcome is a `fail` block — never
// `warn`, because the publisher accepts any non-`fail` gate.
function observedGateBlock(gate, envelope) {
  const passed = envelope.outcome === 'completed' && envelope.exit_code === 0;
  const status = passed ? 'pass' : 'fail';
  const markdown = renderGateResultBlock(createGateResult({ gate, status,
    blockers: passed ? [] : [{ id: 'hook-observation', severity: 'error',
      summary: `observed run ${envelope.run_id} finished with outcome ${envelope.outcome}` }],
    affectedFiles: [],
    suggestedNext: passed ? null : { command: '/aif-fix', reason: `observed check ${envelope.check_id} reported ${envelope.outcome}` } }));
  return { status, markdown: `${markdown}\n` };
}

function buildReceipt(envelope, worktreeIdentity, fingerprintDigest, commandDigest) {
  const artifacts = {};
  for (const relative of Object.keys(envelope.artifacts).sort()) artifacts[relative] = envelope.artifacts[relative];
  const receipt = { schema: OBSERVED_CHECK_RECEIPT_SCHEMA, run_id: envelope.run_id, check_id: envelope.check_id,
    worktree_identity: worktreeIdentity, input_fingerprints_digest: fingerprintDigest,
    command_digest: commandDigest, exit_code: envelope.exit_code, outcome: envelope.outcome, artifacts };
  return { receipt, bytes: Buffer.from(JSON.stringify(receipt)) };
}

// Verified host-attested bytes, minus the entries the recorder may not
// materialize (QA control namespaces stay receipt-catalog-only). Admissibility
// and size are checked here — strictly before the receipt and registry-complete
// writes, so a recorder rejection can never wedge the run_id.
async function collectRecorderArtifacts(store, envelope) {
  const artifacts = {};
  for (const [relative, hash] of Object.entries(envelope.artifacts)) {
    const data = await store.bytes(relative);
    // The store's leaf reader already rejects oversized bytes (unsupported-file);
    // both failures happen here, strictly before the receipt and registry-complete
    // writes, so a recorder rejection can never wedge the run_id.
    requireValue(data !== null && digest(data) === hash, 'observation-declared-mismatch', true);
    if (!RECORDER_CONTROL_NAMES.some(name => withinCi(relative, `${store.qa}/${name}`))) artifacts[relative] = data;
  }
  return artifacts;
}

// Whitelist mapping: the recorder receives exactly the observation contract —
// never caller-supplied artifacts/supersedes/force/markdown or any other bound
// recorder surface that would bypass host attestation. Custody-aliased inputs
// (waveId, lowercase snapshotProvider) are forwarded so the adapter and the
// recorder observe through the same sources.
async function recordObservedResult(store, options, envelope, check, plan) {
  const recorded = await recordBoundEvidence({
    rootDir: store.root, changeId: store.target.id, flow: store.target.flow,
    namespace: store.target.namespace, qaDir: options.qaDir, planDir: options.planDir, plan: options.plan,
    SnapshotProvider: options.SnapshotProvider, snapshotProvider: options.snapshotProvider,
    execFile: plan.execFile, environment: plan.environment, waveId: options.waveId,
    providers: options.providers, readBudget: options.readBudget,
    gate: check.gate, checkId: check.id, resultId: plan.resultId, markdown: plan.markdown,
    receiptPath: plan.receiptPath, artifacts: plan.artifacts,
    execution: { kind: 'host-observed', exit_code: envelope.exit_code, outcome: envelope.outcome },
  });
  requireValue(recorded.ok, recorded.code ?? 'observation-incomplete', true);
  return recorded;
}

const requirementsView = value => ({ gates: sorted(value?.gates ?? []),
  // Roles are deep-copied per snapshot: a provider mutating its cached array
  // in place mid-run must not turn the pre/post owner comparison into a
  // self-comparison (review R3-2).
  independent_roles: (value?.independent_roles ?? []).map(role => ({ ...role })),
  evidence: sorted(value?.evidence ?? []) });
// Publish-owner semantics (qa-manifest.mjs:121-124): the manifest stores the
// union of previous + owner + explicit additions, so the live owner must be a
// subset of the frozen sets — never byte-equal to them.
const requirementsCovered = (owner, frozen) => sorted(owner?.gates ?? []).every(gate => sorted(frozen?.gates ?? []).includes(gate))
  && sorted(owner?.evidence ?? []).every(ref => sorted(frozen?.evidence ?? []).includes(ref))
  && (owner?.independent_roles ?? []).every(role => (frozen?.independent_roles ?? [])
    .some(other => canonical(other) === canonical(role)));

// One custody window: validate -> pre-observe -> run -> post-observe -> receipt
// -> registry complete -> bound record. Nothing survives a digest inequality.
export async function ingestObservedRun(versionedResult, options = {}) {
  try {
    requireValue(options.rootDir, 'invalid-input', true);
    for (const key of RECORDER_ONLY_OPTIONS)
      requireValue(!Object.hasOwn(options, key), 'observation-options-conflict', true);
    const envelope = validateEnvelope(versionedResult);
    if (envelope === null)
      return { ok: false, enrolled: false, state: 'blocked', code: 'hook-capability-unsupported',
        affected_checks: [], authorizes: [], errors: [{ code: 'hook-capability-unsupported',
          message: 'QA binding blocked: hook-capability-unsupported.' }] };
    options = { ...options, readBudget: options.readBudget ?? { bytes: 0 } };
    // One environment object is the single source of truth for the run: the
    // library contract set (`options.environment ?? process.env`) is copied once
    // — fingerprinted, handed to the spawn, and recorded from the same defensive
    // copy, so a caller mutating its own object mid-window cannot change what the
    // verifier executes. Never merged with the parent environment: a
    // declared-absent variable stays absent.
    const environment = { ...(options.environment ?? process.env) };
    const observeOptions = { ...options, environment,
      execFile: options.execFile ? promiseExecFile(options.execFile) : undefined };
    const transport = { execFile: options.execFile, environment, signal: options.signal, timeoutMs: options.timeoutMs };
    const store = await qaStore(options);
    const raw = await storeFor(options.rootDir);
    const paths = observationPaths(store.qa, envelope.run_id);
    // Attested reports live only inside the canonical reports subdirectory (the
    // directory entry itself is not a report path): registry records, receipts
    // and the lock file can never be overwritten by a run.
    requireValue(withinCi(envelope.report_path, paths.reports)
      && envelope.report_path.toLowerCase() !== paths.reports.toLowerCase(), 'observation-envelope-invalid', true);
    const resultId = observedResultId(envelope.run_id);
    // The registry lock is the adapter's own lock. The recorder takes the QA lock
    // itself after this lock has been released: no nested capture.
    const plan = await raw.lock(paths.lock, async () => {
      const existing = await loadRegistryRecord(store, paths);
      if (existing && existing.state === 'complete') {
        requireValue(canonical(existing.payload) === canonical(envelope), 'observation-conflict', true);
        let stored;
        try { stored = await store.json(`${store.qa}/results/${resultId}.json`); }
        catch (error) {
          if (error instanceof WorkflowError && error.code === 'invalid-qa-json')
            throw new WorkflowError('observation-incomplete', true);
          throw error;
        }
        if (stored !== null) {
          // A replay confirms a check only through a stored result that really
          // belongs to this run and its receipt (review: file existence alone
          // proves nothing).
          requireValue(stored.checksum === digest(stored.record) && stored.record.id === resultId
            && stored.record.check_id === envelope.check_id
            && stored.record.execution?.kind === 'host-observed'
            && stored.record.execution?.receipt?.original_path === paths.receipt,
          'observation-incomplete', true);
          return { kind: 'replay', existing };
        }
        return { kind: 'record-only', existing }; // crash after registry-complete, before the record
      }
      if (existing) requireValue(existing.payload_digest === digest(envelope), 'observation-conflict', true);
      const manifest = await store.manifest();
      const check = manifest.payload.checks.find(c => c.id === envelope.check_id);
      requireValue(check && envelope.change_id === store.target.id, 'observation-target-mismatch', true);
      // The host declares the manifest it observed: an envelope from another wave
      // is stale before anything runs or is written (review R2-1).
      requireValue(envelope.manifest_digest === manifest.manifest_digest, 'observation-stale-gates', true);
      // Observed checks stay off the rules gate: a rules FAIL requires trace-backed
      // blockers the adapter cannot author, so the whole gate is unsupported here.
      requireValue(check.gate !== 'rules', 'observation-gate-unsupported', true);
      let block;
      try { block = observedGateBlock(check.gate, envelope); }
      catch { throw new WorkflowError('observation-gate-block-invalid', true); }
      // The check's required evidence catalog must be covered by the host-attested
      // catalog before a report-bearing run starts. Report-free negative outcomes
      // carry no catalog by schema; they record verbatim and never reach PASS.
      if (!REPORT_FREE_OUTCOMES.includes(envelope.outcome)) {
        for (const relative of check.required_evidence ?? [])
          requireValue(Object.hasOwn(envelope.artifacts, relative)
            && !RECORDER_CONTROL_NAMES.some(name => withinCi(relative, `${store.qa}/${name}`)),
          'observation-required-evidence-unattested', true);
      }
      // Recorder admissibility is cheap and checked before the launch: an
      // attested artifact outside the qa namespace would wedge the run_id at the
      // recorder, after the registry-complete write (review: round-1 class).
      for (const relative of Object.keys(envelope.artifacts))
        requireValue(withinCi(relative, store.qa), 'observation-artifact-inadmissible', true);
      let preOwner = null;
      if (options.providers?.requirements) {
        const owner = await options.providers.requirements({ target: store.target, stage: manifest.payload.stage });
        preOwner = requirementsView(owner);
        requireValue(requirementsCovered(owner, manifest.payload.requirements), 'observation-stale-gates', true);
      }
      if (!existing) await saveRegistryRecord(raw, paths, { schema: OBSERVATION_RECORD_SCHEMA, state: 'pending',
        run_id: envelope.run_id, check_id: envelope.check_id, change_id: envelope.change_id,
        result_id: resultId, payload: envelope, payload_digest: digest(envelope) });
      const current = await observeQaSnapshot(store, manifest.payload, observeOptions);
      requireValue(current.worktree_identity === envelope.worktree_identity, 'observation-stale-source', true);
      requireValue(current.digest === envelope.snapshot_digest, 'observation-stale-source', true);
      requireValue(digest(current.modules) === envelope.modules_digest, 'observation-stale-source', true);
      const fingerprints = await checkFingerprints(manifest.payload, current, observeOptions);
      const fingerprintDigest = digest({ [check.id]: fingerprints[check.id] });
      requireValue(fingerprintDigest === envelope.fingerprints_digest, 'observation-stale-gates', true);
      const effectiveCommand = options.providers?.checkDefinition
        ? (await options.providers.checkDefinition(check)).command : check.command;
      const commandDigest = digest(effectiveCommand);
      // The hook envelope is untrusted input: the adapter may only launch the
      // manifest-attested invocation. A substituted argv, cwd or definition is a
      // declared mismatch rejected before any process is spawned (review: the
      // receipt digest alone cannot bind the actual spawn). The effective cwd is
      // bound to the same command so relative argv resolution cannot be redirected
      // to a different file inside the worktree.
      requireValue(canonical(envelope.command) === canonical(effectiveCommand), 'observation-declared-mismatch', true);
      requireValue(envelope.effective_cwd === effectiveCommand.cwd, 'observation-declared-mismatch', true);
      await raw.target(envelope.report_path, true);
      // Report ownership: stale bytes at the declared path belong to no run. They
      // are removed before the launch, so a report present afterwards was written
      // by this very process (review: pre-existing reports must not vouch for a
      // run that never wrote one).
      await raw.remove(envelope.report_path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      let observed = await runVerifier(envelope, store, transport);
      if (observed.outcome === 'completed') {
        // Availability refinement: a clean exit without a report at the declared
        // path is a distinct missing-report outcome, never a silent PASS.
        if (await store.bytes(envelope.report_path) === null)
          observed = { outcome: 'missing-report', exit_code: 0, stop: null };
      }
      requireValue(observed.outcome === envelope.outcome && observed.exit_code === envelope.exit_code,
        'observation-declared-mismatch', true);
      let reportBytes = null;
      if (envelope.report_sha256 !== null) {
        reportBytes = await store.bytes(envelope.report_path);
        requireValue(reportBytes !== null && digest(reportBytes) === envelope.report_sha256, 'observation-declared-mismatch', true);
      }
      // Post-observation: the whole required context is re-read and must equal the
      // pre-run observations (review: snapshot alone is not the full context).
      const second = await observeQaSnapshot(store, manifest.payload, observeOptions);
      requireValue(second.digest === current.digest, 'observation-custody-race', true);
      const secondFingerprints = await checkFingerprints(manifest.payload, second, observeOptions);
      requireValue(canonical(secondFingerprints) === canonical(fingerprints), 'observation-custody-race', true);
      const secondCommand = options.providers?.checkDefinition
        ? (await options.providers.checkDefinition(check)).command : check.command;
      requireValue(canonical(secondCommand) === canonical(effectiveCommand), 'observation-custody-race', true);
      requireValue((await store.manifest()).manifest_digest === manifest.manifest_digest, 'observation-custody-race', true);
      if (options.providers?.requirements && preOwner !== null) {
        const owner = await options.providers.requirements({ target: store.target, stage: manifest.payload.stage });
        requireValue(canonical(requirementsView(owner)) === canonical(preOwner)
          && requirementsCovered(owner, manifest.payload.requirements), 'observation-custody-race', true);
      }
      const artifacts = await collectRecorderArtifacts(store, envelope);
      // Bound the recorder's reference budget before any custody write: the
      // recorder-artifact catalog plus the evidence body and the receipt must fit
      // QA_LIMITS.refs, or recordBoundEvidence would fail after the
      // registry-complete write and irreversibly wedge the run_id (review R3-4).
      const existingRefs = new Set((await store.results()).flatMap(record => [record.evidence.path,
        ...Object.values(record.artifacts).map(ref => ref.path),
        ...(record.execution.receipt ? [record.execution.receipt.path] : [])]));
      requireValue(existingRefs.size + Object.keys(artifacts).length + 2 <= QA_LIMITS.refs, 'qa-refs-limit', true);
      if (reportBytes !== null) {
        const reread = await store.bytes(envelope.report_path);
        requireValue(reread !== null && reread.equals(reportBytes), 'observation-custody-race', true);
      }
      const { receipt, bytes } = buildReceipt(envelope, current.worktree_identity, fingerprintDigest, commandDigest);
      await writeExclusive(raw, paths.receipt, bytes);
      await saveRegistryRecord(raw, paths, { schema: OBSERVATION_RECORD_SCHEMA, state: 'complete',
        run_id: envelope.run_id, check_id: envelope.check_id, change_id: envelope.change_id,
        result_id: resultId, payload: envelope, payload_digest: digest(envelope),
        worktree_identity: receipt.worktree_identity, exit_code: receipt.exit_code,
        outcome: receipt.outcome, receipt_path: paths.receipt, receipt_sha256: digest(bytes) });
      return { kind: 'fresh', check, block, receiptSha256: digest(bytes),
        artifacts, execFile: observeOptions.execFile, environment };
    });
    if (plan.kind === 'replay') {
      // Exact replay is a no-op: no verifier relaunch, no freshness update, no new record.
      return { ok: true, replayed: true, recorded: false, accepted: false, state: 'valid',
        ...registryView(plan.existing), authorizes: [] };
    }
    if (plan.kind === 'record-only') {
      // Crash between the registry-complete write and the bound record: re-run only
      // the record stage with the same deterministic id; the recorder is idempotent
      // for canonically equal content and rejects anything else. The attested
      // snapshot must still hold — a divergent record would fail the receipt
      // binding forever instead of surfacing honest staleness.
      const manifest = await store.manifest();
      const check = manifest.payload.checks.find(c => c.id === plan.existing.check_id);
      requireValue(check, 'observation-target-mismatch', true);
      requireValue(check.gate !== 'rules', 'observation-gate-unsupported', true);
      // A new wave replaces the manifest pointer: recording an earlier run against
      // it would let publication accept pre-wave evidence (Devin PR review).
      requireValue(envelope.manifest_digest === manifest.manifest_digest, 'observation-stale-gates', true);
      let block;
      try { block = observedGateBlock(check.gate, envelope); }
      catch { throw new WorkflowError('observation-gate-block-invalid', true); }
      const current = await observeQaSnapshot(store, manifest.payload, observeOptions);
      requireValue(current.worktree_identity === envelope.worktree_identity
        && current.digest === envelope.snapshot_digest
        && digest(current.modules) === envelope.modules_digest, 'observation-stale-source', true);
      const fingerprints = await checkFingerprints(manifest.payload, current, observeOptions);
      requireValue(digest({ [check.id]: fingerprints[check.id] }) === envelope.fingerprints_digest,
        'observation-stale-gates', true);
      const artifacts = await collectRecorderArtifacts(store, envelope);
      await recordObservedResult(store, options, envelope, check,
        { resultId, receiptPath: paths.receipt, markdown: block.markdown, artifacts,
          execFile: observeOptions.execFile, environment });
      return { ok: true, replayed: true, recorded: true, accepted: false, state: 'valid',
        ...registryView(plan.existing), authorizes: [] };
    }
    await recordObservedResult(store, options, envelope, plan.check,
      { resultId, receiptPath: paths.receipt, markdown: plan.block.markdown,
        artifacts: plan.artifacts, execFile: plan.execFile, environment: plan.environment });
    return { ok: true, replayed: false, recorded: true, accepted: false, state: 'valid',
      result_id: resultId, check_id: plan.check.id, gate: plan.check.gate, run_id: envelope.run_id,
      receipt_path: paths.receipt, receipt_sha256: plan.receiptSha256, outcome: envelope.outcome,
      exit_code: envelope.exit_code, status: plan.block.status, authorizes: [] };
  } catch (error) { return qaFailure(error); }
}
