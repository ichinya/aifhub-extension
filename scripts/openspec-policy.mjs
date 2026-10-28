#!/usr/bin/env node
// openspec-policy.mjs - shared OpenSpec validation policy resolver
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { getLatestGateResult } from './aif-gate-result.mjs';
import { readBoundGateEvidence } from './qa-bound-evidence.mjs';

export const OPENSPEC_POLICY_SCHEMA_VERSION = 1;

const DEFAULT_CONFIG_PATH = path.join('.ai-factory', 'config.yaml');
const DEFAULT_QA_DIR = path.join('.ai-factory', 'qa');
const RULES_GATE_CANDIDATES = [
  'rules.md',
  'aif-rules-check.md',
  'rules-check.md',
  path.join('gates', 'rules.md')
];
const BOOLEAN_KEYS = new Set([
  'installSkills',
  'validateOnPlan',
  'validateOnImprove',
  'validateOnVerify',
  'statusOnVerify',
  'archiveOnDone',
  'useInstructionsApply',
  'compileRulesOnSync',
  'validateOnSync',
  'requireCliForPlan',
  'requireCliForImprove',
  'requireCliForVerify',
  'requireCliForDone',
  'requireGeneratedRulesForVerify',
  'requireGeneratedRulesForDone',
  'requireRulesPassForVerify',
  'requireRulesPassForDone',
  'requireSpecCoverageForVerify',
  'requireSpecCoverageForDone'
]);
const KNOWN_OPEN_SPEC_KEYS = new Set([
  'root',
  'allowWarnOnDone',
  ...BOOLEAN_KEYS
]);
const KNOWN_ALLOW_WARN_KEYS = new Set(['rules', 'coverage', 'openspecStatus']);

export function defaultOpenSpecPolicy() {
  return createPolicy({
    root: 'openspec',
    installSkills: false,
    actions: {
      validateOnPlan: true,
      validateOnImprove: true,
      validateOnVerify: true,
      statusOnVerify: true,
      archiveOnDone: true,
      useInstructionsApply: true,
      compileRulesOnSync: true,
      validateOnSync: true
    },
    requirements: {
      cli: {
        plan: false,
        improve: false,
        verify: false,
        done: true
      },
      generatedRules: {
        verify: false,
        done: true
      },
      rulesPass: {
        verify: false,
        done: true
      },
      specCoverage: {
        verify: false,
        done: true
      }
    },
    allowWarnOnDone: {
      rules: false,
      coverage: false,
      openspecStatus: true
    },
    diagnostics: []
  });
}

export async function readOpenSpecPolicy(options = {}) {
  const rootDir = resolveRootDir(options);
  const configPath = path.resolve(rootDir, options.configPath ?? DEFAULT_CONFIG_PATH);

  try {
    const raw = await readFile(configPath, 'utf8');
    return resolveOpenSpecPolicy(raw, {
      ...options,
      rootDir,
      configPath
    });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return resolveOpenSpecPolicy('', {
        ...options,
        rootDir,
        configPath,
        configMissing: true
      });
    }

    const policy = defaultOpenSpecPolicy();
    return {
      ...policy,
      diagnostics: [
        ...policy.diagnostics,
        {
          code: 'openspec-policy-config-unreadable',
          severity: 'warning',
          message: `OpenSpec policy config could not be read: ${path.relative(rootDir, configPath) || configPath}`,
          path: toPosix(path.relative(rootDir, configPath) || configPath),
          detail: err?.message ?? String(err)
        }
      ]
    };
  }
}

