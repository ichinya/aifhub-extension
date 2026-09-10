# Ordered test-pollution trials

Keep the original suite and target symptom before reducing predecessors. This synchronous example runs explicit steps in one process with fresh fixture-owned state. It never relies on `node --test` discovery order and never deletes files. Steps and the target must return promptly; use the project's bounded subprocess facility for potentially blocking work. Retain the existing caller attempt guard as well as this per-investigation trial budget.

<!-- example: ordered-trials -->
```js
function createTrials({budget, deadline, now, createState, steps, target, seed}) {
  if (!Number.isSafeInteger(budget) || budget < 1 || !Number.isFinite(deadline))
    throw new RangeError('Finite trial budget and deadline required');
  const history = [];
  function trial(ids) {
    if (history.length >= budget || now() >= deadline)
      return {outcome: 'budget-exhausted'};
    if (!Array.isArray(ids) || ids.some(id => typeof steps[id] !== 'function'))
      throw new TypeError('Use known predecessor IDs');
    const state = createState(seed); // Only this fixture owns this fresh state.
    let outcome;
    try {
      for (const id of ids) {
        if (now() >= deadline) {
          outcome = 'deadline-exhausted';
          break;
        }
        const step = steps[id];
        step(state);
      }
      outcome ??= now() >= deadline ? 'deadline-exhausted' : target(state);
      if (!['target-symptom', 'clean', 'deadline-exhausted'].includes(outcome))
        throw new TypeError('Unexpected target result');
    } catch {
      outcome = 'unrelated-failure'; // Keep it distinct from the selected symptom.
    }
    if (now() >= deadline) outcome = 'deadline-exhausted';
    const result = {attempt: history.length + 1, seed, ids: [...ids], outcome};
    history.push(result);
    return result;
  }
  return {trial, history};
}
```

Create this controller once per investigation; do not recreate it to reset attempts. `steps` contains the known predecessors and `target` distinguishes the selected symptom from a clean result. The caller preserves original relative order when choosing a subset. Run target-alone (`trial([])`), the original predecessors, then a small number of symptom-preserving deletions. Compare exact outcomes, not merely process success/failure. Never treat `unrelated-failure`, a deadline or missing setup as the target symptom.

A cache seeded by a blue-tenant predecessor can corrupt a red-tenant target. With a separate legacy-mode predecessor, neither half alone fails: retain both. Adding a cache-reset predecessor may suppress that interaction, so binary search assuming monotonicity is unsound. Try complements or smaller deletions within the same budget and report a useful causal sequence without claiming global minimality. After repairing tenant isolation, execute original and reduced scenarios separately. The literal example is exercised against single/joint pollution, masking reset, unrelated errors and finite-budget outcomes in `scripts/superpowers-reproduction-examples.test.mjs`; those checks validate the recipe, not a model's investigation quality.
