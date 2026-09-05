#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ensureRuntimeLayout as defaultEnsureRuntimeLayout,
  normalizeChangeId,
  resolveActiveChange as defaultResolveActiveChange,
} from './active-change-resolver.mjs';
import {
  collectCanonicalChangeArtifacts,
  collectGeneratedRules,
} from './openspec-execution-context.mjs';
import { getLatestGateResult } from './aif-gate-result.mjs';

export const COVERAGE_SCHEMA_VERSION = 1;
export const COVERAGE_FILE = 'coverage.json';
const DEFAULT_QA_DIR = '.ai-factory/qa';
const DEFAULT_STATE_DIR = '.ai-factory/state';
const DEFAULT_POLICY = 'normal';
const POLICIES = new Set(['strict', 'normal']);
const REQUIREMENT_STATUS_ORDER = ['covered', 'partial', 'missing', 'not-applicable'];
const TEST_PATH_PATTERN = /(^|\/)(test|tests|__tests__)\/|[._-](test|spec)\.[A-Za-z0-9]+$/i;
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$|\.mjs$|\.cjs$|\.py$|\.go$|\.rs$|\.java$|\.kt$|\.cs$|\.php$|\.rb$|\.sh$|\.ps1$/i;
const TOOLING_CONFIG_FILE_PATTERN = /\.(?:json|ya?ml|toml|xml)$/i;
const PROMPT_SOURCE_FILE_PATTERN = /^(?:skills\/(?:[^/]+\/SKILL\.md|shared\/[A-Z0-9_-]+\.md)|injections\/(?:core|handoff)\/[^/]+\.md|agent-files\/(?:codex\/[^/]+\.toml|claude\/[^/]+\.md))$/i;
const DOC_PATH_PATTERN = /(^|\/)(docs|documentation)\//i;
const INTERNAL_ARTIFACT_PATTERN = /^(openspec|\.ai-factory)\//i;
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'be',
  'by',
  'can',
  'for',
  'from',
  'has',
  'have',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'shall',
  'should',
  'the',
  'then',
  'to',
  'when',
  'with',
  'without',
  'must',
  'user',
  'system',
  'requirement',
  'scenario',
]);

