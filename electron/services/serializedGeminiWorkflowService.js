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
  const profile=(text.match(/- prompt_profile:\s*(serialized_genz|serialized_interleaved)/)||[])[1]||"serialized_genz";
  const sharedHook=/- shared cold open:\s*true/i.test(text);
  const sourceName=(text.match(/- Source video:\s*(.+)/)||[])[1]?.trim()||"";
  const sourceDuration=Number((text.match(/- Source duration:\s*([\d.]+)/)||[])[1]);
  const instruction=[
    "GEMINI SERIALIZED TRUE CRIME — STAGE 0 OF 4 — SERIES BLUEPRINT ONLY",
    "All uploaded proxy chunks and transcript must be examined in this SAME chat; verify absolute source timestamps and scene boundaries.",
    "The local action-candidate ranking is NOT evidence of semantic importance. The user-locked hook-contract.json, if supplied, is authoritative.",
    "Do NOT generate any script JSON yet. Decide one case and 3 distinct verified chapters with strong Hooks, chapterBeats, cliffhangers and the last verified consequence.",
    "BLUEPRINT V2: Each Part MUST contain 2-6 non-Hook chapterBeats in narrative sequence. Each beat has a unique beatId, kind (dialogue|action|visual|context), role, absolute sourceStartSec/sourceEndSec, actual sceneIds, sourceProof (real quote or directly visible event), and mustInclude=true. These are mandatory SOURCE EVIDENCE ANCHORS, not timeline edit segments.",
    "Hook must include kind (dialogue_conflict|physical_action|mixed|visual_reveal), source time range and hookProof. A verbal confrontation is NOT a physical action: it uses sustainedBeatOverride when needed; actionOverride is ONLY for a verified physical action.",
    "Do not INVENT evidenceId, sourceRunId, actionCandidateId or sceneId. Use verified source ranges and real sceneIds from supplied manifest. Core chapterBeats must not overlap across Parts, except the separately defined shared Hook when opted in.",
    "Part 1/2 last beat is a complete spoken or visible unresolved cliffhanger; Part 3 last beat is the last verified consequence. Mark beat sourceProof exactly so later Script import can check source-range coverage.",
    "Return exactly ONE JSON code block (save as series-blueprint.json), nothing else:",
    JSON.stringify({
      artifactType:"serialized_story_blueprint",schemaVersion:2,seriesId:"stable-source-case-id",
      prompt_profile:profile,series_mode:"interleaved_multipart",shared_hook_enabled:sharedHook,
      shared_top_banner_text:"One factual common banner",sourceVideo:sourceName,
      sourceDurationSec:Number.isFinite(sourceDuration)?sourceDuration:0,centralViewerQuestion:"One central verified question",
      verifiedCausalChain:["Verified source event with absolute timestamps"],
      source_narrator_ranges:[],
      parts:[
        {scriptId:1,part_number:1,role:"setup_and_escalation",hook:{kind:"dialogue_conflict",sourceStartSec:20,sourceEndSec:30,hookProof:"Verified real Hook dialogue"},storyScope:"Distinct verified chapter",outroPromise:"Verified unresolved turning point",chapterBeats:[
          {beatId:"p1_beat_01",kind:"context",role:"setup",sourceStartSec:100,sourceEndSec:110,sceneIds:["scene_0001"],sourceProof:"Verified source context",mustInclude:true},
          {beatId:"p1_beat_02",kind:"dialogue",role:"cliffhanger",sourceStartSec:120,sourceEndSec:130,sceneIds:["scene_0002"],sourceProof:"Verified full quote/reaction",mustInclude:true}]},
        {scriptId:3,part_number:2,role:"escalation_and_revelation",hook:{kind:"physical_action",sourceStartSec:40,sourceEndSec:50,hookProof:"Visible actual event"},storyScope:"Next verified chapter",outroPromise:"Verified unresolved turning point",chapterBeats:[
          {beatId:"p2_beat_01",kind:"dialogue",role:"escalation",sourceStartSec:200,sourceEndSec:210,sceneIds:["scene_0003"],sourceProof:"Verified confrontation",mustInclude:true},
          {beatId:"p2_beat_02",kind:"dialogue",role:"cliffhanger",sourceStartSec:220,sourceEndSec:230,sceneIds:["scene_0004"],sourceProof:"Verified contradiction",mustInclude:true}]},
        {scriptId:4,part_number:3,role:"verified_climax_and_outcome",hook:{kind:"mixed",sourceStartSec:60,sourceEndSec:70,hookProof:"Verified final chapter Hook"},storyScope:"Final verified chapter",outroPromise:"Verified outcome or last documented consequence",chapterBeats:[
          {beatId:"p3_beat_01",kind:"action",role:"climax",sourceStartSec:300,sourceEndSec:310,sceneIds:["scene_0005"],sourceProof:"Actual event proof",mustInclude:true},
          {beatId:"p3_beat_02",kind:"visual",role:"consequence",sourceStartSec:320,sourceEndSec:330,sceneIds:["scene_0006"],sourceProof:"Last documented consequence",mustInclude:true}]}
      ]},null,2),
    "All sample timestamps, sceneIds, beatIds, Hook types and sourceProof text are PLACEHOLDERS. Replace EVERY example from actual watched source. Do not assume sample IDs are real.",
    "For shared_hook_enabled=true, all 3 Part hook source ranges MUST match; otherwise Part hooks should be distinct.",
    "Include source_narrator_ranges with verified external YouTube narrator intervals, replacementText and confidence; use [] if genuinely none, never guess.",
    "Blueprint must be source-grounded and remain LOCKED during subsequent script turns. Each Script MUST include every mustInclude chapterBeat assigned to its own Part; do not replace proof with narration-only summary.",
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
    "Use the VERIFIED series-blueprint.json from this chat as a LOCKED plan. Do not revise seriesId, ranges, chapterBeats, title, Part boundaries, hooks, chapter question or outcome. Include verified source footage covering EVERY mustInclude chapterBeat for this Part.",
    "Write ONLY script-"+scriptId+".json for Part "+n+". DO NOT output the other Parts, and do not output another Blueprint.",
    n>1?"Maintain continuity with prior scripts; do not repeat their body footage or narration.":"Follow only the Part 1 story scope from the Blueprint.",
    "The response is exactly ONE complete fenced JSON object, with artifactType=highlight_cut_script, schemaVersion=1, scriptId="+scriptId+", part_number="+n+", prompt_profile="+profile+", series_mode=interleaved_multipart.",
    "Include truthful inputAccessAudit and a compact story_blueprint with partQuestion, partPayoffOrCliffhanger and macroBlocks. Never claim you watched an unavailable input.",
    "Copy Blueprint's seriesId to series_id, its shared_top_banner_text and shared_hook_enabled="+sharedHook+".",
    "Copy EXACTLY Blueprint's source_narrator_ranges into this Script. Keep it identical in all three JSON outputs.",
    "For the Hook, obey Blueprint Part "+n+"'s source range"+(sharedHook?" (identical across all Parts).":" (chapter-specific).")+" If hook-contract.json was explicitly locked, obey it.",
    "MANDATORY ASYMMETRIC PACING: 3-8s punchy VO bridges (max 10s) -> complete original_audio proof. Routine recounts generally 5-8s; genuine question/denial/pushback exchanges may run 12-25s; physical action may run 15-30s+. SOFT targets only: a complete sentence, answer and immediate reaction override any timer, including strict_10. Never force alternation inside a sustainedBeatOverride or actionOverride.",
    "VOICEOVER PROMISE GATE: When narration says someone confesses, accuses, snitches or admits a lie, the immediately following selected clip MUST contain the exact response; otherwise phrase the setup as an unresolved question. For such assertions, add payoffProof with quote, sourceStartSec and sourceEndSec; avoid unsupported narration.",
    "B-ROLL / CAPTIONS: Set original_audio caption=\"\" and voiceover_text=\"\"; do not use action_notes as subtitle text. Avoid burned-in dialogue captions as background for muted voiceover. Verify external narrator tails and black-frame transitions using source video; do not use blind fixed +0.6s padding.",
    "ENDINGS: Parts 1/2 end after a complete spoken sentence or meaningful reaction, not mid-word or mid-sentence. Optionally finish with a verified 3-5s VO cliffhanger. Preserve true causal sequence, original audio and locked source ranges.",
    "For every selected chapterBeat, use its locked beatId on the covering segment(s), and show its verified sourceProof in the actual clip. Cut dead air around it but NEVER omit the decisive quote, action or reaction. Non-Hook core beats belong ONLY to their assigned Part.",
    "For a dialogue-only Hook, set actionOverride=false and use sustainedBeatOverride=true for a multi-scene complete exchange. Use actionOverride=true only for verified physical action (or an actual physical-action portion of a mixed Hook).",
    "Require a nonempty segments array. Every segment: sceneId, sourceStartSec, sourceEndSec, playbackSpeed, storyFunction, audio_mode, voiceover_text (empty for original_audio), source_narrator_detected and a short transitionReason.",
    "Only include macroBlockId, sourceRunId, actionSequenceId, sustainedBeatId, completeNarrativeBeat, sustainedBeatOverride or actionOverride when needed to preserve cross-scene beats. Include payoffProof ONLY for a definite verbal promise about the following audio. OMIT redundant preview_vi, caption, action_notes and scene descriptions; this is COMPACT JSON.",
    "Use original video absolute timestamps from the uploaded proxy; ONE sceneId per segment. The local tool calculates output start/end/duration; NEVER write outputStartSec, outputEndSec, startSec or endSec for segment output.",
    "Keep the Part's computed duration between "+min+"s and "+max+"s. Cross-check source narration ranges and never invent legal outcomes.",
    "Return precisely ONE fenced JSON code block parseable by JSON.parse; ALL arrays and braces must be closed. No text outside.",
    "Save it as script-"+scriptId+".json. "+(n===1?"Next prompt: script-3.":n===2?"Next prompt: script-4.":"All three scripts complete; select the three JSON files in RecapTool Studio.")
  ].join("\n\n");
}

