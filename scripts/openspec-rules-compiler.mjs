// openspec-rules-compiler.mjs - derive AI Factory rule guidance from OpenSpec specs
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { detectOpenSpec as defaultDetectOpenSpec, showOpenSpecItem as defaultShowOpenSpecItem } from './openspec-runner.mjs';
import { normalizeChangeId, resolveActiveChange } from './active-change-resolver.mjs';

const GENERATED_DIR = path.join('.ai-factory', 'rules', 'generated');
const BASE_FILE = 'openspec-base.md';
const SECTION_ORDER = new Map([
  ['Requirements', 0],
  ['ADDED Requirements', 1],
  ['MODIFIED Requirements', 2],
  ['REMOVED Requirements', 3]
]);

export async function compileOpenSpecRules(changeId, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const resolverResult = await resolveActiveChange({
    rootDir,
    cwd: options.cwd ?? process.cwd(),
    changeId,
    getCurrentBranch: options.getCurrentBranch
  });

  if (!resolverResult.ok) {
    return createCompilerResult({
      ok: false,
      warnings: resolverResult.warnings,
      errors: resolverResult.errors
    });
  }

  const collected = await collectOpenSpecRuleSources(resolverResult.changeId, {
    ...options,
    rootDir
  });

  if (!collected.ok) {
    return createCompilerResult({
      ok: false,
      changeId: resolverResult.changeId,
      mode: collected.mode,
      warnings: [...resolverResult.warnings, ...collected.warnings],
      errors: collected.errors,
      sources: collected.sources
    });
  }

  const rendered = renderGeneratedRules(collected.sources, {
    ...options,
    changeId: resolverResult.changeId
  });
  const written = await writeGeneratedRules(resolverResult.changeId, rendered, {
    ...options,
    rootDir
  });

  if (!written.ok) {
    return createCompilerResult({
      ok: false,
      changeId: resolverResult.changeId,
      mode: collected.mode,
      warnings: [...resolverResult.warnings, ...collected.warnings, ...rendered.warnings, ...written.warnings],
      errors: written.errors,
      sources: collected.sources,
      files: written.files
    });
  }

  return createCompilerResult({
    ok: true,
    changeId: resolverResult.changeId,
    mode: collected.mode,
    warnings: [...resolverResult.warnings, ...collected.warnings, ...rendered.warnings, ...written.warnings],
    errors: [],
    sources: collected.sources,
    files: written.files
  });
}

export async function collectOpenSpecRuleSources(changeId, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return createSourceResult({
      ok: false,
      errors: [normalized.error]
    });
  }

  const resolvedChangeId = normalized.changeId;
  const changeDir = path.join(rootDir, 'openspec', 'changes', resolvedChangeId);

  if (!await isDirectory(changeDir)) {
    return createSourceResult({
      ok: false,
      errors: [
        {
          code: 'explicit-change-not-found',
          message: `OpenSpec change '${resolvedChangeId}' was not found.`
        }
      ]
    });
  }

  const warnings = [];
  const cli = await detectOpenSpecCapability(rootDir, options);
  warnings.push(...cli.warnings);

  const baseSpecsDir = path.join(rootDir, 'openspec', 'specs');
  const changeSpecsDir = path.join(changeDir, 'specs');
  const baseFiles = await collectSpecFiles(baseSpecsDir);
  const changeFiles = await collectSpecFiles(changeSpecsDir);
  const sources = [];

  for (const filePath of baseFiles) {
    const source = await readRuleSource(filePath, {
      rootDir,
      kind: 'base',
      specsDir: baseSpecsDir,
      changeId: null,
      cli
    });
    warnings.push(...source.warnings);
    sources.push(source.item);
  }

  for (const filePath of changeFiles) {
    const source = await readRuleSource(filePath, {
      rootDir,
      kind: 'change',
      specsDir: changeSpecsDir,
      changeId: resolvedChangeId,
      cli
    });
    warnings.push(...source.warnings);
    sources.push(source.item);
  }

  const mode = chooseMode(sources, cli);

  return createSourceResult({
    ok: true,
    mode,
    warnings: dedupeDiagnostics(warnings),
    sources: sortSources(sources)
  });
}

