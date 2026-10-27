"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {getHighlightAudioMode,getHighlightAmbientVolume}=require("../electron/services/dubbingService");
const project={analysisWorkflow:"manual_gemini_draft_review",mixer:{narrationSourceAudioOverride:true,sourceVolume:25}};
test("explicit voiceover_only ignores global source-volume override",()=>{
 const seg={audioMode:"voiceover_only",voiceoverText:"A separate AI narrator."};
 assert.equal(getHighlightAudioMode(seg,true,project),"voiceover_only");
 assert.equal(getHighlightAmbientVolume(seg,project),0);
});
test("source narrator always mutes raw source, even when AI requests ambient",()=>{
 const seg={audioMode:"voiceover_with_ambient",voiceoverText:"Replacement",sourceNarratorDetected:true,cleanAmbientVerified:true};
 assert.equal(getHighlightAudioMode(seg,true,project),"voiceover_only");
 assert.equal(getHighlightAmbientVolume(seg,project),0);
});
test("manual ambient mode requires clean confirmed bed",()=>{
 assert.equal(getHighlightAudioMode({audioMode:"voiceover_with_ambient"},true,project),"voiceover_only");
 assert.equal(getHighlightAudioMode({audioMode:"voiceover_with_ambient",cleanAmbientVerified:true},true,project),"voiceover_with_ambient");
});
test("original audio with no narrator stays original",()=>{
 assert.equal(getHighlightAudioMode({audioMode:"original_audio"},false,project),"original_audio");
});
