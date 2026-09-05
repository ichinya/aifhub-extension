import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { detectHlvVersion } from './hlv-provider.mjs';
import { readProviderFile, safeProviderPath } from './provider-files.mjs';
import { readProviderPolicies } from './provider-policy.mjs';
import { runProviderProcess } from './provider-process.mjs';

export async function inspectHlvLayout(rootDir) {
  const root = await readProviderFile(rootDir, 'project.yaml', 256 * 1024);
  const adopt = await readProviderFile(rootDir, '.hlv/project.yaml', 256 * 1024);
  if (root !== null && adopt !== null) throw new Error('ambiguous_layout');
  const bytes = root ?? adopt;
  if (bytes === null) return null;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!/^schema_version:\s*1\s*(?:#.*)?$/m.test(text) || !/^project:\s*\S/m.test(text)) {
    throw new Error('invalid_existing_layout');
  }
  return root !== null ? 'greenfield' : 'adopt';
}

// Native fresh adopt writes .hlv/, missing agent assets, and appends an index
// ignore entry. Reinit updates existing managed files, so it is never invoked.
async function preflightHlvInit(rootDir) {
  const configRoot = await safeProviderPath(rootDir, '.hlv');
  if (configRoot.exists && (await readdir(configRoot.path)).length) throw new Error('partial_hlv_layout');
  for (const relative of ['AGENTS.md', 'HLV.md', '.gitignore']) {
    const bytes = await readProviderFile(rootDir, relative);
    if (bytes !== null) new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  let count = 0;
  const visit = async (relative) => {
    if (++count > 10000) throw new Error('agent_inventory_limit');
    const target = await safeProviderPath(rootDir, relative);
    if (!target.exists) return;
    if ((await lstat(target.path)).isDirectory()) {
      for (const name of await readdir(target.path)) await visit(`${relative}/${name}`);
    }
  };
  const skills = await safeProviderPath(rootDir, '.agents/skills');
  if (skills.exists && !(await lstat(skills.path)).isDirectory()) throw new Error('invalid_skills_directory');
  await visit('.agents/skills');
}

function result(options, state, layout = null, error = null) {
  const target = layout === 'greenfield' ? 'project.yaml' : '.hlv/project.yaml';
  return { ok: error === null, dryRun: Boolean(options.dryRun), tool: 'hlv', state, layout,
    operations: ['created', 'would-create', 'preserved'].includes(state)
      ? [{ action: state === 'preserved' ? 'preserve' : state === 'created' ? 'create' : state, target }] : [],
    warnings: [], errors: error === null ? [] : [{ code: `hlv-init-${error}`,
      message: `HLV project initialization could not complete (${error}). Fresh setup requires installed HLV 1.0.0; existing projects are reused and incomplete layouts need repair before retrying.` }] };
}

export async function initializeHlvProject(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  try {
    const config = (await readProviderPolicies(rootDir)).hlv;
    if (!config.enable) return result(options, 'disabled');
    const layout = await inspectHlvLayout(rootDir);
    if (layout) return result(options, 'preserved', layout);
    await preflightHlvInit(rootDir);
    if (options.dryRun) return result(options, 'would-create', 'adopt');
    const version = await detectHlvVersion(rootDir, config, options);
    if (version.status !== 'pass') return result(options, version.status, null, version.reason);
    // HLV interpolates the name into YAML: use a bounded safe slug, not raw paths.
    const project = path.basename(rootDir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project';
    const args = ['init', '--adopt', '--path', rootDir, '--project', project,
      '--owner', project, '--agent', 'agents', '--profile', 'standard'];
    const processResult = await (options.runProcess ?? runProviderProcess)(config.executable ?? 'hlv', args,
      { cwd: rootDir, timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes,
        signal: options.signal, env: options.env });
    if (processResult.outcome !== 'completed' || processResult.exitCode !== 0) {
      return result(options, 'failed', null, 'process_failed');
    }
    if (await inspectHlvLayout(rootDir) !== 'adopt') return result(options, 'failed', null, 'layout_missing_after_init');
    return result(options, 'created', 'adopt');
  } catch {
    return result(options, 'failed', null, 'unsafe_or_incomplete_layout');
  }
}
