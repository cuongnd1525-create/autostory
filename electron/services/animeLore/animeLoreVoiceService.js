'use strict';
const fs=require('fs/promises');
const path=require('path');
const {spawn}=require('child_process');
const ElevenLabsService=require('../elevenLabsService');
const EdgeTtsService=require('../edgeTtsService');
const {hash,blocked}=require('./animeLoreConfig');
async function duration(input,ffprobe='ffprobe') {
  return new Promise((resolve,reject)=>{
    const p=spawn(ffprobe,['-v','error','-show_entries','format=duration','-of','default=nokey=1:noprint_wrappers=1',input],{windowsHide:true});
    let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);
    p.on('error',reject);p.on('close',code=>{const n=Number(out.trim());code===0&&n>0?resolve(n):reject(new Error('ffprobe audio duration: '+err));});
  });
}
function wordSpans(beat,durationSec,alignment) {
  // Normalized alignment timestamps are per character and can be aligned
  // with whitespace-delimited word indices; never claim word precision when absent.
  const words=beat.text.match(/\S+/g)||[];
  const chars=Array.isArray(alignment?.characters)?alignment.characters:[];
  const starts=Array.isArray(alignment?.character_start_times_seconds)?alignment.character_start_times_seconds:[];
  const ends=Array.isArray(alignment?.character_end_times_seconds)?alignment.character_end_times_seconds:[];
  if(chars.length && starts.length===chars.length && ends.length===chars.length) {
    const joined=chars.join('');let cursor=0;
    return words.map(w=>{
      let index=joined.indexOf(w,cursor);if(index<0)index=cursor;
      const end=Math.min(chars.length-1,index+w.length-1);
      cursor=end+1;return {word:w,startSec:Math.max(0,Number(starts[index])||0),endSec:Math.min(durationSec,Number(ends[end])||durationSec)};
    });
  }
  const total=words.reduce((n,w)=>n+w.length,0)||1;let pos=0;
  return words.map(w=>{const start=pos/total*durationSec;pos+=w.length;
    return {word:w,startSec:start,endSec:pos/total*durationSec};});
}
async function synthesize(config,script,settings,outDir,options={}) {
  await fs.mkdir(outDir,{recursive:true});
  const results=[];let totalDuration=0;
  for(let i=0;i<script.beats.length;i++) {
    const b=script.beats[i],id='beat_'+String(i+1).padStart(2,'0');
    const file=path.join(outDir,id+'.mp3');
    const cache=path.join(outDir,id+'.meta.json');
    const key=hash({text:b.text,provider:config.voiceProvider,voiceId:config.voiceId,model:settings.elevenLabsModel,version:1});
    let alignment=null;
    let hit=false;
    try{const previous=JSON.parse(await fs.readFile(cache,'utf8'));const stat=await fs.stat(file);
      if(previous.key===key&&stat.size>200){alignment=previous.alignment;hit=true;}}catch(_e){}
    if(!hit) {
      if(config.voiceProvider==='elevenlabs') {
        if(!settings.elevenLabsApiKey || !config.voiceId) throw blocked('failed','ElevenLabs requires configured API key and voice ID.');
        const api=new ElevenLabsService(settings.elevenLabsApiKey,settings.elevenLabsModel,settings);
        const r=await api.synthesizeSpeechWithTimestamps({text:b.text,voiceId:config.voiceId,outputPath:file,performanceMode:'story'});
        alignment=r.alignment;
      } else {
        // Edge is an explicit lower-fidelity fallback; it has no word timestamps.
        const edge=new EdgeTtsService(settings);
        await edge.synthesize({text:b.text,voice:config.voiceId||'en-US-AndrewNeural',outputPath:file,rate:'+0%',pitch:'+0Hz',volume:100});
      }
      await fs.writeFile(cache,JSON.stringify({key,alignment},null,2));
    }
    const sec=await duration(file,settings.ffprobePath||'ffprobe');
    results.push({id,role:b.role,audioPath:file,durationSec:sec,offsetSec:totalDuration,
      wordAlignment:wordSpans(b,sec,alignment),alignmentConfidence:alignment?'provider_timed':'estimated',
      text:b.text,claimIds:b.claimIds,visualIntent:b.visualIntent});
    totalDuration+=sec;
  }
  return {schemaVersion:1,segments:results,durationSec:totalDuration,needsManualTimingReview:results.some(r=>r.alignmentConfidence==='estimated')};
}
module.exports={synthesize,duration,wordSpans};