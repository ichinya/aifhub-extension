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
const TEST_ONLY_HOOK_TRUST_MODE = 'test_only_pinned_snapshot_bypass';
const LIVE_AUTHORIZATION_BASE_KEYS = Object.freeze([
  'scope',
  'provider_snapshot',
  'runtime_dependency_bootstrap',
  'auth_mode',
  'native_codex'
]);
const LIVE_AUTHORIZATION_KEYS = Object.freeze([
  ...LIVE_AUTHORIZATION_BASE_KEYS,
  'hook_trust_mode'
]);

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
    scenarios: path.join(root, 'scenarios'),
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
  const sourceObserved = source && typeof source === 'object' && !Array.isArray(source);
  const packageMetaObserved = packageMeta && typeof packageMeta === 'object' && !Array.isArray(packageMeta);
  const provenanceVerified = Boolean(sourceObserved && packageMetaObserved);
  if (sourceObserved) {
    compareField(mismatches, 'repository', source.repository, CONTEXT_MODE_IDENTITY.repository);
    compareField(mismatches, 'tag', source.tag, CONTEXT_MODE_IDENTITY.tag);
    compareField(mismatches, 'commit', source.commit, CONTEXT_MODE_IDENTITY.commit);
    checked.push('source_identity');
  }
  if (packageMetaObserved) {
    for (const key of ['version', 'integrity', 'shasum', 'license', 'node']) {
      compareField(mismatches, key, packageMeta[key], CONTEXT_MODE_IDENTITY[key]);
    }
    checked.push('npm_package_identity');
  }
  if (!provenanceVerified) mismatches.push('pinned_identity_evidence_missing');

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
    status: !provenanceVerified ? 'NOT_RUN' : (mismatches.length === 0 ? 'PASS' : 'FAIL'),
    reason_codes: mismatches,
    audit_scope: provenanceVerified ? 'pinned_identity_observations' : 'package_structure_only',
    provenance_verified: provenanceVerified,
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
    global_install: false,
    package_tree_fingerprint: await digestPath(packageRoot)
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
    ctx_search: { queries: [artifact.search_query], limit: 5 },
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
      ...(failedStage ? { stage_reason: failedStage } : {}),
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
  if (!postSearchText || !postStatsText) {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'FAIL',
      reason: 'post_purge_probe_failed',
      ...(failedStage ? { stage_reason: failedStage } : {}),
      evidence_class: 'direct_mcp_contract',
      timings: durations
    };
  }
  if (!postSearchEmpty || residualFact || !postStatsEmpty) {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'FAIL',
      reason: 'provider_purge_residual',
      ...(failedStage ? { stage_reason: failedStage } : {}),
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

export function validateNativeCodexExecutable(command, { platform = process.platform } = {}) {
  const executable = String(command ?? '');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(executable)) {
    return { status: 'NOT_RUN', reason: 'native_codex_executable_required' };
  }
  const extension = pathApi.extname(executable).toLowerCase();
  if ((platform === 'win32' && extension !== '.exe') || ['.cmd', '.bat'].includes(extension)) {
    return { status: 'NOT_RUN', reason: 'native_codex_executable_required' };
  }
  return { status: 'PASS', reason: 'native_codex_executable_verified' };
}

