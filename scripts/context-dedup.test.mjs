// context-dedup.test.mjs - tests for the optional session read dedup service
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  CONTEXT_DEDUP_SCHEMA_VERSION,
  createLedger,
  defaultContextDedupPolicy,
  hashContent,
  isProtectedReadPath,
  loadLedger,
  main,
  purgeSession,
  recordRead,
  resolveContextDedupPolicy,
  resolveLedgerPath,
  resolveSessionId,
  readContextDedupPolicy,
  runSqzCompression,
  saveLedger,
  summarizeSession
} from './context-dedup.mjs';

const ENABLED_CONFIG = `aifhub:
  artifactProtocol: openspec
  contextDedup:
    enabled: true
    minBytes: 64
`;

let rootDir;

function body(marker, size = 400) {
  return `${marker}\n${'context line for dedup tests\n'.repeat(size)}`;
}

async function writeProjectFile(relativePath, content) {
  const absolute = path.join(rootDir, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
  return absolute;
}

async function enabledPolicy(overrides = '') {
  await writeProjectFile(path.join('.ai-factory', 'config.yaml'), `${ENABLED_CONFIG}${overrides}`);
  return readContextDedupPolicy({ rootDir });
}

function collect() {
  const chunks = [];
  return { write: (value) => chunks.push(value), text: () => chunks.join('') };
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-context-dedup-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('context dedup policy', () => {
  it('is disabled by default and keeps built-in protected patterns', () => {
    const policy = defaultContextDedupPolicy();

    assert.equal(policy.mode, 'off');
    assert.equal(policy.enabled, false);
    assert.equal(policy.minBytes, 2048);
    assert.ok(policy.protectedPatterns.includes('openspec/specs/**'));
  });

  it('reads aifhub.contextDedup from config yaml and appends extra protected patterns', () => {
    const policy = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    enabled: true
    minBytes: 128
    protectedPatterns: [docs/frozen/**]
`);

    assert.equal(policy.enabled, true);
    assert.equal(policy.mode, 'aifhub');
    assert.equal(policy.minBytes, 128);
    assert.ok(policy.protectedPatterns.includes('docs/frozen/**'));
    assert.ok(policy.protectedPatterns.includes('**/coverage.json'));
    assert.deepEqual(policy.diagnostics, []);
  });

  it('resolves explicit modes and preserves legacy boolean compatibility', () => {
    const off = resolveContextDedupPolicy('aifhub:\n  contextDedup:\n    mode: "off"\n');
    const aifhub = resolveContextDedupPolicy('aifhub:\n  contextDedup:\n    mode: aifhub\n');
    const sqz = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    mode: sqz
    sqz:
      command: tools/sqz.exe
`);
    const legacyOn = resolveContextDedupPolicy('aifhub:\n  contextDedup:\n    enabled: true\n');
    const legacyOff = resolveContextDedupPolicy('aifhub:\n  contextDedup:\n    enabled: false\n');

    assert.deepEqual([off.mode, off.enabled], ['off', false]);
    assert.deepEqual([aifhub.mode, aifhub.enabled], ['aifhub', true]);
    assert.deepEqual([sqz.mode, sqz.enabled, sqz.sqz.command], ['sqz', true, 'tools/sqz.exe']);
    assert.ok(sqz.diagnostics.some((entry) => entry.code === 'context-dedup-sqz-external-tool'));
    assert.deepEqual([legacyOn.mode, legacyOn.enabled], ['aifhub', true]);
    assert.deepEqual([legacyOff.mode, legacyOff.enabled], ['off', false]);
  });

  it('lets explicit mode override conflicting legacy enabled and rejects invalid modes', () => {
    const conflict = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    mode: "off"
    enabled: true
`);
    const invalid = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    mode: automatic
    enabled: true
`);

    assert.deepEqual([conflict.mode, conflict.enabled], ['off', false]);
    assert.ok(conflict.diagnostics.some((entry) => entry.code === 'context-dedup-mode-conflict'));
    assert.deepEqual([invalid.mode, invalid.enabled], ['aifhub', true]);
    assert.ok(invalid.diagnostics.some((entry) => entry.code === 'context-dedup-malformed-value'));
  });

  it('accepts block-list patterns and inline comments but rejects partial integers', () => {
    const policy = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    enabled: true # explicit opt-in
    minBytes: 12junk
    maxEntries: 1.5
    protectedPatterns:
      - docs/frozen/** # project policy
      - "docs/quoted/**"
`);

    assert.equal(policy.enabled, true);
    assert.equal(policy.minBytes, 2048);
    assert.equal(policy.maxEntries, 500);
    assert.ok(policy.protectedPatterns.includes('docs/frozen/**'));
    assert.ok(policy.protectedPatterns.includes('docs/quoted/**'));
    assert.equal(policy.diagnostics.filter((entry) => entry.code === 'context-dedup-malformed-value').length, 2);
  });

  it('derives protected paths and ledger state from configured project paths', () => {
    const policy = resolveContextDedupPolicy(`aifhub:
  artifactProtocol: openspec
  contextDedup:
    enabled: true
paths:
  plans: project-spec/changes
  specs: project-spec/specs
  qa: runtime/qa
  generated_rules: runtime/rules
  state: runtime/state
`);

    for (const protectedPath of [
      'project-spec/changes/demo/proposal.md',
      'project-spec/specs/demo/spec.md',
      'runtime/qa/demo/aif-gate-result.json',
      'runtime/rules/trace.md',
      'runtime/state/demo/trace.json'
    ]) {
      assert.equal(isProtectedReadPath(protectedPath, policy), true, protectedPath);
    }
    assert.equal(policy.stateDir, 'runtime/state/context-dedup');
  });

  it('protects legacy specs by default when ai-factory paths are omitted', () => {
    const policy = resolveContextDedupPolicy(`aifhub:
  artifactProtocol: ai-factory
  contextDedup:
    enabled: true
`);

    assert.equal(isProtectedReadPath('.ai-factory/plans/demo.md', policy), true);
    assert.equal(isProtectedReadPath('.ai-factory/specs/auth/spec.md', policy), true);
  });

  it('keeps context dedup disabled without emitting unrelated full-config warnings', () => {
    const policy = resolveContextDedupPolicy(`language:
  ui: ru
aifhub:
  artifactProtocol: openspec
paths:
  state: runtime/state
`);

    assert.equal(policy.enabled, false);
    assert.deepEqual(policy.diagnostics, []);
  });

  it('falls back to defaults with diagnostics for malformed and unknown keys', () => {
    const policy = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    enabled: sometimes
    minBytes: many
    surprise: 1
`);

    assert.equal(policy.enabled, false);
    assert.equal(policy.minBytes, 2048);
    assert.deepEqual(
      policy.diagnostics.map((entry) => entry.code).sort(),
      ['context-dedup-malformed-value', 'context-dedup-malformed-value', 'context-dedup-unknown-key']
    );
  });

  it('ignores prototype-polluting config keys', () => {
    const policy = resolveContextDedupPolicy(`__proto__:
  polluted: true
aifhub:
  contextDedup:
    enabled: true
`);

    assert.equal(policy.enabled, true);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  });

  it('treats protected validation artifacts as never deduplicated', () => {
    const policy = defaultContextDedupPolicy();

    for (const protectedPath of [
      'openspec/specs/auth/spec.md',
      '.ai-factory/rules/generated/openspec-rules-trace-add-oauth.md',
      '.ai-factory/qa/add-oauth/aif-gate-result.json',
      '.ai-factory/state/add-oauth/coverage.json',
      '.ai-factory/state/add-oauth/done-readiness.json',
      'coverage.json',
      'done-readiness.json',
      'aif-gate-result.json'
    ]) {
      assert.equal(isProtectedReadPath(protectedPath, policy), true, protectedPath);
    }

    assert.equal(isProtectedReadPath('src/auth/session.ts', policy), false);
  });
});

describe('recordRead decisions', () => {
  it('returns full content on the first read and deduplicates the identical second read', async () => {
    const policy = await enabledPolicy();
    const content = body('session');
    const contentBytes = Buffer.byteLength(content, 'utf8');
    await writeProjectFile('src/session.ts', content);

    const first = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });
    assert.equal(first.decision, 'full');
    assert.equal(first.content, content);
    assert.equal(first.savedBytes, 0);

    const second = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });
    assert.equal(second.decision, 'deduplicated');
    assert.equal(second.content, null);
    assert.equal(second.readCount, 2);
    const replayBytes = Buffer.byteLength(second.replay.text, 'utf8');
    assert.equal(second.replayBytes, replayBytes);
    assert.equal(second.savedBytes, contentBytes - replayBytes);
    assert.equal(second.estimatedSavedTokens, Math.ceil((contentBytes - replayBytes) / 4));
    assert.match(second.replay.text, /already provided in this session/);
    assert.match(second.replay.text, new RegExp(hashContent(content).slice(0, 23)));
    assert.match(second.replay.text, /force=true/);
    assert.ok(replayBytes <= 220, `replay must stay compact; received ${replayBytes} bytes`);
  });

  it('serves full content when a replay would not reduce the model-visible payload', async () => {
    const policy = await enabledPolicy();
    const content = 'small-but-above-configured-threshold'.repeat(3);
    await writeProjectFile('src/small.txt', content);

    const first = await recordRead({ filePath: 'src/small.txt', content, rootDir, policy, sessionId: 'small' });
    const second = await recordRead({ filePath: 'src/small.txt', content, rootDir, policy, sessionId: 'small' });
    const summary = await summarizeSession({ rootDir, policy, sessionId: 'small' });

    assert.equal(first.decision, 'full');
    assert.equal(second.decision, 'full');
    assert.equal(second.content, content);
    assert.match(second.reason, /would not reduce the model-visible payload/);
    assert.equal(second.savedBytes, 0);
    assert.equal(summary.dedupHits, 0);
    assert.equal(summary.savedBytes, 0);
    assert.equal(summary.servedBytes, summary.observedBytes);
  });

  it('serves full content again when the digest changes', async () => {
    const policy = await enabledPolicy();
    const first = body('v1');
    const changed = body('v2');
    await writeProjectFile('src/session.ts', first);

    await recordRead({ filePath: 'src/session.ts', content: first, rootDir, policy, sessionId: 's1' });
    const result = await recordRead({ filePath: 'src/session.ts', content: changed, rootDir, policy, sessionId: 's1' });

    assert.equal(result.decision, 'changed');
    assert.equal(result.content, changed);
    assert.equal(result.previousDigest, hashContent(first));

    const { ledger } = await loadLedger({ rootDir, sessionId: 's1' });
    assert.equal(ledger.entries['src/session.ts'].revisions, 2);
  });

  it('repairs persisted token estimates after a non-deduplicated read', async () => {
    const policy = await enabledPolicy();
    const first = body('estimate-v1');
    const changed = body('estimate-v2');
    await writeProjectFile('src/session.ts', first);

    await recordRead({ filePath: 'src/session.ts', content: first, rootDir, policy, sessionId: 'estimate' });
    await recordRead({ filePath: 'src/session.ts', content: first, rootDir, policy, sessionId: 'estimate' });

    const ledgerPath = resolveLedgerPath('estimate', { rootDir, policy });
    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8'));
    assert.ok(persisted.totals.savedBytes > 0);
    persisted.totals.estimatedSavedTokens = 0;
    await writeFile(ledgerPath, JSON.stringify(persisted), 'utf8');

    await recordRead({ filePath: 'src/session.ts', content: changed, rootDir, policy, sessionId: 'estimate' });
    const { ledger } = await loadLedger({ rootDir, policy, sessionId: 'estimate' });
    assert.equal(ledger.totals.estimatedSavedTokens, Math.ceil(ledger.totals.savedBytes / 4));
  });

  it('never deduplicates protected artifacts', async () => {
    const policy = await enabledPolicy();
    const content = body('spec');

    const first = await recordRead({ filePath: 'openspec/specs/auth/spec.md', content, rootDir, policy, sessionId: 's1' });
    const second = await recordRead({ filePath: 'openspec/specs/auth/spec.md', content, rootDir, policy, sessionId: 's1' });

    assert.equal(first.decision, 'protected');
    assert.equal(second.decision, 'protected');
    assert.equal(second.content, content);
  });

  it('canonicalizes aliases before protected matching and ledger keying', async () => {
    const policy = await enabledPolicy();
    const content = body('spec-alias');
    await writeProjectFile('openspec/specs/auth/spec.md', content);

    for (const alias of [
      './openspec/specs/auth/spec.md',
      'docs/../openspec/specs/auth/spec.md',
      'OPENSPEC/SPECS/AUTH/SPEC.MD'
    ]) {
      const result = await recordRead({ filePath: alias, content, rootDir, policy, sessionId: 'aliases' });
      assert.equal(result.decision, 'protected', alias);
    }
  });

  it('rejects symlink escapes and treats in-root symlink aliases as their canonical target', async (t) => {
    const policy = await enabledPolicy();
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-context-outside-'));
    const outsideFile = path.join(outsideDir, 'outside.md');
    await writeFile(outsideFile, body('outside'), 'utf8');
    await writeProjectFile('openspec/specs/auth/spec.md', body('linked-spec'));

    try {
      try {
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        await symlink(outsideDir, path.join(rootDir, 'outside-link'), linkType);
        await symlink(
          path.join(rootDir, 'openspec', 'specs'),
          path.join(rootDir, 'spec-link'),
          linkType
        );
      } catch (error) {
        if (error?.code === 'EPERM') {
          t.skip('Windows symlink creation is unavailable without Developer Mode.');
          return;
        }
        throw error;
      }

      await assert.rejects(
        recordRead({ filePath: 'outside-link/outside.md', rootDir, policy, sessionId: 'links' }),
        /must stay inside the project root/
      );
      await assert.rejects(
        recordRead({
          filePath: 'outside-link/missing.md',
          content: body('missing-outside'),
          rootDir,
          policy,
          sessionId: 'links'
        }),
        /must stay inside the project root/
      );
      const linked = await recordRead({ filePath: 'spec-link/auth/spec.md', rootDir, policy, sessionId: 'links' });
      assert.equal(linked.decision, 'protected');
      assert.equal(linked.path, 'openspec/specs/auth/spec.md');
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects a dedup state directory symlinked outside the project before writing', async () => {
    const policy = await enabledPolicy();
    const outsideState = await mkdtemp(path.join(os.tmpdir(), 'aifhub-context-state-outside-'));
    const statePath = path.join(rootDir, '.ai-factory', 'state');

    try {
      await symlink(outsideState, statePath, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        recordRead({ filePath: 'src/session.ts', content: body('state-escape'), rootDir, policy, sessionId: 'state' }),
        /must stay inside the project root/
      );
      assert.deepEqual(await readdir(outsideState), []);
    } finally {
      await rm(outsideState, { recursive: true, force: true });
    }
  });

  it('never writes or purges through a lock-directory symlink outside the project', async (t) => {
    const policy = await enabledPolicy();
    const outsideLocks = await mkdtemp(path.join(os.tmpdir(), 'aifhub-context-locks-outside-'));
    const stateRoot = path.join(rootDir, '.ai-factory', 'state');
    const lockPath = path.join(stateRoot, '.context-dedup-locks');

    try {
      await mkdir(stateRoot, { recursive: true });
      try {
        await symlink(outsideLocks, lockPath, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (error?.code === 'EPERM') {
          t.skip('Windows symlink creation is unavailable without Developer Mode.');
          return;
        }
        throw error;
      }

      const result = await recordRead({
        filePath: 'src/session.ts',
        content: body('lock-escape'),
        rootDir,
        policy,
        sessionId: 'lock-escape'
      });
      assert.equal(result.decision, 'full');
      assert.ok(result.warnings.some((warning) => warning.code === 'context-dedup-ledger-unwritable'));
      await assert.rejects(
        purgeSession({ rootDir, policy, all: true }),
        /must stay inside the project root/
      );
      assert.deepEqual(await readdir(outsideLocks), []);
    } finally {
      await rm(outsideLocks, { recursive: true, force: true });
    }
  });

  it('skips content below the minBytes threshold', async () => {
    const policy = await enabledPolicy();
    const content = 'tiny';

    const result = await recordRead({ filePath: 'src/tiny.ts', content, rootDir, policy, sessionId: 's1' });

    assert.equal(result.decision, 'below-threshold');
    assert.equal(result.content, content);
  });

  it('serves full content when the service is disabled', async () => {
    const content = body('disabled');
    const policy = await readContextDedupPolicy({ rootDir });

    const first = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });
    const second = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });

    assert.equal(first.decision, 'disabled');
    assert.equal(second.decision, 'disabled');
    assert.equal(second.content, content);
  });

  it('forces a full read when force is requested', async () => {
    const policy = await enabledPolicy();
    const content = body('forced');

    await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });
    const forced = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1', force: true });

    assert.equal(forced.decision, 'changed');
    assert.equal(forced.content, content);
  });

  it('keeps sessions isolated', async () => {
    const policy = await enabledPolicy();
    const content = body('isolated');

    await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });
    const other = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's2' });

    assert.equal(other.decision, 'full');
  });

  it('reads content from disk when it is not provided', async () => {
    const policy = await enabledPolicy();
    const content = body('from-disk');
    await writeProjectFile('src/session.ts', content);

    const result = await recordRead({ filePath: 'src/session.ts', rootDir, policy, sessionId: 's1' });

    assert.equal(result.decision, 'full');
    assert.equal(result.content, content);
  });

  it('uses stateless SQZ compression plus the AIFHub session ledger for exact repeats', async () => {
    const policy = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    mode: sqz
    minBytes: 64
`);
    const content = body('sqz');
    const inputBytes = Buffer.byteLength(content, 'utf8');
    const calls = [];
    const output = 'compact sqz payload\n';
    const sqzRunner = async (options) => {
      calls.push(options);
      return { ok: true, stdout: output };
    };
    await writeProjectFile('src/session.ts', content);

    const first = await recordRead({
      filePath: 'src/session.ts',
      content,
      rootDir,
      policy,
      sessionId: 'sqz-session',
      sqzRunner
    });
    const second = await recordRead({
      filePath: 'src/session.ts',
      content,
      rootDir,
      policy,
      sessionId: 'sqz-session',
      sqzRunner
    });
    const summary = await summarizeSession({ rootDir, policy, sessionId: 'sqz-session' });

    assert.equal(first.decision, 'compressed');
    assert.equal(first.content, output);
    assert.equal(second.decision, 'deduplicated');
    assert.equal(second.providerOutcome, 'reference');
    assert.equal(second.content, null);
    assert.match(second.replay.text, /self-contained compressed payload/);
    assert.doesNotMatch(second.replay.text, /was already provided in this session/);
    assert.equal(summary.mode, 'sqz');
    assert.equal(summary.reads, 2);
    assert.equal(summary.dedupHits, 1);
    assert.equal(summary.observedBytes, inputBytes * 2);
    assert.equal(summary.observedBytes, summary.servedBytes + summary.savedBytes);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'sqz');
    assert.match(calls[0].homeDir, /context-dedup.+sqz$/);
  });

  it('decodes SQZ stdout when a UTF-8 character crosses chunk boundaries', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    const expected = 'compact кириллица payload\n';
    const encoded = Buffer.from(expected, 'utf8');
    const splitAt = encoded.indexOf(Buffer.from('и', 'utf8')) + 1;

    const resultPromise = runSqzCompression({
      content: body('utf8'),
      cwd: rootDir,
      spawnFn: () => {
        queueMicrotask(() => {
          child.stdout.write(encoded.subarray(0, splitAt));
          child.stdout.end(encoded.subarray(splitAt));
          child.emit('close', 0);
        });
        return child;
      }
    });

    const result = await resultPromise;
    assert.equal(result.ok, true);
    assert.equal(result.stdout, expected);
    assert.doesNotMatch(result.stdout, /\uFFFD/);
  });

  it('does not hold the project gate while SQZ runs in another session', async () => {
    const policy = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    mode: sqz
    minBytes: 64
`);
    let notifyFirstStarted;
    let releaseFirst;
    const firstStarted = new Promise((resolve) => {
      notifyFirstStarted = resolve;
    });
    const firstBarrier = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const firstPromise = recordRead({
      filePath: 'src/first.ts',
      content: body('first-session'),
      rootDir,
      policy,
      sessionId: 'first-session',
      sqzRunner: async () => {
        notifyFirstStarted();
        await firstBarrier;
        return { ok: true, stdout: 'first compact\n' };
      }
    });
    await firstStarted;

    const secondPromise = recordRead({
      filePath: 'src/second.ts',
      content: body('second-session'),
      rootDir,
      policy,
      sessionId: 'second-session',
      sqzRunner: async () => ({ ok: true, stdout: 'second compact\n' })
    });
    let timeout;
    try {
      const second = await Promise.race([
        secondPromise,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('cross-session SQZ read was blocked by the project gate')), 1000);
        })
      ]);
      assert.equal(second.decision, 'compressed');
    } finally {
      clearTimeout(timeout);
      releaseFirst();
      await Promise.allSettled([firstPromise, secondPromise]);
    }
  });

  it('passes only an allowlisted isolated environment to an injected SQZ runner', async () => {
    const policy = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    mode: sqz
    minBytes: 64
`);
    const content = body('sqz-env');
    let runnerEnv;

    await recordRead({
      filePath: 'src/session.ts',
      content,
      rootDir,
      policy,
      sessionId: 'sqz-env-session',
      env: {
        Path: 'C:\\safe-bin',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\safe-temp',
        LANG: 'en_US.UTF-8',
        AWS_ACCESS_KEY_ID: 'must-not-reach-sqz',
        OPENAI_KEY: 'must-not-reach-sqz',
        DATABASE_URL: 'postgres://must-not-reach-sqz',
        CUSTOM_PRIVATE_VALUE: 'must-not-reach-sqz'
      },
      sqzRunner: async (options) => {
        runnerEnv = options.env;
        return { ok: true, stdout: 'compact\n' };
      }
    });

    assert.equal(runnerEnv.Path, 'C:\\safe-bin');
    assert.equal(runnerEnv.SystemRoot, 'C:\\Windows');
    assert.equal(runnerEnv.TEMP, 'C:\\safe-temp');
    assert.equal(runnerEnv.LANG, 'en_US.UTF-8');
    assert.equal(runnerEnv.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(runnerEnv.OPENAI_KEY, undefined);
    assert.equal(runnerEnv.DATABASE_URL, undefined);
    assert.equal(runnerEnv.CUSTOM_PRIVATE_VALUE, undefined);
    assert.match(runnerEnv.HOME, /context-dedup.+sqz$/);
    assert.equal(runnerEnv.USERPROFILE, runnerEnv.HOME);
    assert.equal(runnerEnv.SQZ_HOME, runnerEnv.HOME);
    assert.equal(runnerEnv.XDG_CACHE_HOME, path.join(runnerEnv.HOME, 'cache'));
  });

  it('fails open if SQZ returns a state-dependent reference or delta', async () => {
    const policy = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    mode: sqz
    minBytes: 64
`);
    const content = body('sqz-stateful');
    for (const [index, stdout] of ['§ref:12345678§\n', '§delta:12345678§\npatch'].entries()) {
      const result = await recordRead({
        filePath: 'src/session.ts',
        content,
        rootDir,
        policy,
        sessionId: `sqz-stateful-${index}`,
        sqzRunner: async () => ({ ok: true, stdout })
      });

      assert.equal(result.decision, 'full');
      assert.equal(result.content, content);
      assert.ok(result.warnings.some((warning) => warning.code === 'context-dedup-sqz-stateful-output'));
    }
  });

  it('fails open when SQZ is unavailable and never exposes provider stderr', async () => {
    const policy = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    mode: sqz
    minBytes: 64
`);
    const content = body('sqz-failure');
    await writeProjectFile('src/session.ts', content);

    const result = await recordRead({
      filePath: 'src/session.ts',
      content,
      rootDir,
      policy,
      sessionId: 'sqz-failure',
      sqzRunner: async () => ({
        ok: false,
        code: 'spawn-error',
        stderr: 'OPENAI_API_KEY=must-not-leak C:\\private\\sqz.exe'
      })
    });

    assert.equal(result.decision, 'full');
    assert.equal(result.content, content);
    assert.equal(result.savedBytes, 0);
    assert.ok(result.warnings.some((warning) => warning.code === 'context-dedup-sqz-unavailable'));
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak|C:\\\\private/);
  });

  it('bypasses SQZ for protected, forced and non-beneficial reads', async () => {
    const policy = resolveContextDedupPolicy(`aifhub:
  contextDedup:
    mode: sqz
    minBytes: 64
`);
    const content = body('sqz-bypass');
    let calls = 0;
    const sqzRunner = async () => {
      calls += 1;
      return { ok: true, stdout: `${content}larger` };
    };

    const protectedRead = await recordRead({
      filePath: 'openspec/specs/auth/spec.md',
      content,
      rootDir,
      policy,
      sessionId: 'sqz-bypass',
      sqzRunner
    });
    const forcedRead = await recordRead({
      filePath: 'src/session.ts',
      content,
      rootDir,
      policy,
      sessionId: 'sqz-forced',
      force: true,
      sqzRunner
    });
    const unprofitable = await recordRead({
      filePath: 'src/session.ts',
      content,
      rootDir,
      policy,
      sessionId: 'sqz-bypass',
      sqzRunner
    });

    assert.equal(protectedRead.decision, 'protected');
    assert.equal(forcedRead.decision, 'full');
    assert.equal(unprofitable.decision, 'full');
    assert.equal(unprofitable.content, content);
    assert.equal(unprofitable.savedBytes, 0);
    assert.equal(calls, 1);
  });

  it('evicts the oldest entries beyond maxEntries', async () => {
    const policy = { ...(await enabledPolicy()), maxEntries: 2 };

    for (const name of ['a', 'b', 'c']) {
      await recordRead({ filePath: `src/${name}.ts`, content: body(name), rootDir, policy, sessionId: 's1' });
    }

    const { ledger } = await loadLedger({ rootDir, sessionId: 's1' });
    assert.deepEqual(Object.keys(ledger.entries).sort(), ['src/b.ts', 'src/c.ts']);
  });

  it('uses the path as a deterministic tie-breaker for equally old entries', async () => {
    const policy = { ...(await enabledPolicy()), maxEntries: 2 };
    const ledger = createLedger('s1');
    const tiedAt = '2026-01-01T00:00:00.000Z';

    for (const name of ['z', 'a']) {
      const content = body(name);
      ledger.entries[`src/${name}.ts`] = {
        digest: hashContent(content),
        bytes: Buffer.byteLength(content, 'utf8'),
        firstSeenAt: tiedAt,
        lastSeenAt: tiedAt,
        readCount: 1,
        revisions: 1
      };
    }
    await saveLedger(ledger, { rootDir, policy });

    await recordRead({ filePath: 'src/c.ts', content: body('c'), rootDir, policy, sessionId: 's1' });

    const { ledger: reloaded } = await loadLedger({ rootDir, policy, sessionId: 's1' });
    assert.deepEqual(Object.keys(reloaded.entries).sort(), ['src/c.ts', 'src/z.ts']);
  });

  it('rejects paths that escape the project root', async () => {
    const policy = await enabledPolicy();

    for (const filePath of ['../outside.txt', '../../etc/passwd', path.join(os.tmpdir(), 'outside.txt')]) {
      await assert.rejects(
        recordRead({ filePath, content: body('escape'), rootDir, policy, sessionId: 's1' }),
        /must stay inside the project root/
      );
    }
  });

  it('keeps serving content when maxEntries leaves no room for the current read', async () => {
    const policy = { ...(await enabledPolicy()), maxEntries: 0 };
    const content = body('no-room');

    const result = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });

    assert.equal(result.decision, 'full');
    assert.equal(result.content, content);

    const repeated = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });
    assert.equal(repeated.decision, 'full');
    const { ledger } = await loadLedger({ rootDir, policy, sessionId: 's1' });
    assert.deepEqual(Object.keys(ledger.entries), []);
  });

  it('resets an unreadable ledger with a warning instead of throwing', async () => {
    const policy = await enabledPolicy();
    const ledgerPath = resolveLedgerPath('s1', { rootDir });
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, 'not json', 'utf8');

    const result = await recordRead({ filePath: 'src/session.ts', content: body('reset'), rootDir, policy, sessionId: 's1' });

    assert.equal(result.decision, 'full');
    assert.equal(result.warnings[0].code, 'context-dedup-ledger-unreadable');
  });

  it('resets an incompatible ledger with null totals instead of crashing', async () => {
    const policy = await enabledPolicy();
    const ledgerPath = resolveLedgerPath('s1', { rootDir, policy });
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(
      ledgerPath,
      JSON.stringify({ schemaVersion: CONTEXT_DEDUP_SCHEMA_VERSION, sessionId: 's1', entries: {}, totals: null }),
      'utf8'
    );

    const result = await recordRead({ filePath: 'src/session.ts', content: body('reset-null'), rootDir, policy, sessionId: 's1' });
    assert.equal(result.decision, 'full');
    assert.ok(result.warnings.some((warning) => warning.code === 'context-dedup-ledger-unreadable'));
  });
});

