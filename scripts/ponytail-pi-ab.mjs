// ponytail-pi-ab.mjs - isolated Pi A/B runner for the Ponytail implementation skill
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PONYTAIL_PI_AB_CATALOG_SCHEMA = 'aifhub.ponytail_pi_ab.catalog.v1';
export const PONYTAIL_PI_AB_MATRIX_SCHEMA = 'aifhub.ponytail_pi_ab.matrix.v1';
export const PONYTAIL_PI_AB_RESULTS_SCHEMA = 'aifhub.ponytail_pi_ab.results.v1';
export const PONYTAIL_CONDITIONS = ['baseline', 'ponytail_full'];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOG = path.join(
  REPO_ROOT,
  'docs',
  'skill-providers-research',
  'ponytail-pi-ab',
  'scenario-catalog.json'
);
const GRADER_ROOT = path.join(REPO_ROOT, 'scripts', 'fixtures', 'ponytail-pi-ab');
const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.go', '.h', '.hpp', '.java', '.js', '.jsx', '.kt', '.mjs', '.php', '.py', '.rb', '.rs', '.swift', '.ts', '.tsx'
]);

export async function loadPonytailPiCatalog({ catalogPath = DEFAULT_CATALOG, cwd = process.cwd() } = {}) {
  const resolved = path.resolve(cwd, catalogPath);
  const catalog = JSON.parse(await readFile(resolved, 'utf8'));
  const errors = validatePonytailPiCatalog(catalog);
  if (errors.length > 0) throw new Error(`Invalid Ponytail Pi A/B catalog: ${errors.join('; ')}`);
  return { ...catalog, source_path: toPosix(path.relative(REPO_ROOT, resolved)) };
}

