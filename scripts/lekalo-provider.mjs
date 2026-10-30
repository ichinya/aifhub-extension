// Lekalo v1.0.0/v1.1.0 publishes the workflow + `lekalo install prompt`
// protocol and LPAC-sandbox. A real AIFHub adapter is deferred to a separate issue.
// This intentional fail-closed stub never spawns the CLI and retains the stable
// unsupported / protocol_unpublished result until that adapter is implemented.
export const LEKALO_COMMAND_CONTRACT = Object.freeze({
  id: 'aifhub.lekalo-cli',
  version: '0.0.0',
  toolVersion: null,
  source: 'https://github.com/ichinya/lekalo',
  operations: []
});

export async function detectLekalo(rootDir, config, options = {}) {
  // No process spawn or guessed negotiation; the published protocol requires
  // a separately reviewed adapter, rather than enabling this stub implicitly.
  return { status: 'unsupported', reason: 'protocol_unpublished', version: null, layout: null };
}

export async function runLekaloOperation(operation, rootDir, config, options = {}) {
  return { status: 'unsupported', reason: 'protocol_unpublished', diagnostics: [] };
}
