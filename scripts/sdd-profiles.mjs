// Deterministic planning depth. Gate policy is additive and independent of depth.
export const SDD_PROFILE_MODES = Object.freeze({
  direct: 'fast', quick: 'full', standard: 'full', expanded: 'full',
  ultra: 'ultra', tracer: 'full', research: null
});
export const SDD_POLICY_PATH = '.ai-factory/sdd-policy.json';
export const SDD_POLICY_SCHEMA = 'aifhub.sdd_policy.v1';
export const SDD_SIGNALS_HEADING = 'SDD Profile Inputs';
export const SDD_GATES = Object.freeze([
  'project_policy', 'tests', 'rules', 'review', 'security', 'migration_rollback',
  'human_review', 'verify', 'done'
]);
const SIGNAL_KEYS = [
  'behavior_change', 'modules', 'repositories', 'public_api', 'data_migration',
  'reversible', 'security_sensitive', 'architecture_novelty',
  'requirements_clear', 'expected_files'
];
const BOOLEAN_SIGNALS = SIGNAL_KEYS.filter((key) => !['modules', 'repositories', 'expected_files'].includes(key));

export function sddError(code) {
  const error = new Error(code);
  error.sddCode = code;
  return error;
}

export function validateSddPolicy(input = {}) {
  const allowed = ['schema', 'minimum_profile', 'required_gates', 'require_design', 'context_refs'];
  assertRecord(input, allowed, 'invalid-sdd-policy');
  if (input.schema !== undefined && input.schema !== SDD_POLICY_SCHEMA) throw sddError('invalid-sdd-policy');
  if (input.minimum_profile !== undefined && !['quick', 'standard', 'expanded', 'ultra'].includes(input.minimum_profile)) throw sddError('invalid-sdd-policy');
  if (input.require_design !== undefined && typeof input.require_design !== 'boolean') throw sddError('invalid-sdd-policy');
  const gates = input.required_gates ?? [];
  if (!Array.isArray(gates) || gates.some((gate) => !SDD_GATES.includes(gate))) throw sddError('invalid-sdd-policy');
  const refs = input.context_refs ?? [];
  if (!Array.isArray(refs) || refs.length > 64 || refs.some((ref) => typeof ref !== 'string')) throw sddError('invalid-sdd-policy');
  return {
    schema: SDD_POLICY_SCHEMA, minimum_profile: input.minimum_profile ?? 'quick',
    required_gates: [...new Set(gates)].sort(), require_design: input.require_design ?? false,
    context_refs: [...new Set(refs)].sort()
  };
}

export function validateSddInputs(input) {
  if (input === null) return null;
  assertRecord(input, ['planning_mode', ...SIGNAL_KEYS], 'invalid-sdd-inputs');
  if (!['fast', 'full', 'ultra'].includes(input.planning_mode)) throw sddError('invalid-sdd-inputs');
  for (const key of SIGNAL_KEYS) {
    if (input[key] === null || input[key] === undefined) continue;
    if (BOOLEAN_SIGNALS.includes(key) ? typeof input[key] !== 'boolean'
      : !Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > 100000) throw sddError('invalid-sdd-inputs');
  }
  return input;
}

export function selectSddProfile(input, policyInput = {}, options = {}) {
  const signals = validateSddInputs(input);
  const policy = validateSddPolicy(policyInput);
  const reasons = [];
  const riskSignals = [];
  const gates = new Set(['project_policy', 'tests', 'verify', 'done', ...policy.required_gates]);
  if (signals?.security_sensitive) { riskSignals.push('security_sensitive'); gates.add('security'); }
  if (signals?.data_migration) { riskSignals.push('data_migration'); gates.add('migration_rollback'); }
  if (signals?.public_api) riskSignals.push('public_api');
  if (signals?.reversible === false) riskSignals.push('irreversible');
  let profile;
  if (!signals || SIGNAL_KEYS.some((key) => signals[key] === null || signals[key] === undefined)) {
    profile = 'research'; reasons.push('missing_information');
  } else if (!signals.requirements_clear) {
    profile = 'research'; reasons.push('unclear_requirements');
  } else if (signals.architecture_novelty) {
    profile = 'research'; reasons.push('architecture_uncertainty');
  } else if (signals.planning_mode === 'ultra') {
    profile = 'ultra'; reasons.push('explicit_ultra');
  } else if (riskSignals.length > 0 || signals.repositories > 1) {
    profile = 'expanded'; reasons.push('high_risk_or_cross_repository');
  } else if (signals.modules > 1 || signals.expected_files > 5) {
    profile = 'standard'; reasons.push('multiple_modules_or_broad_surface');
  } else if (!signals.behavior_change && signals.expected_files === 1) {
    profile = 'direct'; reasons.push('trivial_non_behavioral');
  } else {
    profile = 'quick'; reasons.push(signals.behavior_change ? 'bounded_behavior_change' : 'bounded_non_behavioral');
  }
  const rank = ['direct', 'quick', 'standard', 'expanded', 'ultra'];
  // The default quick floor does not force trivial work into OpenSpec. An explicit
  // stronger project floor can require canonical planning for otherwise direct work.
  if (profile !== 'research' && policy.minimum_profile !== 'quick' && rank.indexOf(profile) < rank.indexOf(policy.minimum_profile)) {
    profile = policy.minimum_profile; reasons.push('project_minimum_profile');
  }
  let blockedReason = null;
  if (profile === 'ultra' && !options.supportsUltra) blockedReason = 'ultra_version_required';
  const recommendedMode = SDD_PROFILE_MODES[profile];
  if (signals && recommendedMode && signals.planning_mode !== recommendedMode) {
    // A full request may retain canonical planning for a trivial change.
    if (profile === 'direct' && signals.planning_mode === 'full') {
      profile = 'quick'; reasons.push('explicit_canonical_planning');
    } else blockedReason = 'planning_mode_mismatch';
  }
  const requiredArtifacts = profile === 'direct' || profile === 'research' ? [] : ['proposal', 'tasks', 'session_brief'];
  if (requiredArtifacts.length && signals?.behavior_change) requiredArtifacts.push('delta_specs');
  const requireDesign = policy.require_design || ['standard', 'expanded', 'ultra'].includes(profile);
  if (requiredArtifacts.length && requireDesign) requiredArtifacts.push('design');
  return {
    profile, planning_mode: signals?.planning_mode ?? null,
    recommended_planning_mode: SDD_PROFILE_MODES[profile], reasons,
    risk_signals: riskSignals.sort(), required_artifacts: requiredArtifacts.sort(),
    conditional_artifacts: requiredArtifacts.length && !requireDesign ? ['design'] : [],
    required_gates: [...gates].sort(),
    implementation_allowed: !blockedReason && !['direct', 'research'].includes(profile),
    blocked_reason: blockedReason ?? (profile === 'research' ? 'research_required' : profile === 'direct' ? 'upstream_fast_handoff' : null)
  };
}

function assertRecord(input, allowed, code) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some((key) => !allowed.includes(key))) throw sddError(code);
}
