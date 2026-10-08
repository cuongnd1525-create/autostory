"use strict";
// Regression: Antigravity returns series-plan JSON as a nested stream-json
// response and the first invalid output must retry in a FRESH conversation.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Stage1 = require("../electron/services/manualAntigravityStage1Service");

const series = {
  profile: "viral_tiktok_crime_part1", durationMinSec: 110, durationMaxSec: 125,
  parts: [
    { scriptId:1, partNumber:1, partBadge:"PART 1", name:"The Incident Begins", ending:"cliffhanger", scope:"Opening" },
    { scriptId:3, partNumber:2, partBadge:"PART 2", name:"The Investigation Deepens", ending:"cliffhanger", scope:"Middle" },
    { scriptId:4, partNumber:3, partBadge:"PART 3", name:"The Verified Outcome", ending:"payoff", scope:"End" }
  ]
};
const range = (sourceStartSec, sourceEndSec) => ({sourceStartSec, sourceEndSec});
const plan = {
  artifactType:"series_plan",schemaVersion:1,profile:series.profile,
  centralViewerQuestion:"How was the incident resolved?", hookPromise:"A verified strange event",
  parts:[
    {scriptId:1,partNumber:1,sceneAllocation:[{...range(0,112),purpose:"start"}],
      hookRange:range(15,26),cliffhanger:"What did the officers discover?",
      cliffhangerRange:range(100,112)},
    {scriptId:3,partNumber:2,sceneAllocation:[{...range(120,234),purpose:"middle"}],
      hookRange:range(121,127),cliffhanger:"Will the evidence explain it?",
      cliffhangerRange:range(221,234)},
    {scriptId:4,partNumber:3,sceneAllocation:[{...range(240,360),purpose:"final"}],
      hookRange:range(245,250),payoff:"The outcome is documented",
      payoffRanges:[range(340,360)]}
  ],
  sharedRanges:[],duplicatePrevention:"No duplicate footage"
};
const packed = JSON.stringify({ artifacts:[{filename:"series-plan.json",script:plan}],notes:"" });
const asStream = value => JSON.stringify({event:"result",result:{status:"SUCCESS",response:value}})+"\n";
const metrics = () => ({retryCount:0,agyProcessCount:0,agentTurns:0,toolCalls:0,inputTokens:0,outputTokens:0,thinkingTokens:0,cacheReadTokens:0,modelSeconds:0,attempts:[]});
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"antigravity-series-plan-"));
  try {
    const understandingPath = path.join(dir,"source-understanding.json");
    const hookPath = path.join(dir,"hook-contract.json");
    const schemaPath = path.join(dir,"antigravity-output-schema.json");
    const transcriptPath = path.join(dir,"source-transcript.srt");
    const manifestPath = path.join(dir,"scene-manifest.json");
    await Promise.all([
      fs.writeFile(understandingPath,'{"videoDurationSec":400,"caseSummary":"verified"}'),
      fs.writeFile(hookPath,'{"selectedHook":1}'),
      fs.writeFile(schemaPath,'{}'),
      fs.writeFile(transcriptPath,'1\n00:00:00,000 --> 00:00:01,000\nOfficer speaking'),
      fs.writeFile(manifestPath,'{"scenes":[]}')
    ]);
    const inputs = {series,pass1Dir:dir,packageInfo:{},resultDir:dir,
      schemaPath,understandingPath,
      inputPaths:{hookContractPath:hookPath,transcriptPath,sceneManifestPath:manifestPath},
      videoDurationSec:400,onProgress:()=>{},metrics:metrics(),logs:[]};
    assert.equal(Stage1.validateSeriesPlan(plan,{series,videoDurationSec:400}).ok,true);
    assert.deepEqual(await Stage1.extractNamedArtifact(asStream(packed),
      {filename:"series-plan.json",artifactType:"series_plan"}),plan,
      "result.response JSON must be parsed");
    const service = new Stage1({ antigravityModel:"Gemini 3.7 Flash (High)" });
    service.emitLog = () => {};
    service.buildCommand = (prompt, _schema, _cwd, options) => ({
      command:"agy",args:["--print="+prompt],timeoutMs:options.timeoutMs
    });
    const called = [];
    const responses = ["NO_JSON_WAS_RETURNED",asStream(packed)];
    service.runAgyPhase = async props => {
      called.push(props);
      // Disallow reading unrelated repository files or delegating to manage_task.
      assert.equal(props.toolGuard({toolName:"view_file",file:understandingPath}),null);
      assert.match(props.toolGuard({toolName:"view_file",file:"C:\\repo\\src\\renderer.js"}),/Không nằm/);
      assert.match(props.toolGuard({toolName:"manage_task",file:""}),/Series Plan/);
      return {stdout:responses.shift()};
    };
    const repaired = await service.runSeriesPlan(inputs);
    assert.equal(repaired.plan.lockedBy,"host_validator");
    assert.equal(called.length,2,"One initial run + at most one FRESH retry");
    assert.equal(called[0].label,"SERIES_PLAN");
    assert.equal(called[1].label,"SERIES_PLAN_RETRY_FRESH");
    assert.equal(called[1].commandConfig.args.some(arg=>arg==="--conversation"),false);
    assert.equal(called[1].commandConfig.timeoutMs<=180000,true);
    assert.match(await fs.readFile(path.join(dir,"antigravity-output-seriesPlan-initial.log"),"utf8"),/NO_JSON/);
    assert.match(await fs.readFile(path.join(dir,"antigravity-output-seriesPlan-fresh-retry.log"),"utf8"),/series-plan/);
    await fs.writeFile(path.join(dir,"series-plan.json"),JSON.stringify(repaired.plan));
    const cached = await service.runSeriesPlan(inputs);
    assert.equal(cached.cacheHit,true,"Valid locked plan + matching source/Hook must skip AGY");
    assert.equal(called.length,2);
    await fs.writeFile(hookPath,'{"selectedHook":2}');
    responses.push(asStream(packed));
    const regenerated = await service.runSeriesPlan(inputs);
    assert.equal(regenerated.cacheHit,false,"Changed locked Hook must invalidate plan cache");
    assert.equal(called.length,3);
    console.log("SeriesPlan extraction, fresh retry, tool guard, provenance cache: PASS");
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
