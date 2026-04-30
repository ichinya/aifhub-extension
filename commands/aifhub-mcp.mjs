// aifhub-mcp.mjs - AI Factory extension command that starts the AIFHub MCP server
import { startMcpServer } from '../scripts/aifhub-mcp-server.mjs';

export function register(program) {
  program
    .command('aifhub-mcp')
    .description('Run the AIFHub MCP server over stdio')
    .action(async () => {
      await startMcpServer();
    });
}
