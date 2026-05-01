// openspec-verification-context.mjs - OpenSpec verify runtime context helpers
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  ensureRuntimeLayout as defaultEnsureRuntimeLayout,
  normalizeChangeId,
  resolveActiveChange as defaultResolveActiveChange
} from './active-change-resolver.mjs';
import {
  detectOpenSpec as defaultDetectOpenSpec,
  getOpenSpecStatus as defaultGetOpenSpecStatus,
  validateOpenSpecChange as defaultValidateOpenSpecChange
} from './openspec-runner.mjs';
import {
  collectCanonicalChangeArtifacts,
  collectGeneratedRules
} from './openspec-execution-context.mjs';
import {
  createGateResult,
  getLatestGateResult,
  renderGateResultBlock
} from './aif-gate-result.mjs';

const MODE = 'openspec-native';
const DEFAULT_QA_DIR = path.join('.ai-factory', 'qa');
const GENERATED_RULES_DIR = path.join('.ai-factory', 'rules', 'generated');
const VALIDATION_FILE = 'openspec-validation.json';
const STATUS_FILE = 'openspec-status.json';
const VERIFY_FILE = 'verify.md';

export async function buildVerificationContext(options = {}) {
  return runOpenSpecVerification(options.changeId, options);
}

export async function runOpenSpecVerification(changeId, options = {}) {
  const rootDir = resolveRootDir(options);
  const resolveActiveChange = options.resolveActiveChange ?? defaultResolveActiveChange;
  const ensureRuntimeLayout = options.ensureRuntimeLayout ?? defaultEnsureRuntimeLayout;

  const resolverResult = await resolveActiveChange({
    rootDir,
    cwd: options.cwd ?? process.cwd(),
    changeId,
    getCurrentBranch: options.getCurrentBranch
  });

  if (!resolverResult.ok) {
    return createFailureContext({
      resolverResult,
      warnings: resolverResult.warnings,
      errors: resolverResult.errors
    });
  }

  assertSafeQaPath(rootDir, resolverResult.qaPath);

  const layout = await ensureRuntimeLayout(resolverResult.changeId, {
    rootDir,
    cwd: options.cwd,
    stateDir: options.stateDir,
    qaDir: options.qaDir
  });
  assertSafeQaPath(rootDir, layout.qaPath);

  const config = await readVerificationConfig(rootDir);
  const canonical = await collectCanonicalChangeArtifacts(resolverResult.changeId, {
    ...options,
    rootDir
  });
  const generatedRules = await collectGeneratedRules(resolverResult.changeId, {
    ...options,
    rootDir
  });
  const openspec = await runValidationPipeline(resolverResult.changeId, {
    ...options,
    rootDir,
    config
  });
  const warnings = dedupeDiagnostics([
    ...resolverResult.warnings,
    ...canonical.warnings,
    ...generatedRules.warnings,
    ...openspec.warnings
  ]);
  const errors = [
    ...canonical.errors,
    ...generatedRules.errors,
    ...openspec.errors
  ];
  const shouldRunCodeVerification = errors.length === 0 && openspec.shouldRunCodeVerification;
  const ok = errors.length === 0;
  const result = {
    ok,
    mode: MODE,
    changeId: resolverResult.changeId,
    resolver: createResolverSummary(resolverResult),
    paths: {
      change: resolverResult.changePath,
      state: layout.statePath,
      qa: layout.qaPath,
      generatedRules: path.join(rootDir, GENERATED_RULES_DIR)
    },
    config,
    canonicalArtifacts: canonical.canonicalArtifacts,
    generatedRules: generatedRules.generatedRules,
    openspec: {
      ...openspec.openspec,
      validation: openspec.validation,
      status: openspec.status
    },
    shouldRunCodeVerification,
    warnings,
    errors,
    qaEvidence: {
      path: toPosix(path.relative(rootDir, layout.qaPath)),
      files: []
    }
  };

  const evidence = await writeVerificationEvidence(resolverResult.changeId, {
    validation: openspec.validation,
    status: openspec.status,
    generatedRules: generatedRules.generatedRules,
    shouldRunCodeVerification,
    warnings,
    errors,
    config
  }, {
    ...options,
    rootDir,
    qaPath: layout.qaPath
  });

  return {
    ...result,
    qaEvidence: evidence.qaEvidence
  };
}

