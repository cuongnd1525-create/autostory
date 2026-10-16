"use strict";
const fs=require("fs/promises");
const path=require("path");
const {parseGeminiJsonObject}=require("./geminiJsonArtifactService");
const PART_IDS=[1,3,4];
const str=v=>String(v==null?"":v).trim();
const num=v=>(v==null||v===""||!Number.isFinite(Number(v)))?NaN:Number(v);
const isSerialized=prompt=>/prompt_profile:\s*(serialized_genz|serialized_interleaved)\b/.test(str(prompt))&&/series_mode:\s*interleaved_multipart/.test(str(prompt));

function blueprintPrompt(direct) {
  if(!isSerialized(direct))throw Error("Sequential output requires serialized profile.");
  const text=str(direct),sourceStart=text.indexOf("AUTHORITATIVE SOURCE SUMMARY:");
  const editorialStart=text.indexOf("USER TASK INSTRUCTION - BUILD A 3-PART SERIALIZED TRUE-CRIME SERIES");
  if(sourceStart<0||editorialStart<0)throw Error("Missing serialized source/editorial section.");
  const source=text.slice(sourceStart,editorialStart)
    .replace(/STEP 0 - VERIFIED INPUT ACCESS GATE[\s\S]*$/,"");
  const editorial=text.slice(editorialStart).replace(/### REQUIRED ROOT SCHEMA FOR EACH FILE[\s\S]*$/,"");
  const instruction=[
    "GEMINI SERIALIZED TRUE CRIME — STAGE 0 OF 4 — SERIES BLUEPRINT ONLY",
    "All uploaded proxy chunks and transcript must be examined in this SAME chat; verify absolute source timestamps and scene boundaries.",
    "The local action-candidate ranking is NOT evidence of semantic importance. The user-locked hook-contract.json, if supplied, is authoritative.",
    "Do NOT generate any script JSON yet. Decide one case, the actual causality, and 3 distinct chapters, hooks, unresolved cliffhangers and last verified consequence.",
    "Return exactly ONE JSON code block (save as series-blueprint.json), nothing else:",
    JSON.stringify({
      artifactType:"serialized_story_blueprint",schemaVersion:1,seriesId:"stable-source-case-id",
      prompt_profile:"serialized_genz",series_mode:"interleaved_multipart",shared_hook_enabled:false,
      shared_top_banner_text:"One factual common banner",sourceVideo:"actual-source.mp4",
      sourceDurationSec:1000,centralViewerQuestion:"One central verified question",
      verifiedCausalChain:["Verified source event with absolute timestamps"],
      parts:[
        {scriptId:1,part_number:1,role:"setup_and_escalation",hook:{sourceStartSec:20,sourceEndSec:30},storyScope:"Distinct verified chapter",outroPromise:"Verified unresolved turning point"},
        {scriptId:3,part_number:2,role:"escalation_and_revelation",hook:{sourceStartSec:40,sourceEndSec:50},storyScope:"Next verified chapter",outroPromise:"Verified unresolved turning point"},
        {scriptId:4,part_number:3,role:"verified_climax_and_outcome",hook:{sourceStartSec:60,sourceEndSec:70},storyScope:"Final verified chapter",outroPromise:"Verified outcome or last documented consequence"}
      ]},null,2),
    "The numbers and placeholders above are examples ONLY. Use the actual sourceVideo, duration, selected profile and shared-hook policy below.",
    "For shared_hook_enabled=true, all 3 Part hook source ranges MUST match; otherwise Part hooks should be distinct.",
    "Blueprint must be source-grounded and remain LOCKED during subsequent script turns.",
    "VALIDATE the complete JSON.parse response. Do not send any Part segments in this turn."
  ];
  return [instruction.join("\n"),"SOURCE & CANDIDATES:\n"+source,editorial].join("\n\n");
}
function partPrompt(scriptId,profile="serialized_genz",sharedHook=false, min=75,max=110) {
  const n=PART_IDS.indexOf(Number(scriptId))+1;
  if(!n)throw Error("Unsupported series scriptId: "+scriptId);
  return [
    "GEMINI SERIALIZED TRUE CRIME — STAGE "+n+" OF 3 — SCRIPT "+scriptId+" ONLY",
    "Stay in the SAME Gemini chat that watched all uploaded video and generated series-blueprint.json.",
    "Use the VERIFIED series-blueprint.json from this chat as a LOCKED plan. Do not revise its seriesId, event ranges, title, Part boundaries, hooks, chapter question or true outcome.",
    "Write ONLY script-"+scriptId+".json for Part "+n+". DO NOT output the other Parts, and do not output another Blueprint.",
    n>1?"Maintain continuity with prior scripts; do not repeat their body footage or narration.":"Follow only the Part 1 story scope from the Blueprint.",
    "The response is exactly ONE complete fenced JSON object, with artifactType=highlight_cut_script, schemaVersion=1, scriptId="+scriptId+", part_number="+n+", prompt_profile="+profile+", series_mode=interleaved_multipart.",
    "Copy Blueprint's seriesId to series_id, its shared_top_banner_text and shared_hook_enabled="+sharedHook+".",
    "For the Hook, obey Blueprint Part "+n+"'s source range"+(sharedHook?" (identical across all Parts).":" (chapter-specific).")+" If hook-contract.json was explicitly locked, obey it.",
    "Preserve true causal sequence, source speech and complete action, narrator-source mute, original-audio integrity, cliffhanger policy, no invented events, and pacing exceptions from the original master editorial prompt.",
    "Require a nonempty segments array. Every segment: sceneId, sourceStartSec, sourceEndSec, playbackSpeed, storyFunction, audio_mode, voiceover_text (empty for original_audio), source_narrator_detected and a short transitionReason.",
    "Only include macroBlockId, sourceRunId, actionSequenceId, sustainedBeatId when needed to keep cross-scene complete beats together. OMIT redundant preview_vi, caption, action_notes and repeated scene descriptions; this is COMPACT JSON.",
    "Use original video absolute timestamps from the uploaded proxy; ONE sceneId per segment. The local tool calculates output start/end/duration; NEVER write outputStartSec, outputEndSec, startSec or endSec for segment output.",
    "Keep the Part's computed duration between "+min+"s and "+max+"s. Cross-check source narration ranges and never invent legal outcomes.",
    "Return precisely ONE fenced JSON code block parseable by JSON.parse; ALL arrays and braces must be closed. No text outside.",
    "Save it as script-"+scriptId+".json. "+(n===1?"Next prompt: script-3.":n===2?"Next prompt: script-4.":"All three scripts complete; select the three JSON files in RecapTool Studio.")
  ].join("\n\n");
}
function validateBlueprint(bp,{manifest={},profile="",sharedHook}={}) {
 const errors=[],parts=bp?.parts;
 if(str(bp?.artifactType)!=="serialized_story_blueprint")errors.push("Wrong artifactType.");
 if(str(bp?.series_mode)!=="interleaved_multipart")errors.push("Wrong series_mode.");
 if(!str(bp?.seriesId))errors.push("seriesId missing.");
 if(!str(bp?.shared_top_banner_text))errors.push("shared_top_banner_text missing.");
 if(!str(bp?.centralViewerQuestion)||!Array.isArray(bp?.verifiedCausalChain)||!bp.verifiedCausalChain.length)errors.push("Verified case plan missing.");
 if(profile&&str(bp?.prompt_profile)!==profile)errors.push("Profile mismatch.");
 if(typeof sharedHook==="boolean"&&bp?.shared_hook_enabled!==sharedHook)errors.push("Shared Hook policy mismatch.");
 if(manifest?.sourceVideo&&path.basename(str(bp?.sourceVideo))!==path.basename(manifest.sourceVideo))errors.push("Source video mismatch.");
 if(Number.isFinite(num(manifest?.videoDurationSec))&&Math.abs(num(bp?.sourceDurationSec)-num(manifest.videoDurationSec))>0.3)errors.push("Source duration mismatch.");
 if(!Array.isArray(parts)||parts.length!==3)errors.push("Exactly three chapter plans required.");
 else {
  for(let i=0;i<3;i++){
   const p=parts.find(x=>num(x.scriptId)===PART_IDS[i]);
   if(!p||num(p.part_number)!==i+1){errors.push("Part mapping incorrect for script "+PART_IDS[i]);continue;}
   if(!str(p.storyScope)||!str(p.outroPromise))errors.push("Part "+(i+1)+" missing scope or cliffhanger.");
   const a=num(p.hook?.sourceStartSec),b=num(p.hook?.sourceEndSec);
   if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<=a||b>num(manifest?.videoDurationSec)+0.3)errors.push("Part "+(i+1)+" invalid Hook range.");
  }
  if(bp?.shared_hook_enabled){
   const starts=parts.map(p=>num(p.hook?.sourceStartSec)),ends=parts.map(p=>num(p.hook?.sourceEndSec));
   if(starts.some(v=>Math.abs(v-starts[0])>0.15)||ends.some(v=>Math.abs(v-ends[0])>0.15))errors.push("Shared Hook source ranges must match.");
  }
 }
 return {passed:errors.length===0,errors};
}
function validateScriptAgainstBlueprint(script,bp){
 const errors=[],id=num(script.scriptId??script.script_id),plan=bp.parts.find(p=>num(p.scriptId)===id);
 if(!plan)errors.push("Unknown scriptId "+id);
 if(str(script.series_id||script.seriesId)!==str(bp.seriesId))errors.push("series_id changed from locked Blueprint.");
 if(str(script.shared_top_banner_text||script.sharedTopBannerText)!==str(bp.shared_top_banner_text))errors.push("Shared title changed from locked Blueprint.");
 if(script.shared_hook_enabled!==bp.shared_hook_enabled)errors.push("Shared Hook policy changed.");
 if(str(script.prompt_profile)!==str(bp.prompt_profile))errors.push("Profile changed.");
 if(plan){
  if(num(script.part_number??script.partNumber)!==num(plan.part_number))errors.push("Part number mismatch.");
  const segments=script.segments||[],first=segments[0],a=num(first?.sourceStartSec);
  if(!first||Math.abs(a-num(plan.hook.sourceStartSec))>2.1)errors.push("Opening Hook is outside locked Blueprint tolerance.");
 }
 return {passed:errors.length===0,errors};
}
async function importBlueprint({packageDir,blueprintPath}={}){
 if(!packageDir||!blueprintPath)throw Error("Choose a Series package and Blueprint JSON.");
 const infoPath=path.join(packageDir,"package-info.json");
 const info=JSON.parse(await fs.readFile(infoPath,"utf8"));
 if(!info.sequentialSeriesEnabled)throw Error("This package does not use sequential Series output.");
 const manifest=JSON.parse(await fs.readFile(info.manifestPath,"utf8"));
 const bp=parseGeminiJsonObject(await fs.readFile(blueprintPath,"utf8"),path.basename(blueprintPath));
 const result=validateBlueprint(bp,{manifest,profile:info.sequentialSeriesProfile,sharedHook:info.sequentialSeriesSharedHook});
 if(!result.passed)throw Error("Invalid Series Blueprint: "+result.errors.join(" | "));
 const target=path.join(packageDir,"series-blueprint.json"),temp=target+".tmp-"+process.pid;
 try{await fs.writeFile(temp,JSON.stringify(bp,null,2),"utf8");await fs.rename(temp,target);}
 finally{await fs.rm(temp,{force:true}).catch(()=>{});}
 info.seriesBlueprintPath=target;
 await fs.writeFile(infoPath,JSON.stringify(info,null,2),"utf8");
 return {seriesBlueprintPath:target,seriesId:bp.seriesId,parts:bp.parts.map(p=>p.scriptId)};
}
module.exports={isSerialized,blueprintPrompt,partPrompt,validateBlueprint,validateScriptAgainstBlueprint,importBlueprint};