function checkChapterBeats(bp,manifest){
  const errors=[],seen=new Set(),windows=[];
  const videoEnd=num(manifest?.videoDurationSec);
  const sourceEnd=Number.isFinite(videoEnd)?videoEnd:num(bp?.sourceDurationSec);
  const sceneMap=new Map((manifest?.scenes||[])
    .filter(s=>str(s.sceneId||s.id))
    .map(s=>[str(s.sceneId||s.id),s]));
  for(let i=0;i<3;i++){
    const part=(bp.parts||[]).find(p=>num(p.scriptId)===PART_IDS[i]);
    if(!part)continue;
    if(!["dialogue_conflict","physical_action","mixed","visual_reveal"].includes(str(part.hook?.kind))
       || !str(part.hook?.hookProof))errors.push("Part "+(i+1)+" Hook needs verified kind and hookProof.");
    const beats=part.chapterBeats;
    if(!Array.isArray(beats)||beats.length<2||beats.length>8){
      errors.push("Part "+(i+1)+" requires 2-8 locked chapterBeats, not only Hook/summary.");
      continue;
    }
    for(const [j,b] of beats.entries()){
      const id=str(b.beatId),a=num(b.sourceStartSec),z=num(b.sourceEndSec);
      if(!id||seen.has(id))errors.push("Missing or duplicated chapterBeat beatId: "+(id||"(empty)"));
      seen.add(id);
      if(!["dialogue","action","visual","context"].includes(str(b.kind)))
        errors.push("Part "+(i+1)+" chapterBeat "+id+" has invalid kind.");
      if(!str(b.role)||!str(b.sourceProof))
        errors.push("Part "+(i+1)+" chapterBeat "+id+" needs a role and real sourceProof.");
      if(b.mustInclude!==true)errors.push("Part "+(i+1)+" chapterBeat "+id+" mustInclude must be true.");
      if(!Number.isFinite(a)||!Number.isFinite(z)||a<0||z<=a||!Number.isFinite(sourceEnd)||z>sourceEnd+0.3)
        errors.push("Part "+(i+1)+" chapterBeat "+id+" has invalid source time range.");
      if(!Array.isArray(b.sceneIds)||!b.sceneIds.length||b.sceneIds.some(s=>!str(s)))
        errors.push("Part "+(i+1)+" chapterBeat "+id+" needs source-verified sceneIds.");
      else if(sceneMap.size){
        if(b.sceneIds.some(s=>!sceneMap.has(str(s))))
          errors.push("Part "+(i+1)+" chapterBeat "+id+" references unknown sceneId.");
        else if(Number.isFinite(a)&&Number.isFinite(z) && !b.sceneIds.some(s=>{
          const scene=sceneMap.get(str(s));
          return num(scene.startSec)<z && num(scene.endSec)>a;
        }))errors.push("Part "+(i+1)+" chapterBeat "+id+" sceneIds do not overlap source range.");
      }
      if(Number.isFinite(a)&&Number.isFinite(z)&&z>a){
        windows.push({part:i+1,id,a,z});
        if(Math.min(z,num(part.hook?.sourceEndSec))-Math.max(a,num(part.hook?.sourceStartSec))>0.25)
          errors.push("Part "+(i+1)+" chapterBeat "+id+" repeats its own Hook.");
      }
      if(j===beats.length-1 && i<2 && !["cliffhanger","escalation","contradiction","reveal"].includes(str(b.role)))
        errors.push("Part "+(i+1)+" final chapterBeat should preserve a verified unresolved turn.");
      if(j===beats.length-1 && i===2 && !["resolution","consequence","payoff"].includes(str(b.role)))
        errors.push("Part 3 last chapterBeat must show the final verified consequence.");
    }
  }
  for(let i=0;i<windows.length;i++)for(let j=i+1;j<windows.length;j++){
    const a=windows[i],b=windows[j];
    if(a.part!==b.part&&Math.min(a.z,b.z)-Math.max(a.a,b.a)>0.25)
      errors.push("Core chapterBeats reuse footage across Parts "+a.part+"/"+b.part+": "+a.id+" / "+b.id);
  }
  return errors;
}
function coveredSourceSeconds(segments,beat){
  const a=num(beat.sourceStartSec),b=num(beat.sourceEndSec),ranges=[];
  if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a)return 0;
  for(const s of segments){
    const x=num(s.sourceStartSec??s.source_start_sec),y=num(s.sourceEndSec??s.source_end_sec);
    if(!Number.isFinite(x)||!Number.isFinite(y)||y<=x)continue;
    if(str(beat.kind)==="dialogue"&&str(s.audio_mode||s.audioMode)!=="original_audio")continue;
    const start=Math.max(a,x),end=Math.min(b,y);
    if(end>start)ranges.push([start,end]);
  }
  ranges.sort((x,y)=>x[0]-y[0]);
  const merged=[];
  for(const span of ranges){
    const last=merged.at(-1);
    if(last&&span[0]<=last[1])last[1]=Math.max(last[1],span[1]);
    else merged.push([...span]);
  }
  return merged.reduce((total,r)=>total+r[1]-r[0],0);
}

