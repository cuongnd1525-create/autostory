"use strict";

// Chunked MAP/REDUCE Phase A (default architecture).
// Real-run background (2026-10-07, 3 proxies / 12.9 min): one global AGY
// conversation that watched every proxy failed its synthesis turn until the
// 9m18s print timeout, and same-conversation serialization timed out after
// 4m0s. Here every map process holds ONE chunk; the reducer holds no video.

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const MapReduce = require("../electron/services/sourceUnderstandingMapReduce");
const { createPhaseAwareSpawn, defaultResponder, mapTaskFromPrompt, buildChunkUnderstanding } = require("./helpers/fakeAntigravity");

const DURATION = 771.901;
const CHUNKS = [[0, 239.25], [239.25, 480.5], [480.5, 771.901]];
const MARKERS = ["ALPHA_ONLY_IN_CHUNK_ONE", "BRAVO_ONLY_IN_CHUNK_TWO", "CHARLIE_ONLY_IN_CHUNK_THREE"];
const PRINT_TIMEOUT = { omitResult: true, exitCode: 1, stderr: "[agy] print timeout after 4m0s with turn in progress\n" };

function pad(n, w = 2) { return String(n).padStart(w, "0"); }
function ts(sec) { return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(Math.floor(sec) % 60)},${pad(Math.round((sec % 1) * 1000), 3)}`; }

function buildSrt() {
  const blocks = [];
  let index = 0;
  for (let sec = 1; sec < DURATION - 2; sec += 6) {
    index += 1;
    const chunk = CHUNKS.findIndex(([start, end]) => sec >= start + 6 && sec + 1 <= end - 6);
    const text = chunk >= 0 && index % 10 === 0 ? `${MARKERS[chunk]} line ${index}` : `line ${index}`;
    blocks.push(`${index}\n${ts(sec)} --> ${ts(sec + 1)}\n${text}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

async function createPackage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-map-reduce-"));
  const pass1Dir = path.join(root, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const promptPath = path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt");
  await fs.writeFile(promptPath, "Generate Script 1, Script 3 and Script 4. HOOK CONTRACT: secret editorial rules.", "utf8");
  const scenes = Array.from({ length: 87 }, (_, index) => ({
    sceneId: `scene_${String(index + 1).padStart(4, "0")}`,
    startSec: Number(((index * DURATION) / 87).toFixed(3)),
    endSec: Number((((index + 1) * DURATION) / 87).toFixed(3))
  }));
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({ videoDurationSec: DURATION, scenes }), "utf8");
  await fs.writeFile(path.join(pass1Dir, "action-candidates.json"), JSON.stringify({
    candidates: [
      { actionCandidateId: "a1", sourceStartSec: 18, sourceEndSec: 26, actionPriorityScore: 7.5, localActionType: "high_motion_or_audio_event" },
      { actionCandidateId: "a2", sourceStartSec: 300, sourceEndSec: 306, actionPriorityScore: 6, localActionType: "high_motion_or_audio_event" },
      { actionCandidateId: "a3", sourceStartSec: 700, sourceEndSec: 708, actionPriorityScore: 8, localActionType: "high_motion_or_audio_event" }
    ]
  }), "utf8");
  const chunks = CHUNKS.map(([start, end], index) => ({
    chunkId: `proxy_chunk_00${index + 1}`, file: `analysis-proxy-chunk-00${index + 1}.mp4`, sourceStartSec: start, sourceEndSec: end, durationSec: end - start
  }));
  for (const chunk of chunks) await fs.writeFile(path.join(pass1Dir, chunk.file), `video-${chunk.chunkId}`, "utf8");
  await fs.writeFile(path.join(pass1Dir, "proxy-chunks-manifest.json"), JSON.stringify({ sourceDurationSec: DURATION, chunks }), "utf8");
  await fs.writeFile(path.join(pass1Dir, "source-transcript.srt"), buildSrt(), "utf8");
  await fs.writeFile(path.join(pass1Dir, "hook-contract.json"), JSON.stringify({ secret: "HOOK_CONTRACT_SHOULD_NOT_REACH_MAP" }), "utf8");
  const cacheDir = path.join(root, "source-cache");
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review",
    pass1UploadDir: pass1Dir,
    promptPath,
    proxyChunksManifestPath: path.join(pass1Dir, "proxy-chunks-manifest.json"),
    proxyChunkCount: 3,
    cache: { sourceFingerprint: "fp-map-reduce", cacheDir }
  }), "utf8");
  return { root, pass1Dir, cacheDir };
}