export async function writeVerificationEvidence(changeId, evidence, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }

  const qaPath = resolveQaPath(rootDir, normalized.changeId, options);
  assertSafeQaPath(rootDir, qaPath);

  const rawDir = path.join(qaPath, 'raw');
  await mkdir(rawDir, { recursive: true });

  const files = [];
  const validation = normalizeEvidenceCommand({
    changeId: normalized.changeId,
    result: evidence.validation ?? createSkippedCommand({
      ok: true,
      reason: 'not-run',
      message: 'OpenSpec validation did not run.'
    }),
    rootDir,
    qaPath,
    rawDir,
    stdoutFileName: 'openspec-validate.stdout',
    stderrFileName: 'openspec-validate.stderr'
  });
  await writeRawCommandStreams(validation, rawDir);
  await writeJson(path.join(qaPath, VALIDATION_FILE), validation);
  files.push(toPosix(path.relative(rootDir, path.join(qaPath, VALIDATION_FILE))));

  let status = null;
  if (evidence.status !== null && evidence.status !== undefined) {
    status = normalizeEvidenceCommand({
      changeId: normalized.changeId,
      result: evidence.status,
      rootDir,
      qaPath,
      rawDir,
      stdoutFileName: 'openspec-status.stdout',
      stderrFileName: 'openspec-status.stderr'
    });
    await writeRawCommandStreams(status, rawDir);
    await writeJson(path.join(qaPath, STATUS_FILE), status);
    files.push(toPosix(path.relative(rootDir, path.join(qaPath, STATUS_FILE))));
  }

  const summary = summarizeOpenSpecValidation({
    ok: Array.isArray(evidence.errors) ? evidence.errors.length === 0 : validation.ok,
    changeId: normalized.changeId,
    shouldRunCodeVerification: evidence.shouldRunCodeVerification ?? validation.ok,
    openspec: {
      validation,
      status
    },
    generatedRules: evidence.generatedRules ?? [],
    warnings: evidence.warnings ?? [],
    errors: evidence.errors ?? []
  });
  const gateResult = evidence.gateResult ?? createVerifyGateResult(normalized.changeId, evidence);
  await writeFile(path.join(qaPath, VERIFY_FILE), `${summary}\n\n${renderGateResultBlock(gateResult)}\n`, 'utf8');
  files.push(toPosix(path.relative(rootDir, path.join(qaPath, VERIFY_FILE))));

  return {
    ok: true,
    changeId: normalized.changeId,
    qaEvidence: {
      path: toPosix(path.relative(rootDir, qaPath)),
      files
    },
    validation,
    status,
    gateResult,
    warnings: [],
    errors: []
  };
}

export async function readLatestVerificationEvidence(changeId, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return {
      ok: false,
      changeId: null,
      validation: null,
      status: null,
      verify: {
        exists: false,
        path: null,
        content: ''
      },
      warnings: [],
      errors: [normalized.error]
    };
  }

  const qaPath = resolveQaPath(rootDir, normalized.changeId, options);
  assertSafeQaPath(rootDir, qaPath);

  const validation = await readOptionalJson(path.join(qaPath, VALIDATION_FILE));
  const status = await readOptionalJson(path.join(qaPath, STATUS_FILE));
  const verifyPath = path.join(qaPath, VERIFY_FILE);
  const verifyContent = await readOptionalText(verifyPath);
  const gateResult = verifyContent.exists
    ? getLatestGateResult(verifyContent.value, { gate: 'verify' })
    : null;

  return {
    ok: validation.exists,
    changeId: normalized.changeId,
    validation: validation.exists ? validation.value : null,
    status: status.exists ? status.value : null,
    verify: {
      exists: verifyContent.exists,
      path: toPosix(path.relative(rootDir, verifyPath)),
      content: verifyContent.value
    },
    gateResult,
    warnings: validation.exists ? [] : [
      {
        code: 'verification-evidence-missing',
        message: `Verification evidence is missing: ${toPosix(path.relative(rootDir, path.join(qaPath, VALIDATION_FILE)))}`
      }
    ],
    errors: []
  };
}

