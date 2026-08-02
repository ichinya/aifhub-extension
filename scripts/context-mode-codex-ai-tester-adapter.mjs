// context-mode-codex-ai-tester-adapter.mjs - isolated issue #134 evaluation boundary
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTEXT_MODE_ADAPTER_SCHEMA = 'aifhub.context_mode_codex.adapter.v1';
export const CONTEXT_MODE_IDENTITY = Object.freeze({
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
export const ALLOWED_MCP_TOOLS = Object.freeze([
  'ctx_doctor',
  'ctx_index',
  'ctx_search',
  'ctx_stats',
  'ctx_purge'
]);
export const DIRECT_HOOK_EVENTS = Object.freeze([
  'UserPromptSubmit',
  'PostToolUse',
  'PreCompact',
  'SessionStart',
  'Stop'
]);
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_OUTPUT_CAP_BYTES = 64 * 1024;

const SYSTEM_ENV_KEYS = Object.freeze([
  'PATH',
  'Path',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'OS',
  'NUMBER_OF_PROCESSORS'
]);
const REQUIRED_MANIFESTS = Object.freeze([
  ['plugin.json', '.codex-plugin/plugin.json'],
  ['mcp.json', '.codex-plugin/mcp.json'],
  ['hooks.json', '.codex-plugin/hooks.json']
]);
const SANDBOX_MARKER = '.aifhub-context-mode-sandbox.json';
const SANDBOX_MARKER_SCHEMA = 'aifhub.context_mode_codex.sandbox_owner.v1';

export function buildSandboxLayout(sandboxRoot) {
  const root = path.resolve(sandboxRoot);
  return Object.freeze({
    root,
    source: path.join(root, 'source'),
    package: path.join(root, 'package'),
    fixture: path.join(root, 'fixture'),
    marketplace: path.join(root, 'marketplace'),
    home: path.join(root, 'home'),
    codex_home: path.join(root, 'codex-home'),
    context_mode_dir: path.join(root, 'context-mode'),
    temp: path.join(root, 'temp'),
    cache: path.join(root, 'cache'),
    logs: path.join(root, 'logs'),
    runs: path.join(root, 'runs'),
    wrappers: path.join(root, 'wrappers')
  });
}

export function buildContextModeEnv({ layout, baseEnv = process.env }) {
  const env = {};
  for (const key of SYSTEM_ENV_KEYS) {
    if (typeof baseEnv[key] === 'string' && baseEnv[key]) env[key] = baseEnv[key];
  }
  return {
    ...env,
    HOME: layout.home,
    USERPROFILE: layout.home,
    APPDATA: path.join(layout.home, 'appdata', 'roaming'),
    LOCALAPPDATA: path.join(layout.home, 'appdata', 'local'),
    XDG_CONFIG_HOME: path.join(layout.home, 'xdg', 'config'),
    XDG_DATA_HOME: path.join(layout.home, 'xdg', 'data'),
    XDG_CACHE_HOME: layout.cache,
    CODEX_HOME: layout.codex_home,
    CONTEXT_MODE_DIR: layout.context_mode_dir,
    TEMP: layout.temp,
    TMP: layout.temp,
    CI: '1',
    NO_COLOR: '1',
    CONTEXT_MODE_PLATFORM: 'codex'
  };
}

export function buildPinnedInstallInvocation({
  npmCliPath,
  packageRoot,
  sandboxRoot,
  baseEnv = process.env
}) {
  const layout = buildSandboxLayout(sandboxRoot);
  return {
    command: process.execPath,
    args: [
      npmCliPath,
      'install',
      '--prefix',
      packageRoot,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `${CONTEXT_MODE_IDENTITY.package}@${CONTEXT_MODE_IDENTITY.version}`
    ],
    env: {
      ...buildContextModeEnv({ layout, baseEnv }),
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_global: 'false'
    },
    evidence_class: 'plugin_snapshot_isolated',
    install_lifecycle: 'NOT_RUN(postinstall_forbidden)'
  };
}

export async function assertCanonicalConfinedPath(
  sandboxRoot,
  targetPath,
  { allowMissingLeaf = false } = {}
) {
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(targetPath);
  assertLexicalDescendant(root, target);
  const canonicalRoot = await realpath(root);
  let existing = target;
  if (allowMissingLeaf) {
    while (!(await pathExists(existing))) {
      const parent = path.dirname(existing);
      if (parent === existing) throw adapterError('unsafe_path');
      existing = parent;
    }
  }
  const canonicalExisting = await realpath(existing);
  const relative = path.relative(canonicalRoot, canonicalExisting);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw adapterError('reparse_escape');
  }
  return target;
}

export async function auditContextModeSnapshot({ packageRoot, tarballPath, source, packageMeta }) {
  const checked = [];
  const mismatches = [];
  compareField(mismatches, 'repository', source?.repository, CONTEXT_MODE_IDENTITY.repository);
  compareField(mismatches, 'tag', source?.tag, CONTEXT_MODE_IDENTITY.tag);
  compareField(mismatches, 'commit', source?.commit, CONTEXT_MODE_IDENTITY.commit);
  for (const key of ['version', 'integrity', 'shasum', 'license', 'node']) {
    compareField(mismatches, key, packageMeta?.[key], CONTEXT_MODE_IDENTITY[key]);
  }
  checked.push('source_identity', 'npm_package_identity');

  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  compareField(mismatches, 'package_name', packageJson.name, CONTEXT_MODE_IDENTITY.package);
  compareField(mismatches, 'package_version', packageJson.version, CONTEXT_MODE_IDENTITY.version);
  compareField(mismatches, 'package_license', packageJson.license, CONTEXT_MODE_IDENTITY.license);
  compareField(mismatches, 'package_node', packageJson.engines?.node, CONTEXT_MODE_IDENTITY.node);
  if (typeof packageJson.scripts?.postinstall !== 'string') mismatches.push('postinstall_missing');
  checked.push('package_json', 'postinstall_present_and_suppressed');
  let tarballShasumVerified = null;
  if (tarballPath) {
    tarballShasumVerified =
      createHash('sha1').update(await readFile(tarballPath)).digest('hex') === CONTEXT_MODE_IDENTITY.shasum;
    if (!tarballShasumVerified) mismatches.push('tarball_shasum_mismatch');
    checked.push('npm_tarball_shasum');
  }

  const manifests = [];
  for (const [name, relativePath] of REQUIRED_MANIFESTS) {
    await access(path.join(packageRoot, relativePath));
    manifests.push(name);
  }
  await access(path.join(packageRoot, 'start.mjs'));
  const hooks = JSON.parse(await readFile(path.join(packageRoot, '.codex-plugin', 'hooks.json'), 'utf8'));
  const hookText = JSON.stringify(hooks);
  for (const event of DIRECT_HOOK_EVENTS) {
    if (!hookText.includes(event)) mismatches.push(`hook_missing:${event}`);
  }
  checked.push('codex_manifests', 'hook_events', 'mcp_entrypoint');
  const lifecycleBlocks = [];
  const ensureDepsPath = path.join(packageRoot, 'hooks', 'ensure-deps.mjs');
  if (await pathExists(ensureDepsPath)) {
    const ensureDeps = await readFile(ensureDepsPath, 'utf8');
    if (/execSync/.test(ensureDeps) && /install \$\{pkg\}/.test(ensureDeps)) {
      lifecycleBlocks.push('runtime_dependency_self_install');
    }
    if (/shell:\s*true/.test(ensureDeps)) lifecycleBlocks.push('runtime_shell_execution');
    checked.push('runtime_dependency_bootstrap');
  }

  return {
    schema: CONTEXT_MODE_ADAPTER_SCHEMA,
    status: mismatches.length === 0 ? 'PASS' : 'FAIL',
    reason_codes: mismatches,
    identity: CONTEXT_MODE_IDENTITY,
    manifests,
    checked_contracts: checked,
    tarball_shasum_verified: tarballShasumVerified,
    runtime_eligibility: lifecycleBlocks.length === 0
      ? { status: 'PASS', reason_codes: [] }
      : { status: 'BLOCKED', reason_codes: [...new Set(lifecycleBlocks)].sort() },
    evidence_class: 'plugin_snapshot_isolated',
    install_lifecycle: 'NOT_RUN(postinstall_forbidden)',
    floating_install: false,
    global_install: false
  };
}

export async function captureHostManifest({ projectRoot, codexHome, providerHome }) {
  const targets = {
    project_git_config: path.join(projectRoot, '.git', 'config'),
    project_git_hooks: path.join(projectRoot, '.git', 'hooks'),
    codex_plugins: path.join(codexHome, 'plugins'),
    codex_cache: path.join(codexHome, 'cache'),
    provider_home: providerHome
  };
  const entries = {};
  for (const [key, target] of Object.entries(targets)) entries[key] = await digestPath(target);
  return { schema: 'aifhub.context_mode_codex.host_manifest.v1', entries };
}

export function compareHostManifests(before, after) {
  const keys = new Set([...Object.keys(before?.entries ?? {}), ...Object.keys(after?.entries ?? {})]);
  const changed = [...keys]
    .filter((key) => before?.entries?.[key] !== after?.entries?.[key])
    .sort();
  return { status: changed.length === 0 ? 'PASS' : 'FAIL', changed };
}

export async function runMcpContract({ artifact, invokeTool, hashContent = sha256 }) {
  if (!artifact || path.basename(artifact.name) !== artifact.name || isProtectedArtifact(artifact.name)) {
    throw adapterError('artifact_not_allowlisted');
  }
  if (hashContent(artifact.content) !== artifact.sha256) throw adapterError('artifact_fingerprint_mismatch');
  if (typeof artifact.search_query !== 'string' || artifact.search_query.length === 0 ||
      !Array.isArray(artifact.required_facts) || artifact.required_facts.length === 0 ||
      artifact.required_facts.some((fact) => typeof fact !== 'string' || fact.length === 0)) {
    throw adapterError('artifact_query_contract_missing');
  }
  const durations = {};
  const payloads = {
    ctx_doctor: {},
    ctx_index: {
      source: artifact.name,
      content: artifact.content
    },
    ctx_search: { query: artifact.search_query, limit: 5 },
    ctx_stats: {},
    ctx_purge: { confirm: true, scope: 'project' }
  };
  let failedStage = null;
  for (const tool of ALLOWED_MCP_TOOLS.filter((name) => name !== 'ctx_purge')) {
    const started = performance.now();
    let response;
    try {
      response = await invokeTool(tool, payloads[tool]);
    } catch {
      failedStage = `${tool}_contract_failed`;
    } finally {
      durations[`${tool}_ms`] = Math.round(performance.now() - started);
    }
    if (!failedStage && !validateMcpStage(tool, response, artifact)) {
      failedStage = `${tool}_contract_failed`;
    }
    if (failedStage) break;
  }

  let purgeText = null;
  const purgeStarted = performance.now();
  try {
    purgeText = mcpResponseText(await invokeTool('ctx_purge', payloads.ctx_purge));
  } catch {}
  durations.ctx_purge_ms = Math.round(performance.now() - purgeStarted);
  if (!purgeText || !/^Purged:/im.test(purgeText)) {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'FAIL',
      reason: 'provider_purge_failed',
      evidence_class: 'direct_mcp_contract',
      timings: durations
    };
  }

  let postSearchText = null;
  let postStatsText = null;
  const postSearchStarted = performance.now();
  try {
    postSearchText = mcpResponseText(await invokeTool('ctx_search', payloads.ctx_search));
  } catch {}
  durations.ctx_search_post_purge_ms = Math.round(performance.now() - postSearchStarted);
  const postStatsStarted = performance.now();
  try {
    postStatsText = mcpResponseText(await invokeTool('ctx_stats', payloads.ctx_stats));
  } catch {}
  durations.ctx_stats_post_purge_ms = Math.round(performance.now() - postStatsStarted);
  const residualFact = artifact.required_facts.some((fact) => postSearchText?.includes(fact));
  const postSearchEmpty = postSearchText && /(?:no (?:indexed )?(?:context|results|matches)|nothing found|0 (?:results|matches))/i.test(postSearchText);
  const postStatsEmpty = parseIndexedArtifactCount(postStatsText) === 0;
  if (!postSearchEmpty || residualFact || !postStatsEmpty) {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'FAIL',
      reason: 'provider_purge_residual',
      evidence_class: 'direct_mcp_contract',
      timings: durations
    };
  }
  if (failedStage) {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'FAIL',
      reason: failedStage,
      evidence_class: 'direct_mcp_contract',
      timings: durations
    };
  }
  return {
    schema: CONTEXT_MODE_ADAPTER_SCHEMA,
    status: 'PASS',
    evidence_class: 'direct_mcp_contract',
    artifact_class: 'single_synthetic_generated_output',
    content_fingerprint_verified: true,
    tools: [...ALLOWED_MCP_TOOLS],
    purge: 'PASS',
    timings: durations
  };
}

