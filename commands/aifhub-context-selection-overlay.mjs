// Installed-project wrapper; the helper never writes gate evidence.
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

const DESCRIPTION = 'Run opt-in advisory context selection over the exact baseline SessionBrief for presented supporting candidates without changing evidence, replacing the protected minimum, or authorizing progression.';

export function register(program) {
  program
    .command('aifhub-context-selection-overlay')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/context-selection-overlay.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
