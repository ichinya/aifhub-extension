import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

export function register(program) {
  program
    .command('aifhub-plan-context')
    .description('Resolve a common plan context from a methodology adapter.')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/common-plan-resolver.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
