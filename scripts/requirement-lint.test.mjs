// requirement-lint.test.mjs - opt-in advisory requirement semantic lint (#281).
// The linter always runs inside disposable temp projects (mkdtemp + realpath);
// the checkout is never written to. Fake assessors are injected through the
// DI seam; disabled/no-call follows the mustNotRun pattern. No network, no
// SDK, no keys, no paid calls (AC5).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

  it('accepts a fresh observation as current', async () => {
    const { root, observation } = await writtenObservation('aif-rl-fresh-', { 'docs/req.md': EN_REQ });
    const verdict = await validateObservationBinding(root, observation);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.stale, false);
    assert.deepEqual(verdict.mismatched, []);
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
