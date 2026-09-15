// prime-agent-ai-tester-matrix.test.mjs - prepared-only issue #148 scenario contracts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  PRIME_AGENT_ASSERTION_SCHEMA,
  PRIME_AGENT_ADOPTION_BLOCKERS,
  PRIME_AGENT_BOUNDARY_CONTRACT,
  PRIME_AGENT_CATALOG_SCHEMA,
  PRIME_AGENT_DECISION,
  PRIME_AGENT_EXPERIMENTS,
  PRIME_AGENT_ISSUE,
  PRIME_AGENT_MATRIX_SCHEMA,
  PRIME_AGENT_NOT_RUN_REASONS,
  PRIME_AGENT_PINNED_IDENTITY,
  buildPrimeAgentMatrix,
  containsPrivateMaterial,
  loadPrimeAgentCatalog,
  renderPrimeAgentMarkdown,
  validatePrimeAgentCatalog,
  validatePrimeAgentMatrix
} from './prime-agent-ai-tester-matrix.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_AT = '2026-09-14T00:00:00.000Z';
const RUN_ID = 'prime-agent-prepared-unittest';

let cachedCatalog;
async function committedCatalog() {
  cachedCatalog ??= await loadPrimeAgentCatalog({ cwd: repoRoot });
  return cachedCatalog;
}

function editableCatalog() {
  return structuredClone(catalogValue);
}
let catalogValue;

