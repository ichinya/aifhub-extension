// Installed-project wrapper for the shared QA manifest publisher.
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

export function register(program) {
  program
    .command('aifhub-qa-manifest')
    .description('Prepare, record, publish, or inspect content-bound QA evidence.')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/qa-manifest.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
