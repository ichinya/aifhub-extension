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
  buildSections,
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
import { observeQaSnapshot, allDeclaredRoots } from './qa-manifest-inputs.mjs';
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

  it('keeps quoted boolean-looking values as strings', () => {
    const parsed = parseConfigSubset('aifhub:\n  readability:\n    enabled: "true"\n');
    assert.equal(parsed.aifhub.readability.enabled, 'true');
    assert.equal(typeof parsed.aifhub.readability.enabled, 'string');
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
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'file_limit' && diagnostic.path === 'docs/big.md'));
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
      digest: snapshot.digest,
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
    // Incomplete sentence thresholds are a profile-shape failure: the command
    // must degrade to checker-unavailable instead of crashing on the rule.
    const invalid = await loadProfile({
      readProfile: async () => Buffer.from(JSON.stringify({ schema: 'aifhub.docs_readability_profile.v1', profile_id: 'x', profile_version: 1, rules: [{ id: 'docs-readability:sentence-length', version: 1, origin: 'project', type: 'sentence-length', thresholds: {} }] }), 'utf8'),
    });
    assert.equal(invalid.ok, false);
    const missingPairs = await loadProfile({
      readProfile: async () => Buffer.from(JSON.stringify({ schema: 'aifhub.docs_readability_profile.v1', profile_id: 'x', profile_version: 1, rules: [{ id: 'docs-readability:unbalanced-pair', version: 1, origin: 'project', type: 'unbalanced-pair' }] }), 'utf8'),
    });
    assert.equal(missingPairs.ok, false);
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

// ---------------------------------------------------------------------------
// Review regressions (second round): each test names the defect it pins.
// ---------------------------------------------------------------------------