export async function buildOpenSpecCoverageMatrix(options = {}) {
  const rootDir = resolveRootDir(options.rootDir);
  const warnings = [];
  const errors = [];
  const policy = await resolveCoveragePolicy(rootDir, options.policy, warnings);
  const resolved = await resolveCoverageChange(rootDir, options);
  const changeId = resolved.changeId ?? options.changeId ?? null;

  if (!resolved.ok) {
    const matrix = emptyCoverageMatrix(changeId, policy, 'fail', true, warnings, resolved.errors ?? ['Unable to resolve OpenSpec change.']);
    return matrix;
  }

  const layout = await resolveRuntimeLayout(rootDir, resolved.changeId, options);
  const canonical = await collectCanonicalChangeArtifacts(resolved.changeId, {
    ...options,
    rootDir,
  });
  warnings.push(...(canonical.warnings ?? []));
  errors.push(...(canonical.errors ?? []));
  const requirementInputs = parseRequirementsFromCanonical(canonical.canonicalArtifacts?.deltaSpecs ?? []);
  const taskInputs = parseTasks(canonical.canonicalArtifacts?.tasks?.content ?? '');
  const fallbackTaskIds = taskInputs.filter((task) => task.id.startsWith('task-')).map((task) => task.id);
  if (fallbackTaskIds.length > 0) {
    warnings.push({
      code: 'coverage-task-id-fallback',
      message: `Generated fallback task id(s) for unnumbered checklist entries: ${fallbackTaskIds.join(', ')}.`,
      path: canonical.canonicalArtifacts?.tasks?.path,
    });
  }
  const generatedRules = await resolveGeneratedRulesContext(rootDir, resolved.changeId, options);
  warnings.push(...(generatedRules.warnings ?? []));
  errors.push(...(generatedRules.errors ?? []));
  const traceInputs = await collectRuntimeTraceInputs(layout.statePath, options);
  const verifyInput = await collectVerifyInput(layout.qaPath, options);
  const sourceRecords = await buildSourceRecords(rootDir, [
    ...canonicalSources(canonical.canonicalArtifacts),
    ...traceInputs.sources,
    ...verifyInput.sources,
    ...generatedRuleSources(generatedRules.generatedRules),
  ]);
  const evidenceText = [
    canonical.canonicalArtifacts?.tasks?.content ?? '',
    ...traceInputs.contents,
    verifyInput.content ?? '',
    ...(generatedRules.generatedRules ?? []).map((rule) => rule.content ?? ''),
  ].join('\n\n');
  const evidencePaths = classifyEvidencePaths(extractEvidencePaths(evidenceText));
  const rulesGate = inferRulesGate(generatedRules, verifyInput.gateResult, options.verifyGateResult);
  const requirements = requirementInputs.map((requirement) => {
    const matchingTasks = matchTasks(requirement, taskInputs);
    const implementationEvidence = matchEvidencePaths(requirement, evidencePaths.implementation, matchingTasks);
    const testEvidence = matchEvidencePaths(requirement, evidencePaths.tests, matchingTasks);
    const status = classifyRequirementCoverage(requirement, matchingTasks, implementationEvidence, testEvidence, rulesGate);

    return {
      id: requirement.id,
      source: requirement.source,
      status,
      tasks: matchingTasks.map((task) => task.id),
      implementation_evidence: implementationEvidence,
      test_evidence: testEvidence,
      rules_gate: rulesGate,
    };
  });
  const summary = summarizeRequirements(requirements);
  const policyResult = evaluateOpenSpecCoveragePolicy({ requirements, summary }, { policy: policy.mode });
  const buildErrorDiagnostics = errors.map((error, index) => ({
    severity: 'error',
    code: error.code ?? `coverage-build-error-${index + 1}`,
    message: error.message ?? String(error),
    path: error.path,
  }));
  const status = buildErrorDiagnostics.length > 0 ? 'fail' : policyResult.status;
  const matrix = {
    schema_version: COVERAGE_SCHEMA_VERSION,
    change_id: resolved.changeId,
    status,
    blocking: status === 'fail',
    policy: {
      mode: policy.mode,
      missing_requirement: policy.mode === 'strict' ? 'fail' : 'warn',
    },
    requirements,
    summary,
    sources: sourceRecords,
    stale: false,
    diagnostics: [...buildErrorDiagnostics, ...policyResult.diagnostics],
    warnings: [...warnings, ...policyResult.warnings],
    errors: [...errors, ...policyResult.errors],
  };
  return matrix;
}

export async function writeOpenSpecCoverageMatrix(changeId, matrix, options = {}) {
  const normalized = normalizeCoverageChangeId(changeId ?? matrix?.change_id);
  const rootDir = resolveRootDir(options.rootDir);
  const qaPath = await resolveQaPath(rootDir, normalized.changeId, options);
  await assertSafeQaPath(rootDir, qaPath);
  await ensureRuntimeGitignore(rootDir, options.qaPath ? qaPath : path.dirname(qaPath));
  await mkdir(qaPath, { recursive: true });
  const coveragePath = path.join(qaPath, COVERAGE_FILE);
  const payload = JSON.stringify({ ...matrix, change_id: normalized.changeId }, null, 2);
  await writeFile(coveragePath, `${payload}\n`, 'utf8');
  return {
    ok: true,
    changeId: normalized.changeId,
    coveragePath,
    relativePath: toPosix(path.relative(rootDir, coveragePath)),
  };
}

