const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const DubbingService = require("../electron/services/dubbingService");
const FfmpegService = require("../electron/services/ffmpegService");
const ProjectStore = require("../electron/services/projectStore");

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-story-recut-import-"));
  const originalProbeVideo = FfmpegService.prototype.probeVideo;
  try {
    const sourceVideoPath = path.join(root, "source.mp4");
    const packageDir = path.join(root, "story-recut-pack");
    const pass1Dir = path.join(packageDir, "01-GUI-GEMINI");
    const storyJsonPath = path.join(root, "story-recut.json");
    await fs.mkdir(pass1Dir, { recursive: true });
    await fs.writeFile(sourceVideoPath, Buffer.from("fake-video"));

    const evidence = [
      ["e1", "scene_1", "run_hook", 100, 110, "hook", 9.4],
      ["e2", "scene_2", "run_story", 0, 15, "context", 7.5],
      ["e3", "scene_3", "run_story", 15, 35, "escalation", 8.2],
      ["e4", "scene_4", "run_story", 35, 50, "climax", 9.1],
      ["e5", "scene_5", "run_story", 50, 60, "consequence", 8.4]
    ].map(([evidenceId, sceneId, sourceRunId, sourceStartSec, sourceEndSec, narrativePhase, hookScore]) => ({
      evidenceId,
      sceneId,
      sourceRunId,
      sourceStartSec,
      sourceEndSec,
      narrativePhase,
      hookScore,
      visualFacts: [`Verified ${narrativePhase} action.`],
      dialogueEvidence: [],
      storyMeaning: `Verified ${narrativePhase} meaning.`,
      completeBeat: true,
      cutSafety: "safe"
    }));
    await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({
      sourceVideo: path.basename(sourceVideoPath),
      videoDurationSec: 200,
      scenes: evidence.map((item) => ({
        sceneId: item.sceneId,
        startSec: item.sourceStartSec,
        endSec: item.sourceEndSec
      }))
    }), "utf8");
    await fs.writeFile(path.join(packageDir, "scene-evidence.json"), JSON.stringify({ evidence }), "utf8");

    let cursor = 0;
    const segments = evidence.map((item, index) => {
      const duration = item.sourceEndSec - item.sourceStartSec;
      const segment = {
        id: `recut_${index + 1}`,
        evidenceId: item.evidenceId,
        sceneId: item.sceneId,
        sourceRunId: item.sourceRunId,
        macroBlockId: `macro_${index + 1}`,
        storyFunction: item.narrativePhase,
        transitionReason: index === 0 ? "Opening hook." : "Causal continuation.",
        sourceStartSec: item.sourceStartSec,
        sourceEndSec: item.sourceEndSec,
        startSec: cursor,
        endSec: cursor + duration,
        playbackSpeed: index === 2 ? 1.35 : 1,
        audio_mode: index === 2 ? "voiceover_only" : "original_audio",
        voiceover_text: index === 2 ? "This tool narration must be removed during import." : "",
        preview_vi: `Cảnh ${item.narrativePhase}`
      };
      cursor += duration;
      return segment;
    });
    await fs.writeFile(storyJsonPath, JSON.stringify({
      mode: "story_recut",
      title: "Story Recut Smoke Test",
      shared_top_banner_text: "One Decision Changed Everything That Followed",
      language: "en",
      total_target_sec: cursor,
      story_blueprint: {
        centralCharacter: "Verified subject",
        primaryConflict: "Verified conflict",
        macroBlocks: segments.map((segment) => ({
          macroBlockId: segment.macroBlockId,
          storyFunction: segment.storyFunction,
          sourceRunIds: [segment.sourceRunId]
        }))
      },
      segments
    }), "utf8");

    FfmpegService.prototype.probeVideo = async () => ({
      duration: 200,
      width: 1920,
      height: 1080,
      hasAudio: true
    });

    const store = new ProjectStore();
    const project = await store.createProject(root, {
      title: "story-recut-smoke",
      sourceVideoPath,
      mode: "highlight_cut",
      analysisWorkflow: "manual_gemini_story_recut",
      manualGeminiPackPath: packageDir,
      storyScriptPath: storyJsonPath,
      storyScriptPaths: [storyJsonPath]
    });
    const service = new DubbingService(store);
    const imported = await service.importHighlightCutProject({
      workspaceRoot: root,
      projectId: project.id,
      settings: {},
      onProgress: () => {}
    });

    assert.strictEqual(imported.analysis.workflow, "manual_gemini_story_recut");
    assert.strictEqual(imported.analysis.highlightVariants.length, 1);
    assert.strictEqual(imported.analysis.sharedTopBannerText, "One Decision Changed Everything That Followed");
    assert.strictEqual(imported.analysis.segments.length, 5);
    assert.strictEqual(imported.analysis.highlightVariants[0].workflow, "story_recut");
    assert.strictEqual(imported.analysis.highlightVariants[0].audioStrategy, "source_audio_only");
    assert.strictEqual(imported.analysis.highlightVariants[0].voiceoverEnabled, false);
    assert.ok(imported.analysis.segments.every((segment) => segment.audioMode === "original_audio"));
    assert.ok(imported.analysis.segments.every((segment) => !segment.voiceoverText));
    assert.ok(imported.analysis.segments.every((segment) => segment.sourceVolume === 1));
    assert.ok(imported.analysis.segments.every((segment) => segment.playbackSpeed === 1));
    assert.strictEqual(imported.analysis.highlightVariants[0].viralPreflight.passed, true);
    assert.ok(imported.analysis.highlightVariants[0].viralPreflight.score >= 85);

    const staleVariant = {
      ...imported.analysis.highlightVariants[0],
      warnings: ["OLD_STALE_VIRAL_WARNING"],
      viralPreflight: {
        score: 49,
        grade: "D",
        passed: false,
        issues: ["OLD_STALE_VIRAL_WARNING"],
        diagnostics: {},
        metrics: { workflow: "story_recut" }
      }
    };
    await store.updateProject(root, project.id, {
      analysis: {
        ...imported.analysis,
        warnings: ["OLD_STALE_VIRAL_WARNING"],
        highlightVariants: [staleVariant],
        segments: staleVariant.segments
      }
    });

    const reviewed = await service.importReviewedScriptProject({
      workspaceRoot: root,
      projectId: project.id,
      settings: {},
      jsonPath: storyJsonPath
    });
    const reviewedVariant = reviewed.analysis.highlightVariants[0];
    assert.ok(reviewedVariant.viralPreflight.score >= 85);
    assert.strictEqual(reviewedVariant.viralPreflight.passed, true);
    assert.ok(!reviewedVariant.warnings.includes("OLD_STALE_VIRAL_WARNING"));
    assert.ok(!reviewed.analysis.warnings.includes("OLD_STALE_VIRAL_WARNING"));
    assert.strictEqual(reviewed.analysis.segments.length, reviewedVariant.segments.length);
    assert.strictEqual(reviewed.analysis.artifacts.reviewedScriptJsonPath, storyJsonPath);

    const regressedJsonPath = path.join(root, "story-recut-regressed.json");
    const regressedScript = JSON.parse(await fs.readFile(storyJsonPath, "utf8"));
    delete regressedScript.story_blueprint;
    regressedScript.segments = regressedScript.segments.map((segment, index) => ({
      ...segment,
      macroBlockId: "macro_only",
      storyFunction: index === 0 ? "hook" : "context",
      transitionReason: ""
    }));
    await fs.writeFile(regressedJsonPath, JSON.stringify(regressedScript), "utf8");
    const importedWithWarning = await service.importReviewedScriptProject({
      workspaceRoot: root,
      projectId: project.id,
      settings: {},
      jsonPath: regressedJsonPath
    });
    const warnedVariant = importedWithWarning.analysis.highlightVariants[0];
    assert.ok(warnedVariant.viralPreflight.score < reviewedVariant.viralPreflight.score);
    assert.ok(warnedVariant.warnings.some((warning) => warning.includes("Tool vẫn import theo quyết định của user")));
    const warningReport = JSON.parse(
      await fs.readFile(path.join(root, project.id, "analysis", "highlight-cut-review-regression-warning.json"), "utf8")
    );
    assert.strictEqual(warningReport.accepted, true);
    assert.strictEqual(warningReport.importedWithWarning, true);
    assert.ok(warningReport.candidate.score < warningReport.current.score);
  } finally {
    FfmpegService.prototype.probeVideo = originalProbeVideo;
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log("story recut import tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
