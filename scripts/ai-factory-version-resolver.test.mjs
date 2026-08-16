// ai-factory-version-resolver.test.mjs - deterministic AI Factory feature-gate tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  AI_FACTORY_ULTRA_MIN_VERSION,
  compareStableAiFactoryVersions,
  parseAiFactoryPlanRequest,
  parseStableAiFactoryVersion,
  resolveAiFactoryUltraSupport,
  resolveAiFactoryVersion
} from './ai-factory-version-resolver.mjs';

const ROOT_DIR = path.resolve('C:/fixtures/aif-project');

function metadataReader(value) {
  return async () => JSON.stringify({ version: value });
}

async function missingMetadataReader() {
  const error = new Error('missing fixture metadata');
  error.code = 'ENOENT';
  throw error;
}

describe('AI Factory stable version parsing', () => {
  it('accepts stable 2.17, 2.18.0, and 2.18.1 versions without raising the ultra boundary', () => {
    assert.equal(parseStableAiFactoryVersion('2.17.0').version, '2.17.0');
    assert.equal(parseStableAiFactoryVersion('2.18.0').version, '2.18.0');
    assert.equal(parseStableAiFactoryVersion('2.18.1').version, '2.18.1');
    assert.equal(AI_FACTORY_ULTRA_MIN_VERSION, '2.18.0');
    assert.equal(compareStableAiFactoryVersions('2.17.0', AI_FACTORY_ULTRA_MIN_VERSION), -1);
    assert.equal(compareStableAiFactoryVersions('2.18.0', AI_FACTORY_ULTRA_MIN_VERSION), 0);
    assert.equal(compareStableAiFactoryVersions('2.18.1', AI_FACTORY_ULTRA_MIN_VERSION), 1);
    assert.equal(compareStableAiFactoryVersions('2.19.0', AI_FACTORY_ULTRA_MIN_VERSION), 1);
  });

  it('rejects prerelease and malformed values with stable bounded codes', () => {
    assert.deepEqual(parseStableAiFactoryVersion('2.18.0-rc.1').error, {
      code: 'ai-factory-version-prerelease-unsupported',
      message: 'AI Factory prerelease versions do not enable stable feature gates.'
    });
    assert.equal(parseStableAiFactoryVersion('v2.18').error.code, 'ai-factory-version-malformed');
    assert.equal(parseStableAiFactoryVersion('').error.code, 'ai-factory-version-malformed');
  });
});

