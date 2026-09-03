// Unit tests for the Ponytail lifecycle A/B runner (no Pi, no network, no Git writes).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  LIFECYCLE_COMMANDS,
  PONYTAIL_LIFECYCLE_CONDITIONS,
  buildLifecycleInvocation,
  buildLifecycleMatrix,
  loadLifecycleCatalog,
  renderCasePrompt,
  rewriteCommandSkillFrontmatter,
  validateLifecycleCatalog
} from './ponytail-lifecycle-ab.mjs';
import {
  assertFinalGateBlock,
  assertKeywordGroups,
  extractAssistantText,
  extractGateBlocks
} from './fixtures/ponytail-lifecycle-ab/grader-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('committed lifecycle catalog is valid and covers all four lifecycle commands', async () => {
  const catalog = await loadLifecycleCatalog({ cwd: REPO_ROOT });
  assert.deepEqual(validateLifecycleCatalog(catalog), []);
  const commands = new Set(catalog.scenarios.map((scenario) => scenario.command));
  for (const command of LIFECYCLE_COMMANDS) {
    assert.ok(commands.has(command), `catalog must cover ${command}`);
  }
});

function cloneCatalog(overrides = {}) {
  return {
    schema: 'aifhub.ponytail_lifecycle_ab.catalog.v1',
    defaults: {
      runtime: 'pi',
      runtime_version: '0.84.4',
      provider: 'omniroute',
      model: 'la/ornith-1.5-35b-a3b',
      thinking: 'low',
      conditions: ['baseline', 'ponytail_full'],
      repetitions: 4,
      timeout_seconds: 900,
      tools: ['read', 'grep', 'find', 'ls', 'powershell', 'edit', 'write']
    },
    ponytail: {
      version: '4.9.0',
      source_commit: '0a4dd63ad4541f4f655c4108a295916f3c1d8fda',
      skill_path: 'skills/ponytail/SKILL.md',
      mode: 'full',
      loading: 'explicit_skill_only_no_hooks'
    },
    fixtures: [
      { id: 'passkey', source_directory: 'passkey', source_commit: '24a55ce21aa6a525dd3bd215b13b2af8ef2e14a8', dependency_files: ['go/go.mod'] },
      { id: 'cutcode-shop', source_directory: 'cutcode-shop', source_commit: '1dc513dd7821c30cab2a8738b399768da58b049d', dependency_files: ['composer.json'] }
    ],
    scenarios: [
      { id: 'review-price-float-precision', fixture_id: 'cutcode-shop', command: 'review', shape: 'review-parity', change_id: 'lifecycle-price-format', title: 'review', command_skill: 'agent-files/claude/aifhub-review-sidecar.md', seeded_patch: 'patches/p.patch', hidden_grader: 'review-cutcode-grader.mjs', keywords: [['a']] },
      { id: 'security-decrypt-auth-skip', fixture_id: 'passkey', command: 'security', shape: 'security-parity', change_id: 'lifecycle-decrypt-auth', title: 'security', command_skill: 'agent-files/claude/aifhub-security-sidecar.md', seeded_patch: 'patches/p.patch', hidden_grader: 'security-passkey-grader.mjs', keywords: [['b']] },
      { id: 'verify-price-float-precision', fixture_id: 'cutcode-shop', command: 'verify', shape: 'verify-parity', change_id: 'lifecycle-price-format', title: 'verify', command_skill: 'agent-files/claude/aifhub-verifier.md', seeded_patch: 'patches/p.patch', hidden_grader: 'verify-cutcode-grader.mjs', keywords: [['c']] },
      { id: 'fix-decrypt-auth-restore', fixture_id: 'passkey', command: 'fix', shape: 'fix-parity', change_id: 'lifecycle-decrypt-auth', title: 'fix', command_skill: 'agent-files/claude/aifhub-fixer.md', seeded_patch: 'patches/p.patch', hidden_grader: 'fix-passkey-grader.mjs', qa_evidence: 'qa-evidence/verify.md', keywords: [] }
    ],
    ...overrides
  };
}

test('catalog validation rejects contract violations', () => {
  assert.ok(validateLifecycleCatalog(cloneCatalog()).length === 0);
  const wrongSchema = cloneCatalog({ schema: 'aifhub.ponytail_pi_ab.catalog.v1' });
  assert.ok(validateLifecycleCatalog(wrongSchema).some((message) => message.includes('schema')));

  const missingFix = cloneCatalog();
  missingFix.scenarios = missingFix.scenarios.filter((scenario) => scenario.command !== 'fix');
  assert.ok(validateLifecycleCatalog(missingFix).some((message) => message.includes('fix command')));

  const strayEvidence = cloneCatalog();
  strayEvidence.scenarios[0].qa_evidence = 'qa-evidence/verify.md';
  assert.ok(validateLifecycleCatalog(strayEvidence).some((message) => message.includes('qa_evidence')));

  const shapeMismatch = cloneCatalog();
  shapeMismatch.scenarios[0].shape = 'security-parity';
  assert.ok(validateLifecycleCatalog(shapeMismatch).some((message) => message.includes('review-parity')));

  const shortReps = cloneCatalog();
  shortReps.defaults.repetitions = 3;
  assert.ok(validateLifecycleCatalog(shortReps).some((message) => message.includes('repetitions')));
});

