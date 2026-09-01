// active-change-resolver.test.mjs - tests for shared active OpenSpec change resolution
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ensureRuntimeLayout,
  listActiveOpenSpecChanges,
  mapBranchToChangeCandidates,
  matchesPrimaryIssueBinding,
  normalizeChangeId,
  parseIssueSourceBinding,
  parseLegacyIssueSourceBinding,
  readCurrentChangePointer,
  resolveActiveChange,
  writeCurrentChangePointer
} from './active-change-resolver.mjs';

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-active-change-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function createChange(rootDir, changeId, files = ['proposal.md']) {
  const changeDir = path.join(rootDir, 'openspec', 'changes', changeId);
  await mkdir(changeDir, { recursive: true });

  for (const file of files) {
    if (file.endsWith('/')) {
      await mkdir(path.join(changeDir, file), { recursive: true });
    } else {
      await writeFile(path.join(changeDir, file), `# ${changeId}\n`, 'utf8');
    }
  }

  return changeDir;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('active change resolver API', () => {
  it('exports the required resolver functions', () => {
    assert.equal(typeof resolveActiveChange, 'function');
    assert.equal(typeof listActiveOpenSpecChanges, 'function');
    assert.equal(typeof ensureRuntimeLayout, 'function');
    assert.equal(typeof readCurrentChangePointer, 'function');
    assert.equal(typeof writeCurrentChangePointer, 'function');
    assert.equal(typeof mapBranchToChangeCandidates, 'function');
    assert.equal(typeof parseIssueSourceBinding, 'function');
    assert.equal(typeof parseLegacyIssueSourceBinding, 'function');
    assert.equal(typeof matchesPrimaryIssueBinding, 'function');
    assert.equal(typeof normalizeChangeId, 'function');
  });

  it('returns a stable explicit success result with default runtime paths', async () => {
    const rootDir = await createTempRoot();
    const changePath = await createChange(rootDir, 'add-oauth');

    const result = await resolveActiveChange({
      rootDir,
      changeId: 'add-oauth',
      getCurrentBranch: async () => 'ignored'
    });

    assert.deepEqual(result, {
      ok: true,
      changeId: 'add-oauth',
      source: 'explicit',
      changePath,
      statePath: path.join(rootDir, '.ai-factory', 'state', 'add-oauth'),
      qaPath: path.join(rootDir, '.ai-factory', 'qa', 'add-oauth'),
      candidates: ['add-oauth'],
      warnings: [],
      errors: []
    });
  });

  it('uses OpenSpec-aware config paths and keeps legacy plans out of change resolution', async () => {
    const rootDir = await createTempRoot();
    const changePath = await createChange(rootDir, 'configured-change');
    await mkdir(path.join(rootDir, '.ai-factory'), { recursive: true });
    await writeFile(
      path.join(rootDir, '.ai-factory', 'config.yaml'),
      [
        'paths:',
        '  plans: .ai-factory/plans',
        '  specs: openspec/specs',
        '  state: .custom-state',
        '  qa: .custom-qa'
      ].join('\n'),
      'utf8'
    );

    const result = await resolveActiveChange({
      rootDir,
      changeId: 'configured-change'
    });

    assert.equal(result.ok, true);
    assert.equal(result.changePath, changePath);
    assert.equal(result.statePath, path.join(rootDir, '.custom-state', 'configured-change'));
    assert.equal(result.qaPath, path.join(rootDir, '.custom-qa', 'configured-change'));
  });
});

describe('change id normalization and active listing', () => {
  it('normalizes safe change ids without modifying valid slug characters', () => {
    for (const input of ['add-oauth', 'feature_1', 'v1.2.3', 'ABC-123_value']) {
      assert.deepEqual(normalizeChangeId(input), {
        ok: true,
        changeId: input,
        error: null
      });
    }
  });

  it('rejects unsafe or traversal-like change ids', () => {
    for (const input of ['', ' ', '../escape', 'nested/change', 'nested\\change', '/absolute', 'C:\\absolute', '..', 'safe..unsafe', 'not allowed']) {
      const result = normalizeChangeId(input);
      assert.equal(result.ok, false);
      assert.equal(result.changeId, null);
      assert.equal(result.error.code, 'invalid-change-id');
    }
  });

  it('lists stable active OpenSpec change ids and excludes archives, hidden directories, files, and unmarked directories', async () => {
    const rootDir = await createTempRoot();
    const changesDir = path.join(rootDir, 'openspec', 'changes');
    await createChange(rootDir, 'zeta-change', ['specs/']);
    await createChange(rootDir, 'add-oauth', ['proposal.md']);
    await createChange(rootDir, '.hidden-change', ['proposal.md']);
    await createChange(rootDir, 'unmarked-change', []);
    await mkdir(path.join(changesDir, 'archive', 'old-change'), { recursive: true });
    await writeFile(path.join(changesDir, 'not-a-change.md'), '# file\n', 'utf8');

    const result = await listActiveOpenSpecChanges({ rootDir });

    assert.deepEqual(result, ['add-oauth', 'zeta-change']);
  });

  it('falls back to safe unmarked change directories when no marker-bearing changes exist', async () => {
    const rootDir = await createTempRoot();
    const changesDir = path.join(rootDir, 'openspec', 'changes');
    await createChange(rootDir, 'beta-change', []);
    await createChange(rootDir, 'alpha-change', []);
    await createChange(rootDir, '.hidden-change', []);
    await mkdir(path.join(changesDir, 'archive', 'old-change'), { recursive: true });
    await writeFile(path.join(changesDir, 'not-a-change.md'), '# file\n', 'utf8');

    const result = await listActiveOpenSpecChanges({ rootDir });

    assert.deepEqual(result, ['alpha-change', 'beta-change']);
  });

  it('excludes unsafe marker-bearing and fallback-only change directory names', async () => {
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'valid-change', ['proposal.md']);
    await createChange(rootDir, 'bad name', ['proposal.md']);

    assert.deepEqual(await listActiveOpenSpecChanges({ rootDir }), ['valid-change']);

    const fallbackOnlyRoot = await createTempRoot();
    await createChange(fallbackOnlyRoot, 'safe-draft', []);
    await createChange(fallbackOnlyRoot, 'bad name', []);

    assert.deepEqual(await listActiveOpenSpecChanges({ rootDir: fallbackOnlyRoot }), ['safe-draft']);
  });

  it('reports filesystem diagnostics through resolution when active listing fails', async () => {
    const rootDir = await createTempRoot();

    const result = await resolveActiveChange({
      rootDir,
      changeId: 'missing-change'
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'explicit-change-not-found');
    assert.deepEqual(result.candidates, []);
    assert.equal(result.warnings[0].code, 'filesystem-error');
    assert.match(result.warnings[0].message, /Unable to list active OpenSpec changes/);
  });
});

describe('explicit and cwd resolution', () => {
  it('rejects invalid explicit ids without falling back to another active change', async () => {
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'fallback-change');

    const result = await resolveActiveChange({
      rootDir,
      changeId: '../fallback-change'
    });

    assert.equal(result.ok, false);
    assert.equal(result.source, 'explicit');
    assert.deepEqual(result.candidates, []);
    assert.equal(result.errors[0].code, 'invalid-change-id');
  });

  it('returns explicit missing without falling back to an available active change', async () => {
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'fallback-change');

    const result = await resolveActiveChange({
      rootDir,
      changeId: 'missing-change'
    });

    assert.equal(result.ok, false);
    assert.equal(result.source, 'explicit');
    assert.deepEqual(result.candidates, ['fallback-change']);
    assert.equal(result.errors[0].code, 'explicit-change-not-found');
  });

  it('rejects the reserved archive directory as an explicit active change', async () => {
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'archive', ['proposal.md']);

    const result = await resolveActiveChange({
      rootDir,
      changeId: 'archive'
    });

    assert.equal(result.ok, false);
    assert.equal(result.source, 'explicit');
    assert.equal(result.changeId, null);
    assert.equal(result.errors[0].code, 'explicit-change-not-found');
  });

  it('resolves cwd nested inside an active OpenSpec change', async () => {
    const rootDir = await createTempRoot();
    const changePath = await createChange(rootDir, 'nested-change');
    const nestedCwd = path.join(changePath, 'specs', 'feature');
    await mkdir(nestedCwd, { recursive: true });

    const result = await resolveActiveChange({
      rootDir,
      cwd: nestedCwd,
      getCurrentBranch: async () => null
    });

    assert.equal(result.ok, true);
    assert.equal(result.changeId, 'nested-change');
    assert.equal(result.source, 'cwd');
    assert.equal(result.changePath, changePath);
    assert.deepEqual(result.candidates, ['nested-change']);
  });

  it('does not resolve cwd inside archived OpenSpec changes', async () => {
    const rootDir = await createTempRoot();
    const archivePath = path.join(rootDir, 'openspec', 'changes', 'archive', 'old-change');
    await mkdir(archivePath, { recursive: true });
    await writeFile(path.join(archivePath, 'proposal.md'), '# old\n', 'utf8');

    const result = await resolveActiveChange({
      rootDir,
      cwd: archivePath,
      getCurrentBranch: async () => null
    });

    assert.equal(result.ok, false);
    assert.equal(result.source, null);
    assert.equal(result.errors[0].code, 'no-active-change');
  });
});

