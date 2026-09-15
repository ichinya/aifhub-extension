// prime-agent-ai-tester-matrix.mjs - prepared-only ai-tester scenario contract for issue #148
// Encodes the remaining Prime Agent runtime experiments as NOT_RUN rows. It adds no
// runtime adoption, agent files, installer path, daemon startup or executed evidence.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const PRIME_AGENT_CATALOG_SCHEMA = 'aifhub.prime_agent.ai_tester_catalog.v1';
export const PRIME_AGENT_MATRIX_SCHEMA = 'aifhub.prime_agent.ai_tester_matrix.v1';
export const PRIME_AGENT_ASSERTION_SCHEMA = 'aifhub.prime_agent.assertions.v1';
export const PRIME_AGENT_DECISION = 'defer_supported_runtime';
export const PRIME_AGENT_ISSUE = 148;

export const PRIME_AGENT_PINNED_IDENTITY = Object.freeze({
  prime_agent_release: 'v0.9.1',
  prime_agent_revision: '81ae3cb34d27d38ee37f9e205a1e73694993b344',
  aifhub_revision: 'a560e3fcf6148d9e1663c51db188f6c1491a6477',
  evaluation_date: '2026-09-05',
  provider_calls: 0,
  real_child_agents: 0,
  cost: 'none'
});

// The eight remaining experiments from the issue #148 evaluation README, in order.
export const PRIME_AGENT_EXPERIMENTS = Object.freeze([
  'role-integrity',
  'read-only-child',
  'worker-result-correlation',
  'gate-disagreement',
  'full-lifecycle',
  'background-recovery',
  'evolution-export',
  'installer-lifecycle'
]);

// The documented NOT_RUN stop reasons from the evaluation README.
export const PRIME_AGENT_NOT_RUN_REASONS = Object.freeze([
  'full_cli_session_and_model_refine',
  'protected_role_contract_missing',
  'runtime_adoption_blocked',
  'real_child_and_dcg_adapter'
]);

// Hard blockers that keep adoption closed; every scenario stays NOT_RUN until both
// are resolved by a reviewed design and executed evidence.
export const PRIME_AGENT_ADOPTION_BLOCKERS = Object.freeze([
  'protected_role_contract_missing',
  'enforced_permission_parity_missing'
]);

export const PRIME_AGENT_BOUNDARY_CONTRACT = Object.freeze({
  no_prime_agent_bundling: true,
  no_daemon_or_session_autostart: true,
  no_runtime_adoption: true,
  no_agent_files_prime_agent_runtime: true,
  no_refine_mutation_of_protected_roles: true,
  no_agent_to_agent_bypass_of_handoff_profile: true,
  no_autonomous_gate_equivalence_with_aif_verify: true,
  no_evolve_harness_delta_export: true
});

const DEFAULT_CATALOG = path.join('docs', 'runtime-research', 'prime-agent', 'scenario-catalog.json');
const VALID_STATUSES = new Set(['NOT_RUN']);
const VALID_ADOPTION_GATES = new Set(['blocked']);

export async function loadPrimeAgentCatalog({
  catalogPath = DEFAULT_CATALOG,
  cwd = process.cwd()
} = {}) {
  const resolved = path.resolve(cwd, catalogPath);
  const catalog = JSON.parse(await readFile(resolved, 'utf8'));
  const errors = validatePrimeAgentCatalog(catalog);
  if (errors.length > 0) throw new Error(`Invalid Prime Agent catalog: ${errors.join('; ')}`);
  return { ...catalog, source_path: toProjectPath(cwd, resolved) };
}

