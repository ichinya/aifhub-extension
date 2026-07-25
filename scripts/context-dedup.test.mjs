// context-dedup.test.mjs - tests for the optional session read dedup service
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CONTEXT_DEDUP_SCHEMA_VERSION,
  defaultContextDedupPolicy,
  hashContent,
  isProtectedReadPath,
  loadLedger,
  main,
  purgeSession,
  recordRead,
  resolveContextDedupPolicy,
  resolveLedgerPath,
  readContextDedupPolicy,
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
    assert.equal(policy.minBytes, 128);
    assert.ok(policy.protectedPatterns.includes('docs/frozen/**'));
    assert.ok(policy.protectedPatterns.includes('**/coverage.json'));
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
    await writeProjectFile('src/session.ts', content);

    const first = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });
    assert.equal(first.decision, 'full');
    assert.equal(first.content, content);
    assert.equal(first.savedBytes, 0);

    const second = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });
    assert.equal(second.decision, 'deduplicated');
    assert.equal(second.content, null);
    assert.equal(second.readCount, 2);
    assert.equal(second.savedBytes, Buffer.byteLength(content, 'utf8'));
    assert.match(second.replay.text, /already provided in this session/);
    assert.match(second.replay.text, new RegExp(hashContent(content)));
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

  it('never deduplicates protected artifacts', async () => {
    const policy = await enabledPolicy();
    const content = body('spec');

    const first = await recordRead({ filePath: 'openspec/specs/auth/spec.md', content, rootDir, policy, sessionId: 's1' });
    const second = await recordRead({ filePath: 'openspec/specs/auth/spec.md', content, rootDir, policy, sessionId: 's1' });

    assert.equal(first.decision, 'protected');
    assert.equal(second.decision, 'protected');
    assert.equal(second.content, content);
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

  it('evicts the oldest entries beyond maxEntries', async () => {
    const policy = { ...(await enabledPolicy()), maxEntries: 2 };

    for (const name of ['a', 'b', 'c']) {
      await recordRead({ filePath: `src/${name}.ts`, content: body(name), rootDir, policy, sessionId: 's1' });
    }

    const { ledger } = await loadLedger({ rootDir, sessionId: 's1' });
    assert.deepEqual(Object.keys(ledger.entries).sort(), ['src/b.ts', 'src/c.ts']);
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
});

describe('session summary and purge', () => {
  it('summarizes saved bytes and estimated tokens', async () => {
    const policy = await enabledPolicy();
    const content = body('summary');

    await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });
    await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 's1' });

    const summary = await summarizeSession({ rootDir, sessionId: 's1' });
    const bytes = Buffer.byteLength(content, 'utf8');

    assert.equal(summary.reads, 2);
    assert.equal(summary.dedupHits, 1);
    assert.equal(summary.savedBytes, bytes);
    assert.equal(summary.estimatedSavedTokens, Math.ceil(bytes / 4));
    assert.equal(summary.savedPercent, 50);
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

  it('serves full content when the ledger cannot be persisted', async () => {
    const policy = await enabledPolicy();
    const content = body('unwritable');
    const stateDir = path.join(rootDir, '.ai-factory', 'state');
    await mkdir(stateDir, { recursive: true });
    await chmod(stateDir, 0o500);

    try {
      const result = await recordRead({ filePath: 'src/session.ts', content, rootDir, policy, sessionId: 'ro' });

      assert.equal(result.decision, 'full');
      assert.equal(result.content, content);
      assert.ok(result.warnings.some((warning) => warning.code === 'context-dedup-ledger-unwritable'));
    } finally {
      await chmod(stateDir, 0o700);
    }
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
