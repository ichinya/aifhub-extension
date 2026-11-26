import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { register, syncBuiltinESMExports } from 'node:module';
import fs, { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

describe('issue 186 Pi task accounting', () => {
  let root, records, report, terminal, summary;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sqz-pi-accounting-'));
    const matrix = new URL('../benchmarks/pi-sqz-matrix/', import.meta.url);
    const runner = path.join(root, 'run-matrix.mjs');
    await fs.copyFile(new URL('run-matrix.mjs', matrix), runner);
    const cwd = path.join(root, 'project');
    await mkdir(cwd);
    const model = { provider: 'fixture-provider', model: 'fixture-alpha', thinking: 'low' };
    await writeFile(path.join(root, 'scenarios.json'), JSON.stringify({ model, projects: [{
      id: 'fixture', label: 'fixture', path: cwd, tasks: [{ id: 'research-sample', kind: 'research',
        prompt: 'fixture', assertions: ['known answer'] }]
    }] }));

    // Substitute the optional Pi executable. The runner reads actual session files, checks the answer,
    // and observes the exit code of the subprocess. No model or installed provider is required.
    const bin = path.join(root, 'npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'cli.js'), [
      "const fs = require('node:fs'), path = require('node:path');",
      "const dir = process.argv[process.argv.indexOf('--session-dir') + 1], arm = process.env.SQZ_BENCH_MODE;",
      "function session(name, usage) {",
      "  const header = {type:'session', version:3, id:name, cwd:process.cwd()};",
      "  const messages = usage.map(u => ({type:'message', message:{role:'assistant', stopReason:u.stopReason ?? 'stop', content:[{type:'text',text:'known answer'}], usage:u}}));",
      "  fs.writeFileSync(path.join(dir,name+'.jsonl'), [header,...messages].map(entry => JSON.stringify(entry)).join('\\n')+'\\n');",
      "}",
      "const first = {input:7, output:2, cacheRead:0, cacheWrite:4, totalTokens:13, cost:{total:0.125}};",
      "const second = arm === 'aifhub' ? {input:11, cacheRead:0} : {input:11, output:3, cacheRead:0, cacheWrite:5, totalTokens:19, cost:{total:0.25}};",
      "if (process.argv.at(-1) === 'terminal-fixture') {",
      "  session('aborted', [{stopReason:'aborted',input:0,output:0,totalTokens:0,cost:{total:0}}]); process.exit(0);",
      "}",
      "const interrupted = {stopReason:'error', input:0, output:0, cacheRead:0, cost:{total:0}};",
      "session('first', arm === 'aifhub' ? [first,interrupted,second] : [first,second]);",
      "if (arm === 'sqz') {",
      "  session('unbound', [{input:9001, output:84, cost:{total:9}}]);",
      "  fs.utimesSync(path.join(dir,'first.jsonl'), 1000, 1000);",
      "}",
      "if (arm === 'off') process.exitCode = 7;"
    ].join('\n'));
    const out = path.join(root, 'observed');
    const fixtureEnv = { APPDATA: root, USERPROFILE: root, HOME: root, TEMP: root, TMP: root, TMPDIR: root };
    if (process.env.SystemRoot) fixtureEnv.SystemRoot = process.env.SystemRoot;
    execFileSync(process.execPath, [runner, '--out', out], {
      env: fixtureEnv, encoding: 'utf8', timeout: 20000, stdio: 'pipe'
    });
    const terminalOut = path.join(root, 'terminal');
    const catalogFile = path.join(root, 'scenarios.json');
    const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
    catalog.projects[0].tasks[0].prompt = 'terminal-fixture';
    await writeFile(catalogFile, JSON.stringify(catalog));
    execFileSync(process.execPath, [runner, '--out', terminalOut, '--arms', 'off'], { env: fixtureEnv, timeout: 20000, stdio: 'pipe' });
    const dir = path.join(terminalOut, 'results');
    terminal = JSON.parse(await readFile(path.join(dir, (await fs.readdir(dir))[0]), 'utf8'));
    const results = path.join(out, 'results');
    records = {};
    for (const name of await fs.readdir(results)) {
      const row = JSON.parse(await readFile(path.join(results, name), 'utf8'));
      records[row.arm] = row;
    }
    // An independent historical-format row for a second profile at the same project / task / arm.
    const secondOut = path.join(root, 'second-profile');
    await mkdir(path.join(secondOut, 'results'), { recursive: true });
    await writeFile(path.join(secondOut, 'results/control.json'), JSON.stringify({
      project: 'fixture', task: 'research-sample', arm: 'off', repeat: 1, runId: 'beta-off-1',
      model: { provider: 'other-provider', model: 'fixture-beta', thinking: 'high' },
      quality: { pass: true }, pi: { exitCode: 0 }, turns: 1,
      usage: { input: 22, output: 1, cacheRead: 0, cost: 0.5, costAvailable: true }
    }));
    for (const [arm, totalTokens] of Object.entries({ off: 8205, aifhub: 0, sqz: 12119 })) {
      await writeFile(path.join(secondOut, 'results', arm + '.json'), JSON.stringify({
        project: 'fixture', task: 'research-paired', arm, repeat: 1, runId: 'paired-' + arm,
        model, quality: { pass: true }, pi: { exitCode: 0 }, usage: { totalTokens }
      }));
    }
    const args = [fileURLToPath(new URL('summarize.mjs', matrix)), '--out', out, '--out', secondOut];
    const options = { encoding: 'utf8', timeout: 10000 };
    report = execFileSync(process.execPath, args, options);
    summary = JSON.parse(execFileSync(process.execPath, [...args, '--json'], options));
  });
  after(async () => { if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

  it('counts usage from both turns of an unsuccessful invocation, including reported cost and measured zero', () => {
    const r = records.off;
    assert.equal(r.pi.exitCode, 7);
    assert.equal(r.turns, 2);
    assert.deepEqual([r.usage.input, r.usage.output, r.usage.cacheRead, r.usage.cost, r.usage.costAvailable],
      [18, 5, 0, 0.375, true]);
    assert.equal(r.usage.totalTokens, 32);
    assert.equal(summary.rows.find(row => row.runId === r.runId).totalTokens, 32);
    assert.equal(summary.rows.find(row => row.runId === 'beta-off-1').totalTokens, null);
    assert.equal(summary.rows.find(row => row.runId === 'paired-aifhub').totalTokens, 0);
    const delta = summary.pairedTrials.find(group => group.caseId === 'research-paired').comparisons.sqz.totalTokens;
    assert.deepEqual([delta.count, delta.median], [1, -3914]);
    assert.match(report, /\| input tok \| output tok \| total tok \|/);
    assert.match(report, /\| sqz \| totalTokens \| 1\/1 \| -3914 \|/);
  });

  it('preserves a recovered answer and reports only known subtotals after a provider error', () => {
    const u = records.aifhub.usage;
    assert.deepEqual([records.aifhub.quality.pass, records.aifhub.errorTurns, u.input, u.cacheRead], [true, 1, null, null]);
    assert.deepEqual(u.partial.input, { known: 18, observedTurns: 2, totalTurns: 3 });
    assert.equal(u.totalTokens, null);
    assert.deepEqual(u.partial.totalTokens, { known: 13, observedTurns: 1, totalTurns: 3 });
    assert.equal(u.partial.cacheRead.known, 0);
    assert.equal(u.partial.cost.known, 0.125);
    assert.ok(u.output == null || u.output === 'unavailable', '2 known output tokens are only a subtotal');
    assert.equal(u.costAvailable, false, 'one priced turn cannot establish the total cost');
  });

  it('retains a terminal provider abort even when the process exits zero and the answer matches', () => {
    assert.deepEqual([terminal.pi.exitCode, terminal.quality.pass, terminal.error, terminal.errorTurns],
      [0, true, 'terminal-provider-error', 1]);
    assert.equal(terminal.usage.cost, null);
    assert.equal(terminal.usage.totalTokens, null);
    assert.deepEqual(terminal.usage.partial, {});
  });

  it('does not attribute the latest of two unbound session files to the cell', () => {
    const u = records.sqz.usage;
    assert.ok(u.input == null || u.input === 'unavailable', 'neither 18 nor 9001 is a verified input total');
    assert.ok(u.unavailable || u.reason || u.available === false, 'ambiguous session ownership needs an explicit limitation');
  });

  it('excludes a nonzero runner exit from successful cells even when the answer matched', () => {
    const rows = report.split(/\r?\n/).filter(line => line.startsWith('|') && line.includes('research:sample'));
    const off = rows.filter(line => line.split('|').some(value => value.trim() === 'off'));
    assert.equal(off.length, 2, 'both profiles must retain their observed off cell');
    assert.equal(off.filter(line => /\|\s*PASS\s*\|/.test(line)).length, 1);
    assert.equal(off.filter(line => /\|\s*(ERROR|FAIL)\s*\|/.test(line)).length, 1);
  });

  it('reports both observed model profiles and the known monetary costs of their cells', () => {
    for (const label of ['fixture-alpha', 'fixture-beta', 'fixture-provider', 'other-provider']) {
      assert.ok(report.includes(label), 'missing observed profile label: ' + label);
    }
    assert.match(report, /0\.375\b/);
    assert.match(report, /0\.50*\b/);
  });
});

