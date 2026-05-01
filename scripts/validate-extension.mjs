#!/usr/bin/env node
// validate-extension.mjs - validates upstream extension.json plus AIFHub metadata
// Exit 0 = pass, 1 = fail

import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const UPSTREAM_SCHEMA_URL = 'https://raw.githubusercontent.com/lee-to/ai-factory/2.x/schemas/extension.schema.json';
const UPSTREAM_SCHEMA_FILE = './schemas/extension.schema.json';
const AIFHUB_METADATA_FILE = 'aifhub-extension.json';
const AIFHUB_METADATA_SCHEMA = './schemas/aifhub-extension.schema.json';

const EXTENSION_TOP_LEVEL_KEYS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'commands',
  'agents',
  'agentFiles',
  'injections',
  'skills',
  'replaces',
  'mcpServers'
]);

const AIFHUB_TOP_LEVEL_KEYS = new Set(['$schema', 'compat', 'sources']);
const SOURCE_METADATA_KEYS = new Set([
  'url',
  'version',
  'baselineVersion',
  'supportedRange',
  'lastSync',
  'optional',
  'requiresNode',
  'mode',
  'notes'
]);
const MCP_TEMPLATE_KEYS = new Set(['command', 'args', 'env']);

function log(level, message, details = {}) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  const detailStr = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console[level === 'DEBUG' ? 'error' : level.toLowerCase()](`[validate-extension] ${level} ${message}${detailStr}`);
}