export function validatePrimeAgentCatalog(catalog = {}) {
  const errors = [];
  if (catalog.schema !== PRIME_AGENT_CATALOG_SCHEMA) {
    errors.push(`schema must be ${PRIME_AGENT_CATALOG_SCHEMA}`);
  }
  if (catalog.issue !== PRIME_AGENT_ISSUE) errors.push(`issue must be ${PRIME_AGENT_ISSUE}`);
  if (catalog.decision !== PRIME_AGENT_DECISION) {
    errors.push(`decision must be ${PRIME_AGENT_DECISION}`);
  }
  if (catalog.prepared_only !== true) errors.push('prepared_only must be true');
  if (catalog.no_promote !== true) errors.push('no_promote must be true');

  const identity = catalog.pinned_identity ?? {};
  for (const [key, expected] of Object.entries(PRIME_AGENT_PINNED_IDENTITY)) {
    if (identity[key] !== expected) errors.push(`pinned_identity.${key} must be ${expected}`);
  }
  const identityKeys = Object.keys(identity);
  const expectedIdentityKeys = Object.keys(PRIME_AGENT_PINNED_IDENTITY);
  if (!sameValues(identityKeys, expectedIdentityKeys)) {
    errors.push(`pinned_identity keys must be exactly ${expectedIdentityKeys.join(', ')}`);
  }

  const contract = catalog.boundary_contract ?? {};
  const contractKeys = Object.keys(contract);
  const expectedContractKeys = Object.keys(PRIME_AGENT_BOUNDARY_CONTRACT);
  if (!sameValues(contractKeys, expectedContractKeys)) {
    errors.push(`boundary_contract keys must be exactly ${expectedContractKeys.join(', ')}`);
  }
  for (const [key, expected] of Object.entries(PRIME_AGENT_BOUNDARY_CONTRACT)) {
    if (contract[key] !== expected) errors.push(`boundary_contract.${key} must be ${expected}`);
  }

  const defaults = catalog.defaults ?? {};
  if (defaults.status !== 'NOT_RUN') errors.push('defaults.status must be NOT_RUN');
  if (!VALID_ADOPTION_GATES.has(defaults.adoption_gate)) {
    errors.push('defaults.adoption_gate must be blocked');
  }
  if (!Number.isInteger(defaults.repetitions) || defaults.repetitions < 1) {
    errors.push('defaults.repetitions must be a positive integer');
  }
  if (!Number.isInteger(defaults.timeout_seconds) || defaults.timeout_seconds < 30) {
    errors.push('defaults.timeout_seconds must be an integer >= 30');
  }
  if (!Number.isInteger(defaults.max_turns) || defaults.max_turns < 1) {
    errors.push('defaults.max_turns must be a positive integer');
  }
  if (defaults.assertion_schema !== PRIME_AGENT_ASSERTION_SCHEMA) {
    errors.push(`defaults.assertion_schema must be ${PRIME_AGENT_ASSERTION_SCHEMA}`);
  }
  if (defaults.provenance_class !== 'prepared_scenario_no_execution') {
    errors.push('defaults.provenance_class must be prepared_scenario_no_execution');
  }

  const reasons = catalog.not_run_reasons ?? {};
  const reasonKeys = Object.keys(reasons);
  if (!sameValues(reasonKeys, PRIME_AGENT_NOT_RUN_REASONS)) {
    errors.push(`not_run_reasons keys must be exactly ${PRIME_AGENT_NOT_RUN_REASONS.join(', ')}`);
  }
  for (const reason of PRIME_AGENT_NOT_RUN_REASONS) {
    if (!cleanText(reasons[reason])) errors.push(`not_run_reasons.${reason} must be sanitized text`);
  }

  const blockers = catalog.adoption_blockers ?? {};
  const blockerKeys = Object.keys(blockers);
  if (!sameValues(blockerKeys, PRIME_AGENT_ADOPTION_BLOCKERS)) {
    errors.push(`adoption_blockers keys must be exactly ${PRIME_AGENT_ADOPTION_BLOCKERS.join(', ')}`);
  }
  for (const blocker of PRIME_AGENT_ADOPTION_BLOCKERS) {
    if (blockers[blocker] !== true) errors.push(`adoption_blockers.${blocker} must be true`);
  }

  const scenarios = asArray(catalog.scenarios);
  if (!sameValues(scenarios.map((scenario) => scenario?.id), PRIME_AGENT_EXPERIMENTS)) {
    errors.push(`scenarios must be, in order, ${PRIME_AGENT_EXPERIMENTS.join(', ')}`);
  }
  for (const [index, scenario] of scenarios.entries()) {
    const prefix = `scenarios[${index}]`;
    if (!safeId(scenario?.id)) errors.push(`${prefix}.id must be lowercase kebab-safe`);
    if (!cleanText(scenario?.title)) errors.push(`${prefix}.title must be sanitized text`);
    if (!VALID_STATUSES.has(scenario?.status)) {
      errors.push(`${prefix}.status must be NOT_RUN; prepared catalogs carry no executed result`);
    }
    if (!PRIME_AGENT_NOT_RUN_REASONS.includes(scenario?.not_run_reason)) {
      errors.push(`${prefix}.not_run_reason must be one of ${PRIME_AGENT_NOT_RUN_REASONS.join(', ')}`);
    }
    for (const field of ['required_evidence', 'guards', 'forbidden_claims', 'privacy_canaries']) {
      const values = asArray(scenario?.[field]);
      if (values.length < 1 || values.some((value) => !cleanText(value))) {
        errors.push(`${prefix}.${field} must contain sanitized text`);
      }
    }
    if (/aifhub-verifier|aifhub-implement-worker/.test(String(scenario?.forbidden_claims?.[0] ?? ''))) {
      // forbidden_claims describe claims that must never be made, not role fixtures;
      // shipping loadable role content is out of scope for a deferred runtime.
      errors.push(`${prefix}.forbidden_claims must not embed role fixture content`);
    }
  }

  if (containsPrivateMaterial(catalog)) {
    errors.push('catalog contains private-looking or credential-like material');
  }
  return errors;
}