export async function compileOpenSpecBaseRules(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const collected = await collectOpenSpecBaseRuleSources({
    ...options,
    rootDir
  });

  if (!collected.ok) {
    return createCompilerResult({
      ok: false,
      changeId: null,
      mode: collected.mode,
      warnings: collected.warnings,
      errors: collected.errors,
      sources: collected.sources
    });
  }

  const rendered = renderDocument({
    kind: 'base',
    title: 'Base OpenSpec Rules',
    changeId: null,
    sources: sortSources(collected.sources),
    emptyMessage: 'No base OpenSpec requirements found.'
  });
  const written = await writeGeneratedBaseRules(rendered, {
    ...options,
    rootDir
  });

  if (!written.ok) {
    return createCompilerResult({
      ok: false,
      changeId: null,
      mode: collected.mode,
      warnings: [...collected.warnings, ...written.warnings],
      errors: written.errors,
      sources: collected.sources,
      files: written.files
    });
  }

  return createCompilerResult({
    ok: true,
    changeId: null,
    mode: collected.mode,
    warnings: [...collected.warnings, ...written.warnings],
    errors: [],
    sources: collected.sources,
    files: written.files
  });
}

async function collectOpenSpecBaseRuleSources(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const warnings = [];
  const cli = await detectOpenSpecCapability(rootDir, options);
  warnings.push(...cli.warnings);

  const baseSpecsDir = path.join(rootDir, 'openspec', 'specs');
  const baseFiles = await collectSpecFiles(baseSpecsDir);
  const sources = [];

  for (const filePath of baseFiles) {
    const source = await readRuleSource(filePath, {
      rootDir,
      kind: 'base',
      specsDir: baseSpecsDir,
      changeId: null,
      cli
    });
    warnings.push(...source.warnings);
    sources.push(source.item);
  }

  return createSourceResult({
    ok: true,
    mode: chooseMode(sources, cli),
    warnings: dedupeDiagnostics(warnings),
    sources: sortSources(sources)
  });
}

export function renderGeneratedRules(sources, options = {}) {
  const normalized = normalizeChangeId(options.changeId);
  const changeId = normalized.ok ? normalized.changeId : options.changeId;
  const sortedSources = sortSources(Array.from(sources ?? []));
  const baseSources = sortedSources.filter((source) => source.kind === 'base');
  const changeSources = sortedSources.filter((source) => source.kind === 'change');
  const baseContent = renderDocument({
    kind: 'base',
    title: 'Base OpenSpec Rules',
    changeId,
    sources: baseSources,
    emptyMessage: 'No base OpenSpec requirements found.'
  });
  const changeContent = renderDocument({
    kind: 'change',
    title: 'Change OpenSpec Rules',
    changeId,
    sources: changeSources,
    emptyMessage: 'No OpenSpec change requirements found.'
  });
  const mergedContent = renderDocument({
    kind: 'merged',
    title: 'Merged OpenSpec Rules',
    changeId,
    sources: sortedSources,
    emptyMessage: 'No OpenSpec requirements found.'
  });

  return {
    ok: true,
    changeId,
    warnings: [],
    files: [
      {
        kind: 'base',
        fileName: BASE_FILE,
        content: baseContent
      },
      {
        kind: 'change',
        fileName: `openspec-change-${changeId}.md`,
        content: changeContent
      },
      {
        kind: 'merged',
        fileName: `openspec-merged-${changeId}.md`,
        content: mergedContent
      }
    ]
  };
}

