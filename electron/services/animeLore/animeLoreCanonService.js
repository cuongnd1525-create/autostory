'use strict';
const { safe, blocked } = require('./animeLoreConfig');
// A canon source is one line: "anime | S2 E03 | A concrete fact"; any source
// with no locator or no concrete statement is unverified and never AI-promoted.
function parseCanon(text, medium = 'anime', spoilerThrough = '') {
  const entries = safe(text).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const order = ['anime','manga','light_novel'];
  const facts = []; const sources = []; const disputed = [];
  for (let i=0; i<entries.length; i++) {
    const parts = entries[i].split('|').map(x => x.trim());
    if (parts.length < 3) { disputed.push({line:i+1,reason:'Source location or medium missing',text:entries[i]}); continue; }
    const [kind,location,...rest] = parts;
    const claim = rest.join(' | ').trim();
    const normalized = kind.toLowerCase().replace(/\s+/g,'_');
    if (!order.includes(normalized) || !location || claim.length < 12) {
      disputed.push({line:i+1,reason:'Invalid medium, location or claim',text:entries[i]}); continue;
    }
    if (order.indexOf(normalized) > order.indexOf(medium)) {
      disputed.push({line:i+1,reason:'Source medium exceeds spoiler scope',text:entries[i]}); continue;
    }
    // The user asserts this source; not independently verified by a publisher.
    const id = 'claim_' + String(facts.length+1).padStart(3,'0');
    const sourceId = 'source_' + String(i+1).padStart(3,'0');
    sources.push({sourceId,medium:normalized,location,provenance:'user_supplied',independentlyVerified:false});
    facts.push({id,text:claim,medium:normalized,location,sourceId,spoilerScope:spoilerThrough,
      status:'USER_ATTESTED',independentlyVerified:false});
  }
  return {schemaVersion:1,scope:{medium,spoilerThrough},sources,facts,disputed};
}
function requireGroundedCanon(canon) {
  if (!canon || canon.facts.length < 1) throw blocked('needs_fact_review','Provide canon facts with explicit medium and episode/chapter references.',{example:'anime | S2 E03 | The canon-supported fact here'});
  if (canon.disputed.length) throw blocked('needs_fact_review','Canon has incomplete or out-of-scope sources.',{disputed:canon.disputed});
  return canon;
}
module.exports = {parseCanon,requireGroundedCanon};