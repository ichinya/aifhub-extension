// openspec-change-metadata.test.mjs - OpenSpec per-change metadata compatibility tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENSPEC_CHANGE_METADATA_FILE,
  readOpenSpecSkipSpecsMarker
} from './openspec-change-metadata.mjs';

const changeDir = 'C:/repo/openspec/changes/docs-only';

describe('OpenSpec change metadata', () => {
  it('recognizes native skip_specs true with BOM and an inline comment', async () => {
    const result = await readOpenSpecSkipSpecsMarker(changeDir, {
      readFile: async () => '\uFEFFschema: spec-driven\r\nskip_specs: true # docs only\r\n'
    });

    assert.equal(result.exists, true);
    assert.equal(result.mentioned, true);
    assert.equal(result.declared, true);
    assert.equal(result.valid, true);
    assert.equal(result.invalidReason, null);
    assert.equal(result.metadataPath.endsWith(OPENSPEC_CHANGE_METADATA_FILE), true);
  });

  it('keeps an explicit false marker undeclared', async () => {
    const result = await readOpenSpecSkipSpecsMarker(changeDir, {
      readFile: async () => 'schema: spec-driven\nskip_specs: false\n'
    });

    assert.equal(result.mentioned, true);
    assert.equal(result.declared, false);
    assert.equal(result.valid, true);
  });

  it('accepts a boolean marker in a JSON-compatible YAML container', async () => {
    const result = await readOpenSpecSkipSpecsMarker(changeDir, {
      readFile: async () => '{"schema":"spec-driven","skip_specs":true}\n'
    });

    assert.equal(result.declared, true);
    assert.equal(result.valid, true);
  });

  it('fails closed for a string marker instead of treating it as boolean', async () => {
    const yaml = await readOpenSpecSkipSpecsMarker(changeDir, {
      readFile: async () => 'schema: spec-driven\nskip_specs: "true"\n'
    });
    const json = await readOpenSpecSkipSpecsMarker(changeDir, {
      readFile: async () => '{"schema":"spec-driven","skip_specs":"true"}\n'
    });

    for (const result of [yaml, json]) {
      assert.equal(result.mentioned, true);
      assert.equal(result.declared, false);
      assert.equal(result.valid, false);
      assert.match(result.invalidReason, /boolean true or false/);
    }
  });

  it('distinguishes missing metadata from an unreadable metadata file', async () => {
    const missing = await readOpenSpecSkipSpecsMarker(changeDir, {
      readFile: async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
    });
    const unreadable = await readOpenSpecSkipSpecsMarker(changeDir, {
      readFile: async () => {
        const error = new Error('denied');
        error.code = 'EACCES';
        throw error;
      }
    });

    assert.equal(missing.exists, false);
    assert.equal(missing.valid, true);
    assert.equal(unreadable.exists, true);
    assert.equal(unreadable.mentioned, true);
    assert.equal(unreadable.valid, false);
  });
});
