import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionProject } from './fixtures/execution-project.mjs';
import { createFakeHost } from './fixtures/host-delivery.mjs';
import { createGateResult, renderGateResultBlock } from './aif-gate-result.mjs';

test('native Git execution admission and delivery recovery preserve the exact persisted run', async t => {
  const f = await executionProject(); t.after(f.cleanup);
  const body = renderGateResultBlock(createGateResult({ gate: 'security', status: 'pass', blockers: [], affectedFiles: [], suggestedNext: null })) + '\n';
  const report = '.ai-factory/evidence/report.md'; await f.put(report, body);
  await f.call('start', f.start());
  const slot = await f.call('delivery-reserve', { change_id: f.id, run_id: 'run-1', target: { kind: 'completion', locator: 'worker-1' } });
  const input = { change_id: f.id, run_id: 'run-1', request_uuid: slot.request_uuid };
  await f.call('result', f.actor(1, { result: { result_id: 'result-1', status: 'completed', changed_files: [], checks: [{ name: 'offline', exit_code: 0 }], evidence: [report] } }));
  const before = await f.get('.ai-factory/state/work/execution/runs/run-1.json');
  await f.call('delivery-prepare', { ...input, gate: 'security', body });
  const host = createFakeHost({ mode: 'after-commit' });
  assert.equal((await f.call('delivery-send', input, { HostClient: host })).delivery_verified, true);
  assert.equal((await f.call('delivery-recover', input, { HostClient: host })).delivery_verified, true);
  assert.equal(host.state.completions.length, 1); assert.equal(host.state.counters.create_calls, 1);
  assert.equal(await f.get('.ai-factory/state/work/execution/runs/run-1.json'), before);
});
