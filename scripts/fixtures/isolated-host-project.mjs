// Explicit host smoke fixture. No Orca calls, external installation or automatic cleanup.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
export async function createIsolatedHostProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-orca-smoke-'));
  const files = {
    '.gitignore': '.ai-factory/\n.agents/\n.codex/\n.ai-factory.json\n.repowise/\n',
    '.gitattributes': '* text=auto eol=lf\n',
    'package.json': JSON.stringify({ name: 'aifhub-owned-host-smoke', private: true, scripts: { test: 'node --test test/*.test.cjs' } }, null, 2)+'\n',
    'README.md': '# AIFHub owned host smoke fixture\n\nNo dependencies, network, credentials, publication or service setup. Implement only the assigned canonical task and use the installed AIFHub workflow.\n',
    'AGENTS.md': '# Fixture instructions\n\nThis repository is a disposable, explicitly authorized AIFHub host smoke. Use installed .codex/skills and .ai-factory/extensions/aifhub-extension instructions for your assigned role. Do not commit, publish, install tools, modify tests/canonical tasks, or create nested workers. The parent owns task progress and verification. Preserve outside.txt and other tasks. An initial coordinator admission question is a fixture synchronization step, not a question for the human.\n',
    '.ai-factory/config.yaml': 'aifhub:\n  tools:\n    openspec: true\n',
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/specs/.gitkeep': '',
    'openspec/changes/host-smoke/proposal.md': '# Fixture proposal\n\nImplement two independent pure functions with the behavior specified by their checked-in Node tests. No external services or new dependencies.\n',
    'openspec/changes/host-smoke/design.md': '# Fixture design\n\nKeep two CommonJS exports independent. Existing checked-in tests are acceptance examples, must remain unchanged, and run with Node. Run the affected file test after each implementation, and the complete suite after both tasks are integrated.\n',
    'openspec/changes/host-smoke/tasks.md': '- [ ] 1.1 Implement clamp(value, min, max) in src/clamp.cjs. Verify: node --test test/clamp.test.cjs.\n- [ ] 1.2 Implement slug(value) in src/slug.cjs. Verify: node --test test/slug.test.cjs.\n',
    'openspec/changes/host-smoke/specs/functions/spec.md': '# Functions\n\n## ADDED Requirements\n\n### Requirement: Clamp finite numbers\nThe clamp export SHALL bound finite numeric values to ordered finite numeric limits, reject nonnumeric or nonfinite inputs with TypeError, and reject reversed limits with RangeError.\n\n#### Scenario: Clamp outside bounds\n- **WHEN** clamp(-2, 0, 8) or clamp(20, 0, 8) is called\n- **THEN** the result is 0 or 8 respectively\n\n### Requirement: Normalize ASCII slugs\nThe slug export SHALL accept strings only, lowercase ASCII letters, replace runs of non-ASCII-alphanumeric characters with one hyphen, remove edge hyphens, and reject nonstrings with TypeError.\n\n#### Scenario: Normalize punctuation\n- **WHEN** slug("  Hello, WORLD!! ") is called\n- **THEN** the result is "hello-world"\n',
    'src/clamp.cjs': 'module.exports = (value, min, max) => value;\n',
    'src/slug.cjs': 'module.exports = value => value;\n',
    'outside.txt': 'Fixture baseline data.\n',
    'test/clamp.test.cjs': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst clamp = require('../src/clamp.cjs');\ntest('clamp bounds finite numbers and rejects invalid inputs', () => {\n  assert.equal(clamp(5, 1, 9), 5); assert.equal(clamp(-2, 0, 8), 0); assert.equal(clamp(20, 0, 8), 8); assert.equal(clamp(3, 2, 2), 2);\n  for (const args of [[NaN,0,1],[1,Infinity,2],['1',0,2],[1,0,Infinity]]) assert.throws(() => clamp(...args), TypeError);\n  assert.throws(() => clamp(1,3,2), RangeError);\n});\n",
    'test/slug.test.cjs': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst slug = require('../src/slug.cjs');\ntest('slug normalizes ASCII words and rejects nonstrings', () => {\n  assert.equal(slug('  Hello, WORLD!! '), 'hello-world'); assert.equal(slug('a---b__c'), 'a-b-c'); assert.equal(slug('...'), ''); assert.equal(slug('A1 b2'), 'a1-b2');\n  for (const value of [null,42,{},undefined]) assert.throws(() => slug(value), TypeError);\n});\n",
  };
  for (const [name, contents] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), contents); }
  const git = args => exec('git', args, { cwd: root, windowsHide: true });
  await git(['init', '-q', '-b', 'main']); await git(['config', 'core.autocrlf', 'false']); await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'host smoke fixture']);
  await writeFile(path.join(root, 'outside.txt'), 'Pre-existing dirty fixture data must survive.\n');
  return { root, change_id: 'host-smoke', source_files: Object.keys(files), baseline_head: (await git(['rev-parse', 'HEAD'])).stdout.trim() };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.slice(2).join(' ') !== '--create') throw new Error('Explicit --create required');
  process.stdout.write(JSON.stringify(await createIsolatedHostProject())+'\n');
}
