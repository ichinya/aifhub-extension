import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const REVIEWED_OUTPUT_GRAPH_SCHEMA = 'aifhub.understand_anything.reviewed_graph.v1';
export const REVIEWED_OUTPUT_CONTEXT_SCHEMA = 'aifhub.understand_anything.reviewed_output_context.v1';
export const REVIEWED_OUTPUT_PROVENANCE_SCHEMA = 'aifhub.understand_anything.reviewed_output_provenance.v1';
export const REVIEWED_OUTPUT_FIXTURE_MANIFEST_SCHEMA = 'aifhub.understand_anything.synthetic_fixture_manifest.v1';
export const REVIEWED_OUTPUT_FIXTURE_INDEX_SCHEMA = 'aifhub.understand_anything.synthetic_fixture_index.v1';
export const REVIEWED_OUTPUT_EXPECTED_CONTEXTS_SCHEMA = 'aifhub.understand_anything.synthetic_expected_contexts.v1';
export const PINNED_PROVIDER_REVISION = 'f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8';
export const MAX_GRAPH_BYTES = 262144;

const STRUCTURAL_TOKEN_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9._:@-]*$/;
const PACKAGE_NAME_PATTERN = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_STRUCTURAL_TOKEN_LENGTH = 128;
const MAX_PACKAGE_NAME_LENGTH = 214;

const GRAPH_TOP_LEVEL_KEYS = new Set([
  'schema',
  'project',
  'files',
  'components',
  'impacts',
  'workspace_imports',
  'incremental',
  'metrics'
]);
const MANIFEST_TOP_LEVEL_KEYS = new Set([
  'schema',
  'fixture_id',
  'scenario_id',
  'project',
  'expected'
]);
const ALLOWED_PROJECT_KEYS = new Set(['id', 'revision']);
const ALLOWED_FILE_KEYS = new Set(['id', 'path', 'role']);
const ALLOWED_COMPONENT_KEYS = new Set(['id', 'kind', 'file_paths']);
const ALLOWED_IMPACT_KEYS = new Set(['id', 'direct_paths', 'transitive_paths']);
const ALLOWED_IMPORT_KEYS = new Set(['importer_path', 'package_name', 'resolved_path']);
const ALLOWED_INCREMENTAL_KEYS = new Set(['from_revision', 'to_revision', 'added_imports']);
const ALLOWED_METRIC_KEYS = new Set([
  'file_count',
  'component_count',
  'impact_count',
  'workspace_import_count',
  'incremental_import_count'
]);
const ALLOWED_EXPECTED_KEYS = new Set([
  'required_files',
  'required_components',
  'allowed_component_ids',
  'required_impacts',
  'required_workspace_imports',
  'required_incremental_imports'
]);

export async function loadReviewedOutputFixture(options = {}) {
  const fileOps = createFileOps(options.fileOps);
  const fixtureRoot = await resolveExistingDirectory(
    path.resolve(options.fixtureRoot ?? process.cwd()),
    fileOps,
    'fixture root'
  );
  const projectRoot = await resolveExistingDirectory(
    path.resolve(fixtureRoot, options.projectRoot ?? 'project'),
    fileOps,
    'project root'
  );
  const graphPath = resolveDescendantPath(fixtureRoot, options.graphPath ?? 'graph.json', 'graph path');
  const manifestPath = resolveDescendantPath(fixtureRoot, options.manifestPath ?? 'manifest.json', 'manifest path');
  const maxGraphBytes = options.maxGraphBytes ?? MAX_GRAPH_BYTES;

  const graph = await readJsonFile(graphPath, fileOps, {
    label: 'graph',
    maxBytes: maxGraphBytes
  });
  const manifest = await readJsonFile(manifestPath, fileOps, {
    label: 'manifest'
  });

  rejectSelfDeclaredProvenance(graph, 'graph');
  rejectSelfDeclaredProvenance(manifest, 'manifest');
  validateGraphSchema(graph);
  validateManifestSchema(manifest);
  validateProjectIdentity(graph.project, manifest.project);

  const compact = await buildCompactContext({
    fixtureRoot,
    projectRoot,
    graph,
    manifest,
    fileOps
  });
  const provenance = validateProvenanceEnvelope({
    graph,
    manifest,
    provenance: options.provenance,
    pinnedRevision: options.pinnedRevision ?? PINNED_PROVIDER_REVISION
  });

  logFix('debug', 'reviewed-output.accepted', {
    fixture_id: manifest.fixture_id,
    scenario_id: manifest.scenario_id,
    files: compact.files.length,
    components: compact.components.length
  });

  return {
    schema: REVIEWED_OUTPUT_CONTEXT_SCHEMA,
    fixture_id: manifest.fixture_id,
    scenario_id: manifest.scenario_id,
    project: compact.project,
    files: compact.files,
    components: compact.components,
    impacts: compact.impacts,
    workspace_imports: compact.workspace_imports,
    incremental: compact.incremental,
    metrics: compact.metrics,
    fingerprints: {
      graph: fingerprintGraph(graph),
      fixture: fingerprintFixtureManifest(manifest)
    },
    provenance
  };
}

