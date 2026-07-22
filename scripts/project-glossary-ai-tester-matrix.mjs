// project-glossary-ai-tester-matrix.mjs - controlled glossary context A/B scenarios
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PROJECT_GLOSSARY_CATALOG_SCHEMA = 'aifhub.project_glossary.ai_tester_scenario_catalog.v1';
export const PROJECT_GLOSSARY_MATRIX_SCHEMA = 'aifhub.project_glossary.ai_tester_matrix.v1';
export const GLOSSARY_CONDITIONS = Object.freeze([
  'baseline_without_glossary',
  'candidate_with_glossary'
]);

const DEFAULT_CATALOG = path.join('docs', 'project-glossary-research', 'ai-tester-scenarios.json');
const SAFE_SKILLS = new Set(['aif-explore', 'aif-plan']);
const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

export async function loadProjectGlossaryScenarioCatalog({
  catalogPath = DEFAULT_CATALOG,
  cwd = process.cwd()
} = {}) {
  const resolvedPath = path.resolve(cwd, catalogPath);
  log('debug', 'catalog.read.start', { path: toProjectPath(cwd, resolvedPath) });
  const raw = await readFile(resolvedPath, 'utf8');
  const catalog = JSON.parse(raw);
  const errors = validateProjectGlossaryScenarioCatalog(catalog);
  if (errors.length > 0) {
    throw new Error(`Invalid project glossary ai-tester catalog: ${errors.join('; ')}`);
  }
  log('info', 'catalog.read.complete', {
    path: toProjectPath(cwd, resolvedPath),
    scenarios: catalog.scenarios.length,
    repetitions: catalog.defaults.repetitions
  });
  return { ...catalog, source_path: toProjectPath(cwd, resolvedPath) };
}

export function validateProjectGlossaryScenarioCatalog(catalog = {}) {
  const errors = [];
  if (catalog.schema !== PROJECT_GLOSSARY_CATALOG_SCHEMA) {
    errors.push(`schema must be ${PROJECT_GLOSSARY_CATALOG_SCHEMA}`);
  }

  const defaults = catalog.defaults ?? {};
  if (defaults.runtime !== 'codex') errors.push('defaults.runtime must be codex');
  if (!safeToken(defaults.model)) errors.push('defaults.model must be a safe non-empty model id');
  if (!safeToken(defaults.reasoning)) errors.push('defaults.reasoning must be a safe non-empty reasoning id');
  if (!Number.isInteger(defaults.repetitions) || defaults.repetitions < 2) {
    errors.push('defaults.repetitions must be an integer >= 2');
  }
  if (!sameOrderedValues(defaults.conditions, GLOSSARY_CONDITIONS)) {
    errors.push(`defaults.conditions must be ${GLOSSARY_CONDITIONS.join(', ')}`);
  }
  if (!Number.isInteger(defaults.max_turns) || defaults.max_turns < 1) {
    errors.push('defaults.max_turns must be a positive integer');
  }

  const fixture = catalog.fixture ?? {};
  if (!safeId(fixture.id)) errors.push('fixture.id must be lowercase kebab-safe');
  if (!safeRelativePath(fixture.config_path)) errors.push('fixture.config_path must be project-relative');
  if (!safeRelativePath(fixture.context_path)) errors.push('fixture.context_path must be project-relative');
  if (!safeToken(fixture.sentinel)) errors.push('fixture.sentinel must be a safe non-empty token');

  const sourceFiles = fixture.source_files ?? {};
  if (Object.keys(sourceFiles).length === 0) errors.push('fixture.source_files must not be empty');
  for (const [filePath, content] of Object.entries(sourceFiles)) {
    if (!safeRelativePath(filePath)) errors.push(`fixture.source_files contains unsafe path: ${filePath}`);
    if (containsPrivateMaterial(content)) errors.push(`fixture.source_files contains private-looking material: ${filePath}`);
  }

  const glossary = fixture.synthetic_glossary ?? {};
  if (!Array.isArray(glossary.canonical_terms) || glossary.canonical_terms.length < 1) {
    errors.push('fixture.synthetic_glossary.canonical_terms must not be empty');
  }
  if (!Array.isArray(glossary.avoided_terms) || glossary.avoided_terms.length < 1) {
    errors.push('fixture.synthetic_glossary.avoided_terms must not be empty');
  }
  if (!String(glossary.body ?? '').includes(String(fixture.sentinel ?? ''))) {
    errors.push('fixture.synthetic_glossary.body must contain fixture.sentinel');
  }
  if (containsPrivateMaterial(glossary.body)) {
    errors.push('fixture.synthetic_glossary.body contains private-looking material');
  }

  const scenarios = asArray(catalog.scenarios);
  if (scenarios.length === 0) errors.push('scenarios must not be empty');
  const seen = new Set();
  for (const [index, scenario] of scenarios.entries()) {
    const prefix = `scenarios[${index}]`;
    if (!safeId(scenario.id)) errors.push(`${prefix}.id must be lowercase kebab-safe`);
    if (seen.has(scenario.id)) errors.push(`${prefix}.id duplicates ${scenario.id}`);
    seen.add(scenario.id);
    if (!SAFE_SKILLS.has(scenario.skill)) errors.push(`${prefix}.skill must be aif-explore or aif-plan`);
    if (!String(scenario.task ?? '').trim()) errors.push(`${prefix}.task must not be empty`);
    if (containsPrivateMaterial(scenario.task)) errors.push(`${prefix}.task contains private-looking material`);
    if (asArray(scenario.required_identifiers).length === 0) {
      errors.push(`${prefix}.required_identifiers must not be empty`);
    }
    if (asArray(scenario.forbidden_authority_claims).length === 0) {
      errors.push(`${prefix}.forbidden_authority_claims must not be empty`);
    }
  }
  return errors;
}