describe('Prime Agent ai-tester catalog', () => {
  it('pins the deferred issue #148 identity and prepared-only defaults', async () => {
    assert.equal(Object.isFrozen(PRIME_AGENT_PINNED_IDENTITY), true);
    assert.equal(Object.isFrozen(PRIME_AGENT_EXPERIMENTS), true);
    assert.equal(Object.isFrozen(PRIME_AGENT_NOT_RUN_REASONS), true);
    assert.equal(Object.isFrozen(PRIME_AGENT_ADOPTION_BLOCKERS), true);
    assert.equal(Object.isFrozen(PRIME_AGENT_BOUNDARY_CONTRACT), true);
    assert.deepEqual(PRIME_AGENT_PINNED_IDENTITY, {
      prime_agent_release: 'v0.9.1',
      prime_agent_revision: '81ae3cb34d27d38ee37f9e205a1e73694993b344',
      aifhub_revision: 'a560e3fcf6148d9e1663c51db188f6c1491a6477',
      evaluation_date: '2026-09-05',
      provider_calls: 0,
      real_child_agents: 0,
      cost: 'none'
    });
    assert.equal(PRIME_AGENT_DECISION, 'defer_supported_runtime');
    assert.equal(PRIME_AGENT_ISSUE, 148);
    assert.equal(PRIME_AGENT_ASSERTION_SCHEMA, 'aifhub.prime_agent.assertions.v1');

    const catalog = await committedCatalog();
    assert.equal(catalog.schema, PRIME_AGENT_CATALOG_SCHEMA);
    assert.equal(catalog.decision, PRIME_AGENT_DECISION);
    assert.equal(catalog.prepared_only, true);
    assert.equal(catalog.no_promote, true);
    assert.deepEqual(catalog.pinned_identity, { ...PRIME_AGENT_PINNED_IDENTITY });
    assert.equal(catalog.defaults.status, 'NOT_RUN');
    assert.equal(catalog.defaults.adoption_gate, 'blocked');
    assert.equal(catalog.defaults.provenance_class, 'prepared_scenario_no_execution');
    assert.deepEqual(validatePrimeAgentCatalog(catalog), []);
    assert.equal(containsPrivateMaterial(catalog), false);
  });

  it('encodes the eight remaining README experiments, all NOT_RUN with documented reasons', async () => {
    const catalog = await committedCatalog();
    assert.deepEqual(PRIME_AGENT_EXPERIMENTS, [
      'role-integrity',
      'read-only-child',
      'worker-result-correlation',
      'gate-disagreement',
      'full-lifecycle',
      'background-recovery',
      'evolution-export',
      'installer-lifecycle'
    ]);
    assert.deepEqual(catalog.scenarios.map((scenario) => scenario.id), [...PRIME_AGENT_EXPERIMENTS]);
    assert.deepEqual(Object.keys(catalog.not_run_reasons), [...PRIME_AGENT_NOT_RUN_REASONS]);
    assert.deepEqual(Object.keys(catalog.adoption_blockers), [...PRIME_AGENT_ADOPTION_BLOCKERS]);
    for (const scenario of catalog.scenarios) {
      assert.equal(scenario.status, 'NOT_RUN', scenario.id);
      assert.ok(PRIME_AGENT_NOT_RUN_REASONS.includes(scenario.not_run_reason), scenario.id);
      assert.ok(scenario.required_evidence.length >= 1, scenario.id);
      assert.ok(scenario.guards.length >= 1, scenario.id);
      assert.ok(scenario.forbidden_claims.length >= 1, scenario.id);
      assert.ok(scenario.privacy_canaries.length >= 1, scenario.id);
    }
    assert.equal(
      catalog.scenarios.find((scenario) => scenario.id === 'role-integrity').not_run_reason,
      'protected_role_contract_missing'
    );
    assert.equal(
      catalog.scenarios.find((scenario) => scenario.id === 'read-only-child').not_run_reason,
      'real_child_and_dcg_adapter'
    );
    assert.equal(
      catalog.scenarios.find((scenario) => scenario.id === 'full-lifecycle').not_run_reason,
      'runtime_adoption_blocked'
    );
  });

  it('rejects schema drift, fabricated execution claims and boundary regressions', async () => {
    await committedCatalog();
    catalogValue = structuredClone(cachedCatalog);
    delete catalogValue.source_path;

    const expectError = (mutate, fragment) => {
      const value = editableCatalog();
      mutate(value);
      const errors = validatePrimeAgentCatalog(value);
      assert.ok(errors.some((error) => error.includes(fragment)),
        `expected an error containing "${fragment}", got: ${errors.join('; ')}`);
    };

    expectError((value) => { value.schema = 'aifhub.prime_agent.ai_tester_catalog.v2'; }, 'schema');
    expectError((value) => { value.issue = 149; }, 'issue');
    expectError((value) => { value.decision = 'adopt_supported_runtime'; }, 'decision');
    expectError((value) => { value.prepared_only = false; }, 'prepared_only');
    expectError((value) => { value.no_promote = false; }, 'no_promote');
    expectError((value) => { value.pinned_identity.prime_agent_release = 'v0.9.2'; }, 'pinned_identity.prime_agent_release');
    expectError((value) => { value.pinned_identity.provider_calls = 3; }, 'pinned_identity.provider_calls');
    expectError((value) => { value.pinned_identity.extra = true; }, 'pinned_identity keys');
    expectError((value) => { value.boundary_contract.no_runtime_adoption = false; }, 'boundary_contract.no_runtime_adoption');
    expectError((value) => { delete value.boundary_contract.no_evolve_harness_delta_export; }, 'boundary_contract keys');
    expectError((value) => { value.defaults.status = 'PASS'; }, 'defaults.status');
    expectError((value) => { value.defaults.adoption_gate = 'open'; }, 'defaults.adoption_gate');
    expectError((value) => { value.defaults.assertion_schema = 'aifhub.other.assertions.v1'; }, 'assertion_schema');
    expectError((value) => { value.defaults.timeout_seconds = 10; }, 'timeout_seconds');
    expectError((value) => { delete value.not_run_reasons.real_child_and_dcg_adapter; }, 'not_run_reasons keys');
    expectError((value) => { value.not_run_reasons.runtime_adoption_blocked = ''; }, 'not_run_reasons.runtime_adoption_blocked');
    expectError((value) => { value.adoption_blockers.enforced_permission_parity_missing = false; }, 'adoption_blockers.enforced_permission_parity_missing');
    expectError((value) => { value.scenarios.reverse(); }, 'scenarios must be, in order');
    expectError((value) => { value.scenarios[0].status = 'PASS'; }, 'status must be NOT_RUN');
    expectError((value) => { value.scenarios[0].not_run_reason = 'made_up_reason'; }, 'not_run_reason must be one of');
    expectError((value) => { value.scenarios[0].required_evidence = []; }, 'required_evidence');
    expectError((value) => { value.scenarios[1].guards = ['']; }, 'guards');
    expectError((value) => { value.scenarios[0].title = 'C:\\Users\\dev\\note'; }, 'title must be sanitized text');

    const catalog = await committedCatalog();
    assert.deepEqual(validatePrimeAgentCatalog(catalog), []);
  });
});