export async function writeGeneratedRules(changeId, rendered, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return createWriteResult({
      ok: false,
      errors: [normalized.error]
    });
  }

  const generatedDir = path.resolve(rootDir, GENERATED_DIR);
  const renderedFiles = Array.from(rendered?.files ?? []);
  const expectedNames = new Set([
    BASE_FILE,
    `openspec-change-${normalized.changeId}.md`,
    `openspec-merged-${normalized.changeId}.md`
  ]);
  const renderedNames = renderedFiles.map((file) => file.fileName);
  const renderedNameSet = new Set(renderedNames);
  const files = [];

  if (
    renderedFiles.length !== expectedNames.size
    || renderedNameSet.size !== expectedNames.size
    || renderedNames.some((fileName) => !expectedNames.has(fileName))
  ) {
    return createWriteResult({
      ok: false,
      errors: [
        {
          code: 'invalid-rendered-files',
          message: 'Rendered rules must contain exactly the base, change, and merged generated files.'
        }
      ]
    });
  }

  await mkdir(generatedDir, { recursive: true });

  for (const renderedFile of renderedFiles) {
    const targetPath = path.resolve(generatedDir, renderedFile.fileName);

    if (!isWithinDirectory(targetPath, generatedDir)) {
      return createWriteResult({
        ok: false,
        files,
        errors: [
          {
            code: 'unsafe-generated-path',
            message: `Generated output path escapes '${GENERATED_DIR}': ${renderedFile.fileName}`
          }
        ]
      });
    }

    await writeFile(targetPath, renderedFile.content, 'utf8');
    files.push({
      kind: renderedFile.kind,
      path: targetPath,
      relativePath: toPosix(path.relative(rootDir, targetPath)),
      written: true
    });
  }

  return createWriteResult({
    ok: true,
    files
  });
}

async function writeGeneratedBaseRules(content, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const generatedDir = path.resolve(rootDir, GENERATED_DIR);
  const targetPath = path.resolve(generatedDir, BASE_FILE);
  const relativePath = toPosix(path.relative(rootDir, targetPath));

  if (!isWithinDirectory(targetPath, generatedDir)) {
    return createWriteResult({
      errors: [
        {
          code: 'unsafe-generated-path',
          message: `Generated output path escapes '${GENERATED_DIR}': ${BASE_FILE}`
        }
      ]
    });
  }

  if (options.dryRun) {
    return createWriteResult({
      ok: true,
      files: [
        {
          kind: 'base',
          path: targetPath,
          relativePath,
          written: false
        }
      ]
    });
  }

  await mkdir(generatedDir, { recursive: true });
  await writeFile(targetPath, content, 'utf8');

  return createWriteResult({
    ok: true,
    files: [
      {
        kind: 'base',
        path: targetPath,
        relativePath,
        written: true
      }
    ]
  });
}

