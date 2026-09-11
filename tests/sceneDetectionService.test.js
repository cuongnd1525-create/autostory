const assert = require("assert");

const {
  buildFixedWindowScenes,
  splitLongScenes,
  resolveTimeoutMs,
  parseFfmpegSceneBoundaries
} = require("../electron/services/sceneDetectionService");

const duration = 964.836;
const fallbackScenes = buildFixedWindowScenes(duration, 45);
assert.strictEqual(fallbackScenes.length, 22);
assert.strictEqual(fallbackScenes[0].sceneId, "scene_0001");
assert.strictEqual(fallbackScenes[0].startSec, 0);
assert.strictEqual(fallbackScenes[fallbackScenes.length - 1].endSec, duration);
assert.ok(fallbackScenes.every((scene) => scene.duration <= 45.001));
assert.ok(fallbackScenes.every((scene, index) => (
  index === 0 || Math.abs(scene.startSec - fallbackScenes[index - 1].endSec) < 0.001
)));

const bounded = splitLongScenes([
  { startSec: 0, endSec: 12 },
  { startSec: 12, endSec: 132 },
  { startSec: 132, endSec: 150 }
], 150, 45);
assert.strictEqual(bounded.changed, true);
assert.strictEqual(bounded.scenes[0].endSec, 12);
assert.strictEqual(bounded.scenes[bounded.scenes.length - 1].endSec, 150);
assert.ok(bounded.scenes.every((scene) => scene.duration <= 45.001));

const ffmpegScenes = parseFfmpegSceneBoundaries(
  "showinfo pts_time:12.500 other\nshowinfo pts_time:44.250 other",
  60
);
assert.deepStrictEqual(
  ffmpegScenes.map((scene) => [scene.startSec, scene.endSec]),
  [[0, 12.5], [12.5, 44.25], [44.25, 60]]
);

assert.strictEqual(resolveTimeoutMs(60), 180000);
assert.strictEqual(resolveTimeoutMs(duration), 482418);
assert.strictEqual(resolveTimeoutMs(duration, 300000), 300000);
assert.strictEqual(resolveTimeoutMs(duration, 9999999), 600000);

console.log("scene detection service tests passed");
require("./actionCandidateService.test");
