import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const cfg = read(process.argv[2]);
const here = path.dirname(fileURLToPath(import.meta.url));
const result = read(path.join(cfg.root, 'results.json'));
assert.equal(result.rows.length, 24);
result.method = {
  corpus: 'One related multirepository set, with three exact-commit labelled snapshots',
  arms: 'Same Pi tools and prompts; candidate additionally loads the unmodified native RTK v0.48.0 extension',
  attribution: 'A combined native compression-hook and agent-response experiment; not a deterministic fixed-action replay',
  rawRecovery: 'Normal command required before raw repeat; complete source reads always available in both arms',
  fixtureNoise: '64 controlled documentation line changes per repository in both review scenarios',
  fixes: 'Seeded runtime regressions committed in each disposable repository before the main matrix; model repairs produce visible diffs',
  ordering: 'Sequential calls; arm order alternates by scenario and repetition; no fixed sampler seed',
  quality: 'Predeclared strict criterion: all 12 pairs usable, both arms pass every grader, candidate exposed in every pair',
  benefit: 'At least 15% fewer total tokens, at most 10% more elapsed time, positive median paired token reduction',
  usage: 'Sum input+output+cacheRead+cacheWrite across all assistant messages; ACP zero counters and configured zero prices not used',
  elapsed: 'Wall time of run plus post-run hidden checks; not pure provider latency',
  limitations: ['Small sample', 'Seeded regressions', 'One related repository set', 'Constrained tools', 'No OS sandbox for generated source', 'No complete application or AIFHub lifecycle validation', 'Provider model alias is not weights attestation'],
};
result.audit = read(path.join(cfg.root, 'audit.json'));
result.directProbes = read(path.join(cfg.root, 'probes.json'));
result.supplementary = ['smoke', 'pilot'].map(stage => {
  const data = read(path.join(cfg.root, `${stage}.json`));
  return { stage, includedInMainComparison: false,
    reason: stage === 'smoke' ? 'Connectivity only; no tool calls' : 'Pre-matrix pilot; fix seeds were still uncommitted, so restoring original source gave empty final diffs. Protocol corrected before main inference.',
    provenance: data.provenance, rows: data.rows };
});
result.analysisProvenance = Object.fromEntries(['summarize.mjs', 'audit.mjs', 'probe.mjs', 'publish.mjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(here, file))).digest('hex')]));
result.retention = { rawArtifactsDeleted: false, status: 'cleanup_pending', publicArtifacts: 'Aggregate results and harness only; no raw traces, source copies or private label map' };
const serialized = JSON.stringify(result, null, 2) + '\n';
assert(!(cfg.forbiddenNames || []).some(name => serialized.toLowerCase().includes(name.toLowerCase())), 'Private name in publishable result');
assert(!/[A-Za-z]:[\\/]/.test(serialized), 'Absolute Windows path in publishable result');
assert(!/"(?:sandbox|finalText|commandEnv|apiKey|api_key|commands)"\s*:/.test(serialized), 'Raw field in publishable result');
fs.writeFileSync(process.argv[3], serialized);
console.log(JSON.stringify({ publishedAggregateFile: path.basename(process.argv[3]), observations: result.rows.length, auditPass: result.audit.pass }));
