// markdown-structural-markers.mjs - dependency-free active marker helpers

export const ULTRA_PLAN_MARKER = '<!-- aif:plan-mode:ultra -->';

export function maskMarkdownCode(content) {
  const output = [];
  let fence = null;

  for (const line of String(content ?? '').split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      if (fence === null) {
        fence = { char: token[0], length: token.length };
      } else if (token[0] === fence.char && token.length >= fence.length) {
        fence = null;
      }
      output.push('');
      continue;
    }

    if (fence !== null) {
      output.push('');
      continue;
    }

    output.push(line.replace(/(`+)([^`\n]*?)\1/g, ''));
  }

  return output.join('\n');
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
