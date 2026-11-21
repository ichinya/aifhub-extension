import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { deliveryTransportInput } from './host-delivery.mjs';
import { digest } from './workflow-state-store.mjs';

async function startHost(t, options) {
  const entry = new URL('./fixtures/isolated-delivery-host-client.mjs', import.meta.url);
  const fixture = await import(entry).catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== entry.href) throw error;
    return {};
  });
  assert.equal(typeof fixture.startIsolatedDeliveryHost, 'function', 'isolated delivery host is callable');
  const host = await fixture.startIsolatedDeliveryHost(options);
  t.after(() => host.close());
  return host;
}

function preparedRequest(capabilities) {
  const body = Buffer.from('\ufeffОтчёт\r\n');
  const request = {
    request_uuid: randomUUID(), identity: { body_sha256: digest(body) },
    binding: { run_id: 'host-contract-run' }, target: { kind: 'completion', locator: 'test-worker' }, body
  };
  const transport = deliveryTransportInput(request, capabilities);
  return { ...request, transport: transport.transport, serialized_input: transport.stdin };
}

function queryFor(request, capabilities) {
  return { request_uuid: request.request_uuid, namespace_digest: capabilities.idempotency.scope_digest };
}

test('IPC host stores one completion, preserves frozen bytes and refuses a conflicting replay', async t => {
  const host = await startHost(t);
  const client = host.client;
  const capabilities = await client.capabilities();
  const request = preparedRequest(capabilities);
  const query = queryFor(request, capabilities);
  assert.deepEqual(capabilities.target_kinds, ['completion']);
  assert.equal(capabilities.transport.utf8_stdin, true);
  assert.equal((await client.readRequest(query)).deduplication_retained, true);
  assert.equal((await client.createRequest(request)).state, 'pending');
  const pending = await client.readRequest(query);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.completion_id, null);
  assert.equal(await client.fetchResponse(query), null);
  const completed = await host.complete(query);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.namespace_digest, query.namespace_digest);
  assert.equal(completed.continuity_token, capabilities.idempotency.continuity_token);
  assert.equal((await client.createRequest(request)).completion_id, completed.completion_id);
  const conflict = { ...request, target: { kind: 'completion', locator: 'other-worker' } };
  conflict.serialized_input = deliveryTransportInput(conflict, capabilities).stdin;
  assert.equal((await client.createRequest(conflict)).state, 'conflict');
  assert.deepEqual(await client.readRequest(query), completed);
  assert.deepEqual((await client.fetchResponse(query)).body, request.body);
  await assert.rejects(client.createRequest({ ...request, serialized_input: Buffer.alloc(1024 * 1024 + 1) }), /host-input-too-large/);
  const output = await host.close();
  assert.equal(output.exit.code, 0);
  const creates = output.trace.filter(event => event.operation === 'createRequest' && event.outcome === 'stored');
  assert.equal(creates.length, 1);
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const expected = {
    identity_sha256: sha256(JSON.stringify(request.identity)),
    binding_sha256: sha256(JSON.stringify(request.binding)),
    target_sha256: sha256('{"kind":"completion","locator":"test-worker"}'),
    continuity_sha256: sha256(capabilities.idempotency.continuity_token)
  };
  for (const event of [...creates, output.calls.find(call => call.call_id === creates[0].call_id)]) {
    for (const [field, value] of Object.entries(expected)) assert.equal(event[field], value);
  }
  for (const event of [...output.trace, ...output.calls]) {
    assert.ok(['continuity_token', 'identity', 'binding', 'target', 'body'].every(field => !(field in event)));
  }
  assert.ok(!JSON.stringify(output).includes(capabilities.idempotency.continuity_token));
});

test('IPC timeout discards the late reply and never repeats create on its own', async t => {
  const host = await startHost(t);
  const capabilities = await host.client.capabilities();
  const request = preparedRequest(capabilities);
  await host.holdNextReply();
  const create = host.client.createRequest(request);
  await assert.rejects(create, /host-ipc-timeout/);
  await host.flushReply();
  assert.equal((await host.client.readRequest(queryFor(request, capabilities))).state, 'pending');
  const { trace, exit } = await host.close();
  const creates = trace.filter(event => event.operation === 'createRequest');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].outcome, 'stored');
  assert.equal(exit.code, 0);
});