export function buildSyntheticProvenance({ graph, manifest, settingsFingerprint, runId }) {
  return buildProvenanceEnvelope({
    graph,
    manifest,
    settingsFingerprint,
    runId,
    className: 'synthetic_schema_fixture',
    purgeStatus: 'not_applicable',
    pinnedRevision: null
  });
}

export function buildProviderGeneratedProvenance({
  graph,
  manifest,
  settingsFingerprint,
  runId,
  purgeStatus = 'purge_pass',
  pinnedRevision = PINNED_PROVIDER_REVISION
}) {
  return buildProvenanceEnvelope({
    graph,
    manifest,
    settingsFingerprint,
    runId,
    className: 'provider_generated',
    purgeStatus,
    pinnedRevision
  });
}

export function validateProvenanceEnvelope({
  graph,
  manifest,
  provenance,
  pinnedRevision = PINNED_PROVIDER_REVISION
}) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw createAdapterError('missing_provenance', 'Provenance envelope is required.');
  }
  validateAllowedKeys(
    provenance,
    new Set([
      'schema',
      'class',
      'graph_fingerprint',
      'fixture_fingerprint',
      'settings_fingerprint',
      'project_id',
      'project_revision',
      'lifecycle'
    ]),
    'invalid_provenance_schema'
  );
  expectString(provenance.schema, 'provenance.schema');
  if (provenance.schema !== REVIEWED_OUTPUT_PROVENANCE_SCHEMA) {
    throw createAdapterError('invalid_provenance_schema', 'Unexpected provenance schema.');
  }
  if (!['synthetic_schema_fixture', 'provider_generated'].includes(provenance.class)) {
    throw createAdapterError('invalid_provenance_class', 'Unsupported provenance class.');
  }

  const expectedGraphFingerprint = fingerprintGraph(graph);
  const expectedFixtureFingerprint = fingerprintFixtureManifest(manifest);
  if (provenance.graph_fingerprint !== expectedGraphFingerprint) {
    throw createAdapterError('mismatched_graph_fingerprint', 'Provenance graph fingerprint mismatch.');
  }
  if (provenance.fixture_fingerprint !== expectedFixtureFingerprint) {
    throw createAdapterError('mismatched_fixture_fingerprint', 'Provenance fixture fingerprint mismatch.');
  }
  if (!isSha256Fingerprint(provenance.settings_fingerprint)) {
    throw createAdapterError('invalid_settings_fingerprint', 'Provenance settings fingerprint must be sha256.');
  }
  if (provenance.project_id !== manifest.project.id) {
    throw createAdapterError('mismatched_project_identity', 'Provenance project id mismatch.');
  }
  if (provenance.project_revision !== manifest.project.revision) {
    throw createAdapterError('stale_project_revision', 'Provenance project revision mismatch.');
  }

  const lifecycle = provenance.lifecycle;
  if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) {
    throw createAdapterError('invalid_provenance_lifecycle', 'Provenance lifecycle block is required.');
  }
  validateAllowedKeys(
    lifecycle,
    new Set(['run_id', 'purge_status', 'pinned_revision']),
    'invalid_provenance_lifecycle'
  );
  expectStructuralToken(lifecycle.run_id, 'provenance.lifecycle.run_id');
  expectString(lifecycle.purge_status, 'provenance.lifecycle.purge_status');

  if (provenance.class === 'synthetic_schema_fixture') {
    if (lifecycle.purge_status !== 'not_applicable') {
      throw createAdapterError('invalid_synthetic_purge_linkage', 'Synthetic provenance must remain non-promotable.');
    }
    if (lifecycle.pinned_revision !== null) {
      throw createAdapterError('invalid_synthetic_revision_linkage', 'Synthetic provenance must not claim a pinned revision.');
    }
  }

  if (provenance.class === 'provider_generated') {
    if (lifecycle.purge_status !== 'purge_pass') {
      throw createAdapterError('invalid_provider_purge_linkage', 'Provider provenance requires purge_pass linkage.');
    }
    if (lifecycle.pinned_revision !== pinnedRevision) {
      throw createAdapterError('mismatched_provider_revision', 'Provider provenance pinned revision mismatch.');
    }
  }

  return provenance;
}