function validateBlueprint(bp,{manifest={},profile="",sharedHook,hookContract=null}={}) {
 const errors=[],parts=bp?.parts;
 if(str(bp?.artifactType)!=="serialized_story_blueprint")errors.push("Wrong artifactType.");
 if(num(bp?.schemaVersion)!==2)errors.push("Blueprint schemaVersion=2 required with chapterBeats. Regenerate Stage 0 using the updated Gemini package.");
 if(str(bp?.series_mode)!=="interleaved_multipart")errors.push("Wrong series_mode.");
 if(!str(bp?.seriesId))errors.push("seriesId missing.");
 if(!str(bp?.shared_top_banner_text))errors.push("shared_top_banner_text missing.");
 if(!str(bp?.centralViewerQuestion)||!Array.isArray(bp?.verifiedCausalChain)||!bp.verifiedCausalChain.length)errors.push("Verified case plan missing.");
 if(!Array.isArray(bp?.source_narrator_ranges)) errors.push("source_narrator_ranges must be an array (possibly empty).");
 else for(const range of bp.source_narrator_ranges) {
  if(!Number.isFinite(num(range.startSec))||!Number.isFinite(num(range.endSec))||num(range.endSec)<=num(range.startSec)||!str(range.replacementText))errors.push("Invalid external narrator range.");
 }
 if(profile&&str(bp?.prompt_profile)!==profile)errors.push("Profile mismatch.");
 if(typeof sharedHook==="boolean"&&bp?.shared_hook_enabled!==sharedHook)errors.push("Shared Hook policy mismatch.");
 if(manifest?.sourceVideo&&path.basename(str(bp?.sourceVideo))!==path.basename(manifest.sourceVideo))errors.push("Source video mismatch.");
 if(Number.isFinite(num(manifest?.videoDurationSec))&&Math.abs(num(bp?.sourceDurationSec)-num(manifest.videoDurationSec))>0.3)errors.push("Source duration mismatch.");
 if(!Array.isArray(parts)||parts.length!==3)errors.push("Exactly three chapter plans required.");
 else errors.push(...checkChapterBeats(bp,manifest));
 else {
  for(let i=0;i<3;i++){
   const p=parts.find(x=>num(x.scriptId)===PART_IDS[i]);
   if(!p||num(p.part_number)!==i+1){errors.push("Part mapping incorrect for script "+PART_IDS[i]);continue;}
   if(!str(p.storyScope)||!str(p.outroPromise))errors.push("Part "+(i+1)+" missing scope or cliffhanger.");
   const a=num(p.hook?.sourceStartSec),b=num(p.hook?.sourceEndSec);
   if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<=a||b>num(manifest?.videoDurationSec)+0.3)errors.push("Part "+(i+1)+" invalid Hook range.");
  }
  if(hookContract?.isUserLocked){
   for(let i=0;i<3;i++){
    const part=parts.find(p=>num(p.scriptId)===[1,3,4][i]);
    const anchorIndex=bp.shared_hook_enabled?1:i+1;
    const entry=hookContract.isMultiVariant
      ? hookContract.variants?.["variant_0"+anchorIndex]
      : i===0 || bp.shared_hook_enabled ? hookContract : null;
    if(!entry?.anchorRange||!part?.hook)continue;
    const expectedStart=num(entry.anchorRange.startSec),actualStart=num(part.hook.sourceStartSec);
    const expectedEnd=num(entry.anchorRange.endSec),actualEnd=num(part.hook.sourceEndSec);
    const early=num(entry.trimmingTolerance?.startOffsetMaxSec);
    const late=num(entry.trimmingTolerance?.endOffsetMaxSec);
    if(!Number.isFinite(actualStart)||actualStart<expectedStart-(Number.isFinite(early)?early:2)-0.2
      ||actualStart>expectedEnd+(Number.isFinite(late)?late:3)
      ||actualEnd<expectedStart-(Number.isFinite(early)?early:2)){
      errors.push("Part "+(i+1)+" Blueprint Hook disagrees with user-locked Hook Contract.");
    }
   }
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
 const signature=list=>JSON.stringify((list||[]).map(x=>({
  startSec:num(x.startSec),endSec:num(x.endSec),replacementText:str(x.replacementText),confidence:str(x.confidence)
 })));
 if(signature(script.source_narrator_ranges)!==signature(bp.source_narrator_ranges))errors.push("source_narrator_ranges differ from locked Blueprint.");
 if(plan){
  if(num(script.part_number??script.partNumber)!==num(plan.part_number))errors.push("Part number mismatch.");
  const segments=script.segments||[],first=segments[0],a=num(first?.sourceStartSec);
  if(!first||Math.abs(a-num(plan.hook.sourceStartSec))>2.1)errors.push("Opening Hook is outside locked Blueprint tolerance.");
  const hookSegments=[];
  for(const s of segments){if(!hookSegments.length||/hook/i.test(str(s.storyFunction||s.story_function)))hookSegments.push(s);else break;}
  if(str(plan.hook?.kind)==="dialogue_conflict"&&hookSegments.some(s=>s.actionOverride===true||s.action_override===true))
    errors.push("Dialogue Hook may not use actionOverride=true; use sustainedBeatOverride for complete exchange.");
  const beats=Array.isArray(plan.chapterBeats)?plan.chapterBeats:[];
  const allowed=new Set(beats.map(b=>str(b.beatId)));
  for(const segment of segments){const id=str(segment.beatId||segment.beat_id);if(id&&!allowed.has(id))errors.push("Segment references chapterBeat outside its locked Part: "+id);}
  for(const beat of beats.filter(b=>b.mustInclude===true)){
    const duration=num(beat.sourceEndSec)-num(beat.sourceStartSec);
    const minimum=Math.min(3,Math.max(1,duration*0.4));
    const actual=coveredSourceSeconds(segments,beat);
    if(actual+0.05<minimum)errors.push("Missing locked chapterBeat "+str(beat.beatId)+" in Part "+num(plan.part_number)+": only "+actual.toFixed(2)+"s of verified source range selected.");
  }
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
 const contractPath=path.join(packageDir,"01-GUI-GEMINI","hook-contract.json");
 const hookContract=await fs.readFile(contractPath,"utf8").then(JSON.parse).catch(()=>null);
 const result=validateBlueprint(bp,{manifest,profile:info.sequentialSeriesProfile,
   sharedHook:info.sequentialSeriesSharedHook,hookContract});
 if(!result.passed)throw Error("Invalid Series Blueprint: "+result.errors.join(" | "));
 const target=path.join(packageDir,"series-blueprint.json"),temp=target+".tmp-"+process.pid;
 try{await fs.writeFile(temp,JSON.stringify(bp,null,2),"utf8");await fs.rename(temp,target);}
 finally{await fs.rm(temp,{force:true}).catch(()=>{});}
 info.seriesBlueprintPath=target;
 await fs.writeFile(infoPath,JSON.stringify(info,null,2),"utf8");
 return {seriesBlueprintPath:target,seriesId:bp.seriesId,parts:bp.parts.map(p=>p.scriptId)};
}
module.exports={isSerialized,blueprintPrompt,partPrompt,validateBlueprint,validateScriptAgainstBlueprint,importBlueprint};
