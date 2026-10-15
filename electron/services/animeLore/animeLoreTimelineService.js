'use strict';
const {blocked}=require('./animeLoreConfig');
function create(config,voice,matched,media) {
  const byId=new Map(media.assets.map(a=>[a.assetId,a]));
  const segs=new Map(voice.segments.map(a=>[a.id,a]));
  const shots=matched.edits.map((edit,i)=>{
    const asset=byId.get(edit.assetId),narration=segs.get(edit.segmentId);
    if(!asset || !narration || edit.outputEndSec<=edit.outputStartSec)
      throw blocked('needs_assets','Invalid edit segment, duration, or media reference.',{index:i});
    return {...edit,id:'shot_'+String(i+1).padStart(4,'0'),claimIds:narration.claimIds,
      text:narration.text,visualIntent:narration.visualIntent};
  }).sort((a,b)=>a.outputStartSec-b.outputStartSec);
  if(!shots.length)throw blocked('needs_assets','No shots available.');
  let cursor=0;
  for(const shot of shots){
    if(Math.abs(shot.outputStartSec-cursor)>0.10) throw blocked('needs_assets','Timeline contains uncovered narration.',{expected:cursor,got:shot.outputStartSec});
    cursor=shot.outputEndSec;
  }
  if(Math.abs(cursor-voice.durationSec)>0.2)throw blocked('needs_assets','Timeline does not match measured voice duration.');
  return {schemaVersion:1,canvas:{width:config.width,height:config.height,fps:config.fps},
    durationSec:voice.durationSec,shots,voiceSegments:voice.segments,captionSafeMarginBottom:410,
    editWarnings:matched.reusedAssets.length?['Media source reused: '+matched.reusedAssets.join(', ')]:[]};
}
module.exports={create};