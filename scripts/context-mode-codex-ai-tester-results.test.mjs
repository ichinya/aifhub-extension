// context-mode-codex-ai-tester-results.test.mjs - full-record safety and triad contracts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  auditCodexRolloutRecords,
  buildContextModeResults,
  normalizeContextModeTrace,
  scanCompleteTrace,
  sanitizeAndDeleteUnsafeTrace
} from './context-mode-codex-ai-tester-results.mjs';

let tempDir;
beforeEach(async () => { tempDir = await mkdtemp(path.join(os.tmpdir(), 'context-mode-results-')); });
afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

describe('context-mode complete-record normalization', () => {
  it('fails closed when required trace evidence is missing', () => {
    const row = normalizeContextModeTrace({});
    assert.equal(row.status, 'FAIL');
    assert.equal(row.reason, 'incomplete_trace_evidence');
    assert.equal(row.correctness_pass, false);
    assert.equal(row.privacy_pass, null);
    assert.equal(row.purge_pass, null);
    assert.equal(row.cleanup_pass, null);
    assert.equal(row.continuity_pass, null);
    assert.equal(row.cost.input_tokens, null);
    assert.equal(row.cost.output_tokens, null);
    assert.equal(row.cost.input_output_tokens, null);
  });

  it('fails closed instead of throwing when turns is not an array', () => {
    const trace = completeNormalizationTrace();
    trace.turns = { tool_calls: 1 };
    const row = normalizeContextModeTrace(trace);
    assert.equal(row.status, 'FAIL');
    assert.equal(row.reason, 'incomplete_trace_evidence');
    assert.equal(row.tool_calls, 0);
    assert.equal(row.turns, 0);
  });

  it('fails closed instead of throwing when a turn entry is null', () => {
    const trace = completeNormalizationTrace();
    trace.turns = [null];
    const row = normalizeContextModeTrace(trace);
    assert.equal(row.status, 'FAIL');
    assert.equal(row.reason, 'incomplete_trace_evidence');
    assert.equal(row.tool_calls, 0);
    assert.equal(row.turns, 1);
  });

  it('separates setup, MCP startup/index/query and answer costs', () => {
    const row = normalizeContextModeTrace({
      row_id: 'row',
      triad_id: 'triad',
      variant: 'baseline',
      status: 'PASS',
      settings_fingerprint: 'same',
      scoring: { overall_pass: true, required_facts: 3, recovered_facts: 3 },
      lifecycle: { privacy: true, purge: true, cleanup: true, continuity: true },
      evidence_class: 'ai_tester_trace',
      cost: {
        cold_setup_ms: 100, mcp_startup_ms: 20, index_ms: 30, warm_query_ms: 40,
        answer_ms: 50, input_tokens: 100, output_tokens: 25
      },
      turns: [{ tool_calls: 2 }],
      final_output: 'safe'
    });
    assert.deepEqual(row.cost, {
      cold_setup_ms: 100, mcp_startup_ms: 20, index_ms: 30, warm_query_ms: 40,
      answer_ms: 50, input_tokens: 100, output_tokens: 25, input_output_tokens: 125
    });
    assert.equal(row.tool_calls, 2);
  });

  it('rejects coercible non-number cost, scoring and turn evidence', () => {
    const completeTrace = () => ({
      row_id: 'row',
      triad_id: 'triad',
      variant: 'baseline',
      status: 'PASS',
      settings_fingerprint: 'same',
      scoring: { overall_pass: true, required_facts: 1, recovered_facts: 1 },
      lifecycle: { privacy: true, purge: true, cleanup: true, continuity: true },
      evidence_class: 'ai_tester_trace',
      cost: {
        cold_setup_ms: 0,
        mcp_startup_ms: 0,
        index_ms: 0,
        warm_query_ms: 0,
        answer_ms: 1,
        input_tokens: 1,
        output_tokens: 1
      },
      turns: [{ tool_calls: 0 }],
      final_output: 'safe'
    });

    for (const value of ['', '1', false, []]) {
      const trace = completeTrace();
      trace.cost.input_tokens = value;
      assert.equal(normalizeContextModeTrace(trace).reason, 'incomplete_trace_evidence');
    }

    const booleanScore = completeTrace();
    booleanScore.scoring.required_facts = true;
    assert.equal(normalizeContextModeTrace(booleanScore).reason, 'incomplete_trace_evidence');

    const arrayScore = completeTrace();
    arrayScore.scoring.recovered_facts = [1];
    assert.equal(normalizeContextModeTrace(arrayScore).reason, 'incomplete_trace_evidence');

    const booleanTurn = completeTrace();
    booleanTurn.turns = [{ tool_calls: false }];
    assert.equal(normalizeContextModeTrace(booleanTurn).reason, 'incomplete_trace_evidence');
  });

  it('scans the complete trace, not only final output', () => {
    const scan = scanCompleteTrace({
      final_output: 'safe',
      turns: [{ hidden: 'OPENAI_API_KEY=secret-value' }],
      nested: { path: 'C:\\Users\\private\\repo', canary: 'CM_CANARY_134' }
    }, {
      canaries: ['CM_CANARY_134'],
      contentFingerprints: ['secret fixture body']
    });
    assert.equal(scan.safe, false);
    assert.ok(scan.reason_codes.includes('credential_material'));
    assert.ok(scan.reason_codes.includes('absolute_path'));
    assert.ok(scan.reason_codes.includes('canary_material'));
  });

  it('allows absolute paths only inside the verified disposable sandbox', () => {
    const sandboxRoot = '/tmp/aifhub-context-mode-sandbox';
    const inside = scanCompleteTrace({
      trace_path: `${sandboxRoot}/runs/trace.json`
    }, { allowedAbsoluteRoots: [sandboxRoot] });
    const outside = scanCompleteTrace({
      trace_path: '/tmp/aifhub-context-mode-sibling/trace.json'
    }, { allowedAbsoluteRoots: [sandboxRoot] });
    assert.equal(inside.safe, true);
    assert.deepEqual(inside.reason_codes, []);
    assert.equal(outside.safe, false);
    assert.deepEqual(outside.reason_codes, ['absolute_path']);

    const macSandboxRoot = '/var/folders/ab/cd/T/aifhub-context-mode-sandbox';
    const macInside = scanCompleteTrace({
      trace_path: `${macSandboxRoot}/runs/trace.json`
    }, { allowedAbsoluteRoots: [macSandboxRoot] });
    const macOutside = scanCompleteTrace({
      trace_path: '/var/folders/ab/cd/T/private/trace.json'
    }, { allowedAbsoluteRoots: [macSandboxRoot] });
    const customTmpOutside = scanCompleteTrace({
      trace_path: '/opt/custom-tmp/private/trace.json'
    }, { allowedAbsoluteRoots: [macSandboxRoot] });
    const windowsOutside = scanCompleteTrace({
      trace_path: 'D:\\work\\private\\trace.json'
    }, { allowedAbsoluteRoots: ['D:\\work\\sandbox'] });
    const urlOnly = scanCompleteTrace({
      documentation_url: 'https://example.test/tmp/trace.json'
    });
    const uncOutside = scanCompleteTrace({
      trace_path: '\\\\server\\share\\trace.json'
    });
    const extendedWindowsOutside = scanCompleteTrace({
      trace_path: '\\\\?\\C:\\private\\trace.json'
    });
    const fileUriOutside = scanCompleteTrace({
      trace_path: 'file:///private/var/folders/trace.json'
    });
    assert.equal(macInside.safe, true);
    assert.deepEqual(macInside.reason_codes, []);
    assert.equal(macOutside.safe, false);
    assert.deepEqual(macOutside.reason_codes, ['absolute_path']);
    assert.equal(customTmpOutside.safe, false);
    assert.deepEqual(customTmpOutside.reason_codes, ['absolute_path']);
    assert.equal(windowsOutside.safe, false);
    assert.deepEqual(windowsOutside.reason_codes, ['absolute_path']);
    assert.equal(urlOnly.safe, true);
    assert.deepEqual(urlOnly.reason_codes, []);
    for (const scan of [uncOutside, extendedWindowsOutside, fileUriOutside]) {
      assert.equal(scan.safe, false);
      assert.deepEqual(scan.reason_codes, ['absolute_path']);
    }
  });

  it('deletes an unsafe raw trace after retaining only bounded aggregate reasons', async () => {
    const tracePath = path.join(tempDir, 'trace.json');
    await writeFile(tracePath, '{"token":"secret-value"}', 'utf8');
    const blocked = await sanitizeAndDeleteUnsafeTrace({
      tracePath,
      scan: { safe: false, reason_codes: ['credential_material'], match_count: 1 }
    });
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.raw_trace_deleted, false);
    assert.equal(await readFile(tracePath, 'utf8'), '{"token":"secret-value"}');

    const logs = [];
    const aggregate = await sanitizeAndDeleteUnsafeTrace({
      tracePath,
      allowedRoot: tempDir,
      scan: { safe: false, reason_codes: ['credential_material'], match_count: 1 },
      logger: (line) => logs.push(line)
    });
    await assert.rejects(readFile(tracePath, 'utf8'));
    assert.deepEqual(aggregate, {
      status: 'FAIL',
      reason_codes: ['credential_material'],
      match_count: 1,
      raw_trace_deleted: true
    });
    assert.doesNotMatch(JSON.stringify(aggregate), /secret-value/);
    assert.match(logs.join('\n'), /^\[FIX:134\] unsafe_trace_deleted /);
    assert.doesNotMatch(logs.join('\n'), /secret-value|context-mode-results-/);
  });

  it('does not delete an unsafe trace outside the verified owner root', async () => {
    const ownerRoot = path.join(tempDir, 'owner');
    const outside = path.join(tempDir, 'outside.json');
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(outside, '{"token":"secret-value"}', 'utf8');
    const result = await sanitizeAndDeleteUnsafeTrace({
      tracePath: outside,
      allowedRoot: ownerRoot,
      scan: { safe: false, reason_codes: ['credential_material'], match_count: 1 }
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.raw_trace_deleted, false);
    assert.equal(await readFile(outside, 'utf8'), '{"token":"secret-value"}');
  });
});

