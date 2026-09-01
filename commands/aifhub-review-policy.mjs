// aifhub-review-policy.mjs - installed-project wrapper for safe review policy resolution
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

const DESCRIPTION = 'Resolve, load, or scaffold the configured review policy through canonical path safety checks.';

export function register(program) {
  program
    .command('aifhub-review-policy')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/review-policy-resolver.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
