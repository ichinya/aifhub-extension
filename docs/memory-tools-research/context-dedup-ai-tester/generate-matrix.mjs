#!/usr/bin/env node
// Materialize the exact 3-arm x 4-case issue #133 AI Tester matrix.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const authoredRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(authoredRoot, '..', '..', '..');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') result.output = argv[++index];
    else if (argv[index] === '--sqz-exe') result.sqzExe = argv[++index];
    else if (argv[index] === '--manifest') result.manifest = argv[++index];
    else if (argv[index] === '--profile') result.profile = argv[++index];
    else throw new Error('Unknown generator option.');
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
  await mkdir(path.dirname(resolved), { recursive: true });
  try { await mkdir(resolved); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Output already exists; choose a new directory.');
    throw error;
  }
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

function readWrapper(arm, current = false) {
  return `#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
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
const actualPath = await realpath(absolutePath);
const actualRoot = await realpath(projectRoot);
const relative = path.relative(actualRoot, actualPath);
if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('Target outside fixture.');
const content = await readFile(actualPath, 'utf8');
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

const delivered = ${current ? 'output' : "output.endsWith('\\n') ? output : output + '\\n'"};
if (!prime) process.stdout.write(delivered);
process.stderr.write(
  '[dedup-metric] arm=${arm} phase=' + (prime ? 'prime' : 'read')
    + ' decision=' + decision
    + ' inputBytes=' + Buffer.byteLength(content)
    + ' outputBytes=' + Buffer.byteLength(${current ? 'delivered' : 'output'})
    + ' savedBytes=' + ${current ? '(Buffer.byteLength(content) - Buffer.byteLength(delivered))' : 'Math.max(0, Buffer.byteLength(content) - Buffer.byteLength(output))'}
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

function scenarioYaml(testCase, arm, cell, profile) {
  const lines = [
    'scenario: ' + (cell?.scenario ?? `context-dedup-${testCase.id}-${arm}`),
    `description: ${JSON.stringify(cell ? cell.scenario : `issue=133 arm=${arm} case=${testCase.id} sqz=1.3.0 model=gpt-5.6-luna reasoning=low`)}`,
    'system_prompt_file: "../system-prompt.md"',
    'user_prompt: |',
    ...testCase.commands.map((line) => `  ${line}`),
    'runner:',
    '  runtime: ' + (profile?.runtime ?? 'codex'),
    '  model: ' + (profile?.model ?? 'gpt-5.6-luna'),
    '  reasoning: ' + (profile?.reasoning ?? 'low'),
    ...(cell ? [] : ['  permission_mode: bypassPermissions']),
    'fixtures:',
    '  copy_trees:',
    '    - from: ' + JSON.stringify('../' + (cell?.fixture ?? 'fixtures/' + arm)),
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

const runtimeModules = ['context-dedup.mjs', 'runtime-gitignore.mjs', 'provider-files.mjs', 'provider-process.mjs'];
const manifestReader = 'docs/memory-tools-research/context-dedup-ai-tester/generate-matrix.mjs';
const harnessFiles = {
  aiTester: [manifestReader],
  pi: [manifestReader, 'benchmarks/pi-sqz-matrix/run-matrix.mjs', 'benchmarks/pi-sqz-matrix/scenarios.json', 'benchmarks/pi-sqz-matrix/dedup-read.mjs']
};

export async function readMatrixManifest(file, harness, requestedProfile, binary) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.snapshot ?? '') ||
      !Number.isSafeInteger(manifest.repeats) || manifest.repeats < 3) throw new Error('Invalid snapshot or repeat count.');
  const profiles = manifest.profiles[harness];
  const profile = profiles.find(p => p.id === (requestedProfile ?? profiles[0]?.id));
  if (!profile || !/^[a-z0-9][a-z0-9-]*$/.test(profile.id) ||
      !['model', ...(harness === 'pi' ? ['provider', 'thinking'] : ['runtime', 'reasoning'])].every(k =>
        typeof profile[k] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(profile[k]))) {
    throw new Error('Unknown or invalid benchmark profile.');
  }
  for (const relative of [...runtimeModules.map(name => 'scripts/' + name), ...harnessFiles[harness]]) {
    if (await sha256(path.join(repoRoot, relative)) !== manifest.files[relative]?.toUpperCase()) {
      throw new Error('SHA-256 mismatch for ' + relative);
    }
  }
  if (binary) {
    const expected = manifest.sqz.binarySha256[process.platform];
    if (!expected) throw new Error('No verified SQZ binary pin for ' + process.platform);
    if (await sha256(binary) !== expected.toUpperCase()) throw new Error('SQZ binary SHA-256 mismatch.');
  }
  return { manifest, profile };
}

const shortCase = {
  id: 'short-config',
  commands: ['Run this exact command once: node project/scripts/read-context.mjs src/policy.txt',
    'Report the precise TIMEOUT_S and RETRIES, and end with evaluation_complete.'],
  assertions: [['timeout', 'TIMEOUT_S\\s*[=:]\\s*9\\b'], ['retries', 'RETRIES\\s*[=:]\\s*0\\b']]
};

async function generateSnapshot(args) {
  const { manifest, profile } = await readMatrixManifest(args.manifest, 'aiTester', args.profile, args.sqzExe);
  const definitions = new Map([...cases, shortCase].map(testCase => [testCase.id, testCase]));
  if (!Array.isArray(manifest.aiTesterCases) || !manifest.aiTesterCases.length ||
      new Set(manifest.aiTesterCases).size !== manifest.aiTesterCases.length ||
      manifest.aiTesterCases.some(id => !definitions.has(id))) throw new Error('Invalid AI Tester case selection.');
  const output = await requireNewOutput(args.output);
  await mkdir(path.join(output, 'scenarios'));
  await writeFile(path.join(output, 'system-prompt.md'), 'Inspect the provided fixture through the requested commands only. Report exact observed values.\n');
  await writeFile(path.join(output, '.ai-tester.yaml'), 'version: 1\nruns_dir: ./runs\ndefaults:\n  runtime: ' + profile.runtime +
    '\n  model: ' + profile.model + '\n  reasoning: ' + profile.reasoning + '\n');
  const inputs = { ...fixtureFiles, 'src/policy.txt': 'TIMEOUT_S=9\nRETRIES=0\n' };
  const expectedCells = [];
  for (const caseId of manifest.aiTesterCases) {
    const testCase = definitions.get(caseId);
    for (let repeat = 1; repeat <= manifest.repeats; repeat++) {
      for (const arm of arms) {
        const scenario = ['context-dedup', profile.id, testCase.id, 'r' + repeat, arm].join('-');
        const fixture = 'fixtures/' + scenario;
        const cell = { snapshot: manifest.snapshot, platform: process.platform, profile: profile.id, caseId: testCase.id,
          repeat, arm, scenario, fixture };
        if (testCase.setup) Object.assign(cell, { ledgerSetup: arm === 'baseline' ? 'not-applicable' : 'prime command before model session', providerCache: 'unverified' });
        const root = path.join(output, fixture);
        for (const [relative, bytes] of Object.entries(inputs)) {
          await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
          await writeFile(path.join(root, relative), bytes);
        }
        const scripts = path.join(root, 'scripts');
        await mkdir(scripts);
        await writeFile(path.join(scripts, 'read-context.mjs'), readWrapper(arm, true));
        await writeFile(path.join(scripts, 'mutate-change.mjs'), mutateScript);
        if (arm !== 'baseline') for (const name of runtimeModules) {
          const dest = path.join(scripts, name);
          await copyFile(path.join(repoRoot, 'scripts', name), dest);
          if (await sha256(dest) !== manifest.files['scripts/' + name].toUpperCase()) throw new Error('Copied runtime SHA-256 mismatch.');
        }
        if (arm === 'sqz') {
          await mkdir(path.join(root, 'bin'));
          const dest = path.join(root, 'bin', 'sqz.exe');
          await copyFile(args.sqzExe, dest);
          if (await sha256(dest) !== manifest.sqz.binarySha256[process.platform].toUpperCase()) throw new Error('Copied binary SHA-256 mismatch.');
        }
        const yaml = path.join(output, 'scenarios', scenario + '.yaml');
        await writeFile(yaml, scenarioYaml(testCase, arm, cell, profile));
        expectedCells.push({ ...cell, scenarioSha256: await sha256(yaml) });
      }
    }
  }
  const fixtureHashes = Object.fromEntries(Object.entries(inputs).map(([name, data]) =>
    [name, createHash('sha256').update(data).digest('hex')]));
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ ...manifest, harness: 'aiTester',
    platform: process.platform, profile, fixtureHashes, expectedCells }, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write('Generated ' + expectedCells.length + ' cells for ' + profile.id + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output || !args.sqzExe) {
    throw new Error('Usage: generate-matrix.mjs --output <new-dir> --sqz-exe <file>');
  }
  if (args.manifest) return generateSnapshot(args);
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
});
