// Explicit live diagnostic (paid API calls), never part of the automatic test suite.
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const Vertex = require('../electron/services/vertexAiService');
const { schemas, base } = require('../electron/services/autoStorySourceContracts');
const { validate } = require('../electron/services/autoStorySchemaBoundary');
function minimal(schema) {
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,minimal(v)]));
  if (schema.type === 'array') return [];
  return schema.enum?.[0] ?? (schema.type === 'number' ? 0 : schema.type === 'boolean' ? false : '');
}
(async () => {
  const [configPath, projectPath] = process.argv.slice(2);
  if (!configPath) throw new Error('Pass local config path and optional failed V2 project path; secrets are never printed.');
  const settings = JSON.parse(await fs.readFile(configPath,'utf8'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'vertex-schema-check-'));
  const service = new Vertex(settings);
  await service.assertBudgetAvailable();
  // Keep diagnostic usage separately; no project/cache mutations.
  service.settings = {...settings,vertexUsageLedgerPath:path.join(root,'usage.json')};
  try {
    const checks = [];
    if (projectPath) {
      const p = JSON.parse(await fs.readFile(projectPath,'utf8'));
      const {cache,duration} = p.autoStorySourceV2;
      const {hash} = require('../electron/services/autoStoryTimelineCompiler');
      const file = path.join(cache,`source-${hash({r:{start:0,end:duration},clock:2,fps:4})}.mp4`);
      await fs.access(file);
      const transcript = p.subtitleSourcePath ? await fs.readFile(p.subtitleSourcePath,'utf8') : '';
      checks.push(['source-discovery', schemas.discovery, {
        filePaths:[file],videoFps:2,mediaResolution:'MEDIA_RESOLUTION_LOW',
        prompt:`${base}\nInspect the full source. Discover 6-10 distinct promising story/angle windows before any full edit. Include contradiction, denial, confession, bizarre excuse, entitlement, officer comeback, evidence reveal, arrest realization, emotional reaction, physical escalation and instant consequence when actually present. Score each dimension 0-10; dependency scores increase with dependency. Prefer truthful complete stories over a forced count; capacityReason explains fewer candidates. Source ranges must include the actual climax AND immediate aftermath, not merely a promise of action.\nINPUT: ${JSON.stringify({duration,candidateCount:8,outputDuration:[65,150]})}\nSOURCE MEDIA: ${JSON.stringify({file:path.basename(file),sourceStartSec:0,sourceEndSec:duration})}\nSOURCE SRT:\n${transcript}`
      }, result => {
        require('../electron/services/autoStorySourceGates').access(result);
        const ranked = require('../electron/services/autoStorySourceGates').rank(result.candidates,duration);
        if (!ranked.length) throw new Error('No candidates returned from actual source.');
        console.log(JSON.stringify({candidateCount:ranked.length,eligible:ranked.filter(c=>c.eligible).length}));
      }]);
    } else {
      for (const [name,schema] of Object.entries(schemas)) checks.push([name,schema,{
        maxOutputTokens:512,prompt:`Schema transport diagnostic only, no media. Output exactly this fixture, no reasoning or extra text: ${JSON.stringify(minimal(schema))}`
      }]);
    }
    for (const [name,schema,args,check] of checks) {
      const at=Date.now();
      try {
        const result = await service.generateJsonFromFiles({...args,modelOverride:'gemini-2.5-flash',responseSchema:schema,
          sourceContract:true,temperature:0,strictRootJson:true,
          onProgress:p=>{if(p.heartbeat) console.log(JSON.stringify({name,message:p.message}));}});
        validate(result,schema); check?.(result);
        await fs.writeFile(path.join(root,`${name}.json`),JSON.stringify(result,null,2));
        console.log(JSON.stringify({name,accepted:true,elapsedMs:Date.now()-at,usage:service.lastUsage}));
      } catch(error) {
        await fs.writeFile(path.join(root,`${name}-error.json`),JSON.stringify({error:error.message,metadata:service.lastResponseMetadata,response:service.lastResponseText},null,2));
        console.log(JSON.stringify({name,accepted:false,error:error.message,elapsedMs:Date.now()-at}));
        process.exitCode=1;
      }
    }
    console.log(JSON.stringify({diagnosticDirectory:root}));
  } finally { await service.dispatcher.close(); }
})().catch(error=>{ console.error(error.message);process.exitCode=1; });
