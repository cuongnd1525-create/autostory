"use strict";

const assert = require("assert");
const DubbingService = require("../electron/services/dubbingService");
const { resolveVoiceVisualFit } = require("../electron/services/voiceTimingPolicy");

function voiceSeg(id, start, end, text, extra = {}) {
  return {
    id,
    segmentId: id,
    sceneId: id,
    sourceStartSec: start,
    sourceEndSec: end,
    startSec: start,
    endSec: end,
    duration: end - start,
    playbackSpeed: 1,
    audioMode: text ? "voiceover_with_ambient" : "original_audio",
    requestedAudioMode: text ? "voiceover_with_ambient" : "original_audio",
    voiceoverText: text,
    dubbingLine: text,
    text,
    deliveryProfile: "natural",
    speechRateMultiplier: 1,
    ...extra
  };
}

// Adjacent narrator beats become one runtime-only continuous passage.
{
  const input = [
    voiceSeg("a", 0, 3, "The trooper thought this was routine"),
    voiceSeg("b", 3, 6, "Then everything changed"),
    voiceSeg("raw", 6, 9, ""),
    voiceSeg("c", 9, 12, "She refused to step out"),
    voiceSeg("d", 12, 15, "The warnings kept coming")
  ];
  const project = { analysisWorkflow: "manual_gemini_draft_review", mixer: { narrationSourceAudioOverride: true, sourceVolume: 15 } };
  const out = DubbingService.buildManualDraftContinuousNarration(input, project, {});
  assert.strictEqual(out[0].deliveryMode, "narrated_story");
  assert.strictEqual(out[0].deliveryBlockId, out[1].deliveryBlockId);
  assert.match(out[0].blockNarrationText, /routine\. Then everything changed\./);
  assert.strictEqual(out[1].blockNarrationText, "");
  assert.strictEqual(out[0].voiceoverText, "");
  assert.strictEqual(out[1].dubbingLine, "");
  assert.strictEqual(out[2].deliveryBlockId || "", "", "original audio must break narration continuity");
  assert.strictEqual(out[3].deliveryBlockId, out[4].deliveryBlockId);
  assert.notStrictEqual(out[0].deliveryBlockId, out[3].deliveryBlockId);
}

// Different delivery intent/emotion must not be merged into one flat-sounding block.
{
  const input = [
    voiceSeg("a", 0, 3, "Calm setup", { deliveryProfile: "natural" }),
    voiceSeg("b", 3, 6, "Urgent turn", { deliveryProfile: "urgent_hook", emotionTag: "URGENT" })
  ];
  const out = DubbingService.buildManualDraftContinuousNarration(input, { analysisWorkflow: "manual_gemini_draft_review" }, {});
  assert.ok(!out[0].deliveryBlockId && !out[1].deliveryBlockId);
}

// Max block duration avoids long audiobook-style narration.
{
  const input = [
    voiceSeg("a", 0, 4, "One"),
    voiceSeg("b", 4, 8, "Two"),
    voiceSeg("c", 8, 12, "Three"),
    voiceSeg("d", 12, 16, "Four")
  ];
  const out = DubbingService.buildManualDraftContinuousNarration(input, { analysisWorkflow: "manual_gemini_draft_review" }, { manualDraftNarrationBlockMaxSec: 10 });
  assert.strictEqual(out[0].deliveryBlockId, out[1].deliveryBlockId);
  assert.ok(!out[2].deliveryBlockId || out[2].deliveryBlockId !== out[0].deliveryBlockId);
}

// Manual workflow defaults to final voice when no draft mode was explicitly supplied.
// Explicit custom still wins.
{
  const finalPlan = DubbingService.resolveFastDraftVoicePlan({
    project: { analysisWorkflow: "manual_gemini_draft_review", voiceProvider: "edge_neural", voiceId: "en-US-GuyNeural" },
    settings: {},
    text: "A natural narrator line.",
    outputPath: "voice.mp3"
  });
  assert.strictEqual(finalPlan.draftMode, "final");
  assert.strictEqual(finalPlan.provider, "edge_neural");
  assert.strictEqual(finalPlan.voiceId, "en-US-GuyNeural");

  const customPlan = DubbingService.resolveFastDraftVoicePlan({
    project: {
      analysisWorkflow: "manual_gemini_draft_review",
      draftVoiceMode: "custom",
      draftVoiceProvider: "edge_neural",
      draftVoiceId: "en-US-AriaNeural",
      voiceProvider: "edge_neural",
      voiceId: "en-US-GuyNeural"
    },
    settings: {},
    text: "A custom narrator line.",
    outputPath: "voice.mp3"
  });
  assert.strictEqual(customPlan.draftMode, "custom");
  assert.strictEqual(customPlan.voiceId, "en-US-AriaNeural");
}

// A 5% overrun with a 4% voice-speed cap extends visuals instead of silently
// forcing the old 8% speed-up.
{
  const fit = resolveVoiceVisualFit({
    plannedDurationSec: 10,
    actualVoiceDurationSec: 10.5,
    audioMode: "voiceover_only",
    maxVoiceSpeedUp: 1.04
  });
  assert.ok(fit.renderDurationSec > 10);
  assert.ok(fit.voiceSpeedRatio <= 1.041);
}

console.log("manualDraftNarration tests passed");
