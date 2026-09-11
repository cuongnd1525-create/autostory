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
  result.properties.issues.maxItems = 12;
  result.properties.previewSubtitleIssues.maxItems = 12;
  result.properties.patch.properties.order.maxItems = 80;
  result.properties.patch.properties.changedSegments.maxItems = 40;
  return result;
}
function apply(value, original) {
  const p = value.patch;
  if (!p || !Array.isArray(p.order) || !Array.isArray(p.changedSegments)) throw new Error('Review requires a patch.');
  const segments = new Map(original.segments.map(s => [s.id, s]));
  const changed = new Set();
  for (const s of p.changedSegments) {
    if (!s.id || changed.has(s.id) || !p.order.includes(s.id)) throw new Error('Invalid changed segment ID.');
    changed.add(s.id); segments.set(s.id, s);
  }
  if (!p.order.length || new Set(p.order).size !== p.order.length || p.order.some(id => !segments.has(id))) throw new Error('Invalid review order.');
  if (value.verdict === 'PASS' && (changed.size || JSON.stringify(p.order) !== JSON.stringify(original.segments.map(s => s.id)))) throw new Error('PASS must preserve the script.');
  return { ...value, revisedScript: { ...original, segments: p.order.map(id => segments.get(id)),
    hookAudit: p.hookAudit || original.hookAudit, openingAudit: p.openingAudit || original.openingAudit } };
}
module.exports = { schema, apply };
