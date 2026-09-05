// Extract exactly one top-level JSON object. Formatting is scored separately
// from semantic correctness; prose and Markdown do not hide a correct finding.
export function answerObject(text) {
  const objects = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (start < 0) {
      if (char === '{') { start = i; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { objects.push(JSON.parse(text.slice(start, i + 1))); } catch { /* A prose/code brace block is not a JSON answer. */ }
      start = -1;
    }
  }
  return start < 0 && objects.length === 1 ? objects[0] : null;
}
