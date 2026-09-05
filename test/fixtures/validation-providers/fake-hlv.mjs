// Hermetic process fixture, not an HLV implementation or published tool evidence.
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(`hlv ${process.env.AIF_TEST_HLV_VERSION ?? '1.0.0'}`);
} else {
  const operation = args.find((arg) => ['check', 'doctor', 'workflow', 'status', 'trace'].includes(arg));
  if (process.env.AIF_TEST_HLV_SHAPE === 'invalid') {
    console.log('invalid JSON /private/fixture-secret');
    process.exit(0);
  }
  const failed = process.env.AIF_TEST_HLV_FAIL === '1';
  const diagnostics = failed ? [{ code: 'CTR-020', severity: 'error',
    message: 'fixture-secret /private/account token=do-not-persist', file: 'C:\\private\\account.txt',
    nested: { prompt: 'fixture-secret' } }] : [];
  const result = {
    check: { diagnostics, waived: [], errors: failed ? 1 : 0, warnings: 0, infos: 0, exit_code: failed ? 1 : 0, strictness: 'standard' },
    doctor: { diagnostics: [], fixed: [], exit_code: 0 },
    workflow: { milestone_id: 'fixture-secret', phase: 5, phase_name: 'Validate', stages: [{ id: 1, scope: 'fixture-secret',
      status: failed ? 'implementing' : 'validated', active: true, task_count: 1, tasks_done: 1 }], next_actions: [] },
    status: { project: 'fixture-secret', history_count: 0, milestone: { id: 'fixture-secret', stages: [] } },
    trace: { schema_version: 1, requirements: [{ id: 'fixture-secret', statement: 'fixture-secret' }],
      mappings: [{ requirement: 'fixture-secret', contracts: [], scenarios: [], tests: ['private-test'], runtime_gates: [] }] }
  }[operation];
  if (result === undefined) process.exit(2);
  console.error('fixture-secret stderr C:\\private\\account.txt');
  console.log(JSON.stringify(result));
  if (operation === 'check' && failed) process.exit(1);
}
