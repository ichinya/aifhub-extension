import fs from 'node:fs';
import { contained, execute } from '../rtk-ai-tester-ab/guard.mjs';

export default function(pi: any) {
  const cfg = JSON.parse(fs.readFileSync(process.env.AB_CASE_FILE!, 'utf8'));
  const seen = new Set<string>();
  const stats: any = { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    toolCalls: 0, commandCalls: 0, rtkCalls: 0, rawCalls: 0, commandBytes: 0, toolBytes: 0,
    denied: 0, protocolBlocks: 0, modelErrors: 0, limitReached: false, commands: [], stopReasons: [],
    finalText: '', sandbox: '', model: null };
  const save = () => fs.writeFileSync(cfg.metrics, JSON.stringify(stats));
  const output = (text: string) => { stats.toolBytes += Buffer.byteLength(text); save(); return { content: [{ type: 'text', text }] }; };
  pi.on('session_start', (_: any, ctx: any) => { stats.sandbox = ctx.cwd; stats.model = { provider: ctx.model?.provider, id: ctx.model?.id }; save(); });
  pi.on('tool_call', async (_: any, ctx: any) => {
    stats.toolCalls++;
    if (stats.toolCalls > 30) { stats.limitReached = true; save(); await ctx.abort(); return { block: true, reason: 'Tool-call budget reached' }; }
    save();
  });
  pi.on('message_end', ({ message: m }: any) => {
    if (m.role !== 'assistant') return;
    stats.messages++;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) stats[key] += m.usage?.[key] || 0;
    stats.stopReasons.push(m.stopReason); stats.modelErrors += Number(m.stopReason === 'error');
    const text = (m.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    if (text) stats.finalText = text;
    save();
  });
  pi.registerTool({ name: 'bash', label: 'Multirepository command',
    description: 'Run an allowed command. Always run its normal form first. Afterward, prefix the exact same command with raw to recover complete output. Commands are fixed argument vectors, not free shell text.',
    parameters: { type: 'object', properties: { command: { type: 'string', enum: cfg.commands.flatMap((c: string) => [c, `raw ${c}`]) } }, required: ['command'], additionalProperties: false },
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const entry = cfg.dispatch[params.command];
      if (!entry) { stats.denied++; return output('Command outside scenario allowlist.'); }
      if (entry.raw && !seen.has(entry.original)) { stats.protocolBlocks++; return output('First run this command normally with bash; raw is available after that observation.'); }
      try {
        const r = execute(cfg, ctx.cwd, params.command);
        seen.add(entry.original);
        stats.commandCalls++; stats.rtkCalls += Number(r.rtk); stats.rawCalls += Number(r.raw);
        stats.commandBytes += Buffer.byteLength(r.text);
        stats.commands.push({ command: entry.original, owner: entry.owner, rtk: r.rtk, raw: r.raw, code: r.code, bytes: Buffer.byteLength(r.text) });
        return output(r.text);
      } catch (e: any) { stats.denied++; return output(`Command failed: ${e.message}`); }
    },
  });
  pi.registerTool({ name: 'read', label: 'Read labelled source', description: 'Read a complete allowed source file without compression.',
    parameters: { type: 'object', properties: { path: { type: 'string', enum: cfg.readPaths } }, required: ['path'], additionalProperties: false },
    async execute(_id: string, p: any, _signal: any, _update: any, ctx: any) {
      if (!cfg.readPaths.includes(p.path)) { stats.denied++; return output('File outside scenario allowlist.'); }
      return output(fs.readFileSync(contained(ctx.cwd, p.path), 'utf8'));
    },
  });
  if (cfg.writePaths.length) pi.registerTool({ name: 'write', label: 'Update labelled source', description: 'Replace one allowed source file. Preserve unrelated behavior.',
    parameters: { type: 'object', properties: { path: { type: 'string', enum: cfg.writePaths }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
    async execute(_id: string, p: any, _signal: any, _update: any, ctx: any) {
      if (!cfg.writePaths.includes(p.path)) { stats.denied++; return output('File outside scenario allowlist.'); }
      fs.writeFileSync(contained(ctx.cwd, p.path), p.content); return output('File written.');
    },
  });
}
