"use strict";

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const { createPhaseAwareSpawn, defaultResponder } = require("./helpers/fakeAntigravity");

const DURATION = 90;
const SCRIPTS = [1, 3, 4];
const SRT = "1\n00:00:01,000 --> 00:00:05,000\nDon't move\n";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-story-first-gate-"));
  const pass1Dir = path.join(root, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const promptPath = path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt");
  await fs.writeFile(promptPath, "### SELECTED PROMPT PROFILE\n- prompt_profile: viral_tiktok_crime_part1\nGenerate Script 1, Script 3 and Script 4.");
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({ videoDurationSec: DURATION, scenes: [{ sceneId: "scene_0001", startSec: 0, endSec: DURATION }] }));
  await fs.writeFile(path.join(pass1Dir, "source-transcript.srt"), SRT);
  await fs.writeFile(path.join(pass1Dir, "analysis-proxy.mp4"), "proxy-test-bytes");
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review", pass1UploadDir: pass1Dir, promptPath,
    cache: { sourceFingerprint: "story-first-gate-test", cacheDir: path.join(root, "source-cache") }
  }));
  return root;
}
function segment(start, end, audio_mode, voiceover_text = "") {
  return { id: `s_${String(start).replace(".", "_")}`, sceneId: "scene_0001", sourceStartSec: start, sourceEndSec: end, audio_mode, voiceover_text };
}
function repairedScript(id) {
  const base = { 1: 0, 3: 30, 4: 60 }[id];
  const hookStart = base + 1;
  return {
    artifactType: "story_recut_script", schemaVersion: 1, scriptId: id,
    title: `Part ${id}`,
    segments: [
      segment(hookStart, hookStart + 3, "original_audio"),
      segment(base + 8, base + 11, "voiceover_only", "But officers had received a different explanation earlier."),
      segment(base + 13, base + 17, "original_audio"),
      segment(base + 19, base + 22, "voiceover_only", "Before they could leave, the new evidence changed their questions."),
      segment(base + 27, base + 30, "original_audio")
    ]
  };
}
function weakScript(id) {
  return {
    artifactType: "story_recut_script", schemaVersion: 1, scriptId: id, title: `Weak ${id}`,
    segments: [segment(({ 1: 1, 3: 31, 4: 61 })[id], ({ 1: 4, 3: 34, 4: 64 })[id], "original_audio")]
  };
}
function envelopeFor(fn) {
  return { artifacts: SCRIPTS.map((id) => ({ filename: `script-${id}.json`, script: fn(id) })) };
}
async function exercise({ repairsFixIssue, coldViewer = false, initialIsValid = false } = {}) {
  const root = await fixture();
  const calls = [];
  let attemptedRepair = false;
  const normal = defaultResponder({ durationSec: DURATION });
  const responder = (kind, prompt, call) => {
    if (prompt.includes("INDEPENDENT COLD VIEWER / TRUE-CRIME EDITOR")) {
      const repaired = prompt.includes("audience-repaired.json");
      const passes = repaired && repairsFixIssue;
      const review = {
        artifactType: "audience_review", schemaVersion: 1,
        parts: SCRIPTS.map((id) => ({
          scriptId: id, score: passes ? 91 : 51, accepted: passes,
          hookQuestion: "What did the officers learn after that confrontation?",
          hookHandoffAssessment: "The selected timeline needs a clear transition from hook to the investigation.",
          narratorContribution: "The narrator must explain what changed and yield to authentic source quotes.",
          weakestMoment: "The initial hook ends without an adequate chronology and context bridge.",
          endingPayoffAssessment: "The final source-audio beat provides a verifiable chapter development.",
          issues: passes ? [] : [{
            code: "hook_handoff", segmentIndex: 1, sourceEventId: "e2",
            whyViewerLeaves: "The viewer cannot understand why the hook jumps to the next event.",
            requiredChange: "Add a grounded spoken bridge before the first rewind."
          }]
        }))
      };
      return { envelope: { artifacts: [{ filename: "audience-review.json", script: review }] } };
    }
    if (kind === "phase_b") {
      const repairing = prompt.includes("EDITORIAL REPAIR");
      if (repairing) attemptedRepair = true;
      return { envelope: envelopeFor(repairing
        ? (repairsFixIssue ? repairedScript : weakScript)
        : (initialIsValid ? repairedScript : weakScript)) };
    }
    return normal(kind, prompt, call);
  };
  const service = new Stage1({
    antigravityCommand: "agy",
    antigravityModel: "test-model",
    storyFirstEditorialEnabled: true,
    storyFirstColdViewerEnabled: coldViewer,
    // The synthetic 90-second source has three 29s chapters; bypass only
    // the production 60.5s monetization floor in this fake-CLI test.
    storyFirstUnifiedPreflightEnabled: false
  }, {
    spawn: createPhaseAwareSpawn({ calls, respond: responder }),
    authProbe: async () => ({ expiresAt: new Date(Date.now() + 3600000), expiredFlag: false })
  });
  let value = null, error = null;
  try {
    value = await service.run({ packageDir: root });
  } catch (caught) { error = caught; }
  const resultDir = path.join(root, "01-ANTIGRAVITY-RESULT");
  const report = JSON.parse(await fs.readFile(path.join(resultDir, "editorial-quality-report.json"), "utf8"));
  const intelligence = JSON.parse(await fs.readFile(path.join(resultDir, "story-intelligence.json"), "utf8"));
  const blueprint = JSON.parse(await fs.readFile(path.join(resultDir, "narrative-blueprint.json"), "utf8"));
  return { root, calls, value, error, report, intelligence, blueprint, attemptedRepair, resultDir };
}
(async () => {
  const good = await exercise({ repairsFixIssue: true });
  try {
    assert(!good.error, good.error?.stack || String(good.error));
    assert(good.attemptedRepair);
    assert(good.report.accepted);
    assert(good.report.repairedOnce);
    assert.strictEqual(good.report.results.length, 3);
    assert(good.report.results.every((x) => x.metrics.narrationBeats >= 2));
    assert.strictEqual(good.intelligence.artifactType, "story_intelligence");
    assert.strictEqual(good.blueprint.seriesParts.length, 3);
    assert.deepStrictEqual(good.calls.map((c) => c.kind), ["map", "reduce", "series_plan", "phase_b", "phase_b"]);
    assert(good.calls.filter((c) => c.kind === "phase_b").every((c) => !/view_file\("[^"]+\.mp4"\)/.test(c.prompt)));
    assert(good.value.validFiles.length === 3);
  } finally { await fs.rm(good.root, { recursive: true, force: true }); }

  const poor = await exercise({ repairsFixIssue: false });
  try {
    assert.strictEqual(poor.value, null, "low-quality V1 must not be accepted");
    assert(poor.error && poor.error.kind === "editorial_quality", poor.error?.stack);
    assert(!poor.report.accepted);
    assert(poor.attemptedRepair);
    assert.strictEqual(poor.calls.filter((c) => c.kind === "phase_b").length, 2, "repair capped to one pass");
  } finally { await fs.rm(poor.root, { recursive: true, force: true }); }
  const critic = await exercise({ repairsFixIssue: true, coldViewer: true, initialIsValid: true });
  try {
    assert(!critic.error, critic.error?.stack || String(critic.error));
    assert(critic.attemptedRepair, "independent viewer must be able to force repair even when structural gate passes");
    assert(critic.report.accepted);
    assert.strictEqual(critic.report.results.length, 3);
    assert(critic.report.results.every((x) => x.audienceScore >= 80 && x.structuralScore >= 80));
    assert.strictEqual(critic.calls.filter((x) => x.prompt.includes("INDEPENDENT COLD VIEWER")).length, 2);
    assert.strictEqual(critic.calls.filter((x) => x.kind === "phase_b").length, 2);
    assert(critic.calls.filter((x) => x.prompt.includes("INDEPENDENT COLD VIEWER")).every((x) => !x.prompt.includes(".mp4")));
  } finally { await fs.rm(critic.root, { recursive: true, force: true }); }

  console.log("story-first Phase B reject/repair end-to-end tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
