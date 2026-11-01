// Executable JSON-Schema subset validator shared by extension metadata checks
// and runner-metrics parity gates. Supports the keywords the repository
// schemas actually use: $ref, oneOf, type, const, enum, pattern, format,
// items, properties/required/additionalProperties, dependentRequired, and the
// numeric/string/array bounds minimum, maximum, minLength, maxLength,
// minItems and maxItems that keep the schema↔runtime parity gate two-sided.
// Anything outside this subset is ignored, so callers must not treat a clean
// result as full draft-2020-12 compliance.

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
  // JSON-Schema `integer` also accepts JSON numbers without a fraction part.
  if (expectedType === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return getJsonType(value) === expectedType;
}

function matchesConst(value, expected) {
  // Schema const values in this repository are JSON primitives; a normalized
  // JSON comparison keeps the check faithful for those shapes.
  return JSON.stringify(value) === JSON.stringify(expected);
}

export function validateJsonAgainstSchema(value, schema, options = {}) {
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

  if (schema.const !== undefined && !matchesConst(value, schema.const)) {
    errors.push({ path, message: `expected const ${JSON.stringify(schema.const)}` });
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

    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `expected at least ${schema.minLength} characters` });
    }

    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `expected at most ${schema.maxLength} characters` });
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

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `expected at least ${schema.minimum}` });
    }

    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `expected at most ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `expected at least ${schema.minItems} items` });
    }

    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `expected at most ${schema.maxItems} items` });
    }

    if (schema.items) {
      for (const [index, item] of value.entries()) {
        errors.push(
          ...validateJsonAgainstSchema(item, schema.items, {
            rootSchema,
            path: `${path}[${index}]`
          })
        );
      }
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
