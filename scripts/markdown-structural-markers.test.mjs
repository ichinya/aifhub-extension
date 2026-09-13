// markdown-structural-markers.test.mjs - shared Markdown structure contracts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMarkdownCodeMask,
  findExactMarkdownH2Sections,
  maskMarkdownCode
} from './markdown-structural-markers.mjs';

describe('Markdown structural markers', () => {
  it('only opens and closes fences with zero to three leading spaces', () => {
    for (const marker of ['````', '~~~~']) {
      for (const indent of ['', ' ', '  ', '   ']) {
        assert.deepEqual(createMarkdownCodeMask([
          `${indent}${marker}markdown`, 'hidden', `${indent}${marker}`, 'visible'
        ]), [true, true, true, false]);
      }
      for (const indent of ['    ', '\t']) {
        assert.deepEqual(createMarkdownCodeMask([
          `${indent}${marker}`, '', '### Requirement: Real'
        ]), [false, false, false]);
        assert.deepEqual(createMarkdownCodeMask([
          `${marker}markdown`, `${indent}${marker}`, '### Requirement: Example', marker,
          '### Requirement: Real'
        ]), [true, true, true, true, false]);
      }
    }
  });

  it('finds only exact active H2 headings and preserves their raw bodies', () => {
    const content = [
      '# Target',
      ' ## Target',
      '## Target ',
      '````markdown',
      '## Target',
      'inside the four-backtick fence',
      '```',
      '## Target',
      'still fenced after a shorter delimiter',
      '````',
      '## Target',
      '',
      'outside',
      '```text',
      '## Next',
      '```',
      '## Next',
      ''
    ].join('\n');

    assert.deepEqual(findExactMarkdownH2Sections(content, 'Target'), [[
      '',
      'outside',
      '```text',
      '## Next',
      '```'
    ]]);
  });

  it('uses the same fence-length semantics when masking code', () => {
    const content = [
      '````markdown',
      'hidden',
      '```',
      'still hidden',
      '````',
      'visible `inline hidden` text'
    ].join('\n');

    assert.equal(maskMarkdownCode(content), [
      '',
      '',
      '',
      '',
      '',
      'visible  text'
    ].join('\n'));
  });
});