function createVerifyGateResult(changeId, evidence) {
  const errors = Array.isArray(evidence.errors) ? evidence.errors : [];
  const warnings = Array.isArray(evidence.warnings) ? evidence.warnings : [];
  const shouldRunCodeVerification = evidence.shouldRunCodeVerification !== false;
  const failed = errors.length > 0 || !shouldRunCodeVerification;
  const diagnostics = failed ? errors : warnings;

  return createGateResult({
    gate: 'verify',
    status: failed ? 'fail' : 'warn',
    blockers: diagnostics.map((item, index) => ({
      id: item.code ?? `verify-${index + 1}`,
      severity: failed ? 'error' : 'warning',
      file: item.path,
      summary: item.message ?? String(item)
    })),
    affectedFiles: diagnostics.map((item) => item.path).filter(Boolean),
    suggestedNext: failed
      ? {
        command: '/aif-fix',
        reason: `Verification is blocked for ${changeId}.`
      }
      : null
  });
}

export function summarizeOpenSpecValidation(result, options = {}) {
  const validation = result?.openspec?.validation ?? null;
  const status = result?.openspec?.status ?? null;
  const shouldRunCodeVerification = Boolean(result?.shouldRunCodeVerification);
  const validationState = summarizeValidationState(validation);
  const statusState = summarizeStatusState(status);
  const codeState = shouldRunCodeVerification ? 'PENDING' : 'BLOCKED';
  const nextStep = shouldRunCodeVerification
    ? (options.nextStep ?? `Continue code verification for ${result?.changeId ?? '<change-id>'}`)
    : `/aif-fix ${result?.changeId ?? '<change-id>'}`;
  const lines = [
    `# Verify: ${result?.changeId ?? '<change-id>'}`,
    '',
    '## OpenSpec',
    '',
    `OpenSpec validation: ${validationState}`,
    `OpenSpec status: ${statusState}`,
    `Code verification: ${codeState}`,
    `Next step: ${nextStep}`,
    '',
    '## Generated rules',
    '',
    ...renderGeneratedRulesSummary(result?.generatedRules),
    '',
    '## Diagnostics',
    '',
    ...renderDiagnostics('Warnings', result?.warnings ?? []),
    '',
    ...renderDiagnostics('Errors', result?.errors ?? [])
  ];

  return lines.join('\n');
}

async function runValidationPipeline(changeId, options) {
  if (!options.config.validateOnVerify) {
    const validation = createSkippedCommand({
      ok: true,
      reason: 'validateOnVerify-disabled',
      message: 'OpenSpec validation skipped because aifhub.openspec.validateOnVerify is false.'
    });

    return {
      openspec: createOpenSpecSummary(null),
      validation,
      status: null,
      shouldRunCodeVerification: true,
      warnings: [
        {
          code: 'openspec-validation-disabled',
          message: 'OpenSpec validation skipped because aifhub.openspec.validateOnVerify is false.'
        }
      ],
      errors: []
    };
  }

  const detectOpenSpec = options.detectOpenSpec ?? defaultDetectOpenSpec;
  const detection = await detectOpenSpec(createRunOptions(options));
  const openspec = createOpenSpecSummary(detection);

  if (!detection?.available || !detection?.canValidate) {
    const diagnostic = normalizeCliUnavailableDiagnostic(detection, options.config.requireCliForVerify);
    const validation = createSkippedCommand({
      ok: !options.config.requireCliForVerify,
      reason: diagnostic.code,
      message: diagnostic.message
    });

    return {
      openspec,
      validation,
      status: null,
      shouldRunCodeVerification: !options.config.requireCliForVerify,
      warnings: options.config.requireCliForVerify ? [] : [diagnostic],
      errors: options.config.requireCliForVerify ? [diagnostic] : []
    };
  }

  const validateOpenSpecChange = options.validateOpenSpecChange ?? defaultValidateOpenSpecChange;
  const getOpenSpecStatus = options.getOpenSpecStatus ?? defaultGetOpenSpecStatus;
  const rawValidation = await validateOpenSpecChange(changeId, createRunOptions(options));
  const validation = normalizeCommandResult(rawValidation, {
    requireParsedJsonOnFailure: true
  });

  if (!validation.ok) {
    return {
      openspec,
      validation,
      status: null,
      shouldRunCodeVerification: false,
      warnings: [],
      errors: [
        {
          code: 'openspec-validation-failed',
          message: 'OpenSpec validation failed. Fix canonical change artifacts before running code verification.'
        }
      ]
    };
  }

  if (!options.config.statusOnVerify) {
    return {
      openspec,
      validation,
      status: null,
      shouldRunCodeVerification: true,
      warnings: [
        {
          code: 'openspec-status-disabled',
          message: 'OpenSpec status skipped because aifhub.openspec.statusOnVerify is false.'
        }
      ],
      errors: []
    };
  }

  const rawStatus = await getOpenSpecStatus(changeId, createRunOptions(options));
  const status = normalizeCommandResult(rawStatus);
  const statusWarnings = status.ok ? [] : [
    {
      code: 'openspec-status-unavailable',
      message: 'OpenSpec status was unavailable after validation; continuing code verification.'
    }
  ];

  return {
    openspec,
    validation,
    status,
    shouldRunCodeVerification: true,
    warnings: statusWarnings,
    errors: []
  };
}

