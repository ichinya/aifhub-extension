// Shared tools and metering. The candidate additionally loads the unmodified
// upstream RTK Pi extension. This adapter never executes arbitrary shell text.
import fs from 'node:fs';
import { contained, execute } from './guard.mjs';

export default function(pi: any) {
  const config = JSON.parse(fs.readFileSync(process.env.AB_CASE_FILE!, 'utf8'));
  const stats: any = { schema: 1, messages: 0, input: 0, output: 0, cacheRead: 0,
    cacheWrite: 0, totalTokens: 0, reportedCost: 0, toolCalls: 0, commandCalls: 0,
    rtkCalls: 0, rawCalls: 0, toolBytes: 0, commandBytes: 0, denied: 0,
    testCommands: 0, successfulTestCommands: 0, limitReached: false, stopReasons: [],
    commands: [], finalText: '', sandbox: '', model: null };
  const save = () => fs.writeFileSync(config.metrics, JSON.stringify(stats));
  const output = (text: string) => {
    stats.toolBytes += Buffer.byteLength(text); save();
    return { content: [{ type: 'text', text }] };
  };
  pi.on('session_start', (_: any, ctx: any) => {
    stats.sandbox = ctx.cwd;
    stats.model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
    save();
  });
  pi.on('tool_call', async (_: any, ctx: any) => {
    stats.toolCalls++;
    if (stats.toolCalls > 24) {
      stats.limitReached = true; save(); await ctx.abort();
      return { block: true, reason: 'Scenario tool-call budget reached' };
    }
    save();
  });
  pi.on('message_end', (event: any) => {
    const m = event.message;
    if (m.role !== 'assistant') return;
    stats.messages++;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'])
      stats[key] += m.usage?.[key] || 0;
    stats.reportedCost += m.usage?.cost?.total || 0;
    stats.stopReasons.push(m.stopReason);
    const text = (m.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    if (text) stats.finalText = text;
    save();
  });
  pi.registerTool({ name: 'bash', label: 'Scenario command',
    description: 'Run an allowed project command. Output may be compressed. Prefix a listed command with "raw " to request complete output if details are missing. This is a bounded command adapter, not a general shell.',
    parameters: { type: 'object', properties: { command: { type: 'string', enum: config.commands.flatMap((x: string) => [x, `raw ${x}`]) } }, required: ['command'], additionalProperties: false },
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      try {
        const r = execute(config, ctx.cwd, params.command);
        stats.commandCalls++; stats.rtkCalls += Number(r.rtk); stats.rawCalls += Number(r.raw);
        stats.commandBytes += Buffer.byteLength(r.text);
        const command = config.dispatch[params.command].original;
        const test = /^(go test|php )/.test(command);
        stats.testCommands += Number(test); stats.successfulTestCommands += Number(test && r.code === 0);
        stats.commands.push({ command, rtk: r.rtk, raw: r.raw, code: r.code, bytes: Buffer.byteLength(r.text) });
        return output(r.text);
      } catch (e: any) { stats.denied++; return output(`Denied: ${e.message}`); }
    },
  });
  pi.registerTool({ name: 'read', label: 'Read project source', description: 'Read an allowed project file completely, without compression.',
    parameters: { type: 'object', properties: { path: { type: 'string', enum: config.readPaths } }, required: ['path'], additionalProperties: false },
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      try {
        if (!config.readPaths.includes(params.path)) throw Error('file outside scenario allowlist');
        return output(fs.readFileSync(contained(ctx.cwd, params.path), 'utf8'));
      } catch (e: any) { stats.denied++; return output(`Denied: ${e.message}`); }
    },
  });
  if (config.writePaths.length) pi.registerTool({ name: 'write', label: 'Write project source', description: 'Replace the complete contents of an allowed project file.',
    parameters: { type: 'object', properties: { path: { type: 'string', enum: config.writePaths }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      try {
        if (!config.writePaths.includes(params.path)) throw Error('file outside scenario allowlist');
        fs.writeFileSync(contained(ctx.cwd, params.path), params.content);
        return output('File written.');
      } catch (e: any) { stats.denied++; return output(`Denied: ${e.message}`); }
    },
  });
}