export function parseSpecMarkdownFallback(markdown, options = {}) {
  const warnings = [];
  const requirements = [];
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  let currentSection = 'Requirements';
  let currentRequirement = null;
  let currentScenario = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const sectionMatch = line.match(/^#{2,6}\s+((?:ADDED|MODIFIED|REMOVED)\s+Requirements|Requirements)\s*$/i);
    const requirementMatch = line.match(/^#{3,6}\s+Requirement:\s*(.+?)\s*$/i);
    const scenarioMatch = line.match(/^#{4,6}\s+Scenario:\s*(.+?)\s*$/i);

    if (sectionMatch) {
      currentSection = canonicalSection(sectionMatch[1]);
      currentScenario = null;
      continue;
    }

    if (requirementMatch) {
      if (currentRequirement !== null) {
        requirements.push(finalizeRequirement(currentRequirement));
      }

      currentRequirement = {
        title: requirementMatch[1].trim(),
        section: currentSection,
        bodyLines: [],
        scenarios: []
      };
      currentScenario = null;
      continue;
    }

    if (scenarioMatch) {
      if (currentRequirement === null) {
        warnings.push({
          code: 'scenario-without-requirement',
          message: `Scenario '${scenarioMatch[1].trim()}' has no preceding requirement.`
        });
        continue;
      }

      currentScenario = {
        title: scenarioMatch[1].trim(),
        steps: []
      };
      currentRequirement.scenarios.push(currentScenario);
      continue;
    }

    if (currentScenario !== null) {
      const step = normalizeMarkdownLine(line);

      if (step.length > 0) {
        currentScenario.steps.push(step);
      }
      continue;
    }

    if (currentRequirement !== null) {
      const bodyLine = line.trim();

      if (bodyLine.length > 0) {
        currentRequirement.bodyLines.push(bodyLine);
      }
    }
  }

  if (currentRequirement !== null) {
    requirements.push(finalizeRequirement(currentRequirement));
  }

  if (requirements.length === 0 && String(markdown ?? '').trim().length > 0) {
    warnings.push({
      code: 'no-requirements-found',
      message: 'No OpenSpec requirements were parsed from markdown fallback input.'
    });
  }

  return {
    requirements: sortRequirements(requirements),
    warnings,
    source: options.source ?? null
  };
}

export function extractRequirementsFromShowJson(json, options = {}) {
  const warnings = [];
  const requirements = [];
  const seen = new Set();

  visitJsonNode(json, {
    section: options.section ?? 'Requirements',
    requirements,
    warnings,
    seen
  });

  return {
    requirements: sortRequirements(requirements),
    warnings
  };
}

async function detectOpenSpecCapability(rootDir, options) {
  const detectOpenSpec = options.detectOpenSpec ?? defaultDetectOpenSpec;
  const showOpenSpecItem = options.showOpenSpecItem ?? defaultShowOpenSpecItem;

  try {
    const detection = await detectOpenSpec({
      cwd: rootDir,
      env: options.env,
      executor: options.executor,
      nodeVersion: options.nodeVersion
    });
    const warnings = [];

    if (!detection.available || !detection.canValidate) {
      warnings.push(...normalizeDetectionWarnings(detection));
    }

    return {
      detection,
      showOpenSpecItem,
      available: Boolean(detection.available && detection.canValidate),
      runOptions: {
        command: options.command,
        env: options.env,
        executor: options.executor
      },
      warnings
    };
  } catch (err) {
    return {
      detection: null,
      showOpenSpecItem,
      available: false,
      runOptions: {
        command: options.command,
        env: options.env,
        executor: options.executor
      },
      warnings: [
        {
          code: 'openspec-detection-failed',
          message: 'OpenSpec CLI detection failed; using filesystem fallback.',
          detail: err?.message ?? 'Unknown detection error.'
        }
      ]
    };
  }
}

async function readRuleSource(filePath, context) {
  const content = await readFile(filePath, 'utf8');
  const relativePath = toPosix(path.relative(context.rootDir, filePath));
  const capability = toPosix(path.relative(context.specsDir, path.dirname(filePath)));
  const warnings = [];
  let parseResult = null;
  let extractionMode = 'filesystem-fallback';

  if (context.cli.available) {
    const cliResult = await tryReadRequirementsFromCli(capability, context);
    warnings.push(...cliResult.warnings);

    if (cliResult.requirements.length > 0) {
      parseResult = cliResult;
      extractionMode = 'cli-json';
    }
  }

  if (parseResult === null) {
    parseResult = parseSpecMarkdownFallback(content, { source: relativePath });
    warnings.push(...parseResult.warnings.map((warning) => ({
      ...warning,
      path: relativePath
    })));
  }

  const fingerprint = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const requirements = parseResult.requirements.map((requirement) => ({
    ...requirement,
    kind: context.kind,
    changeId: context.kind === 'change' ? context.changeId : null,
    capability,
    relativePath,
    fingerprint
  }));

  return {
    item: {
      kind: context.kind,
      changeId: context.kind === 'change' ? context.changeId : null,
      capability,
      relativePath,
      path: filePath,
      fingerprint,
      mode: extractionMode,
      requirements
    },
    warnings
  };
}

async function tryReadRequirementsFromCli(capability, context) {
  try {
    const result = await context.cli.showOpenSpecItem(capability, {
      ...context.cli.runOptions,
      cwd: context.rootDir,
      type: 'spec',
      deltasOnly: context.kind === 'change'
    });

    if (!result.ok) {
      return {
        requirements: [],
        warnings: [
          {
            code: 'cli-json-unavailable',
            message: `OpenSpec CLI JSON was unavailable for '${capability}'; using filesystem fallback.`,
            detail: result.error?.message ?? null
          }
        ]
      };
    }

    const extracted = extractRequirementsFromShowJson(result.json);

    if (extracted.requirements.length === 0) {
      return {
        requirements: [],
        warnings: [
          {
            code: 'cli-json-empty',
            message: `OpenSpec CLI JSON for '${capability}' did not contain requirements; using filesystem fallback.`
          },
          ...extracted.warnings
        ]
      };
    }

    return extracted;
  } catch (err) {
    return {
      requirements: [],
      warnings: [
        {
          code: 'cli-json-error',
          message: `OpenSpec CLI JSON extraction failed for '${capability}'; using filesystem fallback.`,
          detail: err?.message ?? 'Unknown CLI JSON extraction error.'
        }
      ]
    };
  }
}

async function collectSpecFiles(rootDir) {
  if (!await isDirectory(rootDir)) {
    return [];
  }

  const files = [];
  await collectSpecFilesRecursive(rootDir, files);
  return files.sort((left, right) => toPosix(left).localeCompare(toPosix(right)));
}

async function collectSpecFilesRecursive(dirPath, files) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of sortedEntries) {
    const childPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await collectSpecFilesRecursive(childPath, files);
      continue;
    }

    if (entry.isFile() && entry.name === 'spec.md') {
      files.push(childPath);
    }
  }
}