describe('issue source binding', () => {
  it('keeps one canonical primary issue distinct from secondary issues with the same number', () => {
    const primaryIssue = 'https://github.com/repo-a/project/issues/156';
    const secondaryIssue = 'https://github.com/repo-b/project/issues/156';
    const proposal = [
      '# Proposal',
      '',
      '## AIFHub Source Binding',
      '',
      `- Primary issue: ${primaryIssue}`,
      '- Branch: feature/some-request-slug',
      '',
      '## Roadmap Linkage',
      '',
      `- Issues: ${primaryIssue}, ${secondaryIssue}`,
      '- Milestone: none',
      '- Roadmap item/slice: none',
      '- Rationale: primary plus secondary linkage',
      ''
    ].join('\n');

    assert.deepEqual(parseIssueSourceBinding(proposal), {
      ok: true,
      status: 'bound',
      binding: {
        primaryIssue,
        issueNumber: '156',
        branch: 'feature/some-request-slug'
      },
      error: null
    });
    assert.equal(matchesPrimaryIssueBinding(proposal, primaryIssue), true);
    assert.equal(matchesPrimaryIssueBinding(proposal, secondaryIssue), false);
  });

  it('parses the synchronized legacy status source_binding mapping', () => {
    const primaryIssue = 'https://github.com/repo-a/project/issues/156';
    const status = [
      'status: planned',
      'source_binding:',
      `  primary_issue: ${JSON.stringify(primaryIssue)}`,
      '  branch: "feature/some-request-slug"',
      'history: []',
      ''
    ].join('\n');

    assert.deepEqual(parseLegacyIssueSourceBinding(status), {
      ok: true,
      status: 'bound',
      binding: {
        primaryIssue,
        issueNumber: '156',
        branch: 'feature/some-request-slug'
      },
      error: null
    });
    assert.equal(matchesPrimaryIssueBinding(status, primaryIssue, { format: 'legacy-status' }), true);
  });

  it('rejects duplicate or malformed source bindings instead of using roadmap membership', () => {
    const section = [
      '## AIFHub Source Binding',
      '',
      '- Primary issue: https://github.com/repo-a/project/issues/156',
      '- Branch: feature/some-request-slug',
      ''
    ].join('\n');
    const duplicate = `${section}\n${section}`;
    const malformed = section.replace('- Primary issue:', '- Issues:');

    assert.equal(parseIssueSourceBinding(duplicate).error.code, 'source-binding-duplicate');
    assert.equal(parseIssueSourceBinding(malformed).error.code, 'source-binding-fields-invalid');
  });
});

