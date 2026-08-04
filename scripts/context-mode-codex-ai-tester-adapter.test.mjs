// context-mode-codex-ai-tester-adapter.test.mjs - issue #134 safety contracts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  CONTEXT_MODE_IDENTITY,
  ALLOWED_MCP_TOOLS,
  auditContextModeSnapshot,
  assertCanonicalConfinedPath,
  buildContextModeEnv,
  buildPinnedInstallInvocation,
  buildSandboxLayout,
  captureHostManifest,
  compareHostManifests,
  buildActualPluginPlan,
  parseCodexFeatureList,
  prepareActualPluginMarketplace,
  removeVerifiedSandbox,
  evaluateActualPluginEligibility,
  runDirectHookContract,
  runActualPluginLifecycle,
  runSandboxLifecycle,
  runMcpContract,
  validateNativeCodexExecutable
} from './context-mode-codex-ai-tester-adapter.mjs';

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'context-mode-codex-adapter-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('context-mode exact static identity', () => {
  it('pins the reviewed source and npm package without install lifecycle', () => {
    assert.deepEqual(CONTEXT_MODE_IDENTITY, {
      repository: 'https://github.com/mksglu/context-mode',
      tag: 'v1.0.169',
      commit: '589d8214d56740a28b5f7bf63167743d586b0b40',
      package: 'context-mode',
      version: '1.0.169',
      integrity: 'sha512-94JIaFuLjF9SO2BsGTrbGtyT44K95+9OC8BdbaL/UT76xOkanJLfUR5CzmNw+GELXZQqH4nBrKg9wjBnSFkVnQ==',
      shasum: 'd5aa9acc648ed420c5dd32ee5f15aa5608f09fea',
      license: 'Elastic-2.0',
      node: '>=22.5.0'
    });
    const invocation = buildPinnedInstallInvocation({
      npmCliPath: 'npm-cli.js',
      packageRoot: path.join(tempDir, 'package'),
      sandboxRoot: tempDir,
      baseEnv: { PATH: 'runtime', OPENAI_API_KEY: 'drop-me' }
    });
    assert.deepEqual(invocation.args.slice(1), [
      'install', '--prefix', path.join(tempDir, 'package'),
      '--ignore-scripts', '--no-audit', '--no-fund', 'context-mode@1.0.169'
    ]);
    assert.equal(invocation.env.npm_config_ignore_scripts, 'true');
    assert.equal(invocation.env.OPENAI_API_KEY, undefined);
    assert.equal(invocation.evidence_class, 'plugin_snapshot_isolated');
    assert.equal(invocation.install_lifecycle, 'NOT_RUN(postinstall_forbidden)');
  });

  it('audits exact manifests and records postinstall as forbidden without executing it', async () => {
    const packageRoot = await writePackageFixture(tempDir);
    const result = await auditContextModeSnapshot({
      packageRoot,
      source: {
        repository: CONTEXT_MODE_IDENTITY.repository,
        tag: CONTEXT_MODE_IDENTITY.tag,
        commit: CONTEXT_MODE_IDENTITY.commit
      },
      packageMeta: CONTEXT_MODE_IDENTITY
    });
    assert.equal(result.status, 'PASS');
    assert.equal(result.evidence_class, 'plugin_snapshot_isolated');
    assert.equal(result.install_lifecycle, 'NOT_RUN(postinstall_forbidden)');
    assert.deepEqual(result.manifests, ['plugin.json', 'mcp.json', 'hooks.json']);
    assert.ok(result.checked_contracts.includes('postinstall_present_and_suppressed'));
  });
});

