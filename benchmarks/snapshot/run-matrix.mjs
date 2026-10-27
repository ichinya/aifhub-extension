import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createFixture, capture, restore, git, isolatedEnvironment, REVISION, sha256, topology } from './fixture.mjs';
import { moduleHashes, validateIdentity } from './run-arm.mjs';
import { aggregateStatus, summarize } from './summarize.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const catalogSchema = JSON.parse(await fs.readFile(new URL('../../schemas/snapshot-benchmark-catalog.schema.json', import.meta.url), 'utf8'));
const resultsSchema = JSON.parse(await fs.readFile(new URL('../../schemas/snapshot-benchmark-results.schema.json', import.meta.url), 'utf8'));
export function catalogFingerprint(catalog) {
  const { catalog_digest: _digest, ...content } = catalog;
  return sha256(JSON.stringify(content));
}
// The two closed schemas use this deliberately small, dependency-free subset.
export function conforms(value, schema) {
  if (schema.anyOf && !schema.anyOf.some(s => conforms(value, s))) return false;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && ![schema.type].flat().some(t => t === type || t === 'integer' && Number.isInteger(value))) return false;
  if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (type === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return false;
    if (schema.items && !value.every(v => conforms(v, schema.items))) return false;
  }
  if (type === 'object') {
    if (Object.keys(value).length < (schema.minProperties ?? 0) || schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames && !conforms(key, schema.propertyNames)) return false;
      if (schema.properties?.[key]) { if (!conforms(item, schema.properties[key])) return false; }
      else if (schema.additionalProperties === false || typeof schema.additionalProperties === 'object' && !conforms(item, schema.additionalProperties)) return false;
    }
  }
  return true;
}
export function validateCatalog(catalog) {
  const errors = [], ids = new Set();
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return ['catalog-schema'];
  if (!conforms(catalog, catalogSchema)) errors.push('catalog-schema');
  if (catalog.catalog_digest !== catalogFingerprint(catalog)) errors.push('catalog-digest');
  if (catalog.arms?.length && (catalog.arms.length !== 2 || catalog.arms.some(a => !validateIdentity(a.identity)))) errors.push('catalog-arms');
  if (catalog?.schema !== 'aifhub.snapshot.ab_scenario_catalog.v1' || catalog.no_promote !== true || catalog.generator_revision !== REVISION) errors.push('catalog-contract');
  if (!Number.isInteger(catalog?.seed) || !Number.isInteger(catalog?.order_seed) || catalog?.repeats !== 10 || catalog?.warmups !== 2) errors.push('catalog-protocol');
  if (!Array.isArray(catalog?.privacy_canaries) || !catalog.privacy_canaries.length) errors.push('catalog-privacy');
  if (!Array.isArray(catalog?.scenarios) || !catalog.scenarios.length || catalog.scenarios.length > 200) return [...errors, 'catalog-scenarios'];
  for (const s of catalog.scenarios) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) { errors.push('scenario-shape'); continue; }
    if (!/^[A-Za-z0-9-]+$/.test(s.id) || ids.has(s.id)) errors.push('scenario-id'); ids.add(s.id);
    if (!'WSBIHFN'.includes(s.family) || s.family.length !== 1 || !Number.isInteger(s.leaves) || s.leaves < 32 || s.leaves > 10000) errors.push('scenario-shape');
    try { topology(s.modules); } catch { errors.push('scenario-topology'); }
    if (!Array.isArray(s.expected_codes) || !s.expected_codes.every(c => /^[a-z-]+$/.test(c))) errors.push('scenario-outcome');
    if (s.family === 'B' && !['1,2,3', '3,2,1'].includes(String(s.order))) errors.push('scenario-batch');
    const operations = { W: ['snapshot'], F: ['snapshot'], S: ['lifecycle', 'result-replay', 'accept-replay'], B: ['lifecycle', 'replay'], I: ['preflight'], H: ['start'], N: ['negative'] };
    if (!operations[s.family]?.includes(s.operation)) errors.push('scenario-operation');
    const variants = { W: ['normal', 'tracked-dirty', 'untracked', 'ignored-in-scope'], F: ['normal', 'linked', 'detached', 'old-form', 'gitfile', 'divergent', 'eol', 'filter'],
      S: ['normal', 'creation', 'deletion'], B: ['normal'], I: ['normal'], H: ['normal'], N: ['bytes', 'ignored', 'mode', 'scope', 'metadata', 'metadata-during-read', 'identity-replacement', 'hardlink', 'symlink', 'junction', 'oversize', 'size-boundary', 'count', 'interrupted'] };
    if (!variants[s.family]?.includes(s.variant) || ['I', 'H'].includes(s.family) && s.modules !== 0) errors.push('scenario-recipe');
  }
  return [...new Set(errors)];
}
export function balancedOrder(seed, index, names = ['A0', 'A-first']) {
  return ((seed >>> 0) + index) % 2 ? [...names].reverse() : [...names];
}
export function privacyCheck(value, canaries) {
  const text = JSON.stringify(value);
  return canaries.every(canary => !text.toLowerCase().includes(canary.toLowerCase()));
}
export function validateResults(value) {
  const errors = [];
  if (!conforms(value, resultsSchema)) return ['results-schema'];
  if (value?.schema !== 'aifhub.snapshot.ab_results.v1' || value.no_promote !== true || !Array.isArray(value.rows)) return ['results-contract'];
  if (!Array.isArray(value.arms) || value.arms.length !== 2 || value.arms.some(a => !validateIdentity(a.identity))) errors.push('results-arms');
  for (const row of value.rows) {
    if (!['PASS', 'FAIL', 'NOTRUN'].includes(row.status) || !['process-cold', 'process-warm', 'diagnostic'].includes(row.profile)) errors.push('results-status');
    if (row.wall_ms !== null && (!Number.isFinite(row.wall_ms) || row.wall_ms < 0)) errors.push('results-latency');
    if ((row.status === 'NOTRUN' || row.profile === 'diagnostic') && row.wall_ms !== null) errors.push('results-unavailable-latency');
    if (row.status === 'PASS' && (row.expected !== true || row.unchanged !== true || !/^[a-f0-9]{64}$/.test(row.fixture_digest ?? ''))) errors.push('results-proof');
  }
  const armNames = value.arms.map(a => a.name);
  if (new Set(armNames).size !== 2 || value.rows.some(r => !armNames.includes(r.arm))) errors.push('results-arm-binding');
  const keys = value.rows.map(r => JSON.stringify([r.scenario, r.profile, r.repeat, r.arm]));
  if (new Set(keys).size !== keys.length) errors.push('results-duplicate-repeat');
  const actual = summarize(value.rows, armNames);
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  if (value.status !== aggregateStatus(actual) || JSON.stringify(stable(value.summaries)) !== JSON.stringify(stable(actual))) errors.push('results-aggregate');
  if (actual.some(group => group.status === 'PASS' && Object.values(group.arms).some(arm => arm.pass !== (group.key.endsWith('/diagnostic') ? 1 : 10)))) errors.push('results-incomplete-repeats');
  return [...new Set(errors)];
}
function unavailableRow(code = 'capability-unavailable') {
  return { status: 'NOTRUN', code, wall_ms: null, fs: null, git: null, peak_rss_kib: null, semantic_digest: null, fixture_digest: null, expected: null, unchanged: null };
}
async function child(config, timeout) {
  return new Promise(resolve => {
    const proc = execFile(process.execPath, [path.join(directory, 'run-arm.mjs')],
      { env: config.fixture.env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        try { const result = JSON.parse(stdout); resolve(result); }
        catch { resolve([error?.code === 'EPERM' ? unavailableRow('NOTRUN-sandbox') : { ...unavailableRow(error?.killed ? 'timeout' : 'child-error'), status: error?.killed ? 'NOTRUN' : 'FAIL' }]); }
      });
    proc.stdin?.on('error', () => {}); proc.stdin?.end(JSON.stringify(config));
  });
}
export async function runMatrix({ arms, catalog, selected, profiles = catalog.profiles, timeout = 3600000 }) {
  if (validateCatalog(catalog).length) throw new Error('invalid-catalog');
  if (!Array.isArray(arms) || arms.length !== 2 || new Set(arms.map(a => a.name)).size !== 2
    || arms.some(a => !/^[A-Za-z0-9-]{1,40}$/.test(a.name) || !validateIdentity(a.identity) || !path.isAbsolute(a.root))) throw new Error('invalid-arms');
  const boundCatalog = { ...catalog, arms: arms.map(({ name, identity }) => ({ name, identity })) };
  if (catalog.arms.length && JSON.stringify(catalog.arms) !== JSON.stringify(boundCatalog.arms)) throw new Error('catalog-arm-mismatch');
  if (catalog.generator_digest !== sha256(await fs.readFile(path.join(directory, 'fixture.mjs')))) throw new Error('generator-identity-mismatch');
  boundCatalog.catalog_digest = catalogFingerprint(boundCatalog);
  if (profiles.some(p => !catalog.profiles.includes(p))) throw new Error('invalid-profile');
  const scenarios = catalog.scenarios.filter(s => !selected || selected.includes(s.id));
  if (!scenarios.length || selected?.some(id => !catalog.scenarios.some(s => s.id === id))) throw new Error('unknown-scenario');
  const rows = [], fixtures = []; let gitVersion = 'UNKNOWN';
  const publicArms = arms.map(({ name, identity }) => ({ name, identity }));
  let index = 0;
  for (const scenario of scenarios) {
    const scenarioOrdinal = index++;
    let fixture;
    try { fixture = await createFixture(scenario); }
    catch (error) {
      const unavailable = ['EPERM', 'EACCES', 'ENOENT', 'ENOTSUP'].includes(error.code);
      for (const profile of profiles) for (const arm of arms) for (let repeat = 0; repeat < (profile === 'diagnostic' ? 1 : catalog.repeats); repeat++) rows.push({ scenario: scenario.id, profile, repeat, arm: arm.name,
        ...unavailableRow(error.code === 'EPERM' ? 'NOTRUN-sandbox' : unavailable ? 'fixture-unavailable' : 'fixture-error'), status: unavailable ? 'NOTRUN' : 'FAIL' });
      continue;
    }
    try {
      gitVersion = await git(fixture.root, fixture.env, '--version');
      const serialized = { container: fixture.container, token: fixture.token, root: fixture.root, env: fixture.env, modules: fixture.modules, workers: fixture.workers, target: fixture.target, manifest: fixture.manifest };
      // Prepare once with the reference arm. Both arms start from these exact physical bytes.
      const prepared = await child({ root: arms[0].root, identity: arms[0].identity, fixture: serialized, scenario, prepareOnly: true }, timeout);
      if (!prepared.prepared) {
        for (const profile of profiles) for (const arm of arms) for (let repeat = 0; repeat < (profile === 'diagnostic' ? 1 : catalog.repeats); repeat++) rows.push({ scenario: scenario.id, profile, repeat, arm: arm.name, ...(prepared[0] ?? unavailableRow('setup-unavailable')) });
        continue;
      }
      Object.assign(serialized, { targets: prepared.targets, replay: prepared.replay });
      const roots = [...new Set([fixture.root, ...fixture.workers])], images = await Promise.all(roots.map(capture));
      const reset = async () => { for (let n = 0; n < roots.length; n++) await restore(roots[n], images[n]); };
      fixtures.push({ scenario: scenario.id, generator: REVISION, semantic_digest: fixture.manifest.digest, leaf_count: fixture.manifest.leaves.length,
        repositories: 1 + fixture.modules.length, physical_identity: sha256(JSON.stringify(await fs.stat(fixture.root, { bigint: true }), (k, v) => typeof v === 'bigint' ? String(v) : v)) });
      for (const profile of profiles) {
        const repeats = profile === 'process-cold' ? catalog.repeats : 1;
        for (let repeat = 0; repeat < repeats; repeat++) {
          for (const name of balancedOrder(catalog.order_seed, scenarioOrdinal + repeat, arms.map(a => a.name))) {
            const arm = arms.find(a => a.name === name); await reset();
            const output = await child({ root: arm.root, identity: arm.identity, fixture: serialized, scenario, profile,
              repeats: catalog.repeats, prepared: true, traceFile: path.join(fixture.container, 'trace.jsonl') }, timeout);
            const expectedRows = profile === 'process-warm' ? catalog.repeats : 1;
            for (let n = 0; n < Math.max(expectedRows, output.length); n++) rows.push({ scenario: scenario.id, profile, repeat: profile === 'process-warm' ? n : repeat,
              arm: name, ...(output[n] ?? unavailableRow('incomplete-arm-output')) });
          }
        }
      }
    } catch (error) {
      const unavailable = error.code === 'EPERM';
      for (const profile of profiles) for (const arm of arms) rows.push({ scenario: scenario.id, profile, repeat: catalog.repeats, arm: arm.name,
        ...unavailableRow(unavailable ? 'NOTRUN-sandbox' : 'fixture-revalidation-error'), status: unavailable ? 'NOTRUN' : 'FAIL' });
    } finally { await fixture.cleanup(); }
  }
  const result = { schema: 'aifhub.snapshot.ab_results.v1', no_promote: true, catalog_digest: boundCatalog.catalog_digest,
    harness_digest: sha256((await Promise.all(['fixture.mjs', 'run-arm.mjs', 'run-matrix.mjs', 'summarize.mjs'].map(n => fs.readFile(path.join(directory, n))))).map(sha256).join('')),
    environment: { os: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model ?? 'UNKNOWN', memory_bytes: os.totalmem(), node: process.version,
      git: gitVersion, filesystem: 'UNKNOWN', storage: 'UNKNOWN', antivirus: 'UNKNOWN', indexer: 'UNKNOWN', os_cache: 'uncontrolled', peak_rss_scope: 'whole arm process high-water mark', concurrency: 1 },
    arms: publicArms, fixtures, rows, summaries: summarize(rows, arms.map(a => a.name)) };
  result.environment.git_config = { autocrlf: false, filemode: process.platform !== 'win32', system_config: false, global_config: 'isolated-empty', filters: 'scenario-local', fixed_dates: true };
  result.status = aggregateStatus(result.summaries);
  if (!privacyCheck(result, catalog.privacy_canaries)) throw new Error('privacy-veto');
  if (validateResults(result).length) throw new Error('invalid-results');
  return result;
}
function argumentsFor(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--pin', '--source', '--arms', '--out', '--scenarios', '--profiles'].includes(args[i]) || args[i + 1] === undefined || options[args[i]]) throw new Error('invalid-arguments');
    options[args[i]] = args[i + 1];
  }
  return options;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = argumentsFor(process.argv.slice(2));
    if (!options['--out']) throw new Error('out-required');
    let value;
    if (options['--pin']) {
      const root = await fs.realpath(path.resolve(options['--pin'])), home = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-pin-'));
      try {
        await fs.writeFile(path.join(home, 'empty.gitconfig'), '');
        const env = isolatedEnvironment(home);
        value = { commit: await git(root, env, 'rev-parse', 'HEAD'), source: options['--source'] ?? 'committed', modules: await moduleHashes(root) };
        if (!validateIdentity(value)) throw new Error('invalid-arm-identity');
        const { verifyIdentity } = await import('./run-arm.mjs'); await verifyIdentity(root, value, env);
      } finally { await fs.rm(home, { recursive: true, force: true }); }
    } else {
      const arms = JSON.parse(await fs.readFile(options['--arms'], 'utf8'));
      value = await runMatrix({ arms, catalog: JSON.parse(await fs.readFile(path.join(directory, 'scenarios.json'), 'utf8')),
        selected: options['--scenarios']?.split(','), ...(options['--profiles'] ? { profiles: options['--profiles'].split(',') } : {}) });
    }
    await fs.writeFile(options['--out'], JSON.stringify(value, null, 2) + '\n');
    console.log(value.schema ? `Snapshot matrix: ${value.status}, ${value.rows.length} rows; no_promote=true.` : 'Snapshot arm identity pinned.');
    if (value.status === 'FAIL') process.exitCode = 1;
  } catch { console.error('Snapshot benchmark rejected input or execution; no performance claim.'); process.exitCode = 1; }
}
