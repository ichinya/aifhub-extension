import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

export function register(program) {
  program.command('aifhub-execution')
    .description('Manage source-bound execution, sealed batches, isolated integration, fix attempts, and recovery.')
    .allowUnknownOption(true).allowExcessArguments(true).argument('[args...]')
    .action(async (args, command) => {
      const normalized = normalizeWrapperArgs(args, command);
      // The independent scanner also works when execution-state itself was locally replaced.
      const script = normalized[0] === 'diagnostics' ? '../scripts/execution-provenance.mjs' : '../scripts/execution-state.mjs';
      await runInstalledScript(script, normalized, import.meta.url);
    });
}
