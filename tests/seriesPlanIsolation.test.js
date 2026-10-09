"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const { createPhaseAwareSpawn, defaultResponder, buildSeriesPlan } = require("./helpers/fakeAntigravity");

async function withFixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-series-plan-isolation-"));
  const pass1Dir = path.join(root, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  await fs.writeFile(path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt"),
    "- prompt_profile: viral_tiktok_crime_part1\nGenerate Script 1, 3 and 4.");
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"),
    JSON.stringify({ videoDurationSec: 90, scenes: [{sceneId:"scene_0001",startSec:0,endSec:90}] }));
  await fs.writeFile(path.join(pass1Dir, "source-transcript.srt"), "1\n00:00:01,000 --> 00:00:05,000\nOpen the door\n");
  await fs.writeFile(path.join(pass1Dir, "analysis-proxy.mp4"), "proxy");
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow:"manual_gemini_draft_review", pass1UploadDir:pass1Dir,
    promptPath:path.join(pass1Dir,"01-gemini-highlight-scripts-prompt.txt"),
    cache:{sourceFingerprint:"case-isolation-test", cacheDir:path.join(root,"source-cache")}
  }));
  try { await fn(root); } finally { await fs.rm(root, {recursive:true,force:true}); }
}
function runner(calls, respond) {
  return new Stage1({
    antigravityCommand:"agy",antigravityModel:"test-model",
    storyFirstEditorialEnabled:false
  }, {
    authProbe:async()=>({expiresAt:new Date(Date.now()+3600000),expiredFlag:false}),
    spawn:createPhaseAwareSpawn({calls,respond})
  });
}

(async()=>{
  // Regression: malformed first answer used to resume the same session, then
  // inspect repo code/write files for six minutes. Fresh retry must not resume.
  await withFixture(async (root)=>{
    const calls=[];
    const normal=defaultResponder({durationSec:90});
    let plans=0;
    const service=runner(calls,(kind,prompt,call)=>{
      if(kind==="series_plan"){
        plans+=1;
        if(plans===1)return {envelope:{artifacts:[], notes:"missing JSON series plan"}};
        assert(prompt.includes("FRESH, ISOLATED SERIES PLAN REGENERATION"),
          "retry must be dedicated bounded creative planning, not self-debugging");
        return {envelope:{artifacts:[{filename:"series-plan.json",script:buildSeriesPlan(90)}]}};
      }
      return normal(kind,prompt,call);
    });
    const outcome=await service.run({packageDir:root});
    const attempts=calls.filter((c)=>c.kind==="series_plan");
    assert.strictEqual(plans,2,"one fresh retry only");
    assert.strictEqual(outcome.validFiles.length,3);
    assert(attempts.every(c=>!c.args.includes("--conversation")),"never resume a contaminated session");
    assert(attempts[1].args.some(a=>a==="--print-timeout"));
    const seconds=Number.parseInt(attempts[1].args[attempts[1].args.indexOf("--print-timeout")+1],10);
    assert(seconds<=180,"fresh retry has its own 180s hard cap");
    const diag=JSON.parse(await fs.readFile(path.join(root,"01-ANTIGRAVITY-RESULT","series-plan-validation-diagnostics.json"),"utf8"));
    assert.strictEqual(diag.repairAttempt.success,true);
    assert(diag.firstAttempt.validationErrors.some((e)=>e.includes("series-plan không phải object")),
      "retain original evidence of failed JSON extraction after a successful repair");
    assert(calls.every(c=>!c.prompt.includes("renderer.js") || c.prompt.includes("Do NOT read")), "no app source investigation");
  });

  // Real CLI may emit final JSON in text_delta fragments with an empty result.
  await withFixture(async(root)=>{
    const calls=[];
    const normal=defaultResponder({durationSec:90});
    const plan=JSON.stringify({artifacts:[{filename:"series-plan.json",script:buildSeriesPlan(90)}]});
    const mid=Math.floor(plan.length/2);
    const service=runner(calls,(kind,prompt,call)=>kind==="series_plan"?{
      extraEvents:[
        {event:"step_update",step_update:{step_index:20,conversation_id:"a",step_type:"agent_response",state:"ACTIVE",text_delta:plan.slice(0,mid)}},
        {event:"step_update",step_update:{step_index:20,conversation_id:"a",step_type:"agent_response",state:"DONE",text_delta:plan.slice(mid)}}
      ],
      resultObject:{status:"SUCCESS"}
    }:normal(kind,prompt,call));
    const outcome=await service.run({packageDir:root});
    assert.strictEqual(outcome.validFiles.length,3,"delta-reconstructed plan is accepted");
    assert.strictEqual(calls.filter(c=>c.kind==="series_plan").length,1,"no unnecessary regeneration");
  });

  // Tool authorization: even a single attempt to roam into manage_task/code
  // editing is stopped rather than allowed to consume the entire token TTL.
  await withFixture(async(root)=>{
    const calls=[];
    const normal=defaultResponder({durationSec:90});
    const service=runner(calls,(kind,prompt,call)=>kind==="series_plan"?{
      extraEvents:[{
        event:"step_update",
        step_update:{step_index:9,conversation_id:"a",step_type:"tool",
          state:"ACTIVE",tool_name:"manage_task",
          tool_info:{name:"manage_task",parameters:{}}}
      }],
      envelope:{artifacts:[{filename:"series-plan.json",script:buildSeriesPlan(90)}]}
    }:normal(kind,prompt,call));
    await assert.rejects(
      service.run({packageDir:root}),
      (e)=>e.kind==="forbidden_tool" || /forbidden_tool|manage_task/i.test(e.message),
      "rogue tool must be blocked before planning can continue");
    assert.strictEqual(calls.filter(c=>c.kind==="series_plan").length,1);
  });

  console.log("series-plan invalid-output isolation, text-delta recovery, and rogue-tool tests passed");
})().catch(e=>{console.error(e);process.exitCode=1});
