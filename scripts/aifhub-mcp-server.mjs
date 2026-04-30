// aifhub-mcp-server.mjs - dependency-free stdio MCP server for AIFHub skill workflows
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';

const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 120000;

const TOOL_DEFINITIONS = [
  {
    name: 'search_skills',
    description: 'Search the skills catalog through the installed skills CLI.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results requested from the caller.' }
      }
    }
  },
  {
    name: 'install_skill',
    description: 'Prepare or run a skills CLI install command. Defaults to dry run unless confirm is true.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['skill'],
      properties: {
        skill: { type: 'string', description: 'Skill name or source accepted by the skills CLI.' },
        agent: { type: 'string', description: 'Target skills CLI agent flag value.' },
        confirm: { type: 'boolean', description: 'When true, execute the install command.' }
      }
    }
  },
  {
    name: 'run_skill_tests',
    description: 'Run tests for a local skill package or a caller-provided test command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skillPath: { type: 'string', description: 'Local skill directory. Defaults to the current directory.' },
        command: { type: 'string', description: 'Explicit test command executable.' },
        args: {
          type: 'array',
          description: 'Arguments for the explicit test command.',
          items: { type: 'string' }
        }
      }
    }
  },
  {
    name: 'propose_skill_improvement',
    description: 'Return a structured improvement proposal for a skill without editing files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['skillPath', 'issue', 'proposal'],
      properties: {
        skillPath: { type: 'string', description: 'Skill path or identifier.' },
        issue: { type: 'string', description: 'Problem or gap to address.' },
        proposal: { type: 'string', description: 'Proposed improvement.' },
        evidence: { type: 'string', description: 'Optional supporting evidence.' }
      }
    }
  }
];

function commandName(command) {
  if (process.platform !== 'win32') return command;
  return command.endsWith('.cmd') ? command : `${command}.cmd`;
}

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function assertStringArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function textResult(text) {
  return {
    content: [{ type: 'text', text }]
  };
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd || process.cwd();

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}Timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function hasFile(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function searchSkills(args, options = {}) {
  const query = assertString(args.query, 'query');
  const limit = Number.isInteger(args.limit) ? args.limit : 10;
  const runner = options.runner || runCommand;
  const result = await runner(commandName('npx'), ['-y', 'skills', 'search', query], { timeoutMs: DEFAULT_TIMEOUT_MS });

  return textResult(jsonText({
    query,
    requestedLimit: limit,
    command: 'npx -y skills search <query>',
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  }));
}

async function installSkill(args, options = {}) {
  const skill = assertString(args.skill, 'skill');
  const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : null;
  const commandArgs = ['-y', 'skills', 'install'];
  if (agent) {
    commandArgs.push('--agent', agent);
  }
  commandArgs.push(skill);

  if (args.confirm !== true) {
    return textResult(jsonText({
      dryRun: true,
      reason: 'Set confirm: true to execute the install command.',
      command: ['npx', ...commandArgs].join(' ')
    }));
  }

  const runner = options.runner || runCommand;
  const result = await runner(commandName('npx'), commandArgs, { timeoutMs: DEFAULT_TIMEOUT_MS });
  return textResult(jsonText({
    dryRun: false,
    skill,
    agent,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  }));
}

async function resolveTestCommand(skillPath, args) {
  const explicitCommand = typeof args.command === 'string' && args.command.trim() ? args.command.trim() : null;
  if (explicitCommand) {
    return {
      command: commandName(explicitCommand),
      args: assertStringArray(args.args, 'args')
    };
  }

  const packageJsonPath = path.join(skillPath, 'package.json');
  if (await hasFile(packageJsonPath)) {
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    if (packageJson.scripts && typeof packageJson.scripts.test === 'string') {
      return { command: commandName('npm'), args: ['test'] };
    }
  }

  const testScript = path.join(skillPath, 'scripts', 'test.mjs');
  if (await hasFile(testScript)) {
    return { command: commandName('node'), args: [testScript] };
  }

  throw new Error('No test command detected. Provide command and args explicitly.');
}

async function runSkillTests(args, options = {}) {
  const skillPath = path.resolve(process.cwd(), typeof args.skillPath === 'string' && args.skillPath ? args.skillPath : '.');
  const testCommand = await resolveTestCommand(skillPath, args);
  const runner = options.runner || runCommand;
  const result = await runner(testCommand.command, testCommand.args, {
    cwd: skillPath,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });

  return textResult(jsonText({
    skillPath,
    command: [testCommand.command, ...testCommand.args].join(' '),
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  }));
}

async function proposeSkillImprovement(args) {
  const skillPath = assertString(args.skillPath, 'skillPath');
  const issue = assertString(args.issue, 'issue');
  const proposal = assertString(args.proposal, 'proposal');
  const evidence = typeof args.evidence === 'string' && args.evidence.trim() ? args.evidence.trim() : 'Not provided.';

  return textResult(`## Skill Improvement Proposal

Skill: ${skillPath}

Problem:
${issue}

Proposal:
${proposal}

Evidence:
${evidence}

Next step:
Review the proposal, then apply it through the normal repository workflow with tests.`);
}

const TOOL_HANDLERS = {
  search_skills: searchSkills,
  install_skill: installSkill,
  run_skill_tests: runSkillTests,
  propose_skill_improvement: proposeSkillImprovement
};

function success(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function failure(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

export async function handleMcpMessage(message, options = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return failure(null, -32600, 'Invalid Request');
  }

  const { id, method, params } = message;
  if (typeof method !== 'string') {
    return failure(id, -32600, 'Invalid Request');
  }

  if (id === undefined && method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'initialize') {
    return success(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'aifhub-mcp', version: SERVER_VERSION }
    });
  }

  if (method === 'tools/list') {
    return success(id, { tools: TOOL_DEFINITIONS });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const toolArgs = params && params.arguments ? params.arguments : {};
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      return failure(id, -32602, `Unknown tool: ${name}`);
    }

    try {
      const result = await handler(toolArgs, options);
      return success(id, result);
    } catch (err) {
      return success(id, {
        isError: true,
        content: [{ type: 'text', text: err.message }]
      });
    }
  }

  return failure(id, -32601, `Method not found: ${method}`);
}

export async function startMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      output.write(`${JSON.stringify(failure(null, -32700, 'Parse error', err.message))}\n`);
      continue;
    }

    const response = await handleMcpMessage(message);
    if (response) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startMcpServer();
}