describe('Prime Agent ai-tester prepared matrix', () => {
  it('builds a deterministic blocked matrix with zero executed scenarios', async () => {
    const catalog = await committedCatalog();
    const first = buildPrimeAgentMatrix({ catalog, runId: RUN_ID, generatedAt: GENERATED_AT });
    const second = buildPrimeAgentMatrix({ catalog, runId: RUN_ID, generatedAt: GENERATED_AT });
    assert.deepEqual(first, second);
    assert.equal(first.schema, PRIME_AGENT_MATRIX_SCHEMA);
    assert.equal(first.issue, 148);
    assert.equal(first.decision, PRIME_AGENT_DECISION);
    assert.equal(first.adoption_gate, 'blocked');
    assert.equal(first.prepared_only, true);
    assert.equal(first.no_promote, true);
    assert.deepEqual(first.adoption_blockers, [...PRIME_AGENT_ADOPTION_BLOCKERS]);
    assert.deepEqual(first.boundary_contract, { ...PRIME_AGENT_BOUNDARY_CONTRACT });
    assert.equal(first.cases.length, 8);
    assert.deepEqual(first.counts, { scenarios: 8, executed: 0, passed: 0, failed: 0 });
    for (const matrixCase of first.cases) {
      assert.equal(matrixCase.executed, false, matrixCase.id);
      assert.equal(matrixCase.prepared, true, matrixCase.id);
      assert.equal(matrixCase.status, 'NOT_RUN', matrixCase.id);
      assert.equal(matrixCase.provenance_class, 'prepared_scenario_no_execution', matrixCase.id);
    }
    assert.deepEqual(validatePrimeAgentMatrix(first), []);
    assert.equal(containsPrivateMaterial(first), false);
  });

  it('refuses matrices that claim execution, passage or an open gate', async () => {
    const catalog = await committedCatalog();
    const matrix = buildPrimeAgentMatrix({ catalog, runId: RUN_ID, generatedAt: GENERATED_AT });

    const expectError = (mutate, fragment) => {
      const value = structuredClone(matrix);
      mutate(value);
      const errors = validatePrimeAgentMatrix(value);
      assert.ok(errors.some((error) => error.includes(fragment)),
        `expected an error containing "${fragment}", got: ${errors.join('; ')}`);
    };

    expectError((value) => { value.schema = PRIME_AGENT_CATALOG_SCHEMA; }, 'schema');
    expectError((value) => { value.decision = 'adopt'; }, 'decision');
    expectError((value) => { value.prepared_only = false; }, 'prepared_only');
    expectError((value) => { value.no_promote = false; }, 'no_promote');
    expectError((value) => { value.adoption_gate = 'open'; }, 'adoption_gate');
    expectError((value) => { value.adoption_blockers = []; }, 'adoption_blockers');
    expectError((value) => { value.cases[0].status = 'PASS'; }, 'status must be NOT_RUN');
    expectError((value) => { value.cases[0].executed = true; }, 'executed must be false');
    expectError((value) => { value.cases[0].prepared = false; }, 'prepared must be true');
    expectError((value) => { value.cases[0].not_run_reason = 'made_up_reason'; }, 'not_run_reason must be a documented NOT_RUN reason');
    expectError((value) => { value.cases.pop(); }, 'cases must be, in order');
    expectError((value) => { value.counts = { scenarios: 8, executed: 2, passed: 1, failed: 0 }; }, 'counts');
    expectError((value) => { value.cases[2].title = '/home/dev/transcript'; }, 'private-looking');

    assert.deepEqual(validatePrimeAgentMatrix(matrix), []);
  });

  it('renders sanitized markdown that cannot read as an adoption result', async () => {
    const catalog = await committedCatalog();
    const matrix = buildPrimeAgentMatrix({ catalog, runId: RUN_ID, generatedAt: GENERATED_AT });
    const markdown = renderPrimeAgentMarkdown(matrix);

    assert.ok(markdown.includes('# Prime Agent ai-tester prepared matrix — issue #148'));
    assert.ok(markdown.includes('`defer_supported_runtime`'));
    assert.ok(markdown.includes('`blocked`'));
    assert.ok(markdown.includes('Prepared scenarios are not executed results'));
    for (const experiment of PRIME_AGENT_EXPERIMENTS) {
      assert.ok(markdown.includes(experiment), experiment);
      const row = markdown.split('\n').find((line) => line.startsWith(`| ${experiment} |`));
      assert.ok(row?.includes('| NOT_RUN |'), experiment);
    }
    assert.equal(/\| (?:PASS|FAIL) \|/.test(markdown), false);
    assert.ok(markdown.includes('0 executed, 0 passed, 0 failed'));
    for (const flag of Object.keys(PRIME_AGENT_BOUNDARY_CONTRACT)) {
      assert.ok(markdown.includes(`- ${flag}: true`), flag);
    }
    assert.equal(containsPrivateMaterial(markdown), false);

    assert.throws(() => renderPrimeAgentMarkdown({ ...matrix, cases: [] }), /Invalid Prime Agent matrix/);
  });
});