export function buildProjectGlossaryMatrix({
  catalog,
  runId,
  model = catalog?.defaults?.model,
  reasoning = catalog?.defaults?.reasoning,
  runtime = catalog?.defaults?.runtime,
  generatedAt = new Date().toISOString()
} = {}) {
  const errors = validateProjectGlossaryScenarioCatalog(catalog);
  if (errors.length > 0) throw new Error(`Invalid project glossary ai-tester catalog: ${errors.join('; ')}`);
  if (!safeId(runId)) throw new Error('runId must be lowercase kebab-safe');
  if (!safeToken(model)) throw new Error('model must be a safe non-empty model id');
  if (!safeToken(reasoning)) throw new Error('reasoning must be a safe non-empty reasoning id');
  if (!safeToken(runtime)) throw new Error('runtime must be a safe non-empty runtime id');

  const sourceFingerprint = sha256(stableStringify(catalog.fixture.source_files));
  const glossaryFingerprint = sha256(String(catalog.fixture.synthetic_glossary.body));
  const cases = [];

  for (const scenario of catalog.scenarios) {
    const settingsFingerprint = sha256(stableStringify({
      fixture_id: catalog.fixture.id,
      source_fingerprint: sourceFingerprint,
      skill: scenario.skill,
      task: scenario.task,
      required_identifiers: scenario.required_identifiers,
      forbidden_authority_claims: scenario.forbidden_authority_claims,
      runtime,
      model,
      reasoning,
      max_turns: catalog.defaults.max_turns
    }));
    for (let repetition = 1; repetition <= catalog.defaults.repetitions; repetition += 1) {
      const repetitionId = `r${String(repetition).padStart(2, '0')}`;
      const pairId = `${runId}__${scenario.id}__${repetitionId}`;
      for (const condition of GLOSSARY_CONDITIONS) {
        const id = `${pairId}__${condition}`;
        cases.push({
          id,
          pair_id: pairId,
          scenario_id: scenario.id,
          skill: scenario.skill,
          task: scenario.task,
          repetition,
          condition,
          runtime,
          model,
          reasoning,
          max_turns: catalog.defaults.max_turns,
          fixture_id: catalog.fixture.id,
          fixture_path: toPosix(path.join('fixtures', scenario.id, condition)),
          scenario_file: toPosix(path.join('scenarios', `${id}.yaml`)),
          settings_fingerprint: settingsFingerprint,
          source_fingerprint: sourceFingerprint,
          glossary_fingerprint: condition === 'candidate_with_glossary' ? glossaryFingerprint : null,
          required_identifiers: [...scenario.required_identifiers],
          canonical_terms: [...catalog.fixture.synthetic_glossary.canonical_terms],
          avoided_terms: [...catalog.fixture.synthetic_glossary.avoided_terms],
          forbidden_authority_claims: [...scenario.forbidden_authority_claims],
          sentinel: catalog.fixture.sentinel,
          exact_filter: exactScenarioFilter(id)
        });
      }
    }
  }

  return {
    schema: PROJECT_GLOSSARY_MATRIX_SCHEMA,
    generated_at: generatedAt,
    run_id: runId,
    catalog_schema: catalog.schema,
    catalog_source: catalog.source_path ?? null,
    runtime,
    model,
    reasoning,
    repetitions: catalog.defaults.repetitions,
    conditions: [...GLOSSARY_CONDITIONS],
    source_fingerprint: sourceFingerprint,
    cases
  };
}

