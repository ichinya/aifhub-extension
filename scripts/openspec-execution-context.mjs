// openspec-execution-context.mjs - OpenSpec implement/fix runtime context helpers
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  ensureRuntimeLayout,
  normalizeChangeId,
  resolveActiveChange
} from './active-change-resolver.mjs';
import {
  detectOpenSpec as defaultDetectOpenSpec,
  getOpenSpecInstructions as defaultGetOpenSpecInstructions
} from './openspec-runner.mjs';

const MODE = 'openspec-native';
const GENERATED_DIR = path.join('.ai-factory', 'rules', 'generated');
const TRACE_STATE_DIR = path.join('.ai-factory', 'state');
const INSTRUCTIONS_ARTIFACT = 'apply';
const REQUIRED_CHANGE_ARTIFACTS = ['proposal.md', 'design.md', 'tasks.md'];

export async function buildImplementationContext(options = {}) {
  const rootDir = resolveRootDir(options);
  const resolverResult = await resolveActiveChange({
    rootDir,
    cwd: options.cwd ?? process.cwd(),
    changeId: options.changeId,
    getCurrentBranch: options.getCurrentBranch
  });

  if (!resolverResult.ok) {
    return createContextFailure({
      resolverResult,
      warnings: resolverResult.warnings,
      errors: resolverResult.errors
    });
  }

  const layout = await ensureRuntimeLayout(resolverResult.changeId, {
    rootDir,
    cwd: options.cwd,
    stateDir: options.stateDir,
    qaDir: options.qaDir
  });
  const canonical = await collectCanonicalChangeArtifacts(resolverResult.changeId, { ...options, rootDir });
  const generatedRules = await collectGeneratedRules(resolverResult.changeId, { ...options, rootDir });
  const instructions = await collectOpenSpecInstructions(resolverResult.changeId, { ...options, rootDir });
  const warnings = dedupeDiagnostics([
    ...resolverResult.warnings,
    ...canonical.warnings,
    ...generatedRules.warnings,
    ...instructions.warnings
  ]);
  const errors = [
    ...canonical.errors,
    ...generatedRules.errors,
    ...instructions.errors
  ];

  return {
    ok: errors.length === 0,
    mode: MODE,
    changeId: resolverResult.changeId,
    resolver: createResolverSummary(resolverResult),
    paths: {
      change: resolverResult.changePath,
      state: layout.statePath,
      qa: layout.qaPath,
      generatedRules: path.join(rootDir, GENERATED_DIR)
    },
    canonicalArtifacts: canonical.canonicalArtifacts,
    generatedRules: generatedRules.generatedRules,
    openspecInstructions: instructions.openspecInstructions,
    warnings,
    errors
  };
}

export async function buildFixContext(options = {}) {
  const context = await buildImplementationContext(options);

  if (!context.ok) {
    return {
      ...context,
      qaEvidence: []
    };
  }

  const qa = await collectQaEvidence(context.changeId, {
    ...options,
    rootDir: resolveRootDir(options),
    qaDir: context.paths.qa
  });
  const missingQa = qa.qaEvidence.length === 0;
  const warnings = dedupeDiagnostics([
    ...context.warnings,
    ...qa.warnings,
    ...(missingQa ? [missingQaEvidenceDiagnostic()] : [])
  ]);
  const errors = [
    ...context.errors,
    ...qa.errors,
    ...(missingQa && options.requireQaEvidence ? [missingQaEvidenceDiagnostic()] : [])
  ];

  return {
    ...context,
    ok: errors.length === 0,
    qaEvidence: qa.qaEvidence,
    warnings,
    errors
  };
}

export async function collectCanonicalChangeArtifacts(changeId, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return {
      ok: false,
      changeId: null,
      canonicalArtifacts: {},
      warnings: [],
      errors: [normalized.error]
    };
  }

  const resolvedChangeId = normalized.changeId;
  const changeDir = path.join(rootDir, 'openspec', 'changes', resolvedChangeId);
  const artifacts = {};
  const warnings = [];

  for (const fileName of REQUIRED_CHANGE_ARTIFACTS) {
    const artifact = await readOptionalTextFile(rootDir, path.join(changeDir, fileName));
    artifacts[artifactKey(fileName)] = artifact;

    if (!artifact.exists) {
      warnings.push({
        code: 'missing-canonical-artifact',
        message: `Canonical OpenSpec artifact is missing: ${artifact.path}`,
        path: artifact.path
      });
    }
  }

  const baseSpecs = await collectTextFiles(rootDir, path.join(rootDir, 'openspec', 'specs'), isSpecMarkdown);
  const deltaSpecs = await collectTextFiles(rootDir, path.join(changeDir, 'specs'), isSpecMarkdown);

  return {
    ok: true,
    changeId: resolvedChangeId,
    canonicalArtifacts: {
      proposal: artifacts.proposal,
      design: artifacts.design,
      tasks: artifacts.tasks,
      baseSpecs,
      deltaSpecs
    },
    warnings,
    errors: []
  };
}

