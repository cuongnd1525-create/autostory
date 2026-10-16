"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {auditManualSourceGrounding} = require("../electron/services/manualSourceGroundingAuditService");
const srt = "1\n00:00:12,000 --> 00:00:15,000\nOfficer: Open the door right now!\n";
test("manual source grounding marks SRT-supported quotes without claiming visual verification", () => {
  const report = auditManualSourceGrounding({
    sourceVideo:"input.mp4",transcriptSrt:srt,
    rawScript:{segments:[{keyDialogue:"Open the door right now!"}]},
    normalizedScript:{segments:[{id:"seg_1",sourceStartSec:10,sourceEndSec:17,audioMode:"original_audio"}]}
  });
  assert.equal(report.quoteManualReviewCount,0);
  assert.equal(report.findings[0].quoteStatus,"transcript_supported");
  assert.match(report.limitations,/NOT proof/);
});
test("unexpected quote is flagged for listening rather than automatically rejected", () => {
  const report=auditManualSourceGrounding({
    transcriptSrt:srt,rawScript:{segments:[{keyDialogue:"That is a gun in the car"}]},
    normalizedScript:{segments:[{sourceStartSec:10,sourceEndSec:17}]}
  });
  assert.equal(report.findings[0].quoteStatus,"requires_manual_listening");
  assert.equal(report.quoteManualReviewCount,1);
});
test("no SRT never masquerades as full source verification", () => {
  const r=auditManualSourceGrounding({rawScript:{segments:[{keyDialogue:"Confession"}]},
    normalizedScript:{segments:[{sourceStartSec:0,sourceEndSec:7}]}});
  assert.equal(r.hasTranscript,false);
  assert.equal(r.findings[0].quoteStatus,"no_srt_available");
});
