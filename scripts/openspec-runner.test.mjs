// openspec-runner.test.mjs - tests for OpenSpec CLI runner and capability detection
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  archiveOpenSpecChange,
  detectOpenSpec,
  getOpenSpecInstructions,
  getOpenSpecStatus,
  resolveOpenSpecCommand,
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
    assert.equal(result.commandSource, 'path');
    assert.equal(result.reason, null);
    assert.deepEqual(result.errors, []);
  });

  it('returns available capabilities for reviewed version 1.4.0 on supported Node', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: 'openspec 1.4.0\n', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, true);
    assert.equal(result.canArchive, true);
    assert.equal(result.version, '1.4.0');
    assert.equal(result.supportedRange, '>=1.3.1 <2.0.0');
    assert.equal(result.versionSupported, true);
    assert.equal(result.latestReviewedVersion, '1.10.0');
    assert.equal(result.versionOutdated, true);
    assert.equal(result.reason, null);
  });

  it('returns available capabilities for reviewed version 1.4.1 on supported Node', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: 'openspec 1.4.1\n', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, true);
    assert.equal(result.canArchive, true);
    assert.equal(result.version, '1.4.1');
    assert.equal(result.supportedRange, '>=1.3.1 <2.0.0');
    assert.equal(result.versionSupported, true);
    assert.equal(result.reason, null);
  });

  it('returns available capabilities for reviewed version 1.5.0 on supported Node', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: 'openspec 1.5.0\n', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, true);
    assert.equal(result.canArchive, true);
    assert.equal(result.version, '1.5.0');
    assert.equal(result.supportedRange, '>=1.3.1 <2.0.0');
    assert.equal(result.versionSupported, true);
    assert.equal(result.reason, null);
  });

  it('returns available capabilities for reviewed version 1.6.0 on supported Node', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: 'openspec 1.6.0\n', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, true);
    assert.equal(result.canArchive, true);
    assert.equal(result.version, '1.6.0');
    assert.equal(result.supportedRange, '>=1.3.1 <2.0.0');
    assert.equal(result.versionSupported, true);
    assert.equal(result.reason, null);
  });

  it('returns available capabilities for reviewed version 1.7.0 on supported Node', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: 'openspec 1.7.0\n', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, true);
    assert.equal(result.canArchive, true);
    assert.equal(result.version, '1.7.0');
    assert.equal(result.supportedRange, '>=1.3.1 <2.0.0');
    assert.equal(result.versionSupported, true);
    assert.equal(result.reason, null);
  });

  it('keeps supported version 1.8.0 available but marks it older than the reviewed baseline', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: 'openspec 1.8.0\n', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, true);
    assert.equal(result.canArchive, true);
    assert.equal(result.version, '1.8.0');
    assert.equal(result.supportedRange, '>=1.3.1 <2.0.0');
    assert.equal(result.versionSupported, true);
    assert.equal(result.latestReviewedVersion, '1.10.0');
    assert.equal(result.versionOutdated, true);
    assert.equal(result.reason, null);
  });

  it('keeps supported version 1.9.0 available but marks it older than the reviewed baseline', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: 'openspec 1.9.0\n', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, true);
    assert.equal(result.canArchive, true);
    assert.equal(result.version, '1.9.0');
    assert.equal(result.supportedRange, '>=1.3.1 <2.0.0');
    assert.equal(result.versionSupported, true);
    assert.equal(result.latestReviewedVersion, '1.10.0');
    assert.equal(result.versionOutdated, true);
    assert.equal(result.reason, null);
  });

  it('returns fresh capabilities for reviewed version 1.10.0 on supported Node', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: 'openspec 1.10.0\n', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, true);
    assert.equal(result.canArchive, true);
    assert.equal(result.version, '1.10.0');
    assert.equal(result.supportedRange, '>=1.3.1 <2.0.0');
    assert.equal(result.versionSupported, true);
    assert.equal(result.latestReviewedVersion, '1.10.0');
    assert.equal(result.versionOutdated, false);
    assert.equal(result.reason, null);
  });

  it('does not mark a newer supported version as outdated or recommend a downgrade signal', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: 'openspec 1.10.1\n', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.version, '1.10.1');
    assert.equal(result.versionSupported, true);
    assert.equal(result.latestReviewedVersion, '1.10.0');
    assert.equal(result.versionOutdated, false);
    assert.equal(result.reason, null);
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
    assert.equal(result.latestReviewedVersion, '1.10.0');
    assert.equal(result.versionOutdated, null);
    assert.equal(result.nodeSupported, true);
    assert.equal(result.reason, 'missing-cli');
    assert.deepEqual(result.errors, [
      {
        code: 'missing-cli',
        message: "Selected OpenSpec CLI 'openspec' (path) is unavailable."
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
    assert.equal(result.latestReviewedVersion, '1.10.0');
    assert.equal(result.versionOutdated, null);
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

  it('keeps reviewed prerelease 1.6.0-beta.1 unavailable for production capabilities', async () => {
    const result = await detectOpenSpec({
      executor: async () => ({ exitCode: 0, stdout: 'openspec 1.6.0-beta.1', stderr: '' }),
      nodeVersion: '20.19.0'
    });

    assert.equal(result.available, true);
    assert.equal(result.canValidate, false);
    assert.equal(result.canArchive, false);
    assert.equal(result.version, '1.6.0-beta.1');
    assert.equal(result.versionSupported, false);
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
      assert.equal(result.command, 'openspec');
      assert.equal(result.commandSource, 'path');
      assert.equal(result.reason, null);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers a newer project-local CLI over an older global CLI', async () => {
    const localCommand = '/workspace/node_modules/.bin/openspec';
    const calls = [];
    const result = await detectOpenSpec({
      cwd: '/workspace',
      platform: 'linux',
      candidateExists: (candidate) => candidate === localCommand,
      executor: async (call) => {
        calls.push(call);
        return {
          exitCode: 0,
          stdout: call.command === localCommand ? 'openspec 1.4.1' : 'openspec 1.2.0',
          stderr: ''
        };
      },
      nodeVersion: '20.19.0'
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, localCommand);
    assert.equal(result.version, '1.4.1');
    assert.equal(result.command, 'node_modules/.bin/openspec');
    assert.equal(result.commandSource, 'project-local');
    assert.equal(result.canValidate, true);
  });

  it('does not replace an unsupported project-local CLI with a supported global CLI', async () => {
    const localCommand = '/workspace/node_modules/.bin/openspec';
    const calls = [];
    const result = await detectOpenSpec({
      cwd: '/workspace',
      platform: 'linux',
      candidateExists: (candidate) => candidate === localCommand,
      executor: async (call) => {
        calls.push(call);
        return {
          exitCode: 0,
          stdout: call.command === localCommand ? 'openspec 1.2.0' : 'openspec 1.4.1',
          stderr: ''
        };
      },
      nodeVersion: '20.19.0'
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, localCommand);
    assert.equal(result.version, '1.2.0');
    assert.equal(result.commandSource, 'project-local');
    assert.equal(result.reason, 'unsupported-version');
    assert.match(result.errors[0].message, /node_modules\/\.bin\/openspec.*project-local/);
  });

  it('uses a project-local Windows shim on the current Windows runtime', { skip: process.platform !== 'win32' }, async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'openspec-local-shim-'));
    const binDir = path.join(tempDir, 'node_modules', '.bin');

    try {
      await mkdir(binDir, { recursive: true });
      await writeFile(
        path.join(binDir, 'openspec.cmd'),
        '@echo off\r\necho 1.4.1\r\n',
        'utf8'
      );

      const result = await detectOpenSpec({
        cwd: tempDir,
        nodeVersion: '20.19.0'
      });

      assert.equal(result.available, true);
      assert.equal(result.version, '1.4.1');
      assert.equal(result.command, 'node_modules/.bin/openspec.cmd');
      assert.equal(result.commandSource, 'project-local');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('resolveOpenSpecCommand', () => {
  it('selects an explicit command before project-local and PATH candidates', () => {
    const result = resolveOpenSpecCommand({
      command: '/workspace/tools/openspec',
      cwd: '/workspace',
      platform: 'linux',
      candidateExists: () => true
    });

    assert.deepEqual(result, {
      executable: '/workspace/tools/openspec',
      displayCommand: 'tools/openspec',
      commandSource: 'explicit'
    });
  });

  it('treats an undefined command as absent and selects project-local', () => {
    const result = resolveOpenSpecCommand({
      command: undefined,
      cwd: '/workspace',
      platform: 'linux',
      candidateExists: (candidate) => candidate === '/workspace/node_modules/.bin/openspec'
    });

    assert.equal(result.executable, '/workspace/node_modules/.bin/openspec');
    assert.equal(result.displayCommand, 'node_modules/.bin/openspec');
    assert.equal(result.commandSource, 'project-local');
  });

  it('uses the global PATH command only when project-local is absent', () => {
    const result = resolveOpenSpecCommand({
      cwd: '/workspace',
      platform: 'linux',
      candidateExists: () => false
    });

    assert.deepEqual(result, {
      executable: 'openspec',
      displayCommand: 'openspec',
      commandSource: 'path'
    });
  });

  it('bounds an explicit absolute command outside cwd to its basename', () => {
    const result = resolveOpenSpecCommand({
      command: '/private/tools/custom-openspec',
      cwd: '/workspace',
      platform: 'linux'
    });

    assert.equal(result.executable, '/private/tools/custom-openspec');
    assert.equal(result.displayCommand, 'custom-openspec');
    assert.equal(result.commandSource, 'explicit');
    assert.doesNotMatch(result.displayCommand, /private|workspace/);
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

  it('keeps JSON stdout parseable when OpenSpec writes a notice to stderr', async () => {
    const result = await runOpenSpec(['show', 'auth', '--json'], {
      expectJson: true,
      executor: async () => ({
        exitCode: 0,
        stdout: '{"id":"auth","root":{"path":"C:/repo","source":"nearest"}}',
        stderr: 'OpenSpec notice stays on stderr'
      })
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.json, {
      id: 'auth',
      root: { path: 'C:/repo', source: 'nearest' }
    });
    assert.equal(result.stderr, 'OpenSpec notice stays on stderr');
    assert.equal(result.jsonParseError, null);
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
      message: "OpenSpec command 'openspec' (path) failed with exit code 1."
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
      message: "Selected OpenSpec CLI 'openspec' (path) is unavailable."
    });
  });

  it('does not fall back after an explicit command is selected and missing', async () => {
    const calls = [];
    const result = await runOpenSpec(['--version'], {
      command: '/workspace/tools/openspec',
      cwd: '/workspace',
      platform: 'linux',
      candidateExists: () => true,
      executor: async (call) => {
        calls.push(call);
        throw missingCliError();
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/workspace/tools/openspec');
    assert.equal(result.command, 'tools/openspec');
    assert.equal(result.commandSource, 'explicit');
    assert.equal(result.error.code, 'missing-cli');
    assert.match(result.error.message, /tools\/openspec.*explicit/);
  });

  it('executes a POSIX project-local shim directly with separate argv', async () => {
    const calls = [];
    const result = await runOpenSpec(['show', 'item with spaces'], {
      cwd: '/workspace',
      platform: 'linux',
      candidateExists: (candidate) => candidate === '/workspace/node_modules/.bin/openspec',
      execFile: async (...call) => {
        calls.push(call);
        return { stdout: 'ok', stderr: '' };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.commandSource, 'project-local');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/workspace/node_modules/.bin/openspec');
    assert.deepEqual(calls[0][1], ['show', 'item with spaces']);
    assert.equal(calls[0][2].cwd, '/workspace');
    assert.equal(calls[0][2].windowsVerbatimArguments, undefined);
  });

  it('routes a synthetic Windows project-local shim directly through ComSpec', async () => {
    const calls = [];
    const cwd = 'C:\\Work Space\\repo';
    const localCommand = 'C:\\Work Space\\repo\\node_modules\\.bin\\openspec.cmd';
    const result = await runOpenSpec(['show', 'value & more'], {
      cwd,
      platform: 'win32',
      candidateExists: (candidate) => candidate === localCommand,
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
      execFile: async (...call) => {
        calls.push(call);
        return { stdout: 'ok', stderr: '' };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.command, 'node_modules/.bin/openspec.cmd');
    assert.equal(result.commandSource, 'project-local');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(calls[0][1].slice(0, 4), ['/d', '/s', '/v:off', '/c']);
    assert.match(calls[0][1][4], /C:\\Work\^ Space\\repo\\node_modules\\\.bin\\openspec\.cmd/);
    assert.match(calls[0][1][4], /\^\^\^&/);
    assert.doesNotMatch(calls[0][1][4], /"value & more"/);
    assert.equal(calls[0][2].windowsVerbatimArguments, true);
  });

  it('rejects a relative or non-cmd ComSpec before executing Windows shims', async () => {
    const cwd = 'C:\\workspace';
    const localCommand = 'C:\\workspace\\node_modules\\.bin\\openspec.cmd';

    for (const comSpec of ['cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell.exe']) {
      let calls = 0;
      const result = await runOpenSpec(['--version'], {
        cwd,
        platform: 'win32',
        candidateExists: (candidate) => candidate === localCommand,
        comSpec,
        execFile: async () => {
          calls += 1;
          return { stdout: '1.8.0', stderr: '' };
        }
      });

      assert.equal(result.ok, false, `${comSpec} must be rejected`);
      assert.equal(result.error?.code, 'invalid-comspec');
      assert.match(result.error?.message ?? '', /absolute cmd\.exe path/);
      assert.equal(calls, 0, 'unsafe ComSpec must not be executed');
    }
  });

  it('preserves shell metacharacters through a real Windows project-local cmd shim', { skip: process.platform !== 'win32' }, async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'openspec-%PATH%-&-args-'));
    const binDir = path.join(tempDir, 'node_modules', '.bin');
    const captureScript = path.join(tempDir, 'capture-args.mjs');
    const localCommand = path.join(binDir, 'openspec.cmd');
    const args = [
      'show',
      'value & more',
      'value | more',
      'value > more',
      'value < more',
      'value %PATH% more',
      'value ^ more',
      'value !AIFHUB_CMD_TEST! more',
      'value "quoted" more',
      'value with trailing slash\\'
    ];

    try {
      await mkdir(binDir, { recursive: true });
      await writeFile(
        captureScript,
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
        'utf8'
      );
      await writeFile(
        localCommand,
        `@echo off\r\n"${process.execPath.replaceAll('%', '%%')}" "${captureScript.replaceAll('%', '%%')}" %*\r\n`,
        'utf8'
      );

      const result = await runOpenSpec(args, {
        cwd: tempDir,
        platform: 'win32',
        candidateExists: (candidate) => candidate === localCommand,
        env: {
          ...process.env,
          AIFHUB_CMD_TEST: 'expanded-value'
        }
      });

      assert.equal(result.ok, true, result.error?.message);
      const receivedArgs = JSON.parse(result.stdout);
      assert.equal(receivedArgs.length, args.length, 'cmd shim should preserve the argv length');
      for (const [index, expected] of args.entries()) {
        assert.equal(
          receivedArgs[index] === expected,
          true,
          `cmd shim should preserve argv[${index}] without environment expansion`
        );
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('OpenSpec command wrappers', () => {
  it('uses the same project-local resolver semantics for every operation', async () => {
    const localCommand = '/workspace/node_modules/.bin/openspec';
    const calls = [];
    const options = {
      cwd: '/workspace',
      platform: 'linux',
      candidateExists: (candidate) => candidate === localCommand,
      executor: async (call) => {
        calls.push(call);
        return {
          exitCode: 0,
          stdout: call.args[0] === 'archive' ? 'archived' : '{}',
          stderr: ''
        };
      }
    };

    const results = await Promise.all([
      validateOpenSpecChange('add-oauth', options),
      getOpenSpecStatus('add-oauth', options),
      showOpenSpecItem('add-oauth', options),
      getOpenSpecInstructions('apply', { ...options, change: 'add-oauth' }),
      archiveOpenSpecChange('add-oauth', options)
    ]);

    assert.deepEqual(calls.map((call) => call.command), Array(5).fill(localCommand));
    assert.equal(results.every((result) => result.command === 'node_modules/.bin/openspec'), true);
    assert.equal(results.every((result) => result.commandSource === 'project-local'), true);
  });

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
    assert.equal(calls[0].args.includes('--archived'), false, 'shared validation argv must remain current-change scoped');
    assert.deepEqual(result.json, { valid: true });
  });

  it('preserves additive OpenSpec 1.5.0 root diagnostics in parsed JSON', async () => {
    const { executor } = createRecordingExecutor({
      exitCode: 0,
      stdout: '{"items":[],"summary":{"total":0},"version":"1.5.0","root":"C:/repo/openspec"}',
      stderr: ''
    });

    const result = await validateOpenSpecChange('add-oauth', { executor });

    assert.equal(result.ok, true);
    assert.deepEqual(result.json, {
      items: [],
      summary: { total: 0 },
      version: '1.5.0',
      root: 'C:/repo/openspec'
    });
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

  it('getOpenSpecInstructions supports the OpenSpec 1.7 archive artifact', async () => {
    const { executor, calls } = createRecordingExecutor({
      exitCode: 0,
      stdout: '{"changeName":"add-oauth"}',
      stderr: ''
    });

    const result = await getOpenSpecInstructions('archive', {
      change: 'add-oauth',
      executor
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].args, [
      'instructions',
      'archive',
      '--change',
      'add-oauth',
      '--json',
      '--no-color'
    ]);
  });

  it('preserves the OpenSpec 1.10 store-aware specs instruction envelope', async () => {
    const envelope = {
      changeName: 'store-change',
      artifactId: 'specs',
      planningHome: {
        kind: 'repo',
        root: 'C:/stores/team-context',
        changesDir: 'C:/stores/team-context/openspec/changes',
        defaultSchema: 'spec-driven'
      },
      instruction: 'Read <planningHome.root>/openspec/specs/<capability-path>/spec.md.',
      root: {
        path: 'C:/stores/team-context',
        source: 'declared',
        store_id: 'team-context'
      }
    };
    const { executor, calls } = createRecordingExecutor({
      exitCode: 0,
      stdout: JSON.stringify(envelope),
      stderr: ''
    });

    const result = await getOpenSpecInstructions('specs', {
      change: 'store-change',
      executor
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.json, envelope);
    assert.equal(result.json.planningHome.root, result.json.root.path);
    assert.match(result.json.instruction, /<planningHome\.root>\/openspec\/specs/);
    assert.deepEqual(calls[0].args, [
      'instructions',
      'specs',
      '--change',
      'store-change',
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
