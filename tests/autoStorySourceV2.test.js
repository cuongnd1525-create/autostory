const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs/promises'),path=require('path'),os=require('os');
const C=require('../electron/services/autoStoryTimelineCompiler');
const G=require('../electron/services/autoStorySourceGates');
const A=require('../electron/services/autoStoryAudioClassifier');
const R=require('../electron/services/autoStoryRepairRouter');
const K=require('../electron/services/autoStorySourceContracts');
const {Engine}=require('../electron/services/autoStorySourceEngine');
const Review=require('../electron/services/autoStorySourceReview');
const Service=require('../electron/services/autoStoryFastService');
const Dubbing=require('../electron/services/dubbingService');
const clean={audioType:'officer_speech',confidence:.96};
const config={targetDurationMinSec:65,targetDurationMaxSec:90,narration:{enabled:true,measuredWordsPerSecond:2.5}};
const assessment={hookQuality:8,storyClarity:8,informationGain:8,storyProgression:8,escalation:8,payoff:8,
  narrationDependency:2,procedureDensity:1,reactionDensity:8,deadStorySpans:[],duplicateMeaning:[],coherentOpening:true,fulfillsPromise:true,grounded:true,reason:'Complete causal account with clean participant reactions.'};
const hook={sourceStartSec:0,sourceEndSec:8,audio:clean,firstMoment:'Command',coldViewerTension:'Visible conflict',continuingCuriosity:'What happens next?',completeBeat:true,completenessReason:'Includes reply',score:9};
const blueprint={centralViewerQuestion:'Why did he flee?',hookPromise:'A verified explanation',minimumContext:'Police make a traffic stop.',
  escalationBeats:['He refuses','Evidence emerges'],turningPoint:'Evidence',climax:{sourceStartSec:100,sourceEndSec:112,reason:'Confession'},
  payoff:{sourceStartSec:112,sourceEndSec:124,reason:'Reaction'},ending:'Immediate consequence',whatToExclude:['Paperwork'],
  footage:[{sourceStartSec:0,sourceEndSec:124}],strongEnough:true,sufficientAuthenticFootage:true,reason:'Complete causal story.'};
const story={...blueprint,scriptId:1,candidateId:'code-owned',title:'A verified story',hook};
const decisions=[[0,8,'hook','original'],[20,28,'context','narration'],[40,70,'escalation','original'],[100,112,'climax','original'],[112,124,'payoff','original']]
  .map(([sourceStartSec,sourceEndSec,storyRole,audioIntent])=>({sourceStartSec,sourceEndSec,storyRole,audioIntent,reason:'Advances the question',audio:clean,
    voiceoverText:audioIntent==='narration'?'Police needed an answer before the driver could leave.':'',previewVi:audioIntent==='narration'?'Cảnh sát cần một câu trả lời.':''}));
const evidence=[
  {id:'c_hook',file:'e.mp4',sourceStart:0,duration:8},
  {id:'c_context',file:'e.mp4',sourceStart:20,duration:8},
  {id:'c_escalation',file:'e.mp4',sourceStart:40,duration:30},
  {id:'c_climax',file:'e.mp4',sourceStart:100,duration:12},
  {id:'c_payoff',file:'e.mp4',sourceStart:112,duration:12},
  {id:'private',file:'e.mp4',sourceStart:0,duration:130}
];
const layout={accessGranted:true,decisions,assessment};
const compile=ds=>C.compile(ds,{story,evidence,config,sourceDuration:1400});
const temp=async fn=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-v2-'));try{return await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}};