describe('review regressions: scanning coverage', () => {
  it('scans the preamble before the first active H2 (no dead prose)', async () => {
    const root = await makeTemp('aif-rv-pre-');
    const doc = [
      '# Титульный документ проекта',
      '',
      'В рамках данного документа преамбула содержит канцелярит до первого заголовка второго уровня проекта.',
      '',
      '## Описание',
      '',
      'Система собирает события и записывает их в журнал наблюдений за поведением основных компонентов платформы.',
      'Каждый журнал содержит время, источник события и код итогового результата проверки состояния окружения.',
      'Отчёт формируется по запросу оператора без изменения исходных файлов документации проекта полностью.',
    ].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.equal(report.state, 'complete');
    const h2 = Buffer.from(doc, 'utf8').indexOf(Buffer.from('## Описание', 'utf8'));
    const preambleCliche = report.findings.find((finding) => finding.rule.id === 'docs-readability:ru-cliche'
      && Buffer.from(doc, 'utf8').slice(finding.span.start, finding.span.end).toString('utf8').toLowerCase() === 'в рамках');
    assert.ok(preambleCliche, 'preamble cliche is found');
    assert.ok(preambleCliche.span.end <= h2, 'preamble finding stays before the first H2');
  });

  it('measures hard-wrapped sentences as one sentence (soft wrap is whitespace)', async () => {
    const root = await makeTemp('aif-rv-wrap-');
    const lineA = 'Длинное предложение без точки продолжается на следующей строке с большим количеством слов чтобы уверенно превысить порог описания';
    const lineB = 'в тридцать слов и стать единой находкой длины при переносе строк посреди предложения документа проекта целиком.';
    const doc = [
      '# Документ с переносами',
      '',
      '## Описание',
      '',
      'Первое короткое предложение контекста абзаца.',
      lineA,
      lineB,
      'Финальная короткая строка после точки завершает абзац теста.',
    ].join('\n');
    const merged = `${lineA} ${lineB}`;
    const words = merged.match(/[\p{L}\p{N}]+/gu).length;
    assert.ok(words > 30, `wrapped sentence must exceed the threshold, got ${words}`);
    const lineAWords = lineA.match(/[\p{L}\p{N}]+/gu).length;
    assert.ok(lineAWords <= 30, 'the pre-fix fragment alone must not exceed the threshold');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    const tailByte = Buffer.from(doc, 'utf8').indexOf(Buffer.from('Длинное предложение', 'utf8'));
    const finding = report.findings.find((item) => item.rule.id === 'docs-readability:sentence-length'
      && item.span.start === tailByte);
    assert.ok(finding, 'the mid-paragraph wrapped sentence is one finding');
    assert.ok(finding.explanation.includes(`${words} words`));
  });

  it('anchors link matching at the scan position', async () => {
    const root = await makeTemp('aif-rv-link-');
    const doc = [
      '# Doc',
      '',
      '## Usage',
      '',
      'The nonsensical bracket prefix [x] utilize the labeled link [label](https://example.com/very/long/path) and the analyzer must keep prose findings while excluding the target URL completely from every rule evaluation today.',
      'Second sentence adds enough letters for confident language detection by the deterministic share estimator used here today.',
    ].join('\n');
    const bytes = Buffer.from(doc, 'utf8');
    await seedProject(root, { files: { 'docs/guide.md': bytes } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    const urlStart = bytes.indexOf(Buffer.from('https://example.com', 'utf8'));
    const urlEnd = bytes.indexOf(Buffer.from(')', 'utf8'), urlStart) + 1;
    for (const finding of report.findings) {
      // Span-local rules must not produce findings that live inside the link
      // target; sentence-length spans legitimately cover the whole sentence,
      // so only containment inside the URL range is a defect here.
      const insideUrl = finding.span.start >= urlStart && finding.span.end <= urlEnd;
      assert.ok(!insideUrl, 'no finding may live inside the link target');
    }
    const utilize = bytes.indexOf(Buffer.from('utilize', 'utf8'));
    const cliche = report.findings.find((item) => item.rule.id === 'docs-readability:en-cliche'
      && bytes.slice(item.span.start, item.span.end).toString('utf8') === 'utilize');
    assert.ok(cliche, 'the prose utilize occurrence is found');
    assert.equal(cliche.span.start, utilize);
  });

  it('excludes indented code blocks from eligible prose', async () => {
    const root = await makeTemp('aif-rv-ind-');
    const doc = [
      '# Документ с отступами',
      '',
      '## Описание',
      '',
      'Сначала идёт обычный абзац проекта с достаточным количеством букв кириллицы для уверенной детекции языка документа.',
      '',
      '    в рамках данного процесса строка кода с отступом четыре пробела',
      '',
      'Ещё один абзац после кода тоже содержит достаточное количество букв кириллицы для детекции и не содержит штампов.',
    ].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    assert.ok(!ruleIds(report).includes('docs-readability:ru-cliche'), 'indented code cliche stays out of findings');
  });

  it('excludes BOM-prefixed front matter and reports unterminated front matter as partial', async () => {
    const body = '## Usage\n\nThe document keeps enough latin letters for confident language detection because detectors require solid evidence before committing to any language decision here today.\n';
    const closedRoot = await makeTemp('aif-rv-fm1-');
    const closedDoc = '\uFEFF---\ntitle: utilize\n---\n\n' + body;
    await seedProject(closedRoot, { files: { 'docs/guide.md': Buffer.from(closedDoc, 'utf8') } });
    const closedRun = await runCli(closedRoot, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const closed = closedRun.json();
    assert.equal(closed.inputs[0].parsing, 'full');
    assert.ok(!ruleIds(closed).includes('docs-readability:en-cliche'), 'front matter is not prose');

    const openRoot = await makeTemp('aif-rv-fm2-');
    const openDoc = '\uFEFF---\ntitle: utilize\n';
    await seedProject(openRoot, { files: { 'docs/guide.md': Buffer.from(openDoc, 'utf8') } });
    const openRun = await runCli(openRoot, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const open = openRun.json();
    assert.equal(open.inputs[0].parsing, 'partial');
    const uncovered = open.diagnostics.find((diagnostic) => diagnostic.code === 'parser-uncovered-span');
    assert.ok(uncovered, 'unterminated front matter produces an uncovered-span diagnostic');
    assert.ok(/bytes=0-\d+/.test(uncovered.detail), `diagnostic carries the byte range: ${uncovered.detail}`);
  });

  it('reports uncovered byte ranges for an unclosed fence', async () => {
    const root = await makeTemp('aif-rv-fence-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('unclosed-fence.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    const uncovered = report.diagnostics.find((diagnostic) => diagnostic.code === 'parser-uncovered-span'
      && diagnostic.path === 'docs/guide.md');
    assert.ok(uncovered, 'unclosed fence diagnostic present');
    assert.ok(/bytes=\d+-\d+/.test(uncovered.detail), `byte range present: ${uncovered.detail}`);
  });

  it('gives quote-mismatch a mechanically derivable suggestion', async () => {
    const root = await makeTemp('aif-rv-quote-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('en-findings.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const quotes = run.json().findings.filter((finding) => finding.rule.id === 'docs-readability:quote-mismatch');
    assert.equal(quotes.length, 2);
    for (const finding of quotes) {
      assert.ok(typeof finding.suggestion === 'string' && finding.suggestion.length > 0);
    }
  });

  it('caps per-document findings and degrades the outcome to partial-coverage', async () => {
    const root = await makeTemp('aif-rv-cap-');
    const doc = `# Cap\n\n## Description\n\n${'“'.repeat(3000)}\n\n${EN_VOLUME}\n`;
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    assert.equal(run.exitCode, 0, 'the bounded pipeline survives pathological documents');
    const report = run.json();
    assert.ok(report.findings.length <= 2000, `findings capped, got ${report.findings.length}`);
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'findings-truncated'
      && diagnostic.path === 'docs/guide.md'));
    assert.equal(report.state, 'partial-coverage', 'truncated diagnostics must not stay complete');
  });
});

describe('review regressions: writer and guard hardening', () => {
  it('refuses to replace a same-change leaf that is not a fully valid report', async () => {
    const root = await makeTemp('aif-rv-leaf-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') } });
    const leafDir = path.join(root, '.ai-factory', 'state', 'work', 'readability');
    await mkdir(leafDir, { recursive: true });
    const plausible = {
      schema: READABILITY_SCHEMA, change_id: 'work', extra_unknown: true,
    };
    await writeFile(path.join(leafDir, 'report.json'), `${JSON.stringify(plausible)}\n`);
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--write']);
    assert.equal(run.exitCode, 1);
    assert.ok(run.stdout.includes('report-leaf-conflict'));
  });

  it('fails the git guard closed on dubious ownership', async () => {
    const dubious = async (command, args) => {
      if (args.join(' ').includes('rev-parse')) {
        const error = new Error('fatal: detected dubious ownership in repository');
        error.code = 128;
        error.stderr = 'fatal: detected dubious ownership in repository';
        throw error;
      }
      return { stdout: '' };
    };
    const verdict = await verifyReportIgnored('/fixture', '.ai-factory/state/w/readability/report.json', { execGit: dubious });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'git-verify-failed');
  });
});

