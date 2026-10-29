// markdown-structural-markers.mjs - dependency-free active marker helpers

export const ULTRA_PLAN_MARKER = '<!-- aif:plan-mode:ultra -->';

export function maskMarkdownCode(content) {
  const lines = splitMarkdownLines(content);
  const codeMask = createMarkdownCodeMask(lines);
  const output = lines.map((line, index) => (
    codeMask[index]
      ? ''
      : line.replace(/(`+)([^`\n]*?)\1/g, '')
  ));

  return output.join('\n');
}

/**
 * Finds exact, active level-two Markdown sections outside fenced code.
 *
 * A heading is active only when the complete line is `## ${heading}`. H1/H3
 * variants, leading whitespace, trailing whitespace, and fenced examples are
 * intentionally ignored. Section bodies end at the next active H2 heading.
 */
export function findExactMarkdownH2Sections(content, heading) {
  if (typeof heading !== 'string' || heading.length === 0 || /[\r\n]/.test(heading)) {
    return [];
  }

  const lines = splitMarkdownLines(content);
  const codeMask = createMarkdownCodeMask(lines);
  const sections = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (codeMask[index] || lines[index] !== `## ${heading}`) {
      continue;
    }

    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!codeMask[cursor] && /^##(?!#)[ \t]+/.test(lines[cursor])) {
        index = cursor - 1;
        break;
      }

      body.push(lines[cursor]);

      if (cursor === lines.length - 1) {
        index = cursor;
      }
    }

    sections.push(body);
  }

  return sections;
}

export function countActiveStandaloneMarker(content, marker = ULTRA_PLAN_MARKER) {
  return maskMarkdownCode(content)
    .split(/\r?\n/)
    .filter((line) => line.trim() === marker)
    .length;
}

export function hasActiveStandaloneMarker(content, marker = ULTRA_PLAN_MARKER) {
  return countActiveStandaloneMarker(content, marker) > 0;
}

export function markdownH2Spans(content) {
  const text = String(content);
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean);
  const bare = lines.map(line => line.replace(/(?:\r\n|\n|\r)$/, ''));
  const mask = createMarkdownCodeMask(bare);
  const spans = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!mask[i] && /^##(?!#)[ \t]+/.test(bare[i])) {
      if (spans.length) spans[spans.length - 1].end = offset;
      spans.push({ heading: bare[i].slice(3), start: offset, body_start: offset + Buffer.byteLength(lines[i]), end: Buffer.byteLength(text) });
    }
    offset += Buffer.byteLength(lines[i]);
  }
  return spans;
}

function splitMarkdownLines(content) {
  return String(content ?? '').split(/\r\n|\n|\r/);
}

export function createMarkdownCodeMask(lines) {
  const mask = [];
  let fence = null;

  for (const line of lines) {
    // Four spaces (or a tab) are code indentation, not a fence delimiter.
    // In an open fence they must not expose example headings to consumers.
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      if (fence === null) {
        fence = { char: token[0], length: token.length };
      } else if (token[0] === fence.char && token.length >= fence.length
        && /^\s*$/.test(line.slice(fenceMatch[0].length))) {
        fence = null;
      }
      mask.push(true);
      continue;
    }

    mask.push(fence !== null);
  }

  return mask;
}
