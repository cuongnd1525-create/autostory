"use strict";

// Vertex Series Stage 1 = the Gemini chat workflow as a cached multi-turn session.

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const VertexSeriesStage1Service = require("../electron/services/vertexSeriesStage1Service");
const ConfiguredAiWorkflowService = require("../electron/services/configuredAiWorkflowService");
const Serial = require("../electron/services/serializedGeminiWorkflowService");
const Bridge = require("../electron/services/seriesBlueprintBridge");

const DURATION = 300;
const SCENES = Array.from({ length: 30 }, (_, i) => ({ sceneId: `scene_${String(i + 1).padStart(4, "0")}`, startSec: i * 10, endSec: (i + 1) * 10 }));

async function createPackage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-series-"));
  const pass1 = path.join(root, "01-GUI-GEMINI");
  const batch1 = path.join(pass1, "UPLOAD-BATCH-01");
  const batch2 = path.join(pass1, "UPLOAD-BATCH-02-FINAL");
  const next = path.join(root, "02-SERIES-SEQUENTIAL");
  for (const dir of [batch1, batch2, next]) await fs.mkdir(dir, { recursive: true });
  const manifest = { sourceVideo: "trunk-stop.mp4", videoDurationSec: DURATION, scenes: SCENES };
  const chunks = { sourceDurationSec: DURATION, chunks: [{ file: "analysis-proxy-chunk-001.mp4", sourceStartSec: 0, sourceEndSec: 150 }, { file: "analysis-proxy-chunk-002.mp4", sourceStartSec: 150, sourceEndSec: 300 }] };
  const prompt = "GEMINI SERIALIZED TRUE CRIME — STAGE 0 OF 4 — SERIES BLUEPRINT ONLY\nReturn exactly ONE JSON code block (save as series-blueprint.json).";
  await fs.writeFile(path.join(pass1, "scene-manifest.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(pass1, "01-gemini-highlight-scripts-prompt.txt"), prompt, "utf8");
  await fs.writeFile(path.join(batch1, "00-UPLOAD-THIS-BATCH-FIRST.txt"), "upload first", "utf8");
  await fs.writeFile(path.join(batch1, "analysis-proxy-chunk-001.mp4"), "v1", "utf8");
  await fs.writeFile(path.join(batch2, "analysis-proxy-chunk-002.mp4"), "v2", "utf8");
  await fs.writeFile(path.join(batch2, "01-gemini-highlight-scripts-prompt.txt"), prompt, "utf8");
  await fs.writeFile(path.join(batch2, "scene-manifest.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(batch2, "proxy-chunks-manifest.json"), JSON.stringify(chunks), "utf8");
  await fs.writeFile(path.join(batch2, "source-transcript.srt"), "1\n00:00:10,000 --> 00:00:14,000\nStep out of the car right now!\n", "utf8");
  await fs.writeFile(path.join(pass1, "source-transcript.srt"), "1\n00:00:10,000 --> 00:00:14,000\nStep out of the car right now!\n", "utf8");
  for (const [id, n] of [[1, 1], [3, 2], [4, 3]]) {
    await fs.writeFile(path.join(next, `script-${id}-NEXT-PROMPT.txt`), `GEMINI SERIALIZED TRUE CRIME — STAGE ${n} OF 3 — SCRIPT ${id} ONLY\nWrite ONLY script-${id}.json.`, "utf8");
  }
  const info = {
    workflow: "manual_gemini_draft_review", sequentialSeriesEnabled: true, sequentialSeriesProfile: "serialized_genz", sequentialSeriesSharedHook: false,
    seriesBlueprintPath: "", sourceVideoPath: path.join(root, "trunk-stop.mp4"), packageDir: root, pass1UploadDir: pass1,
    proxyUploadBatchDirs: [batch1, batch2], manifestPath: path.join(pass1, "scene-manifest.json"), proxyChunksManifestPath: path.join(batch2, "proxy-chunks-manifest.json"),
    promptPath: path.join(pass1, "01-gemini-highlight-scripts-prompt.txt"), sequentialSeriesNextStepsDir: next, cache: { sourceFingerprint: "abcdef1234567890" }
  };
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify(info, null, 2), "utf8");
  return { root, manifest, info };
}

const beat = (beatId, kind, role, a, b, sceneId) => ({ beatId, kind, role, sourceStartSec: a, sourceEndSec: b, sceneIds: [sceneId], sourceProof: `proof ${beatId}`, mustInclude: true });
function blueprint(manifest, info) {
  const plan = {
    profile: "serialized_genz", shared_top_banner_text: "KNOCKING FROM THE TRUNK", centralViewerQuestion: "Who is in the trunk?",
    verifiedCausalChain: ["Stop", "Contradiction", "Rescue"],
    source_narrator_ranges: [{ startSec: 0, endSec: 4, summary: "intro", replacementText: "A routine stop.", confidence: "high" }],
    parts: [
      { scriptId: 1, partNumber: 1, scope: "The stop", hook: { kind: "dialogue_conflict", sourceStartSec: 10, sourceEndSec: 18, hookProof: "Step out!" }, cliffhanger: "Knocking",
        chapterBeats: [beat("p1_b1", "dialogue", "setup", 45, 60, "scene_0005"), beat("p1_b2", "action", "cliffhanger", 70, 85, "scene_0008")] },
      { scriptId: 3, partNumber: 2, scope: "Questioning", hook: { kind: "mixed", sourceStartSec: 110, sourceEndSec: 118, hookProof: "Whose voice?" }, cliffhanger: "Latch",
        chapterBeats: [beat("p2_b1", "dialogue", "escalation", 125, 140, "scene_0013"), beat("p2_b2", "visual", "reveal", 165, 185, "scene_0017")] },
      { scriptId: 4, partNumber: 3, scope: "Rescue", hook: { kind: "visual_reveal", sourceStartSec: 210, sourceEndSec: 218, hookProof: "Trunk opens" }, payoff: "Arrest",
        chapterBeats: [beat("p3_b1", "action", "climax", 225, 245, "scene_0023"), beat("p3_b2", "dialogue", "consequence", 260, 275, "scene_0027")] }
    ]
  };
  const bp = Bridge.buildBlueprintFromSeriesPlan(plan, { manifest, packageInfo: info });
  delete bp.derivedFrom;
  // Gemini's hook audition (structure is what the tool checks).
  for (const part of bp.parts) {
    const a = Number(part.hook.sourceStartSec);
    part.hookAudition = { chosenIndex: 0, why: "loudest identifiable moment", candidates: [0, 1, 2].map((k) => ({
      sourceStartSec: a + k * 3, sourceEndSec: a + k * 3 + 5, first3sSeen: "officer at the trunk", first3sHeard: "shouting", viewerQuestion: "who is inside?" })) };
  }
  return bp;
}
/** Original-audio slices cut on the 10 s scene grid (one sceneId per segment). */
function slices(ranges) {
  const out = [];
  for (const [a, b, extra = {}] of ranges) {
    for (let t = a; t < b; t = Math.min(b, (Math.floor(t / 10) + 1) * 10)) {
      const end = Math.min(b, (Math.floor(t / 10) + 1) * 10);
      const sceneId = `scene_${String(Math.floor(t / 10) + 1).padStart(4, "0")}`;
      out.push({ segmentId: `seg_${t}`, sceneId, sourceStartSec: t, sourceEndSec: end, playbackSpeed: 1, audio_mode: "original_audio", voiceover_text: "", transitionReason: "cut", ...extra });
    }
  }
  return out;
}
function script(id, { missBeat = false, sustainedGap = false } = {}) {
  const base = { artifactType: "highlight_cut_script", schemaVersion: 1, scriptId: id };
  if (id === 1) return { ...base, segments: slices([[10, 18, { storyFunction: "hook" }], [40, 60, { beatId: "p1_b1" }], [60, 70], [70, 90, { beatId: "p1_b2" }], [90, 108]]) };
  if (id === 3) {
    const segments = slices([[110, 118, { storyFunction: "hook" }], [120, 140, { beatId: "p2_b1" }], [140, 160], ...(missBeat ? [] : [[160, 188, { beatId: "p2_b2" }]])]);
    if (sustainedGap) { segments[1].sustainedBeatId = "sb_1"; segments[2].sustainedBeatId = "sb_1"; segments[2].sourceStartSec = 131; }
    return { ...base, segments };
  }
  return { ...base, segments: slices([[210, 218, { storyFunction: "hook" }], [220, 250, { beatId: "p3_b1" }], [250, 260], [260, 280, { beatId: "p3_b2" }], [280, 288]]) };
}

/** In-memory Vertex: answers by the last user turn, records every request. */
function fakeVertex({ manifest, info, availableModels = ["gemini-3.1-pro"], cacheFails = false, badBlueprintFirst = false, script3Bad = 0, script3GapFirst = false, failFirstCallWith = null, criticFlags3 = false, qaRepairBreaks = false }) {
  const state = { requests: [], uploads: [], caches: [], deleted: [], probes: [], inFlight: 0, maxInFlight: 0, script3Calls: 0, blueprintCalls: 0, criticCalls: [], qaRepairs: [] };
  const good = blueprint(manifest, info);
  const respond = (obj) => {
    const text = JSON.stringify(obj);
    return { text, content: { role: "model", parts: [{ text, thoughtSignature: "sig-123" }] }, finishReason: "STOP", usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 900, estimatedCostUsd: 0.01 } };
  };
  const vertex = {
    projectId: "demo", location: "global",
    async probeModel(model) { state.probes.push(model); return { ok: availableModels.includes(model), status: availableModels.includes(model) ? 200 : 404 }; },
    async buildVideoPart(file) { state.uploads.push(path.basename(file)); return { fileData: { mimeType: "video/mp4", fileUri: `gs://bucket/${path.basename(file)}` } }; },
    async createCacheFromParts({ parts, model }) { state.caches.push({ parts, model }); return cacheFails ? { name: null, error: "HTTP 400: model does not support caching" } : { name: "projects/demo/locations/global/cachedContents/c1" }; },
    async deleteCachedContent(name) { state.deleted.push(name); return true; },
    async budgetStatus() { return { totalSpentUsd: 0 }; },
    async generateContent(request) {
      state.requests.push(request);
      if (failFirstCallWith && state.requests.length === 1) throw Object.assign(new Error(`Vertex AI request failed (${failFirstCallWith})`), { httpStatus: failFirstCallWith });
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      state.inFlight -= 1;
      const last = request.contents.at(-1).parts.map((part) => part.text || "").join("\n");
      if (/SERIES BLUEPRINT ONLY/.test(last)) {
        state.blueprintCalls += 1;
        if (badBlueprintFirst) { const bad = JSON.parse(JSON.stringify(good)); bad.parts[0].hook.kind = "part1_cold_open"; return respond(bad); }
        return respond(good);
      }
      if (/rejected this series-blueprint\.json|Review of this series-blueprint\.json/.test(last)) { state.blueprintCalls += 1; return respond(good); }
      if (/EDITOR REVIEW of the series-blueprint\.json/.test(last)) { state.blueprintCritic = (state.blueprintCritic || 0) + 1; return respond({ violations: [] }); }
      const critic = last.match(/EDITOR REVIEW of the script-(\d)\.json/);
      if (critic) {
        const cid = Number(critic[1]);
        state.criticCalls.push(cid);
        const first3 = cid === 3 && state.criticCalls.filter((x) => x === 3).length === 1;
        return respond({ violations: criticFlags3 && first3 ? [{ segment: 2, rule: "VO_OVER_DIALOGUE", evidence: "A 02:00-02:05 officer shouts under the VO", fix: "play 120-125 as original_audio" }] : [] });
      }
      const qa = last.match(/Review of script-(\d)\.json/);
      if (qa) {
        const qid = Number(qa[1]);
        state.qaRepairs.push(qid);
        if (qid === 3) state.script3Calls += 1;
        return respond(qaRepairBreaks && qid === 3 ? script(3, { missBeat: true }) : script(qid));
      }
      const id = Number((last.match(/SCRIPT (\d) ONLY/) || last.match(/rejected script-(\d)\.json/) || [])[1]);
      if (id === 3) { state.script3Calls += 1; return respond(script(3, { missBeat: state.script3Calls <= script3Bad, sustainedGap: script3GapFirst && state.script3Calls === 1 })); }
      return respond(script(id));
    }
  };
  return { vertex, state, good };
}

async function runService(fixture, options = {}, settings = {}) {
  const fake = fakeVertex({ manifest: fixture.manifest, info: fixture.info, ...options });
  const messages = [];
  const sleeps = [];
  const service = new VertexSeriesStage1Service({ aiProvider: "vertex_ai", vertexQualityModel: "gemini-2.5-pro", ...settings }, { vertex: fake.vertex, sleep: async (ms) => { sleeps.push(ms); } });
  let result = null;
  let error = null;
  try { result = await service.run({ packageDir: fixture.root, onProgress: (item) => messages.push(String(item.message || "")) }); } catch (caught) { error = caught; }
  return { ...fake, service, result, error, messages, sleeps };
}

(async () => {
  // --- parallel + cache: Blueprint repaired in-session, Script 3 repaired, locked like "Nhập Series Blueprint".
  {
    VertexSeriesStage1Service.resetModelCache();
    const fixture = await createPackage();
    const run = await runService(fixture, { badBlueprintFirst: true, script3Bad: 1 });
    assert.ifError(run.error);
    assert.strictEqual(run.result.model, "gemini-3.1-pro", "auto-picked the newest Pro the project has");
    assert.deepStrictEqual(run.state.uploads.sort(), ["analysis-proxy-chunk-001.mp4", "analysis-proxy-chunk-002.mp4"], "each video prepared once");
    assert.strictEqual(run.state.caches.length, 1);
    const cacheText = run.state.caches[0].parts.map((part) => part.text || "").join("\n");
    assert(cacheText.includes("FILE analysis-proxy-chunk-002.mp4 — proxy chunk of the source video, absolute SOURCE 150.000-300.000s"), "videos labeled with name + source range");
    assert(cacheText.includes("FILE scene-manifest.json:") && cacheText.includes("FILE source-transcript.srt:"));
    assert(!cacheText.includes("upload first") && !cacheText.includes("SERIES BLUEPRINT ONLY"), "notes/prompts are turns, not files");
    assert.strictEqual((cacheText.match(/FILE scene-manifest\.json/g) || []).length, 1, "deduplicated by file name");
    for (const request of run.state.requests) {
      assert.strictEqual(request.cachedContent, "projects/demo/locations/global/cachedContents/c1");
      assert(!JSON.stringify(request.contents).includes("fileData"), "media never re-sent when cached");
      assert.strictEqual(request.model, "gemini-3.1-pro");
      assert(request.safetySettings.every((item) => item.threshold === "BLOCK_ONLY_HIGH"));
    }
    assert.strictEqual(run.state.blueprintCalls, 2, "Blueprint + one in-session repair");
    const repair = run.state.requests[1].contents;
    assert.strictEqual(repair.length, 3, "user prompt, model answer, repair request");
    assert.strictEqual(repair[1].parts[0].thoughtSignature, "sig-123", "model content echoed verbatim");
    assert(repair[2].parts[0].text.includes("Hook needs verified kind"));
    assert.strictEqual(run.state.maxInFlight, 3, "3 Parts generated in parallel");
    assert.strictEqual(run.state.script3Calls, 2);
    const s3Repair = run.state.requests.find((request) => /rejected script-3\.json/.test(request.contents.at(-1).parts[0].text));
    assert(s3Repair.contents.at(-1).parts[0].text.includes("Missing locked chapterBeat p2_b2"));
    // Import contract.
    const bpPath = path.join(fixture.root, "series-blueprint.json");
    assert.strictEqual(run.result.seriesBlueprintPath, bpPath);
    assert.strictEqual(JSON.parse(await fs.readFile(path.join(fixture.root, "package-info.json"), "utf8")).seriesBlueprintPath, bpPath);
    const locked = JSON.parse(await fs.readFile(bpPath, "utf8"));
    assert.deepStrictEqual(Serial.validateBlueprint(locked, { manifest: fixture.manifest, profile: "serialized_genz", sharedHook: false }).errors, []);
    assert.strictEqual(run.result.validFiles.length, 3);
    for (const file of run.result.validFiles) {
      const saved = JSON.parse(await fs.readFile(file, "utf8"));
      assert.deepStrictEqual(Serial.validateScriptAgainstBlueprint(saved, locked).errors, [], path.basename(file));
      assert(file.includes("01-CONFIGURED-AI-RESULT"));
    }
    assert.deepStrictEqual(run.state.deleted, ["projects/demo/locations/global/cachedContents/c1"], "cache cleaned up");
    const info = JSON.parse(await fs.readFile(path.join(fixture.root, "01-CONFIGURED-AI-RESULT", "configured-ai-run-info.json"), "utf8"));
    assert.strictEqual(info.architecture, "vertex_series_session");
    assert(run.messages.some((message) => message.startsWith("[SERIES_BLUEPRINT] LOCKED")));
    assert(run.messages.some((message) => message.startsWith("[VERTEX_SERIES] DONE")));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- sequential mode replays the chat order: Script 3 sees Script 1's turn.
  {
    const fixture = await createPackage();
    const run = await runService(fixture, {}, { vertexSeriesPartMode: "sequential", vertexSeriesModel: "gemini-custom-pro" });
    assert.ifError(run.error);
    assert.strictEqual(run.state.probes.length, 0, "explicit model: no probing");
    assert.strictEqual(run.state.maxInFlight, 1);
    const s3 = run.state.requests.find((request) => /SCRIPT 3 ONLY/.test(request.contents.at(-1).parts[0].text));
    assert(s3.contents.some((turn) => (turn.parts[0].text || "").includes("SCRIPT 1 ONLY")), "history includes Script 1 turn");
    assert.strictEqual(s3.contents.length, 5, "Blueprint pair + Script 1 pair + Script 3 prompt");
    assert(!s3.contents.at(-1).parts[0].text.includes("PARALLEL GENERATION NOTE"));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- no cache available -> sources attached to the first user turn of every request.
  {
    const fixture = await createPackage();
    const run = await runService(fixture, { cacheFails: true }, { vertexQualityModel: "gemini-team-pro" });
    assert.ifError(run.error);
    assert.strictEqual(run.result.model, "gemini-team-pro", "a non-default quality model is respected");
    for (const request of run.state.requests) {
      assert.strictEqual(request.cachedContent, null);
      assert.strictEqual(request.contents[0].parts.filter((part) => part.fileData).length, 2);
    }
    assert.strictEqual(run.state.deleted.length, 0);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- transient 503 is retried with backoff.
  {
    const fixture = await createPackage();
    const run = await runService(fixture, { failFirstCallWith: 503 }, { vertexSeriesModel: "m" });
    assert.ifError(run.error);
    assert.deepStrictEqual(run.sleeps, [5000]);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- the import's editorial contract (sustained beat cut) is enforced and repaired in-session.
  {
    const fixture = await createPackage();
    const run = await runService(fixture, { script3GapFirst: true }, { vertexSeriesModel: "m" });
    assert.ifError(run.error);
    assert.strictEqual(run.state.script3Calls, 2);
    const repairText = run.state.requests.find((request) => /rejected script-3\.json/.test(request.contents.at(-1).parts[0].text)).contents.at(-1).parts[0].text;
    assert(repairText.includes("Import: Sustained beat sb_1 has a source gap/cut between scene slices"), repairText.slice(0, 400));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
  // --- the preflight reproduces the live 2026-10-21 import rejection.
  {
    const Pre = require("../electron/services/manualGeminiImportPreflight");
    assert.deepStrictEqual(Pre.parseDurationWindow("Keep the Part's computed duration between 75s and 120s."), { minDuration: 75, maxDuration: 120 });
    assert.deepStrictEqual(Pre.parseDurationWindow("", "- target duration for EACH Part: 80-115 seconds after playbackSpeed"), { minDuration: 80, maxDuration: 115 });
    const manifest = { sourceVideo: "trunk-stop.mp4", videoDurationSec: DURATION, scenes: SCENES };
    const bad = script(1);
    bad.segments.at(-1).sourceEndSec = 105;
    const srt = "1\n00:01:40,000 --> 00:01:50,000\nYou need to step back right now.\n";
    const result = Pre.preflightSeriesScript({ script: { ...bad, prompt_profile: "serialized_genz", series_mode: "interleaved_multipart", part_number: 1, shared_hook_enabled: false }, manifest, transcriptSrt: srt, promptOptions: { profile: "serialized_genz", sharedHook: false, minDuration: 60, maxDuration: 120 } });
    assert(result.errors.some((error) => error.includes("final original_audio ends inside an SRT cue")), JSON.stringify(result.errors));
  }

  // --- live 2026-10-21: serialized package built in one-request mode (sequentialSeriesEnabled=false)
  //     -> upgraded in place and run as the session (not the old 16-file request).
  {
    const fixture = await createPackage();
    const direct = [
      "JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY", "- Return exactly 3 independent Markdown JSON code blocks.",
      "AUTHORITATIVE SOURCE SUMMARY:", "- Source video: trunk-stop.mp4", "- Source duration: 300",
      "USER TASK INSTRUCTION - BUILD A 3-PART SERIALIZED TRUE-CRIME SERIES",
      "- prompt_profile: serialized_genz", "- series_mode: interleaved_multipart", "- target duration for EACH Part: 75-120 seconds after playbackSpeed"
    ].join("\n");
    await fs.writeFile(fixture.info.promptPath, direct, "utf8");
    await fs.rm(path.join(fixture.root, "02-SERIES-SEQUENTIAL"), { recursive: true, force: true });
    await fs.writeFile(path.join(fixture.root, "package-info.json"), JSON.stringify({ ...fixture.info, sequentialSeriesEnabled: false, sequentialSeriesNextStepsDir: "" }, null, 2), "utf8");
    assert.strictEqual(VertexSeriesStage1Service.isApplicable({ workflow: "manual_gemini_draft_review", sequentialSeriesEnabled: false }, {}, direct), true);
    assert.strictEqual(VertexSeriesStage1Service.isApplicable({ workflow: "manual_gemini_draft_review", sequentialSeriesEnabled: false }, {}, "- prompt_profile: independent"), false);
    const run = await runService(fixture, {}, { vertexSeriesModel: "m" });
    assert.ifError(run.error);
    const info = JSON.parse(await fs.readFile(path.join(fixture.root, "package-info.json"), "utf8"));
    assert.strictEqual(info.sequentialSeriesEnabled, true);
    assert.strictEqual(info.sequentialSeriesProfile, "serialized_genz");
    assert.strictEqual(info.seriesBlueprintPath, path.join(fixture.root, "series-blueprint.json"));
    const firstPrompt = run.state.requests[0].contents[0].parts[0].text;
    assert(firstPrompt.startsWith("GEMINI SERIALIZED TRUE CRIME — STAGE 0 OF 4 — SERIES BLUEPRINT ONLY"), "Stage 0 built from the direct prompt");
    const part1 = await fs.readFile(path.join(fixture.root, "02-SERIES-SEQUENTIAL", "script-1-NEXT-PROMPT.txt"), "utf8");
    assert(part1.includes("between 75s and 120s"));
    assert.strictEqual(run.result.validFiles.length, 3);
    assert(run.messages.some((message) => message.includes("đã chuyển sang Series tuần tự")));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- editorial QA: the video-grounded critic flags Script 3 -> one QA repair in-session, then accepted.
  {
    const fixture = await createPackage();
    const run = await runService(fixture, { criticFlags3: true }, { vertexSeriesModel: "m" });
    assert.ifError(run.error);
    assert.strictEqual(run.state.blueprintCritic, 1, "one Gemini editor turn on the Blueprint");
    const bpCritic = run.state.requests.find((request) => /EDITOR REVIEW of the series-blueprint\.json/.test(request.contents.at(-1).parts[0].text));
    assert(/SOURCE AUTO-CAPTION EXCERPTS/.test(bpCritic.contents.at(-1).parts[0].text), "transcript reaches Gemini as evidence, not as a tool verdict");
    assert.deepStrictEqual(run.state.criticCalls.sort(), [1, 3, 4], "one critic turn per Part (QA budget 1)");
    assert.deepStrictEqual(run.state.qaRepairs, [3]);
    const qaText = run.state.requests.find((request) => /Review of script-3\.json/.test(request.contents.at(-1).parts[0].text)).contents.at(-1).parts[0].text;
    assert(qaText.includes("[CRITIC_VO_OVER_DIALOGUE]") && qaText.includes("play 120-125 as original_audio"), qaText.slice(0, 500));
    const criticRequest = run.state.requests.find((request) => /EDITOR REVIEW of the script-3\.json/.test(request.contents.at(-1).parts[0].text));
    assert.strictEqual(criticRequest.temperature, 0.1);
    assert(/Hook opening, first 3s/.test(criticRequest.contents.at(-1).parts[0].text), "Part editor turn gets caption pointers");
    assert(criticRequest.contents.at(-2).role === "model", "critic sees the script it reviews");
    const partPrompt = run.state.requests.find((request) => /SCRIPT 1 ONLY/.test(request.contents.at(-1).parts[0].text)).contents.at(-1).parts[0].text;
    assert(partPrompt.includes("EDITORIAL QUALITY RULES v2"), "old package prompts get the review rules appended");
    assert(run.state.requests[0].contents[0].parts[0].text.includes("BLUEPRINT EDITORIAL RULES v2"));
    const info = JSON.parse(await fs.readFile(path.join(fixture.root, "01-CONFIGURED-AI-RESULT", "configured-ai-run-info.json"), "utf8"));
    assert.strictEqual(info.editorialQa.enabled, true);
    assert(Array.isArray(info.editorialQa.partWarnings["script-3"]));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- a QA repair that breaks the import contract never fails the Part: the last valid script is kept.
  {
    const fixture = await createPackage();
    const run = await runService(fixture, { criticFlags3: true, qaRepairBreaks: true }, { vertexSeriesModel: "m" });
    assert.ifError(run.error);
    assert.strictEqual(run.result.validFiles.length, 3);
    const saved = JSON.parse(await fs.readFile(path.join(fixture.root, "01-CONFIGURED-AI-RESULT", "script-3.json"), "utf8"));
    const locked = JSON.parse(await fs.readFile(path.join(fixture.root, "series-blueprint.json"), "utf8"));
    assert.deepStrictEqual(Serial.validateScriptAgainstBlueprint(saved, locked).errors, [], "valid pre-QA script restored on disk");
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- QA can be switched off (no critic turns, no appended rules).
  {
    const fixture = await createPackage();
    const run = await runService(fixture, { criticFlags3: true }, { vertexSeriesModel: "m", vertexSeriesQualityRules: false });
    assert.ifError(run.error);
    assert.strictEqual(run.state.criticCalls.length, 0);
    assert(!run.state.requests[0].contents[0].parts[0].text.includes("BLUEPRINT EDITORIAL RULES v2"));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- a Part that never matches the Blueprint -> no false success.
  {
    const fixture = await createPackage();
    const run = await runService(fixture, { script3Bad: 99 }, { vertexSeriesModel: "m" });
    assert(run.error);
    assert.strictEqual(run.error.kind, "series_blueprint_mismatch");
    assert(run.error.message.includes("script-3.json"));
    assert.strictEqual(run.state.script3Calls, 3, "first answer + 2 repairs");
    assert.strictEqual(run.state.deleted.length, 1, "cache cleaned up on failure too");
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- routing: Vertex + sequential Series package -> session service; other packages keep the old path.
  {
    const fixture = await createPackage();
    const original = VertexSeriesStage1Service.prototype.run;
    let routed = null;
    VertexSeriesStage1Service.prototype.run = async function stub(args) { routed = args; return { resultDir: "x", validFiles: ["a", "b", "c"], model: "gemini-3.1-pro" }; };
    try {
      const settings = { aiProvider: "vertex_ai", vertexProjectId: "demo", vertexCredentialPath: "c.json" };
      const result = await new ConfiguredAiWorkflowService(settings).runStage1({ packageDir: fixture.root });
      assert.strictEqual(routed.packageDir, fixture.root);
      assert.strictEqual(result.model, "gemini-3.1-pro");
      assert.strictEqual(result.provider, "vertex_ai");
      assert.strictEqual(VertexSeriesStage1Service.isApplicable({ ...fixture.info, sequentialSeriesEnabled: false }, settings), false);
      assert.strictEqual(VertexSeriesStage1Service.isApplicable(fixture.info, { ...settings, vertexSeriesSession: false }), false);
    } finally {
      VertexSeriesStage1Service.prototype.run = original;
    }
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- VertexAiService multi-turn primitives: request shape, countTokens probe, HTTP status on errors.
  {
    const VertexAiService = require("../electron/services/vertexAiService");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-prim-"));
    const vertex = new VertexAiService({ vertexProjectId: "demo", vertexLocation: "global", vertexGcloudCommand: "gcloud", vertexUsageLedgerPath: path.join(dir, "ledger.json") });
    vertex.getAccessToken = async () => "tok";
    const originalFetch = global.fetch;
    const seen = [];
    global.fetch = async (url, options = {}) => {
      seen.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith(":countTokens")) return { ok: url.includes("gemini-3.1-pro:"), status: url.includes("gemini-3.1-pro:") ? 200 : 404 };
      if (url.includes("broken-model")) return { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: "overloaded" } }), headers: { get: () => "7" } };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "{\"ok\":true}", thoughtSignature: "s" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }) };
    };
    try {
      assert.deepStrictEqual(await vertex.probeModel("gemini-3.1-pro"), { ok: true, status: 200 });
      assert.strictEqual((await vertex.probeModel("gemini-9-pro")).ok, false);
      const contents = [{ role: "user", parts: [{ text: "a" }] }, { role: "model", parts: [{ text: "b", thoughtSignature: "s0" }] }, { role: "user", parts: [{ text: "c" }] }];
      const result = await vertex.generateContent({ contents, model: "gemini-3.1-pro", cachedContent: "cachedContents/x", safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }] });
      const body = seen.at(-1).body;
      assert.deepStrictEqual(body.contents, contents, "multi-turn contents sent verbatim");
      assert.strictEqual(body.cachedContent, "cachedContents/x");
      assert.strictEqual(body.generationConfig.responseMimeType, "application/json");
      assert.strictEqual(result.text, "{\"ok\":true}");
      assert.strictEqual(result.content.parts[0].thoughtSignature, "s");
      await assert.rejects(vertex.generateContent({ contents, model: "broken-model" }), (error) => error.httpStatus === 503 && error.retryAfterMs === 7000);
    } finally {
      global.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  console.log("vertexSeriesStage1 tests passed (cached multi-turn session, Blueprint lock + in-session repairs, parallel/sequential Parts, no false success, routing)");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
