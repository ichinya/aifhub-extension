// Append-only recording shared by both existing evidence producers. No acceptance.
import { randomUUID } from 'node:crypto';
import { digest, canonical, identifier, portablePath, fields, requireValue } from './workflow-state-store.mjs';
import { readdir } from 'node:fs/promises';
import { qaStore, strictQaGate, QA_LIMITS, qaFailure, withinCi, gateView } from './qa-manifest-store.mjs';
import { observeQaSnapshot, checkFingerprints } from './qa-manifest-inputs.mjs';

// Stage-2 causal rerun vocabulary (#270, contract R11): a duplicated frozen
// list — this module must not import `workflow-exchange` (the reason codes'
// contract lives with the metrics exporter, the producer side stays dependent-
// free). Parity with RUNNER_METRICS_REASON_CODES is pinned by a dedicated test.
export const QA_RERUN_REASON_CODES = Object.freeze([
  'rerun-inputs-changed', 'rerun-command-changed', 'rerun-environment-changed',
  'rerun-policy-changed', 'rerun-explicit'
]);

const isoDate = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const intMs = v => Number.isSafeInteger(v) && v >= 0;
// Closed timing shapes persisted inside qa-result metadata. `complete` means
// "the interval is closed by a measurement", not "the work succeeded": a
// timeout/cancelled verifier still carries a finished checks measurement.
function checksTimingValue(value) {
  fields(value, ['started_at', 'ended_at', 'elapsed_ms', 'complete']);
  requireValue(isoDate(value.started_at) && isoDate(value.ended_at) && intMs(value.elapsed_ms)
    && typeof value.complete === 'boolean', 'timing-invalid', true);
  return value;
}
// The snapshot-hash timing is assembled internally from the telemetry list
// (never caller-supplied); its closed shape is re-validated by the collector
// on read, so no producer-side constructor is needed here.
// Explicit caller-supplied metadata members only. The snapshot-hash timing is
// process telemetry recomputed on every binding — it is never caller-supplied,
// so replay idempotency compares it against nothing (first-write frozen).
function callerMetadata(options) {
  const metadata = {};
  if (options.rerunReason !== undefined) {
    requireValue(QA_RERUN_REASON_CODES.includes(options.rerunReason), 'rerun-reason-invalid', true);
    metadata.rerun_reason = options.rerunReason;
  }
  if (options.executionRunId !== undefined) metadata.execution_run_id = identifier(options.executionRunId);
  if (options.checksTiming !== undefined) {
    metadata.timings = { checks: structuredClone(checksTimingValue(options.checksTiming)) };
  }
  return metadata;
}

export async function isQaEnrolled(options) {
  const store = await qaStore(options);
  return (await store.enrollment()) !== null;
}

