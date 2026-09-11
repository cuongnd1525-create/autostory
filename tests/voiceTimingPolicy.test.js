const assert = require("assert");
const { measureVoiceTiming, resolveVoiceVisualFit } = require("../electron/services/voiceTimingPolicy");
const { compileResolvedTimeline } = require("../electron/services/resolvedTimelineService");

{
  const result = measureVoiceTiming({
    plannedDurationSec: 15,
    actualVoiceDurationSec: 20,
    text: "one two three four five"
  });
  assert.strictEqual(result.status, "too_long");
  assert.strictEqual(result.coverageRatio, 1.333);
  assert.strictEqual(result.overflowSec, 5);
}

{
  const result = resolveVoiceVisualFit({
    plannedDurationSec: 10,
    actualVoiceDurationSec: 10.6,
    audioMode: "voiceover_only"
  });
  assert.strictEqual(result.renderDurationSec, 10);
  assert.strictEqual(result.strategy, "as_requested");
}

{
  const result = resolveVoiceVisualFit({
    plannedDurationSec: 10,
    actualVoiceDurationSec: 11.5,
    audioMode: "voiceover_only"
  });
  assert.ok(result.renderDurationSec > 10 && result.renderDurationSec <= 11.112);
  assert.ok(result.voiceSpeedRatio <= 1.08);
  assert.strictEqual(result.strategy, "light_voice_speedup_and_visual_extension");
}

{
  const result = resolveVoiceVisualFit({
    plannedDurationSec: 10,
    actualVoiceDurationSec: 6,
    audioMode: "voiceover_only",
    protectedVisual: false
  });
  assert.strictEqual(result.renderDurationSec, 6.25);
  assert.strictEqual(result.requiresSceneRebuild, true);
  assert.strictEqual(result.strategy, "trim_flexible_broll_to_voice");
}

{
  const result = resolveVoiceVisualFit({
    plannedDurationSec: 10,
    actualVoiceDurationSec: 6,
    audioMode: "voiceover_with_ambient",
    protectedVisual: true
  });
  assert.strictEqual(result.renderDurationSec, 10);
  assert.strictEqual(result.strategy, "protected_visual_ambient_handoff");
}

{
  const result = measureVoiceTiming({
    plannedDurationSec: 15,
    actualVoiceDurationSec: 6,
    text: "one two three four five"
  });
  assert.strictEqual(result.status, "too_short");
  assert.strictEqual(result.deadAirSec, 9);
}

{
  const timeline = compileResolvedTimeline({
    mode: "satisfying_storytime",
    segments: [
      { id: "a", startSec: 0, endSec: 15, sourceStartSec: 10, sourceEndSec: 25, dubbingLine: "voice" },
      { id: "b", startSec: 15, endSec: 25, sourceStartSec: 30, sourceEndSec: 40, dubbingLine: "voice" }
    ],
    voiceReports: [
      { rawVoiceSec: 20, requestedTimelineSec: 15, renderedText: "voice" },
      { rawVoiceSec: 8, requestedTimelineSec: 10, renderedText: "voice" }
    ],
    voiceDrivenVisuals: true
  });
  assert.strictEqual(timeline.plannedDurationSec, 25);
  assert.strictEqual(timeline.resolvedDurationSec, 28);
  assert.strictEqual(timeline.segments[1].resolved.startSec, 20);
  assert.strictEqual(timeline.segments[0].voice.coverageRatio, 1.333);
}

console.log("voiceTimingPolicy tests passed");
