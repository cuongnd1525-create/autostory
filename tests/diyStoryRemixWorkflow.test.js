const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const DubbingService = require("../electron/services/dubbingService");
const FfmpegService = require("../electron/services/ffmpegService");
const ManualGeminiPackService = require("../electron/services/manualGeminiPackService");
const ProjectStore = require("../electron/services/projectStore");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "diy-remix-workflow-"));
  const pass1 = path.join(root, "01-GUI-GEMINI");
  await fs.mkdir(pass1, { recursive: true });
  const scenes = Array.from({ length: 4 }, (_, index) => ({
    sceneId: `scene_${String(index + 1).padStart(4, "0")}`,
    startSec: index * 10,
    endSec: (index + 1) * 10
  }));
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_diy_story_remix",
    pass1UploadDir: pass1
  }));
  await fs.writeFile(path.join(pass1, "scene-manifest.json"), JSON.stringify({
    sourceVideo: "diy.mp4",
    videoDurationSec: 40,
    scenes
  }));
  await fs.writeFile(path.join(pass1, "action-candidates.json"), JSON.stringify({ candidates: [] }));

  const phases = ["before", "process", "failure", "payoff"];
  const processMap = {
    artifactType: "diy_visual_process_map",
    schemaVersion: 1,
    sourceVideo: "diy.mp4",
    visualBeats: scenes.map((scene, index) => ({
      visualBeatId: `beat_${String(index + 1).padStart(4, "0")}`,
      sceneId: scene.sceneId,
      sourceStartSec: scene.startSec,
      sourceEndSec: scene.endSec - 1,
      phase: phases[index],
      visualFacts: [`Visible DIY operation ${index + 1} changes the same object.`],
      stateBefore: `Object state ${index + 1}`,
      visibleAction: `The creator performs operation ${index + 1}.`,
      stateAfter: `Object state ${index + 2}`,
      requiredBefore: index ? [`beat_${String(index).padStart(4, "0")}`] : [],
      hookPotential: index === 2 ? 9 : 5,
      payoffPotential: index === 3 ? 10 : 4,
      curiosityPotential: index === 2 ? 9 : 5,
      sourceSpeechPresent: false
    }))
  };
  const processMapPath = path.join(root, "gemini-process-map.json");
  await fs.writeFile(processMapPath, `\`\`\`json\n${JSON.stringify(processMap)}\n\`\`\``);

  const service = new ManualGeminiPackService();
  const evidenceResult = await service.importEvidence({
    packageDir: root,
    evidencePath: processMapPath,
    workflow: "manual_gemini_diy_story_remix",
    scriptPrompt: "Story angle: failure_to_success"
  });
  assert.strictEqual(evidenceResult.nextStage, "diy_story_blueprint");
  assert.strictEqual(evidenceResult.qualityGate.passed, true);
  assert.ok(evidenceResult.scriptPromptPath.endsWith("03-diy-story-blueprint-prompt.txt"));

  const blueprint = {
    artifactType: "diy_story_blueprint",
    schemaVersion: 1,
    storyAngle: "failure_to_success",
    hookVisualBeatIds: ["beat_0003"],
    blocks: [
      { blockId: "block_01", storyFunction: "hook", visualBeatIds: ["beat_0003"] },
      { blockId: "block_02", storyFunction: "setup", visualBeatIds: ["beat_0001"] },
      { blockId: "block_03", storyFunction: "process", visualBeatIds: ["beat_0002", "beat_0003"] },
      { blockId: "block_04", storyFunction: "obstacle", visualBeatIds: ["beat_0003"] },
      { blockId: "block_05", storyFunction: "payoff", visualBeatIds: ["beat_0004"] }
    ]
  };
  const blueprintPath = path.join(root, "gemini-blueprint.json");
  await fs.writeFile(blueprintPath, JSON.stringify(blueprint));
  const blueprintResult = await service.importBlueprint({
    packageDir: root,
    blueprintPath,
    scriptPrompt: "Measured voice speed: 3.2 words per second"
  });
  assert.strictEqual(blueprintResult.nextStage, "diy_voice_script");
  assert.strictEqual(blueprintResult.variantDirs.length, 1);
  const voicePrompt = await fs.readFile(blueprintResult.variantDirs[0].promptPath, "utf8");
  assert.ok(voicePrompt.includes("DIY VOICE-LOCKED SCRIPT"));
  assert.ok(voicePrompt.includes("Measured voice speed: 3.2 words per second"));
  assert.ok(voicePrompt.includes('"workflow": "diy_story_remix"'));

  const sourceVideoPath = path.join(root, "diy.mp4");
  const finalJsonPath = path.join(root, "diy-story-remix.json");
  await fs.writeFile(sourceVideoPath, "fake-video");
  const segmentBeatIds = ["beat_0003", "beat_0001", "beat_0002", "beat_0003", "beat_0004"];
  let outputCursor = 0;
  const finalSegments = segmentBeatIds.map((beatId, index) => {
    const beatIndex = Number(beatId.slice(-4)) - 1;
    const duration = 9;
    const segment = {
      id: `diy_${String(index + 1).padStart(4, "0")}`,
      segmentId: `diy_${String(index + 1).padStart(4, "0")}`,
      evidenceId: beatId,
      visualBeatId: beatId,
      sceneId: scenes[beatIndex].sceneId,
      macroBlockId: `block_${String(index + 1).padStart(2, "0")}`,
      sourceStartSec: scenes[beatIndex].startSec,
      sourceEndSec: scenes[beatIndex].endSec - 1,
      startSec: outputCursor,
      endSec: outputCursor + duration,
      playbackSpeed: 1,
      storyFunction: ["hook", "setup", "process", "obstacle", "payoff"][index],
      audio_mode: "voiceover_only",
      voiceover_text: `Connected narration for visible DIY operation ${beatIndex + 1}.`,
      caption: "",
      preview_vi: `Thao tác DIY ${beatIndex + 1}`
    };
    outputCursor += duration;
    return segment;
  });
  await fs.writeFile(finalJsonPath, JSON.stringify({
    artifactType: "highlight_cut_script",
    schemaVersion: 1,
    workflow: "diy_story_remix",
    title: "The Finish That Almost Failed",
    language: "en",
    sourceLanguage: "auto",
    style: "DIY Story Remix",
    total_target_sec: outputCursor,
    segments: finalSegments
  }));

  const originalProbeVideo = FfmpegService.prototype.probeVideo;
  FfmpegService.prototype.probeVideo = async () => ({
    duration: 40,
    width: 1080,
    height: 1920,
    hasAudio: true
  });
  try {
    const store = new ProjectStore();
    const project = await store.createProject(root, {
      title: "diy-remix-smoke",
      sourceVideoPath,
      mode: "highlight_cut",
      analysisWorkflow: "manual_gemini_diy_story_remix",
      manualGeminiPackPath: root,
      storyScriptPath: finalJsonPath,
      storyScriptPaths: [finalJsonPath]
    });
    const imported = await new DubbingService(store).importHighlightCutProject({
      workspaceRoot: root,
      projectId: project.id,
      settings: {},
      onProgress: () => {}
    });
    assert.strictEqual(imported.analysis.workflow, "manual_gemini_diy_story_remix");
    assert.strictEqual(imported.analysis.highlightVariants.length, 1);
    assert.strictEqual(imported.analysis.highlightVariants[0].workflow, "diy_story_remix");
    assert.strictEqual(imported.analysis.segments.length, 5);
    assert.ok(imported.analysis.segments.every((segment) => segment.audioMode === "voiceover_only"));
    assert.ok(imported.analysis.highlightVariants[0].warnings.some((warning) => warning.includes("đã lược bỏ visual beat")));
  } finally {
    FfmpegService.prototype.probeVideo = originalProbeVideo;
  }

  await fs.rm(root, { recursive: true, force: true });
  console.log("DIY Story Remix workflow tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
