const assert = require("assert");

const {
  parseMetadataSeries,
  buildActionCandidates,
  sceneSlicesForRange
} = require("../electron/services/actionCandidateService");

const parsed = parseMetadataSeries(
  "frame:0 pts:1 pts_time:0.25\nlavfi.signalstats.YAVG=15.8\n"
    + "frame:1 pts:2 pts_time:0.50\nlavfi.signalstats.YAVG=18.2",
  "lavfi.signalstats.YAVG"
);
assert.deepStrictEqual(parsed, [
  { timeSec: 0.25, value: 15.8 },
  { timeSec: 0.5, value: 18.2 }
]);

const manifest = {
  videoDurationSec: 24,
  scenes: [
    { sceneId: "scene_0001", startSec: 0, endSec: 8 },
    { sceneId: "scene_0002", startSec: 8, endSec: 16 },
    { sceneId: "scene_0003", startSec: 16, endSec: 24 }
  ]
};
const motionSeries = Array.from({ length: 96 }, (_, index) => ({
  timeSec: index * 0.25,
  value: index >= 32 && index < 72 ? 28 : 4
}));
const audioSeries = Array.from({ length: 48 }, (_, index) => ({
  timeSec: index * 0.5,
  value: index >= 16 && index < 36 ? -8 : -42
}));
const candidates = buildActionCandidates({
  motionSeries,
  audioSeries,
  manifest,
  durationSec: 24,
  windowSec: 4,
  maxCandidateDurationSec: 60,
  maxCandidates: 10
});
assert.ok(candidates.length >= 1);
assert.ok(candidates.some((item) => item.sourceStartSec <= 8 && item.sourceEndSec >= 16));
assert.ok(candidates.some((item) => item.sceneSlices.some((slice) => slice.sceneId === "scene_0002")));
assert.ok(candidates.some((item) => item.mustReview));

assert.deepStrictEqual(sceneSlicesForRange(manifest, 6, 18), [
  { sceneId: "scene_0001", sourceStartSec: 6, sourceEndSec: 8 },
  { sceneId: "scene_0002", sourceStartSec: 8, sourceEndSec: 16 },
  { sceneId: "scene_0003", sourceStartSec: 16, sourceEndSec: 18 }
]);

console.log("action candidate service tests passed");
