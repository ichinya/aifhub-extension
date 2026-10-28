// Snapshot and dependency identity. No QA owners, commands, or result writers here.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { digest, canonical, portablePath, identifier, requireValue, storeFor } from './workflow-state-store.mjs';
import { QA_LIMITS, sorted, within, withinCi, jsonValue } from './qa-manifest-store.mjs';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{64}$/;
const MODULES = ['qa-manifest.mjs', 'qa-manifest-store.mjs', 'qa-manifest-inputs.mjs',
  'qa-bound-evidence.mjs', 'qa-manifest-record.mjs', 'workflow-state-store.mjs',
  'aif-gate-result.mjs', 'write-gate-evidence.mjs', 'openspec-verification-context.mjs'];

function sourcePath(value) {
  portablePath(value);
  requireValue(!value.split('/').some(p => p.toLowerCase() === '.git'), 'protected-input', true);
  return value;
}

export function chargeQaRead(options, bytes) {
  if (!options.readBudget) return;
  options.readBudget.bytes += bytes;
  requireValue(options.readBudget.bytes <= QA_LIMITS.bytes, 'qa-read-budget', true);
}

export function validateChecks(checks) {
  requireValue(Array.isArray(checks) && checks.length > 0 && checks.length <= QA_LIMITS.checks, 'qa-checks-limit', true);
  const ids = new Set();
  return checks.map(check => {
    jsonValue(check); identifier(check.id);
    requireValue(!ids.has(check.id), 'duplicate-check', true); ids.add(check.id);
    requireValue(['verify', 'rules', 'review', 'security'].includes(check.gate), 'invalid-check-gate', true);
    requireValue(Array.isArray(check.inputs) && check.inputs.length <= QA_LIMITS.files, 'invalid-check-inputs', true);
    for (const p of [...check.inputs, ...(check.ignored_inputs ?? [])]) portablePath(p);
    requireValue(check.requires_observed === undefined || typeof check.requires_observed === 'boolean', 'invalid-observation-policy', true);
    requireValue(Array.isArray(check.command?.argv) && check.command.argv.length > 0
      && check.command.argv.every(a => typeof a === 'string'), 'command-unproven', true);
    requireValue(typeof check.command.cwd === 'string', 'command-unproven', true);
    if (check.command.cwd !== '.') portablePath(check.command.cwd);
    if (check.command.definition) portablePath(check.command.definition);
    requireValue(Array.isArray(check.env_inputs ?? []) && (check.env_inputs ?? []).every(n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)), 'invalid-environment-input', true);
    return { ...check, requires_observed: check.requires_observed ?? false };
  });
}

// Closed registry v1. Only these schema/path/field combinations are projected.
// Unknown fields remain hashed. Declared inputs/policy/scope bypass projection.
export function metadataProjection(relative, data) {
  if (data === null) return null;
  let value;
  try { value = JSON.parse(data.toString('utf8')); } catch { return null; }
  let fields;
  if (/^\.ai-factory\/state\/[^/]+\/delivery\/[^/]+\.json$/.test(relative)
      && value.schema === 'aifhub.delivery.v1') fields = ['retry_count', 'ack', 'query_state', 'updated_at'];
  if (/^\.ai-factory\/state\/[^/]+\/status\.json$/.test(relative)
      && value.schema === 'aifhub.operational-status.v1') fields = ['status', 'display', 'updated_at'];
  if (!fields) return null;
  if ('retry_count' in value && (!Number.isInteger(value.retry_count) || value.retry_count < 0)) return null;
  if ('ack' in value && typeof value.ack !== 'boolean') return null;
  if ('query_state' in value && !['pending', 'received', 'unknown'].includes(value.query_state)) return null;
  if ('status' in value && !['idle', 'running', 'waiting', 'complete', 'failed'].includes(value.status)) return null;
  if (['display', 'updated_at'].some(k => k in value && typeof value[k] !== 'string')) return null;
  const protectedValue = { ...value };
  for (const field of fields) delete protectedValue[field];
  return digest({ registry: 'qa-metadata.v1', value: protectedValue });
}

export function dependencyRoots(payload, check) {
  return sorted([...check.inputs, ...(check.ignored_inputs ?? []), ...(payload.policy_inputs ?? []),
    ...(check.command.definition ? [check.command.definition] : []),
    ...(check.toolchain ?? []).filter(t => t.path).map(t => portablePath(t.path))]);
}

export function allDeclaredRoots(payload) {
  return sorted([...(payload.scope ?? []), ...(payload.policy_inputs ?? []), ...(payload.module_inputs ?? []),
    ...payload.checks.flatMap(c => dependencyRoots(payload, c))]);
}