test('lost host custody and IPC disconnect reject observation', async t => {
  const host = await startHost(t);
  const capabilities = await host.client.capabilities();
  const request = preparedRequest(capabilities);
  const query = queryFor(request, capabilities);
  await host.client.createRequest(request);
  await unlink(path.join(host.root, 'request.json'));
  await assert.rejects(host.client.readRequest(query), /host-continuity-unproven/);
  await host.holdNextReply();
  const read = assert.rejects(host.client.readRequest(query), /host-ipc-disconnected/);
  const stopped = await host.close();
  await read;
  assert.equal(stopped.exit.code, 0);
});

test('IPC host removes its temporary directory when fork throws', async t => {
  const parent = await realpath(os.tmpdir());
  const temp = await mkdtemp(path.join(parent, 'aifhub-delivery-spawn-test-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(temp)), parent);
    await rm(temp, { recursive: true, force: true });
  });
  const entry = new URL('./fixtures/isolated-delivery-host-client.mjs', import.meta.url).href;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { readdir } from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import os from 'node:os';

    const spawnError = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
    let attempts = 0;
    childProcess.fork = () => {
      attempts++;
      throw spawnError;
    };
    syncBuiltinESMExports();

    const { startIsolatedDeliveryHost } = await import(${JSON.stringify(entry)});
    await assert.rejects(startIsolatedDeliveryHost(), error => error === spawnError);
    assert.equal(attempts, 1);
    assert.deepEqual(await readdir(os.tmpdir()), [], 'temporaries left by failed fork');
  `], {
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
    timeout: 30_000, windowsHide: true
  });
});

test('qualification removes both temporary projects after Git preparation fails', async t => {
  const parent = await realpath(os.tmpdir());
  const temp = await mkdtemp(path.join(parent, 'aifhub-delivery-test-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(temp)), parent);
    await rm(temp, { recursive: true, force: true });
  });
  const configName = 'fault.gitconfig';
  const config = path.join(temp, configName);
  await writeFile(config, '[invalid\n');
  const entry = new URL('./isolated-delivery-pilot.mjs', import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
    `const { runIsolatedDeliveryPilot } = await import(${JSON.stringify(entry)});
     const pair = await runIsolatedDeliveryPilot();
     console.log(JSON.stringify({ outcome: pair.outcome, reasons: pair.arms.map(arm => arm.reason) }));`
  ], {
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0' },
    timeout: 30_000, windowsHide: true
  });
  const { outcome, reasons } = JSON.parse(stdout);
  assert.equal(outcome, 'INCOMPLETE');
  assert.equal(reasons.length, 2);
  assert.ok(reasons.every(Boolean));
  assert.deepEqual(await readdir(temp), [configName]);
});

test('qualification cleans host and Git directories after confirmed exit with a truncated trace', async t => {
  const parent = await realpath(os.tmpdir());
  const temp = await mkdtemp(path.join(parent, 'aifhub-delivery-trace-test-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(temp)), parent);
    await rm(temp, { recursive: true, force: true });
  });
  const entry = new URL('./isolated-delivery-pilot.mjs', import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import path from 'node:path';

    const root = await fs.realpath(process.env.TMP);
    const originalRead = fs.readFile;
    let injections = 0;
    fs.readFile = async (file, ...options) => {
      if (typeof file === 'string' && path.basename(file) === 'trace.jsonl' &&
          path.dirname(path.dirname(file)) === root &&
          path.basename(path.dirname(file)).startsWith('aifhub-delivery-host-')) {
        await fs.appendFile(file, '{');
        injections++;
      }
      return originalRead(file, ...options);
    };
    syncBuiltinESMExports();
    const { runIsolatedDeliveryPilot } = await import(${JSON.stringify(entry)});
    const pair = await runIsolatedDeliveryPilot();
    const arms = pair.arms.map(({ reason, trace_error, host_exit, metrics }) => ({
      reason, trace_error, host_exit, metrics
    }));
    console.log(JSON.stringify({ injections, outcome: pair.outcome, arms }));
  `], {
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temp, 'unused.gitconfig'), GIT_TERMINAL_PROMPT: '0' },
    timeout: 30_000, windowsHide: true
  });
  const { injections, outcome, arms } = JSON.parse(stdout);
  assert.equal(injections, 2);
  assert.equal(outcome, 'INCOMPLETE');
  assert.equal(arms.length, 2);
  for (const arm of arms) {
    assert.equal(arm.reason, 'host-trace-invalid');
    assert.equal(arm.trace_error, 'host-trace-invalid');
    assert.deepEqual(arm.host_exit, { code: 0, signal: null });
    assert.deepEqual(arm.metrics, {
      service_calls: 'UNKNOWN', host_reads: 'UNKNOWN', host_fetches: 'UNKNOWN', host_releases: 'UNKNOWN'
    });
  }
  assert.deepEqual(await readdir(temp), []);
});

