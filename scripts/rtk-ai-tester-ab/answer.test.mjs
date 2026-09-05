import test from 'node:test';
import assert from 'node:assert/strict';
import { answerObject } from './answer.mjs';

test('extracts one structured answer despite prose, fences and quoted braces', () => {
  assert.deepEqual(answerObject('Result:\n```json\n{"repair":"if (err) { return; }","rows":[{"n":12}]}\n</parameter>\n```'), { repair: 'if (err) { return; }', rows: [{ n: 12 }] });
  assert.deepEqual(answerObject('{"text":"escaped \\\"quote\\\""}'), { text: 'escaped "quote"' });
  assert.deepEqual(answerObject('Fix: if err != nil { return "", err }\n{"verdict":"unsafe"}'), { verdict: 'unsafe' });
});

test('ambiguous, truncated, malformed and absent answers fail closed', () => {
  for (const value of ['', 'done', '{"ok":true', '{bad}', '{"ok":true} {"ok":false}', '{"ok":true} {']) assert.equal(answerObject(value), null);
});
