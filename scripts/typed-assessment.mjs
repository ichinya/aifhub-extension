// Shared typed-assessment helper (issues #281/#282/#283). One dependency-free
// module for every typed-observation consumer: deterministic binding, bounded
// execution, transport-neutral result/provenance, strict validation, and the
// honest `not_run` / `failed` / `stale` outcomes. The helper owns no consumer
// vocabulary: finding types, verdict sets, and observation shapes belong to the
// consumer. It never reads paths or URLs out of model output, never writes QA
// evidence, never creates an `aif-gate-result`, and never sends questions.
// Assessor errors, abstentions, and deadline cutoffs are never coerced into a
// positive verdict: an advisory consumer must not mistake "did not run" for
// "nothing found".
import { createHash } from 'node:crypto';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';

export const ASSESSMENT_RUN_STATES = Object.freeze(['complete', 'failed', 'not_run']);
export const ASSESSMENT_FRESHNESS_STATES = Object.freeze(['current', 'stale']);
export const ASSESSMENT_COVERAGE_STATES = Object.freeze(['full', 'partial', 'none']);
export const ASSESSMENT_CONSUMER_IDS = Object.freeze([
  'requirements_semantic_lint',
  'claim_evidence_check',
  'trace_link_suggestions',
  // #284: consumer-side context-selection overlay; the helper stays
  // consumer-neutral — baseline fallback, candidate registry completeness and
  // owner confirmation are owned by the consumer module.
  'context_selection_overlay',
]);

// Binding/cache key material must stay deterministic: wall-clock time, run
// identity, and cost are provenance, never key inputs (design: binding R7).
const BANNED_BINDING_KEYS = Object.freeze(['timestamp', 'generated_at', 'run_id', 'cost', 'elapsed_ms']);