export function resolveOpenSpecPolicy(configOrRaw, options = {}) {
  const defaults = defaultOpenSpecPolicy();
  const rawConfig = extractOpenSpecConfig(configOrRaw);
  const diagnostics = [];
  const root = normalizeString(rawConfig.root, defaults.root);
  const installSkills = normalizeBooleanValue('installSkills', rawConfig.installSkills, defaults.installSkills, diagnostics);
  const actions = {};
  const requirements = {
    cli: {},
    generatedRules: {},
    rulesPass: {},
    specCoverage: {}
  };
  const allowWarnOnDone = {};

  for (const key of Object.keys(defaults.actions)) {
    actions[key] = normalizeBooleanValue(key, rawConfig[key], defaults.actions[key], diagnostics);
  }

  requirements.cli.plan = normalizeBooleanValue('requireCliForPlan', rawConfig.requireCliForPlan, defaults.requirements.cli.plan, diagnostics);
  requirements.cli.improve = normalizeBooleanValue('requireCliForImprove', rawConfig.requireCliForImprove, defaults.requirements.cli.improve, diagnostics);
  requirements.cli.verify = normalizeBooleanValue('requireCliForVerify', rawConfig.requireCliForVerify, defaults.requirements.cli.verify, diagnostics);
  requirements.cli.done = normalizeBooleanValue('requireCliForDone', rawConfig.requireCliForDone, defaults.requirements.cli.done, diagnostics);
  requirements.generatedRules.verify = normalizeBooleanValue('requireGeneratedRulesForVerify', rawConfig.requireGeneratedRulesForVerify, defaults.requirements.generatedRules.verify, diagnostics);
  requirements.generatedRules.done = normalizeBooleanValue('requireGeneratedRulesForDone', rawConfig.requireGeneratedRulesForDone, defaults.requirements.generatedRules.done, diagnostics);
  requirements.rulesPass.verify = normalizeBooleanValue('requireRulesPassForVerify', rawConfig.requireRulesPassForVerify, defaults.requirements.rulesPass.verify, diagnostics);
  requirements.rulesPass.done = normalizeBooleanValue('requireRulesPassForDone', rawConfig.requireRulesPassForDone, defaults.requirements.rulesPass.done, diagnostics);
  requirements.specCoverage.verify = normalizeBooleanValue('requireSpecCoverageForVerify', rawConfig.requireSpecCoverageForVerify, defaults.requirements.specCoverage.verify, diagnostics);
  requirements.specCoverage.done = normalizeBooleanValue('requireSpecCoverageForDone', rawConfig.requireSpecCoverageForDone, defaults.requirements.specCoverage.done, diagnostics);

  const rawAllowWarn = isPlainObject(rawConfig.allowWarnOnDone) ? rawConfig.allowWarnOnDone : {};
  if (rawConfig.allowWarnOnDone !== undefined && !isPlainObject(rawConfig.allowWarnOnDone)) {
    diagnostics.push(malformedDiagnostic('allowWarnOnDone', rawConfig.allowWarnOnDone, 'object'));
  }
  for (const key of Object.keys(defaults.allowWarnOnDone)) {
    allowWarnOnDone[key] = normalizeBooleanValue(
      `allowWarnOnDone.${key}`,
      rawAllowWarn[key],
      defaults.allowWarnOnDone[key],
      diagnostics
    );
  }

  diagnostics.push(...unknownKeyDiagnostics(rawConfig, rawAllowWarn));

  return createPolicy({
    root,
    installSkills,
    actions,
    requirements,
    allowWarnOnDone,
    diagnostics: dedupeDiagnostics(diagnostics)
  });
}

export function summarizeOpenSpecPolicy(policy, options = {}) {
  const resolved = policy ?? defaultOpenSpecPolicy();
  const format = options.format ?? 'short';
  const verify = [
    `cli=${requirementLabel(resolved.requirements?.cli?.verify)}`,
    `generatedRules=${requirementLabel(resolved.requirements?.generatedRules?.verify)}`,
    `rulesPass=${requirementLabel(resolved.requirements?.rulesPass?.verify)}`,
    `coverage=${requirementLabel(resolved.requirements?.specCoverage?.verify)}`
  ].join(', ');
  const done = [
    `cli=${requirementLabel(resolved.requirements?.cli?.done)}`,
    `generatedRules=${requirementLabel(resolved.requirements?.generatedRules?.done)}`,
    `rulesPass=${requirementLabel(resolved.requirements?.rulesPass?.done)}`,
    `coverage=${requirementLabel(resolved.requirements?.specCoverage?.done)}`
  ].join(', ');
  const warn = [
    `rules=${allowLabel(resolved.allowWarnOnDone?.rules)}`,
    `coverage=${allowLabel(resolved.allowWarnOnDone?.coverage)}`,
    `openspecStatus=${allowLabel(resolved.allowWarnOnDone?.openspecStatus)}`
  ].join(', ');

  if (format === 'lines') {
    return [
      `Plan CLI: ${requirementLabel(resolved.requirements?.cli?.plan)}`,
      `Improve CLI: ${requirementLabel(resolved.requirements?.cli?.improve)}`,
      `Verify policy: ${verify}`,
      `Done policy: ${done}`,
      `Done warnings: ${warn}`
    ];
  }

  return `plan cli ${requirementLabel(resolved.requirements?.cli?.plan)}; improve cli ${requirementLabel(resolved.requirements?.cli?.improve)}; verify ${verify}; done ${done}; done warnings ${warn}`;
}

