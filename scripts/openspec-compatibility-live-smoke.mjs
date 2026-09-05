#!/usr/bin/env node
// Opt-in exact-package audit. Never installs packages or uses a PATH OpenSpec.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  archiveOpenSpecChange, detectOpenSpec, getOpenSpecInstructions,
  getOpenSpecStatus, showOpenSpecItem, validateOpenSpecChange
} from './openspec-runner.mjs';
import { smokeOpenSpec112 } from './openspec-1-12-live-cases.mjs';

const args = process.argv.slice(2);
assert.equal(args.length, 2, 'Usage: node scripts/openspec-compatibility-live-smoke.mjs <installed-package-root> <verified-tarball>');
const packageRoot = path.resolve(args[0]);
const tarballPath = path.resolve(args[1]);
const tarball = readFileSync(tarballPath);
const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const pins = {
  '1.11.0': {
    integrity: 'sha512-P9h8H4Snit8I7tHmCopjg3QDwBllIlObxb+/DebvBwhWTj6YEPPYRYkC4n5GqG4PdQnKMA6E1AlEOI9FT4G7FA==',
    sha1: '0637db769ac89a2120f98f5ce23f05f29e50c193', files: 385
  },
  '1.12.0': {
    integrity: 'sha512-oFE2Lj7WVSc87nSibk6qe9HjHIOlxhcPAXbPey44DlLvJzBl5+9BZVrNiozOwv++CQhW+MG0kuP1XLZ/uQrrWw==',
    sha1: 'c844543999f673cdd72445879b86a4abea4c07ef', files: 389
  }
}[pkg.version];
assert.ok(pins, 'Only the exact reviewed 1.11.0 and 1.12.0 packages are accepted');
assert.equal(integrity, pins.integrity);
assert.equal(createHash('sha1').update(tarball).digest('hex'), pins.sha1);
assert.equal(pkg.name, '@fission-ai/openspec');
assert.equal(pkg.engines.node, '>=20.19.0');
assert.equal(pkg.bin.openspec.replace(/^\.\//, ''), 'bin/openspec.js');
for (const name of ['preinstall', 'install', 'postinstall']) assert.equal(pkg.scripts[name], undefined);
const bin = path.join(packageRoot, pkg.bin.openspec);
const command = path.resolve(packageRoot, '../../.bin', process.platform === 'win32' ? 'openspec.cmd' : 'openspec');
assert.ok(existsSync(command), 'Expected the shim installed from the verified local tarball');
const scratch = mkdtempSync(path.join(tmpdir(), 'openspec-171-smoke-'));
const env = {
  ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', CI: '1', NO_COLOR: '1',
  XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_DATA_HOME: path.join(scratch, 'data'),
  XDG_STATE_HOME: path.join(scratch, 'state'), XDG_CACHE_HOME: path.join(scratch, 'cache')
};
const rows = [];
function put(root, name, text) {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function project(name) {
  const root = path.join(scratch, name);
  put(root, 'openspec/config.yaml', 'schema: spec-driven\n');
  mkdirSync(path.join(root, 'openspec/changes'), { recursive: true });
  return root;
}
function invoke(root, argv, expectedExit = 0, json = true, prefix = []) {
  const result = spawnSync(process.execPath, [...prefix, bin, ...argv, '--no-color'], {
    cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.status, expectedExit, `${argv.join(' ')}\n${result.stdout}\n${result.stderr}`);
  let data = null;
  if (json) {
    assert.ok(result.stdout.trim(), `${argv.join(' ')} expected JSON: ${result.stderr}`);
    data = JSON.parse(result.stdout);
  }
  if (json) assert.equal(result.stderr, argv[0] === 'schema' ? 'Note: Schema commands are experimental and may change.\n' : '', `${argv.join(' ')} unexpected stderr`);
  rows.push({ command: argv.join(' '), exitCode: result.status, jsonKeys: data ? Object.keys(data).sort() : null });
  return { ...result, data };
}
function requirement(name, action = `handle ${name.toLowerCase()} requests`) {
  return `### Requirement: ${name}\nThe system SHALL ${action}.\n\n#### Scenario: ${name} request\n- **WHEN** a request arrives\n- **THEN** the system handles it\n`;
}
const purpose = 'Describe how the audit fixture handles requests and preserves stable specification behavior across compatibility checks.';
function spec(body, overview = purpose) {
  return `# Widgets Specification\n\n## Purpose\n${overview}\n\n## Requirements\n${body}`;
}
function change(root, name, delta = `## ADDED Requirements\n${requirement('Extra')}`, capability = 'widgets') {
  const base = `openspec/changes/${name}`;
  put(root, `${base}/.openspec.yaml`, 'schema: spec-driven\ncreated: 2026-09-05\n');
  put(root, `${base}/proposal.md`, `# ${name}\n\n## Why\nVerify bounded compatibility behavior with a disposable fixture.\n\n## What Changes\n- **${capability}:** Update the fixture requirement.\n\n## Impact\nDisposable audit data only.\n`);
  put(root, `${base}/design.md`, '## Context\nDisposable compatibility verification.\n\n## Decisions\nUse deterministic fixtures.\n');
  put(root, `${base}/tasks.md`, '## 1. Implementation\n- [x] 1.1 Verify fixture behavior with the exact CLI smoke command.\n');
  put(root, `${base}/specs/${capability}/spec.md`, `## Purpose\n${purpose}\n\n${delta}`);
  return base;
}
function inventory(root) {
  const files = [];
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), name + '/');
      else files.push([name, createHash('sha256').update(readFileSync(path.join(dir, entry.name))).digest('hex')]);
    }
  }
  walk(root);
  return files;
}
async function adapter(label, operation, root, extra = {}, expected = true) {
  const result = await operation({ command, cwd: root, env, ...extra });
  assert.equal(result.ok, expected, `${label}: ${result.stdout}\n${result.stderr}`);
  rows.push({ adapter: label, exitCode: result.exitCode, ok: result.ok });
  return result;
}

