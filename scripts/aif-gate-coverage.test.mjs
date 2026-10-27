import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createGateResult, renderGateResultBlock } from './aif-gate-result.mjs';
import { digest } from './workflow-state-store.mjs';
import { buildGateCoverage, runGateCoverageCommand, parseGateCoverageArgs } from './aif-gate-coverage.mjs';

const qa = '.ai-factory/qa/work';
const render = (gate = 'verify', status = 'pass') => renderGateResultBlock(createGateResult({ gate, status,
  blockers: status === 'fail' ? [{ id: 'defect', severity: 'error', summary: 'Known defect', rule_id: 'rule-1' }] : [] }));
async function fixture(t, config = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-coverage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const put = async (name, text) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); };
  await put('.ai-factory/config.yaml', 'aifhub:\n  openspec:\n    requireRulesPassForDone: false\n    requireSpecCoverageForDone: false\n' + config);
  await put(`${qa}/verify.md`, render());
  return { root, put, build: extra => buildGateCoverage({ rootDir: root, changeId: 'work', ...extra }) };
}
const gate = (r, name = 'verify') => r.checks.find(c => c.gate === name);
async function image(root) {
  const rows = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const name = path.join(dir, entry.name), stat = await fs.lstat(path.join(root, name));
      rows.push([name, stat.mode, stat.mtimeMs, entry.isFile() ? digest(await fs.readFile(path.join(root, name))) : null]);
      if (entry.isDirectory()) await walk(name);
    }
  }
  await walk(''); return rows;
}

