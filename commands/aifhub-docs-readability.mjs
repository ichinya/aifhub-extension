// Installed-project wrapper; the helper never writes gate evidence.
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

const DESCRIPTION = 'Run opt-in non-blocking readability diagnostics for documents bound to an OpenSpec change without changing evidence or authorizing progression.';

export function register(program) {
  program
    .command('aifhub-docs-readability')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/docs-readability.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
