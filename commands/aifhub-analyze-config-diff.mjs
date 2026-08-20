// aifhub-analyze-config-diff.mjs - installed-project wrapper for the analyze config diff
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

const DESCRIPTION = 'Run the read-only AIFHub analyze config required-keys diff.';

export function register(program) {
  program
    .command('aifhub-analyze-config-diff')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/aif-analyze-config-diff.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
