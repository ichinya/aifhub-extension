import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeFields } from './grade.mjs';
const pass = checks => Object.values(checks).every(Boolean);

test('security findings must retain repository ownership and exact status coverage', () => {
  const answer = { findings: [{ repo: 'repo-02', kind: 'summary-log-exposure', statuses: [] }, { repo: 'repo-05', kind: 'upstream-error-body-exposure', statuses: [401, 403, 404, 500] }], cleanRepos: ['repo-01'] };
  assert(pass(gradeFields('security-review', answer)));
  const wrongOwner = structuredClone(answer); wrongOwner.findings[0].repo = 'repo-01';
  assert(!pass(gradeFields('security-review', wrongOwner)));
  const missedStatus = structuredClone(answer); missedStatus.findings[1].statuses.pop();
  assert(!pass(gradeFields('security-review', missedStatus)));
});

test('same-basename diagnostic cases cannot be duplicated across repositories', () => {
  const oracle = ['repo-01', 'repo-02', 'repo-05'].flatMap(repo => ['01', '02', '03', '04'].map(c => ({ repo, case: c, actual: 'bad', expected: 'good' })));
  const answer = { failures: structuredClone(oracle), count: 12, exitNonzero: true };
  assert(pass(gradeFields('multi-diagnostics', answer, oracle)));
  answer.failures[11] = answer.failures[7];
  assert(!pass(gradeFields('multi-diagnostics', answer, oracle)));
});

test('malformed structures fail without crashing the matrix', () => {
  for (const id of ['contract-review', 'security-review', 'multi-diagnostics', 'coordinated-fix'])
    for (const answer of [null, {}, { findings: 'wrong', fixedRepos: {}, downstreamRepos: 1 }, { findings: [null, {}] }])
      assert(!pass(gradeFields(id, answer)));
});