describe('branch-derived resolution', () => {
  it('maps common feature branch names to existing active changes', () => {
    assert.deepEqual(
      mapBranchToChangeCandidates('feat/add-oauth', ['add-oauth', 'other-change']),
      ['add-oauth']
    );
    assert.deepEqual(
      mapBranchToChangeCandidates('feat/add-oauth', ['feat-add-oauth', 'other-change']),
      ['feat-add-oauth']
    );
  });

  it('resolves exactly one branch-derived active change', async () => {
    const rootDir = await createTempRoot();
    const changePath = await createChange(rootDir, 'add-oauth');

    const result = await resolveActiveChange({
      rootDir,
      getCurrentBranch: async () => 'feat/add-oauth'
    });

    assert.equal(result.ok, true);
    assert.equal(result.changeId, 'add-oauth');
    assert.equal(result.source, 'branch');
    assert.equal(result.changePath, changePath);
    assert.deepEqual(result.candidates, ['add-oauth']);
  });

  it('prefers an exact persisted branch binding for a numeric change over an older slug match', async () => {
    const rootDir = await createTempRoot();
    const numericPath = await createChange(rootDir, '156');
    await createChange(rootDir, 'some-request-slug');
    await createChange(rootDir, 'unrelated-active-change');
    await writeFile(path.join(numericPath, 'proposal.md'), [
      '# Numeric plan',
      '',
      '## AIFHub Source Binding',
      '',
      '- Primary issue: https://github.com/repo-a/project/issues/156',
      '- Branch: feature/some-request-slug',
      ''
    ].join('\n'), 'utf8');

    const result = await resolveActiveChange({
      rootDir,
      getCurrentBranch: async () => 'feature/some-request-slug'
    });

    assert.equal(result.ok, true);
    assert.equal(result.changeId, '156');
    assert.equal(result.source, 'branch-binding');
    assert.equal(result.changePath, numericPath);
    assert.deepEqual(result.candidates, ['156']);
  });

  it('fails closed when persisted branch bindings are ambiguous or disagree with numeric IDs', async () => {
    const ambiguousRoot = await createTempRoot();
    for (const changeId of ['156', '157']) {
      const changePath = await createChange(ambiguousRoot, changeId);
      await writeFile(path.join(changePath, 'proposal.md'), [
        '# Numeric plan',
        '',
        '## AIFHub Source Binding',
        '',
        `- Primary issue: https://github.com/repo-a/project/issues/${changeId}`,
        '- Branch: feature/shared-branch',
        ''
      ].join('\n'), 'utf8');
    }

    const ambiguous = await resolveActiveChange({
      rootDir: ambiguousRoot,
      getCurrentBranch: async () => 'feature/shared-branch'
    });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.source, 'branch-binding');
    assert.equal(ambiguous.errors[0].code, 'ambiguous-branch-binding');
    assert.deepEqual(ambiguous.candidates, ['156', '157']);

    const mismatchRoot = await createTempRoot();
    const mismatchPath = await createChange(mismatchRoot, '156');
    await writeFile(path.join(mismatchPath, 'proposal.md'), [
      '# Numeric plan',
      '',
      '## AIFHub Source Binding',
      '',
      '- Primary issue: https://github.com/repo-a/project/issues/157',
      '- Branch: feature/shared-branch',
      ''
    ].join('\n'), 'utf8');

    const mismatch = await resolveActiveChange({
      rootDir: mismatchRoot,
      getCurrentBranch: async () => 'feature/shared-branch'
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.source, 'branch-binding');
    assert.equal(mismatch.errors[0].code, 'source-binding-change-id-mismatch');
    assert.deepEqual(mismatch.candidates, ['156']);
  });

  it('fails when a branch maps to multiple active changes', async () => {
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'add-oauth');
    await createChange(rootDir, 'feat-add-oauth');

    const result = await resolveActiveChange({
      rootDir,
      getCurrentBranch: async () => 'feat/add-oauth'
    });

    assert.equal(result.ok, false);
    assert.equal(result.source, 'branch');
    assert.deepEqual(result.candidates, ['add-oauth', 'feat-add-oauth']);
    assert.equal(result.errors[0].code, 'ambiguous-branch-change');
  });

  it('keeps branch detection errors as non-fatal warnings', async () => {
    const rootDir = await createTempRoot();

    const result = await resolveActiveChange({
      rootDir,
      getCurrentBranch: async () => {
        throw new Error('git unavailable');
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'no-active-change');
    assert.equal(result.warnings[0].code, 'filesystem-error');
    assert.equal(result.warnings[1].code, 'git-branch-detection-failed');
  });
});

describe('current pointer and fallback resolution', () => {
  it('reads current pointer files from supported YAML and JSON keys', async () => {
    const rootDir = await createTempRoot();
    const pointerPath = path.join(rootDir, '.ai-factory', 'state', 'current.yaml');
    await mkdir(path.dirname(pointerPath), { recursive: true });

    for (const [key, value] of [
      ['change_id', 'yaml-snake'],
      ['changeId', 'yaml-camel'],
      ['active_change', 'active-snake'],
      ['activeChange', 'active-camel']
    ]) {
      await writeFile(pointerPath, `${key}: ${value}\n`, 'utf8');
      assert.equal(await readCurrentChangePointer({ rootDir }), value);
    }

    await writeFile(pointerPath, '{"activeChange":"json-change"}', 'utf8');
    assert.equal(await readCurrentChangePointer({ rootDir }), 'json-change');
  });

  it('writes the current pointer using the canonical change_id key', async () => {
    const rootDir = await createTempRoot();

    const result = await writeCurrentChangePointer('written-change', { rootDir });
    const content = await readFile(result.pointerPath, 'utf8');

    assert.deepEqual(result, {
      ok: true,
      changeId: 'written-change',
      pointerPath: path.join(rootDir, '.ai-factory', 'state', 'current.yaml')
    });
    assert.equal(content, 'change_id: written-change\n');
  });

  it('resolves a valid current pointer after branch resolution misses', async () => {
    const rootDir = await createTempRoot();
    const changePath = await createChange(rootDir, 'pointer-change');
    await writeCurrentChangePointer('pointer-change', { rootDir });

    const result = await resolveActiveChange({
      rootDir,
      getCurrentBranch: async () => 'feat/no-match'
    });

    assert.equal(result.ok, true);
    assert.equal(result.changeId, 'pointer-change');
    assert.equal(result.source, 'current-pointer');
    assert.equal(result.changePath, changePath);
    assert.deepEqual(result.candidates, ['pointer-change']);
  });

  it('fails on a stale current pointer instead of falling back', async () => {
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'active-change');
    await writeCurrentChangePointer('missing-change', { rootDir });

    const result = await resolveActiveChange({
      rootDir,
      getCurrentBranch: async () => null
    });

    assert.equal(result.ok, false);
    assert.equal(result.source, 'current-pointer');
    assert.deepEqual(result.candidates, ['active-change']);
    assert.equal(result.errors[0].code, 'current-pointer-not-found');
  });

  it('falls back to a single active OpenSpec change when no pointer exists', async () => {
    const rootDir = await createTempRoot();
    const changePath = await createChange(rootDir, 'single-change');

    const result = await resolveActiveChange({
      rootDir,
      getCurrentBranch: async () => null
    });

    assert.equal(result.ok, true);
    assert.equal(result.changeId, 'single-change');
    assert.equal(result.source, 'single-active-change');
    assert.equal(result.changePath, changePath);
    assert.deepEqual(result.candidates, ['single-change']);
  });

  it('fails with candidates when multiple active changes remain ambiguous', async () => {
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'alpha-change');
    await createChange(rootDir, 'beta-change');

    const result = await resolveActiveChange({
      rootDir,
      getCurrentBranch: async () => null
    });

    assert.equal(result.ok, false);
    assert.equal(result.source, null);
    assert.deepEqual(result.candidates, ['alpha-change', 'beta-change']);
    assert.equal(result.errors[0].code, 'ambiguous-active-change');
  });

  it('fails clearly when no active changes exist', async () => {
    const rootDir = await createTempRoot();
    await mkdir(path.join(rootDir, 'openspec', 'changes'), { recursive: true });

    const result = await resolveActiveChange({
      rootDir,
      getCurrentBranch: async () => null
    });

    assert.equal(result.ok, false);
    assert.equal(result.source, null);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.errors[0].code, 'no-active-change');
  });
});

