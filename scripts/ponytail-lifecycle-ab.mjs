// ponytail-lifecycle-ab.mjs - isolated Pi A/B runner for AIFHub lifecycle command parity
// (/aif-review, /aif-security-checklist, /aif-verify, /aif-fix) with and without Ponytail.
// Implementation-only proxy evidence: does not execute the AIFHub extension host commands.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  checkPonytailPiRuntime,
  cloneGitSnapshot,
  runExternal,
  summarizePiJson,
  verifyGitSnapshot
} from './ponytail-pi-ab.mjs';

export const PONYTAIL_LIFECYCLE_AB_CATALOG_SCHEMA = 'aifhub.ponytail_lifecycle_ab.catalog.v1';
export const PONYTAIL_LIFECYCLE_AB_MATRIX_SCHEMA = 'aifhub.ponytail_lifecycle_ab.matrix.v1';
export const PONYTAIL_LIFECYCLE_AB_RESULTS_SCHEMA = 'aifhub.ponytail_lifecycle_ab.results.v1';
export const PONYTAIL_LIFECYCLE_CONDITIONS = ['baseline', 'ponytail_full'];
export const LIFECYCLE_COMMANDS = ['review', 'security', 'verify', 'fix'];
export const LIFECYCLE_SHAPES = ['review-parity', 'security-parity', 'verify-parity', 'fix-parity'];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOG = path.join(
  REPO_ROOT,
  'docs',
  'skill-providers-research',
  'ponytail-lifecycle-ab',
  'scenario-catalog.json'
);
const GRADER_ROOT = path.join(REPO_ROOT, 'scripts', 'fixtures', 'ponytail-lifecycle-ab');

export function lifecycleCommandInvocation(scenario) {
  if (scenario.command === 'review') return '/aif-review';
  if (scenario.command === 'security') return '/aif-security-checklist';
  if (scenario.command === 'verify') return `/aif-verify ${scenario.change_id}`;
  if (scenario.command === 'fix') return `/aif-fix ${scenario.change_id}`;
  throw new Error(`unsupported lifecycle command ${scenario.command}`);
}

export async function loadLifecycleCatalog({ catalogPath = DEFAULT_CATALOG, cwd = process.cwd() } = {}) {
  const resolved = path.resolve(cwd, catalogPath);
  const catalog = JSON.parse(await readFile(resolved, 'utf8'));
  return { ...catalog, source_path: toPosix(path.relative(REPO_ROOT, resolved)) };
}

