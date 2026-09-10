import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

export function register(program) {
  program
    .command('aifhub-fresh-context-review')
    .description('Prepare a fresh-context AI review package and receipt.')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/fresh-context-review.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