describe('review regressions: binding identity', () => {
  it('persists the language override and survives revalidation with malformed inputs', async () => {
    const root = await makeTemp('aif-rv-lang-');
    await seedProject(root, {
      files: {
        'docs/broken.md': Buffer.from([0xD0, 0xB1, 0x00]),
        'docs/clean.md': await fixtureBuffer('clean-ru.md'),
      },
    });
    const run = await runCli(root, ['--change', 'work', '--language', 'en', '--file', 'docs/broken.md', '--file', 'docs/clean.md', '--write', '--json']);
    assert.equal(run.exitCode, 0);
    const report = run.json();
    assert.deepEqual(report.language_options, { override: 'en' });
    assert.equal(report.state, 'malformed-input');
    const verdict = await validateReportBinding(root, report);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.stale, false, 'the binding component is recoverable from the persisted override');
  });

  it('names tampered profile, engine, glossary and language fields', async () => {
    const root = await makeTemp('aif-rv-tamper-');
    const glossary = await fixtureBuffer('glossary-context.md');
    await seedProject(root, { glossary, files: { 'docs/guide.md': await fixtureBuffer('ru-findings.md') } });
    const run = await runCli(root, ['--change', 'work', '--language', 'ru', '--file', 'docs/guide.md', '--write', '--json']);
    assert.equal(run.exitCode, 0);
    const stored = parseStrictJson(await readFile(path.join(root, '.ai-factory', 'state', 'work', 'readability', 'report.json'), 'utf8'));

    const profileTampered = { ...stored, profile: { ...stored.profile, id: 'other-profile' } };
    const profileVerdict = await validateReportBinding(root, profileTampered);
    assert.ok(profileVerdict.mismatched.includes('profile'));

    const engineTampered = { ...stored, engine: { ...stored.engine, sha256: 'a'.repeat(64) } };
    const engineVerdict = await validateReportBinding(root, engineTampered);
    assert.ok(engineVerdict.mismatched.includes('engine'));

    const glossaryTampered = { ...stored, glossary: { ...stored.glossary, sha256: 'b'.repeat(64) } };
    const glossaryVerdict = await validateReportBinding(root, glossaryTampered);
    assert.ok(glossaryVerdict.mismatched.includes('glossary'));

    const languageTampered = { ...stored, language_options: { override: 'en' } };
    const languageVerdict = await validateReportBinding(root, languageTampered);
    // The override has no external source to compare against; tampering is
    // localized by the binding digest that mixes the persisted value in.
    assert.ok(languageVerdict.mismatched.includes('binding'));
  });

  it('keeps the injected-provider snapshot identical across a report write', async () => {
    const root = await makeTemp('aif-rv-inj-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('ru-findings.md') } });
    const toolchain = [{ name: 'fake-node', sha256: digest('runtime') }];
    const checks = [{ id: 'check-verify', gate: 'verify', profile: 'declared.v1', dependencies_complete: true,
      inputs: ['docs'], command: { argv: ['fake'], cwd: '.' }, toolchain, env_inputs: [], requires_observed: false }];
    const model = { files: { 'docs/guide.md': Buffer.from('same bytes') }, ignored_names: [],
      modules: { helper: digest('helper') }, worktree_identity: digest(root), actual_diff: digest('same') };
    const options = { rootDir: root, changeId: 'work', scope: ['docs'], checks, environment: {},
      providers: { requirements: async () => ({ gates: ['verify'], independent_roles: [], evidence: [] }), toolchain: async () => toolchain },
      SnapshotProvider: async ({ payload }) => {
        const files = { ...model.files };
        for (const scope of allDeclaredRoots(payload)) {
          if (!Object.keys(files).some((p) => p === scope || p.startsWith(`${scope}/`))) files[scope] = null;
        }
        return { ...model, complete: true, files };
      } };
    assert.equal((await prepareQaManifest(options)).ok, true);
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    const before = await observeQaSnapshot(store, payload, options);
    assert.equal((await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--write', '--json'])).exitCode, 0);
    const after = await observeQaSnapshot(store, payload, options);
    assert.equal(after.digest, before.digest, 'injected-provider snapshot digest is unchanged');
    assert.deepEqual(after.ignored_names, before.ignored_names);
    assert.deepEqual(after.changed_paths, before.changed_paths);
    assert.ok(!Object.keys(after.files).some((p) => p.includes('readability')));
  });

  it('classifies an unreadable glossary without exposing content', async () => {
    const root = await makeTemp('aif-rv-glos-');
    await seedProject(root, {
      glossary: Buffer.from([0xD0, 0xB1, 0x00]),
      files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') },
    });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.glossary.state, 'unreadable');
    assert.equal(report.glossary.sha256, null);
  });
});

// ---------------------------------------------------------------------------
// Review regressions (fourth round): each test names the defect it pins.
// ---------------------------------------------------------------------------

const EN_VOLUME = 'Second paragraph adds enough letters for confident language detection by the deterministic share estimator used here today and keeps the remaining volume comfortably above the required detector threshold of the analyzed document.';

describe('round three: inline syntax priority', () => {
  it('lets an orphan opener stay literal without blocking later pairs', async () => {
    const root = await makeTemp('aif-r3-orphan-');
    const doc = ['# Orphans', '', '## Usage', '', 'text ` orphan ``utilize`` end and the analyzer must still treat the double-backtick span as code for every rule evaluation of this document today.', EN_VOLUME].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    assert.ok(!ruleIds(report).includes('docs-readability:en-cliche'), 'the closed double-backtick span stays code');
  });

  it('never pairs a backtick inside a recognized link destination', async () => {
    const root = await makeTemp('aif-r3-dest-');
    const doc = ['# Dest', '', '## Usage', '', 'See [label](https://example.com/`) and then utilize the regular prose wording so the rules can evaluate this sentence of the documentation project today.', EN_VOLUME].join('\n');
    const bytes = Buffer.from(doc, 'utf8');
    await seedProject(root, { files: { 'docs/guide.md': bytes } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    const utilize = bytes.indexOf(Buffer.from('utilize', 'utf8'));
    const cliche = report.findings.find((item) => item.rule.id === 'docs-readability:en-cliche'
      && bytes.slice(item.span.start, item.span.end).toString('utf8') === 'utilize');
    assert.ok(cliche, 'prose utilize after the link is found');
    assert.equal(cliche.span.start, utilize);
    const urlStart = bytes.indexOf(Buffer.from('https://example.com', 'utf8'));
    const urlEnd = bytes.indexOf(Buffer.from(')', 'utf8'), urlStart) + 1;
    for (const finding of report.findings) {
      const insideUrl = finding.span.start >= urlStart && finding.span.end <= urlEnd;
      assert.ok(!insideUrl, 'no finding may live inside the destination');
    }
  });

  it('trims bare-url trailing parens only while unbalanced', async () => {
    const root = await makeTemp('aif-r3-url-');
    const doc = [
      '# Библиотека',
      '',
      '## Описание',
      '',
      'Смотрите материал https://en.wikipedia.org/wiki/Markdown_(язык) и проверяйте утверждения по первоисточникам проекта перед использованием в документации.',
      'Каждый журнал проверок содержит время события, источник факта и код итогового результата проверки состояния окружения проекта.',
    ].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    assert.ok(!ruleIds(report).includes('docs-readability:unbalanced-pair'), 'balanced url parens leave no orphan close paren');
  });

  it('accepts two-level balanced parentheses in link destinations', async () => {
    const root = await makeTemp('aif-r3-deep-');
    const doc = ['# Deep', '', '## Usage', '', 'See [label](https://example.com/a((b))) and keep the surrounding prose balanced so no phantom unbalanced pair finding can appear inside this sentence of the documentation project today.', EN_VOLUME].join('\n');
    const bytes = Buffer.from(doc, 'utf8');
    await seedProject(root, { files: { 'docs/guide.md': bytes } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.ok(!ruleIds(report).includes('docs-readability:unbalanced-pair'), 'two-level balanced destination leaves no phantom');
    assert.equal(report.state, 'complete');
  });
});

describe('round three: list containers and markers', () => {
  it('expands tab markers to their visual content column', async () => {
    const root = await makeTemp('aif-r3-tab-');
    const doc = ['# Tabs', '', '## Usage', '', '-\titem', '', '      utilize the six-space line under a tab-marker item that stays prose semantics for the rules engine here.', '', EN_VOLUME].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    const cliche = report.findings.find((item) => item.rule.id === 'docs-readability:en-cliche'
      && item.explanation.includes('utilize'));
    assert.ok(cliche, 'six spaces under a tab marker (content column 4) stay prose');
  });

  it('keeps the list container open across two-space continuations', async () => {
    const root = await makeTemp('aif-r3-cont-');
    const doc = ['# Cont', '', '## Usage', '', '- item', '  continuation of the same item text', '', '    utilize the four-space line after the continuation that stays prose inside the item container.', '', EN_VOLUME].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    const cliche = report.findings.find((item) => item.rule.id === 'docs-readability:en-cliche'
      && item.explanation.includes('utilize'));
    assert.ok(cliche, 'the four-space line after a continuation stays prose (container kept)');
  });

  it('recognizes a nested marker instead of hiding its prose as code', async () => {
    const root = await makeTemp('aif-r3-nest-');
    const doc = ['# Nested', '', '## Usage', '', '- item', '    - sub with utilize wording that must stay visible prose for the rules engine evaluation.', '', EN_VOLUME].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    const cliche = report.findings.find((item) => item.rule.id === 'docs-readability:en-cliche'
      && item.explanation.includes('utilize'));
    assert.ok(cliche, 'nested marker prose stays visible to the rules');
  });
});

describe('round three: paragraph boundaries', () => {
  it('does not merge a heading into a body paragraph without a blank line', async () => {
    const root = await makeTemp('aif-r3-head-');
    const bodyWords = ['ровно', 'тридцать', 'слов', 'идут', 'внутри', 'этого', 'абзаце', 'без', 'единой', 'терминальной',
      'точки', 'чтобы', 'старый', 'алгоритм', 'склейки', 'заголовка', 'или', 'абзаца', 'сформировал', 'ложную',
      'находку', 'длины', 'предложения', 'однако', 'новый', 'алгоритм', 'оставил', 'итоговый', 'результат', 'везде'];
    const body = bodyWords.join(' ');
    const doc = ['# Doc', '## Описание', body].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    assert.deepEqual(report.findings.filter((item) => item.rule.id === 'docs-readability:sentence-length'), [],
      'heading plus body without a blank line stays separate');
  });

  it('treats a link-reference definition as its own paragraph break', async () => {
    const root = await makeTemp('aif-r3-linkdef-');
    const baseWords = ['абзац', 'без', 'точки', 'в', 'конце', 'строки', 'продолжается', 'мыслью', 'документа', 'на', 'всём', 'протяжении', 'каждого', 'предложения', 'текста', 'проекта'];
    const firstParagraph = baseWords.join(' ');
    const secondParagraph = [...baseWords, 'и', 'вторая', 'часть', 'тоже', 'без', 'пунктуации', 'в', 'самом', 'конце', 'всего', 'текста', 'документа', 'целиком', 'совсем'].join(' ');
    const doc = ['# Def', '', '## Описание', '', firstParagraph, '[x]: /u', secondParagraph].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    const merged = firstParagraph.split(' ').length + secondParagraph.split(' ').length;
    const long = report.findings.filter((item) => item.rule.id === 'docs-readability:sentence-length'
      && item.explanation.includes(`${merged} words`));
    assert.deepEqual(long, [], 'link definition breaks the paragraph flow');
  });

  it('stores clean heading names without BOM or hash marks', () => {
    const text = '\uFEFF## Установка\n\nПервый абзац документа с обычным текстом для контекста классификации секций.';
    const model = buildDocumentModel(text);
    const sections = buildSections(model);
    assert.equal(sections[0].heading, 'Установка');
    assert.ok(!sections[0].heading.includes('\uFEFF'));
    assert.ok(!sections[0].heading.startsWith('##'));
  });
});

// ---------------------------------------------------------------------------
// Devin PR-review triage (round four): each test names the defect it pins.
// ---------------------------------------------------------------------------

describe('devin pr triage: bounded inline handling', () => {
  it('stops url tokens at a code-span delimiter so the span still pairs', async () => {
    const root = await makeTemp('aif-d1-urltick-');
    const doc = ['# Url tick', '', '## Usage', '', 'Keep the `utilize https://x.com/a` fragment inside its code span and rely on the remaining prose to carry the language detection evidence of this document today.', EN_VOLUME].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    assert.ok(!ruleIds(report).includes('docs-readability:en-cliche'), 'the code span around the url stays excluded');
  });

  it('flags reversed punctuation order that total counts would miss', async () => {
    const root = await makeTemp('aif-d2-rev-');
    const doc = ['# Reversed', '', '## Usage', '', 'The crossed example )( and the swapped ][ stay visible to the pair rule even though their totals match each other here today.', EN_VOLUME].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    const pairFindings = report.findings.filter((item) => item.rule.id === 'docs-readability:unbalanced-pair');
    assert.ok(pairFindings.length >= 2, 'both reversed pairs are detected');
    assert.ok(pairFindings.some((item) => item.explanation.includes('reversed order: a ) appears before its (')));
    assert.ok(pairFindings.some((item) => item.explanation.includes('reversed order: a ] appears before its [')));
  });

  it('preserves --json for invalid-usage envelopes', () => {
    const parsed = parseReadabilityArgs(['--json', '--nope']);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.json, true, 'the seen --json flag survives the usage error');
    const later = parseReadabilityArgs(['--nope', '--json']);
    assert.equal(later.ok, false);
    assert.equal(later.json, false, 'flags after the error are not honored');
  });

  it('flags crossed nesting across pair kinds that per-pair totals would miss', async () => {
    const root = await makeTemp('aif-d5-crossed-');
    const doc = ['# Crossed', '', '## Usage', '', 'The interleave ([)] sits inside this sentence and the pair rule must flag the crossed order even though both totals match each other here today.', EN_VOLUME].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    const pairFindings = report.findings.filter((item) => item.rule.id === 'docs-readability:unbalanced-pair');
    assert.ok(pairFindings.length >= 1, 'the crossed nesting is detected');
    assert.ok(pairFindings.some((item) => item.explanation.includes('crossed order: a ) appears while a [ is still open')));
  });

  it('degrades the outcome to partial-coverage when only the global finding cap hits', async () => {
    const root = await makeTemp('aif-d6-globalcap-');
    // Three documents stay under the per-document cap (2000) but together
    // cross the global cap (5000): no per-document truncation diagnostic may
    // exist, yet the outcome must not stay complete.
    const docs = ['docs/one.md', 'docs/two.md', 'docs/three.md'].map((name, index) => {
      const filler = '“'.repeat(1750 + index);
      return [name, Buffer.from(`# Cap ${index}\n\n## Description\n\n${filler}\n\n${EN_VOLUME}\n`, 'utf8')];
    });
    await seedProject(root, { files: Object.fromEntries(docs) });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/one.md', '--file', 'docs/two.md', '--file', 'docs/three.md', '--json']);
    assert.equal(run.exitCode, 0, 'the bounded pipeline survives the global cap');
    const report = run.json();
    assert.ok(!report.diagnostics.some((diagnostic) => diagnostic.code === 'findings-truncated' && diagnostic.path !== null),
      'no per-document truncation diagnostic exists');
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'findings-truncated' && diagnostic.path === null),
      'the global truncation diagnostic is present');
    assert.equal(report.state, 'partial-coverage', 'global truncation must not stay complete');
  });
});

// ---------------------------------------------------------------------------
// Review regressions (third round): each test names the defect it pins.
// ---------------------------------------------------------------------------

describe('round two: guard verdict and writer ownership', () => {
  it('fails closed when the stderr merely contains the verdict substring', async () => {
    const injected = async (command, args) => {
      if (args.join(' ').includes('rev-parse')) {
        const error = new Error('Command failed: git rev-parse --is-inside-work-tree');
        error.code = 128;
        error.stderr = 'fatal: detected dubious ownership in repository at D:/not a git repository';
        throw error;
      }
      return { stdout: '' };
    };
    const verdict = await verifyReportIgnored('/fixture', '.ai-factory/state/w/readability/report.json', { execGit: injected });
    assert.equal(verdict.ok, false, 'a substring match must not bypass the guard');
    assert.equal(verdict.code, 'git-verify-failed');
    const genuine = async (command, args) => {
      if (args.join(' ').includes('rev-parse')) {
        const error = new Error('Command failed: git rev-parse --is-inside-work-tree');
        error.code = 128;
        error.stderr = 'fatal: not a git repository (or any of the parent directories): .git\n';
        throw error;
      }
      return { stdout: '' };
    };
    const notGit = await verifyReportIgnored('/fixture', '.ai-factory/state/w/readability/report.json', { execGit: genuine });
    assert.equal(notGit.ok, true, 'the genuine verdict still means not-git');
    assert.equal(notGit.reason, 'not-git');
  });

  it('keeps accepting a legacy report leaf written without language_options', async () => {
    const root = await makeTemp('aif-r2-leaf-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('clean-ru.md') } });
    const write = ['--change', 'work', '--file', 'docs/guide.md', '--write', '--json'];
    assert.equal((await runCli(root, write)).exitCode, 0);
    const leafPath = path.join(root, '.ai-factory', 'state', 'work', 'readability', 'report.json');
    const current = parseStrictJson(await readFile(leafPath, 'utf8'));
    const legacy = { ...current };
    delete legacy.language_options;
    await writeFile(leafPath, `${JSON.stringify(legacy, null, 2)}\n`);
    const overwrite = await runCli(root, write);
    assert.equal(overwrite.exitCode, 0, 'the fix-base form of the same change stays replaceable');
    const rewritten = parseStrictJson(await readFile(leafPath, 'utf8'));
    assert.deepEqual(rewritten.language_options, { override: null });
  });

  it('cross-checks the recorded profile state during revalidation', async () => {
    const root = await makeTemp('aif-r2-state-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('ru-findings.md') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--write', '--json']);
    assert.equal(run.exitCode, 0);
    const stored = parseStrictJson(await readFile(path.join(root, '.ai-factory', 'state', 'work', 'readability', 'report.json'), 'utf8'));
    assert.equal(stored.profile.state, 'loaded');
    const tampered = { ...stored, profile: { ...stored.profile, state: 'unavailable' } };
    const verdict = await validateReportBinding(root, tampered);
    assert.equal(verdict.stale, true);
    assert.ok(verdict.mismatched.includes('profile'), 'a flipped profile state is named');
  });

  it('degrades a malformed phrase list to checker-unavailable instead of crashing', async () => {
    const root = await makeTemp('aif-r2-phr-');
    await seedProject(root, { files: { 'docs/guide.md': await fixtureBuffer('ru-findings.md') } });
    const badProfile = JSON.stringify({
      schema: 'aifhub.docs_readability_profile.v1', profile_id: 'x', profile_version: 1,
      rules: [{ id: 'docs-readability:ru-cliche', version: 1, origin: 'project', type: 'phrase-list', language: 'ru', phrases: ['valid', 42] }],
    });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json'], {
      readProfile: async () => Buffer.from(badProfile, 'utf8'),
    });
    assert.equal(run.exitCode, 0, 'profile degradation stays exit 0, never a crash');
    const report = run.json();
    assert.equal(report.state, 'checker-unavailable');
    assert.equal(report.profile.state, 'unavailable');
  });
});

