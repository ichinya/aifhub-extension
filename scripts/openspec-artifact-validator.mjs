#!/usr/bin/env node
// openspec-artifact-validator.mjs - read-only AIFHub OpenSpec artifact contract checks
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  matchesSourceBoundChangeId,
  normalizeChangeId,
  parseWorkItemSourceBinding,
  resolveActiveChange as defaultResolveActiveChange
} from './active-change-resolver.mjs';
import {
  collectCanonicalChangeArtifacts,
  collectGeneratedRules
} from './openspec-execution-context.mjs';
import {
  readLatestVerificationEvidence as defaultReadLatestVerificationEvidence
} from './openspec-verification-context.mjs';
import {
  getLatestGateResult
} from './aif-gate-result.mjs';
import {
  readOpenSpecSkipSpecsMarker
} from './openspec-change-metadata.mjs';
import {
  hasActiveStandaloneMarker,
  ULTRA_PLAN_MARKER
} from './markdown-structural-markers.mjs';

export const ARTIFACT_CONTRACT_SCHEMA_VERSION = 1;
export const ARTIFACT_CONTRACT_VALIDATOR = 'aifhub-openspec-artifact-contract';

const DEFAULT_QA_DIR = path.join('.ai-factory', 'qa');
const DEFAULT_CONFIG_PATH = path.join('.ai-factory', 'config.yaml');
const REQUIRED_CHANGE_ARTIFACTS = ['proposal.md', 'tasks.md'];
const RUNTIME_FILE_NAMES = new Set([
  'verify.md',
  'validation.md',
  'status.md',
  'done.md',
  'final-summary.md',
  'openspec-validation.json',
  'openspec-status.json',
  'openspec-archive.json',
  'implementation.md',
  'fixes.md',
  'raw-stdout.txt',
  'raw-stderr.txt'
]);
const RUNTIME_DIR_NAMES = new Set([
  '.ai-factory',
  'qa',
  'state',
  'implementation',
  'fixes',
  'raw',
  'generated',
  'reports'
]);
const LEGACY_COMPANION_FILE_NAMES = new Set([
  'task.md',
  'task-prepare.md',
  'context.md',
  'rules.md',
  'verify.md',
  'status.yaml',
  'status.yml',
  'explore.md'
]);

export async function validateOpenSpecArtifactContract(options = {}) {
  const rootDir = resolveRootDir(options);
  const config = await readValidatorConfig(rootDir);
  const resolved = await resolveChange(options, rootDir);

  if (!resolved.ok) {
    return createResult({
      changeId: resolved.changeId,
      checks: [
        createCheck({
          id: 'active-change-resolved',
          status: 'fail',
          message: resolved.errors[0]?.message ?? 'Unable to resolve an active OpenSpec change.'
        })
      ],
      suggestedNext: {
        command: '/aif-mode status',
        reason: 'Select or pass an active OpenSpec change before running artifact validation.'
      }
    });
  }

  const checks = [];
  const changeId = resolved.changeId;
  const changeDir = resolved.changePath;
  const canonical = await collectCanonicalChangeArtifacts(changeId, {
    ...options,
    rootDir
  });
  const artifacts = canonical.canonicalArtifacts ?? {};
  const skipSpecs = await readOpenSpecSkipSpecsMarker(changeDir);

  checks.push(...inspectRequiredArtifacts(artifacts));
  checks.push(inspectWorkItemSourceBinding(changeId, artifacts.proposal));
  checks.push(inspectDesignArtifact(artifacts.design, config.requireDesign));
  checks.push(inspectDeltaSpecs(artifacts, config, skipSpecs, rootDir));
  checks.push(...await inspectPlanningArtifacts(rootDir, changeDir));
  checks.push(...await inspectRuntimeFiles(rootDir, changeDir));
  checks.push(...await inspectVerificationEvidence(changeId, {
    ...options,
    rootDir,
    qaDir: config.qaDir
  }));
  checks.push(...await inspectGeneratedRules(changeId, {
    ...options,
    rootDir
  }));
  checks.push(inspectBaseSpecMutation(options.changedPaths, options.allowBaseSpecMutation));

  return createResult({
    changeId,
    checks,
    suggestedNext: chooseSuggestedNext(changeId, checks)
  });
}

