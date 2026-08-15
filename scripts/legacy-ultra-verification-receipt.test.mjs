// legacy-ultra-verification-receipt.test.mjs - revision-bound legacy ultra receipt tests
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGateResult } from './aif-gate-result.mjs';
import {
  LEGACY_ULTRA_RECEIPT_ROOT,
  computeLegacyUltraBundleBinding,
  computeLegacyUltraWorktreeBinding,
  evaluateLegacyUltraVerificationReceipt,
  legacyUltraReceiptPath,
  normalizeLegacyUltraEntrypoint,
  writeLegacyUltraVerificationReceipt
} from './legacy-ultra-verification-receipt.mjs';

const execFileAsync = promisify(execFile);
const temporaryRoots = [];
const ENTRYPOINT = '.ai-factory/plans/demo-ultra/index.md';
const VERIFIED_AT = '2026-08-14T12:00:00.000Z';

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runGit(rootDir, args) {
  return execFileAsync('git', args, { cwd: rootDir, windowsHide: true });
}

async function writeProjectFile(rootDir, relativePath, content) {
  const absolutePath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
}

async function createFixture(options = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-legacy-ultra-receipt-'));
  temporaryRoots.push(rootDir);
  await writeProjectFile(rootDir, ENTRYPOINT, [
    '<!-- aif:plan-mode:ultra -->',
    '# Demo Ultra Plan',
    '',
    '## Phase Index',
    '1. [Build](phase-01-build.md)',
    '',
    '## Tasks',
    '- [x] Task 1: Build the feature',
    ''
  ].join('\n'));
  await writeProjectFile(rootDir, '.ai-factory/plans/demo-ultra/phase-01-build.md', [
    '# Phase 01: Build',
    '',
    '## Task 1: Build the feature',
    '',
    'Implementation detail.',
    ''
  ].join('\n'));
  await writeProjectFile(rootDir, 'src/app.js', 'export const value = 1;\n');
  await writeProjectFile(rootDir, '.gitignore', 'node_modules/\n');

  if (options.git !== false) {
    await runGit(rootDir, ['init', '--quiet']);
    await runGit(rootDir, ['config', 'user.name', 'Fixture User']);
    await runGit(rootDir, ['config', 'user.email', 'fixture@example.test']);
    await runGit(rootDir, ['add', '.']);
    await runGit(rootDir, ['commit', '--quiet', '-m', 'fixture']);
  }
  return rootDir;
}

function passGate() {
  return createGateResult({
    gate: 'verify',
    status: 'pass',
    blockers: [],
    affectedFiles: [],
    suggestedNext: null
  });
}

function failGate() {
  return createGateResult({
    gate: 'verify',
    status: 'fail',
    blockers: [{
      id: 'tests-failed',
      severity: 'error',
      summary: 'Focused tests failed.',
      file: 'src/app.js'
    }],
    affectedFiles: ['src/app.js'],
    suggestedNext: {
      command: '/aif-fix demo-ultra',
      reason: 'Repair the failing test.'
    }
  });
}

