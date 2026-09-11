const assert = require("assert");
const {
  consolidateStoryRecutSegments,
  scoreStoryRecutVariant
} = require("../electron/services/storyRecutService");

const evidence = [
  ["e1", "hook", 100, 110, 9.3],
  ["e2", "context", 0, 15, 7.5],
  ["e3", "escalation", 15, 35, 8.2],
  ["e4", "climax", 35, 50, 9.1],
  ["e5", "consequence", 50, 60, 8.4]
].map(([evidenceId, narrativePhase, sourceStartSec, sourceEndSec, hookScore], index) => ({
  evidenceId,
  sceneId: `scene_${index + 1}`,
  sourceRunId: index === 0 ? "run_hook" : "run_story",
  sourceStartSec,
  sourceEndSec,
  narrativePhase,
  hookScore,
  completeBeat: true,
  cutSafety: "safe"
}));

const rawSegments = evidence.map((item, index) => ({
  evidenceId: item.evidenceId,
  macroBlockId: `macro_${index + 1}`,
  storyFunction: item.narrativePhase,
  transitionReason: index === 0 ? "Opening hook." : "This beat causally follows the prior block.",
  audio_mode: "original_audio"
}));
const normalizedSegments = evidence.map((item, index) => ({
  index,
  evidenceId: item.evidenceId,
  sourceRunId: item.sourceRunId,
  sourceStartSec: item.sourceStartSec,
  sourceEndSec: item.sourceEndSec,
  duration: item.sourceEndSec - item.sourceStartSec,
  audioMode: "original_audio"
}));

const strong = scoreStoryRecutVariant({
  script: {
    mode: "story_recut",
    story_blueprint: {
      macroBlocks: rawSegments.map((item) => ({ macroBlockId: item.macroBlockId }))
    },
    segments: rawSegments
  },
  normalizedScript: {
    totalDuration: 70,
    segments: normalizedSegments
  },
  evidencePayload: { evidence }
});

assert.ok(strong.score >= 85);
assert.strictEqual(strong.passed, true);
assert.strictEqual(strong.metrics.originalAudioRatio, 1);
assert.strictEqual(strong.metrics.macroBlockCount, 5);
assert.ok(strong.metrics.sourceJumpCount <= 4);

const longContentFirstSegments = normalizedSegments.map((segment) => ({
  ...segment,
  duration: segment.duration * 4,
  audioMode: "original_audio"
}));
const longContentFirst = scoreStoryRecutVariant({
  script: {
    mode: "story_recut",
    story_blueprint: {
      macroBlocks: rawSegments.map((item) => ({ macroBlockId: item.macroBlockId }))
    },
    segments: rawSegments
  },
  normalizedScript: {
    totalDuration: longContentFirstSegments.reduce((sum, segment) => sum + segment.duration, 0),
    segments: longContentFirstSegments
  },
  evidencePayload: { evidence }
});
assert.ok(longContentFirst.metrics.durationSec > 180);
assert.strictEqual(longContentFirst.metrics.durationWithinProfile, true);
assert.strictEqual(longContentFirst.passed, true);
assert.ok(!longContentFirst.issues.some((issue) => issue.includes("tối đa")));

const fragmented = scoreStoryRecutVariant({
  script: {
    mode: "story_recut",
    segments: Array.from({ length: 10 }, (_, index) => ({
      macroBlockId: `micro_${index + 1}`,
      storyFunction: index === 0 ? "hook" : "shock",
      transitionReason: ""
    }))
  },
  normalizedScript: {
    totalDuration: 30,
    segments: Array.from({ length: 10 }, (_, index) => ({
      index,
      evidenceId: "",
      sourceStartSec: index * 100,
      sourceEndSec: index * 100 + 3,
      duration: 3,
      audioMode: "voiceover_only"
    }))
  },
  evidencePayload: { evidence }
});

assert.strictEqual(fragmented.passed, false);
assert.ok(fragmented.score < 50);
assert.ok(fragmented.issues.some((issue) => issue.includes("băm vụn")));
assert.ok(fragmented.issues.some((issue) => issue.includes("Âm thanh gốc")));
assert.ok(fragmented.issues.some((issue) => issue.includes("timeline nguồn")));

const bridgeHeavy = scoreStoryRecutVariant({
  script: {
    mode: "story_recut",
    story_blueprint: { macroBlocks: rawSegments.map((item) => ({ macroBlockId: item.macroBlockId })) },
    segments: rawSegments.map((item, index) => ({
      ...item,
      audio_mode: index < 2 ? "original_audio" : "voiceover_only"
    }))
  },
  normalizedScript: {
    totalDuration: 70,
    segments: normalizedSegments.map((item, index) => ({
      ...item,
      audioMode: index < 2 ? "original_audio" : "voiceover_only"
    }))
  },
  evidencePayload: { evidence }
});

assert.ok(bridgeHeavy.issues.some((issue) => issue.includes("100% âm thanh nguồn")));
assert.ok(bridgeHeavy.metrics.originalAudioRatio < 1);
assert.strictEqual(bridgeHeavy.metrics.nonOriginalAudioCount, 3);

const consolidated = consolidateStoryRecutSegments([
  {
    id: "recut_0005",
    evidenceId: "evidence_0005",
    sceneId: "scene_0005",
    sourceRunId: "source_run_0001",
    macroBlockId: "macro_01",
    storyFunction: "context",
    sourceStartSec: 25.533,
    sourceEndSec: 27.5,
    startSec: 0,
    endSec: 1.967,
    duration: 1.967,
    playbackSpeed: 1,
    audioMode: "original_audio",
    text: "The first complete thought."
  },
  {
    id: "recut_0006",
    evidenceId: "evidence_0006",
    sceneId: "scene_0007",
    sourceRunId: "source_run_0001",
    macroBlockId: "macro_01",
    storyFunction: "context",
    sourceStartSec: 29.2,
    sourceEndSec: 31,
    startSec: 1.967,
    endSec: 3.767,
    duration: 1.8,
    playbackSpeed: 1,
    audioMode: "original_audio",
    text: "The story continues."
  },
  {
    id: "recut_0007",
    evidenceId: "evidence_0007",
    sceneId: "scene_0008",
    sourceRunId: "source_run_0001",
    macroBlockId: "macro_01",
    storyFunction: "context",
    sourceStartSec: 31.033,
    sourceEndSec: 34.4,
    startSec: 3.767,
    endSec: 7.134,
    duration: 3.367,
    playbackSpeed: 1,
    audioMode: "original_audio",
    text: "One final sentence."
  }
]);
assert.strictEqual(consolidated.length, 1);
assert.strictEqual(consolidated[0].sourceStartSec, 25.533);
assert.strictEqual(consolidated[0].sourceEndSec, 34.4);
assert.strictEqual(consolidated[0].duration, 8.867);
assert.strictEqual(consolidated[0].filledSourceGapSec, 1.733);
assert.deepStrictEqual(consolidated[0].evidenceIds, ["evidence_0005", "evidence_0006", "evidence_0007"]);
assert.deepStrictEqual(consolidated[0].sceneIds, ["scene_0005", "scene_0007", "scene_0008"]);
assert.strictEqual(consolidated[0].technicalSegments.length, 3);

console.log("story recut service tests passed");