// Load the shipped extension. Only its two optional Pi dependencies are supplied
// by the test host. A four-line display limit makes a continuation deterministic.
const extension = new URL('../benchmarks/pi-sqz-matrix/dedup-read.mjs', import.meta.url);
const moduleUrl = source => 'data:text/javascript,' + encodeURIComponent(source);
const dependencies = {
  '@earendil-works/pi-coding-agent': moduleUrl([
    'export const DEFAULT_MAX_LINES = 4, DEFAULT_MAX_BYTES = 8192;',
    'export const formatSize = n => n + "B";',
    'export function truncateHead(text) {',
    '  const lines = text.split("\\n");',
    '  return { content: lines.slice(0, 4).join("\\n"), truncated: lines.length > 4,',
    '    truncatedBy: "lines", outputLines: Math.min(4, lines.length), firstLineExceedsLimit: false };',
    '}'
  ].join('\n')),
  typebox: moduleUrl('export const Type = { Object: x=>x, String: x=>x, Optional: x=>x, Boolean: x=>x, Number: x=>x };')
};
register(moduleUrl([
  'const dependencies = ' + JSON.stringify(dependencies) + ';',
  'export function resolve(name, ctx, next) {',
  '  if (ctx.parentURL === ' + JSON.stringify(extension.href) + ' && Object.hasOwn(dependencies, name))',
  '    return { url: dependencies[name], shortCircuit: true };',
  '  return next(name, ctx);',
  '}'
].join('\n')), import.meta.url);
const { default: activate } = await import(extension.href);