async function readVerificationConfig(rootDir) {
  const configPath = path.join(rootDir, '.ai-factory', 'config.yaml');
  const defaults = {
    validateOnVerify: true,
    statusOnVerify: true,
    requireCliForVerify: false
  };

  try {
    const raw = await readFile(configPath, 'utf8');
    return {
      ...defaults,
      ...parseOpenSpecVerifyConfig(raw)
    };
  } catch {
    return defaults;
  }
}

function parseOpenSpecVerifyConfig(raw) {
  const values = {};
  const lines = String(raw ?? '').split(/\r?\n/);
  let aifhubIndent = null;
  let openspecIndent = null;

  for (const rawLine of lines) {
    if (/^\s*(?:#.*)?$/.test(rawLine)) {
      continue;
    }

    const match = rawLine.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*?))?\s*$/);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const key = match[2];
    const rawValue = match[3] ?? '';

    if (aifhubIndent !== null && indent <= aifhubIndent && key !== 'aifhub') {
      aifhubIndent = null;
      openspecIndent = null;
    }

    if (openspecIndent !== null && indent <= openspecIndent && key !== 'openspec') {
      openspecIndent = null;
    }

    if (key === 'aifhub') {
      aifhubIndent = indent;
      openspecIndent = null;
      continue;
    }

    if (aifhubIndent !== null && key === 'openspec' && indent > aifhubIndent) {
      openspecIndent = indent;
      continue;
    }

    if (aifhubIndent !== null && openspecIndent !== null && indent > openspecIndent) {
      if (key === 'validateOnVerify' || key === 'statusOnVerify' || key === 'requireCliForVerify') {
        const parsed = parseBooleanScalar(rawValue);

        if (parsed !== null) {
          values[key] = parsed;
        }
      }
    }
  }

  return values;
}

