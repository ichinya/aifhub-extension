const array = value => Array.isArray(value) ? value : [];
const exactSet = (value, expected) => JSON.stringify([...array(value)].sort()) === JSON.stringify([...expected].sort());

export function gradeFields(id, answer, oracle = []) {
  if (id === 'contract-review') return {
    producer: answer?.producer === 'repo-02', incompatible: answer?.compatible === false,
    keys: answer?.expectedKey === 'status' && answer?.actualKey === 'state',
    consumers: exactSet(answer?.downstreamRepos, ['repo-01', 'repo-05']), proxyPassthrough: answer?.proxyRenamesKey === false,
  };
  if (id === 'security-review') {
    const findings = array(answer?.findings);
    const summary = findings.find(x => x?.repo === 'repo-02' && x?.kind === 'summary-log-exposure');
    const proxy = findings.find(x => x?.repo === 'repo-05' && x?.kind === 'upstream-error-body-exposure');
    return { exactFindingCount: findings.length === 2,
      summaryFinding: !!summary && Array.isArray(summary.statuses) && summary.statuses.length === 0,
      proxyFinding: !!proxy && exactSet(proxy.statuses, [401, 403, 404, 500]), cleanRepo: exactSet(answer?.cleanRepos, ['repo-01']) };
  }
  if (id === 'multi-diagnostics') return {
    completeDiagnostics: oracle.length === 12 && answer?.count === 12 && answer?.exitNonzero === true && Array.isArray(answer?.failures) && answer.failures.length === 12 && oracle.every((x, i) => ['repo', 'case', 'actual', 'expected'].every(k => x[k] === answer.failures[i]?.[k])),
  };
  if (id === 'coordinated-fix') return { fixedAllRepos: exactSet(answer?.fixedRepos, ['repo-01', 'repo-02', 'repo-05']), claim: answer?.testsPassed === true };
  throw Error('Unknown scenario');
}