export function validateLifecycleCatalog(catalog = {}) {
  const errors = [];
  if (catalog.schema !== PONYTAIL_LIFECYCLE_AB_CATALOG_SCHEMA) {
    errors.push(`schema must be ${PONYTAIL_LIFECYCLE_AB_CATALOG_SCHEMA}`);
  }
  const defaults = catalog.defaults ?? {};
  if (defaults.runtime !== 'pi') errors.push('defaults.runtime must be pi');
  if (!safeToken(defaults.runtime_version)) errors.push('defaults.runtime_version must be a safe version');
  if (!safeToken(defaults.provider)) errors.push('defaults.provider must be a safe provider id');
  if (!safeModel(defaults.model)) errors.push('defaults.model must be a safe model id');
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(defaults.thinking)) {
    errors.push('defaults.thinking must be a supported Pi thinking level');
  }
  if (!sameOrderedValues(defaults.conditions, PONYTAIL_LIFECYCLE_CONDITIONS)) {
    errors.push(`defaults.conditions must be ${PONYTAIL_LIFECYCLE_CONDITIONS.join(', ')}`);
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
    if (asArray(fixture.dependency_files).some((item) => !safeRelativePath(item))) {
      errors.push(`${prefix}.dependency_files contains an unsafe path`);
    }
  }

  const scenarios = asArray(catalog.scenarios);
  if (scenarios.length < LIFECYCLE_COMMANDS.length) {
    errors.push(`scenarios must cover at least ${LIFECYCLE_COMMANDS.length} lifecycle commands`);
  }
  const scenarioIds = new Set();
  const seenCommands = new Set();
  for (const [index, scenario] of scenarios.entries()) {
    const prefix = `scenarios[${index}]`;
    if (!safeId(scenario.id)) errors.push(`${prefix}.id must be lowercase kebab-safe`);
    if (scenarioIds.has(scenario.id)) errors.push(`${prefix}.id duplicates ${scenario.id}`);
    scenarioIds.add(scenario.id);
    if (!fixtureIds.has(scenario.fixture_id)) errors.push(`${prefix}.fixture_id is unknown`);
    if (!LIFECYCLE_COMMANDS.includes(scenario.command)) {
      errors.push(`${prefix}.command must be one of ${LIFECYCLE_COMMANDS.join(', ')}`);
    } else {
      seenCommands.add(scenario.command);
    }
    if (!LIFECYCLE_SHAPES.includes(scenario.shape)) errors.push(`${prefix}.shape is unsupported`);
    const expectedShape = `${scenario.command}-parity`;
    if (LIFECYCLE_SHAPES.includes(scenario.shape) && scenario.shape !== expectedShape) {
      errors.push(`${prefix}.shape must be ${expectedShape} for command ${scenario.command}`);
    }
    if (!safeId(scenario.change_id)) errors.push(`${prefix}.change_id must be lowercase kebab-safe`);
    if (!String(scenario.title ?? '').trim()) errors.push(`${prefix}.title must not be empty`);
    if (!safeRelativePath(scenario.command_skill)) errors.push(`${prefix}.command_skill must be repository-relative`);
    if (!safeRelativePath(scenario.seeded_patch)) errors.push(`${prefix}.seeded_patch must be repository-relative`);
    if (!safePathSegment(scenario.hidden_grader) || !scenario.hidden_grader.endsWith('.mjs')) {
      errors.push(`${prefix}.hidden_grader must be one safe .mjs filename`);
    }
    if (scenario.qa_evidence !== undefined) {
      if (scenario.command !== 'fix') errors.push(`${prefix}.qa_evidence is only allowed for the fix command`);
      else if (!safeRelativePath(scenario.qa_evidence)) errors.push(`${prefix}.qa_evidence must be repository-relative`);
    } else if (scenario.command === 'fix') {
      errors.push(`${prefix}.qa_evidence is required for the fix command`);
    }
    for (const [groupIndex, group] of asArray(scenario.keywords).entries()) {
      if (!Array.isArray(group) || group.length === 0 || group.some((item) => typeof item !== 'string')) {
        errors.push(`${prefix}.keywords[${groupIndex}] must be a non-empty list of strings`);
      }
    }
  }
  for (const command of LIFECYCLE_COMMANDS) {
    if (!seenCommands.has(command)) errors.push(`scenarios must cover the ${command} command`);
  }
  return errors;
}

export function buildLifecycleMatrix({
  catalog,
  runId,
  provider = catalog?.defaults?.provider,
  model = catalog?.defaults?.model,
  thinking = catalog?.defaults?.thinking,
  generatedAt = new Date().toISOString()
} = {}) {
  const errors = validateLifecycleCatalog(catalog);
  if (errors.length > 0) throw new Error(`Invalid lifecycle catalog: ${errors.join('; ')}`);
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
    const scenarioFingerprint = sha256(stableStringify({
      fixture_commit: fixture.source_commit,
      command: scenario.command,
      change_id: scenario.change_id,
      command_skill: scenario.command_skill,
      seeded_patch: scenario.seeded_patch,
      qa_evidence: scenario.qa_evidence ?? null,
      hidden_grader: scenario.hidden_grader
    }));
    const settingsFingerprint = sha256(stableStringify({
      runtime: catalog.defaults.runtime,
      runtime_version: catalog.defaults.runtime_version,
      provider,
      model,
      thinking,
      tools: catalog.defaults.tools,
      timeout_seconds: catalog.defaults.timeout_seconds,
      scenario_fingerprint: scenarioFingerprint
    }));

    for (let repetition = 1; repetition <= catalog.defaults.repetitions; repetition += 1) {
      const repetitionId = `r${String(repetition).padStart(2, '0')}`;
      const pairId = `${runId}__${scenario.id}__${repetitionId}`;
      const conditionOrder = repetition % 2 === 1
        ? PONYTAIL_LIFECYCLE_CONDITIONS
        : [...PONYTAIL_LIFECYCLE_CONDITIONS].reverse();
      for (const condition of conditionOrder) {
        const id = `${pairId}__${condition}`;
        cases.push({
          id,
          pair_id: pairId,
          scenario_id: scenario.id,
          fixture_id: fixture.id,
          fixture_source_directory: fixture.source_directory,
          fixture_commit: fixture.source_commit,
          dependency_files: [...fixture.dependency_files],
          shape: scenario.shape,
          command: scenario.command,
          change_id: scenario.change_id,
          command_invocation: lifecycleCommandInvocation(scenario),
          repetition,
          condition,
          runtime: catalog.defaults.runtime,
          runtime_version: catalog.defaults.runtime_version,
          provider,
          model,
          thinking,
          tools: [...catalog.defaults.tools],
          timeout_seconds: catalog.defaults.timeout_seconds,
          command_skill: scenario.command_skill,
          seeded_patch: scenario.seeded_patch,
          qa_evidence: scenario.qa_evidence ?? null,
          hidden_grader: scenario.hidden_grader,
          scenario_fingerprint: scenarioFingerprint,
          settings_fingerprint: settingsFingerprint,
          case_path: toPosix(path.join('cases', id)),
          project_path: toPosix(path.join('cases', id, 'project'))
        });
      }
    }
  }

  return {
    schema: PONYTAIL_LIFECYCLE_AB_MATRIX_SCHEMA,
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
    conditions: [...PONYTAIL_LIFECYCLE_CONDITIONS],
    ponytail: structuredClone(catalog.ponytail),
    cases
  };
}