async function run(fixture, respond = defaultResponder({ durationSec: DURATION }), settings = {}) {
  const calls = [];
  const messages = [];
  const live = { active: 0, maxActive: 0 };
  const baseSpawn = createPhaseAwareSpawn({ calls, respond });
  const spawn = (command, args, options) => {
    const child = baseSpawn(command, args, options);
    const call = calls[calls.length - 1];
    if (call.kind === "map") {
      live.active += 1;
      live.maxActive = Math.max(live.maxActive, live.active);
      child.on("close", () => { live.active -= 1; });
    }
    return child;
  };
  const service = new Stage1(
    { antigravityCommand: "agy", antigravityModel: "gemini-3.8-flash-high", antigravityCapacityRetryBaseMs: 0, ...settings },
    { spawn, authProbe: async () => ({ expiresAt: new Date(Date.now() + 50 * 60000), expiredFlag: false }) }
  );
  let result = null;
  let error = null;
  try {
    result = await service.run({ packageDir: fixture.root, onProgress: (item) => messages.push(String(item.message || "")) });
  } catch (caught) {
    error = caught;
  }
  const timing = JSON.parse(await fs.readFile(path.join(fixture.root, "pipeline-timing.json"), "utf8").catch(() => "null"));
  const mapChunkIds = calls.filter((call) => call.kind === "map").map((call) => mapTaskFromPrompt(call.prompt).chunkId);
  const videoViews = calls.reduce((sum, call) => sum + (call.emittedVideoViews || 0), 0);
  return { calls, messages, result, error, timing, live, mapChunkIds, videoViews, kinds: calls.map((call) => call.kind) };
}

