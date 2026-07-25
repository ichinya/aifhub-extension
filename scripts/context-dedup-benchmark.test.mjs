// context-dedup-benchmark.test.mjs - tests for the deterministic three-way dedup replay benchmark
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BENCHMARK_MODES, defaultTrace, main, normalizeTrace, runBenchmark } from './context-dedup-benchmark.mjs';

function collect() {
  const chunks = [];
  return { write: (value) => chunks.push(value), text: () => chunks.join('') };
}

describe('context dedup benchmark', () => {
  it('exposes the three comparison modes', () => {
    assert.deepEqual(BENCHMARK_MODES, ['baseline', 'variant-a', 'external']);
  });

  it('rejects traces that reference unknown files or revisions', () => {
    assert.throws(() => normalizeTrace({ files: [], reads: [{ path: 'missing.ts' }] }), /unknown file/);
    assert.throws(
      () => normalizeTrace({ files: [{ path: 'a.ts', revisions: ['x'] }], reads: [{ path: 'a.ts', revision: 3 }] }),
      /unknown revision/
    );
  });

  it('emits every byte in baseline mode', async () => {
    const result = await runBenchmark({ mode: 'baseline' });

    assert.equal(result.reads, defaultTrace().reads.length);
    assert.equal(result.savedBytes, 0);
    assert.equal(result.emittedBytes, result.baselineBytes);
    assert.equal(result.correctness.changedContentAlwaysServed, true);
  });

  it('saves bytes in variant-a mode without touching protected artifacts or changed content', async () => {
    const result = await runBenchmark({ mode: 'variant-a' });

    assert.ok(result.savedBytes > 0, 'variant-a must save bytes on repeated reads');
    assert.ok(result.dedupHits > 0);
    assert.equal(result.correctness.changedContentAlwaysServed, true);
    assert.equal(result.correctness.protectedArtifactsAlwaysServed, true);
    assert.equal(result.correctness.protectedReadsDeduplicated, 0);
    assert.equal(result.estimatedSavedTokens, Math.ceil(result.savedBytes / 4));
  });

  it('falls back to full content when the external command is unusable', async () => {
    const result = await runBenchmark({ mode: 'external', externalCommand: 'aifhub-nonexistent-dedup-binary' });

    assert.equal(result.savedBytes, 0);
    assert.equal(result.emittedBytes, result.baselineBytes);
    assert.ok(result.steps.every((step) => step.decision === 'external-error' || step.decision === 'external-passthrough'));
  });

  it('requires an external command in external mode', async () => {
    await assert.rejects(runBenchmark({ mode: 'external' }), /--external-command/);
  });

  it('renders a comparison table and json report from the CLI', async () => {
    const table = collect();
    assert.equal(await main([], { stdout: table, stderr: collect() }), 0);
    assert.match(table.text(), /\| baseline \|/);
    assert.match(table.text(), /\| variant-a \|/);

    const json = collect();
    assert.equal(await main(['--mode', 'variant-a', '--json'], { stdout: json, stderr: collect() }), 0);
    const report = JSON.parse(json.text());
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].mode, 'variant-a');
    assert.equal(report.results[0].steps, undefined);
  });

  it('fails on an unknown mode', async () => {
    const stderr = collect();
    assert.equal(await main(['--mode', 'turbo'], { stdout: collect(), stderr }), 1);
    assert.match(stderr.text(), /Unknown mode/);
  });
});
