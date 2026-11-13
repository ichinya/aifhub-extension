// requirement-lint.test.mjs - opt-in advisory requirement semantic lint (#281).
// The linter always runs inside disposable temp projects (mkdtemp + realpath);
// the checkout is never written to. Fake assessors are injected through the
// DI seam; disabled/no-call follows the mustNotRun pattern. No network, no
// SDK, no keys, no paid calls (AC5).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canonical, digest } from './workflow-state-store.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { prepareQaManifest } from './qa-manifest.mjs';
import { qaStore } from './qa-manifest-store.mjs';
import { observeQaSnapshot } from './qa-manifest-inputs.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import {
  CONTRACT_MODULE,
  FINDING_TYPES,
  LINT_NAMESPACE,
  REQUIREMENT_LINT_SCHEMA,
  STATE_ROOT,
  assembleObservation,
  bindingCanonicalObject,
  currentRequirementLintContext,
  loadRequirementLintProfile,
  parseRequirementLintArgs,
  parseRequirementLintConfigSubset,
  readRequirementDocument,
  readRequirementLintConfig,
  requirementLintPaths,
  resolveProseLanguage,
  runRequirementLintCommand,
  validateObservationBinding,
} from './requirement-lint.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeTemp(prefix) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function seedProject(root, { config, files = {} } = {}) {
  await mkdir(path.join(root, '.ai-factory'), { recursive: true });
  if (config !== undefined) {
    await writeFile(path.join(root, '.ai-factory', 'config.yaml'), config, 'utf8');
  }
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
}

async function runCli(root, args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'requirement-lint.mjs'), ...args],
      { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: typeof error?.code === 'number' ? error.code : (error?.status ?? 1),
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
    };
  }
}

async function treeFingerprint(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return digest(canonical(entries.map((entry) => `${entry.parentPath ?? entry.path}:${entry.name}:${entry.isDirectory() ? 'd' : 'f'}`).sort()));
}

const MUST_NOT_RUN = () => { throw new Error('must not execute'); };

const EN_REQ = [
  '# Requirements',
  '',
  '- The system MUST save the user profile when the user clicks Save.',
  '- The system MUST process the incoming webhook payload.',
  '- Obviously the retry count defaults to three.',
  '- The parser MUST handle v2 format instead of v1 format; previously stated v1-only was required.',
].join('\n');

const CLEAN_EN = [
  '# Requirements',
  '',
  '- The system MUST display a confirmation screen before returning control.',
  '- The system MUST save the draft when the editor loses focus, and MUST report an error when the save fails.',
].join('\n');

describe('requirement-lint arguments and config parsing', () => {
  it('parses explicit-only arguments and rejects unknown, duplicate, or malformed forms', () => {
    const good = parseRequirementLintArgs(['--change', 'work', '--enabled', 'true', '--file', 'a.md', '--file', 'b.md', '--json', '--write']);
    assert.equal(good.ok, true);
    assert.equal(good.changeId, 'work');
    assert.equal(good.enabled, true);
    assert.deepEqual(good.files, ['a.md', 'b.md']);
    assert.equal(good.json, true);
    assert.equal(good.write, true);
    for (const [argv, reason] of [
      [['--wat'], 'unknown option'],
      [['--change', 'a', '--change', 'b'], 'duplicate option'],
      [['--change'], 'missing value'],
      [['--enabled', 'yes'], '--enabled expects'],
      [['--language', 'de'], 'unsupported --language'],
    ]) {
      const parsed = parseRequirementLintArgs(argv);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, new RegExp(reason.slice(0, 12)));
    }
  });

  it('parses the closed requirementLint config subset and detects malformed forms', () => {
    const plain = parseRequirementLintConfigSubset('aifhub:\n  requirementLint:\n    enabled: true\n');
    assert.equal(plain.value.aifhub.requirementLint.enabled, true);
    assert.deepEqual(plain.diagnostics, []);
    const quoted = parseRequirementLintConfigSubset('aifhub:\n  requirementLint:\n    enabled: "true"\n');
    assert.equal(quoted.value.aifhub.requirementLint.enabled, 'true');
    assert.ok(quoted.diagnostics.some((entry) => entry.code === 'requirement-lint:quoted-boolean'));
    for (const [raw, code] of [
      ['aifhub:\n  requirementLint:\n    enabled: true\n    enabled: false\n', 'requirement-lint:duplicate-key'],
      ['aifhub:\n  requirementLint:\n    <<: *base\n    enabled: true\n', 'requirement-lint:merge-key'],
      ['aifhub:\n  requirementLint:\n    &anchor enabled: true\n', null], // anchor inside value position
      ['aifhub:\n  requirementLint:\n    enabled: *ref\n', 'requirement-lint:alias'],
      ['aifhub:\n  requirementLint:\n    enabled: {a: b}\n', 'requirement-lint:flow-mapping'],
      ['aifhub:\n  requirementLint:\n    enabled: true\n    extra: 1\n', 'requirement-lint:unknown-key'],
    ]) {
      const parsed = parseRequirementLintConfigSubset(raw);
      if (code !== null) assert.ok(parsed.diagnostics.some((entry) => entry.code === code), raw);
      else assert.ok(parsed.diagnostics.length >= 0);
    }
    // Anchors in value position are detected as anchors; keys cannot carry
    // them in this subset grammar, so the key form stays an unknown/odd key.
    const anchoredKey = parseRequirementLintConfigSubset('aifhub:\n  requirementLint:\n    &anchor enabled: true\n');
    assert.ok(anchoredKey.diagnostics.length > 0);
    // Anomalies outside the lint namespace are other namespaces' concern.
    const outside = parseRequirementLintConfigSubset('aifhub:\n  contextDedup:\n    mode: *ref\npaths:\n  state: .state\n');
    assert.deepEqual(outside.diagnostics, []);
    assert.equal(outside.value.paths.state, '.state');
  });

  it('reads config with enabled, malformed, and state-root fields', async () => {
    const root = await makeTemp('aif-rl-cfg-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\npaths:\n  state: .state\n' });
    const config = await readRequirementLintConfig(root);
    assert.equal(config.enabled, true);
    assert.equal(config.stateRoot, '.state');
    assert.equal(config.stateRootRaw, '.state');
    assert.equal(config.enabledMalformed, false);
    const bad = await readRequirementLintConfig(await (async () => {
      const other = await makeTemp('aif-rl-cfg2-');
      await seedProject(other, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n    enabled: false\n' });
      return other;
    })());
    assert.equal(bad.enabledMalformed, true);
    assert.ok(bad.diagnostics.some((entry) => entry.code === 'requirement-lint:duplicate-key'));
    const absent = await readRequirementLintConfig(await makeTemp('aif-rl-cfg3-'));
    assert.equal(absent.enabled, null);
  });

  it('marks unreadable config and scalar nested sections as malformed opt-in state', async () => {
    // An oversized config cannot be read (readProviderFile refuses >256 KiB):
    // the reader must mark the namespace malformed so `--enabled true` cannot
    // run a scan (or a write) against silently-defaulted roots — a readable
    // config with `paths.state: .custom-state` would have been refused by the
    // writer (`state-root-mismatch`), so an unreadable one must not unlock it.
    const unreadable = await makeTemp('aif-rl-cfg4-');
    await seedProject(unreadable, {
      config: `paths:\n  state: .custom-state\n${'x'.repeat(300 * 1024)}\n`,
    });
    const broken = await readRequirementLintConfig(unreadable);
    assert.equal(broken.enabledMalformed, true);
    assert.ok(broken.diagnostics.some((entry) => entry.code === 'config-unreadable'));
    assert.equal(broken.stateRootRaw, undefined);
    // A scalar nested `aifhub.requirementLint` never reaches the parser's own
    // diagnostics (the parent mapping is intact), so the reader disables the
    // opt-in itself.
    const scalar = await makeTemp('aif-rl-cfg5-');
    await seedProject(scalar, { config: 'aifhub:\n  requirementLint: 5\n' });
    const damaged = await readRequirementLintConfig(scalar);
    assert.equal(damaged.enabledMalformed, true);
    assert.ok(damaged.diagnostics.some((entry) => entry.code === 'requirement-lint:scalarized-section'));
  });
});