describe('context-mode raw Codex rollout audit', () => {
  it('keeps only bounded tool counts while accepting nested confined MCP calls', () => {
    const result = auditCodexRolloutRecords([
      rolloutTool('ctx_batch_execute', {
        cwd: path.join(tempDir, 'sandbox', 'fixture'),
        commands: [{
          label: 'large-output',
          command: 'node project/emit-large-output.mjs'
        }],
        queries: ['north', 'east', 'checksum']
      }),
      rolloutTool('ctx_purge', { confirm: true, scope: 'project' })
    ], {
      sandboxRoot: path.join(tempDir, 'sandbox'),
      requiredTools: ['ctx_batch_execute', 'ctx_purge'],
      allowedTools: ['ctx_batch_execute', 'ctx_search', 'ctx_purge'],
      allowedCommands: ['node project/emit-large-output.mjs']
    });
    assert.deepEqual(result, {
      status: 'PASS',
      reason: 'raw_provider_audit_verified',
      record_count: 2,
      tool_counts: { ctx_batch_execute: 1, ctx_purge: 1 },
      required_tools_present: true,
      forbidden_tools_absent: true,
      paths_confined: true,
      commands_allowed: true
    });
    assert.doesNotMatch(JSON.stringify(result), /context-mode-results-|sandbox|fixture/);
  });

  it('fails closed for a missing required call, a forbidden tool or an escaped nested path', () => {
    const sandboxRoot = path.join(tempDir, 'sandbox');
    assert.equal(auditCodexRolloutRecords([], {
      sandboxRoot,
      requiredTools: ['ctx_search'],
      allowedTools: ['ctx_search']
    }).reason, 'raw_provider_audit_missing');
    assert.equal(auditCodexRolloutRecords([rolloutTool('ctx_execute', { cwd: sandboxRoot })], {
      sandboxRoot,
      requiredTools: ['ctx_search'],
      allowedTools: ['ctx_search']
    }).reason, 'raw_provider_tool_forbidden');
    const unrelatedServer = rolloutTool('ctx_search', { queries: ['fact'] });
    unrelatedServer.payload.input.server = 'unrelated-provider';
    assert.equal(auditCodexRolloutRecords([unrelatedServer], {
      sandboxRoot,
      requiredTools: ['ctx_search'],
      allowedTools: ['ctx_search']
    }).reason, 'raw_provider_audit_missing');
    assert.equal(auditCodexRolloutRecords([rolloutTool('ctx_search', {
      path: path.resolve(tempDir, '..', 'outside.txt'),
      queries: ['fact']
    })], {
      sandboxRoot,
      requiredTools: ['ctx_search'],
      allowedTools: ['ctx_search']
    }).reason, 'raw_provider_path_escape');
    assert.equal(auditCodexRolloutRecords([rolloutTool('ctx_batch_execute', {
      cwd: sandboxRoot,
      commands: [{ command: `node ${path.resolve(tempDir, '..', 'outside.mjs')}` }]
    })], {
      sandboxRoot,
      requiredTools: ['ctx_batch_execute'],
      allowedTools: ['ctx_batch_execute']
    }).reason, 'raw_provider_path_escape');
    for (const command of ['node ..\\..\\outside.mjs', 'node ../../outside.mjs']) {
      const escaped = auditCodexRolloutRecords([rolloutTool('ctx_batch_execute', {
        cwd: path.join(sandboxRoot, 'fixture'),
        commands: [{ command }]
      })], {
        sandboxRoot,
        requiredTools: ['ctx_batch_execute'],
        allowedTools: ['ctx_batch_execute'],
        allowedCommands: ['node project/emit-large-output.mjs']
      });
      assert.equal(escaped.reason, 'raw_provider_path_escape');
      assert.doesNotMatch(JSON.stringify(escaped), /outside\.mjs|\.\.[\\/]/);
    }
    assert.equal(auditCodexRolloutRecords([rolloutTool('ctx_search', {
      path: 'C:\\outside\\facts.txt',
      queries: ['fact']
    })], {
      sandboxRoot,
      requiredTools: ['ctx_search'],
      allowedTools: ['ctx_search']
    }).reason, 'raw_provider_path_escape');
  });

  it('reports a safe but unlisted command separately from a path escape', () => {
    const sandboxRoot = path.join(tempDir, 'sandbox');
    const result = auditCodexRolloutRecords([rolloutTool('ctx_batch_execute', {
      cwd: path.join(sandboxRoot, 'fixture'),
      commands: [{ command: 'node project/other-safe.mjs' }]
    })], {
      sandboxRoot,
      requiredTools: ['ctx_batch_execute'],
      allowedTools: ['ctx_batch_execute'],
      allowedCommands: ['node project/emit-large-output.mjs']
    });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.reason, 'raw_provider_command_forbidden');
    assert.equal(result.paths_confined, true);
    assert.equal(result.commands_allowed, false);
    assert.doesNotMatch(JSON.stringify(result), /other-safe\.mjs|emit-large-output/);
  });

  it('honors an explicit non-node command allowlist while confining the executable path', () => {
    const sandboxRoot = path.join(tempDir, 'sandbox');
    const allowedCommand = 'python project/check.py';
    const allowed = auditCodexRolloutRecords([rolloutTool('ctx_batch_execute', {
      cwd: path.join(sandboxRoot, 'fixture'),
      commands: [{ command: allowedCommand }]
    })], {
      sandboxRoot,
      requiredTools: ['ctx_batch_execute'],
      allowedTools: ['ctx_batch_execute'],
      allowedCommands: [allowedCommand]
    });
    assert.equal(allowed.status, 'PASS');
    assert.equal(allowed.reason, 'raw_provider_audit_verified');

    const outsideExecutable = path.resolve(tempDir, '..', 'outside-python.exe');
    const escapedCommand = [outsideExecutable, 'project/check.py'];
    const escaped = auditCodexRolloutRecords([rolloutTool('ctx_batch_execute', {
      cwd: path.join(sandboxRoot, 'fixture'),
      commands: [{ command: escapedCommand }]
    })], {
      sandboxRoot,
      requiredTools: ['ctx_batch_execute'],
      allowedTools: ['ctx_batch_execute'],
      allowedCommands: [escapedCommand.join(' ')]
    });
    assert.equal(escaped.status, 'FAIL');
    assert.equal(escaped.reason, 'raw_provider_path_escape');

    for (const invalidExecutable of ['-x', 'FOO=bar', '.']) {
      const command = `${invalidExecutable} project/check.py`;
      const invalid = auditCodexRolloutRecords([rolloutTool('ctx_batch_execute', {
        cwd: path.join(sandboxRoot, 'fixture'),
        commands: [{ command }]
      })], {
        sandboxRoot,
        requiredTools: ['ctx_batch_execute'],
        allowedTools: ['ctx_batch_execute'],
        allowedCommands: [command]
      });
      assert.equal(invalid.status, 'FAIL');
      assert.equal(invalid.reason, 'raw_provider_path_escape');
    }
  });

  it('keeps array-form command path confinement independent from the command allowlist', () => {
    const sandboxRoot = path.join(tempDir, 'sandbox');
    const result = auditCodexRolloutRecords([rolloutTool('ctx_batch_execute', {
      cwd: path.join(sandboxRoot, 'fixture'),
      commands: [{ command: ['node', '../../outside.mjs'] }]
    })], {
      sandboxRoot,
      requiredTools: ['ctx_batch_execute'],
      allowedTools: ['ctx_batch_execute'],
      allowedCommands: ['node project/emit-large-output.mjs']
    });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.reason, 'raw_provider_path_escape');
    assert.equal(result.paths_confined, false);
    assert.doesNotMatch(JSON.stringify(result), /outside\.mjs|\.\.[\\/]/);

    const unlisted = auditCodexRolloutRecords([rolloutTool('ctx_batch_execute', {
      cwd: path.join(sandboxRoot, 'fixture'),
      commands: [{ command: ['node', 'project/other-safe.mjs'] }]
    })], {
      sandboxRoot,
      requiredTools: ['ctx_batch_execute'],
      allowedTools: ['ctx_batch_execute'],
      allowedCommands: ['node project/emit-large-output.mjs']
    });
    assert.equal(unlisted.reason, 'raw_provider_command_forbidden');
    assert.equal(unlisted.paths_confined, true);

    const allowed = auditCodexRolloutRecords([rolloutTool('ctx_batch_execute', {
      cwd: path.join(sandboxRoot, 'fixture'),
      commands: [{ command: ['node', 'project/emit-large-output.mjs'] }]
    })], {
      sandboxRoot,
      requiredTools: ['ctx_batch_execute'],
      allowedTools: ['ctx_batch_execute'],
      allowedCommands: ['node project/emit-large-output.mjs']
    });
    assert.equal(allowed.status, 'PASS');

    const malformed = auditCodexRolloutRecords([rolloutTool('ctx_batch_execute', {
      cwd: path.join(sandboxRoot, 'fixture'),
      commands: [{ command: { argv: ['node', '../../outside.mjs'] } }]
    })], {
      sandboxRoot,
      requiredTools: ['ctx_batch_execute'],
      allowedTools: ['ctx_batch_execute'],
      allowedCommands: ['node project/emit-large-output.mjs']
    });
    assert.equal(malformed.status, 'NOT_RUN');
    assert.equal(malformed.reason, 'raw_provider_audit_invalid');
  });

  it('reports rollout containment violations separately from missing provider calls', () => {
    const result = auditCodexRolloutRecords([], {
      sandboxRoot: path.join(tempDir, 'sandbox'),
      requiredTools: ['ctx_search'],
      allowedTools: ['ctx_search'],
      containmentViolation: true
    });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.reason, 'raw_provider_rollout_escape');
    assert.equal(result.record_count, 0);
    assert.doesNotMatch(JSON.stringify(result), /context-mode-results-|sandbox/);
  });
});

