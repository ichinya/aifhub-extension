// ai-factory-version-resolver.mjs - provenance-aware AI Factory feature gate
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const AI_FACTORY_PROJECT_METADATA = '.ai-factory.json';
export const AI_FACTORY_ULTRA_MIN_VERSION = '2.18.0';

export function parseStableAiFactoryVersion(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (/^\d+\.\d+\.\d+-/.test(value)) {
    return {
      ok: false,
      version: null,
      parts: null,
      error: {
        code: 'ai-factory-version-prerelease-unsupported',
        message: 'AI Factory prerelease versions do not enable stable feature gates.'
      }
    };
  }

  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (match === null) {
    return {
      ok: false,
      version: null,
      parts: null,
      error: {
        code: 'ai-factory-version-malformed',
        message: 'AI Factory version must be a stable major.minor.patch value.'
      }
    };
  }

  return {
    ok: true,
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    parts: match.slice(1).map((part) => Number(part)),
    error: null
  };
}

export function compareStableAiFactoryVersions(left, right) {
  const parsedLeft = parseStableAiFactoryVersion(left);
  const parsedRight = parseStableAiFactoryVersion(right);
  if (!parsedLeft.ok || !parsedRight.ok) {
    throw new TypeError('compareStableAiFactoryVersions requires two stable major.minor.patch versions.');
  }

  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft.parts[index] !== parsedRight.parts[index]) {
      return parsedLeft.parts[index] < parsedRight.parts[index] ? -1 : 1;
    }
  }
  return 0;
}

export function parseAiFactoryPlanRequest(input) {
  const rawInput = String(input ?? '');
  let remaining = rawInput.replace(/^\s*/, '');
  let invocationToken = null;
  let modeToken = null;

  const invocation = /^(\/aif-plan|\$aif-plan|aif-plan)(?=$|\s)/.exec(remaining);
  if (invocation !== null) {
    invocationToken = invocation[1];
    remaining = remaining.slice(invocation[0].length).replace(/^\s+/, '');
  }

  const mode = /^(fast|full|ultra)(?=$|\s)/.exec(remaining);
  if (mode !== null) {
    modeToken = mode[1];
    remaining = remaining.slice(mode[0].length).replace(/^\s+/, '');
  }

  return {
    rawInput,
    invocationToken,
    modeToken,
    mode: modeToken ?? 'default',
    originalRequest: remaining
  };
}

export async function resolveAiFactoryVersion(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const injected = resolveInjectedVersion(options);
  if (injected.present) {
    return resolveVersionCandidate(injected.value, {
      source: 'injected',
      provenance: injected.provenance,
      path: null
    });
  }

  const projectMetadata = await readProjectVersion(rootDir, options);
  if (projectMetadata.exists) {
    if (!projectMetadata.ok) {
      return createVersionFailure({
        source: 'project-metadata',
        provenance: 'project-installation',
        resolutionPath: AI_FACTORY_PROJECT_METADATA,
        errors: projectMetadata.errors
      });
    }

    const resolved = resolveVersionCandidate(projectMetadata.version, {
      source: 'project-metadata',
      provenance: 'project-installation',
      path: AI_FACTORY_PROJECT_METADATA
    });
    if (!resolved.ok) {
      return resolved;
    }

    const suppliedCli = await resolveSuppliedCliEvidence(options);
    if (suppliedCli !== null) {
      const cliMatchesProject = isMatchingProjectCli(suppliedCli, rootDir);

      if (!cliMatchesProject) {
        resolved.warnings.push({
          code: 'ai-factory-cli-provenance-unverified',
          message: 'Supplied CLI version evidence was ignored because it was not proven to match the project installation.'
        });
        return resolved;
      }

      const cliVersion = parseStableAiFactoryVersion(suppliedCli.version);
      if (!cliVersion.ok) {
        return createVersionFailure({
          source: 'project-metadata',
          provenance: 'conflicting-cli-evidence',
          resolutionPath: AI_FACTORY_PROJECT_METADATA,
          errors: [cliVersion.error]
        });
      }

      if (cliVersion.version !== resolved.version) {
        return createVersionFailure({
          source: 'project-metadata',
          provenance: 'conflicting-cli-evidence',
          resolutionPath: AI_FACTORY_PROJECT_METADATA,
          errors: [{
            code: 'ai-factory-version-mismatch',
            message: 'Project AI Factory metadata and supplied CLI evidence report different versions.',
            project_version: resolved.version,
            cli_version: cliVersion.version,
            cli_source: suppliedCli.commandSource ?? 'unknown',
            cli_provenance_matched: true
          }]
        });
      }
    }

    return resolved;
  }

  const cli = await resolveSuppliedCliEvidence(options);
  if (cli === null) {
    return createVersionFailure({
      source: null,
      provenance: null,
      resolutionPath: AI_FACTORY_PROJECT_METADATA,
      errors: [{
        code: 'ai-factory-version-missing',
        message: 'AI Factory version is unavailable from injected evidence and project metadata.'
      }]
    });
  }

  if (!isMatchingProjectCli(cli, rootDir)) {
    return createVersionFailure({
      source: 'cli',
      provenance: cli.commandSource ?? 'unknown',
      resolutionPath: null,
      errors: [{
        code: 'ai-factory-cli-provenance-unverified',
        message: 'CLI version evidence is not proven to match the project installation.'
      }]
    });
  }

  return resolveVersionCandidate(cli.version, {
    source: 'cli',
    provenance: cli.commandSource ?? 'matched-project-cli',
    path: null
  });
}