export async function generateProjectGlossaryMatrix({
  catalogPath = DEFAULT_CATALOG,
  outDir,
  sourceRoot = process.cwd(),
  runId,
  model,
  reasoning,
  runtime,
  dryRun = false,
  cwd = process.cwd()
} = {}) {
  if (!outDir) throw new Error('outDir is required');
  const catalog = await loadProjectGlossaryScenarioCatalog({ catalogPath, cwd });
  const matrix = buildProjectGlossaryMatrix({ catalog, runId, model, reasoning, runtime });
  if (dryRun) {
    log('info', 'matrix.dry_run', { run_id: runId, cases: matrix.cases.length });
    return { matrix, written_files: [], dry_run: true };
  }

  const resolvedOut = path.resolve(cwd, outDir);
  const resolvedSource = path.resolve(cwd, sourceRoot);
  log('info', 'matrix.write.start', {
    out: toProjectPath(cwd, resolvedOut),
    cases: matrix.cases.length
  });
  await mkdir(resolvedOut, { recursive: true });
  await mkdir(path.join(resolvedOut, 'fixtures'), { recursive: true });
  await mkdir(path.join(resolvedOut, 'scenarios'), { recursive: true });
  const writtenFiles = [];

  await writeTracked(path.join(resolvedOut, 'system-prompt.md'), renderSystemPrompt(), writtenFiles, resolvedOut);
  await writeTracked(
    path.join(resolvedOut, 'matrix-summary.json'),
    `${JSON.stringify(matrix, null, 2)}\n`,
    writtenFiles,
    resolvedOut
  );

  const fixtureKeys = new Set();
  for (const matrixCase of matrix.cases) {
    const fixtureKey = `${matrixCase.scenario_id}:${matrixCase.condition}`;
    if (!fixtureKeys.has(fixtureKey)) {
      fixtureKeys.add(fixtureKey);
      await writeFixture({
        catalog,
        matrixCase,
        outDir: resolvedOut,
        sourceRoot: resolvedSource,
        writtenFiles
      });
    }
    const scenarioPath = path.join(resolvedOut, fromPosix(matrixCase.scenario_file));
    await writeTracked(
      scenarioPath,
      renderAiTesterScenario(matrixCase),
      writtenFiles,
      resolvedOut
    );
  }

  log('info', 'matrix.write.complete', {
    out: toProjectPath(cwd, resolvedOut),
    written_files: writtenFiles.length
  });
  return { matrix, written_files: writtenFiles, dry_run: false };
}

export function renderAiTesterScenario(matrixCase = {}) {
  const promptLines = [
    `Target skill: ${matrixCase.skill}.`,
    `Read project/skills/${matrixCase.skill}/SKILL.md completely before answering.`,
    'Read project/skills/shared/LANGUAGE-POLICY.md and the PROJECT-GLOSSARY.md contract it references.',
    'Resolve project/.ai-factory/config.yaml exactly as those instructions require.',
    'Work only inside the copied project fixture and do not edit files.',
    `Benchmark task: ${matrixCase.task}`
  ];
  return [
    `scenario: ${matrixCase.id}`,
    `description: "project-glossary condition=${matrixCase.condition} repetition=${matrixCase.repetition} settings=${matrixCase.settings_fingerprint}"`,
    'system_prompt_file: "../system-prompt.md"',
    'user_prompt: |',
    ...promptLines.map((line) => `  ${line}`),
    'runner:',
    `  runtime: ${quoteYaml(matrixCase.runtime)}`,
    `  model: ${quoteYaml(matrixCase.model)}`,
    `  reasoning: ${quoteYaml(matrixCase.reasoning)}`,
    '  permission_mode: bypassPermissions',
    'fixtures:',
    '  copy_trees:',
    `    - from: ${quoteYaml(`../${matrixCase.fixture_path}`)}`,
    '      to: project',
    'assertions:',
    '  - id: stay-in-sandbox',
    '    type: no_path_escape',
    '  - id: bounded-turns',
    '    type: turn_count_at_most',
    `    max: ${matrixCase.max_turns}`,
    '  - id: completed-output',
    '    type: output_contains',
    '    pattern: "evaluation_complete"',
    ''
  ].join('\n');
}

