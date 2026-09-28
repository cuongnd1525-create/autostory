// Explicit paid integration check, isolated from the user's project and caches.
const fs=require('fs/promises'),path=require('path'),os=require('os');
const Service=require('../electron/services/autoStoryFastService');
const Dubbing=require('../electron/services/dubbingService');
const {Engine}=require('../electron/services/autoStorySourceEngine');
const media=require('../electron/services/autoStorySourceMedia');
const {hash}=require('../electron/services/autoStoryTimelineCompiler');
const hooks=require('../electron/services/autoStoryHookSelection');
(async()=>{
  const [settingsFile,projectFile,resumeRoot,transportMode]=process.argv.slice(2);
  const settings=JSON.parse(await fs.readFile(settingsFile,'utf8'));
  const project=JSON.parse(await fs.readFile(projectFile,'utf8'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hook-selection-check-'));
  if(resumeRoot)for(const f of await fs.readdir(resumeRoot))if(/^v2-.*\.json$/.test(f)||/^source-.*\.mp4$/.test(f))await fs.copyFile(path.join(resumeRoot,f),path.join(root,f));
  const service=new Service(settings,{});
  try{
    await service.vertex.assertBudgetAvailable();
    service.vertex.settings={...settings,vertexUsageLedgerPath:path.join(root,'usage.json')};
    service.metricsRoot=root;
    if(transportMode==='replay'){
      const saved=JSON.parse(await fs.readFile(path.join(resumeRoot,'v2-audition-last-response.json'),'utf8'));
      service.vertex.generateJsonFromFiles=async args=>{
        if(args.responseSchema!==require('../electron/services/autoStorySourceContracts').schemas.audition)throw new Error('Replay must not need another API request.');
        console.log('Replaying saved real Vertex audition; no paid API request.');
        return saved;
      };
    }
    const {cache,duration,identity}=project.autoStorySourceV2;
    const ranking=JSON.parse(await fs.readFile(path.join(path.dirname(projectFile),'analysis','auto-story-fast','candidate-ranking-v2.json'),'utf8'));
    const count=project.autoStoryEditorialConfig.outputCount;
    const candidates=ranking.candidates.filter(c=>c.eligible).slice(0,Math.max(3,Math.min(7,count+2)));
    const cues=Dubbing.normalizeRollingSubtitleCues(await service.dubbing.readSubtitleSegments(project.subtitleSourcePath));
    const evidence=media.merge(candidates,duration,2).map(r=>{
      const id=`source-${hash({r,clock:2,fps:8})}`;
      return {id,file:path.join(cache,`${id}.mp4`),sourceStart:r.start,duration:r.end-r.start,
        transcript:cues.filter(c=>c.endSec>r.start&&c.startSec<r.end).map(c=>({sourceStartSec:c.startSec,sourceEndSec:c.endSec,text:c.text}))};
    });
    for(const e of evidence)await fs.access(e.file);
    const engine=new Engine(service,{root,cache:root,project,duration,sourceHash:identity,cues,config:project.autoStoryEditorialConfig,onProgress:p=>console.log(p.message)});
    const at=Date.now(),result=await hooks.select(engine,candidates,evidence,count);
    await fs.writeFile(path.join(root,'hook-selection.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({good:result.good.map(c=>({title:c.title,hook:c.hook})),rejected:result.rejected.map(c=>({title:c.title,reason:c.rejection})),seconds:(Date.now()-at)/1000,apiCalls:service.callBudget.calls,diagnosticDirectory:root}));
    if(result.good.length<count)process.exitCode=1;
  }finally{await service.vertex.dispatcher.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
