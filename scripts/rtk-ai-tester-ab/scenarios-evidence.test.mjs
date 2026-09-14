import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokens } from './guard.mjs';
import { cases as baseCases, systemPrompt as baseSystemPrompt } from './scenarios.mjs';
import {
  cases, buildFixture, gradeEvidence, privacyPostCheck, systemPrompt,
  GATE_RESULT, COVERAGE, DONE_READINESS, PROPOSAL_SCENARIO,
  PYTEST_FAILURES, PYTEST_TEST_FILE, ESCAPE_COMMITS, ESCAPE, EXPECTED_FILES_DIFF,
  SENSITIVE, STATUS_PHP, EXPLORE_CANDIDATES, selectExploreTerms, buildExploreCase, normalizeRgPath,
} from './scenarios-evidence.mjs';

test('catalog invariants: unique ids, guard-safe commands, single-JSON prompts, synthetic secrets only', () => {
  const ids = cases.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate scenario ids');
  for (const c of cases) {
    for (const command of c.commands) assert.doesNotThrow(() => tokens(command), c.id);
    const isTemplate = c.id === 'code-explore-fidelity' && c.prompt.startsWith('TEMPLATE');
    if (!isTemplate) assert.ok(c.prompt.includes('JSON object'), `${c.id}: prompt must request one JSON object`);
    assert.deepEqual(c.writePaths, [], `${c.id}: evidence matrix is read-only`);
  }
  const baseIds = new Set(baseCases.map(c => c.id));
  for (const id of ids) assert.ok(!baseIds.has(id), `id collides with original matrix: ${id}`);
  assert.equal(systemPrompt, baseSystemPrompt, 'system prompt must stay shared with the original matrix');
  assert.ok(SENSITIVE.token.startsWith('AB-SYNTH-'), 'fixture token must be a synthetic marker');
  for (const file of [STATUS_PHP, PYTEST_TEST_FILE]) assert.ok(!/BEGIN (RSA )?PRIVATE KEY|aws_secret/i.test(file), 'no real credentials in fixtures');
});

test('buildFixture materializes protected artifacts byte-exact', () => {
  const writes = {};
  const io = { write: (p, content) => { writes[p] = content; }, git: () => {} };
  const c = cases.find(x => x.id === 'gate-artifact-fidelity');
  buildFixture(c, '/t', io);
  const rel = p => path.join('/t', p);
  assert.equal(writes[rel('.ai-factory/aif-gate-result.json')], JSON.stringify(GATE_RESULT, null, 2) + '\n');
  assert.equal(writes[rel('.ai-factory/coverage.json')], JSON.stringify(COVERAGE, null, 2) + '\n');
  assert.equal(writes[rel('.ai-factory/done-readiness.json')], JSON.stringify(DONE_READINESS, null, 2) + '\n');
  assert.ok(writes[rel('openspec/changes/fix-auth-retry/proposal.md')].includes(PROPOSAL_SCENARIO));
  assert.ok(writes[rel('openspec/changes/fix-auth-retry/proposal.md')].includes(JSON.stringify(GATE_RESULT, null, 2)));
});

test('pytest fixture operands are environment-driven and match the grader', () => {
  const c = cases.find(x => x.id === 'pytest-traceback-fidelity');
  const writes = {};
  const io = { write: (p, content) => { writes[p] = content; }, git: () => {} };
  buildFixture(c, '/t', io);
  const file = writes[path.join('/t', 'tests/test_audit_operands.py')];
  assert.ok(file.includes('RTK_AB_PYTEST'), 'operands must come from the environment');
  assert.equal(PYTEST_FAILURES.length, 12);
  assert.ok(!file.includes(`got=${PYTEST_FAILURES[0].got}`), 'source must not reveal operands');
  const first = [...PYTEST_FAILURES].sort((a, b) => a.name.localeCompare(b.name))[0];
  assert.equal(`audit mismatch: got=${first.got} want=${first.want}`,
    `audit mismatch: got=${PYTEST_FAILURES[0].got} want=${PYTEST_FAILURES[0].want}`);
});

