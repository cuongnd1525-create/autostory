const test = require("node:test"), assert = require("node:assert/strict");
const Index = require("../electron/services/recap/recapSceneIndexService");
const index = { entries: [
  { scene_id: "s1", source_start: 100, source_end: 104 },
  { scene_id: "s2", source_start: 104, source_end: 108 },
  { scene_id: "s3", source_start: 108, source_end: 112 }
] };
const chunk = { chunkIndex: 2, sourceStartSec: 100, sourceEndSec: 120, durationSec: 20 };
test("scene-index compilation uses code-controlled source bounds rather than guessed model times", () => {
  const result = Index.compile({ summary: "Observed", events: [{ scene_ids: ["s2"], source_start: 3.46, source_end: 3.52, description: "Visible action" }] }, index, chunk);
  assert.equal(result.events[0].source_start, 104); assert.equal(result.events[0].source_end, 108);
  assert.equal(result.events[0].anchorMethod, "scene_frames");
  assert.deepEqual(result.events[0].anchorSceneIds, ["s2"]);
  assert.throws(() => Index.compile({ events: [{ scene_ids: ["invented"], description: "Unseen" }] }, index, chunk));
  assert.throws(() => Index.compile({ events: [{ scene_ids: ["s1", "s3"], description: "Disconnected" }] }, index, chunk));
  const combined = Index.compile({ events: [{ scene_ids: ["s1", "s2"], description: "One continuous action" }] }, index, chunk);
  assert.equal(combined.events[0].source_start, 100); assert.equal(combined.events[0].source_end, 108);
});
test("a combined action begins near its selected observed frame and rejects an unrelated anchor", () => {
  const observed = { entries: index.entries.map(entry => ({ ...entry, source_time: (entry.source_start + entry.source_end) / 2 })) };
  const result = Index.compile({ events: [{ scene_ids: ["s1", "s2"], anchor_scene_id: "s2", description: "Action in the second image" }] }, observed, chunk);
  assert.equal(result.events[0].source_start, 105.2);
  assert.equal(result.events[0].source_end, 108);
  assert.throws(() => Index.compile({ events: [{ scene_ids: ["s1", "s2"], anchor_scene_id: "s3", description: "Unrelated anchor" }] }, observed, chunk), /neo chính/);
});
test("outro graphics cannot become story evidence and a long combined action must be split", () => {
  const raw = { events: [{ scene_ids: ["s1"], description: "Movie action", content_kind: "story" },
    { scene_ids: ["s2"], description: "Promotional end card", content_kind: "outro" }] };
  assert.equal(Index.compile(raw, index, chunk).events.length, 1);
  const long = { entries: [{ scene_id: "long", source_start: 100, source_end: 130 }] };
  assert.throws(() => Index.compile({ events: [{ scene_ids: ["long"], description: "Multiple actions" }] }, long,
    { ...chunk, sourceEndSec: 140, durationSec: 40 }), /24 giây/);
});