export function evaluateScenarioAssertions(context, manifestOrExpected, scenarioId = null) {
  const expected = manifestOrExpected?.expected ?? manifestOrExpected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw createAdapterError('invalid_expected_contract', 'Expected scenario contract is required.');
  }
  validateAllowedKeys(expected, ALLOWED_EXPECTED_KEYS, 'invalid_expected_contract');

  const fileSet = new Set(context.files.map((item) => item.path));
  const componentMap = new Map(context.components.map((item) => [item.id, item]));
  const impactMap = new Map(context.impacts.map((item) => [item.id, item]));
  const importSet = new Set(context.workspace_imports.map(importKey));
  const incrementalSet = new Set(context.incremental.added_imports.map(importKey));
  const allowedComponentIds = expected.allowed_component_ids === undefined
    ? null
    : new Set(asStringArray(expected.allowed_component_ids, 'expected.allowed_component_ids'));

  const missingFiles = asStringArray(expected.required_files, 'expected.required_files')
    .filter((filePath) => !fileSet.has(filePath));
  const missingComponents = asArray(expected.required_components, 'expected.required_components')
    .map((component) => normalizeComponentExpectation(component))
    .filter((component) => {
      const actual = componentMap.get(component.id);
      if (!actual) return true;
      return component.file_paths.some((filePath) => !actual.file_paths.includes(filePath));
    })
    .map((component) => component.id);
  const inventedComponents = allowedComponentIds === null
    ? []
    : context.components
      .map((component) => component.id)
      .filter((componentId) => !allowedComponentIds.has(componentId));
  const missingImpacts = asArray(expected.required_impacts, 'expected.required_impacts')
    .map((impact) => normalizeImpactExpectation(impact))
    .filter((impact) => {
      const actual = impactMap.get(impact.id);
      if (!actual) return true;
      return impact.direct_paths.some((filePath) => !actual.direct_paths.includes(filePath))
        || impact.transitive_paths.some((filePath) => !actual.transitive_paths.includes(filePath));
    })
    .map((impact) => impact.id);
  const missingWorkspaceImports = asArray(expected.required_workspace_imports, 'expected.required_workspace_imports')
    .map((entry) => normalizeImportRecord(entry))
    .filter((entry) => !importSet.has(importKey(entry)))
    .map(importKey);
  const missingIncrementalImports = asArray(expected.required_incremental_imports, 'expected.required_incremental_imports')
    .map((entry) => normalizeImportRecord(entry))
    .filter((entry) => !incrementalSet.has(importKey(entry)))
    .map(importKey);

  return {
    scenario_id: scenarioId ?? context.scenario_id ?? null,
    pass: (
      missingFiles.length === 0
      && missingComponents.length === 0
      && inventedComponents.length === 0
      && missingImpacts.length === 0
      && missingWorkspaceImports.length === 0
      && missingIncrementalImports.length === 0
    ),
    missing_files: missingFiles,
    missing_components: missingComponents,
    invented_components: inventedComponents,
    missing_impacts: missingImpacts,
    missing_workspace_imports: missingWorkspaceImports,
    missing_incremental_imports: missingIncrementalImports
  };
}

