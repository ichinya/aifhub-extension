// understand-anything-eligibility.test.mjs - fail-closed eligibility contracts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { GATE_BLOCKED, GATE_FAIL, GATE_PASS } from './understand-anything-static-audit.mjs';
import {
  UNDERSTAND_ANYTHING_ELIGIBILITY_SCHEMA,
  evaluateUnderstandAnythingEligibility
} from './understand-anything-eligibility.mjs';

const FIXTURE_DIR = path.resolve('test/fixtures/understand-anything-static-audit');

describe('Understand Anything eligibility evaluator', () => {
  it('returns PASS only when every required gate is explicitly verified', async () => {
    const audit = await readJson('valid-audit.json');
    const logs = [];
    const result = evaluateUnderstandAnythingEligibility({
      audit,
      runtime: passingRuntime()
    }, {
      logger: (level, details) => logs.push({ level, details })
    });

    assert.equal(result.schema, UNDERSTAND_ANYTHING_ELIGIBILITY_SCHEMA);
    assert.equal(result.outcome, GATE_PASS);
    assert.equal(result.summary.pass, result.gates.length);
    assert.equal(logs.some((entry) => entry.level === 'INFO' && entry.details.outcome === GATE_PASS), true);
  });

  it('returns FAIL when exact revision drifts or cleanup is incomplete', async () => {
    const audit = await readJson('valid-audit.json');
    const result = evaluateUnderstandAnythingEligibility({
      audit,
      runtime: {
        ...passingRuntime(),
        exact_revision: false,
        cleanup_inventory: {
          verified: true,
          descendant_only: true,
          residual_count: 1
        }
      }
    });

    assert.equal(result.outcome, GATE_FAIL);
    assert.deepEqual(
      result.gates.filter((gate) => gate.status === GATE_FAIL).map((gate) => gate.id),
      ['exact_revision', 'cleanup_inventory']
    );
  });

  it('returns BLOCKED when required interactive confirmation or isolation evidence is missing', async () => {
    const audit = await readJson('valid-audit.json');
    const result = evaluateUnderstandAnythingEligibility({
      audit,
      runtime: {
        ...passingRuntime(),
        understandignore_confirmations: undefined,
        path_isolation: {
          fixture_root: true,
          output_root: true
        }
      }
    });

    assert.equal(result.outcome, GATE_BLOCKED);
    assert.equal(result.gates.some((gate) => gate.id === 'understandignore_confirmations' && gate.status === GATE_BLOCKED), true);
    assert.equal(result.gates.some((gate) => gate.id === 'path_isolation' && gate.status === GATE_BLOCKED), true);
  });

  it('fails when audit metadata contradicts required hook/viewer or windows contracts', async () => {
    const audit = await readJson('valid-audit.json');
    audit.viewer.daemon = true;
    audit.windows_behavior.supports_spaces = false;

    const result = evaluateUnderstandAnythingEligibility({
      audit,
      runtime: passingRuntime()
    });

    assert.equal(result.outcome, GATE_FAIL);
    assert.equal(result.gates.some((gate) => gate.id === 'hooks_viewer_daemon_disabled' && gate.status === GATE_FAIL), true);
    assert.equal(result.gates.some((gate) => gate.id === 'windows_behavior' && gate.status === GATE_FAIL), true);
  });
});

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

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, fileName), 'utf8'));
}