// Windows resolves `Results/x` and `RESULT~1/x` onto a real `results/` directory.
// Materialization targets are canonicalized against on-disk entries so case or
// 8.3 aliases cannot smuggle a control-namespace write past the path guard.
async function assertCanonicalMaterialization(store, relative, forbidden) {
  const parts = relative.split('/');
  let probe = '';
  for (let index = 0; index < parts.length; index++) {
    let canonicalPart = parts[index];
    try {
      const directory = index === 0 ? store.root : await store.safeTarget(probe);
      const entries = await readdir(directory);
      const hit = entries.find(entry => entry.toLowerCase() === parts[index].toLowerCase());
      if (hit !== undefined) canonicalPart = hit;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    probe = probe ? `${probe}/${canonicalPart}` : canonicalPart;
  }
  requireValue(!forbidden.some(name => withinCi(probe, name)) && withinCi(probe, store.qa),
    'artifact-control-path', true);
}

export async function recordBoundEvidence(options = {}) {
  // Snapshot/fingerprint telemetry (#270) accumulates into a local list only:
  // the aggregate becomes metadata, never snapshot material.
  const telemetryEvents = [];
  options = { ...options, readBudget: { bytes: 0 }, telemetry: event => telemetryEvents.push(event) };
  try {
    const store = await qaStore(options);
    return await store.lock(async () => {
      requireValue(await store.enrollment(), 'enrollment-missing', true);
      requireValue(!options.force, 'bound-force-forbidden', true);
      const manifest = await store.manifest();
      const checks = manifest.payload.checks.filter(c => c.gate === options.gate
        && (options.checkId === undefined || c.id === options.checkId));
      requireValue(checks.length === 1, 'check-id-required', true);
      const check = checks[0];
      const markdown = String(options.markdown ?? '');
      requireValue(Buffer.byteLength(markdown) <= QA_LIMITS.blob, 'qa-blob-limit', true);
      const gate = strictQaGate(markdown, options.gate);
      const id = identifier(options.resultId ?? randomUUID());
      const records = await store.results();
      // First-write frozen (#270): the existing record is resolved before the
      // candidate is constructed so a same-id replay can reuse the saved
      // metadata instead of colliding on freshly measured values.
      const existing = records.find(r => r.id === id);
      let fingerprints = manifest.payload.fingerprints;
      let worktreeIdentity = manifest.payload.snapshot.worktree_identity;
      let observedModules = null;
      let bindingCode = null;
      let commandDigest = digest(check.command);
      let snapshotHashTiming = null;
      const snapshotStartWall = new Date().toISOString();
      try {
        const observed = await observeQaSnapshot(store, manifest.payload, options);
        fingerprints = await checkFingerprints(manifest.payload, observed, options);
        if (options.providers?.checkDefinition) commandDigest = digest((await options.providers.checkDefinition(check)).command);
        worktreeIdentity = observed.worktree_identity;
        // Bind the helper identity seen at record time: restoring it before
        // publish must not make the record look current (review F2).
        observedModules = observed.modules;
        // Elapsed is the sum of the measured operations — never an enclosing
        // wall timer on top of them (double-counting is forbidden, contract R2).
        snapshotHashTiming = { started_at: snapshotStartWall, ended_at: new Date().toISOString(),
          elapsed_ms: telemetryEvents.reduce((sum, event) => sum + event.elapsed_ms, 0),
          operations: telemetryEvents.length, complete: true };
      } catch (error) { bindingCode = qaFailure(error).code; }
      // First-write frozen metadata: caller members are explicit and validated;
      // on replay the saved metadata wins and conflicting explicit members are
      // a typed rejection (never a silent overwrite, never a fresh measurement).
      const callerMeta = callerMetadata(options);
      let metadata;
      if (existing && existing.metadata !== undefined) {
        metadata = structuredClone(existing.metadata);
        const conflicting = ['rerun_reason', 'execution_run_id'].filter(key => callerMeta[key] !== undefined
          && (metadata[key] === undefined || canonical(metadata[key]) !== canonical(callerMeta[key])));
        const savedChecks = metadata.timings?.checks;
        if (callerMeta.timings?.checks !== undefined
          && (savedChecks === undefined || canonical(savedChecks) !== canonical(callerMeta.timings.checks))) conflicting.push('timings.checks');
        requireValue(conflicting.length === 0, 'metadata-conflict', true);
      } else if (existing) {
        // Legacy record frozen without metadata: replay without options stays
        // byte-identical, an explicit metadata member cannot be back-filled.
        requireValue(Object.keys(callerMeta).length === 0, 'metadata-conflict', true);
      } else {
        metadata = { recorded_at: snapshotStartWall };
        if (callerMeta.rerun_reason !== undefined) metadata.rerun_reason = callerMeta.rerun_reason;
        if (callerMeta.execution_run_id !== undefined) metadata.execution_run_id = callerMeta.execution_run_id;
        if (snapshotHashTiming !== null || callerMeta.timings?.checks !== undefined) {
          metadata.timings = {};
          if (snapshotHashTiming !== null) metadata.timings.snapshot_hash = snapshotHashTiming;
          if (callerMeta.timings?.checks !== undefined) metadata.timings.checks = callerMeta.timings.checks;
        }
      }
      requireValue(records.length < QA_LIMITS.results || records.some(r => r.id === id), 'qa-results-limit', true);
      let supersedes = options.supersedes ?? null;
      if (supersedes !== null) {
        identifier(supersedes);
        requireValue(records.some(r => r.id === supersedes && r.check_id === check.id), 'supersedes-invalid', true);
      }
      const other = records.filter(r => r.check_id === check.id && r.id !== id);
      const tips = other.filter(r => !other.some(child => child.supersedes === r.id));
      // Corrective chaining: a second bound record for the same check supersedes
      // the single open tip instead of being rejected (corrective runs are the norm).
      // Same-id replay (#270 review): without an explicit option a corrective
      // record reuses its frozen chain reference — the auto-chained supersedes
      // is part of the first write, so the replay stays canonically stable and
      // idempotent instead of colliding on supersedes=null.
      if (supersedes === null) {
        if (existing) supersedes = existing.supersedes ?? null;
        else if (tips.length === 1) supersedes = tips[0].id;
      }
      requireValue(records.some(r => r.id === id) || tips.length === 0
        || (tips.length === 1 && tips[0].id === supersedes), 'supersedes-required', true);
      const artifacts = {};
      const controlNames = ['manifest.json', 'enrollment.json', 'publication.json', 'qa.lock', 'waves', 'results',
        'bodies', 'artifacts', 'publications', 'journals', 'verify.md', 'rules.md', 'review.md', 'security.md', 'gates']
        .map(name => `${store.qa}/${name}`);
      requireValue(Object.keys(options.artifacts ?? {}).length <= QA_LIMITS.refs, 'qa-refs-limit', true);
      for (const [relative, value] of Object.entries(options.artifacts ?? {})) {
        portablePath(relative);
        requireValue(withinCi(relative, store.qa), 'artifact-outside-qa', true);
        await assertCanonicalMaterialization(store, relative, controlNames);
        const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
        const frozen = `${store.qa}/artifacts/${id}/${relative.slice(store.qa.length + 1)}`;
        artifacts[relative] = { path: frozen, sha256: digest(data) };
      }
      const execution = { kind: 'agent-authored', ...(options.execution ?? {}) };
      requireValue(['agent-authored', 'imported', 'host-observed'].includes(execution.kind), 'execution-kind-invalid', true);
      if (options.receiptPath) {
        portablePath(options.receiptPath);
        const data = await store.bytes(options.receiptPath);
        requireValue(data !== null, 'receipt-missing', true);
        execution.receipt = { path: `${store.qa}/artifacts/${id}/receipt.json`, sha256: digest(data),
          original_path: options.receiptPath };
      }
      const record = { schema: 'aifhub.qa-result.v1', id, check_id: check.id, gate: check.gate,
        manifest_digest: manifest.manifest_digest, wave_id: manifest.payload.wave_id,
        target: store.target, worktree_identity: worktreeIdentity, binding_code: bindingCode,
        modules_digest: observedModules === null ? null : digest(observedModules),
        input_fingerprints: { [check.id]: fingerprints[check.id] },
        command_digest: commandDigest,
        evidence: { path: `${store.qa}/bodies/${id}.md`, sha256: digest(Buffer.from(markdown)) },
        gate_block: gate, execution, artifacts, supersedes,
        ...(metadata !== undefined ? { metadata } : {}) };
      const references = new Set([...records.filter(r => r.id !== id), record].flatMap(r => [r.evidence.path,
        ...Object.values(r.artifacts).map(ref => ref.path), ...(r.execution.receipt ? [r.execution.receipt.path] : [])]));
      requireValue(references.size <= QA_LIMITS.refs, 'qa-refs-limit', true);
      requireValue(!existing || canonical(existing) === canonical(record), 'immutable-conflict', true);
      const publicationPointer = await store.json(`${store.qa}/publication.json`);
      const publication = publicationPointer && await store.json(`${store.qa}/publications/${publicationPointer.id}.json`);
      requireValue(existing || publication?.manifest_digest !== manifest.manifest_digest, 'wave-sealed', true);
      // Freeze all bytes before installing the result record. Orphans from a crash
      // never become selected evidence; incomplete records fail the catalog reader.
      await store.immutable(record.evidence.path, markdown);
      for (const [relative, value] of Object.entries(options.artifacts ?? {})) {
        await store.immutable(artifacts[relative].path, Buffer.isBuffer(value) ? value : Buffer.from(String(value)));
      }
      if (execution.receipt) await store.immutable(execution.receipt.path, await store.bytes(options.receiptPath));
      await store.immutable(`${store.qa}/results/${id}.json`, { checksum: digest(record), record });
      // Current view is not accepted until publish commits its exact catalog.
      for (const [relative, value] of Object.entries(options.artifacts ?? {})) await store.write(relative, value);
      await store.write(gateView(store.target, check.gate), markdown);
      return { ok: true, recorded: true, accepted: false, result_id: id, check_id: check.id,
        gate: check.gate, path: gateView(store.target, check.gate), status: gate.status, authorizes: [] };
    });
  } catch (error) { if (process.env.QA_DEBUG) console.error("QA-DEBUG", error && (error.stack || error)); return qaFailure(error); }
}
