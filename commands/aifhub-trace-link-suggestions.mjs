// Installed-project wrapper; the helper never writes gate evidence.
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

const DESCRIPTION = 'Run opt-in advisory trace link suggestions over the closed typed graph of requirements, symbols, scenarios, and tests without changing evidence or authorizing progression.';

export function register(program) {
  program
    .command('aifhub-trace-link-suggestions')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/trace-link-suggestions.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
