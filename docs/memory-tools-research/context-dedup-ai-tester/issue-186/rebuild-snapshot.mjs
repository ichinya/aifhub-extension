// node rebuild-snapshot.mjs <observations.json> <new aggregate.json>
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4) {
  throw new Error('Usage: node rebuild-snapshot.mjs <observations.json> <new aggregate.json>');
}
const source = JSON.parse(await readFile(input, 'utf8'));
assert.equal(source.schemaVersion, 1);
const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
const moneyFields = ['reportedUsd', 'estimatedUsd', 'billedUsd'];
const fields = [...tokenFields, ...moneyFields, 'turns', 'toolCalls', 'readCalls', 'repeatReads',
  'elapsedMs', 'inputBytes', 'outputBytes', 'netBytes', 'readResultTextBytes'];
const usageFields = new Set([...tokenFields, ...moneyFields]);
const arms = ['off', 'aifhub', 'sqz'];
const key = (c, n, arm) => JSON.stringify([c, n, arm]);

function distribution(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const n = sorted.length;
  return { n, median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    min: sorted[0] ?? null, max: sorted.at(-1) ?? null };
}

function knownSpend(failed) {
  return Object.fromEntries([...tokenFields, ...moneyFields].map(field => {
    const known = failed.map(r => r.metrics?.[field]).filter(Number.isFinite);
    const complete = failed.filter(r => r.usageComplete && Number.isFinite(r.metrics?.[field])).length;
    return [field, { reportedAttempts: known.length, completeAttempts: complete,
      reportedSubtotal: known.length ? known.reduce((a, b) => a + b, 0) : null,
      total: complete === failed.length && failed.length ? known.reduce((a, b) => a + b, 0) : null }];
  }));
}

function classTotals(rows) {
  const measured = rows.filter(row => row.readClasses);
  if (!measured.length) return null;
  const sums = {};
  for (const name of Object.keys(measured[0].readClasses)) {
    let reads = 0, inputBytes = 0, outputBytes = 0;
    for (const row of measured) {
      const [n, input, output] = row.readClasses[name];
      reads += n;
      inputBytes += input;
      outputBytes += output;
    }
    sums[name] = { reads, inputBytes, outputBytes, netBytes: inputBytes - outputBytes };
  }
  return { measuredCells: measured.length, plannedCells: rows.length, sums };
}

function summarize(profile) {
  const cells = new Map();
  for (const row of profile.rows) {
    assert.ok(profile.cases.includes(row.caseId) && arms.includes(row.arm));
    assert.ok(Number.isInteger(row.repeat) && row.repeat >= 1 && row.repeat <= profile.repeats);
    assert.ok(['PASS', 'FAIL', 'ERROR', 'BLOCKED', 'NOT_RUN'].includes(row.status));
    const id = key(row.caseId, row.repeat, row.arm);
    assert.ok(!cells.has(id), 'Duplicate cell');
    cells.set(id, row);
  }
  const planned = profile.cases.length * profile.repeats * arms.length;
  assert.equal(cells.size, planned, 'Incomplete manifest');
  const outcomes = Object.fromEntries(['PASS', 'FAIL', 'ERROR', 'BLOCKED', 'NOT_RUN'].map(status =>
    [status, profile.rows.filter(r => r.status === status).length]));
  const failed = profile.rows.filter(r => ['FAIL', 'ERROR'].includes(r.status));
  const byCase = profile.cases.map(caseId => {
    const successful = [], comparable = [], excluded = [];
    for (let repeat = 1; repeat <= profile.repeats; repeat++) {
      const triple = arms.map(arm => cells.get(key(caseId, repeat, arm)));
      if (!triple.every(r => r.status === 'PASS')) {
        excluded.push({ repeat, reason: 'outcome', arms: triple.filter(r => r.status !== 'PASS').map(r => [r.arm, r.status]) });
        continue;
      }
      successful.push(repeat);
      if (triple.every(r => r.protocolVerified === true)) comparable.push(triple);
      else excluded.push({ repeat, reason: 'protocol', arms: triple.filter(r => r.protocolVerified !== true).map(r => r.arm) });
    }
    const comparisons = {};
    if (comparable.length) {
      for (const [i, variant] of arms.entries()) {
        if (i === 0) continue;
        comparisons[variant] = Object.fromEntries(fields.map(field => {
          const deltas = [];
          for (const triple of comparable) {
            const pair = [triple[0], triple[i]];
            if (usageFields.has(field) && !pair.every(r => r.usageComplete)) continue;
            if (field === 'elapsedMs' && pair.some(r => r.setupRetries)) continue;
            if (pair.every(r => Number.isFinite(r.metrics[field]))) deltas.push(pair[0].metrics[field] - pair[1].metrics[field]);
          }
          return [field, distribution(deltas)];
        }));
      }
    }
    const readClasses = Object.fromEntries(arms.map(arm => [arm,
      classTotals(profile.rows.filter(r => r.caseId === caseId && r.arm === arm))]));
    return { caseId, plannedTriples: profile.repeats, successful, comparable: comparable.map(([r]) => r.repeat), excluded, comparisons, readClasses };
  });
  return { id: profile.id, platform: profile.platform, planned, attempted: outcomes.PASS + failed.length, outcomes,
    setupRetries: profile.rows.reduce((n, r) => n + (r.setupRetries ?? 0), 0),
    failedSpend: failed.length ? knownSpend(failed) : null, byCase };
}

assert.equal(new Set(source.profiles.map(p => JSON.stringify([p.platform, p.id]))).size, source.profiles.length);
const result = { schemaVersion: 1, snapshot: source.snapshot, profiles: source.profiles.map(summarize) };
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