async function writePassReceipt(rootDir, options = {}) {
  const result = await writeLegacyUltraVerificationReceipt({
    rootDir,
    entrypoint: ENTRYPOINT,
    gateOutcome: passGate(),
    verifiedAt: VERIFIED_AT,
    ...options
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result;
}

async function mutateReceipt(rootDir, mutator) {
  const location = legacyUltraReceiptPath(ENTRYPOINT);
  const absolutePath = path.join(rootDir, ...location.receiptPath.split('/'));
  const receipt = JSON.parse(await readFile(absolutePath, 'utf8'));
  mutator(receipt);
  await writeFile(absolutePath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

describe('legacy ultra receipt bindings', () => {
  it('normalizes a safe directory or index entrypoint and derives one stable state path', () => {
    const directory = normalizeLegacyUltraEntrypoint('.ai-factory\\plans\\demo-ultra');
    const entrypoint = normalizeLegacyUltraEntrypoint(ENTRYPOINT);
    const location = legacyUltraReceiptPath(ENTRYPOINT);

    assert.equal(directory.entrypoint, ENTRYPOINT);
    assert.equal(entrypoint.entrypoint, ENTRYPOINT);
    assert.match(location.entrypointDigest, /^[a-f0-9]{64}$/);
    assert.equal(location.receiptPath, `${LEGACY_ULTRA_RECEIPT_ROOT}/${location.entrypointDigest}.json`);
    assert.equal(normalizeLegacyUltraEntrypoint('../outside/index.md').ok, false);
    assert.equal(normalizeLegacyUltraEntrypoint('C:\\outside\\index.md').ok, false);
  });

  it('computes separate deterministic bundle and worktree manifests', async () => {
    const rootDir = await createFixture();
    const bundle = await computeLegacyUltraBundleBinding({ rootDir, entrypoint: ENTRYPOINT });
    const worktree = await computeLegacyUltraWorktreeBinding({ rootDir, entrypoint: ENTRYPOINT });

    assert.equal(bundle.ok, true, JSON.stringify(bundle.errors));
    assert.deepEqual(bundle.files, [
      '.ai-factory/plans/demo-ultra/index.md',
      '.ai-factory/plans/demo-ultra/phase-01-build.md'
    ]);
    assert.match(bundle.bundleDigest, /^[a-f0-9]{64}$/);
    assert.equal(worktree.ok, true, JSON.stringify(worktree.errors));
    assert.equal(worktree.sourceRevision.kind, 'git-head');
    assert.equal(worktree.files.includes('src/app.js'), true);
    assert.equal(worktree.files.some((file) => file.startsWith('.ai-factory/plans/demo-ultra/')), false);
    assert.match(worktree.worktreeDigest, /^[a-f0-9]{64}$/);
  });

  it('records a deleted tracked file as a missing manifest row', async () => {
    const rootDir = await createFixture();
    await rm(path.join(rootDir, 'src', 'app.js'));

    const worktree = await computeLegacyUltraWorktreeBinding({ rootDir, entrypoint: ENTRYPOINT });

    assert.equal(worktree.ok, true, JSON.stringify(worktree.errors));
    assert.match(worktree.manifest, /^\["src\/app\.js","missing",null\]$/m);
  });

  it('requires a manual build id in a non-git workspace', async () => {
    const rootDir = await createFixture({ git: false });
    const missing = await computeLegacyUltraWorktreeBinding({ rootDir, entrypoint: ENTRYPOINT });
    const supplied = await computeLegacyUltraWorktreeBinding({
      rootDir,
      entrypoint: ENTRYPOINT,
      manualBuildId: 'manual-build-2026-08-14'
    });

    assert.equal(missing.ok, false);
    assert.equal(missing.errors[0].code, 'legacy-ultra-manual-build-id-required');
    assert.equal(supplied.ok, true);
    assert.deepEqual(supplied.sourceRevision, {
      kind: 'manual-build-id',
      value: 'manual-build-2026-08-14'
    });
  });
});

describe('legacy ultra finalization receipt evaluation', () => {
  it('returns the exact upstream archive handoff only for a current PASS receipt', async () => {
    const rootDir = await createFixture();
    const written = await writePassReceipt(rootDir);
    const result = await evaluateLegacyUltraVerificationReceipt({ rootDir, entrypoint: ENTRYPOINT });

    assert.equal(written.receipt.sourceCommand, `/aif-verify ${ENTRYPOINT}`);
    assert.equal(written.receipt.gateOutcome.status, 'pass');
    assert.equal(result.ok, true);
    assert.equal(result.code, 'legacy-ultra-receipt-current-pass');
    assert.equal(result.handoff, `/aif-archive ${ENTRYPOINT}`);
  });

  it('blocks a missing receipt with the exact verify handoff', async () => {
    const rootDir = await createFixture();
    const result = await evaluateLegacyUltraVerificationReceipt({ rootDir, entrypoint: ENTRYPOINT });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'legacy-ultra-receipt-missing');
    assert.equal(result.handoff, `/aif-verify ${ENTRYPOINT}`);
  });

  it('blocks a stale bundle digest', async () => {
    const rootDir = await createFixture();
    await writePassReceipt(rootDir);
    await writeProjectFile(
      rootDir,
      '.ai-factory/plans/demo-ultra/phase-01-build.md',
      '# Phase 01: Build\n\n## Task 1: Build the feature\n\nChanged detail.\n'
    );
    const result = await evaluateLegacyUltraVerificationReceipt({ rootDir, entrypoint: ENTRYPOINT });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'legacy-ultra-receipt-bundle-stale');
    assert.equal(result.handoff, `/aif-verify ${ENTRYPOINT}`);
  });

  it('blocks a receipt bound to the wrong entrypoint', async () => {
    const rootDir = await createFixture();
    await writePassReceipt(rootDir);
    await mutateReceipt(rootDir, (receipt) => {
      receipt.entrypoint = '.ai-factory/plans/other/index.md';
    });
    const result = await evaluateLegacyUltraVerificationReceipt({ rootDir, entrypoint: ENTRYPOINT });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'legacy-ultra-receipt-entrypoint-mismatch');
  });

  it('blocks a stale source revision even when file bytes are unchanged', async () => {
    const rootDir = await createFixture();
    await writePassReceipt(rootDir);
    await runGit(rootDir, ['commit', '--quiet', '--allow-empty', '-m', 'new revision']);
    const result = await evaluateLegacyUltraVerificationReceipt({ rootDir, entrypoint: ENTRYPOINT });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'legacy-ultra-receipt-revision-stale');
  });

  it('blocks a non-PASS upstream verify gate', async () => {
    const rootDir = await createFixture();
    const written = await writeLegacyUltraVerificationReceipt({
      rootDir,
      entrypoint: ENTRYPOINT,
      gateOutcome: failGate(),
      verifiedAt: VERIFIED_AT
    });
    assert.equal(written.ok, true, JSON.stringify(written.errors));
    const result = await evaluateLegacyUltraVerificationReceipt({ rootDir, entrypoint: ENTRYPOINT });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'legacy-ultra-receipt-non-pass');
    assert.equal(result.gateStatus, 'fail');
    assert.equal(result.handoff, `/aif-verify ${ENTRYPOINT}`);
  });

  it('blocks tracked code changed after PASS without a commit', async () => {
    const rootDir = await createFixture();
    await writePassReceipt(rootDir);
    await writeProjectFile(rootDir, 'src/app.js', 'export const value = 2;\n');
    const result = await evaluateLegacyUltraVerificationReceipt({ rootDir, entrypoint: ENTRYPOINT });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'legacy-ultra-receipt-worktree-stale');
  });

  it('blocks non-ignored untracked code added after PASS', async () => {
    const rootDir = await createFixture();
    await writePassReceipt(rootDir);
    await writeProjectFile(rootDir, 'src/untracked.js', 'export const newValue = true;\n');
    const result = await evaluateLegacyUltraVerificationReceipt({ rootDir, entrypoint: ENTRYPOINT });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'legacy-ultra-receipt-worktree-stale');
  });

  it('does not stale itself when runtime, QA, or generated-rule evidence changes', async () => {
    const rootDir = await createFixture();
    await writePassReceipt(rootDir);
    await writeProjectFile(rootDir, '.ai-factory/state/other.json', '{}\n');
    await writeProjectFile(rootDir, '.ai-factory/qa/demo/verify.md', 'evidence\n');
    await writeProjectFile(rootDir, '.ai-factory/rules/generated/index.json', '{}\n');
    const result = await evaluateLegacyUltraVerificationReceipt({ rootDir, entrypoint: ENTRYPOINT });

    assert.equal(result.ok, true);
    assert.equal(result.handoff, `/aif-archive ${ENTRYPOINT}`);
  });
});
