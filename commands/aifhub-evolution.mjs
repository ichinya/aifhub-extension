import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

export function register(program) {
  program.command('aifhub-evolution')
    .description('Propose, apply, and roll back versioned skill-context changes.')
    .allowUnknownOption(true).allowExcessArguments(true).argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/evolution-transactions.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
