const test=require('node:test'),assert=require('node:assert/strict');
const H=require('../electron/services/autoStoryHookSelection');
const {StoryError}=require('../electron/services/autoStoryRepairRouter');
const clean={audioType:'officer_speech',confidence:.95};
const candidate={title:'Arrest',sourceStartSec:100,sourceEndSec:300,trigger:'Bite',viralScore:90};
const hook={sourceStartSec:233.825,sourceEndSec:237.25,audio:clean,firstMoment:'Bite',coldViewerTension:'Officer hurt',continuingCuriosity:'What follows?',completeBeat:false,completenessReason:'Full consequences and resolution are not shown.',score:9};
const evidence=[{sourceStart:98,duration:204}];
test('local beat definition does not require story resolution or confuse multiple on-scene voices with host narration',()=>{
  assert(H.instruction.includes('NOT the resolution of the whole story'));
  assert(H.instruction.includes('NOT by themselves external narration or mixed'));
  assert(H.instruction.includes('No fixed 3-5 second limit'));
  assert(H.instruction.includes('0 to 10'));
});
test('old zero-story plans re-audition; successful and current-policy plans remain reusable',()=>{
  assert(H.needsRefresh({stories:[]}));
  assert(!H.needsRefresh({stories:[{}]}));
  assert(!H.needsRefresh({stories:[],hookPolicyVersion:H.VERSION}));
});
test('incomplete hook triggers one verified reselection, not automatic approval or a paid audio check first',async()=>{
  let asks=0,audio=0;
  const e={duration:500,verifyAudio:async h=>{audio++;return h;},ask:async(_k,_i,_s,_p,_media,check)=>{
    const v={accessGranted:true,hooks:[++asks===1?hook:{...hook,sourceEndSec:241,completeBeat:true,completenessReason:'Includes full reply.'}]};check(v);return v;
  }};
  const v=await H.select(e,[candidate],evidence,1);
  assert.equal(asks,2);assert.equal(audio,1);assert.equal(v.good.length,1);assert.equal(v.good[0].hook.sourceEndSec,241);
  assert.equal(hook.completeBeat,false);
});
test('failed reselection remains rejected and bounded; another candidate with clean audio survives',async()=>{
  let asks=0;
  const mixed={...hook,completeBeat:true,audio:{audioType:'mixed',confidence:.99}};
  const second={...candidate,title:'Second',sourceStartSec:310,sourceEndSec:400};
  const accepted={...hook,sourceStartSec:320,sourceEndSec:332,completeBeat:true};
  const e={duration:500,verifyAudio:async h=>{if(h.audio.audioType==='mixed')throw new StoryError('BAD_CANDIDATE','Host audible');return h;},
    ask:async()=>({accessGranted:true,hooks:++asks===1?[mixed,accepted]:[mixed]})};
  const v=await H.select(e,[candidate,second],[{sourceStart:0,duration:500}],2);
  assert.equal(asks,2);assert.equal(v.good.length,1);assert.equal(v.good[0].title,'Second');assert.equal(v.rejected.length,1);
});
test('invalid timestamps cannot sneak through reselection',async()=>{
  const e={duration:500,verifyAudio:async h=>h,ask:async()=>({accessGranted:true,hooks:[{...hook,sourceEndSec:900,completeBeat:true}]})};
  const v=await H.select(e,[candidate],evidence,1);assert.equal(v.good.length,0);
});
test('out-of-scale scores are not divided or verified with paid audio calls',async()=>{
  let audio=0,asks=0;
  const e={duration:500,verifyAudio:async h=>{audio++;return h;},ask:async()=>{asks++;return {accessGranted:true,hooks:[{...hook,score:99,completeBeat:true}]};}};
  const v=await H.select(e,[candidate],evidence,1);
  assert.equal(v.good.length,0);assert.equal(audio,0);assert.equal(asks,2);
});
test('enough clean hooks skip uncertain backups and their extra API costs',async()=>{
  const candidates=[candidate,...[310,410,510].map((start,i)=>({...candidate,title:`Other ${i}`,sourceStartSec:start,sourceEndSec:start+50}))];
  const hooks=candidates.map((c,i)=>({...hook,sourceStartSec:c.sourceStartSec+1,sourceEndSec:c.sourceStartSec+12,completeBeat:true,audio:i===0?{audioType:'uncertain',confidence:.4}:clean}));
  let verified=0;
  const engine={duration:600,verifyAudio:async h=>{assert.equal(h.audio.audioType,'officer_speech');verified++;return h;},ask:async()=>({accessGranted:true,hooks})};
  const result=await H.select(engine,candidates,[{sourceStart:0,duration:600}],3);
  assert.equal(result.good.length,3);assert.equal(verified,3);assert.equal(result.deferred.length,1);
});
test('audio verification service failure cannot discard hooks already verified',async()=>{
  const second={...candidate,title:'Second',sourceStartSec:310,sourceEndSec:400};
  const items=[{...hook,completeBeat:true},{...hook,sourceStartSec:320,sourceEndSec:330,completeBeat:true,audio:{audioType:'uncertain',confidence:.4}}];
  const engine={duration:500,verifyAudio:async h=>{if(h.audio.audioType==='uncertain')throw new Error('Vertex 400');return h;},ask:async()=>({accessGranted:true,hooks:items})};
  const result=await H.select(engine,[candidate,second],[{sourceStart:0,duration:500}],2);
  assert.equal(result.good.length,1);assert.equal(result.rejected.length,1);assert(result.rejected[0].rejection.includes('Vertex 400'));
});
