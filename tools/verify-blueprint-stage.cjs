// Explicit paid check of the real source pipeline; no writes to the user's project.
const fs=require('fs/promises'),os=require('os'),path=require('path');
const Service=require('../electron/services/autoStoryFastService');
const Dubbing=require('../electron/services/dubbingService');
const {Engine}=require('../electron/services/autoStorySourceEngine');
const {discover}=require('../electron/services/autoStorySourcePipeline');
const {schemas}=require('../electron/services/autoStorySourceContracts');
const {hash}=require('../electron/services/autoStoryTimelineCompiler');
const media=require('../electron/services/autoStorySourceMedia');
(async()=>{
  const [configFile,projectFile]=process.argv.slice(2);
  const settings=JSON.parse(await fs.readFile(configFile,'utf8')),project=JSON.parse(await fs.readFile(projectFile,'utf8'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blueprint-check-'));
  const service=new Service(settings,{});
  console.log(`Diagnostic directory: ${root}`);
  try {
    await service.vertex.assertBudgetAvailable();
    service.vertex.settings={...settings,vertexUsageLedgerPath:path.join(root,'usage.json')};
    service.metricsRoot=root;
    const {cache,duration,identity}=project.autoStorySourceV2;
    for(const file of await fs.readdir(cache))if(/\.json$/.test(file))await fs.copyFile(path.join(cache,file),path.join(root,file));
    const cues=Dubbing.normalizeRollingSubtitleCues(await service.dubbing.readSubtitleSegments(project.subtitleSourcePath));
    const engine=new Engine(service,{project,root,cache:root,cues,duration,sourceHash:identity,config:project.autoStoryEditorialConfig,onProgress:p=>console.log(p.message)});
    engine.prepare=async(ranges,padding=0,fps=8)=>{
      const evidence=media.merge(ranges,duration,padding).map(r=>{
        const id=`source-${hash({r,clock:2,fps})}`;
        return {id,file:path.join(cache,`${id}.mp4`),sourceStart:r.start,duration:r.end-r.start,
          transcript:cues.filter(c=>c.endSec>r.start&&c.startSec<r.end).map(c=>({sourceStartSec:c.startSec,sourceEndSec:c.endSec,text:c.text}))};
      });
      for(const e of evidence)await fs.access(e.file);
      return evidence;
    };
    let calls=0;
    const generate=service.vertex.generateJsonFromFiles.bind(service.vertex);
    service.vertex.generateJsonFromFiles=async args=>{
      if(args.responseSchema!==schemas.blueprints || ++calls>1)throw new Error('Diagnostic allows one blueprint request only; previous stages must use existing cache.');
      await fs.writeFile(path.join(root,'blueprint-input.json'),JSON.stringify({prompt:args.prompt,sourceFiles:args.filePaths,schema:args.responseSchema},null,2));
      return generate(args);
    };
    const started=Date.now();
    const plan=await discover(engine,await engine.prepare([{sourceStartSec:0,sourceEndSec:duration}],0,4),project.autoStoryEditorialConfig.outputCount);
    await fs.writeFile(path.join(root,'plan.json'),JSON.stringify(plan,null,2));
    console.log(JSON.stringify({stories:plan.stories.length,calls,seconds:(Date.now()-started)/1000,warning:plan.capacityWarning,diagnosticDirectory:root}));
    if(plan.stories.length!==project.autoStoryEditorialConfig.outputCount)process.exitCode=1;
  }finally{await service.vertex.dispatcher.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