try {
  // Bind the executable bytes to the verified archive, not only its version string.
  const extracted = path.join(scratch, 'package-snapshot');
  mkdirSync(extracted);
  const unpack = spawnSync('tar', ['-xzf', tarballPath, '-C', extracted], { encoding: 'utf8', timeout: 60000 });
  assert.ifError(unpack.error);
  assert.equal(unpack.status, 0, unpack.stderr);
  const packedFiles = inventory(path.join(extracted, 'package'));
  assert.equal(packedFiles.length, pins.files);
  for (const [name, hash] of packedFiles) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(packageRoot, name))).digest('hex'), hash, `Installed package differs: ${name}`);
  }
  rows.push({ custody: 'installed package matches verified tarball', files: packedFiles.length });
  const root = project('adapter');
  put(root, 'openspec/specs/widgets/spec.md', spec(requirement('First') + '\n' + requirement('Middle') + '\n' + requirement('Last')));
  change(root, 'audit-change', `## MODIFIED Requirements\n${requirement('Middle', 'handle middle requests with a bounded timeout')}\n## ADDED Requirements\n${requirement('Extra')}`);
  const detection = await detectOpenSpec({ command, cwd: root, env });
  assert.equal(detection.version, pkg.version);
  assert.equal(detection.canValidate, true);
  assert.equal(detection.canArchive, true);
  rows.push({ adapter: 'detect', version: detection.version, requiresNode: detection.requiresNode });
  assert.equal(invoke(root, ['--version'], 0, false).stdout.trim(), pkg.version);
  await adapter('strict validate', (options) => validateOpenSpecChange('audit-change', options), root);
  const status = await adapter('per-change status', (options) => getOpenSpecStatus('audit-change', options), root);
  assert.ok(status.json.artifacts.length);
  await adapter('spec show', (options) => showOpenSpecItem('widgets', { ...options, type: 'spec' }), root);
  const show = await adapter('delta show', (options) => showOpenSpecItem('audit-change', { ...options, type: 'change', deltasOnly: true }), root);
  assert.equal(show.json.deltas.some((delta) => 'diff' in delta), false);
  for (const artifact of ['apply', 'archive']) {
    await adapter(`${artifact} instructions`, (options) => getOpenSpecInstructions(artifact, { ...options, change: 'audit-change' }), root);
  }
  const diff = invoke(root, ['show', 'audit-change', '--type', 'change', '--diff', '--json']).data;
  assert.deepEqual(Object.keys(diff).sort(), Object.keys(show.json).sort());
  assert.match(diff.deltas.find((delta) => delta.operation === 'MODIFIED').diff, /\+The system SHALL handle middle requests with a bounded timeout/);
  assert.equal(diff.deltas.find((delta) => delta.operation === 'ADDED').diff, undefined);
  assert.match(invoke(root, ['show', 'audit-change', '--diff'], 0, false).stdout, /Specifications Changed/);
  change(root, 'missing-base', `## MODIFIED Requirements\n${requirement('Absent')}`, 'nested/missing');
  const missingBase = invoke(root, ['show', 'missing-base', '--diff', '--json']).data.deltas[0];
  assert.equal(missingBase.diff, undefined);
  assert.match(missingBase.warning, /No main spec/);
  // 1.12 reports the missing base as INFO; strict validation still passes.
  const missingValidation = invoke(root, ['validate', 'missing-base', '--type', 'change', '--strict', '--json']).data;
  assert.equal(missingValidation.items[0].valid, true);
  if (pkg.version === '1.12.0') {
    assert.ok(missingValidation.items[0].issues.some((issue) => issue.level === 'INFO'
      && issue.path === 'nested/missing/spec.md' && /Archive would refuse/.test(issue.message)));
  } else assert.deepEqual(missingValidation.items[0].issues, []);
  const beforeMissingBaseArchive = inventory(root);
  invoke(root, ['archive', 'missing-base', '--yes'], 1, false);
  assert.deepEqual(inventory(root), beforeMissingBaseArchive);
  const malformed = change(root, 'invalid-change');
  put(root, `${malformed}/tasks.md`, '## 1. Implementation\n- [x] 1.1 First task.\n- [x] 1.1 Duplicate task identifier.\n');
  const invalid = await adapter('invalid strict validation', (options) => validateOpenSpecChange('invalid-change', options), root, {}, false);
  assert.equal(invalid.exitCode, 1);
  assert.equal(invalid.error.code, 'non-zero-exit');
  assert.equal(invalid.json, null);
  assert.ok(JSON.parse(invalid.stdout).items[0].issues.some((issue) => issue.path === 'tasks.md'));
  // Archive validates non-strictly, so use a structural error to prove no mutation.
  put(root, `${malformed}/specs/widgets/spec.md`, '## MODIFIED Requirements\n### Requirement: Missing\nNo normative statement or scenario.\n');
  const beforeArchive = inventory(root);
  await adapter('invalid archive no mutation', (options) => archiveOpenSpecChange('invalid-change', options), root, {}, false);
  assert.deepEqual(inventory(root), beforeArchive);

  const batchRoot = project('batch');
  for (const name of ['zebra-change', 'Beta-change', 'alpha-change']) change(batchRoot, name);
  const batchArgs = ['status', '--all', '--json'];
  const batch = invoke(batchRoot, batchArgs);
  assert.equal(invoke(batchRoot, batchArgs).stdout, batch.stdout);
  assert.deepEqual(batch.data.changes.map((entry) => entry.changeName), ['alpha-change', 'Beta-change', 'zebra-change']);
  const single = invoke(batchRoot, ['status', '--change', 'alpha-change', '--json']).data;
  const { root: singleRoot, ...singleStatus } = single;
  assert.deepEqual(batch.data.root, singleRoot);
  assert.deepEqual(batch.data.changes[0], singleStatus);
  put(batchRoot, 'openspec/changes/Beta-change/.openspec.yaml', 'schema: no-such-schema\n');
  const partial = invoke(batchRoot, batchArgs, 1).data;
  assert.equal(partial.changes.length, 3);
  assert.equal(partial.changes[1].status[0].severity, 'error');
  assert.equal(partial.changes[1].status[0].code, 'change_error');
  assert.ok(partial.changes[2].artifacts.length);
  invoke(batchRoot, ['status', '--all'], 1, false);
  await adapter('broken per-change status', (options) => getOpenSpecStatus('Beta-change', options), batchRoot, {}, false);
  for (const extra of [['--change', 'alpha-change'], ['--schema', 'unknown'], ['--store', 'unknown']]) {
    const failure = invoke(batchRoot, [...batchArgs, ...extra], 1).data;
    assert.deepEqual(failure.changes, []);
    assert.equal(failure.root, null);
    assert.equal(failure.status[0].severity, 'error');
  }
  const empty = project('empty');
  assert.deepEqual(invoke(empty, batchArgs).data.changes, []);
  invoke(empty, [...batchArgs, '--schema', 'unknown'], 1);

  const purposes = project('purposes');
  const mainSpec = 'openspec/specs/widgets/spec.md';
  const validateSpec = ['validate', 'widgets', '--type', 'spec', '--json', '--no-interactive'];
  for (const placeholder of [
    'TBD - created by archiving change fixture. Update Purpose after archive.',
    'TODO: Write a meaningful description of this capability before accepting the spec.'
  ]) {
    put(purposes, mainSpec, spec(requirement('First'), placeholder));
    const warning = invoke(purposes, validateSpec).data;
    const strict = invoke(purposes, [...validateSpec, '--strict'], 1).data;
    assert.equal(warning.items[0].valid, true);
    assert.equal(strict.items[0].valid, false);
    const finding = strict.items[0].issues.find((issue) => /placeholder/i.test(issue.message));
    assert.equal(finding.level, 'WARNING');
    assert.match(finding.message, /directly/);
  }
  // An existing Purpose is not replaced by a delta's Purpose at archive.
  change(purposes, 'purpose-delta');
  invoke(purposes, ['archive', 'purpose-delta', '--yes'], 0, false);
  assert.match(readFileSync(path.join(purposes, mainSpec), 'utf8'), /TODO: Write/);
  const archivedEvidence = inventory(path.join(purposes, 'openspec/changes/archive'));
  put(purposes, mainSpec, spec(requirement('First') + '\n' + requirement('Extra')));
  invoke(purposes, [...validateSpec, '--strict']);
  assert.deepEqual(inventory(path.join(purposes, 'openspec/changes/archive')), archivedEvidence);
  for (const prose of [
    purpose + ' The retry budget is TBD pending measurements.',
    purpose + '\n```text\nTBD - created by archiving change fixture. Update Purpose after archive.\n```'
  ]) {
    put(purposes, mainSpec, spec(requirement('First'), prose));
    invoke(purposes, [...validateSpec, '--strict']);
  }

  const renameRoot = project('rename');
  put(renameRoot, mainSpec, spec(requirement('First') + '\n' + requirement('Middle') + '\n' + requirement('Last')));
  change(renameRoot, 'rename-middle', '## RENAMED Requirements\n- FROM: `### Requirement: Middle`\n- TO: `### Requirement: Renamed`\n');
  invoke(renameRoot, ['archive', 'rename-middle', '--yes'], 0, false);
  const renamed = readFileSync(path.join(renameRoot, mainSpec), 'utf8');
  assert.deepEqual([...renamed.matchAll(/^### Requirement: (.+)$/gm)].map((match) => match[1]), ['First', 'Renamed', 'Last']);
  assert.match(renamed, /#### Scenario: Middle request/);
  invoke(renameRoot, ['validate', '--all', '--strict', '--json', '--no-interactive']);

  const schemaRoot = project('schema');
  put(schemaRoot, 'openspec/config.yml', '# preserve me\nschema: spec-driven\ndefaultSchema: stale\ncontext: preserved context\n');
  rmSync(path.join(schemaRoot, 'openspec/config.yaml'));
  const initArgs = ['schema', 'init', 'audit-schema', '--default', '--artifacts', 'proposal,tasks', '--description', 'Audit schema', '--json'];
  invoke(schemaRoot, initArgs);
  const config = readFileSync(path.join(schemaRoot, 'openspec/config.yml'), 'utf8');
  assert.match(config, /^schema: audit-schema$/m);
  assert.match(config, /# preserve me/);
  assert.match(config, /context: preserved context/);
  assert.doesNotMatch(config, /defaultSchema/);
  assert.equal(existsSync(path.join(schemaRoot, 'openspec/config.yaml')), false);
  invoke(schemaRoot, ['new', 'change', 'uses-default', '--json']);
  assert.match(readFileSync(path.join(schemaRoot, 'openspec/changes/uses-default/.openspec.yaml'), 'utf8'), /schema: audit-schema/);
  put(schemaRoot, 'openspec/config.yml', 'schema: [invalid yaml\n');
  const invalidConfigBefore = inventory(schemaRoot);
  invoke(schemaRoot, [...initArgs, '--force'], 1);
  assert.deepEqual(inventory(schemaRoot), invalidConfigBefore);
  // Use upstream's exported failure seam in a disposable child process.
  // This verifies rollback after schema installation, beyond input rejection.
  put(schemaRoot, 'openspec/config.yml', config);
  const hook = path.join(scratch, 'fail-schema-install.mjs');
  const schemaModule = pathToFileURL(path.join(packageRoot, 'dist/commands/schema.js')).href;
  writeFileSync(hook, `import { schemaInitFileOperations as ops } from ${JSON.stringify(schemaModule)};\nconst rename = ops.renameSync;\nops.renameSync = (from, to) => { if (String(from).includes('.schema-init-config-')) throw new Error('injected config install failure'); return rename(from, to); };\n`);
  const rollbackBefore = inventory(schemaRoot);
  const rollback = invoke(schemaRoot, [...initArgs, '--force'], 1, true, ['--import', pathToFileURL(hook).href]);
  assert.match(rollback.stdout, /injected config install failure/);
  assert.deepEqual(inventory(schemaRoot), rollbackBefore);

  const agentsRoot = project('agents');
  put(agentsRoot, '.agents/skills/aifhub-sentinel/SKILL.md', '# User-owned AIFHub sentinel\n');
  put(agentsRoot, '.agent/skills/openspec-explore/SKILL.md', '# Customized legacy Explore skill\n');
  put(agentsRoot, '.agent/workflows/opsx-explore.md', '# Customized legacy Explore workflow\n');
  const customSkill = readFileSync(path.join(agentsRoot, '.agent/skills/openspec-explore/SKILL.md'));
  const customWorkflow = readFileSync(path.join(agentsRoot, '.agent/workflows/opsx-explore.md'));
  invoke(agentsRoot, ['init', '--tools', 'antigravity,codex', '--force', '--no-animation'], 0, false);
  assert.equal(readFileSync(path.join(agentsRoot, '.agents/skills/aifhub-sentinel/SKILL.md'), 'utf8'), '# User-owned AIFHub sentinel\n');
  assert.deepEqual(readFileSync(path.join(agentsRoot, '.agent/skills/openspec-explore/SKILL.md')), customSkill);
  assert.deepEqual(readFileSync(path.join(agentsRoot, '.agent/workflows/opsx-explore.md')), customWorkflow);
  assert.ok(existsSync(path.join(agentsRoot, '.agents/skills/openspec-explore/SKILL.md')));
  assert.ok(existsSync(path.join(agentsRoot, '.agents/workflows/opsx-explore.md')));
  const sharedSkill = readFileSync(path.join(agentsRoot, '.agents/skills/openspec-explore/SKILL.md'));
  invoke(agentsRoot, ['update', '--force'], 0, false);
  assert.deepEqual(readFileSync(path.join(agentsRoot, '.agents/skills/openspec-explore/SKILL.md')), sharedSkill);
  assert.equal(readFileSync(path.join(agentsRoot, '.agents/skills/aifhub-sentinel/SKILL.md'), 'utf8'), '# User-owned AIFHub sentinel\n');
  if (pkg.version === '1.12.0') {
    await smokeOpenSpec112({ project, put, change, spec, requirement, invoke, inventory, adapter, scratch });
  }
  console.log(JSON.stringify({ version: pkg.version, node: process.versions.node, platform: process.platform, integrity, passed: true, rows }, null, 2));
} finally {
  // Only this mkdtemp-owned tree can be removed, even on a failed assertion.
  assert.equal(path.dirname(scratch), path.resolve(tmpdir()));
  assert.ok(path.basename(scratch).startsWith('openspec-171-smoke-'));
  rmSync(scratch, { recursive: true, force: true });
}
