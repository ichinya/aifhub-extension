// aifhub-done-finalizer.mjs - installed-project wrapper for verified OpenSpec finalization
import { normalizeWrapperArgs, runInstalledScript } from './run-installed-script.mjs';

const DESCRIPTION = 'Finalize a verified AIFHub OpenSpec change from an installed project.';
const FINALIZER_TIMEOUT_MS = 15 * 60 * 1000;
const FINALIZER_KILL_TIMEOUT_MS = 5000;

export function register(program) {
  program
    .command('aifhub-done-finalizer')
    .description(DESCRIPTION)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async (args, command) => {
      await runInstalledScript(
        '../scripts/openspec-done-finalizer.mjs',
        normalizeWrapperArgs(args, command),
        import.meta.url,
        {
          timeout: FINALIZER_TIMEOUT_MS,
          killTimeout: FINALIZER_KILL_TIMEOUT_MS,
          timeoutExitCode: 2
        }
      );
    });
}
