// Installed-project wrapper; runs with the consumer project's cwd.
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

export function register(program) {
  program
    .command('aifhub-session-brief')
    .description('Compile, inspect, or show a source-bound AIFHub SessionBrief.')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/session-brief.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
