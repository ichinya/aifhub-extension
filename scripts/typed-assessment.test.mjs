// typed-assessment.test.mjs - shared typed-assessment helper contract tests.
// Pure in-process tests: no filesystem, no network, no SDK, no keys, no paid
// calls (AC5). Fake assessors are injected functions; a disabled/no-call fake
// follows the mustNotRun pattern from validation-providers.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSESSMENT_COVERAGE_STATES,
  ASSESSMENT_FRESHNESS_STATES,
  ASSESSMENT_RUN_STATES,
  assessmentCanonical,
  buildAssessmentBinding,
  notRunAssessment,
  normalizeAssessmentLimits,
  runTypedAssessment,
  validateAssessmentObservation,
} from './typed-assessment.mjs';

const mustNotRun = () => { throw new Error('must not execute'); };

describe('typed-assessment binding', () => {
  it('produces a deterministic digest independent of key order', () => {
    const left = buildAssessmentBinding({
      change_id: 'work', inputs: [{ path: 'a.md', sha256: 'ab'.repeat(32) }],
      profile: { sha256: 'cd'.repeat(32), version: 1 }, language: 'ru',
    });
    const right = buildAssessmentBinding({
      language: 'ru', profile: { version: 1, sha256: 'cd'.repeat(32) },
      inputs: [{ sha256: 'ab'.repeat(32), path: 'a.md' }], change_id: 'work',
    });
    assert.equal(left, right);
    assert.match(left, /^[a-f0-9]{64}$/);
  });

  it('diverges when any bound revision changes', () => {
    const base = { inputs: [{ path: 'a.md', sha256: 'aa'.repeat(32) }], profile: { sha256: 'bb'.repeat(32) } };
    const changedInput = buildAssessmentBinding({ ...base, inputs: [{ path: 'a.md', sha256: 'cc'.repeat(32) }] });
    const changedProfile = buildAssessmentBinding({ ...base, profile: { sha256: 'dd'.repeat(32) } });
    const changedTarget = buildAssessmentBinding({ ...base, change_id: 'other' });
    const reference = buildAssessmentBinding(base);
    assert.notEqual(changedInput, reference);
    assert.notEqual(changedProfile, reference);
    assert.notEqual(changedTarget, reference);
  });

  it('rejects volatile key material at any depth', () => {
    for (const key of ['timestamp', 'generated_at', 'run_id', 'cost', 'elapsed_ms']) {
      assert.throws(() => buildAssessmentBinding({ [key]: 1 }), key);
      assert.throws(() => buildAssessmentBinding({ nested: { deeper: { [key]: 'x' } } }), key);
      assert.throws(() => buildAssessmentBinding({ list: [{ [key]: 'x' }] }), key);
    }
  });

  it('canonicalizes arrays and nested objects deterministically', () => {
    assert.equal(assessmentCanonical({ b: [1, { a: 2 }], a: 'x' }), '{"a":"x","b":[1,{"a":2}]}');
    assert.equal(assessmentCanonical('raw'), '"raw"');
  });
});

