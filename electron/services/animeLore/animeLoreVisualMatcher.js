'use strict';
const {blocked}=require('./animeLoreConfig');
const tokens=s=>new Set(String(s||'').toLowerCase().match(/[a-z0-9]{3,}/g)||[]);
function overlap(a,b) {const x=tokens(a),y=tokens(b);let count=0;for(const t of x)if(y.has(t))count++;return count/Math.max(1,Math.min(x.size,y.size));}
function score(asset,segment,config) {
  const target=(segment.visualIntent||[]).join(' ')+' '+segment.text;
  const tags=[...(asset.tags||[]),asset.description||''].join(' ');
  const char=String(config.character||'').toLowerCase();
  if(char && asset.characters.length && !asset.characters.some(c=>c===char||c.includes(char)||char.includes(c)))return -Infinity;
  if(!asset.tags.length && !asset.characters.length && !asset.description)return -Infinity;
  const match=overlap(target,tags);
  const charMatch=char && asset.characters.some(c=>c===char||c.includes(char))?0.2:0;
  const matchScore=match*0.65+charMatch;
  return matchScore;
}
function match(config,voice,media) {
  const edits=[],missing=[];
  const uses=new Map();
  for(const segment of voice.segments) {
    const matches=media.assets.map(asset=>({asset,score:score(asset,segment,config)}))
      .filter(x=>Number.isFinite(x.score)&&x.score>=0.10)
      .sort((a,b)=>b.score-a.score);
    if(!matches.length){missing.push({segmentId:segment.id,visualIntent:segment.visualIntent,reason:'No source-confirmed visual match'});continue;}
    // Keep match explicit. A video candidate can contribute up to its actual duration.
    const best=matches[0].asset;
    const usable=best.mediaType==='image'?segment.durationSec:Math.max(0,Math.min(segment.durationSec,best.endSec-best.startSec));
    if(usable<0.4){missing.push({segmentId:segment.id,reason:'Matched video cannot cover narration'});continue;}
    const key=best.assetId;
    uses.set(key,(uses.get(key)||0)+1);
    edits.push({segmentId:segment.id,assetId:key,path:best.path,mediaType:best.mediaType,
      sourceStartSec:best.mediaType==='video'?best.startSec:0,sourceEndSec:best.mediaType==='video'?best.startSec+usable:0,
      outputStartSec:segment.offsetSec,outputEndSec:segment.offsetSec+segment.durationSec,
      matchScore:matches[0].score,reason:'Character/tag match from user media metadata',
      alternatives:matches.slice(1,4).map(x=>x.asset.assetId)});
  }
  if(missing.length)throw blocked('needs_assets','Missing evidence-matched visuals for one or more script clauses.',{missing});
  return {schemaVersion:1,edits,missing:[],reusedAssets:[...uses].filter(x=>x[1]>1).map(x=>x[0]),
    warning:'Matching uses asset metadata and token overlap, not multimodal semantic verification'};
}
module.exports={match,score,overlap};