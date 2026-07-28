// context-dedup-ai-tester-summary.test.mjs - regression coverage for issue #133 matrix accounting
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
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
