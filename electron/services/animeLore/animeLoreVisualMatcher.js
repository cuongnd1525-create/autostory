'use strict';
const {blocked}=require('./animeLoreConfig');
const tokens=s=>new Set(String(s||'').toLowerCase().match(/[a-z0-9]{3,}/g)||[]);
function overlap(a,b){const x=tokens(a),y=tokens(b);let count=0;for(const t of x)if(y.has(t))count++;return count/Math.max(1,Math.min(x.size,y.size));}
function score(asset,segment,config){
 if(!['user_confirmed','licensed','owned','public_domain'].includes(asset.licenseStatus))return -Infinity;
 const char=String(config.character||'').toLowerCase();
 if(char && asset.characters.length && !asset.characters.some(c=>c===char||c.includes(char)||char.includes(c)))return -Infinity;
 const tags=[...(asset.tags||[]),asset.description||''].join(' ');
 if(!tags && !asset.characters.length)return -Infinity;
 const intent=(segment.visualIntent||[]).join(' ');
 const match=overlap(intent,tags),support=overlap(segment.text,tags);
 const charMatch=char && asset.characters.some(c=>c===char||c.includes(char))?0.25:0;
 return match*0.60+support*0.15+charMatch;
}
function match(config,voice,media){
 const edits=[],missing=[],uses=new Map();let sequence=0;
 for(const segment of voice.segments){
  const ranked=media.assets.map(asset=>({asset,score:score(asset,segment,config)}))
   .filter(x=>Number.isFinite(x.score) && x.score>=0.12)
   .sort((a,b)=>b.score-a.score);
  if(!ranked.length){missing.push({segmentId:segment.id,visualIntent:segment.visualIntent,reason:'No sufficiently relevant rights-cleared visuals'});continue;}
  // Per-shot EDL, not one frozen shot spanning an entire 15-20s narration beat.
  let cursor=0,iterations=0;
  while(cursor<segment.durationSec-0.04 && iterations<120){
   const available=ranked.filter(x=>x.asset.mediaType==='image' || x.asset.endSec-x.asset.startSec>=0.5);
   if(!available.length)break;
   available.sort((a,b)=>(b.score-0.03*(uses.get(b.asset.assetId)||0))-(a.score-0.03*(uses.get(a.asset.assetId)||0)));
   const candidate=available[0],asset=candidate.asset;
   const remainder=segment.durationSec-cursor;
   // Keep edits readable, avoiding the compulsory 2s copyright-evasion rule.
   const desired=Math.min(remainder,2.2+(sequence%3)*0.3);
   const mediaDuration=asset.mediaType==='image'?desired:Math.max(0,asset.endSec-asset.startSec);
   const duration=Math.min(desired,mediaDuration);
   if(duration<0.4)break;
   const count=uses.get(asset.assetId)||0;uses.set(asset.assetId,count+1);
   const start=asset.mediaType==='image'?0:Math.min(asset.endSec-duration,asset.startSec+((count*2.3)%Math.max(0.001,mediaDuration-duration+0.001)));
   edits.push({segmentId:segment.id,assetId:asset.assetId,path:asset.path,mediaType:asset.mediaType,
    sourceStartSec:start,sourceEndSec:asset.mediaType==='image'?0:start+duration,
    outputStartSec:segment.offsetSec+cursor,outputEndSec:segment.offsetSec+cursor+duration,
    matchScore:candidate.score,reason:'User-tagged character/action/visual intent match',
    alternatives:ranked.slice(1,4).map(x=>x.asset.assetId)});
   cursor+=duration;sequence++;iterations++;
  }
  if(Math.abs(cursor-segment.durationSec)>0.1)
    missing.push({segmentId:segment.id,requiredSec:segment.durationSec,coveredSec:cursor,reason:'Insufficient tagged footage'});
  else if(edits.length){edits[edits.length-1].outputEndSec=segment.offsetSec+segment.durationSec;}
 }
 if(missing.length)throw blocked('needs_assets','Missing grounded visuals for some narration.',{missing});
 return {schemaVersion:2,edits,missing:[],reusedAssets:[...uses].filter(x=>x[1]>1).map(x=>x[0]),
  warning:'Automatic matching is metadata-based. Multimodal visual review is mandatory; it must never be treated as verified semantic truth.'};
}
module.exports={match,score,overlap};