export async function runDirectHookContract({ invokeHook }) {
  const outcomes = [];
  for (const event of DIRECT_HOOK_EVENTS) {
    const result = await invokeHook(event, syntheticHookPayload(event));
    outcomes.push({
      event,
      redacted: result?.redacted === true,
      recovered: result?.recovered === true,
      isolated: result?.isolated === true
    });
  }
  const passed = outcomes.every((item) => item.redacted && item.recovered && item.isolated);
  return {
    schema: CONTEXT_MODE_ADAPTER_SCHEMA,
    status: passed ? 'PASS' : 'FAIL',
    evidence_class: 'direct_hook_contract',
    events: outcomes.map((item) => item.event),
    redaction: outcomes.every((item) => item.redacted) ? 'PASS' : 'FAIL',
    continuity: outcomes.every((item) => item.recovered) ? 'PASS' : 'FAIL',
    fresh_session_isolation: outcomes.every((item) => item.isolated) ? 'PASS' : 'FAIL',
    actual_codex_delivery: 'NOT_RUN(direct_entrypoint_only)',
    compaction: 'NOT_RUN(compaction_control_unavailable)'
  };
}

export function evaluateActualPluginEligibility({
  codexVersion,
  supportedFeatures = [],
  authMode = 'none'
}) {
  const result = {
    status: 'NOT_RUN',
    reason: 'auth_isolation_unavailable',
    codex_version: String(codexVersion ?? 'unknown'),
    supported_features: [...supportedFeatures].sort(),
    trust_mode: 'isolated_local_marketplace'
  };
  if (!supportedFeatures.includes('plugins') || !supportedFeatures.includes('hooks')) {
    result.reason = 'required_codex_features_unavailable';
    return result;
  }
  if (!['scoped_ephemeral', 'external_broker'].includes(authMode)) return result;
  return { ...result, status: 'PASS', reason: 'eligible' };
}

