// Cumulative 1.16.0/1.16.1/1.17.0 strict classes and inherited regressions replayed
// on exact 1.17.0 after package custody. Class origins are marked inline:
// scenario-step WARNING and config fail-closed are 1.16.0; unrecognized delta
// sections ERROR and closed headings are 1.16.1; unspaced headers and inline
// fences are 1.16.0 parser fixes.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { archiveOpenSpecChange, validateOpenSpecChange } from './openspec-runner.mjs';

export async function smokeOpenSpec117(context) {
  const { project, put, change, spec, requirement, invoke, inventory, adapter } = context;
  function validation(root, name, strict, exit = 0, type = 'change') {
    const result = invoke(root, ['validate', name, '--type', type, '--json', '--no-interactive', ...(strict ? ['--strict'] : [])], exit);
    assert.equal(result.data.items.length, 1);
    assert.equal(result.data.items[0].valid, exit === 0);
    return result.data.items[0].issues;
  }
  async function strictWarning(root, name, pattern, type = 'change') {
    // Non-strict stays valid with one WARNING; strict exits 1 through the adapter.
    const issues = validation(root, name, false, 0, type);
    assert.equal(issues.length, 1, 'Each negative fixture must isolate one WARNING');
    assert.equal(issues[0].level, 'WARNING');
    assert.match(issues[0].message, pattern);
    const failed = await adapter(`1.17 strict WARNING ${name}`, options => validateOpenSpecChange(name, options), root, {}, false);
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.error.code, 'non-zero-exit');
    assert.equal(failed.json, null);
    assert.equal(JSON.parse(failed.stdout).items[0].valid, false);
  }

  // 1.16.0: positive strict baseline — WHEN+THEN scenario validates strictly.
  const positive = project('117-positive');
  put(positive, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  change(positive, 'positive', `## ADDED Requirements\n${requirement('Extra')}`);
  await adapter('1.17 positive strict validation', (options) => validateOpenSpecChange('positive', options), positive);
  invoke(positive, ['validate', 'positive', '--strict', '--json']);

  // 1.16.0 scenario-step WARNING: a scenario without a trigger step.
  const noWhen = project('117-no-when');
  const missingWhen = `### Requirement: Missing When\nThe system SHALL report the missing trigger step.\n\n#### Scenario: Missing When request\n- **THEN** the system reports it\n`;
  put(noWhen, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  change(noWhen, 'no-when', `## ADDED Requirements\n${missingWhen}`);
  await strictWarning(noWhen, 'no-when', /a WHEN\/GIVEN step/);

  // 1.16.0 scenario-step WARNING: a scenario without an outcome step.
  const noThen = project('117-no-then');
  const missingThen = `### Requirement: Missing Then\nThe system SHALL report the missing outcome step.\n\n#### Scenario: Missing Then request\n- **WHEN** a request arrives\n`;
  put(noThen, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  change(noThen, 'no-then', `## ADDED Requirements\n${missingThen}`);
  await strictWarning(noThen, 'no-then', /a THEN step/);

  // GIVEN closes the WHEN/GIVEN side; GIVEN+THEN is not a scenario-step finding.
  const givenOk = project('117-given-then');
  const givenScenario = `### Requirement: Given Then\nThe system SHALL accept GIVEN as the trigger side.\n\n#### Scenario: Given Then request\n- **GIVEN** a prepared request\n- **THEN** the system handles it\n`;
  put(givenOk, 'openspec/specs/widgets/spec.md', spec(givenScenario));
  invoke(givenOk, ['validate', 'widgets', '--type', 'spec', '--strict', '--json', '--no-interactive']);

  // 1.16.1: unrecognized delta sections are ERROR; validate fails non-strict and archive refuses without mutation.
  const unrecognized = project('117-unrecognized');
  put(unrecognized, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  change(unrecognized, 'unrecognized', `## Notes\nThis text would be lost.\n\n## ADDED Requirements\n${requirement('Extra')}`);
  const unrecIssues = validation(unrecognized, 'unrecognized', false, 1);
  assert.ok(unrecIssues.some((issue) => issue.level === 'ERROR' && /Notes|not carried|recognized/i.test(issue.message)),
    JSON.stringify(unrecIssues));
  const beforeUnrec = inventory(unrecognized);
  await adapter('1.17 unrecognized archive refusal', (options) => archiveOpenSpecChange('unrecognized', options), unrecognized, {}, false);
  assert.deepEqual(inventory(unrecognized), beforeUnrec);

  // 1.16.1: DEPRECATED is not a recognized delta section; validate fails non-strict,
  // archive refuses and the inventory stays untouched.
  const deprecated = project('117-deprecated');
  put(deprecated, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  change(deprecated, 'deprecated', `## DEPRECATED Requirements\n- \`### Requirement: First\`\n`);
  const depIssues = validation(deprecated, 'deprecated', false, 1);
  assert.ok(depIssues.some((issue) => issue.level === 'ERROR' && /DEPRECATED|recognized/i.test(issue.message)),
    JSON.stringify(depIssues));
  const beforeDeprecated = inventory(deprecated);
  await adapter('1.17 deprecated archive refusal', (options) => archiveOpenSpecChange('deprecated', options), deprecated, {}, false);
  assert.deepEqual(inventory(deprecated), beforeDeprecated);

  // 1.16.1: closed section headings in a main spec stay valid (parser fix, not a ban).
  const closed = project('117-closed-heading');
  const closedSpec = `# Widgets Specification\n\n## Purpose ##\nDescribe how the audit fixture handles requests and preserves stable specification behavior across compatibility checks.\n\n## Requirements ##\n${requirement('First')}`;
  put(closed, 'openspec/specs/widgets/spec.md', closedSpec);
  invoke(closed, ['validate', 'widgets', '--type', 'spec', '--strict', '--json', '--no-interactive']);

  // 1.16.0: unspaced requirement headers are recognized by the parser fix.
  const unspaced = project('117-unspaced');
  put(unspaced, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  change(unspaced, 'unspaced', `## ADDED Requirements\n###Requirement: Unspaced\nThe system SHALL recognize unspaced requirement headers.\n\n#### Scenario: Unspaced request\n- **WHEN** a request arrives\n- **THEN** the system handles it\n`);
  const unspacedShow = invoke(unspaced, ['show', 'unspaced', '--type', 'change', '--deltas-only', '--json']).data;
  assert.equal(unspacedShow.deltas.length, 1);
  assert.equal(unspacedShow.deltas[0].requirement.name, 'Unspaced');
  invoke(unspaced, ['validate', 'unspaced', '--strict', '--json']);

  // 1.16.0: inline fences stay invisible to heading/section parsing (positive visibility).
  const inlineFence = project('117-inline-fence');
  const fencedBody = `### Requirement: Inline Fence\nThe system SHALL keep inline code such as \`(see \`## Notes\` guidance)\` inside the requirement body.\n\n#### Scenario: Inline Fence request\n- **WHEN** a request arrives\n- **THEN** the body stays intact\n`;
  put(inlineFence, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  change(inlineFence, 'inline-fence', `## ADDED Requirements\n${fencedBody}`);
  invoke(inlineFence, ['validate', 'inline-fence', '--strict', '--json']);

  // 1.16.0: unreadable config.yaml fails validate closed; non-validating commands carry on.
  const badConfig = project('117-bad-config');
  put(badConfig, 'openspec/config.yaml', 'schema: [invalid yaml\n');
  invoke(badConfig, ['validate', 'widgets', '--type', 'spec', '--json', '--no-interactive'], 1);
  invoke(badConfig, ['list', '--json']);
  put(badConfig, 'openspec/config.yaml', 'schema: spec-driven\n');
  invoke(badConfig, ['validate', 'widgets', '--type', 'spec', '--strict', '--json', '--no-interactive']);

  // Inherited 1.14.1 strict warning: ADDED requirement bodies over 500 characters.
  const lengths = project('117-lengths');
  const body = n => 'The system SHALL ' + 'x'.repeat(n - 'The system SHALL '.length - 1) + '.';
  const longRequirement = n => `### Requirement: Long\n${body(n)}\n\n#### Scenario: Long request\n- **WHEN** a request arrives\n- **THEN** it is handled\n`;
  change(lengths, 'lengths', '## ADDED Requirements\n' + longRequirement(501));
  await strictWarning(lengths, 'lengths', /Requirement text is very long/);
  const lengthBase = change(lengths, 'lengths-ok', '## ADDED Requirements\n' + longRequirement(500));
  assert.deepEqual(validation(lengths, 'lengths-ok', true), []);
  put(lengths, `${lengthBase}/specs/widgets/spec.md`, '## MODIFIED Requirements\n' + longRequirement(501));
  assert.deepEqual(validation(lengths, 'lengths-ok', true), []);

  // Inherited 1.14.2/1.15 strict warning: unknown metadata keys with x- exemptions.
  const metadata = project('117-metadata');
  const metadataBase = change(metadata, 'metadata');
  rmSync(path.join(metadata, metadataBase, 'specs'), { recursive: true, force: true });
  const native = 'schema: spec-driven\ncreated: "2026-09-19"\nskip_specs: true\n';
  put(metadata, `${metadataBase}/.openspec.yaml`, native + 'bogus_key: 1\n');
  await strictWarning(metadata, 'metadata', /Unrecognized key name\(s\)/);
  put(metadata, `${metadataBase}/.openspec.yaml`, native + 'x-goal: bounded\nx-jiraKey: TEST-1\n');
  const nativeIssues = validation(metadata, 'metadata', true);
  assert.ok(nativeIssues.every((issue) => issue.level === 'INFO'), JSON.stringify(nativeIssues));

  // Inherited 1.11 strict Purpose placeholder diagnostics.
  const purposes = project('117-purposes');
  const mainSpec = 'openspec/specs/widgets/spec.md';
  put(purposes, mainSpec, spec(requirement('First'), 'TBD - created by archiving change fixture. Update Purpose after archive.'));
  const placeholder = invoke(purposes, ['validate', 'widgets', '--type', 'spec', '--strict', '--json', '--no-interactive'], 1).data;
  const finding = placeholder.items[0].issues.find((issue) => /placeholder/i.test(issue.message));
  assert.equal(finding.level, 'WARNING');
  assert.match(finding.message, /directly/);

  // Inherited 1.13: repeated delta sections, show completeness and fence-preserving archive.
  const repeated = project('117-repeated');
  const example = '```markdown\n## ADDED Requirements\n' + requirement('Example only') + '\n\n```\n';
  change(repeated, 'repeat', `## ADDED Requirements\n${requirement('First')}\n${example}\n## ADDED Requirements\n${requirement('Second')}`);
  invoke(repeated, ['validate', 'repeat', '--strict', '--json']);
  const shown = invoke(repeated, ['show', 'repeat', '--type', 'change', '--deltas-only', '--json']).data;
  assert.equal(shown.deltas.length, 2, 'Exact 1.17 show must include both real deltas');
  assert.deepEqual(shown.deltas.map(d => d.requirement.name), ['First', 'Second']);
  await adapter('1.17 archive both repeated sections', (options) => archiveOpenSpecChange('repeat', options), repeated);
  const merged = readFileSync(path.join(repeated, 'openspec/specs/widgets/spec.md'), 'utf8');
  assert.match(merged, /### Requirement: First/);
  assert.match(merged, /### Requirement: Second/);
  assert.ok(merged.includes(example.trimEnd()), 'Fenced example blank lines must survive archive');

  // Inherited 1.12: findings report surfaces INFO/WARNING/ERROR and per-item issues.
  const findingsRoot = project('117-findings');
  put(findingsRoot, 'openspec/specs/widgets/spec.md', spec(requirement('First')));
  change(findingsRoot, 'findings-loss', `## MODIFIED Requirements\n${requirement('Absent')}`);
  change(findingsRoot, 'findings-ok', `## ADDED Requirements\n${requirement('Extra')}`);
  const findings = invoke(findingsRoot, ['validate', '--all', '--json', '--no-interactive'], 1).data;
  assert.ok(Array.isArray(findings.items) && findings.items.length >= 2, 'validate --all reports every selected item');
  assert.equal(findings.items.find((item) => item.id === 'findings-ok').valid, true);

  // Inherited 1.12: missing base spec is INFO with a strict-pass validation.
  const missingRoot = project('117-missing-base');
  change(missingRoot, 'missing-base', `## MODIFIED Requirements\n${requirement('Absent')}`, 'nested/missing');
  const missingShow = invoke(missingRoot, ['show', 'missing-base', '--type', 'change', '--diff', '--json']).data.deltas[0];
  assert.equal(missingShow.diff, undefined);
  assert.match(missingShow.warning, /No main spec/);
  const missingIssues = validation(missingRoot, 'missing-base', true);
  assert.ok(missingIssues.some((issue) => issue.level === 'INFO' && /Archive would refuse/.test(issue.message)),
    JSON.stringify(missingIssues));
  const beforeMissing = inventory(missingRoot);
  invoke(missingRoot, ['archive', 'missing-base', '--yes'], 1, false);
  assert.deepEqual(inventory(missingRoot), beforeMissing);
}
