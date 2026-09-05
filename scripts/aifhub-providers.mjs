#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHlv, HLV_COMMAND_CONTRACT, runHlvOperation } from './hlv-provider.mjs';
import { digest, providerRevision, readProviderFile, safeId, writeProviderFile } from './provider-files.mjs';
import { normalizeProviderPolicies, PROVIDER_KINDS, providerGate, readProviderPolicies } from './provider-policy.mjs';

export const PROVIDER_CONTRACT = Object.freeze({ id: 'aifhub.provider', version: '1.0.0' });
const PHASE_OPERATIONS = { status: ['status'], doctor: ['doctor', 'status'],
  implement: [], verify: ['validate', 'status', 'trace'], done: ['validate', 'readiness', 'trace'] };

export function negotiateProviderCapabilities(manifest, requested = []) {
  if (!manifest || Object.keys(manifest).some((key) => !['contract', 'kind', 'toolVersion', 'operations'].includes(key))
    || manifest.contract?.id !== PROVIDER_CONTRACT.id || manifest.contract?.version !== PROVIDER_CONTRACT.version
    || Object.keys(manifest.contract).some((key) => !['id', 'version'].includes(key))
    || !['validation', 'semantic_model'].includes(manifest.kind) || !Array.isArray(manifest.operations)
    || !manifest.operations.every((value) => ['detect', 'status', 'doctor', 'sync', 'validate', 'readiness', 'trace', 'impact', 'context'].includes(value))
    || new Set(manifest.operations).size !== manifest.operations.length
    || typeof manifest.toolVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.toolVersion)) {
    return { status: 'unsupported', reason: 'capability_contract' };
  }
  const missing = requested.filter((operation) => !manifest.operations.includes(operation));
  return { status: missing.length ? 'unsupported' : 'pass', reason: missing.length ? 'capability_missing' : 'compatible', missing };
}

function summary(providers, diagnostics = []) {
  const blocking = diagnostics.some((item) => item.blocking) || providers.some((item) => item.gate.blocking);
  return { schemaVersion: '1.0.0', status: blocking ? 'fail'
    : providers.some((item) => item.gate.status === 'warn') ? 'warn' : 'pass', blocking, providers, diagnostics };
}

function configurationFailure(reason) {
  return summary([], [{ code: 'provider-configuration-error', reason, blocking: true,
    message: 'Provider configuration could not be safely resolved.' }]);
}