export function buildActualPluginPlan({
  layout,
  sandboxOwnerRoot,
  packageRoot,
  codexExecutable,
  codexVersion,
  supportedFeatures,
  authMode,
  authorization,
  snapshotAudit,
  baseEnv = process.env
}) {
  const effectiveAuthMode = authorization?.auth_mode ?? authMode;
  const eligibility = evaluateActualPluginEligibility({
    codexVersion,
    supportedFeatures,
    authMode: effectiveAuthMode
  });
  const nativeExecutable = eligibility.status === 'PASS'
    ? validateNativeCodexExecutable(codexExecutable)
    : { status: eligibility.status, reason: eligibility.reason };
  let effectiveEligibility = eligibility.status === 'PASS' && nativeExecutable.status !== 'PASS'
    ? { ...eligibility, ...nativeExecutable }
    : eligibility;
  if (effectiveEligibility.status === 'PASS') {
    const gate = validateActualPluginAuthorization(authorization);
    if (gate.status !== 'PASS') effectiveEligibility = { ...eligibility, ...gate };
  }
  if (effectiveEligibility.status === 'PASS') {
    const gate = validateSnapshotAudit(snapshotAudit);
    if (gate.status !== 'PASS') effectiveEligibility = { ...eligibility, ...gate };
  }
  if (effectiveEligibility.status === 'PASS') {
    const gate = validatePluginSandboxBinding({ layout, sandboxOwnerRoot, packageRoot });
    if (gate.status !== 'PASS') effectiveEligibility = { ...eligibility, ...gate };
  }
  const env = buildContextModeEnv({ layout, baseEnv });
  const marketplaceName = 'context-mode-134';
  const marketplaceRoot = layout.marketplace;
  const steps = effectiveEligibility.status === 'PASS'
    ? buildActualPluginSteps({
      marketplaceRoot,
      marketplaceName,
      hookTrustMode: authorization.hook_trust_mode
    })
    : [];
  return {
    ...effectiveEligibility,
    command: codexExecutable,
    steps,
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
    inherited_long_lived_credentials: false,
    authorization_class: effectiveEligibility.status === 'PASS' ? 'explicit_isolated_full' : null,
    snapshot_audit_status: effectiveEligibility.status === 'PASS' ? 'PASS' : null,
    snapshot_tree_fingerprint: effectiveEligibility.status === 'PASS'
      ? snapshotAudit.package_tree_fingerprint
      : null,
    hook_trust_mode: effectiveEligibility.status === 'PASS'
      ? authorization.hook_trust_mode
      : null,
    trust_mode: effectiveEligibility.status === 'PASS'
      ? authorization.hook_trust_mode
      : eligibility.trust_mode
  };
}

function validateActualPluginAuthorization(authorization) {
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    return { status: 'NOT_RUN', reason: 'explicit_isolated_authorization_required' };
  }
  const keys = Object.keys(authorization);
  const hasUnexpectedKey = keys.some((key) => !LIVE_AUTHORIZATION_KEYS.includes(key));
  const hasAllBaseKeys = LIVE_AUTHORIZATION_BASE_KEYS.every((key) => keys.includes(key));
  if (hasUnexpectedKey || !hasAllBaseKeys ||
      authorization.scope !== 'isolated_evaluation' ||
      authorization.provider_snapshot !== 'prepared_pinned_snapshot' ||
      authorization.runtime_dependency_bootstrap !== 'approved' ||
      authorization.auth_mode !== 'scoped_ephemeral' ||
      authorization.native_codex !== true) {
    return { status: 'NOT_RUN', reason: 'explicit_isolated_authorization_required' };
  }
  if (authorization.hook_trust_mode !== TEST_ONLY_HOOK_TRUST_MODE) {
    return { status: 'NOT_RUN', reason: 'hook_trust_bypass_not_authorized' };
  }
  if (!sameStringArray(keys.sort(), [...LIVE_AUTHORIZATION_KEYS].sort())) {
    return { status: 'NOT_RUN', reason: 'explicit_isolated_authorization_required' };
  }
  return { status: 'PASS', reason: 'explicit_isolated_authorization_verified' };
}