export function parseCodexFeatureList(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([name, state, enabled]) =>
      /^[a-z][a-z0-9_-]*$/.test(name ?? '') &&
      state !== 'removed' &&
      enabled === 'true'
    )
    .map(([name]) => name)
    .filter((name) => ['hooks', 'plugins'].includes(name))
    .sort();
}

export function buildActualPluginPlan({
  layout,
  sandboxOwnerRoot,
  packageRoot,
  codexExecutable,
  codexVersion,
  supportedFeatures,
  authMode,
  baseEnv = process.env
}) {
  const eligibility = evaluateActualPluginEligibility({
    codexVersion,
    supportedFeatures,
    authMode
  });
  const env = buildContextModeEnv({ layout, baseEnv });
  const marketplaceName = 'context-mode-134';
  const marketplaceRoot = layout.marketplace;
  return {
    ...eligibility,
    command: codexExecutable,
    steps: [
      {
        phase: 'marketplace_add',
        args: ['plugin', 'marketplace', 'add', marketplaceRoot, '--json']
      },
      {
        phase: 'plugin_add',
        args: ['plugin', 'add', 'context-mode', '--marketplace', marketplaceName, '--json']
      },
      {
        phase: 'codex_exec',
        args: [
          '-c',
          'model_reasoning_effort="low"',
          '--dangerously-bypass-hook-trust',
          'exec',
          '--json',
          '--skip-git-repo-check',
          'Return evaluation_complete only.'
        ]
      }
    ],
    env,
    sandbox_root: layout.root,
    sandbox_owner_root: sandboxOwnerRoot,
    working_directory: layout.fixture,
    package_root: packageRoot,
    marketplace_root: marketplaceRoot,
    marketplace_manifest: path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
    marketplace_plugin_root: path.join(marketplaceRoot, 'plugins', 'context-mode'),
    marketplace_name: marketplaceName,
    plugin_source_class: 'pinned_local_snapshot',
    package_root_class: path.relative(layout.root, packageRoot),
    feature_flags: [...supportedFeatures].filter((name) => ['hooks', 'plugins'].includes(name)).sort(),
    copied_auth: false,
    inherited_long_lived_credentials: false
  };
}

