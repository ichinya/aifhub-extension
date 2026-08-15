// ultra-research-resolver.test.mjs - deterministic ultra research selection and integrity tests
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  deriveUltraResearchBundlesDir,
  digestUltraResearchActiveSummary,
  inspectUltraResearchBundle,
  normalizeUltraResearchActiveSummary,
  resolveUltraResearchSource,
  ULTRA_RESEARCH_MARKER
} from './ultra-research-resolver.mjs';

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createProject() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-ultra-research-'));
  temporaryRoots.push(rootDir);
  await mkdir(path.join(rootDir, '.ai-factory', 'research'), { recursive: true });
  return rootDir;
}

async function writeBundle(rootDir, slug, options = {}) {
  const bundleDir = path.join(rootDir, '.ai-factory', 'research', slug);
  await mkdir(bundleDir, { recursive: true });
  const status = options.status ?? 'active';
  const researchStatus = options.researchStatus ?? status;
  const updated = options.updated ?? '2026-08-14 12:00';
  const marker = options.marker ?? ULTRA_RESEARCH_MARKER;
  const links = options.links ?? ['RESEARCH.md'];
  const linkRows = links
    .map((filename) => `| [${filename}](${filename}) | fixture | Required | active |`)
    .join('\n');
  const index = options.index ?? `${marker}\n# Research Index: ${slug}\n\nTopic: ${slug}\nSlug: ${slug}\nUpdated: ${updated}\nStatus: ${status}\n\n## Artifact Index\n\n| Artifact | Purpose | Why included | Status |\n|----------|---------|--------------|--------|\n${linkRows}\n\n## Reading Order\n1. [RESEARCH.md](RESEARCH.md)\n`;
  const summary = options.summary ?? `Topic: ${slug}\nGoal: preserve evidence\nDecisions: none\nOpen questions: none\nNext step: plan`;
  const research = options.research ?? `# Research: ${slug}\n\nUpdated: ${updated}\nStatus: ${researchStatus}\nIndex: [INDEX.md](INDEX.md)\n\n## Active Summary (input for /aif-plan)\n<!-- aif:active-summary:start -->\n${summary}\n<!-- aif:active-summary:end -->\n\n## Sessions\n<!-- aif:sessions:start -->\n<!-- aif:sessions:end -->\n`;

  await writeFile(path.join(bundleDir, 'INDEX.md'), index, 'utf8');
  await writeFile(path.join(bundleDir, 'RESEARCH.md'), research, 'utf8');
  for (const [filename, content] of Object.entries(options.extraFiles ?? {})) {
    await writeFile(path.join(bundleDir, filename), content, 'utf8');
  }
  return bundleDir;
}

describe('ultra research bundle root derivation', () => {
  it('derives the sibling research directory from paths.research without config state', () => {
    assert.deepEqual(deriveUltraResearchBundlesDir('.ai-factory/RESEARCH.md'), {
      ok: true,
      researchPath: '.ai-factory/RESEARCH.md',
      bundlesDir: '.ai-factory/research',
      error: null
    });
    assert.deepEqual(deriveUltraResearchBundlesDir('docs/discovery/current.md'), {
      ok: true,
      researchPath: 'docs/discovery/current.md',
      bundlesDir: 'docs/discovery/research',
      error: null
    });
    assert.equal(deriveUltraResearchBundlesDir('../outside.md').ok, false);
  });
});

