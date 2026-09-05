#!/usr/bin/env node
// write-gate-evidence.mjs - persist validated AI Factory gate evidence
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeChangeId } from './active-change-resolver.mjs';
import { getLatestGateResult, SUPPORTED_GATES } from './aif-gate-result.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';

const DEFAULT_QA_DIR = path.join('.ai-factory', 'qa');

export function parseWriteGateEvidenceArgs(argv = []) {
  const result = {
    ok: true,
    changeId: null,
    gate: null,
    from: null,
    json: false,
    force: false,
    help: false,
    errors: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }

    if (arg === '--json') {
      result.json = true;
      continue;
    }

    if (arg === '--force') {
      result.force = true;
      continue;
    }

    if (arg === '--change') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        result.errors.push('Missing value for --change.');
      } else {
        const normalized = normalizeChangeId(value);
        if (!normalized.ok) {
          result.errors.push(normalized.error.message);
        } else {
          result.changeId = normalized.changeId;
        }
        index += 1;
      }
      continue;
    }

    if (arg === '--gate') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        result.errors.push('Missing value for --gate.');
      } else {
        const gate = String(value).trim().toLowerCase();
        if (!SUPPORTED_GATES.includes(gate)) {
          result.errors.push(`Invalid --gate '${value}'. Expected one of: ${SUPPORTED_GATES.join(', ')}.`);
        } else {
          result.gate = gate;
        }
        index += 1;
      }
      continue;
    }

    if (arg === '--from') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        result.errors.push('Missing value for --from.');
      } else {
        result.from = value;
        index += 1;
      }
      continue;
    }

    result.errors.push(`Unknown argument: ${arg}.`);
  }

  if (!result.help) {
    if (result.changeId === null) {
      result.errors.push('Missing required --change <change-id>.');
    }
    if (result.gate === null) {
      result.errors.push(`Missing required --gate <${SUPPORTED_GATES.join('|')}>.`);
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

export async function writeGateEvidence(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const normalized = normalizeChangeId(options.changeId);
  if (!normalized.ok) {
    return commandFailure('invalid-change-id', normalized.error.message);
  }

  const gate = String(options.gate ?? '').trim().toLowerCase();
  if (!SUPPORTED_GATES.includes(gate)) {
    return commandFailure('invalid-gate', `Invalid --gate '${options.gate}'. Expected one of: ${SUPPORTED_GATES.join(', ')}.`);
  }

  const markdownResult = await readInputMarkdown({
    ...options,
    rootDir,
    readFile: options.readFile ?? readFile
  });
  if (!markdownResult.ok) {
    return markdownResult;
  }

  const latest = getLatestGateResult(markdownResult.markdown, { gate });
  if (latest === null) {
    return commandFailure(
      'invalid-gate-evidence',
      `No valid aif-gate-result block found for gate '${gate}'.`
    );
  }

  if (!latest.ok) {
    return commandFailure(
      'invalid-gate-evidence',
      `Invalid latest aif-gate-result block for gate '${gate}': ${latest.errors.map((error) => error.message).join('; ')}`
    );
  }

  const targetPath = path.join(rootDir, DEFAULT_QA_DIR, normalized.changeId, `${gate}.md`);
  const relativeTargetPath = toPosix(path.relative(rootDir, targetPath));

  if (!options.force && await pathExists(targetPath, options.access ?? access)) {
    return commandFailure(
      'evidence-exists',
      `Gate evidence already exists at ${relativeTargetPath}. Rerun with --force to overwrite it.`,
      relativeTargetPath
    );
  }

  await ensureRuntimeGitignore(rootDir, DEFAULT_QA_DIR);
  await (options.mkdir ?? mkdir)(path.dirname(targetPath), { recursive: true });
  await (options.writeFile ?? writeFile)(targetPath, markdownResult.markdown, 'utf8');

  return {
    ok: true,
    change_id: normalized.changeId,
    gate,
    path: relativeTargetPath,
    status: latest.result.status
  };
}

export async function runWriteGateEvidenceCommand(argv = process.argv.slice(2), options = {}) {
  const parsed = parseWriteGateEvidenceArgs(argv);

  if (parsed.help) {
    const usage = createUsageText();
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, usage }, null, 2)}\n`);
    } else {
      process.stdout.write(`${usage}\n`);
    }
    return parsed.ok ? 0 : 2;
  }

  if (!parsed.ok) {
    writeCommandOutput(commandFailure('invalid-arguments', parsed.errors.join(' ')), parsed.json);
    return 2;
  }

  const markdown = parsed.from === null
    ? await readStream(options.stdin ?? process.stdin)
    : undefined;

  const result = await writeGateEvidence({
    ...options,
    rootDir: options.rootDir ?? process.cwd(),
    changeId: parsed.changeId,
    gate: parsed.gate,
    from: parsed.from,
    markdown,
    force: parsed.force
  });

  writeCommandOutput(result, parsed.json);
  return result.ok ? 0 : 2;
}

async function readInputMarkdown(options) {
  if (options.markdown !== undefined && options.markdown !== null) {
    return {
      ok: true,
      markdown: String(options.markdown)
    };
  }

  if (options.from === undefined || options.from === null || String(options.from).trim().length === 0) {
    return commandFailure('missing-input', 'No gate evidence markdown was provided.');
  }

  const inputPath = path.isAbsolute(options.from)
    ? options.from
    : path.resolve(options.rootDir, options.from);

  try {
    return {
      ok: true,
      markdown: await options.readFile(inputPath, 'utf8')
    };
  } catch (err) {
    return commandFailure(
      'input-unreadable',
      `Gate evidence input could not be read: ${toPosix(path.relative(options.rootDir, inputPath))}.`,
      toPosix(path.relative(options.rootDir, inputPath)),
      err?.message ?? String(err)
    );
  }
}

async function pathExists(targetPath, accessFn) {
  try {
    await accessFn(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeCommandOutput(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (!result.ok) {
    process.stderr.write(`${result.errors.map((error) => error.message).join('\n')}\n`);
    return;
  }

  process.stdout.write(`Wrote ${result.gate} gate evidence to ${result.path} (${result.status}).\n`);
}

function commandFailure(code, message, targetPath, detail) {
  return {
    ok: false,
    errors: [
      {
        code,
        message,
        ...(targetPath ? { path: targetPath } : {}),
        ...(detail ? { detail } : {})
      }
    ]
  };
}

function createUsageText() {
  return [
    'Usage: node scripts/write-gate-evidence.mjs --change <id> --gate rules|review|security|verify [--from <markdown-file>] [--force] [--json]',
    'Reads gate Markdown from --from or stdin, validates the final matching aif-gate-result block, and writes .ai-factory/qa/<change-id>/<gate>.md.'
  ].join('\n');
}

function toPosix(value) {
  return String(value ?? '').replaceAll(path.sep, '/');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  process.exitCode = await runWriteGateEvidenceCommand();
}