describe('context-mode triad decisions', () => {
  it('lets correctness, privacy, lifecycle and purge veto token savings', () => {
    const common = {
      triad_id: 'triad',
      settings_fingerprint: 'same',
      status: 'PASS',
      correctness_pass: true,
      privacy_pass: true,
      purge_pass: true,
      cleanup_pass: true,
      continuity_pass: true,
      cost: { input_tokens: 100, output_tokens: 20, input_output_tokens: 120 }
    };
    const report = buildContextModeResults([
      { ...common, row_id: 'b', variant: 'baseline' },
      { ...common, row_id: 'm', variant: 'mcp_only', cost: { input_tokens: 50, output_tokens: 10, input_output_tokens: 60 } },
      { ...common, row_id: 'p', variant: 'codex_plugin', privacy_pass: false, cost: { input_tokens: 20, output_tokens: 5, input_output_tokens: 25 } }
    ]);
    assert.equal(report.triads[0].mcp_decision, 'conditional');
    assert.equal(report.triads[0].plugin_decision, 'forbid');
    assert.equal(report.plugin_outcome, 'forbid');
  });

  it('avoids a correctness-only failure while reserving forbid for safety vetoes', () => {
    const report = buildContextModeResults([
      safeRow('baseline'),
      safeRow('mcp_only'),
      {
        ...safeRow('codex_plugin'),
        status: 'FAIL',
        reason: 'assertion_failed',
        correctness_pass: false
      }
    ]);

    assert.equal(report.triads[0].plugin_decision, 'avoid');
    assert.equal(report.plugin_outcome, 'avoid');
  });

  it('keeps missing actual plugin lifecycle as NOT_RUN rather than simulated evidence', () => {
    const report = buildContextModeResults([
      safeRow('baseline'),
      safeRow('mcp_only'),
      { row_id: 'plugin', triad_id: 'triad', variant: 'codex_plugin', status: 'NOT_RUN', reason: 'auth_isolation_unavailable', settings_fingerprint: 'same' }
    ]);
    assert.equal(report.triads[0].plugin_decision, 'NOT_RUN');
    assert.equal(report.plugin_outcome, 'NOT_RUN');
  });

  it('keeps incomplete lifecycle evidence unknown instead of reporting a safety veto', () => {
    const report = buildContextModeResults([
      safeRow('baseline'),
      safeRow('mcp_only'),
      {
        ...safeRow('codex_plugin'),
        status: 'FAIL',
        reason: 'incomplete_trace_evidence',
        privacy_pass: null,
        purge_pass: null,
        cleanup_pass: null,
        continuity_pass: null
      }
    ]);

    assert.equal(report.triads[0].plugin_decision, 'NOT_RUN');
    assert.equal(report.plugin_outcome, 'NOT_RUN');
  });

  it('keeps an explicit safety failure stronger than otherwise unknown lifecycle evidence', () => {
    const report = buildContextModeResults([
      safeRow('baseline'),
      safeRow('mcp_only'),
      {
        ...safeRow('codex_plugin'),
        status: 'NOT_RUN',
        reason: 'lifecycle_unavailable',
        privacy_pass: false,
        purge_pass: null,
        cleanup_pass: null,
        continuity_pass: null
      }
    ]);

    assert.equal(report.triads[0].plugin_decision, 'forbid');
    assert.equal(report.plugin_outcome, 'forbid');
  });
});

