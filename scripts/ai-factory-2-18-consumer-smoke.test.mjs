// ai-factory-2-18-consumer-smoke.test.mjs - offline install/update contract coverage
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AI_FACTORY_2181_EXPLORE_SENTINELS,
  EXPECTED_AI_FACTORY_VERSIONS,
  SMOKE_STATUS,
  aiFactoryVersionIncludesTransfer,
  buildNoShellInvocation,
  createNoShellProcessRunner,
  createTemporaryWorkspaceFactory,
  runAiFactory218ConsumerSmoke,
  summarizeSmokeResult
} from './ai-factory-2-18-consumer-smoke.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const tempRoots = [];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function createTempRoot(prefix = 'aifhub-218-consumer-test-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeFixture(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeManifestPath(value) {
  return String(value).replace(/^\.\//, '').replaceAll('\\', '/');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fakeExploreBase(version) {
  if (version !== EXPECTED_AI_FACTORY_VERSIONS.v218) {
    return `---\nname: aif-explore\ndescription: Fake AI Factory ${version} base skill.\nallowed-tools: Read\n---\n\n# aif-explore\n`;
  }
  return [
    '---',
    'name: aif-explore',
    `description: Fake AI Factory ${version} base skill.`,
    'allowed-tools: Read Task',
    '---',
    '',
    '# aif-explore',
    '### Persist exploration context',
    AI_FACTORY_2181_EXPLORE_SENTINELS.coherenceHeading,
    '',
    'Delegate the read-only pass to a fresh-context subagent when supported.',
    AI_FACTORY_2181_EXPLORE_SENTINELS.ultraHeading,
    '',
    AI_FACTORY_2181_EXPLORE_SENTINELS.bundleIntegrityOrdering,
    ''
  ].join('\n');
}

async function createFakeToolchain(root, key, version) {
  const packageRoot = path.join(root, `ai-factory-${version}`);
  const entrypoint = await writeFixture(
    packageRoot,
    'bin/ai-factory.js',
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`
  );
  await writeJson(path.join(packageRoot, 'package.json'), {
    name: 'ai-factory',
    version,
    type: 'module',
    bin: { 'ai-factory': './bin/ai-factory.js' }
  });
  await writeFixture(packageRoot, 'skills/aif-explore/SKILL.md', fakeExploreBase(version));
  return {
    key,
    command: process.execPath,
    argv: [entrypoint],
    provenanceRoot: packageRoot
  };
}

async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

async function ensureBaseSkill(projectDir, skillName, version) {
  const content = skillName === 'aif-explore'
    ? fakeExploreBase(version)
    : `---\nname: ${skillName}\ndescription: Fake AI Factory ${version} base skill.\n---\n\n# ${skillName}\n`;
  await writeFixture(
    projectDir,
    `.codex/skills/${skillName}/SKILL.md`,
    content
  );
}

async function applyFakeInjection(projectDir, extensionName, injection, extensionRoot) {
  const targetPath = path.join(projectDir, '.codex', 'skills', injection.target, 'SKILL.md');
  let target = await readFile(targetPath, 'utf8');
  const source = await readFile(path.resolve(extensionRoot, normalizeManifestPath(injection.file)), 'utf8');
  const start = `<!-- aif-ext:${extensionName}:${injection.target}:${injection.position}:start -->`;
  const end = `<!-- aif-ext:${extensionName}:${injection.target}:${injection.position}:end -->`;
  const existing = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\s*`, 'g');
  target = target.replace(existing, '');
  const block = `${start}\n${source.trim()}\n${end}\n\n`;
  target = injection.position === 'append' ? `${target.trimEnd()}\n\n${block}` : `${block}${target}`;
  await writeFile(targetPath, target, 'utf8');
}

async function copyReferencedAsset(sourceRoot, installedRoot, relativePath) {
  const normalized = normalizeManifestPath(relativePath);
  const source = path.resolve(sourceRoot, normalized);
  const target = path.resolve(installedRoot, normalized);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function installFakeExtension(projectDir, sourceRoot) {
  const manifest = await readJson(path.join(sourceRoot, 'extension.json'));
  const ledgerPath = path.join(projectDir, '.ai-factory.json');
  const ledger = await readJson(ledgerPath);
  const codex = ledger.agents.find((entry) => entry.id === 'codex');
  const installedRoot = path.join(projectDir, '.ai-factory', 'extensions', manifest.name);
  await rm(installedRoot, { recursive: true, force: true });
  await mkdir(installedRoot, { recursive: true });
  await cp(path.join(sourceRoot, 'extension.json'), path.join(installedRoot, 'extension.json'));

  const assetPaths = new Set([
    ...(manifest.skills ?? []),
    ...(manifest.injections ?? []).map((entry) => entry.file),
    ...(manifest.agentFiles ?? []).map((entry) => entry.source)
  ]);
  for (const assetPath of assetPaths) {
    await copyReferencedAsset(sourceRoot, installedRoot, assetPath);
  }

  for (const skillPath of manifest.skills ?? []) {
    const skillName = path.basename(normalizeManifestPath(skillPath));
    const target = path.join(projectDir, '.codex', 'skills', skillName);
    await rm(target, { recursive: true, force: true });
    await cp(path.resolve(sourceRoot, normalizeManifestPath(skillPath)), target, { recursive: true });
    if (!codex.installedSkills.includes(skillName)) codex.installedSkills.push(skillName);
  }

  for (const agentFile of (manifest.agentFiles ?? []).filter((entry) => entry.runtime === 'codex')) {
    const source = path.resolve(sourceRoot, normalizeManifestPath(agentFile.source));
    const target = path.join(projectDir, codex.agentsDir, agentFile.target);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { force: true });
    const digest = await hashFile(source);
    if (!codex.installedAgentFiles.includes(agentFile.target)) codex.installedAgentFiles.push(agentFile.target);
    codex.agentFileSources[agentFile.target] = {
      kind: 'extension',
      sourcePath: agentFile.source,
      extensionName: manifest.name
    };
    codex.managedAgentFiles[agentFile.target] = {
      sourceHash: digest,
      installedHash: digest
    };
  }

  for (const injection of manifest.injections ?? []) {
    await applyFakeInjection(projectDir, manifest.name, injection, sourceRoot);
  }

  const existingIndex = (ledger.extensions ?? []).findIndex((entry) => entry.name === manifest.name);
  const record = {
    name: manifest.name,
    version: manifest.version,
    source: sourceRoot,
    replacedSkills: []
  };
  if (existingIndex >= 0) ledger.extensions[existingIndex] = record;
  else ledger.extensions.push(record);
  codex.installedSkills.sort();
  codex.installedAgentFiles.sort();
  await writeJson(ledgerPath, ledger);
}

async function fakeInit(projectDir, version, cliArgs, manifest) {
  const skillsIndex = cliArgs.indexOf('--skills');
  const requested = skillsIndex >= 0 ? cliArgs[skillsIndex + 1] : 'all';
  const injectionTargets = [...new Set((manifest.injections ?? []).map((entry) => entry.target))].sort();
  const selectedSkills = requested === 'all'
    ? [...new Set([...injectionTargets, 'aif-loop', ...(aiFactoryVersionIncludesTransfer(version) ? ['aif-transfer'] : [])])].sort()
    : requested.split(',').filter(Boolean).sort();
  for (const skillName of selectedSkills) await ensureBaseSkill(projectDir, skillName, version);
  await mkdir(path.join(projectDir, '.codex', 'agents'), { recursive: true });
  await writeFixture(
    projectDir,
    '.ai-factory/config.yaml',
    'version: 1\npaths:\n  plans: .ai-factory/plans\n  tasks: .ai-factory/tasks\n  research: .ai-factory/RESEARCH.md\n'
  );
  await writeJson(path.join(projectDir, '.ai-factory.json'), {
    version,
    agents: [{
      id: 'codex',
      skillsDir: '.codex/skills',
      installedSkills: selectedSkills,
      managedSkills: {},
      agentsDir: '.codex/agents',
      installedAgentFiles: [],
      agentFileSources: {},
      managedAgentFiles: {},
      mcp: {}
    }],
    extensions: []
  });
}

async function fakeOpenSpecMode(projectDir) {
  const configPath = path.join(projectDir, '.ai-factory', 'config.yaml');
  const current = await readFile(configPath, 'utf8');
  const withoutAifhub = current.replace(/\naifhub:\n(?:  .*\n)*/g, '\n');
  await writeFile(
    configPath,
    `${withoutAifhub.trimEnd()}\naifhub:\n  artifactProtocol: openspec\n  openspec:\n    installSkills: false\n`,
    'utf8'
  );
}

function successfulProcess(stdout = '') {
  return {
    exitCode: 0,
    processCode: null,
    signal: null,
    timedOut: false,
    stdout,
    stderr: '',
    adapter: 'injected-fake-executor',
    shell: false
  };
}

function createFakeExecutor({ manifest, trace = [], reportedVersions = {}, failWhen, targetedNoop = false } = {}) {
  const calls = [];
  const runner = async (request) => {
    const cliArgs = request.cliArgs ?? [];
    const call = { toolchain: request.logicalToolchain, cliArgs: [...cliArgs] };
    calls.push(call);
    trace.push({ type: 'command', ...call });
    const failure = failWhen?.(call);
    if (failure) return failure;

    const version = request.logicalToolchain === 'v217'
      ? EXPECTED_AI_FACTORY_VERSIONS.v217
      : EXPECTED_AI_FACTORY_VERSIONS.v218;
    if (cliArgs.length === 1 && cliArgs[0] === '--version') {
      return successfulProcess(`${reportedVersions[request.logicalToolchain] ?? version}\n`);
    }
    if (cliArgs[0] === 'init') {
      await fakeInit(request.cwd, version, cliArgs, manifest);
      return successfulProcess();
    }
    if (cliArgs[0] === 'aifhub-mode' && cliArgs[1] === 'openspec') {
      await fakeOpenSpecMode(request.cwd);
      return successfulProcess('{"mode":"openspec"}\n');
    }
    if (cliArgs[0] === 'extension' && cliArgs[1] === 'add') {
      await installFakeExtension(request.cwd, cliArgs[2]);
      return successfulProcess();
    }
    if (cliArgs[0] === 'update' && cliArgs[1] === '--force') {
      const ledgerPath = path.join(request.cwd, '.ai-factory.json');
      const ledger = await readJson(ledgerPath);
      ledger.version = EXPECTED_AI_FACTORY_VERSIONS.v218;
      await writeJson(ledgerPath, ledger);
      const injectionTargets = [...new Set((manifest.injections ?? []).map((entry) => entry.target))].sort();
      for (const skillName of injectionTargets) {
        await ensureBaseSkill(request.cwd, skillName, EXPECTED_AI_FACTORY_VERSIONS.v218);
      }
      trace.push({
        type: 'base-refresh-complete',
        version: EXPECTED_AI_FACTORY_VERSIONS.v218,
        skills: injectionTargets
      });
      for (const extension of ledger.extensions) {
        trace.push({ type: 'extension-reapply-start', name: extension.name });
        await installFakeExtension(request.cwd, extension.source);
      }
      return successfulProcess();
    }
    if (
      cliArgs[0] === 'extension'
      && cliArgs[1] === 'update'
      && cliArgs[2] === 'aifhub-extension'
      && cliArgs[3] === '--force'
    ) {
      if (!targetedNoop) {
        const ledger = await readJson(path.join(request.cwd, '.ai-factory.json'));
        const record = ledger.extensions.find((entry) => entry.name === 'aifhub-extension');
        await installFakeExtension(request.cwd, record.source);
      }
      return successfulProcess();
    }
    return {
      ...successfulProcess(),
      exitCode: 1,
      stderr: `Unsupported fake command: ${cliArgs.join(' ')}`
    };
  };
  runner.calls = calls;
  return runner;
}

async function createHarness({ reportedVersions, failWhen, targetedNoop = false } = {}) {
  const root = await createTempRoot();
  const manifest = await readJson(path.join(REPO_ROOT, 'extension.json'));
  const toolchains = {
    v217: await createFakeToolchain(root, 'v217', EXPECTED_AI_FACTORY_VERSIONS.v217),
    v218: await createFakeToolchain(root, 'v218', EXPECTED_AI_FACTORY_VERSIONS.v218)
  };
  const trace = [];
  const runner = createFakeExecutor({ manifest, trace, reportedVersions, failWhen, targetedNoop });
  const baseFactory = createTemporaryWorkspaceFactory({ temporaryRoot: root });
  const workspaceFactory = async (label) => {
    trace.push({ type: 'workspace', label });
    return baseFactory(label);
  };
  return { root, manifest, toolchains, trace, runner, workspaceFactory };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AI Factory 2.18 consumer compatibility smoke', () => {
  it('uses injected 2.17.0/2.18.1 executors for clean, global, and exact targeted update contracts', async () => {
    const harness = await createHarness();
    const result = await runAiFactory218ConsumerSmoke({
      toolchains: harness.toolchains,
      extensionRoot: REPO_ROOT,
      runner: harness.runner,
      workspaceFactory: harness.workspaceFactory,
      timeoutMs: 5_000,
      networkEnabled: false,
      evidence: 'deterministic'
    });

    assert.equal(result.status, SMOKE_STATUS.PASS);
    assert.equal(result.evidence, 'deterministic');
    assert.equal(result.provesReleaseOrDeployment, false);
    assert.equal(result.versions.v217.reported, '2.17.0');
    assert.equal(result.versions.v218.expected, '2.18.1');
    assert.equal(result.versions.v218.reported, '2.18.1');
    assert.equal(result.versions.v218.provenance.packageVersion, '2.18.1');
    assert.equal(result.flows.cleanInstall.status, SMOKE_STATUS.PASS);
    assert.equal(result.flows.globalUpdate.status, SMOKE_STATUS.PASS);
    assert.equal(result.flows.targetedUpdate.status, SMOKE_STATUS.PASS);
    assert.equal(result.flows.cleanInstall.transfer.fileCount, 1);
    assert.equal(result.flows.cleanInstall.transfer.owner, 'upstream');
    assert.equal(result.flows.globalUpdate.transfer.fileCount, 0);
    assert.equal(result.flows.globalUpdate.transfer.owner, 'not-selected');
    assert.equal(result.flows.targetedUpdate.transfer.fileCount, 0);
    for (const flow of ['cleanInstall', 'globalUpdate', 'targetedUpdate']) {
      assert.deepEqual(result.flows[flow].upstreamExplore, {
        upstreamVersion: '2.18.1',
        injectionMarkerCount: 1,
        coherenceHeadingCount: 1,
        taskCapabilityCount: 1,
        bundleIntegrityOrderingCount: 1,
        upstreamDigest: result.flows.cleanInstall.upstreamExplore.upstreamDigest
      });
    }
    assert.equal(result.flows.globalUpdate.preservation.artifactCount, 8);
    assert.equal(result.flows.targetedUpdate.preservation.artifactCount, 8);
    const expectedArtifactShapes = {
      classic: {
        shape: 'classic-pair',
        planDir: '.ai-factory/plans/classic-smoke',
        companionCount: 1
      },
      ultra: {
        shape: 'ultra-valid',
        markerCount: 1,
        phaseCount: 1
      }
    };
    assert.deepEqual(result.flows.globalUpdate.preservation.artifactShapes, expectedArtifactShapes);
    assert.deepEqual(result.flows.targetedUpdate.preservation.artifactShapes, expectedArtifactShapes);
    assert.notEqual(result.flows.targetedUpdate.staleHash, result.flows.targetedUpdate.targetHash);
    assert.equal(result.flows.targetedUpdate.sourceHash, result.flows.targetedUpdate.targetHash);
    assert.deepEqual(result.flows.targetedUpdate.exactCommand, [
      'extension',
      'update',
      'aifhub-extension',
      '--force'
    ]);

    const identityEvent = result.events.find((entry) => entry.step === 'identity-complete-before-project-mutation');
    const cleanInitEvent = result.events.find((entry) => entry.step === 'init-2.18');
    const preservationSnapshot = result.events.find((entry) => entry.step === 'preservation-snapshot');
    const globalRecorded = result.events.find((entry) => entry.step === 'contract-assertions-recorded');
    const dummyAdd = result.events.find((entry) => entry.step === 'dummy-extension-add-after-global');
    const staleEvent = result.events.find((entry) => entry.step === 'dummy-snapshotted-and-agent-staled');
    const targetedCommand = result.events.find((entry) => entry.step === 'exact-targeted-extension-update');
    assert.ok(identityEvent.sequence < cleanInitEvent.sequence);
    assert.equal(preservationSnapshot.logPrefix, '[FIX:issue-152]');
    assert.deepEqual(preservationSnapshot.artifactShapes, expectedArtifactShapes);
    assert.ok(globalRecorded.sequence < dummyAdd.sequence);
    assert.ok(dummyAdd.sequence < staleEvent.sequence);
    assert.ok(staleEvent.sequence < targetedCommand.sequence);

    const firstWorkspaceIndex = harness.trace.findIndex((entry) => entry.type === 'workspace');
    assert.deepEqual(harness.trace.slice(0, firstWorkspaceIndex).map((entry) => entry.cliArgs), [
      ['--version'],
      ['--version']
    ]);
    const exactTargetedCalls = harness.runner.calls.filter((entry) => (
      entry.toolchain === 'v218'
      && entry.cliArgs.join('\0') === ['extension', 'update', 'aifhub-extension', '--force'].join('\0')
    ));
    assert.equal(exactTargetedCalls.length, 1);
    const baseRefreshIndex = harness.trace.findIndex((entry) => entry.type === 'base-refresh-complete');
    const extensionReapplyIndex = harness.trace.findIndex((entry) => entry.type === 'extension-reapply-start');
    assert.ok(baseRefreshIndex >= 0);
    assert.ok(baseRefreshIndex < extensionReapplyIndex, 'Global update must refresh the current base before reapplying injections.');
    assert.equal(
      harness.runner.calls.some((entry) => ['npm', 'npx', 'pnpm', 'yarn'].includes(entry.cliArgs[0])),
      false,
      'The harness must not acquire or download toolchains.'
    );

    const serialized = JSON.stringify(summarizeSmokeResult(result));
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(harness.root), 'i'));
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(REPO_ROOT), 'i'));
  });

  it('keeps 2.18.0 as the stable transfer boundary while targeting 2.18.1', () => {
    assert.equal(EXPECTED_AI_FACTORY_VERSIONS.v218Boundary, '2.18.0');
    assert.equal(EXPECTED_AI_FACTORY_VERSIONS.v218, '2.18.1');
    assert.equal(aiFactoryVersionIncludesTransfer('2.17.0'), false);
    assert.equal(aiFactoryVersionIncludesTransfer('2.18.0'), true);
    assert.equal(aiFactoryVersionIncludesTransfer('2.18.1'), true);
    assert.equal(aiFactoryVersionIncludesTransfer('2.19.0'), true);
    assert.equal(aiFactoryVersionIncludesTransfer('2.18.1-rc.1'), false);
    assert.equal(aiFactoryVersionIncludesTransfer('latest'), false);
  });

  it('reports exact version mismatch as NOT_RUN before creating a consumer project', async () => {
    const harness = await createHarness({ reportedVersions: { v217: '2.17.1' } });
    const result = await runAiFactory218ConsumerSmoke({
      toolchains: harness.toolchains,
      extensionRoot: REPO_ROOT,
      runner: harness.runner,
      workspaceFactory: harness.workspaceFactory,
      timeoutMs: 5_000,
      evidence: 'deterministic'
    });

    assert.equal(result.status, SMOKE_STATUS.NOT_RUN);
    assert.equal(result.failure.flow, 'preflight');
    assert.equal(result.failure.code, 'v217-reported-version-mismatch');
    assert.equal(harness.trace.some((entry) => entry.type === 'workspace'), false);
    assert.deepEqual(harness.runner.calls.map((entry) => entry.cliArgs), [['--version']]);
  });

  it('reports a missing local prerequisite as NOT_RUN and never invokes a downloader', async () => {
    const harness = await createHarness();
    harness.toolchains.v218.command = path.join(harness.root, 'missing-node-executable');
    const result = await runAiFactory218ConsumerSmoke({
      toolchains: harness.toolchains,
      extensionRoot: REPO_ROOT,
      runner: harness.runner,
      workspaceFactory: harness.workspaceFactory,
      timeoutMs: 5_000,
      evidence: 'deterministic'
    });

    assert.equal(result.status, SMOKE_STATUS.NOT_RUN);
    assert.equal(result.failure.code, 'missing-v218-command');
    assert.equal(harness.runner.calls.length, 0);
    assert.equal(harness.trace.some((entry) => entry.type === 'workspace'), false);
  });

  it('rejects mismatched package provenance before executing either toolchain', async () => {
    const harness = await createHarness();
    const packagePath = path.join(harness.toolchains.v217.provenanceRoot, 'package.json');
    const packageJson = await readJson(packagePath);
    packageJson.version = '2.17.1';
    await writeJson(packagePath, packageJson);
    const result = await runAiFactory218ConsumerSmoke({
      toolchains: harness.toolchains,
      extensionRoot: REPO_ROOT,
      runner: harness.runner,
      workspaceFactory: harness.workspaceFactory,
      timeoutMs: 5_000,
      evidence: 'deterministic'
    });

    assert.equal(result.status, SMOKE_STATUS.NOT_RUN);
    assert.equal(result.failure.flow, 'preflight');
    assert.equal(result.failure.code, 'v217-provenance-mismatch');
    assert.equal(harness.runner.calls.length, 0);
    assert.equal(harness.trace.some((entry) => entry.type === 'workspace'), false);
  });

  it('attributes registry transport failure to global update and does not start targeted update', async () => {
    const harness = await createHarness({
      failWhen: ({ cliArgs }) => cliArgs.join(' ') === 'update --force'
        ? {
            exitCode: 1,
            processCode: null,
            signal: null,
            timedOut: false,
            stdout: '',
            stderr: 'npm registry request failed: ECONNRESET',
            adapter: 'injected-fake-executor',
            shell: false
          }
        : null
    });
    const result = await runAiFactory218ConsumerSmoke({
      toolchains: harness.toolchains,
      extensionRoot: REPO_ROOT,
      runner: harness.runner,
      workspaceFactory: harness.workspaceFactory,
      timeoutMs: 5_000,
      networkEnabled: true,
      evidence: 'deterministic'
    });

    assert.equal(result.status, SMOKE_STATUS.TRANSPORT_FAILURE);
    assert.equal(result.failure.flow, 'global-update');
    assert.equal(result.failure.code, 'global-update-force-command-failed');
    assert.equal(result.flows.cleanInstall.status, SMOKE_STATUS.PASS);
    assert.equal(result.flows.globalUpdate.status, SMOKE_STATUS.TRANSPORT_FAILURE);
    assert.equal(result.flows.targetedUpdate.status, SMOKE_STATUS.NOT_RUN);
    assert.equal(
      harness.runner.calls.some((entry) => entry.cliArgs.join(' ') === 'extension update aifhub-extension --force'),
      false
    );
  });

  it('attributes a bounded process timeout to the exact clean-install flow', async () => {
    const harness = await createHarness({
      failWhen: ({ cliArgs }) => cliArgs.join(' ') === 'init --agents codex --skills all --config'
        ? {
            exitCode: null,
            processCode: 'ETIMEDOUT',
            signal: 'SIGTERM',
            timedOut: true,
            stdout: '',
            stderr: '',
            adapter: 'injected-fake-executor',
            shell: false
          }
        : null
    });
    const result = await runAiFactory218ConsumerSmoke({
      toolchains: harness.toolchains,
      extensionRoot: REPO_ROOT,
      runner: harness.runner,
      workspaceFactory: harness.workspaceFactory,
      timeoutMs: 5_000,
      evidence: 'deterministic'
    });

    assert.equal(result.status, SMOKE_STATUS.TIMEOUT);
    assert.equal(result.failure.flow, 'clean-install');
    assert.equal(result.failure.code, 'init-2.18-command-failed');
    assert.equal(result.flows.cleanInstall.status, SMOKE_STATUS.TIMEOUT);
    assert.equal(result.flows.globalUpdate.status, SMOKE_STATUS.NOT_RUN);
  });

  it('fails the targeted flow when the exact command returns success without replacing stale bytes', async () => {
    const harness = await createHarness({ targetedNoop: true });
    const result = await runAiFactory218ConsumerSmoke({
      toolchains: harness.toolchains,
      extensionRoot: REPO_ROOT,
      runner: harness.runner,
      workspaceFactory: harness.workspaceFactory,
      timeoutMs: 5_000,
      evidence: 'deterministic'
    });

    assert.equal(result.status, SMOKE_STATUS.FAIL);
    assert.equal(result.failure.flow, 'targeted-update');
    assert.equal(result.failure.code, 'targeted-update-was-no-op');
    assert.equal(result.flows.globalUpdate.status, SMOKE_STATUS.PASS);
    assert.equal(result.flows.targetedUpdate.status, SMOKE_STATUS.FAIL);
  });

  it('uses execFile with shell=false, a bounded timeout, and the Windows ComSpec adapter', async () => {
    const command = 'C:\\Local Toolchains\\ai-factory.cmd';
    const comSpec = 'C:\\Windows\\System32\\cmd.exe';
    const invocation = buildNoShellInvocation({
      command,
      args: ['extension', 'update', 'aifhub-extension', '--force'],
      platform: 'win32',
      comSpec
    });
    assert.equal(invocation.command, comSpec);
    assert.equal(invocation.adapter, 'windows-comspec');
    assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(invocation.args[3], /"C:\\Local Toolchains\\ai-factory\.cmd"/);
    assert.equal(invocation.options.shell, false);
    assert.throws(
      () => buildNoShellInvocation({ command, args: ['%PATH%'], platform: 'win32', comSpec }),
      /unsafe-windows-command-token/
    );

    let captured;
    const runner = createNoShellProcessRunner({
      platform: 'win32',
      comSpec,
      environment: {},
      execFileImpl(executable, args, options, callback) {
        captured = { executable, args, options };
        callback(null, '2.18.1\n', '');
      }
    });
    const processResult = await runner({ command, args: ['--version'], cwd: 'C:\\Temp', timeoutMs: 2_500 });
    assert.equal(processResult.exitCode, 0);
    assert.equal(processResult.adapter, 'windows-comspec');
    assert.equal(captured.executable, comSpec);
    assert.equal(captured.options.shell, false);
    assert.equal(captured.options.timeout, 2_500);
    assert.equal(captured.options.windowsHide, true);
  });

  it('keeps the live driver outside the default glob and exposes it only via the opt-in package script', async () => {
    const packageJson = await readJson(path.join(REPO_ROOT, 'package.json'));
    assert.equal(packageJson.scripts.test, 'node --test scripts/*.test.mjs');
    assert.equal(
      packageJson.scripts['smoke:ai-factory-2-18'],
      'node scripts/ai-factory-2-18-live-smoke.mjs'
    );
    assert.doesNotMatch('ai-factory-2-18-live-smoke.mjs', /\.test\.mjs$/);
  });
});