export function renderCasePrompt(matrixCase) {
  const lines = [
    'You are in a disposable Git copy created for a controlled AIFHub lifecycle benchmark.',
    'Read and write only inside the current project directory. Do not inspect parent or sibling directories.',
    'Do not commit, amend, reset, checkout another revision, or change Git configuration.',
    `Execute the AIFHub lifecycle command \`${matrixCase.command_invocation}\` now, exactly as specified by the loaded AIFHub command skill.`,
    'The AIFHub extension helper scripts are not installed in this copy; degrade gracefully instead of searching for them.',
    'Do not ask questions. Stop after producing the command output.'
  ];
  if (matrixCase.condition === 'ponytail_full') {
    lines.push('Use the explicitly loaded Ponytail skill in full mode while executing this lifecycle command.');
  }
  return lines.join('\n');
}

export function buildLifecycleInvocation(matrixCase, { commandSkillPath, ponytailSkillPath }) {
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
    '--exclude-tools', 'ask_question',
    '--skill', commandSkillPath
  ];
  if (matrixCase.condition === 'ponytail_full') {
    if (!ponytailSkillPath) throw new Error('ponytailSkillPath is required for the ponytail_full condition');
    args.push('--skill', ponytailSkillPath);
  }
  args.push('--', renderCasePrompt(matrixCase));
  return { command: 'pi', args };
}

export function rewriteCommandSkillFrontmatter(sourceText) {
  const match = sourceText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  let name = 'aifhub-lifecycle-command-skill';
  let description = 'AIFHub lifecycle command skill pinned for a controlled benchmark.';
  let body = sourceText;
  if (match) {
    body = sourceText.slice(match[0].length);
    const nameMatch = match[1].match(/^name:\s*(.+)$/m);
    if (nameMatch) name = nameMatch[1].trim();
    const descriptionMatch = match[1].match(/^description:\s*(.+)$/m);
    if (descriptionMatch) description = descriptionMatch[1].trim();
  }
  if (!safeToken(name)) throw new Error('command skill name must be a safe token');
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

async function copyCanonicalTree({ repoRoot, projectRoot, matrixCase }) {
  const canonicalRoot = path.join(repoRoot, 'scripts', 'fixtures', 'ponytail-lifecycle-ab', 'canonical', matrixCase.change_id);
  await mkdir(path.join(projectRoot, '.ai-factory'), { recursive: true });
  await copyFile(path.join(canonicalRoot, 'config.yaml'), path.join(projectRoot, '.ai-factory', 'config.yaml'));
  const changeRoot = path.join(projectRoot, 'openspec', 'changes', matrixCase.change_id);
  await mkdir(changeRoot, { recursive: true });
  for (const fileName of ['proposal.md', 'design.md', 'tasks.md']) {
    await copyFile(path.join(canonicalRoot, fileName), path.join(changeRoot, fileName));
  }
  await copyDirectory(path.join(canonicalRoot, 'specs'), path.join(changeRoot, 'specs'));
  if (matrixCase.qa_evidence) {
    const qaTarget = path.join(projectRoot, '.ai-factory', 'qa', matrixCase.change_id);
    await mkdir(qaTarget, { recursive: true });
    await copyFile(path.join(repoRoot, fromPosix(matrixCase.qa_evidence)), path.join(qaTarget, 'verify.md'));
  }
}

async function copyDirectory(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDirectory(sourcePath, targetPath);
    else await copyFile(sourcePath, targetPath);
  }
}