test('compiler maps source ranges and creates deterministic unique IDs without AI',()=>{
  const ds=decisions.map((d,i)=>({...d,sourceStartSec:[0,20,40,100,112][i]+200,sourceEndSec:[8,28,70,112,124][i]+200}));
  const options={story,evidence:[{id:'e',sourceStart:190,duration:150}],config,sourceDuration:400};
  const a=C.compile(ds,options),b=C.compile(ds,options);
  assert.equal(a.segments[0].start,10);assert.equal(a.segments[0].end,18);assert.equal(a.segments[1].outputStartSec,8);
  assert.deepEqual(a,b);assert.equal(new Set(a.segments.map(s=>s.id)).size,a.segments.length);
  assert.equal(a.hookAudit.selectedCandidateId,'code-owned');
});
test('uncovered/out-of-source ranges fail locally; no silent timestamp clamping',()=>{
  assert.throws(()=>compile([{...decisions[0],evidenceId:undefined,sourceStartSec:0,sourceEndSec:150}]),e=>e.kind==='EVIDENCE_REQUIRED');
  assert.throws(()=>compile([{...decisions[0],evidenceId:undefined,sourceStartSec:-1,sourceEndSec:8}]),/SOURCE/);
  assert.throws(()=>compile([decisions[0],decisions[0]]),/duplicate/);
});
test('semantic ranking lets dialogue defeat weak action and rejects weak candidates',()=>{
  const candidate=(title,trigger,n)=>({title,trigger,evidenceId:'private',editIntent:'keep_full',reason:'Observed',strengths:['Quote'],weaknesses:[],risk:'Context',scores:Object.fromEntries(K.dimensions.map(k=>[k,k.endsWith('Dependency')?2:n]))});
  const ranked=G.rank([candidate('Weak action','physical escalation',3),candidate('Strong quote','contradiction',9)],evidence,1400);
  assert.equal(ranked[0].title,'Strong quote');assert(ranked[0].eligible);assert(!ranked[1].eligible);
});
test('audio classifier distinguishes uncertain/clean/mixed and separate text errors',()=>{
  assert.equal(A.disposition(clean),'CLEAN');assert.equal(A.disposition({audioType:'mixed',confidence:.99}),'REPLACE');
  assert.equal(A.disposition({audioType:'uncertain',confidence:.99}),'VERIFY');
  assert.throws(()=>compile([{...decisions[0],voiceoverText:'Unexpected'}]),/unexpectedly/);
  assert.throws(()=>compile([{...decisions[0],audio:{audioType:'external_narrator',confidence:.99}}]),/external narrator/);
});
test('uncertain audio triggers a focused listening call',()=>temp(async root=>{
  let calls=0;
  const e=new Engine({stage:async(_r,_k,_i,_args,validate)=>{calls++;const v={accessGranted:true,audio:clean};await validate(v);return v;}},
    {cache:root,config,duration:1400,sourceHash:'x'});
  e.prepare=async()=>evidence;
  const d=await e.verifyAudio({...decisions[0],audio:{audioType:'uncertain',confidence:.1}},evidence);
  assert.equal(calls,1);assert.deepEqual(d.audio,clean);
}));
test('blueprint rejects insufficient authentic footage before edit',()=>{
  assert.throws(()=>G.blueprint({...blueprint,sufficientAuthenticFootage:false},evidence,1400),e=>e.kind==='BAD_CANDIDATE');
});
test('pre-render gate rejects missing payoff/weak story before TTS',()=>{
  G.layout(layout,story,evidence,config,1400);
  assert.throws(()=>G.layout({...layout,assessment:{...assessment,fulfillsPromise:false}},story,evidence,config,1400),e=>e.kind==='STRUCTURAL_STORY');
  assert.throws(()=>G.layout({...layout,decisions:decisions.filter(d=>d.storyRole!=='payoff')},story,evidence,config,1400),/payoff/);
});
test('safe word budget is computed in code before narration',()=>{
  assert.equal(C.budget(8,2.5),18);
  assert.throws(()=>compile(decisions.map(d=>d.audioIntent==='narration'?{...d,voiceoverText:'word '.repeat(19)}:d)),e=>e.kind==='VOICE_BUDGET');
});
test('one actual voice overflow repairs only that segment, keeps visual duration',()=>temp(async root=>{
  let patches=0;
  const service={callBudget:{},measuredVoice:async(_p,t)=>({meta:{duration:t===decisions[1].voiceoverText?9:3}}),stage:async(_r,_k,input,args,validate)=>{
    patches++;assert.equal(input.sourceStartSec,20);assert(!args.prompt.includes('private'));const v={voiceoverText:'Police needed an answer.',previewVi:'Cảnh sát cần câu trả lời.'};await validate(v);return v;}};
  const e=new Engine(service,{root,cache:root,project:{},config,duration:1400});e.metric=async()=>{};
  const fitted=await e.fit(decisions,story,evidence);
  assert.equal(patches,1);assert.deepEqual(fitted[0],decisions[0]);assert.equal(fitted[1].sourceStartSec,20);assert.equal(fitted[1].measuredVoiceSec,3);
  assert.equal(compile(fitted).measuredDuration,70);
}));
test('large or dispersed patch routes to structural rebuild',()=>{
  assert.throws(()=>R.assertPatchSize(40,80),e=>e.kind==='STRUCTURAL_STORY');
  assert.equal(R.route([{type:'promise'}],20),'STRUCTURAL_STORY');
  assert.throws(()=>Review.reviewScope([{outputSec:1},{outputSec:69}],compile(decisions)),e=>e.kind==='STRUCTURAL_STORY');
});
test('asynchronous repair postconditions are awaited before cache success',()=>temp(async root=>{
  let calls=0;
  const s=new Service({}, {},{vertex:{getModel:()=> 'flash',generateJsonFromFiles:async()=>({fixed:++calls>1})}});
  const args={sourceContract:true,prompt:'fix',filePaths:[]};
  const validate=async v=>{await new Promise(r=>setTimeout(r,5));if(!v.fixed)throw new Error('rhythm remains');};
  await assert.rejects(s.stage(root,'v2-repair-1',{},args,validate),/rhythm remains/);
  assert(!(await fs.readdir(root)).some(f=>/^v2-repair-1-[0-9a-f]{20}\.json$/.test(f)));
  await s.stage(root,'v2-repair-1',{},args,validate);await s.stage(root,'v2-repair-1',{},args,validate);
  assert.equal(calls,2,'failed repair was not a success cache; successful stage reused');
}));
test('invalid duration and incomplete hook cannot be cached as successful repairs',()=>temp(async root=>{
  const s=new Service({}, {},{vertex:{generateJsonFromFiles:async()=>({ok:true})}});
  await assert.rejects(s.stage(root,'v2-duration_repair-1',{}, {sourceContract:true,prompt:'duration'},()=>C.validateDuration({segments:[{start:0,end:40}]},config)),/duration/);
  await assert.rejects(s.stage(root,'v2-hook_repair-1',{}, {sourceContract:true,prompt:'hook'},()=>G.layout({...layout,decisions:decisions.map((d,i)=>i?d:{...d,evidenceId:undefined,sourceStartSec:0,sourceEndSec:3})},story,evidence,config,1400)),/complete/);
  assert(!(await fs.readdir(root)).some(f=>/^v2-(duration|hook)_repair-1-[a-f0-9]{20}\.json$/.test(f)));
}));
test('compact PASS needs no mutation and no patch contract',()=>{
  G.review({accessGranted:true,verdict:'PASS',viralScore:86,confidence:.96,issues:[],previewSubtitleIssues:[]},70);
  assert(!('patch' in K.schemas.review.properties));
  assert.throws(()=>G.review({accessGranted:true,verdict:'PASS',viralScore:86,confidence:.96,issues:[{outputSec:4,reason:'Bad'}],previewSubtitleIssues:[]},70),/Inconsistent/);
});
test('Rhythm V2 keeps semantic metrics explicitly AI-assessed, never hard audio quotas',()=>{
  const r=require('../electron/services/autoStoryRhythm').analyzeV2(compile(decisions),assessment);
  assert.equal(r.policyVersion,2);assert.equal(r.informationGain,8);assert.match(r.semanticProvenance,/AI/);
  assert.deepEqual(r.targetNarrationRatio,[.15,.3]);assert.equal(r.originalSec,62);
});
test('compiled V2 imports through existing renderer contract',()=>{
  const technical=compile(decisions),json=Service.highlight(technical,story,evidence),normalized=Dubbing.normalizeHighlightCutScript(json,1400);
  assert.equal(normalized.segments.length,5);assert.equal(normalized.segments[1].voiceoverText,decisions[1].voiceoverText);
  assert.equal(normalized.segments[0].sourceStartSec,0);assert.equal(normalized.segments[0].audioMode,'original_audio');
});
test('source pipeline executes actual service stages, resumes caches and reviews an actual draft path',()=>temp(async root=>{
  const source=path.join(root,'source.mp4');await fs.writeFile(source,'1400');
  let project={id:'test',analysisWorkflow:'vertex_auto_story',sourceVideoPath:source,voiceProvider:'kokoro',voiceId:'am_adam',autoStoryConfig:{targetDurationMinSec:65,targetDurationMaxSec:90}};
  const store={getProject:async()=>structuredClone(project),getProjectPaths:()=>({analysisDir:root}),updateProject:async(_w,_id,p)=>(project={...project,...p})};
  const MediaIndexer = require('../electron/services/autoStoryMediaIndexer');
  MediaIndexer.index = () => evidence.map(e => ({ id: e.id, sourceStartSec: e.sourceStart, sourceEndSec: e.sourceStart+e.duration }));
  const calls=[];
  const candidate=i=>({title:`Story ${i}`,trigger:i?'action':'officer quote',sourceStartSec:i*10,sourceEndSec:i*10+60,reason:'Observed',strengths:['Quote'],weaknesses:[],risk:'Attribution',scores:Object.fromEntries(K.dimensions.map(k=>[k,k.endsWith('Dependency')?2:9-i*.2]))});
  const vertex={getModel:t=>t,lastUsage:null,generateJsonFromFiles:async function(args){
    this.lastUsage={estimatedCostUsd:.01,inputTokens:100,outputTokens:50,model:'mock'};calls.push(args);
    if(args.responseSchema===K.schemas.discovery)return {accessGranted:true,candidates:Array.from({length:6},(_,i)=>candidate(i)),capacityReason:''};
    if(args.responseSchema===K.schemas.audition)return {accessGranted:true,hooks:[hook]};
    if(args.responseSchema===K.schemas.blueprints)return {accessGranted:true,stories:[{sourceStartSec:0,sourceEndSec:60,blueprint}]};
    if(args.responseSchema===K.schemas.layout)return {...layout,decisions:decisions.map(({voiceoverText,previewVi,...d})=>d)};
    if(args.responseSchema===K.schemas.narrations)return {accessGranted:true,narrations:[{sourceStartSec:decisions[1].sourceStartSec,sourceEndSec:decisions[1].sourceEndSec,voiceoverText:decisions[1].voiceoverText,previewVi:decisions[1].previewVi}],assessment};
    if(args.responseSchema===K.schemas.review)return {accessGranted:true,verdict:'PASS',viralScore:88,confidence:.96,issues:[],previewSubtitleIssues:[]};
    throw new Error('Unexpected AI stage');
  }};
  const ffmpeg={ffmpegPath:'mock',run:async()=>{},probeVideo:async f=>({duration:Number(await fs.readFile(f,'utf8')),hasAudio:true}),probeAudio:async f=>({duration:Number(await fs.readFile(f,'utf8'))}),
    createAnalysisProxyChunk:async o=>{assert(o.sourceClock);await fs.writeFile(o.outputPath,String(o.durationSec));}};
  const dubbing={synthesizeFastDraftVoice:async o=>fs.writeFile(o.outputPath,String(C.words(o.text)/2.5))};
  const service=new Service({autoStorySourceContract:true,vertexAutoStoryMaxCalls:40},store,{vertex,ffmpeg,dubbing,callBudget:{calls:0,runId:'test-run'}});
  const ready=[];
  const result=await service.run({workspaceRoot:root,projectId:'test',onScriptReady:x=>ready.push(x)});
  if(result.failures.length > 0) throw new Error(JSON.stringify(result.failures) + ' ' + (result.failures[0].stack || result.failures[0].error));
  assert.equal(result.failures.length,0);assert.equal(result.scriptPaths.length,1);assert.equal(project.autoStoryConfig.outputCount,1);assert.equal(project.autoStoryContractVersion,2);
  assert.equal(ready.length,1);assert.equal(calls.length,5);
  const planFile=path.join(root,'auto-story-fast','plan.json');
  const savedPlan=JSON.parse(await fs.readFile(planFile,'utf8'));
  await fs.writeFile(planFile,JSON.stringify({...savedPlan,stories:[],hookPolicyVersion:undefined}));
  const resumed=await service.run({workspaceRoot:root,projectId:'test',retryFailed:true,onScriptReady:()=>{}});
  if (resumed.scriptPaths.length !== 1) throw new Error(JSON.stringify(resumed.failures));
  assert.equal(resumed.scriptPaths.length,1,'legacy zero-story plan is reevaluated instead of permanently blocking retry');
  assert.equal(calls.length,5,'successful source stages are reused while rebuilding the plan');
  const firstCalls=calls.length;await service.run({workspaceRoot:root,projectId:'test',retryFailed:true,onScriptReady:()=>{}});assert.equal(calls.length,firstCalls);
  const compiled=JSON.parse(await fs.readFile(path.join(root,'auto-story-fast','edit-1.json'),'utf8'));
  const draft=path.join(root,'draft.mp4');await fs.writeFile(draft,'70');
  project.analysis={highlightVariants:[{id:'variant_01',scriptId:1,sourceJsonPath:ready[0].scriptPath,segments:Dubbing.normalizeHighlightCutScript(JSON.parse(await fs.readFile(ready[0].scriptPath,'utf8')),1400).segments,artifacts:{fastDraftVideoPath:draft}}]};
  const audited=await service.auditDrafts({workspaceRoot:root,projectId:'test',scriptId:1});
  assert.equal(audited.audits[0].finalCheck.verdict,'PASS');assert.equal(calls.length,firstCalls+1,'PASS requires only one real-video review, not a rewrite/final duplicate');
  assert(calls.at(-1).filePaths.includes(draft));assert.equal(calls.at(-1).taskType,'auto_story_plan','Flash default does not inherit Pro quality setting');
  await service.auditDrafts({workspaceRoot:root,projectId:'test',scriptId:1});assert.equal(calls.length,firstCalls+1);
  const after=JSON.parse(await fs.readFile(path.join(root,'auto-story-fast','edit-1.json'),'utf8'));assert.deepEqual(after,compiled,'PASS preserves script');
}));
