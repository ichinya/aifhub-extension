#!/usr/bin/env node
// QA orchestration. Does not execute checks or grant verification/done authority.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, digest, portablePath, requireValue, identifier } from './workflow-state-store.mjs';
import { qaStore, qaTarget, qaFailure, QA_SCHEMA, sorted, QA_LIMITS, gateView } from './qa-manifest-store.mjs';
import { validateChecks, observeQaSnapshot, checkFingerprints } from './qa-manifest-inputs.mjs';
import { evaluateQaBinding } from './qa-bound-evidence.mjs';
import { writeGateEvidence } from './write-gate-evidence.mjs';
import { readOpenSpecPolicy } from './openspec-policy.mjs';
import { isQaEnrolled } from './qa-manifest-record.mjs';
import { REQUIRED_GATES_BY_STAGE } from './handoff-gate-summary.mjs';

export { evaluateQaBinding, readBoundGateEvidence } from './qa-bound-evidence.mjs';
export { qaTarget, QA_LIMITS } from './qa-manifest-store.mjs';

// Configured rules hierarchy (rules.base / rules.skills under the top-level
// `rules:` key) is material policy even when the files are gitignored: without
// this a byte change to base.md would leave the ignored name-set untouched.
async function configuredRulesInputs(store) {
  const data = await store.bytes('.ai-factory/config.yaml');
  if (data === null) return [];
  const inputs = [];
  let inRules = false;
  for (const rawLine of data.toString('utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine)) continue;
    const match = rawLine.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!match) continue;
    const [, indent, key, rawValue] = match;
    if (indent.length === 0) { inRules = key === 'rules'; continue; }
    if (inRules && indent.length > 0 && (key === 'base' || key === 'skills') && rawValue) {
      inputs.push(rawValue.replace(/^['"]|['"]$/g, ''));
    }
  }
  return inputs;
}

async function ownerRequirements(options, target) {
  const provider = options.providers?.requirements;
  if (provider) return provider({ target, stage: options.stage ?? 'done' });
  const stage = options.stage ?? 'done';
  requireValue(Object.hasOwn(REQUIRED_GATES_BY_STAGE, stage), 'invalid-stage', true);
  const gates = target.flow === 'openspec'
    ? REQUIRED_GATES_BY_STAGE[stage].filter(gate => gate !== 'coverage') : ['verify'];
  const evidence = [];
  if (target.flow === 'openspec') {
    const policy = await readOpenSpecPolicy(options);
    requireValue(policy.diagnostics.length === 0, 'owner-policy-invalid', true);
    if (policy.requirements.rulesPass[stage]) gates.push('rules');
    if (policy.requirements.specCoverage[stage]) evidence.push(`${target.qa}/coverage.json`);
  }
  if (target.flow === 'openspec' && REQUIRED_GATES_BY_STAGE[stage].includes('coverage')) evidence.push(`${target.qa}/coverage.json`);
  return { gates, independent_roles: [], evidence };
}

export async function prepareQaManifest(options = {}) {
  options = { ...options, readBudget: { bytes: 0 } };
  try {
    // --wave names the new wave here; previous requirements belong to the
    // currently enrolled wave and must be loaded without a selection filter.
    const store = await qaStore({ ...options, waveId: undefined });
    return await store.lock(async () => {
      const checks = validateChecks(options.checks);
      const enrolled = await store.enrollment();
      const previous = enrolled ? (await store.manifest()).payload.requirements : {};
      const owner = await ownerRequirements({ ...options, rootDir: store.root }, store.target);
      const requirements = { gates: sorted([...(previous.gates ?? []), ...(owner.gates ?? []), ...(options.requiredGates ?? [])]),
        independent_roles: [...new Map([...(previous.independent_roles ?? []), ...(owner.independent_roles ?? []),
          ...(options.independentRoles ?? [])].map(role => [canonical(role), role])).values()],
        evidence: sorted([...(previous.evidence ?? []), ...(owner.evidence ?? []), ...(options.evidenceRefs ?? [])]) };
      requireValue(requirements.evidence.length <= QA_LIMITS.refs, 'qa-refs-limit', true);
      for (const gate of requirements.gates) requireValue(checks.some(c => c.gate === gate), 'required-gate-missing', true);
      for (const role of requirements.independent_roles) requireValue(checks.some(c => c.id === role.check_id && c.gate === role.role), 'required-role-missing', true);
      const scope = sorted(options.scope ?? []);
      requireValue(scope.length > 0 && scope.length <= QA_LIMITS.files, 'scope-required', true);
      const policyInputs = sorted([...(options.policyInputs ?? []), '.ai-factory/config.yaml', '.ai-factory/RULES.md',
        '.ai-factory/rules/generated', ...(await configuredRulesInputs(store)), ...(store.target.flow === 'openspec'
          ? ['openspec/specs', `openspec/changes/${store.target.id}`] : [`${store.qa}/task.md`, `${store.qa}/context.md`, `${store.qa}/rules.md`])]);
      const payload = { wave_id: options.waveId ?? randomUUID(), target: store.target, scope,
        policy_inputs: policyInputs, module_inputs: sorted(options.moduleInputs ?? []),
        requirements, stage: options.stage ?? 'done', checks, metadata_registry: 'qa-metadata.v1' };
      identifier(payload.wave_id);
      for (const p of [...scope, ...policyInputs, ...payload.module_inputs, ...requirements.evidence]) portablePath(p);
      payload.snapshot = await observeQaSnapshot(store, payload, options);
      payload.fingerprints = await checkFingerprints(payload, payload.snapshot, options);
      const second = await observeQaSnapshot(store, payload, options);
      requireValue(second.digest === payload.snapshot.digest, 'custody-race', true);
      const manifest = { schema: QA_SCHEMA, payload, manifest_digest: digest(payload) };
      await store.immutable(`${store.qa}/waves/${payload.wave_id}/inputs.json`, manifest);
      await store.immutable(`${store.qa}/enrollment.json`, { schema: 'aifhub.qa-enrollment.v1', target: store.target });
      await store.write(`${store.qa}/manifest.json`, `${canonical({ wave_id: payload.wave_id, manifest_digest: manifest.manifest_digest })}\n`);
      return { ok: true, enrolled: true, wave_id: payload.wave_id, manifest_digest: manifest.manifest_digest, target: store.target, authorizes: [] };
    });
  } catch (error) { return qaFailure(error); }
}

export async function recordQaResult(options = {}) {
  try {
    const target = qaTarget(options);
    requireValue(await isQaEnrolled(options), 'enrollment-missing', true);
    return writeGateEvidence({ ...options, changeId: target.id, flow: target.flow,
      namespace: target.namespace, qaDir: target.qa });
  } catch (error) { return qaFailure(error); }
}

export async function publishQaManifest(options = {}) {
  options = { ...options, readBudget: { bytes: 0 } };
  try {
    const store = await qaStore(options);
    return await store.lock(async () => {
      const pointer = await store.json(`${store.qa}/publication.json`);
      requireValue(Object.hasOwn(options, 'expectedPublication') && options.expectedPublication === (pointer?.id ?? null), 'publication-cas-conflict', true);
      const manifest = await store.manifest();
      const owner = await ownerRequirements({ ...options, rootDir: store.root, stage: manifest.payload.stage }, store.target);
      const requiredGates = sorted([...(owner.gates ?? []), ...(options.requiredGates ?? [])]);
      const roles = [...(owner.independent_roles ?? []), ...(options.independentRoles ?? [])];
      // Freshly read owner requirements must already belong to the prepared wave:
      // evidence or gates demanded only now would not be covered by any recorded
      // result, so publication is refused instead of silently accepted (review F6).
      requireValue(roles.every(role => manifest.payload.requirements.independent_roles.some(r => canonical(r) === canonical(role))), 'owner-requirements-drift', true);
      requireValue(requiredGates.every(gate => manifest.payload.requirements.gates.includes(gate)), 'owner-requirements-drift', true);
      requireValue((owner.evidence ?? []).every(relative => manifest.payload.requirements.evidence.includes(relative)), 'owner-requirements-drift', true);
      const first = await evaluateQaBinding({ ...options, requirePublication: false, requiredGates });
      const id = options.publicationId ?? randomUUID();
      identifier(id);
      const catalog = {};
      const journal = { id, manifest_digest: manifest.manifest_digest, expected_publication: pointer?.id ?? null,
        state: first.state, code: first.code, committed: false };
      await store.immutable(`${store.qa}/journals/${id}.json`, journal);
      if (first.state !== 'valid') return { ...first, accepted: false, publication_id: id };
      const records = await store.results();
      for (const gate of Object.values(first.gates)) {
        const record = records.find(r => r.id === gate.result_id);
        const body = await store.bytes(record.evidence.path);
        requireValue(digest(body) === record.evidence.sha256, 'evidence-tampered', true);
        await store.write(gateView(store.target, record.gate), body);
        catalog[gateView(store.target, record.gate)] = record.evidence.sha256;
        for (const [relative, ref] of Object.entries(record.artifacts)) {
          const data = await store.bytes(ref.path);
          requireValue(data !== null && digest(data) === ref.sha256, 'evidence-tampered', true);
          await store.write(relative, data); catalog[relative] = ref.sha256;
        }
      }
      for (const relative of sorted([...manifest.payload.requirements.evidence, ...(owner.evidence ?? [])])) {
        const data = await store.bytes(relative);
        requireValue(data !== null, 'evidence-catalog-incomplete', true);
        catalog[relative] = digest(data);
      }
      requireValue(Object.keys(catalog).length <= QA_LIMITS.refs, 'qa-refs-limit', true);
      const second = await evaluateQaBinding({ ...options, requirePublication: false, requiredGates });
      requireValue(second.state === 'valid' && second.snapshot_digest === first.snapshot_digest
        && canonical(second.selection) === canonical(first.selection), 'custody-race', true);
      for (const [relative, hash] of Object.entries(catalog)) requireValue(digest(await store.bytes(relative)) === hash, 'evidence-changed', true);
      requireValue(canonical(await store.json(`${store.qa}/publication.json`)) === canonical(pointer), 'publication-cas-conflict', true);
      const record = { ...journal, committed: true, selection: second.selection, catalog,
        history: (await store.results()).map(digest),
        snapshot_digest: second.snapshot_digest, requirements_digest: digest(manifest.payload.requirements),
        reuse: second.reuse_witnesses, gates: second.gates };
      await store.immutable(`${store.qa}/publications/${id}.json`, record);
      await store.write(`${store.qa}/publication.json`, `${canonical({ id, sha256: digest(record) })}\n`);
      return { ...second, ok: true, publication_id: id, committed: true,
        accepted: Object.values(second.gates).every(g => g.status !== 'fail'), authorizes: [] };
    });
  } catch (error) { return qaFailure(error); }
}

export function parseQaManifestArgs(argv = []) {
  const parsed = { action: argv[0], json: false };
  if (!['prepare', 'record', 'publish', 'inspect'].includes(parsed.action)) return null;
  const names = { '--change': 'changeId', '--plan': 'plan', '--flow': 'flow', '--namespace': 'namespace', '--qa-dir': 'qaDir',
    '--config': 'configFile', '--wave': 'waveId', '--gate': 'gate', '--check': 'checkId', '--result': 'resultId',
    '--from': 'from', '--receipt': 'receiptPath', '--execution': 'executionFile', '--supersedes': 'supersedes',
    '--expected-publication': 'expectedPublication' };
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === '--json') parsed.json = true;
    else if (names[flag] && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')) parsed[names[flag]] = argv[++i];
    else return null;
  }
  if (!parsed.changeId && !parsed.plan) return null;
  if (parsed.expectedPublication === 'none') parsed.expectedPublication = null;
  return parsed;
}

export async function runQaManifestCommand(argv = process.argv.slice(2), options = {}) {
  const parsed = parseQaManifestArgs(argv);
  let result;
  try {
    requireValue(parsed, 'invalid-arguments', true);
    const rootDir = options.rootDir ?? process.cwd();
    const input = { ...options, ...parsed, rootDir };
    async function jsonFile(relative) {
      const data = await readFile(path.resolve(rootDir, relative));
      requireValue(data.length <= QA_LIMITS.blob, 'qa-blob-limit', true);
      return JSON.parse(data.toString('utf8'));
    }
    if (parsed.configFile) {
      const config = await jsonFile(parsed.configFile);
      // Identity and action come from explicit CLI flags, never from config contents.
      for (const key of ['checks', 'scope', 'policyInputs', 'moduleInputs', 'requiredGates', 'independentRoles', 'evidenceRefs', 'stage']) {
        if (Object.hasOwn(config, key)) input[key] = config[key];
      }
    }
    if (parsed.executionFile) input.execution = await jsonFile(parsed.executionFile);
    const actions = { prepare: prepareQaManifest, record: recordQaResult, publish: publishQaManifest, inspect: evaluateQaBinding };
    result = await actions[parsed.action](input);
  } catch (error) { result = qaFailure(error); }
  const output = options.stdout ?? process.stdout;
  output.write(`${argv.includes('--json') ? JSON.stringify(result, null, 2) : `QA ${parsed?.action ?? 'manifest'}: ${result.code ?? (result.ok ? 'ok' : 'blocked')}`}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  process.exitCode = await runQaManifestCommand();
}
