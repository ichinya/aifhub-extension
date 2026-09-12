import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseStrictJson } from './json-strict.mjs';

// Deterministic PRNG (mulberry32): the corpus is reproducible per seed and the
// whole run stays fast, so a failure always reoccurs with the same input.
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(random, depth) {
  const pick = random();
  if (depth <= 0 || pick < 0.2) {
    const scalar = random();
    if (scalar < 0.25) return null;
    if (scalar < 0.5) return scalar < 0.375;
    if (scalar < 0.75) return randomString(random);
    if (scalar < 0.85) return 0;
    if (scalar < 0.95) return Number((random() * 1000).toFixed(3));
    return Number((random() * 10).toExponential(2).replace('e+', 'e'));
  }
  if (pick < 0.6) return randomObject(random, depth - 1);
  return Array.from({ length: 1 + Math.floor(random() * 4) }, () => randomValue(random, depth - 1));
}

function randomObject(random, depth) {
  const object = {};
  for (const key of uniqueKeys(random, 1 + Math.floor(random() * 4))) object[key] = randomValue(random, depth);
  return object;
}

function uniqueKeys(random, count) {
  const keys = new Set();
  while (keys.size < count) keys.add(randomKey(random));
  return [...keys];
}

function randomKey(random) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const length = 1 + Math.floor(random() * 6);
  return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
}

function randomString(random) {
  const pool = ['plain', 'with space', 'quote"x', 'back\\\\slash', 'unicode \\u00e9', 'surrogate \\ud83d\\ude00', 'tab\\t', 'nul\\u0000'];
  return pool[Math.floor(random() * pool.length)] + Math.floor(random() * 1000);
}

describe('parseStrictJson property coverage', () => {
  it('round-trips every generated JSON.parse-valid value', () => {
    const random = prng(0x5eed168);
    for (let index = 0; index < 300; index += 1) {
      const value = randomValue(random, 5);
      const serialized = JSON.stringify(value);
      assert.deepEqual(parseStrictJson(serialized), JSON.parse(serialized), serialized);
    }
  });

  it('rejects raw and escaped duplicate keys at any nesting level', () => {
    const random = prng(0xd00d1e5);
    for (let index = 0; index < 300; index += 1) {
      const keys = uniqueKeys(random, 1 + Math.floor(random() * 4));
      const victim = keys[Math.floor(random() * keys.length)];
      const members = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(randomValue(random, 2))}`);
      const escaped = [...victim].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
      const duplicateKey = random() < 0.5 ? JSON.stringify(victim) : `"${escaped}"`;
      let text = `{${members.join(',')},${duplicateKey}:${JSON.stringify(randomValue(random, 1))}}`;
      const wrappers = Math.floor(random() * 3);
      for (let w = 0; w < wrappers; w += 1) {
        text = random() < 0.5 ? `[${JSON.stringify(randomValue(random, 0))},${text}]` : `{"w${w}":${text}}`;
      }
      assert.throws(() => parseStrictJson(text), /duplicate_json_key/, text);
    }
  });

  it('keeps sanity anchors for literals, exponents, and depth limits', () => {
    assert.deepEqual(parseStrictJson('0.5'), 0.5);
    assert.deepEqual(parseStrictJson('[1.2e-3, true, false, null, "\\u0041"]'), [0.0012, true, false, null, 'A']);
    assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate_json_key/);
    assert.throws(() => parseStrictJson('{"\\u0061":1,"a":2}'), /duplicate_json_key/);
    assert.throws(() => parseStrictJson('['.repeat(150) + ']'.repeat(150)), /invalid_json/);
    assert.throws(() => parseStrictJson('not json'), /invalid_json/);
    assert.throws(() => parseStrictJson(42), /invalid_json/);
  });
});