export function parseArtifactValidatorArgs(argv) {
  const args = Array.from(argv ?? []);
  const result = {
    ok: true,
    changeId: null,
    json: false,
    requireVerificationEvidence: false,
    allowBaseSpecMutation: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--change') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return invalidArgs('Missing value for --change.');
      }

      result.changeId = value;
      index += 1;
      continue;
    }

    if (arg === '--json') {
      result.json = true;
      continue;
    }

    if (arg === '--require-verification-evidence') {
      result.requireVerificationEvidence = true;
      continue;
    }

    if (arg === '--allow-base-spec-mutation') {
      result.allowBaseSpecMutation = true;
      continue;
    }

    return invalidArgs(`Unknown option: ${arg}.`);
  }

  return result;
}

export async function runArtifactValidatorCommand(argv, options = {}) {
  const parsed = parseArtifactValidatorArgs(argv);
  if (!parsed.ok) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${parsed.error}\n`
    };
  }

  const result = await validateOpenSpecArtifactContract({
    ...options,
    changeId: parsed.changeId ?? options.changeId,
    requireVerificationEvidence: parsed.requireVerificationEvidence || options.requireVerificationEvidence,
    allowBaseSpecMutation: parsed.allowBaseSpecMutation || options.allowBaseSpecMutation
  });
  const stdout = parsed.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${renderArtifactValidatorResult(result)}\n`;

  return {
    exitCode: isUnresolvedChangeResult(result) ? 2 : result.status === 'fail' ? 1 : 0,
    stdout,
    stderr: ''
  };
}

export function renderArtifactValidatorResult(result) {
  const suggested = result.suggested_next
    ? [
      '',
      `Suggested next: ${result.suggested_next.command}`,
      `Reason: ${result.suggested_next.reason}`
    ]
    : [];

  return [
    `AIFHub OpenSpec artifact contract: ${String(result.status).toUpperCase()}`,
    `Change: ${result.change_id ?? 'unresolved'}`,
    `Blocking: ${result.blocking ? 'yes' : 'no'}`,
    '',
    'Checks:',
    ...result.checks.map((check) => renderCheckLine(check)),
    ...suggested
  ].join('\n');
}

function inspectRequiredArtifacts(artifacts) {
  return REQUIRED_CHANGE_ARTIFACTS.map((artifactName) => {
    const artifact = artifacts[path.basename(artifactName, '.md')];
    return createCheck({
      id: `${path.basename(artifactName, '.md')}-present`,
      status: artifact?.exists ? 'pass' : 'fail',
      path: artifact?.path ?? `openspec/changes/<change-id>/${artifactName}`,
      message: artifact?.exists
        ? `${artifactName} is present.`
        : `${artifactName} is required for an AIFHub OpenSpec change.`
    });
  });
}

function inspectWorkItemSourceBinding(changeId, proposal) {
  const checkPath = proposal?.path ?? `openspec/changes/${changeId}/proposal.md`;
  const parsed = parseWorkItemSourceBinding(proposal?.content ?? '');

  if (!parsed.ok) {
    return createCheck({
      id: 'issue-source-binding',
      status: 'fail',
      path: checkPath,
      message: 'The reserved AIFHub source binding is malformed.',
      details: {
        rule_code: parsed.error.code
      }
    });
  }

  if (parsed.status === 'absent') {
    return createCheck({
      id: 'issue-source-binding',
      status: 'pass',
      path: checkPath,
      message: 'No MCP work-item source binding is declared for this change.'
    });
  }

  if (!matchesSourceBoundChangeId(changeId, parsed.binding.externalId)) {
    return createCheck({
      id: 'issue-source-binding',
      status: 'fail',
      path: checkPath,
      message: 'The OpenSpec change id must start with the normalized external ID followed by a request slug.',
      details: {
        rule_code: 'source-binding-change-id-mismatch'
      }
    });
  }

  return createCheck({
    id: 'issue-source-binding',
    status: 'pass',
    path: checkPath,
    message: 'The provider, primary source, external ID, and branch binding match the source-bound change id.'
  });
}

