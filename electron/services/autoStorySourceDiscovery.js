const { schemas } = require('./autoStorySourceContracts');
const gates = require('./autoStorySourceGates');
const { range } = require('./autoStoryTimelineCompiler');
const { StoryError } = require('./autoStoryRepairRouter');
function partition(candidates, duration, mediaIndex) {
  const ranked = [], rejected = [], seen = new Set();
  candidates.forEach((candidate, index) => {
    try {
      const item = gates.rank([candidate], mediaIndex, duration)[0];
      if (seen.has(item.candidateId)) throw new StoryError('INVALID_RESPONSE', 'Duplicate candidate.');
      seen.add(item.candidateId); ranked.push(item);
    } catch (error) {
      rejected.push({ ...candidate, candidateIndex:index, rejection:error.message, rejectionKind:error.kind });
    }
  });
  ranked.sort((a,b) => b.viralScore-a.viralScore);
  return { ranked, rejected };
}
async function resolve(engine, result, overview, mediaIndex) {
  const candidates = structuredClone(result.candidates);
  const first = partition(candidates, engine.duration, mediaIndex);
  const invalid = first.rejected.filter(c => c.rejectionKind === 'LOCAL_EDITORIAL'
    && candidates.filter(other => other.title === c.title).length === 1);
  let repairError = '', corrections = [];
  if (invalid.length) {
    engine.onProgress?.({stage:'discovery_ranges',message:`${first.ranked.length}/${candidates.length} ứng viên có mốc nguồn hợp lệ; đang xác minh riêng ${invalid.length} khoảng sai.`});
    try {
      const fixed = await engine.ask('v2-discovery_ranges', {
        sourceDurationSec:engine.duration,
        candidates:invalid.map(c => ({title:c.title,sourceStartSec:c.sourceStartSec,sourceEndSec:c.sourceEndSec,trigger:c.trigger,reason:c.reason,error:c.rejection}))
      }, schemas.discoveryRanges,
      'Reinspect the attached source ONLY to verify the listed candidate windows. Return only their exact original titles and corrected SOURCE-second ranges, preserving the actual event and aftermath. Seconds are numeric elapsed video time, NOT HHMMSS/MMSS digits or a bodycam wall clock: 13:33 means 813 seconds, never 1333. This example is NOT evidence for any candidate. Read the SOURCE overlay and verify the action/audio. Never mechanically convert, clamp, rescale, invent events, or change the candidate story. Require 0 <= sourceStartSec < sourceEndSec <= sourceDurationSec. Cite an observed action/quote in evidence. If an event cannot be located, return verified=false with a reason; do not guess. No new candidates.', overview,
      value => {
        gates.access(value);
        const seen = new Set();
        for (const c of value.corrections) {
          if (!invalid.some(i=>i.title===c.title) || seen.has(c.title) || !c.evidence.trim()) throw new StoryError('INVALID_RESPONSE','Correction does not identify a unique requested candidate with evidence.');
          seen.add(c.title);
          if (c.verified) range(c, mediaIndex, engine.duration);
        }
      });
      corrections = fixed.corrections;
      for (const c of corrections.filter(c=>c.verified)) {
        const index = invalid.find(i=>i.title===c.title).candidateIndex;
        candidates[index] = {...candidates[index],sourceStartSec:c.sourceStartSec,sourceEndSec:c.sourceEndSec};
      }
    } catch (error) {
      if (engine.signal?.aborted) throw error;
      if (require('./autoStoryProviderErrors').isRateLimit(error)) throw error;
      repairError = error.message;
      engine.onProgress?.({stage:'discovery_ranges',message:`Chưa xác minh được khoảng sai: ${repairError}. Giữ các ứng viên hợp lệ.`});
    }
  }
  const final = partition(candidates, engine.duration, mediaIndex);
  for (const r of final.rejected) engine.onProgress?.({stage:'discovery_ranges',message:`Không sử dụng ứng viên "${r.title}": ${r.rejection}`});
  return {...final, originalRejected:first.rejected, corrections, repairError};
}
module.exports = {partition,resolve};
