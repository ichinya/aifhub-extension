// Lekalo adapter. The upstream provider protocol is unpublished at v0.1.10, so
// this adapter never spawns the lekalo CLI: detection and every operation fail
// closed with unsupported / protocol_unpublished. The reserved command contract
// and dispatch shape mirror hlv-provider.mjs so a published protocol only needs
// changes in this file.
export const LEKALO_COMMAND_CONTRACT = Object.freeze({
  id: 'aifhub.lekalo-cli',
  version: '0.0.0',
  toolVersion: null,
  source: 'https://github.com/ichinya/lekalo',
  operations: []
});

export async function detectLekalo(rootDir, config, options = {}) {
  // No process spawn and no guessed capability commands: v0.1.10 recognizes
  // inspect/impact/context only as unsupported stubs and publishes no versioned
  // provider manifest to negotiate against.
  return { status: 'unsupported', reason: 'protocol_unpublished', version: null, layout: null };
}

export async function runLekaloOperation(operation, rootDir, config, options = {}) {
  return { status: 'unsupported', reason: 'protocol_unpublished', diagnostics: [] };
}