export function exactScenarioFilter(scenarioId) {
  if (!safeScenarioId(scenarioId)) throw new Error('scenario id contains unsafe filter characters');
  return `^${scenarioId}$`;
}

export async function buildAiTesterRuntimeEnv({
  matrixDir,
  platform = process.platform,
  baseEnv = process.env,
  systemRoot = baseEnv.SystemRoot ?? 'C:\\Windows'
} = {}) {
  const env = { ...baseEnv };
  if (platform !== 'win32') return env;
  const shimDir = path.join(matrixDir, '.runner-bin');
  await mkdir(shimDir, { recursive: true });
  await writeFile(path.join(shimDir, 'which.cmd'), '@echo off\r\nwhere.exe %*\r\n', 'utf8');
  await copyFile(path.join(systemRoot, 'System32', 'where.exe'), path.join(shimDir, 'which.exe')).catch(() => {});
  const currentPath = env.Path ?? env.PATH ?? '';
  env.Path = `${shimDir}${path.delimiter}${currentPath}`;
  env.PATH = env.Path;
  log('debug', 'runner.windows_shim.ready', { shim: '.runner-bin/which.cmd' });
  return env;
}

export function buildAiTesterRunInvocation(matrixCase, {
  matrixDir,
  platform = process.platform,
  quiet = true,
  dryRun = false
} = {}) {
  const scenarioPath = path.resolve(matrixDir, fromPosix(matrixCase.scenario_file));
  const args = [
    'run',
    '--file', scenarioPath,
    '--runtime', matrixCase.runtime,
    '--model', matrixCase.model,
    '--reasoning', matrixCase.reasoning,
    '--filter', exactScenarioFilter(matrixCase.id)
  ];
  if (quiet) args.push('--quiet');
  if (dryRun) args.push('--dry-run');
  if (platform !== 'win32') return { command: 'ai-tester', args };
  const commandText = ['ai-tester', ...args.map(quotePowerShellArg)].join(' ');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', commandText]
  };
}

function renderSystemPrompt() {
  return [
    '# AIFHub Project Glossary Evaluation',
    '',
    'You are running a controlled behavioral evaluation of optional project glossary context.',
    '',
    'Rules:',
    '',
    '- Follow the target AIFHub skill and shared language/glossary policies copied into the fixture.',
    '- Treat the configured project glossary as optional lexical context only.',
    '- Preserve source, code, API, path, and CLI identifiers exactly.',
    '- Do not infer requirements, rules, or architecture decisions from glossary text.',
    '- Missing glossary context is non-blocking.',
    '- Never reproduce the complete glossary, HTML comments, or sentinel values in the answer.',
    '- Do not read outside the copied project fixture and do not edit files.',
    '- Return only the requested concise answer and the final marker evaluation_complete.',
    ''
  ].join('\n');
}

async function writeFixture({ catalog, matrixCase, outDir, sourceRoot, writtenFiles }) {
  const fixtureRoot = path.join(outDir, fromPosix(matrixCase.fixture_path));
  await mkdir(fixtureRoot, { recursive: true });
  for (const [relativePath, content] of Object.entries(catalog.fixture.source_files)) {
    await writeTracked(path.join(fixtureRoot, fromPosix(relativePath)), content, writtenFiles, outDir);
  }
  const config = [
    'config_version: 1',
    'language:',
    '  ui: en',
    '  artifacts: en',
    '  technical_terms: keep',
    'paths:',
    `  context: ${catalog.fixture.context_path}`,
    ''
  ].join('\n');
  await writeTracked(
    path.join(fixtureRoot, fromPosix(catalog.fixture.config_path)),
    config,
    writtenFiles,
    outDir
  );

  const skillSource = path.join(sourceRoot, '.agents', 'skills', matrixCase.skill);
  const skillTarget = path.join(fixtureRoot, 'skills', matrixCase.skill);
  await cp(skillSource, skillTarget, { recursive: true, force: true });
  writtenFiles.push(toPosix(path.relative(outDir, skillTarget)) + '/');

  const sharedTarget = path.join(fixtureRoot, 'skills', 'shared');
  await mkdir(sharedTarget, { recursive: true });
  for (const name of ['LANGUAGE-POLICY.md', 'PROJECT-GLOSSARY.md']) {
    const target = path.join(sharedTarget, name);
    await copyFile(path.join(sourceRoot, 'skills', 'shared', name), target);
    writtenFiles.push(toPosix(path.relative(outDir, target)));
  }

  if (matrixCase.condition === 'candidate_with_glossary') {
    await writeTracked(
      path.join(fixtureRoot, fromPosix(catalog.fixture.context_path)),
      catalog.fixture.synthetic_glossary.body,
      writtenFiles,
      outDir
    );
  }
  log('debug', 'fixture.write.complete', {
    scenario: matrixCase.scenario_id,
    condition: matrixCase.condition,
    path: matrixCase.fixture_path
  });
}