export function validatePonytailPiCatalog(catalog = {}) {
  const errors = [];
  if (catalog.schema !== PONYTAIL_PI_AB_CATALOG_SCHEMA) {
    errors.push(`schema must be ${PONYTAIL_PI_AB_CATALOG_SCHEMA}`);
  }

  const defaults = catalog.defaults ?? {};
  if (defaults.runtime !== 'pi') errors.push('defaults.runtime must be pi');
  if (!safeToken(defaults.runtime_version)) errors.push('defaults.runtime_version must be a safe version');
  if (!safeToken(defaults.provider)) errors.push('defaults.provider must be a safe provider id');
  if (!safeModel(defaults.model)) errors.push('defaults.model must be a safe model id');
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(defaults.thinking)) {
    errors.push('defaults.thinking must be a supported Pi thinking level');
  }
  if (!sameOrderedValues(defaults.conditions, PONYTAIL_CONDITIONS)) {
    errors.push(`defaults.conditions must be ${PONYTAIL_CONDITIONS.join(', ')}`);
  }
  if (!Number.isInteger(defaults.repetitions) || defaults.repetitions < 4) {
    errors.push('defaults.repetitions must be an integer >= 4');
  }
  if (!Number.isInteger(defaults.timeout_seconds) || defaults.timeout_seconds < 60) {
    errors.push('defaults.timeout_seconds must be an integer >= 60');
  }
  if (!Array.isArray(defaults.tools) || defaults.tools.length === 0 || defaults.tools.some((item) => !safeId(item))) {
    errors.push('defaults.tools must be a non-empty list of safe built-in tool ids');
  }

  const ponytail = catalog.ponytail ?? {};
  if (!safeToken(ponytail.version)) errors.push('ponytail.version must be a safe version');
  if (!fullCommit(ponytail.source_commit)) errors.push('ponytail.source_commit must be a full Git commit');
  if (!safeRelativePath(ponytail.skill_path)) errors.push('ponytail.skill_path must be repository-relative');
  if (ponytail.mode !== 'full') errors.push('ponytail.mode must be full');
  if (ponytail.loading !== 'explicit_skill_only_no_hooks') {
    errors.push('ponytail.loading must be explicit_skill_only_no_hooks');
  }

  const fixtures = asArray(catalog.fixtures);
  if (fixtures.length < 2) errors.push('fixtures must contain at least two projects');
  const fixtureIds = new Set();
  for (const [index, fixture] of fixtures.entries()) {
    const prefix = `fixtures[${index}]`;
    if (!safeId(fixture.id)) errors.push(`${prefix}.id must be lowercase kebab-safe`);
    if (fixtureIds.has(fixture.id)) errors.push(`${prefix}.id duplicates ${fixture.id}`);
    fixtureIds.add(fixture.id);
    if (!safePathSegment(fixture.source_directory)) errors.push(`${prefix}.source_directory must be one safe path segment`);
    if (!fullCommit(fixture.source_commit)) errors.push(`${prefix}.source_commit must be a full Git commit`);
    if (asArray(fixture.project_shape).length === 0) errors.push(`${prefix}.project_shape must not be empty`);
    if (asArray(fixture.dependency_files).some((item) => !safeRelativePath(item))) {
      errors.push(`${prefix}.dependency_files contains an unsafe path`);
    }
    for (const [kind, commands] of [['setup', asArray(fixture.setup)], ['validation', asArray(fixture.validation)]]) {
      if (kind === 'validation' && commands.length === 0) errors.push(`${prefix}.validation must not be empty`);
      for (const command of commands) {
        if (!safeToken(command.command)) errors.push(`${prefix}.${kind} contains an unsafe command`);
        if (command.windows_command !== undefined && !safeToken(command.windows_command)) {
          errors.push(`${prefix}.${kind} contains an unsafe Windows command`);
        }
        if (!Array.isArray(command.args) || command.args.some((item) => typeof item !== 'string')) {
          errors.push(`${prefix}.${kind} args must be strings`);
        }
        if (!safeRelativePath(command.cwd) && command.cwd !== '.') errors.push(`${prefix}.${kind} contains an unsafe cwd`);
      }
    }
  }

  const scenarios = asArray(catalog.scenarios);
  if (scenarios.length < 2) errors.push('scenarios must contain at least two tasks');
  const scenarioIds = new Set();
  const shapes = new Set();
  for (const [index, scenario] of scenarios.entries()) {
    const prefix = `scenarios[${index}]`;
    if (!safeId(scenario.id)) errors.push(`${prefix}.id must be lowercase kebab-safe`);
    if (scenarioIds.has(scenario.id)) errors.push(`${prefix}.id duplicates ${scenario.id}`);
    scenarioIds.add(scenario.id);
    if (!fixtureIds.has(scenario.fixture_id)) errors.push(`${prefix}.fixture_id is unknown`);
    if (!['over-build', 'security-correctness'].includes(scenario.shape)) errors.push(`${prefix}.shape is unsupported`);
    shapes.add(scenario.shape);
    if (!String(scenario.title ?? '').trim()) errors.push(`${prefix}.title must not be empty`);
    if (!String(scenario.task ?? '').trim()) errors.push(`${prefix}.task must not be empty`);
    if (containsPrivateMaterial(`${scenario.title ?? ''}\n${scenario.task ?? ''}`)) {
      errors.push(`${prefix} contains private-looking material`);
    }
    if (!safePathSegment(scenario.hidden_grader)) {
      errors.push(`${prefix}.hidden_grader must be one safe filename`);
    } else if (!supportedHiddenGrader(scenario.hidden_grader)) {
      errors.push(`${prefix}.hidden_grader must be an .mjs, .php, or _test.go grader`);
    }
    if (asArray(scenario.required_behaviors).length === 0) errors.push(`${prefix}.required_behaviors must not be empty`);
    if (asArray(scenario.forbidden_changes).length === 0) errors.push(`${prefix}.forbidden_changes must not be empty`);
  }
  for (const requiredShape of ['over-build', 'security-correctness']) {
    if (!shapes.has(requiredShape)) errors.push(`scenarios must include shape ${requiredShape}`);
  }
  return errors;
}

