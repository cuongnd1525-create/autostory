'use strict';
const fs=require('fs/promises'),path=require('path');
const {normalize,STAGES,VERSION,hash,readJson,atomicJson,blocked}=require('./animeLoreConfig');
const Canon=require('./animeLoreCanonService');
const Topics=require('./animeLoreTopicService');
const Ledger=require('./animeLoreFactLedgerService');
const Hooks=require('./animeLoreHookService');
const Script=require('./animeLoreScriptService');
const Voice=require('./animeLoreVoiceService');
const Media=require('./animeLoreMediaLibraryService');
const Matcher=require('./animeLoreVisualMatcher');
const Timeline=require('./animeLoreTimelineService');
const Renderer=require('./animeLoreRenderer');
const Review=require('./animeLoreReviewService');
const Export=require('./animeLoreExportService');
function progressFor(idx){return Math.min(99,Math.round(idx/15*100));}
class AnimeLorePipelineService {
 constructor(settings={},store){this.settings=settings;this.store=store;}
 async run({workspaceRoot,projectId=null,input=null,onProgress=()=>{},signal=null}) {
  let project=projectId?await this.store.getProject(workspaceRoot,projectId):null;
  if(!project && !input)throw Error('Missing Anime project input.');
  const config=normalize(input||project?.animeLoreConfig);
  if(!project){
   project=await this.store.createProject(workspaceRoot,{title:config.series+' - '+config.topic,
     mode:'anime_lore',sourceVideoPath:'',targetLanguage:'en',framePreset:'vertical',
     animeLoreConfig:config});
   projectId=project.id;
  }
  if(project.mode!=='anime_lore')throw Error('Refusing to run Anime mode on another project.');
  const root=path.join(this.store.getProjectPaths(workspaceRoot,projectId).rootDir,'anime-lore');
  await fs.mkdir(root,{recursive:true});
  let state=await readJson(path.join(root,'anime-state.json'))||{schemaVersion:VERSION,projectId,completedStages:[],phase:'created'};
  const emit=(i,message,phase)=>onProgress({stage:'anime_lore',step:STAGES[i],phase:phase||STAGES[i],percent:progressFor(i),message,projectId});
  const step=async(i,inputData,task)=>{
   if(signal?.aborted)throw Error('Anime Lore cancelled.');
   const name=STAGES[i],filename=path.join(root,name+'.json');
   const cacheKey=hash({version:VERSION,name,inputData});
   let prior=await readJson(filename);
   if(prior && prior.cacheKey===cacheKey && prior.result) {
    emit(i,'Cache hit: '+name);
    return prior.result;
   }
   emit(i,'Running '+name);
   const result=await task();
   if(result===undefined || result===null)throw Error('Empty stage result: '+name);
   await atomicJson(filename,{schemaVersion:VERSION,cacheKey,result,finishedAt:new Date().toISOString()});
   state={...state,phase:name,completedStages:[...new Set([...state.completedStages,name])],lastStage:name};
   await atomicJson(path.join(root,'anime-state.json'),state);
   return result;
  };
  try {
   const basics=await step(0,config,async()=>({config,runId:projectId}));
   const canon=await step(1,config,async()=>Canon.requireGroundedCanon(Canon.parseCanon(config.canonText,config.medium,config.spoilerThrough)));
   const generated=await step(2,{config,canon},()=>Script.generate(config,canon,this.settings,{signal,onProgress}));
   const topics=Topics.validateTopics(generated.topicCandidates,canon.facts);
   const angle=await step(3,{config,topics},async()=>Topics.lockAngle(config,topics));
   const ledger=await step(4,{canon,angle},async()=>Ledger.validateLedger(canon,canon.facts.filter(f=>angle.claimIds.includes(f.id))));
   const hooks=await step(5,{generated,ledger},async()=>Hooks.audition(generated.hooks,ledger));
   const script=await step(6,{generated,hooks},async()=>{
    const beats=generated.beats.map((b,i)=>i===0?{...b,text:hooks.selected.text,claimIds:hooks.selected.payoffClaimIds}:b);
    return {schemaVersion:1,title:generated.title,beats,selectedHook:hooks.selected};
   });
   await step(7,{script,ledger,scope:config.medium},async()=>{
    Ledger.validateClaimIds(script.beats,ledger);
    const combined=script.beats.map(b=>b.text).join(' ');
    if(combined.length<80)throw blocked('needs_fact_review','Narration is too short.');
    return {scriptPassed:true,claimsUserAttested:true,requiresHumanCanonReview:true};
   });
   const voice=await step(8,{script,voiceProvider:config.voiceProvider,voiceId:config.voiceId,settings:{elevenLabsModel:this.settings.elevenLabsModel}},()=>Voice.synthesize(config,script,this.settings,path.join(root,'voice'),{signal}));
   // Changes to a media folder must invalidate dependent EDL and render artifacts.
   const mediaFingerprint=await this.mediaFingerprint(config.mediaFolder);
   const media=await step(9,{config,mediaFingerprint},()=>Media.index(config,this.settings));
   const matched=await step(10,{config,voice,media},async()=>Matcher.match(config,voice,media));
   const timeline=await step(11,{matched,voice,media},async()=>Timeline.create(config,voice,matched,media));
   const draft=await step(12,{timeline,voice,renderVersion:1},()=>Renderer.render(config,timeline,voice,root,this.settings,{signal,onProgress}));
   // A cached draft can be stale or deleted; block false success rather than inventing a completed render.
   await fs.access(draft.path);
   const review=await step(13,{draft,canon,script},()=>Review.review({config,canon,script,draft,settings:this.settings,signal,onProgress}));
   if(!review.pass)throw blocked('needs_human_review','AI multimodal review found issues. Export is blocked.',{review,projectId});
   const exported=await step(14,{review,draft,config,canon},()=>Export.exportPack(root,config,canon,script,timeline,draft,review));
   state={...state,phase:'needs_human_review',humanCanonReviewRequired:true,outputPath:exported.outputPath};
   await atomicJson(path.join(root,'anime-state.json'),state);
   emit(14,'Video rendered and visually reviewed; confirm source facts and rights before publishing.','needs_human_review');
   return {projectId,status:'needs_human_review',draftPath:draft.path,...exported,review,sourceFactsUnverified:true};
  } catch(error) {
   const status=error.animeStatus || (signal?.aborted?'cancelled':'failed');
   state={...state,phase:status,error:String(error.message),details:error.details||null};
   await atomicJson(path.join(root,'anime-state.json'),state);
   emit(Math.max(0,STAGES.indexOf(state.lastStage)),error.message,status);
   if(error.animeStatus)return {projectId,status,message:error.message,details:error.details||null,root};
   throw error;
  }
 }
 async mediaFingerprint(folder){
  if(!folder)return null;
  try{const entries=await fs.readdir(folder,{withFileTypes:true});
    const names=await Promise.all(entries.filter(x=>x.isFile()).map(async x=>{
      const s=await fs.stat(path.join(folder,x.name));return [x.name,s.size,Math.round(s.mtimeMs)];}));
    return hash(names.sort((a,b)=>a[0].localeCompare(b[0])));
  }catch(_e){return 'unavailable';}
 }
}
module.exports=AnimeLorePipelineService;