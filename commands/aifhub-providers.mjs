import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

export function register(program) {
  program.command('aifhub-providers')
    .description('Inspect and run configured AIFHub validation and semantic model providers.')
    .allowUnknownOption(true).allowExcessArguments(true).argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/aifhub-providers.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
