// aifhub-done-finalizer.mjs - installed-project wrapper for verified OpenSpec finalization
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

const DESCRIPTION = 'Finalize a verified AIFHub OpenSpec change from an installed project.';

export function register(program) {
  program
    .command('aifhub-done-finalizer')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/openspec-done-finalizer.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
