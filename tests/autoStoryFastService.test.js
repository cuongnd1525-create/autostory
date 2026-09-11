const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const Service = require("../electron/services/autoStoryFastService");
const Dubbing = require("../electron/services/dubbingService");
const { schemas } = require("../electron/services/autoStoryEditorial");

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-story-fast-test-"));
  try {
    const units = Service.buildUnits([{ startSec: 11, endSec: 13, text: "verified quote" }], 120);
    assert.equal(units.length, 10);
    assert.equal(units[0].text, "verified quote");
    assert.equal(units[1].text, "verified quote");
    const story = { scriptId: 1, title: "Test", centralViewerQuestion: "What happens?", hookPromise: "Answer",
      climax: "Verified event", payoff: "Reaction", reason: "One causal story", evidenceIds: units.map(u => u.id) };
    const access = { accessGranted: true, missingInputs: [] };
    const plan = { access, stories: [story], summary: "Complete source", capacityWarning: "Only one evidenced angle in this test fixture." };
    assert.throws(() => Service.validatePlan({ ...plan, capacityWarning: "" }, units, 2), /Thiếu kịch bản/);
    assert.equal(Service.validatePlan(plan, units, 2), plan);
    assert.throws(() => Service.validatePlan({ ...plan, access: {} }, units, 2), /input/);
    assert.throws(() => Service.validatePlan({ ...plan, stories: [{ ...story, evidenceIds: ["invented"] }] }, units, 2), /nguồn/);
    assert.deepEqual(Service.evidenceRanges(story, units, 120), [{ start: 0, end: 120 }]);
    const spacedUnits = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, start: i * 100, end: i * 100 + 12 }));
    assert.equal(Service.evidenceRanges({ evidenceIds: spacedUnits.map(u => u.id) }, spacedUnits, 1200).length, 12,
      "file count must never cause long unselected gaps to become evidence");
    const config = { targetDurationMinSec: 65, targetDurationMaxSec: 90, narration: { enabled: true } };
    const evidence = [{ id: "clip", file: path.join(root, "clip.mp4"), sourceStart: 240, duration: 120 }];
    const segments = [
      { id: "a", evidenceId: "clip", start: 0, end: 60, storyRole: "hook", narrativePurpose: "Event", audioMode: "original_audio", sourceNarratorPresent: false, voiceoverText: "", previewVi: "" },
      { id: "b", evidenceId: "clip", start: 60, end: 70, storyRole: "payoff", narrativePurpose: "Context", audioMode: "voiceover_only", sourceNarratorPresent: true, voiceoverText: "Verified connecting narration.", previewVi: "Loi dan da xac minh." }
    ];
    const script = { scriptId: 1, title: "Test", narrationArc: "Event to consequence", segments };
    Service.validateEdit(script, story, evidence, config);
    const candidates = [{ id: "candidate-a", category: "high_action", sourceUnitIds: [units[5].id],
      exactQuoteOrAction: "Verified confrontation", first3SecEvent: "Confrontation already underway", reason: "Answers the same question" }];
    const auditionStory = { ...story, evidenceIds: [units[0].id], hookCandidates: candidates };
    Service.validatePlan({ ...plan, stories: [auditionStory] }, units, 2);
    assert.deepEqual(Service.evidenceRanges(auditionStory, units, 120), [{ start: 0, end: 22 }, { start: 54, end: 82 }],
      "preserve alternatives outside initially chosen story footage for editor AND reviewer");
    assert.throws(() => Service.validatePlan({ ...plan, stories: [{ ...auditionStory,
      hookCandidates: [{ ...candidates[0], sourceUnitIds: ["invented"] }] }] }, units, 2), /hook/);
    const auditionEvidence = [{ ...evidence[0], sourceStart: 0, sourceUnits: units, sourceUnitIds: units.map(u => u.id) }];
    const auditionScript = { ...script, hookAudit: { selectedCandidateId: "candidate-a", first3SecEvent: "Confrontation",
      exactQuoteOrAction: "Verified confrontation", selectionReason: "Strongest clean action", durationReason: "Complete action and reaction",
      transitionToContext: "Explain the rewind" }, segments: [{ ...segments[0], start: 60, end: 100 }, segments[1]] };
    Service.validateEdit(auditionScript, auditionStory, auditionEvidence, config);
    assert.equal(auditionScript.segments[0].end - auditionScript.segments[0].start, 40, "complete hook can exceed 30s, no rigid 3-5s cutoff");
    assert.throws(() => Service.validateEdit({ ...auditionScript, hookAudit: { ...auditionScript.hookAudit, selectedCandidateId: "invented" } }, auditionStory, auditionEvidence, config), /hook/);
    assert.throws(() => Service.validateEdit({ ...auditionScript, segments: [{ ...segments[0], start: 0, end: 5 }, segments[1]] }, auditionStory, auditionEvidence, config), /không khớp/);
    const narratorHook = structuredClone(script);
    narratorHook.segments[0] = { ...segments[1], id: "narrator-hook", storyRole: "Hook" };
    assert.throws(() => Service.validateEdit(narratorHook, story, evidence, config), /hook bắt buộc original_audio/);
    const interruptedHook = structuredClone(script);
    interruptedHook.segments[1].storyRole = "hook";
    assert.throws(() => Service.validateEdit(interruptedHook, story, evidence, config), /hook bắt buộc original_audio/);
    const multiHook = structuredClone(script);
    multiHook.segments.splice(1, 0, { ...segments[0], id: "hook-continued", start: 10, end: 15 });
    Service.validateEdit(multiHook, story, evidence, config);
    const editorial = require("../electron/services/autoStoryEditorial");
    const auditionPrompt = editorial.editPrompt(config, auditionStory, auditionEvidence);
    assert(auditionPrompt.includes('"clipIds":["clip"]'));
    assert(!auditionPrompt.includes('"sourceUnitIds"'), "map planning IDs into editor clip IDs");
    assert(editorial.hookPolicy.includes("NOT A DURATION LIMIT"));
    assert(editorial.reviewPrompt(config, auditionStory, auditionEvidence, auditionScript, {}).includes("ACTUAL rendered opening"));
    for (const prompt of [editorial.planPrompt(config, units), editorial.editPrompt(config, story, evidence), editorial.reviewPrompt(config, story, evidence, script, {})]) {
      assert(prompt.includes(editorial.hookPolicy), "same original hook policy in all editorial passes");
      assert(prompt.indexOf("1) strong physical action") < prompt.indexOf("7) a twist"));
    }
    const bad = structuredClone(script); bad.segments[0].end = 246.9;
    assert.throws(() => Service.validateEdit(bad, story, evidence, config), /ngoài evidence/);
    bad.segments[0] = { ...segments[0], sourceNarratorPresent: true };
    assert.throws(() => Service.validateEdit(bad, story, evidence, config), /âm gốc/);
    const compiled = Service.highlight(script, story, evidence);
    assert.equal(compiled.segments[1].sourceStartSec, 300);
    const normalized = Dubbing.normalizeHighlightCutScript(compiled, 600);
    assert.equal(normalized.segments[1].voiceoverText, segments[1].voiceoverText);
    assert.equal(normalized.segments[0].audioMode, "original_audio");
    assert.equal(normalized.segments[1].audioMode, "voiceover_only");
    assert(schemas.edit.properties.script.properties.segments);

    let calls = 0; let ttsCalls = 0; let proxyCalls = 0;
    let project = { id: "test", analysisWorkflow: "vertex_auto_story", sourceVideoPath: path.join(root, "source.mp4"),
      voiceProvider: "kokoro", voiceId: "am_adam", autoStoryConfig: { outputCount: 1, targetDurationMinSec: 65, targetDurationMaxSec: 90 } };
    await fs.writeFile(project.sourceVideoPath, "test source identity");
    const store = { getProject: async () => structuredClone(project), getProjectPaths: () => ({ analysisDir: root }),
      updateProject: async (_w, _id, patch) => (project = { ...project, ...patch }) };
    const ffmpeg = {
      probeVideo: async file => { const data = await fs.readFile(file, "utf8"); return { duration: data.startsWith("duration:") ? Number(data.slice(9)) : 120 }; },
      probeAudio: async file => { await fs.access(file); return { duration: 10 }; },
      createMultimodalAnalysisProxy: async ({ outputPath }) => { proxyCalls++; await fs.writeFile(outputPath, "proxy"); },
      createAutoStoryEvidenceReel: async (entries, outputPath) => { await fs.writeFile(outputPath, `duration:${entries.reduce((sum, e) => sum + e.duration, 0)}`); },
      createAnalysisProxyChunk: async ({ videoPath, outputPath, fps, width }) => {
        assert.equal(videoPath, project.sourceVideoPath, "fine-cut evidence must come from the source, not low-fps overview");
        assert.equal(fps, 8); assert.equal(width, 640);
        await fs.writeFile(outputPath, "clip");
      }
    };
    const dubbing = { synthesizeFastDraftVoice: async ({ outputPath }) => { ttsCalls++; await fs.writeFile(outputPath, Buffer.alloc(1024)); } };
    const vertex = { getModel: () => "test-model", generateJsonFromFiles: async args => {
      assert.equal(args.maxOutputTokens, undefined, "Auto Story uses the model output allowance, not a local cap");
      calls++;
      if (args.responseSchema === schemas.plan) return plan;
      assert.equal(args.videoFps, 1, "ordinary evidence uses overview density");
      const map = JSON.parse(args.prompt.split("CLIP MAP (local timestamps only; sourceOrder is chronological):\n")[1]);
      assert.deepEqual(args.responseSchema.properties.script.properties.segments.items.properties.evidenceId.enum, map.map(e => e.id));
      assert(!args.prompt.includes('"evidenceIds"'), "do not leak planner IDs into the editor namespace");
      return { access, script: { ...script, segments: segments.map(s => ({ ...s, evidenceId: map[0].id })) } };
    } };
    const service = new Service({}, store, { ffmpeg, dubbing, vertex });
    const textRepairService = new Service({}, store, { ffmpeg, dubbing, vertex: {
      generateJsonFromFiles: async args => {
        assert.deepEqual(args.filePaths, []);
        assert.equal(args.videoFps, undefined);
        assert.equal(args.responseSchema, schemas.voicePatch);
        return { segmentId: "b", voiceoverText: "Verified narration.", previewVi: "Loi dan." };
      }
    } });
    const textRepaired = await textRepairService.repairVoice(script, { segmentId: "b", measurements: [] }, story, evidence, config, root);
    assert.deepEqual(textRepaired.segments[0], script.segments[0]);
    assert.equal(textRepaired.segments[1].start, script.segments[1].start);
    assert.equal(textRepaired.segments[1].voiceoverText, "Verified narration.");
    assert.equal(script.segments[1].voiceoverText, "Verified connecting narration.");
    const result = await service.run({ workspaceRoot: root, projectId: "test" });
    assert.equal(calls, 2, "one plan and one edit on the normal path");
    assert.equal(result.scriptPaths.length, 1);
    assert.equal(project.draftVoiceMode, "final");
    assert.equal(project.mixer.sourceVolume, 0);
    assert.equal(project.showSubtitles, true);
    assert.equal(Object.keys(project.autoStoryVoiceCache).length, 2);
    await service.run({ workspaceRoot: root, projectId: "test" });
    assert.equal(calls, 2, "validated cache avoids paid AI calls on retry");
    assert.equal(ttsCalls, 2, "measured voice reused on retry");
    assert.equal(proxyCalls, 1);

    let attempts = 0;
    const repair = new Service({}, store, { ffmpeg, dubbing, vertex: { generateJsonFromFiles: async () => ({ valid: ++attempts > 1 }) } });
    await repair.stage(root, "repair", {}, { prompt: "test" }, v => { if (!v.valid) throw new Error("invalid"); });
    assert.equal(attempts, 2);
    await repair.stage(root, "repair", {}, { prompt: "test" }, v => assert(v.valid));
    assert.equal(attempts, 2, "invalid first attempt never becomes successful cache");
    let tokenAttempts = 0;
    const exhausted = new Service({}, store, { ffmpeg, dubbing, vertex: {
      generateJsonFromFiles: async () => { tokenAttempts++; throw new Error("Vertex AI không hoàn tất response: MAX_TOKENS"); }
    } });
    await assert.rejects(exhausted.stage(root, "exhausted", {}, { prompt: "test" }, () => assert.fail("must not validate truncated JSON")), /MAX_TOKENS/);
    assert.equal(tokenAttempts, 1, "do not pay for an identical retry at the model limit");

    project.analysis = { highlightVariants: [{ id: "v1", scriptId: 1, segments, artifacts: { fastDraftVideoPath: project.sourceVideoPath } }] };
    let reviews = 0;
    vertex.generateJsonFromFiles = async args => { assert.equal(args.maxOutputTokens, undefined); reviews++; return { access, verdict: "PASS", issues: [], patch: { order: segments.map(s => s.id), changedSegments: [] } }; };
    await service.auditDrafts({ workspaceRoot: root, projectId: "test" });
    await service.auditDrafts({ workspaceRoot: root, projectId: "test" });
    assert.equal(reviews, 1, "completed review is resumable");
    assert.equal(project.autoStoryState.phase, "complete");
    const analysisBefore = structuredClone(project.analysis);
    const artifactsBefore = { fastDraftVideoPath: project.sourceVideoPath };
    project.artifacts = artifactsBefore;
    const reviewRecord = path.join(root, "auto-story-fast", "review-state-1.json");
    await fs.unlink(reviewRecord);
    // A changed draft must not reuse its previous review response.
    await fs.appendFile(project.sourceVideoPath, "changed");
    vertex.generateJsonFromFiles = async () => {
      const selectedEvidence = JSON.parse(await fs.readFile(path.join(root, "auto-story-fast", "evidence-1.json"), "utf8"));
      return { access, verdict: "MAJOR_REVISE", issues: [{ outputSec: 60, reason: "Weak bridge" }],
        patch: { order: segments.map(s => s.id), changedSegments: segments.map(s => ({ ...s, evidenceId: selectedEvidence[0].id,
          voiceoverText: s.audioMode === "voiceover_only" ? "A revised verified bridge." : "" })) } };
    };
    dubbing.importReviewedScriptProject = async () => { project.analysis = { corrupt: true }; throw new Error("synthetic import failure"); };
    const failedReview = await service.auditDrafts({ workspaceRoot: root, projectId: "test" });
    assert.equal(failedReview.audits[0].error, "synthetic import failure");
    assert.deepEqual(project.analysis.highlightVariants, analysisBefore.highlightVariants);
    assert.deepEqual(project.artifacts, artifactsBefore);
    assert.equal(JSON.parse(await fs.readFile(reviewRecord, "utf8")).pending, false);
    assert.equal(project.autoStoryState.phase, "review_failed");
    vertex.generateJsonFromFiles = async () => { throw new Error("must resume pending correction without another video review"); };
    const resumedFailure = await service.auditDrafts({ workspaceRoot: root, projectId: "test" });
    assert.equal(resumedFailure.audits[0].error, "synthetic import failure", "retry reuses pending review and measured correction");
    const sourceJsonPath = path.join(root, "script-2.json");
    await fs.writeFile(sourceJsonPath, JSON.stringify({ artifactType: "vertex_auto_story_script", scriptId: 2 }));
    project.autoStoryPipelineVersion = "editorial-v1";
    project.analysis = { activeVariantId: "variant_01", scenes: [], highlightVariants: [{ id: "variant_01", scriptId: 1, sourceJsonPath, segments,
      artifacts: { fastDraftVideoPath: "preserved.mp4" }, revisionHistory: [{ revision: 1 }] }] };
    const recovered = await service.recoverScriptIds(root, "test");
    assert.equal(recovered.analysis.highlightVariants[0].scriptId, 2);
    assert.equal(recovered.analysis.highlightVariants[0].artifacts.fastDraftVideoPath, "preserved.mp4");
    const preserved = structuredClone(recovered);
    project.analysis.highlightVariants = [
      { id: "variant_01", scriptId: 1, segments },
      { id: "variant_02", scriptId: 2, segments },
      { id: "variant_03", scriptId: 3, segments }
    ];
    const merged = await service.mergePreservedVariants(root, "test", preserved);
    assert.equal(merged.analysis.highlightVariants.length, 3);
    assert.equal(new Set(merged.analysis.highlightVariants.map(v => v.id)).size, 3);
    assert.deepEqual(merged.analysis.highlightVariants.find(v => v.scriptId === 2), preserved.analysis.highlightVariants[0]);
    assert.equal(merged.analysis.activeVariantId, "variant_01");
    project.autoStoryConfig.outputCount = 3;
    project.analysis = { activeVariantId: "v1", highlightVariants: [{ id: "v1", scriptId: 1,
      sourceJsonPath: "preserved.json", segments, artifacts: { fastDraftVideoPath: "preserved.mp4" } }] };
    await fs.writeFile(path.join(root, "auto-story-fast", "plan.json"), JSON.stringify(plan));
    const stages = [];
    service.stage = async (_root, key, input, _args, validate) => {
      stages.push(key);
      if (key === "story-plan-supplement") {
        assert.deepEqual(input.missingIds, [2, 3]);
        const value = { access, capacityWarning: "", stories: [2, 3].map(id => ({ ...story, scriptId: id })) };
        validate(value); return value;
      }
      return { script: { ...script, scriptId: input.story.scriptId, segments: [] } };
    };
    service.fitMeasured = async s => s;
    const supplemented = await service.run({ workspaceRoot: root, projectId: "test", retryFailed: true });
    assert.deepEqual(stages, ["story-plan-supplement", "edit-2", "edit-3"]);
    assert.equal(supplemented.scriptPaths.length, 3);
    assert.equal(supplemented.scriptPaths[0], "preserved.json");
    assert.equal(project.analysis.highlightVariants[0].artifacts.fastDraftVideoPath, "preserved.mp4");
    console.log("autoStoryFastService tests passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
