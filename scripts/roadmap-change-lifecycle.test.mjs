// roadmap-change-lifecycle.test.mjs - bounded roadmap lifecycle helper contracts
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ROADMAP_LIFECYCLE_END_MARKER,
  ROADMAP_LIFECYCLE_START_MARKER,
  parseRoadmapLinkage,
  updateRoadmapChangeLifecycle
} from './roadmap-change-lifecycle.mjs';

const temporaryDirectories = [];
const ROADMAP_PATH = '.ai-factory/ROADMAP.md';
const CHANGE_ID = 'add-roadmap-lifecycle';
const DEFAULT_PROPOSAL = `# Proposal: Roadmap lifecycle

## Roadmap Linkage

- Issues: https://github.com/ichinya/aifhub-extension/issues/88, https://github.com/ichinya/aifhub-extension/issues/151
- Milestone: none
- Roadmap item/slice: Workflow governance / roadmap lifecycle freshness
- Rationale: Keep local lifecycle evidence deterministic.

## Approach

Implement the bounded helper.
`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function createProject() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-roadmap-lifecycle-'));
  temporaryDirectories.push(rootDir);
  await mkdir(path.join(rootDir, '.ai-factory'), { recursive: true });
  return rootDir;
}

async function writeRoadmap(rootDir, content) {
  const roadmapPath = path.join(rootDir, '.ai-factory', 'ROADMAP.md');
  await writeFile(roadmapPath, content);
  return roadmapPath;
}

function updateLifecycle(rootDir, overrides = {}) {
  return updateRoadmapChangeLifecycle({
    rootDir,
    roadmapPath: ROADMAP_PATH,
    proposalContent: DEFAULT_PROPOSAL,
    changeId: CHANGE_ID,
    localState: 'planned',
    evidencePath: `openspec/changes/${CHANGE_ID}/proposal.md`,
    ...overrides
  });
}

