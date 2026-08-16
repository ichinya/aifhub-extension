#!/usr/bin/env node
// ai-factory-2-18-live-smoke.mjs - explicit local-toolchain consumer smoke driver
import {
  SMOKE_SCHEMA_VERSION,
  SMOKE_STATUS,
  createNoShellProcessRunner,
  runAiFactory218ConsumerSmoke,
  summarizeSmokeResult
} from './ai-factory-2-18-consumer-smoke.mjs';

const VALUE_OPTIONS = new Map([
  ['--v217-command', 'v217Command'],
  ['--v217-arg', 'v217Arg'],
  ['--v217-root', 'v217Root'],
  ['--v218-command', 'v218Command'],
  ['--v218-arg', 'v218Arg'],
  ['--v218-root', 'v218Root'],
  ['--extension-root', 'extensionRoot'],
  ['--timeout-ms', 'timeoutMs'],
  ['--comspec', 'comSpec']
]);

function usage() {
  return [
    'Usage:',
    '  npm run smoke:ai-factory-2-18 -- \\',
    '    --v217-command <absolute executable> --v217-arg <local bin/ai-factory.js> --v217-root <local package root> \\',
    '    --v218-command <absolute executable> --v218-arg <local bin/ai-factory.js> --v218-root <local package root> \\',
    '    --extension-root <local aifhub-extension checkout> [--timeout-ms 120000] [--allow-network]',
    '',
    'The existing --v218-* flags bind the exact AI Factory 2.18.1 target; --v217-* binds the 2.17.0 update source.',
    'Repeat --v217-arg or --v218-arg for each fixed argv token. No package is downloaded.',
    'On Windows a caller may instead pass a local .cmd command; the driver uses the explicit/default ComSpec adapter with shell=false.'
  ].join('\n');
}

function parseArguments(argv) {
  const parsed = {
    v217Arg: [],
    v218Arg: [],
    allowNetwork: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (argument === '--allow-network') {
      parsed.allowNetwork = true;
      continue;
    }
    const key = VALUE_OPTIONS.get(argument);
    if (!key) throw new Error('unknown-option');
    if (index + 1 >= argv.length) throw new Error('missing-option-value');
    const value = argv[index + 1];
    index += 1;
    if (key === 'v217Arg' || key === 'v218Arg') parsed[key].push(value);
    else parsed[key] = value;
  }
  return parsed;
}

function notRunResult(code, missing = []) {
  return {
    schemaVersion: SMOKE_SCHEMA_VERSION,
    suite: 'ai-factory-2.18-consumer-compatibility',
    evidence: 'live',
    status: SMOKE_STATUS.NOT_RUN,
    compatibilityScope: 'isolated-local-consumer-contract',
    provesReleaseOrDeployment: false,
    versions: {},
    flows: {
      cleanInstall: { status: SMOKE_STATUS.NOT_RUN },
      globalUpdate: { status: SMOKE_STATUS.NOT_RUN },
      targetedUpdate: { status: SMOKE_STATUS.NOT_RUN }
    },
    events: [],
    failure: {
      flow: 'preflight',
      code,
      ...(missing.length > 0 ? { missing } : {})
    }
  };
}

function exitCodeForStatus(status) {
  if (status === SMOKE_STATUS.PASS) return 0;
  if (status === SMOKE_STATUS.NOT_RUN) return 2;
  return 1;
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    const result = notRunResult(error.message === 'missing-option-value' ? 'missing-option-value' : 'invalid-live-driver-arguments');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCodeForStatus(result.status);
    return;
  }
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const required = [
    ['--v217-command', parsed.v217Command],
    ['--v217-root', parsed.v217Root],
    ['--v218-command', parsed.v218Command],
    ['--v218-root', parsed.v218Root],
    ['--extension-root', parsed.extensionRoot]
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    const result = notRunResult('missing-live-prerequisite', missing);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCodeForStatus(result.status);
    return;
  }

  const timeoutMs = parsed.timeoutMs === undefined ? undefined : Number(parsed.timeoutMs);
  const runner = createNoShellProcessRunner({ comSpec: parsed.comSpec ?? process.env.ComSpec });
  const result = await runAiFactory218ConsumerSmoke({
    toolchains: {
      v217: {
        command: parsed.v217Command,
        argv: parsed.v217Arg,
        provenanceRoot: parsed.v217Root
      },
      v218: {
        command: parsed.v218Command,
        argv: parsed.v218Arg,
        provenanceRoot: parsed.v218Root
      }
    },
    extensionRoot: parsed.extensionRoot,
    runner,
    timeoutMs,
    networkEnabled: parsed.allowNetwork,
    evidence: 'live'
  });
  const summary = summarizeSmokeResult(result);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = exitCodeForStatus(summary.status);
}

await main();
