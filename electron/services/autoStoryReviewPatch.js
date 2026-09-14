function schema(full) {
  const result = structuredClone(full);
  const script = result.properties.revisedScript;
  delete result.properties.revisedScript;
  result.required = result.required.filter(k => k !== 'revisedScript');
  result.properties.patch = { type: 'object', required: ['order', 'changedSegments'], properties: {
    order: { type: 'array', items: { type: 'string' } },
    changedSegments: script.properties.segments,
    hookAudit: script.properties.hookAudit,
    openingAudit: script.properties.openingAudit
  } };
  result.required.push('patch');
  // Enforce array limits locally: these bounds cause Vertex's constrained decoder
  // to reject this nested schema before generation (HTTP 400, too many states).
  return result;
}
function apply(value, original) {
  const p = value.patch;
  if (!p || !Array.isArray(p.order) || !Array.isArray(p.changedSegments)) throw new Error('Review requires a patch.');
  if (p.order.length > 80 || p.changedSegments.length > 40
    || (value.issues?.length || 0) > 12 || (value.previewSubtitleIssues?.length || 0) > 12) {
    throw new Error('Review patch exceeds local array limits: order 80, changes 40, issues 12.');
  }
  const segments = new Map(original.segments.map(s => [s.id, s]));
  const changed = new Set();
  for (const s of p.changedSegments) {
    if (!s.id || changed.has(s.id) || !p.order.includes(s.id)) throw new Error('Invalid changed segment ID.');
    changed.add(s.id); segments.set(s.id, s);
  }
  if (!p.order.length || new Set(p.order).size !== p.order.length || p.order.some(id => !segments.has(id))) throw new Error('Invalid review order.');
  // Providers may return PASS with a correction patch. Apply it as a
  // revision so it is validated instead of silently discarded.
  if (value.verdict === 'PASS' && (changed.size || JSON.stringify(p.order) !== JSON.stringify(original.segments.map(s => s.id)))) {
    value = { ...value, verdict: 'MINOR_REVISE' };
  }
  return { ...value, revisedScript: { ...original, segments: p.order.map(id => segments.get(id)),
    hookAudit: p.hookAudit || original.hookAudit, openingAudit: p.openingAudit || original.openingAudit } };
}
module.exports = { schema, apply };
