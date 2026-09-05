// AIFHub's transport-neutral successor contract; this is not a Lekalo CLI protocol.
import { negotiateProviderCapabilities, validateNeutralTrace } from './aifhub-providers.mjs';

export function normalizeSemanticEvidence(manifest, result) {
  const negotiated = negotiateProviderCapabilities(manifest, ['validate', 'impact', 'context', 'trace']);
  if (negotiated.status !== 'pass' || manifest.kind !== 'semantic_model') return { status: 'unsupported', reason: 'capability_contract' };
  const digestRef = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
  const allowed = ['status', 'diagnostics', 'impact', 'context', 'trace'];
  if (!result || Object.keys(result).some((key) => !allowed.includes(key))
    || !['pass', 'warn', 'fail'].includes(result.status) || !Array.isArray(result.diagnostics)
    || result.diagnostics.length > 2000 || !Array.isArray(result.impact) || result.impact.length > 2000
    || !result.impact.every(digestRef) || !result.context || !digestRef(result.context.digest)
    || !Number.isSafeInteger(result.context.tokens) || result.context.tokens < 0
    || result.context.tokens > 1000000 || !validateNeutralTrace(result.trace)) {
    return { status: 'unsupported', reason: 'semantic_result_schema' };
  }
  const diagnostics = [];
  for (const item of result.diagnostics) {
    if (!item || !/^LEK-[A-Z]{2,12}-[0-9]{3}$/.test(item.code)
      || !['error', 'warning', 'info'].includes(item.severity) || !digestRef(item.symbol)) {
      return { status: 'unsupported', reason: 'semantic_diagnostic_schema' };
    }
    diagnostics.push({ code: item.code, severity: item.severity, symbol: item.symbol });
  }
  if (result.status === 'pass' && diagnostics.some((item) => item.severity !== 'info')) {
    return { status: 'unsupported', reason: 'contradictory_semantic_result' };
  }
  if (result.status === 'warn' && diagnostics.some((item) => item.severity === 'error')) {
    return { status: 'unsupported', reason: 'contradictory_semantic_result' };
  }
  return { status: result.status, diagnostics,
    impact: [...new Set(result.impact)].sort(), context: { digest: result.context.digest, tokens: result.context.tokens },
    trace: result.trace };
}