describe('requirement-lint document reading and language', () => {
  it('computes deterministic UTF-8 byte spans including multibyte lines', async () => {
    const root = await makeTemp('aif-rl-doc-');
    const content = '# Требования\n\n- Система ДОЛЖНА сохранять профиль при нажатии «Сохранить».\n';
    await seedProject(root, { files: { 'docs/req.md': content } });
    const read = await readRequirementDocument(root, 'docs/req.md');
    assert.equal(read.ok, true);
    const raw = await readFile(path.join(root, 'docs', 'req.md'));
    assert.equal(read.sha256, digest(raw));
    const line = read.lines.find((entry) => entry.text.startsWith('- Система'));
    assert.equal(raw.subarray(line.start, line.end).toString('utf8'), line.text);
    assert.ok(line.end > line.start);
    const crlf = await makeTemp('aif-rl-doc2-');
    await seedProject(crlf, { files: { 'docs/crlf.md': '- The system MUST retry.\r\n- The system MUST log.\r\n' } });
    const crlfRead = await readRequirementDocument(crlf, 'docs/crlf.md');
    assert.deepEqual(crlfRead.lines.map((entry) => entry.text), ['- The system MUST retry.', '- The system MUST log.']);
  });

  it('splits CR-only documents so per-line suppression cannot cross requirements', async () => {
    // CR-only line endings: every requirement stays its own assessor line, so
    // a later requirement's error wording cannot suppress the missing-error
    // finding of an earlier one while coverage still reports `full`.
    const root = await makeTemp('aif-rl-doc4-');
    await seedProject(root, {
      files: {
        'docs/cr.md': '- The system MUST save the draft.\r- The system MUST report an error when saving fails.\r',
      },
    });
    const read = await readRequirementDocument(root, 'docs/cr.md');
    assert.equal(read.ok, true);
    assert.deepEqual(read.lines.map((entry) => entry.text), [
      '- The system MUST save the draft.',
      '- The system MUST report an error when saving fails.',
    ]);
    const raw = await readFile(path.join(root, 'docs', 'cr.md'));
    for (const line of read.lines) {
      assert.equal(raw.subarray(line.start, line.end).toString('utf8'), line.text);
    }
  });

  it('fails closed on missing files and fatal UTF-8', async () => {
    const root = await makeTemp('aif-rl-doc3-');
    await seedProject(root, { files: { 'docs/bad.md': Buffer.from([0xff, 0xfe, 0x62, 0x61, 0x64]) } });
    const missing = await readRequirementDocument(root, 'docs/none.md');
    assert.equal(missing.ok, false);
    assert.equal(missing.kind, 'missing');
    const bad = await readRequirementDocument(root, 'docs/bad.md');
    assert.equal(bad.ok, false);
    assert.equal(bad.kind, 'malformed');
    assert.equal(bad.code, 'utf8-fatal');
  });

  it('resolves prose language from override or detected content', () => {
    assert.deepEqual(resolveProseLanguage([{ text: 'Требование должно завершаться.' }], null), { language: 'ru', source: 'detected' });
    assert.deepEqual(resolveProseLanguage([{ text: 'The system must finish.' }], null), { language: 'en', source: 'detected' });
    assert.deepEqual(resolveProseLanguage([], 'ru'), { language: 'ru', source: 'override' });
  });
});

describe('requirement-lint command honesty surfaces', () => {
  it('does nothing and reports not_run when disabled, without invoking the assessor', async () => {
    const root = await makeTemp('aif-rl-off-');
    await seedProject(root, { files: { 'docs/req.md': EN_REQ } });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: root, assessor: MUST_NOT_RUN, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const envelope = JSON.parse(outputs.join(''));
    assert.equal(envelope.state, 'not_run');
    assert.equal(envelope.message, 'advisory scan was not performed');
    assert.ok(envelope.codes.includes('requirement-lint-disabled'));
    const later = await runRequirementLintCommand(['--change', 'work', '--enabled', 'false', '--file', 'docs/req.md', '--json'], {
      rootDir: root, assessor: MUST_NOT_RUN, output: () => {},
    });
    assert.equal(later, 0);
    await assert.rejects(readdir(path.join(root, '.ai-factory', 'state', 'work')), { code: 'ENOENT' });
  });

  it('treats a malformed lint namespace as disabled with bounded diagnostics, not a gate failure', async () => {
    const root = await makeTemp('aif-rl-mal-');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\n    enabled: false\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: root, assessor: MUST_NOT_RUN, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const envelope = JSON.parse(outputs.join(''));
    assert.equal(envelope.state, 'not_run');
    assert.ok(envelope.codes.includes('requirement-lint:duplicate-key'));
  });

  it('rejects invalid usage with exit code 2', async () => {
    const root = await makeTemp('aif-rl-usage-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n' });
    for (const argv of [['--file', 'docs/req.md'], ['--change', 'work'], ['--change', '../escape', '--file', 'docs/req.md'], ['--change', 'work', '--file', '.ai-factory/config.yaml'.replace('config.yaml', '../secrets.md')]]) {
      const outputs = [];
      const exit = await runRequirementLintCommand([...argv, '--json'], { rootDir: root, assessor: MUST_NOT_RUN, output: (value) => outputs.push(value) });
      assert.equal(exit, 2, argv.join(' '));
      const envelope = JSON.parse(outputs.join(''));
      assert.equal(envelope.state, 'not_run');
    }
  });

  it('runs the offline rules assessor and reports typed findings with exact spans', async () => {
    const root = await makeTemp('aif-rl-run-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': EN_REQ } });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const observation = JSON.parse(outputs.join(''));
    assert.equal(observation.schema, REQUIREMENT_LINT_SCHEMA);
    assert.equal(observation.run_status, 'complete');
    assert.equal(observation.freshness, 'current');
    assert.equal(observation.abstained, false);
    assert.equal(observation.coverage.state, 'full');
    assert.equal(observation.language, 'en');
    assert.equal(observation.findings_summary.total, observation.findings.length);
    const types = observation.findings.map((finding) => finding.finding_type);
    assert.ok(types.includes('undefined_observable_outcome'), types.join(','));
    assert.ok(types.includes('owner_decision_assumed'), types.join(','));
    assert.ok(types.includes('suspected_requirement_revision_conflict'), types.join(','));
    for (const finding of observation.findings) {
      assert.ok(FINDING_TYPES.includes(finding.finding_type));
      assert.match(finding.dedup_key, /^[a-f0-9]{64}$/);
      assert.match(finding.rationale, /\S/);
      assert.match(finding.proposed_question, /\?\s*$/);
      for (const ref of finding.refs) {
        assert.equal(ref.kind, 'span');
        assert.match(ref.document_sha256, /^sha256:[a-f0-9]{64}$/);
        assert.match(ref.span_sha256, /^sha256:[a-f0-9]{64}$/);
        const raw = await readFile(path.join(root, ref.path));
        assert.equal(digest(raw), ref.document_sha256.slice('sha256:'.length));
        assert.equal(digest(raw.subarray(ref.span.start, ref.span.end)), ref.span_sha256.slice('sha256:'.length));
        assert.ok(raw.subarray(ref.span.start, ref.span.end).toString('utf8').length > 0);
      }
    }
    const conflict = observation.findings.find((finding) => finding.finding_type === 'suspected_requirement_revision_conflict');
    assert.equal(conflict.refs.length, 2);
    assert.equal(conflict.ref_relation, 'conflicting_revision_pair');
    assert.notEqual(conflict.refs[0].span.start, conflict.refs[1].span.start);
    const schema = parseStrictJson(await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8'));
    assert.deepEqual(validateJsonAgainstSchema(observation, schema), []);
  });

  it('reports none only over completed scans of the presented scope', async () => {
    const root = await makeTemp('aif-rl-none-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/clean.md': CLEAN_EN } });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/clean.md', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const observation = JSON.parse(outputs.join(''));
    assert.equal(observation.run_status, 'complete');
    assert.equal(observation.findings_summary.total, 0);
    assert.equal(observation.coverage.state, 'full');
    assert.equal(observation.outcome_reason, null);
  });

  it('keeps missing sources as coverage outcomes, never as findings or none', async () => {
    const root = await makeTemp('aif-rl-part-');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\n',
      files: { 'docs/clean.md': CLEAN_EN },
    });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/clean.md', '--file', 'docs/absent.md', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const observation = JSON.parse(outputs.join(''));
    assert.equal(observation.coverage.state, 'partial');
    assert.deepEqual(observation.coverage.missing_sources, [{ path: 'docs/absent.md', reason: 'file-missing' }]);
    assert.ok(observation.diagnostics.some((entry) => entry.code === 'file-missing'));
  });

  it('keeps abstain, assessor failure, and deadline outcomes finding-free and honest', async () => {
    const seededRoot = await makeTemp('aif-rl-out-');
    await seedProject(seededRoot, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const collect = [];
    const abstainExit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: seededRoot, output: (value) => collect.push(['abstain', value]),
      assessor: async () => ({ abstain: true, reason: 'declined' }),
    });
    assert.equal(abstainExit, 0);
    const abstain = JSON.parse(collect.find(([tag]) => tag === 'abstain')[1]);
    assert.equal(abstain.run_status, 'complete');
    assert.equal(abstain.abstained, true);
    assert.deepEqual(abstain.findings, []);
    assert.equal(abstain.coverage.state, 'none');
    assert.equal(abstain.outcome_reason, 'assessor-abstain');

    const failed = [];
    const failedExit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: seededRoot, output: (value) => failed.push(value),
      assessor: async () => { throw new Error('provider down'); },
    });
    assert.equal(failedExit, 0);
    const failure = JSON.parse(failed.join(''));
    assert.equal(failure.run_status, 'failed');
    assert.deepEqual(failure.findings, []);
    assert.equal(failure.outcome_reason, 'assessor-error');
    assert.equal(failure.coverage.state, 'full', 'coverage stays honest even when the scan failed');
  });

  it('marks the observation stale when a requirement changes during the scan', async () => {
    const root = await makeTemp('aif-rl-stale-');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
      assessor: async (_input, context) => {
        await writeFile(path.join(root, 'docs', 'req.md'), `${EN_REQ}\n- The system MUST retry the webhook twice.\n`);
        return { findings: [], diagnostics: [] };
      },
    });
    assert.equal(exit, 0);
    const observation = JSON.parse(outputs.join(''));
    assert.equal(observation.freshness, 'stale');
    assert.ok(observation.diagnostics.some((entry) => entry.code === 'assessment-stale'));
  });
});