export async function readOpenSpecCoverageMatrix(changeId, options = {}) {
  const normalized = normalizeCoverageChangeId(changeId);
  const rootDir = resolveRootDir(options.rootDir);
  const qaPath = await resolveQaPath(rootDir, normalized.changeId, options);
  const coveragePath = path.join(qaPath, COVERAGE_FILE);
  const relativePath = toPosix(path.relative(rootDir, coveragePath));

  try {
    await access(coveragePath);
  } catch {
    return {
      ok: false,
      exists: false,
      stale: null,
      changeId: normalized.changeId,
      coveragePath,
      relativePath,
      coverage: null,
      diagnostics: [{
        severity: 'warning',
        code: 'coverage-missing',
        message: `Coverage matrix is missing at ${relativePath}.`,
      }],
      warnings: [`Coverage matrix is missing at ${relativePath}.`],
      errors: [],
    };
  }

  let coverage;
  try {
    coverage = JSON.parse(await readFile(coveragePath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      exists: true,
      stale: null,
      changeId: normalized.changeId,
      coveragePath,
      relativePath,
      coverage: null,
      diagnostics: [{
        severity: 'error',
        code: 'coverage-invalid-json',
        message: `Coverage matrix is not valid JSON: ${error.message}`,
      }],
      warnings: [],
      errors: [`Coverage matrix is not valid JSON: ${error.message}`],
    };
  }

  const validation = validateCoverageShape(coverage);
  const stale = await inspectCoverageStaleness(rootDir, coverage);
  const diagnostics = [...validation.diagnostics, ...stale.diagnostics];
  return {
    ok: validation.ok,
    exists: true,
    stale: stale.stale,
    changeId: normalized.changeId,
    coveragePath,
    relativePath,
    coverage: { ...coverage, stale: stale.stale },
    diagnostics,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').map((diagnostic) => diagnostic.message),
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === 'error').map((diagnostic) => diagnostic.message),
  };
}

export function summarizeOpenSpecCoverage(matrixOrResult, options = {}) {
  const matrix = matrixOrResult?.coverage ?? matrixOrResult;
  if (!matrix) {
    return [
      'Coverage matrix: MISSING',
      options.relativePath ? `Coverage artifact: ${options.relativePath}` : null,
    ].filter(Boolean).join('\n');
  }

  const summary = matrix.summary ?? summarizeRequirements(matrix.requirements ?? []);
  const status = String(matrix.status ?? 'unknown').toUpperCase();
  const lines = [
    `Coverage matrix: ${status}`,
    `Requirements: covered ${summary.covered ?? 0}, partial ${summary.partial ?? 0}, missing ${summary.missing ?? 0}, not-applicable ${summary.not_applicable ?? 0}`,
  ];

  if (matrix.policy?.mode) {
    lines.push(`Coverage policy: ${matrix.policy.mode}`);
  }

  if (matrix.stale === true) {
    lines.push('Coverage staleness: stale');
  } else if (matrix.stale === false) {
    lines.push('Coverage staleness: current');
  }

  const missing = (matrix.requirements ?? []).filter((requirement) => requirement.status === 'missing');
  if (missing.length > 0) {
    lines.push(`Missing coverage: ${missing.map((requirement) => requirement.id).join(', ')}`);
  }

  return lines.join('\n');
}

