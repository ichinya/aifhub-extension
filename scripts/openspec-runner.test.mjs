// openspec-runner.test.mjs - tests for OpenSpec CLI runner and capability detection
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  archiveOpenSpecChange,
  detectOpenSpec,
  getOpenSpecInstructions,
  getOpenSpecStatus,
  runOpenSpec,
  showOpenSpecItem,
  validateOpenSpecChange
} from './openspec-runner.mjs';

function missingCliError() {
  const err = new Error('spawn openspec ENOENT');
  err.code = 'ENOENT';
  return err;
}

function createRecordingExecutor(response) {
  const calls = [];
  const executor = async (call) => {
    calls.push(call);
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
  return { executor, calls };
}

describe('detectOpenSpec', () => {
  it('returns available capabilities for version 1.3.1 on supported Node', async () => {
    const { executor, calls } = createRecordingExecutor({
      exitCode: 0,
      stdout: 'openspec 1.3.1\n',
      stderr: ''
    });

    const result = await detectOpenSpec({
      executor,
      nodeVersion: '20.19.0',
      cwd: 'C:/repo'
    });

    assert.deepEqual(calls[0], {
      command: 'openspec',
      args: ['--version'],
      cwd: 'C:/repo',
      env: process.env
    });
    assert.equal(result.available, true);
    assert.equal(result.canValidate, true);
    assert.equal(result.canArchive, true);
    assert.equal(result.version, '1.3.1');
    assert.equal(result.supportedRange, '>=1.3.1 <2.0.0');
    assert.equal(result.versionSupported, true);
    assert.equal(result.requiresNode, '>=20.19.0');
    assert.equal(result.nodeVersion, '20.19.0');
    assert.equal(result.nodeSupported, true);
    assert.equal(result.command, 'openspec');
    assert.equal(result.reason, null);
    assert.deepEqual(result.errors, []);
  });

  it('returns degraded capabilities when CLI is missing', async () => {
    const result = await detectOpenSpec({
      executor: async () => {
        throw missingCliError();
      },
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, false);
    assert.equal(result.canValidate, false);
    assert.equal(result.canArchive, false);
    assert.equal(result.version, null);
    assert.equal(result.versionSupported, false);
    assert.equal(result.nodeSupported, true);
    assert.equal(result.reason, 'missing-cli');
    assert.deepEqual(result.errors, [
      {
        code: 'missing-cli',
        message: 'OpenSpec CLI is not available on PATH.'
      }
    ]);
  });

  it('returns unsupported-version for 1.2.0', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: '1.2.0', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, false);
    assert.equal(result.canArchive, false);
    assert.equal(result.version, '1.2.0');
    assert.equal(result.versionSupported, false);
    assert.equal(result.nodeSupported, true);
    assert.equal(result.reason, 'unsupported-version');
    assert.equal(result.errors[0].code, 'unsupported-version');
  });

  it('returns unsupported-version for prerelease 1.3.1-beta.1', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: 'openspec 1.3.1-beta.1', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, false);
    assert.equal(result.canArchive, false);
    assert.equal(result.version, '1.3.1-beta.1');
    assert.equal(result.versionSupported, false);
    assert.equal(result.nodeSupported, true);
    assert.equal(result.reason, 'unsupported-version');
    assert.equal(result.errors[0].code, 'unsupported-version');
  });

  it('returns unsupported-node when injected Node version is below 20.19.0', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: '@fission-ai/openspec 1.3.1', stderr: '' }),
      nodeVersion: '20.18.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, false);
    assert.equal(result.canArchive, false);
    assert.equal(result.version, '1.3.1');
    assert.equal(result.versionSupported, true);
    assert.equal(result.nodeSupported, false);
    assert.equal(result.reason, 'unsupported-node');
    assert.equal(result.errors[0].code, 'unsupported-node');
  });

  it('parses bare OpenSpec version output', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: '1.3.1', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.version, '1.3.1');
    assert.equal(result.reason, null);
  });

  it('detects a Windows npm .cmd shim from PATH', { skip: process.platform !== 'win32' }, async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'openspec-shim-'));

    try {
      await writeFile(
        path.join(tempDir, 'openspec.cmd'),
        '@echo off\r\necho 1.3.1\r\n',
        'utf8'
      );

      const result = await detectOpenSpec({
        cwd: tempDir,
        env: {
          ...process.env,
          PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`
        },
        nodeVersion: '20.19.0'
      });

      assert.equal(result.available, true);
      assert.equal(result.canValidate, true);
      assert.equal(result.canArchive, true);
      assert.equal(result.version, '1.3.1');
      assert.equal(result.reason, null);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('runOpenSpec', () => {
  it('parses valid JSON when expectJson is true', async () => {
    const result = await runOpenSpec(['list', '--json'], {
      expectJson: true,
      executor: async () => ({
        exitCode: 0,
        stdout: '{"changes":["add-oauth"]}',
        stderr: ''
      })
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.json, { changes: ['add-oauth'] });
    assert.equal(result.jsonParseError, null);
    assert.equal(result.error, null);
  });

  it('reports invalid JSON when expectJson is true and stdout is not JSON', async () => {
    const result = await runOpenSpec(['list', '--json'], {
      expectJson: true,
      executor: async () => ({
        exitCode: 0,
        stdout: 'not json',
        stderr: ''
      })
    });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'not json');
    assert.equal(result.stderr, '');
    assert.equal(result.json, null);
    assert.deepEqual(result.jsonParseError, {
      code: 'invalid-json',
      message: 'OpenSpec command returned invalid JSON.'
    });
    assert.deepEqual(result.error, {
      code: 'invalid-json',
      message: 'OpenSpec command returned invalid JSON.'
    });
  });

  it('preserves raw stdout and stderr on non-zero exit', async () => {
    const result = await runOpenSpec(['validate', 'add-oauth'], {
      expectJson: true,
      executor: async () => ({
        exitCode: 1,
        stdout: '{"valid":false}',
        stderr: 'failed validation'
      })
    });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '{"valid":false}');
    assert.equal(result.stderr, 'failed validation');
    assert.equal(result.json, null);
    assert.equal(result.jsonParseError, null);
    assert.deepEqual(result.error, {
      code: 'non-zero-exit',
      message: 'OpenSpec command failed with exit code 1.'
    });
  });

  it('returns missing-cli when executor throws ENOENT', async () => {
    const result = await runOpenSpec(['list'], {
      executor: async () => {
        throw missingCliError();
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(result.json, null);
    assert.equal(result.jsonParseError, null);
    assert.deepEqual(result.error, {
      code: 'missing-cli',
      message: 'OpenSpec CLI is not available on PATH.'
    });
  });
});

describe('OpenSpec command wrappers', () => {
  it('validateOpenSpecChange builds the expected args', async () => {
    const { executor, calls } = createRecordingExecutor({
      exitCode: 0,
      stdout: '{"valid":true}',
      stderr: ''
    });

    const result = await validateOpenSpecChange('add-oauth', { executor });

    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].args, [
      'validate',
      'add-oauth',
      '--type',
      'change',
      '--strict',
      '--json',
      '--no-interactive',
      '--no-color'
    ]);
    assert.deepEqual(result.json, { valid: true });
  });

  it('getOpenSpecStatus builds the expected args', async () => {
    const { executor, calls } = createRecordingExecutor({
      exitCode: 0,
      stdout: '{"change":"add-oauth"}',
      stderr: ''
    });

    const result = await getOpenSpecStatus('add-oauth', { executor });

    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].args, [
      'status',
      '--change',
      'add-oauth',
      '--json',
      '--no-color'
    ]);
  });

  it('showOpenSpecItem supports type and deltasOnly args', async () => {
    const { executor, calls } = createRecordingExecutor({
      exitCode: 0,
      stdout: '{}',
      stderr: ''
    });

    await showOpenSpecItem('add-oauth', {
      type: 'change',
      deltasOnly: true,
      executor
    });

    assert.deepEqual(calls[0].args, [
      'show',
      'add-oauth',
      '--type',
      'change',
      '--deltas-only',
      '--json',
      '--no-interactive',
      '--no-color'
    ]);
  });

  it('getOpenSpecInstructions builds the expected args', async () => {
    const { executor, calls } = createRecordingExecutor({
      exitCode: 0,
      stdout: '{}',
      stderr: ''
    });

    await getOpenSpecInstructions('apply', {
      change: 'add-oauth',
      executor
    });

    assert.deepEqual(calls[0].args, [
      'instructions',
      'apply',
      '--change',
      'add-oauth',
      '--json',
      '--no-color'
    ]);
  });

  it('archiveOpenSpecChange builds expected args and does not require JSON', async () => {
    const { executor, calls } = createRecordingExecutor({
      exitCode: 0,
      stdout: 'archived add-oauth',
      stderr: ''
    });

    const result = await archiveOpenSpecChange('add-oauth', {
      skipSpecs: true,
      executor
    });

    assert.equal(result.ok, true);
    assert.equal(result.json, null);
    assert.deepEqual(calls[0].args, [
      'archive',
      'add-oauth',
      '--yes',
      '--skip-specs',
      '--no-color'
    ]);
  });

  it('archiveOpenSpecChange supports noValidate', async () => {
    const { executor, calls } = createRecordingExecutor({
      exitCode: 0,
      stdout: 'archived add-oauth',
      stderr: ''
    });

    await archiveOpenSpecChange('add-oauth', {
      noValidate: true,
      executor
    });

    assert.deepEqual(calls[0].args, [
      'archive',
      'add-oauth',
      '--yes',
      '--no-validate',
      '--no-color'
    ]);
  });
});