describe('AI Factory version source precedence and provenance', () => {
  it('uses an injected test version without reading project metadata or CLI evidence', async () => {
    let metadataReads = 0;
    let cliReads = 0;
    const result = await resolveAiFactoryVersion({
      rootDir: ROOT_DIR,
      injectedVersion: '2.18.0',
      readFile: async () => {
        metadataReads += 1;
        return JSON.stringify({ version: '2.17.0' });
      },
      resolveCliVersion: async () => {
        cliReads += 1;
        return { version: '2.16.0', provenanceMatchesProject: true };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.version, '2.18.0');
    assert.equal(result.source, 'injected');
    assert.equal(metadataReads, 0);
    assert.equal(cliReads, 0);
  });

  it('accepts injected toolchain metadata using the same highest precedence', async () => {
    const result = await resolveAiFactoryVersion({
      rootDir: ROOT_DIR,
      testToolchain: { aiFactoryVersion: '2.18.1' },
      readFile: metadataReader('2.17.0')
    });

    assert.equal(result.ok, true);
    assert.equal(result.version, '2.18.1');
    assert.equal(result.source, 'injected');
    assert.equal(result.provenance, 'test-toolchain');
  });

  it('uses project .ai-factory.json metadata as the authoritative installed version', async () => {
    const result = await resolveAiFactoryVersion({
      rootDir: ROOT_DIR,
      readFile: metadataReader('2.18.0')
    });

    assert.equal(result.ok, true);
    assert.equal(result.version, '2.18.0');
    assert.equal(result.source, 'project-metadata');
    assert.equal(result.resolutionPath, '.ai-factory.json');
    assert.equal(result.supportsUltra, true);
  });

  it('accepts CLI fallback only when its provenance matches the project installation', async () => {
    const trusted = await resolveAiFactoryVersion({
      rootDir: ROOT_DIR,
      readFile: missingMetadataReader,
      cliEvidence: {
        version: '2.18.0',
        commandSource: 'project-local'
      }
    });
    const untrusted = await resolveAiFactoryVersion({
      rootDir: ROOT_DIR,
      readFile: missingMetadataReader,
      cliEvidence: {
        version: '2.18.0',
        commandSource: 'PATH'
      }
    });

    assert.equal(trusted.ok, true);
    assert.equal(trusted.source, 'cli');
    assert.equal(untrusted.ok, false);
    assert.equal(untrusted.errors[0].code, 'ai-factory-cli-provenance-unverified');
  });

  it('ignores an unverified PATH-only CLI even when its version differs', async () => {
    const result = await resolveAiFactoryVersion({
      rootDir: ROOT_DIR,
      readFile: metadataReader('2.18.0'),
      cliEvidence: {
        version: '2.17.0',
        commandSource: 'PATH'
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'project-metadata');
    assert.equal(result.version, '2.18.0');
    assert.deepEqual(result.warnings.map((warning) => warning.code), [
      'ai-factory-cli-provenance-unverified'
    ]);
  });

  it('fails closed when project and provenance-matched CLI versions disagree', async () => {
    const result = await resolveAiFactoryVersion({
      rootDir: ROOT_DIR,
      readFile: metadataReader('2.18.0'),
      cliEvidence: {
        version: '2.17.0',
        commandSource: 'project-local'
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.source, 'project-metadata');
    assert.equal(result.errors[0].code, 'ai-factory-version-mismatch');
    assert.equal(result.errors[0].project_version, '2.18.0');
    assert.equal(result.errors[0].cli_version, '2.17.0');
    assert.equal(result.errors[0].cli_provenance_matched, true);
  });
});

describe('AI Factory ultra feature gate', () => {
  it('rejects stable 2.17 and accepts both stable 2.18.0 and current 2.18.1', async () => {
    const oldRuntime = await resolveAiFactoryUltraSupport({
      rootDir: ROOT_DIR,
      readFile: metadataReader('2.17.0')
    });
    const boundaryRuntime = await resolveAiFactoryUltraSupport({
      rootDir: ROOT_DIR,
      readFile: metadataReader('2.18.0')
    });
    const currentRuntime = await resolveAiFactoryUltraSupport({
      rootDir: ROOT_DIR,
      readFile: metadataReader('2.18.1')
    });

    assert.equal(oldRuntime.ok, false);
    assert.equal(oldRuntime.version, '2.17.0');
    assert.equal(oldRuntime.errors[0].code, 'ai-factory-ultra-unsupported');
    assert.equal(boundaryRuntime.ok, true);
    assert.equal(boundaryRuntime.supportsUltra, true);
    assert.equal(currentRuntime.ok, true);
    assert.equal(currentRuntime.version, '2.18.1');
    assert.equal(currentRuntime.minimumUltraVersion, '2.18.0');
    assert.equal(currentRuntime.supportsUltra, true);
  });

  it('fails closed for prerelease, malformed, missing, and invalid JSON project metadata', async () => {
    const cases = [
      ['prerelease', metadataReader('2.18.0-rc.1'), 'ai-factory-version-prerelease-unsupported'],
      ['malformed', metadataReader('2.18'), 'ai-factory-version-malformed'],
      ['missing', missingMetadataReader, 'ai-factory-version-missing'],
      ['invalid-json', async () => '{not-json', 'ai-factory-metadata-invalid-json']
    ];

    for (const [label, readFile, expectedCode] of cases) {
      const result = await resolveAiFactoryUltraSupport({ rootDir: ROOT_DIR, readFile });
      assert.equal(result.ok, false, label);
      assert.equal(result.errors[0].code, expectedCode, label);
    }
  });

  it('keeps diagnostics bounded and free of request or research bodies', async () => {
    const secretRequest = 'ultra private request body';
    const secretResearch = 'private research body';
    const result = await resolveAiFactoryUltraSupport({
      rootDir: ROOT_DIR,
      readFile: metadataReader('2.17.0')
    });
    const serialized = JSON.stringify(result);

    assert.equal(serialized.includes(secretRequest), false);
    assert.equal(serialized.includes(secretResearch), false);
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        'errors',
        'minimumUltraVersion',
        'ok',
        'provenance',
        'resolutionPath',
        'source',
        'stable',
        'supportsUltra',
        'version',
        'warnings'
      ]
    );
  });
});

describe('aif-plan request parsing', () => {
  it('removes only the leading invocation and mode token', () => {
    assert.deepEqual(parseAiFactoryPlanRequest('/aif-plan ultra Build ultra search'), {
      rawInput: '/aif-plan ultra Build ultra search',
      invocationToken: '/aif-plan',
      modeToken: 'ultra',
      mode: 'ultra',
      originalRequest: 'Build ultra search'
    });
  });

  it('preserves later ultra occurrences, casing, punctuation, whitespace, and line breaks', () => {
    const request = 'Keep  ultra EXACTLY, please.\r\nSecond ultra line.';
    const parsed = parseAiFactoryPlanRequest(`$aif-plan ultra   ${request}`);

    assert.equal(parsed.modeToken, 'ultra');
    assert.equal(parsed.originalRequest, request);
  });

  it('does not treat an internal mode word as a command-position token', () => {
    const request = 'Build a full ultra-compatible workflow';
    const parsed = parseAiFactoryPlanRequest(`/aif-plan ${request}`);

    assert.equal(parsed.modeToken, null);
    assert.equal(parsed.originalRequest, request);
  });
});