function validateSnapshotAudit(snapshotAudit) {
  if (!snapshotAudit) return { status: 'NOT_RUN', reason: 'snapshot_audit_required' };
  const identityMatches = Object.entries(CONTEXT_MODE_IDENTITY)
    .every(([key, value]) => snapshotAudit.identity?.[key] === value);
  const runtimeReasons = Array.isArray(snapshotAudit.runtime_eligibility?.reason_codes)
    ? snapshotAudit.runtime_eligibility.reason_codes
    : [];
  const acceptedRuntimeAudit = snapshotAudit.runtime_eligibility?.status === 'PASS' ||
    (snapshotAudit.runtime_eligibility?.status === 'BLOCKED' &&
      runtimeReasons.length > 0 &&
      runtimeReasons.every((reason) => reason === 'runtime_dependency_self_install'));
  const requiredContracts = [
    'source_identity',
    'npm_package_identity',
    'package_json',
    'postinstall_present_and_suppressed',
    'codex_manifests',
    'hook_events',
    'mcp_entrypoint'
  ];
  const verified = snapshotAudit.schema === CONTEXT_MODE_ADAPTER_SCHEMA &&
    snapshotAudit.status === 'PASS' &&
    snapshotAudit.audit_scope === 'pinned_identity_observations' &&
    snapshotAudit.provenance_verified === true &&
    snapshotAudit.evidence_class === 'plugin_snapshot_isolated' &&
    snapshotAudit.install_lifecycle === 'NOT_RUN(postinstall_forbidden)' &&
    Array.isArray(snapshotAudit.reason_codes) && snapshotAudit.reason_codes.length === 0 &&
    identityMatches &&
    sameStringArray(snapshotAudit.manifests, ['plugin.json', 'mcp.json', 'hooks.json']) &&
    requiredContracts.every((contract) => snapshotAudit.checked_contracts?.includes(contract)) &&
    acceptedRuntimeAudit &&
    /^dir:[a-f0-9]{64}$/.test(String(snapshotAudit.package_tree_fingerprint ?? ''));
  return verified
    ? { status: 'PASS', reason: 'snapshot_audit_verified' }
    : { status: 'NOT_RUN', reason: 'snapshot_audit_failed' };
}

function validatePluginSandboxBinding({ layout, sandboxOwnerRoot, packageRoot }) {
  try {
    if (!layout || typeof layout !== 'object' || !path.isAbsolute(String(layout.root ?? '')) ||
        !path.isAbsolute(String(sandboxOwnerRoot ?? '')) || !path.isAbsolute(String(packageRoot ?? ''))) {
      return { status: 'NOT_RUN', reason: 'sandbox_layout_invalid' };
    }
    const expected = buildSandboxLayout(layout.root);
    if (!sameStringArray(Object.keys(layout).sort(), Object.keys(expected).sort()) ||
        Object.keys(expected).some((key) => path.resolve(layout[key]) !== expected[key]) ||
        !isLexicalDescendant(sandboxOwnerRoot, layout.root) ||
        !isLexicalDescendant(layout.root, packageRoot)) {
      return { status: 'NOT_RUN', reason: 'sandbox_layout_invalid' };
    }
    return { status: 'PASS', reason: 'sandbox_layout_verified' };
  } catch {
    return { status: 'NOT_RUN', reason: 'sandbox_layout_invalid' };
  }
}

function buildActualPluginSteps({ marketplaceRoot, marketplaceName, hookTrustMode }) {
  const hookTrustArgs = hookTrustMode === TEST_ONLY_HOOK_TRUST_MODE
    ? ['--dangerously-bypass-hook-trust']
    : [];
  return [
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
        ...hookTrustArgs,
        'exec',
        '--json',
        '--skip-git-repo-check',
        'Return evaluation_complete only.'
      ]
    }
  ];
}

