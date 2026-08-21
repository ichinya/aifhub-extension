import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadRecommendationMetadata } from './memory-tool-recommender.mjs';
import { validateUnderstandAnythingScenarioCatalog } from './understand-anything-ai-tester-matrix.mjs';

const ROOT = path.resolve('.');
const METADATA = path.join(ROOT, 'docs', 'memory-tools-research', 'recommendation-metadata.yaml');
const RESEARCH = path.join(ROOT, 'docs', 'memory-tools-research', 'understand-anything.md');
const BENCHMARK = path.join(ROOT, 'docs', 'memory-tools-research', 'understand-anything-benchmark-results.md');
const CATALOG = path.join(ROOT, 'docs', 'memory-tools-research', 'understand-anything-ai-tester-scenarios.json');

describe('Understand Anything durable policy artifacts', () => {
  it('pins exact identity and keeps every normal command forbidden without a probe', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: METADATA });
    const tool = metadata.tools['understand-anything'];

    assert.equal(tool.repository, 'https://github.com/Egonex-AI/Understand-Anything');
    assert.match(tool.tested_version, /v2\.9\.0/);
    assert.match(tool.tested_version, /f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8/);
    assert.equal(tool.decision, 'reject_defer');
    assert.deepEqual(tool.allowed_in, []);
    assert.equal(metadata.tool_permissions['understand-anything'].default, 'forbidden');
    assert.equal(Object.hasOwn(metadata.availability_probes, 'understand-anything'), false);
    for (const [command, policy] of Object.entries(metadata.skill_usage_matrix)) {
      assert.ok(policy.forbidden.includes('understand-anything'), command);
    }
  });

  it('separates synthetic contract evidence from actual provider provenance and honest NOT_RUN claims', async () => {
    const research = await readFile(RESEARCH, 'utf8');
    const benchmark = await readFile(BENCHMARK, 'utf8');

    assert.match(research, /synthetic_schema_fixture/);
    assert.match(research, /provider-generated|provider generation/i);
    assert.match(research, /NOT_RUN\(lifecycle_unavailable\)/);
    assert.match(research, /Historical Comparator Caveat/);
    assert.match(benchmark, /16\/16 runner rows executed/);
    assert.match(benchmark, /8\/8 pair identities/);
    assert.match(benchmark, /16\/16.*privacy.*FAIL/is);
    assert.match(benchmark, /ua-luna-low-20260722-r3/);
    assert.match(benchmark, /provider_generated/);
    assert.match(benchmark, /synthetic_evidence_non_promotable/);
    assert.match(benchmark, /SKIPPED\(lifecycle_unavailable\)/);
    assert.match(benchmark, /no_promote|--no-promote/);
    assert.match(benchmark, /Raw synthetic traces.*purged.*full-trace privacy scan/is);
    assert.doesNotMatch(benchmark, /Raw synthetic traces are retained/i);
  });

  it('pins the exact Luna profile and pair identity contract', async () => {
    const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
    assert.deepEqual(validateUnderstandAnythingScenarioCatalog(catalog), []);
    assert.equal(catalog.defaults.runtime, 'codex');
    assert.equal(catalog.defaults.model, 'gpt-5.6-luna');
    assert.equal(catalog.defaults.reasoning, 'low');
    assert.equal(catalog.defaults.repetitions, 2);
    assert.equal(catalog.defaults.no_promote, true);
  });

  it('keeps public evidence free of local paths, secrets and raw payload markers', async () => {
    const files = [
      RESEARCH,
      BENCHMARK,
      METADATA,
      path.join(ROOT, 'docs', 'memory-tools-research', 'README.md'),
      path.join(ROOT, 'docs', 'context-providers.md'),
      path.join(ROOT, 'docs', 'memory-tool-recommendations.md')
    ];
    const content = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
    assert.doesNotMatch(content, /[A-Za-z]:\\Users\\|\/Users\/[^/]+\/|\/home\/[^/]+\//);
    assert.doesNotMatch(content, /BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
    assert.doesNotMatch(content, /(?:api[_-]?key|password|authorization)\s*[:=]\s*\S+/i);
    assert.doesNotMatch(content, /"finalOutput"\s*:|"knowledge-graph"\s*:\s*\{/);
    assert.match(content, /OpenSpec/);
    assert.match(content, /generated rules/);
    assert.match(content, /QA/);
  });
});
