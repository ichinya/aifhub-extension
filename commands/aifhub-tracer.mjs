import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

export function register(program) {
  program
    .command('aifhub-tracer')
    .description('Run a tracer profile: run, promote, discard, replan, blocked, status.')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript('../scripts/tracer.mjs', normalizeWrapperArgs(args, command), import.meta.url);
    });
}
