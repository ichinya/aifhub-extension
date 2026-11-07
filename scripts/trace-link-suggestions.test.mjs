// trace-link-suggestions.test.mjs - opt-in advisory trace link suggestion producer (#283).
// The engine always runs inside disposable temp projects (mkdtemp + realpath);
// the checkout is never written to. Fake assessors are injected through the DI
// seam; disabled/no-call follows the mustNotRun pattern. No network, no SDK,
// no keys, no paid calls (AC). The isolation test never reads
// openspec/specs/** (gitignored; absent in CI checkouts).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cp, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonical, digest } from './workflow-state-store.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { prepareQaManifest } from './qa-manifest.mjs';
import { qaStore } from './qa-manifest-store.mjs';
import { observeQaSnapshot } from './qa-manifest-inputs.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import {
  CHANGE_ID_FORM,
  CONTRACT_MODULE,
  ENGINE_MODULE,
  GRAPH_LIMITS,
  HELPER_MODULE,
  NOT_RUN_CODES,
  RELATION_POLICY,
  STATE_ROOT,
  TRACE_EXPORT_LIMIT,
  TRACE_LINK_CONSUMER_ID,
  TRACE_LINK_NAMESPACE,
  TRACE_LINK_SCHEMA,
  assertStructuralInvariants,
  parseRequirementsFromBytes,
  parseTraceLinkArgs,
  parseTraceLinkSuggestionsConfigSubset,
  readTraceLinkSuggestionsConfig,
  runTraceLinkSuggestionsCommand,
  traceLinkPaths,
  traceManifestPath,
  tokenize,
  intersects,
  maskCodeRegions,
  maskModeForPath,
  validateGraphShape,
  validateObservationBinding,
  writeTraceLinkObservation,
} from './trace-link-suggestions.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'trace-link-suggestions');
const CONFIG_ON = 'aifhub:\n  traceLinkSuggestions:\n    enabled: true\n';
const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeTemp(prefix) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function gitIn(root, args) {
  const { spawn } = await import('node:child_process');
  const child = spawn('git', args, { cwd: root, windowsHide: true });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout }));
  });
}

async function treeFingerprint(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return digest(canonical(entries.map((entry) => `${entry.parentPath ?? entry.path}:${entry.name}:${entry.isDirectory() ? 'd' : 'f'}`).sort()));
}

// Seeds a disposable project for one corpus case: config, delta specs, trace
// manifest under the change's own custody directory, presented test inputs.
async function seedCaseProject(root, changeId, { config = CONFIG_ON, trace = null, specs = [], tests = [], foreignChange = null, foreignTrace = null } = {}) {

  await mkdir(path.join(root, '.ai-factory'), { recursive: true });
  if (config !== undefined && config !== null) {
    await writeFile(path.join(root, '.ai-factory', 'config.yaml'), config, 'utf8');
  }
  for (const spec of specs) {
    // Delta specs must be named spec.md inside their capability directory
    // (collectCanonicalChangeArtifacts collects exactly spec.md files).
    const capDir = path.basename(spec, '.md');
    const target = path.join(root, 'openspec', 'changes', changeId, 'specs', capDir, 'spec.md');
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(CORPUS_DIR, spec), target);
  }
  await mkdir(path.join(root, 'openspec', 'changes', changeId), { recursive: true });
  await writeFile(path.join(root, 'openspec', 'changes', changeId, 'proposal.md'), `# Proposal\n\n## Why\n\n${changeId} corpus fixture.\n`, 'utf8');
  await writeFile(path.join(root, 'openspec', 'changes', changeId, 'tasks.md'), '- [ ] 1.1 Task\n', 'utf8');
  if (trace) {
    const manifest = path.join(root, '.ai-factory', 'traces', changeId, 'lekalo-trace-manifest.json');
    await mkdir(path.dirname(manifest), { recursive: true });
    await cp(path.join(CORPUS_DIR, trace), manifest);
  }
  if (foreignChange && foreignTrace) {
    const foreign = path.join(root, '.ai-factory', 'traces', foreignChange, 'lekalo-trace-manifest.json');
    await mkdir(path.dirname(foreign), { recursive: true });
    await cp(path.join(CORPUS_DIR, foreignTrace), foreign);
  }
  for (const testPath of tests) {
    if (testPath.endsWith('/ghost.spec.mjs')) continue; // presented but never shipped: missing source
    const target = path.join(root, testPath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(CORPUS_DIR, 'tests', path.basename(testPath)), target);
  }
}

async function runCommand(root, argv, options = {}) {
  const outputs = [];
  const exitCode = await runTraceLinkSuggestionsCommand(argv, { rootDir: root, output: (value) => outputs.push(value), ...options });
  const text = outputs.join('');
  let value = null;
  try { value = parseStrictJson(text); } catch { value = null; }
  return { exitCode, value, text };
}

