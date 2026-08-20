// agent-instruction-contract.mjs - prompt-level parity checks for packaged AIFHub agents

export const LEGACY_ULTRA_AGENT_CONTRACTS = Object.freeze({
  'aifhub-plan-polisher': Object.freeze({
    handoffs: Object.freeze(['/aif-improve <entrypoint>']),
    receiptRole: 'none'
  }),
  'aifhub-implement-worker': Object.freeze({
    handoffs: Object.freeze(['/aif-implement <entrypoint>']),
    receiptRole: 'none'
  }),
  'aifhub-verifier': Object.freeze({
    handoffs: Object.freeze(['/aif-verify <entrypoint>']),
    receiptRole: 'command-boundary-writer'
  }),
  'aifhub-fixer': Object.freeze({
    handoffs: Object.freeze(['/aif-fix <entrypoint>']),
    receiptRole: 'none'
  }),
  'aifhub-done-finalizer': Object.freeze({
    handoffs: Object.freeze(['/aif-archive <entrypoint>', '/aif-verify <entrypoint>']),
    receiptRole: 'read-only-evaluator'
  }),
  'aifhub-rules-sidecar': Object.freeze({
    handoffs: Object.freeze(['/aif-archive <entrypoint>', '/aif-verify <entrypoint>']),
    receiptRole: 'read-only-evaluator'
  })
});

export function validateAgentInstructionContract({ runtime, name, source }) {
  const contract = LEGACY_ULTRA_AGENT_CONTRACTS[name];
  if (contract === undefined) return { applicable: false, cases: [], issues: [] };

  const legacy = extractHeadingSection(source, 'Legacy AI Factory-only mode');
  const cases = [];
  const issues = [];
  const record = (caseName, ok, message) => {
    cases.push({ runtime, name, case: caseName, ok });
    if (!ok) issues.push({ runtime, name, case: caseName, message });
  };

  record(
    'marker-first-delegation',
    legacy !== null
      && /before[^\n]*(?:discovery|fallback|reads?|write)/i.test(legacy)
      && legacy.includes('classifyLegacyPlanShape()'),
    'Legacy instructions must delegate marker-first shape resolution before discovery or writes.'
  );
  record(
    'fail-closed-stop',
    legacy !== null
      && /ultra-invalid[^\n]*collision|collision[^\n]*ultra-invalid/i.test(legacy)
      && /fail[^\n]*closed[^\n]*without classic fallback/i.test(legacy),
    'Invalid/colliding ultra input must be a fail-closed stop without classic fallback.'
  );
  record(
    'no-write-boundary',
    legacy !== null
      && /(?:never|do not)[^\n]*write[^\n]*(?:bundle|ultra bundle)/i.test(legacy)
      && /companion/i.test(legacy)
      && /(?:status|QA)/i.test(legacy),
    'The legacy ultra branch must explicitly forbid bundle, companion, status, and QA writes.'
  );

  for (const handoff of contract.handoffs) {
    record(
      `exact-handoff:${handoff}`,
      legacy !== null && legacy.includes(`\`${handoff}\``),
      `Legacy instructions must contain the exact handoff ${handoff}.`
    );
  }

  if (contract.receiptRole === 'command-boundary-writer') {
    record(
      'receipt-owner:command-boundary-writer',
      legacy !== null
        && legacy.includes('writeLegacyUltraVerificationReceipt()')
        && /command boundary/i.test(legacy)
        && /agent must not write that receipt itself/i.test(legacy),
      'Verifier must leave receipt persistence to the command boundary after the upstream gate.'
    );
  }

  if (contract.receiptRole === 'read-only-evaluator') {
    record(
      'receipt-owner:read-only-evaluator',
      legacy !== null
        && legacy.includes('evaluateLegacyUltraVerificationReceipt()')
        && /recompute[^\n]*(?:bundle|bindings?)/i.test(legacy)
        && /exact (?:gate status )?(?:`?pass`?|PASS)/i.test(legacy)
        && /do not execute|Return the handoff only/i.test(legacy),
      'Finalization consumers must recompute receipt bindings, require exact PASS, and return without execution.'
    );
  }

  return { applicable: true, cases, issues };
}

function extractHeadingSection(source, heading) {
  const lines = String(source ?? '').split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match?.[2] === heading) {
      start = index + 1;
      level = match[1].length;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match !== null && match[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}