export async function collectGeneratedRules(changeId, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return {
      ok: false,
      changeId: null,
      generatedRules: [],
      warnings: [],
      errors: [normalized.error]
    };
  }

  const resolvedChangeId = normalized.changeId;
  const generatedDir = path.join(rootDir, GENERATED_DIR);
  const fingerprints = await collectCurrentSpecFingerprints(rootDir, resolvedChangeId);
  const expected = [
    {
      kind: 'merged',
      fileName: `openspec-merged-${resolvedChangeId}.md`,
      expectedFingerprints: new Map([...fingerprints.base, ...fingerprints.delta])
    },
    {
      kind: 'change',
      fileName: `openspec-change-${resolvedChangeId}.md`,
      expectedFingerprints: fingerprints.delta
    },
    {
      kind: 'base',
      fileName: 'openspec-base.md',
      expectedFingerprints: fingerprints.base
    }
  ];
  const generatedRules = [];
  const warnings = [];

  for (const expectedFile of expected) {
    const filePath = path.join(generatedDir, expectedFile.fileName);
    const item = await readOptionalTextFile(rootDir, filePath);
    const stale = item.exists
      ? determineStaleness(item.content, expectedFile.expectedFingerprints)
      : null;

    generatedRules.push({
      kind: expectedFile.kind,
      path: item.path,
      exists: item.exists,
      stale,
      content: item.content
    });

    if (!item.exists) {
      warnings.push({
        code: 'missing-generated-rules',
        message: `Generated OpenSpec rules are missing: ${item.path}`,
        path: item.path
      });
      continue;
    }

    if (stale === true) {
      warnings.push({
        code: 'stale-generated-rules',
        message: `Generated OpenSpec rules are stale: ${item.path}`,
        path: item.path
      });
    }
  }

  return {
    ok: true,
    changeId: resolvedChangeId,
    generatedRules,
    warnings: dedupeDiagnostics(warnings),
    errors: []
  };
}

export async function collectQaEvidence(changeId, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return {
      ok: false,
      changeId: null,
      qaEvidence: [],
      warnings: [],
      errors: [normalized.error]
    };
  }

  const qaDir = options.qaDir !== undefined
    ? path.resolve(options.qaDir)
    : path.join(rootDir, '.ai-factory', 'qa', normalized.changeId);
  const qaEvidence = await collectTextFiles(rootDir, qaDir, () => true);

  return {
    ok: true,
    changeId: normalized.changeId,
    qaEvidence,
    warnings: [],
    errors: []
  };
}

export async function writeExecutionTrace(changeId, trace, options = {}) {
  return writeTrace({
    changeId,
    trace,
    options,
    type: 'Implementation',
    directoryName: 'implementation'
  });
}

export async function writeFixTrace(changeId, trace, options = {}) {
  return writeTrace({
    changeId,
    trace,
    options,
    type: 'Fix',
    directoryName: 'fixes'
  });
}