test('qualification follows the saved request through both branches and rejects missing host evidence', async () => {
  const entry = new URL('./isolated-delivery-pilot.mjs', import.meta.url);
  const pilot = await import(entry).catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== entry.href) throw error;
    return {};
  });
  assert.equal(typeof pilot.runIsolatedDeliveryPilot, 'function', 'qualification pair is callable');
  const pair = await pilot.runIsolatedDeliveryPilot();
  assert.equal(pair.outcome, 'QUALIFIED', JSON.stringify(pair.arms.map(arm => arm.reason)));
  const [baseline, candidate] = pair.arms;
  assert.notEqual(baseline.run_id, candidate.run_id);
  assert.notEqual(baseline.request_uuid, candidate.request_uuid);
  assert.notEqual(baseline.namespace_digest, candidate.namespace_digest);
  assert.notEqual(baseline.completion_id, candidate.completion_id);
  assert.equal(baseline.body_sha256, candidate.body_sha256);
  assert.deepEqual(baseline.services.map(step => step.action), ['delivery-inspect', 'delivery-inspect', 'delivery-recover']);
  assert.deepEqual(candidate.services.map(step => step.action), ['lifecycle-collect', 'lifecycle-collect', 'delivery-recover']);
  assert.equal(candidate.services[0].recovery_type, 'wait-request');
  assert.equal(candidate.services[1].next_action, 'delivery-recover');
  assert.equal(candidate.services[1].recovery_type, 'fetch-response');
  for (const arm of pair.arms) {
    assert.equal(arm.phase_before_recovery, 'pending');
    assert.equal(arm.phase_after_recovery, 'verified');
    assert.equal(arm.delivered_body_sha256, arm.body_sha256);
    assert.equal(arm.host_exit.code, 0);
    assert.equal(arm.metrics.service_calls, 3);
    assert.equal(arm.metrics.host_reads, 3);
    assert.equal(arm.metrics.host_releases, 0);
  }
  assert.equal(baseline.metrics.host_fetches, 2);
  assert.equal(candidate.metrics.host_fetches, 1);
  const proofFields = ['identity_sha256', 'binding_sha256', 'target_sha256', 'continuity_sha256'];
  for (const arm of pair.arms) {
    assert.deepEqual(arm.verified_proof, arm.proof);
    for (const trace of ['hostTrace', 'clientCalls']) {
      const pending = arm[trace].find(event => event.call_id === arm.window.after_call_id);
      assert.equal(pending.state, 'pending');
      for (const field of proofFields) {
        assert.match(arm.proof[field], /^[a-f0-9]{64}$/u);
        assert.equal(pending[field], arm.proof[field]);
        const missing = structuredClone(arm);
        delete missing[trace].find(event => event.call_id === pending.call_id)[field];
        assert.equal(pilot.recountArm(missing).host_reads, 'UNKNOWN');
        const mismatched = structuredClone(arm);
        mismatched[trace].find(event => event.call_id === pending.call_id)[field] = '0'.repeat(64);
        assert.equal(pilot.recountArm(mismatched).host_reads, 'UNKNOWN');
      }
    }
  }
  const incomplete = { ...candidate, hostTrace: candidate.hostTrace.filter(event =>
    !(event.call_id > candidate.window.after_call_id && event.operation === 'fetchResponse')) };
  assert.equal(pilot.recountArm(incomplete).host_reads, 'UNKNOWN');
  const missingService = { ...candidate, services: candidate.services.slice(1) };
  assert.equal(pilot.recountArm(missingService).service_calls, 'UNKNOWN');
});
