// context-dedup-ai-tester-summary.test.mjs - regression coverage for issue #133 matrix accounting
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { snapshotScenarioName } from '../docs/memory-tools-research/context-dedup-ai-tester/generate-matrix.mjs';
import {
  buildRows,
  buildSummary,
  classifyPayload,
  metrics,
  writeSummaryExclusive
} from '../docs/memory-tools-research/context-dedup-ai-tester/summarize-matrix.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function measurement(inputBytes, outputBytes, payloadClass, decision = 'full', readIndex = 0) {
  return { inputBytes, outputBytes, payloadClass, decision, readIndex, phase: 'read' };
}

function row(caseId, arm, pass, measurements) {
  return { caseId, arm, pass, measurements };
}

function fixtureRows() {
  const rows = [];
  for (const arm of ['baseline', 'aifhub', 'sqz']) {
    rows.push(row('repeat-source', arm, true, arm === 'baseline'
      ? [
          measurement(14342, 14342, 'firstRead', 'full', 0),
          measurement(14342, 14342, 'exactRepeat', 'full', 1)
        ]
      : arm === 'aifhub'
        ? [
            measurement(14342, 14342, 'firstRead', 'full', 0),
            measurement(14342, 181, 'exactRepeat', 'deduplicated', 1)
          ]
        : [
            measurement(14342, 277, 'firstRead', 'compressed', 0),
            measurement(14342, 181, 'exactRepeat', 'reference', 1)
          ]));

    rows.push(row('changed-source', arm, true, arm === 'sqz'
      ? [
          measurement(16673, 8442, 'firstRead', 'compressed', 0),
          measurement(16673, 8136, 'changed', 'compressed', 1)
        ]
      : [
          measurement(16673, 16673, 'firstRead', 'full', 0),
          measurement(16673, 16673, 'changed', arm === 'aifhub' ? 'changed' : 'full', 1)
        ]));

    rows.push(row('protected-openspec', arm, true, arm === 'sqz'
      ? [
          measurement(14589, 14589, 'protected', 'protected', 0),
          measurement(14589, 14589, 'protected', 'protected', 1)
        ]
      : [
          measurement(14589, 14589, 'protected', arm === 'aifhub' ? 'protected' : 'full', 0),
          measurement(14589, 14589, 'protected', arm === 'aifhub' ? 'protected' : 'full', 1)
        ]));

    rows.push(row('fresh-session-preseeded-cache', arm, true, arm === 'sqz'
      ? [measurement(14052, 7867, 'freshSession', 'compressed', 0)]
      : [measurement(14052, 14052, 'freshSession', 'full', 0)]));
  }
  return rows;
}

function byArm(entries, arm) {
  return entries.find((entry) => entry.arm === arm);
}