async function collectOpenSpecInstructions(changeId, options) {
  const detectOpenSpec = options.detectOpenSpec ?? defaultDetectOpenSpec;
  const getOpenSpecInstructions = options.getOpenSpecInstructions ?? defaultGetOpenSpecInstructions;
  const runOptions = createOpenSpecRunOptions(options);
  const unavailable = (detail) => ({
    openspecInstructions: createUnavailableInstructions(detail),
    warnings: [
      {
        code: 'openspec-instructions-unavailable',
        message: 'OpenSpec apply instructions were unavailable; continuing with filesystem artifacts.',
        detail
      }
    ],
    errors: []
  });

  let detection;

  try {
    detection = await detectOpenSpec(runOptions);
  } catch (err) {
    return unavailable(err?.message ?? 'OpenSpec detection failed.');
  }

  if (!detection?.available || !detection?.canValidate) {
    return unavailable(detection?.errors?.[0]?.message ?? detection?.reason ?? 'OpenSpec CLI is unavailable or unsupported.');
  }

  let instructions;

  try {
    instructions = await getOpenSpecInstructions(INSTRUCTIONS_ARTIFACT, {
      ...runOptions,
      change: changeId
    });
  } catch (err) {
    return unavailable(err?.message ?? 'OpenSpec instructions command failed.');
  }

  if (!instructions?.ok) {
    return unavailable(instructions?.error?.message ?? 'OpenSpec instructions command failed.');
  }

  return {
    openspecInstructions: {
      available: true,
      artifact: INSTRUCTIONS_ARTIFACT,
      json: instructions.json ?? null,
      stdout: instructions.stdout ?? '',
      stderr: instructions.stderr ?? '',
      raw: instructions
    },
    warnings: [],
    errors: []
  };
}

async function writeTrace({ changeId, trace, options, type, directoryName }) {
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }

  const runId = normalizeRunId(options.runId ?? createDefaultRunId(options));
  const rootDir = resolveRootDir(options);
  assertCanonicalTraceStateDir(rootDir, options.stateDir);

  const statePath = path.join(rootDir, TRACE_STATE_DIR, normalized.changeId);
  const outputDir = path.join(statePath, directoryName);
  const targetPath = path.resolve(outputDir, `${runId}.md`);

  if (!isWithinDirectory(targetPath, outputDir) || !isWithinDirectory(targetPath, statePath)) {
    throw new Error(`Trace output path escapes runtime state: ${targetPath}`);
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(targetPath, renderTraceMarkdown({
    changeId: normalized.changeId,
    trace,
    type
  }), 'utf8');

  return {
    ok: true,
    changeId: normalized.changeId,
    runId,
    path: targetPath,
    relativePath: toPosix(path.relative(rootDir, targetPath)),
    warnings: [],
    errors: []
  };
}

function assertCanonicalTraceStateDir(rootDir, stateDir) {
  if (stateDir === undefined || stateDir === null) {
    return;
  }

  const canonicalStateDir = path.join(rootDir, TRACE_STATE_DIR);
  const requestedStateDir = path.resolve(rootDir, stateDir);

  if (!samePath(requestedStateDir, canonicalStateDir)) {
    throw new Error(`Trace stateDir must resolve to canonical runtime state directory: ${toPosix(TRACE_STATE_DIR)}.`);
  }
}

function renderTraceMarkdown({ changeId, trace, type }) {
  const nextStep = trace?.nextStep ?? `/aif-verify ${changeId}`;
  const lines = [
    `# ${type} Trace: ${changeId}`,
    '',
    '## Summary',
    '',
    normalizeTraceText(trace?.summary, 'No summary provided.'),
    '',
    '## Canonical artifacts read',
    '',
    ...renderList(trace?.canonicalArtifactsRead),
    '',
    '## Generated rules read',
    '',
    ...renderList(trace?.generatedRulesRead),
    '',
    '## Changed files',
    '',
    ...renderList(trace?.changedFiles),
    '',
    '## Next step',
    '',
    nextStep,
    ''
  ];

  return lines.join('\n');
}

function renderList(values) {
  const items = Array.isArray(values) ? values.filter((value) => String(value).trim().length > 0) : [];

  if (items.length === 0) {
    return ['- none'];
  }

  return items.map((item) => `- ${item}`);
}

function normalizeTraceText(value, fallback) {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : fallback;
}

function normalizeRunId(input) {
  if (typeof input !== 'string') {
    throw new Error(`Invalid OpenSpec run id: ${JSON.stringify(input)}.`);
  }

  const runId = input.trim();

  if (
    runId.length === 0
    || path.isAbsolute(runId)
    || runId.includes('/')
    || runId.includes('\\')
    || runId === '..'
    || runId.includes('..')
    || !/^[A-Za-z0-9._-]+$/.test(runId)
  ) {
    throw new Error(`Invalid OpenSpec run id: ${JSON.stringify(input)}.`);
  }

  return runId;
}

function createDefaultRunId(options = {}) {
  const date = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  return `run-${date.toISOString().replace(/[:.]/g, '-')}`;
}