describe('requirement-lint observation writer guards', () => {
  it('writes atomically inside the lint namespace with a namespace gitignore', async () => {
    const root = await makeTemp('aif-rl-write-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': EN_REQ } });
    const outputs = [];
    const argv = ['--change', 'work', '--file', 'docs/req.md', '--write', '--json'];
    assert.equal(await runRequirementLintCommand(argv, { rootDir: root, output: (value) => outputs.push(value) }), 0);
    const namespaceDir = path.join(root, STATE_ROOT, 'work', LINT_NAMESPACE);
    const written = parseStrictJson(await readFile(path.join(namespaceDir, 'observation.json'), 'utf8'));
    assert.equal(written.schema, REQUIREMENT_LINT_SCHEMA);
    assert.equal(await readFile(path.join(namespaceDir, '.gitignore'), 'utf8'), '*\n!.gitignore\n');
    // Same-change overwrite is allowed; the previous leaf is schema-valid.
    assert.equal(await runRequirementLintCommand(argv, { rootDir: root, output: () => {} }), 0);
  });

  it('refuses a custom paths.state root and leaves the tree untouched', async () => {
    const root = await makeTemp('aif-rl-state-');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\npaths:\n  state: .state\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const before = await treeFingerprint(root);
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--write', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 1);
    const envelope = JSON.parse(outputs.join(''));
    assert.equal(envelope.state, 'observation-not-saved');
    assert.ok(envelope.codes.includes('state-root-mismatch'));
    assert.equal(await treeFingerprint(root), before, 'failed write leaves the project untouched');
  });

  it('refuses QA namespace conflicts, file shadows, and foreign leaves', async () => {
    const qaRoot = await makeTemp('aif-rl-qa-');
    await seedProject(qaRoot, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\npaths:\n  qa: .ai-factory/state\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const qaOutputs = [];
    assert.equal(await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--write', '--json'], {
      rootDir: qaRoot, output: (value) => qaOutputs.push(value),
    }), 1);
    assert.ok(JSON.parse(qaOutputs.join('')).codes.includes('qa-namespace-conflict'));

    const shadowRoot = await makeTemp('aif-rl-shadow-');
    await seedProject(shadowRoot, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': EN_REQ } });
    await mkdir(path.join(shadowRoot, STATE_ROOT), { recursive: true });
    await writeFile(path.join(shadowRoot, STATE_ROOT, 'work'), 'control file\n');
    const shadowOutputs = [];
    assert.equal(await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--write'], {
      rootDir: shadowRoot, output: (value) => shadowOutputs.push(value),
    }), 1);
    assert.ok(shadowOutputs.join('').includes('file-shadow'));

    const leafRoot = await makeTemp('aif-rl-leaf-');
    await seedProject(leafRoot, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': EN_REQ } });
    const leafDir = path.join(leafRoot, STATE_ROOT, 'work', LINT_NAMESPACE);
    await mkdir(leafDir, { recursive: true });
    await writeFile(path.join(leafDir, 'observation.json'), '{"schema":"aifhub.unrelated.v1"}\n');
    const leafOutputs = [];
    assert.equal(await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--write'], {
      rootDir: leafRoot, output: (value) => leafOutputs.push(value),
    }), 1);
    assert.ok(leafOutputs.join('').includes('observation-leaf-conflict'));
  });
});

describe('requirement-lint binding revalidation (AC2)', () => {
  async function writtenObservation(prefix, files) {
    const root = await makeTemp(prefix);
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files });
    const outputs = [];
    await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--write', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    const observation = parseStrictJson(await readFile(path.join(root, STATE_ROOT, 'work', LINT_NAMESPACE, 'observation.json'), 'utf8'));
    return { root, observation };
  }

  async function previewObservation(prefix, files) {
    const root = await makeTemp(prefix);
    await seedProject(root, { files });
    const outputs = [];
    assert.equal(await runRequirementLintCommand(['--change', 'work', '--enabled', 'true', '--file', 'docs/req.md', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    }), 0);
    return { root, observation: parseStrictJson(outputs.join('')) };
  }

  it('accepts a fresh observation as current', async () => {
    const { root, observation } = await writtenObservation('aif-rl-fresh-', { 'docs/req.md': EN_REQ });
    const verdict = await validateObservationBinding(root, observation);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.stale, false);
    assert.deepEqual(verdict.mismatched, []);
  });

  it('revalidates honest span digests over raw UTF-8 bytes with CRLF and CR endings', async () => {
    for (const ending of ['\r\n', '\r']) {
      const bytes = Buffer.from(`# Кириллица${ending}${EN_REQ.replaceAll('\n', ending)}`, 'utf8');
      const { root, observation } = await previewObservation('aif-rl-span-endings-', { 'docs/req.md': bytes });
      const refs = observation.findings.flatMap((finding) => finding.refs).filter((ref) => ref.kind === 'span');
      assert.ok(refs.length > 0, 'fixture must exercise span revalidation');
      for (const ref of refs) {
        assert.equal(ref.span_sha256, `sha256:${digest(bytes.subarray(ref.span.start, ref.span.end))}`);
      }
      assert.deepEqual(await validateObservationBinding(root, observation), { ok: true, stale: false, mismatched: [], state: null });
    }
  });

  it('marks an edited span digest stale while the document digest stays unchanged', async () => {
    const { root, observation } = await previewObservation('aif-rl-span-tamper-', { 'docs/req.md': EN_REQ });
    const finding = observation.findings.find((entry) => entry.refs.some((ref) => ref.kind === 'span'));
    assert.ok(finding, 'fixture must carry a span ref');
    const ref = finding.refs.find((entry) => entry.kind === 'span');
    const documentDigest = ref.document_sha256;
    ref.span_sha256 = `sha256:${'0'.repeat(64)}`;
    // Preserve internal dedup consistency to isolate fresh-byte revalidation.
    finding.dedup_key = digest({ finding_type: finding.finding_type, refs: finding.refs });
    const verdict = await validateObservationBinding(root, observation);
    assert.equal(ref.document_sha256, documentDigest);
    assert.equal(verdict.ok, true, 'span drift is stale, not observation-invalid');
    assert.equal(verdict.stale, true);
    assert.equal(verdict.state, 'stale-observation');
    assert.deepEqual(verdict.mismatched, ['findings']);
  });

  it('rejects scanned counts above declared counts in every coverage state', async () => {
    const { root, observation } = await previewObservation('aif-rl-counts-', { 'docs/req.md': EN_REQ });
    for (const state of ['full', 'partial', 'none']) {
      const tampered = structuredClone(observation);
      tampered.coverage.state = state;
      tampered.coverage.scanned_sources = tampered.coverage.declared_sources + 1;
      assert.deepEqual(await validateObservationBinding(root, tampered), { ok: false, code: 'observation-invalid' }, state);
    }
  });

  it('rejects partial coverage without scanned sources and accepts honest degraded scans', async () => {
    const { root, observation } = await previewObservation('aif-rl-partial-counts-', { 'docs/req.md': EN_REQ });
    for (const declared of [0, observation.coverage.declared_sources]) {
      const tampered = structuredClone(observation);
      tampered.coverage = { state: 'partial', declared_sources: declared, scanned_sources: 0, missing_sources: [] };
      assert.deepEqual(await validateObservationBinding(root, tampered), { ok: false, code: 'observation-invalid' });
    }
    // Truncation may degrade coverage even when all declared files were read.
    const truncated = structuredClone(observation);
    truncated.coverage.state = 'partial';
    truncated.diagnostics.push({ code: 'findings-truncated', path: 'docs/req.md', detail: 'bounded scan' });
    assert.equal((await validateObservationBinding(root, truncated)).stale, false);

    const outputs = [];
    assert.equal(await runRequirementLintCommand(['--change', 'partial', '--enabled', 'true', '--file', 'docs/req.md', '--file', 'docs/absent.md', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    }), 0);
    const partial = parseStrictJson(outputs.join(''));
    assert.equal(partial.coverage.state, 'partial');
    assert.deepEqual(await validateObservationBinding(root, partial), { ok: true, stale: false, mismatched: [], state: null });
  });

  it('invalidates the observation when a requirement is edited, renamed, or the profile changes', async () => {
    const edited = await writtenObservation('aif-rl-edit-', { 'docs/req.md': EN_REQ });
    await writeFile(path.join(edited.root, 'docs', 'req.md'), `${EN_REQ}\n- The system MUST retry the webhook twice.\n`);
    const editedVerdict = await validateObservationBinding(edited.root, edited.observation);
    assert.equal(editedVerdict.stale, true);
    assert.ok(editedVerdict.mismatched.includes('inputs:docs/req.md'));
    assert.ok(editedVerdict.mismatched.includes('binding'));

    const profileDrift = await writtenObservation('aif-rl-prof-', { 'docs/req.md': EN_REQ });
    const originalProfile = (await readFile(path.join(REPO_ROOT, 'scripts', 'requirement-lint.profile.json'))).toString('utf8');
    const profileOptions = {
      // A drifted rubric (different profile bytes -> different sha256) must
      // invalidate the recorded observation.
      readProfile: async () => Buffer.from(`${originalProfile}\n`, 'utf8'),
    };
    const driftedVerdict = await validateObservationBinding(profileDrift.root, profileDrift.observation, profileOptions);
    assert.equal(driftedVerdict.stale, true);
    assert.ok(driftedVerdict.mismatched.includes('profile') || driftedVerdict.mismatched.includes('binding'));

    const tampered = await writtenObservation('aif-rl-tamper-', { 'docs/req.md': EN_REQ });
    tampered.observation.binding = 'f'.repeat(64);
    const tamperedVerdict = await validateObservationBinding(tampered.root, tampered.observation);
    assert.equal(tamperedVerdict.stale, true);
    assert.ok(tamperedVerdict.mismatched.includes('binding'));
  });

  it('rejects observations that are not schema-valid lint records', async () => {
    const root = await makeTemp('aif-rl-inv-');
    const verdict = await validateObservationBinding(root, { schema: 'aifhub.other.v1' });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'observation-invalid');
  });
});