describe('roadmap change lifecycle helper', () => {
  it('parses one standardized linkage section and ignores fenced examples', () => {
    const proposal = `# Proposal\n\n\`\`\`markdown\n## Roadmap Linkage\n- Issues: none\n\`\`\`\n\n${DEFAULT_PROPOSAL}`;
    const result = parseRoadmapLinkage(proposal);

    assert.deepEqual(result, {
      ok: true,
      status: 'linked',
      reason: 'roadmap-linkage-found',
      linkage: {
        issues: [
          'https://github.com/ichinya/aifhub-extension/issues/151',
          'https://github.com/ichinya/aifhub-extension/issues/88'
        ],
        milestone: null,
        roadmapItem: 'Workflow governance / roadmap lifecycle freshness',
        rationale: 'Keep local lifecycle evidence deterministic.'
      }
    });
  });

  it('accepts canonical HTTPS and MCP work-item references from different providers', () => {
    const result = parseRoadmapLinkage(`## Roadmap Linkage

- Issues: https://linear.app/acme/issue/ENG-431/fix-login, https://acme.atlassian.net/browse/PROJ-77, mcp://yougile/task/a1b2c3d4
- Milestone: none
- Roadmap item/slice: Cross-provider intake
- Rationale: One primary item plus supporting work items.
`);

    assert.equal(result.ok, true);
    assert.deepEqual(result.linkage.issues, [
      'https://acme.atlassian.net/browse/PROJ-77',
      'https://linear.app/acme/issue/ENG-431/fix-login',
      'mcp://yougile/task/a1b2c3d4'
    ]);
  });

  it('distinguishes missing, explicit-none, and malformed linkage without returning proposal text', () => {
    const missing = parseRoadmapLinkage('# Proposal\n\n## Intent\n\nNo linkage.\n');
    const unlinked = parseRoadmapLinkage(`## Roadmap Linkage

- Issues: none
- Milestone: none
- Roadmap item/slice: none
- Rationale: none
`);
    const malformed = parseRoadmapLinkage(`## Roadmap Linkage

- Issues: https://example.com/private?token=secret
- Milestone: none
- Roadmap item/slice: none
- Rationale: secret body
`);

    assert.deepEqual(missing, {
      ok: true,
      status: 'missing',
      reason: 'roadmap-linkage-missing',
      linkage: null
    });
    assert.deepEqual(unlinked, {
      ok: true,
      status: 'unlinked',
      reason: 'roadmap-linkage-none',
      linkage: {
        issues: [],
        milestone: null,
        roadmapItem: null,
        rationale: null
      }
    });
    assert.deepEqual(malformed, {
      ok: false,
      status: 'malformed',
      reason: 'roadmap-linkage-invalid-issues',
      linkage: null
    });
    assert.doesNotMatch(JSON.stringify(malformed), /token|secret|example\.com/i);
  });

  it('appends one escaped lifecycle block while preserving BOM, CRLF, and no-final-newline bytes', async () => {
    const rootDir = await createProject();
    const original = Buffer.from('\uFEFF# Дорожная карта\r\n\r\nOutside | bytes <stay>', 'utf8');
    const roadmapPath = await writeRoadmap(rootDir, original);
    const proposalContent = DEFAULT_PROPOSAL.replace(
      '- Milestone: none',
      '- Milestone: MVP | <phase> \\ one'
    );

    const result = await updateLifecycle(rootDir, {
      proposalContent,
      localState: 'finalized',
      evidencePath: '.ai-factory/qa/add-roadmap-lifecycle/final|evidence.md'
    });
    const updated = await readFile(roadmapPath);
    const text = updated.toString('utf8');

    assert.deepEqual(result, {
      status: 'updated',
      reason: 'lifecycle-updated',
      path: ROADMAP_PATH,
      changed: true,
      suggestedNext: null
    });
    assert.ok(updated.subarray(0, original.length).equals(original), 'original roadmap bytes should remain an exact prefix');
    assert.equal(updated.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.doesNotMatch(text, /(?<!\r)\n/, 'new lifecycle block should use CRLF');
    assert.equal(text.endsWith('\r\n'), false, 'no-final-newline convention should be preserved');
    assert.match(text, /MVP \\\| &lt;phase&gt; \\\\ one/);
    assert.match(text, /final\\\|evidence\.md/);
    assert.equal(text.match(/aifhub:roadmap-change-lifecycle:start/g)?.length, 1);
    assert.equal(text.match(/aifhub:roadmap-change-lifecycle:end/g)?.length, 1);
  });

  it('sorts lifecycle rows deterministically and makes repeated updates byte-idempotent', async () => {
    const rootDir = await createProject();
    const roadmapPath = await writeRoadmap(rootDir, '# Roadmap\n');

    await updateLifecycle(rootDir, {
      changeId: 'z-last',
      evidencePath: 'openspec/changes/z-last/proposal.md'
    });
    await updateLifecycle(rootDir, {
      changeId: 'a-first',
      evidencePath: 'openspec/changes/a-first/proposal.md'
    });
    const beforeRepeat = await readFile(roadmapPath);
    const repeated = await updateLifecycle(rootDir, {
      changeId: 'a-first',
      evidencePath: 'openspec/changes/a-first/proposal.md'
    });
    const afterRepeat = await readFile(roadmapPath);
    const text = afterRepeat.toString('utf8');

    assert.ok(text.indexOf('`a-first`') < text.indexOf('`z-last`'));
    assert.deepEqual(repeated, {
      status: 'skipped',
      reason: 'lifecycle-current',
      path: ROADMAP_PATH,
      changed: false,
      suggestedNext: null
    });
    assert.ok(afterRepeat.equals(beforeRepeat));
  });

  it('replaces only managed bytes and never downgrades finalized state', async () => {
    const rootDir = await createProject();
    const roadmapPath = await writeRoadmap(rootDir, 'PREFIX\r\n');

    await updateLifecycle(rootDir);
    const planned = await readFile(roadmapPath, 'utf8');
    const withSuffix = `${planned}SUFFIX-WITHOUT-NEWLINE`;
    await writeFile(roadmapPath, withSuffix, 'utf8');
    const startIndex = withSuffix.indexOf(ROADMAP_LIFECYCLE_START_MARKER);
    const endIndex = withSuffix.indexOf(ROADMAP_LIFECYCLE_END_MARKER);
    const prefix = withSuffix.slice(0, startIndex + ROADMAP_LIFECYCLE_START_MARKER.length);
    const suffix = withSuffix.slice(endIndex);

    const finalizedResult = await updateLifecycle(rootDir, {
      localState: 'finalized',
      evidencePath: '.ai-factory/qa/add-roadmap-lifecycle/done.md'
    });
    const finalized = await readFile(roadmapPath, 'utf8');

    assert.equal(finalizedResult.status, 'updated');
    assert.equal(finalized.slice(0, startIndex + ROADMAP_LIFECYCLE_START_MARKER.length), prefix);
    assert.equal(finalized.slice(finalized.indexOf(ROADMAP_LIFECYCLE_END_MARKER)), suffix);
    assert.match(finalized, /\| finalized \|/);

    const downgradeResult = await updateLifecycle(rootDir, {
      localState: 'planned',
      evidencePath: 'openspec/changes/add-roadmap-lifecycle/proposal.md'
    });
    const afterDowngrade = await readFile(roadmapPath, 'utf8');

    assert.equal(downgradeResult.reason, 'finalized-state-preserved');
    assert.equal(downgradeResult.changed, false);
    assert.equal(afterDowngrade, finalized);
  });

  it('rejects duplicate, reversed, incomplete, and malformed managed blocks without mutation', async () => {
    const malformedCases = [
      `${ROADMAP_LIFECYCLE_START_MARKER}\n${ROADMAP_LIFECYCLE_START_MARKER}\n${ROADMAP_LIFECYCLE_END_MARKER}`,
      `${ROADMAP_LIFECYCLE_END_MARKER}\n${ROADMAP_LIFECYCLE_START_MARKER}`,
      `# Roadmap\n${ROADMAP_LIFECYCLE_START_MARKER}\nunfinished`,
      `# Roadmap\n${ROADMAP_LIFECYCLE_END_MARKER}`,
      `${ROADMAP_LIFECYCLE_START_MARKER}\nnot the managed table\n${ROADMAP_LIFECYCLE_END_MARKER}`
    ];

    for (const content of malformedCases) {
      const rootDir = await createProject();
      const roadmapPath = await writeRoadmap(rootDir, content);
      const before = await readFile(roadmapPath);
      const result = await updateLifecycle(rootDir);
      const after = await readFile(roadmapPath);

      assert.equal(result.status, 'handoff');
      assert.equal(result.changed, false);
      assert.equal(result.suggestedNext, '/aif-roadmap check');
      assert.match(result.reason, /^roadmap-(?:markers|block)-/);
      assert.ok(after.equals(before));
    }
  });

  it('rejects unsafe paths, directories, and missing roadmaps without creating or modifying targets', async () => {
    const rootDir = await createProject();
    const outsidePath = path.join(path.dirname(rootDir), 'outside-roadmap.md');
    await writeFile(outsidePath, 'outside', 'utf8');
    temporaryDirectories.push(outsidePath);

    for (const roadmapPath of [outsidePath, '../outside-roadmap.md', '.ai-factory']) {
      const result = await updateLifecycle(rootDir, { roadmapPath });
      assert.equal(result.status, 'handoff');
      assert.equal(result.changed, false);
      assert.equal(result.suggestedNext, '/aif-roadmap check');
    }

    const missing = await updateLifecycle(rootDir);
    assert.deepEqual(missing, {
      status: 'handoff',
      reason: 'roadmap-missing',
      path: ROADMAP_PATH,
      changed: false,
      suggestedNext: '/aif-roadmap check'
    });
    await assert.rejects(readFile(path.join(rootDir, ROADMAP_PATH)), { code: 'ENOENT' });
    assert.equal(await readFile(outsidePath, 'utf8'), 'outside');
  });

  it('detects a source digest conflict before replacement and removes its temporary file', async () => {
    const rootDir = await createProject();
    const roadmapPath = await writeRoadmap(rootDir, '# Roadmap\n');
    const concurrentContent = '# Roadmap\n\nConcurrent owner update.\n';

    const result = await updateLifecycle(rootDir, {
      beforeReplace: async () => {
        await writeFile(roadmapPath, concurrentContent, 'utf8');
      }
    });

    assert.deepEqual(result, {
      status: 'handoff',
      reason: 'roadmap-source-conflict',
      path: ROADMAP_PATH,
      changed: false,
      suggestedNext: '/aif-roadmap check'
    });
    assert.equal(await readFile(roadmapPath, 'utf8'), concurrentContent);
    assert.deepEqual(
      (await readdir(path.dirname(roadmapPath))).filter((entry) => entry.endsWith('.tmp')),
      []
    );
  });

  it('keeps normal results and configurable structured logs bounded and credential-safe', async () => {
    const rootDir = await createProject();
    await writeRoadmap(rootDir, '# Roadmap\n');
    const events = [];
    const proposalContent = DEFAULT_PROPOSAL.replace(
      'Keep local lifecycle evidence deterministic.',
      'private-token-should-not-be-logged'
    );

    const result = await updateLifecycle(rootDir, {
      proposalContent,
      logLevel: 'debug',
      logger: (entry) => events.push(entry)
    });
    const publicText = JSON.stringify({ result, events });

    assert.equal(result.status, 'updated');
    assert.ok(events.length >= 3);
    assert.ok(events.every((entry) => entry.component === 'roadmap-change-lifecycle'));
    assert.doesNotMatch(publicText, new RegExp(rootDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    assert.doesNotMatch(publicText, /private-token|raw proposal|# Roadmap/i);
  });
});
