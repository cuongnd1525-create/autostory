const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs/promises'),path=require('path'),os=require('os');
const Service=require('../electron/services/autoStoryFastService');
const Runner=require('../electron/services/autoStoryRunner');
const P=require('../electron/services/autoStoryProviderErrors');
const Vertex=require('../electron/services/vertexAiService');
const rate=()=>Vertex.formatVertexApiError(429,JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Resource exhausted. Please try again later.'}}),'test');
const temp=async fn=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'rate-limit-test-'));try{await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}};
test('429 uses bounded exponential backoff and respects Retry-After',()=>{
  assert(P.isRateLimit(rate()));
  assert.equal(P.retryDelay(rate(),0,()=>0),15000);
  assert.equal(P.retryDelay(rate(),1,()=>0),30000);
  assert.equal(P.retryDelay(rate(),2,()=>0),null);
  assert.equal(P.retryDelay(Object.assign(rate(),{retryAfterMs:60000}),0,()=>0),60000);
  assert.equal(P.retryDelay(Object.assign(rate(),{retryAfterMs:100000}),0,()=>0),null);
  assert.equal(P.retryDelay(new Error('Vertex AI request failed (400)'),0),null);
});
test('429 then success retries identical request and caches only valid success',()=>temp(async root=>{
  let calls=0;const requests=[],delays=[];
  const service=new Service({}, {},{retryWait:async d=>delays.push(d),vertex:{getModel:()=> 'flash',generateJsonFromFiles:async args=>{
    requests.push(args.prompt);if(++calls===1)throw rate();return {ok:true};
  }}});
  const args={sourceContract:true,prompt:'blueprints',filePaths:['existing.mp4']};
  const check=v=>assert(v.ok);
  await service.stage(root,'v2-blueprints',{},args,check);
  await service.stage(root,'v2-blueprints',{},args,check);
  assert.equal(calls,2);assert.equal(delays.length,1);assert.deepEqual(requests,['blueprints','blueprints']);
}));
test('persistent 429 stops after two retries; later resume can succeed',()=>temp(async root=>{
  let calls=0;const delays=[];
  const service=new Service({}, {},{retryWait:async d=>delays.push(d),vertex:{getModel:()=> 'flash',generateJsonFromFiles:async()=>{calls++;throw rate();}}});
  const args={sourceContract:true,prompt:'blueprints',filePaths:['existing.mp4']};
  await assert.rejects(service.stage(root,'v2-blueprints',{},args,()=>{}),e=>e.kind==='PROVIDER_RATE_LIMIT'&&e.stage==='v2-blueprints');
  assert.equal(calls,3);assert.equal(delays.length,2);
  assert(!(await fs.readdir(root)).some(f=>/^v2-blueprints-[a-f0-9]{20}\.json$/.test(f)));
  service.vertex.generateJsonFromFiles=async()=>({ok:true});
  await service.stage(root,'v2-blueprints',{},args,v=>assert(v.ok));
}));
test('cancellation during backoff does not send another request',()=>temp(async root=>{
  const controller=new AbortController();let calls=0;
  const service=new Service({}, {},{retryWait:async()=>{controller.abort();controller.signal.throwIfAborted();},vertex:{generateJsonFromFiles:async()=>{calls++;throw rate();}}});
  await assert.rejects(service.stage(root,'v2-blueprints',{}, {sourceContract:true,prompt:'test'},()=>{},null,controller.signal),e=>e.name==='AbortError');
  assert.equal(calls,1);
}));
test('actual blueprint 429 scenario does not resurrect old hook failures in runner',()=>temp(async root=>{
  const old=[1,2,3].map(scriptId=>({scriptId,kind:'BAD_CANDIDATE',error:'Các hook được nghe kiểm tra chưa đủ sạch hoặc chưa trọn ý.'}));
  let project={id:'p',autoStoryContractVersion:2,autoStoryPipelineVersion:'editorial-v1',autoStoryConfig:{outputCount:3},autoStoryCapacityWarning:old[0].error,
    autoStoryState:{failures:old},analysis:{highlightVariants:[]}};
  const store={getProject:async()=>structuredClone(project),getProjectPaths:()=>({analysisDir:root}),updateProject:async(_w,_id,p)=>(project={...project,...p})};
  await fs.mkdir(path.join(root,'auto-story-fast'),{recursive:true});
  await fs.writeFile(path.join(root,'auto-story-fast','failures.json'),JSON.stringify(old));
  let calls=0;
  const runner=new Runner({},store,{},()=>({recoverScriptIds:async()=>project,run:async()=>{calls++;throw P.exhausted(rate(),'v2-blueprints');}}));
  await assert.rejects(runner.run({workspaceRoot:root,projectId:'p'}),e=>P.isRateLimit(e));
  assert.equal(calls,1);assert.deepEqual(project.autoStoryState.failures,[]);
  assert.equal(project.autoStoryCapacityWarning,'');assert.equal(project.autoStoryState.failedStage,'v2-blueprints');
  assert.equal(project.autoStoryState.errorKind,'PROVIDER_RATE_LIMIT');assert(project.autoStoryProduction.finished);
}));
test('hook reselection 429 stays a provider failure rather than a no-hook verdict',async()=>{
  const hook=require('../electron/services/autoStoryHookSelection');let calls=0;
  const engine={duration:100,ask:async()=>{if(++calls===1)return {accessGranted:true,hooks:[]};throw P.exhausted(rate(),'v2-hook_reselect');}};
  await assert.rejects(hook.select(engine,[{title:'Test',sourceStartSec:0,sourceEndSec:100}],[],1),e=>P.isRateLimit(e));
});
