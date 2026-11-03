// docs-readability.test.mjs - opt-in advisory readability diagnostics (#228).
// The helper always runs inside disposable temp projects (mkdtemp + realpath);
// checkout fixtures are only read as content templates and never written to.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canonical, digest } from './workflow-state-store.mjs';
import {
  READABILITY_SCHEMA,
  STALE_REPORT_STATE,
  buildByteOffsets,
  buildDocumentModel,
  loadProfile,
  parseConfigSubset,
  parseGlossaryEntries,
  parseReadabilityArgs,
  readReadabilityConfig,
  runDocsReadabilityCommand,
  validateReportBinding,
} from './docs-readability.mjs';
import { verifyReportIgnored } from './docs-readability-git-guard.mjs';
import { prepareQaManifest } from './qa-manifest.mjs';
import { qaStore } from './qa-manifest-store.mjs';
import { observeQaSnapshot } from './qa-manifest-inputs.mjs';
import { buildOpenSpecDoneReadiness } from './openspec-done-readiness.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'docs-readability');

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function makeTemp(prefix) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function fixtureBuffer(name) {
  return readFile(path.join(FIXTURE_DIR, name));
}

async function fixtureText(name) {
  return (await fixtureBuffer(name)).toString('utf8');
}

async function runCli(root, argv, options = {}) {
  const outputs = [];
  const exitCode = await runDocsReadabilityCommand(argv, {
    rootDir: root,
    output: (value) => outputs.push(value),
    ...options,
  });
  return { exitCode, stdout: outputs.join(''), json: () => parseStrictJson(outputs.join('')) };
}

// Minimal project: readability enabled, docs seeded with exact fixture bytes.
async function seedProject(root, { enabled = true, files = {}, config = null, glossary = null } = {}) {
  await mkdir(path.join(root, '.ai-factory'), { recursive: true });
  const configText = config ?? `aifhub:\n  readability:\n    enabled: ${enabled ? 'true' : 'false'}\n`;
  await writeFile(path.join(root, '.ai-factory', 'config.yaml'), configText);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  if (glossary !== null) await writeFile(path.join(root, 'CONTEXT.md'), glossary);
}

async function treeFingerprint(root) {
  const entries = [];
  async function walk(dir, relative) {
    const list = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRelative);
      else entries.push(`${childRelative}:${digest(await readFile(path.join(dir, entry.name)))}`);
    }
  }
  await walk(root, '');
  return entries.join('|');
}

const ruleIds = (report) => report.findings.map((finding) => finding.rule.id);

// ---------------------------------------------------------------------------

describe('readability argument parsing', () => {
  it('rejects unknown options, duplicates, and missing values', () => {
    assert.equal(parseReadabilityArgs(['--nope']).ok, false);
    assert.equal(parseReadabilityArgs(['--json', '--json']).ok, false);
    assert.equal(parseReadabilityArgs(['--change', 'a', '--change', 'b']).ok, false);
    assert.equal(parseReadabilityArgs(['--change']).ok, false);
    assert.equal(parseReadabilityArgs(['--change', '--json']).ok, false);
    assert.equal(parseReadabilityArgs(['--enabled', 'yes']).ok, false);
    assert.equal(parseReadabilityArgs(['--language', 'fr']).ok, false);
  });

  it('accepts explicit options and repeats only --file', () => {
    const parsed = parseReadabilityArgs([
      '--change', 'work', '--enabled', 'true', '--file', 'a.md', '--file', 'b.md',
      '--language', 'ru', '--json', '--write',
    ]);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.files, ['a.md', 'b.md']);
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.language, 'ru');
    assert.equal(parsed.json, true);
    assert.equal(parsed.write, true);
  });
});

describe('readability config subset parsing', () => {
  it('resolves nested readability and path keys', () => {
    const parsed = parseConfigSubset('aifhub:\n  readability:\n    enabled: true\npaths:\n  state: .ai-factory/state\n  context: GLOSSARY.md\n');
    assert.equal(parsed.aifhub.readability.enabled, true);
    assert.equal(parsed.paths.state, '.ai-factory/state');
    assert.equal(parsed.paths.context, 'GLOSSARY.md');
  });

  it('keeps malformed boolean values as non-boolean diagnostics input', () => {
    const parsed = parseConfigSubset('aifhub:\n  readability:\n    enabled: "yes"\n');
    assert.equal(parsed.aifhub.readability.enabled, 'yes');
  });
});