describe('typed-assessment honest outcomes', () => {
  it('exposes closed state vocabularies', () => {
    assert.deepEqual([...ASSESSMENT_RUN_STATES], ['complete', 'failed', 'not_run']);
    assert.deepEqual([...ASSESSMENT_FRESHNESS_STATES], ['current', 'stale']);
    assert.deepEqual([...ASSESSMENT_COVERAGE_STATES], ['full', 'partial', 'none']);
  });

  it('builds a not_run outcome that carries no findings', () => {
    const outcome = notRunAssessment('requirement-lint-disabled', [{ code: 'x', path: null, detail: null }]);
    assert.equal(outcome.run_status, 'not_run');
    assert.equal(outcome.freshness, 'current');
    assert.deepEqual(outcome.findings, []);
    assert.equal(outcome.coverage.state, 'none');
    assert.ok(outcome.diagnostics.some((entry) => entry.code === 'assessment-not-run'));
  });

  it('completes a fake assessor and preserves consumer-shaped findings', async () => {
    const finding = { finding_type: 'fake', refs: [] };
    const outcome = await runTypedAssessment({
      assessor: async () => ({ findings: [finding], diagnostics: [] }),
      input: { documents: [] },
      coverage: { state: 'full', declared_sources: 2, scanned_sources: 2, missing_sources: [] },
      limits: { deadlineMs: 5000, maxFindings: 10, maxDiagnostics: 5 },
    });
    assert.equal(outcome.run_status, 'complete');
    assert.equal(outcome.freshness, 'current');
    assert.equal(outcome.abstained, false);
    assert.deepEqual(outcome.findings, [finding]);
    assert.equal(outcome.coverage.state, 'full');
  });

  it('truncates unbounded findings and records the truncation diagnostic', async () => {
    const outcome = await runTypedAssessment({
      assessor: async () => ({ findings: Array.from({ length: 8 }, () => ({ n: 1 })), diagnostics: [] }),
      coverage: { state: 'full' },
      limits: { maxFindings: 3, maxDiagnostics: 10 },
    });
    assert.equal(outcome.findings.length, 3);
    assert.ok(outcome.diagnostics.some((entry) => entry.code === 'findings-truncated'));
  });

  it('maps an abstention to finding-free none coverage without a positive verdict', async () => {
    const outcome = await runTypedAssessment({
      assessor: async () => ({ abstain: true, reason: 'declined' }),
      coverage: { state: 'full', declared_sources: 3, scanned_sources: 3, missing_sources: [] },
    });
    assert.equal(outcome.run_status, 'complete');
    assert.equal(outcome.abstained, true);
    assert.deepEqual(outcome.findings, []);
    assert.equal(outcome.coverage.state, 'none');
    assert.ok(outcome.diagnostics.some((entry) => entry.code === 'assessor-abstain'));
  });

  it('maps explicit failure, throws, and invalid output to failed with no findings', async () => {
    for (const [name, assessor] of Object.entries({
      explicit: async () => ({ ok: false, code: 'provider-down' }),
      thrown: async () => { throw new Error('boom'); },
      'non-object': async () => 'nope',
      'array-findings': async () => ({ findings: 'nope' }),
    })) {
      const outcome = await runTypedAssessment({
        assessor, coverage: { state: 'full' }, limits: { deadlineMs: 5000 },
      });
      assert.equal(outcome.run_status, 'failed', name);
      assert.deepEqual(outcome.findings, [], name);
      assert.equal(outcome.abstained, false, name);
      assert.ok(outcome.diagnostics.length > 0, name);
    }
    const missing = await runTypedAssessment({ assessor: undefined, coverage: { state: 'full' } });
    assert.equal(missing.run_status, 'not_run');
    assert.deepEqual(missing.findings, []);
    assert.ok(missing.diagnostics.some((entry) => entry.code === 'assessment-not-run'));
  });

  it('fails closed on a hard deadline cutoff without presenting abandoned output', async () => {
    const outcome = await runTypedAssessment({
      assessor: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 5000).unref?.(); });
        return { findings: [{ late: true }], diagnostics: [] };
      },
      coverage: { state: 'full' },
      limits: { deadlineMs: 60 },
    });
    assert.equal(outcome.run_status, 'failed');
    assert.deepEqual(outcome.findings, []);
    assert.ok(outcome.diagnostics.some((entry) => entry.code === 'deadline-exceeded'));
  });

  it('marks the outcome stale when inputs or rubric drift during the scan', async () => {
    let drift = false;
    const outcome = await runTypedAssessment({
      assessor: async () => { drift = true; return { findings: [{ n: 1 }], diagnostics: [] }; },
      coverage: { state: 'full' },
      watch: { changed: async () => drift },
    });
    assert.equal(outcome.freshness, 'stale');
    assert.ok(outcome.diagnostics.some((entry) => entry.code === 'assessment-stale'));
  });

  it('keeps a pre-drift outcome stale and finding-free for a not_run scan', async () => {
    const outcome = await runTypedAssessment({
      assessor: undefined,
      coverage: { state: 'none' },
      watch: { changed: async () => true },
      limits: { deadlineMs: 1000 },
    });
    assert.equal(outcome.run_status, 'not_run');
    assert.equal(outcome.freshness, 'stale');
    assert.deepEqual(outcome.findings, []);
  });

  it('treats a must-not-run assessor that still executed as a failed scan', async () => {
    const outcome = await runTypedAssessment({
      assessor: mustNotRun,
      coverage: { state: 'none' },
      limits: { deadlineMs: 1000 },
    });
    assert.equal(outcome.run_status, 'failed');
    assert.deepEqual(outcome.findings, []);
    assert.ok(outcome.diagnostics.some((entry) => entry.code === 'assessor-error'));
  });

  it('normalizes malformed coverage and limits instead of trusting them', async () => {
    assert.deepEqual(normalizeAssessmentLimits({ deadlineMs: -5, maxFindings: 1.7, maxDiagnostics: 'x' }),
      { deadlineMs: 1, maxFindings: 1, maxDiagnostics: 200 });
    assert.deepEqual(normalizeAssessmentLimits(null), { deadlineMs: 30000, maxFindings: 500, maxDiagnostics: 200 });
    assert.deepEqual(normalizeAssessmentLimits('x'), { deadlineMs: 30000, maxFindings: 500, maxDiagnostics: 200 });
    assert.deepEqual(normalizeAssessmentLimits({ maxDiagnostics: 0 }).maxDiagnostics, 1, 'zero budget still leaves the marker slot');
    const outcome = await runTypedAssessment({
      assessor: async () => ({ findings: [], diagnostics: [] }),
      coverage: { state: 'bogus', declared_sources: 'x', missing_sources: 'x' },
    });
    assert.equal(outcome.coverage.state, 'none');
    assert.equal(outcome.coverage.declared_sources, 0);
    assert.deepEqual(outcome.coverage.missing_sources, []);
    const inconsistent = await runTypedAssessment({
      assessor: async () => ({ findings: [], diagnostics: [] }),
      coverage: { state: 'full', declared_sources: 2, scanned_sources: 1, missing_sources: [{ path: 'a.md', reason: 'file-missing' }] },
    });
    assert.equal(inconsistent.coverage.state, 'partial', 'an incomplete scan can never stay full');
    const junkEntries = await runTypedAssessment({
      assessor: async () => ({ findings: [], diagnostics: [] }),
      coverage: { state: 'partial', missing_sources: ['junk', null, { path: 'ok.md', reason: 'file-missing' }, 7] },
    });
    assert.deepEqual(junkEntries.coverage.missing_sources, [{ path: 'ok.md', reason: 'file-missing' }]);
  });

  it('rejects outcome shapes that would mask a negative result', async () => {
    // Guarded internally: not_run/failed outcomes with findings are impossible
    // to construct through the public API; assert via the invariant checker
    // surface by asserting the public outcomes observed above never carry
    // findings outside complete.
    const outcome = await runTypedAssessment({
      assessor: async () => ({ ok: false, code: 'down', findings: [{ smuggled: true }] }),
      coverage: { state: 'full' },
    });
    assert.equal(outcome.run_status, 'failed');
    assert.deepEqual(outcome.findings, []);
  });

  it('discards a same-tick assessor result produced after the deadline elapsed', async () => {
    // A synchronous assessor blocks the loop, so the deadline timer cannot
    // fire while it runs; the post-race expired() check must discard its
    // output instead of presenting a complete outcome. The clock only jumps
    // past the deadline AFTER the assessor started running (reads 1-2 are the
    // start and the pre-check; the assessor itself advances the clock), which
    // is exactly what a blocked loop produces with a real clock — and the
    // assertion proves the assessor was actually invoked.
    let reads = 0;
    const calls = [];
    const outcome = await runTypedAssessment({
      now: () => {
        reads += 1;
        return calls.length === 0 ? 0 : 5000;
      },
      assessor: async () => {
        calls.push('run');
        return { findings: [{ late: true }], diagnostics: [] };
      },
      coverage: { state: 'full' },
      limits: { deadlineMs: 1000 },
    });
    assert.equal(calls.length, 1, 'the assessor must have actually run');
    assert.equal(outcome.run_status, 'failed');
    assert.deepEqual(outcome.findings, []);
    assert.ok(outcome.diagnostics.some((entry) => entry.code === 'deadline-exceeded'));
  });

  it('marks a same-tick freshness probe stale when it finishes past the deadline budget', async () => {
    // The probe settles successfully, but the loop was blocked while it ran
    // (the clock advances inside the probe), so its verdict is produced after
    // its budget elapsed and must not keep the outcome current.
    let probeRan = false;
    const outcome = await runTypedAssessment({
      now: () => (probeRan ? 5000 : 0),
      assessor: async () => ({ findings: [{ n: 1 }], diagnostics: [] }),
      coverage: { state: 'full' },
      watch: { changed: async () => { probeRan = true; return false; } },
      limits: { deadlineMs: 1000 },
    });
    assert.equal(outcome.freshness, 'stale');
    assert.ok(outcome.diagnostics.some((entry) => entry.code === 'assessment-stale'
      && String(entry.detail).includes('probe')));
  });

  it('degrades coverage to partial when findings are truncated even with a full diagnostics budget', async () => {
    const junkDiagnostics = Array.from({ length: 10 }, (_, index) => ({ code: `junk-${index}`, path: null, detail: null }));
    const outcome = await runTypedAssessment({
      assessor: async () => ({ findings: Array.from({ length: 8 }, () => ({ n: 1 })), diagnostics: junkDiagnostics }),
      coverage: { state: 'full', declared_sources: 2, scanned_sources: 2, missing_sources: [] },
      limits: { maxFindings: 5, maxDiagnostics: 10 },
    });
    assert.equal(outcome.findings.length, 5);
    assert.equal(outcome.coverage.state, 'partial', 'truncation is a coverage fact, not a diagnostics fact');
  });

  it('rejects sparse arrays and non-plain objects in binding inputs', () => {
    const sparse = new Array(2);
    sparse[1] = 1;
    assert.throws(() => buildAssessmentBinding({ sparse }), /sparse/);
    assert.throws(() => buildAssessmentBinding({ at: new Date() }), /non-plain/);
    assert.throws(() => buildAssessmentBinding({ map: new Map() }), /non-plain/);
    // A null-prototype plain mapping stays acceptable.
    const nullProto = Object.assign(Object.create(null), { a: 1 });
    assert.match(buildAssessmentBinding({ nullProto }), /^[a-f0-9]{64}$/);
  });

  it('degrades to stale when the freshness probe hangs past the deadline budget', async () => {
    const outcome = await runTypedAssessment({
      assessor: async () => ({ findings: [{ n: 1 }], diagnostics: [] }),
      coverage: { state: 'full' },
      watch: { changed: () => new Promise(() => {}) },
      limits: { deadlineMs: 60 },
    });
    assert.equal(outcome.freshness, 'stale');
    assert.ok(outcome.diagnostics.some((entry) => entry.code === 'assessment-stale'
      && String(entry.detail).includes('probe')));
  });

  it('rejects binding inputs that would silently collapse into one digest', () => {
    for (const [name, parts] of Object.entries({
      nan: { x: Number.NaN },
      infinity: { x: Number.POSITIVE_INFINITY },
      undefined_value: { x: undefined },
      array_hole: { list: [undefined] },
      function_value: { fn: () => {} },
      cycle: null,
    })) {
      if (parts === null) {
        const cyclic = { self: null };
        cyclic.self = cyclic;
        assert.throws(() => buildAssessmentBinding(cyclic), /acyclic/, name);
        continue;
      }
      assert.throws(() => buildAssessmentBinding(parts), /JSON-compatible/, name);
    }
  });
});

describe('typed-assessment strict validation', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      run_status: { enum: ['complete', 'failed', 'not_run'] },
      findings: { type: 'array', maxItems: 2, items: { type: 'object' } },
    },
    required: ['run_status', 'findings'],
  };

  it('accepts a schema-valid observation and rejects an invalid one', () => {
    const good = validateAssessmentObservation({ run_status: 'complete', findings: [] }, schema);
    assert.equal(good.ok, true);
    assert.deepEqual(good.errors, []);
    const bad = validateAssessmentObservation({ run_status: 'bogus', findings: [], extra: 1 }, schema);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.length >= 2);
  });
});
