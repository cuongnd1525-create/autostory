"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("fs/promises"),path=require("path"),os=require("os");
const {isSerialized,blueprintPrompt,partPrompt,validateBlueprint,validateScriptAgainstBlueprint,importBlueprint}=require("../electron/services/serializedGeminiWorkflowService");
const manifest={sourceVideo:"input.mp4",videoDurationSec:1200,scenes:[{startSec:0,endSec:1200}]};
const makeBlueprint=()=>({
  artifactType:"serialized_story_blueprint",schemaVersion:2,seriesId:"case-1",
  prompt_profile:"serialized_genz",series_mode:"interleaved_multipart",shared_hook_enabled:false,
  shared_top_banner_text:"The Real Case",sourceVideo:"input.mp4",sourceDurationSec:1200,
  centralViewerQuestion:"What happened?",verifiedCausalChain:["The traffic stop escalates"],source_narrator_ranges:[],
  parts:[1,3,4].map((id,i)=>({scriptId:id,part_number:i+1,storyScope:"New verified event "+i,outroPromise:"Question "+i,
    hook:{kind:i===1?"dialogue_conflict":"physical_action",sourceStartSec:100+i*100,sourceEndSec:108+i*100,hookProof:"Verified live action"},
    chapterBeats:[{beatId:`p${i+1}_one`,kind:"context",role:"escalation",sourceStartSec:120+i*100,sourceEndSec:130+i*100,sourceProof:"Verified evidence one",sceneIds:["scene_0001"],mustInclude:true},
      {beatId:`p${i+1}_two`,kind:"dialogue",role:i===2?"consequence":"cliffhanger",sourceStartSec:140+i*100,sourceEndSec:150+i*100,sourceProof:"Verified evidence two",sceneIds:["scene_0001"],mustInclude:true}]}))
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
 assert.match(prompt,/schemaVersion": 2/);
 assert.match(prompt,/chapterBeats/);
 assert.match(prompt,/Do not INVENT evidenceId/);
});
test("individual prompts request one script at a time with correct mapping and compact schema",()=>{
 for(const [id,n] of [[1,1],[3,2],[4,3]]){
   const prompt=partPrompt(id,"serialized_genz",false,75,110);
   assert.match(prompt,new RegExp("ONLY script-"+id+"\\.json"));
   assert.match(prompt,new RegExp("part_number="+n));
   assert.match(prompt,/OMIT redundant preview_vi/);
   assert.match(prompt,/exactly ONE complete fenced JSON object/i);
   assert.match(prompt,/beatId/);
   assert.match(prompt,/actionOverride=false/);
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
  segments:[{sceneId:"scene_0003",sourceStartSec:200,sourceEndSec:205,storyFunction:"hook"},
    {sceneId:"scene_0003",sourceStartSec:220,sourceEndSec:225,audio_mode:"voiceover_only",beatId:"p2_one"},
    {sceneId:"scene_0003",sourceStartSec:240,sourceEndSec:245,audio_mode:"original_audio",beatId:"p2_two"}]};
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

test("narrator source map is immutable across separately generated parts",()=>{
 const bp=makeBlueprint();
 bp.source_narrator_ranges=[{startSec:20,endSec:30,replacementText:"Verified context",confidence:"high"}];
 assert.equal(validateBlueprint(bp,{manifest,profile:"serialized_genz",sharedHook:false}).passed,true);
 const script={scriptId:1,part_number:1,series_id:"case-1",prompt_profile:"serialized_genz",
   shared_top_banner_text:"The Real Case",shared_hook_enabled:false,
   source_narrator_ranges:[],segments:[{sourceStartSec:100,sourceEndSec:105,storyFunction:"hook"}]};
 assert.match(validateScriptAgainstBlueprint(script,bp).errors.join(" "),/source_narrator_ranges/);
});

test("truncated per-Part JSON gives targeted regenerate advice rather than accepting partial segments",()=>{
 const {parseGeminiJsonObject}=require("../electron/services/geminiJsonArtifactService");
 const cut='{"artifactType":"highlight_cut_script","scriptId":3,"segments":[{"sceneId":"scene_0021",';
 assert.throws(()=>parseGeminiJsonObject(cut,"script-3.json"),/xuất LẠI chỉ Script 3/);
 const malformed='{"artifactType":"highlight_cut_script","scriptId":3,"segments":[,]}';
 assert.throws(()=>parseGeminiJsonObject(malformed,"script-3.json"),/không chứa một JSON object hợp lệ/);
});

test("Blueprint v2 rejects sparse, reused and hallucinated chapter beats",()=>{
 const bp=makeBlueprint();
 delete bp.parts[0].chapterBeats;
 assert.match(validateBlueprint(bp,{manifest}).errors.join(" "),/chapterBeats/);
 bp.parts[0].chapterBeats=makeBlueprint().parts[0].chapterBeats;
 bp.parts[1].chapterBeats[0].sourceStartSec=120;
 bp.parts[1].chapterBeats[0].sourceEndSec=125;
 assert.match(validateBlueprint(bp,{manifest}).errors.join(" "),/reuse footage/);
 bp.parts[1].chapterBeats=makeBlueprint().parts[1].chapterBeats;
 bp.parts[0].chapterBeats[0].sourceProof="";
 assert.match(validateBlueprint(bp,{manifest}).errors.join(" "),/sourceProof/);
 bp.parts[0].chapterBeats[0].sourceProof="Verified source proof";
 bp.schemaVersion=1;
 assert.match(validateBlueprint(bp,{manifest}).errors.join(" "),/schemaVersion=2/);
});
test("script must cover core locked footage rather than just the Hook",()=>{
 const bp=makeBlueprint();
 const script={artifactType:"highlight_cut_script",scriptId:3,part_number:2,series_id:"case-1",
   prompt_profile:"serialized_genz",shared_top_banner_text:"The Real Case",shared_hook_enabled:false,source_narrator_ranges:[],
   segments:[{sourceStartSec:200,sourceEndSec:206,storyFunction:"hook",audio_mode:"original_audio"}]};
 assert.match(validateScriptAgainstBlueprint(script,bp).errors.join(" "),/Missing locked chapterBeat p2_one/);
 script.segments.push({sourceStartSec:220,sourceEndSec:223,audio_mode:"voiceover_only",beatId:"p2_one"});
 script.segments.push({sourceStartSec:240,sourceEndSec:244,audio_mode:"original_audio",beatId:"p2_two"});
 assert.equal(validateScriptAgainstBlueprint(script,bp).passed,true);
 script.segments[2].audio_mode="voiceover_only";
 assert.match(validateScriptAgainstBlueprint(script,bp).errors.join(" "),/p2_two/);
 script.segments[2].audio_mode="original_audio";
 script.segments[0].actionOverride=true;
 assert.match(validateScriptAgainstBlueprint(script,bp).errors.join(" "),/Dialogue Hook/);
});
