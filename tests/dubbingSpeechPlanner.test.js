const assert = require("assert");
const FfmpegService = require("../electron/services/ffmpegService");
const {
  DubbingSpeechPlanner,
  estimateSpeechDuration,
  distributeTextAcrossSegments
} = require("../electron/services/dubbingSpeechPlanner");

function seg(id, startSec, endSec, speaker = "SPEAKER_00", text = "xin chao") {
  return {
    id,
    index: Number(id.replace(/\D/g, "")) || 0,
    startSec,
    endSec,
    speaker,
    text,
    translatedText: text,
    dubbingLine: text
  };
}

{
  const planner = new DubbingSpeechPlanner({ minClusterDuration: 5, maxClusterDuration: 12, maxPauseSec: 1 });
  const plan = planner.buildPlan([
    seg("seg_001", 0, 1.0, "SPEAKER_00", "một"),
    seg("seg_002", 1.2, 2.1, "SPEAKER_00", "hai"),
    seg("seg_003", 2.3, 5.2, "SPEAKER_00", "ba")
  ]);
  assert.strictEqual(plan.clusters.length, 1, "short same-speaker segments should merge");
  assert.deepStrictEqual(plan.clusters[0].sourceSegmentIds, ["seg_001", "seg_002", "seg_003"]);
  assert(plan.clusters[0].risk.includes("merged_short_segments"));
}

{
  const planner = new DubbingSpeechPlanner({ minClusterDuration: 5, maxClusterDuration: 12, maxPauseSec: 1 });
  const plan = planner.buildPlan([
    seg("seg_001", 0, 1.0, "SPEAKER_00", "một"),
    seg("seg_002", 1.1, 2.0, "SPEAKER_01", "hai")
  ]);
  assert.strictEqual(plan.clusters.length, 2, "speaker change should prevent merge");
}

{
  const planner = new DubbingSpeechPlanner({ minClusterDuration: 5, maxClusterDuration: 12, maxPauseSec: 0.8 });
  const plan = planner.buildPlan([
    seg("seg_001", 0, 2.0, "SPEAKER_00", "một hai"),
    seg("seg_002", 3.2, 5.0, "SPEAKER_00", "ba bốn")
  ]);
  assert.strictEqual(plan.clusters.length, 2, "long pause should prevent merge");
}

{
  const planner = new DubbingSpeechPlanner({ minClusterDuration: 5, maxClusterDuration: 6, maxSafeStretch: 0.08, targetLanguage: "vi" });
  const longText = Array.from({ length: 60 }, (_, index) => `từ${index}`).join(" ");
  const plan = planner.buildPlan([
    seg("seg_001", 0, 3.0, "SPEAKER_00", longText)
  ]);
  assert(plan.clusters[0].risk.includes("duration_overflow_before_tts"), "duration guard should detect overflow");
  assert(estimateSpeechDuration(plan.clusters[0].adaptedText, "vi", 1) <= plan.clusters[0].maxSafeDuration + 0.2);
}

{
  const source = FfmpegService.prototype.fitDubbingClusterAudio.toString();
  assert(source.includes("allowTrim"), "safe cluster fit should keep trim behind allowTrim");
  assert(source.includes("overflow_keep_full"), "safe cluster fit should keep overflowing audio instead of trimming");
}

{
  const segments = [
    seg("seg_001", 0, 1, "SPEAKER_00", "a"),
    seg("seg_002", 1, 2, "SPEAKER_00", "b")
  ];
  const cues = distributeTextAcrossSegments("xin chào thế giới hôm nay", segments, 10, 4);
  assert.strictEqual(cues.length, 2);
  assert(cues[0].startSec >= 10);
  assert(cues[1].endSec <= 14.001);
  assert(cues.every((cue) => cue.translatedText));
}

console.log("dubbingSpeechPlanner tests passed");
