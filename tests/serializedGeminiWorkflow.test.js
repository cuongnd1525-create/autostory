"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("fs/promises"),path=require("path"),os=require("os");
const {isSerialized,blueprintPrompt,partPrompt,validateBlueprint,validateScriptAgainstBlueprint,importBlueprint}=require("../electron/services/serializedGeminiWorkflowService");
const manifest={sourceVideo:"input.mp4",videoDurationSec:1200,scenes:[{startSec:0,endSec:1200}]};
const makeBlueprint=()=>({
  artifactType:"serialized_story_blueprint",schemaVersion:1,seriesId:"case-1",
  prompt_profile:"serialized_genz",series_mode:"interleaved_multipart",shared_hook_enabled:false,
  shared_top_banner_text:"The Real Case",sourceVideo:"input.mp4",sourceDurationSec:1200,
  centralViewerQuestion:"What happened?",verifiedCausalChain:["The traffic stop escalates"],
  parts:[1,3,4].map((id,i)=>({scriptId:id,part_number:i+1,storyScope:"New verified event "+i,outroPromise:"Question "+i,
    hook:{sourceStartSec:100+i*100,sourceEndSec:108+i*100}}))
});
test("only serialized prompt enables Blueprint-first packaging",()=>{
 assert.equal(isSerialized("prompt_profile: serialized_genz\nseries_mode: interleaved_multipart"),true);
 assert.equal(isSerialized("prompt_profile: independent"),false);
 const prompt=blueprintPrompt("AUTHORITATIVE SOURCE SUMMARY:\n- Source video: input.mp4\n"+
   "STEP 0 - VERIFIED INPUT ACCESS GATE\nsome extra access gate\n"+
   "USER TASK INSTRUCTION - BUILD A 3-PART SERIALIZED TRUE-CRIME SERIES\n"+
   "- prompt_profile: serialized_genz\n- series_mode: interleaved_multipart\n"+
   "### REQUIRED ROOT SCHEMA FOR EACH FILE\n{some huge example}");
 assert.match(prompt,/ONE JSON code block/);
 assert.doesNotMatch(prompt,/some huge example/);
 assert.match(prompt,/Source video: input.mp4/);
});
test("individual prompts request one script at a time with correct mapping and compact schema",()=>{
 for(const [id,n] of [[1,1],[3,2],[4,3]]){
   const prompt=partPrompt(id,"serialized_genz",false,75,110);
   assert.match(prompt,new RegExp("ONLY script-"+id+"\\.json"));
   assert.match(prompt,new RegExp("part_number="+n));
   assert.match(prompt,/OMIT redundant preview_vi/);
   assert.match(prompt,/exactly ONE complete fenced JSON object/i);
 }
});
test("validate blueprint source identity, policy and chapter mapping",()=>{
 const bp=makeBlueprint();
 assert.equal(validateBlueprint(bp,{manifest,profile:"serialized_genz",sharedHook:false}).passed,true);
 bp.shared_hook_enabled=true;
 assert.match(validateBlueprint(bp,{manifest,profile:"serialized_genz",sharedHook:false}).errors.join(" "),/policy mismatch/i);
 bp.shared_hook_enabled=false;
 bp.parts[1].part_number=3;
 assert.match(validateBlueprint(bp,{manifest,profile:"serialized_genz",sharedHook:false}).errors.join(" "),/Part mapping/i);
});
test("script cannot diverge from locked Blueprint",()=>{
 const bp=makeBlueprint();
 const good={artifactType:"highlight_cut_script",scriptId:3,part_number:2,
  prompt_profile:"serialized_genz",series_id:"case-1",shared_hook_enabled:false,
  shared_top_banner_text:"The Real Case",
  segments:[{sceneId:"scene_0003",sourceStartSec:200,sourceEndSec:205,storyFunction:"hook"}]};
 assert.equal(validateScriptAgainstBlueprint(good,bp).passed,true);
 assert.match(validateScriptAgainstBlueprint({...good,series_id:"different"},bp).errors.join(" "),/series_id/);
 assert.match(validateScriptAgainstBlueprint({...good,segments:[{sourceStartSec:100,sourceEndSec:105}]},bp).errors.join(" "),/Hook/);
});
test("Blueprint import validates before persisting, bad source never overwrites previous one",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"series-blueprint-test-"));
 try{
   const info={sequentialSeriesEnabled:true,sequentialSeriesProfile:"serialized_genz",sequentialSeriesSharedHook:false,
     manifestPath:path.join(root,"scene-manifest.json")};
   await fs.writeFile(info.manifestPath,JSON.stringify(manifest));
   await fs.writeFile(path.join(root,"package-info.json"),JSON.stringify(info));
   const input=path.join(root,"sample.json");
   await fs.writeFile(input,JSON.stringify(makeBlueprint()));
   const result=await importBlueprint({packageDir:root,blueprintPath:input});
   assert.equal(result.seriesId,"case-1");
   const accepted=await fs.readFile(result.seriesBlueprintPath,"utf8");
   await fs.writeFile(input,JSON.stringify({...makeBlueprint(),sourceVideo:"wrong.mp4"}));
   await assert.rejects(importBlueprint({packageDir:root,blueprintPath:input}),/Source video mismatch/);
   assert.equal(await fs.readFile(result.seriesBlueprintPath,"utf8"),accepted);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