function renderDocument({ kind, title, changeId, sources, emptyMessage }) {
  const lines = [
    '# Generated OpenSpec Rules',
    '',
    `View: ${title}`,
    'Source of truth: OpenSpec canonical specs',
    'Generated files are derived guidance and are safe to delete, overwrite, and regenerate.'
  ];

  if (kind !== 'base') {
    lines.push(`Change: ${changeId}`);
  }

  lines.push('', '## Source Fingerprints');

  if (sources.length === 0) {
    lines.push('', emptyMessage, '');
    return `${lines.join('\n')}\n`;
  }

  for (const source of sources) {
    lines.push(`- ${source.fingerprint} ${source.relativePath}`);
  }

  const requirements = flattenRequirements(sources);

  if (requirements.length === 0) {
    lines.push('', emptyMessage, '');
    return `${lines.join('\n')}\n`;
  }

  let previousSection = null;

  for (const requirement of requirements) {
    if (requirement.section !== previousSection) {
      lines.push('', `## ${requirement.section}`);
      previousSection = requirement.section;
    }

    lines.push('', `### Requirement: ${requirement.title}`, '');
    lines.push('Source:');
    lines.push(`- Kind: ${requirement.kind}`);
    lines.push(`- Path: ${requirement.relativePath}`);
    lines.push(`- Capability: ${requirement.capability}`);
    lines.push(`- Change: ${requirement.changeId ?? 'none'}`);
    lines.push(`- Section: ${requirement.section}`);
    lines.push(`- Fingerprint: ${requirement.fingerprint}`);

    if (requirement.body.length > 0) {
      lines.push('', ...requirement.body);
    }

    for (const scenario of requirement.scenarios) {
      lines.push('', `#### Scenario: ${scenario.title}`);

      for (const step of scenario.steps) {
        lines.push(`- ${step}`);
      }
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function flattenRequirements(sources) {
  return sources
    .flatMap((source) => source.requirements)
    .sort(compareRequirements);
}

function sortSources(sources) {
  return Array.from(sources).sort((left, right) => {
    const kindComparison = compareKind(left.kind, right.kind);

    if (kindComparison !== 0) {
      return kindComparison;
    }

    return left.capability.localeCompare(right.capability)
      || left.relativePath.localeCompare(right.relativePath);
  });
}

function sortRequirements(requirements) {
  return Array.from(requirements).sort(compareRequirements);
}

function compareRequirements(left, right) {
  return compareKind(left.kind, right.kind)
    || left.capability.localeCompare(right.capability)
    || sectionRank(left.section) - sectionRank(right.section)
    || left.title.localeCompare(right.title)
    || firstScenarioTitle(left).localeCompare(firstScenarioTitle(right));
}

function compareKind(left, right) {
  return kindRank(left) - kindRank(right);
}

function kindRank(kind) {
  return kind === 'base' ? 0 : 1;
}

function sectionRank(section) {
  return SECTION_ORDER.get(section) ?? 99;
}

function firstScenarioTitle(requirement) {
  return requirement.scenarios[0]?.title ?? '';
}

function canonicalSection(section) {
  const normalized = String(section ?? '').trim().replace(/\s+/g, ' ');
  const lower = normalized.toLowerCase();

  if (lower === 'added requirements') {
    return 'ADDED Requirements';
  }

  if (lower === 'modified requirements') {
    return 'MODIFIED Requirements';
  }

  if (lower === 'removed requirements') {
    return 'REMOVED Requirements';
  }

  return 'Requirements';
}

function finalizeRequirement(requirement) {
  return {
    title: requirement.title,
    section: requirement.section,
    body: requirement.bodyLines,
    scenarios: requirement.scenarios.map((scenario) => ({
      title: scenario.title,
      steps: scenario.steps
    })),
    kind: requirement.kind ?? 'base',
    changeId: requirement.changeId ?? null,
    capability: requirement.capability ?? '',
    relativePath: requirement.relativePath ?? '',
    fingerprint: requirement.fingerprint ?? ''
  };
}

function normalizeMarkdownLine(line) {
  return line.trim().replace(/^[-*]\s+/, '').trim();
}

function visitJsonNode(node, state) {
  if (node === null || node === undefined) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      visitJsonNode(item, state);
    }
    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  const section = inferJsonSection(node, state.section);

  if (looksLikeRequirement(node)) {
    const requirement = normalizeJsonRequirement(node, section);
    const key = `${requirement.section}:${requirement.title}`;

    if (!state.seen.has(key)) {
      state.seen.add(key);
      state.requirements.push(requirement);
    }
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'requirements' || key === 'reqs') {
      visitJsonRequirementsCollection(value, {
        ...state,
        section
      });
      continue;
    }

    if (/^(added|modified|removed)$/i.test(key)) {
      visitJsonRequirementsCollection(value, {
        ...state,
        section: canonicalSection(`${key.toUpperCase()} Requirements`)
      });
      continue;
    }

    if (/^(added|modified|removed)\s*Requirements$/i.test(key)) {
      visitJsonRequirementsCollection(value, {
        ...state,
        section: canonicalSection(key)
      });
      continue;
    }

    if (typeof value === 'object') {
      visitJsonNode(value, {
        ...state,
        section
      });
    }
  }
}

function visitJsonRequirementsCollection(value, state) {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitJsonNode(item, state);
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const [title, item] of Object.entries(value)) {
      if (item !== null && typeof item === 'object') {
        visitJsonNode({
          title,
          ...item
        }, state);
      }
    }
  }
}