describe('issue 186 AI Tester accounting', () => {
  function traceEntry(identity, { inputBytes = 100, outputBytes = 100, inputTokens = 100,
    outputTokens = 0, exitCode = 0, pass = true, attempt = 1 } = {}) {
    const { caseId, arm, profile, repeat } = identity;
    const trace = {
      scenario: { name: 'context-dedup-' + caseId + '-' + arm },
      runner: { exitCode, attempt }, scoring: { overallPass: pass },
      cost: { inputTokens, outputTokens },
      turns: [{ toolCalls: [{ name: 'Bash', resultIsError: false, input: { command: 'node project/scripts/read-context.mjs src/policy.txt' }, resultContent: '[dedup-metric] arm=' + arm +
        ' phase=read decision=full inputBytes=' + inputBytes + ' outputBytes=' + outputBytes +
        ' savedBytes=' + (inputBytes - outputBytes) }] }]
    };
    return { identity: { ...identity, attempt }, trace,
      file: path.join('runs', profile, caseId, arm, 'r' + repeat, 'attempt-' + attempt + '.json') };
  }

  function cell(profile, repeat, arm) {
    return { snapshot: 'fixture', platform: 'linux', profile, repeat, arm, caseId: 'short-config' };
  }

  it('retains negative net model-visible bytes by row and read class', () => {
    const [actual] = buildRows([traceEntry(cell('alpha', 1, 'sqz'), { inputBytes: 10, outputBytes: 15 })], 'runs');
    assert.deepEqual([actual.inputBytes, actual.outputBytes, actual.savedBytes], [10, 15, -5]);
    assert.equal(actual.payloadByClass.firstRead.savedBytes, -5);
  });

  it('keeps measured zero separate from missing token usage', () => {
    const zero = traceEntry(cell('alpha', 1, 'sqz'), { inputTokens: 0, outputTokens: 0 });
    zero.trace.cost.totalTokens = 0;
    const unknown = traceEntry(cell('alpha', 2, 'sqz'), { inputTokens: 21 });
    delete unknown.trace.cost.outputTokens;
    assert.deepEqual(buildRows([zero, unknown], 'runs').map(r => [r.inputTokens, r.outputTokens, r.totalTokens]), [[0, 0, 0], [21, null, null]]);
  });

  it('retains measured costs when the runner exits unsuccessfully despite a correct answer', () => {
    const [actual] = buildRows([traceEntry(cell('alpha', 1, 'sqz'), { exitCode: 7, inputTokens: 13, outputTokens: 4 })], 'runs');
    assert.deepEqual([actual.pass, actual.inputTokens, actual.outputTokens], [false, 13, 4]);
  });

  it('requires two separate reads around a confirmed mutation before comparing a changed-source trial', () => {
    const expected = ['baseline', 'aifhub', 'sqz'].map(arm => ({ ...cell('alpha', 1, arm), caseId: 'changed-source' }));
    const entries = expected.map(key => {
      const entry = traceEntry(key);
      const calls = entry.trace.turns[0].toolCalls;
      const read = calls[0];
      read.input.command = 'node project/scripts/read-context.mjs src/change-target.txt';
      calls.push({ name: 'Bash', input: { command: 'node project/scripts/mutate-change.mjs' },
        resultIsError: false, resultContent: 'fixture_mutated\n' }, structuredClone(read));
      return entry;
    });
    const summarize = items => buildSummary(buildRows(items, 'runs'), { expectedCells: expected }).pairedTrials[0];
    assert.equal(summarize(entries).comparisons.sqz.inputTokens.count, 1);
    for (const invalidate of [
      calls => calls.splice(1, 1), calls => calls.unshift(calls.splice(1, 1)[0]),
      calls => { calls[1].resultContent = ''; }, calls => { calls[1].resultIsError = true; },
      calls => { calls[2].input.command += ' && echo extra'; },
      calls => { calls[0].resultContent += '\n' + calls[0].resultContent; },
      calls => { calls[2].input.command = 'node project/scripts/read-context.mjs src/policy.txt'; }
    ]) {
      const items = structuredClone(entries);
      invalidate(items[2].trace.turns[0].toolCalls);
      const [row] = buildRows([items[2]], 'runs');
      assert.deepEqual([row.status, row.inputTokens, row.protocolVerified, row.payloadByClass], ['PASS', 100, false, null]);
      const group = summarize(items);
      assert.deepEqual([group.successfulTriples, group.comparableTriples, group.comparisons.sqz.inputTokens.count], [1, 0, 0]);
    }
  });

  it('charges both trace files for one retried cell when summarizing a manifest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sqz-retry-traces-'));
    temporaryDirectories.push(root);
    const runs = path.join(root, 'runs');
    const output = path.join(root, 'summary');
    await mkdir(runs);
    const expectedCells = [];
    const attempts = [];
    // The twelve historical case/arm names also exercise the CLI that reads existing traces.
    for (const { caseId, arm } of fixtureRows()) {
      const key = { ...cell('alpha', 1, arm), caseId };
      expectedCells.push(key);
      const retried = caseId === 'repeat-source' && arm === 'sqz';
      for (const [i, inputTokens] of (retried ? [5, 75] : [100]).entries()) {
        const attempt = i + 1;
        const { trace } = traceEntry(key, { inputTokens, attempt, pass: !retried || attempt === 2 });
        trace.runner.startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, attempt)).toISOString();
        const file = caseId + '-' + arm + '-' + attempt + '.json';
        attempts.push({ ...key, attempt, file });
        await writeFile(path.join(runs, file), JSON.stringify(trace));
      }
    }
    const manifest = path.join(root, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ expectedCells, attempts }));
    const cli = fileURLToPath(new URL('../docs/memory-tools-research/context-dedup-ai-tester/summarize-matrix.mjs', import.meta.url));
    execFileSync(process.execPath, [cli, '--manifest', manifest, '--runs', runs, '--output', output],
      { stdio: 'pipe', timeout: 10000 });
    const { rows } = JSON.parse(await readFile(path.join(output, 'matrix-summary.json'), 'utf8'));
    const selected = rows.filter(r => r.caseId === 'repeat-source' && r.arm === 'sqz');
    assert.equal(selected.reduce((sum, r) => sum + r.inputTokens, 0), 80, 'failed attempt (5) and retry (75) were both billed');
  });

  it('isolates snapshot and platform traces and requires explicit bindings for legacy names', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sqz-trace-identity-'));
    temporaryDirectories.push(root);
    const runs = path.join(root, 'runs');
    await mkdir(runs);
    const key = cell('alpha', 1, 'sqz');
    const current = snapshotScenarioName(key);
    const legacy = 'context-dedup-alpha-short-config-r1-sqz';
    const scenarios = {
      current, previous: snapshotScenarioName({ ...key, snapshot: 'previous' }),
      foreign: snapshotScenarioName({ ...key, platform: 'win32' }), legacy
    };
    for (const [file, name] of Object.entries(scenarios)) {
      const { trace } = traceEntry(key);
      trace.scenario.name = name;
      await writeFile(path.join(runs, file + '.json'), JSON.stringify(trace));
    }
    const cli = fileURLToPath(new URL('../docs/memory-tools-research/context-dedup-ai-tester/summarize-matrix.mjs', import.meta.url));
    async function summarize(outputName, scenario, attempts) {
      const manifest = path.join(root, 'manifest.json');
      const output = path.join(root, outputName);
      await writeFile(manifest, JSON.stringify({ expectedCells: [{ ...key, scenario }], attempts }));
      execFileSync(process.execPath, [cli, '--manifest', manifest, '--runs', runs, '--output', output], { timeout: 10000 });
      return JSON.parse(await readFile(path.join(output, 'matrix-summary.json'), 'utf8'));
    }
    const scoped = await summarize('scoped', current);
    assert.deepEqual([scoped.rows.length, scoped.unboundTraceCount], [1, 3]);
    const ambiguous = await summarize('ambiguous', legacy);
    assert.equal(ambiguous.rows.length, 0);
    assert.ok(ambiguous.unboundAttempts.some(a => a.reason === 'legacy scenario requires an explicit attempt binding'));
    const attempts = [{ ...key, attempt: 1, file: 'legacy.json' }];
    const bound = await summarize('bound', legacy, attempts);
    assert.deepEqual([bound.rows[0].status, bound.unboundTraceCount], ['PASS', 3]);
    const file = path.join(runs, 'legacy.json');
    const trace = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...trace, snapshot: 'previous' }));
    const conflict = await summarize('conflict', legacy, attempts);
    assert.equal(conflict.rows[0].status, 'MISSING');
    assert.ok(conflict.unboundAttempts.some(a => a.reason === 'trace conflicts with manifest'));
  });

  it('compares matched triples per profile and accounts for retries, missing cells, duplicates and failures', () => {
    const expectedCells = [];
    const entries = [];
    function addRepeat(profile, repeat, tokens) {
      for (const [i, arm] of ['baseline', 'aifhub', 'sqz'].entries()) {
        const key = cell(profile, repeat, arm);
        expectedCells.push(key);
        if (tokens[i] !== null) entries.push(traceEntry(key, { inputTokens: tokens[i] }));
      }
    }
    // alpha: first SQZ cell spends 5 on its failed attempt and 75 on its retry.
    // Signed baseline-minus-SQZ input deltas are 110-80, 50-70, 200-190.
    addRepeat('alpha', 1, [110, 95, 5]);
    entries.at(-1).trace.scoring.overallPass = false;
    entries.at(-1).trace.turns = []; // The billed first attempt stopped before the required read.
    delete entries.at(-1).trace.cost.outputTokens;
    entries.push(traceEntry(cell('alpha', 1, 'sqz'), { inputTokens: 75, attempt: 2 }));
    addRepeat('alpha', 2, [50, 55, 70]);
    addRepeat('alpha', 3, [200, 195, 190]);
    addRepeat('alpha', 4, [20, 25, null]);
    addRepeat('alpha', 5, [30, 28, 22]);
    const duplicate = traceEntry(cell('alpha', 5, 'sqz'), { inputTokens: 22 });
    entries.push({ ...duplicate, file: path.join('runs', 'duplicate.json') });
    addRepeat('alpha', 6, [60, 50, 13]);
    entries.at(-1).trace.runner.exitCode = 7;
    // beta reuses the same case and repeat identifiers but has independent observations.
    addRepeat('beta', 1, [12, 7, 3]);
    addRepeat('beta', 2, [20, 17, 8]);
    addRepeat('beta', 3, [15, 14, 9]);

    const rows = buildRows(entries, 'runs');
    const { pairedTrials } = buildSummary(rows, { expectedCells });
    assert.ok(Array.isArray(pairedTrials), 'summary must expose paired comparisons for the planned cells');
    assert.equal(pairedTrials.length, 2);
    const alpha = pairedTrials.find(group => group.profile === 'alpha');
    const beta = pairedTrials.find(group => group.profile === 'beta');
    assert.deepEqual([alpha.expectedTriples, alpha.successfulTriples], [6, 3]);
    assert.deepEqual([alpha.missingCells, alpha.duplicateCells, alpha.failedCells, alpha.retries], [1, 1, 1, 1]);
    assert.equal(alpha.failedAttemptInputTokens, 18); // 5 on retry + 13 on the unsuccessful cell
    assert.equal(alpha.comparableTriples, 3);
    assert.equal(alpha.comparisons.sqz.outputTokens.count, 2, 'the retry cannot supply missing usage for its first attempt');
    const stats = group => {
      const { count, median, min, max } = group.comparisons.sqz.inputTokens;
      return [count, median, min, max];
    };
    assert.deepEqual(stats(alpha), [3, 10, -20, 30]);
    assert.deepEqual([beta.expectedTriples, beta.successfulTriples, ...stats(beta)], [3, 3, 3, 9, 6, 12]);
  });
});

