'use strict';
const {blocked}=require('./animeLoreConfig');
function repairVisualEdits(timeline,review,media) {
 const assetMap=new Map(media.assets.map(a=>[a.assetId,a]));
 const issues=(review.issues||[]).filter(i=>['visual','visual_grounding','wrong_character','framing'].includes(i.category)
   && ['critical','error','warning'].includes(i.severity));
 if(!issues.length) return {patched:false,timeline,reason:'No locally repairable visual issues'};
 const shots=timeline.shots.map(s=>({...s}));let patched=0;
 for(const issue of issues) {
  const shot=shots.find(s=>issue.timeSec>=s.outputStartSec && issue.timeSec<s.outputEndSec);
  if(!shot || !Array.isArray(shot.alternatives))continue;
  const targetDuration=shot.outputEndSec-shot.outputStartSec;
  const candidate=shot.alternatives.map(id=>assetMap.get(id)).find(a=>
   a && a.licenseStatus!=='restricted' && a.licenseStatus!=='unknown'
   && (a.mediaType==='image'||a.endSec-a.startSec>=targetDuration));
  if(!candidate)continue;
  shot.assetId=candidate.assetId;shot.path=candidate.path;shot.mediaType=candidate.mediaType;
  shot.sourceStartSec=candidate.mediaType==='video'?candidate.startSec:0;
  shot.sourceEndSec=candidate.mediaType==='video'?candidate.startSec+targetDuration:0;
  shot.alternatives=shot.alternatives.filter(id=>id!==candidate.assetId);
  shot.reason='AI-flagged visual mismatch, substituted next eligible user-tagged asset';
  patched++;
 }
 if(!patched)return {patched:false,timeline,reason:'No rights-cleared alternative with adequate duration'};
 return {patched:true,patchCount:patched,timeline:{...timeline,shots},reason:'Changed '+patched+' issue-located shots'};
}
module.exports={repairVisualEdits};