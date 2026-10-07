"use strict";

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ProjectStore = require("../electron/services/projectStore");
const GeminiDraftReviewService = require("../electron/services/geminiDraftReviewService");
const { planReviewEvidenceReel } = require("../electron/services/reviewEvidenceReelService");

function makeVideo(filePath, durationSec) {
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=12",
    "-f", "lavfi", "-i", "sine=frequency=330", "-t", String(durationSec),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", filePath
  ]);
}

function probeDuration(filePath) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]).toString().trim());
}

(async () => {
  // ---------------------------------------------------------------- planner
  const plan = planReviewEvidenceReel({
    segments: [
      { sourceStartSec: 93, sourceEndSec: 105 },
      { sourceStartSec: 300, sourceEndSec: 320 },
      { sourceStartSec: 321, sourceEndSec: 330 }
    ],
    hookCandidates: [{ sourceStartSec: 10, sourceEndSec: 60 }, { sourceStartSec: 95, sourceEndSec: 100 }],
    actionCandidates: [
      { sourceStartSec: 500, sourceEndSec: 520, actionPriorityScore: 9 },
      { sourceStartSec: 300, sourceEndSec: 320, actionPriorityScore: 10 },
      { sourceStartSec: 700, sourceEndSec: 710, actionPriorityScore: 1 }
    ],
    sourceDurationSec: 1200
  });
  const asPairs = plan.ranges.map((range) => [range.start, range.end, range.reason]);
  assert.deepStrictEqual(asPairs, [
    [10, 30, "hook_candidate"],
    [89, 109, "used_in_draft"],
    [296, 334, "used_in_draft"],
    [500, 520, "replacement_candidate"],
    [700, 710, "replacement_candidate"]
  ], JSON.stringify(asPairs));
  assert(plan.ranges[1].reasons.includes("hook_candidate"), "a hook inside used footage is tagged, not duplicated");
  assert.strictEqual(plan.totalSec, 20 + 20 + 38 + 20 + 10);

  // Budget: used footage is never dropped; candidates are dropped first.
  const tight = planReviewEvidenceReel({
    segments: [{ sourceStartSec: 0, sourceEndSec: 50 }],
    hookCandidates: [{ sourceStartSec: 200, sourceEndSec: 220 }],
    sourceDurationSec: 600,
    options: { maxReelSec: 60 }
  });
  assert.deepStrictEqual(tight.ranges.map((range) => [range.start, range.end]), [[0, 54]]);
  assert.strictEqual(tight.dropped.length, 1);

  // ---------------------------------------------------------------- integration (real ffmpeg)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-evidence-reel-"));
  const workspaceRoot = path.join(root, "workspace");
  const packRoot = path.join(root, "pack");
  const pass1Dir = path.join(packRoot, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const sourceVideoPath = path.join(root, "source.mp4");
  const sourceDurationSec = 480;
  makeVideo(sourceVideoPath, sourceDurationSec);
  const proxyPath = path.join(root, "analysis-proxy-cache.mp4");
  await fs.copyFile(sourceVideoPath, proxyPath);
  const chunks = [0, 240].map((start, index) => ({
    chunkId: `proxy_chunk_00${index + 1}`, file: `analysis-proxy-chunk-00${index + 1}.mp4`,
    sourceStartSec: start, sourceEndSec: start + 240, durationSec: 240
  }));
  await fs.writeFile(path.join(pass1Dir, "proxy-chunks-manifest.json"), JSON.stringify({ sourceDurationSec, chunks }));
  for (const chunk of chunks) await fs.writeFile(path.join(pass1Dir, chunk.file), "chunk");
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({
    videoDurationSec: sourceDurationSec,
    scenes: [{ sceneId: "scene_0001", startSec: 0, endSec: 240 }, { sceneId: "scene_0002", startSec: 240, endSec: 480 }]
  }));
  await fs.writeFile(path.join(pass1Dir, "hook-candidates.json"), JSON.stringify({
    topCandidates: [{ hookId: "h1", sourceStartSec: 400, sourceEndSec: 410 }]
  }));
  await fs.writeFile(path.join(pass1Dir, "action-candidates.json"), JSON.stringify({
    candidates: [{ actionCandidateId: "a1", sourceStartSec: 300, sourceEndSec: 315, actionPriorityScore: 8 }]
  }));
  await fs.writeFile(path.join(pass1Dir, "source-transcript.srt"), "1\n00:00:01,000 --> 00:00:02,000\nPolice!\n");
  await fs.writeFile(path.join(packRoot, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review", pass1UploadDir: pass1Dir, proxyPath,
    proxyChunksManifestPath: path.join(pass1Dir, "proxy-chunks-manifest.json")
  }));

  const store = new ProjectStore();
  const project = await store.createProject(workspaceRoot, {
    title: "reel", sourceVideoPath, mode: "highlight_cut", analysisWorkflow: "manual_gemini_draft_review", manualGeminiPackPath: packRoot
  });
  const paths = store.getProjectPaths(workspaceRoot, project.id);
  const draftPath = path.join(paths.outputDir, "draft.mp4");
  makeVideo(draftPath, 20);
  await store.updateProject(workspaceRoot, project.id, {
    analysis: {
      activeVariantId: "variant_01",
      highlightVariants: [{
        id: "variant_01", label: "V1", scriptId: 1, promptProfile: "viral_tiktok_crime_part1", revisionNumber: 1,
        segments: [
          { id: "highlight_0001", sceneId: "scene_0001", sourceStartSec: 30, sourceEndSec: 40, duration: 10, playbackSpeed: 1, audioMode: "original_audio" },
          { id: "highlight_0002", sceneId: "scene_0002", sourceStartSec: 250, sourceEndSec: 260, duration: 10, playbackSpeed: 1, audioMode: "voiceover_only", voiceoverText: "Officers move in." }
        ],
        artifacts: { fastDraftVideoPath: draftPath }
      }]
    }
  });
  const service = new GeminiDraftReviewService(store);
  const result = await service.createPackage({ workspaceRoot, projectId: project.id, settings: {} });
  assert.strictEqual(result.evidenceMode, "evidence_reel", result.evidenceReelWarning);
  assert(result.uploadFiles.includes("review-evidence-reel.mp4"));
  assert(result.uploadFiles.includes("review-evidence-reel-manifest.json"));
  assert(!result.uploadFiles.some((name) => /analysis-proxy-chunk/.test(name)), "whole proxy chunks must not be sent");
  const manifest = JSON.parse(await fs.readFile(path.join(result.reviewDir, "review-evidence-reel-manifest.json"), "utf8"));
  assert.strictEqual(manifest.artifactType, "review_evidence_reel");
  assert.deepStrictEqual(manifest.segments.map((segment) => [segment.sourceStartSec, segment.sourceEndSec, segment.reason]), [
    [26, 44, "used_in_draft"],
    [246, 264, "used_in_draft"],
    [300, 315, "replacement_candidate"],
    [400, 410, "hook_candidate"]
  ]);
  for (const [index, segment] of manifest.segments.entries()) {
    assert(Math.abs((segment.reelEndSec - segment.reelStartSec) - (segment.sourceEndSec - segment.sourceStartSec)) < 0.3, `segment ${index} duration must match its source range`);
    if (index > 0) assert.strictEqual(segment.reelStartSec, manifest.segments[index - 1].reelEndSec, "reel ranges must be contiguous");
  }
  const reelSec = probeDuration(path.join(result.reviewDir, "review-evidence-reel.mp4"));
  assert(Math.abs(reelSec - 61) < 1.5, `reel duration ${reelSec}`);
  assert(result.reviewInputVideoDurationSec < 120, `review input ${result.reviewInputVideoDurationSec}s must be far below the 480s source`);
  const prompt = await fs.readFile(result.promptPath, "utf8");
  assert(prompt.includes("REVIEW EVIDENCE REEL CONTRACT"));
  assert(prompt.includes("reel 0.0-18.0s = SOURCE 26.0-44.0s (used_in_draft)"));
  const context = JSON.parse(await fs.readFile(path.join(result.reviewDir, "review-context.json"), "utf8"));
  assert.strictEqual(context.sourceProxyManifest.artifactType, "review_evidence_reel");
  const info = JSON.parse(await fs.readFile(path.join(result.packageRoot, "review-package-info.json"), "utf8"));
  assert.strictEqual(info.sourceCoverageComplete, false);
  assert.strictEqual(info.inputVideo.sourceEvidenceSec > 0, true);

  // Fallback: a broken proxy/source falls back to proxy chunks (controlled, reported).
  await fs.writeFile(proxyPath, "not a video");
  const brokenSource = path.join(root, "source.mp4");
  await fs.rename(brokenSource, `${brokenSource}.bak`);
  for (const chunk of chunks) await fs.writeFile(path.join(pass1Dir, chunk.file), "chunk-bytes");
  const fallback = await service.createPackage({ workspaceRoot, projectId: project.id, settings: {} });
  assert.strictEqual(fallback.evidenceMode, "proxy_chunks_fallback");
  assert(fallback.evidenceReelWarning.includes("review-evidence-reel.mp4"));

  await fs.rm(root, { recursive: true, force: true });
  console.log(`reviewEvidenceReel tests passed (480s source → ${reelSec.toFixed(1)}s reel)`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
