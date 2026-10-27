// Read-only inventory of final gate evidence. Never grants workflow authority.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { getLatestGateResult, extractGateResultBlocks } from './aif-gate-result.mjs';
import { readOpenSpecPolicy } from './openspec-policy.mjs';
import { storeFor, digest, identifier, portablePath, requireValue } from './workflow-state-store.mjs';

const GATES = ['verify', 'rules', 'review', 'security'];
const LIMIT = 1024 * 1024;
const MAX_RECEIPTS = 64;
const SHA = /^[a-f0-9]{64}$/;
const usage = 'ai-factory aifhub-gate-coverage --change <id> [--require review,security] --json';

export function parseGateCoverageArgs(argv) {
  const result = { changeId: null, require: [], json: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!['--change', '--require', '--json'].includes(arg) || seen.has(arg)) return null;
    seen.add(arg);
    if (arg === '--json') result.json = true;
    else {
      const value = argv[++i];
      if (typeof value !== 'string') return null;
      if (arg === '--change') result.changeId = value;
      else result.require = value.split(',');
    }
  }
  try { validateQuery(result); } catch { return null; }
  return result;
}

function validateQuery(query) {
  identifier(query.changeId);
  requireValue(Array.isArray(query.require) && query.require.length <= 2
    && new Set(query.require).size === query.require.length
    && query.require.every(g => ['review', 'security'].includes(g)), 'invalid-query');
}

// The shared parser ignores an unclosed terminal fence. Do not let an old PASS
// hide one here; canonical files have exactly one gate type, so inspect all blocks.
export function extractCoverageGate(content, gate) {
  const blocks = extractGateResultBlocks(content);
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  const lastStart = lines.findLastIndex(line => line.trimEnd() === '```aif-gate-result');
  if (lastStart >= 0 && !lines.slice(lastStart + 1).some(line => line.trim() === '```')) {
    return { state: 'invalid', status: null, codes: ['terminal-result-unclosed'] };
  }
  const latest = getLatestGateResult(content, { gate });
  if (!latest || blocks.at(-1)?.startLine !== latest.startLine) {
    return { state: 'invalid', status: null, codes: ['gate-result-missing-or-wrong-gate'] };
  }
  if (!latest.ok) return { state: 'invalid', status: null, codes: ['latest-result-invalid'] };
  return { state: 'valid', status: latest.result.status, codes: [] };
}