export async function observeQaSnapshot(store, payload, options = {}) {
  const provider = options.SnapshotProvider ?? options.snapshotProvider;
  const observed = provider
    ? await (typeof provider === 'function' ? provider : provider.observe.bind(provider))({ rootDir: store.root, payload })
    : await filesystemSnapshot(store, payload, options);
  requireValue(observed && observed.complete === true && typeof observed.worktree_identity === 'string'
    && observed.worktree_identity.length > 0, 'snapshot-incomplete', true);
  requireValue(observed.files && typeof observed.files === 'object', 'snapshot-incomplete', true);
  const names = Object.keys(observed.files);
  requireValue(names.length <= QA_LIMITS.files, 'qa-files-limit', true);
  const collision = new Map();
  const directoryCase = new Map();
  function registerPath(relative) {
    const parts = relative.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      requireValue(!directoryCase.has(prefix.toLowerCase()) || directoryCase.get(prefix.toLowerCase()) === prefix,
        'path-case-collision', true);
      directoryCase.set(prefix.toLowerCase(), prefix);
    }
  }
  const directories = new Set(observed.directory_names ?? []);
  requireValue(directories.size <= QA_LIMITS.files && [...directories].every(p => Object.hasOwn(observed.files, p)
    && observed.files[p] === null), 'directory-catalog-invalid', true);
  let bytes = 0;
  const files = Object.create(null);
  for (const relative of names.sort()) {
    sourcePath(relative);
    registerPath(relative);
    requireValue(!collision.has(relative.toLowerCase()), 'path-case-collision', true);
    collision.set(relative.toLowerCase(), relative);
    const data = observed.files[relative];
    requireValue(data === null || Buffer.isBuffer(data), 'invalid-snapshot-bytes', true);
    requireValue(data === null || data.length <= QA_LIMITS.blob, 'qa-blob-limit', true);
    bytes += data?.length ?? 0;
    if (provider) chargeQaRead(options, data?.length ?? 0);
    requireValue(bytes <= QA_LIMITS.bytes, 'qa-read-budget', true);
    const material = allDeclaredRoots(payload).some(root => within(relative, root));
    files[relative] = data === null ? { kind: directories.has(relative) ? 'directory' : 'missing' } : { kind: 'file', sha256: digest(data),
      projection: material ? null : metadataProjection(relative, data) };
  }
  const ignored = sorted(observed.ignored_names ?? []);
  requireValue(ignored.length <= QA_LIMITS.files, 'qa-files-limit', true);
  for (const p of ignored) {
    sourcePath(p);
    registerPath(p);
    requireValue(!collision.has(p.toLowerCase()) || collision.get(p.toLowerCase()) === p, 'path-case-collision', true);
    collision.set(p.toLowerCase(), p);
  }
  requireValue(new Set([...names, ...ignored]).size <= QA_LIMITS.files, 'qa-files-limit', true);
  requireValue(observed.modules && Object.keys(observed.modules).length > 0
    && Object.values(observed.modules).every(hash => SHA.test(hash)), 'module-identity-unproven', true);
  const changedPaths = sorted(observed.changed_paths ?? []);
  requireValue(changedPaths.length <= QA_LIMITS.files, 'qa-files-limit', true);
  for (const p of changedPaths) {
    sourcePath(p);
    requireValue(allDeclaredRoots(payload).some(root => within(p, root)) || files[p]?.projection,
      'out-of-scope-edit', true);
  }
  const snapshot = { files, ignored_names: ignored, worktree_identity: observed.worktree_identity,
    modules: observed.modules ?? {}, actual_diff: observed.actual_diff ?? null, changed_paths: changedPaths };
  jsonValue(snapshot);
  return { ...snapshot, digest: digest(snapshot) };
}

export async function checkFingerprints(payload, snapshot, options = {}) {
  const fingerprints = {};
  for (const frozen of payload.checks) {
    const check = options.providers?.checkDefinition ? await options.providers.checkDefinition(frozen) : frozen;
    requireValue(check.id === frozen.id && check.gate === frozen.gate, 'check-identity-drift', true);
    const dependencies = options.providers?.dependencies ? await options.providers.dependencies(check) : check;
    requireValue(dependencies.profile === 'declared.v1' && dependencies.dependencies_complete === true,
      'dependency-unproven', true);
    const roots = dependencyRoots(payload, check);
    const files = Object.create(null);
    for (const root of roots) {
      const members = Object.keys(snapshot.files).filter(p => within(p, root)).sort();
      requireValue(members.length > 0, 'dependency-catalog-incomplete', true);
      for (const p of members) files[p] = snapshot.files[p];
    }
    const toolchain = options.providers?.toolchain ? await options.providers.toolchain(check)
      : (check.toolchain ?? []).map(t => {
        requireValue(t.path && snapshot.files[t.path]?.kind === 'file', 'toolchain-unproven', true);
        return { ...t, sha256: snapshot.files[t.path].sha256 };
      });
    requireValue(Array.isArray(toolchain) && toolchain.length > 0
      && toolchain.every(t => typeof t.name === 'string' && SHA.test(t.sha256)), 'toolchain-unproven', true);
    const env = options.environment ?? process.env;
    const environment = Object.create(null);
    for (const name of sorted(check.env_inputs ?? [])) environment[name] = Object.hasOwn(env, name)
      ? { state: 'present', sha256: digest(String(env[name])) } : { state: 'absent' };
    fingerprints[check.id] = digest({ profile: 'declared.v1', files, command: check.command, toolchain, environment,
      actual_diff: check.depends_on_diff ? snapshot.actual_diff : null });
  }
  return fingerprints;
}