export function buildPrimeAgentMatrix({
  catalog,
  runId = 'prepared',
  generatedAt = new Date().toISOString()
} = {}) {
  const errors = validatePrimeAgentCatalog(catalog);
  if (errors.length > 0) throw new Error(`Invalid Prime Agent catalog: ${errors.join('; ')}`);
  const defaults = catalog.defaults;
  const cases = catalog.scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    status: scenario.status,
    not_run_reason: scenario.not_run_reason,
    executed: false,
    prepared: true,
    required_evidence: [...scenario.required_evidence],
    guards: [...scenario.guards],
    forbidden_claims: [...scenario.forbidden_claims],
    privacy_canaries: [...scenario.privacy_canaries],
    repetitions: defaults.repetitions,
    timeout_seconds: defaults.timeout_seconds,
    max_turns: defaults.max_turns,
    assertion_schema: defaults.assertion_schema,
    provenance_class: defaults.provenance_class
  }));
  return {
    schema: PRIME_AGENT_MATRIX_SCHEMA,
    generated_at: generatedAt,
    run_id: String(runId),
    catalog_schema: catalog.schema,
    catalog_source: catalog.source_path ?? null,
    issue: catalog.issue,
    decision: catalog.decision,
    prepared_only: true,
    no_promote: true,
    pinned_identity: { ...catalog.pinned_identity },
    adoption_gate: defaults.adoption_gate,
    adoption_blockers: Object.keys(catalog.adoption_blockers),
    boundary_contract: { ...PRIME_AGENT_BOUNDARY_CONTRACT },
    cases,
    counts: {
      scenarios: cases.length,
      executed: 0,
      passed: 0,
      failed: 0
    }
  };
}

