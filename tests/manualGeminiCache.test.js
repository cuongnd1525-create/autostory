const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const ManualGeminiPackService = require("../electron/services/manualGeminiPackService");
const {
  buildSourceFingerprint,
  buildAnalysisCacheKeys,
  buildProxyCacheKey
} = require("../electron/services/manualGeminiPackService");
const {
  resolveManualGeminiManifestPath
} = require("../electron/services/dubbingService");

async function run() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-cache-test-"));
  const sourcePath = path.join(tempDir, "source.mp4");

  try {
    await fs.writeFile(sourcePath, Buffer.from("video-content-a"));
    const firstFingerprint = await buildSourceFingerprint(sourcePath);
    const unchangedFingerprint = await buildSourceFingerprint(sourcePath);
    assert.strictEqual(firstFingerprint.key, unchangedFingerprint.key);

    await fs.writeFile(sourcePath, Buffer.from("video-content-b"));
    const changedFingerprint = await buildSourceFingerprint(sourcePath);
    assert.notStrictEqual(firstFingerprint.key, changedFingerprint.key);

    const baseSettings = {
      pythonPath: "python",
      ffmpegPath: "ffmpeg",
      whisperCommand: "whisper",
      whisperModel: "small"
    };
    const baseKeys = buildAnalysisCacheKeys({
      sourceFingerprint: "source-key",
      settings: baseSettings,
      sourceLanguage: "en"
    });
    const sameKeys = buildAnalysisCacheKeys({
      sourceFingerprint: "source-key",
      settings: { ...baseSettings },
      sourceLanguage: "en"
    });
    assert.deepStrictEqual(baseKeys, sameKeys);

    const changedWhisperKeys = buildAnalysisCacheKeys({
      sourceFingerprint: "source-key",
      settings: { ...baseSettings, whisperModel: "medium" },
      sourceLanguage: "en"
    });
    assert.strictEqual(baseKeys.sceneKey, changedWhisperKeys.sceneKey);
    assert.notStrictEqual(baseKeys.transcriptKey, changedWhisperKeys.transcriptKey);

    const changedDetectorKeys = buildAnalysisCacheKeys({
      sourceFingerprint: "source-key",
      settings: { ...baseSettings, ffmpegPath: "custom-ffmpeg" },
      sourceLanguage: "en"
    });
    assert.notStrictEqual(baseKeys.sceneKey, changedDetectorKeys.sceneKey);

    const changedSceneWindowKeys = buildAnalysisCacheKeys({
      sourceFingerprint: "source-key",
      settings: { ...baseSettings, sceneDetectionMaxSceneDurationSec: 30 },
      sourceLanguage: "en"
    });
    assert.notStrictEqual(baseKeys.sceneKey, changedSceneWindowKeys.sceneKey);
    assert.strictEqual(baseKeys.detectionProxyKey, changedSceneWindowKeys.detectionProxyKey);

    const manifest = {
      sceneDetector: "pyscenedetect",
      scenes: [
        { sceneId: "scene_0001", startSec: 0, endSec: 4 },
        { sceneId: "scene_0002", startSec: 4, endSec: 8 }
      ]
    };
    const proxyKey = buildProxyCacheKey(baseKeys.sceneKey, manifest);
    const changedProxyKey = buildProxyCacheKey(baseKeys.sceneKey, {
      ...manifest,
      scenes: [
        { sceneId: "scene_0001", startSec: 0, endSec: 3.5 },
        { sceneId: "scene_0002", startSec: 3.5, endSec: 8 }
      ]
    });
    assert.notStrictEqual(proxyKey, changedProxyKey);

    const packageDir = path.join(tempDir, "analysis-pack");
    const evidenceInputPath = path.join(tempDir, "gemini-scene-evidence.json");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "scene-manifest.json"), JSON.stringify({
      sourceVideo: "source.mp4",
      videoDurationSec: 8,
      scenes: manifest.scenes
    }), "utf8");
    await fs.writeFile(evidenceInputPath, JSON.stringify({
      evidence: [
        ["evidence_0001", "scene_0001", 0, 2, "hook", 9],
        ["evidence_0002", "scene_0001", 2, 4, "context", 5],
        ["evidence_0003", "scene_0002", 4, 6, "escalation", 5],
        ["evidence_0004", "scene_0002", 6, 8, "climax", 5]
      ].map(([evidenceId, sceneId, sourceStartSec, sourceEndSec, narrativePhase, hookScore]) => ({
        evidenceId,
        sceneId,
        sourceStartSec,
        sourceEndSec,
        visualFacts: ["An officer completes a visible action and the occupant gives an immediate reaction."],
        dialogueEvidence: [{ text: "A complete verified source line." }],
        storyMeaning: "This complete beat advances the same central refusal.",
        narrativePhase,
        hookScore,
        viralScore: hookScore,
        completeBeat: true,
        cutSafety: "safe",
        continuityBefore: "The previous command leads into this beat.",
        continuityAfter: "This beat directly causes the next response.",
        confidence: 0.9
      }))
    }), "utf8");
    const workflowResult = await new ManualGeminiPackService().importEvidence({
      packageDir,
      evidencePath: evidenceInputPath,
      scriptPrompt: "FINAL SCRIPT BASE"
    });
    assert.strictEqual(workflowResult.evidenceCount, 4);
    assert.strictEqual(workflowResult.nextStage, "story_blueprint");
    assert.ok(await fs.readFile(workflowResult.evidencePath, "utf8"));
    const generatedScriptPrompt = await fs.readFile(workflowResult.scriptPromptPath, "utf8");
    assert.ok(generatedScriptPrompt.includes("evidence_0001"));
    assert.ok(generatedScriptPrompt.includes("story-blueprint.json"));

    const nestedPackageDir = path.join(tempDir, "nested-analysis-pack");
    const nestedPass1Dir = path.join(nestedPackageDir, "01-GUI-GEMINI");
    await fs.mkdir(nestedPass1Dir, { recursive: true });
    await fs.writeFile(path.join(nestedPass1Dir, "scene-manifest.json"), JSON.stringify({
      sourceVideo: "source.mp4",
      videoDurationSec: 8,
      scenes: manifest.scenes
    }), "utf8");
    const nestedWorkflowResult = await new ManualGeminiPackService().importEvidence({
      packageDir: nestedPackageDir,
      evidencePath: evidenceInputPath,
      scriptPrompt: "NESTED FINAL SCRIPT BASE",
      workflow: "manual_gemini_story_recut"
    });
    assert.strictEqual(
      nestedWorkflowResult.pass2UploadDir,
      path.join(nestedPackageDir, "02-GUI-GEMINI")
    );
    assert.strictEqual(
      nestedWorkflowResult.scriptPromptPath,
      path.join(nestedPackageDir, "02-GUI-GEMINI", "02-gemini-script-prompt.txt")
    );
    const nestedScriptPrompt = await fs.readFile(nestedWorkflowResult.scriptPromptPath, "utf8");
    assert.ok(nestedScriptPrompt.includes("Create exactly ONE Story Recut JSON"));
    assert.ok(!nestedScriptPrompt.includes("Write exactly three final scripts"));
    assert.ok(nestedScriptPrompt.includes('Root artifactType must equal "story_recut_script"'));
    assert.ok(nestedScriptPrompt.includes("Root segments must be a non-empty array"));
    assert.ok(nestedScriptPrompt.includes("Do not return scene-evidence.json again"));
    const nestedPackageInfo = JSON.parse(await fs.readFile(
      path.join(nestedPackageDir, "package-info.json"),
      "utf8"
    ));
    assert.strictEqual(nestedPackageInfo.workflow, "manual_gemini_story_recut");
    assert.strictEqual(
      await resolveManualGeminiManifestPath(nestedPackageDir),
      path.join(nestedPass1Dir, "scene-manifest.json")
    );
    assert.strictEqual(
      await resolveManualGeminiManifestPath(packageDir),
      path.join(packageDir, "scene-manifest.json")
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log("manual Gemini cache tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
