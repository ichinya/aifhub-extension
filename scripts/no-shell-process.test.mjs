import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNoShellProcessRunner, buildNoShellInvocation } from './no-shell-process.mjs';
import { deliveryTransportInput } from './host-delivery.mjs';
import { digest } from './workflow-state-store.mjs';

const body = Buffer.from('\uFEFFRU Русский EN English 😀 e\u0301\r\n&|<>^%! " ` $()\n');
for (const platform of ['linux', 'win32']) test(`AC3 ${platform}: exact stdin Buffer, body absent from argv/env`, async () => {
  let captured, received, childSeen;
  const runner = createNoShellProcessRunner({ platform, comSpec: 'C:\\Windows\\System32\\cmd.exe',
    environment: { PATH: 'safe', SECRET_TOKEN: 'never-copy' },
    execFileImpl(command, args, options, callback) {
      captured = { command, args, options };
      const stdin = new EventEmitter(); stdin.end = bytes => { received = bytes; queueMicrotask(() => callback(null, bytes, Buffer.alloc(0))); };
      return { stdin };
    } });
  const request = { request_uuid: 'uuid', identity: { body_sha256: digest(body) }, target: { kind: 'completion' }, body };
  const transfer = deliveryTransportInput(request, { transport: { utf8_stdin: true } });
  const result = await runner({ command: platform === 'win32' ? 'C:\\tools\\host.cmd' : '/bin/host', args: ['create-request'],
    stdin: transfer.stdin, onChild: child => { childSeen = child; } });
  assert.equal(result.exitCode, 0); assert.ok(childSeen); assert.equal(captured.options.shell, false);
  assert.equal(captured.options.encoding, 'buffer'); assert.equal(captured.options.env.SECRET_TOKEN, undefined);
  assert.equal(JSON.stringify(captured.args).includes('Русский'), false);
  assert.deepEqual(Buffer.from(JSON.parse(received).body), body); assert.deepEqual(result.stdoutBytes, received);
  assert.equal(result.adapter, platform === 'win32' ? 'windows-comspec' : 'direct-exec-file');
});
test('serialized input size (including escaping and control fields) chooses file, never report argv', () => {
  const bytes = Buffer.alloc(600000, 34);
  const descriptor = { path: '.ai-factory/state/work/execution/request-bodies/body.utf8', sha256: digest(bytes), byte_length: bytes.length, encoding: 'utf-8' };
  const r = deliveryTransportInput({ request_uuid: 'uuid', body: bytes, body_file: descriptor }, { transport: { utf8_stdin: true, utf8_file: true } });
  assert.equal(r.transport, 'file'); assert.deepEqual(JSON.parse(r.stdin).body_file, descriptor);
  assert.equal(JSON.parse(r.stdin).body, undefined);
  assert.equal(deliveryTransportInput({ body: bytes }, { transport: { utf8_stdin: true } }), null);
  assert.throws(() => deliveryTransportInput({ body: Buffer.from([0xc3, 0x28]) }, {}), { code: 'invalid-utf8' });
});
test('timeout/EPIPE/overflow/invalid stdout remain process failures requiring host observation', async () => {
  for (const code of ['ETIMEDOUT', 'EPIPE', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'invalid-utf8']) {
    const runner = createNoShellProcessRunner({ execFileImpl(_command, _args, _options, callback) {
      callback(code === 'invalid-utf8' ? null : { code }, code === 'invalid-utf8' ? Buffer.from([0xff]) : body, Buffer.alloc(0));
    } });
    const r = await runner({ command: 'host', stdin: body });
    assert.equal(r.processCode, code); assert.equal(r.exitCode, null); assert.equal(r.timedOut, code === 'ETIMEDOUT');
  }
});
test('stdin stream EPIPE is retained until process close', async () => {
  const runner = createNoShellProcessRunner({ execFileImpl(_command, _args, _options, callback) {
    const stdin = new EventEmitter(); stdin.end = () => { stdin.emit('error', { code: 'EPIPE' }); setImmediate(() => callback(null, '', '')); };
    return { stdin };
  } });
  const r = await runner({ command: 'host', stdin: body }); assert.equal(r.processCode, 'EPIPE'); assert.equal(r.exitCode, null);
});
test('only .cmd/.bat use ComSpec, invalid control/path tokens fail before process creation', async () => {
  const direct = buildNoShellInvocation({ command: 'C:\\host.exe', args: ['&|<>^%!'], platform: 'win32' });
  assert.equal(direct.adapter, 'direct-exec-file');
  for (const arg of ['%PATH%', '!x!', '"quoted"']) assert.throws(() => buildNoShellInvocation({ command: 'C:\\host.cmd', args: [arg], platform: 'win32', comSpec: 'C:\\Windows\\System32\\cmd.exe' }), { code: 'unsafe-windows-command-token' });
  assert.throws(() => buildNoShellInvocation({ command: 'host\nother' }), { code: 'invalid-toolchain-token' });
  const runner = createNoShellProcessRunner({ execFileImpl() { assert.fail('must not create process'); } });
  await assert.rejects(runner({ command: 'host', stdin: Buffer.alloc(1024 * 1024 + 1) }), { code: 'input-too-large' });
});
test('Windows real .cmd shim transports report on stdin unchanged', { skip: process.platform !== 'win32' }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'delivery-cmd-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const shim = path.join(root, 'host.cmd'), script = path.join(root, 'echo.cjs');
  await writeFile(script, 'process.stdin.pipe(process.stdout);\n');
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
  const result = await createNoShellProcessRunner()({ command: shim, stdin: body });
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.deepEqual(result.stdoutBytes, body);
});