export async function prepareActualPluginMarketplace(plan) {
  await assertCanonicalConfinedPath(plan.sandbox_root, plan.package_root);
  await assertCanonicalConfinedPath(plan.sandbox_root, plan.working_directory, { allowMissingLeaf: true });
  await assertCanonicalConfinedPath(plan.sandbox_root, plan.marketplace_root, { allowMissingLeaf: true });
  await assertCanonicalConfinedPath(plan.sandbox_root, plan.marketplace_plugin_root, { allowMissingLeaf: true });
  await assertCanonicalConfinedPath(plan.sandbox_root, plan.marketplace_manifest, { allowMissingLeaf: true });
  await mkdir(plan.working_directory, { recursive: true });
  await assertCanonicalConfinedPath(plan.sandbox_root, plan.working_directory);
  await mkdir(path.dirname(plan.marketplace_manifest), { recursive: true });
  await mkdir(path.dirname(plan.marketplace_plugin_root), { recursive: true });
  await cp(plan.package_root, plan.marketplace_plugin_root, {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  await writeFile(plan.marketplace_manifest, `${JSON.stringify({
    name: plan.marketplace_name,
    interface: { displayName: 'context-mode issue 134 evaluation' },
    plugins: [
      {
        name: 'context-mode',
        source: { source: 'local', path: './plugins/context-mode' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
        category: 'Developer Tools'
      }
    ]
  }, null, 2)}\n`, 'utf8');
  return {
    status: 'PASS',
    phase: 'marketplace_prepare',
    marketplace_name: plan.marketplace_name,
    plugin_source_class: plan.plugin_source_class
  };
}

export async function runActualPluginLifecycle({
  plan,
  hostManifestTargets,
  captureManifest = captureHostManifest,
  compareManifests = compareHostManifests,
  prepareMarketplace = prepareActualPluginMarketplace,
  runProcess = runBoundedProcess,
  purgeProvider = async () => ({ status: 'NOT_RUN', reason: 'provider_purge_unavailable' }),
  logger,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (plan?.status !== 'PASS') {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: plan?.status ?? 'NOT_RUN',
      reason: plan?.reason ?? 'plugin_preflight_missing',
      phases: []
    };
  }
  if (!plan.sandbox_owner_root) {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'cleanup_boundary_unavailable',
      phases: []
    };
  }
  if (!hostManifestTargets || typeof hostManifestTargets !== 'object' ||
      !hostManifestTargets.projectRoot || !hostManifestTargets.codexHome ||
      !hostManifestTargets.providerHome) {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'host_manifest_boundary_unavailable',
      phases: []
    };
  }
  let beforeManifest;
  try {
    beforeManifest = await captureManifest(hostManifestTargets);
  } catch {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'host_manifest_capture_failed',
      phases: []
    };
  }
  const lifecycle = await runSandboxLifecycle({
    ownerRoot: plan.sandbox_owner_root,
    sandboxRoot: plan.sandbox_root,
    purge: purgeProvider,
    logger,
    run: async () => runActualPluginSteps({ plan, prepareMarketplace, runProcess, timeoutMs })
  });
  let afterManifest;
  try {
    afterManifest = await captureManifest(hostManifestTargets);
  } catch {
    logFix(logger, 'host_manifest_capture_failed', { phase: 'after' });
    return {
      ...lifecycle,
      status: 'FAIL',
      reason: 'host_manifest_capture_failed',
      host_manifest: { status: 'FAIL', changed: [] }
    };
  }
  const hostManifest = compareManifests(beforeManifest, afterManifest);
  logFix(logger, 'host_manifest_checked', {
    status: hostManifest.status,
    changed: hostManifest.changed ?? []
  });
  if (hostManifest.status !== 'PASS') {
    return {
      ...lifecycle,
      status: 'FAIL',
      reason: 'host_manifest_drift',
      host_manifest: hostManifest
    };
  }
  return { ...lifecycle, host_manifest: hostManifest };
}