async function writeTracked(filePath, content, writtenFiles, rootDir) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  writtenFiles.push(toPosix(path.relative(rootDir, filePath)));
}

function safeRelativePath(value) {
  const raw = String(value ?? '');
  if (!raw || path.isAbsolute(raw) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return false;
  const normalized = path.posix.normalize(raw.replaceAll('\\', '/'));
  return normalized !== '..' && !normalized.startsWith('../') && normalized !== '.';
}

function containsPrivateMaterial(value) {
  const raw = String(value ?? '');
  return /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/[^/]+\/|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|(?:api[_-]?key|token|password)\s*[:=]\s*\S+)/i.test(raw);
}

function safeToken(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(String(value ?? ''));
}

function safeId(value) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(value ?? ''));
}

function safeScenarioId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(value ?? ''));
}

function sameOrderedValues(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function quoteYaml(value) {
  return JSON.stringify(String(value));
}

function quotePowerShellArg(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function toProjectPath(root, filePath) {
  const relative = path.relative(root, filePath);
  return toPosix(relative || '.');
}

function toPosix(value) {
  return String(value).replaceAll(path.sep, '/');
}

function fromPosix(value) {
  return String(value).split('/').join(path.sep);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function log(level, event, details = {}) {
  const configured = String(process.env.AIF_GLOSSARY_LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'warn').toLowerCase();
  const threshold = LOG_LEVELS[configured] ?? LOG_LEVELS.warn;
  if ((LOG_LEVELS[level] ?? LOG_LEVELS.info) < threshold) return;
  process.stderr.write(`${JSON.stringify({ component: 'project-glossary-ai-tester', level, event, ...details })}\n`);
}

function parseCliArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--catalog') parsed.catalogPath = args[++index];
    else if (token === '--out') parsed.outDir = args[++index];
    else if (token === '--source-root') parsed.sourceRoot = args[++index];
    else if (token === '--run-id') parsed.runId = args[++index];
    else if (token === '--model') parsed.model = args[++index];
    else if (token === '--reasoning') parsed.reasoning = args[++index];
    else if (token === '--runtime') parsed.runtime = args[++index];
    else if (token === '--dry-run') parsed.dryRun = true;
    else if (token === '--json') parsed.json = true;
    else if (token === '--help' || token === '-h') parsed.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/project-glossary-ai-tester-matrix.mjs --out <dir> --run-id <id> [options]',
    '',
    'Options:',
    `  --catalog <file>       Catalog JSON. Default: ${toPosix(DEFAULT_CATALOG)}.`,
    '  --source-root <dir>    Repository root containing .agents/skills and skills/shared.',
    '  --model <id>           Override pinned model for this matrix.',
    '  --reasoning <level>    Override pinned reasoning level.',
    '  --runtime <id>         Override runtime. Default from catalog.',
    '  --dry-run              Validate and select cases without writing files.',
    '  --json                 Print JSON result.',
    ''
  ].join('\n');
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  if (!parsed.outDir || !parsed.runId) throw new Error('--out and --run-id are required');
  const result = await generateProjectGlossaryMatrix(parsed);
  const body = {
    schema: PROJECT_GLOSSARY_MATRIX_SCHEMA,
    run_id: result.matrix.run_id,
    cases: result.matrix.cases.length,
    dry_run: result.dry_run,
    written_files: result.written_files.length,
    model: result.matrix.model,
    reasoning: result.matrix.reasoning,
    runtime: result.matrix.runtime
  };
  process.stdout.write(parsed.json ? `${JSON.stringify(body, null, 2)}\n` : `Generated ${body.cases} cases for ${body.run_id}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    log('error', 'matrix.failed', { message: error instanceof Error ? error.message : String(error) });
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
