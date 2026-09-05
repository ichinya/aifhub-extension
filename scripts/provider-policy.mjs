import path from 'node:path';
import { readProviderFile } from './provider-files.mjs';
import { parseToolConfig } from './tool-config.mjs';

export const PROVIDER_KINDS = Object.freeze({ hlv: 'validation', lekalo: 'semantic_model' });
export const PROVIDER_PHASES = Object.freeze(['implement', 'verify', 'done']);
export const PROVIDER_POLICIES = Object.freeze(['optional', 'required']);

// The provider namespace accepts an intentionally closed YAML subset. Unsupported
// YAML must produce a configuration error, never silently disable a required gate.
export function parseProviderConfig(raw) {
  const selection = parseToolConfig(raw);
  const settings = parseProviderSettings(raw);
  if (!selection.explicit) return settings;
  for (const id of Object.keys(PROVIDER_KINDS)) {
    settings[id] = { ...settings[id], enable: selection.tools[id] };
  }
  return settings;
}

function parseProviderSettings(raw) {
  const lines = String(raw).replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (lines[0] === '---') lines.shift();
  if (lines.at(-1) === '...') lines.pop();
  if (lines.some((line) => /^["']aifhub["']|^<<\s*:|^\{|^---|^\.\.\.|^%/.test(line))) throw new Error('unsupported_config');
  const hubs = lines.map((line, index) => /^aifhub\s*:/.test(line) ? index : -1).filter((index) => index >= 0);
  if (hubs.length > 1) throw new Error('duplicate_aifhub');
  if (!hubs.length) {
    if (lines.some((line) => /["']aifhub["']|^<<\s*:|^\{|^---|^%/.test(line))) throw new Error('unsupported_config');
    return {};
  }
  const start = hubs[0];
  if (!/^aifhub:\s*(?:#.*)?$/.test(lines[start])) throw new Error('unsupported_aifhub');
  const endOffset = lines.slice(start + 1).findIndex((line) => /^\S/.test(line));
  const hub = lines.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset);
  if (hub.some((line) => /\t|^  <<\s*:|^  ["']/.test(line))) throw new Error('unsupported_aifhub');
  const indexes = hub.map((line, index) => /^  providers\s*:/.test(line) ? index : -1).filter((index) => index >= 0);
  if (indexes.length > 1) throw new Error('duplicate_providers');
  if (!indexes.length) {
    if (hub.some((line) => /\bproviders\s*:/.test(line))) throw new Error('invalid_provider_indent');
    return {};
  }
  const index = indexes[0];
  if (/^  providers:\s*\{\}\s*$/.test(hub[index])) {
    if (hub[index + 1] && /^    /.test(hub[index + 1])) throw new Error('invalid_empty_mapping');
    return {};
  }
  if (!/^  providers:\s*(?:#.*)?$/.test(hub[index])) throw new Error('unsupported_providers');
  const next = hub.slice(index + 1).findIndex((line) => /^  \S/.test(line));
  const body = hub.slice(index + 1, next < 0 ? undefined : index + 1 + next);
  const result = Object.create(null);
  let provider;
  let list;
  for (const line of body) {
    let match;
    if ((match = line.match(/^    ([a-z][a-z0-9_]*):\s*(?:#.*)?$/))) {
      if (Object.hasOwn(result, match[1])) throw new Error('duplicate_provider');
      provider = Object.create(null);
      result[match[1]] = provider;
      list = null;
    } else if ((match = line.match(/^      ([a-zA-Z][a-zA-Z0-9]*):\s*(.*?)\s*$/))) {
      if (!provider || Object.hasOwn(provider, match[1])) throw new Error('duplicate_or_missing_provider');
      const value = match[2].replace(/\s+#.*$/, '');
      if (match[1] === 'phases' && !value) {
        list = [];
        provider.phases = list;
      } else {
        list = null;
        provider[match[1]] = scalar(value);
      }
    } else if ((match = line.match(/^        -\s+([a-z]+)\s*(?:#.*)?$/)) && list) {
      list.push(match[1]);
    } else throw new Error('unsupported_provider_yaml');
  }
  return result;
}

function scalar(value) {
  if (value === 'true' || value === 'false') return value === 'true';
  if (value.startsWith('"') || value.startsWith('[')) {
    try { return JSON.parse(value); } catch { throw new Error('invalid_provider_value'); }
  }
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (/^[0-9]+$/.test(value)) return Number(value);
  if (/^[a-z][a-z0-9_-]*$/.test(value)) return value;
  throw new Error('unsupported_provider_value');
}

export function normalizeProviderPolicies(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_providers');
  if (Object.keys(value).some((id) => !Object.hasOwn(PROVIDER_KINDS, id))) throw new Error('unknown_provider');
  const normalized = {};
  for (const id of Object.keys(PROVIDER_KINDS)) {
    const config = Object.hasOwn(value, id) ? value[id] : { enable: false };
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some((key) => !['enable', 'policy', 'phases', 'executable', 'timeoutMs', 'maxOutputBytes'].includes(key))
      || config.enable !== undefined && typeof config.enable !== 'boolean') throw new Error('invalid_provider_config');
    const policy = config.policy === undefined ? 'required' : config.policy;
    if (!PROVIDER_POLICIES.includes(policy)) throw new Error('invalid_provider_policy');
    const phases = config.phases ?? (id === 'hlv' ? ['verify', 'done'] : ['implement', 'verify', 'done']);
    if (!Array.isArray(phases) || !phases.length || new Set(phases).size !== phases.length
      || phases.some((phase) => !PROVIDER_PHASES.includes(phase) || (id === 'hlv' && phase === 'implement'))) {
      throw new Error('invalid_provider_phases');
    }
    if (config.executable !== undefined && (typeof config.executable !== 'string'
      || !path.isAbsolute(config.executable) || /[\x00-\x1f]/.test(config.executable)
      || /\.(?:cmd|bat|ps1|sh)$/i.test(config.executable))) throw new Error('invalid_provider_executable');
    const timeoutMs = config.timeoutMs ?? 30000;
    const maxOutputBytes = config.maxOutputBytes ?? 1024 * 1024;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000
      || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 4 * 1024 * 1024) {
      throw new Error('invalid_provider_limits');
    }
    normalized[id] = { enable: config.enable ?? false, policy, phases, timeoutMs, maxOutputBytes,
      ...(config.executable === undefined ? {} : { executable: config.executable }) };
  }
  return normalized;
}

export async function readProviderPolicies(rootDir) {
  const bytes = await readProviderFile(rootDir, '.ai-factory/config.yaml', 256 * 1024);
  const text = bytes === null ? '' : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return normalizeProviderPolicies(parseProviderConfig(text));
}

export function providerGate(status, policy) {
  if (status === 'pass') return { status: 'pass', blocking: false };
  if (status === 'warn') return { status: 'warn', blocking: false };
  if (policy === 'required') return { status: 'fail', blocking: true };
  return { status: 'warn', blocking: false };
}
