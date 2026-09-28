// Explicit paid integration diagnostic; original projects and their caches stay read-only.
const fs=require('fs/promises'),path=require('path'),os=require('os');
const Service=require('../electron/services/autoStoryFastService');
const Dubbing=require('../electron/services/dubbingService');
const {Engine}=require('../electron/services/autoStorySourceEngine');
const {loadDiscovery}=require('../electron/services/autoStorySourcePipeline');
const {resolve}=require('../electron/services/autoStorySourceDiscovery');
const {hash}=require('../electron/services/autoStoryTimelineCompiler');
const {schemas}=require('../electron/services/autoStorySourceContracts');
(async()=>{
  const [configFile,projectFile]=process.argv.slice(2);
  if(!configFile||!projectFile)throw new Error('Pass config and failed V2 project paths.');
  const settings=JSON.parse(await fs.readFile(configFile,'utf8'));
  const project=JSON.parse(await fs.readFile(projectFile,'utf8'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'discovery-recovery-'));
  const service=new Service(settings,{});
  try {
    await service.vertex.assertBudgetAvailable();
    service.vertex.settings={...settings,vertexUsageLedgerPath:path.join(root,'usage.json')};
    service.metricsRoot=root;
    const {cache,duration,identity}=project.autoStorySourceV2;
    for(const f of await fs.readdir(cache)) if(/^v2-discovery-[a-f0-9]+\.json(?:\.repair\.json)?$/.test(f)) await fs.copyFile(path.join(cache,f),path.join(root,f));
    const cues=project.subtitleSourcePath ? Dubbing.normalizeRollingSubtitleCues(await service.dubbing.readSubtitleSegments(project.subtitleSourcePath)) : [];
    const id=`source-${hash({r:{start:0,end:duration},clock:2,fps:4})}`;
    const overview=[{id,file:path.join(cache,`${id}.mp4`),sourceStart:0,duration,
      transcript:cues.filter(c=>c.endSec>0&&c.startSec<duration).map(c=>({sourceStartSec:c.startSec,sourceEndSec:c.endSec,text:c.text}))}];
    let calls=0;
    const generate=service.vertex.generateJsonFromFiles.bind(service.vertex);
    service.vertex.generateJsonFromFiles=async args=>{
      if(args.responseSchema===schemas.discovery)throw new Error('Recovery unexpectedly tried to rediscover the full source.');
      if(++calls>1)throw new Error('Diagnostic permits only one range verification request.');
      return generate(args);
    };
    const engine=new Engine(service,{project,root,cache:root,config:project.autoStoryEditorialConfig,cues,sourceHash:identity,duration,
      onProgress:p=>console.log(p.message)});
    const raw=await loadDiscovery(engine,overview);
    console.log(JSON.stringify({recoveredCandidates:raw.candidates.length,discoveryApiCalls:calls}));
    const resolved=await resolve(engine,raw,overview);
    await fs.writeFile(path.join(root,'resolved.json'),JSON.stringify(resolved,null,2));
    console.log(JSON.stringify({acceptedCandidates:resolved.ranked.length,rejectedCandidates:resolved.rejected.length,corrections:resolved.corrections,calls,diagnosticDirectory:root}));
    if(resolved.repairError||resolved.rejected.length)process.exitCode=1;
  } finally {await service.vertex.dispatcher.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