export function buildPonytailPiMatrix({
  catalog,
  runId,
  provider = catalog?.defaults?.provider,
  model = catalog?.defaults?.model,
  thinking = catalog?.defaults?.thinking,
  generatedAt = new Date().toISOString()
} = {}) {
  const errors = validatePonytailPiCatalog(catalog);
  if (errors.length > 0) throw new Error(`Invalid Ponytail Pi A/B catalog: ${errors.join('; ')}`);
  if (!safeId(runId)) throw new Error('runId must be lowercase kebab-safe');
  if (!safeToken(provider)) throw new Error('provider must be a safe provider id');
  if (!safeModel(model)) throw new Error('model must be a safe model id');
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) {
    throw new Error('thinking must be a supported Pi thinking level');
  }

  const fixtures = new Map(catalog.fixtures.map((fixture) => [fixture.id, fixture]));
  const cases = [];
  for (const scenario of catalog.scenarios) {
    const fixture = fixtures.get(scenario.fixture_id);
    const taskFingerprint = sha256(stableStringify({
      fixture_commit: fixture.source_commit,
      task: scenario.task,
      required_behaviors: scenario.required_behaviors,
      forbidden_changes: scenario.forbidden_changes
    }));
    const settingsFingerprint = sha256(stableStringify({
      runtime: catalog.defaults.runtime,
      runtime_version: catalog.defaults.runtime_version,
      provider,
      model,
      thinking,
      tools: catalog.defaults.tools,
      timeout_seconds: catalog.defaults.timeout_seconds,
      task_fingerprint: taskFingerprint
    }));

    for (let repetition = 1; repetition <= catalog.defaults.repetitions; repetition += 1) {
      const repetitionId = `r${String(repetition).padStart(2, '0')}`;
      const pairId = `${runId}__${scenario.id}__${repetitionId}`;
      const conditionOrder = repetition % 2 === 1
        ? PONYTAIL_CONDITIONS
        : [...PONYTAIL_CONDITIONS].reverse();
      for (const condition of conditionOrder) {
        const id = `${pairId}__${condition}`;
        cases.push({
          id,
          pair_id: pairId,
          scenario_id: scenario.id,
          fixture_id: fixture.id,
          fixture_source_directory: fixture.source_directory,
          fixture_commit: fixture.source_commit,
          shape: scenario.shape,
          repetition,
          condition,
          runtime: catalog.defaults.runtime,
          runtime_version: catalog.defaults.runtime_version,
          provider,
          model,
          thinking,
          tools: [...catalog.defaults.tools],
          timeout_seconds: catalog.defaults.timeout_seconds,
          task: scenario.task,
          task_fingerprint: taskFingerprint,
          settings_fingerprint: settingsFingerprint,
          hidden_grader: scenario.hidden_grader,
          dependency_files: [...fixture.dependency_files],
          setup: structuredClone(fixture.setup ?? []),
          validation: structuredClone(fixture.validation),
          case_path: toPosix(path.join('cases', id)),
          project_path: toPosix(path.join('cases', id, 'project'))
        });
      }
    }
  }

  return {
    schema: PONYTAIL_PI_AB_MATRIX_SCHEMA,
    generated_at: generatedAt,
    run_id: runId,
    catalog_schema: catalog.schema,
    catalog_source: catalog.source_path ?? null,
    runtime: catalog.defaults.runtime,
    runtime_version: catalog.defaults.runtime_version,
    provider,
    model,
    thinking,
    repetitions: catalog.defaults.repetitions,
    conditions: [...PONYTAIL_CONDITIONS],
    ponytail: structuredClone(catalog.ponytail),
    cases
  };
}

export function buildPiInvocation(matrixCase, { ponytailSkillPath = '<ponytail-skill-path>' } = {}) {
  const args = [
    '--provider', matrixCase.provider,
    '--model', matrixCase.model,
    '--thinking', matrixCase.thinking,
    '--mode', 'json',
    '--print',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--tools', matrixCase.tools.join(','),
    '--exclude-tools', 'ask_question'
  ];
  if (matrixCase.condition === 'ponytail_full') args.push('--skill', ponytailSkillPath);
  args.push('--', renderCasePrompt(matrixCase));
  return { command: 'pi', args };
}

export function renderCasePrompt(matrixCase) {
  const lines = [
    'You are in a disposable Git copy created for a controlled implementation benchmark.',
    'Read and write only inside the current project directory. Do not inspect parent or sibling directories.',
    'Do not commit, amend, reset, checkout another revision, or change Git configuration.',
    'Implement the canonical task completely, run its requested validation, and stop. Do not ask questions.'
  ];
  if (matrixCase.condition === 'ponytail_full') {
    lines.push('Use the explicitly loaded Ponytail skill in full mode for this implementation task.');
  }
  return [
    ...lines,
    '',
    'Canonical task:',
    matrixCase.task
  ].join('\n');
}

