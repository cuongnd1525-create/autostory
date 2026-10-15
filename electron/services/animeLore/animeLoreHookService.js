'use strict';
const {blocked} = require('./animeLoreConfig');
function audition(hooks,ledger) {
  const ids = new Set(ledger.claims.map(c=>c.id));
  const valid = (hooks||[]).filter(h=>h.text && h.text.length>=15
    && Array.isArray(h.payoffClaimIds) && h.payoffClaimIds.length
    && h.payoffClaimIds.every(id=>ids.has(id))
    && Array.isArray(h.visualIntent) && h.visualIntent.length);
  if (valid.length<3) throw blocked('needs_fact_review','The AI failed to provide three distinct grounded hooks.');
  const unique = [...new Map(valid.map(h=>[h.text.toLowerCase().replace(/\W/g,''),h])).values()];
  if(unique.length<3) throw blocked('needs_fact_review','Hook variants repeat the same assertion.');
  const ranked = unique.map((h,i)=>({...h,internalScore:Math.max(0,Math.min(100,Number(h.score)||55)) - (/\b(always|never|impossible|no one)\b/i.test(h.text)?10:0),index:i}))
    .sort((a,b)=>b.internalScore-a.internalScore);
  return {schemaVersion:1,candidates:ranked,selected:ranked[0],selectionMethod:'heuristic; not a viral probability'};
}
module.exports={audition};