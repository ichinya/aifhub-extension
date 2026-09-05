import fs from 'node:fs';
import assert from 'node:assert/strict';

const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const overview = rows => ({ runs: rows.length, passed: rows.filter(x => x.pass).length,
  input: sum(rows, 'input'), output: sum(rows, 'output'), cacheRead: sum(rows, 'cacheRead'),
  cacheWrite: sum(rows, 'cacheWrite'), totalTokens: sum(rows, 'totalTokens'),
  elapsedMs: sum(rows, 'elapsedMs'), toolBytes: sum(rows, 'toolBytes'), commandBytes: sum(rows, 'commandBytes'),
  toolCalls: sum(rows, 'toolCalls'), rtkCalls: sum(rows, 'rtkCalls'), rawCalls: sum(rows, 'rawCalls'),
  reportedCost: sum(rows, 'reportedCost'), jsonOnly: rows.filter(x => x.jsonOnly).length });
if (process.argv[4]) {
  const retries = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  const originals = result.rows;
  const key = row => `${row.scenario}/${row.repetition}/${row.arm}`;
  const replacements = new Map(retries.rows.map(row => [key(row), row]));
  const excluded = originals.filter(row => replacements.has(key(row)));
  assert.equal(excluded.length, replacements.size, 'retry has no original row');
  assert(excluded.every(row => row.processExit !== 0), 'refusing to replace a completed semantic failure');
  assert(excluded.every(row => !row.checks.validJson), 'refusing to replace a structured completed answer');
  for (const row of excluded) assert(replacements.has(`${row.scenario}/${row.repetition}/${row.arm === 'rtk' ? 'baseline' : 'rtk'}`), 'retry must replace the entire pair');
  result.initialMatrix = { baseline: overview(originals.filter(x => x.arm === 'baseline')), rtk: overview(originals.filter(x => x.arm === 'rtk')) };
  result.excludedIncompleteAttempts = excluded;
  result.supplementaryRepeats = { reason: retries.reason, controllerSha256: retries.controllerSha256, count: retries.rows.length };
  result.executionTotals = overview([...originals, ...retries.rows]);
  result.rows = originals.map(row => replacements.get(key(row)) || row);
}
const keys = new Set();
for (const row of result.rows) {
  const key = `${row.scenario}/${row.repetition}/${row.arm}`;
  assert(!keys.has(key), 'duplicate run'); keys.add(key);
  assert.equal(row.totalTokens, row.input + row.output + row.cacheRead + row.cacheWrite, 'usage accounting mismatch');
  assert(row.messages > 0 && row.totalTokens > 0, 'missing usage');
  assert.equal(row.model.provider, result.model.provider);
  assert.equal(row.model.id, result.model.id);
}
const baseline = result.rows.filter(x => x.arm === 'baseline'), candidate = result.rows.filter(x => x.arm === 'rtk');
assert.equal(baseline.length, candidate.length);
assert.equal(result.rows.length, 4 * 2 * result.repetitions);
const pairs = baseline.map(a => {
  const b = candidate.find(b => b.scenario === a.scenario && b.repetition === a.repetition);
  assert(b && a.promptHash === b.promptHash, 'missing or unequal pair');
  return { scenario: a.scenario, repetition: a.repetition, baselinePass: a.pass, rtkPass: b.pass,
    tokenReductionPercent: (1 - b.totalTokens / a.totalTokens) * 100, rtkExposed: b.rtkCalls > 0 };
});
const a = overview(baseline), b = overview(candidate);
const sortedReductions = pairs.map(x => x.tokenReductionPercent).sort((a, b) => a - b);
const largestBaseline = baseline.reduce((a, b) => a.totalTokens > b.totalTokens ? a : b);
const largestPartner = candidate.find(x => x.scenario === largestBaseline.scenario && x.repetition === largestBaseline.repetition);
const summary = { baseline: a, rtk: b, tokenReductionPercent: (1 - b.totalTokens / a.totalTokens) * 100,
  elapsedIncreasePercent: (b.elapsedMs / a.elapsedMs - 1) * 100,
  toolByteReductionPercent: (1 - b.toolBytes / a.toolBytes) * 100,
  sensitivity: { medianPairTokenReductionPercent: (sortedReductions[Math.floor((sortedReductions.length - 1) / 2)] + sortedReductions[Math.floor(sortedReductions.length / 2)]) / 2,
    largestBaselinePair: { scenario: largestBaseline.scenario, repetition: largestBaseline.repetition },
    tokenReductionWithoutLargestBaselinePairPercent: (1 - (b.totalTokens - largestPartner.totalTokens) / (a.totalTokens - largestBaseline.totalTokens)) * 100 },
  pairs: { total: pairs.length, bothPass: pairs.filter(x => x.baselinePass && x.rtkPass).length,
    baselineOnlyPass: pairs.filter(x => x.baselinePass && !x.rtkPass).length,
    rtkOnlyPass: pairs.filter(x => !x.baselinePass && x.rtkPass).length,
    neitherPass: pairs.filter(x => !x.baselinePass && !x.rtkPass).length,
    rtkExposed: pairs.filter(x => x.rtkExposed).length,
    fewerTokens: pairs.filter(x => x.tokenReductionPercent > 0).length },
  scenarios: [...new Set(result.rows.map(x => x.scenario))].map(scenario => ({ scenario,
    baseline: overview(baseline.filter(x => x.scenario === scenario)), rtk: overview(candidate.filter(x => x.scenario === scenario)) })) };
summary.qualityCriterionMet = result.rows.every(x => x.pass && x.processExit === 0 && x.aiTesterErrors === 0) && pairs.every(x => x.rtkExposed);
summary.benefitCriterionMet = summary.tokenReductionPercent >= 15 && summary.elapsedIncreasePercent <= 10;
summary.decision = summary.qualityCriterionMet && summary.benefitCriterionMet ? 'bounded_benchmark_positive_privacy_blockers_remain' : 'reject_defer';
result.summary = summary;
result.pairs = pairs;
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