export function evaluateOpenSpecCoveragePolicy(matrixOrSummary, options = {}) {
  const policy = normalizePolicyValue(options.policy ?? matrixOrSummary?.policy?.mode ?? DEFAULT_POLICY);
  const requirements = matrixOrSummary?.requirements ?? [];
  const summary = matrixOrSummary?.summary ?? summarizeRequirements(requirements);
  const diagnostics = [];
  const warnings = [];
  const errors = [];
  const missing = summary.missing ?? 0;
  const partial = summary.partial ?? 0;
  const ruleGateFailures = requirements.filter((requirement) => requirement.rules_gate === 'fail');

  if (ruleGateFailures.length > 0) {
    const message = `Coverage rules gate failed for ${ruleGateFailures.length} requirement(s).`;
    diagnostics.push({ severity: 'error', code: 'coverage-rules-gate-failed', message });
    errors.push(message);
  }

  if (missing > 0) {
    const severity = policy === 'strict' ? 'error' : 'warning';
    const message = `Coverage matrix has ${missing} missing requirement(s).`;
    diagnostics.push({ severity, code: 'coverage-missing-requirements', message });
    if (severity === 'error') {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  if (partial > 0) {
    const message = `Coverage matrix has ${partial} partially covered requirement(s).`;
    diagnostics.push({ severity: 'warning', code: 'coverage-partial-requirements', message });
    warnings.push(message);
  }

  const status = errors.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';
  return {
    status,
    blocking: status === 'fail',
    policy,
    diagnostics,
    warnings,
    errors,
  };
}

export async function runCoverageMatrixCommand(argv = process.argv.slice(2), options = {}) {
  const parsed = parseCoverageMatrixArgs(argv);
  if (!parsed.ok) {
    const result = {
      ok: false,
      status: 'fail',
      errors: parsed.errors,
    };
    await writeCommandOutput(result, parsed.json);
    return 2;
  }

  const matrix = await buildOpenSpecCoverageMatrix({
    ...options,
    rootDir: options.rootDir ?? process.cwd(),
    changeId: parsed.changeId,
    policy: parsed.policy,
  });

  let writeResult = null;
  if (parsed.write && matrix.change_id) {
    writeResult = await writeOpenSpecCoverageMatrix(matrix.change_id, matrix, {
      ...options,
      rootDir: options.rootDir ?? process.cwd(),
    });
  }

  const output = writeResult ? { ...matrix, artifact: writeResult.relativePath } : matrix;
  await writeCommandOutput(output, parsed.json);
  return matrix.status === 'fail' ? 1 : 0;
}

export function parseCoverageMatrixArgs(argv = []) {
  const result = {
    ok: true,
    changeId: null,
    json: false,
    write: false,
    policy: null,
    errors: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--change') {
      result.changeId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      result.json = true;
      continue;
    }
    if (arg === '--write') {
      result.write = true;
      continue;
    }
    if (arg === '--policy') {
      result.policy = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    result.ok = false;
    result.errors.push(`Unknown argument: ${arg}`);
  }

  if (result.help) {
    result.ok = false;
    result.errors.push(usageText());
  }

  if (result.policy && !POLICIES.has(result.policy)) {
    result.ok = false;
    result.errors.push(`Unsupported coverage policy: ${result.policy}. Expected strict or normal.`);
  }

  if (result.changeId !== null) {
    const normalized = normalizeChangeId(result.changeId);
    if (!normalized.ok) {
      result.ok = false;
      result.errors.push(...normalizeChangeIdMessages(normalized));
    } else {
      result.changeId = normalized.changeId;
    }
  }

  return result;
}

function usageText() {
  return [
    'Usage: node scripts/openspec-coverage-matrix.mjs [--change <id>] [--policy strict|normal] [--write] [--json]',
    'Builds an OpenSpec requirement-to-code coverage matrix.',
  ].join('\n');
}

async function writeCommandOutput(output, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  if (output?.errors?.length > 0 && !output?.requirements) {
    process.stderr.write(`${output.errors.join('\n')}\n`);
    return;
  }

  process.stdout.write(`${summarizeOpenSpecCoverage(output)}\n`);
  if (output?.artifact) {
    process.stdout.write(`Coverage artifact: ${output.artifact}\n`);
  }
}

async function resolveCoverageChange(rootDir, options) {
  if (options.changeId) {
    const normalized = normalizeChangeId(options.changeId);
    return normalized.ok
      ? { ok: true, changeId: normalized.changeId, source: 'explicit', errors: [] }
      : { ok: false, changeId: null, source: 'explicit', errors: normalizeChangeIdMessages(normalized) };
  }

  const resolver = options.resolveActiveChange ?? defaultResolveActiveChange;
  const resolved = await resolver({
    rootDir,
    cwd: options.cwd ?? process.cwd(),
    changeId: null,
    getCurrentBranch: options.getCurrentBranch,
  });
  if (resolved.ok) {
    return { ok: true, changeId: resolved.changeId, source: resolved.source, errors: [] };
  }
  return { ok: false, changeId: null, source: resolved.source, errors: resolved.errors };
}

async function resolveRuntimeLayout(rootDir, changeId, options) {
  if (options.qaPath && options.statePath) {
    return { qaPath: options.qaPath, statePath: options.statePath };
  }

  const ensureLayout = options.ensureRuntimeLayout ?? defaultEnsureRuntimeLayout;
  const layout = await ensureLayout(changeId, {
    rootDir,
    cwd: options.cwd,
    stateDir: options.stateDir,
    qaDir: options.qaDir,
  });
  return {
    qaPath: options.qaPath ?? layout.qaPath,
    statePath: options.statePath ?? layout.statePath,
  };
}

async function resolveGeneratedRulesContext(rootDir, changeId, options) {
  if (Array.isArray(options.generatedRules)) {
    return {
      ok: true,
      changeId,
      generatedRules: options.generatedRules,
      warnings: [],
      errors: [],
    };
  }

  if (options.generatedRules?.generatedRules) {
    return options.generatedRules;
  }

  return collectGeneratedRules(changeId, {
    ...options,
    rootDir,
  });
}

async function resolveQaPath(rootDir, changeId, options) {
  if (options.qaPath) {
    return path.resolve(rootDir, options.qaPath);
  }
  if (options.qaDir) {
    return path.resolve(rootDir, options.qaDir, changeId);
  }
  return path.resolve(rootDir, DEFAULT_QA_DIR, changeId);
}

function resolveRootDir(rootDir) {
  return path.resolve(rootDir ?? process.cwd());
}

function normalizeCoverageChangeId(changeId) {
  const normalized = normalizeChangeId(changeId);
  if (!normalized.ok) {
    throw new Error(normalizeChangeIdMessages(normalized).join('; '));
  }
  return normalized;
}

function normalizeChangeIdMessages(normalized) {
  const errors = Array.isArray(normalized?.errors)
    ? normalized.errors
    : normalized?.error
      ? [normalized.error]
      : [];
  const messages = errors.map((error) => error?.message ?? String(error)).filter(Boolean);
  return messages.length > 0 ? messages : ['Invalid OpenSpec change id.'];
}

function emptyCoverageMatrix(changeId, policy, status, blocking, warnings, errors) {
  return {
    schema_version: COVERAGE_SCHEMA_VERSION,
    change_id: changeId,
    status,
    blocking,
    policy: {
      mode: policy.mode,
      missing_requirement: policy.mode === 'strict' ? 'fail' : 'warn',
    },
    requirements: [],
    summary: { covered: 0, partial: 0, missing: 0, not_applicable: 0 },
    sources: [],
    stale: false,
    diagnostics: errors.map((message) => ({ severity: 'error', code: 'coverage-build-failed', message })),
    warnings,
    errors,
  };
}

async function resolveCoveragePolicy(rootDir, explicitPolicy, warnings) {
  if (explicitPolicy) {
    return { mode: normalizePolicyValue(explicitPolicy, warnings) };
  }

  const configPath = path.join(rootDir, '.ai-factory', 'config.yaml');
  try {
    const config = await readFile(configPath, 'utf8');
    const match = config.match(/^\s*verify_mode:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m);
    if (match) {
      return { mode: normalizePolicyValue(match[1], warnings) };
    }
  } catch {
    // Missing config is acceptable for isolated tests and direct CLI use.
  }

  return { mode: DEFAULT_POLICY };
}

function normalizePolicyValue(value, warnings = []) {
  const normalized = String(value ?? DEFAULT_POLICY).trim().toLowerCase();
  if (POLICIES.has(normalized)) {
    return normalized;
  }
  warnings.push(`Unsupported coverage policy "${value}", using ${DEFAULT_POLICY}.`);
  return DEFAULT_POLICY;
}

function parseRequirementsFromCanonical(deltaSpecs) {
  const requirements = [];
  for (const spec of deltaSpecs) {
    requirements.push(...parseRequirements(spec.content ?? '', spec.relativePath ?? spec.path));
  }
  return requirements;
}

function parseRequirements(content, source) {
  const requirements = [];
  const lines = String(content ?? '').split(/\r?\n/);
  let currentSection = null;
  let currentRequirement = null;
  let scenarioIndex = 0;
  let inScenario = false;

  const flush = () => {
    if (!currentRequirement) {
      return;
    }
    currentRequirement.text = [
      currentRequirement.title,
      currentRequirement.body.join('\n'),
      currentRequirement.scenarios.join('\n'),
    ].join('\n');
    currentRequirement.keywords = tokenize(currentRequirement.text);
    currentRequirement.notApplicable = isNotApplicableRequirement(currentRequirement);
    delete currentRequirement.body;
    requirements.push(currentRequirement);
    currentRequirement = null;
  };

  for (const line of lines) {
    const section = line.match(/^##\s+(ADDED|MODIFIED|REMOVED|DEPRECATED)\s+Requirements/i);
    if (section) {
      flush();
      currentSection = section[1].toLowerCase();
      scenarioIndex = 0;
      inScenario = false;
      continue;
    }

    const requirement = line.match(/^###\s+Requirement:\s+(.+?)\s*$/i);
    if (requirement) {
      flush();
      scenarioIndex = 0;
      inScenario = false;
      const title = requirement[1].trim();
      currentRequirement = {
        id: requirementId(title, source, requirements.length + 1),
        title,
        section: currentSection ?? 'unknown',
        source,
        body: [],
        scenarios: [],
      };
      continue;
    }

    if (!currentRequirement) {
      continue;
    }

    const scenario = line.match(/^####\s+Scenario:\s+(.+?)\s*$/i);
    if (scenario) {
      scenarioIndex += 1;
      inScenario = true;
      currentRequirement.scenarios.push(`Scenario ${scenarioIndex}: ${scenario[1].trim()}`);
      continue;
    }

    if (inScenario) {
      currentRequirement.scenarios.push(line);
    } else {
      currentRequirement.body.push(line);
    }
  }

  flush();
  return requirements;
}

function requirementId(title, source, fallbackIndex) {
  const specName = path.basename(path.dirname(toPosix(source ?? 'spec/spec.md')));
  const slug = slugify(title);
  return `${slugify(specName || 'requirement')}.${slug || `requirement-${fallbackIndex}`}`;
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isNotApplicableRequirement(requirement) {
  const text = `${requirement.title}\n${(requirement.body ?? []).join('\n')}`.toLowerCase();
  return /\b(not-applicable|no code change|documentation only|docs only|tooling only|non-runtime|no runtime behavior|does not require runtime)\b/.test(text);
}

function parseTasks(content) {
  const tasks = [];
  const lines = String(content ?? '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*-\s+\[(?<state>[ xX])\]\s+(?:(?<id>\d+(?:\.\d+)*)\s+)?(?<text>.+?)\s*$/);
    if (!match) {
      continue;
    }
    const id = match.groups?.id ?? `task-${tasks.length + 1}`;
    const text = match.groups?.text ?? '';
    tasks.push({
      id,
      text,
      done: /x/i.test(match.groups?.state ?? ''),
      keywords: tokenize(text),
      paths: extractEvidencePaths(text),
    });
  }
  return tasks;
}

function matchTasks(requirement, tasks) {
  return tasks
    .filter((task) => intersects(requirement.keywords, task.keywords) || pathSetMatchesRequirement(requirement, task.paths))
    .sort((a, b) => naturalCompare(a.id, b.id));
}

function classifyEvidencePaths(paths) {
  const implementation = new Set();
  const tests = new Set();

  for (const evidencePath of paths) {
    if (TEST_PATH_PATTERN.test(evidencePath)) {
      tests.add(evidencePath);
      continue;
    }

    if (isImplementationEvidencePath(evidencePath)) {
      implementation.add(evidencePath);
    }
  }

  return {
    implementation: [...implementation].sort(naturalCompare),
    tests: [...tests].sort(naturalCompare),
  };
}

function isImplementationEvidencePath(evidencePath) {
  if (TEST_PATH_PATTERN.test(evidencePath)) {
    return false;
  }
  if (DOC_PATH_PATTERN.test(evidencePath)) {
    return false;
  }
  if (INTERNAL_ARTIFACT_PATTERN.test(evidencePath)) {
    return false;
  }
  return PROMPT_SOURCE_FILE_PATTERN.test(evidencePath)
    || SOURCE_FILE_PATTERN.test(evidencePath)
    || TOOLING_CONFIG_FILE_PATTERN.test(evidencePath);
}

function matchEvidencePaths(requirement, paths, matchingTasks) {
  const taskPathMatches = new Set(matchingTasks.flatMap((task) => task.paths));
  const matched = paths.filter((evidencePath) => {
    if (taskPathMatches.has(evidencePath)) {
      return true;
    }
    return intersects(requirement.keywords, tokenizePath(evidencePath));
  });
  return [...new Set(matched)].sort(naturalCompare);
}

function pathSetMatchesRequirement(requirement, paths) {
  return paths.some((evidencePath) => intersects(requirement.keywords, tokenizePath(evidencePath)));
}

function classifyRequirementCoverage(requirement, tasks, implementationEvidence, testEvidence, rulesGate) {
  if (requirement.notApplicable) {
    return 'not-applicable';
  }
  if (rulesGate === 'fail') {
    return 'partial';
  }
  if (tasks.length === 0 && implementationEvidence.length === 0) {
    return 'missing';
  }
  if (tasks.length > 0 && implementationEvidence.length > 0 && testEvidence.length > 0) {
    return 'covered';
  }
  return 'partial';
}

function summarizeRequirements(requirements) {
  const summary = { covered: 0, partial: 0, missing: 0, not_applicable: 0 };
  for (const requirement of requirements ?? []) {
    const status = REQUIREMENT_STATUS_ORDER.includes(requirement.status) ? requirement.status : 'partial';
    if (status === 'not-applicable') {
      summary.not_applicable += 1;
    } else {
      summary[status] += 1;
    }
  }
  return summary;
}

function inferRulesGate(generatedRules, verifyGateResult, overrideGateResult) {
  const gate = overrideGateResult ?? verifyGateResult;
  const gateStatus = gate?.result?.status ?? gate?.status;
  if (gateStatus === 'fail') {
    return 'fail';
  }
  const rules = generatedRules?.generatedRules ?? (Array.isArray(generatedRules) ? generatedRules : []);
  if (rules.some((rule) => rule.stale === true || rule.exists === false)) {
    return 'warn';
  }
  if ((generatedRules?.warnings ?? []).length > 0 || gateStatus === 'warn') {
    return 'warn';
  }
  return 'pass';
}

async function collectRuntimeTraceInputs(statePath, options) {
  if (options.traceInputs) {
    return options.traceInputs;
  }

  const contents = [];
  const sources = [];
  const traceDirs = [
    path.join(statePath, 'implementation'),
    path.join(statePath, 'fixes'),
  ];

  for (const traceDir of traceDirs) {
    const files = await collectFiles(traceDir, (filePath) => /\.(md|markdown)$/i.test(filePath));
    for (const filePath of files) {
      try {
        const content = await readFile(filePath, 'utf8');
        contents.push(content);
        sources.push({
          path: filePath,
          relativePath: toPosix(path.relative(options.rootDir ?? process.cwd(), filePath)),
          content,
        });
      } catch {
        // Ignore unreadable optional traces; missing evidence naturally reduces coverage.
      }
    }
  }

  return { contents, sources };
}

async function collectVerifyInput(qaPath, options) {
  if (options.skipVerifyEvidence) {
    return { content: '', sources: [], gateResult: null };
  }
  if (options.verifyContent !== undefined) {
    return {
      content: options.verifyContent ?? '',
      sources: options.verifyPath ? [{ path: options.verifyPath, relativePath: options.verifyRelativePath, content: options.verifyContent ?? '' }] : [],
      gateResult: options.verifyGateResult ?? null,
    };
  }

  const verifyPath = path.join(qaPath, 'verify.md');
  try {
    const content = await readFile(verifyPath, 'utf8');
    return {
      content,
      sources: [{ path: verifyPath, content }],
      gateResult: getLatestGateResult(content),
    };
  } catch {
    return { content: '', sources: [], gateResult: null };
  }
}

async function collectFiles(directory, predicate) {
  const result = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectFiles(filePath, predicate));
    } else if (entry.isFile() && predicate(filePath)) {
      result.push(filePath);
    }
  }

  return result.sort(naturalCompare);
}

function canonicalSources(canonicalArtifacts = {}) {
  const specs = canonicalArtifacts.deltaSpecs ?? [];
  return [
    ...specs.map((spec) => ({
      path: spec.path,
      relativePath: spec.relativePath ?? spec.path,
      content: spec.content,
    })),
    canonicalArtifacts.tasks ? {
      path: canonicalArtifacts.tasks.path,
      relativePath: canonicalArtifacts.tasks.relativePath ?? canonicalArtifacts.tasks.path,
      content: canonicalArtifacts.tasks.content,
    } : null,
  ].filter(Boolean);
}

function generatedRuleSources(generatedRules = []) {
  return generatedRules
    .filter((artifact) => artifact && artifact.exists !== false)
    .map((artifact) => ({
      path: artifact.path,
      relativePath: artifact.relativePath ?? artifact.path,
      content: artifact.content,
    }));
}

async function buildSourceRecords(rootDir, sources) {
  const records = [];
  const seen = new Set();

  for (const source of sources) {
    if (!source) {
      continue;
    }
    const relativePath = toPosix(source.relativePath ?? path.relative(rootDir, source.path));
    if (!relativePath || seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    let content = source.content;
    if (content === undefined && source.path) {
      try {
        content = await readFile(source.path, 'utf8');
      } catch {
        content = '';
      }
    }
    records.push({
      path: relativePath,
      sha256: sha256(content ?? ''),
    });
  }

  return records.sort((a, b) => naturalCompare(a.path, b.path));
}

async function inspectCoverageStaleness(rootDir, coverage) {
  const diagnostics = [];
  const sources = Array.isArray(coverage?.sources) ? coverage.sources : [];

  for (const source of sources) {
    const relativePath = source?.path;
    if (!relativePath || !source.sha256) {
      diagnostics.push({
        severity: 'warning',
        code: 'coverage-source-invalid',
        message: `Coverage source entry is missing path or sha256: ${JSON.stringify(source)}`,
      });
      continue;
    }

    const sourcePath = path.resolve(rootDir, relativePath);
    let content;
    try {
      content = await readFile(sourcePath, 'utf8');
    } catch {
      diagnostics.push({
        severity: 'warning',
        code: 'coverage-source-missing',
        message: `Coverage source is missing: ${relativePath}`,
      });
      continue;
    }

    const current = sha256(content);
    if (current !== source.sha256) {
      diagnostics.push({
        severity: 'warning',
        code: 'coverage-source-stale',
        message: `Coverage source changed since matrix generation: ${relativePath}`,
      });
    }
  }

  return {
    stale: diagnostics.length > 0,
    diagnostics,
  };
}

function validateCoverageShape(coverage) {
  const diagnostics = [];
  if (coverage?.schema_version !== COVERAGE_SCHEMA_VERSION) {
    diagnostics.push({
      severity: 'error',
      code: 'coverage-schema-version',
      message: `Unsupported coverage schema version: ${coverage?.schema_version}`,
    });
  }
  if (!coverage?.change_id) {
    diagnostics.push({
      severity: 'error',
      code: 'coverage-change-id-missing',
      message: 'Coverage matrix is missing change_id.',
    });
  }
  if (!Array.isArray(coverage?.requirements)) {
    diagnostics.push({
      severity: 'error',
      code: 'coverage-requirements-invalid',
      message: 'Coverage matrix requirements must be an array.',
    });
  }
  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
  };
}

async function assertSafeQaPath(rootDir, qaPath) {
  const root = path.resolve(rootDir);
  const qa = path.resolve(qaPath);

  if (!isWithinDirectory(qa, root)) {
    throw new Error(`Refusing to write coverage outside repository root: ${qa}`);
  }

  for (const forbiddenDir of [
    path.join(root, 'openspec', 'changes'),
    path.join(root, '.ai-factory', 'plans'),
  ]) {
    if (isWithinDirectory(qa, forbiddenDir)) {
      throw new Error(`Coverage evidence path must stay outside canonical OpenSpec changes and legacy plan folders: ${qa}`);
    }
  }
}

function isWithinDirectory(targetPath, directoryPath) {
  const relative = path.relative(path.resolve(directoryPath), path.resolve(targetPath));
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function extractEvidencePaths(text) {
  const paths = new Set();
  const source = String(text ?? '');
  const pathPattern = /(?:^|[\s`"'(])((?:(?:\.?[A-Za-z0-9_.@-]+[\\/])+)?\.?[A-Za-z0-9_@()-][A-Za-z0-9_.@()-]*\.[A-Za-z][A-Za-z0-9]{1,})(?=$|[\s`"',).:\]])/g;
  for (const match of source.matchAll(pathPattern)) {
    const normalized = normalizeEvidencePath(match[1]);
    if (normalized) {
      paths.add(normalized);
    }
  }
  return [...paths].sort(naturalCompare);
}

function normalizeEvidencePath(value) {
  let normalized = String(value ?? '').trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/|\/)+/, '')
    .replace(/[.,;:)]+$/g, '');
  if (!normalized || /^[a-z]+:\/\//i.test(normalized)) {
    return null;
  }
  if (normalized.includes('..')) {
    return null;
  }
  return normalized;
}

function tokenize(text) {
  const tokens = String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  return [...new Set(tokens)];
}

function tokenizePath(evidencePath) {
  return tokenize(evidencePath.replace(/[./_-]/g, ' '));
}

function intersects(left, right) {
  const rightSet = new Set(right);
  return left.some((token) => rightSet.has(token));
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

function sha256(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

function toPosix(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/');
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  runCoverageMatrixCommand().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
}