export function evaluateDoneWarningPolicy(kind, status, policy) {
  const normalizedKind = normalizeWarnKind(kind);
  const normalizedStatus = normalizeStatus(status);

  if (normalizedStatus === 'pass' || normalizedStatus === 'not-applicable') {
    return {
      allowed: true,
      blocking: false,
      severity: 'pass',
      reason: 'passing'
    };
  }

  if (normalizedStatus === 'warn') {
    const allowed = Boolean((policy ?? defaultOpenSpecPolicy()).allowWarnOnDone?.[normalizedKind]);
    return {
      allowed,
      blocking: !allowed,
      severity: allowed ? 'warning' : 'error',
      reason: allowed ? 'warning-allowed' : 'warning-blocked'
    };
  }

  return {
    allowed: false,
    blocking: true,
    severity: 'error',
    reason: 'non-passing'
  };
}

export function evaluatePolicyFinding(finding, policy, options = {}) {
  const resolved = policy ?? defaultOpenSpecPolicy();
  const action = normalizeAction(options.action ?? finding?.action ?? 'verify');
  const kind = normalizeFindingKind(finding?.kind);
  const status = normalizeStatus(finding?.status ?? 'missing');
  const required = isFindingRequired(kind, action, resolved);
  const code = finding?.code ?? policyDiagnosticCode(kind, status, action);
  const message = finding?.message ?? policyDiagnosticMessage(kind, status, action, required);

  if (status === 'pass' || status === 'not-applicable') {
    return {
      ok: true,
      blocking: false,
      level: 'pass',
      diagnostic: {
        code,
        message,
        path: finding?.path
      }
    };
  }

  if (action === 'done' && status === 'warn' && isDoneWarningAllowed(kind, resolved)) {
    return {
      ok: true,
      blocking: false,
      level: 'warn',
      diagnostic: {
        code,
        message,
        path: finding?.path
      }
    };
  }

  const blocking = required || action === 'done';
  return {
    ok: !blocking,
    blocking,
    level: blocking ? 'fail' : 'warn',
    diagnostic: {
      code,
      message,
      path: finding?.path
    }
  };
}