function inspectDesignArtifact(design, requireDesign) {
  const required = Boolean(requireDesign);

  return createCheck({
    id: 'design-present',
    status: design?.exists ? 'pass' : required ? 'fail' : 'warn',
    path: design?.path ?? 'openspec/changes/<change-id>/design.md',
    message: design?.exists
      ? 'design.md is present.'
      : required
        ? 'design.md is required by aifhub.openspec.requireDesign.'
        : 'design.md is missing; it is optional unless aifhub.openspec.requireDesign is true.'
  });
}

function inspectDeltaSpecs(artifacts, config, skipSpecs, rootDir) {
  const deltaSpecs = Array.isArray(artifacts.deltaSpecs) ? artifacts.deltaSpecs : [];
  const proposal = artifacts.proposal;
  const hasSkipReason = proposal?.exists && hasExplicitSkipSpecsReason(proposal.content);

  if (deltaSpecs.length > 0) {
    return createCheck({
      id: 'delta-specs-present',
      status: 'pass',
      path: deltaSpecs[0].path,
      message: `Found ${deltaSpecs.length} OpenSpec delta spec file(s).`
    });
  }

  if (skipSpecs?.declared) {
    return createCheck({
      id: 'delta-specs-present',
      status: 'pass',
      path: toPosix(path.relative(rootDir, skipSpecs.metadataPath)),
      message: 'No delta specs are required because .openspec.yaml declares native skip_specs: true.'
    });
  }

  if (skipSpecs?.valid === false) {
    return createCheck({
      id: 'delta-specs-present',
      status: 'fail',
      path: toPosix(path.relative(rootDir, skipSpecs.metadataPath)),
      message: `OpenSpec skip_specs metadata is invalid: ${skipSpecs.invalidReason}`
    });
  }

  if (hasSkipReason) {
    return createCheck({
      id: 'delta-specs-present',
      status: 'pass',
      path: proposal.path,
      message: 'No delta specs are required because proposal.md contains an explicit docs/tooling-only skip-specs reason.'
    });
  }

  return createCheck({
    id: 'delta-specs-present',
    status: config.allowMissingSpecs ? 'warn' : 'fail',
    path: `openspec/changes/${config.changeIdPlaceholder ?? '<change-id>'}/specs/**/spec.md`,
    message: 'OpenSpec changes must include specs/**/spec.md unless .openspec.yaml declares skip_specs: true or proposal.md preserves an explicit legacy docs/tooling-only skip-specs reason.'
  });
}

async function inspectRuntimeFiles(rootDir, changeDir) {
  const files = await collectFiles(rootDir, changeDir);
  const offenders = files.filter((file) =>
    file.kind !== 'directory' && isRuntimeOrEvidenceFile(file.path)
  );

  if (offenders.length === 0) {
    return [
      createCheck({
        id: 'runtime-files-outside-change',
        status: 'pass',
        path: toPosix(path.relative(rootDir, changeDir)),
        message: 'No runtime state, QA evidence, or generated rule files were found inside the canonical change folder.'
      })
    ];
  }

  return offenders.map((file) => createCheck({
    id: 'runtime-files-outside-change',
    status: 'fail',
    path: file.repoPath,
    message: 'Runtime state, QA evidence, and generated files must stay outside openspec/changes/<change-id>.'
  }));
}

