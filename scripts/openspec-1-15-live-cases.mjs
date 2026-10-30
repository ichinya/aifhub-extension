// Cumulative 1.13 regressions replayed on exact 1.15.0 after package custody.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { archiveOpenSpecChange, getOpenSpecInstructions, validateOpenSpecChange } from './openspec-runner.mjs';
import { buildOpenSpecCoverageMatrix } from './openspec-coverage-matrix.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function smokeOpenSpec115(context) {
  const { project, put, change, spec, requirement, invoke, inventory, adapter, scratch } = context;
  function validation(root, name, strict, exit = 0, type = 'change') {
    const result = invoke(root, ['validate', name, '--type', type, '--json', '--no-interactive', ...(strict ? ['--strict'] : [])], exit);
    assert.equal(result.data.items.length, 1);
    assert.equal(result.data.items[0].valid, exit === 0);
    return result.data.items[0].issues;
  }
  async function warning(root, name, pattern, type = 'change') {
    for (const strict of [false, true]) {
      const allIssues = validation(root, name, strict, strict ? 1 : 0, type);
      for (const issue of allIssues.filter(issue => issue.level === 'INFO')) {
        assert.match(issue.message, /^skip_specs is set .*zero deltas accepted$/);
      }
      const issues = allIssues.filter(issue => issue.level !== 'INFO');
      assert.equal(issues.length, 1, 'Each negative fixture must isolate one WARNING');
      assert.equal(issues[0].level, 'WARNING');
      assert.match(issues[0].message, pattern);
    }
    if (type === 'change') {
      const failed = await adapter(`1.15 strict WARNING ${name}`, options => validateOpenSpecChange(name, options), root, {}, false);
      assert.equal(failed.exitCode, 1);
      assert.equal(failed.stderr, '');
      assert.equal(failed.error.code, 'non-zero-exit');
      assert.equal(failed.json, null);
      assert.equal(JSON.parse(failed.stdout).items[0].valid, false);
    }
  }
  const metadata = project('115-metadata');
  const metadataBase = change(metadata, 'metadata');
  // Native skip_specs is valid only for a change without delta spec files.
  rmSync(path.join(metadata, metadataBase, 'specs'), { recursive: true });
  const native = 'schema: spec-driven\ncreated: "2026-09-19"\nskip_specs: true\n';
  put(metadata, `${metadataBase}/.openspec.yaml`, native + 'skip_design: true\nbogus_key: 1\n');
  await warning(metadata, 'metadata', /Unrecognized key name\(s\).*bogus_key.*skip_design|Unrecognized key name\(s\).*skip_design.*bogus_key/);
  put(metadata, `${metadataBase}/.openspec.yaml`, native);
  const assertNativeSkip = () => {
    const issues = validation(metadata, 'metadata', true);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].level, 'INFO');
    assert.match(issues[0].message, /^skip_specs is set .*zero deltas accepted$/);
  };
  assertNativeSkip();
  put(metadata, `${metadataBase}/.openspec.yaml`, native + 'x-goal: bounded\nx-jiraKey: TEST-1\nx-owner: {team: test}\nx-list: [one, two]\nx-empty:\n');
  assertNativeSkip();
  for (const key of ['X-Tracker', '"x-"', '"x- tracker"']) {
    put(metadata, `${metadataBase}/.openspec.yaml`, native + `${key}: true\n`);
    await warning(metadata, 'metadata', /Unrecognized key name/);
  }

  const lengths = project('115-lengths');
  // Count only the normative body, excluding header and scenarios.
  const body = n => 'The system SHALL ' + 'x'.repeat(n - 'The system SHALL '.length - 1) + '.';
  const longRequirement = n => `### Requirement: Long\n${body(n)}\n\n#### Scenario: Long request\n- **WHEN** a request arrives\n- **THEN** it is handled\n`;
  const lengthBase = change(lengths, 'lengths', '## ADDED Requirements\n' + longRequirement(501));
  await warning(lengths, 'lengths', /Requirement text is very long/);
  for (const length of [499, 500]) {
    put(lengths, `${lengthBase}/specs/widgets/spec.md`, '## ADDED Requirements\n' + longRequirement(length));
    assert.deepEqual(validation(lengths, 'lengths', true), []);
  }
  put(lengths, 'openspec/specs/widgets/spec.md', spec(longRequirement(501)));
  put(lengths, `${lengthBase}/specs/widgets/spec.md`, '## MODIFIED Requirements\n' + longRequirement(501));
  assert.deepEqual(validation(lengths, 'lengths', true), []);
  await warning(lengths, 'widgets', /Requirement text is very long/, 'spec');

  const portability = project('115-portability');
  for (const [name, delta, pattern] of [
    ['notes', '## Notes\nThis text would be lost.\n\n## ADDED Requirements\n' + requirement('Extra'), /section "## Notes"/],
    ['pre-requirement', '## ADDED Requirements\nThis text would be lost.\n\n' + requirement('Extra'), /text before the first requirement/],
    ['pre-section', 'This text would be lost.\n\n## ADDED Requirements\n' + requirement('Extra'), /text above the first/]
  ]) {
    const base = change(portability, name, delta);
    if (name === 'pre-section') put(portability, `${base}/specs/widgets/spec.md`, delta);
    await warning(portability, name, pattern);
  }
  // Purpose and fenced headings remain allowed; replay113 verifies archive bytes too.
  change(portability, 'purpose-and-fence', '## ADDED Requirements\n' + requirement('Extra') + '\n```markdown\n## Notes\nExample content only.\n```\n');
  assert.deepEqual(validation(portability, 'purpose-and-fence', true), []);

  const blocked = project('115-blocked-sync');
  put(blocked, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  change(blocked, 'blocked', '## MODIFIED Requirements\n' + requirement('Absent'));
  const before = inventory(blocked);
  const refusal = invoke(blocked, ['archive', 'blocked', '--yes'], 1, false);
  assert.match(refusal.stdout + refusal.stderr, /Absent|not found|does not exist/i);
  assert.deepEqual(inventory(blocked), before);

  await replay113(context);
  const crlf = project('115-crlf');
  put(crlf, 'openspec/specs/widgets/spec.md', spec(requirement('First')).replaceAll('\n', '\r\n'));
  change(crlf, 'crlf', '## ADDED Requirements\n' + requirement('Extra'));
  await adapter('1.15 CRLF archive', options => archiveOpenSpecChange('crlf', options), crlf);
  const merged = readFileSync(path.join(crlf, 'openspec/specs/widgets/spec.md'), 'utf8');
  assert.ok(merged.includes('\r\n'));
  assert.doesNotMatch(merged, /(?<!\r)\n/);

  if (process.platform === 'win32') {
    const locked = project('115-windows-lock');
    change(locked, 'locked');
    const target = path.join(locked, 'openspec/changes/locked/tasks.md');
    const ready = path.join(scratch, 'windows-lock-ready');
    // A real Windows exclusive file handle makes archive-copy fail; release on stdin EOF.
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const script = `$f=[System.IO.File]::Open(${quote(target)},'Open','Read','None'); try { [System.IO.File]::WriteAllText(${quote(ready)},'ready'); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    });
    let error = '';
    child.stderr.on('data', data => { error += data; });
    const ended = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
    try {
      for (let n = 0; !existsSync(ready) && n < 100; n++) await delay(50);
      assert.ok(existsSync(ready), `Exclusive lock was not acquired: ${error}`);
      const failed = invoke(locked, ['archive', 'locked', '--yes'], 1, false);
      assert.match(failed.stdout + failed.stderr, /EPERM|EBUSY|locked|permission|resource busy/i);
      assert.equal(existsSync(path.join(locked, 'openspec/changes/archive/.openspec-archive.lock')), false);
    } finally { child.stdin.end('\n'); assert.equal(await ended, 0, error); }
    // The lock and partial archive must not prevent a clean retry after releasing the handle.
    await adapter('1.15 Windows lock cleanup retry', options => archiveOpenSpecChange('locked', options), locked);
    assert.equal(existsSync(path.join(locked, 'openspec/changes/locked')), false);
    assert.equal(existsSync(path.join(locked, 'openspec/changes/archive/.openspec-archive.lock')), false);
  }
}

async function replay113({ project, put, change, spec, requirement, invoke, inventory, adapter }) {
  const root = project('apply-warnings');
  const base = change(root, 'no-specs');
  rmSync(path.join(root, base, 'specs'), { recursive: true });
  for (const [checkbox, state] of [[' ', 'ready'], ['x', 'all_done']]) {
    put(root, `${base}/tasks.md`, `## 1. Implementation\n- [${checkbox}] 1.1 Verify the fixture behavior.\n`);
    const result = await adapter(`1.13 ${state} warnings`, (options) => getOpenSpecInstructions('apply', { ...options, change: 'no-specs' }), root);
    assert.equal(result.json.state, state);
    assert.equal(result.json.warnings.length, 1);
    assert.match(result.json.warnings[0], /no delta specs.*skip_specs: true/);
    assert.deepEqual(result.json.missingPrerequisites, ['specs']);
  }
  put(root, `${base}/.openspec.yaml`, 'schema: spec-driven\nskip_specs: true\n');
  const skipped = invoke(root, ['instructions', 'apply', '--change', 'no-specs', '--json']).data;
  assert.equal(skipped.warnings, undefined);
  assert.equal(skipped.missingPrerequisites, undefined);
  put(root, `${base}/.openspec.yaml`, 'schema: spec-driven\n');
  rmSync(path.join(root, base, 'tasks.md'));
  const blocked = invoke(root, ['instructions', 'apply', '--change', 'no-specs', '--json']).data;
  assert.equal(blocked.state, 'blocked');
  assert.deepEqual(blocked.missingPrerequisites, ['specs', 'tasks']);
  assert.equal(blocked.warnings, undefined);
  assert.match(blocked.instruction, /openspec instructions/);
  assert.doesNotMatch(blocked.instruction, /openspec-continue-change/);

  const repeated = project('repeated-sections');
  const example = '```markdown\n## ADDED Requirements\n' + requirement('Example only') + '\n\n```\n';
  change(repeated, 'repeat', `## ADDED Requirements\n${requirement('First')}\n${example}\n## ADDED Requirements\n${requirement('Second')}`);
  invoke(repeated, ['validate', 'repeat', '--strict', '--json']);
  // The residual was resolved upstream in 1.13.1; verify full additive names.
  const shown = invoke(repeated, ['show', 'repeat', '--type', 'change', '--deltas-only', '--json']).data;
  assert.equal(shown.deltas.length, 2, 'Exact 1.15 show must include both real deltas');
  assert.deepEqual(shown.deltas.map(d => d.requirement.name), ['First', 'Second']);
  assert.deepEqual(shown.deltas.map(d => d.requirement.scenarios[0].name), ['First request', 'Second request']);
  const matrix = await buildOpenSpecCoverageMatrix({ rootDir: repeated, changeId: 'repeat' });
  assert.deepEqual(matrix.requirements.map((entry) => entry.id), ['widgets.first', 'widgets.second']);
  await adapter('1.13 archive both repeated sections', (options) => archiveOpenSpecChange('repeat', options), repeated);
  const merged = readFileSync(path.join(repeated, 'openspec/specs/widgets/spec.md'), 'utf8');
  assert.match(merged, /### Requirement: First/);
  assert.match(merged, /### Requirement: Second/);
  assert.ok(merged.includes(example.trimEnd()), 'Fenced example blank lines must survive archive');

  for (const marker of ['-', '*', '+']) {
    const lists = project(`list-${marker === '-' ? 'dash' : marker === '*' ? 'star' : 'plus'}`);
    put(lists, 'openspec/specs/widgets/spec.md', spec(requirement('First') + '\n' + requirement('Second') + '\n' + requirement('Keep')));
    change(lists, 'lists', `## REMOVED Requirements\n${marker} \`### Requirement: First\`\n\n## RENAMED Requirements\n${marker} FROM: \`### Requirement: Second\`\n${marker} TO: \`### Requirement: Renamed\`\n`);
    invoke(lists, ['validate', 'lists', '--strict', '--json']);
    await adapter(`1.13 ${marker} removal and rename`, (options) => archiveOpenSpecChange('lists', options), lists);
    const content = readFileSync(path.join(lists, 'openspec/specs/widgets/spec.md'), 'utf8');
    assert.doesNotMatch(content, /### Requirement: (First|Second)\n/);
    assert.match(content, /### Requirement: Renamed\n/);
    assert.match(content, /### Requirement: Keep\n/);
  }

  for (const guarded of [false, true]) {
    const retirement = project(`wrapped-retirement-${guarded}`);
    const wrapped = '### Requirement: Wrapped\nThe system SHALL preserve wrapped scenario behavior.\n\n#### Scenario: Wrapped request\n+ **WHEN** a long request arrives with\n  additional parameters\n+ **THEN** the result preserves\n  the supplied parameters\n';
    put(retirement, 'openspec/specs/widgets/spec.md', spec(wrapped) + (guarded ? '\n## Operational note\nRetain this independent content.\n' : ''));
    const retireBase = change(retirement, 'retire', '## REMOVED Requirements\n+ `### Requirement: Wrapped`\n');
    put(retirement, `${retireBase}/.openspec.yaml`, 'schema: spec-driven\nretire_capabilities: true\n');
    invoke(retirement, ['validate', 'retire', '--strict', '--json']);
    const before = inventory(retirement);
    await adapter(`1.13 wrapped retirement guarded=${guarded}`, (options) => archiveOpenSpecChange('retire', options), retirement, {}, !guarded);
    if (guarded) assert.deepEqual(inventory(retirement), before);
    else assert.equal(existsSync(path.join(retirement, 'openspec/specs/widgets/spec.md')), false);
  }
}
