import { boundedText, canonical, cliMain, digest, fields, identifier, requireValue, storeFor } from './workflow-state-store.mjs';

const SCHEMA = 'aifhub.evolution.v1';
function skillName(value) {
  requireValue(typeof value === 'string' && /^aif-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80, 'invalid-skill');
  return value;
}
function content(value) {
  requireValue(value === null || (typeof value === 'string' && Buffer.byteLength(value) <= 256 * 1024 && !value.includes('\0')), 'invalid-skill-context');
  return value;
}
function diff(before, after, target) {
  const lines = value => value === null || value === '' ? [] : value.replace(/\n$/, '').split('\n');
  const oldLines = lines(before); const newLines = lines(after);
  const block = (value, prefix) => {
    const result = lines(value).map(line => `${prefix}${line}`);
    if (value && !value.endsWith('\n')) result.push('\\ No newline at end of file');
    return result;
  };
  return [`--- ${before === null ? '/dev/null' : `a/${target}`}`, `+++ ${after === null ? '/dev/null' : `b/${target}`}`,
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
    ...block(before, '-'), ...block(after, '+')].join('\n') + '\n';
}
function view(record) {
  return { schema: SCHEMA, transaction_id: record.proposal.transaction_id, status: record.status,
    proposal_digest: record.proposal_digest, target: record.proposal.target,
    before_digest: digest({ content: record.proposal.before }), after_digest: digest({ content: record.proposal.after }),
    evidence: record.proposal.evidence, reason: record.proposal.reason,
    diff: diff(record.proposal.before, record.proposal.after, record.proposal.target) };
}

/** One skill-context file per recoverable transaction; base skill files are never targets. */
export async function evolutionCommand(action, input, options = {}) {
  const contracts = {
    propose: [['transaction_id', 'skill', 'after', 'reason', 'evidence'], []],
    show: [['transaction_id'], []],
    apply: [['transaction_id', 'proposal_digest'], []],
    rollback: [['transaction_id', 'proposal_digest'], []],
  };
  requireValue(Object.hasOwn(contracts, action), 'unknown-action');
  fields(input, ...contracts[action]);
  const id = identifier(input.transaction_id);
  const store = await storeFor(options.rootDir);
  const folder = '.ai-factory/evolutions/transactions';
  const filename = `${folder}/${id}.json`;
  async function execute() {
    let record = await store.load(filename);
    if (action === 'propose') {
      requireValue(record === null, 'transaction-exists', true);
      const skill = skillName(input.skill);
      const target = `.ai-factory/skill-context/${skill}/SKILL.md`;
      const before = content(await store.textFile(target)); const after = content(input.after);
      requireValue(before !== after, 'no-change');
      boundedText(input.reason);
      const evidence = await store.references(input.evidence);
      requireValue(Object.keys(evidence).length > 0, 'missing-evidence');
      requireValue(!Object.keys(evidence).some(p => p === target || p.startsWith(`${folder}/`)), 'self-referencing-evidence');
      const proposal = { transaction_id: id, skill, target, before, after, reason: input.reason, evidence };
      record = { schema: SCHEMA, proposal, proposal_digest: digest(proposal), status: 'proposed' };
      await store.save(filename, record);
      return view(record);
    }
    requireValue(record?.schema === SCHEMA && record.proposal?.transaction_id === id && record.proposal_digest === digest(record.proposal), 'missing-or-invalid-transaction');
    const proposal = record.proposal;
    requireValue(proposal.target === `.ai-factory/skill-context/${skillName(proposal.skill)}/SKILL.md`, 'invalid-transaction-target');
    content(proposal.before); content(proposal.after);
    requireValue(['proposed', 'applying', 'applied', 'rolling_back', 'rolled_back'].includes(record.status), 'invalid-state');
    if (action === 'show') return view(record);
    requireValue(input.proposal_digest === record.proposal_digest, 'proposal-mismatch', true);
    const existing = await store.textFile(proposal.target);
    const applying = action === 'apply';
    const source = applying ? proposal.before : proposal.after;
    const destination = applying ? proposal.after : proposal.before;
    const initialStatus = applying ? 'proposed' : 'applied';
    const pendingStatus = applying ? 'applying' : 'rolling_back';
    const finalStatus = applying ? 'applied' : 'rolled_back';
    if (record.status === finalStatus) {
      requireValue(existing === destination, 'target-conflict', true);
      return { ...view(record), replay: true };
    }
    requireValue(record.status === initialStatus || record.status === pendingStatus, 'transaction-state-conflict', true);
    if (record.status === pendingStatus && existing === destination) {
      // A prior process wrote the file and stopped before saving its receipt.
      record.status = finalStatus; await store.save(filename, record);
      return { ...view(record), recovered: true };
    }
    requireValue(existing === source, 'target-conflict', true);
    if (applying) {
      requireValue(canonical(await store.references(Object.keys(proposal.evidence))) === canonical(proposal.evidence), 'stale-evidence', true);
    }
    record.status = pendingStatus; await store.save(filename, record);
    // Recheck after journaling. Helpers serialize each other; external editors must be quiescent.
    requireValue(await store.textFile(proposal.target) === source, 'target-conflict', true);
    if (destination === null) await store.remove(proposal.target);
    else await store.write(proposal.target, destination);
    record.status = finalStatus; await store.save(filename, record);
    return view(record);
  }
  return action === 'show' ? execute() : store.lock(`${folder}/write.lock`, execute);
}

await cliMain(import.meta.url, evolutionCommand);