async function runActualPluginSteps({ plan, prepareMarketplace, runProcess, timeoutMs }) {
  let preparation;
  try {
    preparation = await prepareMarketplace(plan);
  } catch {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'FAIL',
      reason: 'marketplace_prepare_failed',
      phases: ['marketplace_prepare']
    };
  }
  if (preparation?.status !== 'PASS') {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'FAIL',
      reason: 'marketplace_prepare_failed',
      phases: ['marketplace_prepare']
    };
  }
  const phases = ['marketplace_prepare'];
  for (const step of plan.steps ?? []) {
    const result = await runProcess(plan.command, step.args, {
      cwd: plan.working_directory,
      env: plan.env,
      timeoutMs,
      outputCapBytes: DEFAULT_OUTPUT_CAP_BYTES
    });
    phases.push(step.phase);
    if (result.exitCode !== 0) {
      return {
        schema: CONTEXT_MODE_ADAPTER_SCHEMA,
        status: 'FAIL',
        reason: `${step.phase}_failed`,
        phases
      };
    }
  }
  return {
    schema: CONTEXT_MODE_ADAPTER_SCHEMA,
    status: 'PASS',
    evidence_class: 'actual_codex_plugin',
    phases,
    trust_mode: plan.trust_mode
  };
}

export async function prepareSandbox(layout) {
  for (const target of Object.values(layout)) {
    if (target !== layout.root) {
      await assertCanonicalConfinedPath(layout.root, target, { allowMissingLeaf: true });
    }
    await mkdir(target, { recursive: true });
  }
}

