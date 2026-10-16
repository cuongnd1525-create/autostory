"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const {buildManualNarratorEnglishCues,captionPhrases,toSrt}=require("../electron/services/manualGeminiCaptionService");
test("narrator only: output concise English captions and no original-audio captions",()=>{
 const segments=[
  {audioMode:"original_audio",duration:5,voiceoverText:""},
  {audioMode:"voiceover_only",duration:8,voiceoverText:"She drives away but the officer sees exactly where she goes before the next call arrives."}
 ];
 const timeline={segments:[{resolved:{startSec:0,endSec:5}},{resolved:{startSec:5,endSec:13}}]};
 const cues=buildManualNarratorEnglishCues({segments,timeline,voiceReports:[{}, {rawVoiceSec:6}]});
 assert.ok(cues.length>=3);
 assert.ok(cues.every(c=>c.startSec>=5&&c.endSec<=11&&c.text.split(" ").length<=5));
 assert.match(toSrt(cues),/00:00:05,000/);
});
test("caption phrases preserve complete words and avoid duplicate text",()=>{
 const input="This is the actual first line of an English narrator.";
 assert.equal(captionPhrases(input).flatMap(v=>v.split(" ")).join(" "),input);
});
