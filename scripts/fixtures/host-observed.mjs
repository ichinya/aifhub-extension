// Offline fake host driver for observed-run tests (#227), modeled on the
// host-delivery fixture: trace, counters, failpoints, capability override and an
// immutable envelope signature. The transport wraps the real child_process
// execFile; the adapter receives it through its injectable execFile option.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { digest } from '../workflow-state-store.mjs';
import { qaStore } from '../qa-manifest-store.mjs';
import { OBSERVED_RUN_SCHEMA } from '../qa-observed-check.mjs';
import { observedVerifierReport } from './observed-verifier.mjs';

export const OBSERVED_MODE_OUTCOMES = Object.freeze({
  pass: { outcome: 'completed', exit_code: 0 },
  fail: { outcome: 'failed', exit_code: 2 },
  hang: { outcome: 'timeout', exit_code: null },
  cancel: { outcome: 'cancelled', exit_code: null },
  noreport: { outcome: 'missing-report', exit_code: 0 },
  slow: { outcome: 'completed', exit_code: 0 },
  verbose: { outcome: 'completed', exit_code: 0 },
});

export function createFakeObservedHost({ state, capabilities = {}, failpoint } = {}) {
  state ??= { trace: [], counters: { verifier_launches: 0, envelopes_issued: 0 }, signatures: new Map() };
  const host = {
    state,
    capabilitiesOverride: capabilities,
    async capabilities() {
      return { observed_runs: true, real_child_transport: true, conflicting_payload: 'reject', ...host.capabilitiesOverride };
    },
    async issueEnvelope({ envelope, run_id, check_id }) {
      const caps = await host.capabilities();
      state.trace.push(['issue', run_id]); state.counters.envelopes_issued++;
      await failpoint?.('before-issue');
      // Capability override: the host refuses the run before it starts, so the
      // adapter sees an unsupported declaration and must not fabricate a receipt.
      if (!caps.observed_runs)
        return { schema: OBSERVED_RUN_SCHEMA, run_id, check_id, outcome: 'unsupported' };
      const signature = digest(envelope);
      const old = state.signatures.get(envelope.run_id);
      if (old && old !== signature) throw new Error('conflicting-payload');
      state.signatures.set(envelope.run_id, signature);
      await failpoint?.('after-issue');
      return envelope;
    },
  };
  return host;
}

export function createVerifierExec(state, { failpoint } = {}) {
  return (file, argv, options, callback) => {
    if (file === 'git') return execFile(file, argv, options, callback);
    state.counters.verifier_launches++;
    state.trace.push(['exec', path.basename(argv[1] ?? argv[0]), ...argv.slice(2)]);
    return execFile(file, argv, options, async (error, stdout, stderr) => {
      await failpoint?.('after-verifier');
      callback(error, stdout, stderr);
    });
  };
}

// Host-side envelope composition: the hook attests the state it observed at run
// time (snapshot/module/fingerprint digests, manifest digest) plus the expected
// outcome, exit code and deterministic report digest of the fixture verifier.
export async function composeObservedRun(options, { runId = 'run-1', mode } = {}) {
  const store = await qaStore(options);
  const manifest = await store.manifest();
  const check = manifest.payload.checks[0];
  const effective = options.providers?.checkDefinition
    ? (await options.providers.checkDefinition(check)).command : check.command;
  const argvMode = effective.argv[effective.argv.indexOf('--mode') + 1] ?? 'pass';
  const resolvedMode = mode ?? argvMode;
  const expected = OBSERVED_MODE_OUTCOMES[resolvedMode];
  const reportPath = `${store.qa}/artifacts/observations/reports/${runId}.json`;
  const withReport = expected.outcome === 'completed' || expected.outcome === 'failed';
  const reportDigest = withReport ? digest(observedVerifierReport({ mode: resolvedMode, check_id: check.id })) : null;
  return { schema: OBSERVED_RUN_SCHEMA, run_id: runId, check_id: check.id, covered_checks: [check.id],
    change_id: store.target.id, manifest_digest: manifest.manifest_digest,
    command: structuredClone(effective), effective_cwd: '.',
    worktree_identity: manifest.payload.snapshot.worktree_identity,
    snapshot_digest: manifest.payload.snapshot.digest,
    fingerprints_digest: digest({ [check.id]: manifest.payload.fingerprints[check.id] }),
    modules_digest: digest(manifest.payload.snapshot.modules),
    outcome: expected.outcome, exit_code: expected.exit_code,
    report_path: reportPath, report_sha256: reportDigest,
    artifacts: withReport ? { [reportPath]: reportDigest } : {} };
}