async function inspectPlanningArtifacts(rootDir, changeDir) {
  const files = await collectFiles(rootDir, changeDir);
  const violations = [];

  for (const file of files) {
    const fileName = path.posix.basename(file.path).toLowerCase();
    if (fileName === 'index.md') {
      violations.push(createPlanningArtifactViolation(
        file.repoPath,
        'openspec-ultra-index-forbidden',
        'Ultra plan index.md is forbidden inside a canonical OpenSpec change.'
      ));
    }

    if (/^phase-\d{2}-.+/i.test(fileName)) {
      violations.push(createPlanningArtifactViolation(
        file.repoPath,
        'openspec-ultra-phase-forbidden',
        'Ultra phase artifacts are forbidden inside a canonical OpenSpec change.'
      ));
    }

    if (LEGACY_COMPANION_FILE_NAMES.has(fileName)) {
      violations.push(createPlanningArtifactViolation(
        file.repoPath,
        'openspec-legacy-companion-forbidden',
        'Legacy companion plan artifacts are forbidden inside a canonical OpenSpec change.'
      ));
    }

    if (file.kind === 'file' && fileName.endsWith('.md')) {
      const content = await readFile(file.absolutePath, 'utf8');
      if (hasActiveStandaloneMarker(content, ULTRA_PLAN_MARKER)) {
        violations.push(createPlanningArtifactViolation(
          file.repoPath,
          'openspec-ultra-marker-forbidden',
          'Active standalone ultra plan markers are forbidden inside canonical OpenSpec files.'
        ));
      }
    }
  }

  if (violations.length > 0) {
    return violations;
  }

  return [createCheck({
    id: 'planning-artifacts-outside-change',
    status: 'pass',
    path: toPosix(path.relative(rootDir, changeDir)),
    message: 'No legacy or ultra planning artifacts were found inside the canonical change folder.'
  })];
}

function createPlanningArtifactViolation(checkPath, ruleCode, message) {
  return createCheck({
    id: 'planning-artifacts-outside-change',
    status: 'fail',
    path: checkPath,
    message,
    details: {
      rule_code: ruleCode
    }
  });
}

async function inspectVerificationEvidence(changeId, options) {
  if (!options.requireVerificationEvidence) {
    return [
      createCheck({
        id: 'qa-verify-evidence',
        status: 'pass',
        path: path.join(options.qaDir ?? DEFAULT_QA_DIR, changeId).replaceAll('\\', '/'),
        message: 'Verification evidence is not required for this validator stage.'
      })
    ];
  }

  const readLatestVerificationEvidence = options.readLatestVerificationEvidence ?? defaultReadLatestVerificationEvidence;
  const qaDir = options.qaDir ?? DEFAULT_QA_DIR;
  const evidence = await readLatestVerificationEvidence(changeId, {
    ...options,
    qaDir
  });
  const checks = [];
  const qaPath = path.join(qaDir, changeId).replaceAll('\\', '/');
  const qaAbsolutePath = path.isAbsolute(qaDir)
    ? path.join(qaDir, changeId)
    : path.join(options.rootDir, qaDir, changeId);
  const validationExists = evidence?.ok === true || evidence?.validation !== null && evidence?.validation !== undefined;
  const verifyExists = evidence?.verify?.exists === true;

  checks.push(createCheck({
    id: 'qa-openspec-validation-present',
    status: validationExists ? evidence.validation?.ok === false ? 'fail' : 'pass' : 'fail',
    path: `${qaPath}/openspec-validation.json`,
    message: validationExists
      ? evidence.validation?.ok === false
        ? 'OpenSpec validation evidence exists but reports failure.'
        : 'OpenSpec validation evidence is present.'
      : 'OpenSpec validation evidence is missing.'
  }));

  checks.push(createCheck({
    id: 'qa-verify-evidence',
    status: verifyExists ? 'pass' : 'fail',
    path: evidence?.verify?.path ?? `${qaPath}/verify.md`,
    message: verifyExists
      ? 'Verify evidence is present.'
      : 'Verify evidence is missing.'
  }));

  if (verifyExists) {
    checks.push(inspectVerifyGate(evidence.verify.content, evidence.gateResult, evidence.verify.path));
  } else {
    checks.push(createCheck({
      id: 'qa-verify-gate',
      status: 'fail',
      path: `${qaPath}/verify.md`,
      message: 'Verify evidence must contain a final aif-gate-result block for the verify gate.'
    }));
  }

  checks.push(...await inspectDoneEvidence(qaPath, qaAbsolutePath));
  return checks;
}