describe('requirement-lint observation shape and schema parity', () => {
  it('validates span, catalog, and conflict ref shapes against the closed schema', async () => {
    const schema = parseStrictJson(await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8'));
    const profile = await loadRequirementLintProfile();
    assert.equal(profile.ok, true);
    const context = {
      profile,
      profilePart: { sha256: profile.sha256, id: profile.profile.profile_id, version: profile.profile.profile_version, rules: {} },
      engine: { module: 'scripts/requirement-lint.mjs', sha256: 'a'.repeat(64), parser_version: 1 },
      contract: { name: REQUIREMENT_LINT_SCHEMA, sha256: 'b'.repeat(64) },
    };
    const outcome = {
      ok: true, run_status: 'complete', freshness: 'current', abstained: false,
      findings: [
        {
          finding_type: 'undefined_observable_outcome',
          rule: { id: 'requirement-lint:undefined_observable_outcome', version: 1, origin: 'project' },
          refs: [{ kind: 'span', path: 'docs/req.md', span: { start: 2, end: 60 }, document_sha256: `sha256:${'c'.repeat(64)}`, span_sha256: `sha256:${'d'.repeat(64)}` }],
          ref_relation: 'describes',
          rationale: 'Obligation without an observable completion criterion.',
          proposed_question: 'What observable signal marks this requirement satisfied: "quote"?'
            .slice(0, 300),
        },
        {
          finding_type: 'suspected_requirement_revision_conflict',
          rule: { id: 'requirement-lint:suspected_requirement_revision_conflict', version: 1, origin: 'project' },
          refs: [
            { kind: 'catalog', source_id: 'REQ-100' },
            { kind: 'catalog', source_id: 'REQ-100.rev2' },
          ],
          ref_relation: 'conflicting_revision_pair',
          rationale: 'One requirement carries two revision markers.',
          proposed_question: 'Which revision is current?',
        },
      ],
      diagnostics: [],
      coverage: { state: 'full', declared_sources: 1, scanned_sources: 1, missing_sources: [] },
    };
    const observation = assembleObservation({
      changeId: 'work',
      generatedAt: '2026-11-06T00:00:00.000Z',
      outcome,
      inputs: [{ path: 'docs/req.md', sha256: 'e'.repeat(64), bytes: 64, kind: 'file' }],
      context,
      language: 'en',
      languageSource: 'detected',
      worktreeIdentity: 'f'.repeat(64),
      binding: 'a'.repeat(64),
      diagnostics: [],
    });
    assert.deepEqual(validateJsonAgainstSchema(observation, schema), []);
    // A conflict finding with one ref must fail the oneOf discrimination.
    const broken = structuredClone(observation);
    const conflictIndex = broken.findings.findIndex((finding) => finding.finding_type === 'suspected_requirement_revision_conflict');
    assert.ok(conflictIndex >= 0);
    broken.findings[conflictIndex].refs = [broken.findings[conflictIndex].refs[0]];
    const errors = validateJsonAgainstSchema(broken, schema);
    assert.ok(errors.length > 0, JSON.stringify(errors));
    // Unknown properties fail closed.
    const extra = structuredClone(observation);
    extra.surprise = 1;
    assert.ok(validateJsonAgainstSchema(extra, schema).length > 0);
  });

  it('keeps binding inputs free of volatile fields and mirrors the canonical object', () => {
    const parts = bindingCanonicalObject({
      worktreeIdentity: 'a'.repeat(64),
      changeId: 'work',
      methodology: 'openspec',
      inputDigests: [{ path: 'docs/req.md', sha256: 'b'.repeat(64), bytes: 10, kind: 'file' }],
      profilePart: { sha256: 'c'.repeat(64), id: 'p', version: 1, rules: {} },
      engine: { module: 'm', sha256: 'd'.repeat(64), parser_version: 1 },
      helper: { module: 'h', sha256: 'e'.repeat(64) },
      contract: { name: REQUIREMENT_LINT_SCHEMA, sha256: 'f'.repeat(64) },
      languageOptions: { override: null, resolved: 'en', raw_quotes: 'preserve' },
      exclusionPolicy: { id: 'x', version: 1 },
    });
    assert.equal(Object.hasOwn(parts, 'timestamp'), false);
    assert.equal(requirementLintPaths('Work-1').directory, `${STATE_ROOT}/Work-1/${LINT_NAMESPACE}`);
    assert.throws(() => requirementLintPaths('../escape'));
  });
});

describe('AC3: requirement-lint QA namespace isolation', () => {
  async function seedGitProject(root) {
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await mkdir(path.join(root, '.ai-factory'), { recursive: true });
    await mkdir(path.join(root, 'openspec', 'changes', 'work'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n');
    await writeFile(path.join(root, 'docs', 'req.md'), EN_REQ);
    await writeFile(path.join(root, '.ai-factory', 'config.yaml'), 'aifhub:\n  requirementLint:\n    enabled: true\n');
    await writeFile(path.join(root, 'openspec', 'changes', 'work', 'proposal.md'), '# Proposal\n\n## Why\n\nQA isolation fixture.\n');
    await writeFile(path.join(root, 'openspec', 'changes', 'work', 'tasks.md'), '- [ ] 1.1 Task\n');
    const git = async (args) => execFileAsync('git', args, { cwd: root });
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.email', 'fixture@example.com']);
    await git(['config', 'user.name', 'fixture']);
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);
    // The state-level runtime gitignore is a pre-existing surface: create it
    // before enrollment so the first lint write cannot shift ignored_names.
    await ensureRuntimeGitignore(root, STATE_ROOT);
    const toolchain = [{ name: 'fixture-node', sha256: digest('node') }];
    const check = {
      id: 'check-verify', gate: 'verify', profile: 'declared.v1', dependencies_complete: true,
      inputs: ['docs'], command: { argv: ['fake'], cwd: '.' }, toolchain, env_inputs: [], requires_observed: false,
    };
    const options = {
      rootDir: root, changeId: 'work', scope: ['docs'], checks: [check], environment: {},
      providers: {
        requirements: async () => ({ gates: ['verify'], independent_roles: [], evidence: [] }),
        toolchain: async () => toolchain,
      },
    };
    assert.equal((await prepareQaManifest(options)).ok, true, 'qa enrollment needs a real git worktree');
    return options;
  }

  async function observe(options) {
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    const snapshot = await observeQaSnapshot(store, payload);
    return {
      files: Object.keys(snapshot.files).sort(),
      ignored_names: snapshot.ignored_names,
      changed_paths: snapshot.changed_paths,
      digest: snapshot.digest,
    };
  }

  it('keeps the QA fingerprint identical across lint write, overwrite, and deletion', async () => {
    const root = await makeTemp('aif-rl-qa3-');
    const options = await seedGitProject(root);
    const before = await observe(options);
    const argv = ['--change', 'work', '--file', 'docs/req.md', '--write', '--json'];
    assert.equal(await runRequirementLintCommand(argv, { rootDir: root, output: () => {} }), 0);
    const afterWrite = await observe(options);
    assert.deepEqual(afterWrite, before);
    assert.equal(await runRequirementLintCommand(argv, { rootDir: root, output: () => {} }), 0, 'overwrite of the same-change observation is allowed');
    const afterOverwrite = await observe(options);
    assert.deepEqual(afterOverwrite, before);
    await rm(path.join(root, STATE_ROOT, 'work', LINT_NAMESPACE, 'observation.json'));
    const afterDelete = await observe(options);
    assert.deepEqual(afterDelete, before);
    assert.ok(!before.files.some((p) => p.includes(LINT_NAMESPACE)), 'namespace never enters the projected file catalog');
    assert.ok(!before.ignored_names.some((p) => p.includes(LINT_NAMESPACE)), 'namespace never enters ignored_names');
    assert.ok(!before.changed_paths.some((p) => p.includes(LINT_NAMESPACE)), 'namespace never enters changed_paths');
  });
});

describe('requirement-lint corpus evaluation (fixtures + labels)', () => {
  const CORPUS_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'requirement-lint');

  async function corpusRun(file) {
    const content = await readFile(path.join(CORPUS_DIR, file));
    const project = await makeTemp('aif-rl-corpus-');
    await seedProject(project, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\n',
      files: { [`docs/${file}`]: content },
    });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', `docs/${file}`, '--json'], {
      rootDir: project, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0, file);
    return JSON.parse(outputs.join(''));
  }

  it('matches curated labels exactly on dev and held-out files', async () => {
    const labels = parseStrictJson(await readFile(path.join(CORPUS_DIR, 'labels.json'), 'utf8'));
    for (const [group, entries] of Object.entries(labels.groups)) {
      for (const [file, label] of Object.entries(entries)) {
        if (typeof label !== 'object' || label === null) continue;
        const observation = await corpusRun(file);
        assert.equal(observation.run_status, 'complete', `${group}/${file}`);
        assert.equal(observation.coverage.state, 'full', `${group}/${file}`);
        assert.deepEqual(observation.findings_summary.by_type, label.expected_by_type, `${group}/${file}`);
        // Line precision: a same-type finding on the wrong line is a false
        // positive the by_type counts cannot see.
        if (Array.isArray(label.expected_findings)) {
          const raw = await readFile(path.join(CORPUS_DIR, file));
          const observed = observation.findings.map((finding) => {
            const ref = finding.refs[0];
            let line = 1;
            for (let index = 0; index < ref.span.start; index += 1) {
              if (raw[index] === 0x0A) line += 1;
            }
            return [finding.finding_type, line];
          }).sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
          const expected = [...label.expected_findings].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
          assert.deepEqual(observed, expected, `${group}/${file} finding lines`);
        }
      }
    }
  });

  it('keeps machine tokens stable across languages and raw quotes untranslated', async () => {
    const ru = await corpusRun('dev-ru-owner-assumption.md');
    for (const finding of ru.findings) {
      assert.ok(FINDING_TYPES.includes(finding.finding_type));
      assert.equal(finding.rule.origin, 'project');
    }
    assert.equal(ru.language, 'ru');
    assert.ok(ru.findings.some((finding) => /лимит попыток|отчёт формируется/.test(finding.proposed_question)), 'raw RU quote must stay untranslated');
    const mixed = await corpusRun('dev-mixed-ru-en.md');
    assert.equal(mixed.language_source, 'detected');
    for (const finding of mixed.findings) assert.ok(FINDING_TYPES.includes(finding.finding_type));
  });

  it('treats hostile prompt injection as inert data: refs stay confined to the presented input', async () => {
    const observation = await corpusRun('dev-hostile-injection.md');
    assert.equal(observation.run_status, 'complete');
    for (const finding of observation.findings) {
      for (const ref of finding.refs) {
        assert.equal(ref.kind, 'span');
        assert.equal(ref.path, 'docs/dev-hostile-injection.md', 'findings may only reference the presented input');
      }
    }
    for (const diagnostic of observation.diagnostics) {
      assert.ok(!String(diagnostic.detail ?? '').includes('attacker.invalid'), 'diagnostics must not echo hostile payload content');
      assert.ok(!String(diagnostic.path ?? '').includes('attacker.invalid'));
    }
  });
});

