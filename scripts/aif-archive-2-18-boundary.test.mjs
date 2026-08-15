// aif-archive-2-18-boundary.test.mjs - AI Factory 2.18 archive ownership contract
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const INJECTION_PATH = 'injections/core/aif-archive-openspec-boundary.md';

async function readRepoFile(relativePath) {
  return readFile(join(REPO_ROOT, relativePath), 'utf8');
}

function assertIncludes(source, expected, label) {
  assert.ok(source.includes(expected), `${label} should include ${JSON.stringify(expected)}`);
}

function assertOrder(source, fragments, label) {
  let cursor = -1;
  for (const fragment of fragments) {
    const index = source.indexOf(fragment, cursor + 1);
    assert.notEqual(index, -1, `${label} should include ${JSON.stringify(fragment)} after index ${cursor}`);
    assert.ok(index > cursor, `${label} should preserve target classification order`);
    cursor = index;
  }
}

describe('AI Factory 2.18 archive boundary', () => {
  it('registers exactly one prepend injection for aif-archive', async () => {
    const manifest = JSON.parse(await readRepoFile('extension.json'));
    const entries = manifest.injections.filter(({ target }) => target === 'aif-archive');

    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      target: 'aif-archive',
      position: 'prepend',
      file: './injections/core/aif-archive-openspec-boundary.md'
    });
  });

  it('loads language policy and classifies arguments before any plan discovery', async () => {
    const injection = await readRepoFile(INJECTION_PATH);

    assertIncludes(injection, 'skills/shared/LANGUAGE-POLICY.md', INJECTION_PATH);
    assertOrder(
      injection,
      [
        '### Mode and target classification before discovery',
        'Read `.ai-factory/config.yaml`',
        'parse the raw `aif-archive` arguments',
        'before resolving `paths.plans`',
        '### OpenSpec-native mode'
      ],
      INJECTION_PATH
    );

    for (const expected of [
      '`list` -> `archive-list`',
      '`--roadmap` -> `roadmap-only`',
      'no arguments -> `plan-mutating-interactive`',
      '`--all` -> `plan-mutating-all`',
      'one non-control argument -> `plan-mutating-explicit`',
      'conflicting or extra arguments -> `invalid`'
    ]) {
      assertIncludes(injection, expected, `${INJECTION_PATH} target classifier`);
    }
  });

  it('blocks only OpenSpec plan-mutating targets with the exact done handoff', async () => {
    const injection = await readRepoFile(INJECTION_PATH);

    for (const expected of [
      '`plan-mutating-interactive`, `plan-mutating-all`, or `plan-mutating-explicit`',
      'stop before resolving or scanning `paths.plans`',
      'Do not read plan entrypoints, completion checkboxes, `openspec/changes/**`, or `openspec/specs/**`',
      'do not create an archive directory or write any canonical, runtime-state, QA, generated-rule, roadmap, or archive artifact',
      '/aif-done <change-id>',
      'without checking the filesystem'
    ]) {
      assertIncludes(injection, expected, `${INJECTION_PATH} plan-mutating boundary`);
    }
  });

  it('preserves read-only list without active plan or canonical discovery', async () => {
    const injection = await readRepoFile(INJECTION_PATH);

    for (const expected of [
      'For `archive-list`, preserve the upstream `list` behavior.',
      'read only the resolved `<paths.archive>/plans/` inventory and `<paths.archive>/roadmap/` snapshots',
      'must not resolve, glob, or read `paths.plans`',
      'must not read or write `openspec/changes/**` or `openspec/specs/**`',
      'must not create or edit any file'
    ]) {
      assertIncludes(injection, expected, `${INJECTION_PATH} list boundary`);
    }
  });

  it('preserves roadmap-only upstream writes without plan or canonical discovery', async () => {
    const injection = await readRepoFile(INJECTION_PATH);

    for (const expected of [
      'For `roadmap-only`, preserve the upstream `--roadmap` behavior and confirmation gate.',
      'read the resolved `paths.roadmap`',
      'write one non-colliding snapshot under `<paths.archive>/roadmap/`',
      'edit only the completed milestone lines owned by upstream in `paths.roadmap`',
      'must not resolve, glob, or read `paths.plans`',
      'must not read or write `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/state/**`, `.ai-factory/qa/**`, or `.ai-factory/rules/generated/**`'
    ]) {
      assertIncludes(injection, expected, `${INJECTION_PATH} roadmap-only boundary`);
    }
  });

  it('keeps legacy archive upstream-owned and emits bounded routing output', async () => {
    const injection = await readRepoFile(INJECTION_PATH);

    for (const expected of [
      '### Legacy AI Factory-only mode',
      'preserve the complete upstream `/aif-archive` behavior',
      'classic plan files, and marked ultra bundle directories',
      '`mode=OpenSpec-native`',
      'target class',
      '`handoff=/aif-done <change-id>`',
      'Do not include plan bodies, roadmap bodies, credentials, raw stdout, raw stderr, or private absolute paths',
      'does not perform filesystem mutations or claim archive completion'
    ]) {
      assertIncludes(injection, expected, `${INJECTION_PATH} ownership/output contract`);
    }
  });

  it('contains no direct filesystem mutation command', async () => {
    const injection = await readRepoFile(INJECTION_PATH);
    assert.doesNotMatch(
      injection,
      /(?:^|[\s`])(?:mv|rm|unlink|Move-Item|Remove-Item|Rename-Item)(?:[\s`]|$)/im
    );
  });
});