function completeNormalizationTrace() {
  return {
    row_id: 'row',
    triad_id: 'triad',
    variant: 'baseline',
    status: 'PASS',
    settings_fingerprint: 'same',
    scoring: { overall_pass: true, required_facts: 1, recovered_facts: 1 },
    lifecycle: { privacy: true, purge: true, cleanup: true, continuity: true },
    evidence_class: 'ai_tester_trace',
    cost: {
      cold_setup_ms: 0,
      mcp_startup_ms: 0,
      index_ms: 0,
      warm_query_ms: 0,
      answer_ms: 1,
      input_tokens: 1,
      output_tokens: 1
    },
    turns: [{ tool_calls: 0 }],
    final_output: 'safe'
  };
}

function safeRow(variant) {
  return {
    row_id: variant,
    triad_id: 'triad',
    variant,
    status: 'PASS',
    settings_fingerprint: 'same',
    correctness_pass: true,
    privacy_pass: true,
    purge_pass: true,
    cleanup_pass: true,
    continuity_pass: true,
    cost: { input_tokens: 100, output_tokens: 20, input_output_tokens: 120 }
  };
}

function rolloutTool(tool, argumentsValue) {
  return {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'functions.exec',
      input: {
        server: 'context-mode',
        tool,
        arguments: argumentsValue
      }
    }
  };
}