export async function preparePonytailPiMatrix({
  catalogPath = DEFAULT_CATALOG,
  runId,
  referencesRoot,
  ponytailRoot,
  outDir,
  provider,
  model,
  thinking,
  dryRun = false,
  cloneSnapshotFn = cloneGitSnapshot,
  cwd = process.cwd()
} = {}) {
  const catalog = await loadPonytailPiCatalog({ catalogPath, cwd });
  const matrix = buildPonytailPiMatrix({ catalog, runId, provider, model, thinking });
  if (dryRun) return { matrix, out_dir: null, prepared_cases: 0, dry_run: true };
  if (!referencesRoot || !ponytailRoot || !outDir) {
    throw new Error('--references-root, --ponytail-root, and --out are required unless --dry-run is used');
  }

  const resolvedReferences = path.resolve(cwd, referencesRoot);
  const resolvedPonytail = path.resolve(cwd, ponytailRoot);
  const resolvedOut = path.resolve(cwd, outDir);
  await assertPathExists(resolvedReferences, 'references root');
  await assertPathExists(resolvedPonytail, 'Ponytail root');
  await assertFreshOutput(resolvedOut);
  await assertPathExists(path.dirname(resolvedOut), 'output parent');
  const canonicalReferences = await realpath(resolvedReferences);
  const canonicalPonytail = await realpath(resolvedPonytail);
  const canonicalOut = path.join(await realpath(path.dirname(resolvedOut)), path.basename(resolvedOut));
  if (pathsOverlap(canonicalOut, canonicalReferences) || pathsOverlap(canonicalOut, canonicalPonytail)) {
    throw new Error('output directory must be outside the reference and Ponytail source roots');
  }

  const fixtureSources = new Map();
  for (const fixture of catalog.fixtures) {
    const source = await realpath(path.join(canonicalReferences, fixture.source_directory));
    if (!isDescendant(canonicalReferences, source)) throw new Error(`reference ${fixture.id} escapes the references root`);
    await verifyGitSnapshot(source, fixture.source_commit, `reference ${fixture.id}`);
    fixtureSources.set(fixture.id, source);
  }
  await verifyGitSnapshot(canonicalPonytail, catalog.ponytail.source_commit, 'Ponytail source');
  const sourceSkill = path.join(canonicalPonytail, fromPosix(catalog.ponytail.skill_path));
  await assertPathExists(sourceSkill, 'Ponytail skill');

  const copiedSkillSha256 = sha256(await readFile(sourceSkill));

  for (const matrixCase of matrix.cases) {
    const caseRoot = path.join(canonicalOut, fromPosix(matrixCase.case_path));
    const projectRoot = path.join(canonicalOut, fromPosix(matrixCase.project_path));
    await mkdir(caseRoot, { recursive: true });
    await cloneSnapshotFn(fixtureSources.get(matrixCase.fixture_id), projectRoot, matrixCase.fixture_commit);
    const caseSkill = path.join(caseRoot, 'treatment', 'ponytail', 'SKILL.md');
    await mkdir(path.dirname(caseSkill), { recursive: true });
    await copyFile(sourceSkill, caseSkill);
    const invocation = buildPiInvocation(matrixCase, {
      ponytailSkillPath: '<case-root>/treatment/ponytail/SKILL.md'
    });
    await writeFile(path.join(caseRoot, 'prompt.md'), `${renderCasePrompt(matrixCase)}\n`, 'utf8');
    await writeFile(path.join(caseRoot, 'invocation.json'), `${JSON.stringify({
      command: invocation.command,
      args: invocation.args,
      cwd: '<case-root>/project'
    }, null, 2)}\n`, 'utf8');
  }

  const summary = {
    ...matrix,
    ponytail: {
      ...matrix.ponytail,
      copied_skill_sha256: copiedSkillSha256
    }
  };
  await writeFile(path.join(canonicalOut, 'matrix-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  for (const fixture of catalog.fixtures) {
    await verifyGitSnapshot(fixtureSources.get(fixture.id), fixture.source_commit, `reference ${fixture.id}`);
  }
  await verifyGitSnapshot(canonicalPonytail, catalog.ponytail.source_commit, 'Ponytail source');

  return {
    matrix: summary,
    out_dir: canonicalOut,
    prepared_cases: matrix.cases.length,
    dry_run: false,
    source_roots: { references: canonicalReferences, ponytail: canonicalPonytail }
  };
}

export async function executePonytailPiMatrix(prepared, { piCommand = 'pi' } = {}) {
  if (!prepared?.out_dir || prepared.dry_run) throw new Error('a prepared matrix is required for execution');
  const matrix = prepared.matrix;
  const outDir = prepared.out_dir;
  await checkPonytailPiRuntime(matrix, { piCommand });

  const results = [];
  for (const matrixCase of matrix.cases) {
    const caseRoot = path.join(outDir, fromPosix(matrixCase.case_path));
    const projectRoot = path.join(outDir, fromPosix(matrixCase.project_path));
    const skillPath = path.join(caseRoot, 'treatment', 'ponytail', 'SKILL.md');
    const invocation = buildPiInvocation(matrixCase, { ponytailSkillPath: skillPath });
    const startedAt = new Date().toISOString();
    const piRun = await runExternal(piCommand, invocation.args, {
      cwd: projectRoot,
      timeoutMs: matrixCase.timeout_seconds * 1000,
      maxBuffer: 64 * 1024 * 1024
    });
    await writeFile(path.join(caseRoot, 'pi-events.jsonl'), piRun.stdout, 'utf8');
    await writeFile(path.join(caseRoot, 'pi-stderr.log'), piRun.stderr, 'utf8');

    const commandResults = [];
    for (const [kind, commands] of [['setup', matrixCase.setup], ['validation', matrixCase.validation]]) {
      for (const [index, commandSpec] of commands.entries()) {
        const commandResult = await runCatalogCommand(commandSpec, projectRoot, matrixCase.timeout_seconds * 1000);
        commandResults.push({ kind, index: index + 1, ...withoutOutput(commandResult) });
        await writeCommandLogs(caseRoot, `${kind}-${String(index + 1).padStart(2, '0')}`, commandResult);
      }
    }
    const hiddenResult = await runHiddenGrader(matrixCase, projectRoot, caseRoot);
    const diffCheck = await runExternal('git', gitArgs('diff', '--check', matrixCase.fixture_commit, '--'), {
      cwd: projectRoot,
      timeoutMs: 60_000
    });
    await writeCommandLogs(caseRoot, 'git-diff-check', diffCheck);
    const metrics = await collectGitMetrics(projectRoot, matrixCase.fixture_commit, matrixCase.dependency_files);
    const reference = prepared.source_roots?.references
      ? path.join(prepared.source_roots.references, matrixCase.fixture_source_directory)
      : null;
    let sourceSnapshotIntact = true;
    if (reference) {
      try {
        await verifyGitSnapshot(reference, matrixCase.fixture_commit, `reference ${matrixCase.fixture_id}`);
      } catch {
        sourceSnapshotIntact = false;
      }
    }
    const treatmentResourceIntact = sha256(await readFile(skillPath)) === matrix.ponytail.copied_skill_sha256;
    let ponytailSourceIntact = true;
    if (prepared.source_roots?.ponytail) {
      try {
        await verifyGitSnapshot(prepared.source_roots.ponytail, matrix.ponytail.source_commit, 'Ponytail source');
      } catch {
        ponytailSourceIntact = false;
      }
    }
    const commandPass = commandResults.every((item) => item.exit_code === 0 && !item.timed_out);
    const result = {
      schema: PONYTAIL_PI_AB_RESULTS_SCHEMA,
      case_id: matrixCase.id,
      pair_id: matrixCase.pair_id,
      scenario_id: matrixCase.scenario_id,
      condition: matrixCase.condition,
      repetition: matrixCase.repetition,
      started_at: startedAt,
      duration_ms: piRun.durationMs,
      pi: {
        exit_code: piRun.exitCode,
        timed_out: piRun.timedOut,
        usage: summarizePiJson(piRun.stdout)
      },
      commands: commandResults,
      hidden_grader: withoutOutput(hiddenResult),
      diff_check_pass: diffCheck.exitCode === 0,
      source_snapshot_intact: sourceSnapshotIntact,
      ponytail_source_intact: ponytailSourceIntact,
      treatment_resource_intact: treatmentResourceIntact,
      metrics,
      task_pass: piRun.exitCode === 0
        && !piRun.timedOut
        && commandPass
        && hiddenResult.exitCode === 0
        && !hiddenResult.timedOut
        && diffCheck.exitCode === 0
        && sourceSnapshotIntact
        && ponytailSourceIntact
        && treatmentResourceIntact
        && metrics.head_unchanged
        && !metrics.dependency_files_changed
    };
    results.push(result);
    await writeFile(path.join(caseRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeAggregate(outDir, matrix, results);
  }
  return writeAggregate(outDir, matrix, results);
}

export async function checkPonytailPiRuntime(matrix, { piCommand = 'pi' } = {}) {
  const version = (await runExternal(piCommand, ['--version'], { timeoutMs: 30_000 })).stdout.trim();
  if (version !== matrix.runtime_version) {
    throw new Error(`pi version ${version || '<empty>'} does not match pinned ${matrix.runtime_version}`);
  }
  const modelListing = await runExternal(piCommand, ['--list-models', matrix.model], { timeoutMs: 60_000 });
  if (modelListing.exitCode !== 0 || !modelListing.stdout.includes(matrix.provider) || !modelListing.stdout.includes(matrix.model)) {
    throw new Error(`pinned model ${matrix.provider}/${matrix.model} is not available in pi`);
  }
  const authCheck = await runExternal(piCommand, [
    'auth', 'check',
    '--provider', matrix.provider,
    '--model', matrix.model,
    '--json',
    '--no-refresh'
  ], { timeoutMs: 30_000 });
  let auth;
  try {
    auth = JSON.parse(authCheck.stdout);
  } catch {
    auth = null;
  }
  if (authCheck.exitCode !== 0 || auth?.status !== 'ready') {
    throw new Error(`pi authentication is not ready for ${matrix.provider}/${matrix.model}`);
  }
  return {
    runtime: 'pi',
    version,
    provider: matrix.provider,
    model: matrix.model,
    available: true,
    auth_ready: true
  };
}

export function summarizePiJson(jsonl) {
  let usage = null;
  let eventCount = 0;
  let toolCalls = 0;
  for (const line of String(jsonl ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    eventCount += 1;
    if (event.type === 'tool_execution_start') toolCalls += 1;
    if (event.usage && typeof event.usage === 'object') usage = event.usage;
    if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.usage) {
      usage = event.message.usage;
    }
  }
  return { event_count: eventCount, tool_calls: toolCalls, provider_usage: usage };
}

export function buildHiddenGraderInvocation(matrixCase, projectRoot, graderPath) {
  if (matrixCase.hidden_grader.endsWith('.php')) {
    return { command: 'php', args: [graderPath, projectRoot] };
  }
  if (matrixCase.hidden_grader.endsWith('.mjs')) {
    return { command: process.execPath, args: [graderPath, projectRoot] };
  }
  throw new Error(`unsupported script grader ${matrixCase.hidden_grader}`);
}

async function runHiddenGrader(matrixCase, projectRoot, caseRoot) {
  const grader = path.join(GRADER_ROOT, matrixCase.hidden_grader);
  await assertPathExists(grader, `hidden grader ${matrixCase.hidden_grader}`);
  let result;
  if (matrixCase.hidden_grader.endsWith('_test.go')) {
    const injected = path.join(projectRoot, 'go', 'ponytail_ab_hidden_test.go');
    await copyFile(grader, injected);
    try {
      result = await runExternal('go', ['test', '-skip', 'OpenSSL', './...'], {
        cwd: path.join(projectRoot, 'go'),
        timeoutMs: matrixCase.timeout_seconds * 1000
      });
    } finally {
      await rm(injected, { force: true });
    }
  } else {
    const invocation = buildHiddenGraderInvocation(matrixCase, projectRoot, grader);
    result = await runExternal(invocation.command, invocation.args, {
      cwd: projectRoot,
      timeoutMs: matrixCase.timeout_seconds * 1000
    });
  }
  await writeCommandLogs(caseRoot, 'hidden-grader', result);
  return result;
}

async function collectGitMetrics(projectRoot, sourceCommit, dependencyFiles) {
  const [head, statusResult, numstatResult, namesResult] = await Promise.all([
    runExternal('git', gitArgs('rev-parse', 'HEAD'), { cwd: projectRoot, timeoutMs: 30_000 }),
    runExternal('git', gitArgs('status', '--porcelain=v1', '--untracked-files=all'), { cwd: projectRoot, timeoutMs: 30_000 }),
    runExternal('git', gitArgs('diff', '--numstat', sourceCommit, '--'), { cwd: projectRoot, timeoutMs: 30_000 }),
    runExternal('git', gitArgs('diff', '--name-only', sourceCommit, '--'), { cwd: projectRoot, timeoutMs: 30_000 })
  ]);
  const changed = new Set(namesResult.stdout.split(/\r?\n/).filter(Boolean).map(toPosix));
  const untracked = statusResult.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('?? '))
    .map((line) => toPosix(line.slice(3).trim()));
  untracked.forEach((file) => changed.add(file));

  let sourceAdded = 0;
  let sourceDeleted = 0;
  for (const line of numstatResult.stdout.split(/\r?\n/).filter(Boolean)) {
    const [added, deleted, ...fileParts] = line.split('\t');
    const file = toPosix(fileParts.join('\t'));
    if (!SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    if (/^\d+$/.test(added)) sourceAdded += Number(added);
    if (/^\d+$/.test(deleted)) sourceDeleted += Number(deleted);
  }
  for (const file of untracked) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    try {
      const content = await readFile(path.join(projectRoot, fromPosix(file)), 'utf8');
      sourceAdded += content.length === 0 ? 0 : content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0);
    } catch {
      // Binary, removed, or unreadable untracked files are counted as files but not source LOC.
    }
  }
  const changedFiles = [...changed].sort();
  const dependencySet = new Set(dependencyFiles.map(toPosix));
  return {
    head_unchanged: head.stdout.trim() === sourceCommit,
    changed_files: changedFiles,
    changed_file_count: changedFiles.length,
    source_loc_added: sourceAdded,
    source_loc_deleted: sourceDeleted,
    dependency_files_changed: changedFiles.some((file) => dependencySet.has(file))
  };
}

async function runCatalogCommand(commandSpec, projectRoot, timeoutMs) {
  const command = process.platform === 'win32' && commandSpec.windows_command
    ? commandSpec.windows_command
    : commandSpec.command;
  return runExternal(command, commandSpec.args, {
    cwd: path.resolve(projectRoot, fromPosix(commandSpec.cwd)),
    timeoutMs
  });
}

async function writeAggregate(outDir, matrix, results) {
  const completePairCount = [...new Set(results.map((item) => item.pair_id))]
    .filter((pairId) => results.filter((item) => item.pair_id === pairId).length === PONYTAIL_CONDITIONS.length)
    .length;
  const aggregate = {
    schema: PONYTAIL_PI_AB_RESULTS_SCHEMA,
    run_id: matrix.run_id,
    provider: matrix.provider,
    model: matrix.model,
    thinking: matrix.thinking,
    expected_cases: matrix.cases.length,
    completed_cases: results.length,
    complete_pairs: completePairCount,
    pass_by_condition: Object.fromEntries(PONYTAIL_CONDITIONS.map((condition) => [
      condition,
      results.filter((item) => item.condition === condition && item.task_pass).length
    ])),
    results
  };
  await writeFile(path.join(outDir, 'aggregate.json'), `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
  return aggregate;
}

async function writeCommandLogs(caseRoot, stem, result) {
  await writeFile(path.join(caseRoot, `${stem}.stdout.log`), result.stdout, 'utf8');
  await writeFile(path.join(caseRoot, `${stem}.stderr.log`), result.stderr, 'utf8');
}

export async function cloneGitSnapshot(source, target, commit) {
  const clone = await runExternal('git', gitArgs('clone', '--local', '--no-hardlinks', '--no-checkout', source, target), {
    timeoutMs: 120_000
  });
  if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr.trim()}`);
  const checkout = await runExternal('git', gitArgs('checkout', '--detach', commit), { cwd: target, timeoutMs: 60_000 });
  if (checkout.exitCode !== 0) throw new Error(`git checkout failed: ${checkout.stderr.trim()}`);
  await verifyGitSnapshot(target, commit, 'prepared case');
}

async function verifyGitSnapshot(repoRoot, expectedCommit, label) {
  await assertPathExists(repoRoot, label);
  const head = await runExternal('git', gitArgs('rev-parse', 'HEAD'), { cwd: repoRoot, timeoutMs: 30_000 });
  if (head.exitCode !== 0 || head.stdout.trim() !== expectedCommit) {
    throw new Error(`${label} must be at exact commit ${expectedCommit}`);
  }
  const statusResult = await runExternal('git', gitArgs('status', '--porcelain=v1', '--untracked-files=all'), {
    cwd: repoRoot,
    timeoutMs: 30_000
  });
  if (statusResult.exitCode !== 0 || statusResult.stdout.trim()) throw new Error(`${label} must be a clean Git snapshot`);
}

async function runExternal(command, args, { cwd, timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const resolved = await resolveExecutable(command, args);
  return runExternalDirect(resolved.command, resolved.args, { cwd, timeoutMs, maxBuffer });
}

export async function runExternalDirect(command, args, { cwd, timeoutMs, maxBuffer }) {
  const started = Date.now();
  return new Promise((resolve) => {
    let capturedStdout = '';
    let capturedStderr = '';
    const finish = (error, stdout = '', stderr = '') => {
      resolve({
        command,
        exitCode: error?.code === 'ETIMEDOUT' ? null : (typeof error?.code === 'number' ? error.code : error ? 1 : 0),
        timedOut: Boolean(error?.killed && error?.signal),
        durationMs: Date.now() - started,
        stdout: capturedStdout || String(stdout),
        stderr: capturedStderr || String(stderr || error?.message || '')
      });
    };
    try {
      const child = execFile(command, args, {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer,
        encoding: 'utf8'
      }, finish);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        capturedStdout += chunk;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => {
        capturedStderr += chunk;
      });
      child.stdin?.end();
    } catch (error) {
      finish(error);
    }
  });
}

async function resolveExecutable(command, args) {
  if (process.platform !== 'win32') return { command, args };
  const base = path.basename(command).toLowerCase().replace(/\.cmd$/, '');
  if (!['npm', 'pi'].includes(base)) return { command, args };
  const shimPath = path.extname(command).toLowerCase() === '.cmd' && path.isAbsolute(command)
    ? command
    : await findWindowsCommand(`${base}.cmd`);
  const body = await readFile(shimPath, 'utf8');
  const match = body.match(/"%dp0%\\([^"\r\n]+\.js)"\s+%\*/i);
  if (!match) throw new Error(`unsupported Windows command shim: ${base}.cmd`);
  const script = path.resolve(path.dirname(shimPath), fromPosix(match[1].replaceAll('\\', '/')));
  await assertPathExists(script, `${base} command entrypoint`);
  return { command: process.execPath, args: [script, ...args] };
}