describe('round two: paragraph and section boundaries', () => {
  it('keeps two unterminated paragraphs separate across a blank line', async () => {
    const root = await makeTemp('aif-r2-par-');
    const baseWords = ['абзац', 'без', 'точки', 'в', 'конце', 'строки', 'продолжается', 'мыслью', 'документа', 'на', 'всём', 'протяжении', 'каждого', 'предложения', 'текста', 'проекта'];
    const firstParagraph = baseWords.join(' ');
    const secondParagraph = [...baseWords, 'и', 'вторая', 'часть', 'тоже', 'без', 'пунктуации', 'в', 'самом', 'конце', 'всего', 'текста', 'документа', 'целиком', 'совсем'].join(' ');
    const doc = [
      '# Документ без пунктуации',
      '',
      '## Описание',
      '',
      firstParagraph,
      '',
      secondParagraph,
    ].join('\n');
    const words = (match) => match.match(/[\p{L}\p{N}]+/gu).length;
    const first = words(firstParagraph);
    const second = words(secondParagraph);
    const merged = first + second;
    assert.ok(first <= 30 && second <= 30 && merged > 30, `fixture: first=${first}, second=${second}, merged=${merged}`);
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    const long = report.findings.filter((item) => item.rule.id === 'docs-readability:sentence-length'
      && item.explanation.includes(`${merged} words`));
    assert.deepEqual(long, [], 'paragraphs must not merge across the blank line');
    assert.deepEqual(report.findings.filter((item) => item.rule.id === 'docs-readability:sentence-length'), [],
      'each paragraph alone stays within the threshold');
  });

  it('does not merge a heading with the following 30-word paragraph', async () => {
    const root = await makeTemp('aif-r2-head-');
    const bodyWords = ['ровно', 'тридцать', 'слов', 'идут', 'внутри', 'этого', 'абзаце', 'без', 'единой', 'терминальной',
      'точки', 'чтобы', 'старый', 'алгоритм', 'склейки', 'заголовка', 'или', 'абзаца', 'сформировал', 'ложную',
      'находку', 'длины', 'предложения', 'однако', 'новый', 'алгоритм', 'оставил', 'итоговый', 'результат', 'везде'];
    const body = bodyWords.join(' ');
    assert.equal(bodyWords.length, 30, 'fixture must be exactly 30 words');
    const doc = ['# Doc', '', '## Описание', '', body].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete', 'the 30-word paragraph plus short heading stays under the detector threshold and description limit');
    assert.deepEqual(report.findings.filter((item) => item.rule.id === 'docs-readability:sentence-length'), [],
      'heading words must not merge with the following paragraph');
  });

  it('recognizes a BOM-prefixed H2 heading for classification', () => {
    const text = '\uFEFF## Установка\n\nПервый абзац документа с обычным текстом для контекста классификации секций и проверки заголовка с байт-порядка маркером в начале файла проекта.';
    const model = buildDocumentModel(text);
    const sections = buildSections(model);
    assert.equal(sections[0].sectionClass, 'procedure', 'the BOM-prefixed H2 is classified');
  });

  it('keeps a fenced block inside closed front matter from masking the body', async () => {
    const root = await makeTemp('aif-r2-fm3-');
    const doc = [
      '---',
      'title: fixture',
      'blocks:',
      '  ```yaml',
      '  key: value',
      '  ```',
      '---',
      '',
      '## Usage',
      '',
      'The body keeps enough latin letters for confident language detection because detectors require solid evidence before committing to any language decision for the document here today.',
      'Second sentence adds the remaining letter volume the deterministic share estimator needs for a confident verdict today.',
    ].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.inputs[0].parsing, 'full', 'closed front matter must not trip fence state');
    assert.ok(report.inputs[0].eligible_bytes > 0, 'body prose stays eligible');
    assert.ok(!report.diagnostics.some((diagnostic) => diagnostic.code === 'parser-uncovered-span'));
    assert.equal(report.state, 'complete');
  });
});