describe('requirement-lint config reader compatibility', () => {
  it('keeps parseToolConfig behavior unchanged when the requirementLint namespace is present', async () => {
    const { parseToolConfig } = await import('./tool-config.mjs');
    const withLint = 'config_version: 1\naifhub:\n  tools:\n    openspec: true\n    hlv: false\n    lekalo: false\n  requirementLint:\n    enabled: false\n';
    const withoutLint = 'config_version: 1\naifhub:\n  tools:\n    openspec: true\n    hlv: false\n    lekalo: false\n';
    assert.deepEqual(parseToolConfig(withLint), parseToolConfig(withoutLint));
    // Pre-existing hub-level failure modes are neither softened nor extended.
    assert.throws(() => parseToolConfig('aifhub:\n  requirementLint:\n    enabled: true\naifhub:\n'), /duplicate_aifhub/);
    assert.throws(() => parseToolConfig('aifhub:\n\trequirementLint:\n\t\tenabled: true\n'), /unsupported_aifhub|unsupported_tool_config/);
  });

  it('keeps provider policy parsing unchanged with the new namespace', async () => {
    const { parseProviderConfig, normalizeProviderPolicies } = await import('./provider-policy.mjs');
    const base = 'aifhub:\n  providers:\n    hlv:\n      enable: true\n      policy: optional\n';
    const withLint = `${base}  requirementLint:\n    enabled: false\n`;
    assert.deepEqual(normalizeProviderPolicies(parseProviderConfig(withLint)), normalizeProviderPolicies(parseProviderConfig(base)));
  });

  it('registers the optional managed key and keeps the required-keys diff clean', async () => {
    const manifest = parseStrictJson(await readFile(path.join(REPO_ROOT, 'skills', 'aif-analyze', 'references', 'config-keys.json'), 'utf8'));
    const entry = manifest.keys.find((item) => item.key === 'aifhub.requirementLint.enabled');
    assert.ok(entry, 'config-keys must declare aifhub.requirementLint.enabled');
    assert.equal(entry.required, false, 'the lint opt-in must stay optional');
    assert.ok(!manifest.keys.some((item) => item.key.startsWith('aifhub.requirementLint.') && item.key !== 'aifhub.requirementLint.enabled'),
      'policy keys must not be exposed');

    const { buildAnalyzeConfigDiff } = await import('./aif-analyze-config-diff.mjs');
    const { renderConfigForMode } = await import('./aif-artifact-sync.mjs');
    const root = await makeTemp('aif-rl-diff-');
    const rendered = renderConfigForMode('', 'openspec', { analyzeSkillVersion: '0.11.0' });
    const lines = rendered.split('\n');
    const hubIndex = lines.findIndex((line) => /^aifhub:$/.test(line));
    assert.ok(hubIndex >= 0, 'fresh openspec config must contain the aifhub hub');
    let insertAt = lines.findIndex((line, index) => index > hubIndex && /^\S/.test(line));
    if (insertAt < 0) insertAt = lines.length;
    lines.splice(insertAt, 0, '  requirementLint:', '    enabled: false');
    await mkdir(path.join(root, '.ai-factory'), { recursive: true });
    await writeFile(path.join(root, '.ai-factory', 'config.yaml'), lines.join('\n'), 'utf8');
    const diff = await buildAnalyzeConfigDiff({ rootDir: root });
    assert.equal(diff.ok, true, JSON.stringify(diff.errors ?? []));
    assert.deepEqual(diff.errors ?? [], []);
    assert.equal((diff.missing ?? []).length, 0, 'optional lint key must never appear as a missing required key');
  });

  it('documents the never-auto-enable clause in the analyze skill', async () => {
    const skill = await readFile(path.join(REPO_ROOT, 'skills', 'aif-analyze', 'SKILL.md'), 'utf8');
    assert.ok(skill.includes('Preserve existing `aifhub.requirementLint.enabled` values and never enable the requirement ambiguity lint automatically.'));
    const template = await readFile(path.join(REPO_ROOT, 'skills', 'aif-analyze', 'references', 'config-template.yaml'), 'utf8');
    assert.ok(template.includes('# requirementLint:'));
    assert.ok(template.includes('#   enabled: false'));
  });
});

