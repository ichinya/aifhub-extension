// context-dedup-benchmark.test.mjs - tests for the deterministic three-way dedup replay benchmark
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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

  it('rejects absolute and traversal paths before materializing a trace', () => {
    for (const unsafePath of [
      '../outside.ts',
      '/absolute.ts',
      'C:\\outside.ts',
      'docs/../../outside.ts',
      'src/NUL.txt',
      'src/file.txt:secret',
      'src/trailing.',
      'src/trailing '
    ]) {
      assert.throws(
        () => normalizeTrace({ files: [{ path: unsafePath, revisions: ['x'] }], reads: [{ path: unsafePath }] }),
        /safe project-relative path/
      );
    }
  });

  it('rejects case-insensitive duplicate trace paths on every host platform', () => {
    assert.throws(
      () => normalizeTrace({
        files: [
          { path: 'src/Auth.ts', revisions: ['first'] },
          { path: 'src/auth.ts', revisions: ['second'] }
        ],
        reads: []
      }),
      /duplicate file path/
    );
  });

  it('emits every byte in baseline mode', async () => {
    const result = await runBenchmark({ mode: 'baseline' });

    assert.equal(result.reads, defaultTrace().reads.length);
    assert.equal(result.savedBytes, 0);
    assert.equal(result.emittedBytes, result.baselineBytes);
    assert.equal(result.correctness.changedContentAlwaysServed, true);
  });

  it('writes the disabled benchmark mode as an unambiguous YAML string', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aifhub-benchmark-config-'));
    let generatedConfig;

    try {
      await runBenchmark({
        mode: 'baseline',
        workspace,
        emit: () => {
          if (generatedConfig !== undefined) return;
          const nestedWorkspace = readdirSync(workspace, { withFileTypes: true })
            .find((entry) => entry.isDirectory() && entry.name.startsWith('aifhub-dedup-bench-'));
          generatedConfig = readFileSync(
            path.join(workspace, nestedWorkspace.name, '.ai-factory', 'config.yaml'),
            'utf8'
          );
        }
      });

      assert.match(generatedConfig, /^\s*mode:\s+"off"\s*$/m);
      assert.doesNotMatch(generatedConfig, /^\s*mode:\s+off(?:\s+#.*)?$/m);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('saves bytes in variant-a mode without touching protected artifacts or changed content', async () => {
    const result = await runBenchmark({ mode: 'variant-a' });

    assert.ok(result.savedBytes > 0, 'variant-a must save bytes on repeated reads');
    assert.ok(result.dedupHits > 0);
    assert.equal(result.correctness.changedContentAlwaysServed, true);
    assert.equal(result.correctness.protectedArtifactsAlwaysServed, true);
    assert.equal(result.correctness.protectedReadsDeduplicated, 0);
    assert.equal(result.correctness.protectedReadsTransformed, 0);
    assert.equal(result.estimatedSavedTokens, Math.ceil(result.savedBytes / 4));
    assert.equal(result.payloadByClass.exactRepeat.reads, 3);
    assert.equal(result.payloadByClass.exactRepeat.savedBytes, result.savedBytes);
    assert.ok(result.payloadByClass.exactRepeat.savedPercent > 95);
    assert.equal(result.payloadByClass.firstRead.savedBytes, 0);
    assert.equal(result.payloadByClass.changed.savedBytes, 0);
    assert.equal(result.payloadByClass.protected.savedBytes, 0);
    assert.equal(result.payloadByClass.belowThreshold.savedBytes, 0);
    assert.equal(
      Object.values(result.payloadByClass).reduce((sum, entry) => sum + entry.inputBytes, 0),
      result.baselineBytes
    );
  });

  it('falls back to full content when the external command is unusable', async () => {
    const result = await runBenchmark({ mode: 'external', externalCommand: 'aifhub-nonexistent-dedup-binary' });

    assert.equal(result.savedBytes, 0);
    assert.equal(result.emittedBytes, result.baselineBytes);
    assert.ok(result.steps.every((step) => step.decision === 'external-error' || step.decision === 'external-passthrough'));
  });

  it('uses a nested temporary workspace and never overwrites a supplied directory', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aifhub-benchmark-parent-'));
    const configPath = path.join(workspace, '.ai-factory', 'config.yaml');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, 'sentinel: keep\n', 'utf8');

    try {
      await runBenchmark({ mode: 'variant-a', workspace });
      assert.equal(await readFile(configPath, 'utf8'), 'sentinel: keep\n');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('supports raw sqz output and counts only reference markers as dedup hits', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'aifhub-benchmark-sqz-'));
    const adapter = path.join(fixture, 'adapter.mjs');
    await writeFile(
      adapter,
      [
        "let input = '';",
        "for await (const chunk of process.stdin) input += chunk;",
        "process.stdout.write(input.includes('session-v1') ? '§ref:0123456789abcdef§' : input);"
      ].join('\n'),
      'utf8'
    );

    try {
      const result = await runBenchmark({
        mode: 'external',
        externalCommand: [process.execPath, adapter],
        externalProtocol: 'sqz-text'
      });
      assert.ok(result.dedupHits > 0);
      assert.ok(result.transformedReads >= result.dedupHits);
      assert.ok(result.savedBytesByKind.reference > 0);
      assert.ok(result.steps.some((step) => step.decision === 'external-reference'));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('decodes a sqz marker split across UTF-8 output chunks', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'aifhub-benchmark-utf8-'));
    const adapter = path.join(fixture, 'adapter.mjs');
    await writeFile(
      adapter,
      [
        "const marker = Buffer.from('§ref:0123456789abcdef§', 'utf8');",
        'process.stdin.resume();',
        "process.stdin.on('end', () => {",
        '  process.stdout.write(marker.subarray(0, 1));',
        '  setTimeout(() => process.stdout.write(marker.subarray(1)), 10);',
        '});'
      ].join('\n'),
      'utf8'
    );

    try {
      const result = await runBenchmark({
        mode: 'external',
        externalCommand: [process.execPath, adapter],
        externalProtocol: 'sqz-text'
      });
      assert.equal(result.dedupHits, result.reads);
      assert.ok(result.steps.every((step) => step.deliveryKind === 'reference'));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('times out an external command and fails open with full content', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'aifhub-benchmark-timeout-'));
    const adapter = path.join(fixture, 'adapter.mjs');
    await writeFile(adapter, "setTimeout(() => process.stdout.write('late'), 10_000);\n", 'utf8');

    try {
      const result = await runBenchmark({
        mode: 'external',
        externalCommand: [process.execPath, adapter],
        externalProtocol: 'sqz-text',
        externalTimeoutMs: 25
      });
      assert.equal(result.savedBytes, 0);
      assert.ok(result.steps.every((step) => step.decision === 'external-timeout'));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('kills the external process tree after timeout', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'aifhub-benchmark-tree-'));
    const marker = path.join(fixture, 'descendant-survived.txt');
    const worker = path.join(fixture, 'worker.mjs');
    const adapter = path.join(fixture, 'adapter.mjs');
    await writeFile(
      worker,
      `import { writeFile } from 'node:fs/promises';\nsetTimeout(() => writeFile(${JSON.stringify(marker)}, 'survived'), 500);\n`,
      'utf8'
    );
    await writeFile(
      adapter,
      [
        "import { spawn } from 'node:child_process';",
        `spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: 'ignore', windowsHide: true });`,
        'setInterval(() => {}, 1000);'
      ].join('\n'),
      'utf8'
    );
    const trace = {
      name: 'process-tree-timeout',
      files: [{ path: 'one.txt', revisions: ['one'] }],
      reads: [{ path: 'one.txt', revision: 0 }]
    };

    try {
      const result = await runBenchmark({
        mode: 'external',
        trace,
        externalCommand: [process.execPath, adapter],
        externalTimeoutMs: 50
      });
      assert.equal(result.steps[0].decision, 'external-timeout');
      await delay(800);
      await assert.rejects(readFile(marker), /ENOENT/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('fails open when external output exceeds the cap', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'aifhub-benchmark-output-'));
    const adapter = path.join(fixture, 'adapter.mjs');
    await writeFile(adapter, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('x'.repeat(9 * 1024 * 1024)));\n", 'utf8');
    const trace = {
      name: 'output-limit',
      files: [{ path: 'one.txt', revisions: ['one'] }],
      reads: [{ path: 'one.txt', revision: 0 }]
    };

    try {
      const result = await runBenchmark({
        mode: 'external',
        trace,
        externalCommand: [process.execPath, adapter]
      });
      assert.equal(result.steps[0].decision, 'external-output-limit');
      assert.equal(result.emittedBytes, result.baselineBytes);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('passes repeated CLI arguments to an adapter without a shell', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'aifhub-benchmark-args-'));
    const adapter = path.join(fixture, 'adapter.mjs');
    const tracePath = path.join(fixture, 'trace.json');
    await writeFile(
      adapter,
      [
        "if (process.argv[2] !== '--store' || process.argv[3] !== '.external-home/sessions.db') process.exit(9);",
        "let input = '';",
        "for await (const chunk of process.stdin) input += chunk;",
        'process.stdout.write(input);'
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      tracePath,
      JSON.stringify({
        name: 'cli-external-args',
        files: [{ path: 'one.txt', revisions: ['one'] }],
        reads: [{ path: 'one.txt', revision: 0 }]
      }),
      'utf8'
    );

    try {
      const stdout = collect();
      const stderr = collect();
      assert.equal(await main([
        '--mode', 'external',
        '--trace', tracePath,
        '--external-command', process.execPath,
        '--external-arg', adapter,
        '--external-arg', '--store',
        '--external-arg', '.external-home/sessions.db',
        '--json'
      ], { stdout, stderr }), 0);
      assert.equal(JSON.parse(stdout.text()).results[0].savedBytes, 0);
      assert.equal(stderr.text(), '');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
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