function looksLikeRequirement(node) {
  return typeof (node.title ?? node.name ?? node.requirement) === 'string'
    && (
      node.description !== undefined
      || node.text !== undefined
      || node.body !== undefined
      || node.scenarios !== undefined
      || node.scenario !== undefined
    );
}

function normalizeJsonRequirement(node, section) {
  const title = String(node.title ?? node.name ?? node.requirement).trim();
  const body = normalizeBody(node.description ?? node.text ?? node.body);
  const scenarios = normalizeJsonScenarios(node.scenarios ?? node.scenario);

  return {
    title,
    section,
    body,
    scenarios,
    kind: 'base',
    changeId: null,
    capability: '',
    relativePath: '',
    fingerprint: ''
  };
}

function normalizeJsonScenarios(input) {
  if (input === undefined || input === null) {
    return [];
  }

  const values = Array.isArray(input) ? input : [input];
  return values.map((scenario, index) => {
    if (typeof scenario === 'string') {
      return {
        title: `Scenario ${index + 1}`,
        steps: normalizeBody(scenario)
      };
    }

    const title = String(scenario.title ?? scenario.name ?? `Scenario ${index + 1}`).trim();
    const steps = normalizeJsonScenarioSteps(scenario);

    return {
      title,
      steps
    };
  });
}

