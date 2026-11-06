// Installed-project wrapper; the helper never writes gate evidence.
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

const DESCRIPTION = 'Run opt-in advisory requirement ambiguity diagnostics for presented requirement sources without changing evidence or authorizing progression.';

export function register(program) {
  program
    .command('aifhub-requirement-lint')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/requirement-lint.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