describe('Prime Agent committed research guards', () => {
  it('keeps the probe results on the deferred, zero-inference decision', async () => {
    const results = JSON.parse(await readFile(
      path.join(repoRoot, 'docs', 'runtime-research', 'prime-agent', 'results.json'),
      'utf8'
    ));
    assert.equal(results.decision, 'defer_supported_runtime');
    assert.equal(results.refinement_probe.adoption_pass, false);
    assert.equal(results.kernel_probe.adoption_pass, false);
    assert.equal(results.refinement_probe.provider_calls, 0);
    assert.equal(results.kernel_probe.provider_calls, 0);
    assert.equal(results.kernel_probe.real_child_agents, 0);
    assert.equal(results.refinement_probe.upstream_revision, PRIME_AGENT_PINNED_IDENTITY.prime_agent_revision);
    assert.equal(results.kernel_probe.upstream_revision, PRIME_AGENT_PINNED_IDENTITY.prime_agent_revision);
  });

  it('keeps prime-agent out of the managed runtime surfaces', async () => {
    for (const manifest of ['extension.json', 'aifhub-extension.json']) {
      const raw = await readFile(path.join(repoRoot, manifest), 'utf8');
      assert.equal(raw.includes('prime-agent'), false, `${manifest} must not reference prime-agent`);
      assert.equal(raw.includes('prime_agent'), false, `${manifest} must not reference prime_agent`);
    }
    const extension = JSON.parse(await readFile(path.join(repoRoot, 'extension.json'), 'utf8'));
    const runtimes = (extension.agentFiles ?? []).map((entry) => entry.runtime);
    assert.ok(runtimes.length > 0);
    for (const runtime of runtimes) {
      assert.ok(['claude', 'codex'].includes(runtime), runtime);
    }
    for (const entry of extension.agentFiles ?? []) {
      assert.ok(!entry.target.endsWith('.py'), entry.target);
    }
  });
});