describe('runtime state and QA layout', () => {
  it('creates state and QA directories with relative created entries, then reports preserved entries', async () => {
    const rootDir = await createTempRoot();

    const first = await ensureRuntimeLayout('layout-change', { rootDir });

    assert.equal(first.ok, true);
    assert.equal(first.changeId, 'layout-change');
    assert.equal(first.statePath, path.join(rootDir, '.ai-factory', 'state', 'layout-change'));
    assert.equal(first.qaPath, path.join(rootDir, '.ai-factory', 'qa', 'layout-change'));
    assert.deepEqual(first.created, [
      path.join('.ai-factory', 'state', 'layout-change'),
      path.join('.ai-factory', 'qa', 'layout-change')
    ]);
    assert.deepEqual(first.preserved, []);
    assert.equal(await pathExists(first.statePath), true);
    assert.equal(await pathExists(first.qaPath), true);

    const second = await ensureRuntimeLayout('layout-change', { rootDir });

    assert.deepEqual(second.created, []);
    assert.deepEqual(second.preserved, [
      path.join('.ai-factory', 'state', 'layout-change'),
      path.join('.ai-factory', 'qa', 'layout-change')
    ]);
  });

  it('rejects unsafe ids before creating runtime directories', async () => {
    const rootDir = await createTempRoot();

    await assert.rejects(
      () => ensureRuntimeLayout('../escape', { rootDir }),
      /Invalid OpenSpec change id/
    );

    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'state')), false);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'qa')), false);
  });

  it('rejects existing runtime layout paths that are files', async () => {
    const rootDir = await createTempRoot();
    const stateFile = path.join(rootDir, '.ai-factory', 'state', 'file-collision');
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, 'not a directory\n', 'utf8');

    await assert.rejects(
      () => ensureRuntimeLayout('file-collision', { rootDir }),
      /Runtime layout path exists but is not a directory/
    );

    const qaRoot = await createTempRoot();
    const qaFile = path.join(qaRoot, '.ai-factory', 'qa', 'file-collision');
    await mkdir(path.dirname(qaFile), { recursive: true });
    await writeFile(qaFile, 'not a directory\n', 'utf8');

    await assert.rejects(
      () => ensureRuntimeLayout('file-collision', { rootDir: qaRoot }),
      /Runtime layout path exists but is not a directory/
    );
  });

  it('does not create plan folders or write under OpenSpec change artifacts', async () => {
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'guard-change');

    await ensureRuntimeLayout('guard-change', { rootDir });

    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'plans', 'guard-change')), false);
    assert.equal(await pathExists(path.join(rootDir, 'openspec', 'changes', 'guard-change', '.ai-factory')), false);
    assert.equal(await pathExists(path.join(rootDir, 'openspec', 'changes', 'guard-change', 'qa')), false);
  });
});