export function fingerprintGraph(graph) {
  return sha256(stableStringify(graph));
}

export function fingerprintFixtureManifest(manifest) {
  return sha256(stableStringify(manifest));
}

export function fingerprintSettings(settings) {
  return sha256(stableStringify(settings));
}

async function buildCompactContext({ projectRoot, graph, manifest, fileOps }) {
  const files = [];
  for (const entry of asArray(graph.files, 'graph.files')) {
    validateAllowedKeys(entry, ALLOWED_FILE_KEYS, 'invalid_graph_schema');
    expectStructuralToken(entry.id, 'graph.files[].id');
    expectStructuralToken(entry.role, 'graph.files[].role');
    const normalizedPath = await validateProjectFilePath(projectRoot, entry.path, fileOps, 'graph.files[].path');
    files.push({
      id: entry.id,
      path: normalizedPath,
      role: entry.role
    });
  }

  const components = [];
  for (const entry of asArray(graph.components, 'graph.components')) {
    validateAllowedKeys(entry, ALLOWED_COMPONENT_KEYS, 'invalid_graph_schema');
    expectStructuralToken(entry.id, 'graph.components[].id');
    expectStructuralToken(entry.kind, 'graph.components[].kind');
    const filePaths = [];
    for (const filePath of asStringArray(entry.file_paths, 'graph.components[].file_paths')) {
      filePaths.push(await validateProjectFilePath(projectRoot, filePath, fileOps, 'graph.components[].file_paths[]'));
    }
    components.push({
      id: entry.id,
      kind: entry.kind,
      file_paths: dedupeStrings(filePaths)
    });
  }

  const impacts = [];
  for (const entry of asArray(graph.impacts, 'graph.impacts')) {
    validateAllowedKeys(entry, ALLOWED_IMPACT_KEYS, 'invalid_graph_schema');
    expectStructuralToken(entry.id, 'graph.impacts[].id');
    const directPaths = [];
    for (const filePath of asStringArray(entry.direct_paths, 'graph.impacts[].direct_paths')) {
      directPaths.push(await validateProjectFilePath(projectRoot, filePath, fileOps, 'graph.impacts[].direct_paths[]'));
    }
    const transitivePaths = [];
    for (const filePath of asStringArray(entry.transitive_paths, 'graph.impacts[].transitive_paths')) {
      transitivePaths.push(await validateProjectFilePath(projectRoot, filePath, fileOps, 'graph.impacts[].transitive_paths[]'));
    }
    impacts.push({
      id: entry.id,
      direct_paths: dedupeStrings(directPaths),
      transitive_paths: dedupeStrings(transitivePaths)
    });
  }

  const workspaceImports = [];
  for (const entry of asArray(graph.workspace_imports, 'graph.workspace_imports')) {
    workspaceImports.push(await normalizeImportRecordAsync(projectRoot, entry, fileOps, 'graph.workspace_imports[]'));
  }

  validateAllowedKeys(graph.incremental, ALLOWED_INCREMENTAL_KEYS, 'invalid_graph_schema');
  const incremental = {
    from_revision: expectStructuralToken(graph.incremental.from_revision, 'graph.incremental.from_revision'),
    to_revision: expectStructuralToken(graph.incremental.to_revision, 'graph.incremental.to_revision'),
    added_imports: []
  };
  for (const entry of asArray(graph.incremental.added_imports, 'graph.incremental.added_imports')) {
    incremental.added_imports.push(await normalizeImportRecordAsync(projectRoot, entry, fileOps, 'graph.incremental.added_imports[]'));
  }

  validateAllowedKeys(graph.metrics, ALLOWED_METRIC_KEYS, 'invalid_graph_schema');
  const metrics = {
    file_count: expectInteger(graph.metrics.file_count, 'graph.metrics.file_count'),
    component_count: expectInteger(graph.metrics.component_count, 'graph.metrics.component_count'),
    impact_count: expectInteger(graph.metrics.impact_count, 'graph.metrics.impact_count'),
    workspace_import_count: expectInteger(graph.metrics.workspace_import_count, 'graph.metrics.workspace_import_count'),
    incremental_import_count: expectInteger(graph.metrics.incremental_import_count, 'graph.metrics.incremental_import_count')
  };

  if (metrics.file_count !== files.length
    || metrics.component_count !== components.length
    || metrics.impact_count !== impacts.length
    || metrics.workspace_import_count !== workspaceImports.length
    || metrics.incremental_import_count !== incremental.added_imports.length) {
    throw createAdapterError('invalid_graph_metrics', 'Graph metrics do not match compact structural counts.');
  }

  return {
    project: {
      id: manifest.project.id,
      revision: manifest.project.revision
    },
    files,
    components,
    impacts,
    workspace_imports: workspaceImports,
    incremental,
    metrics
  };
}