function inspectVerifyGate(content, gateResult, verifyPath) {
  const gate = gateResult ?? getLatestGateResult(content, { gate: 'verify' });

  if (gate === null) {
    return createCheck({
      id: 'qa-verify-gate',
      status: 'fail',
      path: verifyPath,
      message: 'Verify evidence is missing the final aif-gate-result block for the verify gate.'
    });
  }

  if (!gate.ok) {
    return createCheck({
      id: 'qa-verify-gate',
      status: 'fail',
      path: verifyPath,
      message: 'Verify evidence contains an invalid aif-gate-result block for the verify gate.',
      details: gate.errors
    });
  }

  return createCheck({
    id: 'qa-verify-gate',
    status: gate.result.status === 'fail' ? 'fail' : 'pass',
    path: verifyPath,
    message: gate.result.status === 'fail'
      ? 'The latest verify gate result is failing.'
      : 'The latest verify gate result is present and non-failing.'
  });
}

async function inspectDoneEvidence(qaPath, qaAbsolutePath) {
  const donePath = path.join(qaAbsolutePath, 'done.md');
  const archivePath = path.join(qaAbsolutePath, 'openspec-archive.json');
  const doneExists = await pathExists(donePath);
  const archiveExists = await pathExists(archivePath);

  if (!doneExists) {
    return [
      createCheck({
        id: 'qa-done-evidence',
        status: 'pass',
        path: `${qaPath}/done.md`,
        message: 'No done.md evidence is present before finalization.'
      })
    ];
  }

  return [
    createCheck({
      id: 'qa-done-evidence',
      status: archiveExists ? 'pass' : 'fail',
      path: `${qaPath}/done.md`,
      message: archiveExists
        ? 'done.md has matching archive evidence.'
        : 'done.md must only exist after finalization and should have matching openspec-archive.json evidence.'
    })
  ];
}

async function inspectGeneratedRules(changeId, options) {
  const generated = await collectGeneratedRules(changeId, options);

  if (generated.errors.length > 0) {
    return generated.errors.map((error) => createCheck({
      id: 'generated-rules-current',
      status: 'fail',
      message: error.message,
      details: error
    }));
  }

  const missing = generated.generatedRules.filter((rule) => !rule.exists);
  const stale = generated.generatedRules.filter((rule) => rule.stale === true);
  const traceWarnings = generated.warnings.filter((warning) =>
    warning.code !== 'missing-generated-rules'
    && warning.code !== 'stale-generated-rules'
  );

  if (missing.length === 0 && stale.length === 0 && traceWarnings.length === 0) {
    return [
      createCheck({
        id: 'generated-rules-current',
        status: 'pass',
        path: '.ai-factory/rules/generated',
        message: 'Generated OpenSpec rules are present and current.'
      })
    ];
  }

  return [
    ...missing.map((rule) => createCheck({
      id: 'generated-rules-current',
      status: 'warn',
      path: rule.path,
      message: 'Generated OpenSpec rules are missing.'
    })),
    ...stale.map((rule) => createCheck({
      id: 'generated-rules-current',
      status: 'warn',
      path: rule.path,
      message: 'Generated OpenSpec rules are stale.'
    })),
    ...traceWarnings.map((warning) => createCheck({
      id: 'generated-rules-current',
      status: 'warn',
      path: warning.path ?? '.ai-factory/rules/generated',
      message: warning.message,
      details: warning
    }))
  ];
}

function inspectBaseSpecMutation(changedPaths, allowBaseSpecMutation) {
  const paths = Array.isArray(changedPaths) ? changedPaths.map((item) => toPosix(item)) : [];
  const offenders = paths.filter((item) => item.startsWith('openspec/specs/'));

  if (offenders.length === 0 || allowBaseSpecMutation) {
    return createCheck({
      id: 'base-specs-not-directly-mutated',
      status: 'pass',
      path: 'openspec/specs',
      message: allowBaseSpecMutation
        ? 'Direct base spec mutation check was explicitly allowed for this run.'
        : 'No direct openspec/specs mutation was detected from supplied changed paths.'
    });
  }

  return createCheck({
    id: 'base-specs-not-directly-mutated',
    status: 'fail',
    path: offenders[0],
    message: 'AIFHub skills must not directly mutate openspec/specs; archive OpenSpec changes instead.',
    details: {
      changed_paths: offenders
    }
  });
}

