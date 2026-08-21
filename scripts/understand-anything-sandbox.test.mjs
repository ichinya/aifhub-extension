// understand-anything-sandbox.test.mjs - sandbox plan and ai-tester runner contracts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { GATE_BLOCKED, GATE_FAIL, GATE_PASS } from './understand-anything-static-audit.mjs';
import { evaluateUnderstandAnythingEligibility } from './understand-anything-eligibility.mjs';
import {
  UNDERSTAND_ANYTHING_SANDBOX_SCHEMA,
  assertDescendantPath,
  buildUnderstandAnythingSandboxPlan,
  runUnderstandAnythingSandbox
} from './understand-anything-sandbox.mjs';

const FIXTURE_DIR = path.resolve('test/fixtures/understand-anything-static-audit');

describe('Understand Anything sandbox plan', () => {
  it('builds an ai-tester-only plan with isolated descendant roots and bounded confirmations', () => {
    const sandboxRoot = path.resolve('C:/sandbox/root');
    const plan = buildUnderstandAnythingSandboxPlan({
      sandboxRoot,
      confirmations: [
        { id: 'understandignore_reviewed', response: 'approved-reviewed', bounded: true },
        { id: 'workspace_private_confirmation', response: 'private-workspace-only', bounded: true }
      ],
      limits: { max_tokens: 8000 }
    });

    assert.equal(plan.schema, UNDERSTAND_ANYTHING_SANDBOX_SCHEMA);
    assert.equal(plan.command, 'ai-tester');
    assert.deepEqual(plan.roots, {
      checkout: 'checkout',
      fixture: 'fixture',
      output: '.ua',
      home: 'home',
      config: 'config',
      dependencies: '.ai-tester-tools'
    });
    assert.equal(plan.confirmations.length, 2);
    assert.equal(plan.limits.max_tokens, 8000);
    assert.equal(plan.cleanup_targets.every((item) => !/^[A-Za-z]:[\\/]/.test(item)), true);
  });

  it('rejects non-descendant sandbox targets and cleanup escapes', () => {
    const sandboxRoot = path.resolve('C:/sandbox/root');
    assert.throws(
      () => assertDescendantPath(sandboxRoot, sandboxRoot, 'checkout root'),
      /checkout root must stay inside the sandbox root/
    );
    assert.throws(
      () => buildUnderstandAnythingSandboxPlan({
        sandboxRoot,
        cleanupTargets: [path.resolve('C:/outside')]
      }),
      /cleanup target must stay inside the sandbox root/
    );
  });
});

describe('Understand Anything sandbox runner', () => {
  it('blocks before execution when eligibility is not PASS', async () => {
    let invoked = false;
    const result = await runUnderstandAnythingSandbox({
      eligibility: { outcome: GATE_BLOCKED }
    }, {
      aiTesterExecutor: async () => {
        invoked = true;
        return { status: GATE_PASS, output_schema_detected: true };
      }
    });

    assert.equal(result.status, GATE_BLOCKED);
    assert.equal(result.reason_code, 'eligibility_not_pass');
    assert.equal(invoked, false);
  });

  it('invokes only the injected ai-tester executor after PASS and verifies clean descendant-only teardown', async () => {
    const audit = await readJson('valid-audit.json');
    const eligibility = evaluateUnderstandAnythingEligibility({
      audit,
      runtime: passingRuntime()
    });
    const sandboxRoot = path.resolve('C:/sandbox/root');
    let receivedCommand = null;

    const result = await runUnderstandAnythingSandbox({
      audit,
      runtime: passingRuntime(),
      eligibility,
      sandboxRoot,
      confirmations: [
        { id: 'understandignore_reviewed', response: 'approved-reviewed', bounded: true },
        { id: 'workspace_private_confirmation', response: 'private-workspace-only', bounded: true }
      ]
    }, {
      aiTesterExecutor: async ({ command, plan }) => {
        receivedCommand = command;
        assert.equal(plan.command, 'ai-tester');
        return {
          status: GATE_PASS,
          output_schema_detected: true
        };
      },
      listResidualPaths: async () => [],
      listResidualProcesses: async () => []
    });

    assert.equal(receivedCommand, 'ai-tester');
    assert.equal(result.status, GATE_PASS);
    assert.equal(result.cleanup.status, GATE_PASS);
  });

  it('fails when teardown leaves residual descendants or the executor omits schema detection', async () => {
    const audit = await readJson('valid-audit.json');
    const eligibility = evaluateUnderstandAnythingEligibility({
      audit,
      runtime: passingRuntime()
    });

    const cleanupFailure = await runUnderstandAnythingSandbox({
      eligibility,
      sandboxRoot: path.resolve('C:/sandbox/root'),
      confirmations: [
        { id: 'understandignore_reviewed', response: 'approved-reviewed', bounded: true },
        { id: 'workspace_private_confirmation', response: 'private-workspace-only', bounded: true }
      ]
    }, {
      aiTesterExecutor: async () => ({
        status: GATE_PASS,
        output_schema_detected: true
      }),
      listResidualPaths: async () => [path.resolve('C:/sandbox/root/.ua/context.json')]
    });

    assert.equal(cleanupFailure.status, GATE_FAIL);
    assert.equal(cleanupFailure.reason_code, 'cleanup_residual_detected');

    const outputFailure = await runUnderstandAnythingSandbox({
      eligibility,
      sandboxRoot: path.resolve('C:/sandbox/root'),
      confirmations: [
        { id: 'understandignore_reviewed', response: 'approved-reviewed', bounded: true },
        { id: 'workspace_private_confirmation', response: 'private-workspace-only', bounded: true }
      ]
    }, {
      aiTesterExecutor: async () => ({
        status: GATE_PASS,
        output_schema_detected: false
      })
    });

    assert.equal(outputFailure.status, GATE_FAIL);
    assert.equal(outputFailure.reason_code, 'output_schema_missing');
  });
});

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, fileName), 'utf8'));
}

function passingRuntime() {
  return {
    exact_revision: true,
    private_workspace_preparation: true,
    interactive_skill_execution: true,
    understandignore_confirmations: {
      authored: true,
      bounded: true
    },
    bounded_subagents: {
      verified: true,
      observed_max: 3
    },
    path_isolation: {
      fixture_root: true,
      output_root: true,
      dependency_root: true
    },
    config_and_credentials: {
      home_isolated: true,
      config_isolated: true,
      credentials_exposed: false
    },
    hooks_viewer_daemon_disabled: {
      verified: true
    },
    output_schema: {
      detected: true
    },
    cleanup_inventory: {
      verified: true,
      descendant_only: true,
      residual_count: 0
    },
    windows_behavior: {
      supports_spaces: true
    }
  };
}
