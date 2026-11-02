// Instruction composition producer: canonicalization, byte identity, CAS and
// consumed validation. Node 18 compatible (no node:test glob API); the FS class
// must pass on both Windows (junction) and POSIX (symlink).
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './workflow-state-store.mjs';
import { prepareQaManifest } from './qa-manifest.mjs';
import { qaStore } from './qa-manifest-store.mjs';
import { observeQaSnapshot } from './qa-manifest-inputs.mjs';
import {
  COMPOSITION_INDEX_SCHEMA, COMPOSITION_SCHEMA, buildCompositionBaseline, compositionStore, compositionStatus,
  prepareCompositionAttempt, recordCompositionConsumption,
  rebaseCompositions, validateCompositionIndex, validateCompositionManifest,
} from './instruction-composition.mjs';
import { publishedInjectionBlock } from './prompt-assets.mjs';

const execAsync = promisify(execFile);

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
    const declaration = { references: consumptionDeclaration(manifest) };
    const verified = await recordCompositionConsumption(root, 'change-live', { attemptId: 'attempt-1', runtimeId: '.claude', declaration });
    assert.equal(verified.status, 'verified');
    assert.deepEqual(verified.assessment, { completeness: 'pass', freshness: 'pass', declaration_verification: 'pass' });
    await store.readConsumptions('attempt-1', '.claude').then(records => assert.equal(records.length, 2));
  });

  it('rejects forged, incomplete and out-of-set declarations; candidates stay unverified', async () => {
    const baseline = await buildCompositionBaseline(root);
    await prepareCompositionAttempt(root, 'change-decl', 'attempt-1', baseline);
    const manifest = manifestFor(baseline, '.claude');
    const required = consumptionDeclaration(manifest);
    const forged = required.map(reference => reference.path.endsWith('classic-sdd.md')
      ? { ...reference, sha256: 'f'.repeat(64) } : reference);
    const forgedResult = await recordCompositionConsumption(root, 'change-decl', { attemptId: 'attempt-1', runtimeId: '.claude', declaration: { references: forged } });
    assert.equal(forgedResult.status, 'incomplete');
    assert.ok(forgedResult.reasons.some(reason => reason.startsWith('reference-sha-mismatch:')));
    const incomplete = await recordCompositionConsumption(root, 'change-decl', {
      attemptId: 'attempt-1', runtimeId: '.claude',
      declaration: { references: required.filter(reference => !reference.path.endsWith('worker-claude.md')) },
    });
    assert.equal(incomplete.status, 'incomplete');
    assert.ok(incomplete.reasons.some(reason => reason.startsWith('required-reference-undeclared:')));
    // Review round three: an honest declaration needs no done triple — the
    // required set is the mode/runtime subset (contract decision 16 as
    // written); both or neither mode references fail with distinct reasons.
    const noMode = await recordCompositionConsumption(root, 'change-decl', {
      attemptId: 'attempt-1', runtimeId: '.claude',
      declaration: { references: required.filter(reference => !reference.path.endsWith('classic-sdd.md')) },
    });
    assert.equal(noMode.status, 'incomplete');
    assert.ok(noMode.reasons.includes('mode-reference-undeclared'));
    const openspecComponent = manifest.payload.components.find(item => item.path.endsWith('openspec-native.md'));
    const bothModes = await recordCompositionConsumption(root, 'change-decl', {
      attemptId: 'attempt-1', runtimeId: '.claude',
      declaration: { references: [...required, { path: openspecComponent.path, sha256: openspecComponent.sha256 }] },
    });
    assert.equal(bothModes.status, 'incomplete');
    assert.ok(bothModes.reasons.includes('mode-reference-ambiguous'));
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

// Honest consumed declaration (review round three): exactly one implement
// mode reference plus this runtime's worker reference. The rest of the
// validatable surface is optional and only validated when declared.
function consumptionDeclaration(manifest, mode = 'classic') {
  const workerTarget = manifest.payload.runtime.id === '.codex'
    ? 'injections/references/aif-implement/worker-codex.md'
    : 'injections/references/aif-implement/worker-claude.md';
  const targets = new Set([
    mode === 'openspec'
      ? 'injections/references/aif-implement/openspec-native.md'
      : 'injections/references/aif-implement/classic-sdd.md',
    workerTarget,
  ]);
  return manifest.payload.components
    .filter(item => targets.has(item.path.replace('.ai-factory/extensions/aifhub-extension/', '')))
    .map(item => ({ path: item.path, sha256: item.sha256 }));
}

describe('instruction composition QA namespace', () => {
  it('a composition record written between enroll and publish does not drift the QA snapshot', async () => {
    const qaRoot = await mkdtemp(path.join(os.tmpdir(), 'aif-composition-qa-'));
    try {
      const git = async args => execAsync('git', args, { cwd: qaRoot });
      await mkdir(path.join(qaRoot, 'src'), { recursive: true });
      await mkdir(path.join(qaRoot, 'openspec/changes/work'), { recursive: true });
      await mkdir(path.join(qaRoot, '.ai-factory'), { recursive: true });
      await writeFile(path.join(qaRoot, '.gitignore'), '.ai-factory/\n');
      await writeFile(path.join(qaRoot, 'src/a.js'), 'source\n');
      await writeFile(path.join(qaRoot, 'openspec/changes/work/proposal.md'), '# Proposal\n');
      await writeFile(path.join(qaRoot, 'openspec/changes/work/tasks.md'), '- [ ] 1.1 Task\n');
      await writeFile(path.join(qaRoot, '.ai-factory/config.yaml'), 'aifhub:\n  tools:\n    openspec: true\n');
      await git(['init', '--initial-branch=main']);
      await git(['config', 'user.email', 'fixture@example.com']);
      await git(['config', 'user.name', 'fixture']);
      await git(['add', '.']);
      await git(['commit', '-m', 'init']);
      const toolchain = [{ name: 'fixture-node', sha256: digest('node') }];
      const check = { id: 'check-verify', gate: 'verify', profile: 'declared.v1', dependencies_complete: true, inputs: ['src'],
        command: { argv: ['fake'], cwd: '.' }, toolchain, env_inputs: [], requires_observed: false };
      const options = { rootDir: qaRoot, changeId: 'work', scope: ['src'], checks: [check], environment: {},
        providers: { requirements: async () => ({ gates: ['verify'], independent_roles: [], evidence: [] }), toolchain: async () => toolchain } };
      assert.equal((await prepareQaManifest(options)).ok, true, 'qa enrollment needs a real git worktree');
      const store = await qaStore(options);
      const { payload } = await store.manifest();
      const before = await observeQaSnapshot(store, payload);
      // Write-gate activity lands after enrollment: a fresh attempt with one
      // consumption record under the closed compositions namespace.
      const baseline = await buildCompositionBaseline(qaRoot);
      void baseline; // no installed ledger in this fixture: unavailable degradation is fine
      const compositions = await compositionStore(qaRoot, 'work');
      const index = { schema: COMPOSITION_INDEX_SCHEMA, normalization_version: 1,
        compositions: [{ runtime_id: '.fixture', manifest_digest: 'a'.repeat(64), manifest_ref: `compositions/manifests/${'a'.repeat(64)}.json`, status: 'unavailable' }] };
      await compositions.writeIndex(index);
      await compositions.writeConsumption('attempt-1', '.fixture', {
        schema: 'aifhub.instruction_composition_consumption.v1', change_id: 'work', attempt_id: 'attempt-1',
        runtime_id: '.fixture', consumption_id: 'consumption-1', index_digest: 'a'.repeat(64), manifest_digest: 'b'.repeat(64),
        declaration: null, rehash: [], assessment: { completeness: 'pass', freshness: 'pass', declaration_verification: 'unverified' },
        status: 'unverified', reasons: ['declaration-absent'], created_at: '2026-11-02T00:00:00.000Z',
      });
      const after = await observeQaSnapshot(store, payload);
      // Same projections: the closed namespace never enters ignored_names or
      // changed_paths, so publish/inspect sees no ignored-membership-drift.
      assert.deepEqual(after.ignored_names, before.ignored_names);
      assert.deepEqual(after.changed_paths, before.changed_paths);
      assert.ok(!Object.keys(after.files).some(p => p.includes('compositions')));
      assert.ok(!after.ignored_names.some(p => p.includes('compositions')));
    } finally {
      await rm(qaRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('instruction composition review coverage', () => {
  it('malformed extension manifests degrade instead of throwing (producer never throws)', async () => {
    const ledger = JSON.stringify({ agents: [{ id: 'claude' }] });
    for (const [manifest, expected] of [
      ['{ "skills": "oops" }', 'extension-manifest-corrupt'],
      ['{ "injections": 5 }', 'extension-manifest-corrupt'],
      ['{ "agentFiles": {} }', 'extension-manifest-corrupt'],
      ['{ "skills": { "a": 1 } }', 'extension-manifest-corrupt'],
      ['"text"', 'extension-manifest-corrupt'],
      ['{}', 'extension-surface-empty'],
      ['{ "skills": [] }', 'extension-surface-empty'],
    ]) {
      await put('.ai-factory.json', ledger);
      await put('.ai-factory/extensions/aifhub-extension/extension.json', manifest);
      const baseline = await buildCompositionBaseline(root);
      assert.equal(baseline.status, 'unavailable', manifest);
      assert.equal(baseline.digest, null, manifest);
      assert.equal(baseline.degradation === 'extension-manifest-corrupt' || baseline.degradation === 'extension-surface-empty',
        true, `${manifest}: ${baseline.degradation}`);
      assert.equal(baseline.degradation, expected, manifest);
    }
  });

  it('injection-only entrypoints and their context layers join the surface (review F1)', async () => {
    await put('.ai-factory.json', JSON.stringify({ agents: [{ id: 'claude' }] }));
    await put('.ai-factory/extensions/aifhub-extension/extension.json', JSON.stringify({
      injections: [{ target: 'aif-fix', position: 'prepend', file: './injections/core/aif-fix-head.md' }],
    }));
    await put('.ai-factory/extensions/aifhub-extension/injections/core/aif-fix-head.md', 'fix head\n');
    await mkdir(path.dirname(path.join(root, '.claude/skills/aif-fix/SKILL.md')), { recursive: true });
    await mkdir(path.join(root, '.claude/agents'), { recursive: true });
    await put('.claude/skills/aif-fix/SKILL.md', '# fix body outside markers\n<!-- aif-ext:aifhub-extension:aif-fix:prepend:start -->\nfix head\n<!-- aif-ext:aifhub-extension:aif-fix:prepend:end -->\n');
    await put('.ai-factory/skill-context/aif-fix/SKILL.md', 'fix individual context\n');
    const baseline = await buildCompositionBaseline(root);
    const manifest = manifestFor(baseline, '.claude');
    assert.equal(manifest.status, 'verified');
    const entrypoint = componentOf(manifest, 'runtime_skill_entrypoint')[0];
    assert.equal(entrypoint.path, '.claude/skills/aif-fix/SKILL.md');
    assert.equal(entrypoint.sha256, digest(Buffer.from('# fix body outside markers\n<!-- aif-ext:aifhub-extension:aif-fix:prepend:start -->\nfix head\n<!-- aif-ext:aifhub-extension:aif-fix:prepend:end -->\n')));
    assert.deepEqual(manifest.payload.skill_context_order.map(entry => entry.role), ['project_skill_context_individual']);
    // Editing the upstream body outside the marker block changes the digest.
    const before = baseline.digest;
    await put('.claude/skills/aif-fix/SKILL.md', '# changed body outside markers\n');
    assert.notEqual((await buildCompositionBaseline(root)).digest, before);
  });

  it('injection_order offsets are byte offsets and carry the declared index (review F8)', async () => {
    const nonAscii = 'предисловие-перед-маркером\n';
    const entrypointBody = `${nonAscii}<!-- aif-ext:aifhub-extension:aif-implement:prepend:start -->\n${INJECTION_SOURCE}<!-- aif-ext:aifhub-extension:aif-implement:prepend:end -->\n`;
    await put('.claude/skills/aif-implement/SKILL.md', entrypointBody);
    const baseline = await buildCompositionBaseline(root);
    const order = manifestFor(baseline, '.claude').payload.injection_order[0];
    const [start] = injectionMarkerPairOf('aif-implement', 'prepend');
    assert.equal(order.offset, Buffer.from(entrypointBody, 'utf8').indexOf(Buffer.from(start, 'utf8')));
    assert.notEqual(order.offset, entrypointBody.indexOf(start)); // UTF-16 index differs for non-ASCII prefixes
    assert.equal(order.declared_index, 0);
    assert.equal(order.ordinal, 0);
  });

  it('consumption re-hashes the whole prepared surface and binds declarations to prepared hashes (review F10)', async () => {
    const baseline = await buildCompositionBaseline(root);
    await prepareCompositionAttempt(root, 'change-f10', 'attempt-1', baseline);
    const referencePath = path.join(root, '.ai-factory/extensions/aifhub-extension/injections/references/aif-implement/openspec-native.md');
    const original = await readFile(referencePath, 'utf8');
    await writeFile(referencePath, `${original}changed-after-prepare\n`);
    const manifest = manifestFor(baseline, '.claude');
    const required = consumptionDeclaration(manifest, 'openspec');
    const staleDeclaration = await recordCompositionConsumption(root, 'change-f10', {
      attemptId: 'attempt-1', runtimeId: '.claude', declaration: { references: required },
    });
    // Extension-layer bytes changed after prepare: stale, even though the
    // declaration echoes the prepared hashes.
    assert.equal(staleDeclaration.status, 'stale');
    assert.equal(staleDeclaration.assessment.freshness, 'stale');
    assert.ok(staleDeclaration.rehash.some(entry => entry.path.endsWith('openspec-native.md') && entry.match === false));
    // New bytes attested against the old prepared snapshot cannot verify.
    const forgedCurrent = required.map(reference => reference.path.endsWith('openspec-native.md')
      ? { path: reference.path, sha256: digest(Buffer.from(`${original}changed-after-prepare\n`)) } : reference);
    const forgedResult = await recordCompositionConsumption(root, 'change-f10', {
      attemptId: 'attempt-1', runtimeId: '.claude', declaration: { references: forgedCurrent },
    });
    assert.equal(forgedResult.status, 'stale'); // rehash still flags the drift
    await writeFile(referencePath, original);
    const restored = await recordCompositionConsumption(root, 'change-f10', {
      attemptId: 'attempt-1', runtimeId: '.claude', declaration: { references: required },
    });
    assert.equal(restored.status, 'verified');
  });

  it('missing validatable reference is a required gap (review round three)', async () => {
    await rm(path.join(root, '.ai-factory/extensions/aifhub-extension/skills/aif-done/references/openspec-finalization.md'));
    const baseline = await buildCompositionBaseline(root);
    assert.equal(baseline.status, 'incomplete');
    const manifest = manifestFor(baseline, '.claude');
    assert.ok(manifest.payload.required_gaps.some(gap => gap.includes('openspec-finalization.md')), JSON.stringify(manifest.payload.required_gaps));
    assert.equal(compositionStatus(manifest.payload), 'incomplete');
  });

  it('a missing runtime worker reference is a required gap for that runtime only (review round three)', async () => {
    await rm(path.join(root, '.ai-factory/extensions/aifhub-extension/injections/references/aif-implement/worker-codex.md'));
    const baseline = await buildCompositionBaseline(root);
    assert.equal(manifestFor(baseline, '.codex').status, 'incomplete');
    assert.equal(manifestFor(baseline, '.claude').status, 'verified');
    assert.ok(manifestFor(baseline, '.codex').payload.required_gaps.some(gap => gap.includes('worker-codex.md')));
  });

  it('consumption inherits prepared incompleteness and rejects a foreign prepared record (review F6/F11)', async () => {
    await rm(path.join(root, '.claude/skills/aif-implement/SKILL.md'));
    const incomplete = await buildCompositionBaseline(root);
    assert.equal(incomplete.status, 'incomplete');
    await prepareCompositionAttempt(root, 'change-f6', 'attempt-1', incomplete);
    const consumed = await recordCompositionConsumption(root, 'change-f6', { attemptId: 'attempt-1', runtimeId: '.claude' });
    assert.equal(consumed.status, 'incomplete');
    assert.equal(consumed.assessment.completeness, 'fail');
    assert.ok(consumed.reasons.includes('prepared-incomplete'));
    assert.ok(consumed.reasons.some(reason => reason.startsWith('prepared-gap:')));
    await assert.rejects(
      () => recordCompositionConsumption(root, 'change-f6', {
        attemptId: 'attempt-1', runtimeId: '.claude', expectedIndexDigest: 'c'.repeat(64),
      }),
      /composition-prepared-mismatch/,
    );
    // Matching index digest, different runtime: the .codex prepared surface is
    // verified in this fixture, so the consumption is honest unverified.
    const otherRuntime = await recordCompositionConsumption(root, 'change-f6', {
      attemptId: 'attempt-1', runtimeId: '.codex', expectedIndexDigest: incomplete.digest,
    });
    assert.equal(otherRuntime.status, 'unverified');
    await assert.rejects(
      () => recordCompositionConsumption(root, 'change-f6', { attemptId: 'missing-attempt', runtimeId: '.claude' }),
      /composition-prepared-missing/,
    );
  });

  it('prepared records are deterministic: retries rewrite identical CAS content (review F15)', async () => {
    const baseline = await buildCompositionBaseline(root);
    const first = await prepareCompositionAttempt(root, 'change-det', 'attempt-1', baseline);
    const second = await prepareCompositionAttempt(root, 'change-det', 'attempt-1', baseline);
    assert.deepEqual(second, first);
    const store = await compositionStore(root, 'change-det');
    assert.equal((await store.readConsumptions('attempt-1', '.claude')).length, 0);
  });
});

function injectionMarkerPairOf(target, position) {
  const prefix = `<!-- aif-ext:aifhub-extension:${target}:${position}:`;
  return [`${prefix}start -->`, `${prefix}end -->`];
}

describe('instruction composition review round two', () => {
  it('caps the ordered and inventory arrays like the schema (review R5)', async () => {
    const baseline = await buildCompositionBaseline(root);
    const payload = manifestFor(baseline, '.claude').payload;
    for (const field of ['skill_context_order', 'selected_references', 'missing', 'required_gaps']) {
      const inflated = structuredClone(payload);
      const entry = field === 'required_gaps' ? 'gap' : field === 'missing'
        ? { path: '.ai-factory/extensions/aifhub-extension/x', role: 'reference_candidate', reason: 'absent' }
        : field === 'skill_context_order'
          ? { path: '.ai-factory/skill-context/global-skill-context.md', role: 'project_skill_context_global' }
          : { source: 'skills/aif-done/SKILL.md', target: 'skills/aif-done/references/finalization-contract.md', component_index: 0 };
      inflated[field] = Array.from({ length: 4097 }, () => structuredClone(entry));
      assert.throws(() => validateCompositionManifest(inflated), /invalid-composition-manifest/, field);
    }
  });

  it('reports drift on exotic candidate paths as stale, not as a validation failure (review R6)', async () => {
    const exotic = '.ai-factory/extensions/aifhub-extension/injections/references/aif-roadmap/has space-кириллица.md';
    await put(exotic, 'exotic candidate\n');
    const baseline = await buildCompositionBaseline(root);
    assert.equal(baseline.status, 'verified');
    await prepareCompositionAttempt(root, 'change-r6', 'attempt-1', baseline);
    await put(exotic, 'drifted exotic candidate\n');
    const consumed = await recordCompositionConsumption(root, 'change-r6', { attemptId: 'attempt-1', runtimeId: '.claude' });
    assert.equal(consumed.status, 'stale');
    assert.ok(consumed.reasons.every(reason => /^[a-z0-9._:/-]{1,200}$/i.test(reason)));
    assert.ok(consumed.reasons.length <= 100);
  });
});