async function findWindowsCommand(name) {
  const result = await runExternalDirect('where.exe', [name], {
    timeoutMs: 30_000,
    maxBuffer: 1024 * 1024
  });
  const selected = result.stdout.split(/\r?\n/).find(Boolean);
  if (result.exitCode !== 0 || !selected) throw new Error(`${name} was not found on PATH`);
  return selected.trim();
}

function withoutOutput(result) {
  return {
    command: path.basename(result.command),
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    duration_ms: result.durationMs
  };
}

async function assertFreshOutput(outDir) {
  try {
    await stat(outDir);
    throw new Error('output directory already exists; choose a new disposable path');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertPathExists(target, label) {
  try {
    await stat(target);
  } catch {
    throw new Error(`${label} does not exist`);
  }
}

function pathsOverlap(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

function isDescendant(root, candidate) {
  const relative = path.relative(normalizePath(root), normalizePath(candidate));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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

function safeModel(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(String(value ?? ''));
}

function safeId(value) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(value ?? ''));
}

function safePathSegment(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(String(value ?? ''));
}

function fullCommit(value) {
  return /^[0-9a-f]{40}$/.test(String(value ?? ''));
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
  return createHash('sha256').update(value).digest('hex');
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

function gitArgs(...args) {
  return ['-c', 'core.longpaths=true', ...args];
}

function supportedHiddenGrader(value) {
  return value.endsWith('.mjs') || value.endsWith('.php') || value.endsWith('_test.go');
}

function parseCliArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--catalog') parsed.catalogPath = args[++index];
    else if (token === '--run-id') parsed.runId = args[++index];
    else if (token === '--references-root') parsed.referencesRoot = args[++index];
    else if (token === '--ponytail-root') parsed.ponytailRoot = args[++index];
    else if (token === '--out') parsed.outDir = args[++index];
    else if (token === '--provider') parsed.provider = args[++index];
    else if (token === '--model') parsed.model = args[++index];
    else if (token === '--thinking') parsed.thinking = args[++index];
    else if (token === '--pi-command') parsed.piCommand = args[++index];
    else if (token === '--dry-run') parsed.dryRun = true;
    else if (token === '--check-runtime') parsed.checkRuntime = true;
    else if (token === '--execute') parsed.execute = true;
    else if (token === '--json') parsed.json = true;
    else if (token === '--help' || token === '-h') parsed.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/ponytail-pi-ab.mjs --run-id <id> [options]',
    '',
    'Options:',
    `  --catalog <file>          Catalog JSON. Default: ${toPosix(path.relative(REPO_ROOT, DEFAULT_CATALOG))}.`,
    '  --references-root <dir>  Root containing clean passkey, yougile-mcp, and cutcode-shop snapshots.',
    '  --ponytail-root <dir>     Clean Ponytail v4.9.0 source snapshot.',
    '  --out <dir>               New disposable output directory.',
    '  --provider <id>           Override the pinned provider.',
    '  --model <id>              Override the pinned model.',
    '  --thinking <level>        Override the pinned thinking level.',
    '  --dry-run                 Validate and build the in-memory paired matrix only.',
    '  --check-runtime            Verify pinned Pi, model, and auth without an inference call.',
    '  --execute                 Run Pi and independent graders after preparation.',
    '  --pi-command <path>       Pi executable. Default: pi.',
    '  --json                    Print a machine-readable summary.',
    ''
  ].join('\n');
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  if (!parsed.runId) throw new Error('--run-id is required');
  if (parsed.execute && parsed.dryRun) throw new Error('--execute and --dry-run cannot be combined');
  if (parsed.execute && parsed.checkRuntime) throw new Error('--execute and --check-runtime cannot be combined');
  if (parsed.checkRuntime) {
    const checked = await preparePonytailPiMatrix({ ...parsed, dryRun: true });
    const runtime = await checkPonytailPiRuntime(checked.matrix, { piCommand: parsed.piCommand ?? 'pi' });
    const body = { schema: PONYTAIL_PI_AB_MATRIX_SCHEMA, run_id: checked.matrix.run_id, ...runtime };
    process.stdout.write(parsed.json ? `${JSON.stringify(body, null, 2)}\n` : `${runtime.provider}/${runtime.model}: available.\n`);
    return;
  }
  const prepared = await preparePonytailPiMatrix(parsed);
  const executed = parsed.execute
    ? await executePonytailPiMatrix(prepared, { piCommand: parsed.piCommand ?? 'pi' })
    : null;
  const body = executed ?? {
    schema: PONYTAIL_PI_AB_MATRIX_SCHEMA,
    run_id: prepared.matrix.run_id,
    cases: prepared.matrix.cases.length,
    prepared_cases: prepared.prepared_cases,
    dry_run: prepared.dry_run,
    provider: prepared.matrix.provider,
    model: prepared.matrix.model,
    thinking: prepared.matrix.thinking
  };
  process.stdout.write(parsed.json ? `${JSON.stringify(body, null, 2)}\n` : `${prepared.matrix.run_id}: ${prepared.matrix.cases.length} cases ready.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
