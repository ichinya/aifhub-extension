// understand-anything-static-audit.test.mjs - static audit and boundary contracts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  GATE_BLOCKED,
  GATE_FAIL,
  GATE_PASS,
  UNDERSTAND_ANYTHING_PINNED_COMMIT,
  UNDERSTAND_ANYTHING_REPOSITORY,
  UNDERSTAND_ANYTHING_PINNED_TAG,
  UNDERSTAND_ANYTHING_STATIC_AUDIT_SCHEMA,
  classifyProtectedBoundary,
  evaluateProtectedWrites,
  validateUnderstandAnythingStaticAudit
} from './understand-anything-static-audit.mjs';

const FIXTURE_DIR = path.resolve('test/fixtures/understand-anything-static-audit');

describe('Understand Anything static audit validator', () => {
  it('accepts the exact pinned revision fixture and counts PASS claims', async () => {
    const audit = await readJson('valid-audit.json');
    const events = [];
    const result = validateUnderstandAnythingStaticAudit(audit, {
      workspaceRoot: 'C:/repo',
      logger: (level, details) => events.push({ level, details })
    });

    assert.equal(result.schema, UNDERSTAND_ANYTHING_STATIC_AUDIT_SCHEMA);
    assert.equal(result.valid, true);
    assert.equal(result.gate.status, GATE_PASS);
    assert.equal(audit.provider.repository, UNDERSTAND_ANYTHING_REPOSITORY);
    assert.equal(result.gate.counts.PASS >= 12, true);
    assert.equal(result.protected_boundary.gate.status, GATE_PASS);
    assert.equal(audit.revision.tag, UNDERSTAND_ANYTHING_PINNED_TAG);
    assert.equal(audit.revision.commit, UNDERSTAND_ANYTHING_PINNED_COMMIT);
    assert.equal(events.some((event) => event.level === GATE_PASS), true);
  });

  it('fails closed when protected writes target canonical artifacts, generated rules, QA, global paths, hooks, or the checkout', () => {
    const workspaceRoot = path.resolve('C:/repo');
    const userHome = path.resolve('C:/Users/Ichi');
    const result = evaluateProtectedWrites([
      path.join(workspaceRoot, 'openspec', 'changes', 'x', 'proposal.md'),
      path.join(workspaceRoot, '.ai-factory', 'rules', 'generated', 'x.md'),
      path.join(workspaceRoot, '.ai-factory', 'qa', 'x', 'evidence.md'),
      path.join(workspaceRoot, '.git', 'hooks', 'pre-commit'),
      path.join(userHome, '.codex', 'skills', 'custom', 'SKILL.md'),
      path.join(userHome, '.codex', 'plugins', 'cache', 'plugin', 'bundle'),
      path.join(userHome, '.codex', 'settings.json'),
      path.join(workspaceRoot, 'src', 'local-copy.js')
    ], { workspaceRoot, userHome });

    assert.equal(result.gate.status, GATE_FAIL);
    assert.deepEqual(result.violations.map((item) => item.category), [
      'openspec',
      'generated_rules',
      'qa_evidence',
      'git_hooks',
      'global_skill_path',
      'global_plugin_path',
      'agent_config',
      'current_checkout'
    ]);
    assert.equal(result.violations.every((item) => !/^[A-Za-z]:[\\/]/.test(item.path)), true);
  });

  it('rejects absolute source references and raw source bodies', async () => {
    const audit = await readJson('invalid-absolute-path.json');
    const result = validateUnderstandAnythingStaticAudit(audit, {
      workspaceRoot: 'C:/repo'
    });

    assert.equal(result.valid, false);
    assert.equal(result.gate.status, GATE_FAIL);
    assert.equal(result.errors.some((item) => item.code === 'absolute_source_ref_path'), true);
    assert.equal(result.errors.some((item) => item.code === 'raw_source_leak'), true);
  });

  it('marks unknown but otherwise valid claims as warnings instead of PASS inflation', async () => {
    const audit = await readJson('valid-audit.json');
    audit.claims.push({
      id: 'future_unknown_claim',
      status: GATE_BLOCKED,
      source_refs: [{ kind: 'doc', path: 'docs/upstream.md#future' }]
    });

    const result = validateUnderstandAnythingStaticAudit(audit, {
      workspaceRoot: 'C:/repo'
    });

    assert.equal(result.gate.status, GATE_BLOCKED);
    assert.equal(result.warnings.some((item) => item.code === 'unknown_claim'), true);
  });
});

describe('Understand Anything protected-boundary classifier', () => {
  it('classifies the most specific category before the generic current checkout boundary', () => {
    const workspaceRoot = path.resolve('C:/repo');

    assert.deepEqual(
      classifyProtectedBoundary(path.join(workspaceRoot, 'openspec', 'specs', 'x.md'), { workspaceRoot }),
      { category: 'openspec', path: 'workspace:openspec/specs/x.md' }
    );
    assert.deepEqual(
      classifyProtectedBoundary(path.join(workspaceRoot, 'notes', 'todo.txt'), { workspaceRoot }),
      { category: 'current_checkout', path: 'workspace:notes/todo.txt' }
    );
  });
});

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, fileName), 'utf8'));
}
