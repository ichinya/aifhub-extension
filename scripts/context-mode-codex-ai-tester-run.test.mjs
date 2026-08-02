// context-mode-codex-ai-tester-run.test.mjs - provenance-safe runner contracts
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  buildRunnerInvocation,
  planMissingRows,
  runVerifiedMatrix,
  validateRunnerProvenance,
  validateTraceRoot
} from './context-mode-codex-ai-tester-run.mjs';

let tempDir;
beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'context-mode-runner-'));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('context-mode dedicated runner', () => {
  it('rejects PATH ambiguity, dirty source and mismatched binary provenance', () => {
    assert.equal(validateRunnerProvenance({
      executable: 'ai-tester',
      source_clean: true,
      source_commit: 'expected',
      expected_source_commit: 'expected',
      binary_sha256: 'a',
      expected_binary_sha256: 'a'
    }).reason, 'explicit_executable_required');
    assert.equal(validateRunnerProvenance({
      executable: 'C:/tools/ai-tester.exe',
      source_clean: false,
      source_commit: 'expected',
      expected_source_commit: 'expected',
      binary_sha256: 'a',
      expected_binary_sha256: 'a'
    }).reason, 'runner_source_dirty');
    assert.equal(validateRunnerProvenance({
      executable: 'C:/tools/ai-tester.exe',
      source_clean: true,
      source_commit: 'expected',
      expected_source_commit: 'expected',
      binary_sha256: 'b',
      expected_binary_sha256: 'a'
    }).reason, 'runner_binary_mismatch');
  });

  it('runs only missing rows after a mandatory dry-run', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(planMissingRows(rows, new Set(['b'])).map((row) => row.id), ['a', 'c']);
    const invocation = buildRunnerInvocation({
      executable: 'C:/tools/ai-tester.exe',
      scenarioFile: 'C:/sandbox/scenarios/a.yaml',
      runRoot: 'C:/sandbox/runs',
      row: { id: 'a', model: 'gpt-5.6-luna', reasoning: 'low' },
      dryRun: true
    });
    assert.equal(invocation.command, 'C:/tools/ai-tester.exe');
    assert.ok(invocation.args.includes('--dry-run'));
    assert.ok(invocation.args.includes('gpt-5.6-luna'));
    assert.ok(invocation.args.includes('low'));
  });

  it('rejects traces outside the isolated run root', () => {
    assert.equal(validateTraceRoot('C:/sandbox/runs', 'C:/sandbox/runs/a/trace.json').status, 'PASS');
    assert.equal(validateTraceRoot('C:/sandbox/runs', 'C:/other/trace.json').reason, 'unexpected_trace_root');
  });

  it('does not execute when provenance or low-reasoning proof is unavailable', async () => {
    let calls = 0;
    const dirty = {
      executable: 'C:/tools/ai-tester.exe',
      source_clean: false,
      source_commit: 'expected',
      expected_source_commit: 'expected',
      binary_sha256: 'a',
      expected_binary_sha256: 'a'
    };
    const result = await runVerifiedMatrix({
      matrix: { rows: [{ id: 'a', model: 'gpt-5.6-luna', reasoning: 'low' }] },
      sourceRoot: 'C:/tools/source',
      expectedSourceCommit: 'expected',
      expectedBinarySha256: 'a',
      inspectProvenance: async () => dirty,
      profileProof: { status: 'PASS' },
      sandboxRoot: 'C:/sandbox',
      scenarioRoot: 'C:/sandbox/scenarios',
      runRoot: 'C:/sandbox/runs',
      executable: 'C:/tools/ai-tester.exe',
      runProcess: async () => { calls += 1; return { exitCode: 0 }; }
    });
    assert.equal(result.reason, 'runner_source_dirty');
    assert.equal(calls, 0);
  });

  it('does not report aggregate PASS when dry-run or live rows do not pass', async () => {
    const options = await runnerOptions({
      runProcess: async () => ({ exitCode: 1 })
    });
    const result = await runVerifiedMatrix(options);
    assert.equal(result.status, 'NOT_RUN');
    assert.equal(result.reason, 'no_rows_passed');
    assert.equal(result.statuses[0].reason, 'dry_run_failed');
  });

  it('rejects missing or stale traces instead of trusting process exit zero', async () => {
    const options = await runnerOptions({ runProcess: async () => ({ exitCode: 0 }) });
    const stalePath = path.join(options.runRoot, 'inline', 'stale.json');
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, JSON.stringify(validTrace('row-a')), 'utf8');
    const result = await runVerifiedMatrix(options);
    assert.equal(result.status, 'NOT_RUN');
    assert.equal(result.statuses[0].reason, 'trace_evidence_missing_or_stale');
  });

  it('does not substitute a same-thread model turn for external fresh-session evidence', async () => {
    let calls = 0;
    const options = await runnerOptions({
      runProcess: async () => {
        calls += 1;
        return { exitCode: 0 };
      }
    });
    options.matrix.rows[0].session_mode = 'external_fresh_pair';
    const result = await runVerifiedMatrix(options);
    assert.equal(calls, 1, 'only schema dry-run may execute without an external session driver');
    assert.equal(result.status, 'NOT_RUN');
    assert.equal(result.statuses[0].reason, 'fresh_session_driver_unavailable');
  });

  it('does not execute a provider variant without an explicit provisioning boundary', async () => {
    let calls = 0;
    const options = await runnerOptions({
      runProcess: async () => { calls += 1; return { exitCode: 0 }; }
    });
    options.matrix.rows[0].variant = 'mcp_only';
    options.matrix.rows[0].execution_gate = {
      status: 'BLOCKED',
      reason: 'runtime_dependency_self_install'
    };
    const result = await runVerifiedMatrix(options);
    assert.equal(calls, 0, 'unavailable provider variants must skip ai-tester entirely');
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.statuses[0].reason, 'runtime_dependency_self_install');
  });

  it('does not execute an apparently eligible provider row without a provisioner', async () => {
    let calls = 0;
    const options = await runnerOptions({
      runProcess: async () => { calls += 1; return { exitCode: 0 }; }
    });
    options.matrix.rows[0].variant = 'mcp_only';
    options.matrix.rows[0].execution_gate = { status: 'PASS', reason: 'provider_ready' };
    const result = await runVerifiedMatrix(options);
    assert.equal(calls, 0);
    assert.equal(result.status, 'NOT_RUN');
    assert.equal(result.statuses[0].reason, 'provider_provisioner_unavailable');
  });

  it('fails a matching ai-tester trace when complete external lifecycle evidence is absent', async () => {
    let calls = 0;
    const options = await runnerOptions({
      rowEvidence: {},
      runProcess: async () => {
        calls += 1;
        if (calls === 2) {
          const tracePath = path.join(tempDir, 'sandbox', 'runs', 'inline', 'incomplete.json');
          await mkdir(path.dirname(tracePath), { recursive: true });
          await writeFile(tracePath, JSON.stringify(validTrace('row-a')), 'utf8');
        }
        return { exitCode: 0 };
      }
    });
    const result = await runVerifiedMatrix(options);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.statuses[0].reason, 'incomplete_trace_evidence');
  });

  it('accepts only a fresh matching trace under the isolated run root', async () => {
    let calls = 0;
    const childEnvironments = [];
    const options = await runnerOptions({
      env: { PATH: 'runtime', OPENAI_API_KEY: 'must-not-cross', UNKNOWN_SECRET: 'drop-me' },
      runProcess: async (_command, _args, processOptions) => {
        calls += 1;
        childEnvironments.push(processOptions.env);
        if (calls === 2) {
          const tracePath = path.join(tempDir, 'sandbox', 'runs', 'inline', 'fresh.json');
          await mkdir(path.dirname(tracePath), { recursive: true });
          await writeFile(tracePath, JSON.stringify(validTrace('row-a')), 'utf8');
        }
        return { exitCode: 0 };
      }
    });
    const result = await runVerifiedMatrix(options);
    assert.equal(result.status, 'PASS');
    assert.equal(result.statuses[0].status, 'PASS');
    assert.equal(result.statuses[0].trace_class, 'isolated_run_descendant');
    assert.equal(result.results.rows[0].status, 'PASS');
    assert.ok(childEnvironments.every((env) => env.OPENAI_API_KEY === undefined && env.UNKNOWN_SECRET === undefined));
    assert.ok(childEnvironments.every((env) => {
      const relative = path.relative(options.sandboxRoot, env.HOME);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    }));
    assert.doesNotMatch(JSON.stringify(result), /context-mode-runner-|fresh\.json/);
  });

  it('deletes an unsafe fresh trace and returns only bounded reason codes', async () => {
    let calls = 0;
    let tracePath;
    const options = await runnerOptions({
      runProcess: async () => {
        calls += 1;
        if (calls === 2) {
          tracePath = path.join(tempDir, 'sandbox', 'runs', 'inline', 'unsafe.json');
          await mkdir(path.dirname(tracePath), { recursive: true });
          const trace = validTrace('row-a');
          trace.debug = { OPENAI_API_KEY: 'secret-value', cwd: 'C:\\projects\\private\\repo' };
          await writeFile(tracePath, JSON.stringify(trace), 'utf8');
        }
        return { exitCode: 0 };
      }
    });
    const result = await runVerifiedMatrix(options);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.statuses[0].reason, 'unsafe_trace_evidence');
    assert.deepEqual(result.statuses[0].reason_codes, ['absolute_path', 'credential_material']);
    await assert.rejects(access(tracePath));
    assert.doesNotMatch(JSON.stringify(result), /secret-value|private[\\/]repo|unsafe\.json/);
  });
});