function normalizeJsonScenarioSteps(scenario) {
  const fields = [
    scenario.steps,
    scenario.given,
    scenario.when,
    scenario.then,
    scenario.description,
    scenario.body
  ];

  return fields.flatMap((field) => normalizeBody(field));
}

function normalizeBody(input) {
  if (input === undefined || input === null) {
    return [];
  }

  if (Array.isArray(input)) {
    return input.flatMap((item) => normalizeBody(item));
  }

  return String(input)
    .split(/\r?\n/)
    .map(normalizeMarkdownLine)
    .filter((line) => line.length > 0);
}

function inferJsonSection(node, fallback) {
  const candidate = node.section ?? node.type ?? node.kind ?? fallback;
  return canonicalSection(String(candidate).includes('Requirements') ? candidate : fallback);
}

function chooseMode(sources, cli) {
  if (!cli.available) {
    return 'filesystem-fallback';
  }

  const modes = new Set(sources.map((source) => source.mode));

  if (modes.size === 1 && modes.has('cli-json')) {
    return 'cli-json';
  }

  if (modes.has('cli-json')) {
    return 'mixed';
  }

  return 'filesystem-fallback';
}

function normalizeDetectionWarnings(detection) {
  if (Array.isArray(detection.errors) && detection.errors.length > 0) {
    return detection.errors.map((error) => ({
      code: error.code ?? detection.reason ?? 'openspec-unavailable',
      message: error.message ?? 'OpenSpec CLI is unavailable; using filesystem fallback.'
    }));
  }

  return [
    {
      code: detection.reason ?? 'openspec-unavailable',
      message: 'OpenSpec CLI is unavailable or unsupported; using filesystem fallback.'
    }
  ];
}

function createCompilerResult(overrides = {}) {
  return {
    ok: overrides.ok ?? false,
    changeId: overrides.changeId ?? null,
    mode: overrides.mode ?? 'failed',
    warnings: dedupeDiagnostics(overrides.warnings ?? []),
    errors: overrides.errors ?? [],
    sources: overrides.sources ?? [],
    files: overrides.files ?? []
  };
}

function createSourceResult(overrides = {}) {
  return {
    ok: overrides.ok ?? false,
    mode: overrides.mode ?? 'failed',
    warnings: dedupeDiagnostics(overrides.warnings ?? []),
    errors: overrides.errors ?? [],
    sources: overrides.sources ?? []
  };
}

function createWriteResult(overrides = {}) {
  return {
    ok: overrides.ok ?? false,
    warnings: dedupeDiagnostics(overrides.warnings ?? []),
    errors: overrides.errors ?? [],
    files: overrides.files ?? []
  };
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

async function isDirectory(targetPath) {
  try {
    const item = await stat(targetPath);
    return item.isDirectory();
  } catch {
    return false;
  }
}

function isWithinDirectory(targetPath, dirPath) {
  const relative = path.relative(dirPath, targetPath);
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosix(value) {
  return String(value).replaceAll(path.sep, '/');
}