export function validatePrimeAgentMatrix(matrix = {}) {
  const errors = [];
  if (matrix.schema !== PRIME_AGENT_MATRIX_SCHEMA) {
    errors.push(`schema must be ${PRIME_AGENT_MATRIX_SCHEMA}`);
  }
  if (matrix.decision !== PRIME_AGENT_DECISION) {
    errors.push(`decision must be ${PRIME_AGENT_DECISION}`);
  }
  if (matrix.prepared_only !== true) errors.push('prepared_only must be true');
  if (matrix.no_promote !== true) errors.push('no_promote must be true');
  if (matrix.adoption_gate !== 'blocked') errors.push('adoption_gate must be blocked');
  if (!sameValues(matrix.adoption_blockers ?? [], PRIME_AGENT_ADOPTION_BLOCKERS)) {
    errors.push(`adoption_blockers must be ${PRIME_AGENT_ADOPTION_BLOCKERS.join(', ')}`);
  }
  if (!sameValues((matrix.cases ?? []).map((item) => item?.id), PRIME_AGENT_EXPERIMENTS)) {
    errors.push(`cases must be, in order, ${PRIME_AGENT_EXPERIMENTS.join(', ')}`);
  }
  const cases = asArray(matrix.cases);
  for (const [index, matrixCase] of cases.entries()) {
    const prefix = `cases[${index}]`;
    if (matrixCase?.executed !== false) errors.push(`${prefix}.executed must be false`);
    if (matrixCase?.prepared !== true) errors.push(`${prefix}.prepared must be true`);
    if (!VALID_STATUSES.has(matrixCase?.status)) {
      errors.push(`${prefix}.status must be NOT_RUN; this matrix cannot carry executed results`);
    }
    if (!PRIME_AGENT_NOT_RUN_REASONS.includes(matrixCase?.not_run_reason)) {
      errors.push(`${prefix}.not_run_reason must be a documented NOT_RUN reason`);
    }
  }
  const counts = matrix.counts ?? {};
  const executed = cases.filter((item) => item?.executed === true).length;
  if (counts.scenarios !== cases.length || counts.executed !== executed
    || counts.passed !== 0 || counts.failed !== 0) {
    errors.push('counts must report zero executed, passed and failed scenarios');
  }
  if (containsPrivateMaterial(matrix)) {
    errors.push('matrix contains private-looking or credential-like material');
  }
  return errors;
}

export function renderPrimeAgentMarkdown(matrix = {}) {
  const errors = validatePrimeAgentMatrix(matrix);
  if (errors.length > 0) throw new Error(`Invalid Prime Agent matrix: ${errors.join('; ')}`);
  const lines = [
    '# Prime Agent ai-tester prepared matrix — issue #148',
    '',
    `Decision: \`${matrix.decision}\`. Adoption gate: \`${matrix.adoption_gate}\`.`,
    `Run: \`${matrix.run_id}\` generated at \`${matrix.generated_at}\`.`,
    '',
    '> Prepared scenarios are not executed results. This matrix carries no provider',
    '> calls and no real child agents; every row is NOT_RUN pending a protected-role',
    '> and enforced-permission design. Reopen criteria live in the evaluation README.',
    '',
    '| Experiment | Status | Not-run reason | Required evidence |',
    '|---|---|---|---|'
  ];
  for (const matrixCase of matrix.cases) {
    const evidence = matrixCase.required_evidence.map((item) => escapeCell(item)).join(' ');
    lines.push(`| ${escapeCell(matrixCase.id)} | ${matrixCase.status} | ${escapeCell(matrixCase.not_run_reason)} | ${evidence} |`);
  }
  lines.push(
    '',
    `Adoption blockers: ${matrix.adoption_blockers.map((item) => `\`${item}\``).join(', ')}.`,
    `Counts: ${matrix.counts.scenarios} prepared, ${matrix.counts.executed} executed, ${matrix.counts.passed} passed, ${matrix.counts.failed} failed.`,
    '',
    '## Boundary contract',
    ''
  );
  for (const [flag, value] of Object.entries(matrix.boundary_contract)) {
    lines.push(`- ${flag}: ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function containsPrivateMaterial(value) {
  let encoded;
  try {
    encoded = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return true;
  }
  const text = String(encoded ?? '');
  const privatePath = /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/[^/]+\/)/;
  const privateKeyBlock = /BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY/i;
  const credentialField = /(?:^|[\s{,["'])(?:api[_-]?key|private[_-]?key|(?:access|refresh|id)[_-]?token|password|secret|auth(?:orization)?[_-]?token)\b["']?\s*[:=]/i;
  return privatePath.test(text) || privateKeyBlock.test(text) || credentialField.test(text);
}

function cleanText(value) {
  return typeof value === 'string' && value.trim().length > 0
    && !containsPrivateMaterial(value);
}

function safeId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sameValues(actual = [], expected = []) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((item, index) => actual[index] === item);
}

function toProjectPath(cwd, resolved) {
  const relative = path.relative(cwd, resolved).split(path.sep).join('/');
  return relative.startsWith('..') ? resolved : relative;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