async function validateActualPluginPlanForExecution(plan) {
  const native = validateNativeCodexExecutable(plan.command);
  if (native.status !== 'PASS' || plan.authorization_class !== 'explicit_isolated_full' ||
      plan.snapshot_audit_status !== 'PASS' || plan.hook_trust_mode !== TEST_ONLY_HOOK_TRUST_MODE ||
      plan.trust_mode !== TEST_ONLY_HOOK_TRUST_MODE) {
    return { status: 'NOT_RUN', reason: 'plugin_plan_integrity_invalid' };
  }
  const layout = buildSandboxLayout(plan.sandbox_root);
  const binding = validatePluginSandboxBinding({
    layout,
    sandboxOwnerRoot: plan.sandbox_owner_root,
    packageRoot: plan.package_root
  });
  const expectedSteps = buildActualPluginSteps({
    marketplaceRoot: layout.marketplace,
    marketplaceName: 'context-mode-134',
    hookTrustMode: plan.hook_trust_mode
  });
  const rootsMatch = binding.status === 'PASS' &&
    plan.working_directory === layout.fixture &&
    plan.marketplace_root === layout.marketplace &&
    plan.marketplace_plugin_root === path.join(layout.marketplace, 'plugins', 'context-mode') &&
    plan.marketplace_manifest === path.join(layout.marketplace, '.agents', 'plugins', 'marketplace.json') &&
    plan.env?.HOME === layout.home &&
    plan.env?.CODEX_HOME === layout.codex_home &&
    plan.env?.CONTEXT_MODE_DIR === layout.context_mode_dir &&
    plan.env?.TEMP === layout.temp &&
    plan.env?.TMP === layout.temp;
  if (!rootsMatch || JSON.stringify(plan.steps) !== JSON.stringify(expectedSteps)) {
    return { status: 'NOT_RUN', reason: 'plugin_plan_integrity_invalid' };
  }
  await assertCanonicalConfinedPath(layout.root, plan.package_root);
  if (await digestPath(plan.package_root) !== plan.snapshot_tree_fingerprint) {
    return { status: 'NOT_RUN', reason: 'snapshot_changed' };
  }
  return { status: 'PASS', reason: 'plugin_plan_verified' };
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function isLexicalDescendant(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
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
  let executionPreflight;
  try {
    executionPreflight = await validateActualPluginPlanForExecution(plan);
  } catch {
    executionPreflight = { status: 'NOT_RUN', reason: 'plugin_plan_integrity_invalid' };
  }
  if (executionPreflight.status !== 'PASS') {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      ...executionPreflight,
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
    trust_mode: plan.trust_mode,
    hook_trust_mode: plan.hook_trust_mode,
    hook_trust_bypass: 'PASS(test_only_authorized)'
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

export async function runSandboxLifecycle({
  ownerRoot,
  sandboxRoot,
  run,
  purge,
  purgeRequired = true,
  logger
}) {
  let lease;
  try {
    lease = await createSandboxLease({ ownerRoot, sandboxRoot });
  } catch (error) {
    return {
      schema: CONTEXT_MODE_ADAPTER_SCHEMA,
      status: 'NOT_RUN',
      reason: error?.code ?? 'sandbox_lease_failed',
      purge: 'NOT_APPLICABLE',
      cleanup: 'NOT_APPLICABLE'
    };
  }
  let runResult = null;
  let runFailure = null;
  try {
    runResult = await run();
  } catch (error) {
    runFailure = error?.code ?? 'sandbox_operation_failed';
  }
  let shouldPurge;
  let purgeRequirementFailure = null;
  try {
    shouldPurge = typeof purgeRequired === 'function'
      ? Boolean(purgeRequired())
      : Boolean(purgeRequired);
  } catch {
    shouldPurge = true;
    purgeRequirementFailure = 'purge_requirement_failed';
  }
  const operationFailure = runFailure ?? purgeRequirementFailure;
  let purgeStatus = shouldPurge ? 'FAIL' : 'NOT_APPLICABLE';
  if (shouldPurge) {
    try {
      purgeStatus = typeof purge === 'function' && (await purge())?.status === 'PASS' ? 'PASS' : 'FAIL';
    } catch {
      purgeStatus = 'FAIL';
    }
  }
  let cleanupStatus = 'FAIL';
  try {
    await removeVerifiedSandbox(lease);
    cleanupStatus = 'PASS';
    logFix(logger, 'sandbox_cleanup_pass', { outcome: operationFailure ?? runResult?.status ?? 'unknown' });
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
  const operationStatus = operationFailure ? 'FAIL' : (runResult?.status ?? 'FAIL');
  const status = shouldPurge && purgeStatus !== 'PASS'
    ? (operationStatus === 'BLOCKED' ? 'BLOCKED' : 'FAIL')
    : operationStatus;
  return {
    ...(runResult ?? {}),
    schema: CONTEXT_MODE_ADAPTER_SCHEMA,
    status,
    reason: operationFailure ??
      (shouldPurge && purgeStatus !== 'PASS' ? 'provider_purge_failed' : runResult?.reason),
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
  // Nested npm .bin symlinks and junctions are unlinked by fs.rm; they are not
  // followed. The owned root itself, canonical boundary and lease marker were
  // verified above, so refusing nested links would strand scoped credentials.
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50
  });
  if (await pathExists(target)) throw adapterError('sandbox_cleanup_failed');
  return { status: 'PASS', target_class: 'verified_sandbox_descendant' };
}

export async function runBoundedProcess(command, args, {
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputCapBytes = DEFAULT_OUTPUT_CAP_BYTES
} = {}) {
  if (!Number.isSafeInteger(outputCapBytes) || outputCapBytes < 1) {
    throw adapterError('invalid_output_cap');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const append = (current, chunk, markTruncated) => {
      const combined = Buffer.concat([current, Buffer.from(chunk)]);
      if (combined.length <= outputCapBytes) return combined;
      markTruncated();
      return combined.subarray(combined.length - outputCapBytes);
    };
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk, () => { stdoutTruncated = true; });
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk, () => { stderrTruncated = true; });
    });
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
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: decodeUtf8Tail(stdout),
        stderr: decodeUtf8Tail(stderr),
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated
      });
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
  if (path.parse(owner).root === owner) {
    throw adapterError('cleanup_boundary_unavailable');
  }
  if (path.parse(target).root === target) {
    throw adapterError('sandbox_outside_cleanup_owner');
  }
  let ownerInfo;
  try {
    ownerInfo = await lstat(owner);
  } catch {
    throw adapterError('cleanup_boundary_unavailable');
  }
  if (!ownerInfo.isDirectory() || ownerInfo.isSymbolicLink()) {
    throw adapterError('cleanup_boundary_unavailable');
  }
  try {
    await assertCanonicalConfinedPath(owner, target, { allowMissingLeaf: true });
  } catch {
    throw adapterError('sandbox_outside_cleanup_owner');
  }
  if (!await pathExists(target)) {
    try {
      await mkdir(target, { recursive: true });
    } catch {
      throw adapterError('sandbox_lease_failed');
    }
  }
  let targetInfo;
  try {
    targetInfo = await lstat(target);
  } catch {
    throw adapterError('sandbox_lease_failed');
  }
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw adapterError('reparse_escape');
  }
  await assertCanonicalConfinedPath(owner, target);
  const token = randomUUID();
  const markerPath = path.join(target, SANDBOX_MARKER);
  await assertCanonicalConfinedPath(target, markerPath, { allowMissingLeaf: true });
  try {
    await writeFile(markerPath, `${JSON.stringify({ schema: SANDBOX_MARKER_SCHEMA, token })}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    });
  } catch (error) {
    if (error?.code === 'EEXIST') throw adapterError('sandbox_lease_exists');
    throw adapterError('sandbox_lease_failed');
  }
  return { ownerRoot: owner, sandboxRoot: target, token };
}

function decodeUtf8Tail(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
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
    for (const entry of entries.sort((a, b) => compareCodeUnitStrings(a.name, b.name))) {
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

function compareCodeUnitStrings(left, right) {
  return left < right ? -1 : (left > right ? 1 : 0);
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
    packageRoot: path.resolve(packageRoot)
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