describe('AC1: opt-in default-off is a no-op', () => {
  it('refuses without --enabled and without the config key, reading nothing else and writing nothing', async () => {
    const root = await makeTemp('aif-read-off-');
    const doc = await fixtureBuffer('ru-findings.md');
    await seedProject(root, {
      enabled: false,
      config: 'language:\n  ui: ru\n',
      files: { 'docs/guide.md': doc },
    });
    const before = await treeFingerprint(root);
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 2);
    const envelope = run.json();
    assert.equal(envelope.schema_version, 1);
    assert.ok(envelope.codes.includes('readability-disabled'));
    assert.equal(await treeFingerprint(root), before, 'disabled run must not write');
  });

  it('proceeds when the config key enables the function', async () => {
    const root = await makeTemp('aif-read-cfg-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    assert.equal(run.json().state, 'complete');
  });

  it('honors precedence: explicit --enabled false wins over config true', async () => {
    const root = await makeTemp('aif-read-prec-');
    await seedProject(root, { enabled: true, files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') } });
    const run = await runCli(root, ['--change', 'work', '--enabled', 'false', '--file', 'docs/guide.md']);
    assert.equal(run.exitCode, 2);
    assert.ok(run.stdout.includes('readability-disabled'));
  });

  it('explicit --enabled true overrides config false', async () => {
    const root = await makeTemp('aif-read-over-');
    await seedProject(root, { enabled: false, files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') } });
    const run = await runCli(root, ['--change', 'work', '--enabled', 'true', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    assert.equal(run.json().state, 'complete');
  });

  it('reports malformed config values as diagnostics instead of truthiness', async () => {
    const root = await makeTemp('aif-read-mal-');
    await seedProject(root, {
      config: 'aifhub:\n  readability:\n    enabled: "yes"\n',
      files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') },
    });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md']);
    assert.equal(run.exitCode, 2);
    assert.ok(run.stdout.includes('config-malformed'));
  });
});

describe('AC2: source-bound findings', () => {
  it('finds RU degradations with byte spans and leaves sources untouched', async () => {
    const root = await makeTemp('aif-read-ru-');
    const bytes = await fixtureBuffer('ru-findings.md');
    await seedProject(root, { files: { 'docs/guide.md': bytes } });
    const sourceSha = digest(bytes);
    const before = await treeFingerprint(root);
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.schema, READABILITY_SCHEMA);
    assert.equal(report.diagnostic_only, true);
    assert.deepEqual(report.authorizes, []);
    assert.equal(report.state, 'complete');
    const ids = ruleIds(report);
    assert.ok(ids.includes('docs-readability:sentence-length'));
    assert.ok(ids.includes('docs-readability:ru-cliche'));
    assert.ok(ids.includes('docs-readability:unbalanced-pair'));
    const cliches = report.findings.filter((finding) => finding.rule.id === 'docs-readability:ru-cliche');
    assert.ok(cliches.length >= 4);
    for (const finding of cliches) {
      assert.equal(finding.heuristic, true);
      assert.equal(finding.suggestion, null, 'cliche suggestions stay conservative (null)');
      assert.equal(finding.source_sha256, sourceSha);
      assert.ok(finding.span.end > finding.span.start);
      assert.ok(finding.span.start < bytes.length);
    }
    assert.equal(await treeFingerprint(root), before, 'preview must not write');
    const afterBytes = await readFile(path.join(root, 'docs', 'guide.md'));
    assert.equal(digest(afterBytes), sourceSha, 'source bytes are unchanged');
  });

  it('finds EN degradations including unsupported quotes', async () => {
    const root = await makeTemp('aif-read-en-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('en-findings.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.state, 'complete');
    assert.equal(report.inputs[0].language, 'en');
    assert.equal(report.inputs[0].language_source, 'detected');
    assert.ok(ruleIds(report).includes('docs-readability:en-cliche'));
    const quotes = report.findings.filter((finding) => finding.rule.id === 'docs-readability:quote-mismatch');
    assert.equal(quotes.length, 2);
  });

  it('reports zero findings as the distinct complete outcome', async () => {
    const root = await makeTemp('aif-read-zero-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.state, 'complete');
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.counts_only, []);
    assert.ok(!report.diagnostics.some((diagnostic) => diagnostic.code !== 'config-unreadable'));
  });

  it('produces reports that match the schema', async () => {
    const root = await makeTemp('aif-read-schema-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('ru-findings.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    const schema = parseStrictJson(await readFile(path.join(REPO_ROOT, 'schemas', 'docs-readability.schema.json'), 'utf8'));
    assert.deepEqual(validateJsonAgainstSchema(report, schema), []);
    const invalid = { ...report, extra_field: true };
    assert.ok(validateJsonAgainstSchema(invalid, schema).length > 0);
  });
});

describe('AC3: composite invalidation', () => {
  async function writtenReport(root) {
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('ru-findings.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--write', '--json']);
    assert.equal(run.exitCode, 0);
    return parseStrictJson(await readFile(path.join(root, '.ai-factory', 'state', 'work', 'readability', 'report.json'), 'utf8'));
  }

  it('accepts a fresh report and flags source drift as stale-report', async () => {
    const root = await makeTemp('aif-read-stale-');
    const report = await writtenReport(root);
    const fresh = await validateReportBinding(root, report);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.state, null);
    const doc = path.join(root, 'docs', 'guide.md');
    await writeFile(doc, `${await readFile(doc, 'utf8')}\nДополнительный абзац меняет байты документа.\n`);
    const drifted = await validateReportBinding(root, report);
    assert.equal(drifted.stale, true);
    assert.equal(drifted.state, STALE_REPORT_STATE);
    assert.ok(drifted.mismatched.some((field) => field.startsWith('inputs:docs/guide.md')));
    assert.ok(drifted.mismatched.includes('binding'));
  });

  it('flags profile digest drift', async () => {
    const root = await makeTemp('aif-read-prof-');
    const report = await writtenReport(root);
    const drifted = await validateReportBinding(root, report, {
      readProfile: async () => Buffer.from('{"schema":"aifhub.docs_readability_profile.v1","profile_id":"other","profile_version":2,"rules":[]}', 'utf8'),
    });
    assert.equal(drifted.ok, true);
    assert.equal(drifted.stale, true);
    assert.ok(drifted.mismatched.includes('binding'));
  });

  it('flags engine drift', async () => {
    const root = await makeTemp('aif-read-eng-');
    const report = await writtenReport(root);
    const drifted = await validateReportBinding(root, report, {
      readEngine: async () => Buffer.from('// changed engine bytes', 'utf8'),
    });
    assert.equal(drifted.stale, true);
  });

  it('flags glossary drift', async () => {
    const root = await makeTemp('aif-read-glo-');
    const glossary = await fixtureBuffer('glossary-context.md');
    await seedProject(root, { glossary, files: { 'docs/guide.md': await fixtureBuffer('ru-findings.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--write', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.glossary.state, 'present');
    const fresh = await validateReportBinding(root, report);
    assert.equal(fresh.stale, false);
    const glossaryPath = path.join(root, 'CONTEXT.md');
    await writeFile(glossaryPath, `${await readFile(glossaryPath, 'utf8')}\n- **Дополнение** — новый термин глоссария\n`);
    const drifted = await validateReportBinding(root, report);
    assert.equal(drifted.stale, true);
  });

  it('never reuses a report from a foreign worktree', async () => {
    const root = await makeTemp('aif-read-wt1-');
    const report = await writtenReport(root);
    const twin = await makeTemp('aif-read-wt2-');
    await seedProject(twin, { files: { 'docs/guide.md': await fixtureBuffer('ru-findings.md') } });
    const drifted = await validateReportBinding(twin, report);
    assert.equal(drifted.ok, true);
    assert.equal(drifted.stale, true);
    assert.ok(drifted.mismatched.includes('worktree_identity'));
  });

  it('rejects malformed reports', async () => {
    const root = await makeTemp('aif-read-bad-');
    assert.equal((await validateReportBinding(root, null)).ok, false);
    assert.equal((await validateReportBinding(root, { schema: 'other' })).ok, false);
    const report = await writtenReport(root);
    const tampered = { ...report, binding: 'f'.repeat(64) };
    const verdict = await validateReportBinding(root, tampered);
    assert.equal(verdict.stale, true);
    assert.ok(verdict.mismatched.includes('binding'));
  });
});

describe('AC4: code exclusion and partial coverage', () => {
  it('never flags fenced code, inline code, or link targets', async () => {
    const root = await makeTemp('aif-read-code-');
    const bytes = await fixtureBuffer('mixed-code.md');
    await seedProject(root, { files: { 'docs/guide.md': bytes } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.state, 'complete');
    const fenceStart = bytes.indexOf(Buffer.from('```'));
    assert.ok(fenceStart > 0);
    for (const finding of report.findings) {
      assert.ok(finding.span.end <= fenceStart, `finding must stay before the fence: ${finding.rule.id}`);
    }
    assert.ok(!ruleIds(report).includes('docs-readability:ru-cliche'), 'only cliche occurrences live inside code');
    assert.ok(!ruleIds(report).includes('docs-readability:unbalanced-pair'));
    assert.ok(!ruleIds(report).includes('docs-readability:quote-mismatch'));
    assert.ok(ruleIds(report).includes('docs-readability:sentence-length'));
  });

  it('reports unsupported parsing as partial coverage with diagnostics', async () => {
    const root = await makeTemp('aif-read-part-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('unclosed-fence.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.state, 'partial-coverage');
    assert.equal(report.inputs[0].parsing, 'partial');
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'parser-uncovered-span'));
  });
});

describe('AC5: protected constructs and conservative suggestions', () => {
  it('never suggests rewrites for modal requirements', async () => {
    const root = await makeTemp('aif-read-prot-');
    const bytes = await fixtureBuffer('protected-constructs.md');
    await seedProject(root, { files: { 'docs/guide.md': bytes } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.state, 'complete');
    for (const finding of report.findings) {
      assert.equal(finding.suggestion, null, 'no rule proposes a rewrite of modal prose');
    }
    const after = await readFile(path.join(root, 'docs', 'guide.md'));
    assert.deepEqual(after, bytes, 'protected constructs stay byte-identical');
    const text = after.toString('utf8');
    for (const token of ['MUST', 'SHOULD', 'MAY']) assert.ok(text.includes(token));
  });
});

describe('AC6: distinct outcomes', () => {
  it('reports empty input as a usage failure', async () => {
    const root = await makeTemp('aif-read-empty-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') } });
    const run = await runCli(root, ['--change', 'work', '--json']);
    assert.equal(run.exitCode, 2);
    const envelope = run.json();
    assert.equal(envelope.state, 'empty-input');
    assert.ok(envelope.codes.includes('empty-input'));
  });

  it('reports oversized, NUL and invalid-UTF-8 inputs as malformed-input while forming the report', async () => {
    const root = await makeTemp('aif-read-malf-');
    const oversized = Buffer.from('а'.repeat(1024 * 1024 + 16), 'utf8');
    await seedProject(root, {
      files: {
        'docs/guide.md': await fixtureBuffer('ru-findings.md'),
        'docs/big.md': oversized,
        'docs/nul-bytes.md': Buffer.from([0xD0, 0xB1, 0x00, 0xD0, 0xB2]),
        'docs/bin-data.md': Buffer.from([0xFF, 0xFE, 0x61]),
      },
    });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--file', 'docs/big.md', '--file', 'docs/nul-bytes.md', '--file', 'docs/bin-data.md', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.state, 'malformed-input');
    const readStates = Object.fromEntries(report.inputs.map((input) => [input.path, input.read_state]));
    assert.equal(readStates['docs/guide.md'], 'ok');
    assert.equal(readStates['docs/big.md'], 'malformed');
    assert.equal(readStates['docs/nul-bytes.md'], 'malformed');
    assert.equal(readStates['docs/bin-data.md'], 'malformed');
    assert.ok(report.diagnostics.some((diagnostic) => ['unsafe_file', 'file_limit'].includes(diagnostic.code) && diagnostic.path === 'docs/big.md'));
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'nul-byte'));
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'utf8-fatal'));
    assert.ok(report.findings.length > 0, 'healthy inputs are still analyzed');
  });

  it('reports a missing profile as checker-unavailable, never as zero findings', async () => {
    const root = await makeTemp('aif-read-noprof-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('ru-findings.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json'], {
      readProfile: async () => { throw new Error('gone'); },
    });
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.state, 'checker-unavailable');
    assert.equal(report.profile.state, 'unavailable');
    assert.deepEqual(report.findings, []);
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'profile-unavailable'));
  });

  it('reports deadline expiry as the distinct timeout state with skipped inputs', async () => {
    const root = await makeTemp('aif-read-time-');
    await seedProject(root, {
      files: {
        'docs/a.md': await fixtureBuffer('ru-findings.md'),
        'docs/b.md': await fixtureBuffer('en-findings.md'),
      },
    });
    let clock = 0;
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/a.md', '--file', 'docs/b.md', '--json'], {
      now: () => (clock += 1) <= 1 ? 0 : 5000,
      deadlineMs: 1,
    });
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.state, 'timeout');
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'deadline-exceeded'));
    for (const input of report.inputs) assert.equal(input.read_state, 'skipped');
    assert.deepEqual(report.findings, []);
  });

  it('detects wrong-language against an explicit override', async () => {
    const root = await makeTemp('aif-read-wrong-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('ru-findings.md') } });
    const run = await runCli(root, ['--change', 'work', '--language', 'en', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.state, 'wrong-language');
    assert.equal(report.inputs[0].language_source, 'override');
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'wrong-language'));
  });

  it('detects ambiguous language for short documents without override', async () => {
    const root = await makeTemp('aif-read-amb-');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from('# Краткий документ\n\nКоротко и по делу.\n', 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.state, 'ambiguous-language');
    assert.equal(report.inputs[0].language, 'unknown');
  });

  it('aggregates multi-input severity deterministically', async () => {
    const root = await makeTemp('aif-read-agg-');
    await seedProject(root, {
      files: {
        'docs/aaa-ambiguous.md': Buffer.from('# Кратко\n\nКоротко.\n', 'utf8'),
        'docs/bbb-wrong.md': await fixtureBuffer('ru-findings.md'),
        'docs/ccc-clean.md': await fixtureBuffer('clean-ru.md'),
      },
    });
    const ambiguousRun = await runCli(root, ['--change', 'work', '--file', 'docs/aaa-ambiguous.md', '--file', 'docs/ccc-clean.md', '--json']);
    assert.equal(ambiguousRun.json().state, 'ambiguous-language');
    const wrongRun = await runCli(root, ['--change', 'work', '--language', 'en', '--file', 'docs/bbb-wrong.md', '--file', 'docs/ccc-clean.md', '--json']);
    assert.equal(wrongRun.json().state, 'wrong-language');
  });
});

