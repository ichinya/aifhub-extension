// Hermetic protocol fixture. Never evidence of the installed Lekalo binary.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const privateText = 'fixture-secret /private/account token=do-not-persist';
export const projectYaml = 'schema_version: "0.2.16"\ndefinitions:\n  - id: fixture\n    kind: project\n    version: 1\n';
const diagnostic = severity => ({ schema_version: 'lekalo/diagnostic/v0.2.16', registry_version: '0.6.4',
  id: 'semantic.fixture', code: 'LEK-SEM-001', severity, category: 'semantic', message_id: 'semantic.fixture',
  message: privateText, data: { privateText }, related_locations: [], causes: [], fixes: [], metadata: {} });

export async function fakeLekalo(args, env = {}, cwd = process.cwd()) {
  const reply = (payload, exitCode = 0) => ({ outcome: 'completed', exitCode,
    stdout: [1, 5].includes(exitCode) ? '' : JSON.stringify(payload),
    stderr: [1, 5].includes(exitCode) ? JSON.stringify(payload) : privateText });
  if (args[0] === '--version') return { outcome: 'completed', exitCode: 0,
    stdout: env.AIF_TEST_LEKALO_VERSION_SHAPE ?? `lekalo ${env.AIF_TEST_LEKALO_VERSION ?? '1.1.0'}\n`, stderr: '' };
  if (args[0] === 'provider') {
    const payload = JSON.parse(await readFile(new URL('./lekalo-describe-v0.8.0.json', import.meta.url), 'utf8'));
    if (env.AIF_TEST_LEKALO_MANIFEST === 'identity') payload.manifest.identity = 'dev.lekalo.workflow-provider@9.0.0';
    if (env.AIF_TEST_LEKALO_MANIFEST === 'field') payload.manifest.unknown = privateText;
    if (env.AIF_TEST_LEKALO_MANIFEST === 'operation') payload.manifest.operations.push({ id: 'unknown' });
    if (env.AIF_TEST_LEKALO_MANIFEST === 'pin') payload.manifest.schemaPins[0].schemaVersion = 'unknown';
    return reply(payload);
  }
  if (args[0] === 'init') {
    if (env.AIF_TEST_LEKALO_INIT === 'refuse') return reply({ status: 'denied', diagnostics: [diagnostic('error')] }, 3);
    if (args[1] !== '--adopt' || args[2] !== '--project' || args[3] !== cwd) return reply({}, 2);
    await mkdir(path.join(cwd, 'lekalo'), { recursive: true });
    await writeFile(path.join(cwd, 'lekalo/project.yaml'), projectYaml, { flag: 'wx' });
    return reply({ status: 'valid' });
  }
  if (env.AIF_TEST_LEKALO_SHAPE === 'invalid') return { outcome: 'completed', exitCode: 0, stdout: privateText, stderr: '' };
  if (env.AIF_TEST_LEKALO_OVERFLOW) return { outcome: 'completed', exitCode: 0,
    stdout: JSON.stringify({ privateText: privateText.repeat(200000) }), stderr: '' };
  const exit = Number(env.AIF_TEST_LEKALO_EXIT ?? 0);
  if (exit) return reply({ status: { 1: 'invalid', 3: 'denied', 4: env.AIF_TEST_LEKALO_ABSENCE ?? 'unavailable', 5: 'unsupported-version' }[exit],
    diagnostics: [diagnostic('error')] }, exit);
  let payload;
  if (['status', 'doctor', 'readiness'].includes(args[0])) {
    const verdict = env.AIF_TEST_LEKALO_VERDICT ?? 'ready';
    payload = { status: 'valid', schemaVersion: 'lekalo/doctor/v0.3.2', identity: 'dev.lekalo.doctor@0.3.2',
      report: args[0], productVersion: '1.1.0', verdict,
      checks: [{ id: 'project.root', required: true, state: verdict === 'blocked' ? 'blocked' : 'ok' },
        { id: 'integrations.hlv', required: false, state: verdict === 'degraded' ? 'degraded' : 'ok' }] };
    if (args[0] === 'readiness') payload.phase = 'release';
  } else if (args[0] === 'validate') {
    if (!args.includes('--no-cache')) return reply({}, 2);
    const severity = env.AIF_TEST_LEKALO_RECEIPT;
    const diagnostics = severity ? [diagnostic(severity)] : [];
    payload = { status: 'valid', modelVersion: '0.2.16', validation: { profile: 'default', profileVersion: '0.6.4',
      registryVersion: '0.6.4', rulesEnabled: 1,
      counts: { error: severity === 'error' ? 1 : 0, warning: severity === 'warning' ? 1 : 0, info: severity === 'info' ? 1 : 0 } } };
    if (severity) Object.assign(payload, { diagnostics, reasonCodes: diagnostics.map(item => item.id) });
  } else if (args[0] === 'impact') {
    payload = { status: 'valid', impact: { schemaVersion: 'lekalo/impact/v0.2.16', identity: 'dev.lekalo.impact@0.2.16',
      digest: hash('impact'),
      roots: env.AIF_TEST_LEKALO_IMPACT === 'empty' ? [] : ['operation:fixture.changed'],
      direct: { items: env.AIF_TEST_LEKALO_IMPACT === 'empty' ? [] : [{ subject: 'entity:fixture.account' }] },
      transitive: { items: [] }, mandatoryPublic: { items: [] },
      completeness: { complete: !env.AIF_TEST_LEKALO_PARTIAL } } };
  } else if (args[0] === 'context') {
    payload = { status: 'valid', context: { schemaVersion: 'lekalo/context/v0.8.0', identity: 'dev.lekalo.context@0.8.0',
      complete: !env.AIF_TEST_LEKALO_PARTIAL,
      budget: { estimated: 100, fits: !env.AIF_TEST_LEKALO_PARTIAL, limit: 5000, minimumRequired: env.AIF_TEST_LEKALO_PARTIAL ? 6000 : 100 },
      manifest: { excluded: env.AIF_TEST_LEKALO_PARTIAL ? [{ id: privateText, reason: 'budget', section: 'symbol' }] : [], included: [] },
      sections: { privateText } } };
  } else if (args[0] === 'trace' && args[1] === 'export') {
    const trace = { schemaVersion: 'lekalo/trace-manifest/v0.2.16', identity: 'dev.lekalo.trace-manifest@0.2.16',
      completeness: 'partial', nodes: [], relations: [], gaps: [{ reason: privateText }],
      ...(env.AIF_TEST_LEKALO_TRACE_BIG ? { padding: 'x'.repeat(2 * 1024 * 1024) } : {}) };
    payload = { status: 'valid', trace, manifestDigest: hash(JSON.stringify(trace)) };
  } else return reply({}, 2);
  if (env.AIF_TEST_LEKALO_ADDITIVE) payload.future = { privateText };
  return reply(payload);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await fakeLekalo(process.argv.slice(2), process.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