test('escape fixture seeds the deleted line in history and removes it from the working tree', () => {
  const commits = [];
  const history = [];
  const io = {
    write: (p, content) => history.push({ p, content }),
    git: args => { if (args[0] === 'commit') commits.push(args); },
  };
  const c = cases.find(x => x.id === 'raw-escape-archaeology');
  buildFixture(c, '/t', io);
  assert.equal(commits.length, 3);
  const legacy = history.filter(x => x.p === path.join('/t', 'src/auth/legacy.go')).map(x => x.content);
  assert.equal(legacy.length, 2, 'legacy.go is written once in history, once in the working tree');
  assert.ok(legacy[0].includes(ESCAPE.deletedLine), 'the deleted line must be committed first');
  assert.ok(!legacy[1].includes(ESCAPE.deletedLine), 'the working tree removes the deleted line');
  assert.ok(legacy[1].includes('func helperTwo() int { return 22 }'), 'only the secret line disappears');
  assert.ok(history.filter(x => x.p === path.join('/t', 'src/auth/session.go')).at(-1).content.includes('tightenedBoundary'));
  const notesAfter = history.filter(x => x.p === path.join('/t', 'docs/notes.md')).map(x => x.content)[1];
  assert.equal(notesAfter.split('\n').filter(l => l.includes('updated')).length, ESCAPE.boilerplateLines);
  assert.equal(notesAfter.split('\n').filter(l => l.includes('unchanged')).length, 0);
  assert.equal(EXPECTED_FILES_DIFF.reduce((sum, f) => sum + f.insertions + f.deletions, 0), ESCAPE.boilerplateLines * 2 + 3);
  // HEAD gate trailer derives from the newest commit
  assert.ok(ESCAPE_COMMITS[2].gate === 'gate-3-full-patch-required');
});

test('gradeEvidence: exact evidence passes, mutations fail per check', () => {
  const gate = cases.find(x => x.id === 'gate-artifact-fidelity');
  const goodGate = {
    verdict: GATE_RESULT.verdict, next: GATE_RESULT.next, failedGate: 'tests',
    failedTest: 'tests/test_retry.py::test_backoff_ceiling', coverageLines: COVERAGE.totals.lines,
    coverageBranches: COVERAGE.totals.branches, ready: false, blockers: [...DONE_READINESS.blockers],
    proposalScenario: PROPOSAL_SCENARIO, complete: true,
  };
  const statsGate = { commandCalls: 1, denied: 0, limitReached: false,
    commands: [{ command: 'cat .ai-factory/aif-gate-result.json', rtk: true, raw: false, code: 0 }] };
  const ok = gradeEvidence(gate, statsGate, { answer: goodGate });
  assert.equal(ok.pass, true, JSON.stringify(ok.checks));
  const rounded = gradeEvidence(gate, statsGate, { answer: { ...goodGate, coverageLines: 87.3 } });
  assert.equal(rounded.checks.coverageExact, false);
  assert.equal(rounded.pass, false);
  const incomplete = gradeEvidence(gate, statsGate, { answer: { ...goodGate, complete: false } });
  assert.equal(incomplete.checks.complete, false);
});

test('gradeEvidence: pytest exact operands required; path recorded as observation only', () => {
  const c = cases.find(x => x.id === 'pytest-traceback-fidelity');
  const failures = [...PYTEST_FAILURES].sort((a, b) => a.name.localeCompare(b.name));
  const first = failures[0];
  const answer = { failures: failures.map(f => ({ ...f })), count: 12, passedCount: 4, exitNonzero: true,
    firstAssertion: `audit mismatch: got=${first.got} want=${first.want}` };
  const stats = { commandCalls: 1, denied: 0, limitReached: false,
    commands: [{ command: 'pytest -q tests/test_audit_operands.py', rtk: true, raw: false, code: 1 }] };
  assert.equal(gradeEvidence(c, stats, { answer }).pass, true);
  const offByOne = gradeEvidence(c, stats, { answer: { ...answer, failures: answer.failures.map((f, i) => i === 3 ? { ...f, got: f.got + 1 } : f) } });
  assert.equal(offByOne.pass, false);
  const summary = gradeEvidence(c, stats, { answer: { ...answer, failures: answer.failures.slice(0, 10), count: 10 } });
  assert.equal(summary.pass, false, 'collapsed failure list must not pass');
  const rawStats = { ...stats, rawCalls: 1, commands: [...stats.commands, { command: 'raw pytest -q tests/test_audit_operands.py', rtk: false, raw: true, code: 1 }] };
  assert.equal(gradeEvidence(c, rawStats, { answer }).pass, true);
  assert.deepEqual(gradeEvidence(c, rawStats, { answer }).observation.rawRecoveryUsed, true);
  assert.deepEqual(gradeEvidence(c, stats, { answer }).observation.compressedPathSufficient, true);
});

