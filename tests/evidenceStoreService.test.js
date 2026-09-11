const assert = require("assert");

const {
  EvidenceStoreService,
  normalizeScene,
  buildSceneEvidence
} = require("../electron/services/evidenceStoreService");

function makeStore() {
  const service = new EvidenceStoreService();
  return service.build({
    project: { id: "project_predator_test", title: "Predator Test" },
    videoPath: "D:/sample/predator.mp4",
    sceneMetadata: {
      provider: "local-scene-metadata",
      transcriptProvider: "whisper",
      scenes: [
        {
          sceneId: "scene_0001",
          startSec: 0,
          endSec: 8,
          audioTranscript: "Run, it is coming through the trees.",
          localVisualTags: ["forest", "running person", "predator creature"],
          motionIntensity: "HIGH",
          motionScore: 81,
          audioEnergy: "LOUD",
          lightChange: "FLASH"
        },
        {
          sceneId: "scene_0002",
          startSec: 8,
          endSec: 14,
          localVisualTags: "robot, damaged face",
          motionIntensity: "LOW",
          audioEnergy: "QUIET",
          lightChange: "NONE"
        },
        {
          sceneId: "scene_0003",
          startSec: 14,
          endSec: 18
        }
      ]
    }
  });
}

function testEvidenceStoreSchemaAndFacts() {
  const store = makeStore();
  assert.strictEqual(store.schemaVersion, "evidence-store.v1");
  assert.deepStrictEqual(store.policy.priority, ["Accuracy", "Grounding", "Story Coherence", "Retention", "Virality"]);
  assert.strictEqual(store.sources.transcriptProvider, "whisper");
  assert.strictEqual(store.scenes.length, 3);
  assert(store.evidence.some((entry) => entry.type === "dialogue" && entry.sceneId === "scene_0001"));
  assert(store.facts.some((fact) => fact.text === "Run, it is coming through the trees."));
}

function testWeakScenesRemainWarnings() {
  const store = makeStore();
  const weakScene = store.scenes.find((scene) => scene.sceneId === "scene_0003");
  assert(weakScene.confidence < 0.45, "empty scene should be weak evidence");
  assert(store.report.weakScenes.some((scene) => scene.sceneId === "scene_0003"));
  assert(store.report.warnings.some((warning) => warning.includes("weak evidence")));
}

function testStringVisualTagsAreNormalized() {
  const store = makeStore();
  const robotScene = store.scenes.find((scene) => scene.sceneId === "scene_0002");
  assert(robotScene.objects.some((object) => object.label === "robot"));
  assert(robotScene.objects.some((object) => object.label === "damaged face"));
}

function testSceneEvidenceSeparatesHypotheses() {
  const scene = normalizeScene({
    sceneId: "scene_0042",
    startSec: 10,
    endSec: 12,
    localVisualTags: ["monster", "forest"],
    motionIntensity: "HIGH"
  });
  const evidence = buildSceneEvidence(scene);
  const visual = evidence.find((entry) => entry.type === "visual");
  assert(visual.hypotheses.length >= 1, "visual-only tags should remain hypotheses");
  assert.strictEqual(visual.facts.length, 0, "suggested visual tags should not become confirmed facts");
}

function testCharacterCandidatesAreNotConfirmedCharacters() {
  const store = makeStore();
  const candidates = store.scenes.flatMap((scene) => scene.characterCandidates);
  assert(candidates.length >= 1, "human/person tags should produce candidates");
  assert(candidates.every((candidate) => candidate.confidence < 0.9), "Phase 1 should not assert stable characters from weak local tags");
}

testEvidenceStoreSchemaAndFacts();
testWeakScenesRemainWarnings();
testStringVisualTagsAreNormalized();
testSceneEvidenceSeparatesHypotheses();
testCharacterCandidatesAreNotConfirmedCharacters();

console.log("evidenceStoreService tests passed");
