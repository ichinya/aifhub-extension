// Shared read-only binding evaluator. Deliberately independent of policy/readiness owners.
import { digest, canonical, requireValue, portablePath } from './workflow-state-store.mjs';
import { qaStore, strictQaGate, qaFailure, sorted, within, QA_LIMITS } from './qa-manifest-store.mjs';
import { observeQaSnapshot, checkFingerprints, validateChecks, allDeclaredRoots, dependencyRoots } from './qa-manifest-inputs.mjs';

export function selectQaResults(records, checks) {
  const selected = {};
  for (const check of checks) {
    const candidates = records.filter(r => r.check_id === check.id);
    const tips = candidates.filter(r => !candidates.some(child => child.supersedes === r.id));
    requireValue(tips.length === 1, tips.length ? 'result-history-conflict' : 'result-missing', true);
    selected[check.id] = tips[0];
  }
  return selected;
}

export async function evaluateQaBinding(options = {}) {
  options = { ...options, readBudget: options.readBudget ?? { bytes: 0 } };
  try {
    const store = await qaStore(options);
    const enrollment = await store.enrollment();
    if (!enrollment) return { ok: true, enrolled: false, state: 'valid', code: 'manifest-absent', affected_checks: [], authorizes: [] };
    const manifest = await store.manifest();
    const payload = manifest.payload;
    validateChecks(payload.checks);
    const reads = new Map();
    async function read(relative, hash) {
      portablePath(relative);
      const data = await store.bytes(relative);
      requireValue(data !== null && digest(data) === hash, 'evidence-tampered', true);
      requireValue(!reads.has(relative) || reads.get(relative) === hash, 'evidence-changed', true);
      reads.set(relative, hash);
      requireValue(reads.size <= QA_LIMITS.refs, 'qa-refs-limit', true);
      return data;
    }
    const current = await observeQaSnapshot(store, payload, options);
    requireValue(current.worktree_identity === payload.snapshot.worktree_identity, 'stale-worktree', true);
    requireValue(canonical(current.modules) === canonical(payload.snapshot.modules), 'module-identity-drift', true);
    requireValue(canonical(current.ignored_names) === canonical(payload.snapshot.ignored_names), 'ignored-membership-drift', true);
    const changed = sorted([...Object.keys(current.files), ...Object.keys(payload.snapshot.files)])
      .filter(p => canonical(current.files[p] ?? null) !== canonical(payload.snapshot.files[p] ?? null));
    const material = changed.filter(p => !(current.files[p]?.projection
      && current.files[p].projection === payload.snapshot.files[p]?.projection));
    for (const p of material) {
      requireValue(!(payload.module_inputs ?? []).some(root => within(p, root)), 'module-identity-drift', true);
      requireValue(allDeclaredRoots(payload).some(root => within(p, root)), 'out-of-scope-edit', true);
      requireValue(payload.checks.some(c => dependencyRoots(payload, c).some(root => within(p, root))), 'dependency-unproven', true);
    }
    const fingerprints = await checkFingerprints(payload, current, options);
    const records = await store.results();
    const selected = selectQaResults(records, payload.checks);
    const affected = [];
    const gates = {};
    const required = sorted([...(payload.requirements.gates ?? []), ...(options.requiredGates ?? [])]);
    for (const gate of required) requireValue(payload.checks.some(c => c.gate === gate), 'required-gate-missing', true);
    // Inspect all historical records as well: preserved failures are part of custody.
    for (const result of records) {
      requireValue(result.schema === 'aifhub.qa-result.v1' && canonical(result.target) === canonical(store.target), 'result-target-mismatch', true);
      requireValue(['agent-authored', 'imported', 'host-observed'].includes(result.execution?.kind), 'execution-kind-invalid', true);
      if (result.supersedes !== null) requireValue(records.some(parent => parent.id === result.supersedes
        && parent.check_id === result.check_id && parent.id !== result.id), 'result-history-incomplete', true);
      const body = await read(result.evidence.path, result.evidence.sha256);
      requireValue(canonical(strictQaGate(body.toString('utf8'), result.gate)) === canonical(result.gate_block), 'gate-block-mismatch', true);
      for (const ref of Object.values(result.artifacts)) await read(ref.path, ref.sha256);
      if (result.execution.receipt) await read(result.execution.receipt.path, result.execution.receipt.sha256);
    }
    for (const check of payload.checks) {
      const result = selected[check.id];
      requireValue(result.gate === check.gate, 'gate-identity-drift', true);
      requireValue(result.binding_code === null, result.binding_code ?? 'result-binding-invalid', true);
      requireValue(result.worktree_identity === current.worktree_identity, 'stale-worktree', true);
      if (result.input_fingerprints[check.id] !== fingerprints[check.id]
        || payload.fingerprints[check.id] !== fingerprints[check.id]) affected.push(check.id);
      if (check.depends_on_diff && current.actual_diff !== payload.snapshot.actual_diff) affected.push(check.id);
      const execution = result.execution;
      for (const relative of check.required_evidence ?? []) requireValue(result.artifacts[relative], 'evidence-catalog-incomplete', true);
      requireValue(!check.requires_observed || execution.kind === 'host-observed', 'execution-unproven', true);
      if (execution.kind === 'host-observed') {
        requireValue(execution.receipt && options.HostObservationRegistry?.lookup, 'execution-unproven', true);
        const bytes = await read(execution.receipt.path, execution.receipt.sha256);
        const receipt = JSON.parse(bytes.toString('utf8'));
        const trusted = await options.HostObservationRegistry.lookup(receipt.run_id);
        requireValue(trusted && trusted.receipt_sha256 === digest(bytes)
          && trusted.receipt_path === execution.receipt.original_path
          && trusted.worktree_identity === current.worktree_identity && trusted.run_id === receipt.run_id,
        'forged-receipt', true);
        requireValue(receipt.schema === 'aifhub.observed-check.v1' && receipt.check_id === check.id
          && receipt.worktree_identity === current.worktree_identity
          && receipt.input_fingerprints_digest === digest(result.input_fingerprints)
          && receipt.command_digest === result.command_digest
          && receipt.exit_code === execution.exit_code && receipt.exit_code === trusted.exit_code
          && receipt.outcome === trusted.outcome, 'forged-receipt', true);
        requireValue(result.gate_block.status !== 'pass' || (receipt.exit_code === 0 && receipt.outcome === 'completed'), 'execution-inconsistent', true);
        for (const [relative, hash] of Object.entries(receipt.artifacts ?? {})) await read(relative, hash);
      }
      requireValue(result.gate_block.status !== 'pass' || (execution.exit_code === undefined || execution.exit_code === 0)
        && (execution.outcome === undefined || execution.outcome === 'completed'), 'execution-inconsistent', true);
      const status = result.gate_block.status;
      const previous = gates[check.gate]?.status;
      const rank = { pass: 0, warn: 1, fail: 2 };
      if (previous === undefined || rank[status] >= rank[previous]) gates[check.gate] = { status, result_id: result.id, evidence: result.evidence };
    }
    const roles = payload.requirements.independent_roles ?? [];
    const actors = new Set();
    for (const role of roles) {
      const result = selected[role.check_id];
      const proof = result && await options.HostObservationRegistry?.role?.(result.id, role.role);
      requireValue(proof && proof.role === role.role && typeof proof.actor === 'string'
        && proof.result_sha256 === digest(result) && proof.worktree_identity === current.worktree_identity
        && !actors.has(proof.actor) && proof.independent === true, 'independence-unproven', true);
      actors.add(proof.actor);
    }
    for (const [gate, content] of Object.entries(options.gateContents ?? {})) {
      if (gates[gate]) requireValue(digest(Buffer.from(content)) === gates[gate].evidence.sha256, 'evidence-not-published', true);
    }
    const selection = Object.fromEntries(Object.entries(selected).map(([id, record]) => [id, digest(record)]));
    let publication = null;
    if (options.requirePublication !== false) {
      const pointerBytes = await store.bytes(`${store.qa}/publication.json`);
      const pointer = await store.json(`${store.qa}/publication.json`);
      requireValue(pointer && typeof pointer.id === 'string', 'publication-missing', true);
      portablePath(pointer.id);
      publication = await store.json(`${store.qa}/publications/${pointer.id}.json`);
      requireValue(publication?.committed === true && publication.manifest_digest === manifest.manifest_digest
        && pointer.sha256 === digest(publication) && canonical(publication.selection) === canonical(selection)
        && canonical(publication.history) === canonical(records.map(digest)), 'publication-incomplete', true);
      await read(`${store.qa}/publication.json`, digest(pointerBytes));
      requireValue(publication.state === 'valid', 'publication-not-valid', true);
      for (const [relative, hash] of Object.entries(publication.catalog)) await read(relative, hash);
    }
    // Two observations close the ordinary read/materialization race window.
    const second = await observeQaSnapshot(store, payload, options);
    requireValue(second.digest === current.digest, 'custody-race', true);
    requireValue((await store.manifest()).manifest_digest === manifest.manifest_digest
      && canonical((await store.results()).map(digest)) === canonical(records.map(digest)), 'catalog-race', true);
    for (const [relative, hash] of reads) await read(relative, hash);
    const state = affected.length ? 'stale' : 'valid';
    return { ok: state === 'valid', enrolled: true, state, code: state === 'valid' ? 'qa-binding-valid' : 'gate-source-stale',
      affected_checks: sorted(affected), check_gates: Object.fromEntries(payload.checks.map(c => [c.id, c.gate])),
      gates, selection, manifest_digest: manifest.manifest_digest,
      snapshot_digest: current.digest, reused: changed.length > 0 && material.length === 0,
      reuse_witnesses: Object.values(selected).filter(r => r.manifest_digest !== manifest.manifest_digest)
        .map(r => ({ result_id: r.id, from_manifest: r.manifest_digest, to_manifest: manifest.manifest_digest,
          input_fingerprints_digest: digest(r.input_fingerprints), custody_snapshot_digest: current.digest })),
      publication_id: publication?.id ?? null, authorizes: [] };
  } catch (error) { return qaFailure(error); }
}

// Consumers must pass their actual evidence bytes so alternate candidate files or
// a mutated second read cannot bypass the publication catalog.
export async function readBoundGateEvidence(options = {}) {
  const binding = await evaluateQaBinding({ ...options, requirePublication: true });
  if (!binding.enrolled || binding.state !== 'valid') return binding;
  const gate = binding.gates?.[options.gate];
  if (!gate || (options.content !== undefined && digest(Buffer.isBuffer(options.content)
    ? options.content : Buffer.from(options.content)) !== gate.evidence.sha256)) {
    return { ...binding, ok: false, state: 'blocked', code: 'evidence-not-published' };
  }
  return { ...binding, semantic_status: gate.status };
}