function buildProvenanceEnvelope({
  graph,
  manifest,
  settingsFingerprint,
  runId,
  className,
  purgeStatus,
  pinnedRevision
}) {
  if (!isSha256Fingerprint(settingsFingerprint)) {
    throw createAdapterError('invalid_settings_fingerprint', 'Settings fingerprint must be sha256.');
  }
  expectStructuralToken(runId, 'runId');
  return {
    schema: REVIEWED_OUTPUT_PROVENANCE_SCHEMA,
    class: className,
    graph_fingerprint: fingerprintGraph(graph),
    fixture_fingerprint: fingerprintFixtureManifest(manifest),
    settings_fingerprint: settingsFingerprint,
    project_id: manifest.project.id,
    project_revision: manifest.project.revision,
    lifecycle: {
      run_id: runId,
      purge_status: purgeStatus,
      pinned_revision: pinnedRevision
    }
  };
}

function validateGraphSchema(graph) {
  validateAllowedKeys(graph, GRAPH_TOP_LEVEL_KEYS, 'invalid_graph_schema');
  expectString(graph.schema, 'graph.schema');
  if (graph.schema !== REVIEWED_OUTPUT_GRAPH_SCHEMA) {
    throw createAdapterError('invalid_graph_schema', 'Unexpected reviewed graph schema.');
  }
  validateAllowedKeys(graph.project, ALLOWED_PROJECT_KEYS, 'invalid_graph_schema');
  expectStructuralToken(graph.project.id, 'graph.project.id');
  expectStructuralToken(graph.project.revision, 'graph.project.revision');
  if (!Array.isArray(graph.files)
    || !Array.isArray(graph.components)
    || !Array.isArray(graph.impacts)
    || !Array.isArray(graph.workspace_imports)
    || !graph.incremental
    || typeof graph.incremental !== 'object'
    || Array.isArray(graph.incremental)
    || !graph.metrics
    || typeof graph.metrics !== 'object'
    || Array.isArray(graph.metrics)) {
    throw createAdapterError('invalid_graph_schema', 'Reviewed graph must contain typed structural collections only.');
  }
}

function validateManifestSchema(manifest) {
  validateAllowedKeys(manifest, MANIFEST_TOP_LEVEL_KEYS, 'invalid_fixture_manifest');
  expectString(manifest.schema, 'manifest.schema');
  if (manifest.schema !== REVIEWED_OUTPUT_FIXTURE_MANIFEST_SCHEMA) {
    throw createAdapterError('invalid_fixture_manifest', 'Unexpected fixture manifest schema.');
  }
  expectStructuralToken(manifest.fixture_id, 'manifest.fixture_id');
  expectStructuralToken(manifest.scenario_id, 'manifest.scenario_id');
  validateAllowedKeys(manifest.project, ALLOWED_PROJECT_KEYS, 'invalid_fixture_manifest');
  expectStructuralToken(manifest.project.id, 'manifest.project.id');
  expectStructuralToken(manifest.project.revision, 'manifest.project.revision');
  validateAllowedKeys(manifest.expected, ALLOWED_EXPECTED_KEYS, 'invalid_fixture_manifest');
}