describe('review round: parser hardening', () => {
  it('flags duplicated aifhub/requirementLint blocks instead of silently winning last', () => {
    const duplicatedHub = parseRequirementLintConfigSubset('aifhub:\n  requirementLint:\n    enabled: false\naifhub:\n  requirementLint:\n    enabled: true\n');
    assert.ok(duplicatedHub.diagnostics.some((entry) => entry.code === 'requirement-lint:duplicate-key'), JSON.stringify(duplicatedHub.diagnostics));
    const duplicatedSubtree = parseRequirementLintConfigSubset('aifhub:\n  requirementLint:\n    enabled: true\n  requirementLint:\n    enabled: false\n');
    assert.ok(duplicatedSubtree.diagnostics.some((entry) => entry.code === 'requirement-lint:duplicate-key'));
  });

  it('keeps quoted comment forms quoted: enabled never flips through "true # x"', async () => {
    const parsed = parseRequirementLintConfigSubset('aifhub:\n  requirementLint:\n    enabled: "true # x"\n');
    assert.equal(parsed.value.aifhub.requirementLint.enabled, 'true # x');
    const root = await makeTemp('aif-rl-quoted-');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint:\n    enabled: "true # x"\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const config = await readRequirementLintConfig(root);
    assert.notEqual(config.enabled, true, 'a quoted comment form must never become a boolean opt-in');
    assert.equal(config.enabledMalformed, true);
    assert.ok(config.diagnostics.some((entry) => entry.code === 'requirement-lint:not-a-boolean'));
  });

  it('flags a scalar structural section that hides paths.state', () => {
    const parsed = parseRequirementLintConfigSubset('aifhub:\n  requirementLint:\n    enabled: true\npaths: 5\n');
    assert.equal(parsed.value.paths, 5);
    assert.deepEqual(parsed.diagnostics, [], 'a plain scalar parses; the reader diagnoses the section shape');
  });

  it('does not pollute Object.prototype through __proto__ keys', async () => {
    const root = await makeTemp('aif-rl-proto-');
    await seedProject(root, {
      config: '__proto__:\n  aifhub:\n    requirementLint:\n      enabled: true\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: root, assessor: MUST_NOT_RUN, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const envelope = JSON.parse(outputs.join(''));
    assert.equal(envelope.state, 'not_run');
    assert.ok(envelope.codes.includes('requirement-lint-disabled'));
  });

  it('degrades a flow-scalarized structural section instead of silently using defaults', async () => {
    const root = await makeTemp('aif-rl-flow-');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\npaths: {state: .state}\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: root, assessor: MUST_NOT_RUN, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const envelope = JSON.parse(outputs.join(''));
    assert.equal(envelope.state, 'not_run');
    assert.ok(
      envelope.codes.includes('requirement-lint:scalarized-section') || envelope.codes.includes('requirement-lint:flow-mapping'),
      envelope.codes.join(','),
    );
  });

  it('refuses a flow-scalar paths.state value on write instead of writing the default root', async () => {
    const root = await makeTemp('aif-rl-flowstate-');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\npaths:\n  state: [1,2]\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const before = await treeFingerprint(root);
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--write', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 1);
    assert.ok(JSON.parse(outputs.join('')).codes.includes('state-root-mismatch'));
    assert.equal(await treeFingerprint(root), before);
  });
});

describe('review round: profile honesty and caps', () => {
  it('does not run the scan when the pinned profile is missing or damaged', async () => {
    const root = await makeTemp('aif-rl-profmiss-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': EN_REQ } });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: root, assessor: MUST_NOT_RUN, readProfile: async () => { throw new Error('missing'); }, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const observation = JSON.parse(outputs.join(''));
    assert.equal(observation.run_status, 'not_run');
    assert.deepEqual(observation.findings, []);
    assert.ok(observation.diagnostics.some((entry) => entry.code === 'profile-unavailable'));
  });

  it('rejects a profile whose rules are empty, duplicated, or do not cover all four types', async () => {
    const base = JSON.parse(await readFile(path.join(REPO_ROOT, 'scripts', 'requirement-lint.profile.json'), 'utf8'));
    for (const [name, rules] of Object.entries({
      empty: [],
      duplicate: [base.rules[0], base.rules[0], base.rules[1], base.rules[2]],
      partial: base.rules.slice(0, 3),
    })) {
      const profile = { ...base, rules };
      const loaded = await loadRequirementLintProfile({ readProfile: async () => Buffer.from(JSON.stringify(profile), 'utf8') });
      assert.equal(loaded.ok, false, name);
      assert.ok(loaded.diagnostics.some((entry) => entry.detail === 'profile-invalid'), name);
    }
    const good = await loadRequirementLintProfile();
    assert.equal(good.ok, true);
    assert.equal(good.rules.size, 4);
  });

  async function cappedRun(lineCount, fileCount) {
    const root = await makeTemp('aif-rl-cap-');
    const files = {};
    for (let index = 0; index < fileCount; index += 1) {
      const lines = Array.from({ length: lineCount }, (unused, n) => `- The system MUST validate item ${index}-${n} before processing.`);
      files[`docs/req${index}.md`] = `# Requirements\n\n${lines.join('\n')}\n`;
    }
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files });
    const argv = ['--change', 'work', '--json'];
    for (const file of Object.keys(files)) argv.push('--file', file);
    const outputs = [];
    const exit = await runRequirementLintCommand(argv, { rootDir: root, output: (value) => outputs.push(value) });
    assert.equal(exit, 0);
    return JSON.parse(outputs.join(''));
  }

  it('keeps exactly-at-cap scans complete with full coverage', async () => {
    const observation = await cappedRun(200, 1);
    assert.equal(observation.findings_summary.total, 200);
    assert.equal(observation.coverage.state, 'full');
    assert.ok(!observation.diagnostics.some((entry) => entry.code === 'findings-truncated'));
  });

  it('marks an over-cap scan truncated and degrades coverage to partial', async () => {
    const perDocument = await cappedRun(201, 1);
    assert.equal(perDocument.findings_summary.total, 200);
    assert.equal(perDocument.coverage.state, 'partial', 'unprocessed tail must degrade coverage');
    assert.ok(perDocument.diagnostics.some((entry) => entry.code === 'findings-truncated' && entry.path === 'docs/req0.md'));

    const global = await cappedRun(170, 3);
    assert.equal(global.findings_summary.total, 500);
    assert.equal(global.coverage.state, 'partial');
    assert.ok(global.diagnostics.some((entry) => entry.code === 'findings-truncated'));
  });
});

describe('review round: binding-from-scanned-bytes and deterministic order', () => {
  it('binds findings to the bytes the assessor saw and goes stale when the source swaps mid-run', async () => {
    const root = await makeTemp('aif-rl-swap-');
    const contentA = '# Requirements\n\n- The system MUST process the incoming webhook payload.\n';
    const contentB = '# Requirements\n\n- The system MUST display a confirmation screen when the conversion completes.\n';
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': contentA } });
    const calls = [];
    const swapAfterFirstRead = {
      readInput: async () => {
        calls.push('read');
        if (calls.length === 1) return Buffer.from(contentA, 'utf8');
        // Every later read (freshness probe): content B — a mid-run swap.
        return Buffer.from(contentB, 'utf8');
      },
    };
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: root, ...swapAfterFirstRead, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const observation = JSON.parse(outputs.join(''));
    assert.equal(observation.freshness, 'stale', 'a swapped source must mark the outcome stale');
    assert.equal(digest(Buffer.from(contentA, 'utf8')), observation.inputs[0].sha256, 'binding inputs record the scanned bytes');
    assert.ok(observation.diagnostics.some((entry) => entry.code === 'assessment-stale'));
  });

  it('produces identical findings for the same input set regardless of CLI order', async () => {
    const seededRoot = await makeTemp('aif-rl-order-');
    await seedProject(seededRoot, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\n',
      files: {
        'docs/aaa.md': '# Requirements\n\n- The system MUST process the incoming webhook payload.\n',
        'docs/zzz.md': '# Requirements\n\n- The system MUST store the signed bundle on the artifact server and confirm completion with a visible status.\n',
      },
    });
    const run = async (order) => {
      const outputs = [];
      const argv = ['--change', 'work', '--json'];
      for (const file of order) argv.push('--file', file);
      await runRequirementLintCommand(argv, { rootDir: seededRoot, output: (value) => outputs.push(value) });
      return JSON.parse(outputs.join(''));
    };
    const forward = await run(['docs/aaa.md', 'docs/zzz.md']);
    const backward = await run(['docs/zzz.md', 'docs/aaa.md']);
    assert.deepEqual(forward.findings, backward.findings, 'document order must not change saved findings');
    assert.equal(forward.binding, backward.binding);
  });
});

