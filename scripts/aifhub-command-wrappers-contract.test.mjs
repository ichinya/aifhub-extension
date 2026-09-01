// aifhub-command-wrappers-contract.test.mjs - installed command wrapper contract tests
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);

const WRAPPER_COMMANDS = [
  {
    name: 'aifhub-mode',
    description: 'Run AIFHub artifact mode status, switch, sync, and doctor commands.',
    module: './commands/aifhub-mode.mjs',
    script: 'aif-mode.mjs',
    args: ['sync', '--change', 'add-oauth', '--json']
  },
  {
    name: 'aifhub-migrate-legacy-plans',
    description: 'Run AIFHub legacy AI Factory plan migration commands.',
    module: './commands/aifhub-migrate-legacy-plans.mjs',
    script: 'migrate-legacy-plans.mjs',
    args: ['add-oauth', '--dry-run']
  },
  {
    name: 'aifhub-write-gate-evidence',
    description: 'Persist validated AIFHub gate evidence under QA paths.',
    module: './commands/aifhub-write-gate-evidence.mjs',
    script: 'write-gate-evidence.mjs',
    args: ['--change', 'add-oauth', '--gate', 'rules', '--from', 'rules.md']
  },
  {
    name: 'aifhub-coverage',
    description: 'Build and optionally write AIFHub OpenSpec coverage evidence.',
    module: './commands/aifhub-coverage.mjs',
    script: 'openspec-coverage-matrix.mjs',
    args: ['--change', 'add-oauth', '--write', '--json']
  },
  {
    name: 'aifhub-done-readiness',
    description: 'Run AIFHub OpenSpec done-readiness diagnostics.',
    module: './commands/aifhub-done-readiness.mjs',
    script: 'openspec-done-readiness.mjs',
    args: ['--change', 'add-oauth', '--json']
  },
  {
    name: 'aifhub-done-finalizer',
    description: 'Finalize a verified AIFHub OpenSpec change from an installed project.',
    module: './commands/aifhub-done-finalizer.mjs',
    script: 'openspec-done-finalizer.mjs',
    args: ['--change', 'add-oauth', '--skip-specs', '--record-dirty-state', '--json']
  },
  {
    name: 'aifhub-validate-artifacts',
    description: 'Run AIFHub OpenSpec artifact contract validation.',
    module: './commands/aifhub-validate-artifacts.mjs',
    script: 'openspec-artifact-validator.mjs',
    args: ['--change', 'add-oauth', '--json']
  },
  {
    name: 'aifhub-handoff-gate-summary',
    description: 'Run AIFHub Handoff gate summary diagnostics.',
    module: './commands/aifhub-handoff-gate-summary.mjs',
    script: 'handoff-gate-summary.mjs',
    args: ['--change', 'add-oauth', '--stage', 'review', '--json']
  },
  {
    name: 'aifhub-memory-tools',
    description: 'Run AIFHub optional memory and context tool recommendation diagnostics.',
    module: './commands/aifhub-memory-tools.mjs',
    script: 'memory-tool-recommender.mjs',
    args: ['recommend', '--shape', 'large_framework_app', '--task', 'architecture_or_impact_discovery', '--json']
  },
  {
    name: 'aifhub-analyze-config-diff',
    description: 'Run the read-only AIFHub analyze config required-keys diff.',
    module: './commands/aifhub-analyze-config-diff.mjs',
    script: 'aif-analyze-config-diff.mjs',
    args: ['--json']
  },
  {
    name: 'aifhub-review-policy',
    description: 'Resolve, load, or scaffold the configured review policy through canonical path safety checks.',
    module: './commands/aifhub-review-policy.mjs',
    script: 'review-policy-resolver.mjs',
    args: ['resolve', '--json']
  },
  {
    name: 'aifhub-context-dedup',
    description: 'Run AIFHub session context dedup checks, status, and purge.',
    module: './commands/aifhub-context-dedup.mjs',
    script: 'context-dedup.mjs',
    args: ['status', '--json']
  }
];

const INSTALLED_FACING_ROOT_SCRIPT_RE = /\bnode\s+scripts\/[A-Za-z0-9_.-]+\.mjs\b/;

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-command-wrappers-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function readRepoFile(relativePath) {
  return readFile(path.join(REPO_ROOT, relativePath), 'utf8');
}

async function readJson(relativePath) {
  return JSON.parse(await readRepoFile(relativePath));
}