async function openTool(root, mode, sessionId = 'session-1') {
  const events = new Map();
  let read;
  const env = {
    SQZ_BENCH_MODE: mode, SQZ_BENCH_RUN_ID: 'read-contract', SQZ_BENCH_MIN_BYTES: '1',
    SQZ_BENCH_METRICS: path.join(root, 'metrics.json'), SQZ_BENCH_SQZ_CMD: process.execPath
  };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    await activate({
      registerTool(tool) { if (tool.name === 'read') read = tool; },
      on(name, fn) { events.set(name, fn); }
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const messages = [];
  const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId, buildSessionProjection: () => ({ messages }) } };
  const event = (name, payload = {}) => events.get(name)?.(payload, ctx);
  await event('session_start', { reason: 'resume' });
  const execute = params => read.execute('test-read', { path: 'notes.txt', ...params }, undefined, undefined, ctx);
  return {
    event, execute, messages, parameters: read.parameters,
    async read(params = {}) {
      const reply = await execute(params);
      assert.ok(!reply.details.error, 'registered read should deliver requested text');
      return reply.content[0].text;
    }
  };
}

const entries = Array.from({ length: 8 }, (_, i) => 'entry ' + (i + 1) + ' ' + 'neutral '.repeat(17) + 'end');

async function workspace(t, lines) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-pi-read-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await writeFile(path.join(root, 'notes.txt'), lines.join('\n'));
  await writeFile(path.join(root, 'compress'), "process.stdin.pipe(process.stdout);");
  return root;
}

