// legacy-ultra-verification-receipt.mjs - revision-bound verification receipts for upstream ultra plans
import { execFile as defaultExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { classifyLegacyPlanShape } from './legacy-plan-migration.mjs';
import { validateGateResult } from './aif-gate-result.mjs';

export const LEGACY_ULTRA_RECEIPT_SCHEMA_VERSION = 1;
export const LEGACY_ULTRA_RECEIPT_ROOT = '.ai-factory/state/legacy-ultra-verification';

const WORKTREE_EXCLUSIONS = Object.freeze([
  '.git',
  '.ai-factory/state',
  '.ai-factory/qa',
  '.ai-factory/rules/generated'
]);

export function normalizeLegacyUltraEntrypoint(input) {
  const value = typeof input === 'string' ? input.trim().replaceAll('\\', '/') : '';
  if (
    value === ''
    || value.includes('\0')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
  ) {
    return entrypointFailure();
  }

  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..') || parts.length < 2) return entrypointFailure();
  const lastPart = parts.at(-1);
  if (lastPart.toLowerCase() === 'index.md' && lastPart !== 'index.md') {
    return entrypointFailure(
      'legacy-ultra-entrypoint-noncanonical',
      'Legacy ultra entrypoint must use the exact lowercase index.md filename.'
    );
  }
  if (lastPart !== 'index.md') parts.push('index.md');
  if (parts.length < 3) return entrypointFailure();

  return {
    ok: true,
    entrypoint: parts.join('/'),
    planDir: parts.slice(0, -1).join('/'),
    planId: parts.at(-2),
    plansRoot: parts.slice(0, -2).join('/'),
    error: null
  };
}

export function legacyUltraReceiptPath(entrypoint) {
  const normalized = normalizeLegacyUltraEntrypoint(entrypoint);
  if (!normalized.ok) return normalized;
  const entrypointDigest = sha256Text(normalized.entrypoint);
  return {
    ok: true,
    entrypoint: normalized.entrypoint,
    entrypointDigest,
    receiptPath: `${LEGACY_ULTRA_RECEIPT_ROOT}/${entrypointDigest}.json`,
    error: null
  };
}

export async function computeLegacyUltraBundleBinding(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const normalized = normalizeLegacyUltraEntrypoint(options.entrypoint);
  if (!normalized.ok) return createBindingFailure(normalized.error.code, normalized.error.message);

  const classification = await classifyLegacyPlanShape(normalized.planId, {
    rootDir,
    legacyPlanSourceRoot: normalized.plansRoot
  });
  if (classification.shape !== 'ultra-valid' || classification.planDir !== normalized.planDir) {
    return createBindingFailure(
      'legacy-ultra-bundle-invalid',
      'Entrypoint does not resolve to one valid marked upstream ultra plan bundle.',
      normalized.entrypoint,
      classification.errors.map(({ code, path: errorPath }) => ({ code, path: errorPath }))
    );
  }

  const bundleFiles = [normalized.entrypoint, ...classification.phaseFiles]
    .sort(compareProjectPaths);
  const manifest = await buildManifestForPaths(rootDir, bundleFiles);
  if (!manifest.ok) return manifest;

  return {
    ok: true,
    entrypoint: normalized.entrypoint,
    planDir: normalized.planDir,
    files: bundleFiles,
    manifest: manifest.manifest,
    bundleDigest: sha256Text(manifest.manifest),
    errors: []
  };
}

export async function computeLegacyUltraWorktreeBinding(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const normalized = normalizeLegacyUltraEntrypoint(options.entrypoint);
  if (!normalized.ok) return createBindingFailure(normalized.error.code, normalized.error.message);
  const execFile = options.execFile ?? defaultExecFile;

  const gitFiles = await executeGit(execFile, rootDir, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  let sourceRevision;
  let paths;
  if (gitFiles.ok) {
    const head = await executeGit(execFile, rootDir, ['rev-parse', '--verify', 'HEAD']);
    if (!head.ok || !/^[a-f0-9]{40,64}$/i.test(head.stdout.trim())) {
      return createBindingFailure('legacy-ultra-git-head-invalid', 'Git HEAD could not be resolved for receipt binding.');
    }
    sourceRevision = { kind: 'git-head', value: head.stdout.trim() };
    paths = gitFiles.stdout.split('\0').filter(Boolean).map(toProjectPath);
  } else if (isNotGitRepository(gitFiles)) {
    const manualBuildId = normalizeManualBuildId(options.manualBuildId);
    if (!manualBuildId.ok) return createBindingFailure(manualBuildId.error.code, manualBuildId.error.message);
    sourceRevision = { kind: 'manual-build-id', value: manualBuildId.value };
    paths = await enumerateNonGitFiles(rootDir);
  } else {
    return createBindingFailure(
      'legacy-ultra-git-inventory-failed',
      'Git worktree inventory failed before receipt binding.'
    );
  }

  const filteredPaths = [...new Set(paths)]
    .filter((projectPath) => !isExcludedWorktreePath(projectPath, normalized.planDir))
    .sort(compareProjectPaths);
  const manifest = await buildManifestForPaths(rootDir, filteredPaths, { allowMissing: true });
  if (!manifest.ok) return manifest;

  return {
    ok: true,
    sourceRevision,
    files: filteredPaths,
    manifest: manifest.manifest,
    worktreeDigest: sha256Text(manifest.manifest),
    errors: []
  };
}

export async function writeLegacyUltraVerificationReceipt(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const receiptLocation = legacyUltraReceiptPath(options.entrypoint);
  if (!receiptLocation.ok) return createReceiptFailure(receiptLocation.error.code, receiptLocation.error.message, null);

  const gate = validateGateResult(options.gateOutcome, { gate: 'verify' });
  if (!gate.ok) {
    return createReceiptFailure(
      'legacy-ultra-gate-outcome-invalid',
      'Receipt requires one valid upstream verify aif-gate-result.',
      receiptLocation.entrypoint
    );
  }

  const verifiedAt = normalizeVerifiedAt(options.verifiedAt ?? new Date().toISOString());
  if (!verifiedAt.ok) {
    return createReceiptFailure(verifiedAt.error.code, verifiedAt.error.message, receiptLocation.entrypoint);
  }

  const bundle = await computeLegacyUltraBundleBinding({ rootDir, entrypoint: receiptLocation.entrypoint });
  if (!bundle.ok) return createReceiptFailure(bundle.errors[0].code, bundle.errors[0].message, receiptLocation.entrypoint);
  const worktree = await computeLegacyUltraWorktreeBinding({
    rootDir,
    entrypoint: receiptLocation.entrypoint,
    manualBuildId: options.manualBuildId,
    execFile: options.execFile
  });
  if (!worktree.ok) return createReceiptFailure(worktree.errors[0].code, worktree.errors[0].message, receiptLocation.entrypoint);

  const receipt = {
    schemaVersion: LEGACY_ULTRA_RECEIPT_SCHEMA_VERSION,
    entrypoint: receiptLocation.entrypoint,
    entrypointDigest: receiptLocation.entrypointDigest,
    bundleDigest: bundle.bundleDigest,
    sourceRevision: worktree.sourceRevision,
    worktreeDigest: worktree.worktreeDigest,
    verifiedAt: verifiedAt.value,
    sourceCommand: `/aif-verify ${receiptLocation.entrypoint}`,
    gateOutcome: gate.value
  };
  const absoluteReceiptPath = path.resolve(rootDir, fromProjectPath(receiptLocation.receiptPath));
  try {
    await mkdir(path.dirname(absoluteReceiptPath), { recursive: true });
    await writeFile(absoluteReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  } catch {
    return createReceiptFailure(
      'legacy-ultra-receipt-write-failed',
      'Legacy ultra verification receipt could not be written.',
      receiptLocation.entrypoint
    );
  }

  return {
    ok: true,
    status: 'recorded',
    code: 'legacy-ultra-receipt-recorded',
    entrypoint: receiptLocation.entrypoint,
    receiptPath: receiptLocation.receiptPath,
    receipt,
    errors: []
  };
}

export async function evaluateLegacyUltraVerificationReceipt(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const receiptLocation = legacyUltraReceiptPath(options.entrypoint);
  if (!receiptLocation.ok) {
    return createEvaluationBlock(
      receiptLocation.error.code,
      receiptLocation.error.message,
      null,
      null
    );
  }

  const bundle = await computeLegacyUltraBundleBinding({ rootDir, entrypoint: receiptLocation.entrypoint });
  if (!bundle.ok) {
    return createEvaluationBlock(
      bundle.errors[0].code,
      bundle.errors[0].message,
      receiptLocation.entrypoint,
      receiptLocation.receiptPath
    );
  }
  const worktree = await computeLegacyUltraWorktreeBinding({
    rootDir,
    entrypoint: receiptLocation.entrypoint,
    manualBuildId: options.manualBuildId,
    execFile: options.execFile
  });
  if (!worktree.ok) {
    return createEvaluationBlock(
      worktree.errors[0].code,
      worktree.errors[0].message,
      receiptLocation.entrypoint,
      receiptLocation.receiptPath
    );
  }

  const loaded = options.receipt === undefined
    ? await readReceipt(rootDir, receiptLocation.receiptPath)
    : { ok: true, receipt: options.receipt, error: null };
  if (!loaded.ok) {
    return createEvaluationBlock(
      loaded.error.code,
      loaded.error.message,
      receiptLocation.entrypoint,
      receiptLocation.receiptPath,
      bundle,
      worktree
    );
  }

  const receipt = loaded.receipt;
  const structuralError = validateReceiptStructure(receipt, receiptLocation);
  if (structuralError !== null) {
    return createEvaluationBlock(
      structuralError.code,
      structuralError.message,
      receiptLocation.entrypoint,
      receiptLocation.receiptPath,
      bundle,
      worktree
    );
  }

  const gate = validateGateResult(receipt.gateOutcome, { gate: 'verify' });
  if (!gate.ok) {
    return createEvaluationBlock(
      'legacy-ultra-receipt-gate-invalid',
      'Receipt verify gate outcome is invalid.',
      receiptLocation.entrypoint,
      receiptLocation.receiptPath,
      bundle,
      worktree
    );
  }
  if (gate.value.status !== 'pass') {
    return createEvaluationBlock(
      'legacy-ultra-receipt-non-pass',
      'Receipt verify gate outcome is not pass.',
      receiptLocation.entrypoint,
      receiptLocation.receiptPath,
      bundle,
      worktree,
      gate.value.status
    );
  }
  if (receipt.bundleDigest !== bundle.bundleDigest) {
    return createEvaluationBlock(
      'legacy-ultra-receipt-bundle-stale',
      'Receipt bundle digest does not match the current upstream ultra bundle.',
      receiptLocation.entrypoint,
      receiptLocation.receiptPath,
      bundle,
      worktree,
      gate.value.status
    );
  }
  if (
    receipt.sourceRevision.kind !== worktree.sourceRevision.kind
    || receipt.sourceRevision.value !== worktree.sourceRevision.value
  ) {
    return createEvaluationBlock(
      'legacy-ultra-receipt-revision-stale',
      'Receipt source revision does not match the current workspace revision.',
      receiptLocation.entrypoint,
      receiptLocation.receiptPath,
      bundle,
      worktree,
      gate.value.status
    );
  }
  if (receipt.worktreeDigest !== worktree.worktreeDigest) {
    return createEvaluationBlock(
      'legacy-ultra-receipt-worktree-stale',
      'Receipt worktree digest does not match current tracked and non-ignored untracked content.',
      receiptLocation.entrypoint,
      receiptLocation.receiptPath,
      bundle,
      worktree,
      gate.value.status
    );
  }

  return {
    ok: true,
    status: 'ready',
    code: 'legacy-ultra-receipt-current-pass',
    entrypoint: receiptLocation.entrypoint,
    receiptPath: receiptLocation.receiptPath,
    bundleDigest: bundle.bundleDigest,
    sourceRevision: worktree.sourceRevision,
    worktreeDigest: worktree.worktreeDigest,
    gateStatus: gate.value.status,
    handoff: `/aif-archive ${receiptLocation.entrypoint}`,
    errors: []
  };
}

async function buildManifestForPaths(rootDir, projectPaths, options = {}) {
  const rows = [];
  for (const projectPath of projectPaths) {
    const absolutePath = path.resolve(rootDir, fromProjectPath(projectPath));
    if (!isInsidePath(rootDir, absolutePath)) {
      return createBindingFailure('legacy-ultra-manifest-path-escape', 'Manifest path escapes the project root.');
    }

    let stat;
    try {
      stat = await lstat(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT' && options.allowMissing === true) {
        rows.push([projectPath, 'missing', null]);
        continue;
      }
      return createBindingFailure('legacy-ultra-manifest-read-failed', 'Manifest input could not be read.', projectPath);
    }

    if (stat.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      rows.push([projectPath, 'symlink', sha256Text(target)]);
    } else if (stat.isFile()) {
      const content = await readFile(absolutePath);
      rows.push([projectPath, 'file', sha256Bytes(content)]);
    } else {
      rows.push([projectPath, 'other', null]);
    }
  }

  return {
    ok: true,
    manifest: `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    errors: []
  };
}

async function enumerateNonGitFiles(rootDir) {
  const files = [];
  async function visit(directory, prefix = '') {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareProjectPaths(left.name, right.name));
    for (const entry of entries) {
      const projectPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isExcludedWorktreePath(projectPath, null)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, projectPath);
      else files.push(toProjectPath(projectPath));
    }
  }
  await visit(rootDir);
  return files;
}

function isExcludedWorktreePath(projectPath, planDir) {
  const normalized = toProjectPath(projectPath);
  if (planDir !== null && (normalized === planDir || normalized.startsWith(`${planDir}/`))) return true;
  return WORKTREE_EXCLUSIONS.some((excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`));
}

function executeGit(execFile, cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 50 * 1024 * 1024 }, (error, stdout = '', stderr = '') => {
      resolve({ ok: error === null, error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function isNotGitRepository(result) {
  const combined = `${result?.stderr ?? ''}\n${result?.error?.message ?? ''}`;
  return /not a git repository/i.test(combined);
}

async function readReceipt(rootDir, receiptPath) {
  try {
    const raw = await readFile(path.resolve(rootDir, fromProjectPath(receiptPath)), 'utf8');
    return { ok: true, receipt: JSON.parse(raw), error: null };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        ok: false,
        receipt: null,
        error: { code: 'legacy-ultra-receipt-missing', message: 'Current legacy ultra verification receipt is missing.' }
      };
    }
    return {
      ok: false,
      receipt: null,
      error: { code: 'legacy-ultra-receipt-invalid', message: 'Legacy ultra verification receipt is unreadable or invalid JSON.' }
    };
  }
}

function validateReceiptStructure(receipt, expected) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { code: 'legacy-ultra-receipt-invalid', message: 'Receipt must be a JSON object.' };
  }
  if (receipt.schemaVersion !== LEGACY_ULTRA_RECEIPT_SCHEMA_VERSION) {
    return { code: 'legacy-ultra-receipt-schema-invalid', message: 'Receipt schema version is unsupported.' };
  }
  if (receipt.entrypoint !== expected.entrypoint || receipt.entrypointDigest !== expected.entrypointDigest) {
    return { code: 'legacy-ultra-receipt-entrypoint-mismatch', message: 'Receipt is bound to a different normalized entrypoint.' };
  }
  if (receipt.sourceCommand !== `/aif-verify ${expected.entrypoint}`) {
    return { code: 'legacy-ultra-receipt-command-mismatch', message: 'Receipt source command does not match the normalized entrypoint.' };
  }
  if (!normalizeVerifiedAt(receipt.verifiedAt).ok) {
    return { code: 'legacy-ultra-receipt-timestamp-invalid', message: 'Receipt verifiedAt timestamp is invalid.' };
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.bundleDigest ?? '') || !/^[a-f0-9]{64}$/.test(receipt.worktreeDigest ?? '')) {
    return { code: 'legacy-ultra-receipt-digest-invalid', message: 'Receipt digests must be lowercase SHA256 values.' };
  }
  if (
    receipt.sourceRevision === null
    || typeof receipt.sourceRevision !== 'object'
    || !['git-head', 'manual-build-id'].includes(receipt.sourceRevision.kind)
    || typeof receipt.sourceRevision.value !== 'string'
    || receipt.sourceRevision.value === ''
  ) {
    return { code: 'legacy-ultra-receipt-revision-invalid', message: 'Receipt source revision is invalid.' };
  }
  return null;
}