async function gitWorktreeState(projectRoot, commit) {
  const porcelain = await runExternal('git', gitArgs('status', '--porcelain=v1', '--untracked-files=all'), {
    cwd: projectRoot,
    timeoutMs: 60_000
  });
  const diff = await runExternal('git', gitArgs('diff', commit, '--'), {
    cwd: projectRoot,
    timeoutMs: 60_000
  });
  if (porcelain.exitCode !== 0) throw new Error('git status failed while seeding the case');
  if (diff.exitCode !== 0) throw new Error('git diff failed while seeding the case');
  const names = await runExternal('git', gitArgs('diff', '--name-only', commit, '--'), {
    cwd: projectRoot,
    timeoutMs: 60_000
  });
  if (names.exitCode !== 0) throw new Error('git diff --name-only failed while seeding the case');
  return {
    porcelain: porcelain.stdout,
    diff: diff.stdout,
    changedFiles: names.stdout.split(/\r?\n/).filter(Boolean),
    fingerprint: sha256(`${porcelain.stdout}\u0000${diff.stdout}`)
  };
}

export async function preparePonytailLifecycleMatrix({
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
  const catalog = await loadLifecycleCatalog({ catalogPath, cwd });
  const matrix = buildLifecycleMatrix({ catalog, runId, provider, model, thinking });
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
  const sourcePonytailSkill = path.join(canonicalPonytail, fromPosix(catalog.ponytail.skill_path));
  await assertPathExists(sourcePonytailSkill, 'Ponytail skill');
  const copiedPonytailSkillSha256 = sha256(await readFile(sourcePonytailSkill));

  for (const matrixCase of matrix.cases) {
    const caseRoot = path.join(canonicalOut, fromPosix(matrixCase.case_path));
    const projectRoot = path.join(canonicalOut, fromPosix(matrixCase.project_path));
    await mkdir(caseRoot, { recursive: true });
    await cloneSnapshotFn(fixtureSources.get(matrixCase.fixture_id), projectRoot, matrixCase.fixture_commit);

    await copyCanonicalTree({ repoRoot: REPO_ROOT, projectRoot, matrixCase });

    const seededPatchPath = path.join(REPO_ROOT, fromPosix(matrixCase.seeded_patch));
    await assertPathExists(seededPatchPath, `seeded patch ${matrixCase.seeded_patch}`);
    const patchApply = await runExternal('git', gitArgs('apply', '--whitespace=nowarn', seededPatchPath), {
      cwd: projectRoot,
      timeoutMs: 60_000
    });
    if (patchApply.exitCode !== 0) {
      throw new Error(`seeded patch failed to apply for ${matrixCase.id}: ${patchApply.stderr.trim()}`);
    }

    const commandSkillSource = await readFile(path.join(REPO_ROOT, fromPosix(matrixCase.command_skill)), 'utf8');
    const commandSkillPath = path.join(caseRoot, 'treatment', 'command-skill', 'SKILL.md');
    await mkdir(path.dirname(commandSkillPath), { recursive: true });
    await writeFile(commandSkillPath, rewriteCommandSkillFrontmatter(commandSkillSource), 'utf8');

    let ponytailSkillPath = null;
    if (matrixCase.condition === 'ponytail_full') {
      ponytailSkillPath = path.join(caseRoot, 'treatment', 'ponytail', 'SKILL.md');
      await mkdir(path.dirname(ponytailSkillPath), { recursive: true });
      await copyFile(sourcePonytailSkill, ponytailSkillPath);
    }

    const invocation = buildLifecycleInvocation(matrixCase, { commandSkillPath, ponytailSkillPath });
    await writeFile(path.join(caseRoot, 'prompt.md'), `${renderCasePrompt(matrixCase)}\n`, 'utf8');
    await writeFile(path.join(caseRoot, 'invocation.json'), `${JSON.stringify({
      command: invocation.command,
      args: invocation.args,
      cwd: '<case-root>/project'
    }, null, 2)}\n`, 'utf8');

    if (matrixCase.qa_evidence) {
      const evidencePath = path.join(projectRoot, '.ai-factory', 'qa', matrixCase.change_id, 'verify.md');
      const evidenceSha = sha256(await readFile(evidencePath));
      await writeFile(path.join(caseRoot, 'treatment', 'verify-evidence.sha256'), `${evidenceSha}\n`, 'utf8');
    }

    const seededState = await gitWorktreeState(projectRoot, matrixCase.fixture_commit);
    await writeFile(path.join(caseRoot, 'seeded-diff.txt'), seededState.diff, 'utf8');
    await writeFile(path.join(caseRoot, 'current-diff.txt'), seededState.diff, 'utf8');
    await writeFile(path.join(caseRoot, 'seeded-state.json'), `${JSON.stringify({
      fingerprint: seededState.fingerprint,
      porcelain: seededState.porcelain,
      changedFiles: seededState.changedFiles
    }, null, 2)}\n`, 'utf8');
  }

  const summary = {
    ...matrix,
    ponytail: {
      ...matrix.ponytail,
      copied_skill_sha256: copiedPonytailSkillSha256
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

async function collectLifecycleMetrics(projectRoot, commit, dependencyFiles) {
  const [head, statusResult, numstatResult, namesResult] = await Promise.all([
    runExternal('git', gitArgs('rev-parse', 'HEAD'), { cwd: projectRoot, timeoutMs: 30_000 }),
    runExternal('git', gitArgs('status', '--porcelain=v1', '--untracked-files=all'), { cwd: projectRoot, timeoutMs: 30_000 }),
    runExternal('git', gitArgs('diff', '--numstat', commit, '--'), { cwd: projectRoot, timeoutMs: 30_000 }),
    runExternal('git', gitArgs('diff', '--name-only', commit, '--'), { cwd: projectRoot, timeoutMs: 30_000 })
  ]);
  const headUnchanged = head.exitCode === 0 && head.stdout.trim() === commit;
  const changedFiles = namesResult.stdout.split(/\r?\n/).filter(Boolean);
  const dependencySet = new Set(dependencyFiles);
  let sourceAdded = 0;
  let sourceDeleted = 0;
  for (const line of numstatResult.stdout.split(/\r?\n/).filter(Boolean)) {
    const [added, deleted] = line.split('\t');
    if (added !== '-') sourceAdded += Number(added);
    if (deleted !== '-') sourceDeleted += Number(deleted);
  }
  return {
    head_unchanged: headUnchanged,
    dependency_files_changed: changedFiles.some((file) => dependencySet.has(toPosix(file))),
    changed_files: changedFiles,
    source_loc_added: sourceAdded,
    source_loc_deleted: sourceDeleted,
    status_porcelain: statusResult.stdout
  };
}

function assertReadonlyIntegrity(matrixCase, seededState, metrics) {
  if (metrics.status_porcelain !== seededState.porcelain) {
    return 'the read-only sidecar modified the worktree (porcelain drift)';
  }
  return null;
}

function assertQaOnlyIntegrity(matrixCase, seededState, metrics) {
  const seededLines = new Set(seededState.porcelain.split(/\r?\n/).filter(Boolean));
  for (const line of metrics.status_porcelain.split(/\r?\n/).filter(Boolean)) {
    if (seededLines.has(line)) continue;
    const addition = line.match(/^(\?\?)\s+(.+)$/);
    if (!addition) return `verify wrote outside its QA write scope: ${line}`;
    const normalized = toPosix(addition[2].replace(/\/$/, ''));
    const qaPrefix = toPosix(path.join('.ai-factory', 'qa', matrixCase.change_id));
    if (!normalized.startsWith(`${qaPrefix}/`)) return `verify added a file outside .ai-factory/qa/${matrixCase.change_id}/: ${normalized}`;
  }
  return null;
}

function assertFindingScopeIntegrity(matrixCase, seededState, metrics) {
  const seededChanged = new Set(seededState.changedFiles.map((file) => toPosix(file)));
  for (const file of metrics.changed_files) {
    if (!seededChanged.has(toPosix(file))) {
      return `fix edited a file outside the seeded changed scope: ${file}`;
    }
  }
  const statePrefix = toPosix(path.join('.ai-factory', 'state', matrixCase.change_id));
  const seededLines = new Set(seededState.porcelain.split(/\r?\n/).filter(Boolean));
  for (const line of metrics.status_porcelain.split(/\r?\n/).filter(Boolean)) {
    if (seededLines.has(line)) continue;
    const addition = line.match(/^(\?\?)\s+(.+)$/);
    if (!addition) return `fix modified the worktree outside its allowed scope: ${line}`;
    const normalized = toPosix(addition[2].replace(/\/$/, ''));
    if (!normalized.startsWith(`${statePrefix}/`)) {
      return `fix added a file outside .ai-factory/state/${matrixCase.change_id}/: ${normalized}`;
    }
  }
  return null;
}

export async function executePonytailLifecycleMatrix(prepared, {
  piCommand = 'pi',
  allowUnlistedModel = false
} = {}) {
  if (!prepared?.out_dir || prepared.dry_run) throw new Error('a prepared matrix is required for execution');
  const matrix = prepared.matrix;
  const outDir = prepared.out_dir;
  await checkPonytailPiRuntime(matrix, { piCommand, allowUnlistedModel });

  const results = [];
  for (const matrixCase of matrix.cases) {
    const caseRoot = path.join(outDir, fromPosix(matrixCase.case_path));
    const projectRoot = path.join(outDir, fromPosix(matrixCase.project_path));
    const seededState = JSON.parse(await readFile(path.join(caseRoot, 'seeded-state.json'), 'utf8'));
    const commandSkillPath = path.join(caseRoot, 'treatment', 'command-skill', 'SKILL.md');
    const ponytailSkillPath = matrixCase.condition === 'ponytail_full'
      ? path.join(caseRoot, 'treatment', 'ponytail', 'SKILL.md')
      : null;
    const invocation = buildLifecycleInvocation(matrixCase, { commandSkillPath, ponytailSkillPath });
    const startedAt = new Date().toISOString();
    const piRun = await runExternal(piCommand, invocation.args, {
      cwd: projectRoot,
      timeoutMs: matrixCase.timeout_seconds * 1000,
      maxBuffer: 64 * 1024 * 1024
    });
    await writeFile(path.join(caseRoot, 'pi-events.jsonl'), piRun.stdout, 'utf8');
    await writeFile(path.join(caseRoot, 'pi-stderr.log'), piRun.stderr, 'utf8');

    const currentDiff = await runExternal('git', gitArgs('diff', matrixCase.fixture_commit, '--'), {
      cwd: projectRoot,
      timeoutMs: 60_000
    });
    await writeFile(path.join(caseRoot, 'current-diff.txt'), currentDiff.stdout, 'utf8');
    const diffCheck = await runExternal('git', gitArgs('diff', '--check', matrixCase.fixture_commit, '--'), {
      cwd: projectRoot,
      timeoutMs: 60_000
    });
    await writeCommandLogs(caseRoot, 'git-diff-check', diffCheck);

    const grader = path.join(GRADER_ROOT, matrixCase.hidden_grader);
    await assertPathExists(grader, `hidden grader ${matrixCase.hidden_grader}`);
    const graderRun = await runExternal(process.execPath, [grader, projectRoot], {
      cwd: projectRoot,
      timeoutMs: matrixCase.timeout_seconds * 1000
    });
    await writeCommandLogs(caseRoot, 'hidden-grader', graderRun);

    const metrics = await collectLifecycleMetrics(projectRoot, matrixCase.fixture_commit, matrixCase.dependency_files);

    let integrityViolation = null;
    if (matrixCase.command === 'review' || matrixCase.command === 'security') {
      integrityViolation = assertReadonlyIntegrity(matrixCase, { ...seededState }, metrics);
    } else if (matrixCase.command === 'verify') {
      integrityViolation = assertQaOnlyIntegrity(matrixCase, { ...seededState }, metrics)
        ?? (currentDiff.stdout !== seededState.diff ? 'verify modified tracked files' : null);
    } else if (matrixCase.command === 'fix') {
      integrityViolation = assertFindingScopeIntegrity(matrixCase, { ...seededState, changedFiles: seededState.changedFiles }, metrics)
        ?? (diffCheck.exitCode !== 0 ? 'git diff --check reported whitespace errors' : null)
        ?? (!metrics.head_unchanged ? 'the fixer moved or recommitted HEAD' : null)
        ?? (metrics.dependency_files_changed ? 'the fixer changed dependency files' : null);
    }

    let commandSkillIntact = true;
    try {
      const sourceText = await readFile(path.join(REPO_ROOT, fromPosix(matrixCase.command_skill)), 'utf8');
      commandSkillIntact = sha256(await readFile(commandSkillPath)) === sha256(Buffer.from(rewriteCommandSkillFrontmatter(sourceText), 'utf8'));
    } catch {
      commandSkillIntact = false;
    }
    let ponytailSourceIntact = true;
    if (prepared.source_roots?.ponytail) {
      try {
        await verifyGitSnapshot(prepared.source_roots.ponytail, matrix.ponytail.source_commit, 'Ponytail source');
      } catch {
        ponytailSourceIntact = false;
      }
    }
    let treatmentResourceIntact = true;
    if (matrixCase.condition === 'ponytail_full') {
      treatmentResourceIntact = sha256(await readFile(ponytailSkillPath)) === matrix.ponytail.copied_skill_sha256;
    }
    let sourceSnapshotIntact = true;
    if (prepared.source_roots?.references) {
      try {
        await verifyGitSnapshot(
          path.join(prepared.source_roots.references, matrixCase.fixture_source_directory),
          matrixCase.fixture_commit,
          `reference ${matrixCase.fixture_id}`
        );
      } catch {
        sourceSnapshotIntact = false;
      }
    }

    const result = {
      schema: PONYTAIL_LIFECYCLE_AB_RESULTS_SCHEMA,
      case_id: matrixCase.id,
      pair_id: matrixCase.pair_id,
      scenario_id: matrixCase.scenario_id,
      command: matrixCase.command,
      condition: matrixCase.condition,
      repetition: matrixCase.repetition,
      started_at: startedAt,
      duration_ms: piRun.durationMs,
      pi: {
        exit_code: piRun.exitCode,
        timed_out: piRun.timedOut,
        usage: summarizePiJson(piRun.stdout)
      },
      commands: [
        { kind: 'hidden-grader', command: path.basename(process.execPath), exit_code: graderRun.exitCode, timed_out: graderRun.timedOut, duration_ms: graderRun.durationMs },
        { kind: 'git-diff-check', command: 'git', exit_code: diffCheck.exitCode, timed_out: diffCheck.timedOut, duration_ms: diffCheck.durationMs }
      ],
      hidden_grader: withoutOutput(graderRun),
      integrity_violation: integrityViolation,
      diff_check_pass: diffCheck.exitCode === 0,
      source_snapshot_intact: sourceSnapshotIntact,
      ponytail_source_intact: ponytailSourceIntact,
      treatment_resource_intact: treatmentResourceIntact,
      command_skill_intact: commandSkillIntact,
      metrics: {
        head_unchanged: metrics.head_unchanged,
        dependency_files_changed: metrics.dependency_files_changed,
        changed_files: metrics.changed_files,
        source_loc_added: metrics.source_loc_added,
        source_loc_deleted: metrics.source_loc_deleted
      },
      task_pass: piRun.exitCode === 0
        && !piRun.timedOut
        && graderRun.exitCode === 0
        && !graderRun.timedOut
        && diffCheck.exitCode === 0
        && integrityViolation === null
        && sourceSnapshotIntact
        && ponytailSourceIntact
        && treatmentResourceIntact
        && commandSkillIntact
        && metrics.head_unchanged
        && !metrics.dependency_files_changed
    };
    results.push(result);
    await writeFile(path.join(caseRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeAggregate(outDir, matrix, results);
  }
  return writeAggregate(outDir, matrix, results);
}

async function writeAggregate(outDir, matrix, results) {
  const completePairCount = [...new Set(results.map((item) => item.pair_id))]
    .filter((pairId) => results.filter((item) => item.pair_id === pairId).length === PONYTAIL_LIFECYCLE_CONDITIONS.length)
    .length;
  const perScenario = {};
  for (const scenarioId of [...new Set(matrix.cases.map((item) => item.scenario_id))]) {
    perScenario[scenarioId] = Object.fromEntries(PONYTAIL_LIFECYCLE_CONDITIONS.map((condition) => [
      condition,
      results.filter((item) => item.scenario_id === scenarioId && item.condition === condition && item.task_pass).length
    ]));
  }
  const aggregate = {
    schema: PONYTAIL_LIFECYCLE_AB_RESULTS_SCHEMA,
    run_id: matrix.run_id,
    provider: matrix.provider,
    model: matrix.model,
    thinking: matrix.thinking,
    expected_cases: matrix.cases.length,
    completed_cases: results.length,
    complete_pairs: completePairCount,
    pass_by_condition: Object.fromEntries(PONYTAIL_LIFECYCLE_CONDITIONS.map((condition) => [
      condition,
      results.filter((item) => item.condition === condition && item.task_pass).length
    ])),
    pass_by_scenario: perScenario,
    results
  };
  await writeFile(path.join(outDir, 'aggregate.json'), `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
  return aggregate;
}

async function writeCommandLogs(caseRoot, stem, result) {
  await writeFile(path.join(caseRoot, `${stem}.stdout.log`), result.stdout, 'utf8');
  await writeFile(path.join(caseRoot, `${stem}.stderr.log`), result.stderr, 'utf8');
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
    await realpath(outDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`output directory must not exist: ${outDir}`);
}

async function assertPathExists(target, label) {
  try {
    await realpath(target);
  } catch {
    throw new Error(`${label} does not exist: ${target}`);
  }
}

function pathsOverlap(left, right) {
  return isDescendant(left, right) || isDescendant(right, left);
}

function isDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function safeRelativePath(value) {
  const posix = String(value ?? '');
  if (!posix || posix.startsWith('/') || posix.includes('..')) return false;
  return posix.split('/').every((segment) => safePathSegment(segment));
}

function fullCommit(value) {
  return /^[0-9a-f]{40}$/.test(String(value ?? ''));
}

function sameOrderedValues(actual, expected) {
  return Array.isArray(actual)
    && Array.isArray(expected)
    && actual.length === expected.length
    && expected.every((item, index) => actual[index] === item);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
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
    else if (token === '--allow-unlisted-model') parsed.allowUnlistedModel = true;
    else if (token === '--execute') parsed.execute = true;
    else if (token === '--json') parsed.json = true;
    else if (token === '--help' || token === '-h') parsed.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/ponytail-lifecycle-ab.mjs --run-id <id> [options]',
    '',
    'Options:',
    `  --catalog <file>          Catalog JSON. Default: ${toPosix(path.relative(REPO_ROOT, DEFAULT_CATALOG))}.`,
    '  --references-root <dir>  Root containing clean passkey and cutcode-shop snapshots.',
    '  --ponytail-root <dir>     Clean Ponytail v4.9.0 source snapshot.',
    '  --out <dir>               New disposable output directory.',
    '  --provider <id>           Override the pinned provider.',
    '  --model <id>              Override the pinned model.',
    '  --thinking <level>        Override the pinned thinking level.',
    '  --dry-run                 Validate and build the in-memory paired matrix only.',
    '  --check-runtime            Verify pinned Pi, model, and auth without an inference call.',
    '  --allow-unlisted-model     Allow an explicit custom model ID absent from Pi\'s static catalog.',
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
  if (parsed.allowUnlistedModel && !parsed.model) {
    throw new Error('--allow-unlisted-model requires an explicit --model');
  }
  if (parsed.execute && parsed.dryRun) throw new Error('--execute and --dry-run cannot be combined');
  if (parsed.execute && parsed.checkRuntime) throw new Error('--execute and --check-runtime cannot be combined');
  if (parsed.checkRuntime) {
    const checked = await preparePonytailLifecycleMatrix({ ...parsed, dryRun: true });
    const runtime = await checkPonytailPiRuntime(checked.matrix, {
      piCommand: parsed.piCommand ?? 'pi',
      allowUnlistedModel: parsed.allowUnlistedModel ?? false
    });
    const body = { schema: PONYTAIL_LIFECYCLE_AB_MATRIX_SCHEMA, run_id: checked.matrix.run_id, ...runtime };
    process.stdout.write(parsed.json ? `${JSON.stringify(body, null, 2)}\n` : `${runtime.provider}/${runtime.model}: available.\n`);
    return;
  }
  const prepared = await preparePonytailLifecycleMatrix(parsed);
  const executed = parsed.execute
    ? await executePonytailLifecycleMatrix(prepared, {
      piCommand: parsed.piCommand ?? 'pi',
      allowUnlistedModel: parsed.allowUnlistedModel ?? false
    })
    : null;
  const body = executed ?? {
    schema: PONYTAIL_LIFECYCLE_AB_MATRIX_SCHEMA,
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