function rejectSelfDeclaredProvenance(value, label) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'provenance')) {
    throw createAdapterError('self_declared_provenance', `${label} must not self-declare provenance.`);
  }
}

function validateProjectIdentity(graphProject, manifestProject) {
  if (graphProject.id !== manifestProject.id || graphProject.revision !== manifestProject.revision) {
    throw createAdapterError('mismatched_project_identity', 'Graph project identity does not match the fixture manifest.');
  }
}

async function readJsonFile(filePath, fileOps, { label, maxBytes = null } = {}) {
  const details = await fileOps.stat(filePath);
  if (!details.isFile()) {
    throw createAdapterError('invalid_path_type', `${label} must be a regular file.`);
  }
  if (maxBytes !== null && details.size > maxBytes) {
    throw createAdapterError('graph_too_large', `${label} exceeds the reviewed graph size limit.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(await fileOps.readFile(filePath, 'utf8'));
  } catch (error) {
    throw createAdapterError('invalid_json', `${label} must be valid JSON.`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw createAdapterError('invalid_json', `${label} must be a JSON object.`);
  }
  return parsed;
}

async function validateProjectFilePath(projectRoot, candidatePath, fileOps, label) {
  const relativePath = normalizeRelativePath(candidatePath, label);
  const absolutePath = path.resolve(projectRoot, relativePath);
  const relativeResolved = path.relative(projectRoot, absolutePath);
  if (!relativeResolved || relativeResolved.startsWith('..') || path.isAbsolute(relativeResolved)) {
    throw createAdapterError('path_escape', `${label} must stay inside the project root.`);
  }

  const details = await fileOps.stat(absolutePath);
  if (!details.isFile()) {
    throw createAdapterError('invalid_path_type', `${label} must resolve to a regular file.`);
  }

  const real = await fileOps.realpath(absolutePath);
  const realRelative = path.relative(projectRoot, real);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw createAdapterError('escaping_symlink', `${label} resolved outside the project root.`);
  }

  return toPosix(relativePath);
}

async function normalizeImportRecordAsync(projectRoot, record, fileOps, label) {
  validateAllowedKeys(record, ALLOWED_IMPORT_KEYS, 'invalid_graph_schema');
  expectPackageName(record.package_name, `${label}.package_name`);
  return {
    importer_path: await validateProjectFilePath(projectRoot, record.importer_path, fileOps, `${label}.importer_path`),
    package_name: record.package_name,
    resolved_path: await validateProjectFilePath(projectRoot, record.resolved_path, fileOps, `${label}.resolved_path`)
  };
}

function normalizeComponentExpectation(component) {
  validateAllowedKeys(component, new Set(['id', 'file_paths']), 'invalid_expected_contract');
  return {
    id: expectStructuralToken(component.id, 'expected.required_components[].id'),
    file_paths: asStringArray(component.file_paths, 'expected.required_components[].file_paths')
  };
}

function normalizeImpactExpectation(impact) {
  validateAllowedKeys(impact, new Set(['id', 'direct_paths', 'transitive_paths']), 'invalid_expected_contract');
  return {
    id: expectStructuralToken(impact.id, 'expected.required_impacts[].id'),
    direct_paths: asStringArray(impact.direct_paths, 'expected.required_impacts[].direct_paths'),
    transitive_paths: asStringArray(impact.transitive_paths, 'expected.required_impacts[].transitive_paths')
  };
}

function normalizeImportRecord(record) {
  validateAllowedKeys(record, ALLOWED_IMPORT_KEYS, 'invalid_expected_contract');
  return {
    importer_path: normalizeRelativePath(record.importer_path, 'expected import importer_path'),
    package_name: expectPackageName(record.package_name, 'expected import package_name'),
    resolved_path: normalizeRelativePath(record.resolved_path, 'expected import resolved_path')
  };
}

async function resolveExistingDirectory(directoryPath, fileOps, label) {
  const details = await fileOps.stat(directoryPath);
  if (!details.isDirectory()) {
    throw createAdapterError('invalid_path_type', `${label} must be a directory.`);
  }
  return directoryPath;
}

function resolveDescendantPath(rootPath, childPath, label) {
  const candidate = path.resolve(rootPath, String(childPath));
  const relativePath = path.relative(rootPath, candidate);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw createAdapterError('path_escape', `${label} must stay inside the fixture root.`);
  }
  return candidate;
}

function normalizeRelativePath(value, label) {
  expectString(value, label);
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    throw createAdapterError('absolute_source_path', `${label} must not be absolute.`);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw createAdapterError('uri_like_path', `${label} must not be URI-like.`);
  }
  const normalized = toPosix(path.posix.normalize(toPosix(value)));
  if (normalized === '.' || normalized === '' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw createAdapterError('path_traversal', `${label} must not traverse outside the project.`);
  }
  return normalized;
}

function createFileOps(fileOps = {}) {
  return {
    readFile: fileOps.readFile ?? readFile,
    stat: async (targetPath) => {
      try {
        return await (fileOps.stat ?? stat)(targetPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw createAdapterError('missing_path', `Required fixture path is missing: ${targetPath}`);
        }
        throw error;
      }
    },
    realpath: fileOps.realpath ?? realpath
  };
}

function validateAllowedKeys(value, allowedKeys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createAdapterError(code, 'Expected an object.');
  }
  const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw createAdapterError(code, `Unexpected keys: ${unexpectedKeys.join(', ')}`);
  }
}

function expectString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createAdapterError('invalid_string', `${label} must be a non-empty string.`);
  }
  return value;
}

function expectStructuralToken(value, label) {
  expectString(value, label);
  if (value.length > MAX_STRUCTURAL_TOKEN_LENGTH || !STRUCTURAL_TOKEN_PATTERN.test(value)) {
    logFix('warn', 'unsafe-structural-text.rejected', {
      field: label,
      length: value.length,
      reason_code: 'unsafe_structural_text'
    });
    throw createAdapterError(
      'unsafe_structural_text',
      `${label} must be bounded token-shaped structural data, not prose.`
    );
  }
  return value;
}

function expectPackageName(value, label) {
  expectString(value, label);
  if (value.length > MAX_PACKAGE_NAME_LENGTH || !PACKAGE_NAME_PATTERN.test(value)) {
    logFix('warn', 'unsafe-structural-text.rejected', {
      field: label,
      length: value.length,
      reason_code: 'unsafe_structural_text'
    });
    throw createAdapterError(
      'unsafe_structural_text',
      `${label} must be a bounded package-name token, not prose.`
    );
  }
  return value;
}

function expectInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw createAdapterError('invalid_integer', `${label} must be a non-negative integer.`);
  }
  return value;
}

function asArray(value, label) {
  if (!Array.isArray(value)) {
    throw createAdapterError('invalid_graph_schema', `${label} must be an array.`);
  }
  return value;
}

function asStringArray(value, label) {
  const entries = asArray(value ?? [], label);
  return entries.map((entry) => normalizeRelativePathOrPlain(entry, label));
}

function normalizeRelativePathOrPlain(value, label) {
  expectString(value, label);
  if (value.includes('/') || value.includes('\\') || value.startsWith('.')) {
    return normalizeRelativePath(value, label);
  }
  return value;
}

function importKey(record) {
  return `${record.importer_path}|${record.package_name}|${record.resolved_path}`;
}

function dedupeStrings(values) {
  return [...new Set(values)];
}

function stableStringify(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortDeep(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .reduce((result, key) => {
      result[key] = sortDeep(value[key]);
      return result;
    }, {});
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isSha256Fingerprint(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
}

function createAdapterError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function logFix(level, event, details = {}) {
  const configured = String(process.env.AIF_UNDERSTAND_ANYTHING_LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'warn').toLowerCase();
  const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  if ((levels[level] ?? levels.info) < (levels[configured] ?? levels.warn)) return;
  process.stderr.write(`${JSON.stringify({ prefix: '[FIX:129]', component: 'understand-anything-reviewed-output', level, event, ...details })}\n`);
}
