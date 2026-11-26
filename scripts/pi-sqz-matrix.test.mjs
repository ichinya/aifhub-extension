import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { register, syncBuiltinESMExports } from 'node:module';
import fs, { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

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
  t.after(() => rm(root, { recursive: true, force: true }));
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
      assert.equal(await first.read(), lines.join('\n'));
      let recipient = first;
      if (transition === 'resume' || transition === 'handoff') recipient = await openTool(root, 'aifhub');
      else await first.event(transition);
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