test('final PASS inventory is read-only and has no authority or target freshness claim', async t => {
  const f = await fixture(t), before = await image(f.root), r = await f.build();
  assert.equal(r.coverage, 'incomplete'); assert.deepEqual(r.required, ['verify']);
      assert.ok(gate(r).codes.includes('target-binding-unrecorded'));
  assert.equal(gate(r).result_state, 'valid'); assert.equal(gate(r).target_binding, 'unknown');
  assert.equal(gate(r).evidence_sha256, digest(render())); assert.deepEqual(r.authorizes, []);
  assert.deepEqual(await image(f.root), before);
});
for (const status of ['warn', 'fail']) test(`preserves final ${status} without producing a semantic verdict`, async t => {
  const f = await fixture(t); await f.put(`${qa}/verify.md`, render('verify', status));
  const r = await f.build(); assert.equal(gate(r).result_status, status);
  assert.equal(r.coverage, status === 'fail' ? 'blocked' : 'incomplete'); assert.deepEqual(r.authorizes, []);
});
test('missing results remain gaps and no QA/state directories are created', async t => {
  const f = await fixture(t); await fs.rm(path.join(f.root, '.ai-factory/qa'), { recursive: true });
  const before = await image(f.root), r = await f.build({ require: ['review', 'security'] });
  assert.equal(r.coverage, 'incomplete'); assert.equal(gate(r).result_state, 'missing');
  assert.deepEqual(await image(f.root), before);
});
for (const [name, content] of [
  ['wrong gate', render('security')], ['malformed JSON', '```aif-gate-result\n{secret-invalid\n```'],
  ['invalid latest', render() + '\n```aif-gate-result\n{}\n```'],
  ['unclosed terminal', render() + '\n```aif-gate-result\n{"gate":"verify"'],
  ['wrong terminal after PASS', render() + '\n' + render('review')]
]) test(`${name} cannot fall back to an old PASS`, async t => {
  const f = await fixture(t); await f.put(`${qa}/verify.md`, content);
  const r = await f.build(); assert.equal(gate(r).result_state, 'invalid'); assert.equal(r.coverage, 'incomplete');
  assert.ok(!JSON.stringify(r).includes('secret-invalid'));
});
test('last failing result wins over old PASS; duplicate same-type results are ordered', async t => {
  const f = await fixture(t); await f.put(`${qa}/verify.md`, render() + '\n' + render('verify', 'fail'));
  assert.equal((await f.build()).coverage, 'blocked');
  await f.put(`${qa}/verify.md`, render() + '\n' + render());
  assert.equal((await f.build()).coverage, 'incomplete');
});
test('canonical evidence is exact and does not fall back to a passing alias', async t => {
  const f = await fixture(t); await f.put(`${qa}/verify.md`, 'no final result');
  await f.put(`${qa}/aif-verify.md`, render()); assert.equal((await f.build()).coverage, 'incomplete');
});
test('effective policy unions verify/done flags and validates current coverage sources', async t => {
  const f = await fixture(t, '    requireRulesPassForVerify: true\n    requireSpecCoverageForVerify: true\n');
  await f.put(`${qa}/rules.md`, render('rules'));
  await f.put('source.md', 'current');
  const coverage = { schema_version: 1, change_id: 'work', status: 'pass', requirements: [], sources: [{ path: 'source.md', sha256: digest('current') }] };
  await f.put(`${qa}/coverage.json`, JSON.stringify(coverage));
  let r = await f.build(); assert.deepEqual(r.required, ['verify', 'rules', 'coverage']); assert.equal(r.coverage, 'incomplete');
  assert.equal(r.supporting.find(s => s.gate === 'coverage').target_binding, 'matched');
  assert.ok(gate(r).codes.includes('target-binding-unrecorded'));
  await f.put('source.md', 'changed'); r = await f.build(); assert.equal(r.coverage, 'incomplete');
  assert.equal(r.supporting[0].target_binding, 'mismatched');
  coverage.sources[0].path = '../outside'; await f.put(`${qa}/coverage.json`, JSON.stringify(coverage));
  assert.equal((await f.build()).supporting[0].result_state, 'invalid');
});
test('default policy requires rules and spec coverage; optional failing gates do not veto inventory', async t => {
  const f = await fixture(t); await fs.rm(path.join(f.root, '.ai-factory/config.yaml'));
  assert.deepEqual((await f.build()).required, ['verify', 'rules', 'coverage']);
  await f.put('.ai-factory/config.yaml', 'aifhub:\n  openspec:\n    requireRulesPassForDone: false\n    requireSpecCoverageForDone: false\n');
  await f.put(`${qa}/review.md`, render('review', 'fail'));
  assert.equal((await f.build()).coverage, 'incomplete');
  assert.equal((await f.build({ require: ['review'] })).coverage, 'blocked');
});
test('required WARN follows owner policy: Done allowWarn does not weaken Verify', async t => {
  const f = await fixture(t);
  const config = 'aifhub:\n  openspec:\n    requireRulesPassForDone: true\n    requireSpecCoverageForDone: false\n    allowWarnOnDone:\n      rules: true\n';
  await f.put('.ai-factory/config.yaml', config); await f.put(`${qa}/rules.md`, render('rules', 'warn'));
  assert.equal((await f.build()).coverage, 'incomplete');
  await f.put('.ai-factory/config.yaml', config.replace('    allowWarnOnDone:', '    requireRulesPassForVerify: true\n    allowWarnOnDone:'));
  assert.equal((await f.build()).coverage, 'incomplete');
});
test('labels, self-review prose and no receipt never establish independence', async t => {
  const f = await fixture(t); await f.put(`${qa}/review.md`, 'Role: independent specialist; self-review\n' + render('review'));
  const r = await f.build({ require: ['review'] }); assert.equal(r.coverage, 'incomplete');
  assert.equal(gate(r, 'review').provenance, 'unrecorded'); assert.equal(gate(r, 'review').independence, 'unknown');
});
for (const kind of ['fresh-context', 'same-session', 'mismatched', 'reviewed']) test(`${kind} receipt cannot substitute for final result/role/current-target binding`, async t => {
  const f = await fixture(t), dir = '.ai-factory/state/work/reviews/audit';
  await f.put(`${qa}/review.md`, render('review')); await f.put(`${qa}/security.md`, render('security'));
  await f.put(`${dir}/review-target.diff`, 'diff');
  await f.put(`${dir}/ai-cross-context-review.json`, JSON.stringify({ schema: 'aifhub.ai_cross_context_review.v1', change_id: 'work',
    execution_profile: 'ai-fresh-context', same_session_fallback: kind === 'same-session',
    outcome: kind === 'reviewed' ? 'reviewed' : 'prepared', target: { path: 'review-target.diff', fingerprint: digest(kind === 'mismatched' ? 'other' : 'diff') } }));
  const r = await f.build({ require: ['review', 'security'] }); assert.equal(r.coverage, 'incomplete');
  for (const name of ['review', 'security']) assert.equal(gate(r, name).independence, 'unknown');
  assert.equal(r.provenance_observations[0].provenance, kind === 'same-session' ? 'same-session' : kind === 'mismatched' ? 'unknown' : 'fresh-context');
  assert.equal(r.provenance_observations[0].target_binding, 'unknown');
});
test('prepared package never supplies a missing final review; conflicting packages do not select a winner', async t => {
  const f = await fixture(t);
  for (const name of ['one', 'two']) await f.put(`.ai-factory/state/work/reviews/${name}/ai-cross-context-review.json`, '{}');
  const r = await f.build({ require: ['review'] }); assert.equal(gate(r, 'review').result_state, 'missing');
  assert.equal(r.provenance_observations.length, 2); assert.equal(r.coverage, 'incomplete');
});
test('done readiness is supporting-only and cannot override a failing verify', async t => {
  const f = await fixture(t); await f.put(`${qa}/verify.md`, render('verify', 'fail'));
  await f.put(`${qa}/done-readiness.json`, JSON.stringify({ schema_version: 1, change_id: 'work', status: 'pass' }));
  assert.equal((await f.build()).coverage, 'blocked');
});
test('unsafe query fields and unknown arguments give exit 2 without echoing input', async () => {
  for (const args of [[], ['--change', '../escape'], ['--change', 'C:secret'], ['--change', 'work', '--require', 'rules'],
    ['--change', 'work', '--require', 'review,review'], ['--change', 'work', '--write'], ['--change', 'work', '--require', ''],
    ['--change', 'work', '--change', 'other']]) {
    assert.equal(parseGateCoverageArgs(args), null);
    let out; assert.equal(await runGateCoverageCommand(args, { output: value => { out = value; } }), 2);
    assert.deepEqual(out.codes, ['invalid-query']);
  }
});
test('command exits 1 while gate-to-target binding is unrecorded, 2 for bad queries', async t => {
  const f = await fixture(t); let out;
  const options = { rootDir: f.root, output: value => { out = value; } };
  assert.equal(await runGateCoverageCommand(['--change', 'work', '--json'], options), 1);
  assert.equal(out.coverage, 'incomplete'); assert.deepEqual(out.authorizes, []);
  assert.equal(await runGateCoverageCommand(['--change', 'work', '--require', 'review', '--json'], options), 1);
});
for (const kind of ['hardlink', 'junction']) test(`rejects ${kind} evidence`, async t => {
  const f = await fixture(t), verify = path.join(f.root, qa, 'verify.md');
  if (kind === 'hardlink') {
    await fs.link(verify, path.join(f.root, 'second-link.md'));
  } else {
    const outside = path.join(f.root, 'other'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'verify.md'), render());
    await fs.rm(path.join(f.root, qa), { recursive: true });
    await fs.symlink(outside, path.join(f.root, qa), 'junction');
  }
  const r = await f.build(); assert.equal(r.coverage, 'incomplete'); assert.equal(gate(r).result_state, 'invalid');
});
test('bounded files and receipt inventory cannot produce unbounded diagnostics', async t => {
  const f = await fixture(t); await f.put(`${qa}/verify.md`, 'x'.repeat(1024 * 1024 + 1));
  for (let i = 0; i < 65; i++) await f.put(`.ai-factory/state/work/reviews/r${i}/ai-cross-context-review.json`, '{}');
  const r = await f.build(); assert.equal(r.coverage, 'unknown'); assert.ok(JSON.stringify(r).length < 10000);
  assert.ok(r.codes.includes('receipt-inventory-invalid-or-unsafe'));
});
test('evidence bytes changed after the first read prevent complete inventory', async t => {
  const f = await fixture(t), original = fs.open; let changed = false;
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith('verify.md') && !changed) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); if (!changed) { changed = true; await fs.writeFile(args[0], render('verify', 'fail')); } };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { assert.equal((await f.build()).coverage, 'unknown'); }
  finally { fs.open = original; syncBuiltinESMExports(); }
});
