import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

export function register(program) {
  program
    .command('aifhub-plan-compliance')
    .description('Compare plan, SessionBrief, and changed scope to produce a drift receipt.')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/plan-compliance.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
