"use strict";

// End-to-end (real ffmpeg) tests for the fast-draft caches used by
// manual_gemini_draft_review:
//  - Edge neural TTS is cached persistently in audio/.voice-cache keyed by
//    text + voice + rate + pitch + volume + delivery options.
//  - An existing file at the (index-named) voice outputPath is NEVER a cache hit.
//  - Segment render cache: a V2 that changes one beat re-renders only that beat.
//  - Variants render with bounded concurrency without losing project updates.

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const EdgeTtsService = require("../electron/services/edgeTtsService");
const ProjectStore = require("../electron/services/projectStore");
const DubbingService = require("../electron/services/dubbingService");

const synthCalls = [];
let synthFallback = false;
EdgeTtsService.prototype.synthesizeSpeech = async function fakeEdge({ text, voiceName, outputPath, rate, pitch, volume }) {
  synthCalls.push({ text, voiceName, outputPath, rate, pitch, volume });
  const seconds = Math.max(0.6, Math.min(4, String(text).split(/\s+/).length * 0.3));
  const frequency = 200 + (String(text).length % 50) * 10;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${seconds}`, "-c:a", "libmp3lame", "-b:a", "64k", outputPath]);
  return { resolvedVoice: voiceName || "en-US-GuyNeural", fallbackUsed: synthFallback };
};

function makeVideo(filePath, durationSec = 24) {
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=12",
    "-f", "lavfi", "-i", "sine=frequency=330", "-t", String(durationSec),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", filePath
  ]);
}

function segment(id, start, end, voiceover = "") {
  return {
    id, segmentId: id, sceneId: "scene_0001", sourceStartSec: start, sourceEndSec: end,
    startSec: 0, endSec: end - start, duration: end - start, playbackSpeed: 1,
    audio_mode: voiceover ? "voiceover_only" : "original_audio", voiceover_text: voiceover,
    preview_vi: "phụ đề", previewSubtitleVi: "phụ đề"
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-draft-cache-"));
  const workspaceRoot = path.join(root, "workspace");
  const audioDir = path.join(root, "audio");
  await fs.mkdir(audioDir, { recursive: true });
  const dubbing = new DubbingService(new ProjectStore());
  const settings = { edgeVoiceRate: 5, edgeVoicePitchHz: 0, edgeVoiceVolume: 100 };
  const project = { draftVoiceMode: "edge_neural", voiceProvider: "kokoro", voiceId: "af_heart" };

  // ------------------------------------------------------------ Edge TTS cache
  const out1 = path.join(audioDir, "draft-highlight-v1-0004.mp3");
  const first = await dubbing.synthesizeFastDraftVoiceDirect({ project, settings, text: "Officers break the door open.", outputPath: out1 });
  assert.strictEqual(first.cacheHit, false);
  assert.strictEqual(synthCalls.length, 1);
  const second = await dubbing.synthesizeFastDraftVoiceDirect({
    project, settings, text: "Officers break the door open.", outputPath: path.join(audioDir, "draft-highlight-v2-0001.mp3")
  });
  assert.strictEqual(second.cacheHit, true, "same text/voice/rate/pitch/volume must hit across output paths");
  assert.strictEqual(synthCalls.length, 1);
  assert(first.cachePath.includes(`${path.sep}.voice-cache${path.sep}`), "edge draft voice must be cached persistently in .voice-cache");
  assert.strictEqual((await fs.stat(first.cachePath)).size > 512, true);

  // Stale-file regression: V2 rewrites beat 4 -> same output path, new text.
  const before = await fs.readFile(out1);
  const rewritten = await dubbing.synthesizeFastDraftVoiceDirect({ project, settings, text: "The suspect finally admits everything to the officer.", outputPath: out1 });
  assert.strictEqual(rewritten.cacheHit, false, "an existing outputPath with old text must never be reused");
  assert.strictEqual(synthCalls.length, 2);
  assert.notDeepStrictEqual(await fs.readFile(out1), before, "beat 4 audio must be regenerated for the new text");

  // Parameters that change audio must miss.
  await dubbing.synthesizeFastDraftVoiceDirect({ project, settings: { ...settings, edgeVoiceRate: 20 }, text: "Officers break the door open.", outputPath: out1 });
  assert.strictEqual(synthCalls.length, 3, "rate change must miss");
  await dubbing.synthesizeFastDraftVoiceDirect({ project, settings, text: "Officers break the door open.", outputPath: out1, voiceRenderOptions: { speechRateMultiplier: 1.2 } });
  assert.strictEqual(synthCalls.length, 4, "delivery option change must miss");
  await dubbing.synthesizeFastDraftVoiceDirect({ project: { ...project, draftVoiceMode: "custom", draftVoiceProvider: "edge_neural", draftVoiceId: "en-US-AriaNeural" }, settings, text: "Officers break the door open.", outputPath: out1 });
  assert.strictEqual(synthCalls.length, 5, "voice change must miss");
  // Final-voice settings that the edge draft does not use must NOT invalidate it.
  const unaffected = await dubbing.synthesizeFastDraftVoiceDirect({ project: { ...project, voiceId: "bf_emma" }, settings, text: "Officers break the door open.", outputPath: out1 });
  assert.strictEqual(unaffected.cacheHit, true);
  // A fallback voice is never cached under the requested voice key.
  synthFallback = true;
  const fallback = await dubbing.synthesizeFastDraftVoiceDirect({ project, settings, text: "Fallback only line here.", outputPath: out1 });
  synthFallback = false;
  assert.strictEqual(fallback.cacheHit, false);
  await assert.rejects(fs.access(fallback.cachePath), "fallback audio must not be cached");

  // ------------------------------------------------------------ Segment render cache + concurrency
  const sourceVideoPath = path.join(root, "source.mp4");
  makeVideo(sourceVideoPath);
  const store = new ProjectStore();
  const created = await store.createProject(workspaceRoot, {
    title: "cache-test",
    sourceVideoPath,
    mode: "highlight_cut",
    analysisWorkflow: "manual_gemini_draft_review"
  });
  const beats = (label) => [
    segment(`${label}_1`, 0, 3),
    segment(`${label}_2`, 3, 6, "Officers arrive at the house."),
    segment(`${label}_3`, 6, 9),
    segment(`${label}_4`, 9, 12, "The resident refuses to open the door."),
    segment(`${label}_5`, 12, 15)
  ];
  const variants = ["variant_01", "variant_02"].map((id, index) => ({
    id, index, label: `Variant ${index + 1}`, scriptId: [1, 3][index], segments: beats(id), warnings: [], artifacts: {}
  }));
  await store.updateProject(workspaceRoot, created.id, {
    draftVoiceMode: "edge_neural",
    analysis: { activeVariantId: "variant_01", highlightVariants: variants, segments: variants[0].segments, scenes: [] }
  });
  const renderSettings = { ...settings, draftRenderConcurrency: 2 };
  const progress = [];
  const startedAt = Date.now();
  await dubbing.renderAllHighlightFastDraftVariants({ workspaceRoot, projectId: created.id, settings: renderSettings, onProgress: (item) => progress.push(item) });
  const coldMs = Date.now() - startedAt;
  let saved = await store.getProject(workspaceRoot, created.id);
  for (const variant of saved.analysis.highlightVariants) {
    assert(variant.artifacts.fastDraftVideoPath, `${variant.id} must keep its draft path (no lost concurrent update)`);
    assert(variant.artifacts.fastDraftRenderMetrics, `${variant.id} must record render metrics`);
  }
  const coldV1 = saved.analysis.highlightVariants[0].artifacts.fastDraftRenderMetrics;
  const coldV2 = saved.analysis.highlightVariants[1].artifacts.fastDraftRenderMetrics;
  // Variants share identical source ranges/voice text: variant_02 reuses many of variant_01's
  // beats only if it runs after them; with concurrency both may miss. Total hits+misses = 10.
  assert.strictEqual(coldV1.segmentCacheHits + coldV1.segmentCacheMisses + coldV2.segmentCacheHits + coldV2.segmentCacheMisses, 10);
  assert(progress.some((item) => /song song 2/.test(item.message || "")), "batch must report the concurrency used");

  // V2 of variant_01: change only beat 4's narration.
  saved = await store.getProject(workspaceRoot, created.id);
  const v2Segments = saved.analysis.highlightVariants[0].segments.map((item, index) => (
    index === 3 ? { ...item, voiceover_text: "Then the resident slams the door shut on the officers." } : item
  ));
  const v2Project = {
    ...saved,
    analysis: {
      ...saved.analysis,
      activeVariantId: "variant_01",
      highlightVariants: saved.analysis.highlightVariants.map((item) => (item.id === "variant_01" ? { ...item, segments: v2Segments, revisionNumber: 2 } : item)),
      segments: v2Segments
    }
  };
  await store.saveProject(workspaceRoot, v2Project);
  const v2Result = await dubbing.renderHighlightFastDraft({ workspaceRoot, projectId: created.id, settings: renderSettings, onProgress: () => {} });
  const metrics = v2Result.renderMetrics;
  assert.deepStrictEqual(metrics.segmentCacheLog, ["Beat 1 HIT", "Beat 2 HIT", "Beat 3 HIT", "Beat 4 MISS", "Beat 5 HIT"], metrics.segmentCacheLog.join(", "));
  assert.strictEqual(metrics.segmentCacheHits, 4);
  assert.strictEqual(metrics.segmentCacheMisses, 1);
  assert.strictEqual(metrics.ttsCacheMisses, 1, "only the rewritten narration is synthesized");
  assert.strictEqual(metrics.ttsCacheHits, 1);
  console.log(`draftRenderCache tests passed (cold 2-variant render ${coldMs}ms, V2 one-beat change: ${metrics.segmentCacheLog.join(", ")})`);
  await fs.rm(root, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