describe('round two: inline constructs', () => {
  it('keeps Wikipedia-style balanced link destinations fully excluded', async () => {
    const root = await makeTemp('aif-r2-wiki-');
    const doc = [
      '# Wiki',
      '',
      '## Usage',
      '',
      'See [the article](https://en.wikipedia.org/wiki/Use_(section)) for background and keep the surrounding prose balanced so no false unbalanced pair finding can ever appear inside this sentence of the document today.',
      'Second sentence adds enough letters for confident language detection by the deterministic share estimator used here today.',
    ].join('\n');
    const bytes = Buffer.from(doc, 'utf8');
    await seedProject(root, { files: { 'docs/guide.md': bytes } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.ok(!ruleIds(report).includes('docs-readability:unbalanced-pair'), 'balanced parens in the destination leave no phantom close paren');
    const urlStart = bytes.indexOf(Buffer.from('https://en.wikipedia.org', 'utf8'));
    const urlEnd = bytes.indexOf(Buffer.from('))', 'utf8'), urlStart) + 2;
    for (const finding of report.findings) {
      const insideUrl = finding.span.start >= urlStart && finding.span.end <= urlEnd;
      assert.ok(!insideUrl, 'no finding may live inside the balanced link target');
    }
    assert.equal(report.state, 'complete');
  });

  it('excludes multi-line inline code spans from prose rules', async () => {
    const root = await makeTemp('aif-r2-code-');
    const doc = [
      '# Code spans',
      '',
      '## Usage',
      '',
      'Prose before the span `code begins on this line',
      'utilize the continuation across the newline` and the sentence keeps going for the detection evidence purposes of the document.',
      'Second paragraph adds enough letters for confident language detection by the deterministic share estimator used here today.',
    ].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    assert.ok(!ruleIds(report).includes('docs-readability:en-cliche'), 'the cross-line span cliche stays out of findings');
  });

  it('treats an indented continuation inside a list item as prose', async () => {
    const root = await makeTemp('aif-r2-list-');
    const doc = [
      '# Lists',
      '',
      '## Usage',
      '',
      '- item',
      '',
      '    utilize the four-space continuation inside the list item paragraph without any code semantics at all.',
      '',
      'Second paragraph adds enough letters for confident language detection by the deterministic share estimator used here today.',
    ].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    const cliche = report.findings.find((item) => item.rule.id === 'docs-readability:en-cliche'
      && item.explanation.includes('utilize'));
    assert.ok(cliche, 'the four-space list continuation stays prose (found by rules)');
  });

  it('still treats a deep indented line after a list item as code', async () => {
    const root = await makeTemp('aif-r2-list2-');
    const doc = [
      '# Lists deep',
      '',
      '## Usage',
      '',
      '- item',
      '',
      '      utilize the six-space line inside the list item that really is code semantics here.',
      '',
      'Second paragraph adds enough letters for confident language detection by the deterministic share estimator used here today and keeps the remaining volume above the threshold that the deterministic share estimator requires before committing to any language decision for the analyzed document.',
    ].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.equal(report.state, 'complete');
    assert.ok(!ruleIds(report).includes('docs-readability:en-cliche'), 'the six-space line is code');
  });

  it('excludes an indented code line that directly follows a heading', async () => {
    const root = await makeTemp('aif-r2-head2-');
    const doc = [
      '# Heading code',
      '',
      '## Установка',
      '    в рамках данного процесса строка сразу после заголовка',
      '',
      'Второй абзац содержит достаточное количество букв кириллицы для уверенной детекции языка всего документа целиком.',
    ].join('\n');
    await seedProject(root, { files: { 'docs/guide.md': Buffer.from(doc, 'utf8') } });
    const run = await runCli(root, ['--change', 'work', '--file', 'docs/guide.md', '--json']);
    const report = run.json();
    assert.ok(!ruleIds(report).includes('docs-readability:ru-cliche'), 'indented line right after a heading is code');
  });
});

