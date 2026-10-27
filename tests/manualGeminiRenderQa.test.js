"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const RenderQaService = require("../electron/services/renderQaService");

function fixture() {
  const qa = new RenderQaService();
  qa.probeVideo = async () => ({duration:90,width:1080,height:1920,hasAudio:true});
  qa.detectBlackAndFreeze = async () => ({blackStarts:[35.2],freezeStarts:[]});
  qa.measureAudio = async () => ({meanVolumeDb:-15,maxVolumeDb:-1});
  qa.detectSilence = async () => ({intervals:[]});
  return qa;
}
test("black frame QA can be strict only for Manual Gemini", async () => {
  const qa = fixture();
  const strict = await qa.inspect({videoPath:"dummy.mp4",targetDuration:90,subtitlePath:"not_requested",strictBlackFrames:true});
  assert.equal(strict.passed,false);
  assert.equal(strict.issues.find(i=>i.code==="black_frames").severity,"error");
  const legacy = await qa.inspect({videoPath:"dummy.mp4",targetDuration:90,subtitlePath:"not_requested"});
  assert.equal(legacy.passed,true);
  assert.equal(legacy.issues.find(i=>i.code==="black_frames").severity,"warning");
});