describe('registered Pi read delivery', () => {
  for (const mode of ['off', 'aifhub', 'sqz']) {
    it(mode + ' opens allowed text and images through their canonical paths', async t => {
      const root = await workspace(t, ['ordinary control']);
      const source = path.join(root, 'samples');
      await mkdir(source);
      await symlink(source, path.join(root, 'allowed-alias'), process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(path.join(source, 'note.txt'), 'sample');
      await writeFile(path.join(source, 'image.png'), Buffer.from([1, 2, 3]));
      const expectedPaths = await Promise.all(['note.txt', 'image.png'].map(name => fs.realpath(path.join(source, name))));
      const tool = await openTool(root, mode);
      const opened = [];
      const unallocated = path.join(path.dirname(root), randomUUID());
      let deniedReadAttempts = 0;
      const originalRead = fs.readFile;
      const spy = t.mock.method(fs, 'readFile', (file, ...args) => {
        if (typeof file === 'string' && path.dirname(file) === unallocated) {
          deniedReadAttempts++;
          throw new Error('test observer intercepted a content read');
        }
        if (typeof file === 'string' && ['note.txt', 'image.png'].includes(path.basename(file))) opened.push(path.normalize(file));
        return originalRead(file, ...args);
      });
      syncBuiltinESMExports();
      try {
        const note = await tool.execute({ path: 'allowed-alias/note.txt', limit: 1 });
        const image = await tool.execute({ path: 'allowed-alias/image.png' });
        assert.equal(note.content[0].text, 'sample');
        assert.equal(image.details.image, true);
        assert.equal(opened.length, 2);
        assert.ok(opened.every((file, index) => file === expectedPaths[index]), 'both reads use the canonical fixture');
        for (const name of ['note.txt', 'image.png']) {
          const denied = await tool.execute({ path: path.join(unallocated, name) });
          assert.equal(denied.details.error, true);
          assert.match(denied.content[0].text, /project root/);
          assert.ok(!JSON.stringify(denied).includes(path.basename(unallocated)));
        }
        assert.equal(deniedReadAttempts, 0);
      } finally {
        spy.mock.restore();
        syncBuiltinESMExports();
      }
    });

    it(mode + ' preserves protected fixture bytes under configured roots and permitted aliases', async t => {
      const root = await workspace(t, ['ordinary control']);
      const marker = randomUUID();
      const original = Buffer.from('Состояние Δ\r\n' + marker + ' neutral'.repeat(70) + '\r\n');
      await mkdir(path.join(root, '.ai-factory'), { recursive: true });
      await writeFile(path.join(root, '.ai-factory/config.yaml'),
        'paths:\n  plans: custom/plans\n  specs: custom/specs\n  qa: custom/qa\n  state: custom/state\n  generated_rules: custom/rules\n');
      const targets = ['openspec/specs/demo/spec.md', 'openspec/changes/demo/design.md',
        '.ai-factory/qa/demo/result.md', '.ai-factory/state/demo/done-readiness.json', '.ai-factory/rules/generated/demo.md',
        'reports/coverage.json', 'reports/done-readiness.json', 'reports/aif-gate-result.json',
        'custom/specs/demo/spec.md', 'custom/qa/demo/evidence.md', 'custom/plans/demo/plan.md',
        'custom/state/demo/trace.md', 'custom/rules/demo.md', 'mixed-case/Coverage.JSON'];
      for (const target of targets) {
        await mkdir(path.dirname(path.join(root, target)), { recursive: true });
        await writeFile(path.join(root, target), original);
      }
      await symlink(path.join(root, 'custom/specs'), path.join(root, 'allowed-alias'),
        process.platform === 'win32' ? 'junction' : 'dir');
      targets.push('allowed-alias/demo/spec.md');
      if (process.platform === 'win32') targets.push('CUSTOM/QA/demo/evidence.md');
      await writeFile(path.join(root, 'calls.txt'), '');
      await writeFile(path.join(root, 'compress'),
        "require('node:fs').appendFileSync('calls.txt','1'); process.stdin.resume(); process.stdout.write('short');");
      const tool = await openTool(root, mode);
      for (const target of targets) {
        for (let pass = 0; pass < 2; pass++) {
          const reply = await tool.execute({ path: target });
          assert.ok(!reply.details.error && Buffer.from(reply.content[0].text).equals(original), target);
          if (mode !== 'off') assert.equal(reply.details.dedup?.decision, 'protected', target);
        }
      }
      assert.equal(await readFile(path.join(root, 'calls.txt'), 'utf8'), '');
      if (mode === 'sqz') {
        await tool.read();
        assert.equal(await readFile(path.join(root, 'calls.txt'), 'utf8'), '1');
      }
      await tool.event('session_shutdown');
      const metrics = await readFile(path.join(root, 'metrics.json'), 'utf8');
      assert.ok(!metrics.includes(marker));
      assert.equal(JSON.parse(metrics).totals.readCalls, targets.length * 2 + Number(mode === 'sqz'));
    });
  }

  for (const mode of ['off', 'aifhub', 'sqz']) {
    it(mode + ' delivers disjoint line ranges and a later complete request', async t => {
      const root = await workspace(t, entries.slice(0, 3));
      const tool = await openTool(root, mode);
      assert.equal(await tool.read({ offset: 1, limit: 1 }), entries[0] + '\n\n[2 more lines in file. Use offset=2 to continue.]');
      assert.equal(await tool.read({ offset: 3, limit: 1 }), entries[2]);
      assert.equal(await tool.read(), entries.slice(0, 3).join('\n'));
    });

    it(mode + ' delivers the continuation advertised after automatic truncation', async t => {
      const root = await workspace(t, entries);
      const tool = await openTool(root, mode);
      const first = await tool.read();
      const marker = /Use offset=(\d+) to continue\./.exec(first);
      assert.ok(marker);
      assert.equal(Number(marker[1]), 5);
      assert.equal(await tool.read({ offset: Number(marker[1]) }), entries.slice(4).join('\n'));
    });
  }

  it('returns original Pi text on force even after confirmed visible delivery', async t => {
    const lines = entries.slice(0, 3);
    const root = await workspace(t, lines);
    const tool = await openTool(root, 'aifhub');
    assert.ok(Object.hasOwn(tool.parameters, 'force'));
    const first = await tool.execute({});
    tool.messages.push({ role: 'toolResult', toolName: 'read', content: first.content, details: first.details });
    assert.equal((await tool.execute({})).details.dedup.decision, 'deduplicated');
    assert.equal(await tool.read({ force: true }), lines.join('\n'));
  });

  for (const transition of ['session_compact', 'session_tree', 'resume', 'handoff']) {
    it('keeps a full read available after ' + transition, async t => {
      const lines = entries.slice(1, 4);
      const root = await workspace(t, lines);
      const first = await openTool(root, 'aifhub');
      const reply = await first.execute({});
      assert.equal(reply.content[0].text, lines.join('\n'));
      const delivered = { role: 'toolResult', toolName: 'read', content: reply.content, details: reply.details };
      first.messages.push(delivered);
      assert.equal((await first.execute({})).details.dedup.decision, 'deduplicated');
      let recipient = first;
      if (transition === 'resume' || transition === 'handoff') {
        recipient = await openTool(root, 'aifhub');
        recipient.messages.push(delivered); // A restored transcript still belongs to the previous recipient.
      } else {
        // Pi exposes the compacted or newly selected branch through buildSessionProjection.
        first.messages.splice(0, 1, { role: 'assistant', content: [{ type: 'text', text: 'summary without the file' }] });
        await first.event(transition);
      }
      assert.equal(await recipient.read(), lines.join('\n'));
    });
  }

  it('delivers a changed file and the other project’s version of the same path', async t => {
    const root = await workspace(t, entries.slice(0, 3));
    const other = await workspace(t, entries.slice(5));
    const tool = await openTool(root, 'aifhub');
    assert.equal(await tool.read(), entries.slice(0, 3).join('\n'));
    await writeFile(path.join(root, 'notes.txt'), entries.slice(2, 5).join('\n'));
    assert.equal(await tool.read(), entries.slice(2, 5).join('\n'));
    assert.equal(await (await openTool(other, 'aifhub')).read(), entries.slice(5).join('\n'));
  });
});