export async function readOpenSpecRulesGateEvidence(changeId, options = {}) {
  if (options.rulesGateEvidence !== undefined || options.rulesGateResult !== undefined) {
    const binding = await readBoundGateEvidence({ ...options, changeId, gate: 'rules',
      content: options.rulesGateEvidence?.content ?? '' });
    if (binding.enrolled && binding.state !== 'valid') return { exists: true, ok: false,
      status: 'invalid', gateResult: null, path: null, binding, warnings: [],
      errors: [{ code: binding.code, message: `Rules QA binding: ${binding.state}.` }] };
  }
  if (options.rulesGateEvidence !== undefined) {
    return normalizeRulesGateEvidence(options.rulesGateEvidence, null);
  }
  if (options.rulesGateResult !== undefined) {
    return normalizeRulesGateEvidence({ gateResult: options.rulesGateResult }, null);
  }

  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeIdForPath(changeId);
  if (!normalized.ok) {
    return {
      exists: false,
      ok: false,
      status: 'missing',
      path: null,
      gateResult: null,
      warnings: [],
      errors: [normalized.error]
    };
  }

  const qaPath = options.qaPath !== undefined
    ? path.resolve(options.qaPath)
    : path.resolve(rootDir, options.qaDir ?? DEFAULT_QA_DIR, normalized.changeId);
  const candidates = Array.isArray(options.rulesGateCandidates) && options.rulesGateCandidates.length > 0
    ? options.rulesGateCandidates
    : RULES_GATE_CANDIDATES;

  for (const candidate of candidates) {
    const candidatePath = path.resolve(qaPath, candidate);
    if (!isWithinDirectory(candidatePath, qaPath)) {
      continue;
    }

    try {
      const content = await readFile(candidatePath, 'utf8');
      const gate = getLatestGateResult(content, { gate: 'rules' });
      const binding = await readBoundGateEvidence({ ...options, rootDir, changeId: normalized.changeId,
        qaDir: toPosix(path.relative(rootDir, qaPath)), gate: 'rules', content });
      if (binding.enrolled && binding.state !== 'valid') {
        return { exists: true, ok: false, status: 'invalid', binding,
          path: toPosix(path.relative(rootDir, candidatePath)), gateResult: null, warnings: [],
          errors: [{ code: binding.code, message: `Rules QA binding: ${binding.state}.` }] };
      }
      return normalizeRulesGateEvidence({
        exists: true,
        path: toPosix(path.relative(rootDir, candidatePath)),
        content,
        gateResult: gate
      }, toPosix(path.relative(rootDir, candidatePath)));
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        return {
          exists: true,
          ok: false,
          status: 'invalid',
          path: toPosix(path.relative(rootDir, candidatePath)),
          gateResult: null,
          warnings: [],
          errors: [
            {
              code: 'rules-gate-evidence-unreadable',
              message: `Rules gate evidence could not be read: ${toPosix(path.relative(rootDir, candidatePath))}`,
              path: toPosix(path.relative(rootDir, candidatePath)),
              detail: err?.message ?? String(err)
            }
          ]
        };
      }
    }
  }

  return {
    exists: false,
    ok: false,
    status: 'missing',
    path: toPosix(path.relative(rootDir, path.join(qaPath, RULES_GATE_CANDIDATES[0]))),
    gateResult: null,
    warnings: [],
    errors: [
      {
        code: 'rules-gate-evidence-missing',
        message: `Rules gate evidence is missing. Run /aif-rules-check and save the final rules gate result to ${toPosix(path.relative(rootDir, path.join(qaPath, RULES_GATE_CANDIDATES[0])))}.`,
        path: toPosix(path.relative(rootDir, path.join(qaPath, RULES_GATE_CANDIDATES[0])))
      }
    ]
  };
}

function createPolicy({ root, installSkills, actions, requirements, allowWarnOnDone, diagnostics }) {
  return {
    schema_version: OPENSPEC_POLICY_SCHEMA_VERSION,
    mode: 'openspec',
    root,
    installSkills,
    actions: { ...actions },
    requirements: {
      cli: { ...requirements.cli },
      generatedRules: { ...requirements.generatedRules },
      rulesPass: { ...requirements.rulesPass },
      specCoverage: { ...requirements.specCoverage }
    },
    allowWarnOnDone: { ...allowWarnOnDone },
    diagnostics: diagnostics ?? [],
    validateOnPlan: actions.validateOnPlan,
    validateOnImprove: actions.validateOnImprove,
    validateOnVerify: actions.validateOnVerify,
    statusOnVerify: actions.statusOnVerify,
    archiveOnDone: actions.archiveOnDone,
    useInstructionsApply: actions.useInstructionsApply,
    compileRulesOnSync: actions.compileRulesOnSync,
    validateOnSync: actions.validateOnSync,
    requireCliForPlan: requirements.cli.plan,
    requireCliForImprove: requirements.cli.improve,
    requireCliForVerify: requirements.cli.verify,
    requireCliForDone: requirements.cli.done,
    requireGeneratedRulesForVerify: requirements.generatedRules.verify,
    requireGeneratedRulesForDone: requirements.generatedRules.done,
    requireRulesPassForVerify: requirements.rulesPass.verify,
    requireRulesPassForDone: requirements.rulesPass.done,
    requireSpecCoverageForVerify: requirements.specCoverage.verify,
    requireSpecCoverageForDone: requirements.specCoverage.done
  };
}

function extractOpenSpecConfig(configOrRaw) {
  if (typeof configOrRaw === 'string') {
    return parseSimpleYaml(configOrRaw).aifhub?.openspec ?? {};
  }

  if (!isPlainObject(configOrRaw)) {
    return {};
  }

  if (typeof configOrRaw.raw === 'string') {
    const parsed = parseSimpleYaml(configOrRaw.raw);
    return {
      ...(parsed.aifhub?.openspec ?? {}),
      ...(configOrRaw.parsed?.aifhub?.openspec ?? {}),
      ...(configOrRaw.aifhub?.openspec ?? {})
    };
  }

  if (isPlainObject(configOrRaw.parsed?.aifhub?.openspec)) {
    return configOrRaw.parsed.aifhub.openspec;
  }

  if (isPlainObject(configOrRaw.aifhub?.openspec)) {
    return configOrRaw.aifhub.openspec;
  }

  if (isPlainObject(configOrRaw.openspec)) {
    return configOrRaw.openspec;
  }

  return configOrRaw;
}

