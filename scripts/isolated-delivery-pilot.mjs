import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGateResult, renderGateResultBlock } from './aif-gate-result.mjs';
import { executionCommand } from './execution-state.mjs';
import { deliveryStore } from './host-delivery-store.mjs';
import { startIsolatedDeliveryHost } from './fixtures/isolated-delivery-host-client.mjs';
import { digest, requireValue, storeFor, WorkflowError } from './workflow-state-store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const fixtureChangeId = 'isolated-delivery-fixture';
const fixtureSourceFile = 'src/a.js';
const sources = [
  'scripts/isolated-delivery-pilot.mjs', 'scripts/fixtures/isolated-delivery-host-client.mjs',
  'scripts/fixtures/isolated-delivery-host.mjs'
];
const unknownMetrics = Object.freeze({ service_calls: 'UNKNOWN', host_reads: 'UNKNOWN', host_fetches: 'UNKNOWN', host_releases: 'UNKNOWN' });
const requestProofFields = ['identity_sha256', 'binding_sha256', 'target_sha256'];
const proofFields = [...requestProofFields, 'continuity_sha256'];
const sha256 = /^[0-9a-f]{64}$/u;

async function prepareFixture(rootDir) {
  const fixture = await storeFor(rootDir);
  await fixture.write('.gitignore', '.ai-factory/\n');
  await fixture.write('.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: true\n');
  await fixture.write(fixtureSourceFile, 'initial a\n');
  const change = `openspec/changes/${fixtureChangeId}`;
  await fixture.write(`${change}/proposal.md`, '# Proposal\n');
  await fixture.write(`${change}/tasks.md`, '- [ ] 1.1 Test delivery\n');
  const git = (...args) => exec('git', args, { cwd: rootDir, windowsHide: true });
  await git('init', '-q');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return fixture;
}

function requestProof({ identity, binding, target }, continuity) {
  return {
    identity_sha256: digest(identity), binding_sha256: digest(binding),
    target_sha256: digest(target), continuity_sha256: digest(continuity)
  };
}

export function recountArm(arm) {
  if (arm.phase_before_recovery !== 'pending' || arm.phase_after_recovery !== 'verified' ||
      !arm.window || arm.host_exit?.code !== 0 || arm.host_exit?.signal !== null) return { ...unknownMetrics };
  const proof = arm.proof;
  if (!proof || !proofFields.every(field => sha256.test(proof[field]) && proof[field] === arm.verified_proof?.[field])) {
    return { ...unknownMetrics };
  }
  const sameContinuity = row => row.namespace_digest === arm.namespace_digest &&
    row.continuity_sha256 === proof.continuity_sha256;
  const matchesProof = (call, event) => {
    if (!event || !call || event.call_id !== call.call_id || event.operation !== call.operation ||
        (event.request_uuid ?? null) !== call.request_uuid || call.outcome !== 'received' || !sameContinuity(event)) return false;
    if (call.operation === 'capabilities') return call.request_uuid === null && sameContinuity(call);
    if (event.request_uuid !== arm.request_uuid || event.run_id !== arm.run_id || event.body_sha256 !== arm.body_sha256 ||
        !requestProofFields.every(field => event[field] === proof[field])) return false;
    if (call.operation === 'fetchResponse') return call.body_sha256 === arm.body_sha256;
    return sameContinuity(call) && call.state === event.state && requestProofFields.every(field => call[field] === proof[field]);
  };
  const { after_call_id: start, through_call_id: end } = arm.window;
  const anchor = arm.hostTrace.find(event => event.call_id === start);
  const anchorCall = arm.clientCalls.find(call => call.call_id === start);
  if (anchor?.operation !== 'readRequest' || anchor.state !== 'pending' || !matchesProof(anchorCall, anchor)) return { ...unknownMetrics };
  const inWindow = event => event.call_id > start && event.call_id <= end;
  const calls = arm.clientCalls.filter(inWindow);
  const observations = arm.hostTrace.filter(inWindow);
  const observeAction = arm.name === 'baseline' ? 'delivery-inspect' : 'lifecycle-collect';
  const [wait, complete, recover] = arm.services;
  if (arm.services.length !== 3 || wait.action !== observeAction || complete.action !== observeAction ||
      recover.action !== 'delivery-recover' || wait.after_call_id !== start || recover.through_call_id !== end ||
      complete.after_call_id !== wait.through_call_id + 1 || recover.after_call_id !== complete.through_call_id ||
      !observations.some(event => event.call_id === complete.after_call_id && event.operation === 'complete')) {
    return { ...unknownMetrics };
  }
  if (calls.length !== end - start || observations.length !== calls.length ||
      !calls.every((call, index) => call.call_id === start + index + 1 && matchesProof(call, observations[index]))) {
    return { ...unknownMetrics };
  }

  const transitions = observations.filter(event => event.operation === 'readRequest').map(event => event.state);
  if (transitions[0] !== 'pending' || !transitions.includes('completed')) return { ...unknownMetrics };
  return {
    service_calls: arm.services.length,
    host_reads: transitions.length,
    host_fetches: observations.filter(event => event.operation === 'fetchResponse').length,
    host_releases: observations.filter(event => event.operation === 'releaseRequest').length
  };
}