test('gradeEvidence: escape evidence and diff counts must be exact', () => {
  const c = cases.find(x => x.id === 'raw-escape-archaeology');
  const answer = { deletedLine: ESCAPE.deletedLine, files: EXPECTED_FILES_DIFF,
    oldestSubject: ESCAPE_COMMITS[0].subject, headGateTrailer: ESCAPE.headGateTrailer, usedRawOutput: true };
  const stats = { commandCalls: 2, denied: 0, limitReached: false, rawCalls: 1,
    commands: [{ command: 'git diff --stat', rtk: true, raw: false, code: 0 }, { command: 'raw git diff', rtk: false, raw: true, code: 0 }] };
  assert.equal(gradeEvidence(c, stats, { answer }).pass, true);
  const wrongCounts = gradeEvidence(c, stats, { answer: { ...answer, files: EXPECTED_FILES_DIFF.map(f => ({ ...f, insertions: f.insertions + 1 })) } });
  assert.equal(wrongCounts.pass, false);
  const condensed = gradeEvidence(c, { ...stats, rawCalls: 0, commands: [stats.commands[0]] },
    { answer: { ...answer, deletedLine: 'LEGACY line lost by compression' } });
  assert.equal(condensed.pass, false, 'a condensed-only wrong answer must not pass');
});

test('gradeEvidence: sensitive command must stay unrewritten and leak must be reported honestly', () => {
  const c = cases.find(x => x.id === 'sensitive-command-bypass');
  const answer = { status: { service: 'auth', status: 'ok', tokenEcho: SENSITIVE.token },
    failedDiagnosticExit: SENSITIVE.failingExit, tokenVisibleInGain: false, gainSummary: 'Cumulative savings reported.' };
  const commands = [
    { command: SENSITIVE.statusCommand, rtk: false, raw: false, code: 0 },
    { command: SENSITIVE.failingCommand, rtk: false, raw: false, code: SENSITIVE.failingExit },
    { command: 'rtk gain', rtk: true, raw: false, code: 0 },
  ];
  const clean = { clean: true, findings: [], gainHasMarker: false };
  assert.equal(gradeEvidence(c, { commandCalls: 3, denied: 0, limitReached: false, commands }, { answer, privacy: clean }).pass, true);
  const rewritten = gradeEvidence(c, { commandCalls: 3, denied: 0, limitReached: false,
    commands: [{ ...commands[0], rtk: true }, ...commands.slice(1)] }, { answer, privacy: clean });
  assert.equal(rewritten.checks.statusNotRewritten, false, 'rewritten sensitive command must fail');
  const rawEscape = gradeEvidence(c, { commandCalls: 3, denied: 0, limitReached: false,
    commands: [{ ...commands[0], raw: true }, ...commands.slice(1)] }, { answer, privacy: clean });
  assert.equal(rawEscape.checks.statusNotRewritten, true, 'documented raw escape is not a rewrite');
  const dirty = { clean: false, findings: [{ where: 'gain', file: 'rtk-gain-output', markerHint: 'AB-SYNTH-T' }], gainHasMarker: true };
  const silent = gradeEvidence(c, { commandCalls: 3, denied: 0, limitReached: false, commands }, { answer, privacy: dirty });
  assert.equal(silent.checks.honestTokenReport, false, 'denying an actual gain leak must fail');
  const honest = gradeEvidence(c, { commandCalls: 3, denied: 0, limitReached: false, commands },
    { answer: { ...answer, tokenVisibleInGain: true }, privacy: dirty });
  assert.equal(honest.checks.honestTokenReport, true);
  assert.equal(honest.checks.privacyClean, false, 'leak still fails the scenario');
});

