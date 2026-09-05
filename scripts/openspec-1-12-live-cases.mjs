// Additional exact-1.12.0 probes; invoked only by the checksum-bound live driver.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveOpenSpecChange, validateOpenSpecChange } from './openspec-runner.mjs';

export async function smokeOpenSpec112({ project, put, change, spec, requirement, invoke, inventory, adapter, scratch }) {
  const root = project('findings');
  put(root, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  put(root, 'openspec/specs/placeholder/spec.md', spec(requirement('Placeholder'),
    'TODO: Write a meaningful description of this capability before accepting the spec.'));
  change(root, 'clean-change');
  change(root, 'info-change', `## MODIFIED Requirements\n${requirement('Absent')}`);
  const broken = change(root, 'error-change', '## MODIFIED Requirements\n### Requirement: Broken\nNo normative statement or scenario.\n');
  const before = inventory(root);
  const fullArgs = ['validate', '--all', '--json', '--no-interactive'];
  const full = invoke(root, fullArgs, 1).data;
  const explicit = invoke(root, [...fullArgs, '--report', 'full'], 1).data;
  // Duration is measured independently on every invocation.
  const stable = (data) => JSON.parse(JSON.stringify(data, (key, value) => key === 'durationMs' ? undefined : value));
  assert.deepEqual(stable(explicit), stable(full));
  assert.deepEqual(Object.keys(full).sort(), ['items', 'root', 'summary', 'version']);
  assert.deepEqual(full.summary.totals, { items: 5, passed: 4, failed: 1 });
  const findings = invoke(root, [...fullArgs, '--report', 'findings'], 1).data;
  assert.deepEqual(Object.keys(findings).sort(), ['itemFindings', 'report', 'root', 'summary']);
  assert.deepEqual(findings.report, { kind: 'validation-findings', version: '1.0', scope: 'all', returnedItems: 3, totalItems: 5 });
  assert.deepEqual(stable(findings.itemFindings), stable(full.items.filter((item) => item.issues.length > 0)));
  assert.deepEqual(findings.summary, full.summary);
  assert.deepEqual(findings.root, full.root);
  for (const level of ['INFO', 'WARNING', 'ERROR']) {
    assert.ok(findings.itemFindings.some((item) => item.issues.some((issue) => issue.level === level)));
  }
  const strict = invoke(root, [...fullArgs, '--strict', '--report', 'findings'], 1).data;
  assert.deepEqual(strict.summary.totals, { items: 5, passed: 3, failed: 2 });
  const scopes = invoke(root, ['validate', '--changes', '--specs', '--report', 'findings', '--json'], 1).data;
  assert.equal(scopes.report.scope, 'all');
  const text = invoke(root, ['validate', '--all', '--report', 'findings', '--no-interactive'], 1, false);
  assert.match(text.stdout, /Scope: all \(5 items\)/);
  assert.match(text.stdout, /Totals: 4 passed, 1 failed/);
  assert.match(text.stderr, /\[INFO\].*Archive would refuse/);
  assert.doesNotMatch(text.stdout + text.stderr, /\u001b\[/);
  assert.deepEqual(inventory(root), before, 'Validation preflight must not mutate the corpus');

  const info = await adapter('strict INFO preserved', (options) => validateOpenSpecChange('info-change', options), root);
  assert.equal(info.json.items[0].valid, true);
  assert.ok(info.json.items[0].issues.some((issue) => issue.level === 'INFO' && issue.path === 'widgets/spec.md'));
  const ordinaryText = invoke(root, ['validate', 'info-change', '--strict', '--no-interactive'], 0, false);
  assert.match(ordinaryText.stdout + ordinaryText.stderr, /INFO.*Archive would refuse/);
  await adapter('INFO does not authorize archive', (options) => archiveOpenSpecChange('info-change', options), root, {}, false);
  assert.deepEqual(inventory(root), before);
  const structural = invoke(root, ['validate', path.basename(broken), '--strict', '--json'], 1).data.items[0];
  assert.ok(structural.issues.some((issue) => issue.level === 'ERROR'));
  assert.equal(structural.issues.some((issue) => /Archive would refuse/.test(issue.message)), false);

  // Findings can be empty while full-scope totals still contain validated items.
  const clean = project('clean-findings');
  put(clean, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  change(clean, 'clean-change');
  for (const scope of ['--all', '--changes', '--specs']) {
    const result = invoke(clean, ['validate', scope, '--strict', '--report', 'findings', '--json']).data;
    assert.deepEqual(result.itemFindings, []);
    assert.equal(result.report.totalItems, scope === '--all' ? 2 : 1);
    assert.equal(result.report.returnedItems, 0);
    assert.equal(result.summary.totals.failed, 0);
  }
  const empty = project('empty-findings');
  const emptyReport = invoke(empty, ['validate', '--all', '--report', 'findings', '--json']).data;
  assert.deepEqual(emptyReport.itemFindings, []);
  assert.equal(emptyReport.report.totalItems, 0);
  for (const invalid of [
    ['--report', 'findings'], ['--report', 'full'], ['--all', '--report', 'unknown'],
    ['clean-change', '--all', '--report', 'findings'], ['clean-change', '--report', 'full'],
    ['--archived', '--all', '--report', 'findings']
  ]) {
    const result = invoke(clean, ['validate', ...invalid, '--json'], 1).data;
    assert.equal(result.status[0].code, 'invalid_validation_report_request');
    assert.equal(result.status[0].severity, 'error');
    assert.equal(result.items, undefined);
  }

  // Reuse upstream's already-synced merge semantics without false INFO.
  change(clean, 'already-added', `## ADDED Requirements\n${requirement('First')}`);
  const synced = invoke(clean, ['validate', 'already-added', '--strict', '--json']).data.items[0];
  assert.equal(synced.valid, true);
  assert.deepEqual(synced.issues, []);
  change(clean, 'scenario-loss', `## MODIFIED Requirements\n${requirement('First').replace('Scenario: First request', 'Scenario: Replacement request')}`);
  const loss = invoke(clean, ['validate', 'scenario-loss', '--strict', '--json'], 1).data.items[0];
  assert.ok(loss.issues.some((issue) => issue.level === 'ERROR' && /scenario/i.test(issue.message)));
  assert.equal(loss.issues.some((issue) => /Archive would refuse/.test(issue.message)), false);

  // An I/O failure is not a missing base or merge conflict. Inject only in the
  // disposable child, leaving installed bytes and the fixture files untouched.
  const io = project('preflight-io');
  const main = path.join(io, 'openspec/specs/widgets/spec.md');
  put(io, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  change(io, 'io-change', `## MODIFIED Requirements\n${requirement('First', 'handle first requests with a timeout')}`);
  const hook = path.join(scratch, 'read-eio.mjs');
  writeFileSync(hook, `import fs from 'node:fs/promises';\nimport path from 'node:path';\nconst read = fs.readFile;\nfs.readFile = function (file, ...args) { if (path.resolve(String(file)) === ${JSON.stringify(main)}) return Promise.reject(Object.assign(new Error('injected EIO reading accepted spec'), {code: 'EIO'})); return read.call(this, file, ...args); };\n`);
  const ioBefore = inventory(io);
  const prefix = ['--import', pathToFileURL(hook).href];
  const ioValidation = invoke(io, ['validate', 'io-change', '--strict', '--json'], 0, true, prefix).data.items[0];
  assert.equal(ioValidation.valid, true);
  assert.equal(ioValidation.issues.some((issue) => /Archive would refuse/.test(issue.message)), false);
  const ioArchive = invoke(io, ['archive', 'io-change', '--yes'], 1, false, prefix);
  assert.match(ioArchive.stdout + ioArchive.stderr, /injected EIO/);
  assert.deepEqual(inventory(io), ioBefore);

  const anchors = path.join(scratch, 'sourcecraft');
  mkdirSync(anchors);
  put(anchors, '.codeassistant/skills/aifhub-sentinel/SKILL.md', '# User-owned sentinel\n');
  const initArgs = ['init', '--tools', 'codeassistant', '--force', '--no-animation'];
  invoke(anchors, initArgs, 0, false);
  const specsAnchor = path.join(anchors, 'openspec/specs/.gitkeep');
  const archiveAnchor = path.join(anchors, 'openspec/changes/archive/.gitkeep');
  assert.equal(readFileSync(specsAnchor, 'utf8'), '');
  assert.equal(readFileSync(archiveAnchor, 'utf8'), '');
  assert.ok(existsSync(path.join(anchors, '.codeassistant/commands/opsx-explore.md')));
  assert.ok(existsSync(path.join(anchors, '.codeassistant/skills/openspec-explore/SKILL.md')));
  writeFileSync(specsAnchor, 'preserve this user marker\n');
  rmSync(archiveAnchor);
  invoke(anchors, initArgs, 0, false);
  assert.equal(readFileSync(specsAnchor, 'utf8'), 'preserve this user marker\n');
  assert.equal(readFileSync(archiveAnchor, 'utf8'), '');
  rmSync(archiveAnchor);
  put(anchors, 'openspec/changes/archive/README.md', 'User-owned archive notes\n');
  invoke(anchors, initArgs, 0, false);
  assert.equal(existsSync(archiveAnchor), false, 'Only empty directories receive markers');
  invoke(anchors, ['update', '--force'], 0, false);
  assert.equal(readFileSync(path.join(anchors, '.codeassistant/skills/aifhub-sentinel/SKILL.md'), 'utf8'), '# User-owned sentinel\n');
  assert.equal(readFileSync(specsAnchor, 'utf8'), 'preserve this user marker\n');
  assert.deepEqual(invoke(anchors, ['status', '--all', '--json']).data.changes, []);
  const anchoredValidation = invoke(anchors, ['validate', '--all', '--strict', '--json']).data;
  assert.deepEqual(anchoredValidation.items, []);
  assert.equal(anchoredValidation.summary.totals.items, 0);
}
