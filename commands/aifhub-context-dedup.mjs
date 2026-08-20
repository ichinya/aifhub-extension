// aifhub-context-dedup.mjs - installed-project wrapper for the optional session read dedup service
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

const DESCRIPTION = 'Run AIFHub session context dedup checks, status, and purge.';

export function register(program) {
  program
    .command('aifhub-context-dedup')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/context-dedup.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