function normalizeBooleanValue(key, value, fallback, diagnostics) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = stripInlineComment(value).trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  diagnostics.push(malformedDiagnostic(key, value, 'boolean'));
  return fallback;
}

function normalizeString(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value);
}

function unknownKeyDiagnostics(rawConfig, rawAllowWarn) {
  const diagnostics = [];
  for (const key of Object.keys(rawConfig ?? {})) {
    if (!KNOWN_OPEN_SPEC_KEYS.has(key)) {
      diagnostics.push({
        code: 'openspec-policy-unknown-key',
        severity: 'warning',
        message: `Unknown OpenSpec policy key ignored: aifhub.openspec.${key}`,
        path: '.ai-factory/config.yaml',
        key: `aifhub.openspec.${key}`
      });
    }
  }
  for (const key of Object.keys(rawAllowWarn ?? {})) {
    if (!KNOWN_ALLOW_WARN_KEYS.has(key)) {
      diagnostics.push({
        code: 'openspec-policy-unknown-key',
        severity: 'warning',
        message: `Unknown OpenSpec done warning policy key ignored: aifhub.openspec.allowWarnOnDone.${key}`,
        path: '.ai-factory/config.yaml',
        key: `aifhub.openspec.allowWarnOnDone.${key}`
      });
    }
  }
  return diagnostics;
}

function malformedDiagnostic(key, value, expected) {
  return {
    code: 'openspec-policy-invalid-value',
    severity: 'warning',
    message: `Invalid OpenSpec policy value for ${key}; expected ${expected}, using default.`,
    path: '.ai-factory/config.yaml',
    key,
    value
  };
}