describe('review round: writer guards', () => {
  async function seedGitProjectForGuard(root, { gitignore = true, runtimeGitignore = true } = {}) {
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await mkdir(path.join(root, '.ai-factory'), { recursive: true });
    await mkdir(path.join(root, 'openspec', 'changes', 'work'), { recursive: true });
    if (gitignore) await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n');
    await writeFile(path.join(root, 'docs', 'req.md'), EN_REQ);
    await writeFile(path.join(root, '.ai-factory', 'config.yaml'), 'aifhub:\n  requirementLint:\n    enabled: true\n');
    await writeFile(path.join(root, 'openspec', 'changes', 'work', 'proposal.md'), '# Proposal\n\n## Why\n\nGuard fixture.\n');
    await writeFile(path.join(root, 'openspec', 'changes', 'work', 'tasks.md'), '- [ ] 1.1 Task\n');
    const git = async (args) => execFileAsync('git', args, { cwd: root });
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.email', 'fixture@example.com']);
    await git(['config', 'user.name', 'fixture']);
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);
    if (runtimeGitignore) await ensureRuntimeGitignore(root, STATE_ROOT);
  }

  it('refuses to overwrite a tracked observation and leaves the tree untouched', async () => {
    const root = await makeTemp('aif-rl-tracked-');
    await seedGitProjectForGuard(root);
    const argv = ['--change', 'work', '--file', 'docs/req.md', '--write', '--json'];
    assert.equal(await runRequirementLintCommand(argv, { rootDir: root, output: () => {} }), 0);
    await execFileAsync('git', ['add', '-f', '.ai-factory/state/work/requirement-lint/observation.json'], { cwd: root });
    const before = await treeFingerprint(root);
    const outputs = [];
    const exit = await runRequirementLintCommand(argv, { rootDir: root, output: (value) => outputs.push(value) });
    assert.equal(exit, 1);
    const envelope = JSON.parse(outputs.join(''));
    assert.equal(envelope.state, 'observation-not-saved');
    assert.ok(envelope.codes.includes('observation-path-tracked'), envelope.codes.join(','));
    assert.equal(await treeFingerprint(root), before);
  });

  it('refuses an output that is not effectively ignored', async () => {
    const root = await makeTemp('aif-rl-unign-');
    await seedGitProjectForGuard(root, { gitignore: false, runtimeGitignore: false });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--write', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 1);
    assert.ok(JSON.parse(outputs.join('')).codes.includes('observation-path-not-ignored'));
  });

  it('refuses an output equal to a selected input', async () => {
    const root = await makeTemp('aif-rl-collide-');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\n',
      files: { '.ai-factory/state/work/requirement-lint/observation.json': '- The system MUST process the incoming webhook payload.\n' },
    });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', '.ai-factory/state/work/requirement-lint/observation.json', '--write', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 1);
    assert.ok(JSON.parse(outputs.join('')).codes.includes('observation-source-collision'));
  });

  it('refuses a schema-invalid same-change leaf', async () => {
    const root = await makeTemp('aif-rl-badleaf-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': EN_REQ } });
    const leafDir = path.join(root, STATE_ROOT, 'work', LINT_NAMESPACE);
    await mkdir(leafDir, { recursive: true });
    // Same schema and change id but a stripped required field: ownership
    // cannot be proven, so the overwrite must be refused.
    await writeFile(path.join(leafDir, 'observation.json'), '{"schema":"aifhub.requirement_lint_observation.v1","change_id":"work"}\n');
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--write'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 1);
    assert.ok(outputs.join('').includes('observation-leaf-conflict'));
  });

  it('rejects an oversized change id before any read or scan', async () => {
    const root = await makeTemp('aif-rl-longid-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': EN_REQ } });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'x'.repeat(201), '--file', 'docs/req.md', '--json'], {
      rootDir: root, assessor: MUST_NOT_RUN, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 2);
    assert.ok(JSON.parse(outputs.join('')).codes.includes('invalid-change-id'));
  });
});

describe('review round: read-time validation strictness', () => {
  it('rejects damaged findings, foreign refs, and out-of-range spans', async () => {
    const root = await makeTemp('aif-rl-val-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': EN_REQ } });
    const outputs = [];
    await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--write', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    const observationPath = path.join(root, STATE_ROOT, 'work', LINT_NAMESPACE, 'observation.json');
    const observation = parseStrictJson(await readFile(observationPath, 'utf8'));

    const stripped = { ...observation, findings: undefined };
    assert.equal((await validateObservationBinding(root, stripped)).ok, false);

    const foreignRef = structuredClone(observation);
    if (foreignRef.findings.length > 0 && foreignRef.findings[0].refs[0].kind === 'span') {
      foreignRef.findings[0].refs[0].path = 'docs/not-an-input.md';
      assert.equal((await validateObservationBinding(root, foreignRef)).ok, false);
    }

    const outOfRange = structuredClone(observation);
    if (outOfRange.findings.length > 0 && outOfRange.findings[0].refs[0].kind === 'span') {
      outOfRange.findings[0].refs[0].span = { start: 0, end: 10 * 1024 * 1024 };
      assert.equal((await validateObservationBinding(root, outOfRange)).ok, false);
    }

    const splitPair = structuredClone(observation);
    const conflictIndex = splitPair.findings.findIndex((finding) => finding.finding_type === 'suspected_requirement_revision_conflict');
    if (conflictIndex >= 0) {
      splitPair.findings[conflictIndex].refs[1].path = 'docs/other.md';
      assert.equal((await validateObservationBinding(root, splitPair)).ok, false, 'conflict pair must sit inside one document');
    }
  });

  it('rejects semantically tampered observations that stay schema-valid', async () => {
    const root = await makeTemp('aif-rl-sem-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': EN_REQ } });
    const outputs = [];
    await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--write', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    const observationPath = path.join(root, STATE_ROOT, 'work', LINT_NAMESPACE, 'observation.json');
    const observation = parseStrictJson(await readFile(observationPath, 'utf8'));
    assert.ok(observation.findings.length > 0, 'fixture needs findings');

    // A flipped dedup key must fail revalidation, not pass as fresh.
    const flippedKey = structuredClone(observation);
    flippedKey.findings[0].dedup_key = digest({ different: true });
    assert.equal((await validateObservationBinding(root, flippedKey)).ok, false, 'dedup_key');

    // A corrupted summary contradicts the findings array.
    const corruptedSummary = structuredClone(observation);
    corruptedSummary.findings_summary.total += 1;
    assert.equal((await validateObservationBinding(root, corruptedSummary)).ok, false, 'summary total');
    const corruptedByType = structuredClone(observation);
    corruptedByType.findings_summary.by_type[corruptedByType.findings[0].finding_type] += 1;
    assert.equal((await validateObservationBinding(root, corruptedByType)).ok, false, 'summary by_type');

    // A span ref claiming a foreign document digest is an internal
    // contradiction of the record.
    const foreignDigest = structuredClone(observation);
    foreignDigest.findings[0].refs[0].document_sha256 = `sha256:${'9'.repeat(64)}`;
    assert.equal((await validateObservationBinding(root, foreignDigest)).ok, false, 'document digest');

    // Honest outcome invariants: schema-valid but semantically impossible
    // records must be rejected.
    const failedWithFindings = structuredClone(observation);
    failedWithFindings.run_status = 'failed';
    assert.equal((await validateObservationBinding(root, failedWithFindings)).ok, false, 'failed + findings');
    const abstainedFull = structuredClone(observation);
    abstainedFull.abstained = true;
    abstainedFull.findings = [];
    abstainedFull.coverage.state = 'full';
    assert.equal((await validateObservationBinding(root, abstainedFull)).ok, false, 'abstained + full coverage');
    const truncatedFull = structuredClone(observation);
    truncatedFull.coverage.state = 'full';
    truncatedFull.diagnostics = [{ code: 'findings-truncated', path: 'docs/req.md', detail: 'x' }];
    assert.equal((await validateObservationBinding(root, truncatedFull)).ok, false, 'truncated + full coverage');
  });
});