test('matrix builds 32 paired cases with alternating condition order', async () => {
  const matrix = buildLifecycleMatrix({ catalog: cloneCatalog(), runId: 'lifecycle-la-test-01' });
  assert.equal(matrix.cases.length, 32);
  assert.equal(new Set(matrix.cases.map((item) => item.id)).size, 32);
  const first = matrix.cases[0];
  const firstPairMate = matrix.cases[1];
  assert.equal(first.pair_id, firstPairMate.pair_id);
  assert.equal(first.condition, 'baseline');
  assert.equal(firstPairMate.condition, 'ponytail_full');
  const evenPair = matrix.cases.filter((item) => item.repetition === 2 && item.scenario_id === first.scenario_id);
  assert.deepEqual(evenPair.map((item) => item.condition), ['ponytail_full', 'baseline']);
  assert.equal(new Set(matrix.cases.map((item) => item.command)).size, 4);
  const verifyCase = matrix.cases.find((item) => item.command === 'verify');
  assert.equal(verifyCase.command_invocation, '/aif-verify lifecycle-price-format');
});

test('invocations differ only by the Ponytail skill between arms', () => {
  const matrix = buildLifecycleMatrix({ catalog: cloneCatalog(), runId: 'lifecycle-la-test-01' });
  const baseline = matrix.cases.find((item) => item.condition === 'baseline' && item.repetition === 1);
  const candidate = matrix.cases.find((item) => item.condition === 'ponytail_full' && item.repetition === 1);
  const baselineArgs = buildLifecycleInvocation(baseline, {
    commandSkillPath: '<case>/treatment/command-skill/SKILL.md',
    ponytailSkillPath: null
  }).args;
  const candidateArgs = buildLifecycleInvocation(candidate, {
    commandSkillPath: '<case>/treatment/command-skill/SKILL.md',
    ponytailSkillPath: '<case>/treatment/ponytail/SKILL.md'
  }).args;
  const skills = (args) => args.flatMap((arg, index) => (arg === '--skill' ? [args[index + 1]] : []));
  assert.deepEqual(skills(baselineArgs), ['<case>/treatment/command-skill/SKILL.md']);
  assert.deepEqual(skills(candidateArgs), ['<case>/treatment/command-skill/SKILL.md', '<case>/treatment/ponytail/SKILL.md']);
  assert.throws(() => buildLifecycleInvocation(candidate, {
    commandSkillPath: '<case>/treatment/command-skill/SKILL.md',
    ponytailSkillPath: null
  }), /ponytailSkillPath/);
});

test('case prompts pin the command invocation and isolation rules', () => {
  const matrix = buildLifecycleMatrix({ catalog: cloneCatalog(), runId: 'lifecycle-la-test-01' });
  const baselineReview = matrix.cases.find((item) => item.condition === 'baseline' && item.command === 'review');
  const candidateReview = matrix.cases.find((item) => item.condition === 'ponytail_full' && item.command === 'review');
  const baselinePrompt = renderCasePrompt(baselineReview);
  const candidatePrompt = renderCasePrompt(candidateReview);
  assert.match(baselinePrompt, /`\/aif-review`/);
  assert.match(baselinePrompt, /Do not commit, amend, reset/);
  assert.doesNotMatch(baselinePrompt, /Ponytail skill/);
  assert.match(candidatePrompt, /Use the explicitly loaded Ponytail skill in full mode/);
});

test('command skill frontmatter rewrite keeps only pi-safe keys', async () => {
  const source = await readFile(path.join(REPO_ROOT, 'agent-files/claude/aifhub-review-sidecar.md'), 'utf8');
  const rewritten = rewriteCommandSkillFrontmatter(source);
  assert.match(rewritten, /^---\nname: aifhub-review-sidecar\ndescription: Read-only sidecar[^\n]*\n---\n/);
  assert.doesNotMatch(rewritten, /^tools:/m);
  assert.doesNotMatch(rewritten, /^maxTurns:/m);
  assert.match(rewritten, /You are a read-only review sidecar for AIFHub\./);
  const rewrittenTwice = rewriteCommandSkillFrontmatter(rewritten);
  assert.equal(rewrittenTwice, rewritten);
});

