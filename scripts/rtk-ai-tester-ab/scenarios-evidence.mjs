// Evidence & privacy matrix for issue #138 (RTK evaluation).
// Covers the acceptance criteria added to the issue that the four original
// scenarios in scenarios.mjs do not:
//   - raw bypass for full diffs, logs, history and protected artifacts
//   - failing-test traceback/assertion fidelity under the compressed path
//   - protected validation artifacts (aif-gate-result, coverage.json,
//     done-readiness.json, openspec/**) recoverable exactly
//   - sensitive commands excluded from rewriting; no token in local
//     persistence (SQLite store, tee files, `rtk gain` output)
// Grading is exact-evidence based: review findings, failure diagnostics and
// exact-evidence completeness, not token counts alone.
//
// Runner glue (run.mjs extension for this matrix):
//   - import { cases as evidenceCases, systemPrompt } from './scenarios-evidence.mjs'
//     (systemPrompt is re-exported unchanged from scenarios.mjs)
//   - commandEnv.RTK_AB_PYTEST = JSON.stringify(PYTEST_FAILURES)
//   - inputs needs additional executables: `cat` (e.g. coreutils cat.exe),
//     `pytest` (python -m pytest wrapper); `php`, `git`, `rtk` as before
//   - per-run post-check: privacyPostCheck({ dbPath: path.join(work, 'rtk.db'),
//     teeDir, gainOutput: <captured `rtk gain` stdout>, markers: [SENSITIVE.token] })
//   - extension.ts test-command regex should include pytest: /^(go test|php |pytest )/
//
// All tokens in fixtures are synthetic (AB-SYNTH-*); no real credentials exist
// anywhere in this matrix.
import fs from 'node:fs';
import path from 'node:path';
import { tokens } from './guard.mjs';

export { systemPrompt } from './scenarios.mjs';

// ---------------------------------------------------------------------------
// Fixture constants. Everything is deterministic so run fingerprints are stable.
// ---------------------------------------------------------------------------

// Protected validation artifacts (docs/context-loading-policy.md contract):
// exact JSON blocks, decimal coverage numbers, exact blocker strings.
export const GATE_RESULT = {
  schema: 'aifhub.gate-result.v1',
  change: 'fix-auth-retry',
  verdict: 'BLOCKED',
  next: '/aif-fix tests/test_retry.py::test_backoff_ceiling',
  gates: [
    { id: 'openspec-validate', status: 'PASS', details: '2 capabilities validated, 0 deltas invalid' },
    { id: 'tests', status: 'FAIL', required: true, details: '1 of 14 failed: tests/test_retry.py::test_backoff_ceiling' },
    { id: 'coverage', status: 'WARN', details: 'line coverage 87.34% below threshold 90.00%' },
  ],
};

export const COVERAGE = {
  schema: 'aifhub.coverage.v1',
  threshold: 90.0,
  totals: { lines: 87.34, branches: 71.25, functions: 93.08 },
  files: {
    'src/auth/retry.py': { lines: 84.21, branches: 60.0 },
    'src/auth/session.py': { lines: 91.44, branches: 82.5 },
  },
};

export const DONE_READINESS = {
  schema: 'aifhub.done-readiness.v1',
  ready: false,
  blockers: ['coverage-below-threshold', 'unverified-manual-check'],
  warnings: ['stale-handoff-note'],
  generated_at: '2026-09-01T10:15:00Z',
};

export const PROPOSAL_SCENARIO = '#### Scenario: retry honors the configured ceiling';

const gateResultBlock = JSON.stringify(GATE_RESULT, null, 2);
const PROPOSAL_MD = `# fix-auth-retry

## Why

Session refresh retries exceed the configured ceiling and silently drop the
last failure reason. Evidence for this change lives in protected artifacts;
this proposal text is exact evidence and must survive any output compression.

## Requested response label

The scenario heading below is graded byte-exact.

${PROPOSAL_SCENARIO}

## Proposed changes

- Cap refresh backoff at exactly 5 attempts, then surface the stored reason.
- Keep the failing test name verbatim in every gate result.

## Gate result snapshot

\`\`\`json
${gateResultBlock}
\`\`\`
`;

const TASKS_MD = `## 1. Implementation

- [ ] 1.1 Honor ceiling 5 in src/auth/retry.py
- [ ] 1.2 Preserve failure reason across attempts

## 2. Validation

- [ ] 2.1 tests/test_retry.py::test_backoff_ceiling asserts exact ceiling
`;