function createEvaluationBlock(code, message, entrypoint, receiptPath, bundle = null, worktree = null, gateStatus = null) {
  return {
    ok: false,
    status: 'blocked',
    code,
    entrypoint,
    receiptPath,
    bundleDigest: bundle?.bundleDigest ?? null,
    sourceRevision: worktree?.sourceRevision ?? null,
    worktreeDigest: worktree?.worktreeDigest ?? null,
    gateStatus,
    handoff: entrypoint === null ? '/aif-verify <entrypoint>' : `/aif-verify ${entrypoint}`,
    errors: [{ code, message }]
  };
}

function createReceiptFailure(code, message, entrypoint) {
  return {
    ok: false,
    status: 'failed',
    code,
    entrypoint,
    receiptPath: null,
    receipt: null,
    errors: [{ code, message }]
  };
}

function createBindingFailure(code, message, projectPath = null, details = []) {
  return {
    ok: false,
    entrypoint: null,
    manifest: null,
    errors: [{ code, message, ...(projectPath === null ? {} : { path: projectPath }), ...(details.length === 0 ? {} : { details }) }]
  };
}

function entrypointFailure(
  code = 'legacy-ultra-entrypoint-unsafe',
  message = 'Legacy ultra entrypoint must be a safe project-relative bundle directory or index.md path.'
) {
  return {
    ok: false,
    entrypoint: null,
    planDir: null,
    planId: null,
    plansRoot: null,
    error: {
      code,
      message
    }
  };
}

function normalizeVerifiedAt(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (value === '' || Number.isNaN(Date.parse(value)) || value.length > 64) {
    return {
      ok: false,
      value: null,
      error: { code: 'legacy-ultra-verified-at-invalid', message: 'verifiedAt must be a bounded ISO-compatible timestamp.' }
    };
  }
  return { ok: true, value, error: null };
}

function normalizeManualBuildId(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (value === '' || value.length > 256 || /[\r\n\0]/.test(value)) {
    return {
      ok: false,
      value: null,
      error: {
        code: 'legacy-ultra-manual-build-id-required',
        message: 'A bounded manualBuildId is required outside a Git worktree.'
      }
    };
  }
  return { ok: true, value, error: null };
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function toProjectPath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function fromProjectPath(value) {
  return value.split('/').join(path.sep);
}

function compareProjectPaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInsidePath(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