function parseBooleanScalar(rawValue) {
  const value = stripInlineComment(rawValue).trim().replace(/^["']|["']$/g, '').toLowerCase();

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return null;
}

function stripInlineComment(value) {
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if ((char === '"' || char === "'") && (index === 0 || value[index - 1] !== '\\')) {
      quote = quote === char ? null : quote ?? char;
      continue;
    }

    if (char === '#' && quote === null) {
      return value.slice(0, index);
    }
  }

  return value;
}

function createOpenSpecSummary(detection) {
  return {
    available: Boolean(detection?.available),
    canValidate: Boolean(detection?.canValidate),
    version: detection?.version ?? null,
    command: detection?.command ?? 'openspec',
    reason: detection?.reason ?? null,
    errors: detection?.errors ?? []
  };
}

function normalizeCliUnavailableDiagnostic(detection, strict) {
  const detectionError = detection?.errors?.[0];

  if (strict) {
    return {
      code: 'openspec-cli-required',
      message: 'OpenSpec CLI is required by configuration but is unavailable or unsupported.',
      detail: detectionError?.message ?? detection?.reason ?? null
    };
  }

  return {
    code: 'openspec-cli-unavailable',
    message: 'OpenSpec CLI is unavailable or unsupported; continuing in degraded verification mode.',
    detail: detectionError?.message ?? detection?.reason ?? null
  };
}

function normalizeCommandResult(result, options = {}) {
  const parsed = parseCommandJson(result);
  const jsonParseError = result?.jsonParseError ?? parsed.jsonParseError;
  const ok = Boolean(result?.ok) && jsonParseError === null;

  return {
    ok,
    command: result?.command ?? null,
    args: Array.from(result?.args ?? []),
    exitCode: result?.exitCode ?? null,
    parsedJson: result?.json ?? parsed.parsedJson,
    jsonParseError,
    stdout: normalizeOutput(result?.stdout),
    stderr: normalizeOutput(result?.stderr),
    error: result?.error ?? null,
    raw: result ?? null,
    ...(options.requireParsedJsonOnFailure ? { parsedOnFailure: parsed.parsedJson !== null } : {})
  };
}

function normalizeEvidenceCommand({ changeId, result, rootDir, qaPath, stdoutFileName, stderrFileName }) {
  const normalized = result?.skipped
    ? result
    : normalizeCommandResult(result);
  const stdout = normalizeOutput(normalized.stdout);
  const stderr = normalizeOutput(normalized.stderr);
  const executed = !normalized.skipped && normalized.command !== null;
  const rawStdoutPath = executed
    ? toPosix(path.relative(rootDir, path.join(qaPath, 'raw', stdoutFileName)))
    : null;
  const rawStderrPath = executed
    ? toPosix(path.relative(rootDir, path.join(qaPath, 'raw', stderrFileName)))
    : null;

  return {
    changeId,
    command: normalized.command ?? null,
    args: Array.from(normalized.args ?? []),
    exitCode: normalized.exitCode ?? null,
    ok: Boolean(normalized.ok),
    skipped: Boolean(normalized.skipped),
    reason: normalized.reason ?? null,
    message: normalized.message ?? null,
    parsedJson: normalized.parsedJson ?? null,
    jsonParseError: normalized.jsonParseError ?? null,
    rawStdoutPath,
    rawStderrPath,
    stdout,
    stderr,
    error: normalized.error ?? null
  };
}

function parseCommandJson(result) {
  if (result?.json !== undefined && result?.json !== null) {
    return {
      parsedJson: result.json,
      jsonParseError: null
    };
  }

  const stdout = normalizeOutput(result?.stdout);

  if (stdout.trim().length === 0) {
    return {
      parsedJson: null,
      jsonParseError: null
    };
  }

  try {
    return {
      parsedJson: JSON.parse(stdout),
      jsonParseError: null
    };
  } catch {
    return {
      parsedJson: null,
      jsonParseError: {
        code: 'invalid-json',
        message: 'OpenSpec command returned invalid JSON.'
      }
    };
  }
}

function createSkippedCommand({ ok, reason, message }) {
  return {
    ok,
    skipped: true,
    reason,
    message,
    command: null,
    args: [],
    exitCode: null,
    parsedJson: null,
    jsonParseError: null,
    stdout: '',
    stderr: '',
    error: ok ? null : {
      code: reason,
      message
    }
  };
}

async function writeRawCommandStreams(command, rawDir) {
  if (command.rawStdoutPath !== null) {
    await writeFile(path.join(rawDir, path.basename(command.rawStdoutPath)), command.stdout, 'utf8');
  }

  if (command.rawStderrPath !== null) {
    await writeFile(path.join(rawDir, path.basename(command.rawStderrPath)), command.stderr, 'utf8');
  }
}

async function writeJson(targetPath, value) {
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readOptionalJson(targetPath) {
  try {
    return {
      exists: true,
      value: JSON.parse(await readFile(targetPath, 'utf8'))
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        exists: false,
        value: null
      };
    }

    throw err;
  }
}

async function readOptionalText(targetPath) {
  try {
    return {
      exists: true,
      value: await readFile(targetPath, 'utf8')
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        exists: false,
        value: ''
      };
    }

    throw err;
  }
}