export async function runProviders(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const phase = options.phase ?? 'status';
  if (!Object.hasOwn(PHASE_OPERATIONS, phase)) return configurationFailure('phase');
  const durable = ['implement', 'verify', 'done'].includes(phase) && options.write === true;
  if (durable && !safeId(options.changeId)) return configurationFailure('change_id');
  let policies;
  try {
    policies = options.policies === undefined ? await readProviderPolicies(rootDir) : normalizeProviderPolicies(options.policies);
  } catch { return configurationFailure('provider_policy'); }
  const active = Object.entries(policies).filter(([, config]) => config.enable
    && (['status', 'doctor'].includes(phase) || config.phases.includes(phase)));
  if (!active.length) return summary([]);
  let revision = null;
  if (['implement', 'verify', 'done'].includes(phase)) {
    try { revision = await (options.revision ?? providerRevision)(rootDir, options); }
    catch { return configurationFailure('revision_unavailable'); }
    if (!revision || !/^[a-f0-9]{40,64}$/.test(revision.commit) || !/^[a-f0-9]{64}$/.test(revision.worktree)) {
      return configurationFailure('revision_shape');
    }
  }
  const providers = [];
  for (const [id, config] of active) {
    let evidence = {
      schemaVersion: '1.0.0', provider: id, kind: PROVIDER_KINDS[id], policy: config.policy,
      phase, changeId: safeId(options.changeId) ? options.changeId : null, revision,
      timestamp: new Date().toISOString(), toolVersion: null, commandContract: null,
      provenance: { boundary: 'process-json', source: config.executable ? 'explicit-executable' : 'path',
        policyDigest: digest(JSON.stringify({ enable: config.enable, policy: config.policy, phases: config.phases, timeoutMs: config.timeoutMs,
          maxOutputBytes: config.maxOutputBytes, executableDigest: config.executable ? digest(config.executable) : null })) },
      status: 'unsupported', reason: 'protocol_unpublished', operations: [], gate: null
    };
    try {
      if (id === 'hlv') {
        const detection = await detectHlv(rootDir, config, options);
        evidence = { ...evidence, status: detection.status, reason: detection.reason,
          toolVersion: detection.version, layout: detection.layout,
          commandContract: detection.version === HLV_COMMAND_CONTRACT.toolVersion
            ? { id: HLV_COMMAND_CONTRACT.id, version: HLV_COMMAND_CONTRACT.version, source: HLV_COMMAND_CONTRACT.source } : null };
        if (detection.status === 'pass') {
          if (phase === 'done' && options.readOnly === true) {
            const savedResults = [];
            let malformed = false;
            if (safeId(options.changeId)) {
              for (const sourcePhase of ['verify', 'done']) {
                const bytes = await readProviderFile(rootDir,
                  `.ai-factory/qa/${options.changeId}/providers/hlv-${sourcePhase}.json`, 4 * 1024 * 1024);
                if (bytes === null) continue;
                try {
                  const saved = JSON.parse(bytes.toString('utf8'));
                  if (saved.schemaVersion !== '1.0.0' || saved.provider !== id || saved.phase !== sourcePhase
                    || saved.changeId !== options.changeId || !Number.isFinite(Date.parse(saved.timestamp))) malformed = true;
                  else savedResults.push(saved);
                } catch { malformed = true; }
              }
            }
            // A later failed observation supersedes an older PASS at the same
            // revision. Never search backwards until a convenient PASS appears.
            savedResults.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
              || Number(['pass', 'warn'].includes(a.status)) - Number(['pass', 'warn'].includes(b.status)));
            const saved = savedResults[0];
            const validated = saved?.operations?.find?.((item) => item.operation === 'validate');
            const verified = !malformed && saved?.toolVersion === detection.version
              && saved?.kind === evidence.kind && saved?.policy === config.policy && saved?.layout === detection.layout
              && saved?.commandContract?.id === HLV_COMMAND_CONTRACT.id
              && saved?.commandContract?.version === HLV_COMMAND_CONTRACT.version
              && saved?.commandContract?.source === HLV_COMMAND_CONTRACT.source
              && saved?.provenance?.boundary === 'process-json' && saved?.provenance?.source === evidence.provenance.source
              && saved?.provenance?.policyDigest === evidence.provenance.policyDigest
              && JSON.stringify(saved?.revision) === JSON.stringify(revision)
              && ['pass', 'warn'].includes(saved?.status) && saved?.gate?.blocking === false
              && ['pass', 'warn'].includes(saved?.gate?.status)
              && ['pass', 'warn'].includes(validated?.status) && validated?.reason === 'validation_result'
              && validated?.summary?.errors === 0 && validated?.streams?.exitCode === 0
              && validated?.streams?.stdout === 'present' && ['present', 'empty'].includes(validated?.streams?.stderr)
              && ['errors', 'warnings', 'infos'].every((key) => Number.isSafeInteger(validated.summary[key])
                && validated.summary[key] >= 0 && validated.summary[key] <= 2000)
              && Array.isArray(validated?.diagnostics)
              && validated.diagnostics.length === validated.summary.warnings + validated.summary.infos
              && validated.diagnostics.filter((item) => item.severity === 'warning').length === validated.summary.warnings
              && validated.status === (validated.summary.warnings ? 'warn' : 'pass')
              && validated.diagnostics.every((item) => /^[A-Z]{2,5}-[0-9]{3}$/.test(item.code)
                && ['warning', 'info'].includes(item.severity));
            evidence.operations.push({ operation: 'validate', status: verified ? validated.status : 'fail',
              reason: verified ? 'current_validation_evidence' : 'validation_evidence_missing_or_stale', diagnostics: [] });
          }
          const operations = phase === 'done' && options.readOnly === true ? ['readiness'] : PHASE_OPERATIONS[phase];
          for (const operation of operations) {
            const noMilestone = evidence.operations.some((item) => item.operation === 'status' && item.summary?.milestone === false
              || item.operation === 'readiness' && item.summary?.applicable === false);
            const result = operation === 'trace' && noMilestone
              ? { status: 'unavailable', reason: 'no_active_milestone', diagnostics: [] }
              : await runHlvOperation(operation, rootDir, config, options);
            evidence.operations.push({ operation, ...result });
          }
          const gates = evidence.operations.filter((item) => item.operation !== 'trace');
          evidence.status = gates.find((item) => !['pass', 'warn'].includes(item.status))?.status
            ?? (gates.some((item) => item.status === 'warn') ? 'warn' : 'pass');
          evidence.reason = 'operations_complete';
        }
      }
      // Lekalo deliberately has no guessed executable or capability commands.
      // The published v0.1.10 contract marks its provider protocol unpublished.
    } catch {
      evidence.status = 'configuration_error';
      evidence.reason = 'unsafe_or_unreadable_provider_layout';
    }
    evidence.gate = providerGate(evidence.status, config.policy);
    providers.push(evidence);
  }
  if (revision !== null) {
    try {
      const after = await (options.revision ?? providerRevision)(rootDir, options);
      if (JSON.stringify(after) !== JSON.stringify(revision)) throw new Error('changed');
    } catch {
      for (const evidence of providers) {
        evidence.status = 'infrastructure_error';
        evidence.reason = 'revision_changed_during_provider_run';
        evidence.gate = { status: 'fail', blocking: true };
      }
    }
  }
  if (durable) {
    for (let index = 0; index < providers.length; index++) {
      const evidence = providers[index];
      try {
        providers[index] = await writeProviderFile(rootDir,
          `.ai-factory/qa/${options.changeId}/providers/${evidence.provider}-${phase}.json`, evidence);
      } catch {
        evidence.status = 'infrastructure_error';
        evidence.reason = 'evidence_write_failed';
        evidence.gate = { status: 'fail', blocking: true };
      }
    }
  }
  return summary(providers);
}