export async function runSandboxLifecycle({ ownerRoot, sandboxRoot, run, purge, logger }) {
  const lease = await createSandboxLease({ ownerRoot, sandboxRoot });
  let runResult = null;
  let runFailure = null;
  try {
    runResult = await run();
  } catch (error) {
    runFailure = error?.code ?? 'sandbox_operation_failed';
  }
  let purgeStatus = 'FAIL';
  try {
    purgeStatus = (await purge())?.status === 'PASS' ? 'PASS' : 'FAIL';
  } catch {
    purgeStatus = 'FAIL';
  }
  let cleanupStatus = 'FAIL';
  try {
    await removeVerifiedSandbox(lease);
    cleanupStatus = 'PASS';
    logFix(logger, 'sandbox_cleanup_pass', { outcome: runFailure ?? runResult?.status ?? 'unknown' });
  } catch (error) {
    logFix(logger, 'sandbox_cleanup_failed', { reason: error?.code ?? 'sandbox_cleanup_failed' });
    return {
      ...(runResult ?? {}),
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'BLOCKED',
      reason: error?.code ?? 'sandbox_cleanup_failed',
      purge: purgeStatus,
      cleanup: 'FAIL'
    };
  }
  const operationStatus = runFailure ? 'FAIL' : runResult?.status;
  const status = operationStatus === 'PASS' && purgeStatus === 'PASS' ? 'PASS' : 'FAIL';
  return {
    ...(runResult ?? {}),
    schema: CONTEXT_MODE_ADAPTER_SCHEMA,
    status,
    reason: runFailure ?? runResult?.reason ?? (purgeStatus === 'PASS' ? undefined : 'provider_purge_failed'),
    purge: purgeStatus,
    cleanup: cleanupStatus
  };
}

