// Exact-1.13.0 probes, called only after the live driver verifies package custody.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { archiveOpenSpecChange, getOpenSpecInstructions } from './openspec-runner.mjs';
import { buildOpenSpecCoverageMatrix } from './openspec-coverage-matrix.mjs';

export async function smokeOpenSpec113({ project, put, change, spec, requirement, invoke, inventory, adapter }) {
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
  // Upstream 1.13 show uses a different parser: record this residual explicitly.
  const shown = invoke(repeated, ['show', 'repeat', '--type', 'change', '--deltas-only', '--json']).data;
  assert.equal(shown.deltas.length, 1, 'Exact 1.13 show limitation changed; re-audit before updating this assertion');
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
    const before = inventory(retirement);
    await adapter(`1.13 wrapped retirement guarded=${guarded}`, (options) => archiveOpenSpecChange('retire', options), retirement, {}, !guarded);
    if (guarded) assert.deepEqual(inventory(retirement), before);
    else assert.equal(existsSync(path.join(retirement, 'openspec/specs/widgets/spec.md')), false);
  }
}