describe('AI Tester issue #133 matrix summary', () => {
  it('normalizes unchanged compressed markers and assigns disjoint payload classes', () => {
    const trace = {
      turns: [{
        toolCalls: [{
          resultContent: [
            '[dedup-metric] arm=sqz phase=read decision=compressed inputBytes=12 outputBytes=12 savedBytes=0',
            '[dedup-metric] arm=sqz phase=read decision=delta inputBytes=12 outputBytes=5 savedBytes=7'
          ].join('\n')
        }]
      }]
    };

    assert.deepEqual(metrics(trace).map(({ decision, readIndex }) => ({ decision, readIndex })), [
      { decision: 'full', readIndex: 0 },
      { decision: 'delta', readIndex: 1 }
    ]);
    assert.equal(classifyPayload('changed-source', 0), 'firstRead');
    assert.equal(classifyPayload('changed-source', 1), 'changed');
    assert.equal(classifyPayload('repeat-source', 1), 'exactRepeat');
    assert.equal(classifyPayload('protected-openspec', 0), 'protected');
    assert.equal(classifyPayload('fresh-session-preseeded-cache', 0), 'freshSession');
  });

  it('reports raw, category, correctness-adjusted, and fair exact-repeat metrics', () => {
    const summary = buildSummary(fixtureRows());
    const baseline = byArm(summary.aggregates, 'baseline');
    const aifhub = byArm(summary.aggregates, 'aifhub');
    const sqz = byArm(summary.aggregates, 'sqz');

    assert.deepEqual(
      [baseline.inputBytes, baseline.outputBytes, baseline.savedPercent, baseline.passed],
      [105260, 105260, 0, 4]
    );
    assert.deepEqual(
      [aifhub.inputBytes, aifhub.outputBytes, aifhub.savedBytes, aifhub.savedPercent, aifhub.passed],
      [105260, 91099, 14161, 13.45, 4]
    );
    assert.deepEqual(
      [sqz.inputBytes, sqz.outputBytes, sqz.savedBytes, sqz.savedPercent, sqz.passed],
      [105260, 54081, 51179, 48.62, 4]
    );

    assert.deepEqual(
      [aifhub.payloadByClass.exactRepeat.inputBytes, aifhub.payloadByClass.exactRepeat.savedBytes],
      [14342, 14161]
    );
    assert.deepEqual(
      [sqz.payloadByClass.firstRead.inputBytes, sqz.payloadByClass.firstRead.savedBytes],
      [31015, 22296]
    );
    assert.equal(
      Object.values(sqz.payloadByClass).reduce((sum, value) => sum + value.inputBytes, 0),
      sqz.inputBytes
    );

    assert.deepEqual(
      [byArm(summary.comparisonViews.correctnessAdjusted, 'sqz').outputBytes,
        byArm(summary.comparisonViews.correctnessAdjusted, 'sqz').savedBytes,
        byArm(summary.comparisonViews.correctnessAdjusted, 'sqz').savedPercent],
      [54081, 51179, 48.62]
    );
    assert.deepEqual(
      [byArm(summary.comparisonViews.policyAndCorrectnessAdjusted, 'sqz').outputBytes,
        byArm(summary.comparisonViews.policyAndCorrectnessAdjusted, 'sqz').savedBytes,
        byArm(summary.comparisonViews.policyAndCorrectnessAdjusted, 'sqz').savedPercent],
      [54081, 51179, 48.62]
    );
    assert.deepEqual(
      [byArm(summary.comparisonViews.exactRepeatOnly, 'aifhub').savedPercent,
        byArm(summary.comparisonViews.exactRepeatOnly, 'sqz').savedPercent],
      [98.74, 98.74]
    );
    assert.deepEqual(
      [byArm(summary.comparisonViews.fairTwoReadExactRepeat, 'aifhub').savedPercent,
        byArm(summary.comparisonViews.fairTwoReadExactRepeat, 'sqz').savedPercent],
      [49.37, 49.37]
    );
  });

  it('refuses to overwrite an existing historical summary', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aifhub-matrix-summary-'));
    temporaryDirectories.push(directory);
    const target = path.join(directory, 'matrix-summary.json');

    await writeSummaryExclusive(target, { schemaVersion: 2 });
    await assert.rejects(
      writeSummaryExclusive(target, { schemaVersion: 3 }),
      (error) => error?.code === 'EEXIST'
    );
  });
});
