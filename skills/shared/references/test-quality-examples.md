# Test quality examples

Use the project's actual requirements and existing test utilities. These small JavaScript examples show why an independent expectation and a bounded readiness condition matter; they do not prescribe a project API or require JavaScript for other stacks.

## Independent expectation

Suppose the requirement for `pageCount(total, size)` is zero pages for no items, otherwise enough pages to hold every item. This assertion cannot detect incorrect rounding, because the production function supplies both sides:

<!-- example: mirror-assertion -->
```js
assert.equal(pageCount(11, 5), pageCount(11, 5));
```

These expectations follow directly from the requirement. In particular, two pages cannot hold eleven items at five per page. Replacing ceiling with floor in production must fail the last assertion; returning one page for an empty input must fail the first.

<!-- example: independent-expectations -->
```js
assert.equal(pageCount(0, 5), 0);
assert.equal(pageCount(1, 5), 1);
assert.equal(pageCount(10, 5), 2);
assert.equal(pageCount(11, 5), 3);
```

## Controlled readiness

Prefer an existing project wait facility. This minimal fallback illustrates a synchronous boolean readiness predicate and an injectable monotonic clock/delay. The predicate must return promptly; use bounded, cancellable operations for an asynchronous predicate instead. Readiness must be observed before the deadline, including after a delayed timer callback.

<!-- example: condition-wait -->
```js
async function waitUntil(isReady, {
  timeoutMs,
  intervalMs = 10,
  now = () => performance.now(),
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0
      || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('Use a finite positive timeout and polling interval');
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    if (now() >= deadline) throw new Error('Readiness deadline exceeded');
    const ready = isReady();
    if (typeof ready !== 'boolean') throw new TypeError('Readiness must be a synchronous boolean');
    if (now() >= deadline) throw new Error('Readiness deadline exceeded');
    if (ready) return;
    await delay(Math.min(intervalMs, deadline - now()));
  }
}
```

The executable checks use an injected clock: immediate and delayed readiness succeed; an unmet condition and a timer overshooting the deadline fail; predicate errors propagate. No real sleep is needed to establish these outcomes.

This example does not test debounce or throttle duration. For such a requirement, advance a controlled clock to just before the specified boundary and assert no effect, then advance to the boundary and assert the required effect. An eventual-success assertion would lose that timing guarantee.