async function runArm(name, body) {
  const arm = {
    name, run_id: `${name}-${randomUUID()}`, body_sha256: digest(body), services: [],
    clientCalls: [], hostTrace: [], reason: null
  };
  const debug = process.env.LOG_LEVEL === 'debug';
  let fixtureRoot;
  let host;
  try {
    if (debug) console.error('[FIX:pilot-fixture-cleanup]', JSON.stringify({ arm: name, action: 'prepare-fixture' }));
    fixtureRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'aifhub-delivery-pilot-'));
    const fixture = await prepareFixture(fixtureRoot);
    host = await startIsolatedDeliveryHost();
    const call = (action, input, options = {}) => executionCommand(action, input, { rootDir: fixtureRoot, ...options });
    const identity = { change_id: fixtureChangeId, run_id: arm.run_id };
    const report = '.ai-factory/evidence/report.md';
    const started = await call('start', {
      ...identity, task_id: '1.1', owner: 'parent', worker: 'worker', role: 'implement', scope: [fixtureSourceFile]
    });
    requireValue(started.status === 'started', 'pilot-start-refused');
    const slot = await call('delivery-reserve', { ...identity, target: { kind: 'completion', locator: `${name}-worker` } });
    requireValue(slot.ok, 'pilot-reserve-refused');
    arm.request_uuid = slot.request_uuid;
    const request = { ...identity, request_uuid: slot.request_uuid };
    await fixture.write(report, body);
    const submitted = await call('result', {
      ...identity, actor: 'worker', version: started.version,
      result: { result_id: `${name}-result`, status: 'completed', changed_files: [],
        checks: [{ name: 'fixture', exit_code: 0 }], evidence: [report] }
    });
    requireValue(submitted.status === 'completed', 'pilot-result-refused');
    const prepared = await call('delivery-prepare', { ...request, gate: 'security', body });
    requireValue(prepared.ok, 'pilot-prepare-refused');
    const store = await deliveryStore({ rootDir: fixtureRoot });
    const load = () => store.loadRequest(fixtureChangeId, request.request_uuid);
    const frozen = await load();
    const send = await call('delivery-send', request, { HostClient: host.client });
    const pending = await load();
    requireValue(send.recovery_action?.type === 'wait-request' && pending.phase === 'pending' &&
      pending.body.sha256 === arm.body_sha256 && pending.host.request_state === 'pending', 'pilot-pending-unproven');
    arm.namespace_digest = pending.host.namespace_digest;
    arm.proof = requestProof(frozen, pending.host.continuity_token);
    arm.window = { after_call_id: host.lastCallId() };

    async function service(action, input) {
      const step = { sequence: arm.services.length + 1, action, after_call_id: host.lastCallId() };
      arm.services.push(step);
      const result = await call(action, input, { HostClient: host.client });
      step.through_call_id = host.lastCallId();
      step.state = result.state;
      step.code = result.code ?? null;
      step.next_action = result.next_action?.type ?? null;
      step.recovery_type = result.next_action?.recovery_type ?? result.recovery_action?.type ?? null;
      if (debug) console.error(JSON.stringify({ arm: name, ...step }));
      return result;
    }
    const observe = name === 'baseline'
      ? () => service('delivery-inspect', request)
      : () => service('lifecycle-collect', { change_id: fixtureChangeId, members: [{ request_uuid: slot.request_uuid }], read_host: true });
    await observe();
    requireValue(arm.services[0].recovery_type === 'wait-request', 'pilot-wait-unproven');
    const completion = await host.complete({ request_uuid: request.request_uuid, namespace_digest: arm.namespace_digest });
    const observed = await observe();
    const readyForRecovery = name === 'baseline' ? observed.delivery_verified === true :
      observed.next_action?.type === 'delivery-recover' && observed.next_action.recovery_type === 'fetch-response';
    requireValue(completion.state === 'completed' && readyForRecovery, 'pilot-host-completion-unproven');
    const before = await load();
    arm.phase_before_recovery = before.phase;
    requireValue(digest(before) === digest(pending), 'pilot-observation-changed-record');
    const recovered = await service('delivery-recover', request);
    const verified = await load();
    arm.phase_after_recovery = verified.phase;
    arm.delivered_body_sha256 = verified.host.delivered_body_sha256;
    arm.verified_proof = requestProof(verified, verified.host.continuity_token);
    arm.completion_id = verified.host.completion_id;
    arm.window.through_call_id = host.lastCallId();
    requireValue(recovered.delivery_verified === true && verified.phase === 'verified' &&
      verified.host.delivered_body_sha256 === arm.body_sha256 && arm.completion_id === completion.completion_id &&
      verified.host.namespace_digest === arm.namespace_digest && verified.host.continuity_token === pending.host.continuity_token &&
      digest(verified.binding) === digest(pending.binding), 'pilot-verified-delivery-unproven');
  } catch (error) {
    arm.reason = error instanceof WorkflowError ? error.code : 'pilot-operation-failed';
    if (debug && !host) console.error('[FIX:pilot-fixture-cleanup]', JSON.stringify({ arm: name, outcome: arm.reason }));
  }

  try {
    if (host) {
      const { trace, calls, exit, traceError } = await host.close();
      arm.hostTrace = trace;
      arm.clientCalls = calls;
      arm.host_exit = exit;
      if (traceError) {
        arm.trace_error = traceError;
        arm.reason ??= traceError;
      }
    }
    if (fixtureRoot) {
      requireValue(await realpath(fixtureRoot) === fixtureRoot, 'pilot-fixture-root-mismatch');
      await rm(fixtureRoot, { recursive: true, maxRetries: 3, retryDelay: 100 });
      if (debug) console.error('[FIX:pilot-fixture-cleanup]', JSON.stringify({ arm: name, outcome: 'fixture-removed' }));
    }
  } catch {
    arm.reason ??= 'pilot-cleanup-incomplete';
    if (debug) console.error('[FIX:pilot-fixture-cleanup]', JSON.stringify({ arm: name, outcome: 'pilot-cleanup-incomplete' }));
  }
  arm.metrics = arm.reason ? { ...unknownMetrics } : recountArm(arm);
  if (arm.metrics.host_reads === 'UNKNOWN') arm.reason ??= 'pilot-trace-incomplete';
  if (debug) console.error('[FIX:pilot-trace-binding-evidence]', JSON.stringify({ arm: name, request_uuid: arm.request_uuid, outcome: arm.reason ?? 'matched' }));
  return arm;
}