describe('ultra research selection precedence', () => {
  it('selects a safe explicit RESEARCH.md path before a conflicting exact slug', async () => {
    const rootDir = await createProject();
    await writeBundle(rootDir, 'billing-ledger');
    await writeBundle(rootDir, 'partner-sync');

    const result = await resolveUltraResearchSource({
      rootDir,
      explicitResearchPath: '.ai-factory/research/billing-ledger/RESEARCH.md',
      exactSlug: 'partner-sync'
    });

    assert.equal(result.ok, true);
    assert.equal(result.diagnostic.selection, 'explicit-path');
    assert.equal(result.source.slug, 'billing-ledger');
    assert.equal(result.source.path, '.ai-factory/research/billing-ledger/RESEARCH.md');
  });

  it('selects an exact active slug without recency or fuzzy override', async () => {
    const rootDir = await createProject();
    await writeBundle(rootDir, 'older-exact', { updated: '2026-01-01 00:00' });
    await writeBundle(rootDir, 'newer-other', { updated: '2026-12-31 23:59' });

    const result = await resolveUltraResearchSource({ rootDir, exactSlug: 'older-exact' });

    assert.equal(result.ok, true);
    assert.equal(result.diagnostic.selection, 'exact-slug');
    assert.equal(result.source.slug, 'older-exact');
    assert.equal(result.revision.updated, '2026-01-01 00:00');
  });

  it('selects exactly one caller-reviewed relevant active bundle', async () => {
    const rootDir = await createProject();
    await writeBundle(rootDir, 'billing-ledger');
    await writeBundle(rootDir, 'partner-sync');

    const result = await resolveUltraResearchSource({
      rootDir,
      relevantSlugs: ['partner-sync']
    });

    assert.equal(result.ok, true);
    assert.equal(result.diagnostic.selection, 'implicit-relevant');
    assert.equal(result.source.slug, 'partner-sync');
    assert.equal(result.diagnostic.candidateCount, 2);
  });

  it('stops on ambiguity and never resolves it by Updated recency', async () => {
    const rootDir = await createProject();
    await writeBundle(rootDir, 'older-topic', { updated: '2025-01-01 00:00' });
    await writeBundle(rootDir, 'newer-topic', { updated: '2026-12-31 23:59' });

    const result = await resolveUltraResearchSource({
      rootDir,
      relevantSlugs: ['older-topic', 'newer-topic']
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'ultra-research-ambiguous');
    assert.deepEqual(result.candidates, [
      '.ai-factory/research/newer-topic/RESEARCH.md',
      '.ai-factory/research/older-topic/RESEARCH.md'
    ]);
  });
});

describe('ultra research bundle integrity and safety', () => {
  it('returns an exact safe source, normalized revision, and linked artifact set', async () => {
    const rootDir = await createProject();
    const summary = 'Topic: billing\nGoal: stable ledger   \n<!-- private note -->\nDecisions: retain\n';
    await writeBundle(rootDir, 'billing-ledger', {
      summary,
      links: ['RESEARCH.md', 'C4-CONTEXT.md'],
      extraFiles: { 'C4-CONTEXT.md': '# Context\n' }
    });

    const result = await resolveUltraResearchSource({ rootDir, exactSlug: 'billing-ledger' });
    const expectedNormalized = 'Topic: billing\nGoal: stable ledger\n\nDecisions: retain\n';
    const expectedDigest = createHash('sha256').update(expectedNormalized).digest('hex');

    assert.equal(result.ok, true);
    assert.deepEqual(result.source, {
      kind: 'ultra-research',
      slug: 'billing-ledger',
      path: '.ai-factory/research/billing-ledger/RESEARCH.md',
      bundlePath: '.ai-factory/research/billing-ledger',
      indexPath: '.ai-factory/research/billing-ledger/INDEX.md',
      status: 'active'
    });
    assert.equal(result.content.normalizedActiveSummary, expectedNormalized);
    assert.equal(result.revision.sha256, expectedDigest);
    assert.deepEqual(result.artifacts, ['RESEARCH.md', 'C4-CONTEXT.md']);
  });

  it('normalizes LF, trailing spaces, comments, Source lines, and one final newline', () => {
    const input = 'Source: ignored\r\nTopic: x  \r\n<!-- one\r\ntwo -->\r\nGoal: y\r\n\r\n';
    const normalized = normalizeUltraResearchActiveSummary(input);
    const digest = digestUltraResearchActiveSummary(input);

    assert.equal(normalized, 'Topic: x\n\nGoal: y\n');
    assert.equal(digest.normalized, normalized);
    assert.equal(digest.sha256, createHash('sha256').update(normalized).digest('hex'));
  });

  it('rejects missing, duplicate, and code-only markers', async () => {
    for (const [label, marker] of [
      ['missing', ''],
      ['duplicate', `${ULTRA_RESEARCH_MARKER}\n${ULTRA_RESEARCH_MARKER}`],
      ['code-only', `\`${ULTRA_RESEARCH_MARKER}\``]
    ]) {
      const rootDir = await createProject();
      await writeBundle(rootDir, `${label}-marker`, { marker });
      const result = await resolveUltraResearchSource({ rootDir, exactSlug: `${label}-marker` });
      assert.equal(result.ok, false, label);
      assert.equal(result.errors[0].code, 'ultra-research-marker-invalid', label);
    }
  });

  it('rejects unsafe Artifact Index links and missing direct files', async () => {
    const cases = [
      ['unsafe-link', ['RESEARCH.md', '../outside.md'], 'ultra-research-link-unsafe'],
      ['missing-link', ['RESEARCH.md', 'ADR-0001-choice.md'], 'ultra-research-path-missing'],
      ['duplicate-link', ['RESEARCH.md', 'C4-CONTEXT.md', 'C4-CONTEXT.md'], 'ultra-research-artifact-link-duplicate']
    ];

    for (const [slug, links, expectedCode] of cases) {
      const rootDir = await createProject();
      await writeBundle(rootDir, slug, {
        links,
        extraFiles: slug === 'duplicate-link' ? { 'C4-CONTEXT.md': '# Context\n' } : {}
      });
      const result = await resolveUltraResearchSource({ rootDir, exactSlug: slug });
      assert.equal(result.ok, false, slug);
      assert.equal(result.errors[0].code, expectedCode, slug);
    }
  });

  it('rejects traversal and absolute explicit paths before reading candidates', async () => {
    const rootDir = await createProject();
    for (const explicitResearchPath of [
      '../outside/RESEARCH.md',
      path.resolve(rootDir, '.ai-factory/research/topic/RESEARCH.md')
    ]) {
      const result = await resolveUltraResearchSource({ rootDir, explicitResearchPath });
      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, 'ultra-research-path-unsafe');
    }
  });

  it('rejects a symlinked bundle before reading INDEX.md', async () => {
    const rootDir = await createProject();
    const bundleDir = await writeBundle(rootDir, 'linked-topic');
    const result = await resolveUltraResearchSource({
      rootDir,
      exactSlug: 'linked-topic',
      lstat: async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(bundleDir)) {
          return {
            isSymbolicLink: () => true,
            isDirectory: () => false,
            isFile: () => false
          };
        }
        return lstat(targetPath);
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'ultra-research-symlink-rejected');
  });

  it('rejects inactive explicit sources but ignores inactive implicit candidates with a bounded warning', async () => {
    const rootDir = await createProject();
    await writeBundle(rootDir, 'paused-topic', { status: 'paused' });
    await writeBundle(rootDir, 'active-topic');

    const explicit = await resolveUltraResearchSource({ rootDir, exactSlug: 'paused-topic' });
    const implicit = await resolveUltraResearchSource({ rootDir, relevantSlugs: ['active-topic'] });

    assert.equal(explicit.ok, false);
    assert.equal(explicit.errors[0].code, 'ultra-research-inactive');
    assert.equal(implicit.ok, true);
    assert.equal(implicit.source.slug, 'active-topic');
    assert.ok(implicit.warnings.some(({ code, path: warningPath }) => (
      code === 'ultra-research-inactive' && warningPath === '.ai-factory/research/paused-topic'
    )));
  });

  it('exposes bounded diagnostics without Active Summary bodies', async () => {
    const rootDir = await createProject();
    await writeBundle(rootDir, 'secret-topic', { summary: 'TOP-SECRET-RESEARCH-BODY' });
    const result = await resolveUltraResearchSource({ rootDir, relevantSlugs: [] });
    const bounded = JSON.stringify({
      diagnostic: result.diagnostic,
      candidates: result.candidates,
      warnings: result.warnings,
      errors: result.errors
    });

    assert.equal(result.ok, false);
    assert.equal(bounded.includes('TOP-SECRET-RESEARCH-BODY'), false);
  });

  it('supports direct bundle inspection for downstream drift checks', async () => {
    const rootDir = await createProject();
    await writeBundle(rootDir, 'drift-source');
    const result = await inspectUltraResearchBundle({
      rootDir,
      bundlePath: '.ai-factory/research/drift-source'
    });

    assert.equal(result.ok, true);
    assert.equal(result.source.path, '.ai-factory/research/drift-source/RESEARCH.md');
    assert.match(result.revision.sha256, /^[a-f0-9]{64}$/);
  });
});
