// Installed-project wrapper; the helper never writes gate evidence.
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

const DESCRIPTION = 'Inspect required gate coverage without changing evidence or authorizing progression.';

export function register(program) {
  program
    .command('aifhub-gate-coverage')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/aif-gate-coverage.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