async function runnerOptions({ runProcess, rowEvidence = defaultRowEvidence(), env = {} }) {
  const sandboxRoot = path.join(tempDir, 'sandbox');
  const scenarioRoot = path.join(sandboxRoot, 'scenarios');
  const runRoot = path.join(sandboxRoot, 'runs');
  await mkdir(scenarioRoot, { recursive: true });
  await mkdir(runRoot, { recursive: true });
  return {
    matrix: { rows: [{
      id: 'row-a',
      triad_id: 'triad-a',
      variant: 'baseline',
      settings_fingerprint: 'same',
      scenario_id: 'large_generated_output_retrieval',
      model: 'gpt-5.6-luna',
      reasoning: 'low',
      assertions: [{ id: 'north' }],
      execution_gate: { status: 'PASS', reason: 'baseline_ready' }
    }] },
    sourceRoot: path.join(tempDir, 'ai-tester-source'),
    expectedSourceCommit: 'expected',
    expectedBinarySha256: 'a',
    inspectProvenance: async ({ executable }) => ({
      executable,
      source_clean: true,
      source_commit: 'expected',
      expected_source_commit: 'expected',
      binary_sha256: 'a',
      expected_binary_sha256: 'a',
      version: 'test'
    }),
    profileProof: { status: 'PASS' },
    sandboxRoot,
    scenarioRoot,
    runRoot,
    executable: path.join(tempDir, 'ai-tester.exe'),
    env,
    rowEvidence,
    runProcess
  };
}

function defaultRowEvidence() {
  return {
    'row-a': {
      evidence_class: 'ai_tester_trace_plus_external_lifecycle',
      lifecycle: { privacy: true, purge: true, cleanup: true, continuity: true },
      cost: {
        cold_setup_ms: 10,
        mcp_startup_ms: 0,
        index_ms: 0,
        warm_query_ms: 0,
        answer_ms: 5
      }
    }
  };
}

function validTrace(scenarioName) {
  return {
    schemaVersion: '2.0.0',
    runId: 'fresh-run',
    scenario: { name: scenarioName },
    runner: { runtime: 'codex', model: 'gpt-5.6-luna', reasoning: 'low', sessionId: 'fresh-session' },
    turns: [],
    finalOutput: 'north=17 east=29 checksum=46',
    assertions: [{ id: 'north', pass: true }],
    scoring: { allPassed: true, overallPass: true },
    cost: { inputTokens: 1, outputTokens: 1 },
    errors: []
  };
}
