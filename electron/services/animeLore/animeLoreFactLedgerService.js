'use strict';
const { blocked } = require('./animeLoreConfig');
function validateLedger(canon, claims, options = {}) {
  const sourceIds = new Set((canon?.sources || []).map(x => x.sourceId));
  const accepted = new Map((canon?.facts || []).map(x => [x.id,x]));
  if (!(claims instanceof Array) || !claims.length) throw blocked('needs_fact_review','No grounded claims in script.');
  for (const c of claims) {
    const fact = accepted.get(c.id);
    if (!fact || !sourceIds.has(fact.sourceId) || fact.status !== 'USER_ATTESTED')
      throw blocked('needs_fact_review','Claim has no permissible canonical source.',{claim:c});
    if (c.text && !fact.text) throw blocked('needs_fact_review','Claim is missing evidence.',{claim:c});
  }
  if (options.requireIndependentVerification && canon.sources.some(s=>!s.independentlyVerified))
    throw blocked('needs_fact_review','Independent canon verification is needed.');
  return {schemaVersion:1,claims:claims.map(c=>({...accepted.get(c.id),status:'SOURCE_LINKED_UNVERIFIED'})),
    verificationLevel:'user_attested_only',requiresHumanFactReview:true};
}
function validateClaimIds(segments,ledger) {
  const set = new Set(ledger.claims.map(c=>c.id));
  if (!Array.isArray(segments) || !segments.length) throw blocked('needs_fact_review','Empty narration.');
  for (const s of segments) {
    if (!Array.isArray(s.claimIds) || !s.claimIds.length || s.claimIds.some(id=>!set.has(id)))
      throw blocked('needs_fact_review','Every narration beat must cite a sourced claim.',{segment:s});
  }
  return true;
}
module.exports = {validateLedger,validateClaimIds};