describe('session summary and purge', () => {
  it('summarizes saved bytes and estimated tokens', async () => {
    const policy = await enabledPolicy();
    const content = body('summary');

    await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });
    const repeated = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });

    const summary = await summarizeSession({ rootDir, sessionId: 's1' });
    const bytes = Buffer.byteLength(content, 'utf8');
    const replayBytes = Buffer.byteLength(repeated.replay.text, 'utf8');
    const savedBytes = bytes - replayBytes;

    assert.equal(summary.reads, 2);
    assert.equal(summary.dedupHits, 1);
    assert.equal(summary.observedBytes, bytes * 2);
    assert.equal(summary.servedBytes, bytes + replayBytes);
    assert.equal(summary.savedBytes, savedBytes);
    assert.equal(summary.estimatedSavedTokens, Math.ceil(savedBytes / 4));
    assert.equal(summary.savedPercent, Number(((savedBytes / (bytes * 2)) * 100).toFixed(2)));
  });

  it('uses total input bytes for saved percent after changed revisions', async () => {
    const policy = await enabledPolicy();
    const first = body('summary-v1');
    const changed = body('summary-v2');

    await recordRead({ filePath: 'src/session.ts', content: first, rootDir, policy, sessionId: 's1' });
    const repeated = await recordRead({ filePath: 'src/session.ts', content: first, rootDir, policy, sessionId: 's1' });
    await recordRead({ filePath: 'src/session.ts', content: changed, rootDir, policy, sessionId: 's1' });

    const summary = await summarizeSession({ rootDir, policy, sessionId: 's1' });
    const totalInputBytes = Buffer.byteLength(first, 'utf8') * 2 + Buffer.byteLength(changed, 'utf8');
    const savedBytes = Buffer.byteLength(first, 'utf8') - Buffer.byteLength(repeated.replay.text, 'utf8');
    assert.equal(summary.savedPercent, Number(((savedBytes / totalInputBytes) * 100).toFixed(2)));
  });

  it('emits content-free opt-in fix metrics for profitable and rejected replays', async () => {
    const policy = await enabledPolicy();
    const logs = [];
    const logger = (message) => logs.push(message);
    const large = body('private-content-marker');
    const tiny = 'tiny';

    await recordRead({
      filePath: 'src/large.ts',
      content: large,
      rootDir,
      policy,
      sessionId: 'debug',
      logFix: true,
      logger
    });
    await recordRead({
      filePath: 'src/large.ts',
      content: large,
      rootDir,
      policy,
      sessionId: 'debug',
      logFix: true,
      logger
    });
    const zeroThresholdPolicy = { ...policy, minBytes: 0 };
    await recordRead({
      filePath: 'src/tiny.ts',
      content: tiny,
      rootDir,
      policy: zeroThresholdPolicy,
      sessionId: 'debug',
      logFix: true,
      logger
    });
    await recordRead({
      filePath: 'src/tiny.ts',
      content: tiny,
      rootDir,
      policy: zeroThresholdPolicy,
      sessionId: 'debug',
      logFix: true,
      logger
    });

    const profitable = logs.find((line) => line.includes('read-deduplicated'));
    const rejected = logs.find((line) => line.includes('replay-not-beneficial'));
    assert.match(profitable, /"inputBytes":\d+,"outputBytes":\d+,"savedBytes":\d+/);
    assert.match(rejected, /"candidateReplayBytes":\d+,"savedBytes":0/);
    assert.doesNotMatch(logs.join('\n'), /private-content-marker/);
  });

  it('purges one session and every session', async () => {
    const policy = await enabledPolicy();
    await recordRead({ filePath: 'src/session.ts', content: body('purge'), rootDir, policy, sessionId: 's1' });
    await recordRead({ filePath: 'src/session.ts', content: body('purge'), rootDir, policy, sessionId: 's2' });

    await purgeSession({ rootDir, sessionId: 's1' });
    await assert.rejects(stat(path.dirname(resolveLedgerPath('s1', { rootDir }))));
    await stat(path.dirname(resolveLedgerPath('s2', { rootDir })));

    await purgeSession({ rootDir, all: true });
    await assert.rejects(stat(path.join(rootDir, '.ai-factory', 'state', 'context-dedup')));
  });

  it('waits for an in-flight ledger transaction before purging the session', async () => {
    const policy = await enabledPolicy();
    let releaseSave;
    let notifySaveStarted;
    const saveStarted = new Promise((resolve) => {
      notifySaveStarted = resolve;
    });
    const saveBarrier = new Promise((resolve) => {
      releaseSave = resolve;
    });
    const saveLedgerFn = async (ledger, options) => {
      notifySaveStarted();
      await saveBarrier;
      return saveLedger(ledger, options);
    };

    const readPromise = recordRead({
      filePath: 'src/session.ts',
      content: body('purge-race'),
      rootDir,
      policy,
      sessionId: 'race',
      saveLedgerFn
    });
    await saveStarted;

    let purgeSettled = false;
    const purgePromise = purgeSession({ rootDir, policy, sessionId: 'race' }).then((result) => {
      purgeSettled = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(purgeSettled, false);

    releaseSave();
    await readPromise;
    await purgePromise;
    await assert.rejects(stat(resolveLedgerPath('race', { rootDir, policy })));
  });

  it('waits for in-flight session locks before purging all dedup state', async () => {
    const policy = await enabledPolicy();
    let releaseSave;
    let notifySaveStarted;
    const saveStarted = new Promise((resolve) => {
      notifySaveStarted = resolve;
    });
    const saveBarrier = new Promise((resolve) => {
      releaseSave = resolve;
    });
    const readPromise = recordRead({
      filePath: 'src/session.ts',
      content: body('purge-all-race'),
      rootDir,
      policy,
      sessionId: 'race-all',
      saveLedgerFn: async (ledger, options) => {
        notifySaveStarted();
        await saveBarrier;
        return saveLedger(ledger, options);
      }
    });
    await saveStarted;

    let purgeSettled = false;
    const purgePromise = purgeSession({ rootDir, policy, all: true }).then((result) => {
      purgeSettled = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(purgeSettled, false);

    releaseSave();
    await readPromise;
    await purgePromise;
    await assert.rejects(stat(path.join(rootDir, '.ai-factory', 'state', 'context-dedup')));
  });

  it('keeps traversal session ids inside the dedup state directory', async () => {
    const policy = await enabledPolicy();
    const stateDir = path.join(rootDir, '.ai-factory', 'state');
    await writeProjectFile(path.join('.ai-factory', 'state', 'current.yaml'), 'change: demo\n');

    for (const sessionId of ['..', '.', '../../escape']) {
      const result = await recordRead({ filePath: 'src/session.ts', content: body('traversal'), rootDir, policy, sessionId });
      assert.equal(result.decision, 'full');

      await purgeSession({ rootDir, sessionId });
      await stat(path.join(stateDir, 'current.yaml'));
    }

    await assert.rejects(stat(path.join(stateDir, 'ledger.json')));
  });

  it('keeps unsafe session ids collision-resistant and uses a process-local fallback', async () => {
    await writeProjectFile(path.join('.ai-factory', 'state', 'current.yaml'), 'change: persistent-change\n');

    const slash = resolveLedgerPath('team/a', { rootDir });
    const dash = resolveLedgerPath('team-a', { rootDir });
    const dots = resolveLedgerPath('..', { rootDir });
    const empty = resolveLedgerPath('', { rootDir });
    assert.notEqual(slash, dash);
    assert.notEqual(dots, empty);

    const first = await resolveSessionId({ rootDir, env: {} });
    const second = await resolveSessionId({ rootDir, env: {} });
    assert.equal(first, second);
    assert.match(first, /^process-/);
    assert.notEqual(first, 'persistent-change');
    assert.notEqual(first, 'default');
  });

  it('serves full content when the ledger persistence seam fails on every platform', async () => {
    const policy = await enabledPolicy();
    const content = body('unwritable');
    const saveLedgerFn = async () => {
      throw new Error('synthetic persistence failure');
    };
    const result = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 'ro', saveLedgerFn });

    assert.equal(result.decision, 'full');
    assert.equal(result.content, content);
    assert.ok(result.warnings.some((warning) => warning.code === 'context-dedup-ledger-unwritable'));
  });

  it('serializes concurrent updates without losing read totals', async () => {
    const policy = await enabledPolicy();
    const content = body('concurrent');
    const concurrentReads = 200;

    const results = await Promise.all(
      Array.from({ length: concurrentReads }, () =>
        recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 'parallel' }))
    );
    const summary = await summarizeSession({ rootDir, policy, sessionId: 'parallel' });

    assert.deepEqual({
      reads: summary.reads,
      dedupHits: summary.dedupHits,
      fullReads: results.filter((result) => result.decision === 'full').length,
      deduplicatedReads: results.filter((result) => result.decision === 'deduplicated').length,
      unwritableWarnings: results.filter((result) =>
        result.warnings.some((warning) => warning.code === 'context-dedup-ledger-unwritable')).length
    }, {
      reads: concurrentReads,
      dedupHits: concurrentReads - 1,
      fullReads: 1,
      deduplicatedReads: concurrentReads - 1,
      unwritableWarnings: 0
    });
  });

  it('writes a schema-versioned ledger', async () => {
    const policy = await enabledPolicy();
    await recordRead({ filePath: 'src/session.ts', content: body('ledger'), rootDir, policy, sessionId: 's1' });

    const ledger = JSON.parse(await readFile(resolveLedgerPath('s1', { rootDir }), 'utf8'));

    assert.equal(ledger.schemaVersion, CONTEXT_DEDUP_SCHEMA_VERSION);
    assert.equal(ledger.sessionId, 's1');
    assert.equal(ledger.entries['src/session.ts'].readCount, 1);
  });
});