async function filesystemSnapshot(store, payload, options) {
  const run = options.execFile ?? exec;
  async function git(args) {
    const value = await run('git', args, { cwd: store.root, encoding: 'utf8', windowsHide: true,
      maxBuffer: QA_LIMITS.blob, timeout: 30000 });
    return String(value.stdout ?? value);
  }
  const visible = (await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const ignored = (await git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const stage = await git(['ls-files', '--stage', '-z']);
  requireValue(!/(?:^|\0)160000 /.test(stage), 'submodule-identity-unproven', true);
  const actualDiff = await git(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']);
  const changedPaths = sorted([...(await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--'])).split('\0'),
    ...(await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0')].filter(Boolean));
  const roots = allDeclaredRoots(payload);
  const qaInternal = p => within(p, `${store.qa}/waves`) || within(p, `${store.qa}/results`)
    || within(p, `${store.qa}/bodies`) || within(p, `${store.qa}/artifacts`)
    || within(p, `${store.qa}/publications`) || within(p, `${store.qa}/journals`)
    || ['manifest.json', 'enrollment.json', 'publication.json', 'qa.lock', 'verify.md',
      ...(payload.target.flow === 'classic' ? ['gates'] : ['rules.md']), 'review.md', 'security.md', 'coverage.json', 'done-readiness.json', '.gitignore', 'raw', 'openspec-validation.json', 'openspec-status.json']
      .some(name => withinCi(p, `${store.qa}/${name}`));
  const excluded = p => within(p, '.git') || qaInternal(p);
  requireValue(!roots.some(excluded), 'self-referential-input', true);
  const names = new Set(visible.filter(p => !excluded(p)));
  const directories = new Set();
  // Inventory declared ignored roots, plus the two closed metadata namespaces.
  const scanRoots = sorted([...roots, `.ai-factory/state/${payload.target.id}/delivery`, `.ai-factory/state/${payload.target.id}/status.json`]);
  async function walk(relative, tombstone = true) {
    sourcePath(relative);
    const filename = await store.safeTarget(relative);
    let info;
    try { info = await lstat(filename); }
    catch (e) { if (e.code !== 'ENOENT') throw e; if (tombstone) names.add(relative); return; }
    if (info.isFile()) names.add(relative);
    else {
      names.add(relative); directories.add(relative);
      const entries = await readdir(filename);
      requireValue(entries.length <= QA_LIMITS.files, 'qa-files-limit', true);
      for (const name of entries.sort()) await walk(`${relative}/${name}`, tombstone);
    }
    requireValue(names.size <= QA_LIMITS.files, 'qa-files-limit', true);
  }
  for (const root of scanRoots) await walk(root, roots.includes(root));
  requireValue(names.size <= QA_LIMITS.files && ignored.length <= QA_LIMITS.files, 'qa-files-limit', true);
  const files = Object.create(null);
  let readBudget = 0;
  for (const name of [...names].sort()) {
    const filename = await store.safeTarget(name);
    const info = await lstat(filename).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (info?.isDirectory()) files[name] = null;
    else {
      readBudget += info?.size ?? 0;
      requireValue(readBudget <= QA_LIMITS.bytes, 'qa-read-budget', true);
      files[name] = await store.bytes(name);
    }
  }
  const helper = await storeFor(fileURLToPath(new URL('../', import.meta.url)));
  const modules = {};
  async function moduleIdentity(relative) {
    if (Object.hasOwn(modules, relative)) return;
    portablePath(relative);
    requireValue(Object.keys(modules).length < 256, 'module-catalog-limit', true);
    const data = await helper.bytes(relative);
    chargeQaRead(options, data?.length ?? 0);
    modules[relative] = data === null ? digest('missing') : digest(data);
    if (data === null || !relative.endsWith('.mjs')) return;
    // Pin the installed local module closure, not just version strings. External
    // runtime/dependency identities still belong to each check's trusted profile.
    const imports = [...data.toString('utf8').matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+\.mjs)['"]/g)];
    for (const match of imports) await moduleIdentity(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
  }
  for (const name of MODULES) await moduleIdentity(`scripts/${name}`);
  for (const name of ['extension.json', 'provenance.json', 'aifhub-extension.json']) await moduleIdentity(name);
  for (const name of payload.module_inputs ?? []) modules[name] = digest(files[name] ?? 'missing');
  const rootInfo = await lstat(store.root, { bigint: true });
  requireValue(rootInfo.isDirectory() && rootInfo.ino > 0n, 'unsupported-file-identity', true);
  return { complete: true, files, modules, actual_diff: digest(actualDiff),
    directory_names: [...directories].sort(),
    changed_paths: changedPaths.filter(p => !excluded(p)),
    worktree_identity: digest({ root: store.root, device: String(rootInfo.dev), inode: String(rootInfo.ino) }),
    ignored_names: ignored.filter(p => !excluded(p)
      && !roots.some(root => within(p, root)) && !scanRoots.some(root => within(p, root))) };
}
