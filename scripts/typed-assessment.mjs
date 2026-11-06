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
]);

// Binding/cache key material must stay deterministic: wall-clock time, run
// identity, and cost are provenance, never key inputs (design: binding R7).
const BANNED_BINDING_KEYS = Object.freeze(['timestamp', 'generated_at', 'run_id', 'cost', 'elapsed_ms']);

export function assessmentCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(assessmentCanonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${assessmentCanonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function assessmentDigest(value) {
  return createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : assessmentCanonical(value))
    .digest('hex');
}

function assertNoBannedKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoBannedKeys(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (BANNED_BINDING_KEYS.includes(key)) {
        throw new TypeError(`binding input must not contain volatile key ${key} at ${path}.${key}`);
      }
      assertNoBannedKeys(item, `${path}.${key}`);
    }
  }
}

// Deterministic composite binding for a typed-assessment cache/observation.
// Callers assemble the full revision set (input digests, rubric/profile,
// adapter, contract, language, exclusion policy, target identity); this module
// only guarantees canonical serialization, a stable digest, and that volatile
// fields never enter the key.
export function buildAssessmentBinding(parts) {
  assertNoBannedKeys(parts);
  return assessmentDigest(assessmentCanonical(parts));
}

export function normalizeAssessmentLimits(limits = {}) {
  const normalized = {
    deadlineMs: Number.isFinite(limits.deadlineMs) && limits.deadlineMs > 0 ? Math.floor(limits.deadlineMs) : 30000,
    maxFindings: Number.isFinite(limits.maxFindings) && limits.maxFindings >= 0 ? Math.floor(limits.maxFindings) : 500,
    maxDiagnostics: Number.isFinite(limits.maxDiagnostics) && limits.maxDiagnostics >= 0 ? Math.floor(limits.maxDiagnostics) : 200,
  };
  return normalized;
}

function diagnostic(code, path = null, detail = null) {
  return { code, path, detail: detail === null || detail === undefined ? null : String(detail).slice(0, 500) };
}

function emptyCoverage() {
  return { state: 'none', declared_sources: 0, scanned_sources: 0, missing_sources: [] };
}

function normalizeCoverage(coverage) {
  const base = coverage && typeof coverage === 'object' && !Array.isArray(coverage) ? coverage : {};
  const state = ASSESSMENT_COVERAGE_STATES.includes(base.state) ? base.state : 'none';
  const boundedCount = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
  const missing = Array.isArray(base.missing_sources) ? base.missing_sources.slice(0, 100) : [];
  return {
    state,
    declared_sources: boundedCount(base.declared_sources),
    scanned_sources: boundedCount(base.scanned_sources),
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
      let drifted = false;
      try { drifted = (await watch.changed()) === true; } catch { drifted = true; }
      if (drifted) {
        result.freshness = 'stale';
        result.diagnostics = [...result.diagnostics, diagnostic('assessment-stale', null, 'inputs or rubric changed during the scan')];
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
  try {
    const context = { expired, deadlineMs: bounds.deadlineMs };
    const deadline = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), bounds.deadlineMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    raw = await Promise.race([Promise.resolve(assessor(input, context)), deadline]);
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
  if (findings.length > bounds.maxFindings) {
    diagnostics.push(diagnostic('findings-truncated', null, `limit=${bounds.maxFindings}`));
    findings = findings.slice(0, bounds.maxFindings);
  }
  const normalizedCoverage = normalizeCoverage(coverage);
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
