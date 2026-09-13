import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

export function register(program) {
  program
    .command('aifhub-exchange')
    .description('Export workflow profile metadata, per-change exchange bundles, or anonymized evaluation records.')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/workflow-exchange.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
