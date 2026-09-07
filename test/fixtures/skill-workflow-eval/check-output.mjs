// Coordinator-only independent public-API checks. Never materialize in a worker context.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [scenario, workspace] = process.argv.slice(2);
const timer = setTimeout(() => { process.stderr.write('hidden check deadline exceeded\n'); process.exit(2); }, 5000);
try {
  assert.ok(['implement', 'fix'].includes(scenario), 'only implement and fix have executable hidden checks');
  assert.ok(workspace, 'workspace required');
  if (scenario === 'implement') {
    const { summarizeInvoice } = await import(pathToFileURL(path.resolve(workspace, 'src/invoice.mjs')));
    assert.deepEqual(summarizeInvoice([]), { totalCents: 0, itemCount: 0 });
    assert.deepEqual(summarizeInvoice([{ unitCents: 125, quantity: 3 }, { unitCents: 40, quantity: 2 }]),
      { totalCents: 455, itemCount: 5 });
    assert.deepEqual(summarizeInvoice([{ unitCents: 0, quantity: 4 }]), { totalCents: 0, itemCount: 4 });
  } else {
    const { loadOnce } = await import(pathToFileURL(path.resolve(workspace, 'src/load-once.mjs')));
    let calls = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const loader = async () => { calls++; await barrier; return 13; };
    const a = loadOnce('a', loader);
    const b = loadOnce('a', loader);
    const c = loadOnce('b', loader);
    release();
    assert.deepEqual(await Promise.all([a, b, c]), [13, 13, 13]);
    assert.equal(calls, 2, 'one call per distinct in-flight key');
    assert.equal(await loadOnce('a', async () => 21), 21, 'success releases key');
    await assert.rejects(async () => loadOnce('reject', async () => { throw new Error('loader failed'); }));
    assert.equal(await loadOnce('reject', async () => 34), 34, 'rejection releases key');
    await assert.rejects(async () => loadOnce('throw', () => { throw new Error('sync failure'); }));
    assert.equal(await loadOnce('throw', async () => 55), 55, 'synchronous throw releases key');
  }
  process.stdout.write(`${JSON.stringify({ requirement: scenario === 'implement' ? 'invoice-behavior' : 'load-once-behavior', met: true })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally { clearTimeout(timer); }