const SPEC_MD = `# auth-retry Specification

## ADDED Requirements

### Requirement: Bounded refresh retry

The refresh path SHALL perform at most exactly 5 attempts and SHALL preserve
the final failure reason string verbatim.

${PROPOSAL_SCENARIO}
`;

// Failing pytest suite. Operands come from the environment at run time so
// source inspection cannot reveal the answer (mirrors the Go diagnostics
// fixture). 12 failures + 4 passing tests exercise pass-collapse compression.
export const PYTEST_FAILURES = Array.from({ length: 12 }, (_, i) => ({
  name: `phase_${String(i + 1).padStart(2, '0')}`,
  got: 5200 + i * 23,
  want: 6100 + i * 19,
}));

export const PYTEST_TEST_FILE = `import json
import os

import pytest

CASES = json.loads(os.environ["RTK_AB_PYTEST"])


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_audit_operand(case):
    assert case["got"] == case["want"], f"audit mismatch: got={case['got']} want={case['want']}"


def test_passing_summary_shape():
    assert {"audit": "operands"} == {"audit": "operands"}


@pytest.mark.parametrize("index", [1, 2, 3])
def test_passing_retry_paths(index):
    assert index * 2 == index + index
`;

// Raw-escape fixture: seeded three-commit history plus a dirty working tree
// whose full patch contains evidence the condensed overview omits.
export const ESCAPE_COMMITS = [
  { subject: 'escape step 1: extract session validator', author: 'Escape Maintainer One',
    email: 'escape1@example.invalid', date: '2026-08-25', gate: 'gate-1-full-patch-required' },
  { subject: 'escape step 2: remove legacy hmac path', author: 'Escape Maintainer Two',
    email: 'escape2@example.invalid', date: '2026-08-26', gate: 'gate-2-full-patch-required' },
  { subject: 'escape step 3: tighten refresh boundary', author: 'Escape Maintainer Three',
    email: 'escape3@example.invalid', date: '2026-08-27', gate: 'gate-3-full-patch-required' },
];
export const ESCAPE = {
  deletedLine: 'const LEGACY_HMAC_SECRET = "removed-legacy-hmac-9137"',
  headGateTrailer: 'Gate: gate-3-full-patch-required',
  boilerplateLines: 120,
};
const SESSION_SEED = 'package auth\n\nfunc helperOne() int { return 11 }\n';
const SESSION_AFTER = `${SESSION_SEED}\nfunc tightenedBoundary() int { return 44 }\n`;
const LEGACY_SEED = `package auth\n\n${ESCAPE.deletedLine}\nfunc helperTwo() int { return 22 }\n`;
const LEGACY_AFTER = 'package auth\n\nfunc helperTwo() int { return 22 }\n';
const notes = marker => Array.from({ length: ESCAPE.boilerplateLines },
  (_, i) => `documentation context ${i}: ${marker} baseline explanation`).join('\n') + '\n';
const REFRESH_SEED = 'package auth\n\nfunc helperThree() int { return 33 }\n';

// Sensitive-command fixture: a synthetic token passed as a command argument.
// The status output intentionally echoes the token, simulating a
// credential-bearing diagnostic, so persistence hygiene is observable.
export const SENSITIVE = {
  token: 'AB-SYNTH-TOKEN-7f3a91c2',
  statusCommand: 'php tool/status.php --token=AB-SYNTH-TOKEN-7f3a91c2',
  failingCommand: 'php tool/status.php --token=AB-SYNTH-TOKEN-7f3a91c2 --fail-stdout',
  failingExit: 3,
};
export const STATUS_PHP = `<?php
$options = getopt('', ['token:', 'fail-stdout']);
$token = $options['token'] ?? '';
if (isset($options['fail-stdout'])) {
    fwrite(STDOUT, "diagnostic dump token={$token} service=auth stage=upgrade\\n");
    fwrite(STDERR, "recovery required for token={$token}\\n");
    exit(${SENSITIVE.failingExit});
}
echo json_encode(['service' => 'auth', 'status' => 'ok', 'token' => $token]), "\\n";
`;

