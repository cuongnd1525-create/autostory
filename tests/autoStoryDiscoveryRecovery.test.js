const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises'), os = require('os'), path = require('path');
const {partition,resolve} = require('../electron/services/autoStorySourceDiscovery');
const {schemas,dimensions} = require('../electron/services/autoStorySourceContracts');
const {Engine} = require('../electron/services/autoStorySourceEngine');
const Service = require('../electron/services/autoStoryFastService');
const {validate} = require('../electron/services/autoStorySchemaBoundary');
// Observed ranges from project 0915-05-6df3b55e, 2026-09-15 13:59:22.
const ranges = [[19.11,36.07],[140.2,273.99],[304.99,314.99],[347.5,412.5],[414.5,555],[1333,1449],[1449,1541.79],[1707,1729.5]];
const duration = 1049.661;
const candidates = ranges.map(([sourceStartSec,sourceEndSec],i)=>({title:`Candidate ${i+1}`,sourceStartSec,sourceEndSec,
  reason:'Observed event',trigger:'Action',strengths:['Conflict'],weaknesses:[],risk:'Context',
  scores:Object.fromEntries(dimensions.map(k=>[k,k.endsWith('Dependency')?2:8]))}));
const result = {accessGranted:true,candidates,capacityReason:''};
test('actual failing ranges quarantine only 3 of 8 candidates without clamping or guessing',()=>{
  const {ranked,rejected} = partition(candidates,duration);
  assert.equal(ranked.length,5); assert.equal(rejected.length,3);
  assert.deepEqual(rejected.map(c=>[c.sourceStartSec,c.sourceEndSec]),ranges.slice(5));
  assert(rejected[0].rejection.includes('1333-1449s'));
  assert(rejected[0].rejection.includes('1049.661'));
});
test('one focused repair preserves valid candidates and applies only verified source ranges',async()=>{
  let calls=0;
  const engine={duration,ask:async(key,input,schema,prompt,media,check)=>{
    calls++; assert.equal(key,'v2-discovery_ranges');assert.equal(input.candidates.length,3);
    const v={accessGranted:true,corrections:[{title:'Candidate 6',sourceStartSec:800,sourceEndSec:850,verified:true,evidence:'Observed action in fixture'},
      {title:'Candidate 7',sourceStartSec:0,sourceEndSec:0,verified:false,evidence:'Not located'}]};
    validate(v,schema);check(v);return v;
  }};
  const fixed=await resolve(engine,result,[]);
  assert.equal(calls,1);assert.equal(fixed.ranked.length,6);assert.equal(fixed.rejected.length,2);
  for(const c of candidates.slice(0,5)) {const v=fixed.ranked.find(v=>v.title===c.title);assert.equal(v.sourceStartSec,c.sourceStartSec);assert.equal(v.sourceEndSec,c.sourceEndSec);}
  assert.deepEqual(result.candidates.map(c=>[c.sourceStartSec,c.sourceEndSec]),ranges);
});
test('failed/unverified/out-of-bounds repairs do not discard valid candidates or retry forever',async()=>{
  for(const failure of ['network','unverified','invalid']) {
    let calls=0;
    const engine={duration,ask:async(_k,_i,_s,_p,_e,check)=>{
      calls++;if(failure==='network')throw new Error('503');
      const v={accessGranted:true,corrections:failure==='unverified'?[]:[{title:'Candidate 6',sourceStartSec:1333,sourceEndSec:1449,verified:true,evidence:'Still wrong'}]};
      check(v);return v;
    }};
    const fixed=await resolve(engine,result,[]);
    assert.equal(calls,1);assert.equal(fixed.ranked.length,5);assert.equal(fixed.rejected.length,3);
  }
});
test('resume revalidates matching saved discovery without another discovery API call',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'discovery-resume-'));
  const vertex={getModel:()=> 'flash',generateJsonFromFiles:async()=>result};
  const service=new Service({}, {},{vertex});
  const args={sourceContract:true,prompt:'same prompt',responseSchema:schemas.discovery};
  try {
    await assert.rejects(service.stage(root,'v2-discovery',{duration},args,v=>require('../electron/services/autoStorySourceGates').rank(v.candidates,duration)),/SOURCE/);
    vertex.generateJsonFromFiles=async()=>{throw new Error('Unexpected paid discovery');};
    const check=v=>{validate(v,schemas.discovery);require('../electron/services/autoStorySourceGates').access(v);};
    const resumed=await service.stage(root,'v2-discovery',{duration},{...args,recoverValidatedArtifact:true},check);
    assert.deepEqual(resumed,result);assert.equal(partition(resumed.candidates,duration).ranked.length,5);
    await service.stage(root,'v2-discovery',{duration},args,check);
    await assert.rejects(service.stage(root,'v2-discovery',{duration:2000},{...args,recoverValidatedArtifact:true},check),/Unexpected paid/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