export function providerDiagnostics(result) {
  return [...result.diagnostics, ...result.providers.filter((item) => item.gate.status !== 'pass').map((item) => ({
    code: `provider-${item.provider}-${item.status.replaceAll('_', '-')}`,
    message: `${item.provider}: ${item.status} (${item.reason}); policy=${item.policy}.`,
    blocking: item.gate.blocking, level: item.gate.status
  }))];
}

export function validateNeutralTrace(manifest) {
  const fields = ['requirement', 'semanticSymbol', 'binding', 'scenarioTest', 'gate'];
  if (!manifest || manifest.schemaVersion !== '1.0.0' || !Array.isArray(manifest.links) || manifest.links.length > 2000
    || Object.keys(manifest).some((key) => !['schemaVersion', 'links'].includes(key))) return false;
  return manifest.links.every((link) => link && typeof link === 'object' && !Array.isArray(link)
    && Object.keys(link).every((key) => fields.includes(key))
    && fields.every((field) => link[field] === null || /^sha256:[a-f0-9]{64}$/.test(link[field]))
    && link.requirement !== null && link.gate !== null);
}

export async function runProviderCommand(argv = [], options = {}) {
  const parsed = { phase: argv[0] ?? 'status', write: false };
  let json = false;
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === '--json') json = true;
    else if (argv[index] === '--write') parsed.write = true;
    else if (argv[index] === '--change' && safeId(argv[index + 1])) parsed.changeId = argv[++index];
    else return { exitCode: 2, stdout: '', stderr: 'Invalid provider command arguments.\n' };
  }
  if (!Object.hasOwn(PHASE_OPERATIONS, parsed.phase) || parsed.write && ['status', 'doctor'].includes(parsed.phase)) {
    return { exitCode: 2, stdout: '', stderr: 'Invalid provider phase or write option.\n' };
  }
  const result = await runProviders({ ...options, ...parsed });
  return { exitCode: result.blocking ? 1 : 0, stderr: '', stdout: json ? `${JSON.stringify(result, null, 2)}\n`
    : `Providers: ${result.status}\n${providerDiagnostics(result).map((item) => item.message).join('\n')}\n` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => abort.abort());
  try {
    const result = await runProviderCommand(process.argv.slice(2), { signal: abort.signal });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify(configurationFailure('command_failed'))}\n`);
    process.exitCode = 1;
  }
}