async function collectCurrentSpecFingerprints(rootDir, changeId) {
  const baseFiles = await collectTextFiles(rootDir, path.join(rootDir, 'openspec', 'specs'), isSpecMarkdown);
  const deltaFiles = await collectTextFiles(
    rootDir,
    path.join(rootDir, 'openspec', 'changes', changeId, 'specs'),
    isSpecMarkdown
  );

  return {
    base: fingerprintMap(baseFiles),
    delta: fingerprintMap(deltaFiles)
  };
}

function fingerprintMap(files) {
  return new Map(files.map((file) => [
    file.path,
    createFingerprint(file.content)
  ]));
}

function createFingerprint(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function determineStaleness(content, expectedFingerprints) {
  const actualFingerprints = parseSourceFingerprints(content);

  if (actualFingerprints.size === 0 && expectedFingerprints.size === 0) {
    return false;
  }

  if (actualFingerprints.size === 0) {
    return null;
  }

  if (actualFingerprints.size !== expectedFingerprints.size) {
    return true;
  }

  for (const [relativePath, fingerprint] of expectedFingerprints) {
    if (actualFingerprints.get(relativePath) !== fingerprint) {
      return true;
    }
  }

  for (const relativePath of actualFingerprints.keys()) {
    if (!expectedFingerprints.has(relativePath)) {
      return true;
    }
  }

  return false;
}

function parseSourceFingerprints(content) {
  const fingerprints = new Map();
  const pattern = /^-\s+(sha256:\S+)\s+(.+?)\s*$/gm;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    fingerprints.set(toPosix(match[2].trim()), match[1].trim());
  }

  return fingerprints;
}

async function collectTextFiles(rootDir, directoryPath, predicate) {
  if (!await isDirectory(directoryPath)) {
    return [];
  }

  const filePaths = [];
  await collectFilePaths(directoryPath, filePaths, predicate);

  const sorted = filePaths.sort((left, right) => toPosix(path.relative(rootDir, left)).localeCompare(toPosix(path.relative(rootDir, right))));
  const result = [];

  for (const filePath of sorted) {
    const content = await readFile(filePath, 'utf8');
    result.push({
      path: toPosix(path.relative(rootDir, filePath)),
      content
    });
  }

  return result;
}

async function collectFilePaths(directoryPath, filePaths, predicate) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of sortedEntries) {
    const childPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      await collectFilePaths(childPath, filePaths, predicate);
      continue;
    }

    if (entry.isFile() && predicate(childPath)) {
      filePaths.push(childPath);
    }
  }
}

async function readOptionalTextFile(rootDir, filePath) {
  const relativePath = toPosix(path.relative(rootDir, filePath));

  try {
    return {
      path: relativePath,
      exists: true,
      content: await readFile(filePath, 'utf8')
    };
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }

    return {
      path: relativePath,
      exists: false,
      content: ''
    };
  }
}

function createContextFailure({ resolverResult, warnings = [], errors = [] }) {
  return {
    ok: false,
    mode: MODE,
    changeId: null,
    resolver: createResolverSummary(resolverResult),
    paths: {},
    canonicalArtifacts: {},
    generatedRules: [],
    openspecInstructions: createUnavailableInstructions(null),
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

function createUnavailableInstructions(detail) {
  return {
    available: false,
    artifact: INSTRUCTIONS_ARTIFACT,
    json: null,
    stdout: '',
    stderr: '',
    raw: null,
    detail
  };
}

function missingQaEvidenceDiagnostic() {
  return {
    code: 'missing-qa-evidence',
    message: 'No QA evidence was found for this change. Run /aif-verify before /aif-fix when possible.'
  };
}

function createOpenSpecRunOptions(options) {
  return {
    cwd: options.rootDir,
    command: options.command,
    env: options.env,
    executor: options.executor,
    nodeVersion: options.nodeVersion
  };
}

function artifactKey(fileName) {
  return path.basename(fileName, path.extname(fileName));
}

function isSpecMarkdown(filePath) {
  return path.basename(filePath) === 'spec.md';
}

async function isDirectory(targetPath) {
  try {
    const item = await stat(targetPath);
    return item.isDirectory();
  } catch {
    return false;
  }
}

function isWithinDirectory(targetPath, directoryPath) {
  const relative = path.relative(directoryPath, targetPath);
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);

  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function resolveRootDir(options = {}) {
  return path.resolve(options.rootDir ?? process.cwd());
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
