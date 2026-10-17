"use strict";
const assert = require("node:assert/strict");
const { inspectScript, inspectScripts } = require("../electron/services/bodycamV1QualityService");

function part(id, start, source, opts = {}) {
  const chunks=[14,17,12,16,13,18,10,15]; // 115s, 8 source-grounded beats
  let cursor=start;
  const modes=["original_audio","voiceover_only","original_audio","voiceover_only",
    "original_audio","voiceover_only","original_audio","voiceover_only"];
  const beats=chunks.map((len,i) => {
    const r={ sourceStartSec:cursor, sourceEndSec:cursor+len,
      audio_mode:modes[i],
      voiceover_text: i%2 ? "Police confirmed the next detail, and the stakes changed." : "" };
    cursor+=len;
    return r;
  });
  return {
    artifactType:"highlight_cut_script",scriptId:id,
    prompt_profile:"viral_tiktok_crime_part1",
    language:"en",segments:beats,
    v1EditorialAudit:{
      centralViewerQuestion:"Why did the driver behave strangely?",
      hookPromise:"Police uncover a contradiction",
      first3SecClear:true,hookSourceSec:start+2,payoffSourceSec:source,
      hookEventId: id===1?"e1":id===3?"e2":"e3",
      payoffEventId: source<120?"e1":source<240?"e2":"e3",
      endingEventId: id===1?"e1":id===3?"e2":"e3",
      headlineMatchesHook:true,
      payoffWithinPart:id===4,verifiedNextPartOpenLoop:id!==4,
      endingSourceSec:start+114,endingUsable:true,weakSourceRanges:[]
    },
    ...opts
  };
}
const source={storyTimeline:[
  {eventId:"e1",sourceStartSec:0,sourceEndSec:119,summary:"Initial police response"},
  {eventId:"e2",sourceStartSec:120,sourceEndSec:238,summary:"Accounts diverge"},
  {eventId:"e3",sourceStartSec:240,sourceEndSec:360,summary:"Later resolution"}
]};
const seriesPlan={parts:[
  {scriptId:1,sceneAllocation:[{sourceStartSec:0,sourceEndSec:119}]},
  {scriptId:3,sceneAllocation:[{sourceStartSec:120,sourceEndSec:239}]},
  {scriptId:4,sceneAllocation:[{sourceStartSec:240,sourceEndSec:360}]}
],sharedRanges:[]};
const scripts=[part(1,0,130),part(3,120,270),part(4,240,350)];
const settings={source,seriesPlan,videoDurationSec:400};
const report=inspectScripts(scripts,settings);
assert.equal(report.passed,true,JSON.stringify(report.errors));
const broken=part(1,0,999);
assert.equal(inspectScript(broken,settings).passed,false);
assert.match(inspectScript(broken,settings).errors.join(" "),/storyTimeline/);
const missingHook=part(1,0,130,{v1EditorialAudit:{
  ...scripts[0].v1EditorialAudit,first3SecClear:false
}});
assert.match(inspectScript(missingHook,settings).errors.join(" "),/0-3s/);
const unusable=part(1,0,130,{v1EditorialAudit:{
  ...scripts[0].v1EditorialAudit,endingUsable:false
}});
assert.match(inspectScript(unusable,settings).errors.join(" "),/Ending/);
const padded=part(1,0,130);
padded.segments[4].sourceEndSec+=30;
assert.equal(inspectScript(padded,settings).passed,false);
const wrongMode=part(1,0,130);
wrongMode.segments[3].audio_mode="original_audio";
assert.match(inspectScript(wrongMode,settings).errors.join(" "),/8 nhịp/);
const weak=part(1,0,130,{v1EditorialAudit:{
  ...scripts[0].v1EditorialAudit,
  weakSourceRanges:[{sourceStartSec:35,sourceEndSec:58,reason:"static car"}]
}});
assert.match(inspectScript(weak,settings).errors.join(" "),/source yếu/);
const wrongPart=inspectScripts(scripts.slice(0,2),settings);
assert.equal(wrongPart.passed,false);
assert.match(wrongPart.errors.join(" "),/Script 4/);
console.log("Bodycam V1 source-grounded hook/ending, 8 beats, no weak ranges, series completeness: PASS");
