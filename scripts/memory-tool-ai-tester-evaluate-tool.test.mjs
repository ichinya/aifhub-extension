// memory-tool-ai-tester-evaluate-tool.test.mjs - one-shot tool evaluation orchestration contracts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AI_TESTER_TOOL_EVALUATION_SCHEMA,
  runMemoryToolAiTesterToolEvaluation
} from './memory-tool-ai-tester-evaluate-tool.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memory-tool-evaluate-tool-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('ai-tester one-shot tool evaluation', () => {
  it('orchestrates matrix, missing runs, report, and promotion proposal for one tool/root', async () => {
    const calls = [];
    const result = await runMemoryToolAiTesterToolEvaluation([
      '--tool',
      'codegraph',
      '--root',
      'project-a',
      '--out',
      'out',
      '--scenario-prefix',
      'stable-prefix',
      '--run-id',
      'stable-run',
      '--max-runs',
      '2',
      '--preinitialize',
      '--profile-id-mode',
      'path-hash',
      '--json'
    ], fakeOptions(calls));

    assert.equal(result.exitCode, 0);
    assert.equal(result.body.schema, AI_TESTER_TOOL_EVALUATION_SCHEMA);
    assert.equal(result.body.tool_id, 'codegraph');
    assert.equal(result.body.mode.ran_ai_tester, true);
    assert.equal(result.body.mode.wrote_promotion_proposal, true);
    assert.equal(result.body.mode.promoted_metadata, false);
    assert.equal(result.body.summary.matrix_cases, 2);
    assert.equal(result.body.summary.executed_rows, 2);
    assert.equal(result.body.summary.promotion_entries, 1);
    assert.deepEqual(calls.map((call) => call.name), ['matrix', 'missing', 'report', 'promote']);

    const matrixArgs = calls[0].args;
    assert.deepEqual(argValues(matrixArgs, '--tool'), ['codegraph']);
    assert.deepEqual(argValues(matrixArgs, '--roots'), ['project-a']);
    assert.deepEqual(argValues(matrixArgs, '--run-class'), ['accepted_evidence']);
    assert.equal(argValue(matrixArgs, '--profile-id-mode'), 'path-hash');
    assert.equal(matrixArgs.includes('--scenario-catalog'), true);
    assert.equal(matrixArgs.includes('--preinitialize-tool'), true);

    const missingArgs = calls[1].args;
    assert.equal(argValue(missingArgs, '--matrix-dir'), path.join(tmpDir, 'out'));
    assert.equal(argValue(missingArgs, '--max-runs'), '2');
    assert.equal(argValue(missingArgs, '--runs-dir'), path.join(tmpDir, 'runs'));
    assert.equal(missingArgs.includes('--no-report-copy'), true);

    const reportArgs = calls[2].args;
    assert.equal(argValue(reportArgs, '--runs-dir'), path.join(tmpDir, 'runs'));

    const promoteArgs = calls[3].args;
    assert.equal(argValue(promoteArgs, '--run-id'), 'stable-run');
    assert.equal(promoteArgs.includes('--apply'), false);
  });

  it('supports no-run/no-promote mode for preparing scenarios only', async () => {
    const calls = [];
    const result = await runMemoryToolAiTesterToolEvaluation([
      '--tool',
      'graphify',
      '--root',
      'project-a',
      '--out',
      'out',
      '--no-run',
      '--no-promote',
      '--json'
    ], fakeOptions(calls));

    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls.map((call) => call.name), ['matrix', 'report']);
    assert.equal(result.body.mode.ran_ai_tester, false);
    assert.equal(result.body.paths.promotion_json, null);
    assert.ok(result.body.notes.some((note) => /No-run mode/i.test(note)));
  });

  it('dry-run only invokes matrix and does not write report or promotion outputs', async () => {
    const calls = [];
    const result = await runMemoryToolAiTesterToolEvaluation([
      '--tool',
      'context7',
      '--root',
      'project-a',
      '--dry-run',
      '--json'
    ], fakeOptions(calls));

    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls.map((call) => call.name), ['matrix']);
    assert.equal(result.body.paths.matrix_summary, null);
    assert.equal(result.body.paths.report_json, null);
    assert.equal(result.body.mode.dry_run, true);
  });

  it('passes --apply only when metadata mutation is explicitly requested', async () => {
    const calls = [];
    const result = await runMemoryToolAiTesterToolEvaluation([
      '--tool',
      'codegraph',
      '--root',
      'project-a',
      '--out',
      'out',
      '--apply',
      '--json'
    ], fakeOptions(calls));

    assert.equal(result.exitCode, 0);
    assert.equal(result.body.mode.promoted_metadata, true);
    assert.equal(calls.find((call) => call.name === 'promote').args.includes('--apply'), true);
  });

  it('rejects missing required tool or root arguments', async () => {
    await assert.rejects(
      () => runMemoryToolAiTesterToolEvaluation(['--root', 'project-a'], fakeOptions([])),
      /Missing required --tool/
    );
    await assert.rejects(
      () => runMemoryToolAiTesterToolEvaluation(['--tool', 'codegraph'], fakeOptions([])),
      /Missing required --root/
    );
  });
});

function fakeOptions(calls) {
  return {
    cwd: tmpDir,
    stdout: [],
    exit: false,
    runMatrix: async (args) => {
      calls.push({ name: 'matrix', args });
      return {
        exitCode: 0,
        body: {
          schema: 'aifhub.memory_tools.ai_tester_matrix.v1',
          case_count: 2
        }
      };
    },
    runMissing: async (args) => {
      calls.push({ name: 'missing', args });
      return {
        exitCode: 0,
        body: {
          attempted: 2,
          failed: 0
        }
      };
    },
    runReport: async (args) => {
      calls.push({ name: 'report', args });
      return {
        exitCode: 0,
        body: {
          schema: 'aifhub.memory_tools.ai_tester_results_report.v1',
          summary: {
            executed_rows: 2,
            not_run_rows: 0
          }
        }
      };
    },
    runPromote: async (args) => {
      calls.push({ name: 'promote', args });
      return {
        exitCode: 0,
        body: {
          schema: 'aifhub.memory_tools.ai_tester_metadata_promotion.v1',
          summary: {
            promoted_entries: 1,
            skipped_items: 0
          },
          output: {
            proposal_json: 'out/promotion/metadata-promotion-proposal.json',
            proposal_markdown: 'out/promotion/metadata-promotion-proposal.md',
            applied_metadata: args.includes('--apply') ? 'docs/memory-tools-research/recommendation-metadata.yaml' : null
          }
        }
      };
    }
  };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function argValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}
