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

function splitMarkdownLines(content) {
  return String(content ?? '').split(/\r\n|\n|\r/);
}

function createMarkdownCodeMask(lines) {
  const mask = [];
  let fence = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      if (fence === null) {
        fence = { char: token[0], length: token.length };
      } else if (token[0] === fence.char && token.length >= fence.length) {
        fence = null;
      }
      mask.push(true);
      continue;
    }

    mask.push(fence !== null);
  }

  return mask;
}
