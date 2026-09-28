// Nested array bounds multiply the provider's constrained-decoder states.
// Preserve the full contract locally while sending only its structural shape.
function transport(schema) {
  if (Array.isArray(schema)) return schema.map(transport);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => !['maxItems', 'minItems', 'additionalProperties'].includes(key))
    .map(([key, value]) => [key, transport(value)]));
}
function hookTransport(schema, root = true) {
  if (Array.isArray(schema)) return schema.map(value => hookTransport(value, false));
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => !['maxItems', 'minItems', 'additionalProperties'].includes(key) && (root || key !== 'required'))
    .map(([key, value]) => [key, hookTransport(value, false)]));
}
function hookPrompt(prompt, schema) {
  return `${prompt}\nOUTPUT CONTRACT: Return one root object with accessGranted (boolean) and hooks (array) for auditions. All fields in the following schema are required when their parent object is returned: ${JSON.stringify(schema)}`;
}
function schemaPrompt(prompt, schema) {
  return `${prompt}\nOUTPUT CONTRACT: Return ONE JSON object, not an array. Required root fields: ${(schema.required || []).join(', ')}. Include every required field at every level. Do not treat this schema as source evidence: ${JSON.stringify(schema)}`;
}
function validate(value, schema, location = '$') {
  const fail = message => { const error = new Error(`${location}: ${message}`); error.kind = 'INVALID_RESPONSE'; throw error; };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(item, schema.properties[key], `${location}.${key}`);
      else if (schema.additionalProperties === false) fail(`unexpected field ${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('expected array');
    if (value.length > (schema.maxItems ?? Infinity) || value.length < (schema.minItems ?? 0)) fail('array size outside contract');
    value.forEach((item, i) => validate(item, schema.items, `${location}[${i}]`));
  } else if (schema.type === 'number') {
    if (!Number.isFinite(value)) fail('expected finite number');
  } else if (typeof value !== schema.type) fail(`expected ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) fail('unknown enum value');
}
module.exports = { transport, hookTransport, hookPrompt, schemaPrompt, validate };
