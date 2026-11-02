// Instruction composition producer: canonicalization, byte identity, CAS and
// consumed validation. Node 18 compatible (no node:test glob API); the FS class
// must pass on both Windows (junction) and POSIX (symlink).
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './workflow-state-store.mjs';
import {
  COMPOSITION_INDEX_SCHEMA, COMPOSITION_SCHEMA, buildCompositionBaseline, compositionStore,
  prepareCompositionAttempt, recordCompositionConsumption,
  rebaseCompositions, validateCompositionIndex, validateCompositionManifest,
} from './instruction-composition.mjs';
import { publishedInjectionBlock } from './prompt-assets.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let root;

const SKILL_BODY = '# aif-implement\n\nBody text.\n';
const INJECTION_SOURCE = 'Managed injection body.\nSecond line.\n';
const references = [
  'injections/references/aif-implement/openspec-native.md',
  'injections/references/aif-implement/classic-sdd.md',
  'skills/aif-done/references/openspec-finalization.md',
  'skills/aif-done/references/classic-finalization.md',
  'skills/aif-done/references/finalization-contract.md',
  'injections/references/aif-implement/worker-claude.md',
  'injections/references/aif-implement/worker-codex.md',
  'skills/shared/references/question-tool/examples.md',
];
const support = [
  'skills/shared/TOOLS.md', 'skills/shared/LANGUAGE-POLICY.md', 'skills/shared/TEST-QUALITY.md',
  'skills/shared/TASK-COORDINATION.md', 'skills/shared/ISOLATED-EXECUTION.md',
  'skills/shared/references/test-quality-examples.md', 'docs/workflow-mechanics.md', 'docs/isolated-execution.md',
];

async function put(relative, content) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

async function fixture() {
  root = await mkdtemp(path.join(os.tmpdir(), 'aif-composition-'));
  await put('.ai-factory.json', JSON.stringify({ extensions: [{ name: 'aifhub-extension' }], agents: [{ id: 'claude' }, { id: 'codex' }] }));
  await put('.ai-factory/extensions/aifhub-extension/extension.json', JSON.stringify({
    skills: ['skills/aif-implement'],
    injections: [{ target: 'aif-implement', position: 'prepend', file: './injections/core/aif-implement-head.md' }],
    agentFiles: [
      { runtime: 'claude', source: './agent-files/claude/aifhub-implement-worker.md', target: 'aifhub-implement-worker.md' },
      { runtime: 'codex', source: './agent-files/codex/aifhub-implement-worker.toml', target: 'aifhub-implement-worker.toml' },
    ],
  }));
  await put('.ai-factory/extensions/aifhub-extension/injections/core/aif-implement-head.md', INJECTION_SOURCE);
  for (const reference of references) await put(`.ai-factory/extensions/aifhub-extension/${reference}`, `reference: ${reference}\n`);
  for (const file of support) await put(`.ai-factory/extensions/aifhub-extension/${file}`, `support: ${file}\n`);
  await put('.ai-factory/extensions/aifhub-extension/injections/references/aif-roadmap/extra.md', 'undeclared candidate\n');
  await put('.ai-factory/extensions/aifhub-extension/agent-files/claude/aifhub-implement-worker.md', 'worker claude\n');
  await put('.ai-factory/extensions/aifhub-extension/agent-files/codex/aifhub-implement-worker.toml', 'worker-codex = true\n');
  for (const runtime of ['.claude', '.codex']) {
    await put(`${runtime}/skills/aif-implement/SKILL.md`, `${publishedBlock(INJECTION_SOURCE)}`);
    await put(`${runtime}/agents/${runtime === '.codex' ? 'aifhub-implement-worker.toml' : 'aifhub-implement-worker.md'}`, runtime === '.codex' ? 'worker-codex = true\n' : 'worker claude\n');
  }
}

const publishedBlock = source => `# aif-implement\n\n<!-- aif-ext:aifhub-extension:aif-implement:prepend:start -->\n${source}<!-- aif-ext:aifhub-extension:aif-implement:prepend:end -->\n\nTail.\n`;