async function resolveChange(options, rootDir) {
  const resolveActiveChange = options.resolveActiveChange ?? defaultResolveActiveChange;
  const result = await resolveActiveChange({
    rootDir,
    cwd: options.cwd ?? process.cwd(),
    changeId: options.changeId,
    getCurrentBranch: options.getCurrentBranch
  });

  if (!result.ok) {
    const normalized = options.changeId ? normalizeChangeId(options.changeId) : { ok: false, changeId: null };
    return {
      ok: false,
      changeId: normalized.ok ? normalized.changeId : null,
      errors: result.errors ?? []
    };
  }

  return {
    ok: true,
    changeId: result.changeId,
    changePath: result.changePath
  };
}

async function readValidatorConfig(rootDir) {
  try {
    const raw = await readFile(path.join(rootDir, DEFAULT_CONFIG_PATH), 'utf8');
    const parsed = parseSimpleYaml(raw);
    return {
      qaDir: parsed.paths?.qa ?? DEFAULT_QA_DIR,
      requireDesign: Boolean(parsed.aifhub?.openspec?.requireDesign)
    };
  } catch {
    return {
      qaDir: DEFAULT_QA_DIR,
      requireDesign: false
    };
  }
}

function parseSimpleYaml(raw) {
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '');
    if (withoutComment.trim().length === 0) {
      continue;
    }

    const match = /^(\s*)([^:]+):(?:\s*(.*))?$/.exec(withoutComment);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const key = match[2].trim();
    const rawValue = match[3]?.trim() ?? '';

    while (stack.length > 1 && stack.at(-1).indent >= indent) {
      stack.pop();
    }

    const parent = stack.at(-1).value;
    if (rawValue.length === 0) {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
      continue;
    }

    parent[key] = parseYamlScalar(rawValue);
  }

  return root;
}

function parseYamlScalar(value) {
  const unquoted = value.replace(/^['"]|['"]$/g, '');

  if (/^(true|false)$/i.test(unquoted)) {
    return unquoted.toLowerCase() === 'true';
  }

  if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) {
    return Number(unquoted);
  }

  return unquoted;
}

function hasExplicitSkipSpecsReason(content) {
  const text = String(content ?? '').toLowerCase();
  const hasSkipSpecs = /\bskip[-_\s]?specs\b/.test(text);
  const hasDocsToolingScope = /\b(docs?|documentation|tooling)[-_\s/]+only\b/.test(text)
    || /\bdocs[-_\s/]+tooling[-_\s/]+only\b/.test(text);
  const hasReason = /\b(reason|because|no behavior|no product|non[-_\s]?runtime|documentation[-_\s]?only)\b/.test(text);

  return (hasSkipSpecs || hasDocsToolingScope) && hasReason;
}

function isRuntimeOrEvidenceFile(relativePath) {
  const posixPath = toPosix(relativePath);
  const parts = posixPath.split('/');
  const fileName = parts.at(-1);

  if (['proposal.md', 'design.md', 'tasks.md'].includes(posixPath)) {
    return false;
  }

  if (/^specs\/.+\/spec\.md$/.test(posixPath)) {
    return false;
  }

  if (RUNTIME_FILE_NAMES.has(fileName)) {
    return true;
  }

  if (/^openspec-(base|change-|merged-).+\.md$/.test(fileName)) {
    return true;
  }

  return parts.some((part) => RUNTIME_DIR_NAMES.has(part));
}

async function collectFiles(rootDir, directoryPath) {
  if (!await isDirectory(directoryPath)) {
    return [];
  }

  const results = [];
  await collectFilesRecursive(rootDir, directoryPath, directoryPath, results);
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectFilesRecursive(rootDir, basePath, directoryPath, results) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const sorted = entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of sorted) {
    const childPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      results.push({
        path: toPosix(path.relative(basePath, childPath)),
        repoPath: toPosix(path.relative(rootDir, childPath)),
        absolutePath: childPath,
        kind: 'directory'
      });
      await collectFilesRecursive(rootDir, basePath, childPath, results);
      continue;
    }

    if (entry.isFile()) {
      results.push({
        path: toPosix(path.relative(basePath, childPath)),
        repoPath: toPosix(path.relative(rootDir, childPath)),
        absolutePath: childPath,
        kind: 'file'
      });
      continue;
    }

    if (entry.isSymbolicLink()) {
      results.push({
        path: toPosix(path.relative(basePath, childPath)),
        repoPath: toPosix(path.relative(rootDir, childPath)),
        absolutePath: childPath,
        kind: 'symlink'
      });
    }
  }
}

