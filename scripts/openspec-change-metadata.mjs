// openspec-change-metadata.mjs - bounded readers for OpenSpec per-change metadata
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const OPENSPEC_CHANGE_METADATA_FILE = '.openspec.yaml';

export async function readOpenSpecSkipSpecsMarker(changeDir, options = {}) {
  const metadataPath = path.join(changeDir, OPENSPEC_CHANGE_METADATA_FILE);
  const read = options.readFile ?? readFile;
  let raw;

  try {
    raw = await read(metadataPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return createMarker({ metadataPath, exists: false });
    }

    return createMarker({
      metadataPath,
      exists: true,
      mentioned: true,
      valid: false,
      invalidReason: `Unable to read ${OPENSPEC_CHANGE_METADATA_FILE}.`
    });
  }

  const normalized = String(raw ?? '').replace(/^\uFEFF/, '');
  const jsonMarker = parseJsonContainer(normalized, metadataPath);
  if (jsonMarker !== null) {
    return jsonMarker;
  }

  const declarations = [];
  for (const rawLine of normalized.split(/\r?\n/)) {
    const match = rawLine.match(/^(?:skip_specs|(['"])skip_specs\1)\s*:\s*(.*?)\s*$/);
    if (match) {
      declarations.push(stripInlineComment(match[2]).trim());
    }
  }

  if (declarations.length === 0) {
    return createMarker({ metadataPath, exists: true });
  }

  if (declarations.length !== 1) {
    return createMarker({
      metadataPath,
      exists: true,
      mentioned: true,
      valid: false,
      invalidReason: 'skip_specs must be declared exactly once.'
    });
  }

  return markerFromValue(declarations[0], metadataPath, { allowStringBoolean: true });
}

function parseJsonContainer(raw, metadataPath) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      return createMarker({ metadataPath, exists: true });
    }
    if (!Object.hasOwn(parsed, 'skip_specs')) {
      return createMarker({ metadataPath, exists: true });
    }
    return markerFromValue(parsed.skip_specs, metadataPath);
  } catch {
    return /["']?skip_specs["']?\s*:/.test(trimmed)
      ? createMarker({
        metadataPath,
        exists: true,
        mentioned: true,
        valid: false,
        invalidReason: `${OPENSPEC_CHANGE_METADATA_FILE} is not valid JSON/YAML metadata.`
      })
      : null;
  }
}

function markerFromValue(value, metadataPath, options = {}) {
  if (value === true || (options.allowStringBoolean && value === 'true')) {
    return createMarker({
      metadataPath,
      exists: true,
      mentioned: true,
      declared: true
    });
  }

  if (value === false || (options.allowStringBoolean && value === 'false')) {
    return createMarker({
      metadataPath,
      exists: true,
      mentioned: true
    });
  }

  return createMarker({
    metadataPath,
    exists: true,
    mentioned: true,
    valid: false,
    invalidReason: 'skip_specs must be the boolean true or false.'
  });
}

function createMarker({
  metadataPath,
  exists,
  mentioned = false,
  declared = false,
  valid = true,
  invalidReason = null
}) {
  return {
    metadataPath,
    exists,
    mentioned,
    declared,
    valid,
    invalidReason
  };
}

function stripInlineComment(value) {
  let quote = null;
  const text = String(value ?? '');

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ((char === '"' || char === "'") && (index === 0 || text[index - 1] !== '\\')) {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === '#' && quote === null) {
      return text.slice(0, index);
    }
  }

  return text;
}