async function copyInstalledCommandLayout(userProjectDir) {
  const extensionDir = path.join(userProjectDir, '.ai-factory', 'extensions', 'aifhub-extension');
  await mkdir(path.join(extensionDir, 'commands'), { recursive: true });
  await mkdir(path.join(extensionDir, 'scripts'), { recursive: true });

  await copyFile(
    path.join(REPO_ROOT, 'commands', 'run-installed-script.mjs'),
    path.join(extensionDir, 'commands', 'run-installed-script.mjs')
  );

  for (const command of WRAPPER_COMMANDS) {
    await copyFile(
      path.join(REPO_ROOT, command.module.replace(/^\.\//, '')),
      path.join(extensionDir, command.module.replace(/^\.\//, ''))
    );

    await writeFile(
      path.join(extensionDir, 'scripts', command.script),
      [
        "import { writeFile } from 'node:fs/promises';",
        'const recordPath = process.env.AIFHUB_WRAPPER_RECORD_PATH;',
        'const record = {',
        '  scriptPath: process.argv[1].replaceAll(String.fromCharCode(92), "/"),',
        '  argv: process.argv.slice(2),',
        '  cwd: process.cwd().replaceAll(String.fromCharCode(92), "/"),',
        '  marker: process.env.AIFHUB_WRAPPER_TEST_MARKER ?? null',
        '};',
        'await writeFile(recordPath, JSON.stringify(record, null, 2));'
      ].join('\n'),
      'utf8'
    );
  }

  return extensionDir;
}

async function copyRealFinalizerLayout(userProjectDir) {
  const extensionDir = path.join(userProjectDir, '.ai-factory', 'extensions', 'aifhub-extension');
  await mkdir(path.join(extensionDir, 'commands'), { recursive: true });
  await copyFile(
    path.join(REPO_ROOT, 'commands', 'run-installed-script.mjs'),
    path.join(extensionDir, 'commands', 'run-installed-script.mjs')
  );
  await copyFile(
    path.join(REPO_ROOT, 'commands', 'aifhub-done-finalizer.mjs'),
    path.join(extensionDir, 'commands', 'aifhub-done-finalizer.mjs')
  );
  await cp(
    path.join(REPO_ROOT, 'scripts'),
    path.join(extensionDir, 'scripts'),
    { recursive: true }
  );
  return extensionDir;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runFinalizerWrapperHarness(userProjectDir, extensionDir) {
  const harnessPath = path.join(tmpDir, 'run-finalizer-wrapper.mjs');
  await writeFile(harnessPath, [
    "import { pathToFileURL } from 'node:url';",
    'const wrapperPath = process.env.AIFHUB_FINALIZER_WRAPPER_PATH;',
    'const mod = await import(pathToFileURL(wrapperPath).href);',
    'let actionHandler = null;',
    'const chain = {',
    '  description() { return this; },',
    '  allowUnknownOption() { return this; },',
    '  allowExcessArguments() { return this; },',
    '  argument() { return this; },',
    '  action(handler) { actionHandler = handler; return this; }',
    '};',
    'mod.register({ command() { return chain; } });',
    'await actionHandler(process.argv.slice(2));'
  ].join('\n'), 'utf8');

  try {
    const result = await execFileAsync(process.execPath, [
      harnessPath,
      '--change',
      'missing-change',
      '--json'
    ], {
      cwd: userProjectDir,
      env: {
        ...process.env,
        AIFHUB_FINALIZER_WRAPPER_PATH: path.join(extensionDir, 'commands', 'aifhub-done-finalizer.mjs')
      },
      windowsHide: true
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    return {
      exitCode: typeof err?.code === 'number' ? err.code : (err?.status ?? 1),
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? '')
    };
  }
}

function createFakeProgram() {
  const commands = new Map();
  return {
    commands,
    command(name) {
      const registered = {
        name,
        descriptionText: null,
        allowUnknown: false,
        allowExcess: false,
        argumentSpec: null,
        actionHandler: null,
        description(value) {
          this.descriptionText = value;
          return this;
        },
        allowUnknownOption(value = true) {
          this.allowUnknown = value;
          return this;
        },
        allowExcessArguments(value = true) {
          this.allowExcess = value;
          return this;
        },
        argument(value) {
          this.argumentSpec = value;
          return this;
        },
        action(handler) {
          this.actionHandler = handler;
          commands.set(name, this);
          return this;
        }
      };
      return registered;
    }
  };
}

describe('AIFHub command wrapper manifest contract', () => {
  it('publishes installed-project wrappers through extension.json', async () => {
    const manifest = await readJson('extension.json');

    for (const expected of WRAPPER_COMMANDS) {
      const command = (manifest.commands || []).find((entry) => entry.name === expected.name);
      assert.ok(command, `extension.json must declare ${expected.name}`);
      assert.equal(command.description, expected.description);
      assert.equal(command.module, expected.module);
    }
  });
});

describe('AIFHub installed command wrappers', () => {
  it('resolve scripts from the installed extension while preserving argv and user cwd', async () => {
    const userProjectDir = path.join(tmpDir, 'user-project');
    await mkdir(userProjectDir, { recursive: true });
    const extensionDir = await copyInstalledCommandLayout(userProjectDir);

    const originalEnv = {
      recordPath: process.env.AIFHUB_WRAPPER_RECORD_PATH,
      marker: process.env.AIFHUB_WRAPPER_TEST_MARKER
    };
    const originalExitCode = process.exitCode;

    try {
      for (const command of WRAPPER_COMMANDS) {
        const program = createFakeProgram();
        const modulePath = path.join(extensionDir, command.module.replace(/^\.\//, ''));
        const mod = await import(pathToFileURL(modulePath).href);
        mod.register(program);

        const registered = program.commands.get(command.name);
        assert.ok(registered, `${command.name} should register with the program`);
        assert.equal(registered.descriptionText, command.description);
        assert.equal(registered.allowUnknown, true);
        assert.equal(registered.allowExcess, true);
        assert.equal(registered.argumentSpec, '[args...]');

        const recordPath = path.join(tmpDir, `${command.name}.json`);
        process.env.AIFHUB_WRAPPER_RECORD_PATH = recordPath;
        process.env.AIFHUB_WRAPPER_TEST_MARKER = command.name;

        const oldCwd = process.cwd();
        process.chdir(userProjectDir);
        try {
          await registered.actionHandler(command.args);
        } finally {
          process.chdir(oldCwd);
        }

        const record = JSON.parse(await readFile(recordPath, 'utf8'));
        assert.deepEqual(record.argv, command.args, `${command.name} should preserve helper args`);
        assert.equal(record.cwd, userProjectDir.replaceAll(path.sep, '/'));
        assert.equal(record.marker, command.name);
        assert.ok(
          record.scriptPath.endsWith(`/.ai-factory/extensions/aifhub-extension/scripts/${command.script}`),
          `${command.name} should execute the installed extension script, got ${record.scriptPath}`
        );
        assert.ok(
          !record.scriptPath.endsWith(`/user-project/scripts/${command.script}`),
          `${command.name} must not resolve scripts from the user project root`
        );
      }
    } finally {
      restoreEnvValue('AIFHUB_WRAPPER_RECORD_PATH', originalEnv.recordPath);
      restoreEnvValue('AIFHUB_WRAPPER_TEST_MARKER', originalEnv.marker);
      process.exitCode = originalExitCode;
    }
  });

  it('runs the real installed finalizer graph without project-root helper scripts', async () => {
    const userProjectDir = path.join(tmpDir, 'installed-finalizer-project');
    await mkdir(userProjectDir, { recursive: true });
    const extensionDir = await copyRealFinalizerLayout(userProjectDir);

    assert.equal(
      await pathExists(path.join(userProjectDir, 'scripts', 'openspec-done-finalizer.mjs')),
      false,
      'consumer project must not need a root finalizer script'
    );

    const command = await runFinalizerWrapperHarness(userProjectDir, extensionDir);
    const output = JSON.parse(command.stdout);

    assert.equal(command.exitCode, 2, 'unresolved explicit change should propagate command exit 2');
    assert.equal(command.stderr, '');
    assert.equal(output.ok, false);
    assert.equal(output.mode, 'openspec-native');
    assert.equal(output.change_id, null);
    assert.equal(output.status, 'FAIL');
    assert.equal(output.archive.status, 'SKIPPED');
    assert.equal(output.errors[0].code, 'explicit-change-not-found');
    assert.equal(Object.hasOwn(output, 'context'), false);
  });

  it('runInstalledScript forwards process settings and reports child failures', async () => {
    const { runInstalledScript, resolveInstalledScriptPath } = await import('../commands/run-installed-script.mjs');
    const moduleUrl = pathToFileURL(path.join(tmpDir, 'installed', 'commands', 'wrapper.mjs')).href;
    const processLike = {
      execPath: 'node-bin',
      env: { AIFHUB_TEST: '1' },
      exitCode: undefined,
      cwd: () => path.join(tmpDir, 'user-project')
    };
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 7));
      return child;
    };

    assert.equal(
      resolveInstalledScriptPath('../scripts/example.mjs', moduleUrl),
      path.join(tmpDir, 'installed', 'scripts', 'example.mjs')
    );

    const exitCode = await runInstalledScript('../scripts/example.mjs', ['--flag'], moduleUrl, {
      processLike,
      spawn
    });

    assert.equal(exitCode, 7);
    assert.equal(processLike.exitCode, 7);
    assert.equal(calls[0].command, 'node-bin');
    assert.deepEqual(calls[0].args, [
      path.join(tmpDir, 'installed', 'scripts', 'example.mjs'),
      '--flag'
    ]);
    assert.equal(calls[0].options.cwd, path.join(tmpDir, 'user-project'));
    assert.deepEqual(calls[0].options.env, processLike.env);
    assert.equal(calls[0].options.stdio, 'inherit');
  });

  it('runInstalledScript bounds a hanging child with TERM and KILL fallback', async () => {
    const { runInstalledScript } = await import('../commands/run-installed-script.mjs');
    const moduleUrl = pathToFileURL(path.join(tmpDir, 'installed', 'commands', 'wrapper.mjs')).href;
    const processLike = {
      execPath: 'node-bin',
      env: {},
      exitCode: undefined,
      cwd: () => path.join(tmpDir, 'user-project')
    };
    const scheduled = [];
    const cleared = [];
    const signals = [];
    let unrefCalls = 0;
    const child = new EventEmitter();
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };
    child.unref = () => {
      unrefCalls += 1;
    };
    const setTimeoutImplementation = (callback, delay) => {
      const handle = { callback, delay };
      scheduled.push(handle);
      return handle;
    };
    const clearTimeoutImplementation = (handle) => {
      cleared.push(handle);
    };

    const pending = runInstalledScript('../scripts/example.mjs', [], moduleUrl, {
      processLike,
      spawn: () => child,
      timeout: 100,
      killTimeout: 25,
      setTimeout: setTimeoutImplementation,
      clearTimeout: clearTimeoutImplementation
    });

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 100);
    scheduled[0].callback();
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[1].delay, 25);
    scheduled[1].callback();

    assert.equal(await pending, 124);
    assert.equal(processLike.exitCode, 124);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(unrefCalls, 1);
    assert.ok(cleared.length >= 1);
  });

  it('configures a bounded timeout for the installed done finalizer wrapper', async () => {
    const source = await readRepoFile('commands/aifhub-done-finalizer.mjs');

    assert.match(source, /FINALIZER_TIMEOUT_MS/);
    assert.match(source, /timeout:\s*FINALIZER_TIMEOUT_MS/);
    assert.match(source, /killTimeout:\s*FINALIZER_KILL_TIMEOUT_MS/);
    assert.match(source, /timeoutExitCode:\s*2/);
  });
});

describe('AIFHub wrapper guidance contract', () => {
  it('declares aif-done metadata for installed finalization', async () => {
    const source = await readRepoFile('skills/aif-done/SKILL.md');
    const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);

    assert.ok(frontmatterMatch, 'skills/aif-done/SKILL.md should include YAML frontmatter');

    const fields = new Map(frontmatterMatch[1].split(/\r?\n/).map((line) => {
      const separator = line.indexOf(':');
      return separator === -1
        ? [line.trim(), '']
        : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
    const version = fields.get('version') ?? '';
    const versionParts = version.split('.').map((part) => Number.parseInt(part, 10));
    const argumentHint = fields.get('argument-hint') ?? '';
    const allowedTools = fields.get('allowed-tools') ?? '';

    assert.equal(fields.get('name'), 'aif-done');
    assert.ok(fields.get('description'), 'aif-done description should be non-empty');
    assert.match(version, /^\d+\.\d+\.\d+$/, 'aif-done version should use X.Y.Z semver');
    assert.ok(
      versionParts[0] > 1 || (versionParts[0] === 1 && versionParts[1] >= 4),
      'aif-done version should be at least 1.4.0 for marker-bounded roadmap lifecycle co-ownership'
    );
    for (const expected of ['change-id', 'plan-id', '--skip-specs', '--record-dirty-state']) {
      assert.ok(argumentHint.includes(expected), `aif-done argument-hint should include ${expected}`);
    }
    for (const expected of [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash(ai-factory aifhub-done-finalizer *)',
      'Bash(git status *)',
      'Bash(git branch --show-current)',
      'Bash(git diff *)',
      'Bash(git log *)',
      'Bash(gh --version)'
    ]) {
      assert.ok(allowedTools.includes(expected), `aif-done allowed-tools should include ${expected}`);
    }
    assert.doesNotMatch(
      allowedTools,
      /(?:^|\s)Bash(?:\s|$)/,
      'aif-done allowed-tools should not include unrestricted Bash'
    );
  });

  it('documents installed-project wrapper commands instead of root scripts', async () => {
    const expectations = [
      ['README.md', [
        'ai-factory aifhub-migrate-legacy-plans --list',
        'ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run',
        'ai-factory aifhub-done-finalizer --change <change-id> --json',
        'Omitting `--change` delegates to the active-change resolver'
      ]],
      ['docs/usage.md', [
        'ai-factory aifhub-write-gate-evidence --change add-oauth-login --gate rules',
        'ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run',
        'ai-factory aifhub-migrate-legacy-plans --all --dry-run',
        'ai-factory aifhub-done-finalizer --change <change-id> --json'
      ]],
      ['docs/openspec-validation.md', [
        'ai-factory aifhub-write-gate-evidence --change add-oauth-login --gate rules',
        'ai-factory aifhub-done-readiness --change <change-id> --json',
        'ai-factory aifhub-validate-artifacts --change <change-id> --json',
        'ai-factory aifhub-done-finalizer --change <change-id> --json',
        'Omitting `--change` delegates to the active-change resolver'
      ]],
      ['docs/openspec-compatibility.md', [
        'ai-factory aifhub-done-finalizer --change <change-id> --json'
      ]],
      ['docs/codex-agents.md', [
        'ai-factory aifhub-done-finalizer --change <change-id> --json'
      ]],
      ['docs/claude-agents.md', [
        'ai-factory aifhub-done-finalizer --change <change-id> --json'
      ]],
      ['skills/aif-done/SKILL.md', [
        'ai-factory aifhub-done-finalizer --change <change-id> --json'
      ]],
      ['skills/aif-done/references/finalization-contract.md', [
        'ai-factory aifhub-done-finalizer --change <change-id> --json'
      ]],
      ['agent-files/codex/aifhub-done-finalizer.toml', [
        'ai-factory aifhub-done-finalizer --change <change-id> --json'
      ]],
      ['agent-files/claude/aifhub-done-finalizer.md', [
        'ai-factory aifhub-done-finalizer --change <change-id> --json'
      ]],
      ['docs/spec-coverage.md', [
        'ai-factory aifhub-coverage --change <change-id> --write --json'
      ]],
      ['docs/handoff-validation-profile.md', [
        'ai-factory aifhub-handoff-gate-summary --change <change-id> --stage review --json'
      ]],
      ['docs/memory-tool-recommendations.md', [
        'ai-factory aifhub-memory-tools labels --from-project --json',
        'ai-factory aifhub-memory-tools recommend --from-project --json',
        'ai-factory aifhub-memory-tools recommend --command aif-analyze',
        'ai-factory aifhub-memory-tools status --json',
        'ai-factory aifhub-memory-tools metadata --json'
      ]],
      ['docs/legacy-plan-migration.md', [
        'ai-factory aifhub-migrate-legacy-plans --list',
        'ai-factory aifhub-migrate-legacy-plans <change-id> --on-collision merge-safe'
      ]],
      ['docs/active-change-resolver.md', [
        'ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run'
      ]],
      ['skills/aif-mode/SKILL.md', [
        'ai-factory aifhub-mode status',
        'ai-factory aifhub-migrate-legacy-plans --all --dry-run'
      ]],
      ['injections/core/aif-improve-plan-folder.md', [
        'ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run'
      ]],
      ['injections/core/aif-implement-plan-folder.md', [
        'ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run'
      ]],
      ['injections/core/aif-verify-plan-folder.md', [
        'ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run'
      ]],
      ['injections/core/aif-plan-plan-folder.md', [
        'ai-factory aifhub-mode status --json'
      ]],
      ['agent-files/codex/aifhub-plan-polisher.toml', [
        'ai-factory aifhub-mode status --json'
      ]],
      ['agent-files/claude/aifhub-plan-polisher.md', [
        'ai-factory aifhub-mode status --json'
      ]]
    ];

    for (const [relativePath, expectedFragments] of expectations) {
      const source = await readRepoFile(relativePath);
      for (const expected of expectedFragments) {
        assert.ok(source.includes(expected), `${relativePath} should include ${JSON.stringify(expected)}`);
      }
      assert.doesNotMatch(
        source,
        INSTALLED_FACING_ROOT_SCRIPT_RE,
        `${relativePath} should not expose root scripts as installed-project helper commands`
      );
    }
  });
});

function restoreEnvValue(key, value) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