describe('context-mode sandbox and lifecycle boundary', () => {
  it('keeps mutable roots under the sandbox and drops unknown credentials', () => {
    const layout = buildSandboxLayout(tempDir);
    const env = buildContextModeEnv({
      layout,
      baseEnv: {
        PATH: 'runtime',
        SystemRoot: 'windows',
        OPENAI_API_KEY: 'drop',
        GITHUB_TOKEN: 'drop',
        HTTPS_PROXY: 'drop',
        SSH_AUTH_SOCK: 'drop',
        DATABASE_URL: 'drop',
        UNKNOWN_VALUE: 'drop'
      }
    });
    for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CONTEXT_MODE_DIR', 'TEMP', 'TMP']) {
      const relative = path.relative(tempDir, env[key]);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), key);
    }
    assert.equal(env.PATH, 'runtime');
    for (const key of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'SSH_AUTH_SOCK', 'DATABASE_URL', 'UNKNOWN_VALUE']) {
      assert.equal(env[key], undefined, key);
    }
  });

  it('rejects lexical and canonical symlink escapes', async () => {
    await mkdir(path.join(tempDir, 'safe'), { recursive: true });
    assert.equal(
      await assertCanonicalConfinedPath(tempDir, path.join(tempDir, 'safe', 'child'), { allowMissingLeaf: true }),
      path.join(tempDir, 'safe', 'child')
    );
    await assert.rejects(
      assertCanonicalConfinedPath(tempDir, path.resolve(tempDir, '..', 'escape'), { allowMissingLeaf: true }),
      /unsafe_path/
    );
    const external = await mkdtemp(path.join(os.tmpdir(), 'context-mode-external-'));
    try {
      const link = path.join(tempDir, 'link');
      await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        assertCanonicalConfinedPath(tempDir, path.join(link, 'child'), { allowMissingLeaf: true }),
        /reparse_escape/
      );
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it('detects host manifest drift without persisting file bodies', async () => {
    const hostRoot = path.join(tempDir, 'host');
    await mkdir(path.join(hostRoot, '.git', 'hooks'), { recursive: true });
    await writeFile(path.join(hostRoot, '.git', 'config'), '[core]\n', 'utf8');
    const before = await captureHostManifest({
      projectRoot: hostRoot,
      codexHome: path.join(hostRoot, 'codex'),
      providerHome: path.join(hostRoot, 'provider')
    });
    await writeFile(path.join(hostRoot, '.git', 'config'), '[core]\nchanged=true\n', 'utf8');
    const after = await captureHostManifest({
      projectRoot: hostRoot,
      codexHome: path.join(hostRoot, 'codex'),
      providerHome: path.join(hostRoot, 'provider')
    });
    const comparison = compareHostManifests(before, after);
    assert.equal(comparison.status, 'FAIL');
    assert.deepEqual(comparison.changed, ['project_git_config']);
    assert.doesNotMatch(JSON.stringify(comparison), /changed=true/);
  });

  it('runs only the bounded MCP contract and requires confirmed purge', async () => {
    const calls = [];
    const callCounts = new Map();
    const result = await runMcpContract({
      artifact: {
        name: 'generated-output.txt',
        content: 'synthetic output north=17 east=29 checksum=46',
        sha256: 'expected',
        search_query: 'required facts',
        required_facts: ['north=17', 'east=29', 'checksum=46']
      },
      invokeTool: async (name, payload) => {
        calls.push({ name, payload: structuredClone(payload) });
        const count = (callCounts.get(name) ?? 0) + 1;
        callCounts.set(name, count);
        if (name === 'ctx_doctor') return mcpText('Server test: PASS\nFTS5 / SQLite: PASS\nVersion: v1.0.169');
        if (name === 'ctx_index') return mcpText('Indexed 1 sections from: generated-output.txt');
        if (name === 'ctx_search') return mcpText(count === 1
          ? 'generated-output.txt\nnorth=17\neast=29\nchecksum=46'
          : 'No indexed context or results');
        if (name === 'ctx_stats') return mcpText(count === 1 ? 'Indexed artifacts: 1' : 'Indexed artifacts: 0');
        return mcpText('Purged: project');
      },
      hashContent: () => 'expected'
    });
    assert.equal(result.status, 'PASS');
    assert.deepEqual(calls.map((item) => item.name), [
      ...ALLOWED_MCP_TOOLS,
      'ctx_search',
      'ctx_stats'
    ]);
    assert.deepEqual(Object.keys(calls.find((item) => item.name === 'ctx_index').payload).sort(), ['content', 'source']);
    assert.deepEqual(calls.filter((item) => item.name === 'ctx_search').map((item) => item.payload), [
      { queries: ['required facts'], limit: 5 },
      { queries: ['required facts'], limit: 5 }
    ]);
    assert.ok(calls.filter((item) => item.name === 'ctx_search').every((item) => item.payload.query === undefined));
    assert.doesNotMatch(JSON.stringify(result), /synthetic output/);
    await assert.rejects(
      runMcpContract({
        artifact: { name: 'src/index.mjs', content: 'x', sha256: 'x', search_query: 'x', required_facts: ['x'] },
        invokeTool: async () => mcpText('ok'),
        hashContent: () => 'x'
      }),
      /artifact_not_allowlisted/
    );
  });

  it('fails MCP evidence when any required stage or exact search fingerprint fails', async () => {
    const artifact = {
      name: 'generated-output.txt',
      content: 'synthetic output north=17',
      sha256: 'expected',
      search_query: 'required facts',
      required_facts: ['north=17']
    };
    const failedStage = await runMcpContract({
      artifact,
      invokeTool: async (name) => {
        if (name === 'ctx_purge') return mcpText('Purged: project');
        if (name === 'ctx_search') return mcpText('No indexed context or results');
        if (name === 'ctx_stats') return mcpText('Indexed artifacts: 0');
        return { content: [], isError: true };
      },
      hashContent: () => 'expected'
    });
    assert.equal(failedStage.status, 'FAIL');
    assert.equal(failedStage.reason, 'ctx_doctor_contract_failed');

    const counts = new Map();
    const wrongSearch = await runMcpContract({
      artifact,
      invokeTool: async (name) => {
        const count = (counts.get(name) ?? 0) + 1;
        counts.set(name, count);
        if (name === 'ctx_doctor') return mcpText('Server test: PASS\nFTS5 / SQLite: PASS\nVersion: v1.0.169');
        if (name === 'ctx_index') return mcpText('Indexed 1 sections from: generated-output.txt');
        if (name === 'ctx_search') return mcpText(count === 1 ? 'generated-output.txt\nnorth=18' : 'No indexed context or results');
        if (name === 'ctx_stats') return mcpText('Indexed artifacts: 0');
        return mcpText('Purged: project');
      },
      hashContent: () => 'expected'
    });
    assert.equal(wrongSearch.status, 'FAIL');
    assert.equal(wrongSearch.reason, 'ctx_search_contract_failed');

    const residualCounts = new Map();
    const misleadingResidual = await runMcpContract({
      artifact,
      invokeTool: async (name) => {
        const count = (residualCounts.get(name) ?? 0) + 1;
        residualCounts.set(name, count);
        if (name === 'ctx_doctor') return mcpText('Server test: PASS\nFTS5 / SQLite: PASS\nVersion: v1.0.169');
        if (name === 'ctx_index') return mcpText('Indexed 1 sections from: generated-output.txt');
        if (name === 'ctx_search') return mcpText(count === 1 ? 'generated-output.txt\nnorth=17' : 'No indexed context or results');
        if (name === 'ctx_stats') return mcpText(count === 1 ? 'Indexed artifacts: 1' : 'Indexed artifacts: 1\nErrors: 0');
        return mcpText('Purged: project');
      },
      hashContent: () => 'expected'
    });
    assert.equal(misleadingResidual.status, 'FAIL');
    assert.equal(misleadingResidual.reason, 'provider_purge_residual');
  });

  it('binds recursive cleanup to an explicit owner and runs it after PASS, FAIL and timeout', async () => {
    const ownerRoot = path.join(tempDir, 'owned');
    await mkdir(ownerRoot, { recursive: true });
    for (const outcome of ['PASS', 'FAIL', 'process_timeout']) {
      const sandboxRoot = path.join(ownerRoot, `sandbox-${outcome.toLowerCase()}`);
      await mkdir(sandboxRoot, { recursive: true });
      await writeFile(path.join(sandboxRoot, 'state.json'), '{}', 'utf8');
      const logs = [];
      const result = await runSandboxLifecycle({
        ownerRoot,
        sandboxRoot,
        run: async () => {
          if (outcome === 'process_timeout') {
            const error = new Error('process_timeout');
            error.code = 'process_timeout';
            throw error;
          }
          return { status: outcome };
        },
        purge: async () => ({ status: 'PASS' }),
        logger: (line) => logs.push(line)
      });
      assert.equal(result.status, outcome === 'PASS' ? 'PASS' : 'FAIL');
      assert.equal(result.cleanup, 'PASS');
      assert.equal(result.purge, 'PASS');
      await assert.rejects(readFile(path.join(sandboxRoot, 'state.json'), 'utf8'));
      assert.match(logs.join('\n'), /\[FIX:134\] sandbox_cleanup_pass /);
      assert.doesNotMatch(logs.join('\n'), /context-mode-codex-adapter-/);
    }

    const external = path.join(tempDir, 'external');
    await mkdir(external, { recursive: true });
    await assert.rejects(
      removeVerifiedSandbox({ ownerRoot, sandboxRoot: external }),
      /unsafe_delete_target|unsafe_path/
    );
  });

  it('labels deterministic direct hooks separately from actual Codex delivery', async () => {
    const events = [];
    const result = await runDirectHookContract({
      invokeHook: async (event) => {
        events.push(event);
        return { redacted: true, recovered: true, isolated: true };
      }
    });
    assert.equal(result.status, 'PASS');
    assert.equal(result.evidence_class, 'direct_hook_contract');
    assert.deepEqual(events, ['UserPromptSubmit', 'PostToolUse', 'PreCompact', 'SessionStart', 'Stop']);
    assert.equal(result.actual_codex_delivery, 'NOT_RUN(direct_entrypoint_only)');
  });

  it('fails actual plugin execution closed when isolated auth is unavailable', () => {
    assert.deepEqual(
      evaluateActualPluginEligibility({
        codexVersion: 'codex-cli 0.144.6',
        supportedFeatures: ['hooks', 'plugins'],
        authMode: 'none'
      }),
      {
        status: 'NOT_RUN',
        reason: 'auth_isolation_unavailable',
        codex_version: 'codex-cli 0.144.6',
        supported_features: ['hooks', 'plugins'],
        trust_mode: 'isolated_local_marketplace'
      }
    );
  });

  it('uses only supported current feature names in an isolated local marketplace plan', () => {
    assert.deepEqual(
      parseCodexFeatureList('hooks stable true\nplugins stable true\nplugin_hooks removed false\nunknown experimental false'),
      ['hooks', 'plugins']
    );
    const layout = buildSandboxLayout(tempDir);
    const plan = buildActualPluginPlan({
      layout,
      packageRoot: path.join(layout.package, 'node_modules', 'context-mode'),
      codexExecutable: path.join(tempDir, 'codex.exe'),
      codexVersion: 'codex-cli 0.144.6',
      supportedFeatures: ['hooks', 'plugins'],
      authMode: 'none'
    });
    assert.equal(plan.status, 'NOT_RUN');
    assert.equal(plan.reason, 'auth_isolation_unavailable');
    assert.equal(plan.env.CODEX_HOME, layout.codex_home);
    assert.equal(plan.env.OPENAI_API_KEY, undefined);
    assert.doesNotMatch(JSON.stringify(plan), /plugin_hooks/);
    assert.match(plan.marketplace_manifest, /marketplace\.json$/);
    assert.match(plan.marketplace_manifest, /\.agents[\\/]plugins[\\/]marketplace\.json$/);
    assert.deepEqual(plan.steps[0].args, ['plugin', 'marketplace', 'add', layout.marketplace, '--json']);
  });

  it('requires an explicit native Codex executable before eligible plugin lifecycle', () => {
    assert.deepEqual(validateNativeCodexExecutable('codex'), {
      status: 'NOT_RUN',
      reason: 'native_codex_executable_required'
    });
    assert.deepEqual(validateNativeCodexExecutable('C:/tools/codex.cmd', { platform: 'win32' }), {
      status: 'NOT_RUN',
      reason: 'native_codex_executable_required'
    });
    assert.equal(validateNativeCodexExecutable('C:/tools/codex.exe', { platform: 'win32' }).status, 'PASS');
    assert.equal(validateNativeCodexExecutable('/usr/local/bin/codex', { platform: 'linux' }).status, 'PASS');

    const layout = buildSandboxLayout(tempDir);
    const plan = buildActualPluginPlan({
      layout,
      sandboxOwnerRoot: tempDir,
      packageRoot: path.join(layout.package, 'node_modules', 'context-mode'),
      codexExecutable: 'codex.cmd',
      codexVersion: 'codex-cli 0.144.6',
      supportedFeatures: ['hooks', 'plugins'],
      authMode: 'scoped_ephemeral'
    });
    assert.equal(plan.status, 'NOT_RUN');
    assert.equal(plan.reason, 'native_codex_executable_required');
  });

  it('never mutates plugin state when preflight is NOT_RUN and executes only an eligible isolated plan', async () => {
    const layout = buildSandboxLayout(tempDir);
    const blocked = buildActualPluginPlan({
      layout,
      packageRoot: path.join(layout.package, 'node_modules', 'context-mode'),
      codexExecutable: path.join(tempDir, 'codex.exe'),
      codexVersion: 'codex-cli 0.144.6',
      supportedFeatures: ['hooks', 'plugins'],
      authMode: 'none'
    });
    let calls = 0;
    assert.equal((await runActualPluginLifecycle({
      plan: blocked,
      runProcess: async () => { calls += 1; return { exitCode: 0 }; }
    })).reason, 'auth_isolation_unavailable');
    assert.equal(calls, 0);

    const ownerRoot = path.join(tempDir, 'owned-plugin-run');
    const sandboxRoot = path.join(ownerRoot, 'sandbox');
    await mkdir(sandboxRoot, { recursive: true });
    const isolatedLayout = buildSandboxLayout(sandboxRoot);
    const packageRoot = await writePackageFixture(path.join(sandboxRoot, 'plugin-source'));
    const eligible = buildActualPluginPlan({
      layout: isolatedLayout,
      sandboxOwnerRoot: ownerRoot,
      packageRoot,
      codexExecutable: path.join(tempDir, 'codex.exe'),
      codexVersion: 'codex-cli 0.144.6',
      supportedFeatures: ['hooks', 'plugins'],
      authMode: 'scoped_ephemeral'
    });
    const hostManifestTargets = {
      projectRoot: path.join(tempDir, 'real-project'),
      codexHome: path.join(tempDir, 'real-codex-home'),
      providerHome: path.join(tempDir, 'real-provider-home')
    };
    let missingBoundaryCalls = 0;
    const missingBoundary = await runActualPluginLifecycle({
      plan: eligible,
      purgeProvider: async () => ({ status: 'PASS' }),
      runProcess: async () => { missingBoundaryCalls += 1; return { exitCode: 0 }; }
    });
    assert.equal(missingBoundary.status, 'NOT_RUN');
    assert.equal(missingBoundary.reason, 'host_manifest_boundary_unavailable');
    assert.equal(missingBoundaryCalls, 0);
    await assert.rejects(
      prepareActualPluginMarketplace({
        ...eligible,
        package_root: path.resolve(tempDir, '..', 'outside-package')
      }),
      /unsafe_path/
    );
    const childOptions = [];
    const result = await runActualPluginLifecycle({
      plan: eligible,
      hostManifestTargets,
      purgeProvider: async () => ({ status: 'PASS' }),
      runProcess: async (_command, args, options) => {
        calls += 1;
        childOptions.push(options);
        return { exitCode: 0, stdout: args.includes('exec') ? '{"type":"turn.completed"}' : '{}', stderr: '' };
      }
    });
    assert.equal(result.status, 'PASS');
    assert.equal(result.purge, 'PASS');
    assert.equal(result.cleanup, 'PASS');
    assert.deepEqual(result.host_manifest, { status: 'PASS', changed: [] });
    assert.equal(calls, 3);
    assert.ok(childOptions.every((options) => options.cwd === eligible.working_directory));
    assert.ok(path.relative(sandboxRoot, eligible.working_directory) &&
      !path.relative(sandboxRoot, eligible.working_directory).startsWith('..'));
    assert.deepEqual(result.phases, ['marketplace_prepare', 'marketplace_add', 'plugin_add', 'codex_exec']);
    await assert.rejects(readFile(eligible.marketplace_manifest, 'utf8'));
  });

  it('fails actual plugin evidence when a real host manifest changes during the lifecycle', async () => {
    const ownerRoot = path.join(tempDir, 'owned-plugin-drift');
    const sandboxRoot = path.join(ownerRoot, 'sandbox');
    const hostProject = path.join(tempDir, 'real-project-drift');
    await mkdir(sandboxRoot, { recursive: true });
    await mkdir(path.join(hostProject, '.git', 'hooks'), { recursive: true });
    await writeFile(path.join(hostProject, '.git', 'config'), '[core]\n', 'utf8');
    const layout = buildSandboxLayout(sandboxRoot);
    const packageRoot = await writePackageFixture(path.join(sandboxRoot, 'plugin-source'));
    const plan = buildActualPluginPlan({
      layout,
      sandboxOwnerRoot: ownerRoot,
      packageRoot,
      codexExecutable: path.join(tempDir, 'codex.exe'),
      codexVersion: 'codex-cli 0.144.6',
      supportedFeatures: ['hooks', 'plugins'],
      authMode: 'scoped_ephemeral'
    });
    let changed = false;
    const result = await runActualPluginLifecycle({
      plan,
      hostManifestTargets: {
        projectRoot: hostProject,
        codexHome: path.join(tempDir, 'real-codex-drift'),
        providerHome: path.join(tempDir, 'real-provider-drift')
      },
      purgeProvider: async () => ({ status: 'PASS' }),
      runProcess: async () => {
        if (!changed) {
          changed = true;
          await writeFile(path.join(hostProject, '.git', 'config'), '[core]\nchanged=true\n', 'utf8');
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      }
    });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.reason, 'host_manifest_drift');
    assert.deepEqual(result.host_manifest, { status: 'FAIL', changed: ['project_git_config'] });
    assert.equal(result.cleanup, 'PASS');
  });
});

async function writePackageFixture(root) {
  const packageRoot = path.join(root, 'package');
  await mkdir(path.join(packageRoot, '.codex-plugin'), { recursive: true });
  await mkdir(path.join(packageRoot, 'hooks', 'codex'), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'context-mode',
    version: '1.0.169',
    license: 'Elastic-2.0',
    engines: { node: '>=22.5.0' },
    scripts: { postinstall: 'node scripts/postinstall.mjs' }
  }), 'utf8');
  await writeFile(path.join(packageRoot, '.codex-plugin', 'plugin.json'), '{"name":"context-mode"}', 'utf8');
  await writeFile(path.join(packageRoot, '.codex-plugin', 'mcp.json'), '{"command":"node","args":["./start.mjs"]}', 'utf8');
  await writeFile(path.join(packageRoot, '.codex-plugin', 'hooks.json'), JSON.stringify({
    hooks: ['UserPromptSubmit', 'PostToolUse', 'PreCompact', 'SessionStart', 'Stop']
  }), 'utf8');
  await writeFile(path.join(packageRoot, 'start.mjs'), '', 'utf8');
  await writeFile(path.join(packageRoot, 'hooks', 'codex', 'entry.mjs'), '', 'utf8');
  return packageRoot;
}

function mcpText(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}