// Canonical serialization with strict JSON-compatibility: binding inputs must
// round-trip losslessly. `NaN`→`null`, dropped `undefined` array slots, and
// cyclic structures would collapse distinct values into one digest, so every
// unsupported value is rejected instead of silently normalized.
export function assessmentCanonical(value, seen = new WeakSet(), path = '$') {
  if (typeof value === 'string' || value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`binding input must be JSON-compatible: non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    throw new TypeError(`binding input must be JSON-compatible: unsupported value at ${path}`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`binding input must be acyclic: cycle at ${path}`);
    // Sparse arrays serialize as if the holes did not exist, collapsing
    // distinct values into one digest — reject them outright.
    if (Object.keys(value).length !== value.length) {
      throw new TypeError(`binding input must be JSON-compatible: sparse array at ${path}`);
    }
    seen.add(value);
    const rendered = value.map((item, index) => assessmentCanonical(item, seen, `${path}[${index}]`));
    seen.delete(value);
    return `[${rendered.join(',')}]`;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError(`binding input must be acyclic: cycle at ${path}`);
    // Non-plain objects (Date, Map, class instances) either serialize as {}
    // or carry non-JSON state — reject anything but plain/null-prototype.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`binding input must be JSON-compatible: non-plain object at ${path}`);
    }
    seen.add(value);
    const rendered = Object.keys(value).sort()
      .map((key) => {
        if (BANNED_BINDING_KEYS.includes(key)) {
          throw new TypeError(`binding input must not contain volatile key ${key} at ${path}.${key}`);
        }
        return `${JSON.stringify(key)}:${assessmentCanonical(value[key], seen, `${path}.${key}`)}`;
      });
    seen.delete(value);
    return `{${rendered.join(',')}}`;
  }
  throw new TypeError(`binding input must be JSON-compatible at ${path}`);
}

export function assessmentDigest(value) {
  return createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : assessmentCanonical(value))
    .digest('hex');
}

// Deterministic composite binding for a typed-assessment cache/observation.
// Callers assemble the full revision set (input digests, rubric/profile,
// adapter, contract, language, exclusion policy, target identity); this module
// only guarantees canonical serialization, a stable digest, and that volatile
// fields never enter the key. One cycle-safe walk performs both the banned-key
// rejection and the JSON-compatibility check.
export function buildAssessmentBinding(parts) {
  return createHash('sha256').update(assessmentCanonical(parts)).digest('hex');
}

export function normalizeAssessmentLimits(limits) {
  const source = limits && typeof limits === 'object' && !Array.isArray(limits) ? limits : {};
  // Clamps are applied after rounding so a fractional 0.4 deadline cannot
  // floor to 0 (immediate-expiry) and a zero diagnostics budget still leaves
  // room for the truncation marker itself.
  const bounded = (value, fallback, minimum, maximum) => {
    if (!Number.isFinite(value)) return fallback;
    const rounded = Math.floor(value);
    if (rounded < minimum) return minimum;
    if (rounded > maximum) return maximum;
    return rounded;
  };
  return {
    deadlineMs: bounded(source.deadlineMs, 30000, 1, 24 * 60 * 60 * 1000),
    maxFindings: bounded(source.maxFindings, 500, 0, 1_000_000),
    maxDiagnostics: bounded(source.maxDiagnostics, 200, 1, 10_000),
  };
}

function diagnostic(code, path = null, detail = null) {
  return { code, path, detail: detail === null || detail === undefined ? null : String(detail).slice(0, 500) };
}

function emptyCoverage() {
  return { state: 'none', declared_sources: 0, scanned_sources: 0, missing_sources: [] };
}

function normalizeCoverage(coverage) {
  const base = coverage && typeof coverage === 'object' && !Array.isArray(coverage) ? coverage : {};
  let state = ASSESSMENT_COVERAGE_STATES.includes(base.state) ? base.state : 'none';
  const boundedCount = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
  const declared = boundedCount(base.declared_sources);
  // scanned > declared is a caller contradiction: clamp before any state
  // decision instead of keeping an impossible "full" claim.
  const scanned = Math.min(boundedCount(base.scanned_sources), declared);
  // Items must be exactly {path, reason} string pairs: anything else — extra
  // properties, missing/null reason, non-objects — is dropped so a malformed
  // entry cannot masquerade as coverage evidence.
  const missing = (Array.isArray(base.missing_sources) ? base.missing_sources : [])
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item)
      && Object.getPrototypeOf(item) === Object.prototype
      && typeof item.path === 'string' && item.path.length > 0
      && typeof item.reason === 'string' && item.reason.length > 0
      && Object.keys(item).length === 2)
    .slice(0, 100);
  // Consistency: an incomplete scan can never be `full`, whatever the caller
  // claimed — missing entries or a scanned<declared gap degrade to partial.
  if ((missing.length > 0 || scanned < declared) && state === 'full') state = 'partial';
  return {
    state,
    declared_sources: declared,
    scanned_sources: scanned,
    missing_sources: missing,
  };
}

// Honest `not_run` outcome builder. A consumer that skipped the scan (disabled,
// unavailable, upstream gate already stopped) must present this as "advisory
// scan was not performed"; it is never a zero-findings result.
export function notRunAssessment(reason, diagnostics = [], options = {}) {
  const outcome = {
    ok: true,
    run_status: 'not_run',
    freshness: ASSESSMENT_FRESHNESS_STATES.includes(options.freshness) ? options.freshness : 'current',
    abstained: false,
    findings: [],
    diagnostics: [diagnostic('assessment-not-run', null, String(reason).slice(0, 200)),
      ...(Array.isArray(diagnostics) ? diagnostics : []).slice(0, 199)],
    coverage: emptyCoverage(),
    elapsed_ms: 0,
  };
  return outcome;
}

function assertOutcomeInvariants(outcome) {
  if (!ASSESSMENT_RUN_STATES.includes(outcome.run_status)) throw new TypeError('invalid run_status');
  if (!ASSESSMENT_FRESHNESS_STATES.includes(outcome.freshness)) throw new TypeError('invalid freshness');
  if (!ASSESSMENT_COVERAGE_STATES.includes(outcome.coverage.state)) throw new TypeError('invalid coverage state');
  if (!Array.isArray(outcome.diagnostics)) throw new TypeError('diagnostics must be an array');
  if ((outcome.run_status === 'not_run' || outcome.run_status === 'failed') && outcome.findings.length > 0) {
    throw new TypeError(`${outcome.run_status} outcome must not carry findings`);
  }
  if (outcome.abstained && (outcome.findings.length > 0 || outcome.coverage.state !== 'none')) {
    throw new TypeError('abstained outcome must stay finding-free with none coverage');
  }
}

// Bounded, transport-neutral execution of one typed assessment. The assessor
// owns consumer vocabulary and returns either
// `{ findings: [...], diagnostics: [...] }`,
// `{ abstain: true, reason }`, or `{ ok: false, code }`; anything else is an
// invalid output and degrades to `failed` — never to a positive result.
// `watch.changed()` is the freshness probe: a `true` answer before or after the
// scan marks the outcome `stale`, and the caller must not present it as
// current. Deadline enforcement is cooperative (`context.expired()`) plus a
// hard race cutoff whose abandoned result is discarded.
export async function runTypedAssessment(spec) {
  const { assessor, input, coverage, watch, limits, now } = spec ?? {};
  const bounds = normalizeAssessmentLimits(limits);
  const startedAt = typeof now === 'function' ? now() : Date.now();
  const expired = () => (typeof now === 'function' ? now() : Date.now()) - startedAt > bounds.deadlineMs;

  const finish = async (outcome) => {
    const result = { ...outcome };
    if (typeof watch?.changed === 'function') {
      // The freshness probe shares the assessment's deadline budget: a hung
      // probe must not hold the whole call open past the bound. A probe that
      // exceeds the budget (or rejects) degrades to stale — the conservative
      // honest direction.
      const probeStartedAt = typeof now === 'function' ? now() : Date.now();
      const remaining = Math.max(1, bounds.deadlineMs - Math.round(probeStartedAt - startedAt));
      let drifted = false;
      let probeTimedOut = false;
      try {
        let probeTimer;
        const probeDeadline = new Promise((resolve) => {
          probeTimer = setTimeout(() => resolve({ probeTimedOut: true }), remaining);
        });
        try {
          const probeResult = await Promise.race([
            Promise.resolve(watch.changed()).then((value) => ({ drifted: value === true })),
            probeDeadline,
          ]);
          // A same-tick probe can settle after its budget already elapsed (the
          // loop was blocked, so the timer callback could not run first): its
          // verdict is not trusted past the deadline.
          const probeElapsed = (typeof now === 'function' ? now() : Date.now()) - probeStartedAt;
          if (probeResult && probeResult.probeTimedOut === true) probeTimedOut = true;
          else if (probeElapsed > remaining) probeTimedOut = true;
          else if (probeResult) drifted = probeResult.drifted === true;
        } finally {
          // Cancelled, not just unref'd: the probe already settled, so a
          // pending timer would otherwise linger in a long-lived process
          // until its (possibly long) budget expires.
          if (probeTimer && typeof probeTimer.unref === 'function') probeTimer.unref();
          if (probeTimer) clearTimeout(probeTimer);
        }
      } catch {
        drifted = true;
      }
      if (drifted || probeTimedOut) {
        result.freshness = 'stale';
        result.diagnostics = [...result.diagnostics, diagnostic('assessment-stale', null, probeTimedOut
          ? 'freshness probe exceeded the deadline budget'
          : 'inputs or rubric changed during the scan')];
      }
    }
    if (result.diagnostics.length > bounds.maxDiagnostics) {
      result.diagnostics = result.diagnostics.slice(0, Math.max(0, bounds.maxDiagnostics - 1));
      result.diagnostics.push(diagnostic('diagnostics-truncated', null, `limit=${bounds.maxDiagnostics}`));
    }
    result.elapsed_ms = Math.max(0, Math.round((typeof now === 'function' ? now() : Date.now()) - startedAt));
    assertOutcomeInvariants(result);
    return result;
  };

  if (typeof assessor !== 'function') {
    return finish(notRunAssessment('assessor-unavailable'));
  }
  if (expired()) {
    return finish({
      ok: false, run_status: 'failed', freshness: 'current', abstained: false, findings: [],
      diagnostics: [diagnostic('deadline-exceeded', null, `deadlineMs=${bounds.deadlineMs}`)],
      coverage: normalizeCoverage(coverage), elapsed_ms: 0,
    });
  }

  let raw;
  let raceTimer = null;
  try {
    const context = { expired, deadlineMs: bounds.deadlineMs };
    const deadline = new Promise((resolve) => {
      // Referenced while the race is pending: a never-settling assessor must
      // still drive the deadline outcome instead of letting the process exit
      // silently. Cancelled right after the race settles — unref alone would
      // leave the timer scheduled in a long-lived process until each deadline
      // expires.
      raceTimer = setTimeout(() => resolve({ timedOut: true }), bounds.deadlineMs);
    });
    try {
      raw = await Promise.race([Promise.resolve(assessor(input, context)), deadline]);
    } finally {
      if (raceTimer && typeof raceTimer.unref === 'function') raceTimer.unref();
      if (raceTimer) clearTimeout(raceTimer);
    }
  } catch (error) {
    return finish({
      ok: false, run_status: 'failed', freshness: 'current', abstained: false, findings: [],
      diagnostics: [diagnostic('assessor-error', null, String(error?.message ?? error).slice(0, 200))],
      coverage: normalizeCoverage(coverage), elapsed_ms: 0,
    });
  }
  if (raw && raw.timedOut === true) {
    return finish({
      ok: false, run_status: 'failed', freshness: 'current', abstained: false, findings: [],
      diagnostics: [diagnostic('deadline-exceeded', null, `deadlineMs=${bounds.deadlineMs}`)],
      coverage: normalizeCoverage(coverage), elapsed_ms: 0,
    });
  }
  // A synchronous or same-tick assessor can return after the deadline already
  // elapsed (the loop was blocked so the timer callback could not run first).
  // Its output is discarded: an over-deadline result is never presented.
  if (expired()) {
    return finish({
      ok: false, run_status: 'failed', freshness: 'current', abstained: false, findings: [],
      diagnostics: [diagnostic('deadline-exceeded', null, `deadlineMs=${bounds.deadlineMs}`)],
      coverage: normalizeCoverage(coverage), elapsed_ms: 0,
    });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return finish({
      ok: false, run_status: 'failed', freshness: 'current', abstained: false, findings: [],
      diagnostics: [diagnostic('assessor-invalid-output', null, 'assessor must return an object')],
      coverage: normalizeCoverage(coverage), elapsed_ms: 0,
    });
  }
  if (raw.ok === false) {
    return finish({
      ok: false, run_status: 'failed', freshness: 'current', abstained: false, findings: [],
      diagnostics: [diagnostic('assessor-failed', null, String(raw.code ?? 'unspecified').slice(0, 200))],
      coverage: normalizeCoverage(coverage), elapsed_ms: 0,
    });
  }
  if (raw.abstain === true) {
    const outcome = {
      ok: true, run_status: 'complete', freshness: 'current', abstained: true, findings: [],
      diagnostics: [diagnostic('assessor-abstain', null, String(raw.reason ?? 'unspecified').slice(0, 200))],
      coverage: { ...normalizeCoverage(coverage), state: 'none' },
    };
    return finish(outcome);
  }
  if (!Array.isArray(raw.findings)) {
    return finish({
      ok: false, run_status: 'failed', freshness: 'current', abstained: false, findings: [],
      diagnostics: [diagnostic('assessor-invalid-output', null, 'findings must be an array')],
      coverage: normalizeCoverage(coverage), elapsed_ms: 0,
    });
  }
  const diagnostics = Array.isArray(raw.diagnostics) ? [...raw.diagnostics] : [];
  let findings = raw.findings;
  let findingsTruncated = false;
  if (findings.length > bounds.maxFindings) {
    diagnostics.push(diagnostic('findings-truncated', null, `limit=${bounds.maxFindings}`));
    findings = findings.slice(0, bounds.maxFindings);
    findingsTruncated = true;
  }
  const normalizedCoverage = normalizeCoverage(coverage);
  if (findingsTruncated && normalizedCoverage.state === 'full') {
    // Truncation is a coverage fact, not a diagnostics fact: the unprocessed
    // tail must degrade coverage even if the diagnostics budget later trims
    // the findings-truncated marker.
    normalizedCoverage.state = 'partial';
  }
  return finish({
    ok: true, run_status: 'complete', freshness: 'current', abstained: false,
    findings, diagnostics, coverage: normalizedCoverage,
  });
}

// Strict validation of a consumer observation against the consumer's own
// closed schema. A non-empty error list means the observation is not writable
// and not presentable; callers fail closed instead of repairing the payload.
export function validateAssessmentObservation(observation, schema, options = {}) {
  const errors = validateJsonAgainstSchema(observation, schema, options);
  return { ok: errors.length === 0, errors };
}