export async function buildGateCoverage(options = {}) {
  const query = { changeId: options.changeId, require: options.require ?? [] };
  validateQuery(query);
  const store = await storeFor(options.rootDir ?? process.cwd());
  const qa = `.ai-factory/qa/${query.changeId}`;
  const inputs = new Map();
  const diagnostics = [];
  async function read(relative) {
    portablePath(relative);
    const data = await store.bytes(relative);
    requireValue(data === null || data.length <= LIMIT, 'evidence-too-large');
    // Hash the decoded text like the coverage matrix writer does, so UTF-8 BOM
    // differences between writers never report an unchanged source as stale.
    const hash = data === null ? null : digest(new TextDecoder('utf-8', { fatal: true }).decode(data));
    if (inputs.has(relative)) requireValue(inputs.get(relative) === hash, 'evidence-changed');
    inputs.set(relative, hash);
    return data === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
  async function json(relative) {
    const text = await read(relative);
    return text === null ? null : JSON.parse(text);
  }
  // Validate before the existing policy reader touches the config; recheck its
  // exact bytes at the end. Do not call a readiness builder (it creates layout).
  const configPath = '.ai-factory/config.yaml';
  await read(configPath);
  const policy = await readOpenSpecPolicy({ rootDir: store.root });
  if (policy.diagnostics.length) diagnostics.push('policy-diagnostic');
  const required = ['verify'];
  if (policy.requirements.rulesPass.verify || policy.requirements.rulesPass.done) required.push('rules');
  if (policy.requirements.specCoverage.verify || policy.requirements.specCoverage.done) required.push('coverage');
  required.push(...GATES.filter(g => query.require.includes(g)));
  const checks = [];
  for (const gate of GATES) {
    const evidencePath = `${qa}/${gate}.md`;
    const check = {
      requirement_id: gate, gate, required: required.includes(gate),
      required_role: gate, evidence_path: evidencePath, evidence_sha256: null,
      result_state: 'missing', result_status: null, target_binding: 'unknown',
      role_coverage: 'missing', independence: query.require.includes(gate) ? 'unknown' : 'not-required',
      provenance: 'unrecorded', codes: []
    };
    try {
      const text = await read(evidencePath);
      check.evidence_sha256 = inputs.get(evidencePath);
      if (text !== null) {
        const parsed = extractCoverageGate(text, gate);
        check.result_state = parsed.state;
        check.result_status = parsed.status;
        check.codes.push(...parsed.codes);
        // This is gate-role coverage, never authenticated person/session identity.
        check.role_coverage = parsed.state === 'valid' ? 'matched' : 'unknown';
        check.codes.push('target-binding-unrecorded');
      } else check.codes.push('evidence-missing');
    } catch {
      check.result_state = 'invalid'; check.role_coverage = 'unknown';
      check.codes.push('evidence-unreadable-or-unsafe');
    }
    checks.push(check);
  }

  const supporting = [];
  for (const name of ['coverage', 'done-readiness']) {
    const evidencePath = `${qa}/${name}.json`;
    const check = { requirement_id: name, gate: name, required: required.includes(name),
      evidence_path: evidencePath, evidence_sha256: null, result_state: 'missing',
      result_status: null, target_binding: 'unknown', role_coverage: 'matched',
      independence: 'not-required', codes: [] };
    try {
      const value = await json(evidencePath);
      check.evidence_sha256 = inputs.get(evidencePath);
      if (value !== null) {
        requireValue(value.schema_version === 1 && value.change_id === query.changeId
          && ['pass', 'warn', 'fail'].includes(value.status), 'invalid-supporting-evidence');
        check.result_state = 'valid'; check.result_status = value.status;
        if (name === 'coverage') {
          requireValue(Array.isArray(value.requirements) && Array.isArray(value.sources)
            && value.sources.length > 0 && value.sources.length <= 256, 'invalid-coverage');
          const seen = new Set();
          for (const source of value.sources) {
            requireValue(SHA.test(source.sha256) && !seen.has(source.path), 'invalid-coverage-source');
            seen.add(source.path);
            const content = await read(source.path);
            if (content === null || inputs.get(source.path) !== source.sha256) check.codes.push('coverage-source-stale');
          }
          check.target_binding = check.codes.length ? 'mismatched' : 'matched';
        } else check.codes.push('supporting-only-not-finalization-authority');
      } else check.codes.push('evidence-missing');
    } catch {
      check.result_state = 'invalid'; check.codes = ['supporting-evidence-invalid-or-unsafe'];
    }
    supporting.push(check);
  }

  // Existing receipts bind a prepared diff, not a final gate result. Report their
  // tiers separately rather than assigning an unrelated receipt to a gate/role.
  const reviewDir = `.ai-factory/state/${query.changeId}/reviews`;
  const observations = [];
  let receiptNames = [];
  async function listReceipts() {
    const target = await store.target(reviewDir);
    let entries;
    try { entries = await readdir(target, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    requireValue(entries.length <= MAX_RECEIPTS, 'too-many-receipts');
    requireValue(entries.every(entry => entry.isDirectory() && !entry.isSymbolicLink()), 'unsafe-receipt-entry');
    return entries.map(e => identifier(e.name)).sort();
  }
  try {
    receiptNames = await listReceipts();
    for (const name of receiptNames) {
      const evidencePath = `${reviewDir}/${name}/ai-cross-context-review.json`;
      const observation = { evidence_path: evidencePath, evidence_sha256: null, provenance: 'unknown',
        target_binding: 'unknown', independence: 'unknown', codes: ['final-result-binding-unrecorded'] };
      try {
        const receipt = await json(evidencePath);
        observation.evidence_sha256 = inputs.get(evidencePath);
        requireValue(receipt?.schema === 'aifhub.ai_cross_context_review.v1' && receipt.change_id === query.changeId, 'invalid-receipt');
        if (receipt.same_session_fallback === true) observation.provenance = 'same-session';
        else if (receipt.execution_profile === 'ai-fresh-context' && receipt.same_session_fallback === false) {
          requireValue(receipt.target?.path === 'review-target.diff' && SHA.test(receipt.target.fingerprint), 'unsupported-target');
          // The preparer allows up to the store limit for this diff; read it through
          // the store's own custody path instead of the diagnostic's smaller bound.
          const diff = await store.bytes(`${reviewDir}/${name}/review-target.diff`);
          if (diff !== null && digest(diff) === receipt.target.fingerprint) observation.provenance = 'fresh-context';
          else observation.codes.push('receipt-target-mismatched');
        }
        if (receipt.outcome === 'prepared') observation.codes.push('preparation-only');
      } catch { observation.codes.push('receipt-invalid-or-unsafe'); }
      observations.push(observation);
    }
  } catch { diagnostics.push('receipt-inventory-invalid-or-unsafe'); }
  for (const check of checks.filter(c => query.require.includes(c.gate))) {
    check.provenance = observations.length ? 'unknown' : 'unrecorded';
    check.codes.push('independence-unproven');
  }
  // Recheck every consumed identity, including absence and the receipt inventory,
  // with the same decoded-text basis as the first read.
  try {
    requireValue(JSON.stringify(receiptNames) === JSON.stringify(await listReceipts()), 'receipt-inventory-changed');
    for (const [relative, hash] of inputs) {
      const data = await store.bytes(relative);
      requireValue((data === null ? null : digest(new TextDecoder('utf-8', { fatal: true }).decode(data))) === hash, 'evidence-changed');
    }
  } catch { diagnostics.push('input-identity-changed-or-unsafe'); }
  const requested = [...checks, ...supporting].filter(c => c.required);
  for (const check of requested.filter(c => c.result_status === 'warn')) {
    // Apply the existing owner policy rather than converting every WARN into
    // either success or failure. Verify has no allow-WARN completion policy.
    const allowsWarning = check.gate === 'rules'
      ? !policy.requirements.rulesPass.verify && policy.allowWarnOnDone.rules
      : check.gate === 'coverage'
        ? !policy.requirements.specCoverage.verify && policy.allowWarnOnDone.coverage
        : false;
    if (!allowsWarning) check.codes.push('required-warning-not-accepted');
  }
  const failing = requested.some(c => c.result_state === 'valid' && c.result_status === 'fail');
  // Untrusted input identity (mid-read changes) makes the whole inventory
  // 'unknown'. A final gate result that cannot be bound to the current target,
  // or whose independence is unproven, is a known gap: 'complete' stays
  // reserved for recorded matching bindings and proven independence.
  const unknown = diagnostics.length > 0;
  const gap = requested.some(c => c.result_state !== 'valid' || c.target_binding !== 'matched'
    || c.independence === 'unknown' || c.codes.includes('required-warning-not-accepted'));
  // Preserve the final status; coverage never becomes a semantic QA verdict.
  const coverage = failing ? 'blocked' : unknown ? 'unknown' : gap ? 'incomplete' : 'complete';
  return { schema_version: 1, change_id: query.changeId, diagnostic_only: true,
    requirements_complete: true, requirements_scope: 'explicit-query-and-openspec-policy',
    coverage, required, checks, supporting, provenance_observations: observations,
    codes: diagnostics, authorizes: [] };
}

export async function runGateCoverageCommand(argv = process.argv.slice(2), options = {}) {
  const parsed = parseGateCoverageArgs(argv);
  const output = options.output ?? (value => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (!parsed) { output({ schema_version: 1, diagnostic_only: true, codes: ['invalid-query'], usage, authorizes: [] }); return 2; }
  try {
    const result = await buildGateCoverage({ ...options, changeId: parsed.changeId, require: parsed.require });
    output(result);
    return result.coverage === 'complete' ? 0 : 1;
  } catch {
    output({ schema_version: 1, change_id: parsed.changeId, diagnostic_only: true,
      coverage: 'unknown', codes: ['diagnostic-input-unreadable-or-unsafe'], authorizes: [] });
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runGateCoverageCommand();
}