// ---------------------------------------------------------------------------
// Explore scenario (research phase, ~ aif-explore): ripgrep evidence recovery.
// Terms are selected per project from the pinned snapshot so the ground truth
// is computed, not authored; the runner stores it outside the sandbox.
// ---------------------------------------------------------------------------
export const EXPLORE_CANDIDATES = ['error', 'config', 'request', 'user', 'data', 'render', 'service',
  'controller', 'widget', 'provider', 'model', 'state', 'route', 'test', 'name', 'path'];

export function selectExploreTerms(counts) {
  const entries = Object.entries(counts).filter(([, n]) => Number.isFinite(n) && n > 0);
  const common = entries.slice().sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!common) throw Error('no explore candidate has matches');
  const rest = entries.filter(([t]) => t !== common[0]);
  // Prefer a genuinely rare term (1..8 matches); fall back to the smallest
  // positive count so sparse stacks (small fixtures, Unity code) still work.
  const rare = rest.filter(([, n]) => n >= 1 && n <= 8)
    .sort((a, b) => Math.abs(a[1] - 5) - Math.abs(b[1] - 5) || a[0].localeCompare(b[0]))[0]
    || rest.slice().sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0];
  if (!rare) throw Error('no rare explore candidate with matches');
  return { common: common[0], commonTotal: common[1], rare: rare[0], rareTotal: rare[1] };
}

export function buildExploreCase(common, rare) {
  return {
    id: 'code-explore-fidelity', project: 'single-01',
    commands: [`rg -c ${common} .`, `rg -n ${rare} .`],
    readPaths: [], writePaths: [],
    prompt: `Research task: locate evidence in this repository with ripgrep. Run "rg -c ${common} ." to map the distribution, then "rg -n ${rare} ." for exact locations. Return exactly one JSON object: {"commonTerm":string,"commonTotal":number,"topFiles":[{"file":string,"count":number}],"rareTerm":string,"rareTotal":number,"rareMatches":[{"file":string,"line":number}],"usedRawOutput":boolean}. commonTerm and rareTerm echo the searched terms. commonTotal is the exact total number of matching lines of "rg -c ${common} ." across all files. topFiles lists up to three files with the most matches for ${common}, with relative paths (forward slashes, no "./" prefix) and exact per-file counts. rareMatches lists every ${rare} match as relative path and 1-based line number. If compressed output truncates or hides any required detail, re-run the same command prefixed with "raw ". Do not edit files.`,
  };
}

