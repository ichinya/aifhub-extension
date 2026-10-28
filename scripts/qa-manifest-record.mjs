// Append-only recording shared by both existing evidence producers. No acceptance.
import { randomUUID } from 'node:crypto';
import { digest, canonical, identifier, portablePath, requireValue } from './workflow-state-store.mjs';
import { qaStore, strictQaGate, QA_LIMITS, qaFailure, within, gateView } from './qa-manifest-store.mjs';
import { observeQaSnapshot, checkFingerprints } from './qa-manifest-inputs.mjs';

export async function isQaEnrolled(options) {
  const store = await qaStore(options);
  return (await store.enrollment()) !== null;
}

export async function recordBoundEvidence(options = {}) {
  options = { ...options, readBudget: { bytes: 0 } };
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
      let fingerprints = manifest.payload.fingerprints;
      let worktreeIdentity = manifest.payload.snapshot.worktree_identity;
      let bindingCode = null;
      let commandDigest = digest(check.command);
      try {
        const observed = await observeQaSnapshot(store, manifest.payload, options);
        fingerprints = await checkFingerprints(manifest.payload, observed, options);
        if (options.providers?.checkDefinition) commandDigest = digest((await options.providers.checkDefinition(check)).command);
        worktreeIdentity = observed.worktree_identity;
      } catch (error) { bindingCode = qaFailure(error).code; }
      requireValue(records.length < QA_LIMITS.results || records.some(r => r.id === id), 'qa-results-limit', true);
      const supersedes = options.supersedes ?? null;
      if (supersedes !== null) {
        identifier(supersedes);
        requireValue(records.some(r => r.id === supersedes && r.check_id === check.id), 'supersedes-invalid', true);
      }
      const other = records.filter(r => r.check_id === check.id && r.id !== id);
      const tips = other.filter(r => !other.some(child => child.supersedes === r.id));
      requireValue(records.some(r => r.id === id) || tips.length === 0
        || (tips.length === 1 && tips[0].id === supersedes), 'supersedes-required', true);
      const artifacts = {};
      requireValue(Object.keys(options.artifacts ?? {}).length <= QA_LIMITS.refs, 'qa-refs-limit', true);
      for (const [relative, value] of Object.entries(options.artifacts ?? {})) {
        portablePath(relative);
        requireValue(within(relative, store.qa), 'artifact-outside-qa', true);
        const suffix = relative.slice(store.qa.length + 1);
        requireValue(!['manifest.json', 'enrollment.json', 'publication.json', 'qa.lock', 'waves', 'results',
          'bodies', 'artifacts', 'publications', 'journals', 'verify.md', 'rules.md', 'review.md', 'security.md', 'gates']
          .some(name => within(suffix, name)), 'artifact-control-path', true);
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
        input_fingerprints: { [check.id]: fingerprints[check.id] },
        command_digest: commandDigest,
        evidence: { path: `${store.qa}/bodies/${id}.md`, sha256: digest(Buffer.from(markdown)) },
        gate_block: gate, execution, artifacts, supersedes };
      const references = new Set([...records.filter(r => r.id !== id), record].flatMap(r => [r.evidence.path,
        ...Object.values(r.artifacts).map(ref => ref.path), ...(r.execution.receipt ? [r.execution.receipt.path] : [])]));
      requireValue(references.size <= QA_LIMITS.refs, 'qa-refs-limit', true);
      const existing = records.find(r => r.id === id);
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
  } catch (error) { return qaFailure(error); }
}