describe('review round 2: writer containment and namespace gitignore guard', () => {
  async function seedGuardProject(root, { gitignore = true } = {}) {
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await mkdir(path.join(root, '.ai-factory'), { recursive: true });
    await mkdir(path.join(root, 'openspec', 'changes', 'work'), { recursive: true });
    if (gitignore) await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n');
    await writeFile(path.join(root, 'docs', 'req.md'), EN_REQ);
    await writeFile(path.join(root, '.ai-factory', 'config.yaml'), 'aifhub:\n  requirementLint:\n    enabled: true\n');
    await writeFile(path.join(root, 'openspec', 'changes', 'work', 'proposal.md'), '# Proposal\n\n## Why\n\nGuard fixture.\n');
    await writeFile(path.join(root, 'openspec', 'changes', 'work', 'tasks.md'), '- [ ] 1.1 Task\n');
    const git = async (args) => execFileAsync('git', args, { cwd: root });
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.email', 'fixture@example.com']);
    await git(['config', 'user.name', 'fixture']);
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);
    await ensureRuntimeGitignore(root, STATE_ROOT);
  }

  it('refuses to restore a tracked-then-deleted namespace gitignore', async () => {
    const root = await makeTemp('aif-rl-gitrack-');
    await seedGuardProject(root);
    const argv = ['--change', 'work', '--file', 'docs/req.md', '--write', '--json'];
    assert.equal(await runRequirementLintCommand(argv, { rootDir: root, output: () => {} }), 0);
    const namespaceDir = path.join(root, STATE_ROOT, 'work', LINT_NAMESPACE);
    // Track the namespace gitignore, then delete it from the worktree: the
    // next write must refuse BEFORE ensureRuntimeGitignore recreates it —
    // restoring tracked content would shift the unfiltered actual_diff.
    await execFileAsync('git', ['add', '-f', '.ai-factory/state/work/requirement-lint/.gitignore'], { cwd: root });
    await rm(path.join(namespaceDir, '.gitignore'));
    const before = await treeFingerprint(root);
    const outputs = [];
    const exit = await runRequirementLintCommand(argv, { rootDir: root, output: (value) => outputs.push(value) });
    assert.equal(exit, 1);
    const envelope = JSON.parse(outputs.join(''));
    assert.equal(envelope.state, 'observation-not-saved');
    assert.ok(envelope.codes.includes('observation-path-tracked'), envelope.codes.join(','));
    assert.match(String(envelope.detail), /\.gitignore$/);
    assert.equal(await treeFingerprint(root), before, 'refused write must not restore the tracked gitignore');
    assert.ok(!existsSync(path.join(namespaceDir, '.gitignore')), 'gitignore must stay absent after the refusal');
  });

  it('keeps the temp file contained and cleans up on a failed create', async () => {
    const root = await makeTemp('aif-rl-tmp-');
    await seedGuardProject(root);
    const namespaceDir = path.join(root, STATE_ROOT, 'work', LINT_NAMESPACE);
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--write', '--json'], {
      rootDir: root,
      openFile: async () => { throw new Error('open refused'); },
      output: (value) => outputs.push(value),
    });
    assert.equal(exit, 1);
    assert.ok(JSON.parse(outputs.join('')).codes.includes('observation-write-failed'));
    const entries = await readdir(namespaceDir);
    assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), [], 'failed create must not leave a partial temp file');
  });

  it('runs the controlled TOCTOU probe through the beforeRename seam', async () => {
    const root = await makeTemp('aif-rl-toctou-');
    await seedGuardProject(root);
    const argv = ['--change', 'work', '--file', 'docs/req.md', '--write', '--json'];
    assert.equal(await runRequirementLintCommand(argv, { rootDir: root, output: () => {} }), 0);
    // The seam fires after the temp write and the third ownership check but
    // before the rename: a foreign replacement must be refused, not renamed.
    const outputs = [];
    const exit = await runRequirementLintCommand(argv, {
      rootDir: root,
      beforeRename: async () => {
        const observationPath = path.join(root, STATE_ROOT, 'work', LINT_NAMESPACE, 'observation.json');
        await writeFile(observationPath, '{"schema":"aifhub.unrelated.v1"}\n');
      },
      output: (value) => outputs.push(value),
    });
    assert.equal(exit, 1);
    assert.ok(outputs.join('').includes('observation-leaf-conflict'));
    const namespaceDir = path.join(root, STATE_ROOT, 'work', LINT_NAMESPACE);
    const entries = await readdir(namespaceDir);
    assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), [], 'refusal must clean up the temp file');
    const content = await readFile(path.join(namespaceDir, 'observation.json'), 'utf8');
    assert.equal(JSON.parse(content).schema, 'aifhub.unrelated.v1', 'foreign leaf must survive a refused rename');
  });
});

describe('review round 2: honesty and config edges', () => {
  it('truncates at the exact overshoot when one line carries several findings', async () => {
    const root = await makeTemp('aif-rl-capline-');
    const vague = Array.from({ length: 199 }, (unused, n) => `- The system MUST validate item ${n} before processing.`);
    // One line, three findings: observable gap + success action + assumption.
    vague.push('- The system MUST sync the payload obviously without asking anyone.');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\n',
      files: { 'docs/req.md': `# Requirements\n\n${vague.join('\n')}\n` },
    });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const observation = JSON.parse(outputs.join(''));
    assert.equal(observation.findings_summary.total, 200, 'the cap must stop at the exact overshoot');
    assert.equal(observation.coverage.state, 'partial');
    assert.ok(observation.diagnostics.some((entry) => entry.code === 'findings-truncated'));
  });

  it('degrades to not_run for a JSON-null or scalar pinned profile', async () => {
    const root = await makeTemp('aif-rl-profnull-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': EN_REQ } });
    for (const payload of ['null', '5', '[]']) {
      const outputs = [];
      const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
        rootDir: root, assessor: MUST_NOT_RUN, readProfile: async () => Buffer.from(payload, 'utf8'), output: (value) => outputs.push(value),
      });
      assert.equal(exit, 0, payload);
      const observation = JSON.parse(outputs.join(''));
      assert.equal(observation.run_status, 'not_run', payload);
      assert.ok(observation.diagnostics.some((entry) => entry.code === 'profile-unavailable'), payload);
    }
  });

  it('keeps an unterminated quote from flipping the opt-in', async () => {
    const root = await makeTemp('aif-rl-unterm-');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint:\n    enabled: "true\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const config = await readRequirementLintConfig(root);
    assert.notEqual(config.enabled, true, 'an unterminated quote must never enable the lint');
    assert.equal(config.enabledMalformed, true);
    assert.ok(config.diagnostics.some((entry) => entry.code === 'requirement-lint:unterminated-quote'));
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: root, assessor: MUST_NOT_RUN, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    assert.ok(JSON.parse(outputs.join('')).codes.includes('requirement-lint:unterminated-quote'));
  });

  it('disables the lint when a structural section scalarizes, even with enabled true', async () => {
    const root = await makeTemp('aif-rl-scal5-');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint:\n    enabled: true\npaths: 5\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md', '--json'], {
      rootDir: root, assessor: MUST_NOT_RUN, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const envelope = JSON.parse(outputs.join(''));
    assert.equal(envelope.state, 'not_run');
    assert.ok(envelope.codes.includes('requirement-lint:scalarized-section'), envelope.codes.join(','));
  });

  it('does not scan or write when the config itself is unreadable, even with enabled true', async () => {
    // The CLI opt-in must not resurrect a config the reader could not verify:
    // with unreadable config the configured roots are unknown, so neither a
    // scan nor a write may proceed against silently-defaulted roots.
    const root = await makeTemp('aif-rl-cfg6-');
    await seedProject(root, {
      config: `paths:\n  state: .custom-state\n${'x'.repeat(300 * 1024)}\n`,
      files: { 'docs/req.md': EN_REQ },
    });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--enabled', 'true', '--write', '--file', 'docs/req.md', '--json'], {
      rootDir: root, assessor: MUST_NOT_RUN, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const envelope = JSON.parse(outputs.join(''));
    assert.equal(envelope.state, 'not_run');
    assert.ok(envelope.codes.includes('config-unreadable'), envelope.codes.join(','));
    await assert.rejects(readdir(path.join(root, '.ai-factory', 'state', 'work')), { code: 'ENOENT' });
  });

  it('does not scan when the nested requirementLint section scalarizes, even with enabled true', async () => {
    const root = await makeTemp('aif-rl-scal6-');
    await seedProject(root, {
      config: 'aifhub:\n  requirementLint: 5\n',
      files: { 'docs/req.md': EN_REQ },
    });
    const outputs = [];
    const exit = await runRequirementLintCommand(['--change', 'work', '--enabled', 'true', '--file', 'docs/req.md', '--json'], {
      rootDir: root, assessor: MUST_NOT_RUN, output: (value) => outputs.push(value),
    });
    assert.equal(exit, 0);
    const envelope = JSON.parse(outputs.join(''));
    assert.equal(envelope.state, 'not_run');
    assert.ok(envelope.codes.includes('requirement-lint:scalarized-section'), envelope.codes.join(','));
  });

  it('renders both refs of a conflicting pair in human output', async () => {
    const root = await makeTemp('aif-rl-human-');
    await seedProject(root, { config: 'aifhub:\n  requirementLint:\n    enabled: true\n', files: { 'docs/req.md': EN_REQ } });
    const outputs = [];
    await runRequirementLintCommand(['--change', 'work', '--file', 'docs/req.md'], {
      rootDir: root, output: (value) => outputs.push(value),
    });
    const text = outputs.join('');
    const conflict = text.split('\n').find((line) => line.includes('suspected_requirement_revision_conflict'));
    assert.ok(conflict, 'conflict finding rendered');
    assert.ok(conflict.includes(' <-> '), `both refs must render: ${conflict}`);
  });
});