// rg on Windows prints '.\path\file' with backslashes; rtk's compressed view may
// use forward slashes. Ground truth and grading normalize to forward slashes
// without the leading './' or '.\'.
export function normalizeRgPath(p) {
  return String(p || '').replace(/^\.\\|^\.\//, '').replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Scenario catalog. Same shape as scenarios.mjs; commands must survive
// guard.tokens() and the adapter enum (a `raw ` variant is added per command).
// ---------------------------------------------------------------------------
export const cases = [
  {
    id: 'gate-artifact-fidelity', project: 'single-01',
    commands: [
      'cat .ai-factory/aif-gate-result.json',
      'cat .ai-factory/coverage.json',
      'cat .ai-factory/done-readiness.json',
      'cat openspec/changes/fix-auth-retry/proposal.md',
    ],
    readPaths: [], writePaths: [],
    prompt: `Read the protected validation artifacts of OpenSpec change fix-auth-retry: the gate result, the coverage report, the done-readiness report and the proposal. Return exactly one JSON object: {"verdict":string,"next":string,"failedGate":string,"failedTest":string,"coverageLines":number,"coverageBranches":number,"ready":boolean,"blockers":[string],"proposalScenario":string,"complete":boolean}. verdict/next/failedGate/failedTest/proposalScenario and blockers must be copied byte-exact from the artifacts; coverage numbers keep both decimals. proposalScenario is the exact "#### Scenario:" heading line from the proposal. Set complete to true only if every value above came from full artifact output. If compressed output omits or alters any detail, re-run the same command prefixed with "raw " before answering. Do not edit files.`,
  },
  {
    id: 'pytest-traceback-fidelity', project: 'single-01',
    commands: [
      'pytest -q tests/test_audit_operands.py',
      'pytest tests/test_audit_operands.py -k phase_01 -q',
    ],
    readPaths: ['tests/test_audit_operands.py'], writePaths: [],
    prompt: `Run the audit test suite and report every failing subtest exactly. Return exactly one JSON object: {"failures":[{"name":string,"got":number,"want":number}],"count":number,"passedCount":number,"exitNonzero":boolean,"firstAssertion":string}. Use short subtest names sorted alphabetically. got/want must be the exact integer operands from the real test output; the source file reads placeholders from the environment and is insufficient. firstAssertion is the exact assertion message of the phase_01 failure, from "audit mismatch:" up to and including "want=". count counts failures only; passedCount counts passing tests. If compressed output hides any failing-test detail, re-run the affected command prefixed with "raw ". Do not modify code.`,
  },
  {
    id: 'raw-escape-archaeology', project: 'single-01',
    commands: ['git diff --stat', 'git diff', 'git log -3', 'git show HEAD'],
    readPaths: [], writePaths: [],
    prompt: `Audit the uncommitted changes and the last three commits. Begin with git diff --stat. The condensed overview is intentionally incomplete for this audit; recover exact evidence. Return exactly one JSON object: {"deletedLine":string,"files":[{"file":string,"insertions":number,"deletions":number}],"oldestSubject":string,"headGateTrailer":string,"usedRawOutput":boolean}. deletedLine is the exact deleted source line containing LEGACY_HMAC_SECRET. files lists every working-tree change with its exact total insertion and deletion counts, sorted by path. oldestSubject is the complete subject of the oldest of the last three commits. headGateTrailer is the exact "Gate:" trailer line from the commit message body of HEAD. Set usedRawOutput to true if you needed a "raw " prefixed command to recover any field. Do not edit files.`,
  },
  {
    id: 'code-explore-fidelity', project: 'single-01',
    commands: ['rg -c error .', 'rg -n state .'],
    readPaths: [], writePaths: [],
    prompt: 'TEMPLATE: the runner substitutes per-project terms via buildExploreCase.',
  },
  {
    id: 'sensitive-command-bypass', project: 'single-03',
    commands: [SENSITIVE.statusCommand, SENSITIVE.failingCommand, 'rtk gain'],
    readPaths: ['tool/status.php'], writePaths: [],
    prompt: `Run the deployment status check with the synthetic token, then the failing diagnostic, then request the RTK gain report. The token is synthetic and safe inside this sandbox. Return exactly one JSON object: {"status":{"service":string,"status":string,"tokenEcho":string},"failedDiagnosticExit":number,"tokenVisibleInGain":boolean,"gainSummary":string}. tokenEcho equals the token exactly as passed on the command line. failedDiagnosticExit is the exact exit code of the failing diagnostic. tokenVisibleInGain reports whether the token value appears anywhere in the gain output; report what you observe, never assume. gainSummary is a one-sentence summary of the gain report without command arguments. Do not print the token outside the required JSON fields. Prefix a listed command with "raw " only if its output is truncated.`,
  },
];

// ---------------------------------------------------------------------------
// Fixture materialization. io = { write(absPath, content), git(args, cwd, env) }
// so this stays pure and unit-testable; run.mjs passes fs.writeFileSync and
// its existing git() helper. Called after prepare()'s snapshot commit, so
// exactly the commits created here plus the dirty tree form the fixture.
// ---------------------------------------------------------------------------
export function buildFixture(c, target, io) {
  const write = (rel, content) => io.write(path.join(target, rel), content);
  if (c.id === 'gate-artifact-fidelity') {
    write('.ai-factory/aif-gate-result.json', JSON.stringify(GATE_RESULT, null, 2) + '\n');
    write('.ai-factory/coverage.json', JSON.stringify(COVERAGE, null, 2) + '\n');
    write('.ai-factory/done-readiness.json', JSON.stringify(DONE_READINESS, null, 2) + '\n');
    write('openspec/changes/fix-auth-retry/proposal.md', PROPOSAL_MD);
    write('openspec/changes/fix-auth-retry/tasks.md', TASKS_MD);
    write('openspec/specs/auth-retry/spec.md', SPEC_MD);
    return;
  }
  if (c.id === 'pytest-traceback-fidelity') {
    write('tests/test_audit_operands.py', PYTEST_TEST_FILE);
    return;
  }
  if (c.id === 'raw-escape-archaeology') {
    for (const [index, commit] of ESCAPE_COMMITS.entries()) {
      if (index === 0) write('src/auth/session.go', SESSION_SEED);
      if (index === 1) write('src/auth/legacy.go', LEGACY_SEED);
      if (index === 2) { write('src/auth/refresh.go', REFRESH_SEED); write('docs/notes.md', notes('unchanged')); }
      io.git(['add', '-A'], target);
      io.git(['commit', '-qm', `${commit.subject}\n\nControlled fixture history for the raw-evidence audit.\n\n${ESCAPE.headGateTrailer.replace('gate-3', `gate-${index + 1}`)}`], target,
        { GIT_AUTHOR_NAME: commit.author, GIT_AUTHOR_EMAIL: commit.email, GIT_AUTHOR_DATE: `${commit.date}T12:00:00Z`, GIT_COMMITTER_DATE: `${commit.date}T12:00:00Z` });
    }
    write('src/auth/session.go', SESSION_AFTER);
    write('src/auth/legacy.go', LEGACY_AFTER);
    write('docs/notes.md', notes('updated'));
    return;
  }
  if (c.id === 'code-explore-fidelity') {
    return; // the snapshot copy is the fixture; terms and ground truth are computed per project
  }
  if (c.id === 'sensitive-command-bypass') {
    write('tool/status.php', STATUS_PHP);
    return;
  }
  throw Error(`no fixture builder for ${c.id}`);
}

// ---------------------------------------------------------------------------
// Grading. gradeEvidence(c, stats, ctx) mirrors run.mjs grade(): ctx.answer is
// answerObject(finalText), ctx.privacy is privacyPostCheck(...) or null when
// the runner did not run the post-check (recorded as not checked, not passed).
// ---------------------------------------------------------------------------
// True per-file working-tree diff counts of the escape fixture (verified via
// git diff --numstat). session.go gains a blank separator line plus the new
// function: 2 insertions.
export const EXPECTED_FILES_DIFF = [
  { file: 'docs/notes.md', insertions: ESCAPE.boilerplateLines, deletions: ESCAPE.boilerplateLines },
  { file: 'src/auth/legacy.go', insertions: 0, deletions: 1 },
  { file: 'src/auth/session.go', insertions: 2, deletions: 0 },
];

export function gradeEvidence(c, stats, ctx) {
  const answer = ctx.answer;
  const commands = stats.commands || [];
  const checks = {
    validJson: !!answer,
    actualCommand: stats.commandCalls > 0,
    noDeniedCalls: stats.denied === 0,
    withinBudget: !stats.limitReached,
  };
  if (c.id === 'gate-artifact-fidelity') {
    checks.gateVerdict = answer?.verdict === GATE_RESULT.verdict;
    checks.gateNext = answer?.next === GATE_RESULT.next;
    checks.failedGate = answer?.failedGate === 'tests';
    checks.failedTest = answer?.failedTest === 'tests/test_retry.py::test_backoff_ceiling';
    checks.coverageExact = answer?.coverageLines === COVERAGE.totals.lines && answer?.coverageBranches === COVERAGE.totals.branches;
    checks.readinessExact = answer?.ready === DONE_READINESS.ready
      && JSON.stringify(answer?.blockers) === JSON.stringify(DONE_READINESS.blockers);
    checks.proposalScenario = answer?.proposalScenario === PROPOSAL_SCENARIO;
    checks.complete = answer?.complete === true;
    checks.initialCat = commands[0]?.command === 'cat .ai-factory/aif-gate-result.json';
  } else if (c.id === 'pytest-traceback-fidelity') {
    const expected = [...PYTEST_FAILURES].sort((a, b) => a.name.localeCompare(b.name));
    checks.allFailures = answer?.count === expected.length && answer?.failures?.length === expected.length
      && expected.every((x, i) => ['name', 'got', 'want'].every(k => answer.failures[i][k] === x[k]));
    checks.passedCount = answer?.passedCount === 4;
    checks.exitNonzero = answer?.exitNonzero === true;
    const first = expected[0];
    checks.firstAssertion = answer?.firstAssertion === `audit mismatch: got=${first.got} want=${first.want}`;
    checks.executedFailingSuite = commands.some(x => x.command.startsWith('pytest') && x.code !== 0);
  } else if (c.id === 'raw-escape-archaeology') {
    checks.deletedLine = answer?.deletedLine === ESCAPE.deletedLine;
    checks.fileCounts = JSON.stringify(answer?.files) === JSON.stringify(EXPECTED_FILES_DIFF);
    checks.oldestSubject = answer?.oldestSubject === ESCAPE_COMMITS[0].subject;
    checks.headGateTrailer = answer?.headGateTrailer === ESCAPE.headGateTrailer;
    checks.beganWithStat = commands[0]?.command === 'git diff --stat';
  } else if (c.id === 'code-explore-fidelity') {
    // Content-exact grading: order-insensitive comparison after rg path
    // normalization (rg prints OS separators; rtk may not), presentation
    // preferences stay in the prompt, exactness in the checks.
    const exp = ctx.expected;
    const pairList = list => JSON.stringify((list || []).slice()
      .map(x => ({ ...x, file: normalizeRgPath(x.file) }))
      .sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? a.count) - (b.line ?? b.count))
      .map(x => [x.file, x.line ?? x.count]));
    checks.termsEchoed = !!exp && answer?.commonTerm === exp.common && answer?.rareTerm === exp.rare;
    checks.commonTotal = !!exp && answer?.commonTotal === exp.commonTotal;
    checks.topFiles = !!exp && pairList(answer?.topFiles) === pairList(exp.topFiles);
    checks.rareTotal = !!exp && answer?.rareTotal === exp.rareTotal;
    checks.rareMatches = !!exp && pairList(answer?.rareMatches) === pairList(exp.rareMatches);
    checks.initialCommand = !!exp && commands[0]?.command === `rg -c ${exp.common} .`;
    checks.usedRawFlagged = typeof answer?.usedRawOutput === 'boolean';
  } else if (c.id === 'sensitive-command-bypass') {
    checks.statusExact = JSON.stringify(answer?.status) === JSON.stringify(
      { service: 'auth', status: 'ok', tokenEcho: SENSITIVE.token });
    checks.failingExit = answer?.failedDiagnosticExit === SENSITIVE.failingExit;
    checks.ranFailingDiagnostic = commands.some(x => x.command === SENSITIVE.failingCommand && x.code === SENSITIVE.failingExit);
    checks.ranGain = commands.some(x => x.command === 'rtk gain');
    checks.tokenVisibilityReported = typeof answer?.tokenVisibleInGain === 'boolean';
    checks.honestTokenReport = answer?.tokenVisibleInGain === false
      ? (ctx.privacy ? ctx.privacy.clean && !ctx.privacy.gainHasMarker : false)
      : !!ctx.privacy?.gainHasMarker; // reported leak must be real
    // Rewriting is what the acceptance criterion forbids; the documented raw
    // escape is protocol in both arms and must not fail this check.
    checks.statusNotRewritten = commands.filter(x => x.command === SENSITIVE.statusCommand)
      .every(x => x.rtk === false);
    checks.privacyClean = ctx.privacy ? ctx.privacy.clean : false;
    checks.gainSummary = typeof answer?.gainSummary === 'string' && answer.gainSummary.length > 0
      && !answer.gainSummary.includes(SENSITIVE.token);
  }
  // Recorded separately from pass/fail (issue wording: tracebacks survive the
  // compressed path OR verification automatically uses raw output — the pass
  // criterion is exact evidence either way, the path is an observation).
  const rawRecoveryUsed = stats.rawCalls > 0 || commands.some(x => x.raw);
  const observation = { rawRecoveryUsed, compressedPathSufficient: !rawRecoveryUsed };
  return { pass: Object.values(checks).every(Boolean), checks, observation };
}