function parseSimpleYaml(raw) {
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }

    const match = rawLine.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*?))?\s*$/);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const key = match[2];
    const rawValue = match[3] ?? '';

    while (stack.length > 1 && indent <= stack.at(-1).indent) {
      stack.pop();
    }

    const parent = stack.at(-1).value;

    if (rawValue.length === 0) {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

function parseScalar(value) {
  const trimmed = stripInlineComment(String(value)).trim();
  const unquoted = trimmed.replace(/^["']|["']$/g, '');
  const lower = unquoted.toLowerCase();

  if (lower === 'true') {
    return true;
  }

  if (lower === 'false') {
    return false;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) {
    return Number(unquoted);
  }

  return unquoted;
}

function stripInlineComment(value) {
  let quote = null;
  const raw = String(value ?? '');

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if ((char === '"' || char === "'") && (index === 0 || raw[index - 1] !== '\\')) {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === '#' && quote === null && (index === 0 || /\s/.test(raw[index - 1]))) {
      return raw.slice(0, index);
    }
  }

  return raw;
}

function normalizeRulesGateEvidence(evidence, fallbackPath) {
  const exists = evidence?.exists ?? Boolean(evidence?.gateResult);
  const gate = evidence?.gateResult ?? null;

  if (!exists) {
    return {
      exists: false,
      ok: false,
      status: 'missing',
      path: evidence?.path ?? fallbackPath,
      gateResult: null,
      warnings: evidence?.warnings ?? [],
      errors: evidence?.errors ?? []
    };
  }

  if (!gate || gate.missing) {
    return {
      exists: true,
      ok: false,
      status: 'missing',
      path: evidence?.path ?? fallbackPath,
      gateResult: gate,
      warnings: evidence?.warnings ?? [],
      errors: [
        ...(evidence?.errors ?? []),
        {
          code: 'rules-gate-result-missing',
          message: 'Rules gate evidence is missing the final aif-gate-result block for the rules gate.',
          path: evidence?.path ?? fallbackPath
        }
      ]
    };
  }

  if (gate.ok === false) {
    return {
      exists: true,
      ok: false,
      status: 'invalid',
      path: evidence?.path ?? fallbackPath,
      gateResult: gate,
      warnings: evidence?.warnings ?? [],
      errors: [
        ...(evidence?.errors ?? []),
        {
          code: 'rules-gate-result-invalid',
          message: 'Rules gate evidence contains an invalid aif-gate-result block for the rules gate.',
          path: evidence?.path ?? fallbackPath
        }
      ]
    };
  }

  const status = gate.result?.status ?? gate.status ?? 'missing';
  return {
    exists: true,
    ok: status === 'pass',
    status,
    path: evidence?.path ?? fallbackPath,
    gateResult: gate,
    warnings: evidence?.warnings ?? [],
    errors: evidence?.errors ?? []
  };
}

function isFindingRequired(kind, action, policy) {
  if (kind === 'cli') {
    return Boolean(policy.requirements?.cli?.[action]);
  }
  if (kind === 'generatedRules') {
    return Boolean(policy.requirements?.generatedRules?.[action]);
  }
  if (kind === 'rulesPass') {
    return Boolean(policy.requirements?.rulesPass?.[action]);
  }
  if (kind === 'specCoverage' || kind === 'coverage') {
    return Boolean(policy.requirements?.specCoverage?.[action]);
  }
  return action === 'done';
}

function isDoneWarningAllowed(kind, policy) {
  if (kind === 'rulesPass' || kind === 'rules') {
    return Boolean(policy.allowWarnOnDone?.rules);
  }
  if (kind === 'specCoverage' || kind === 'coverage') {
    return Boolean(policy.allowWarnOnDone?.coverage);
  }
  if (kind === 'openspecStatus') {
    return Boolean(policy.allowWarnOnDone?.openspecStatus);
  }
  return false;
}

function normalizeWarnKind(kind) {
  if (kind === 'rulesPass' || kind === 'rules') {
    return 'rules';
  }
  if (kind === 'specCoverage' || kind === 'coverage') {
    return 'coverage';
  }
  return 'openspecStatus';
}

function normalizeFindingKind(kind) {
  if (kind === 'generated-rules') {
    return 'generatedRules';
  }
  if (kind === 'rules' || kind === 'rulesGate') {
    return 'rulesPass';
  }
  if (kind === 'coverage') {
    return 'specCoverage';
  }
  return kind ?? 'unknown';
}

function normalizeAction(action) {
  const normalized = String(action ?? 'verify').trim();
  return ['plan', 'improve', 'verify', 'done'].includes(normalized) ? normalized : 'verify';
}

function normalizeStatus(status) {
  const normalized = String(status ?? 'missing').trim().toLowerCase();
  if (['pass', 'warn', 'fail', 'missing', 'stale', 'invalid', 'not-applicable'].includes(normalized)) {
    return normalized;
  }
  return 'invalid';
}

function policyDiagnosticCode(kind, status, action) {
  return `openspec-policy-${action}-${kind}-${status}`;
}

function policyDiagnosticMessage(kind, status, action, required) {
  const requirement = required ? 'required' : 'optional';
  return `OpenSpec ${kind} policy finding is ${status} for ${action}; evidence is ${requirement}.`;
}

function requirementLabel(value) {
  return value ? 'required' : 'degraded';
}

function allowLabel(value) {
  return value ? 'allowed' : 'blocked';
}

function normalizeChangeIdForPath(changeId) {
  const value = String(changeId ?? '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    return {
      ok: false,
      error: {
        code: 'invalid-change-id',
        message: 'Invalid OpenSpec change id.',
        value
      }
    };
  }
  return {
    ok: true,
    changeId: value
  };
}

function resolveRootDir(options = {}) {
  return path.resolve(options.rootDir ?? process.cwd());
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  const deduped = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}|${diagnostic.message}|${diagnostic.path ?? ''}|${diagnostic.key ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(diagnostic);
  }
  return deduped;
}

function isWithinDirectory(candidate, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosix(value) {
  return String(value ?? '').split(path.sep).join('/');
}

async function runCli() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const summary = args.includes('--summary') || !json;
  const rootIndex = args.indexOf('--root');
  const rootDir = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
  const policy = await readOpenSpecPolicy({ rootDir });

  if (json) {
    process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
    return;
  }

  if (summary) {
    process.stdout.write(`${summarizeOpenSpecPolicy(policy)}\n`);
  }
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  runCli().catch((err) => {
    process.stderr.write(`${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  });
}