function reviewOutputFixture({ status = 'fail', blocking = true, withSuggested = true, gate = 'review' } = {}) {
  const suggested = withSuggested
    ? { command: '/aif-fix', args: { 'change-id': 'x' } }
    : null;
  return [
    'Verdict: FAIL',
    'Findings:',
    '- F-1: `src/Support/ValueObjects/Price.php` renders through float division; the value 9007199254740993 at precision 100 loses the last digit (90 071 992 547 409,92 instead of ,93). number_format receives a float.',
    '',
    'Evidence: changed file src/Support/ValueObjects/Price.php; canonical artifacts inspected.',
    '',
    '```aif-gate-result',
    JSON.stringify({ schema_version: 1, gate, status, blocking, blockers: status === 'pass' ? [] : ['F-1'], affected_files: ['src/Support/ValueObjects/Price.php'], suggested_next: suggested }, null, 2),
    '```'
  ].join('\n');
}

test('grader lib extracts assistant text and enforces gate contracts', () => {
  const events = [
    { type: 'message_start' },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'task' }] } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: reviewOutputFixture() }] } }
  ];
  const jsonl = events.map((event) => JSON.stringify(event)).join('\n');
  const text = extractAssistantText(jsonl);
  assert.match(text, /Verdict: FAIL/);
  const gate = assertFinalGateBlock(text, 'test', 'review');
  assert.equal(gate.status, 'fail');

  assert.throws(() => assertFinalGateBlock(text, 'test', 'security'), /gate must be/);
  assert.throws(() => assertFinalGateBlock(reviewOutputFixture({ status: 'pass', withSuggested: true }), 'test', 'review'), /suggested_next must be null/);
  assert.throws(() => assertFinalGateBlock(reviewOutputFixture({ status: 'fail', blocking: false }), 'test', 'review'), /blocking must be true/);
  assert.throws(() => assertFinalGateBlock('no block here', 'test', 'review'), /no fenced aif-gate-result/);
  assert.doesNotThrow(() => assertKeywordGroups(reviewOutputFixture(), [['price', 'Price'], ['float', 'точность']], 'test'));
  assert.throws(() => assertKeywordGroups(reviewOutputFixture(), [['price'], ['swallowed gcm tag']], 'test'), /keyword group #2/);
});

test('review grader passes a compliant read-only case and fails tampering', async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'lifecycle-grader-'));
  try {
    const caseRoot = path.join(fixtureRoot, 'case');
    const projectRoot = path.join(caseRoot, 'project');
    await mkdir(projectRoot, { recursive: true });
    const output = reviewOutputFixture();
    await writeFile(path.join(caseRoot, 'pi-events.jsonl'), `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: output }] } })}\n`);
    await writeFile(path.join(caseRoot, 'seeded-diff.txt'), 'diff --git a/x b/x\n');
    await writeFile(path.join(caseRoot, 'current-diff.txt'), 'diff --git a/x b/x\n');
    const graderPath = path.join(REPO_ROOT, 'scripts', 'fixtures', 'ponytail-lifecycle-ab', 'review-cutcode-grader.mjs');
    const { spawnSync } = await import('node:child_process');
    const pass = spawnSync(process.execPath, [graderPath, projectRoot], { encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stderr);
    await writeFile(path.join(caseRoot, 'current-diff.txt'), 'diff --git a/y b/y\n');
    const fail = spawnSync(process.execPath, [graderPath, projectRoot], { encoding: 'utf8' });
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /read-only/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('verify grader enforces persisted fail verdict matching stdout', async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'lifecycle-verify-'));
  try {
    const caseRoot = path.join(fixtureRoot, 'case');
    const projectRoot = path.join(caseRoot, 'project');
    await mkdir(path.join(projectRoot, '.ai-factory', 'qa', 'lifecycle-price-format'), { recursive: true });
    const gateText = reviewOutputFixture({ status: 'fail', gate: 'verify', withSuggested: true });
    await writeFile(path.join(projectRoot, '.ai-factory', 'qa', 'lifecycle-price-format', 'verify.md'), gateText);
    await writeFile(path.join(caseRoot, 'pi-events.jsonl'), `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: gateText }] } })}\n`);
    const { spawnSync } = await import('node:child_process');
    const graderPath = path.join(REPO_ROOT, 'scripts', 'fixtures', 'ponytail-lifecycle-ab', 'verify-cutcode-grader.mjs');
    const pass = spawnSync(process.execPath, [graderPath, projectRoot], { encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stderr);
    const passingText = reviewOutputFixture({ status: 'pass', blocking: false, withSuggested: false, gate: 'verify' });
    await writeFile(path.join(projectRoot, '.ai-factory', 'qa', 'lifecycle-price-format', 'verify.md'), passingText);
    const fail = spawnSync(process.execPath, [graderPath, projectRoot], { encoding: 'utf8' });
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /must fail/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('conditions and command constants stay pinned', () => {
  assert.deepEqual(PONYTAIL_LIFECYCLE_CONDITIONS, ['baseline', 'ponytail_full']);
  assert.deepEqual(LIFECYCLE_COMMANDS, ['review', 'security', 'verify', 'fix']);
});