async function isDirectory(targetPath) {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function createResult({ changeId, checks, suggestedNext }) {
  const status = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'warn') ? 'warn' : 'pass';

  return {
    schema_version: ARTIFACT_CONTRACT_SCHEMA_VERSION,
    validator: ARTIFACT_CONTRACT_VALIDATOR,
    change_id: changeId ?? null,
    status,
    blocking: status === 'fail',
    checks,
    suggested_next: suggestedNext ?? null
  };
}

function isUnresolvedChangeResult(result) {
  return (result.checks ?? []).some((check) => check.id === 'active-change-resolved' && check.status === 'fail');
}

function createCheck({ id, status, path: checkPath, message, details }) {
  const check = {
    id,
    status,
    path: checkPath ?? null,
    message
  };

  if (details !== undefined) {
    check.details = details;
  }

  return check;
}

function chooseSuggestedNext(changeId, checks) {
  const failing = checks.find((check) => check.status === 'fail');

  if (failing?.id === 'generated-rules-current') {
    return {
      command: `/aif-mode sync --change ${changeId}`,
      reason: 'generated rules are stale or missing'
    };
  }

  if (failing?.id === 'qa-verify-evidence' || failing?.id === 'qa-openspec-validation-present' || failing?.id === 'qa-verify-gate') {
    return {
      command: `/aif-verify ${changeId}`,
      reason: 'verification evidence is required before finalization'
    };
  }

  if (failing?.id === 'delta-specs-present') {
    return {
      command: `/aif-mode sync --change ${changeId}`,
      reason: 'add delta specs or declare native skip_specs: true in .openspec.yaml before syncing again'
    };
  }

  if (failing?.id === 'runtime-files-outside-change') {
    return {
      command: `/aif-mode sync --change ${changeId}`,
      reason: 'move runtime evidence out of openspec/changes before continuing'
    };
  }

  if (failing?.id === 'planning-artifacts-outside-change') {
    return {
      command: `/aif-fix ${changeId}`,
      reason: 'remove legacy or ultra planning artifacts from the canonical OpenSpec change'
    };
  }

  if (failing?.id === 'base-specs-not-directly-mutated') {
    return {
      command: `/aif-done ${changeId}`,
      reason: 'archive through OpenSpec instead of directly mutating openspec/specs'
    };
  }

  const generatedWarning = checks.find((check) => check.id === 'generated-rules-current' && check.status === 'warn');
  if (generatedWarning) {
    return {
      command: `/aif-mode sync --change ${changeId}`,
      reason: 'generated rules are stale'
    };
  }

  return null;
}

function renderCheckLine(check) {
  const suffix = check.path ? ` (${check.path})` : '';
  return `- ${check.status.toUpperCase()} ${check.id}${suffix}: ${check.message}`;
}

function invalidArgs(error) {
  return {
    ok: false,
    error
  };
}

function resolveRootDir(options = {}) {
  return path.resolve(options.rootDir ?? process.cwd());
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runArtifactValidatorCommand(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