describe('AC7: QA isolation and writer guards', () => {
  async function seedGitProject(root) {
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await mkdir(path.join(root, '.ai-factory'), { recursive: true });
    await mkdir(path.join(root, 'openspec', 'changes', 'work'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n');
    await writeFile(path.join(root, 'docs', 'guide.md'), await fixtureBuffer('ru-findings.md'));
    await writeFile(path.join(root, '.ai-factory', 'config.yaml'), 'aifhub:\n  readability:\n    enabled: true\n');
    await writeFile(path.join(root, 'openspec', 'changes', 'work', 'proposal.md'), '# Предложение\n\n## Why\n\nФикстура изоляции QA.\n');
    await writeFile(path.join(root, 'openspec', 'changes', 'work', 'tasks.md'), '- [ ] 1.1 Задача\n');
    const git = async (args) => execFileAsync('git', args, { cwd: root });
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.email', 'fixture@example.com']);
    await git(['config', 'user.name', 'fixture']);
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);
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
    };
  }

  it('keeps the QA binding identical across write, overwrite and deletion', async () => {
    const root = await makeTemp('aif-read-qa-');
    const options = await seedGitProject(root);
    const readinessBefore = canonical(await buildOpenSpecDoneReadiness({ rootDir: root, changeId: 'work', cwd: root }));
    const before = await observe(options);
    const argv = ['--change', 'work', '--file', 'docs/guide.md', '--write', '--json'];
    assert.equal((await runCli(root, argv)).exitCode, 0);
    const afterWrite = await observe(options);
    assert.deepEqual(afterWrite, before);
    assert.equal((await runCli(root, argv)).exitCode, 0, 'overwrite of the same-change report is allowed');
    const afterOverwrite = await observe(options);
    assert.deepEqual(afterOverwrite, before);
    const readinessAfter = canonical(await buildOpenSpecDoneReadiness({ rootDir: root, changeId: 'work', cwd: root }));
    assert.equal(readinessAfter, readinessBefore, 'done-readiness is identical before and after the report write');
    await rm(path.join(root, '.ai-factory', 'state', 'work', 'readability', 'report.json'));
    const afterDelete = await observe(options);
    assert.deepEqual(afterDelete, before);
    assert.ok(!before.files.some((p) => p.includes('readability')));
    assert.ok(!before.ignored_names.some((p) => p.includes('readability')));
  });

  it('fail-closed refuses a custom paths.state root', async () => {
    const root = await makeTemp('aif-read-state-');
    await seedProject(root, {
      config: 'aifhub:\n  readability:\n    enabled: true\npaths:\n  state: .state\n',
      files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') },
    });
    const before = await treeFingerprint(root);
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--write', '--json']);
    assert.equal(run.exitCode, 1);
    const envelope = run.json();
    assert.equal(envelope.state, 'report-not-saved');
    assert.ok(envelope.codes.includes('state-root-mismatch'));
    assert.equal(await treeFingerprint(root), before, 'failed write leaves the project untouched');
  });

  it('fail-closed refuses to shadow a control file and to overwrite a foreign leaf', async () => {
    const shadowRoot = await makeTemp('aif-read-shadow-');
    await seedProject(shadowRoot, { files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') } });
    await mkdir(path.join(shadowRoot, '.ai-factory', 'state'), { recursive: true });
    await writeFile(path.join(shadowRoot, '.ai-factory', 'state', 'work'), 'control file\n');
    const shadowRun = await runCli(shadowRoot, ['--change', 'work', '--file', 'docs/guide.md', '--write']);
    assert.equal(shadowRun.exitCode, 1);
    assert.ok(shadowRun.stdout.includes('file-shadow'));

    const leafRoot = await makeTemp('aif-read-leaf-');
    await seedProject(leafRoot, { files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') } });
    const leafDir = path.join(leafRoot, '.ai-factory', 'state', 'work', 'readability');
    await mkdir(leafDir, { recursive: true });
    await writeFile(path.join(leafDir, 'report.json'), '{"schema":"aifhub.unrelated.v1"}\n');
    const leafRun = await runCli(leafRoot, ['--change', 'work', '--file', 'docs/guide.md', '--write']);
    assert.equal(leafRun.exitCode, 1);
    assert.ok(leafRun.stdout.includes('report-leaf-conflict'));
  });

  it('git guard fails closed on not-ignored and tracked destinations', async () => {
    const verdicts = [];
    const fake = async (command, args) => {
      verdicts.push([command, ...args]);
      const joined = args.join(' ');
      if (joined.includes('rev-parse')) return { stdout: 'true\n' };
      if (joined.includes('check-ignore')) { const error = new Error('not ignored'); error.code = 1; throw error; }
      return { stdout: '' };
    };
    const notIgnored = await verifyReportIgnored('/fixture', '.ai-factory/state/w/readability/report.json', { execGit: fake });
    assert.equal(notIgnored.ok, false);
    assert.equal(notIgnored.code, 'report-path-not-ignored');

    const trackedFake = async (command, args) => {
      const joined = args.join(' ');
      if (joined.includes('rev-parse')) return { stdout: 'true\n' };
      if (joined.includes('check-ignore')) return { stdout: '.ai-factory/state/w/readability/report.json\n' };
      if (joined.includes('ls-files')) return { stdout: '.ai-factory/state/w/readability/report.json\0' };
      return { stdout: '' };
    };
    const tracked = await verifyReportIgnored('/fixture', '.ai-factory/state/w/readability/report.json', { execGit: trackedFake });
    assert.equal(tracked.ok, false);
    assert.equal(tracked.code, 'report-path-tracked');

    const outsideFake = async () => { const error = new Error('fatal: not a git repository'); error.code = 128; error.stderr = 'fatal: not a git repository'; throw error; };
    const outside = await verifyReportIgnored('/fixture', '.ai-factory/state/w/readability/report.json', { execGit: outsideFake });
    assert.equal(outside.ok, true);
    assert.equal(outside.reason, 'not-git');
  });
});

describe('AC8: offline boundary and hostile fixtures', () => {
  it('keeps the analysis module free of process and network APIs', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'scripts', 'docs-readability.mjs'), 'utf8');
    for (const forbidden of ['child_process', 'execFile', 'spawn(', 'fetch(', 'http.request', 'XMLHttpRequest']) {
      assert.ok(!source.includes(forbidden), `docs-readability.mjs must not reference ${forbidden}`);
    }
  });

  it('treats hostile instructions as prose without executing or suggesting them', async () => {
    const root = await makeTemp('aif-read-hostile-');
    const bytes = await fixtureBuffer('hostile.md');
    await seedProject(root, { files: { 'docs/guide.md': bytes } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    const commandLineStart = bytes.indexOf(Buffer.from('$ curl'));
    assert.ok(commandLineStart > 0);
    for (const finding of report.findings) {
      assert.ok(finding.span.start < commandLineStart, 'excluded command lines produce no findings');
      assert.ok(!finding.explanation.includes('evil.example'));
      assert.ok(finding.suggestion === null || !finding.suggestion.includes('evil.example'));
    }
    assert.ok(ruleIds(report).includes('docs-readability:sentence-length'));
  });
});

describe('position accuracy on CRLF/BOM and Unicode fixtures', () => {
  it('derives exact byte spans and line/column from source bytes with BOM and CRLF', async () => {
    const root = await makeTemp('aif-read-crlf-');
    const bytes = await fixtureBuffer('crlf-bom.md');
    await seedProject(root, { files: { 'docs/guide.md': bytes } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    const expectedStart = bytes.indexOf(Buffer.from('Настоящий', 'utf8'));
    assert.ok(expectedStart > 0, 'fixture sentence is found after the BOM');
    const finding = report.findings.find((item) => item.rule.id === 'docs-readability:ru-cliche'
      && bytes.slice(item.span.start, item.span.end).toString('utf8').toLowerCase() === 'настоящий');
    assert.ok(finding, 'a Настоящий cliche finding exists');
    assert.equal(finding.span.start, expectedStart);
    assert.equal(finding.span.end, expectedStart + Buffer.byteLength('Настоящий', 'utf8'));
    const beforeStart = bytes.subarray(0, expectedStart).toString('utf8');
    assert.equal(finding.span.line, beforeStart.split('\n').length);
    assert.equal(finding.span.column, 1);
  });

  it('keeps exact byte offsets across four-byte emoji', async () => {
    const root = await makeTemp('aif-read-uni-');
    const bytes = await fixtureBuffer('unicode.md');
    await seedProject(root, { files: { 'docs/guide.md': bytes } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    const expectedStart = bytes.indexOf(Buffer.from('данный', 'utf8'));
    const finding = report.findings.find((item) => item.rule.id === 'docs-readability:ru-cliche'
      && bytes.slice(item.span.start, item.span.end).toString('utf8').toLowerCase() === 'данный');
    assert.ok(finding, 'a данный cliche finding exists');
    assert.equal(finding.span.start, expectedStart);
    assert.equal(finding.span.end - finding.span.start, Buffer.byteLength('данный', 'utf8'));
  });

  it('maps byte offsets per code unit including surrogate pairs', () => {
    const offsets = buildByteOffsets('\uFEFFA\u{1F4A1}\u0411');
    assert.deepEqual([...offsets], [0, 3, 4, 6, 8, 10]);
  });
});

describe('glossary read-only consumption', () => {
  it('reports missing, empty and unsafe glossaries without exposing content', async () => {
    const missingRoot = await makeTemp('aif-read-g1-');
    await seedProject(missingRoot, { files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') } });
    const missingRun = await runCli(missingRoot, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(missingRun.json().glossary.state, 'missing');

    const emptyRoot = await makeTemp('aif-read-g2-');
    await seedProject(emptyRoot, { glossary: '   \n', files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') } });
    const emptyRun = await runCli(emptyRoot, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(emptyRun.json().glossary.state, 'empty');

    const unsafeRoot = await makeTemp('aif-read-g3-');
    await seedProject(unsafeRoot, {
      config: 'aifhub:\n  readability:\n    enabled: true\npaths:\n  context: ../outside.md\n',
      files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') },
    });
    const unsafeRun = await runCli(unsafeRoot, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(unsafeRun.json().glossary.state, 'unsafe');
    assert.equal(unsafeRun.json().glossary.sha256, null);
  });

  it('finds terminology only through recognized glossary entries and never copies the body', async () => {
    const root = await makeTemp('aif-read-g4-');
    const glossary = await fixtureBuffer('glossary-context.md');
    await seedProject(root, { glossary, files: { 'docs/guide.md': await fixtureBuffer('doc-uses-alias.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    const terms = report.findings.filter((finding) => finding.rule.id === 'docs-readability:glossary-term');
    assert.ok(terms.length >= 2);
    for (const finding of terms) {
      assert.equal(finding.heuristic, true);
      assert.equal(finding.suggestion, 'AIFHub');
    }
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('канонический протокол'), 'glossary body stays out of the report');
    assert.ok(!serialized.includes('расширение AI Factory'), 'glossary body stays out of the report');
  });

  it('parses glossary entries best-effort', async () => {
    const entries = parseGlossaryEntries(await fixtureText('glossary-context.md'));
    assert.deepEqual(entries.map((entry) => entry.preferred), ['OpenSpec', 'AIFHub']);
    assert.deepEqual(entries[1].aliases, ['эйфхаб', 'аифхаб']);
  });
});

describe('profile loading', () => {
  it('loads the pinned repository profile', async () => {
    const profile = await loadProfile({});
    assert.equal(profile.ok, true);
    assert.equal(profile.profile.id, 'aifhub-docs-readability-default');
    assert.equal(profile.profile.version, 1);
    for (const [id, rule] of profile.profile.rules) {
      assert.ok(id.startsWith('docs-readability:'));
      assert.ok(['project', 'upstream'].includes(rule.origin));
      assert.ok(Number.isInteger(rule.version) && rule.version >= 1);
    }
  });

  it('degrades to checker-unavailable diagnostics on corrupt profiles', async () => {
    const corrupt = await loadProfile({ readProfile: async () => Buffer.from('not json', 'utf8') });
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.diagnostics[0].code, 'profile-unavailable');
    const invalid = await loadProfile({
      readProfile: async () => Buffer.from(JSON.stringify({ schema: 'aifhub.docs_readability_profile.v1', profile_id: 'x', profile_version: 1, rules: [{ id: 'docs-readability:sentence-length', version: 1, origin: 'project', type: 'sentence-length', thresholds: {} }] }), 'utf8'),
    });
    assert.equal(invalid.ok, true);
    const badShape = await loadProfile({
      readProfile: async () => Buffer.from(JSON.stringify({ schema: 'wrong', profile_id: 'x' }), 'utf8'),
    });
    assert.equal(badShape.ok, false);
  });
});

describe('readReadabilityConfig', () => {
  it('falls back to defaults when the config file is absent', async () => {
    const root = await makeTemp('aif-read-cfgdef-');
    const config = await readReadabilityConfig(root);
    assert.equal(config.enabled, null);
    assert.equal(config.stateRoot, '.ai-factory/state');
    assert.equal(config.contextPath, 'CONTEXT.md');
    assert.deepEqual(config.diagnostics, []);
  });
});
