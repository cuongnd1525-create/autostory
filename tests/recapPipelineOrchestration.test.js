const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Pipeline = require("../electron/services/recap/recapPipelineService");
const Tts = require("../electron/services/recap/recapTtsService");
const ProjectStore = require("../electron/services/projectStore");
const { createScopedToken } = require("../electron/services/cancelToken");

test("bad timestamp checkpoints invalidate derived edits while valid chunks survive", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-bad-anchor-"));
  try {
    const source = path.join(root, "source.mp4"); await fs.writeFile(source, "fixture");
    const store = new ProjectStore(), project = await store.createProject(root, { title: "Anchor checkpoint", sourceVideoPath: source, mode: "recap" });
    const chunks = [0, 240].map((start, i) => ({ chunkIndex: i + 1, sourceStartSec: start, sourceEndSec: start + 240, durationSec: 240, isSingleChunk: true }));
    const wrong = Array.from({ length: 20 }, (_, i) => ({ id: `bad${i}`, source_start: i * .15, source_end: i * .15 + .04 }));
    const good = [{ id: "kept", source_start: 250, source_end: 260 }], calls = [];
    const service = new Pipeline({ projectStore: store, logger: { log() {} }, serviceFactories: {
      media: () => ({ planChunks: () => chunks }), tts: () => ({}), renderer: () => ({}),
      ai: () => ({ providerService: { label: "Fixture", provider: "fixture" },
        analyzeVideoChunk: async ({ chunkMetadata }) => { calls.push(chunkMetadata.chunkIndex); return { events: [{ id: "rechecked", source_start: 30, source_end: 40 }] }; },
        buildStoryModel: async ({ events: actual }) => { assert.deepEqual(actual.map(e => e.id), ["rechecked", "kept"]); return { title: "Rebuilt" }; }
      })
    } });
    const statePath = path.join(store.getProjectPaths(root, project.id).analysisDir, "recap_state.json");
    await service._saveState(statePath, { analysisVersion: 2, completedStages: [], sourceMeta: { duration: 480 }, proxyPath: source, scenes: [{ startSec: 0, endSec: 480 }],
      chunkAnalysisKey: JSON.stringify({ version: 2, proxyPath: source, chunks, provider: "fixture" }), chunkAnalyses: { 0: { events: wrong }, 1: { events: good } },
      visualEvents: [...wrong, ...good], storyModel: { title: "Stale" }, speechUnits: [{ id: "stale" }], decisions: [{ id: "stale" }], qualityGate: { passed: true } });
    const result = await Object.getPrototypeOf(Pipeline.prototype).runRecapProject.call(service, { workspaceRoot: root, projectId: project.id });
    assert.deepEqual(calls, [1]); assert.equal(result.state.storyModel.title, "Rebuilt");
    assert.equal(result.state.speechUnits, undefined); assert.equal(result.state.decisions, undefined); assert.equal(result.state.qualityGate, undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("pipeline runs all stages, preserves absolute chunk timestamps, and saves final project metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-orchestration-"));
  try {
    const source = path.join(root, "source.mp4");
    await fs.writeFile(source, "fixture");
    const store = new ProjectStore();
    const project = await store.createProject(root, { title: "Test recap", sourceVideoPath: source, mode: "recap", voiceProvider: "kokoro", recapMuteSourceAudio: true, targetDurationSec: 15, viralOptimization: false });
    assert.equal(project.recapMuteSourceAudio, true);
    let expectedMute = true;
    const token = createScopedToken("test");
    let ttsCalled = false, analysisCalls = 0, renders = 0, reviews = 0;
    const events = [2, 62].map((start, i) => ({ id: `event_${i}`, source_start: start, source_end: start + 5, duration: 5, description: "Visible action", importance: 0.8 }));
    const units = events.map((event, i) => ({ id: `speech_${i}`, beat_id: `beat_${i}`, text: "This is a short narration.", visual_event_ids: [event.id], target_duration_budget: 7 }));
    const service = new Pipeline({ projectStore: store, logger: { log() {} }, serviceFactories: {
      media: () => ({
        probeVideo: async () => ({ duration: 120, width: 640, height: 360 }),
        ensureAnalysisProxy: async () => source,
        detectScenes: async () => [{ startSec: 0, endSec: 60 }, { startSec: 60, endSec: 120 }],
        planChunks: () => [{ chunkIndex: 1, sourceStartSec: 0, sourceEndSec: 60, isSingleChunk: true }, { chunkIndex: 2, sourceStartSec: 60, sourceEndSec: 120, isSingleChunk: true }]
      }),
      ai: () => ({
        providerService: { label: "Antigravity CLI" },
        analyzeVideoChunk: async ({ cancelToken }) => { assert.equal(cancelToken, token); return { events: [events[analysisCalls++]] }; },
        buildStoryModel: async ({ events: actual }) => { assert.equal(actual[1].source_start, 62); return { title: "Story", story_arcs: [] }; },
        planRecap: async ({ allowShotReuse }) => { assert.equal(allowShotReuse, true); return { beats: events.map((event, i) => ({ beat_id: `beat_${i}`, role: "development", visual_event_ids: [event.id] })), selected_event_ids: events.map((event) => event.id) }; },
        generateNarration: async () => units,
        reviewDraft: async () => { reviews++; return { overall_score: 0.9, summary: "OK", issues: [] }; }
      }),
      tts: () => ({
        getVoiceProfile: async (workspaceRoot, actualProject) => { assert.equal(workspaceRoot, root); assert.equal(actualProject.id, project.id); return { wordsPerSecond: 2.5 }; },
        synthesizeAll: async ({ workspaceRoot, project: actualProject, signal }) => {
          ttsCalled = true;
          assert.equal(workspaceRoot, root);
          assert.equal(actualProject.voiceProvider, "kokoro");
          assert.equal(signal, token.signal);
          return Object.fromEntries(units.map((unit) => [unit.id, { audioPath: source, durationSec: 7, text: unit.text }]));
        }
      }),
      renderer: () => ({
        renderDraft: async ({ proxyVideoPath, decisions, outputPath, muteSourceAudio }) => {
          renders++;
          assert.equal(muteSourceAudio, expectedMute);
          assert.equal(proxyVideoPath, source);
          assert.ok(decisions.flatMap((decision) => decision.clips).some((clip) => clip.source_start >= 60 && clip.source_end <= 70));
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, "draft"); return outputPath;
        },
        renderFinal: async ({ outputPath, muteSourceAudio }) => { assert.equal(muteSourceAudio, expectedMute); renders++; await fs.writeFile(outputPath, "final"); return outputPath; }
      })
    } });
    const result = await service.runRecapProject({ workspaceRoot: root, projectId: project.id, settings: { aiProvider: "antigravity_cli", allowShotReuse: true }, cancelToken: token });
    assert.equal(result.status, "completed");
    assert.equal(ttsCalled, true);
    assert.equal(renders, 2);
    const saved = await store.getProject(root, project.id);
    assert.equal(saved.status, "completed");
    assert.equal(saved.recapMuteSourceAudio, true);
    assert.equal(saved.finalVideoPath, result.finalVideoPath);
    assert.equal(saved.recap.qualityScore, 0.9);
    assert.equal((await service.getReviewState(root, project.id)).analysisVersion, 2);
    expectedMute = false;
    const resumed = await service.runRecapProject({ workspaceRoot: root, projectId: project.id,
      settings: { aiProvider: "antigravity_cli", recapMuteSourceAudio: false, allowShotReuse: true, recapWorkflow: "review" }, cancelToken: token });
    assert.equal(resumed.status, "review_ready");
    assert.equal(renders, 3, "changing mute must regenerate the cached draft");
    assert.equal(reviews, 2, "changing rendered audio must invalidate the old quality approval and review the new draft");
    const resumedState = await service.getReviewState(root, project.id);
    assert.equal(resumedState.renderMuteSourceAudio, false, "explicit false must override the saved project value");
    assert.equal(resumedState.userApprovedFinal, false);
    assert.equal((await store.getProject(root, project.id)).recapMuteSourceAudio, false, "the option must remain saved while waiting for review");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("recap voice calls use each provider's actual speech API and selected voice", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-voice-api-"));
  try {
    for (const provider of ["edge_neural", "kokoro", "elevenlabs", "windows_local", "omnivoice"]) {
      let request;
      const service = new Tts({}, { providers: { [provider]: { synthesizeSpeech: async (options) => { request = options; } } } });
      await service.synthesizeRaw({ text: "A line.", outputPath: path.join(root, `${provider}.wav`), provider, voiceId: "selected-voice" });
      assert.equal(request.text, "A line.");
      assert.equal(provider === "elevenlabs" ? request.voiceId : request.voiceName, "selected-voice");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("TTS cache cannot reuse audio after narration or voice changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-voice-cache-"));
  try {
    const service = new Tts({ defaultVoiceProvider: "edge_neural" });
    service.synthesizeRaw = async ({ outputPath }) => fs.writeFile(outputPath, Buffer.alloc(1024));
    service.probeAudioDuration = async () => 3;
    service.trimAudioSilence = async (input, output) => fs.copyFile(input, output);
    const first = await service.processSpeechUnit({ speechUnit: { id: "speech_1", text: "First line." }, outputDir: root });
    const cached = await service.processSpeechUnit({ speechUnit: { id: "speech_1", text: "First line." }, outputDir: root });
    assert.equal(cached.isCached, true);
    const edited = await service.processSpeechUnit({ speechUnit: { id: "speech_1", text: "Edited line." }, outputDir: root });
    assert.notEqual(first.audio_path, edited.audio_path);
    assert.equal(edited.isCached, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("interrupted analysis resumes at the failed chunk and keeps pipeline progress below later stages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-checkpoint-"));
  try {
    const source = path.join(root, "source.mp4"); await fs.writeFile(source, "fixture");
    const store = new ProjectStore(), project = await store.createProject(root, { title: "Checkpoint", sourceVideoPath: source, mode: "recap" });
    let failing = true, provider = "fixture"; const calls = [], progress = [];
    const service = new Pipeline({ projectStore: store, logger: { log() {} }, serviceFactories: {
      media: () => ({ probeVideo: async () => ({ duration: 120 }), ensureAnalysisProxy: async ({ onProgress }) => { onProgress({ percent: 100, message: "Proxy done" }); return source; },
        detectScenes: async () => [], planChunks: () => [1, 2].map((i) => ({ chunkIndex: i, sourceStartSec: (i - 1) * 60, sourceEndSec: i * 60, isSingleChunk: true })) }),
      ai: () => ({ providerService: { label: "Fixture", provider, getModel: () => "model" },
        analyzeVideoChunk: async ({ chunkMetadata, onProgress }) => {
          calls.push(chunkMetadata.chunkIndex); onProgress({ percent: 98, message: "CLI local completion", heartbeat: true, lastActivityAt: 123 });
          if (failing && chunkMetadata.chunkIndex === 2) throw new Error("Chunk interrupted");
          return { events: [{ id: `event_${chunkMetadata.chunkIndex}`, source_start: chunkMetadata.sourceStartSec + 2, source_end: chunkMetadata.sourceStartSec + 5 }] };
        }, buildStoryModel: async ({ events }) => { assert.deepEqual(events.map((e) => e.source_start), [2, 62]); return { title: "Story" }; } }),
      tts: () => ({}), renderer: () => ({})
    } });
    const request = { workspaceRoot: root, projectId: project.id, settings: { _recapPrepareOnly: true, viralOptimization: false }, onProgress: (value) => progress.push(value) };
    const prepareSource = () => Object.getPrototypeOf(Pipeline.prototype).runRecapProject.call(service, request);
    await assert.rejects(prepareSource(), /Chunk interrupted/);
    const interrupted = await service.getReviewState(root, project.id);
    assert.equal(interrupted.chunkAnalyses[0].events.length, 1);
    assert.equal(interrupted.chunkAnalyses[1], undefined);
    assert.deepEqual(interrupted.analysisChunk, { index: 2, count: 2 });
    // Older checkpoints include the formerly selected High model. Keep the
    // validated events when the remaining chunk switches to Low.
    interrupted.chunkAnalysisKey = JSON.stringify({ ...JSON.parse(interrupted.chunkAnalysisKey), model: "gemini-3.7-flash-high" });
    await service._saveState(path.join(store.getProjectPaths(root, project.id).analysisDir, "recap_state.json"), interrupted);
    failing = false; provider = "vertex_ai"; await prepareSource();
    assert.deepEqual(calls, [1, 2, 2], "changing provider must retain completed source chunks");
    const local = progress.filter((item) => item.message === "CLI local completion");
    assert.ok(local.every((item) => item.percent < 42 && item.chunkCount === 2 && item.lastActivityAt === 123));
    assert.ok(progress.some((item) => /khôi phục/.test(item.message)));
    assert.ok(progress.filter((item) => item.stage !== "story_synthesis").every((item) => item.percent < 42), "proxy and CLI completion must not finish the global progress bar");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const failureKind of ["output_limit", "print_timeout", "invalid_json"]) test(`${failureKind} splits only the affected chunk and resumes its completed part after interruption`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-output-split-"));
  try {
    const source = path.join(root, "source.mp4"); await fs.writeFile(source, "fixture");
    const store = new ProjectStore(), project = await store.createProject(root, { title: "Split", sourceVideoPath: source, mode: "recap" });
    let failing = true, provider = "fixture"; const calls = [], progress = [];
    const service = new Pipeline({ projectStore: store, logger: { log() {} }, serviceFactories: {
      media: () => ({ probeVideo: async () => ({ duration: 120 }), ensureAnalysisProxy: async () => source, detectScenes: async () => [],
        planChunks: () => [{ chunkIndex: 1, sourceStartSec: 0, sourceEndSec: 120, durationSec: 120, isSingleChunk: true }],
        extractProxyChunk: async ({ chunk }) => { assert.equal(chunk.durationSec, 60); return source; } }),
      ai: () => ({ providerService: { label: "Fixture", provider },
        analyzeVideoChunk: async ({ chunkMetadata }) => {
          calls.push(chunkMetadata.chunkIndex);
          if (chunkMetadata.chunkIndex === 1) throw Object.assign(new Error(failureKind), { kind: failureKind });
          if (failing && chunkMetadata.chunkIndex === "1-part-2") throw new Error("Interrupted part two");
          return { events: [{ id: `event_${chunkMetadata.chunkIndex}`, source_start: chunkMetadata.sourceStartSec + 2, source_end: chunkMetadata.sourceStartSec + 5 }] };
        }, buildStoryModel: async ({ events }) => { assert.deepEqual(events.map((event) => event.source_start), [2, 62]); return { title: "Story" }; } }),
      tts: () => ({}), renderer: () => ({})
    } });
    const request = { workspaceRoot: root, projectId: project.id, settings: {}, onProgress: (value) => progress.push(value) };
    const prepareSource = () => Object.getPrototypeOf(Pipeline.prototype).runRecapProject.call(service, request);
    await assert.rejects(prepareSource(), /Interrupted part two/);
    const partial = await service.getReviewState(root, project.id);
    assert.equal(partial.chunkSplits[0], true); assert.equal(partial.chunkAnalyses['0:part1'].events.length, 1);
    failing = false; provider = "vertex_ai"; await prepareSource();
    assert.deepEqual(calls, [1, "1-part-1", "1-part-2", "1-part-2"]);
    assert.ok(progress.some((item) => item.chunkPart === 2 && item.chunkCount === 1));
    assert.equal((await service.getReviewState(root, project.id)).visualEvents.length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
