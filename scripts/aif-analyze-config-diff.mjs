// aif-analyze-config-diff.mjs - read-only required-keys diff for the aif-analyze config
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  flattenConfigKeyPaths,
  parseSimpleYaml,
  readAnalyzeSkillVersion
} from './aif-artifact-sync.mjs';

const DEFAULT_CONFIG_PATH = path.join('.ai-factory', 'config.yaml');
const USAGE = 'Usage: node scripts/aif-analyze-config-diff.mjs [--config <path>] [--manifest <path>] [--skill <path>] [--json]';

function invalidArgs(message) {
  return { ok: false, error: message };
}

function parseDiffArgs(argv) {
  const parsed = { json: false, configPath: undefined, manifestPath: undefined, skillPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--config' || arg === '--manifest' || arg === '--skill') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return invalidArgs(`Missing value for ${arg}.`);
      }
      if (arg === '--config') parsed.configPath = value;
      if (arg === '--manifest') parsed.manifestPath = value;
      if (arg === '--skill') parsed.skillPath = value;
      index += 1;
      continue;
    }
    return invalidArgs(`Unknown option: ${arg}.`);
  }
  return { ok: true, ...parsed };
}

function readFlatValue(flat, key) {
  const raw = flat.get(key);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function readManifest(manifestUrl) {
  let raw;
  try {
    raw = await readFile(fileURLToPath(manifestUrl), 'utf8');
  } catch (err) {
    return {
      ok: false,
      keys: null,
      error: {
        code: 'manifest-unreadable',
        message: `Could not read the config keys manifest: ${err?.code ?? err?.message ?? 'unknown error'}`
      }
    };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.keys)) {
      return {
        ok: false,
        keys: null,
        error: {
          code: 'manifest-invalid',
          message: 'The config keys manifest must be a JSON object with a keys array.'
        }
      };
    }
    return { ok: true, keys: parsed.keys, error: null };
  } catch (err) {
    return {
      ok: false,
      keys: null,
      error: {
        code: 'manifest-invalid',
        message: `The config keys manifest is not valid JSON: ${err?.message ?? 'unknown error'}`
      }
    };
  }
}

export async function buildAnalyzeConfigDiff(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const configPath = options.configPath ?? path.join(rootDir, DEFAULT_CONFIG_PATH);
  const manifestUrl = options.manifestUrl ?? new URL('../skills/aif-analyze/references/config-keys.json', import.meta.url);
  const analyzeSkillUrl = options.analyzeSkillUrl;
  const warnings = [];
  const errors = [];

  let configRaw = null;
  try {
    configRaw = await readFile(configPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      errors.push({
        code: 'config-missing',
        message: `Project config not found: ${toPosix(path.relative(rootDir, configPath)) || toPosix(configPath)}`,
        path: toPosix(path.relative(rootDir, configPath)) || toPosix(configPath)
      });
    } else {
      errors.push({
        code: 'config-unreadable',
        message: `Could not read the project config: ${err?.code ?? err?.message ?? 'unknown error'}`,
        path: toPosix(path.relative(rootDir, configPath)) || toPosix(configPath)
      });
    }
  }

  const manifest = await readManifest(manifestUrl);
  if (!manifest.ok) {
    errors.push(manifest.error);
  }

  const skill = await readAnalyzeSkillVersion(analyzeSkillUrl ? { analyzeSkillUrl } : {});
  if (!skill.ok) {
    errors.push(skill.error);
  }

  if (errors.length > 0 || configRaw === null || !manifest.ok || !skill.ok) {
    return {
      ok: false,
      skill_version: skill.version,
      config_analyze_version: null,
      version_drift: null,
      missing: null,
      obsolete: null,
      up_to_date: false,
      warnings,
      errors
    };
  }

  const flat = flattenConfigKeyPaths(parseSimpleYaml(configRaw));
  const entries = manifest.keys;
  const missing = entries
    .filter((entry) => entry?.required === true && !flat.has(entry.key))
    .map((entry) => ({
      key: entry.key,
      since: entry.since ?? null,
      purpose: typeof entry.purpose === 'string' ? entry.purpose : ''
    }));
  const obsolete = entries
    .filter((entry) => entry?.deprecated === true && flat.has(entry.key))
    .map((entry) => ({
      key: entry.key,
      purpose: typeof entry.purpose === 'string' ? entry.purpose : ''
    }));
  const configAnalyzeVersion = flat.has('analyze.skill_version')
    ? String(readFlatValue(flat, 'analyze.skill_version'))
    : null;
  const versionDrift = configAnalyzeVersion !== skill.version;

  return {
    ok: true,
    skill_version: skill.version,
    config_analyze_version: configAnalyzeVersion,
    version_drift: versionDrift,
    missing,
    obsolete,
    up_to_date: missing.length === 0 && !versionDrift,
    warnings,
    errors: []
  };
}

function renderDiffSummary(result) {
  if (!result.ok) {
    const lines = ['Analyze config diff: FAILED', ''];
    for (const error of result.errors) {
      lines.push(`ERROR [${error.code}] ${error.message}`);
    }
    return lines.join('\n');
  }

  const lines = [
    'Analyze config diff:',
    `Skill version: ${result.skill_version}`,
    `Config analyze.skill_version: ${result.config_analyze_version ?? '(missing)'}`,
    `Version drift: ${result.version_drift ? 'yes' : 'no'}`,
    `Up to date: ${result.up_to_date ? 'yes' : 'no'}`,
    ''
  ];
  if (result.missing.length > 0) {
    lines.push(`Missing required keys (${result.missing.length}):`);
    for (const item of result.missing) {
      lines.push(`- ${item.key} (since ${item.since ?? 'unknown'}): ${item.purpose}`);
    }
    lines.push('');
  }
  if (result.obsolete.length > 0) {
    lines.push(`Deprecated keys still present (${result.obsolete.length}):`);
    for (const item of result.obsolete) {
      lines.push(`- ${item.key}: ${item.purpose}`);
    }
    lines.push('');
  }
  if (result.up_to_date) {
    lines.push('Config is up to date with the aif-analyze skill.');
  } else {
    lines.push('Run /aif-analyze to apply the additions listed above.');
  }
  return lines.join('\n');
}

export async function runAnalyzeConfigDiffCommand(argv = process.argv.slice(2), options = {}) {
  const parsed = parseDiffArgs(argv);
  if (!parsed.ok) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${parsed.error}\n${USAGE}\n`
    };
  }

  const result = await buildAnalyzeConfigDiff({
    ...options,
    rootDir: options.rootDir,
    configPath: parsed.configPath ?? options.configPath,
    manifestUrl: parsed.manifestPath ? pathToFileUrlOrPath(parsed.manifestPath) : options.manifestUrl,
    analyzeSkillUrl: parsed.skillPath ? pathToFileUrlOrPath(parsed.skillPath) : options.analyzeSkillUrl
  });

  const stdout = parsed.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${renderDiffSummary(result)}\n`;

  return {
    exitCode: result.ok ? 0 : 2,
    stdout,
    stderr: ''
  };
}

function pathToFileUrlOrPath(filePath) {
  return filePath.startsWith('file:')
    ? filePath
    : new URL(`file://${encodeURI(path.resolve(filePath).replace(/\\/g, '/'))}`);
}

function toPosix(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/');
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  runAnalyzeConfigDiffCommand().then((command) => {
    process.stdout.write(command.stdout);
    process.stderr.write(command.stderr);
    process.exitCode = command.exitCode;
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
}
