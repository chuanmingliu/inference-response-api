// Deliberately bounded JSON Schema subset shared by admission and output checks.
// Runtime constrained decoding remains mandatory for strict generation.
export class ResponseError extends Error {
  constructor(status, message, code = 'invalid_request_error', param = null) {
    super(message);
    this.name = 'ResponseError';
    this.status = status;
    this.code = code;
    this.param = param;
    this.type = status >= 500 ? 'server_error' : 'invalid_request_error';
  }
}

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'title', 'description']);
const own = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, path) => { throw new ResponseError(400, message, 'invalid_json_schema', path); };

function jsonSize(value, path) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined || Buffer.byteLength(text) > 65_536) fail('Schema must be JSON and at most 65536 bytes.', path);
  } catch (error) {
    if (error instanceof ResponseError) throw error;
    fail('Schema must be serializable JSON without cycles.', path);
  }
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'object') return record(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function equalJson(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equalJson(value, b[index]));
  if (record(a) && record(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => own(b, key) && equalJson(a[key], b[key]));
  }
  return false;
}

/** Validate the declared subset and return an independent schema copy. */
export function validateSchema(schema, { strict = false, param = 'schema' } = {}) {
  jsonSize(schema, param);
  let nodes = 0;
  function visit(node, path, depth) {
    if (!record(node)) fail('Schema nodes must be objects; boolean schemas are unsupported.', path);
    if (++nodes > 1000 || depth > 20) fail('Schema exceeds the 1000-node or 20-level limit.', path);
    for (const key of Object.keys(node)) if (!KEYWORDS.has(key)) fail(`Unsupported JSON Schema keyword: ${key}.`, `${path}.${key}`);
    for (const key of ['title', 'description']) if (own(node, key) && typeof node[key] !== 'string') fail(`${key} must be a string.`, `${path}.${key}`);
    let types = [];
    if (own(node, 'type')) {
      types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.length || types.some((type) => !TYPES.has(type)) || new Set(types).size !== types.length) fail('Invalid or duplicate schema type.', `${path}.type`);
      if (types.length > 1 && (types.length !== 2 || !types.includes('null'))) fail('Only nullable type unions are supported; use anyOf for other unions.', `${path}.type`);
    } else if (!own(node, 'anyOf')) {
      fail('A schema node requires type or anyOf.', path);
    }
    if (own(node, 'anyOf')) {
      if (!Array.isArray(node.anyOf) || !node.anyOf.length || node.anyOf.length > 32) fail('anyOf must contain 1 to 32 schemas.', `${path}.anyOf`);
      node.anyOf.forEach((entry, index) => visit(entry, `${path}.anyOf[${index}]`, depth + 1));
    }
    if (own(node, 'properties') && (!types.includes('object') || !record(node.properties))) fail('properties requires an object type and an object value.', `${path}.properties`);
    if (own(node, 'required') && (!types.includes('object') || !Array.isArray(node.required) || node.required.some((key) => typeof key !== 'string') || new Set(node.required).size !== node.required.length)) fail('required must be a unique string array on an object schema.', `${path}.required`);
    if (own(node, 'additionalProperties') && (!types.includes('object') || typeof node.additionalProperties !== 'boolean')) fail('Only boolean additionalProperties on object schemas is supported.', `${path}.additionalProperties`);
    if (types.includes('object')) {
      const properties = node.properties ?? {};
      for (const key of node.required ?? []) if (!own(properties, key)) fail('Every required name must be declared in properties.', `${path}.required`);
      if (strict && node.additionalProperties !== false) fail('Strict object schemas require additionalProperties:false.', `${path}.additionalProperties`);
      if (strict && Object.keys(properties).some((key) => !(node.required ?? []).includes(key))) fail('Strict object schemas require every property to be required.', `${path}.required`);
      for (const [key, property] of Object.entries(properties)) visit(property, `${path}.properties.${key}`, depth + 1);
    }
    if (own(node, 'items') && !types.includes('array')) fail('items requires an array type.', `${path}.items`);
    if (types.includes('array') && !own(node, 'items')) fail('Array schemas require items.', `${path}.items`);
    if (own(node, 'items')) visit(node.items, `${path}.items`, depth + 1);
    if (own(node, 'enum')) {
      if (!Array.isArray(node.enum) || !node.enum.length || node.enum.length > 500) fail('enum must contain 1 to 500 values.', `${path}.enum`);
      if (types.length && node.enum.some((entry) => !types.some((type) => matchesType(entry, type)))) fail('enum values must match the declared type.', `${path}.enum`);
      if (node.enum.some((entry, index) => node.enum.slice(0, index).some((previous) => equalJson(entry, previous)))) fail('enum values must be unique.', `${path}.enum`);
    }
    if (own(node, 'const') && types.length && !types.some((type) => matchesType(node.const, type))) fail('const must match the declared type.', `${path}.const`);
  }
  visit(schema, param, 0);
  if (strict && schema.type !== 'object') fail('Strict schemas require an object at the root.', `${param}.type`);
  return structuredClone(schema);
}

/** Try the documented omitted-strict normalization without mutating callers. */
export function normalizeStrictSchema(schema, { param = 'schema' } = {}) {
  const normalized = validateSchema(schema, { param });
  function normalize(node) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes('object')) {
      if (node.additionalProperties === true) fail('An open object cannot be normalized to strict without changing its explicit contract.', `${param}.additionalProperties`);
      node.properties ??= {};
      node.additionalProperties = false;
      node.required = Object.keys(node.properties);
      Object.values(node.properties).forEach(normalize);
    }
    if (node.items) normalize(node.items);
    node.anyOf?.forEach(normalize);
  }
  normalize(normalized);
  return validateSchema(normalized, { strict: true, param });
}

/** Defense-in-depth only: this is not a substitute for constrained decoding. */
export function validateValue(value, schema, { param = 'value' } = {}) {
  validateSchema(schema);
  function problem(data, node, path) {
    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    if (types.length && !types.some((type) => matchesType(data, type))) return `${path} does not match the schema type.`;
    if (node.anyOf && !node.anyOf.some((branch) => problem(data, branch, path) === null)) return `${path} does not match any allowed schema.`;
    if (node.enum && !node.enum.some((entry) => equalJson(data, entry))) return `${path} is not an allowed enum value.`;
    if (own(node, 'const') && !equalJson(data, node.const)) return `${path} does not match const.`;
    if (record(data)) {
      for (const key of node.required ?? []) if (!own(data, key)) return `${path}.${key} is required.`;
      for (const [key, entry] of Object.entries(data)) {
        if (own(node.properties ?? {}, key)) {
          const error = problem(entry, node.properties[key], `${path}.${key}`);
          if (error) return error;
        } else if (node.additionalProperties === false) return `${path}.${key} is not allowed.`;
      }
    }
    if (Array.isArray(data) && node.items) {
      for (let index = 0; index < data.length; index += 1) {
        const error = problem(data[index], node.items, `${path}[${index}]`);
        if (error) return error;
      }
    }
    return null;
  }
  const error = problem(value, schema, param);
  if (error) throw new ResponseError(400, error, 'invalid_schema_value', param);
  return value;
}
