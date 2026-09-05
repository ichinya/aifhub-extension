// Execute the exact examples shipped with the shared skill against faulty code and a controlled clock.
// This validates the examples, not arbitrary model compliance with the instructions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const examples = await readFile(new URL('../skills/shared/references/test-quality-examples.md', import.meta.url), 'utf8');

function example(name) {
  const pattern = new RegExp('<!-- example: ' + name + ' -->\\r?\\n```js\\r?\\n([\\s\\S]*?)\\r?\\n```', 'g');
  const matches = [...examples.matchAll(pattern)];
  assert.equal(matches.length, 1, `Expected one executable ${name} example`);
  return matches[0][1];
}

const mirroredCheck = new Function('assert', 'pageCount', example('mirror-assertion'));
const independentCheck = new Function('assert', 'pageCount', example('independent-expectations'));
const waitUntil = new Function(`${example('condition-wait')}\nreturn waitUntil;`)();

function controlledClock(timeoutMs = 40, intervalMs = 7) {
  let time = 0;
  const delays = [];
  return {
    delays,
    get time() { return time; },
    options: {
      timeoutMs,
      intervalMs,
      now: () => time,
      delay: async (ms) => { delays.push(ms); time += ms; }
    }
  };
}

describe('Executable shared test-quality examples', () => {
  it('accepts the required page count behavior', () => {
    independentCheck(assert, (total, size) => Math.ceil(total / size));
  });

  for (const [name, faulty] of [
    ['rounding down drops a partial page', (total, size) => Math.floor(total / size)],
    ['an empty result gets a spurious page', (total, size) => Math.max(1, Math.ceil(total / size))]
  ]) {
    it(`exposes a mirror assertion that misses: ${name}`, () => {
      assert.doesNotThrow(() => mirroredCheck(assert, faulty));
      assert.throws(() => independentCheck(assert, faulty), { code: 'ERR_ASSERTION' });
    });
  }

  it('returns immediately for observed readiness without any sleep', async () => {
    const clock = controlledClock();
    await waitUntil(() => true, clock.options);
    assert.equal(clock.time, 0);
    assert.deepEqual(clock.delays, []);
  });

  for (const readyAt of [1, 17, 38]) {
    it(`waits for readiness at ${readyAt} without depending on wall-clock speed`, async () => {
      const clock = controlledClock(60);
      await waitUntil(() => clock.time >= readyAt, clock.options);
      assert.ok(clock.time >= readyAt, 'must observe actual readiness');
      assert.ok(clock.time < readyAt + 7, 'should finish at the first ready poll');
      assert.ok(clock.delays.every(ms => ms > 0 && ms <= 7));
    });
  }

  it('fails at a finite deadline when readiness never arrives', async () => {
    const clock = controlledClock(20, 7);
    await assert.rejects(waitUntil(() => false, clock.options), /Readiness deadline exceeded/);
    assert.equal(clock.time, 20);
    assert.deepEqual(clock.delays, [7, 7, 6]);
  });

  it('does not turn deadline expiry into eventual success', async () => {
    const clock = controlledClock(20, 7);
    await assert.rejects(waitUntil(() => clock.time >= 20, clock.options), /Readiness deadline exceeded/);
    assert.equal(clock.time, 20);
  });

  it('rejects readiness after an overshooting timer callback', async () => {
    let time = 0;
    let polls = 0;
    await assert.rejects(waitUntil(() => { polls += 1; return time >= 5; }, {
      timeoutMs: 20,
      intervalMs: 7,
      now: () => time,
      delay: async () => { time = 100; }
    }), /Readiness deadline exceeded/);
    assert.equal(polls, 1, 'must not accept a ready observation after expiry');
  });

  it('propagates unexpected predicate errors without retrying', async () => {
    const clock = controlledClock();
    const failure = new Error('readiness source failed');
    await assert.rejects(waitUntil(() => { throw failure; }, clock.options), error => error === failure);
    assert.deepEqual(clock.delays, []);
  });

  it('does not accept a predicate that returns true after consuming the deadline', async () => {
    let time = 0;
    await assert.rejects(waitUntil(() => { time = 20; return true; }, {
      timeoutMs: 20,
      now: () => time,
      delay: async () => assert.fail('must not sleep after expiry')
    }), /Readiness deadline exceeded/);
  });

  it('does not treat a promise as a truthy readiness result', async () => {
    const clock = controlledClock();
    await assert.rejects(waitUntil(() => Promise.resolve(false), clock.options), /synchronous boolean/);
    assert.deepEqual(clock.delays, []);
  });

  it('rejects unbounded timeouts and non-progressing polling intervals', async () => {
    for (const [field, value] of [
      ['timeoutMs', 0], ['timeoutMs', -1], ['timeoutMs', Infinity], ['timeoutMs', NaN],
      ['intervalMs', 0], ['intervalMs', -1], ['intervalMs', Infinity]
    ]) {
      const clock = controlledClock();
      await assert.rejects(waitUntil(() => false, { ...clock.options, [field]: value }), RangeError);
      assert.deepEqual(clock.delays, []);
    }
  });
});