export async function runIsolatedDeliveryPilot() {
  const gate = createGateResult({ gate: 'security', status: 'pass', blockers: [], affectedFiles: [], suggestedNext: null });
  const body = '\ufeffИзолированная тестовая доставка\r\n\r\n' + renderGateResultBlock(gate).replace(/\n/g, '\r\n') + '\r\n';
  const arms = [await runArm('baseline', body), await runArm('candidate', body)];
  const [baseline, candidate] = arms;
  const distinctKeys = ['run_id', 'request_uuid', 'namespace_digest', 'completion_id'];
  const comparable = baseline.body_sha256 === candidate.body_sha256 && distinctKeys.every(key => baseline[key] && candidate[key] && baseline[key] !== candidate[key]);
  return { outcome: comparable && arms.every(arm => arm.reason === null) ? 'QUALIFIED' : 'INCOMPLETE', arms };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = await storeFor(root);
  const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async file => [file, digest(await store.bytes(file))])));
  const result = await runIsolatedDeliveryPilot();
  const output = `.ai-factory/state/add-isolated-host-client/pilot/${randomUUID()}.json`;
  await store.write(output, JSON.stringify({ ...result, environment: { node: process.version, platform: process.platform }, sourceHashes }, null, 2) + '\n');
  console.log(JSON.stringify({ outcome: result.outcome, output, arms: result.arms.map(arm => ({ name: arm.name, metrics: arm.metrics, reason: arm.reason })) }));
  if (result.outcome !== 'QUALIFIED') process.exitCode = 1;
}
