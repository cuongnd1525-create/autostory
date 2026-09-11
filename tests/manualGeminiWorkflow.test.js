const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const ManualGeminiPackService = require("../electron/services/manualGeminiPackService");

function makeEvidence(count = 8) {
  return {
    artifactType: "scene_evidence",
    schemaVersion: 1,
    sourceVideo: "input.mp4",
    evidence: Array.from({ length: count }, (_, index) => ({
      evidenceId: `evidence_${String(index + 1).padStart(4, "0")}`,
      sceneId: "scene_0001",
      sourceStartSec: Number((index * 2).toFixed(3)),
      sourceEndSec: Number(((index + 1) * 2).toFixed(3)),
      visualFacts: [`The camera verifies complete action ${index + 1} and its immediate visible reaction.`],
      dialogueEvidence: [{ text: `Verified complete source line ${index + 1}.` }],
      storyMeaning: `Causal story beat ${index + 1} advances the verified incident.`,
      narrativePhase: ["hook", "context", "context", "escalation", "escalation", "climax", "consequence", "aftermath"][index] || "aftermath",
      hookScore: index === 0 ? 9 : 5,
      viralScore: index === 0 ? 9 : 7,
      completeBeat: true,
      cutSafety: "safe",
      continuityBefore: index ? `Action ${index}` : "The incident begins.",
      continuityAfter: `Action ${index + 2}`,
      confidence: 0.95
    }))
  };
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manual-gemini-flow-"));
  const packageDir = path.join(root, "pack");
  const pass1Dir = path.join(packageDir, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const manifest = {
    sourceVideo: "input.mp4",
    videoDurationSec: 16,
    scenes: [{ sceneId: "scene_0001", startSec: 0, endSec: 16 }]
  };
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(packageDir, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_pro_two_pass"
  }), "utf8");
  const service = new ManualGeminiPackService({});

  const weakPath = path.join(root, "weak.json");
  await fs.writeFile(weakPath, JSON.stringify(makeEvidence(1)), "utf8");
  const weak = await service.importEvidence({ packageDir, evidencePath: weakPath });
  assert.strictEqual(weak.nextStage, "evidence_repair");
  assert.strictEqual(weak.qualityGate.passed, false);
  assert.strictEqual(weak.evidencePath, "");

  const strongPath = path.join(root, "strong.json");
  await fs.writeFile(strongPath, JSON.stringify(makeEvidence()), "utf8");
  const strong = await service.importEvidence({ packageDir, evidencePath: strongPath });
  assert.strictEqual(strong.nextStage, "story_blueprint");
  assert.strictEqual(strong.qualityGate.passed, true);
  assert.ok(strong.evidencePath.endsWith("scene-evidence.json"));

  const blueprintPath = path.join(root, "story-blueprint.json");
  await fs.writeFile(blueprintPath, JSON.stringify({
    artifactType: "story_blueprint",
    centralCharacter: "The driver",
    primaryConflict: "A refusal escalates the stop.",
    audienceQuestion: "Why does the stop escalate?",
    factualCausalChain: ["The refusal causes the confrontation."],
    macroBlocks: [
      { macroBlockId: "m1", storyFunction: "hook", evidenceIds: ["evidence_0001"], transitionReason: "Opening." },
      { macroBlockId: "m2", storyFunction: "context", evidenceIds: ["evidence_0002", "evidence_0003"], transitionReason: "The hook raises the context question." },
      { macroBlockId: "m3", storyFunction: "escalation", evidenceIds: ["evidence_0004", "evidence_0005"], transitionReason: "The refusal escalates the conflict." },
      { macroBlockId: "m4", storyFunction: "climax", evidenceIds: ["evidence_0006"], transitionReason: "The escalation causes the confrontation." },
      { macroBlockId: "m5", storyFunction: "consequence", evidenceIds: ["evidence_0007", "evidence_0008"], transitionReason: "The confrontation produces the outcome." }
    ]
  }), "utf8");
  const variants = await service.importBlueprint({
    packageDir,
    blueprintPath,
    scriptPrompt: "VOICE CALIBRATION PARAMETERS PROVIDED BY USER:\n- measuredWordsPerSecond: 2.9\n---"
  });
  assert.strictEqual(variants.nextStage, "variant_scripts");
  assert.deepStrictEqual(variants.variantDirs.map((item) => item.scriptId), [1, 3]);
  for (const item of variants.variantDirs) {
    const prompt = await fs.readFile(item.promptPath, "utf8");
    assert.ok(prompt.includes(`CREATE ONLY SCRIPT ${item.scriptId}`));
    assert.ok(prompt.includes("measuredWordsPerSecond: 2.9"));
  }

  const serializedPrompt = [
    "USER TASK INSTRUCTION - BUILD A 3-PART SERIALIZED TRUE-CRIME SERIES",
    "prompt_profile: serialized_interleaved",
    "- target duration for EACH Part: 70-105 seconds",
    "VOICE CALIBRATION PARAMETERS PROVIDED BY USER:",
    "- measuredWordsPerSecond: 2.9",
    "---"
  ].join("\n");
  await assert.rejects(
    service.importBlueprint({ packageDir, blueprintPath, scriptPrompt: serializedPrompt }),
    /phân bổ Series Part 1-3 chưa hợp lệ/
  );

  const serializedBlueprintPath = path.join(root, "story-blueprint-series.json");
  await fs.writeFile(serializedBlueprintPath, JSON.stringify({
    artifactType: "story_blueprint",
    centralCharacter: "The driver",
    primaryConflict: "A refusal escalates the stop.",
    audienceQuestion: "Why does the stop escalate?",
    factualCausalChain: ["The refusal causes the confrontation."],
    macroBlocks: [
      { macroBlockId: "m1", storyFunction: "hook", evidenceIds: ["evidence_0001"], partNumbers: [1, 2, 3], transitionReason: "Shared opening." },
      { macroBlockId: "m2", storyFunction: "context", evidenceIds: ["evidence_0002", "evidence_0003"], partNumbers: [1], transitionReason: "The hook raises the context question." },
      { macroBlockId: "m3", storyFunction: "escalation", evidenceIds: ["evidence_0004", "evidence_0005"], partNumbers: [2], transitionReason: "The refusal escalates the conflict." },
      { macroBlockId: "m4", storyFunction: "climax", evidenceIds: ["evidence_0006"], partNumbers: [3], transitionReason: "The escalation causes the confrontation." },
      { macroBlockId: "m5", storyFunction: "consequence", evidenceIds: ["evidence_0007", "evidence_0008"], partNumbers: [3], transitionReason: "The confrontation produces the immediate outcome." }
    ]
  }), "utf8");
  const serializedVariants = await service.importBlueprint({
    packageDir,
    blueprintPath: serializedBlueprintPath,
    scriptPrompt: serializedPrompt
  });
  for (const [index, item] of serializedVariants.variantDirs.entries()) {
    const prompt = await fs.readFile(item.promptPath, "utf8");
    assert.ok(prompt.includes(`CREATE SERIALIZED PART ${index + 1} ONLY`));
    assert.ok(prompt.includes("Final duration must be 70-105 seconds"));
    assert.ok(prompt.includes("CRITICAL ANTI-TALKING-HEAD RULE"));
    assert.ok(prompt.includes("ANTI-HALLUCINATION PROTOCOL"));
    assert.ok(!prompt.includes("3 DISTINCT SCRIPT ANGLES"));
    assert.ok(!prompt.includes("80/20 Raw Reality"));
  }
  await fs.rm(root, { recursive: true, force: true });
  console.log("manual Gemini workflow tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
