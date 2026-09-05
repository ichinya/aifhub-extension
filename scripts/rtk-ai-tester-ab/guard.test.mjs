import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contained, tokens, execute } from './guard.mjs';

test('bounds reject traversal, absolute outside paths, and junction escape', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-ab-guard-test-'));
  const project = path.join(base, 'project'), hidden = path.join(base, 'hidden');
  fs.mkdirSync(project); fs.mkdirSync(hidden);
  fs.writeFileSync(path.join(project, 'source.txt'), 'source');
  fs.symlinkSync(hidden, path.join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(contained(project, 'source.txt'), path.join(project, 'source.txt'));
  for (const input of ['../hidden/grader.json', hidden, 'link/grader.json', '.']) assert.throws(() => contained(project, input));
  assert.ok(fs.realpathSync(base).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  fs.rmSync(base, { recursive: true });
});

test('no command substitution or free shell execution', () => {
  assert.deepEqual(tokens('git diff -- "a file"'), ['git', 'diff', '--', 'a file']);
  for (const input of ['git diff; whoami', 'git diff | cat', 'git $(whoami)', 'git %SECRET%', 'git `id`', 'git diff\nwhoami', 'git  diff']) assert.throws(() => tokens(input));
  assert.throws(() => execute({ dispatch: {} }, '.', 'node -e evil()'), /allowlist/);
});