async function chunkCacheFiles(cacheDir) {
  return (await fs.readdir(path.join(cacheDir, "chunk-understanding")).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
}
async function globalCacheFiles(cacheDir) {
  return (await fs.readdir(cacheDir).catch(() => [])).filter((name) => /^source-understanding-v2-[0-9a-f]+\.json$/.test(name));
}

(async () => {
  // ------------------------------------------------ slicing helpers (pure)
  const cues = [{ start: 0, end: 2, text: "a" }, { start: 237, end: 238, text: "b" }, { start: 242, end: 243, text: "c" }, { start: 250, end: 251, text: "d" }];
  assert.deepStrictEqual(MapReduce.sliceTranscriptForRange(cues, 0, 239.25, 4).map((cue) => cue.text), ["a", "b", "c"], "±4s handle includes the cue just after the boundary");
  assert.deepStrictEqual(MapReduce.sliceTranscriptForRange(cues, 239.25, 480.5, 4).map((cue) => cue.text), ["b", "c", "d"]);
  assert.deepStrictEqual(MapReduce.sliceScenesForRange([{ sceneId: "s1", startSec: 0, endSec: 100 }, { sceneId: "s2", startSec: 400, endSec: 500 }], 239.25, 300, 4).map((scene) => scene.sceneId), []);
  assert.deepStrictEqual(MapReduce.sliceActionCandidatesForRange([{ sourceStartSec: 236, sourceEndSec: 238 }, { sourceStartSec: 600, sourceEndSec: 610 }], 239.25, 480.5, 4).length, 1);
  assert.strictEqual(Stage1.resolveMapConcurrency({}), 1, "safe default map concurrency is 1 until a live AGY run proves 2 stable");
  assert.strictEqual(Stage1.resolveMapConcurrency({ sourceUnderstandingMapConcurrency: 2 }), 2);
  assert.strictEqual(Stage1.resolveMapConcurrency({ sourceUnderstandingMapConcurrency: 99 }), 4, "concurrency is bounded");
  assert.strictEqual(Stage1.resolveSourceUnderstandingArchitecture({}), "chunked_map_reduce", "map/reduce is the normal Phase A");
  const timeouts = MapReduce.resolveMapReduceTimeouts({}, { chunkDurationSec: 291 });
  assert(timeouts.mapChunkTimeoutMs >= 240000 && timeouts.mapChunkTimeoutMs <= 480000, "bounded per-chunk timeout, not chunkCount*8min+20min");
  assert.strictEqual(timeouts.reduceTimeoutMs, 240000);

  // ------------------------------------------------ Test 1: 3 chunks cold
  const fixture = await createPackage();
  const cold = await run(fixture, undefined, { sourceUnderstandingMapConcurrency: 2 });
  assert.ifError(cold.error);
  assert.strictEqual(cold.kinds.filter((kind) => kind === "map").length, 3, "3 video-view MAP turns");
  assert.strictEqual(cold.kinds.filter((kind) => kind === "map_serialize").length, 3, "3 same-conversation serialization turns");
  assert.strictEqual(cold.kinds.filter((kind) => kind === "reduce").length, 1, "1 reducer");
  assert.strictEqual(cold.kinds.filter((kind) => kind === "phase_b").length, 1, "1 Phase B");
  assert.deepStrictEqual([...cold.mapChunkIds].sort(), ["chunk-001", "chunk-002", "chunk-003"]);
  assert.strictEqual(cold.videoViews, 3, "exactly 3 video view_file calls in total");
  assert.strictEqual(cold.live.maxActive, 2, "bounded concurrency: never more than 2 map processes in flight");
  assert.strictEqual((await chunkCacheFiles(fixture.cacheDir)).length, 3, "3 chunk-understanding cache files");
  assert.strictEqual((await globalCacheFiles(fixture.cacheDir)).length, 1, "1 reducer (global) cache file");
  const su1 = cold.timing.sourceUnderstanding;
  assert.strictEqual(su1.architecture, "chunked_map_reduce");
  assert.strictEqual(su1.map.chunkCount, 3);
  assert.strictEqual(su1.map.concurrency, 2);
  assert.strictEqual(su1.map.maxConcurrentAgyProcesses, 2);
  assert.strictEqual(su1.map.cacheHits, 0);
  assert.strictEqual(su1.map.cacheMisses, 3);
  assert.strictEqual(su1.map.agyProcessCount, 6, "each cold chunk uses one view turn + one serialize turn");
  assert.strictEqual(su1.map.viewFileCount, 3);
  assert.strictEqual(su1.map.duplicateVideoViewCount, 0);
  assert.strictEqual(su1.map.failedChunkCount, 0);
  assert.strictEqual(su1.reduce.agyProcessCount, 1);
  assert.strictEqual(su1.reduce.videoViewFileCount, 0);
  assert(Number.isFinite(su1.totalDurationMs) && Number.isFinite(su1.map.durationMs) && Number.isFinite(su1.reduce.durationMs));
  assert.strictEqual(su1.viewFileCount, 3);
  assert.strictEqual(su1.agyProcessCount, 7);
  assert.strictEqual(su1.fullMultimodalRestartCount, 0);
  for (const chunk of su1.map.chunks) {
    for (const field of ["chunkId", "sourceStartSec", "sourceEndSec", "durationMs", "cacheHit", "agyRuntimeMs", "viewFileCount", "agentTurns", "inputTokens", "outputTokens", "retryCount"]) {
      assert(field in chunk, `per-chunk diagnostics must include ${field}`);
    }
    assert.strictEqual(chunk.viewFileCount, 1);
    assert.strictEqual(chunk.inputTokens, 2000, "view + serialize turns are both measured");
  }
  assert.strictEqual(cold.timing.scriptGeneration.videoViewFileCount, 0, "Phase B stays text-only");
  // MAP view turns are deliberately tiny: one video tool call and no transcript/editorial payload.
  for (const call of cold.calls.filter((item) => item.kind === "map")) {
    const task = mapTaskFromPrompt(call.prompt);
    const index = Number(task.chunkId.slice(-3)) - 1;
    assert.deepStrictEqual([...new Set([...call.prompt.matchAll(/analysis-proxy-chunk-\d+\.mp4/g)].map((match) => match[0]))], [`analysis-proxy-chunk-00${index + 1}.mp4`], `${task.chunkId}: exactly one proxy`);
    assert.strictEqual([...call.prompt.matchAll(/view_file\(/g)].length, 1, `${task.chunkId}: exactly one video view_file instruction`);
    assert(!MARKERS.some((marker) => call.prompt.includes(marker)), `${task.chunkId}: no transcript text in video-view turn`);
    assert(!/source-transcript\.srt|scene-manifest\.json|hook-contract|HOOK CONTRACT|Script 1/i.test(call.prompt), `${task.chunkId}: no raw/editorial input`);
    assert(call.prompt.includes("reply only VIEW_DONE"));
    assert(call.prompt.length < Stage1.MAX_PRINT_PROMPT_CHARS);
  }
  // Serialization resumes the same conversation, reads only the local text context, and never views video again.
  for (const call of cold.calls.filter((item) => item.kind === "map_serialize")) {
    assert.strictEqual(call.resumed, true);
    assert(call.prompt.includes("-context.txt"));
    assert(call.prompt.includes("Do NOT call view_file on any video again."));
    assert.strictEqual([...call.prompt.matchAll(/view_file\(/g)].length, 1, "serializer has one text-context view_file");
    assert(!/view_file\("[^"]+\.mp4"/i.test(call.prompt), "serializer never requests video");
    assert(call.prompt.includes("write_to_file exactly once"));
  }
  const reducePrompt = cold.calls.find((call) => call.kind === "reduce").prompt;
  assert(!/\.mp4/i.test(reducePrompt) && !reducePrompt.includes("line 1 ") && !MARKERS.some((marker) => reducePrompt.includes(marker)), "reducer: no video, no full transcript");
  assert(reducePrompt.includes("chunk-001") && reducePrompt.includes("chunk-003"));
  // Chunk-specific local inputs exist for traceability.
  const chunkInput = path.join(fixture.root, "01-ANTIGRAVITY-RESULT", "map", "chunk-002");
  for (const name of ["chunk-002-transcript.srt", "chunk-002-scenes.json", "chunk-002-actions.json", "chunk-002-context.txt", "prompt-attempt1.txt", "antigravity-output-chunk-002-attempt1.log", "chunk-understanding-chunk-002.json", "diagnostics.json"]) {
    await fs.access(path.join(chunkInput, name));
  }
  assert(cold.messages.some((message) => message.startsWith("[PHASE_A] DONE (map/reduce)")));

  // ------------------------------------------------ Test 2: all warm
  const warm = await run(fixture);
  assert.ifError(warm.error);
  assert.deepStrictEqual(warm.kinds, ["phase_b"], "warm: zero Phase A AGY processes");
  assert.strictEqual(warm.videoViews, 0, "warm: 0 video view_file");
  const su2 = warm.timing.sourceUnderstanding;
  assert.strictEqual(su2.cacheHit, true);
  assert.strictEqual(su2.phaseASkipped, true);
  assert.strictEqual(su2.map.cacheHits, 3, "3 chunk cache hits");
  assert.strictEqual(su2.reduce.cacheHit, true, "global cache hit");
  assert.strictEqual(su2.viewFileCount, 0);
  assert.strictEqual(su2.agyProcessCount, 0);
  assert(warm.messages.some((message) => message.startsWith("[SOURCE_UNDERSTANDING] CACHE HIT")));
  assert(warm.messages.some((message) => message.startsWith("[PHASE_A] SKIPPED")));

  // ------------------------------------------------ Test 3: chunk 2 corrupted
  for (const name of await globalCacheFiles(fixture.cacheDir)) await fs.rm(path.join(fixture.cacheDir, name));
  const chunk2File = (await chunkCacheFiles(fixture.cacheDir)).find((name) => name.startsWith("chunk-002-"));
  await fs.writeFile(path.join(fixture.cacheDir, "chunk-understanding", chunk2File), "{ corrupted", "utf8");
  const partial = await run(fixture);
  assert.ifError(partial.error);
  assert.deepStrictEqual(partial.mapChunkIds, ["chunk-002"], "chunk 1 HIT, chunk 2 reruns, chunk 3 HIT");
  assert.deepStrictEqual(partial.kinds, ["map", "map_serialize", "reduce", "phase_b"]);
  assert.strictEqual(partial.videoViews, 1, "video view_file = 1");
  const chunks3 = partial.timing.sourceUnderstanding.map.chunks;
  assert.deepStrictEqual(chunks3.map((chunk) => chunk.cacheHit), [true, false, true]);
  assert.strictEqual(chunks3[1].cacheStatus, "invalid");
  assert(partial.messages.some((message) => message.includes("[MAP chunk-002] CACHE INVALID")));

  // ------------------------------------------------ Test 4a: print timeout AFTER real video DONE is recoverable.
  const fixture4 = await createPackage();
  const timeoutAfterDone = (kind, prompt, call) => {
    if (kind === "map" && mapTaskFromPrompt(prompt).chunkId === "chunk-002") {
      return { viewFiles: [mapTaskFromPrompt(prompt).proxy], ...PRINT_TIMEOUT };
    }
    return defaultResponder({ durationSec: DURATION })(kind, prompt, call);
  };
  const recovered4 = await run(fixture4, timeoutAfterDone);
  assert.ifError(recovered4.error);
  assert.strictEqual(recovered4.videoViews, 3, "no chunk is rewatched");
  assert.strictEqual(recovered4.kinds.filter((kind) => kind === "map_serialize").length, 3);
  assert.strictEqual(recovered4.timing.sourceUnderstanding.map.failedChunkCount, 0);

  // ------------------------------------------------ Test 4b: timeout BEFORE view_file DONE must fail and never cache that chunk.
  const fixture4b = await createPackage();
  const timeoutBeforeDone = (kind, prompt, call) => {
    if (kind === "map" && mapTaskFromPrompt(prompt).chunkId === "chunk-002") {
      return { viewFiles: [], ...PRINT_TIMEOUT };
    }
    return defaultResponder({ durationSec: DURATION })(kind, prompt, call);
  };
  const failed4 = await run(fixture4b, timeoutBeforeDone);
  assert(failed4.error, "timeout before DONE fails Phase A");
  assert(failed4.error.message.startsWith("[PHASE_A] FAILED") && failed4.error.message.includes("chunk-002"), failed4.error.message);
  assert(!failed4.kinds.includes("reduce"));
  assert.strictEqual(failed4.timing.sourceUnderstanding.map.failedChunkCount, 1);
  assert.strictEqual(failed4.timing.sourceUnderstanding.map.chunks[1].failureKind, "print_timeout");
  assert.strictEqual(failed4.timing.sourceUnderstanding.map.chunks[1].coverage.complete, false);
  assert.deepStrictEqual((await chunkCacheFiles(fixture4b.cacheDir)).map((name) => name.slice(0, 9)), ["chunk-001", "chunk-003"], "only truly completed views can be cached");
  assert.strictEqual((await globalCacheFiles(fixture4b.cacheDir)).length, 0);
  assert(failed4.messages.some((message) => message.includes("chưa có state DONE")));

  // ------------------------------------------------ Test 5: reducer fails
  const fixture5 = await createPackage();
  const reduceTimeout = (kind, prompt, call) => (kind === "reduce" ? PRINT_TIMEOUT : defaultResponder({ durationSec: DURATION })(kind, prompt, call));
  const failed5 = await run(fixture5, reduceTimeout);
  assert(failed5.error && failed5.error.message.includes("[PHASE_A_REDUCE] FAILED"), failed5.error?.message);
  assert.deepStrictEqual(failed5.kinds.filter((kind) => kind === "reduce").length, 1, "a reducer timeout is not retried blindly");
  assert.strictEqual(failed5.timing.sourceUnderstanding.reduce.videoViewFileCount, 0);
  assert.strictEqual((await chunkCacheFiles(fixture5.cacheDir)).length, 3, "map results survive a reducer failure");
  const retry5 = await run(fixture5);
  assert.ifError(retry5.error);
  assert.deepStrictEqual(retry5.kinds, ["reduce", "phase_b"], "rerun = reducer only");
  assert.strictEqual(retry5.videoViews, 0, "no video rewatch after a reducer failure");
  assert.strictEqual(retry5.timing.sourceUnderstanding.map.cacheHits, 3);

  // ------------------------------------------------ Test 6: reducer calls view_file
  const fixture6 = await createPackage();
  const sneakyReducer = (kind, prompt, call) => {
    if (kind === "reduce") {
      return { viewFiles: [path.join(fixture6.pass1Dir, "analysis-proxy-chunk-001.mp4")], envelope: defaultResponder({ durationSec: DURATION })(kind, prompt, call).envelope };
    }
    return defaultResponder({ durationSec: DURATION })(kind, prompt, call);
  };
  const failed6 = await run(fixture6, sneakyReducer);
  assert(failed6.error, "reducer view_file must FAIL");
  assert.strictEqual(failed6.error.kind, "reduce_forbidden_tool");
  assert(failed6.error.message.includes("view_file"), failed6.error.message);
  const reduceCalls6 = failed6.calls.filter((call) => call.kind === "reduce");
  assert.strictEqual(reduceCalls6.length, 1, "no retry after a forbidden tool");
  assert.strictEqual(reduceCalls6[0].killed, true, "the reducer process is killed immediately");
  assert.strictEqual((await globalCacheFiles(fixture6.cacheDir)).length, 0, "no global cache from a reducer that touched video");

  // ------------------------------------------------ map watching another chunk's proxy is refused
  const fixture7 = await createPackage();
  const wrongVideo = (kind, prompt, call) => {
    if (kind === "map" && mapTaskFromPrompt(prompt).chunkId === "chunk-003") {
      const task = mapTaskFromPrompt(prompt);
      return {
        viewFiles: [task.proxy, path.join(fixture7.pass1Dir, "analysis-proxy-chunk-001.mp4")],
        envelope: { artifacts: [{ filename: "chunk-understanding-chunk-003.json", script: buildChunkUnderstanding("chunk-003", task.startSec, task.endSec) }] }
      };
    }
    return defaultResponder({ durationSec: DURATION })(kind, prompt, call);
  };
  const failed7 = await run(fixture7, wrongVideo);
  assert(failed7.error && failed7.error.message.includes("chunk-003"));
  assert.strictEqual(failed7.timing.sourceUnderstanding.map.chunks[2].failureKind, "forbidden_tool");

  // ------------------------------------------------ default concurrency (1) is honoured
  const fixture8 = await createPackage();
  const serial = await run(fixture8);
  assert.ifError(serial.error);
  assert.strictEqual(serial.live.maxActive, 1);
  assert.deepStrictEqual(serial.mapChunkIds, ["chunk-001", "chunk-002", "chunk-003"]);

  for (const item of [fixture, fixture4, fixture4b, fixture5, fixture6, fixture7, fixture8]) await fs.rm(item.root, { recursive: true, force: true });
  console.log("sourceUnderstandingMapReduce tests passed (1 cold, 2 warm, 3 corrupted chunk, 4 chunk timeout, 5 reducer failure, 6 reducer view_file, wrong-proxy guard, concurrency)");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
