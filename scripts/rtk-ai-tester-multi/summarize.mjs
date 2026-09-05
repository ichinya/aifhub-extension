import fs from 'node:fs';
import assert from 'node:assert/strict';

const matrix = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sum = (rows, key) => rows.reduce((n, row) => n + (row[key] || 0), 0);
const totals = rows => ({ attempts: rows.length, passed: rows.filter(x => x.pass).length,
  input: sum(rows, 'input'), output: sum(rows, 'output'), cacheRead: sum(rows, 'cacheRead'), cacheWrite: sum(rows, 'cacheWrite'),
  totalTokens: sum(rows, 'totalTokens'), elapsedMs: sum(rows, 'elapsedMs'), commandBytes: sum(rows, 'commandBytes'), toolBytes: sum(rows, 'toolBytes'),
  toolCalls: sum(rows, 'toolCalls'), rtkCalls: sum(rows, 'rtkCalls'), rawCalls: sum(rows, 'rawCalls'), protocolBlocks: sum(rows, 'protocolBlocks') });
const original = matrix.rows;
let selected = original;
if (process.argv[4]) {
  const retries = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  const key = x => `${x.scenario}/${x.repetition}/${x.arm}`;
  const map = new Map(retries.rows.map(x => [key(x), x]));
  const replaced = original.filter(x => map.has(key(x)));
  assert.equal(replaced.length, map.size);
  for (const r of replaced) {
    const other = `${r.scenario}/${r.repetition}/${r.arm === 'rtk' ? 'baseline' : 'rtk'}`;
    assert(map.has(other), 'Only entire pairs may be repeated');
    const pair = replaced.filter(x => x.scenario === r.scenario && x.repetition === r.repetition);
    assert(pair.some(x => !x.checks.structuredAnswer || x.modelErrors > 0 || x.aiTesterErrors !== 0), 'Refusing quality-based retry');
  }
  selected = original.map(x => map.get(key(x)) || x);
  matrix.originalAttempts = original;
  matrix.repeatedPairs = { attempts: retries.rows, provenance: retries.provenance };
  matrix.executionTotals = totals([...original, ...retries.rows]);
}
matrix.rows = selected;
const a = selected.filter(x => x.arm === 'baseline'), b = selected.filter(x => x.arm === 'rtk');
assert.equal(a.length, b.length);
const pairs = a.map(x => {
  const y = b.find(y => y.scenario === x.scenario && y.repetition === x.repetition);
  assert(y && x.promptHash === y.promptHash, 'Missing or unequal pair');
  const usable = [x, y].every(r => r.checks.structuredAnswer && r.messages > 0 && r.totalTokens > 0 && r.modelErrors === 0 && r.aiTesterErrors === 0);
  return { scenario: x.scenario, repetition: x.repetition, baselinePass: x.pass, rtkPass: y.pass, usable,
    rtkExposed: y.rtkCalls > 0, tokenReductionPercent: x.totalTokens > 0 ? (1 - y.totalTokens / x.totalTokens) * 100 : null };
});
for (const r of selected) assert.equal(r.totalTokens, r.input + r.output + r.cacheRead + r.cacheWrite);
const use = row => pairs.some(p => p.usable && p.scenario === row.scenario && p.repetition === row.repetition);
const aa = a.filter(use), bb = b.filter(use), at = totals(aa), bt = totals(bb);
const reductions = pairs.filter(x => x.usable).map(x => x.tokenReductionPercent).sort((a, b) => a - b);
const median = reductions.length ? (reductions[Math.floor((reductions.length - 1) / 2)] + reductions[Math.floor(reductions.length / 2)]) / 2 : null;
const summary = { selectedAttempts: selected.length, allSelected: { baseline: totals(a), rtk: totals(b) },
  usablePairs: pairs.filter(x => x.usable).length, rtkExposedPairs: pairs.filter(x => x.usable && x.rtkExposed).length,
  baseline: at, rtk: bt, tokenReductionPercent: (1 - bt.totalTokens / at.totalTokens) * 100,
  elapsedIncreasePercent: (bt.elapsedMs / at.elapsedMs - 1) * 100,
  toolByteReductionPercent: (1 - bt.toolBytes / at.toolBytes) * 100,
  medianPairTokenReductionPercent: median,
  scenarios: [...new Set(selected.map(x => x.scenario))].map(scenario => ({ scenario, baseline: totals(aa.filter(x => x.scenario === scenario)), rtk: totals(bb.filter(x => x.scenario === scenario)) })) };
if (aa.length) {
  const largest = aa.reduce((a, b) => a.totalTokens > b.totalTokens ? a : b);
  const partner = bb.find(x => x.scenario === largest.scenario && x.repetition === largest.repetition);
  summary.largestBaselinePair = { scenario: largest.scenario, repetition: largest.repetition };
  summary.tokenReductionWithoutLargestBaselinePairPercent = (1 - (bt.totalTokens - partner.totalTokens) / (at.totalTokens - largest.totalTokens)) * 100;
}
summary.qualityCriterionMet = pairs.length === 12 && pairs.every(x => x.usable && x.rtkExposed && x.baselinePass && x.rtkPass);
summary.benefitCriterionMet = summary.tokenReductionPercent >= 15 && summary.elapsedIncreasePercent <= 10 && median > 0;
summary.decision = summary.qualityCriterionMet && summary.benefitCriterionMet ? 'bounded_positive_privacy_blockers_remain' : 'reject_defer';
matrix.pairs = pairs; matrix.summary = summary;
fs.writeFileSync(process.argv[3], JSON.stringify(matrix, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