function resolvePath(baseDir, relPath) {
  if (typeof relPath !== 'string' || !relPath) {
    throw new Error(`Expected non-empty relative path, got ${JSON.stringify(relPath)}`);
  }
  const p = relPath.replace(/^\.\//, '');
  const resolved = resolve(baseDir, p);
  // Prevent path traversal: resolved path must stay within baseDir.
  const normalizedBase = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (!resolved.startsWith(normalizedBase)) {
    throw new Error(`Path traversal detected: "${relPath}" resolves outside base directory`);
  }
  return resolved;
}

async function fileExists(absPath) {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath, label) {
  log('DEBUG', `Reading ${label}`, { path: filePath });
  try {
    const raw = await readFile(filePath, 'utf-8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    log('ERROR', `Failed to read or parse ${label}: ${err.message}`);
    return { ok: false, value: null };
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateUnknownKeys(value, allowedKeys, label) {
  let hasErrors = false;
  if (!isPlainObject(value)) {
    log('ERROR', `${label} must be an object`);
    return true;
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      log('ERROR', `Unknown field in ${label}`, { field: key });
      hasErrors = true;
    }
  }
  return hasErrors;
}

function resolveSchemaRef(rootSchema, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error(`Unsupported schema reference: ${ref}`);
  }

  const parts = ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current = rootSchema;
  for (const part of parts) {
    if (!isPlainObject(current) || !(part in current)) {
      throw new Error(`Unresolved schema reference: ${ref}`);
    }
    current = current[part];
  }
  return current;
}

function getJsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

function matchesSchemaType(value, expectedType) {
  if (expectedType === 'object') return isPlainObject(value);
  if (expectedType === 'array') return Array.isArray(value);
  return getJsonType(value) === expectedType;
}

function validateJsonAgainstSchema(value, schema, options = {}) {
  const rootSchema = options.rootSchema ?? schema;
  const path = options.path ?? '$';
  const errors = [];

  if (!isPlainObject(schema)) {
    errors.push({ path, message: 'schema node must be an object' });
    return errors;
  }

  if (schema.$ref) {
    let resolved;
    try {
      resolved = resolveSchemaRef(rootSchema, schema.$ref);
    } catch (err) {
      errors.push({ path, message: err.message });
      return errors;
    }
    return validateJsonAgainstSchema(value, resolved, { rootSchema, path });
  }

  if (Array.isArray(schema.oneOf)) {
    const results = schema.oneOf.map((candidate) => validateJsonAgainstSchema(value, candidate, { rootSchema, path }));
    const matches = results.filter((candidateErrors) => candidateErrors.length === 0);

    if (matches.length !== 1) {
      errors.push({ path, message: `expected exactly one oneOf schema to match, got ${matches.length}` });
    }
  }

  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expectedTypes.some((type) => matchesSchemaType(value, type))) {
      errors.push({
        path,
        message: `expected type ${expectedTypes.join('|')}, got ${getJsonType(value)}`
      });
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}` });
  }

  if (typeof value === 'string') {
    if (schema.pattern) {
      const pattern = new RegExp(schema.pattern);
      if (!pattern.test(value)) {
        errors.push({ path, message: `does not match pattern ${schema.pattern}` });
      }
    }

    if (schema.format === 'uri') {
      try {
        const parsed = new URL(value);
        if (!parsed.protocol) {
          errors.push({ path, message: 'must be a valid URI' });
        }
      } catch {
        errors.push({ path, message: 'must be a valid URI' });
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (const [index, item] of value.entries()) {
      errors.push(
        ...validateJsonAgainstSchema(item, schema.items, {
          rootSchema,
          path: `${path}[${index}]`
        })
      );
    }
  }

  const shouldValidateObject =
    isPlainObject(value) && (schema.properties || schema.required || schema.additionalProperties !== undefined);

  if (shouldValidateObject) {
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push({ path, message: `missing required property ${key}` });
      }
    }

    if (isPlainObject(schema.dependentRequired)) {
      for (const [key, dependentKeys] of Object.entries(schema.dependentRequired)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;

        for (const dependentKey of dependentKeys) {
          if (!Object.prototype.hasOwnProperty.call(value, dependentKey)) {
            errors.push({ path, message: `property ${dependentKey} is required when ${key} is present` });
          }
        }
      }
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(
          ...validateJsonAgainstSchema(value[key], propertySchema, {
            rootSchema,
            path: `${path}.${key}`
          })
        );
      }
    }

    const knownProperties = new Set(Object.keys(properties));
    for (const [key, propertyValue] of Object.entries(value)) {
      if (knownProperties.has(key)) continue;

      if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: 'additional property is not allowed' });
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(
          ...validateJsonAgainstSchema(propertyValue, schema.additionalProperties, {
            rootSchema,
            path: `${path}.${key}`
          })
        );
      }
    }
  }

  return errors;
}

async function validateExtensionManifest(manifest, repoRoot) {
  let hasErrors = validateUnknownKeys(manifest, EXTENSION_TOP_LEVEL_KEYS, 'extension.json');

  if (manifest.$schema !== UPSTREAM_SCHEMA_URL) {
    log('ERROR', 'extension.json must point at the upstream AI Factory manifest schema', {
      expected: UPSTREAM_SCHEMA_URL,
      actual: manifest.$schema
    });
    hasErrors = true;
  } else {
    log('INFO', 'extension.json schema OK', { schema: manifest.$schema });
  }

  if (!manifest.name || typeof manifest.name !== 'string') {
    log('ERROR', 'Missing or invalid required field: name');
    hasErrors = true;
  }

  log('DEBUG', 'Checking version field', { version: manifest.version });
  if (!manifest.version) {
    log('ERROR', 'Missing required field: version');
    hasErrors = true;
  } else {
    const semverRe = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;
    if (!semverRe.test(manifest.version)) {
      log('ERROR', `Invalid semver version: "${manifest.version}"`);
      hasErrors = true;
    } else {
      log('INFO', 'Version OK', { version: manifest.version });
    }
  }

  try {
    const schemaPath = resolvePath(repoRoot, UPSTREAM_SCHEMA_FILE);
    if (!(await fileExists(schemaPath))) {
      log('ERROR', 'Upstream extension schema file not found', { path: UPSTREAM_SCHEMA_FILE, resolved: schemaPath });
      hasErrors = true;
    } else {
      const schemaResult = await readJsonFile(schemaPath, UPSTREAM_SCHEMA_FILE);
      if (!schemaResult.ok) {
        hasErrors = true;
      } else {
        log('INFO', 'Upstream extension schema file OK', { schema: UPSTREAM_SCHEMA_FILE });
        const schemaErrors = validateJsonAgainstSchema(manifest, schemaResult.value);
        if (schemaErrors.length > 0) {
          for (const error of schemaErrors) {
            log('ERROR', 'extension.json upstream schema violation', error);
          }
          hasErrors = true;
        } else {
          log('INFO', 'extension.json matches upstream schema', { schema: UPSTREAM_SCHEMA_FILE });
        }
      }
    }
  } catch (err) {
    log('ERROR', `Upstream extension schema path invalid: ${err.message}`);
    hasErrors = true;
  }

  return hasErrors;
}

async function validateAifhubMetadata(metadata, repoRoot) {
  let hasErrors = validateUnknownKeys(metadata, AIFHUB_TOP_LEVEL_KEYS, AIFHUB_METADATA_FILE);

  if (metadata.$schema !== AIFHUB_METADATA_SCHEMA) {
    log('ERROR', `${AIFHUB_METADATA_FILE} must point at the local AIFHub metadata schema`, {
      expected: AIFHUB_METADATA_SCHEMA,
      actual: metadata.$schema
    });
    hasErrors = true;
  } else {
    try {
      const schemaPath = resolvePath(repoRoot, metadata.$schema);
      if (!(await fileExists(schemaPath))) {
        log('ERROR', 'AIFHub metadata schema file not found', { path: metadata.$schema, resolved: schemaPath });
        hasErrors = true;
      } else {
        const schemaResult = await readJsonFile(schemaPath, AIFHUB_METADATA_SCHEMA);
        if (!schemaResult.ok) {
          hasErrors = true;
        } else {
          log('INFO', 'AIFHub metadata schema file OK', { schema: metadata.$schema });
          const schemaErrors = validateJsonAgainstSchema(metadata, schemaResult.value);
          if (schemaErrors.length > 0) {
            for (const error of schemaErrors) {
              log('ERROR', 'AIFHub metadata schema violation', error);
            }
            hasErrors = true;
          } else {
            log('INFO', 'AIFHub metadata matches schema', { schema: metadata.$schema });
          }
        }
      }
    } catch (err) {
      log('ERROR', `AIFHub metadata schema path invalid: ${err.message}`);
      hasErrors = true;
    }
  }

  const compat = metadata.compat;
  log('DEBUG', 'Checking AIFHub compat field', { compat });
  if (!isPlainObject(compat) || typeof compat['ai-factory'] !== 'string' || !compat['ai-factory']) {
    log('ERROR', `Missing required field: ${AIFHUB_METADATA_FILE}.compat.ai-factory`);
    hasErrors = true;
  } else {
    log('INFO', 'compat.ai-factory OK', { compat: compat['ai-factory'] });
  }

  const sources = metadata.sources;
  if (!isPlainObject(sources)) {
    log('ERROR', `Missing required field: ${AIFHUB_METADATA_FILE}.sources`);
    return true;
  }

  if (!isPlainObject(sources['ai-factory'])) {
    log('ERROR', `Missing required field: ${AIFHUB_METADATA_FILE}.sources.ai-factory`);
    hasErrors = true;
  }

  for (const [sourceName, source] of Object.entries(sources)) {
    if (!isPlainObject(source)) {
      log('ERROR', 'Source metadata must be an object', { source: sourceName });
      hasErrors = true;
      continue;
    }

    for (const key of Object.keys(source)) {
      if (!SOURCE_METADATA_KEYS.has(key)) {
        log('ERROR', 'Unknown source metadata field', { source: sourceName, field: key });
        hasErrors = true;
      }
    }

    for (const requiredKey of ['url', 'version', 'lastSync']) {
      if (typeof source[requiredKey] !== 'string' || !source[requiredKey]) {
        log('ERROR', 'Missing required source metadata field', { source: sourceName, field: requiredKey });
        hasErrors = true;
      }
    }

    if (typeof source.url === 'string' && !/^https?:\/\//.test(source.url)) {
      log('ERROR', 'Source metadata URL must be http(s)', { source: sourceName, url: source.url });
      hasErrors = true;
    }

    if (typeof source.lastSync === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(source.lastSync)) {
      log('ERROR', 'Source metadata lastSync must use YYYY-MM-DD', { source: sourceName, lastSync: source.lastSync });
      hasErrors = true;
    }

    if ('optional' in source && typeof source.optional !== 'boolean') {
      log('ERROR', 'Source metadata optional must be boolean', { source: sourceName });
      hasErrors = true;
    }
  }

  return hasErrors;
}

async function validateManifestPaths(manifest, repoRoot) {
  let hasErrors = false;

  const commands = manifest.commands || [];
  log('DEBUG', `Checking ${commands.length} command(s)`);
  for (const command of commands) {
    let abs;
    try {
      abs = resolvePath(repoRoot, command.module);
    } catch (err) {
      log('ERROR', `Command module path traversal: ${err.message}`, { module: command.module });
      hasErrors = true;
      continue;
    }
    log('DEBUG', 'Checking command module', { module: command.module, resolved: abs });
    const exists = await fileExists(abs);
    if (!exists) {
      log('ERROR', 'Command module not found', { module: command.module, resolved: abs });
      hasErrors = true;
    }
  }
  log('INFO', 'Commands check complete', { total: commands.length });

  const skills = manifest.skills || [];
  log('DEBUG', `Checking ${skills.length} skill(s)`);
  for (const skillPath of skills) {
    let abs;
    try {
      abs = resolvePath(repoRoot, skillPath);
    } catch (err) {
      log('ERROR', `Skill path traversal: ${err.message}`, { path: skillPath });
      hasErrors = true;
      continue;
    }
    log('DEBUG', 'Checking skill path', { path: skillPath, resolved: abs });
    const exists = await fileExists(abs);
    if (!exists) {
      log('ERROR', 'Skill path not found', { path: skillPath, resolved: abs });
      hasErrors = true;
    }
  }
  log('INFO', 'Skills check complete', { total: skills.length });

  const agentFiles = manifest.agentFiles || [];
  log('DEBUG', `Checking ${agentFiles.length} agentFile(s)`);
  for (const af of agentFiles) {
    let srcAbs;
    try {
      srcAbs = resolvePath(repoRoot, af.source);
    } catch (err) {
      log('ERROR', `agentFile source traversal: ${err.message}`, { source: af.source });
      hasErrors = true;
      continue;
    }
    log('DEBUG', 'Checking agentFile source', { source: af.source, resolved: srcAbs });
    const srcExists = await fileExists(srcAbs);
    if (!srcExists) {
      log('ERROR', 'agentFile source not found', { source: af.source, resolved: srcAbs });
      hasErrors = true;
    }

    const target = af.target || '';
    const runtime = af.runtime || '';
    if (runtime === 'codex' && !target.endsWith('.toml')) {
      log('ERROR', 'Codex agentFile target must have .toml extension', { target });
      hasErrors = true;
    } else if (runtime === 'claude' && !target.endsWith('.md')) {
      log('ERROR', 'Claude agentFile target must have .md extension', { target });
      hasErrors = true;
    } else if (runtime !== 'codex' && runtime !== 'claude') {
      log('ERROR', 'Unknown agentFile runtime', { runtime });
      hasErrors = true;
    }
  }
  log('INFO', 'AgentFiles check complete', { total: agentFiles.length });

  const injections = manifest.injections || [];
  log('DEBUG', `Checking ${injections.length} injection(s)`);
  for (const inj of injections) {
    let abs;
    try {
      abs = resolvePath(repoRoot, inj.file);
    } catch (err) {
      log('ERROR', `Injection file traversal: ${err.message}`, { file: inj.file });
      hasErrors = true;
      continue;
    }
    log('DEBUG', 'Checking injection file', { file: inj.file, resolved: abs });
    const exists = await fileExists(abs);
    if (!exists) {
      log('ERROR', 'Injection file not found', { file: inj.file, resolved: abs });
      hasErrors = true;
    }
  }
  log('INFO', 'Injections check complete', { total: injections.length });

  const mcpServers = manifest.mcpServers || [];
  log('DEBUG', `Checking ${mcpServers.length} MCP server(s)`);
  for (const server of mcpServers) {
    if (!isPlainObject(server)) {
      log('ERROR', 'MCP server entry must be an object');
      hasErrors = true;
      continue;
    }

    const key = server.key;
    if (typeof key !== 'string' || !key) {
      log('ERROR', 'MCP server key must be a non-empty string', { key });
      hasErrors = true;
    }

    if ('instruction' in server && typeof server.instruction !== 'string') {
      log('ERROR', 'MCP server instruction must be a string when present', { key });
      hasErrors = true;
    }

    const template = server.template;
    if (typeof template === 'string') {
      let templateAbs;
      try {
        templateAbs = resolvePath(repoRoot, template);
      } catch (err) {
        log('ERROR', `MCP template path traversal: ${err.message}`, { key, template });
        hasErrors = true;
        continue;
      }

      const exists = await fileExists(templateAbs);
      if (!exists) {
        log('ERROR', 'MCP template file not found', { key, template, resolved: templateAbs });
        hasErrors = true;
        continue;
      }

      const templateResult = await readJsonFile(templateAbs, `MCP template ${key}`);
      if (!templateResult.ok) {
        hasErrors = true;
        continue;
      }
      hasErrors = validateMcpTemplate(templateResult.value, key) || hasErrors;
      continue;
    }

    hasErrors = validateMcpTemplate(template, key) || hasErrors;
  }
  log('INFO', 'MCP servers check complete', { total: mcpServers.length });

  return hasErrors;
}

function validateMcpTemplate(template, key) {
  let hasErrors = false;
  if (!isPlainObject(template)) {
    log('ERROR', 'MCP server template must be an object or relative JSON template path', { key });
    return true;
  }

  for (const templateKey of Object.keys(template)) {
    if (!MCP_TEMPLATE_KEYS.has(templateKey)) {
      log('ERROR', 'Unknown MCP server template field', {
        key,
        field: templateKey,
        allowed: [...MCP_TEMPLATE_KEYS]
      });
      hasErrors = true;
    }
  }

  if (typeof template.command !== 'string' || !template.command) {
    log('ERROR', 'MCP server template.command must be a non-empty string', { key });
    hasErrors = true;
  }

  if ('args' in template && (!Array.isArray(template.args) || template.args.some((arg) => typeof arg !== 'string'))) {
    log('ERROR', 'MCP server template.args must be an array of strings', { key });
    hasErrors = true;
  }

  const env = template.env;
  if (
    'env' in template &&
    (!isPlainObject(env) || Object.values(env).some((value) => typeof value !== 'string'))
  ) {
    log('ERROR', 'MCP server template.env must be an object with string values', { key });
    hasErrors = true;
  }

  return hasErrors;
}

async function validateExtension() {
  const repoRoot = process.cwd();
  const manifestPath = join(repoRoot, 'extension.json');
  const metadataPath = join(repoRoot, AIFHUB_METADATA_FILE);
  let hasErrors = false;

  const manifestResult = await readJsonFile(manifestPath, 'extension.json');
  if (!manifestResult.ok) return 1;
  const metadataResult = await readJsonFile(metadataPath, AIFHUB_METADATA_FILE);
  if (!metadataResult.ok) return 1;

  hasErrors = await validateExtensionManifest(manifestResult.value, repoRoot) || hasErrors;
  hasErrors = await validateAifhubMetadata(metadataResult.value, repoRoot) || hasErrors;
  hasErrors = await validateManifestPaths(manifestResult.value, repoRoot) || hasErrors;

  if (hasErrors) {
    log('ERROR', 'Validation FAILED');
    return 1;
  }

  log('INFO', 'All checks passed');
  return 0;
}

process.exit(await validateExtension());
