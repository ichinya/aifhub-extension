#!/usr/bin/env node
// Materialize the exact 3-arm x 4-case issue #133 AI Tester matrix.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const authoredRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(authoredRoot, '..', '..', '..');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') result.output = argv[++index];
    else if (argv[index] === '--sqz-exe') result.sqzExe = argv[++index];
  }
  return result;
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex').toUpperCase();
}

async function requireNewOutput(output) {
  const resolved = path.resolve(output);
  const root = path.parse(resolved).root;
  if (resolved === root || resolved === repoRoot || resolved === authoredRoot) {
    throw new Error('Refusing unsafe --output path.');
  }
  try {
    await stat(resolved);
    throw new Error(`Output already exists; choose a new directory: ${resolved}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(resolved, { recursive: true });
  return resolved;
}

const cases = [
  {
    id: 'repeat-source',
    commands: [
      'Run this exact command twice as two separate reads:',
      'node project/scripts/read-context.mjs src/repeat-target.ts',
      'Use only those two command outputs as file content evidence.',
      'Report the exact values of RETRY_WINDOW_MS and REPEAT_SENTINEL, plus the retry endpoint.',
      'End with evaluation_complete.'
    ],
    assertions: [
      ['retry-window', 'RETRY_WINDOW_MS[^\\n]{0,24}45000'],
      ['repeat-sentinel', 'REPEAT_SENTINEL[^\\n]{0,24}amber-orbit'],
      ['retry-endpoint', '/v2/jobs/:jobId/retry']
    ]
  },
  {
    id: 'changed-source',
    commands: [
      'Run these exact commands in order:',
      'node project/scripts/read-context.mjs src/change-target.txt',
      'node project/scripts/mutate-change.mjs',
      'node project/scripts/read-context.mjs src/change-target.txt',
      'Use only the two read-context outputs as file content evidence.',
      'Report the final exact values of DEPLOY_GENERATION and CHANGE_SENTINEL.',
      'End with evaluation_complete.'
    ],
    assertions: [
      ['changed-generation', 'DEPLOY_GENERATION\\s*[=:]\\s*18'],
      ['changed-sentinel', 'CHANGE_SENTINEL\\s*[=:]\\s*after-emerald']
    ]
  },
  {
    id: 'protected-openspec',
    commands: [
      'Run this exact command twice as two separate reads:',
      'node project/scripts/read-context.mjs openspec/specs/orders/spec.md',
      'Use only those two command outputs as file content evidence.',
      'Report both exact requirement IDs and the exact timeout in seconds.',
      'End with evaluation_complete.'
    ],
    assertions: [
      ['protected-id-17', 'REQ-ORDERS-017'],
      ['protected-id-18', 'REQ-ORDERS-018'],
      ['protected-timeout', '(?i)timeout[^\\n]*37|37[^\\n]*seconds']
    ]
  },
  {
    id: 'fresh-session-preseeded-cache',
    setup: 'node project/scripts/read-context.mjs --prime src/session-target.txt',
    commands: [
      'This is a fresh model session. Run this exact command once:',
      'node project/scripts/read-context.mjs src/session-target.txt',
      'Use only that command output as file content evidence.',
      'Report the exact values of CROSS_SESSION_SECRET and OWNER.',
      'If the output does not contain those values, state unresolved instead of guessing.',
      'End with evaluation_complete.'
    ],
    assertions: [
      ['cross-session-secret', 'CROSS_SESSION_SECRET\\s*[=:]\\s*violet-cedar-927'],
      ['cross-session-owner', 'OWNER\\s*[=:]\\s*agent-session-beta']
    ]
  }
];
const arms = ['baseline', 'aifhub', 'sqz'];

const repeatedPadding = Array.from(
  { length: 150 },
  (_, index) => `// retry pipeline invariant ${String(index + 1).padStart(3, '0')}: preserve idempotency key, lease owner, and attempt ordering.`
).join('\n');
const changePadding = Array.from(
  { length: 155 },
  (_, index) => `deployment invariant ${String(index + 1).padStart(3, '0')}: validate lease epoch, snapshot digest, and rollback checkpoint before promotion.`
).join('\n');
const sessionPadding = Array.from(
  { length: 150 },
  (_, index) => `session boundary fact ${String(index + 1).padStart(3, '0')}: a new agent must receive content before it may reuse a reference.`
).join('\n');
const protectedPadding = Array.from(
  { length: 145 },
  (_, index) => `- Evidence clause ${String(index + 1).padStart(3, '0')}: validation remains authoritative and must be reread before a gate decision.`
).join('\n');

const fixtureFiles = {
  'src/repeat-target.ts': [
    'export const RETRY_WINDOW_MS = 45000;',
    'export const RETRY_ENDPOINT = "/v2/jobs/:jobId/retry";',
    'export const REPEAT_SENTINEL = "amber-orbit";',
    '',
    'export class DispatchCoordinator {',
    '  retry(jobId) { return { jobId, windowMs: RETRY_WINDOW_MS }; }',
    '}',
    '',
    repeatedPadding,
    ''
  ].join('\n'),
  'src/change-target.txt': [
    'DEPLOY_GENERATION=17',
    'CHANGE_SENTINEL=before-cobalt',
    'ROLLBACK_POLICY=checkpoint-required',
    '',
    changePadding,
    ''
  ].join('\n'),
  'src/session-target.txt': [
    'CROSS_SESSION_SECRET=violet-cedar-927',
    'OWNER=agent-session-beta',
    'SESSION_POLICY=fresh-context-required',
    '',
    sessionPadding,
    ''
  ].join('\n'),
  'openspec/specs/orders/spec.md': [
    '# Orders capability',
    '',
    '## Requirement REQ-ORDERS-017',
    '',
    'The retry coordinator SHALL stop an attempt after exactly 37 seconds.',
    '',
    '## Requirement REQ-ORDERS-018',
    '',
    'The verifier SHALL preserve the original order identifier in every diagnostic.',
    '',
    protectedPadding,
    ''
  ].join('\n')
};

function readWrapper(arm) {
  return `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const prime = args[0] === '--prime';
const requestedPath = prime ? args[1] : args[0];
if (!requestedPath) throw new Error('Usage: read-context.mjs [--prime] <relative-path>');
const absolutePath = path.resolve(projectRoot, requestedPath);
if (absolutePath !== projectRoot && !absolutePath.startsWith(projectRoot + path.sep)) {
  throw new Error('Target must stay inside the project fixture.');
}
const content = await readFile(absolutePath, 'utf8');
let output = content;
let decision = 'full';

if ('${arm}' === 'aifhub') {
  const { PROTECTED_READ_PATTERNS, recordRead } = await import('./context-dedup.mjs');
  const result = await recordRead({
    rootDir: projectRoot,
    filePath: requestedPath,
    sessionId: prime ? 'fixture-prime-session' : 'model-session',
    policy: {
      mode: 'aifhub',
      enabled: true,
      minBytes: 2048,
      maxEntries: 500,
      protectedPatterns: [...PROTECTED_READ_PATTERNS],
      diagnostics: []
    }
  });
  decision = result.decision;
  output = result.content ?? result.replay?.text ?? '';
}

if ('${arm}' === 'sqz') {
  const { PROTECTED_READ_PATTERNS, recordRead } = await import('./context-dedup.mjs');
  const result = await recordRead({
    rootDir: projectRoot,
    filePath: requestedPath,
    sessionId: prime ? 'fixture-prime-session' : 'model-session',
    policy: {
      mode: 'sqz',
      enabled: true,
      minBytes: 2048,
      maxEntries: 500,
      sqz: {
        command: path.join(projectRoot, 'bin', 'sqz.exe')
      },
      protectedPatterns: [...PROTECTED_READ_PATTERNS],
      diagnostics: []
    }
  });
  decision = result.providerOutcome === 'reference' ? 'reference' : result.decision;
  output = result.content ?? result.replay?.text ?? '';
}

if (!prime) process.stdout.write(output.endsWith('\\n') ? output : output + '\\n');
process.stderr.write(
  '[dedup-metric] arm=${arm} phase=' + (prime ? 'prime' : 'read')
    + ' decision=' + decision
    + ' inputBytes=' + Buffer.byteLength(content)
    + ' outputBytes=' + Buffer.byteLength(output)
    + ' savedBytes=' + Math.max(0, Buffer.byteLength(content) - Buffer.byteLength(output))
    + '\\n'
);
`;
}

const mutateScript = `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src', 'change-target.txt');
const before = await readFile(target, 'utf8');
const after = before
  .replace('DEPLOY_GENERATION=17', 'DEPLOY_GENERATION=18')
  .replace('CHANGE_SENTINEL=before-cobalt', 'CHANGE_SENTINEL=after-emerald');
if (after === before) throw new Error('Fixture was already mutated or did not match.');
await writeFile(target, after, 'utf8');
process.stdout.write('fixture_mutated\\n');
`;

function scenarioYaml(testCase, arm) {
  const lines = [
    `scenario: context-dedup-${testCase.id}-${arm}`,
    `description: ${JSON.stringify(`issue=133 arm=${arm} case=${testCase.id} sqz=1.3.0 model=gpt-5.6-luna reasoning=low`)}`,
    'system_prompt_file: "../system-prompt.md"',
    'user_prompt: |',
    ...testCase.commands.map((line) => `  ${line}`),
    'runner:',
    '  runtime: codex',
    '  model: gpt-5.6-luna',
    '  reasoning: low',
    '  permission_mode: bypassPermissions',
    'fixtures:',
    '  copy_trees:',
    `    - from: "../fixtures/${arm}"`,
    '      to: project'
  ];
  if (testCase.setup) lines.push('  setup_commands:', `    - ${JSON.stringify(testCase.setup)}`);
  lines.push(
    'assertions:',
    '  - id: stay-in-sandbox',
    '    type: no_path_escape',
    '  - id: bounded-turns',
    '    type: turn_count_at_most',
    '    max: 8',
    '  - id: completed-output',
    '    type: output_contains',
    '    pattern: evaluation_complete'
  );
  for (const [id, pattern] of testCase.assertions) {
    lines.push(`  - id: ${id}`, '    type: output_contains', `    pattern: ${JSON.stringify(pattern)}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output || !args.sqzExe) {
    throw new Error('Usage: generate-matrix.mjs --output <new-dir> --sqz-exe <file>');
  }
  const catalog = JSON.parse(await readFile(path.join(authoredRoot, 'matrix-catalog.json'), 'utf8'));
  if (await sha256(args.sqzExe) !== catalog.sqz.officialBinarySha256) {
    throw new Error('Official sqz.exe SHA-256 mismatch.');
  }
  const sourcePins = [
    [
      path.join(repoRoot, 'scripts', 'context-dedup.mjs'),
      catalog.implementation.contextDedupSha256,
      'AIFHub context-dedup implementation'
    ],
    [
      path.join(repoRoot, 'scripts', 'active-change-resolver.mjs'),
      catalog.implementation.activeChangeResolverSha256,
      'AIFHub active-change resolver'
    ]
  ];
  for (const [filePath, expected, label] of sourcePins) {
    if (await sha256(filePath) !== expected) {
      throw new Error(`${label} SHA-256 mismatch; record a new benchmark pin before running.`);
    }
  }

  const output = await requireNewOutput(args.output);
  const fixtures = path.join(output, 'fixtures');
  const scenarios = path.join(output, 'scenarios');
  await Promise.all([mkdir(fixtures), mkdir(scenarios)]);
  await writeFile(
    path.join(output, 'system-prompt.md'),
    [
      'You are a read-only repository inspection agent in a controlled benchmark.',
      'Follow the user-provided commands exactly and only inspect target files through the requested wrapper.',
      'Do not browse the web. Keep the final answer concise and preserve exact identifiers and values.',
      ''
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    path.join(output, '.ai-tester.yaml'),
    'version: 1\nruns_dir: ./runs\ndefaults:\n  runtime: codex\n  model: gpt-5.6-luna\n  reasoning: low\n  permission_mode: bypassPermissions\n',
    'utf8'
  );
  await copyFile(path.join(authoredRoot, 'generate-matrix.mjs'), path.join(output, 'generate-matrix.mjs'));
  await copyFile(path.join(authoredRoot, 'summarize-matrix.mjs'), path.join(output, 'summarize-matrix.mjs'));

  for (const arm of arms) {
    const root = path.join(fixtures, arm);
    await Promise.all([
      mkdir(path.join(root, 'scripts'), { recursive: true }),
      mkdir(path.join(root, 'src'), { recursive: true }),
      mkdir(path.join(root, 'openspec', 'specs', 'orders'), { recursive: true }),
      mkdir(path.join(root, 'bin'), { recursive: true })
    ]);
    for (const [relativePath, content] of Object.entries(fixtureFiles)) {
      await writeFile(path.join(root, relativePath), content, 'utf8');
    }
    await writeFile(path.join(root, 'scripts', 'read-context.mjs'), readWrapper(arm), 'utf8');
    await writeFile(path.join(root, 'scripts', 'mutate-change.mjs'), mutateScript, 'utf8');
    if (arm === 'aifhub' || arm === 'sqz') {
      await copyFile(path.join(repoRoot, 'scripts', 'context-dedup.mjs'), path.join(root, 'scripts', 'context-dedup.mjs'));
      await copyFile(path.join(repoRoot, 'scripts', 'active-change-resolver.mjs'), path.join(root, 'scripts', 'active-change-resolver.mjs'));
    }
    if (arm === 'sqz') {
      await copyFile(args.sqzExe, path.join(root, 'bin', 'sqz.exe'));
    }
  }

  for (const testCase of cases) {
    for (const arm of arms) {
      await writeFile(path.join(scenarios, `${testCase.id}-${arm}.yaml`), scenarioYaml(testCase, arm), 'utf8');
    }
  }
  await writeFile(path.join(output, 'matrix-catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  process.stdout.write(`Generated ${cases.length * arms.length} scenarios under ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
});
