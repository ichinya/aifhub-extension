// Installed-project wrapper; the helper never writes gate evidence.
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

const DESCRIPTION = 'Run opt-in advisory claim evidence diagnostics for presented claim-source pairs without changing evidence or authorizing progression.';

export function register(program) {
  program
    .command('aifhub-claim-evidence-check')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/claim-evidence-check.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