export async function removeVerifiedSandbox({ ownerRoot, sandboxRoot, token }) {
  if (!ownerRoot || !sandboxRoot || !token) throw adapterError('unsafe_delete_target');
  const owner = path.resolve(ownerRoot);
  const target = path.resolve(sandboxRoot);
  if (path.parse(owner).root === owner || path.parse(target).root === target) throw adapterError('unsafe_delete_target');
  const [ownerInfo, targetInfo] = await Promise.all([lstat(owner), lstat(target)]);
  if (!ownerInfo.isDirectory() || ownerInfo.isSymbolicLink() ||
      !targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw adapterError('reparse_escape');
  }
  await assertCanonicalConfinedPath(owner, target);
  const markerPath = path.join(target, SANDBOX_MARKER);
  await assertCanonicalConfinedPath(target, markerPath);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (marker.schema !== SANDBOX_MARKER_SCHEMA || marker.token !== token) {
    throw adapterError('sandbox_owner_mismatch');
  }
  await assertNoReparseEntries(target, target);
  await rm(target, { recursive: true, force: true });
  if (await pathExists(target)) throw adapterError('sandbox_cleanup_failed');
  return { status: 'PASS', target_class: 'verified_sandbox_descendant' };
}

export async function runBoundedProcess(command, args, {
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputCapBytes = DEFAULT_OUTPUT_CAP_BYTES
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const append = (current, chunk) => `${current}${chunk.toString()}`.slice(-outputCapBytes);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await terminateProcessTree(child.pid);
      reject(adapterError('process_timeout'));
    }, timeoutMs);
    child.once('error', async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await terminateProcessTree(child.pid);
      reject(adapterError('process_spawn_failed'));
    });
    child.once('exit', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

export async function terminateProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function validateMcpStage(tool, response, artifact) {
  const text = mcpResponseText(response);
  if (!text || /\[FAIL\]/i.test(text)) return false;
  if (tool === 'ctx_doctor') {
    return /Server test:\s*PASS/i.test(text) &&
      /FTS5\s*\/\s*SQLite:\s*PASS/i.test(text) &&
      /Version:\s*v?1\.0\.169/i.test(text);
  }
  if (tool === 'ctx_index') {
    return /Indexed\s+\d+\s+sections?/i.test(text) && text.includes(artifact.name);
  }
  if (tool === 'ctx_search') {
    return text.includes(artifact.name) && artifact.required_facts.every((fact) => text.includes(fact));
  }
  return tool === 'ctx_stats' && parseIndexedArtifactCount(text) === 1;
}

function parseIndexedArtifactCount(text) {
  const match = String(text ?? '').match(
    /(?:^|\r?\n)\s*Indexed artifacts:\s*(\d+)\s*(?=\r?\n|$)/i
  );
  return match ? Number(match[1]) : null;
}

function mcpResponseText(response) {
  if (!response || response.isError === true || !Array.isArray(response.content)) return null;
  const text = response.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();
  return text || null;
}

async function createSandboxLease({ ownerRoot, sandboxRoot }) {
  if (!ownerRoot || !sandboxRoot) throw adapterError('unsafe_delete_target');
  const owner = path.resolve(ownerRoot);
  const target = path.resolve(sandboxRoot);
  if (path.parse(owner).root === owner || path.parse(target).root === target) {
    throw adapterError('unsafe_delete_target');
  }
  const [ownerInfo, targetInfo] = await Promise.all([lstat(owner), lstat(target)]);
  if (!ownerInfo.isDirectory() || ownerInfo.isSymbolicLink() ||
      !targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw adapterError('reparse_escape');
  }
  await assertCanonicalConfinedPath(owner, target);
  const token = randomUUID();
  const markerPath = path.join(target, SANDBOX_MARKER);
  await assertCanonicalConfinedPath(target, markerPath, { allowMissingLeaf: true });
  await writeFile(markerPath, `${JSON.stringify({ schema: SANDBOX_MARKER_SCHEMA, token })}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  });
  return { ownerRoot: owner, sandboxRoot: target, token };
}

async function assertNoReparseEntries(root, current) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw adapterError('reparse_escape');
    await assertCanonicalConfinedPath(root, target);
    if (info.isDirectory()) await assertNoReparseEntries(root, target);
  }
}

function logFix(logger, event, fields) {
  if (typeof logger !== 'function') return;
  logger(`[FIX:134] ${event} ${JSON.stringify(fields)}`);
}

function syntheticHookPayload(event) {
  return {
    event,
    session_id: 'synthetic-session',
    cwd_class: 'sandbox_fixture',
    canary_classes: ['decision', 'file_state', 'error']
  };
}

function isProtectedArtifact(name) {
  return /(?:^|[-_.])(openspec|coverage|done-readiness|aif-gate-result|source|src)(?:$|[-_.])/i.test(name);
}

function assertLexicalDescendant(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw adapterError('unsafe_path');
  }
}

async function digestPath(target) {
  try {
    const info = await stat(target);
    if (info.isFile()) return `file:${sha256(await readFile(target))}`;
    if (!info.isDirectory()) return `other:${info.size}`;
    const entries = await readdir(target, { withFileTypes: true });
    const parts = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(target, entry.name);
      const childInfo = await lstat(child);
      if (childInfo.isSymbolicLink()) {
        parts.push(`${entry.name}:link`);
      } else if (childInfo.isFile()) {
        parts.push(`${entry.name}:file:${sha256(await readFile(child))}`);
      } else if (childInfo.isDirectory()) {
        parts.push(`${entry.name}:dir:${await digestPath(child)}`);
      }
    }
    return `dir:${sha256(parts.join('\n'))}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareField(mismatches, key, actual, expected) {
  if (actual !== expected) mismatches.push(`${key}_mismatch`);
}

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function main(argv = process.argv.slice(2)) {
  if (!argv.includes('--audit')) {
    process.stderr.write('usage: node scripts/context-mode-codex-ai-tester-adapter.mjs --audit --package-root <path>\n');
    process.exitCode = 2;
    return;
  }
  const packageRoot = valueAfter(argv, '--package-root');
  if (!packageRoot) throw adapterError('package_root_required');
  const result = await auditContextModeSnapshot({
    packageRoot: path.resolve(packageRoot),
    source: CONTEXT_MODE_IDENTITY,
    packageMeta: CONTEXT_MODE_IDENTITY
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'PASS') process.exitCode = 1;
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? 'adapter_failed'}\n`);
    process.exitCode = 1;
  });
}
