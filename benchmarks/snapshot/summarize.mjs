import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function distribution(values) {
  if (!values.length) return { median: null, iqr: null, samples: [] };
  if (values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('invalid-sample');
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = p => { const index = (sorted.length - 1) * p, low = Math.floor(index); return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low); };
  return { median: quantile(0.5), iqr: quantile(0.75) - quantile(0.25), samples: values };
}
export function aggregateStatus(rows) {
  return rows.some(r => r.status === 'FAIL') ? 'FAIL' : !rows.length || rows.some(r => r.status !== 'PASS') ? 'NOTRUN' : 'PASS';
}
export function summarize(rows, armNames) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.scenario}/${row.profile}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].map(([key, group]) => {
    const status = aggregateStatus(group);
    const arms = Object.fromEntries(armNames.map(name => {
      const selected = group.filter(r => r.arm === name);
      return [name, { status: aggregateStatus(selected), pass: selected.filter(r => r.status === 'PASS').length,
        fail: selected.filter(r => r.status === 'FAIL').length, notrun: selected.filter(r => r.status === 'NOTRUN').length,
        latency_ms: distribution(selected.filter(r => r.status === 'PASS' && r.wall_ms !== null).map(r => r.wall_ms)) }];
    }));
    const first = group.filter(r => r.arm === armNames[0]), second = group.filter(r => r.arm === armNames[1]);
    const complete = first.length > 0 && first.length === second.length;
    const equivalence = complete && first.every(a => second.some(b => b.repeat === a.repeat && b.fixture_digest === a.fixture_digest
      && b.semantic_digest === a.semantic_digest && a.expected === true && b.expected === true && a.unchanged === true && b.unchanged === true));
    const ratios = equivalence && status === 'PASS' ? first.flatMap(a => {
      const b = second.find(b => b.repeat === a.repeat);
      return a.wall_ms !== null && b.wall_ms > 0 ? [a.wall_ms / b.wall_ms] : [];
    }) : [];
    return { key, status: status === 'PASS' && !equivalence ? 'FAIL' : status, equivalence,
      safety: status === 'PASS' && equivalence ? 'PASS' : status === 'NOTRUN' ? 'UNKNOWN' : 'FAIL',
      arms, paired_speedup: distribution(ratios), uncertainty: 'IQR of paired ratios; no statistical significance claim', no_promote: true };
  });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  console.log(JSON.stringify(summarize(result.rows, result.arms.map(a => a.name)), null, 2));
}