// Writes an inline delta spec (test-local scenario, outside the corpus files)
// into the change's canonical specs tree under the exact spec.md name.
async function writeInlineSpec(root, changeId, capDir, content) {
  const target = path.join(root, 'openspec', 'changes', changeId, 'specs', capDir, 'spec.md');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function refOf(node) {
  if (node.kind === 'requirement') return `req:#${node.exact_ref.requirement_ref}`;
  if (node.kind === 'semantic_symbol') return node.exact_ref.symbol_ref;
  if (node.kind === 'scenario') return `scn:#${node.exact_ref.heading}`;
  return `test:${node.exact_ref.path}`;
}

function edgesAsLabels(observation) {
  return (observation.structural?.edges ?? []).map((edge) => ({
    relation: edge.relation,
    from: refOf(observation.structural.nodes.find((node) => node.node_id === edge.from_node_id)),
    to: refOf(observation.structural.nodes.find((node) => node.node_id === edge.to_node_id)),
    outcome: edge.outcome,
    anchors: edge.behavioral_assertion_refs.length,
  })).sort((left, right) => `${left.relation}|${left.from}|${left.to}`.localeCompare(`${right.relation}|${right.from}|${right.to}`));
}

function sortedLabels(labels) {
  return [...labels].sort((left, right) => `${left.relation}|${left.from}|${left.to}`.localeCompare(`${right.relation}|${right.from}|${right.to}`));
}

function fakeAssessor(input) {
  return {
    findings: input.edges.map((edge) => ({
      edge_id: edge.edge_id,
      verdict: edge.outcome === 'candidate' ? 'supports' : 'insufficient',
      rationale: `fake assessor: ${edge.outcome}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Argument parsing and closed config subset
// ---------------------------------------------------------------------------

describe('trace-link-suggestions arguments and config', () => {
  it('rejects unknown, duplicate, and valueless options', () => {
    assert.equal(parseTraceLinkArgs(['--bogus']).ok, false);
    assert.equal(parseTraceLinkArgs(['--change', 'a', '--change', 'b']).ok, false);
    assert.equal(parseTraceLinkArgs(['--change']).ok, false);
    assert.equal(parseTraceLinkArgs(['--enabled', 'maybe']).ok, false);
    assert.equal(parseTraceLinkArgs(['--change', 'a', '--test', 't/x.spec.mjs', '--test', 't/y.spec.md']).testPaths.length, 2);
  });

  it('keeps the traceLinkSuggestions namespace closed with bounded diagnostics', () => {
    const malformed = parseTraceLinkSuggestionsConfigSubset([
      'aifhub:',
      '  traceLinkSuggestions:',
      '    enabled: "true"',
      '    extra: 1',
      '  claimEvidence: 3',
    ].join('\n'));
    const codes = malformed.diagnostics.map((entry) => entry.code);
    assert.ok(codes.includes('trace-link-suggestions:quoted-boolean'), codes.join(','));
    assert.ok(codes.includes('trace-link-suggestions:unknown-key'), codes.join(','));
    const parsed = parseTraceLinkSuggestionsConfigSubset('aifhub:\n  traceLinkSuggestions:\n    enabled: true\n');
    assert.equal(parsed.value.aifhub.traceLinkSuggestions.enabled, true);
    assert.equal(parsed.diagnostics.length, 0);
  });

  it('treats an unreadable config as malformed instead of enabling the scan', async () => {
    const root = await makeTemp('aif-tls-cfg-');
    await mkdir(path.join(root, '.ai-factory'), { recursive: true });
    await writeFile(path.join(root, '.ai-factory', 'config.yaml'), Buffer.from([0xff, 0xfe, 0x00]));
    const config = await readTraceLinkSuggestionsConfig(root);
    assert.equal(config.enabledMalformed, true);
    assert.equal(config.enabled, null);
  });

  it('treats a non-mapping line inside the guarded namespace as a malformed form, never a silent skip', () => {
    const parsed = parseTraceLinkSuggestionsConfigSubset([
      'aifhub:',
      '  traceLinkSuggestions:',
      '    enabled: true',
      '    this line has no mapping colon at all',
    ].join('\n'));
    const codes = parsed.diagnostics.map((entry) => entry.code);
    assert.ok(codes.includes('trace-link-suggestions:malformed-line'), codes.join(','));
    // A guarded malformed line keeps the producer off: parsed diagnostics
    // force enabledMalformed at the config-read layer.
    assert.ok(parsed.diagnostics.length > 0);
  });

  it('keeps an unguarded malformed line outside the bounded namespace diagnostics', () => {
    const parsed = parseTraceLinkSuggestionsConfigSubset([
      'utilities:',
      '  this line has no mapping colon at all',
      'aifhub:',
      '  traceLinkSuggestions:',
      '    enabled: true',
    ].join('\n'));
    assert.equal(parsed.diagnostics.length, 0);
    assert.equal(parsed.value.aifhub.traceLinkSuggestions.enabled, true);
  });
});

// ---------------------------------------------------------------------------
// Custody trace reader: honest not_run, never an interpreted payload
// ---------------------------------------------------------------------------

describe('trace-link-suggestions custody reader', () => {
  it('reads the own-change manifest and records its raw-byte identity', async () => {
    const root = await makeTemp('aif-tls-own-');
    const changeId = 'own-change';
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: [] });
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(value.schema, TRACE_LINK_SCHEMA);
    assert.equal(value.structural.trace.path, traceManifestPath(changeId));
    const raw = await readFile(path.join(root, traceManifestPath(changeId)));
    assert.equal(value.structural.trace.sha256, digest(raw));
    assert.equal(value.structural.trace.bytes, raw.length);
    assert.equal(value.structural.trace.schema_version, 'lekalo/trace-manifest/v0.2.16');
    assert.equal(value.diagnostic_only, true);
    assert.deepEqual(value.authorizes, []);
  });

  it('reports trace-missing without reading anything else', async () => {
    const root = await makeTemp('aif-tls-miss-');
    await seedCaseProject(root, 'missing-trace', { specs: ['specs/spec-en.md'], tests: [] });
    const before = await treeFingerprint(root);
    const { exitCode, value } = await runCommand(root, ['--change', 'missing-trace', '--enabled', 'true', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(value.state, 'not_run');
    assert.deepEqual(value.codes, ['trace-missing']);
    assert.equal(value.message, 'advisory scan was not performed');
    assert.equal(await treeFingerprint(root), before);
  });

  it('never reads a foreign change custody directory', async () => {
    const root = await makeTemp('aif-tls-foreign-');
    await seedCaseProject(root, 'my-change', { trace: null, specs: ['specs/spec-en.md'], tests: [], foreignChange: 'other-change', foreignTrace: 'traces/foreign-trace.json' });
    const { exitCode, value } = await runCommand(root, ['--change', 'my-change', '--enabled', 'true', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(value.state, 'not_run');
    assert.deepEqual(value.codes, ['trace-missing']);
    const foreign = await readFile(path.join(root, '.ai-factory', 'traces', 'other-change', 'lekalo-trace-manifest.json'));
    assert.ok(foreign.length > 0, 'foreign file untouched on disk');
  });

  it('refuses a manifest path that is a directory (trace-custody)', async () => {
    const root = await makeTemp('aif-tls-dir-');
    const changeId = 'dir-change';
    await seedCaseProject(root, changeId, { specs: ['specs/spec-en.md'], tests: [] });
    await rm(path.join(root, '.ai-factory', 'traces', changeId), { recursive: true, force: true });
    await mkdir(path.join(root, '.ai-factory', 'traces', changeId, 'lekalo-trace-manifest.json'), { recursive: true });
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
    assert.equal(exitCode, 0);
    assert.deepEqual(value.codes, ['trace-custody']);
  });

  it('refuses hardlinked and symlinked manifests (trace-custody)', async () => {
    const root = await makeTemp('aif-tls-link-');
    const changeId = 'link-change';
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: [] });
    const outside = path.join(root, 'outside-trace.json');
    const manifest = path.join(root, traceManifestPath(changeId));
    await writeFile(outside, await readFile(manifest));
    let linked = false;
    try {
      await rm(manifest);
      await link(outside, manifest);
      linked = true;
    } catch {
      linked = false; // hardlinks unsupported on this volume: the directory refusal above covers the shape
    }
    if (linked) {
      const { value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
      assert.deepEqual(value.codes, ['trace-custody']);
      // Remove the hardlink before the symlink attempt: an existing
      // destination would make the symlink creation fail with EEXIST and be
      // silently absorbed, leaving the symlink shape untested.
      await rm(manifest);
    }
    let symlinked = false;
    try {
      await symlink(outside, manifest);
      symlinked = true;
    } catch {
      symlinked = false; // symlink privilege unavailable: skipped honestly, not asserted
    }
    if (symlinked) {
      const { value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
      assert.deepEqual(value.codes, ['trace-custody']);
    }
    assert.ok(linked || symlinked, 'at least one link refusal shape must be exercised');
  });

  it('refuses exports above the 32 MiB contract limit (export-overflow)', async () => {
    const root = await makeTemp('aif-tls-overflow-');
    const changeId = 'overflow-change';
    await seedCaseProject(root, changeId, { specs: ['specs/spec-en.md'], tests: [] });
    const manifest = path.join(root, traceManifestPath(changeId));
    await mkdir(path.dirname(manifest), { recursive: true });
    const oversized = Buffer.alloc(TRACE_EXPORT_LIMIT + 1, 0x20);
    await writeFile(manifest, oversized);
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
    assert.equal(exitCode, 0);
    assert.deepEqual(value.codes, ['export-overflow']);
  });

  it('maps envelope self-check failures to trace-invalid, never to a partial interpretation', async () => {
    const root = await makeTemp('aif-tls-invalid-');
    const changeId = 'invalid-change';
    await seedCaseProject(root, changeId, { trace: 'traces/heldout-trace-bad-hash.json', specs: ['specs/spec-en.md'], tests: [] });
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
    assert.equal(exitCode, 0);
    assert.deepEqual(value.codes, ['trace-invalid']);
  });

  it('maps a mid-read file change to trace-changed through the read seam', async () => {
    const root = await makeTemp('aif-tls-changed-');
    const changeId = 'changed-change';
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: [] });
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json'], {
      readTrace: async () => { throw new Error('file_changed'); },
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(value.codes, ['trace-changed']);
  });

  it('reports an honest none for a full scan with resolvable nodes but zero suggestions', async () => {
    const root = await makeTemp('aif-tls-none-');
    const changeId = 'none-change';
    // (A) resolvable requirement ref, no relations: nodes exist, edges 0.
    await seedCaseProject(root, changeId, { trace: null, specs: [], tests: [] });
    await writeInlineSpec(root, changeId, 'none', '# Delta for none\n\n## ADDED Requirements\n\n### Requirement: Good\n\nThe none outcome MUST stay honest for a full scan without suggestions.\n');
    const { createHash } = await import('node:crypto');
    const traceA = {
      schemaVersion: 'lekalo/trace-manifest/v0.2.16',
      identity: 'dev.lekalo.trace-manifest@0.2.16',
      completeness: 'full',
      nodes: [{ symbol: 'requirement:Good' }],
      relations: [],
      gaps: [],
    };
    const manifestA = path.join(root, traceManifestPath(changeId));
    await mkdir(path.dirname(manifestA), { recursive: true });
    await writeFile(manifestA, JSON.stringify({ trace: traceA, manifestDigest: `sha256:${createHash('sha256').update(JSON.stringify(traceA)).digest('hex')}` }), 'utf8');
    const runA = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
    assert.equal(runA.exitCode, 0, JSON.stringify(runA.value?.codes ?? []));
    assert.equal(runA.value.structural.outcome, 'none');
    assert.equal(runA.value.structural.scan.coverage, 'full');
    assert.equal(runA.value.structural.edges.length, 0);
    assert.ok(runA.value.structural.nodes.length > 0, 'resolved universe nodes are not suggestions');
    // (D) unsupported-kind symbols only + a parsed scenario: nodes exist, edges 0.
    const traceB = {
      schemaVersion: 'lekalo/trace-manifest/v0.2.16',
      identity: 'dev.lekalo.trace-manifest@0.2.16',
      completeness: 'full',
      nodes: [{ symbol: 'policy:legacy.only' }],
      relations: [],
      gaps: [],
    };
    await writeFile(manifestA, JSON.stringify({ trace: traceB, manifestDigest: `sha256:${createHash('sha256').update(JSON.stringify(traceB)).digest('hex')}` }), 'utf8');
    const runB = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
    assert.equal(runB.exitCode, 0, JSON.stringify(runB.value?.codes ?? []));
    assert.equal(runB.value.structural.outcome, 'none');
  });

  it('honors the structural deadline as a bounded not_run', async () => {
    const root = await makeTemp('aif-tls-deadline-');
    const changeId = 'deadline-change';
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: [] });
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json'], { deadlineMs: 0 });
    assert.equal(exitCode, 0);
    assert.equal(value.state, 'not_run');
    assert.deepEqual(value.codes, ['deadline-exceeded']);
  });
});

// ---------------------------------------------------------------------------
// Exact-ref refusals: typed, exit 2, before any emit
// ---------------------------------------------------------------------------

describe('trace-link-suggestions exact-ref refusals', () => {
  it('refuses a candidate referencing an unresolvable requirement ref', async () => {
    const root = await makeTemp('aif-tls-unres-');
    await seedCaseProject(root, 'unresolved-change', { trace: 'traces/heldout-trace-unresolved.json', specs: ['specs/spec-en.md'], tests: [] });
    const { exitCode, value } = await runCommand(root, ['--change', 'unresolved-change', '--enabled', 'true', '--json']);
    assert.equal(exitCode, 2);
    assert.deepEqual(value.codes, ['invalid-candidate:unresolved-ref']);
  });

  it('refuses an ambiguous duplicate scenario heading instead of picking the first match', async () => {
    const root = await makeTemp('aif-tls-amb-');
    await seedCaseProject(root, 'ambiguous-change', { trace: 'traces/heldout-trace-ambiguous.json', specs: ['specs/spec-amb.md'], tests: [] });
    const { exitCode, value } = await runCommand(root, ['--change', 'ambiguous-change', '--enabled', 'true', '--json']);
    assert.equal(exitCode, 2);
    assert.deepEqual(value.codes, ['invalid-candidate:ambiguous-scenario-ref']);
  });

  it('refuses duplicate requirement titles without a first-match fallback', async () => {
    const root = await makeTemp('aif-tls-twin-');
    await seedCaseProject(root, 'twin-change', { trace: 'traces/heldout-trace-duplicate-req.json', specs: ['specs/spec-twin.md'], tests: [] });
    const { exitCode, value } = await runCommand(root, ['--change', 'twin-change', '--enabled', 'true', '--json']);
    assert.equal(exitCode, 2);
    assert.deepEqual(value.codes, ['invalid-candidate:unresolved-ref']);
  });

  it('refuses duplicate scenario headings inside one requirement before any node collapses', async () => {
    const root = await makeTemp('aif-tls-dupscn-');
    const changeId = 'dup-scenario-change';
    // No trace ref names the duplicate: the pre-created scenario nodes must
    // refuse the ambiguity instead of silently keeping the last span.
    await seedCaseProject(root, changeId, { trace: null, specs: [], tests: [] });
    await writeInlineSpec(root, changeId, 'dup', [
      '# Delta for duplicates',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: DupHost',
      '',
      'One requirement with two identical scenario headings.',
      '',
      '#### Scenario: Same',
      '',
      '- GIVEN first',
      '- WHEN parsed',
      '- THEN ambiguous',
      '',
      '#### Scenario: Same',
      '',
      '- GIVEN second',
      '- WHEN parsed',
      '- THEN refused',
      '',
    ].join('\n'));
    const manifest = path.join(root, traceManifestPath(changeId));
    await mkdir(path.dirname(manifest), { recursive: true });
    const emptyTrace = { schemaVersion: 'lekalo/trace-manifest/v0.2.16', identity: 'dev.lekalo.trace-manifest@0.2.16', completeness: 'full', nodes: [], relations: [], gaps: [] };
    await writeFile(manifest, JSON.stringify({ trace: emptyTrace, manifestDigest: `sha256:${digest(JSON.stringify(emptyTrace))}` }), 'utf8');
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
    assert.equal(exitCode, 2);
    assert.deepEqual(value.codes, ['invalid-candidate:ambiguous-scenario-ref']);
  });

  it('skips unsupported trace relations with a bounded diagnostic and keeps scanning', async () => {
    const root = await makeTemp('aif-tls-rel-');
    await seedCaseProject(root, 'rel-change', { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: ['test/auth.spec.mjs'] });
    const { exitCode, value } = await runCommand(root, ['--change', 'rel-change', '--enabled', 'true', '--json']);
    assert.equal(exitCode, 0);
    const codes = value.diagnostics.map((entry) => entry.code);
    assert.ok(codes.includes('unsupported-trace-relation'));
    assert.ok(codes.includes('unsupported-trace-node-kind'));
    assert.equal(value.structural.edges.some((edge) => edge.relation === 'requirement_symbol'
      && refOf(value.structural.nodes.find((node) => node.node_id === edge.to_node_id)) === 'scn:#AuthLoginHappy'), false);
  });

  it('validates the closed graph shape with typed refusals (defense in depth)', () => {
    const nodes = [
      { node_id: 'req:a#A', kind: 'requirement', exact_ref: { spec_path: 's.md', requirement_ref: 'A' } },
      { node_id: 'operation:x', kind: 'semantic_symbol', exact_ref: { symbol_ref: 'operation:x' } },
      { node_id: 'scn:a#A#H', kind: 'scenario', exact_ref: { spec_path: 's.md', requirement_ref: 'A', heading: 'H', span: { start: 0, end: 1 }, document_sha256: `sha256:${'a'.repeat(64)}`, span_sha256: `sha256:${'b'.repeat(64)}` } },
      { node_id: 'test:t.spec.mjs', kind: 'test', exact_ref: { path: 't.spec.mjs', sha256: `sha256:${'c'.repeat(64)}` } },
    ];
    const anchor = { path: 't.spec.mjs', span: { start: 0, end: 1 }, document_sha256: `sha256:${'c'.repeat(64)}`, span_sha256: `sha256:${'d'.repeat(64)}` };
    assert.deepEqual(validateGraphShape({
      nodes,
      edges: [{ edge_id: 'edge-1', from_node_id: 'req:a#A', to_node_id: 'operation:x', relation: 'requirement_symbol', outcome: 'related_only', behavioral_assertion_refs: [] }],
    }), { ok: true });
    assert.equal(validateGraphShape({
      nodes,
      edges: [{ edge_id: 'edge-1', from_node_id: 'req:a#A', to_node_id: 'operation:x', relation: 'symbol_scenario', outcome: 'related_only', behavioral_assertion_refs: [] }],
    }).code, 'unknown-relation');
    assert.equal(validateGraphShape({
      nodes,
      edges: [{ edge_id: 'edge-1', from_node_id: 'scn:a#A#H', to_node_id: 'req:a#A', relation: 'symbol_scenario', outcome: 'related_only', behavioral_assertion_refs: [] }],
    }).code, 'invalid-kind-pair');
    assert.equal(validateGraphShape({
      nodes,
      edges: [{ edge_id: 'edge-1', from_node_id: 'req:a#A', to_node_id: 'ghost', relation: 'requirement_symbol', outcome: 'related_only', behavioral_assertion_refs: [] }],
    }).code, 'dangling-endpoint');
    assert.equal(validateGraphShape({
      nodes,
      edges: [{ edge_id: 'edge-1', from_node_id: 'req:a#A', to_node_id: 'operation:x', relation: 'requirement_symbol', outcome: 'candidate', behavioral_assertion_refs: [] }],
    }).code, 'candidate-without-anchor');
    assert.equal(validateGraphShape({ nodes, edges: [] }, { relationPolicy: { ...RELATION_POLICY, version: 2 } }).code, 'unsupported-version');
    assert.equal(validateGraphShape({ nodes: [nodes[0], nodes[0]], edges: [] }).code, 'duplicate-node-id');
  });

  it('refuses an unsupported relation policy version as invalid-candidate:unsupported-version through the invariant gate', () => {
    const nodes = [
      { node_id: 'req:a#A', kind: 'requirement', exact_ref: { spec_path: 's.md', requirement_ref: 'A' } },
      { node_id: 'operation:x', kind: 'semantic_symbol', exact_ref: { symbol_ref: 'operation:x' } },
    ];
    const shape = validateGraphShape({
      nodes,
      edges: [{ edge_id: 'edge-1', from_node_id: 'req:a#A', to_node_id: 'operation:x', relation: 'requirement_symbol', outcome: 'related_only', behavioral_assertion_refs: [] }],
    }, { relationPolicy: { id: 'trace-link-relations-v1', version: 99, relations: RELATION_POLICY.relations } });
    assert.equal(shape.code, 'unsupported-version');
  });
});

// ---------------------------------------------------------------------------
// Outcome semantics: topic match is never coverage, anchors are required
// ---------------------------------------------------------------------------

describe('trace-link-suggestions outcome semantics', () => {
  it('keeps topic-only matches at related_only and never candidate', async () => {
    const root = await makeTemp('aif-tls-topic-');
    await seedCaseProject(root, 'topic-change', { trace: 'traces/heldout-trace-behavior.json', specs: ['specs/spec-en.md'], tests: ['test/behavior-masked.spec.mjs'] });
    const { exitCode, value } = await runCommand(root, ['--change', 'topic-change', '--enabled', 'true', '--test', 'test/behavior-masked.spec.mjs', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(value.structural.outcome, 'related_only');
    const labels = edgesAsLabels(value);
    assert.ok(labels.some((edge) => edge.relation === 'symbol_test' && edge.outcome === 'related_only' && edge.anchors === 0));
    assert.equal(labels.some((edge) => edge.outcome === 'candidate'), false);
  });

  it('counts assertions in comments and string literals as non-behavioral', async () => {
    const root = await makeTemp('aif-tls-mask-');
    await seedCaseProject(root, 'mask-change', { trace: 'traces/heldout-trace-behavior.json', specs: ['specs/spec-en.md'], tests: ['test/behavior-real.spec.mjs', 'test/behavior-masked.spec.mjs'] });
    const { exitCode, value } = await runCommand(root, ['--change', 'mask-change', '--enabled', 'true', '--test', 'test/behavior-real.spec.mjs', '--test', 'test/behavior-masked.spec.mjs', '--json']);
    assert.equal(exitCode, 0);
    const labels = edgesAsLabels(value);
    assert.deepEqual(labels.find((edge) => edge.to === 'test:test/behavior-real.spec.mjs'), {
      relation: 'symbol_test', from: 'operation:topic.thing', to: 'test:test/behavior-real.spec.mjs', outcome: 'candidate', anchors: 1,
    });
    assert.deepEqual(labels.find((edge) => edge.to === 'test:test/behavior-masked.spec.mjs'), {
      relation: 'symbol_test', from: 'operation:topic.thing', to: 'test:test/behavior-masked.spec.mjs', outcome: 'related_only', anchors: 0,
    });
  });

  it('masks comments, strings, and templates deterministically', async () => {
    const bytes = Buffer.from([
      'const a = topic.thing(); // topic.thing in comment',
      "const b = 'topic.thing in string';",
      'const c = `topic.thing in template`;',
      '/* topic.thing blocked */ const d = topic.thing();',
    ].join('\n'), 'utf8');
    const masked = maskCodeRegions(bytes);
    const occurrences = (needle) => {
      const found = [];
      let cursor = 0;
      for (;;) {
        const at = bytes.indexOf(Buffer.from(needle), cursor);
        if (at < 0) break;
        found.push(at);
        cursor = at + 1;
      }
      return found.map((at) => [...Array(needle.length).keys()].every((offset) => !masked[at + offset]));
    };
    assert.deepEqual(occurrences('topic.thing'), [true, false, false, false, false, true]);
  });

  it('masks needles inside nested template interpolations but keeps real interpolation code anchorable', () => {
    const bytes = Buffer.from([
      'const message = `a ${`topic.thing nested`} c`;',
      'const value = `${topic.thing()} done`;',
    ].join('\n'), 'utf8');
    const masked = maskCodeRegions(bytes, 'js');
    const first = bytes.indexOf(Buffer.from('topic.thing nested'));
    const second = bytes.indexOf(Buffer.from('topic.thing()'));
    assert.ok([...Array('topic.thing nested'.length).keys()].every((offset) => masked[first + offset]), 'nested literal stays masked');
    assert.ok([...Array('topic.thing()'.length).keys()].every((offset) => !masked[second + offset]), 'interpolation code stays anchorable');
  });

  it('masks hash-family comments and quotes, and leaves prose unmasked', () => {
    const hashBytes = Buffer.from([
      'def run():',
      "    # topic.thing documented in a comment",
      "    label = 'topic.thing in string'",
      '    topic.thing()',
    ].join('\n'), 'utf8');
    const masked = maskCodeRegions(hashBytes, 'hash');
    const commentAt = hashBytes.indexOf(Buffer.from('topic.thing documented'));
    const stringAt = hashBytes.indexOf(Buffer.from('topic.thing in string'));
    const callAt = hashBytes.indexOf(Buffer.from('topic.thing()'));
    assert.ok([...Array('topic.thing documented'.length).keys()].every((offset) => masked[commentAt + offset]));
    assert.ok([...Array('topic.thing in string'.length).keys()].every((offset) => masked[stringAt + offset]));
    assert.ok([...Array('topic.thing()'.length).keys()].every((offset) => !masked[callAt + offset]));
    // Prose/unknown extensions: no recognized comment or literal forms, so
    // nothing is masked (documented P0 limitation).
    const proseBytes = Buffer.from("Scenario: user's topic.thing anchor\n", 'utf8');
    const proseMasked = maskCodeRegions(proseBytes, 'none');
    assert.ok([...Array(proseBytes.length).keys()].every((offset) => !proseMasked[offset]));
    assert.equal(maskModeForPath('test/behavior.spec.py'), 'hash');
    assert.equal(maskModeForPath('test/behavior.spec.mjs'), 'js');
    assert.equal(maskModeForPath('test/behavior.spec.md'), 'none');
    assert.equal(maskModeForPath('test/unknown.spec.xyz'), 'none');
  });

  it('anchors hash-family tests by their own comment forms end-to-end', async () => {
    const root = await makeTemp('aif-tls-py-');
    const changeId = 'py-change';
    await seedCaseProject(root, changeId, { trace: 'traces/heldout-trace-behavior.json', specs: [], tests: [] });
    await writeInlineSpec(root, changeId, 'behavior', [
      '# Delta for behavior',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: TopicOnly',
      '',
      'The topic-only rule MUST stay at related level without behavioral anchors.',
      '',
    ].join('\n'));
    const pyTarget = path.join(root, 'test', 'behavior.spec.py');
    await mkdir(path.dirname(pyTarget), { recursive: true });
    await writeFile(pyTarget, [
      'def test_masked():',
      "    # topic.thing only in a comment",
      "    caption = 'topic.thing only in a string'",
      '    assert caption',
      '',
      'def test_real():',
      '    topic.thing()',
      '',
    ].join('\n'), 'utf8');
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--test', 'test/behavior.spec.py', '--json']);
    assert.equal(exitCode, 0);
    const edge = value.structural.edges.find((entry) => entry.relation === 'symbol_test');
    assert.ok(edge, 'the topic-matched edge is emitted');
    assert.equal(edge.outcome, 'candidate', 'the real python call is an unmasked anchor');
    assert.equal(edge.behavioral_assertion_refs.length, 1);
    assert.ok(edge.behavioral_assertion_refs[0].span.end > edge.behavioral_assertion_refs[0].span.start);
  });

  it('never turns a suggestion into coverage, QA status, or a gate result', async () => {
    const root = await makeTemp('aif-tls-cov-');
    await seedCaseProject(root, 'cov-change', { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: ['test/auth.spec.mjs'] });
    const { exitCode, value } = await runCommand(root, ['--change', 'cov-change', '--enabled', 'true', '--test', 'test/auth.spec.mjs', '--write', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(validateJsonAgainstSchema(value, parseStrictJson(await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8'))).length, 0);
    const engineSource = await readFile(new URL(`../${ENGINE_MODULE}`, import.meta.url), 'utf8');
    assert.ok(!engineSource.includes("from './aif-gate-result.mjs'"), 'the engine never imports the gate-result writer');
    assert.ok(!engineSource.includes("from './write-gate-evidence.mjs'"), 'the engine never writes QA evidence');
    assert.ok(!engineSource.includes("from './openspec-coverage-matrix.mjs'"), 'the engine never imports the frozen coverage matrix');
    assert.ok(!/\bfetch\s*\(/.test(engineSource) && !engineSource.includes('node:http') && !engineSource.includes('node:https'), 'the engine opens no network path');
    const entries = await readdir(path.join(root, '.ai-factory'), { recursive: true, withFileTypes: true });
    assert.equal(entries.some((entry) => entry.name === 'coverage.json'), false, 'no coverage.json anywhere');
  });
});

// ---------------------------------------------------------------------------
// N:M typed graph: explicit edges, no cross-product, dedup by full typed edge
// ---------------------------------------------------------------------------

describe('trace-link-suggestions N:M graph', () => {
  it('preserves every explicit edge of 1->N, N->1, and N->M without cross-product', async () => {
    const root = await makeTemp('aif-tls-nm-');
    await seedCaseProject(root, 'nm-change', { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: ['test/auth.spec.mjs', 'test/auth.spec.md', 'test/ru.spec.md'] });
    const { exitCode, value } = await runCommand(root, ['--change', 'nm-change', '--enabled', 'true', '--test', 'test/auth.spec.mjs', '--test', 'test/auth.spec.md', '--test', 'test/ru.spec.md', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(value.structural.outcome, 'candidate');
    assert.equal(value.structural.scan.coverage, 'full');
    const labels = edgesAsLabels(value);
    // 1->N: auth.login carries two symbol_scenario edges.
    assert.equal(labels.filter((edge) => edge.relation === 'symbol_scenario' && edge.from === 'operation:auth.login').length, 2);
    // N->1: two symbols reach AuthLoginHappy; the full cross-product would add logout->AuthLoginDenied.
    assert.equal(labels.some((edge) => edge.relation === 'symbol_scenario' && edge.from === 'operation:auth.logout' && edge.to === 'scn:#AuthLoginDenied'), false);
    // Dedup keeps distinct typed edges: both symbol_scenario edges to AuthLoginHappy exist.
    assert.equal(labels.filter((edge) => edge.relation === 'symbol_scenario' && edge.to === 'scn:#AuthLoginHappy').length, 2);
    assert.equal(labels.length, 12);
  });
});

// ---------------------------------------------------------------------------
// Composite binding, read-time revalidation, mid-run freshness
// ---------------------------------------------------------------------------

describe('trace-link-suggestions binding and revalidation', () => {
  async function seededWritten(root, changeId = 'bind-change') {
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: ['test/auth.spec.mjs'] });
    const { exitCode } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--test', 'test/auth.spec.mjs', '--write', '--json']);
    assert.equal(exitCode, 0);
    return parseStrictJson(await readFile(path.join(root, traceLinkPaths(changeId).observation), 'utf8'));
  }

  it('is current right after the write and names drifted inputs on edits', async () => {
    const root = await makeTemp('aif-tls-bind-');
    const observation = await seededWritten(root);
    assert.equal(observation.binding, observation.binding);
    const fresh = await validateObservationBinding(root, observation);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.stale, false);
    assert.deepEqual(fresh.mismatched, []);

    const specPath = path.join(root, 'openspec', 'changes', 'bind-change', 'specs', 'spec-en', 'spec.md');
    await writeFile(specPath, `${await readFile(specPath, 'utf8')}\n`);
    const driftedSpec = await validateObservationBinding(root, observation);
    assert.equal(driftedSpec.stale, true);
    assert.ok(driftedSpec.mismatched.some((field) => field.startsWith('inputs:')), driftedSpec.mismatched.join(','));
    assert.ok(driftedSpec.mismatched.includes('binding'));
  });

  it('names trace drift and a deleted trace manifest', async () => {
    const root = await makeTemp('aif-tls-bind2-');
    const observation = await seededWritten(root);
    const manifest = path.join(root, traceManifestPath('bind-change'));
    await writeFile(manifest, `${await readFile(manifest, 'utf8')}`);
    const drifted = await validateObservationBinding(root, observation);
    assert.equal(drifted.mismatched.includes('trace'), false, 'rewriting identical bytes is not drift');
    await writeFile(manifest, '{"trace":{},"manifestDigest":"sha256:' + '0'.repeat(64) + '"}');
    const invalid = await validateObservationBinding(root, observation);
    assert.ok(invalid.mismatched.includes('trace'), invalid.mismatched.join(','));
    await rm(manifest);
    const deleted = await validateObservationBinding(root, observation);
    assert.ok(deleted.mismatched.includes('trace'));
    assert.equal(deleted.stale, true);
  });

  it('names engine, helper, and contract drift through the read seam', async () => {
    const root = await makeTemp('aif-tls-bind3-');
    const observation = await seededWritten(root);
    const drifted = await validateObservationBinding(root, observation, {
      readEngine: (url) => (String(url).includes(ENGINE_MODULE) ? Buffer.from('drifted engine') : readFile(url)),
    });
    assert.ok(drifted.mismatched.includes('engine'));
    const helperDrift = await validateObservationBinding(root, observation, {
      readEngine: (url) => (String(url).includes(HELPER_MODULE) ? Buffer.from('drifted helper') : readFile(url)),
    });
    assert.ok(helperDrift.mismatched.includes('helper'));
    const contractDrift = await validateObservationBinding(root, observation, {
      readEngine: (url) => (String(url).includes(CONTRACT_MODULE) ? Buffer.from('{"drifted":true}') : readFile(url)),
    });
    assert.ok(contractDrift.mismatched.includes('contract'));
  });

  it('names rubric, relation policy, and candidate payload edits on a recorded observation', async () => {
    const root = await makeTemp('aif-tls-bind4-');
    const observation = await seededWritten(root);
    const rubricEdit = structuredClone(observation);
    rubricEdit.rubric.version = 2;
    const rubricDrift = await validateObservationBinding(root, rubricEdit);
    assert.ok(rubricDrift.mismatched.includes('rubric'), rubricDrift.mismatched.join(','));
    assert.equal(rubricDrift.stale, true);

    const policyEdit = structuredClone(observation);
    policyEdit.relation_policy = {
      ...policyEdit.relation_policy,
      relations: [...policyEdit.relation_policy.relations.slice(0, 3), { relation: 'scenario_test', from_kind: 'semantic_symbol', to_kind: 'test' }],
    };
    const policyDrift = await validateObservationBinding(root, policyEdit);
    assert.ok(policyDrift.mismatched.includes('relation_policy'), policyDrift.mismatched.join(','));

    const payloadEdit = structuredClone(observation);
    payloadEdit.structural.edges[0].behavioral_assertion_refs.push({
      path: payloadEdit.structural.trace.path,
      span: { start: 0, end: 1 },
      document_sha256: `sha256:${payloadEdit.structural.trace.sha256}`,
      span_sha256: `sha256:${'a'.repeat(64)}`,
    });
    const payloadDrift = await validateObservationBinding(root, payloadEdit);
    assert.ok(payloadDrift.mismatched.includes('candidate_payload'), payloadDrift.mismatched.join(','));
    assert.ok(payloadDrift.mismatched.includes('binding'));
  });

  it('refuses schema-valid tampering that breaks engine invariants', async () => {
    const root = await makeTemp('aif-tls-bind5-');
    const observation = await seededWritten(root);
    const overrideEdit = structuredClone(observation);
    overrideEdit.language_source = 'override';
    overrideEdit.language_options.override = 'en';
    assert.equal((await validateObservationBinding(root, overrideEdit)).code, 'observation-invalid');

    const noneEdit = structuredClone(observation);
    noneEdit.structural.outcome = 'none';
    assert.equal((await validateObservationBinding(root, noneEdit)).code, 'observation-invalid');

    const partialEdit = structuredClone(observation);
    partialEdit.structural.scan.coverage = 'partial';
    partialEdit.structural.outcome = 'candidate';
    assert.throws(() => assertStructuralInvariants(partialEdit));
    assert.equal((await validateObservationBinding(root, partialEdit)).code, 'observation-invalid');

    const fullWithMissingEdit = structuredClone(observation);
    fullWithMissingEdit.structural.scan.missing_sources = [{ path: 'test/ghost.spec.mjs', reason: 'file-missing' }];
    assert.equal((await validateObservationBinding(root, fullWithMissingEdit)).code, 'observation-invalid');

    const failedSemanticEdit = structuredClone(observation);
    failedSemanticEdit.semantic.run_status = 'failed';
    failedSemanticEdit.semantic.assessments = [{ edge_id: 'edge-999', verdict: 'supports', rationale: 'ghost assessment' }];
    assert.equal((await validateObservationBinding(root, failedSemanticEdit)).code, 'observation-invalid');

    const notRunSemanticEdit = structuredClone(observation);
    notRunSemanticEdit.semantic.run_status = 'not_run';
    notRunSemanticEdit.semantic.assessments = [{ edge_id: 'edge-1', verdict: 'supports', rationale: 'assessed without a stage' }];
    assert.equal((await validateObservationBinding(root, notRunSemanticEdit)).code, 'observation-invalid');

    const duplicateAssessmentEdit = structuredClone(observation);
    duplicateAssessmentEdit.semantic.assessments = [
      ...duplicateAssessmentEdit.semantic.assessments,
      { ...duplicateAssessmentEdit.semantic.assessments[0], verdict: 'contradicts' },
    ];
    assert.equal((await validateObservationBinding(root, duplicateAssessmentEdit)).code, 'observation-invalid');
  });

  it('rejects tampered nodes whose exact_ref shape does not match their kind', async () => {
    const root = await makeTemp('aif-tls-kindref-');
    const observation = await seededWritten(root);
    const schema = parseStrictJson(await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8'));
    const tampered = structuredClone(observation);
    const testNode = tampered.structural.nodes.find((node) => node.kind === 'test');
    testNode.kind = 'semantic_symbol';
    // The schema's oneOf branches pin kind consts AND ref shapes together.
    assert.ok(validateJsonAgainstSchema(tampered, schema).length > 0, 'schema rejects the kind/ref mismatch');
    const shape = validateGraphShape({ nodes: tampered.structural.nodes, edges: tampered.structural.edges });
    assert.equal(shape.ok, false);
    assert.equal(shape.code, 'kind-ref-mismatch');
    assert.equal((await validateObservationBinding(root, tampered)).code, 'observation-invalid');
  });

  it('marks an observation stale when a delta spec is added after the write', async () => {
    const root = await makeTemp('aif-tls-inventory-');
    const observation = await seededWritten(root);
    const fresh = await validateObservationBinding(root, observation);
    assert.equal(fresh.stale, false);
    await writeInlineSpec(root, 'bind-change', 'extra', '# Delta for extra\n\n## ADDED Requirements\n\n### Requirement: LateAddition\n\nA spec added after the write MUST invalidate the observation.\n');
    const drifted = await validateObservationBinding(root, observation);
    assert.equal(drifted.stale, true);
    assert.ok(drifted.mismatched.includes('delta_spec_inventory'), drifted.mismatched.join(','));
    assert.ok(drifted.mismatched.includes('binding'));
  });

  it('keeps a malformed-UTF-8 spec consistently classified across write, probe, and revalidation', async () => {
    const root = await makeTemp('aif-tls-malformed-');
    const changeId = 'malformed-spec-change';
    await seedCaseProject(root, changeId, { trace: null, specs: ['specs/spec-en.md'], tests: [] });
    await mkdir(path.join(root, 'openspec', 'changes', changeId, 'specs', 'broken'), { recursive: true });
    await writeFile(path.join(root, 'openspec', 'changes', changeId, 'specs', 'broken', 'spec.md'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const manifest = path.join(root, traceManifestPath(changeId));
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(manifest, JSON.stringify({ trace: { schemaVersion: 'lekalo/trace-manifest/v0.2.16', identity: 'dev.lekalo.trace-manifest@0.2.16', completeness: 'full', nodes: [], relations: [], gaps: [] }, manifestDigest: `sha256:${digest(JSON.stringify({ schemaVersion: 'lekalo/trace-manifest/v0.2.16', identity: 'dev.lekalo.trace-manifest@0.2.16', completeness: 'full', nodes: [], relations: [], gaps: [] }))}` }), 'utf8');
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--write', '--json']);
    assert.equal(exitCode, 0, JSON.stringify(value?.codes ?? []));
    assert.equal(value.structural.outcome, 'abstain', 'an unreadable declared spec degrades coverage');
    assert.equal(value.structural.scan.coverage, 'partial');
    assert.ok(value.structural.scan.missing_sources.some((entry) => entry.path.endsWith('broken/spec.md')), JSON.stringify(value.structural.scan.missing_sources));
    const malformedInput = value.inputs.find((input) => input.path.endsWith('broken/spec.md'));
    assert.equal(malformedInput.kind, 'malformed');
    const observation = parseStrictJson(await readFile(path.join(root, traceLinkPaths(changeId).observation), 'utf8'));
    const fresh = await validateObservationBinding(root, observation);
    assert.equal(fresh.stale, false, 'a malformed spec must not be born stale (classification is consistent)');
    assert.deepEqual(fresh.mismatched, []);
  });

  it('degrades coverage for a dangling-symlink delta spec instead of skipping it silently', async () => {
    const root = await makeTemp('aif-tls-danglingspec-');
    const changeId = 'dangling-spec-change';
    await seedCaseProject(root, changeId, { trace: null, specs: ['specs/spec-en.md'], tests: [] });
    let symlinked = false;
    try {
      await symlink(path.join(root, 'no-such-target.md'), path.join(root, 'openspec', 'changes', changeId, 'specs', 'broken', 'spec.md'));
      symlinked = true;
    } catch {
      symlinked = false; // symlink privilege unavailable: the malformed-UTF-8 test above covers the same degradation path
    }
    if (!symlinked) return;
    const manifest = path.join(root, traceManifestPath(changeId));
    await mkdir(path.dirname(manifest), { recursive: true });
    const emptyTrace = { schemaVersion: 'lekalo/trace-manifest/v0.2.16', identity: 'dev.lekalo.trace-manifest@0.2.16', completeness: 'full', nodes: [], relations: [], gaps: [] };
    await writeFile(manifest, JSON.stringify({ trace: emptyTrace, manifestDigest: `sha256:${digest(JSON.stringify(emptyTrace))}` }), 'utf8');
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(value.structural.scan.coverage, 'partial');
    assert.ok(value.structural.scan.missing_sources.some((entry) => entry.path.endsWith('broken/spec.md')), 'the dangling spec is a declared missing source');
  });

  it('marks a mid-run swap stale through the freshness probe', async () => {
    const root = await makeTemp('aif-tls-swap-');
    const changeId = 'swap-change';
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: ['test/auth.spec.mjs'] });
    const testPath = path.join(root, 'test', 'auth.spec.mjs');
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--test', 'test/auth.spec.mjs', '--json'], {
      mutateDuringScan: async () => {
        await writeFile(testPath, '// swapped mid-run\n', 'utf8');
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(value.semantic.freshness, 'stale');
    assert.ok(value.diagnostics.some((entry) => entry.code === 'assessment-stale'));
  });
});

// ---------------------------------------------------------------------------
// Writer custody: state-only, guarded, preview-by-default
// ---------------------------------------------------------------------------

describe('trace-link-suggestions writer custody', () => {
  it('writes nothing without --write and stays clean in git', async () => {
    const root = await makeTemp('aif-tls-prev-');
    await seedCaseProject(root, 'prev-change', { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: ['test/auth.spec.mjs'] });
    await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n', 'utf8');
    await gitIn(root, ['init', '--initial-branch=main']);
    await gitIn(root, ['config', 'user.email', 'fixture@example.com']);
    await gitIn(root, ['config', 'user.name', 'fixture']);
    await gitIn(root, ['add', '.']);
    await gitIn(root, ['commit', '-m', 'init']);
    const { exitCode } = await runCommand(root, ['--change', 'prev-change', '--enabled', 'true', '--json']);
    assert.equal(exitCode, 0);
    const status = await gitIn(root, ['status', '--porcelain']);
    assert.equal(status.stdout, '', 'preview must not change the worktree');
    let missing = false;
    try { await readFile(path.join(root, traceLinkPaths('prev-change').observation)); } catch { missing = true; }
    assert.equal(missing, true);
  });

  it('persists only with --write, only under the default state root', async () => {
    const root = await makeTemp('aif-tls-write-');
    await seedCaseProject(root, 'write-change', { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: ['test/auth.spec.mjs'] });
    const { exitCode } = await runCommand(root, ['--change', 'write-change', '--enabled', 'true', '--write', '--json']);
    assert.equal(exitCode, 0);
    const observation = parseStrictJson(await readFile(path.join(root, traceLinkPaths('write-change').observation), 'utf8'));
    assert.equal(observation.schema, TRACE_LINK_SCHEMA);
    const namespaceFiles = await readdir(path.join(root, STATE_ROOT, 'write-change', TRACE_LINK_NAMESPACE));
    assert.deepEqual(namespaceFiles.sort(), ['.gitignore', 'observation.json']);
  });

  it('refuses a custom paths.state with state-root-mismatch', async () => {
    const root = await makeTemp('aif-tls-root-');
    await seedCaseProject(root, 'root-change', {
      config: 'paths:\n  state: .ai-factory/custom-state\naifhub:\n  traceLinkSuggestions:\n    enabled: true\n',
      trace: 'traces/dev-trace-nm.json',
      specs: ['specs/spec-en.md', 'specs/spec-ru.md'],
      tests: [],
    });
    const { exitCode, value } = await runCommand(root, ['--change', 'root-change', '--write', '--json']);
    assert.equal(exitCode, 1);
    assert.equal(value.state, 'observation-not-saved');
    assert.deepEqual(value.codes, ['state-root-mismatch']);
  });

  it('refuses a destination colliding with a presented input (observation-source-collision)', async () => {
    const root = await makeTemp('aif-tls-coll-');
    await seedCaseProject(root, 'coll-change', { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: ['test/auth.spec.mjs'] });
    const observation = parseStrictJson((await runCommand(root, ['--change', 'coll-change', '--enabled', 'true', '--json'])).text);
    observation.inputs.push({ path: traceLinkPaths('coll-change').observation, sha256: null, bytes: 0, kind: 'missing' });
    const config = await readTraceLinkSuggestionsConfig(root);
    const written = await writeTraceLinkObservation(root, observation, config);
    assert.equal(written.ok, false);
    assert.equal(written.code, 'observation-source-collision');
  });

  it('refuses file-shadow ancestors and foreign observation leaves', async () => {
    const root = await makeTemp('aif-tls-shadow-');
    const changeId = 'shadow-change';
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: [] });
    await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n', 'utf8');
    await mkdir(path.join(root, STATE_ROOT, changeId), { recursive: true });
    await writeFile(path.join(root, STATE_ROOT, changeId, TRACE_LINK_NAMESPACE), 'not a directory');
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--write', '--json']);
    assert.equal(exitCode, 1);
    assert.deepEqual(value.codes, ['file-shadow']);

    await rm(path.join(root, STATE_ROOT, changeId), { recursive: true, force: true });
    const observation = parseStrictJson((await runCommand(root, ['--change', changeId, '--json'])).text);
    const config = await readTraceLinkSuggestionsConfig(root);
    await mkdir(path.join(root, STATE_ROOT, changeId, TRACE_LINK_NAMESPACE), { recursive: true });
    await writeFile(path.join(root, traceLinkPaths(changeId).observation), '{"not":"an observation"}');
    const conflict = await writeTraceLinkObservation(root, observation, config);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'observation-leaf-conflict');
  });

  it('refuses tracked and not-ignored outputs for the observation and the namespace gitignore', async () => {
    const root = await makeTemp('aif-tls-git-');
    const changeId = 'git-change';
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: [] });
    await gitIn(root, ['init', '--initial-branch=main']);
    await gitIn(root, ['config', 'user.email', 'fixture@example.com']);
    await gitIn(root, ['config', 'user.name', 'fixture']);
    await gitIn(root, ['add', '.']);
    await gitIn(root, ['commit', '-m', 'init']);
    const refused = await runCommand(root, ['--change', changeId, '--write', '--json']);
    assert.equal(refused.exitCode, 1);
    assert.deepEqual(refused.value.codes, ['observation-path-not-ignored']);

    await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n', 'utf8');
    await gitIn(root, ['add', '.gitignore']);
    await gitIn(root, ['commit', '-m', 'ignore runtime']);
    const allowed = await runCommand(root, ['--change', changeId, '--write', '--json']);
    assert.equal(allowed.exitCode, 0);

    await gitIn(root, ['add', '-f', traceLinkPaths(changeId).observation]);
    await gitIn(root, ['commit', '-m', 'tracked observation']);
    const tracked = await runCommand(root, ['--change', changeId, '--write', '--json']);
    assert.equal(tracked.exitCode, 1);
    assert.deepEqual(tracked.value.codes, ['observation-path-tracked']);

    await gitIn(root, ['rm', '--cached', traceLinkPaths(changeId).observation]);
    await gitIn(root, ['commit', '-m', 'untrack observation']);
    await gitIn(root, ['add', '-f', `${traceLinkPaths(changeId).directory}/.gitignore`]);
    await gitIn(root, ['commit', '-m', 'tracked gitignore']);
    const trackedGitignore = await runCommand(root, ['--change', changeId, '--write', '--json']);
    assert.equal(trackedGitignore.exitCode, 1);
    assert.deepEqual(trackedGitignore.value.codes, ['observation-path-tracked']);
  });

  it('keeps the atomic temp+rename window closed (TOCTOU re-check)', async () => {
    const root = await makeTemp('aif-tls-toctou-');
    const changeId = 'toctou-change';
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: [] });
    await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n', 'utf8');
    const observation = parseStrictJson((await runCommand(root, ['--change', changeId, '--json'])).text);
    const config = await readTraceLinkSuggestionsConfig(root);
    const written = await writeTraceLinkObservation(root, observation, config, {
      beforeRename: async () => {
        await writeFile(path.join(root, traceLinkPaths(changeId).observation), 'swapped in the window');
      },
    });
    assert.equal(written.ok, false);
    assert.equal(written.code, 'observation-leaf-conflict');
    const namespaceFiles = await readdir(path.join(root, STATE_ROOT, changeId, TRACE_LINK_NAMESPACE));
    assert.deepEqual(namespaceFiles.sort(), ['.gitignore', 'observation.json'], 'no partial temp file survives a refused rename');
  });
});

// ---------------------------------------------------------------------------
// QA namespace isolation and the behavioral #228 boundary
// ---------------------------------------------------------------------------

describe('trace-link-suggestions QA namespace isolation', () => {
  const QA_CONFIG = CONFIG_ON;

  async function seedGitProject(root) {
    await mkdir(path.join(root, '.ai-factory'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n');
    await seedCaseProject(root, 'work', {
      config: QA_CONFIG,
      trace: 'traces/heldout-trace-behavior.json',
      specs: [],
      tests: [],
    });
    // The QA trace references TopicOnly; the minimal QA change carries its
    // delta spec so the scan completes with an honest empty result.
    const specTarget = path.join(root, 'openspec', 'changes', 'work', 'specs', 'qa', 'spec.md');
    await mkdir(path.dirname(specTarget), { recursive: true });
    await writeFile(specTarget, '# Delta for qa\n\n## ADDED Requirements\n\n### Requirement: TopicOnly\n\nThe topic-only rule MUST stay advisory.\n', 'utf8');
    await gitIn(root, ['init', '--initial-branch=main']);
    await gitIn(root, ['config', 'user.email', 'fixture@example.com']);
    await gitIn(root, ['config', 'user.name', 'fixture']);
    await gitIn(root, ['add', '.']);
    await gitIn(root, ['commit', '-m', 'init']);
    await ensureRuntimeGitignore(root, STATE_ROOT);
    const toolchain = [{ name: 'fixture-node', sha256: digest('node') }];
    const check = {
      id: 'check-verify', gate: 'verify', profile: 'declared.v1', dependencies_complete: true,
      inputs: ['openspec/changes/work'], command: { argv: ['fake'], cwd: '.' }, toolchain, env_inputs: [], requires_observed: false,
    };
    const options = {
      rootDir: root, changeId: 'work', scope: ['openspec/changes/work'], checks: [check], environment: {},
      providers: {
        requirements: async () => ({ gates: ['verify'], independent_roles: [], evidence: [] }),
        toolchain: async () => toolchain,
      },
    };
    assert.equal((await prepareQaManifest(options)).ok, true, 'qa enrollment needs a real git worktree');
    return options;
  }

  async function observe(options) {
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    const snapshot = await observeQaSnapshot(store, payload);
    return {
      files: Object.keys(snapshot.files).sort(),
      ignored_names: snapshot.ignored_names,
      changed_paths: snapshot.changed_paths,
      digest: snapshot.digest,
    };
  }

  it('keeps the QA fingerprint identical across write, overwrite, and deletion', async () => {
    const root = await makeTemp('aif-tls-qa1-');
    const options = await seedGitProject(root);
    const before = await observe(options);
    const argv = ['--change', 'work', '--enabled', 'true', '--write', '--json'];
    assert.equal(await runTraceLinkSuggestionsCommand(argv, { rootDir: root, output: () => {} }), 0);
    const afterWrite = await observe(options);
    assert.deepEqual(afterWrite, before);
    assert.equal(await runTraceLinkSuggestionsCommand(argv, { rootDir: root, output: () => {} }), 0, 'overwrite of the same-change observation is allowed');
    const afterOverwrite = await observe(options);
    assert.deepEqual(afterOverwrite, before);
    await rm(path.join(root, STATE_ROOT, 'work', TRACE_LINK_NAMESPACE, 'observation.json'));
    const afterDelete = await observe(options);
    assert.deepEqual(afterDelete, before);
    assert.ok(!before.files.some((p) => p.includes(TRACE_LINK_NAMESPACE)), 'namespace never enters the projected file catalog');
    assert.ok(!before.ignored_names.some((p) => p.includes(TRACE_LINK_NAMESPACE)), 'namespace never enters ignored_names');
    assert.ok(!before.changed_paths.some((p) => p.includes(TRACE_LINK_NAMESPACE)), 'namespace never enters changed_paths');
  });

  it('filters the namespace at the projection layer even in front of an injected SnapshotProvider', async () => {
    const root = await makeTemp('aif-tls-qa2-');
    const options = await seedGitProject(root);
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    const injected = {
      observe: async () => ({
        complete: true,
        worktree_identity: 'a'.repeat(64),
        modules: { 'scripts/qa-manifest.mjs': digest('x') },
        actual_diff: null,
        files: {
          'docs/spec.md': Buffer.from('spec'),
          [`.ai-factory/state/work/${TRACE_LINK_NAMESPACE}/observation.json`]: Buffer.from('{}'),
          [`.ai-factory/state/work/${TRACE_LINK_NAMESPACE}/.gitignore`]: Buffer.from('*\n'),
        },
        directory_names: [`.ai-factory/state/work/${TRACE_LINK_NAMESPACE}`],
        ignored_names: [`.ai-factory/state/work/${TRACE_LINK_NAMESPACE}/observation.json`],
        changed_paths: [`.ai-factory/state/work/${TRACE_LINK_NAMESPACE}/observation.json`],
      }),
    };
    const snapshot = await observeQaSnapshot(store, payload, { SnapshotProvider: injected });
    const leak = (p) => p.includes(TRACE_LINK_NAMESPACE);
    assert.ok(!Object.keys(snapshot.files).some(leak), 'injected-provider files must not leak the namespace');
    assert.ok(!snapshot.ignored_names.some(leak), 'injected-provider ignored_names must not leak the namespace');
    assert.ok(!snapshot.changed_paths.some(leak), 'injected-provider changed_paths must not leak the namespace');
    assert.ok(snapshot.files['docs/spec.md'], 'presented scope stays projected');
  });

  it('keeps the #228 boundary behavioral: no gate result, no QA surface shift, unchanged frozen parsing', async () => {
    const root = await makeTemp('aif-tls-qa3-');
    const options = await seedGitProject(root);
    const before = await observe(options);
    const beforeTree = await treeFingerprint(root);
    assert.equal(await runTraceLinkSuggestionsCommand(['--change', 'work', '--enabled', 'true', '--write', '--json'], {
      rootDir: root, output: () => {},
    }), 0);
    assert.deepEqual(await observe(options), before, 'done-readiness QA surfaces stay identical after the observation write');
    assert.notEqual(await treeFingerprint(root), beforeTree, 'the only mutated surface is the closed runtime namespace');
    const { parseToolConfig } = await import('./tool-config.mjs');
    const withScan = 'config_version: 1\naifhub:\n  tools:\n    openspec: true\n    hlv: false\n    lekalo: false\n  traceLinkSuggestions:\n    enabled: false\n';
    const withoutScan = 'config_version: 1\naifhub:\n  tools:\n    openspec: true\n    hlv: false\n    lekalo: false\n';
    assert.deepEqual(parseToolConfig(withScan), parseToolConfig(withoutScan));
    const { parseProviderConfig, normalizeProviderPolicies } = await import('./provider-policy.mjs');
    const base = 'aifhub:\n  providers:\n    hlv:\n      enable: true\n      policy: optional\n';
    assert.deepEqual(normalizeProviderPolicies(parseProviderConfig(`${base}  traceLinkSuggestions:\n    enabled: false\n`)), normalizeProviderPolicies(parseProviderConfig(base)));
  });

  it('never lets a strong candidate become QA evidence and leaves coverage/status/trace untouched', async () => {
    const root = await makeTemp('aif-tls-qa4-');
    const changeId = 'qa4-change';
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: ['test/auth.spec.mjs', 'test/auth.spec.md', 'test/ru.spec.md'] });
    const tracePath = path.join(root, traceManifestPath(changeId));
    const traceBefore = await readFile(tracePath);
    const treeBefore = await treeFingerprint(root);
    const preview = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--test', 'test/auth.spec.mjs', '--test', 'test/auth.spec.md', '--test', 'test/ru.spec.md', '--json']);
    assert.equal(preview.exitCode, 0);
    assert.ok(preview.value.structural.edges.some((edge) => edge.outcome === 'candidate'), 'the scan produced a strong candidate');
    assert.equal(await treeFingerprint(root), treeBefore, 'preview mutates nothing');
    const written = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--test', 'test/auth.spec.mjs', '--test', 'test/auth.spec.md', '--test', 'test/ru.spec.md', '--write', '--json']);
    assert.equal(written.exitCode, 0);
    const entries = await readdir(path.join(root, '.ai-factory'), { recursive: true, withFileTypes: true });
    assert.equal(entries.some((entry) => entry.name === 'coverage.json'), false);
    assert.equal(entries.some((entry) => entry.name === 'verify.md'), false);
    assert.deepEqual(await readFile(tracePath), traceBefore, 'trace bytes untouched by the consumer');
    const rejected = await runCommand(root, ['--change', changeId, '--enabled', 'false', '--write', '--json']);
    assert.equal(rejected.exitCode, 0);
    assert.deepEqual(await readFile(tracePath), traceBefore, 'rejected run leaves the trace byte-identical');
  });
});

// ---------------------------------------------------------------------------
// AC7: trace exports stay byte-identical across consumer states
// ---------------------------------------------------------------------------

describe('trace-link-suggestions AC7 byte-identity', () => {
  async function seedAc7(root) {
    const changeId = 'ac7-change';
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: ['test/auth.spec.mjs'] });
    const tracePath = path.join(root, traceManifestPath(changeId));
    return { changeId, tracePath, before: await readFile(tracePath) };
  }

  async function expectIdentical(tracePath, before, label, runner) {
    await runner();
    assert.deepEqual(await readFile(tracePath), before, `trace bytes must stay byte-identical: ${label}`);
  }

  it('keeps raw trace bytes identical across off, preview, write, refusal, stale, partial, and malformed branches', async () => {
    const root = await makeTemp('aif-tls-ac7-');
    const { changeId, tracePath, before } = await seedAc7(root);
    assert.deepEqual(await readFile(tracePath), before);

    await expectIdentical(tracePath, before, 'consumer off', async () => {
      const run = await runCommand(root, ['--change', changeId, '--json'], { config: { enabled: false, enabledMalformed: false, stateRoot: STATE_ROOT, qaRoot: '.ai-factory/qa', diagnostics: [] } });
      assert.equal(run.exitCode, 0);
      assert.deepEqual(run.value.codes, ['trace-link-suggestions-disabled']);
    });
    await expectIdentical(tracePath, before, 'preview', async () => {
      assert.equal((await runCommand(root, ['--change', changeId, '--enabled', 'true', '--test', 'test/auth.spec.mjs', '--json'])).exitCode, 0);
    });
    await expectIdentical(tracePath, before, 'write', async () => {
      assert.equal((await runCommand(root, ['--change', changeId, '--enabled', 'true', '--test', 'test/auth.spec.mjs', '--write', '--json'])).exitCode, 0);
    });
    await expectIdentical(tracePath, before, 'refusal', async () => {
      assert.equal((await runCommand(root, ['--change', 'no-such-change', '--enabled', 'true', '--json'])).exitCode, 0);
    });
    await expectIdentical(tracePath, before, 'stale', async () => {
      const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json'], {
        mutateDuringScan: async () => {
          const specPath = path.join(root, 'openspec', 'changes', changeId, 'specs', 'spec-en', 'spec.md');
          await writeFile(specPath, `${await readFile(specPath, 'utf8')} drifted`, 'utf8');
        },
      });
      assert.equal(run.exitCode, 0);
      assert.equal(run.value.semantic.freshness, 'stale');
    });
    // For the mutated-trace branches the consumer must leave the bytes exactly
    // as the test wrote them: the comparison runs against the post-mutation
    // snapshot BEFORE any restore, so a consumer write would be caught; the
    // original fixture is restored in a finally afterwards.
    const mutatedBranches = [
      ['partial', async (manifest) => {
        const partial = parseStrictJson(await readFile(path.join(CORPUS_DIR, 'traces', 'dev-trace-partial.json'), 'utf8'));
        await writeFile(manifest, JSON.stringify(partial), 'utf8');
        const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
        assert.equal(run.exitCode, 0);
        assert.equal(run.value.structural.outcome, 'abstain');
      }],
      ['malformed', async (manifest) => {
        await writeFile(manifest, '{"broken"', 'utf8');
        const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
        assert.deepEqual(run.value.codes, ['trace-invalid']);
      }],
      ['overflow', async (manifest) => {
        await writeFile(manifest, Buffer.alloc(TRACE_EXPORT_LIMIT + 1, 0x20));
        const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
        assert.deepEqual(run.value.codes, ['export-overflow']);
      }],
    ];
    for (const [label, branch] of mutatedBranches) {
      const manifest = path.join(root, traceManifestPath(changeId));
      try {
        await branch(manifest);
        const mutated = await readFile(manifest);
        assert.deepEqual(await readFile(tracePath), mutated, `trace bytes must stay byte-identical to the mutated snapshot: ${label}`);
      } finally {
        await writeFile(tracePath, before, 'utf8');
      }
      assert.deepEqual(await readFile(tracePath), before, `restore returns the original bytes: ${label}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Registration, opt-in config, and injection pins
// ---------------------------------------------------------------------------

describe('trace-link-suggestions registration contracts', () => {
  it('keeps the description byte-identical in extension.json, the wrapper, and WRAPPER_COMMANDS', async () => {
    const manifest = parseStrictJson(await readFile(path.join(REPO_ROOT, 'extension.json'), 'utf8'));
    const command = manifest.commands.find((entry) => entry.name === 'aifhub-trace-link-suggestions');
    assert.ok(command, 'extension.json must declare the command');
    const wrapper = await readFile(path.join(REPO_ROOT, 'commands', 'aifhub-trace-link-suggestions.mjs'), 'utf8');
    const contract = await readFile(path.join(REPO_ROOT, 'scripts', 'aifhub-command-wrappers-contract.test.mjs'), 'utf8');
    const descriptionMatch = /const DESCRIPTION = '([^']+)'/.exec(wrapper);
    assert.ok(descriptionMatch, 'wrapper must pin DESCRIPTION');
    assert.equal(manifest.version, '1.8.1', 'the extension version is never bumped by this change');
    assert.equal(manifest.commands.length, 28, 'one command added on top of #282 (27 -> 28)');
    assert.ok(contract.includes("name: 'aifhub-trace-link-suggestions'"));
    assert.ok(contract.includes(descriptionMatch[1]));
    assert.equal(command.description, descriptionMatch[1], 'extension.json and wrapper descriptions must be byte-identical');
    assert.equal(manifest.commands.filter((entry) => entry.name === 'aifhub-trace-link-suggestions').length, 1);
  });

  it('registers the optional managed key and keeps the required-keys diff clean', async () => {
    const manifest = parseStrictJson(await readFile(path.join(REPO_ROOT, 'skills', 'aif-analyze', 'references', 'config-keys.json'), 'utf8'));
    const entry = manifest.keys.find((item) => item.key === 'aifhub.traceLinkSuggestions.enabled');
    assert.ok(entry, 'config-keys must declare aifhub.traceLinkSuggestions.enabled');
    assert.equal(entry.required, false, 'the trace link opt-in must stay optional');
    assert.equal(entry.since, '1.8.1');
    assert.ok(!manifest.keys.some((item) => item.key.startsWith('aifhub.traceLinkSuggestions.') && item.key !== 'aifhub.traceLinkSuggestions.enabled'),
      'policy keys must not be exposed');
    const template = await readFile(path.join(REPO_ROOT, 'skills', 'aif-analyze', 'references', 'config-template.yaml'), 'utf8');
    assert.ok(template.includes('# traceLinkSuggestions:'));
    assert.ok(template.includes('#   enabled: false'));
    const skill = await readFile(path.join(REPO_ROOT, 'skills', 'aif-analyze', 'SKILL.md'), 'utf8');
    assert.ok(skill.includes('Preserve existing `aifhub.traceLinkSuggestions.enabled` values and never enable the trace link suggestions automatically.'));
    assert.match(skill, /^version: 0\.20\.0$/m);

    const reviewPolicy = await readFile(path.join(REPO_ROOT, 'scripts', 'review-policy-contract.test.mjs'), 'utf8');
    assert.ok(reviewPolicy.includes("'version: 0.20.0'"), 'review-policy pin must target 0.20.0');
    assert.ok(reviewPolicy.includes('#283'), 'review-policy pin must carry its own #283 reason comment');
    const compat = await readFile(path.join(REPO_ROOT, 'scripts', 'openspec-1-12-compatibility.test.mjs'), 'utf8');
    assert.match(compat, /version: 0\\\.20\\\.0/);

    const { buildAnalyzeConfigDiff } = await import('./aif-analyze-config-diff.mjs');
    const { renderConfigForMode } = await import('./aif-artifact-sync.mjs');
    const root = await makeTemp('aif-tls-diff-');
    const rendered = renderConfigForMode('', 'openspec', { analyzeSkillVersion: '0.11.0' });
    const lines = rendered.split('\n');
    const hubIndex = lines.findIndex((line) => /^aifhub:$/.test(line));
    assert.ok(hubIndex >= 0, 'fresh openspec config must contain the aifhub hub');
    let insertAt = lines.findIndex((line, index) => index > hubIndex && /^\S/.test(line));
    if (insertAt < 0) insertAt = lines.length;
    lines.splice(insertAt, 0, '  traceLinkSuggestions:', '    enabled: false');
    await mkdir(path.join(root, '.ai-factory'), { recursive: true });
    await writeFile(path.join(root, '.ai-factory', 'config.yaml'), lines.join('\n'), 'utf8');
    const diff = await buildAnalyzeConfigDiff({ rootDir: root });
    assert.equal(diff.ok, true, JSON.stringify(diff.errors ?? []));
    assert.equal((diff.missing ?? []).length, 0, 'optional trace-link key must never appear as a missing required key');
  });

  it('pins the advisory hook call in the review and improve injections without root-script exposure', async () => {
    for (const relative of ['injections/core/aif-review-context-providers.md', 'injections/core/aif-improve-plan-folder.md']) {
      const source = await readFile(path.join(REPO_ROOT, relative), 'utf8');
      assert.ok(source.includes('ai-factory aifhub-trace-link-suggestions --change <change-id> --enabled true --test <test-path> [--test <test-path> ...] --json'), relative);
      assert.ok(source.includes('without `--write`'), `${relative} must keep the hook preview-only`);
      assert.ok(source.includes('#### Advisory trace link suggestions (opt-in, preview only)'), relative);
      assert.ok(source.includes('advisory scan was not performed'), relative);
      assert.ok(!/\bnode\s+scripts\/[A-Za-z0-9_.-]+\.mjs\b/.test(source), `${relative} must not expose root scripts`);
    }
    const review = await readFile(path.join(REPO_ROOT, 'injections/core/aif-review-context-providers.md'), 'utf8');
    const claimEvidenceIndex = review.indexOf('#### Advisory claim evidence check (opt-in, preview only)');
    const traceIndex = review.indexOf('#### Advisory trace link suggestions (opt-in, preview only)');
    const legacyIndex = review.indexOf('### Legacy AI Factory-only mode');
    assert.ok(claimEvidenceIndex > 0 && traceIndex > claimEvidenceIndex && legacyIndex > traceIndex, 'review section order: claim evidence, trace links, legacy');
    const improve = await readFile(path.join(REPO_ROOT, 'injections/core/aif-improve-plan-folder.md'), 'utf8');
    const lintIndex = improve.indexOf('#### Optional requirement ambiguity lint (opt-in, advisory)');
    const improveTraceIndex = improve.indexOf('#### Advisory trace link suggestions (opt-in, preview only)');
    const preservationIndex = improve.indexOf('Preservation rules:');
    assert.ok(lintIndex > 0 && improveTraceIndex > lintIndex && preservationIndex > improveTraceIndex, 'improve section order: lint, trace links, preservation rules');
    assert.ok(improve.includes('independent of whether the requirement ambiguity lint ran'), 'the improve section stays independent of the lint opt-in');
    for (const relative of ['injections/core/aif-plan-plan-folder.md', 'injections/core/aif-explore-plan-folder.md']) {
      const source = await readFile(path.join(REPO_ROOT, relative), 'utf8');
      assert.equal(source.includes('aifhub-trace-link-suggestions'), false, `${relative} must not carry the trace-link hook`);
    }
  });
});

// ---------------------------------------------------------------------------
// Corpus evaluation (fixtures + labels)
// ---------------------------------------------------------------------------

describe('trace-link-suggestions corpus evaluation (fixtures + labels)', () => {
  const loadLabels = async () => parseStrictJson(await readFile(path.join(CORPUS_DIR, 'labels.json'), 'utf8'));

  it('matches the structural expectations exactly on dev and heldout cases with zero false accusations', async () => {
    const labels = await loadLabels();
    let falseAccusations = 0;
    const checked = [];
    for (const [index, testCase] of labels.cases.entries()) {
      const root = await makeTemp(`aif-tls-corpus-${index}-`);
      const changeId = `corpus-${testCase.id}`;
      await seedCaseProject(root, changeId, testCase);
      const { exitCode, value } = await runCommand(root, [
        '--change', changeId, '--enabled', 'true',
        ...testCase.tests.flatMap((testPath) => ['--test', testPath]),
        '--json',
      ], { assessor: testCase.assessor ? fakeAssessor : undefined });
      assert.equal(exitCode, 0, `${testCase.id} must complete`);
      const expected = testCase.expected_structural;
      assert.equal(value.structural.outcome, expected.outcome, `${testCase.id} outcome`);
      assert.equal(value.structural.scan.coverage, expected.coverage, `${testCase.id} coverage`);
      const actual = edgesAsLabels(value);
      assert.deepEqual(actual, sortedLabels(expected.edges), `${testCase.id} edge set`);
      if (expected.missing_sources) {
        assert.deepEqual(value.structural.scan.missing_sources.map((entry) => entry.path), expected.missing_sources, `${testCase.id} missing sources`);
      }
      if (expected.unsupported_trace_node_kinds !== undefined) {
        assert.equal(value.diagnostics.filter((entry) => entry.code === 'unsupported-trace-node-kind').length, expected.unsupported_trace_node_kinds, `${testCase.id} unsupported kinds`);
      }
      if (expected.unsupported_trace_relations !== undefined) {
        assert.equal(value.diagnostics.filter((entry) => entry.code === 'unsupported-trace-relation').length, expected.unsupported_trace_relations, `${testCase.id} unsupported relations`);
      }
      if (testCase.kind === 'ru-en') {
        const scenarioNode = value.structural.nodes.find((node) => node.kind === 'scenario' && node.exact_ref.heading.includes('CRLF'));
        assert.ok(scenarioNode, `${testCase.id} resolves the cyrillic CRLF scenario`);
        const bytes = await readFile(path.join(CORPUS_DIR, 'specs/spec-crlf.md'));
        assert.equal(scenarioNode.exact_ref.document_sha256, `sha256:${digest(bytes)}`, `${testCase.id} document digest covers raw CRLF bytes`);
        assert.equal(scenarioNode.exact_ref.span_sha256, `sha256:${digest(bytes.subarray(scenarioNode.exact_ref.span.start, scenarioNode.exact_ref.span.end))}`, `${testCase.id} span digest is byte-exact`);
        assert.ok(bytes.subarray(scenarioNode.exact_ref.span.start, scenarioNode.exact_ref.span.end).toString('utf8').includes('#### Scenario: Кириллический CRLF'), `${testCase.id} span covers the heading`);
      }
      if (testCase.forbidden_echo) {
        for (const phrase of testCase.forbidden_echo) {
          assert.equal(JSON.stringify(value).includes(phrase), false, `${testCase.id} must not echo ${phrase}`);
        }
      }
      if (testCase.negative) {
        falseAccusations += actual.filter((edge) => edge.outcome === 'candidate').length;
      }
      checked.push(testCase.id);
    }
    assert.ok(checked.includes('dev-nm') && checked.includes('heldout-behavior'), 'dev and heldout slices both evaluated');
    assert.equal(falseAccusations, labels.thresholds.negative_false_accusations, 'zero false accusations on negatives');
  });

  it('keeps the semantic slice separate: fake-assessor verdicts transport without touching the structural section', async () => {
    const labels = await loadLabels();
    for (const testCase of labels.cases.filter((entry) => entry.assessor)) {
      const root = await makeTemp(`aif-tls-semantic-${testCase.id}-`);
      const changeId = `semantic-${testCase.id}`;
      await seedCaseProject(root, changeId, testCase);
      const { exitCode, value } = await runCommand(root, [
        '--change', changeId, '--enabled', 'true',
        ...testCase.tests.flatMap((testPath) => ['--test', testPath]),
        '--json',
      ], { assessor: fakeAssessor });
      assert.equal(exitCode, 0);
      assert.equal(value.semantic.run_status, 'complete');
      assert.equal(value.semantic.freshness, 'current');
      const supports = value.semantic.assessments.filter((entry) => entry.verdict === 'supports').length;
      const insufficient = value.semantic.assessments.filter((entry) => entry.verdict === 'insufficient').length;
      assert.deepEqual({ supports, insufficient }, {
        supports: testCase.expected_semantic.supports,
        insufficient: testCase.expected_semantic.insufficient,
      }, `${testCase.id} semantic distribution`);
      assert.equal(value.structural.outcome, testCase.expected_structural.outcome, `${testCase.id} structural section untouched by the semantic stage`);
    }
  });

  it('reports an honest not_run semantic stage without an assessor', async () => {
    const root = await makeTemp('aif-tls-noassessor-');
    const changeId = 'no-assessor-change';
    await seedCaseProject(root, changeId, { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md', 'specs/spec-ru.md'], tests: ['test/auth.spec.mjs'] });
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--test', 'test/auth.spec.mjs', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(value.semantic.run_status, 'not_run');
    assert.equal(value.semantic.assessments.length, 0);
    assert.ok(value.diagnostics.some((entry) => entry.code === 'assessment-not-run' && entry.detail === 'assessor-unavailable'));
    assert.equal(value.semantic.outcome_reason, 'assessor-unavailable', 'the not_run reason names the concrete cause');
    assert.ok(value.structural.edges.length > 0, 'structural results survive the not_run semantic stage');
  });

  it('executes every labeled refusal case from labels.json', async () => {
    const labels = await loadLabels();
    assert.ok(labels.refusals.length >= 7, `the refusal corpus ships ${labels.refusals.length} cases`);
    for (const [index, refusal] of labels.refusals.entries()) {
      const root = await makeTemp(`aif-tls-refusal-${index}-`);
      const changeId = `refusal-${refusal.id}`;
      await seedCaseProject(root, changeId, {
        trace: refusal.foreign_change ? null : refusal.trace,
        specs: refusal.specs ?? [],
        tests: refusal.tests ?? [],
        foreignChange: refusal.foreign_change ? 'other-change' : null,
        foreignTrace: refusal.foreign_change ? refusal.trace : null,
      });
      const { exitCode, value } = await runCommand(root, [
        '--change', changeId, '--enabled', 'true',
        ...(refusal.tests ?? []).flatMap((testPath) => ['--test', testPath]),
        '--json',
      ]);
      assert.equal(exitCode, refusal.exit, `${refusal.id} exit code`);
      if (refusal.exit === 2) {
        assert.deepEqual(value.codes, [refusal.expected_code], `${refusal.id} refusal code`);
      } else {
        assert.equal(value.state, 'not_run', `${refusal.id} is an honest not_run`);
        assert.deepEqual(value.codes, [refusal.expected_code], `${refusal.id} not_run code`);
      }
      if (refusal.foreign_change) {
        const foreign = await readFile(path.join(root, '.ai-factory', 'traces', 'other-change', 'lekalo-trace-manifest.json'));
        assert.ok(foreign.length > 0, `${refusal.id}: foreign custody file untouched`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Local parser and topic primitives: behavioral parity pins on shared fixtures
// ---------------------------------------------------------------------------

describe('trace-link-suggestions local parser parity', () => {
  it('parses shared fixture specs identically across LF, CRLF, and cyrillic headings', async () => {
    const en = await readFile(path.join(CORPUS_DIR, 'specs/spec-en.md'));
    const enRequirements = parseRequirementsFromBytes(en, 'specs/spec-en.md');
    assert.deepEqual(enRequirements.map((requirement) => requirement.title), ['AuthOptIn', 'Partial Coverage Rule', 'TopicOnly']);
    assert.deepEqual(enRequirements[0].scenarios.map((scenario) => scenario.heading), ['AuthLoginHappy', 'AuthLoginDenied']);

    const crlf = await readFile(path.join(CORPUS_DIR, 'specs/spec-crlf.md'));
    assert.ok(crlf.includes(Buffer.from('\r\n', 'latin1')), 'the byte pin keeps CRLF intact');
    const crlfRequirements = parseRequirementsFromBytes(crlf, 'specs/spec-crlf.md');
    assert.deepEqual(crlfRequirements.map((requirement) => requirement.title), ['CrlfProbe']);
    const scenario = crlfRequirements[0].scenarios[0];
    assert.equal(scenario.heading, 'Кириллический CRLF');
    assert.ok(crlf.subarray(scenario.start, scenario.end).toString('utf8').startsWith('#### Scenario: Кириллический CRLF'), 'byte-exact span start');
    assert.ok(crlf.subarray(scenario.start, scenario.end).toString('utf8').includes('GIVEN'), 'the span covers the scenario body');
  });

  it('tokenizes with the shared EN-only stopword discipline', () => {
    assert.deepEqual(tokenize('The system MUST gate the auth adapter'), ['gate', 'auth', 'adapter']);
    assert.deepEqual(tokenize('Система ОБЯЗАНА сообщать'), [], 'cyrillic text yields no ASCII tokens (EN-only stopwords, no neutrality claim)');
    assert.equal(intersects(tokenize('auth adapter'), tokenize('adapter gate')), true);
    assert.equal(intersects(tokenize('auth adapter'), tokenize('unrelated')), false);
  });
});

// ---------------------------------------------------------------------------
// Graph limits: bounded output, never a masked none
// ---------------------------------------------------------------------------

describe('trace-link-suggestions graph limits', () => {
  it('truncates oversized graphs to partial coverage with an honest abstain', async () => {
    const root = await makeTemp('aif-tls-limits-');
    const changeId = 'limits-change';
    const nodes = Array.from({ length: 600 }, (_, index) => ({ symbol: `operation:bulk.symbol${index}` }));
    const trace = {
      schemaVersion: 'lekalo/trace-manifest/v0.2.16',
      identity: 'dev.lekalo.trace-manifest@0.2.16',
      completeness: 'full',
      nodes,
      relations: [],
      gaps: [],
    };
    const { createHash } = await import('node:crypto');
    const envelope = { trace, manifestDigest: `sha256:${createHash('sha256').update(JSON.stringify(trace)).digest('hex')}` };
    await seedCaseProject(root, changeId, { specs: ['specs/spec-en.md'], tests: [] });
    const manifestPath = path.join(root, traceManifestPath(changeId));
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(envelope), 'utf8');
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(value.structural.nodes.length, GRAPH_LIMITS.max_nodes);
    assert.equal(value.structural.scan.coverage, 'partial');
    assert.equal(value.structural.outcome, 'abstain');
    assert.ok(value.diagnostics.some((entry) => entry.code === 'graph-truncated'));
  });

  it('degrades coverage when behavioral anchors are truncated beyond the per-edge cap', async () => {
    const root = await makeTemp('aif-tls-anchorlimit-');
    const changeId = 'anchor-limit-change';
    const trace = {
      schemaVersion: 'lekalo/trace-manifest/v0.2.16',
      identity: 'dev.lekalo.trace-manifest@0.2.16',
      completeness: 'full',
      nodes: [{ symbol: 'operation:anchor.thing' }],
      relations: [],
      gaps: [],
    };
    const { createHash } = await import('node:crypto');
    const envelope = { trace, manifestDigest: `sha256:${createHash('sha256').update(JSON.stringify(trace)).digest('hex')}` };
    await seedCaseProject(root, changeId, { specs: [], tests: [] });
    const manifestPath = path.join(root, traceManifestPath(changeId));
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(envelope), 'utf8');
    // 55 unmasked occurrences: 50 kept anchors plus dropped real anchors
    // beyond the cap — a coverage fact, never a silent full scan.
    const testLines = Array.from({ length: 55 }, () => 'anchor.thing();');
    const testTarget = path.join(root, 'test', 'anchors.spec.mjs');
    await mkdir(path.dirname(testTarget), { recursive: true });
    await writeFile(testTarget, testLines.join('\n'), 'utf8');
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--test', 'test/anchors.spec.mjs', '--json']);
    assert.equal(exitCode, 0);
    const edge = value.structural.edges.find((entry) => entry.relation === 'symbol_test');
    assert.ok(edge, 'the anchored edge is emitted');
    assert.equal(edge.behavioral_assertion_refs.length, GRAPH_LIMITS.max_assertion_refs_per_edge);
    assert.ok(value.diagnostics.some((entry) => entry.code === 'assertion-refs-truncated'));
    assert.equal(value.structural.scan.coverage, 'partial');
    assert.equal(value.structural.outcome, 'abstain');
  });

  it('keeps exactly-at-cap anchor sets complete (no false truncation)', async () => {
    const root = await makeTemp('aif-tls-anchorcap-');
    const changeId = 'anchor-cap-change';
    const trace = {
      schemaVersion: 'lekalo/trace-manifest/v0.2.16',
      identity: 'dev.lekalo.trace-manifest@0.2.16',
      completeness: 'full',
      nodes: [{ symbol: 'operation:anchor.thing' }],
      relations: [],
      gaps: [],
    };
    const { createHash } = await import('node:crypto');
    const envelope = { trace, manifestDigest: `sha256:${createHash('sha256').update(JSON.stringify(trace)).digest('hex')}` };
    await seedCaseProject(root, changeId, { specs: [], tests: [] });
    const manifestPath = path.join(root, traceManifestPath(changeId));
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(envelope), 'utf8');
    const testLines = Array.from({ length: GRAPH_LIMITS.max_assertion_refs_per_edge }, () => 'anchor.thing();');
    const testTarget = path.join(root, 'test', 'exact.spec.mjs');
    await mkdir(path.dirname(testTarget), { recursive: true });
    await writeFile(testTarget, testLines.join('\n'), 'utf8');
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--test', 'test/exact.spec.mjs', '--json']);
    assert.equal(exitCode, 0);
    assert.ok(!value.diagnostics.some((entry) => entry.code === 'assertion-refs-truncated'));
    assert.equal(value.structural.scan.coverage, 'full');
    assert.equal(value.structural.outcome, 'candidate');
  });

  it('refuses observations above the global byte budget before emit', async () => {
    const root = await makeTemp('aif-tls-bytes-');
    const changeId = 'bytes-change';
    // 100 symbols x 50 capped anchors per edge pushes the serialized
    // observation over the 1 MiB global budget (the schema per-array bounds
    // alone cannot express the sum limit).
    const symbols = Array.from({ length: 100 }, (_, index) => `operation:bulk.symbol${index}`);
    const trace = {
      schemaVersion: 'lekalo/trace-manifest/v0.2.16',
      identity: 'dev.lekalo.trace-manifest@0.2.16',
      completeness: 'full',
      nodes: symbols.map((symbol) => ({ symbol })),
      relations: [],
      gaps: [],
    };
    const { createHash } = await import('node:crypto');
    const envelope = { trace, manifestDigest: `sha256:${createHash('sha256').update(JSON.stringify(trace)).digest('hex')}` };
    await seedCaseProject(root, changeId, { specs: [], tests: [] });
    const manifestPath = path.join(root, traceManifestPath(changeId));
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(envelope), 'utf8');
    const testLines = [];
    for (let occurrence = 0; occurrence < 60; occurrence += 1) {
      for (const symbol of symbols) {
        testLines.push(`${symbol.slice('operation:'.length)}();`);
      }
    }
    const testTarget = path.join(root, 'test', 'bulk.spec.mjs');
    await mkdir(path.dirname(testTarget), { recursive: true });
    await writeFile(testTarget, testLines.join('\n'), 'utf8');
    const { exitCode, value } = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--test', 'test/bulk.spec.mjs', '--json']);
    assert.equal(exitCode, 2);
    assert.deepEqual(value.codes, ['invalid-candidate:observation-overflow']);
  });
});

// ---------------------------------------------------------------------------
// Disabled and malformed opt-in: honest not_run, no writes
// ---------------------------------------------------------------------------

describe('trace-link-suggestions opt-in', () => {
  it('stays off without opt-in and reports the bounded disabled envelope', async () => {
    const root = await makeTemp('aif-tls-off-');
    await seedCaseProject(root, 'off-change', { config: null, trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md'], tests: [] });
    const before = await treeFingerprint(root);
    const { exitCode, value } = await runCommand(root, ['--change', 'off-change', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(value.state, 'not_run');
    assert.deepEqual(value.codes, ['trace-link-suggestions-disabled']);
    assert.equal(await treeFingerprint(root), before);
  });

  it('keeps a malformed namespace off with bounded codes instead of a gate failure', async () => {
    const root = await makeTemp('aif-tls-malformed-');
    await seedCaseProject(root, 'malformed-change', {
      config: 'aifhub:\n  traceLinkSuggestions:\n    enabled: "true"\n',
      trace: 'traces/dev-trace-nm.json',
      specs: ['specs/spec-en.md'],
      tests: [],
    });
    const { exitCode, value } = await runCommand(root, ['--change', 'malformed-change', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(value.state, 'not_run');
    assert.equal(value.codes[0], 'trace-link-suggestions-disabled');
    assert.ok(value.codes.some((code) => String(code).startsWith('trace-link-suggestions:')));
  });

  it('keeps the producer off when a guarded namespace line is not a mapping', async () => {
    const root = await makeTemp('aif-tls-badline-');
    await seedCaseProject(root, 'bad-line-change', {
      config: 'aifhub:\n  traceLinkSuggestions:\n    enabled: true\n    broken line without colon\n',
      trace: 'traces/dev-trace-nm.json',
      specs: ['specs/spec-en.md'],
      tests: [],
    });
    const { exitCode, value } = await runCommand(root, ['--change', 'bad-line-change', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(value.state, 'not_run');
    assert.equal(value.codes[0], 'trace-link-suggestions-disabled');
    assert.ok(value.codes.some((code) => code === 'trace-link-suggestions:malformed-line'), value.codes.join(','));
  });

  it('gives the CLI override precedence over the config key and refuses invalid change ids early', async () => {
    const root = await makeTemp('aif-tls-cli-');
    await seedCaseProject(root, 'cli-change', {
      config: 'aifhub:\n  traceLinkSuggestions:\n    enabled: false\n',
      trace: 'traces/dev-trace-nm.json',
      specs: ['specs/spec-en.md', 'specs/spec-ru.md'],
      tests: [],
    });
    const disabled = await runCommand(root, ['--change', 'cli-change', '--json']);
    assert.deepEqual(disabled.value.codes, ['trace-link-suggestions-disabled']);
    const enabled = await runCommand(root, ['--change', 'cli-change', '--enabled', 'true', '--json']);
    assert.equal(enabled.exitCode, 0);
    assert.equal(enabled.value.schema, TRACE_LINK_SCHEMA);
    const invalid = await runCommand(root, ['--change', 'Bad_Change', '--enabled', 'true', '--json']);
    assert.equal(invalid.exitCode, 2);
    assert.deepEqual(invalid.value.codes, ['invalid-change-id']);
    assert.equal(CHANGE_ID_FORM.test('Bad_Change'), false);
    assert.equal(CHANGE_ID_FORM.test('ok-change-1'), true);
  });

  it('refuses non-test and unsafe test inputs before any read', async () => {
    const root = await makeTemp('aif-tls-testform-');
    await seedCaseProject(root, 'form-change', { trace: 'traces/dev-trace-nm.json', specs: ['specs/spec-en.md'], tests: [] });
    const { exitCode, value } = await runCommand(root, ['--change', 'form-change', '--enabled', 'true', '--test', 'docs/notes.md', '--json']);
    assert.equal(exitCode, 2);
    assert.equal(value.codes[0], 'invalid-test-input:docs/notes.md');
    const escape = await runCommand(root, ['--change', 'form-change', '--enabled', 'true', '--test', '../secret.spec.mjs', '--json']);
    assert.equal(escape.exitCode, 2);
    assert.equal(escape.value.codes[0], 'invalid-test-input:../secret.spec.mjs');
  });
});
