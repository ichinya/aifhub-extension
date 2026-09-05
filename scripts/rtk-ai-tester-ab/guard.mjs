import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function contained(root, relative) {
  const base = fs.realpathSync(root);
  const target = path.resolve(base, relative);
  if (target === base || !target.startsWith(base + path.sep)) throw Error('path outside project');
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actual = fs.realpathSync(ancestor);
  if (actual !== base && !actual.startsWith(base + path.sep)) throw Error('symlink outside project');
  return target;
}

export function tokens(command) {
  if (/[\r\n;&|<>`$%]/.test(command)) throw Error('shell syntax forbidden');
  const parts = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g) || [];
  if (parts.join(' ') !== command) throw Error('noncanonical command');
  return parts.map(x => /^['"]/.test(x) ? x.slice(1, -1) : x);
}

export function execute(config, root, command) {
  const entry = config.dispatch[command];
  if (!entry) throw Error('command outside scenario allowlist');
  const cwd = entry.cwd === '.' ? fs.realpathSync(root) : contained(root, entry.cwd);
  const result = spawnSync(entry.exe, entry.args, {
    cwd, env: config.commandEnv, encoding: 'utf8', timeout: 90000,
    maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw Error(`command failed: ${result.error.code}`);
  return { text: `${result.stdout || ''}${result.stderr || ''}\n[exit=${result.status}]`,
    code: result.status, rtk: entry.rtk, raw: entry.raw };
}