export async function resolveAiFactoryUltraSupport(options = {}) {
  const resolution = await resolveAiFactoryVersion(options);
  if (!resolution.ok || resolution.supportsUltra) {
    return resolution;
  }

  return {
    ...resolution,
    ok: false,
    errors: [{
      code: 'ai-factory-ultra-unsupported',
      message: `AI Factory ${resolution.version} does not support stable ultra mode; ${AI_FACTORY_ULTRA_MIN_VERSION} or newer is required.`,
      detected_version: resolution.version,
      required_version: AI_FACTORY_ULTRA_MIN_VERSION
    }]
  };
}

function resolveInjectedVersion(options) {
  if (Object.hasOwn(options, 'injectedVersion')) {
    return {
      present: true,
      value: options.injectedVersion,
      provenance: 'injected-version'
    };
  }

  for (const [name, toolchain] of [
    ['test-toolchain', options.testToolchain],
    ['toolchain', options.toolchain]
  ]) {
    if (toolchain !== null && typeof toolchain === 'object') {
      const value = toolchain.aiFactoryVersion ?? toolchain.version;
      if (value !== undefined) {
        return { present: true, value, provenance: name };
      }
    }
  }

  return { present: false, value: null, provenance: null };
}

async function readProjectVersion(rootDir, options) {
  const read = options.readFile ?? readFile;
  const metadataPath = path.join(rootDir, AI_FACTORY_PROJECT_METADATA);
  let raw;
  try {
    raw = await read(metadataPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: true, exists: false, version: null, errors: [] };
    }
    return {
      ok: false,
      exists: true,
      version: null,
      errors: [{
        code: 'ai-factory-metadata-read-failed',
        message: `Unable to read ${AI_FACTORY_PROJECT_METADATA}.`
      }]
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      exists: true,
      version: null,
      errors: [{
        code: 'ai-factory-metadata-invalid-json',
        message: `${AI_FACTORY_PROJECT_METADATA} is not valid JSON.`
      }]
    };
  }

  if (!Object.hasOwn(parsed ?? {}, 'version')) {
    return {
      ok: false,
      exists: true,
      version: null,
      errors: [{
        code: 'ai-factory-version-missing',
        message: `${AI_FACTORY_PROJECT_METADATA} does not declare version.`
      }]
    };
  }

  return { ok: true, exists: true, version: parsed.version, errors: [] };
}

async function resolveSuppliedCliEvidence(options) {
  if (options.cliEvidence !== undefined) {
    return options.cliEvidence;
  }
  if (options.cli !== undefined) {
    return options.cli;
  }
  if (typeof options.resolveCliVersion === 'function') {
    return options.resolveCliVersion({ rootDir: path.resolve(options.rootDir ?? process.cwd()) });
  }
  return null;
}

function isMatchingProjectCli(cli, rootDir) {
  if (cli?.provenanceMatchesProject === true || cli?.commandSource === 'project-local') {
    return true;
  }

  if (typeof cli?.projectRoot !== 'string') {
    return false;
  }

  return path.resolve(cli.projectRoot) === path.resolve(rootDir);
}

function resolveVersionCandidate(value, context) {
  const parsed = parseStableAiFactoryVersion(value);
  if (!parsed.ok) {
    return createVersionFailure({
      source: context.source,
      provenance: context.provenance,
      resolutionPath: context.path,
      errors: [parsed.error]
    });
  }

  return {
    ok: true,
    version: parsed.version,
    source: context.source,
    provenance: context.provenance,
    resolutionPath: context.path,
    stable: true,
    supportsUltra: compareStableAiFactoryVersions(parsed.version, AI_FACTORY_ULTRA_MIN_VERSION) >= 0,
    minimumUltraVersion: AI_FACTORY_ULTRA_MIN_VERSION,
    warnings: [],
    errors: []
  };
}

function createVersionFailure({ source, provenance, resolutionPath, errors }) {
  return {
    ok: false,
    version: null,
    source,
    provenance,
    resolutionPath,
    stable: false,
    supportsUltra: false,
    minimumUltraVersion: AI_FACTORY_ULTRA_MIN_VERSION,
    warnings: [],
    errors
  };
}