// ---------------------------------------------------------------------------
// Post-run privacy check (issue acceptance: tee disabled, no command arguments
// in the local store, `rtk gain` without arguments/secrets). Scans the RTK
// SQLite files, the tee directory and the captured gain output for the
// synthetic markers. Findings never echo full marker values.
// ---------------------------------------------------------------------------
export function privacyPostCheck({ dbPath, teeDir, gainOutput, markers }) {
  const needle = marker => Buffer.from(marker, 'utf8');
  const findings = [];
  const scan = (where, file, buffer) => {
    for (const marker of markers) if (buffer.includes(needle(marker))) findings.push({ where, file, markerHint: marker.slice(0, 10) });
  };
  for (const suffix of ['', '-wal', '-shm']) {
    const file = dbPath + suffix;
    if (dbPath && fs.existsSync(file)) scan('db', path.basename(file), fs.readFileSync(file));
  }
  const walk = dir => {
    if (!dir || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else scan('tee', path.basename(full), fs.readFileSync(full));
    }
  };
  walk(teeDir);
  if (gainOutput) scan('gain', 'rtk-gain-output', Buffer.from(gainOutput, 'utf8'));
  return {
    clean: findings.length === 0,
    findings,
    gainHasMarker: findings.some(x => x.where === 'gain'),
  };
}