describe('cli', () => {
  it('returns replay text on a repeated check and json summaries on demand', async () => {
    await enabledPolicy();
    const content = body('cli');
    await writeProjectFile('src/session.ts', content);
    const baseArgs = ['--root', rootDir, '--session', 'cli'];

    const first = collect();
    assert.equal(await main(['check', '--file', 'src/session.ts', ...baseArgs, '--json'], { stdout: first, stderr: collect() }), 0);
    assert.equal(JSON.parse(first.text()).decision, 'full');

    const second = collect();
    assert.equal(await main(['check', '--file', 'src/session.ts', ...baseArgs], { stdout: second, stderr: collect() }), 0);
    assert.match(second.text(), /already provided in this session/);

    const status = collect();
    assert.equal(await main(['status', ...baseArgs, '--json'], { stdout: status, stderr: collect() }), 0);
    assert.equal(JSON.parse(status.text()).dedupHits, 1);

    const purge = collect();
    assert.equal(await main(['purge', ...baseArgs, '--json'], { stdout: purge, stderr: collect() }), 0);
    assert.equal(JSON.parse(purge.text()).sessionId, 'cli');
  });

  it('fails with usage guidance when check has no file', async () => {
    const stderr = collect();
    assert.equal(await main(['check', '--root', rootDir], { stdout: collect(), stderr }), 1);
    assert.match(stderr.text(), /--file/);
  });
});
