import { readProviderFile } from './provider-files.mjs';

export const TOOL_IDS = Object.freeze(['openspec', 'hlv', 'lekalo']);

// Keep tool switches strict: malformed opt-in must never select another artifact
// owner or silently disable a required provider. Other namespaces remain opaque.
export function parseToolConfig(raw = '') {
  const lines = String(raw).replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (lines[0] === '---') lines.shift();
  if (lines.at(-1) === '...') lines.pop();
  if (lines.some((line) => /^["']aifhub["']|^<<\s*:|^\{|^---|^\.\.\.|^%/.test(line))) throw new Error('unsupported_tool_config');
  const starts = lines.flatMap((line, index) => /^aifhub\s*:/.test(line) ? [index] : []);
  if (starts.length > 1) throw new Error('duplicate_aifhub');
  const start = starts[0];
  if (start === undefined) return toolResult(false, {}, null);
  if (!/^aifhub:\s*(?:#.*)?$/.test(lines[start])) throw new Error('unsupported_aifhub');
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  const hub = lines.slice(start + 1, end < 0 ? undefined : end);
  if (hub.some((line) => /\t|^  <<\s*:|^  ["']/.test(line))) throw new Error('unsupported_aifhub');
  const toolStarts = hub.flatMap((line, index) => /^  tools\s*:/.test(line) ? [index] : []);
  if (toolStarts.length > 1) throw new Error('duplicate_tools');
  if (!toolStarts.length) {
    if (hub.some((line) => /\btools\s*:/.test(line))) throw new Error('invalid_tools_indent');
    const markers = hub.filter((line) => /^  artifactProtocol\s*:/.test(line));
    if (markers.length > 1) throw new Error('duplicate_artifact_protocol');
    const legacy = markers[0]?.match(/^  artifactProtocol:\s*["']?(openspec|ai-factory)["']?\s*(?:#.*)?$/)?.[1] ?? null;
    if (markers.length && legacy === null) throw new Error('invalid_artifact_protocol');
    return toolResult(false, {}, legacy);
  }
  const index = toolStarts[0];
  const next = hub.findIndex((line, position) => position > index && /^  \S/.test(line));
  const body = hub.slice(index + 1, next < 0 ? undefined : next);
  if (/^  tools:\s*\{\}\s*(?:#.*)?$/.test(hub[index])) {
    if (body.length) throw new Error('invalid_empty_tools');
    return toolResult(true, {}, null);
  }
  if (!/^  tools:\s*(?:#.*)?$/.test(hub[index])) throw new Error('invalid_tools');
  if (!body.length) throw new Error('invalid_tools');
  const tools = {};
  for (const line of body) {
    const match = line.match(/^    ([a-z][a-z0-9_]*):\s*(true|false)\s*(?:#.*)?$/);
    if (!match || !TOOL_IDS.includes(match[1]) || Object.hasOwn(tools, match[1])) throw new Error('invalid_tool_switch');
    tools[match[1]] = match[2] === 'true';
  }
  return toolResult(true, tools, null);
}

function toolResult(explicit, values, legacy) {
  const tools = { openspec: legacy === 'openspec', hlv: false, lekalo: false, ...values };
  return { explicit, tools, mode: tools.openspec ? 'openspec' : 'ai-factory' };
}

export async function readToolConfig(rootDir) {
  const bytes = await readProviderFile(rootDir, '.ai-factory/config.yaml', 256 * 1024);
  return parseToolConfig(bytes === null ? '' : new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function toolArtifactPaths(selection, paths = {}) {
  if (!selection.explicit) return paths;
  return { ...paths,
    plans: selection.tools.openspec ? 'openspec/changes' : '.ai-factory/plans',
    specs: selection.tools.openspec ? 'openspec/specs' : '.ai-factory/specs' };
}