const manifestFor = (baseline, runtimeId) => baseline.manifests.find(entry => entry.runtime_id === runtimeId);
const componentOf = (manifest, role) => manifest.payload.components.filter(item => item.role === role);

beforeEach(async () => { await fixture(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); root = undefined; });

describe('instruction composition producer', () => {
  it('produces a stable baseline digest for identical inputs and validates against the schemas', async () => {
    const first = await buildCompositionBaseline(root);
    assert.equal(first.ok, true, first.degradation ?? '');
    assert.equal(first.status, 'verified');
    assert.match(first.digest, /^[a-f0-9]{64}$/);
    const twinRoot = root;
    await fixture();
    const second = await buildCompositionBaseline(root);
    assert.equal(second.digest, first.digest);
    validateCompositionIndex(first.index);
    validateCompositionIndex(second.index);
    for (const manifest of first.manifests) {
      validateCompositionManifest(manifest.payload);
      assert.equal(manifest.payload.schema, COMPOSITION_SCHEMA);
      assert.equal(first.index.schema, COMPOSITION_INDEX_SCHEMA);
    }
    assert.ok(manifestFor(first, '.claude'));
    void twinRoot;
  });

  it('binds runtime identity into the digest: same bytes in two runtimes give different digests', async () => {
    const baseline = await buildCompositionBaseline(root);
    const claude = manifestFor(baseline, '.claude'), codex = manifestFor(baseline, '.codex');
    assert.notEqual(claude.manifest_digest, codex.manifest_digest);
    // The published surfaces share bytes; only runtime identity differs.
    assert.equal(claude.payload.runtime, claude.payload.runtime);
    assert.deepEqual(componentOf(claude, 'runtime_skill_entrypoint').map(item => item.sha256),
      componentOf(codex, 'runtime_skill_entrypoint').map(item => item.sha256));
  });

  it('canonicalizes keys and preserves semantic array order', () => {
    const a = { schema: COMPOSITION_SCHEMA, normalization_version: 1, components: [{ path: 'x', sha256: 'a', role: 'reference_candidate' }] };
    const b = { components: [{ role: 'reference_candidate', sha256: 'a', path: 'x' }], normalization_version: 1, schema: COMPOSITION_SCHEMA };
    assert.equal(digest(b), digest(a));
    const reordered = { ...a, components: [...a.components].reverse() };
    assert.equal(digest(reordered), digest(a)); // single element: order irrelevant
    const two = { ...a, components: [{ path: 'x', sha256: 'a', role: 'reference_candidate' }, { path: 'y', sha256: 'b', role: 'extension_support' }] };
    const twoSwapped = { ...a, components: [two.components[1], two.components[0]] };
    assert.notEqual(digest(twoSwapped), digest(two));
  });

  it('hashes raw bytes: CRLF, LF and BOM stay distinct', async () => {
    await put('.claude/skills/aif-implement/SKILL.md', `${SKILL_BODY}\r\n`);
    const crlf = await buildCompositionBaseline(root);
    await put('.claude/skills/aif-implement/SKILL.md', `${SKILL_BODY}\n`);
    const lf = await buildCompositionBaseline(root);
    assert.notEqual(manifestFor(crlf, '.claude').manifest_digest, manifestFor(lf, '.claude').manifest_digest);
    await put('.claude/skills/aif-implement/SKILL.md', `\uFEFF${SKILL_BODY}\n`);
    const bom = await buildCompositionBaseline(root);
    const entry = componentOf(manifestFor(bom, '.claude'), 'runtime_skill_entrypoint')[0];
    const raw = await readFile(path.join(root, entry.path));
    assert.equal(entry.sha256, createHash('sha256').update(raw).digest('hex'));
    assert.equal(entry.sha256, digest(raw));
    assert.notEqual(entry.sha256, createHash('sha256').update(raw.toString('utf8').replace(/^\uFEFF/, '')).digest('hex'));
  });

  it('extracts the raw injection block: outside-block edits keep the digest, broken marker pairs do not', async () => {
    const baseline = await buildCompositionBaseline(root);
    const block = componentOf(manifestFor(baseline, '.claude'), 'runtime_injection_prepend')[0];
    // Raw block bytes include the newline after the start marker; no trimming.
    assert.equal(block.sha256, digest(Buffer.from(`\n${INJECTION_SOURCE}`, 'utf8')));
    const published = await readFile(path.join(root, '.claude/skills/aif-implement/SKILL.md'), 'utf8');
    assert.equal(publishedInjectionBlock(published, 'aif-implement', 'prepend'), `\n${INJECTION_SOURCE}`);
    await put('.claude/skills/aif-implement/SKILL.md', `${publishedBlock(INJECTION_SOURCE)}Edited tail.\n`);
    const edited = await buildCompositionBaseline(root);
    // The published entrypoint bytes changed, so the manifest digest changes;
    // the marker-block component hash itself is untouched (separate layers).
    assert.notEqual(manifestFor(edited, '.claude').manifest_digest, manifestFor(baseline, '.claude').manifest_digest);
    assert.equal(componentOf(manifestFor(edited, '.claude'), 'runtime_injection_prepend')[0].sha256, block.sha256);
    for (const broken of [
      `<!-- aif-ext:aifhub-extension:aif-implement:prepend:start -->x<!-- aif-ext:aifhub-extension:aif-implement:prepend:start -->`,
      `<!-- aif-ext:aifhub-extension:aif-implement:prepend:end -->x<!-- aif-ext:aifhub-extension:aif-implement:prepend:start -->`,
      '# no markers at all\n',
    ]) {
      await put('.claude/skills/aif-implement/SKILL.md', `${broken}\n`);
      const degraded = await buildCompositionBaseline(root);
      assert.equal(manifestFor(degraded, '.claude').status, 'incomplete');
      assert.ok(manifestFor(degraded, '.claude').payload.required_gaps.length > 0);
      void broken;
    }
  });

  it('keeps optional context optional and mandatory composition honest', async () => {
    const withoutContext = await buildCompositionBaseline(root);
    assert.equal(manifestFor(withoutContext, '.claude').status, 'verified');
    await put('.ai-factory/skill-context/global-skill-context.md', 'global layer\n');
    await put('.ai-factory/skill-context/aif-implement/SKILL.md', 'individual layer\n');
    const withContext = await buildCompositionBaseline(root);
    assert.notEqual(withContext.digest, withoutContext.digest);
    const order = manifestFor(withContext, '.claude').payload.skill_context_order;
    assert.deepEqual(order.map(entry => entry.role),
      ['project_skill_context_individual', 'project_skill_context_global']);
    // Build context applies to the build skill set.
    await rm(path.join(root, '.ai-factory/skill-context/aif-implement'), { recursive: true, force: true });
    const missingIndividual = await buildCompositionBaseline(root);
    assert.deepEqual(manifestFor(missingIndividual, '.claude').payload.skill_context_order.map(entry => entry.role),
      ['project_skill_context_global']);
    // Removing the optional layer returns to the earlier digest (disappearance observed).
    await rm(path.join(root, '.ai-factory/skill-context'), { recursive: true, force: true });
    const removed = await buildCompositionBaseline(root);
    assert.equal(removed.digest, withoutContext.digest);
    // Mandatory published entrypoint disappears: incomplete with a required gap.
    await rm(path.join(root, '.codex/skills/aif-implement/SKILL.md'));
    const incomplete = await buildCompositionBaseline(root);
    assert.equal(manifestFor(incomplete, '.codex').status, 'incomplete');
    assert.equal(incomplete.status, 'incomplete');
    assert.equal(manifestFor(incomplete, '.claude').status, 'verified');
  });

  it('degrades without throwing: ledger absent, ledger corrupt, extension unavailable', async () => {
    await rm(path.join(root, '.ai-factory.json'));
    const absent = await buildCompositionBaseline(root);
    assert.deepEqual([absent.status, absent.digest, absent.degradation], ['unavailable', null, 'ledger-absent']);
    await put('.ai-factory.json', '{ not json');
    const corrupt = await buildCompositionBaseline(root);
    assert.deepEqual([corrupt.status, corrupt.digest, corrupt.degradation], ['unavailable', null, 'ledger-corrupt']);
    await put('.ai-factory.json', JSON.stringify({ agents: [{ id: 'claude' }] }));
    await rm(path.join(root, '.ai-factory/extensions/aifhub-extension/extension.json'));
    const noExtension = await buildCompositionBaseline(root);
    assert.deepEqual([noExtension.status, noExtension.digest, noExtension.degradation], ['unavailable', null, 'extension-unavailable']);
    await put('.ai-factory/extensions/aifhub-extension/extension.json', JSON.stringify({
      skills: ['skills/aif-implement'],
      injections: [{ target: 'aif-implement', position: 'prepend', file: './injections/core/aif-implement-head.md' }],
    }));
    await put('.ai-factory.json', JSON.stringify({ agents: [{ id: 'claude', skillsDir: '../escape' }] }));
    const unsafeLayout = await buildCompositionBaseline(root);
    assert.equal(unsafeLayout.degradation, 'invalid-installed-layout');
    await put('.ai-factory.json', JSON.stringify({ agents: [{ id: 'claude', skillsDir: '.c:\\x' }] }));
    assert.equal((await buildCompositionBaseline(root)).degradation, 'invalid-installed-layout');
    await put('.ai-factory.json', JSON.stringify({ agents: [{ id: 'claude' }] }));
    await put('.ai-factory/extensions/aifhub-extension/extension.json', '{ "injections": [{ "target": "../evil", "position": "prepend", "file": "./injections/core/aif-implement-head.md" }] }');
    const unsafeInjection = await buildCompositionBaseline(root);
    assert.equal(unsafeInjection.degradation, 'unsafe-composition-manifest');
  });

  it('keeps undeclared reference files as inventory candidates', async () => {
    const baseline = await buildCompositionBaseline(root);
    const candidates = componentOf(manifestFor(baseline, '.claude'), 'reference_candidate').map(item => item.path);
    assert.ok(candidates.some(p => p.endsWith('aif-roadmap/extra.md')));
    const declared = manifestFor(baseline, '.claude').payload.selected_references;
    assert.ok(declared.length >= 8);
    assert.ok(declared.every(entry => manifestFor(baseline, '.claude').payload.components[entry.component_index].role === 'extension_reference'));
  });

  it('rejects symlinked and hardlinked published surfaces honestly', async () => {
    const plain = path.join(root, 'outside-skills');
    await mkdir(plain);
    await rm(path.join(root, '.codex/skills'), { recursive: true, force: true });
    await symlink(plain, path.join(root, '.codex/skills'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await buildCompositionBaseline(root);
    assert.equal(manifestFor(linked, '.codex').status, 'unavailable');
    await rm(path.join(root, '.codex/skills'));
    await mkdir(path.join(root, '.codex/skills/aif-implement'), { recursive: true });
    await put('.codex/skills/aif-implement/SKILL.md', publishedBlock(INJECTION_SOURCE));
    await link(path.join(root, '.codex/skills/aif-implement/SKILL.md'), path.join(root, '.codex/skills/aif-implement/copy.md'));
    const hardlinked = await buildCompositionBaseline(root);
    assert.equal(manifestFor(hardlinked, '.codex').status, 'incomplete');
  });
});

describe('instruction composition CAS store and consumed validation', () => {
  it('writes immutable content-addressed records and detects conflicts', async () => {
    const baseline = await buildCompositionBaseline(root);
    const store = await compositionStore(root, 'change-cas');
    const indexDigest = await store.writeIndex(baseline.index);
    assert.equal(await store.writeIndex(baseline.index), indexDigest); // identical rewrite accepted
    const stored = await readFile(path.join(root, `.ai-factory/state/change-cas/compositions/indexes/${indexDigest}.json`), 'utf8');
    assert.equal(JSON.parse(stored).schema, COMPOSITION_INDEX_SCHEMA);
    await writeFile(path.join(root, `.ai-factory/state/change-cas/compositions/indexes/${indexDigest}.json`), '{"schema":"tampered"}\n');
    await assert.rejects(() => store.writeIndex(baseline.index), /immutable-conflict/);
  });

  it('prepared then consumed: absent declaration stays unverified, valid declaration verifies', async () => {
    const baseline = await buildCompositionBaseline(root);
    const prepared = await prepareCompositionAttempt(root, 'change-live', 'attempt-1', baseline);
    assert.equal(prepared.index_digest, baseline.digest);
    const store = await compositionStore(root, 'change-live');
    const preparedRecord = await store.readPrepared('attempt-1', '.claude');
    assert.equal(preparedRecord.status, 'verified');
    const noDeclaration = await recordCompositionConsumption(root, 'change-live', { attemptId: 'attempt-1', runtimeId: '.claude' });
    assert.equal(noDeclaration.status, 'unverified');
    assert.ok(noDeclaration.reasons.includes('declaration-absent'));
    assert.equal(noDeclaration.assessment.completeness, 'pass');
    const manifest = manifestFor(baseline, '.claude');
    const declaration = { references: requiredDeclaration(manifest) };
    const verified = await recordCompositionConsumption(root, 'change-live', { attemptId: 'attempt-1', runtimeId: '.claude', declaration });
    assert.equal(verified.status, 'verified');
    assert.deepEqual(verified.assessment, { completeness: 'pass', freshness: 'pass', declaration_verification: 'pass' });
    await store.readConsumptions('attempt-1', '.claude').then(records => assert.equal(records.length, 2));
  });

  it('rejects forged, incomplete and out-of-set declarations; candidates stay unverified', async () => {
    const baseline = await buildCompositionBaseline(root);
    await prepareCompositionAttempt(root, 'change-decl', 'attempt-1', baseline);
    const manifest = manifestFor(baseline, '.claude');
    const required = requiredDeclaration(manifest);
    const forged = required.map(reference => reference.path.endsWith('openspec-native.md')
      ? { ...reference, sha256: 'f'.repeat(64) } : reference);
    const forgedResult = await recordCompositionConsumption(root, 'change-decl', { attemptId: 'attempt-1', runtimeId: '.claude', declaration: { references: forged } });
    assert.equal(forgedResult.status, 'incomplete');
    assert.ok(forgedResult.reasons.some(reason => reason.startsWith('reference-sha-mismatch:')));
    const incomplete = await recordCompositionConsumption(root, 'change-decl', { attemptId: 'attempt-1', runtimeId: '.claude', declaration: { references: required.slice(1) } });
    assert.equal(incomplete.status, 'incomplete');
    assert.ok(incomplete.reasons.some(reason => reason.startsWith('required-reference-undeclared:')));
    const outside = await recordCompositionConsumption(root, 'change-decl', {
      attemptId: 'attempt-1', runtimeId: '.claude',
      declaration: { references: [...required, { path: 'outside/aif-roadmap/extra.md', sha256: 'a'.repeat(64) }] },
    });
    assert.equal(outside.status, 'incomplete');
    assert.ok(outside.reasons.includes('reference-outside-prepared'));
    const duplicated = await recordCompositionConsumption(root, 'change-decl', {
      attemptId: 'attempt-1', runtimeId: '.claude', declaration: { references: [...required, required[0]] },
    });
    assert.equal(duplicated.status, 'incomplete');
    const candidatePath = manifest.payload.components.find(item => item.role === 'reference_candidate').path;
    const candidate = await recordCompositionConsumption(root, 'change-decl', {
      attemptId: 'attempt-1', runtimeId: '.claude',
      declaration: { references: [...required, { path: candidatePath, sha256: manifest.payload.components.find(item => item.path === candidatePath).sha256 }] },
    });
    assert.equal(candidate.status, 'unverified');
    assert.ok(candidate.reasons.includes('candidate-reference-unverified'));
  });

  it('detects instruction updates between prepare and consume as stale', async () => {
    const baseline = await buildCompositionBaseline(root);
    await prepareCompositionAttempt(root, 'change-stale', 'attempt-1', baseline);
    await put('.claude/skills/aif-implement/SKILL.md', `${publishedBlock(INJECTION_SOURCE)}Updated after prepare.\n`);
    const stale = await recordCompositionConsumption(root, 'change-stale', { attemptId: 'attempt-1', runtimeId: '.claude' });
    assert.equal(stale.status, 'stale');
    assert.equal(stale.assessment.freshness, 'stale');
    assert.ok(stale.reasons.some(reason => reason.startsWith('rehash-mismatch:')));
    // Mixed snapshot: only one of two runtimes updated.
    const other = await recordCompositionConsumption(root, 'change-stale', { attemptId: 'attempt-1', runtimeId: '.codex' });
    assert.equal(other.assessment.freshness, 'pass');
  });

  it('rejects consumption without a prepared record and continuation binds a predecessor', async () => {
    await assert.rejects(
      () => recordCompositionConsumption(root, 'change-none', { attemptId: 'missing', runtimeId: '.claude' }),
      /composition-prepared-missing/,
    );
    const baseline = await buildCompositionBaseline(root);
    await prepareCompositionAttempt(root, 'change-cont', 'attempt-1', baseline);
    const first = await recordCompositionConsumption(root, 'change-cont', { attemptId: 'attempt-1', runtimeId: '.claude' });
    const reentry = await recordCompositionConsumption(root, 'change-cont', {
      attemptId: 'attempt-1', runtimeId: '.claude', predecessorConsumptionId: first.consumption_id,
    });
    assert.equal(reentry.predecessor_consumption_id, first.consumption_id);
  });

  it('rebases baselines after an update: new index, old one untouched', async () => {
    const baseline = await buildCompositionBaseline(root);
    await prepareCompositionAttempt(root, 'change-rebase', 'attempt-1', baseline);
    const oldDigest = baseline.digest;
    await put('.claude/skills/aif-implement/SKILL.md', `${publishedBlock(INJECTION_SOURCE)}Rebased.\n`);
    const results = await rebaseCompositions(root);
    const rebased = results.find(entry => entry.change_id === 'change-rebase');
    assert.ok(rebased, JSON.stringify(results));
    assert.notEqual(rebased.index_digest, oldDigest);
    const store = await compositionStore(root, 'change-rebase');
    assert.deepEqual(await store.readIndex(oldDigest), baseline.index); // immutable history
    assert.equal((await store.readIndex(rebased.index_digest)).schema, COMPOSITION_INDEX_SCHEMA);
    const stale = await recordCompositionConsumption(root, 'change-rebase', { attemptId: 'attempt-1', runtimeId: '.claude' });
    assert.equal(stale.status, 'stale');
    // Changes without a compositions namespace are not rebased.
    assert.ok(!results.some(entry => entry.change_id === 'unrelated'));
  });

  it('schema files agree with the module validators', async () => {
    const manifestSchema = JSON.parse(await readFile(path.join(repo, 'schemas/instruction-composition.schema.json'), 'utf8'));
    const indexSchema = JSON.parse(await readFile(path.join(repo, 'schemas/instruction-composition-index.schema.json'), 'utf8'));
    const baseline = await buildCompositionBaseline(root);
    const manifest = manifestFor(baseline, '.claude').payload;
    assert.deepEqual(Object.keys(manifest).sort(), Object.keys(manifestSchema.properties).sort());
    assert.deepEqual(Object.keys(manifest).sort(), manifestSchema.required.slice().sort());
    for (const entry of baseline.index.compositions) {
      assert.deepEqual(Object.keys(entry).sort(), Object.keys(indexSchema.properties.compositions.items.properties).sort());
    }
    void validateCompositionManifest;
  });
});

function requiredDeclaration(manifest) {
  const workerTarget = manifest.payload.runtime.id === '.codex'
    ? 'injections/references/aif-implement/worker-codex.md'
    : 'injections/references/aif-implement/worker-claude.md';
  const targets = new Set([
    'injections/references/aif-implement/openspec-native.md',
    'injections/references/aif-implement/classic-sdd.md',
    'skills/aif-done/references/openspec-finalization.md',
    'skills/aif-done/references/classic-finalization.md',
    'skills/aif-done/references/finalization-contract.md',
    'skills/shared/references/question-tool/examples.md',
    workerTarget,
  ]);
  return manifest.payload.components
    .filter(item => targets.has(item.path.replace('.ai-factory/extensions/aifhub-extension/', '')))
    .map(item => ({ path: item.path, sha256: item.sha256 }));
}