function summarizeValidationState(validation) {
  if (validation === null) {
    return 'SKIPPED';
  }

  if (validation.skipped && validation.ok) {
    return 'SKIPPED';
  }

  if (validation.skipped && !validation.ok) {
    return 'FAIL';
  }

  return validation.ok ? 'PASS' : 'FAIL';
}

function summarizeStatusState(status) {
  if (status === null) {
    return 'SKIPPED';
  }

  return status.ok ? 'PASS' : 'WARN';
}

function renderGeneratedRulesSummary(generatedRules) {
  const rules = Array.isArray(generatedRules) ? generatedRules : [];

  if (rules.length === 0) {
    return ['- none'];
  }

  return rules.map((rule) => `- ${rule.path}: ${rule.exists ? 'present' : 'missing'}${rule.stale ? ' stale' : ''}`);
}

function renderDiagnostics(label, diagnostics) {
  const items = Array.isArray(diagnostics) ? diagnostics : [];

  if (items.length === 0) {
    return [`${label}: none`];
  }

  return [
    `${label}:`,
    ...items.map((item) => `- ${item.code}: ${item.message}`)
  ];
}

function createFailureContext({ resolverResult, warnings = [], errors = [] }) {
  return {
    ok: false,
    mode: MODE,
    changeId: null,
    resolver: createResolverSummary(resolverResult),
    paths: {},
    config: {
      validateOnVerify: true,
      statusOnVerify: true,
      requireCliForVerify: false
    },
    canonicalArtifacts: {},
    generatedRules: [],
    openspec: {
      available: false,
      canValidate: false,
      version: null,
      command: 'openspec',
      reason: null,
      errors: [],
      validation: null,
      status: null
    },
    qaEvidence: {
      path: null,
      files: []
    },
    shouldRunCodeVerification: false,
    warnings: dedupeDiagnostics(warnings),
    errors
  };
}

function createResolverSummary(result) {
  return {
    source: result?.source ?? null,
    candidates: result?.candidates ?? [],
    warnings: result?.warnings ?? []
  };
}

function createRunOptions(options) {
  return {
    cwd: options.rootDir,
    command: options.command,
    env: options.env,
    executor: options.executor,
    nodeVersion: options.nodeVersion
  };
}

function resolveQaPath(rootDir, changeId, options) {
  if (options.qaPath !== undefined) {
    return path.resolve(options.qaPath);
  }

  const qaRoot = resolveFromRoot(rootDir, options.qaDir ?? DEFAULT_QA_DIR);
  return path.join(qaRoot, changeId);
}

function assertSafeQaPath(rootDir, qaPath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedQaPath = path.resolve(qaPath);

  if (!isWithinDirectory(resolvedQaPath, resolvedRoot)) {
    throw new Error(`QA evidence path escapes repository root: ${resolvedQaPath}`);
  }

  for (const forbiddenDir of [
    path.join(resolvedRoot, 'openspec', 'changes'),
    path.join(resolvedRoot, '.ai-factory', 'plans')
  ]) {
    if (isWithinDirectory(resolvedQaPath, forbiddenDir)) {
      throw new Error(`QA evidence path must stay outside canonical OpenSpec changes and legacy plan folders: ${resolvedQaPath}`);
    }
  }
}

function isWithinDirectory(targetPath, directoryPath) {
  const relative = path.relative(directoryPath, targetPath);
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRootDir(options = {}) {
  return path.resolve(options.rootDir ?? process.cwd());
}

function resolveFromRoot(rootDir, value) {
  return path.resolve(rootDir, value);
}

function normalizeOutput(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
}

function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  const result = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code ?? ''}:${diagnostic.message ?? ''}:${diagnostic.path ?? ''}`;

    if (!seen.has(key)) {
      seen.add(key);
      result.push(diagnostic);
    }
  }

  return result;
}