test('explore terms are computed, not authored; explore grading is content-exact', () => {
  const sel = selectExploreTerms({ error: 1674, config: 1180, render: 1, widget: 0, route: 590, name: 2 });
  assert.equal(sel.common, 'error');
  assert.equal(sel.rare, 'name', 'closest to 5 matches wins');
  const sparse = selectExploreTerms({ path: 7004, error: 116, controller: 0, widget: 0, config: 9 });
  assert.equal(sparse.rare, 'config', 'falls back to the smallest positive count');
  assert.throws(() => selectExploreTerms({ error: 100 }), /no rare explore candidate/);
  assert.throws(() => selectExploreTerms({ error: 0 }), /no explore candidate/);
  const c = buildExploreCase('error', 'name');
  for (const command of c.commands) assert.doesNotThrow(() => tokens(command));
  assert.ok(c.prompt.includes('rg -c error .') && c.prompt.includes('rg -n name .'));
  assert.equal(normalizeRgPath('.\\a\\b.ts'), 'a/b.ts');
  assert.equal(normalizeRgPath('./a/b.ts'), 'a/b.ts');
  assert.equal(normalizeRgPath('a/b.ts'), 'a/b.ts');
  const expected = { common: 'error', commonTotal: 42, rare: 'name', rareTotal: 3,
    topFiles: [{ file: 'a.ts', count: 20 }, { file: 'b.ts', count: 12 }, { file: 'c.ts', count: 10 }],
    rareMatches: [{ file: 'a.ts', line: 3 }, { file: 'b.ts', line: 7 }] };
  const answer = { commonTerm: 'error', commonTotal: 42, topFiles: [...expected.topFiles].reverse(),
    rareTerm: 'name', rareTotal: 3, rareMatches: [...expected.rareMatches].reverse(), usedRawOutput: false };
  const stats = { commandCalls: 2, denied: 0, limitReached: false,
    commands: [{ command: 'rg -c error .', rtk: true, raw: false, code: 0 }] };
  assert.equal(gradeEvidence(c, stats, { answer, expected }).pass, true, 'order-insensitive exact grading');
  const winPaths = gradeEvidence(c, stats, { answer: { ...answer, topFiles: expected.topFiles.map(x => ({ ...x, file: '.\\' + x.file.replace(/\//g, '\\') })) }, expected });
  assert.equal(winPaths.checks.topFiles, true, 'rg backslash paths normalize');
  const wrongCount = gradeEvidence(c, stats, { answer: { ...answer, commonTotal: 41 }, expected });
  assert.equal(wrongCount.checks.commonTotal, false);
  const missingMatch = gradeEvidence(c, stats, { answer: { ...answer, rareMatches: expected.rareMatches.slice(0, 1) }, expected });
  assert.equal(missingMatch.checks.rareMatches, false, 'collapsed match list must not pass');
});

test('privacyPostCheck scans db (incl. -wal/-shm), tee tree and gain output', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-evidence-privacy-'));
  try {
    const markers = [SENSITIVE.token];
    const dbPath = path.join(base, 'rtk.db');
    fs.writeFileSync(dbPath, Buffer.from(`INSERT ... original_cmd '${SENSITIVE.token}' ...`));
    fs.writeFileSync(dbPath + '-wal', Buffer.from('clean wal'));
    const teeDir = path.join(base, 'tee');
    fs.mkdirSync(path.join(teeDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(teeDir, 'nested', 'failure.log'), `stderr token=${SENSITIVE.token}`);
    const dirty = privacyPostCheck({ dbPath, teeDir, gainOutput: `gain: 1234 tokens\nargs: --token=${SENSITIVE.token}`, markers });
    assert.equal(dirty.clean, false);
    assert.deepEqual(dirty.findings.map(x => x.where).sort(), ['db', 'gain', 'tee']);
    assert.equal(dirty.gainHasMarker, true);
    assert.ok(dirty.findings.every(x => !x.markerHint.includes('91c2')), 'findings must not echo full markers');

    fs.rmSync(dbPath); fs.writeFileSync(dbPath, Buffer.from('no markers here'));
    fs.rmSync(teeDir, { recursive: true });
    const clean = privacyPostCheck({ dbPath, teeDir, gainOutput: 'gain: total 0', markers });
    assert.deepEqual(clean, { clean: true, findings: [], gainHasMarker: false });
    const absent = privacyPostCheck({ dbPath: path.join(base, 'missing.db'), teeDir: path.join(base, 'no-tee'), gainOutput: '', markers });
    assert.equal(absent.clean, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
