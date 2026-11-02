// Vertex's constrained decoder can reject a nested schema with array bounds,
// even when that same schema is valid JSON Schema. Keep bounds in the local
// contract and describe them to the model without compiling them into a grammar.
function vertexTransport(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const result = { ...schema };
  if (schema.type === "array") {
    const limits = [];
    if (schema.minItems !== undefined) limits.push(`at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined) limits.push(`at most ${schema.maxItems} items`);
    delete result.minItems; delete result.maxItems;
    if (limits.length) result.description = [schema.description, `Return ${limits.join(" and ")}. Validated by the application.`].filter(Boolean).join(" ");
  }
  if (schema.properties) result.properties = Object.fromEntries(Object.entries(schema.properties)
    .map(([key, child]) => [key, vertexTransport(child)]));
  if (schema.items) result.items = vertexTransport(schema.items);
  if (schema.anyOf) result.anyOf = schema.anyOf.map(vertexTransport);
  return result;
}

module.exports = { vertexTransport };
