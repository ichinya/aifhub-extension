import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

export function register(program) {
  program.command('aifhub-execution')
    .description('Manage source-bound execution, sealed batches, isolated integration, fix attempts, and recovery.')
    .allowUnknownOption(true).allowExcessArguments(true).argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/execution-state.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
