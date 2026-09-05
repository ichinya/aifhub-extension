// aifhub-mode.mjs - installed-project wrapper for the AIFHub mode helper
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';
import { registerPostUpdateInit } from './post-update-init.mjs';

const DESCRIPTION = 'Run AIFHub artifact mode status, switch, sync, and doctor commands.';

export function register(program) {
  registerPostUpdateInit(program, import.meta.url);
  program
    .command('aifhub-mode')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/aif-mode.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
