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
    assert.equal(row.privacy_pass, false);
    assert.equal(row.purge_pass, false);
    assert.equal(row.cleanup_pass, false);
    assert.equal(row.continuity_pass, false);
    assert.equal(row.cost.input_tokens, null);
    assert.equal(row.cost.output_tokens, null);
    assert.equal(row.cost.input_output_tokens, null);
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
          command: `node ${path.join(tempDir, 'sandbox', 'fixture', 'emit-large-output.mjs')}`
        }],
        queries: ['north', 'east', 'checksum']
      }),
      rolloutTool('ctx_purge', { confirm: true, scope: 'project' })
    ], {
      sandboxRoot: path.join(tempDir, 'sandbox'),
      requiredTools: ['ctx_batch_execute', 'ctx_purge'],
      allowedTools: ['ctx_batch_execute', 'ctx_search', 'ctx_purge']
    });
    assert.deepEqual(result, {
      status: 'PASS',
      reason: 'raw_provider_audit_verified',
      record_count: 2,
      tool_counts: { ctx_batch_execute: 1, ctx_purge: 1 },
      required_tools_present: true,
      forbidden_tools_absent: true,
      paths_confined: true
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
    assert.equal(auditCodexRolloutRecords([rolloutTool('ctx_search', {
      path: 'C:\\outside\\facts.txt',
      queries: ['fact']
    })], {
      sandboxRoot,
      requiredTools: ['ctx_search'],
      allowedTools: ['ctx_search']
    }).reason, 'raw_provider_path_escape');
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

  it('keeps missing actual plugin lifecycle as NOT_RUN rather than simulated evidence', () => {
    const report = buildContextModeResults([
      safeRow('baseline'),
      safeRow('mcp_only'),
      { row_id: 'plugin', triad_id: 'triad', variant: 'codex_plugin', status: 'NOT_RUN', reason: 'auth_isolation_unavailable', settings_fingerprint: 'same' }
    ]);
    assert.equal(report.triads[0].plugin_decision, 'NOT_RUN');
    assert.equal(report.plugin_outcome, 'NOT_RUN');
  });
});

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
