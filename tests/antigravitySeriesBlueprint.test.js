"use strict";

// Antigravity Series -> locked series-blueprint.json bridge.
// Live run 2026-10-19 (source-k9-sn-aeqts): Stage 1 reported "3 JSON variant hợp lệ"
// but "Chọn nội dung" failed with "Chưa có Blueprint đã khóa": the AGY flow wrote
// only 01-ANTIGRAVITY-RESULT/series-plan.json, never <package>/series-blueprint.json.

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const Bridge = require("../electron/services/seriesBlueprintBridge");
const Serial = require("../electron/services/serializedGeminiWorkflowService");
const { createPhaseAwareSpawn, defaultResponder, partScriptIdFromPrompt, proxyPathsFromPrompt } = require("./helpers/fakeAntigravity");

const DURATION = 300;
const CHUNKS = [[0, 100], [100, 200], [200, 300]];

async function createPackage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-series-bp-"));
  const pass1Dir = path.join(root, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const promptPath = path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt");
  await fs.writeFile(promptPath, "### SELECTED PROMPT PROFILE\n- prompt_profile: serialized_genz\n- series_mode: interleaved_multipart\nGenerate Script 1, Script 3 and Script 4.", "utf8");
  const scenes = Array.from({ length: 30 }, (_, index) => ({ sceneId: `scene_${String(index + 1).padStart(4, "0")}`, startSec: index * 10, endSec: (index + 1) * 10 }));
  const manifestPath = path.join(pass1Dir, "scene-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({ sourceVideo: "trunk-stop.mp4", videoDurationSec: DURATION, scenes }), "utf8");
  const chunks = CHUNKS.map(([start, end], index) => ({ chunkId: `proxy_chunk_00${index + 1}`, file: `analysis-proxy-chunk-00${index + 1}.mp4`, sourceStartSec: start, sourceEndSec: end, durationSec: end - start }));
  for (const chunk of chunks) await fs.writeFile(path.join(pass1Dir, chunk.file), `video-${chunk.chunkId}`, "utf8");
  await fs.writeFile(path.join(pass1Dir, "proxy-chunks-manifest.json"), JSON.stringify({ sourceDurationSec: DURATION, chunks }), "utf8");
  await fs.writeFile(path.join(pass1Dir, "source-transcript.srt"), "1\n00:00:10,000 --> 00:00:14,000\nStep out of the car right now!\n", "utf8");
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review",
    sequentialSeriesEnabled: true,
    sequentialSeriesProfile: "serialized_genz",
    sequentialSeriesSharedHook: false,
    seriesBlueprintPath: "",
    sourceVideoPath: "D:\\Video\\trunk-stop.mp4",
    pass1UploadDir: pass1Dir,
    promptPath,
    manifestPath,
    proxyChunksManifestPath: path.join(pass1Dir, "proxy-chunks-manifest.json"),
    proxyChunkCount: 3,
    cache: { sourceFingerprint: "abcdef1234567890", cacheDir: path.join(root, "source-cache") }
  }, null, 2), "utf8");
  return { root, pass1Dir, manifestPath };
}

const beat = (beatId, kind, role, start, end, sceneId, proof) => ({ beatId, kind, role, sourceStartSec: start, sourceEndSec: end, sceneIds: [sceneId], sourceProof: proof, mustInclude: true });

function validPlan() {
  return {
    artifactType: "series_plan",
    schemaVersion: 2,
    profile: "serialized_genz",
    shared_top_banner_text: "KNOCKING FROM THE TRUNK",
    centralViewerQuestion: "Who is knocking inside the trunk?",
    hookPromise: "A routine stop turns into a rescue.",
    verifiedCausalChain: ["Stop at 10s", "Contradiction at 125s", "Trunk opened at 225s"],
    source_narrator_ranges: [{ startSec: 0, endSec: 4, summary: "Documentary intro", replacementText: "A routine stop. Then a sound from the trunk.", confidence: "high" }],
    parts: [
      {
        scriptId: 1, partNumber: 1, partBadge: "PART 1", scope: "The stop",
        hook: { kind: "dialogue_conflict", sourceStartSec: 10, sourceEndSec: 18, hookProof: "Step out of the car right now!" },
        sceneAllocation: [{ sourceStartSec: 0, sourceEndSec: 100, purpose: "chapter 1" }],
        chapterBeats: [beat("p1_b1", "dialogue", "setup", 45, 60, "scene_0005", "Driver refuses keys"), beat("p1_b2", "action", "cliffhanger", 70, 85, "scene_0008", "Knocking from trunk")],
        mustNotReveal: ["arrest"], cliffhanger: "Who is in the trunk?", cliffhangerRange: { sourceStartSec: 70, sourceEndSec: 85 }
      },
      {
        scriptId: 3, partNumber: 2, partBadge: "PART 2", scope: "The questioning",
        hook: { kind: "mixed", sourceStartSec: 110, sourceEndSec: 118, hookProof: "Whose voice is that?" },
        sceneAllocation: [{ sourceStartSec: 100, sourceEndSec: 200, purpose: "chapter 2" }],
        chapterBeats: [beat("p2_b1", "dialogue", "escalation", 125, 140, "scene_0013", "Two different stories"), beat("p2_b2", "visual", "reveal", 165, 185, "scene_0017", "Text on dashboard")],
        mustNotReveal: ["arrest"], cliffhanger: "The latch gives way.", cliffhangerRange: { sourceStartSec: 180, sourceEndSec: 190 }
      },
      {
        scriptId: 4, partNumber: 3, partBadge: "PART 3", scope: "The rescue",
        hook: { kind: "visual_reveal", sourceStartSec: 210, sourceEndSec: 218, hookProof: "Trunk pops open" },
        sceneAllocation: [{ sourceStartSec: 200, sourceEndSec: 300, purpose: "chapter 3" }],
        chapterBeats: [beat("p3_b1", "action", "climax", 225, 245, "scene_0023", "Passenger pulled out"), beat("p3_b2", "dialogue", "consequence", 260, 275, "scene_0027", "You are under arrest")],
        mustNotReveal: [], payoff: "Passenger rescued, driver arrested.", payoffRanges: [{ sourceStartSec: 255, sourceEndSec: 295 }]
      }
    ],
    sharedRanges: [],
    duplicatePrevention: "chronological"
  };
}

/** The vocabulary the AGY prompt template used to teach (live 2026-10-19 output). */
function legacyPlan() {
  const plan = validPlan();
  plan.parts[0].hook.kind = "part1_cold_open";
  plan.parts[0].chapterBeats[0].kind = "confrontation";
  plan.parts[0].chapterBeats[1].role = "High-speed pursuit toward the spike strips";
  plan.source_narrator_ranges = [{ startSec: 0, endSec: 4, summary: "Documentary intro" }];
  delete plan.shared_top_banner_text;
  return plan;
}

const seg = (id, sceneId, start, end, extra = {}) => ({ segmentId: id, sceneId, sourceStartSec: start, sourceEndSec: end, audio_mode: "original_audio", voiceover_text: "", ...extra });
function script(scriptId, { missBeat = false } = {}) {
  const base = { artifactType: "highlight_cut_script", schemaVersion: 1, scriptId, prompt_profile: "serialized_genz", series_mode: "interleaved_multipart" };
  if (scriptId === 1) {
    return { ...base, part_number: 1, shared_top_banner_text: "MODEL BANNER ONE", segments: [
      seg("s1_1", "scene_0002", 10, 18, { storyFunction: "hook" }),
      seg("s1_2", "scene_0005", 45, 60, { beatId: "p1_b1" }),
      seg("s1_3", "scene_0008", 70, 85, { beatId: "p1_b2", on_screen_elements: [{ type: "top_banner", text: "MODEL BANNER ONE" }] })
    ] };
  }
  if (scriptId === 3) {
    return { ...base, part_number: 2, shared_top_banner_text: "A DIFFERENT TITLE", segments: [
      seg("s3_1", "scene_0012", 110, 118, { storyFunction: "hook" }),
      seg("s3_2", "scene_0013", 125, 140, { chapterBeatId: "p2_b1" }),
      ...(missBeat ? [] : [seg("s3_3", "scene_0017", 165, 185, { chapterBeatId: "p2_b2" })])
    ] };
  }
  return { ...base, part_number: 3, segments: [
    seg("s4_1", "scene_0022", 210, 218, { storyFunction: "hook", beatId: "hook" }),
    seg("s4_2", "scene_0023", 225, 245, { beatId: "p3_b1" }),
    seg("s4_3", "scene_0027", 260, 275, { beatId: "p3_b2" })
  ] };
}

function unitTests() {
  const manifest = { sourceVideo: "trunk-stop.mp4", videoDurationSec: DURATION, scenes: Array.from({ length: 30 }, (_, i) => ({ sceneId: `scene_${String(i + 1).padStart(4, "0")}`, startSec: i * 10, endSec: (i + 1) * 10 })) };
  const packageInfo = { sequentialSeriesEnabled: true, sequentialSeriesProfile: "serialized_genz", sequentialSeriesSharedHook: false, sourceVideoPath: "D:\\Video\\trunk-stop.mp4", cache: { sourceFingerprint: "abcdef1234567890" } };
  const blueprint = Bridge.buildBlueprintFromSeriesPlan(validPlan(), { manifest, packageInfo });
  assert.strictEqual(blueprint.artifactType, "serialized_story_blueprint");
  assert.strictEqual(blueprint.seriesId, "trunk-stop-abcdef12", "stable id from source + fingerprint");
  assert.deepStrictEqual(Bridge.validateBlueprintForPackage(blueprint, { manifest, packageInfo }).errors, []);

  // The legacy vocabulary is rejected by the import's validator (what blocked the live run).
  const legacy = Bridge.validateBlueprintForPackage(Bridge.buildBlueprintFromSeriesPlan(legacyPlan(), { manifest, packageInfo }), { manifest, packageInfo });
  assert(!legacy.passed);
  for (const fragment of ["Hook needs verified kind", "has invalid kind", "final chapterBeat should preserve", "Invalid external narrator range", "shared_top_banner_text missing"]) {
    assert(legacy.errors.some((error) => error.includes(fragment)), `legacy plan error: ${fragment}`);
  }

  // Raw model scripts fail the import check; host-applied fields make them pass.
  for (const id of [1, 3, 4]) {
    const raw = script(id);
    assert(!Serial.validateScriptAgainstBlueprint(raw, blueprint).passed, `raw script-${id} lacks series fields`);
    const applied = Bridge.applyBlueprintToScript(raw, blueprint);
    assert.deepStrictEqual(Serial.validateScriptAgainstBlueprint(applied.script, blueprint).errors, [], `script-${id}`);
    assert.strictEqual(applied.script.series_id, blueprint.seriesId);
    assert.strictEqual(applied.script.shared_top_banner_text, "KNOCKING FROM THE TRUNK");
    assert.notStrictEqual(applied.script, raw, "returns a copy");
  }
  assert.strictEqual(Bridge.applyBlueprintToScript(script(3), blueprint).script.segments[1].beatId, "p2_b1", "chapterBeatId alias -> beatId");
  const s4 = Bridge.applyBlueprintToScript(script(4), blueprint);
  assert(!("beatId" in s4.script.segments[0]), "'hook' is not a chapterBeat reference");
  assert.strictEqual(s4.notes.length, 1);
  assert.strictEqual(Bridge.applyBlueprintToScript(script(1), blueprint).script.segments[2].on_screen_elements[0].text, "KNOCKING FROM THE TRUNK");
  // A real coverage gap is NOT papered over.
  const missing = Serial.validateScriptAgainstBlueprint(Bridge.applyBlueprintToScript(script(3, { missBeat: true }), blueprint).script, blueprint);
  assert(missing.errors.some((error) => error.includes("Missing locked chapterBeat p2_b2")));
  assert(!Bridge.isBlueprintMode({ series: {}, packageInfo: { sequentialSeriesEnabled: false } }));
}

async function runStage1(respond) {
  const fixture = await createPackage();
  const calls = [];
  const messages = [];
  const service = new Stage1(
    { antigravityCommand: "agy", antigravityModel: "gemini-3.8-flash-high", antigravityCapacityRetryBaseMs: 0, phaseBArchitecture: "sequential" },
    { spawn: createPhaseAwareSpawn({ calls, respond }), sleep: async () => {}, authProbe: async () => ({ expiresAt: new Date(Date.now() + 50 * 60000), expiredFlag: false }) }
  );
  let result = null;
  let error = null;
  try {
    result = await service.run({ packageDir: fixture.root, onProgress: (item) => messages.push(String(item.message || "")) });
  } catch (caught) {
    error = caught;
  }
  return { fixture, calls, messages, result, error };
}

function partResponse(prompt, kind, overrides = {}) {
  const scriptId = partScriptIdFromPrompt(prompt);
  return {
    viewFiles: kind === "phase_b_part" ? proxyPathsFromPrompt(prompt) : [],
    envelope: { artifacts: [{ filename: `script-${scriptId}.json`, script: overrides[scriptId] || script(scriptId) }] }
  };
}

async function e2eTests() {
  const base = defaultResponder({ durationSec: DURATION });

  // --- legacy plan -> Blueprint repair -> locked series-blueprint.json the import accepts.
  {
    let planCalls = 0;
    const run = await runStage1((kind, prompt, call) => {
      if (kind === "series_plan" || kind === "series_plan_repair") {
        planCalls += 1;
        if (kind === "series_plan_repair") assert(prompt.includes("Blueprint v2:"), "repair lists the import's Blueprint errors");
        return { envelope: { artifacts: [{ filename: "series-plan.json", script: planCalls === 1 ? legacyPlan() : validPlan() }] } };
      }
      if (kind === "phase_b_part") {
        assert(prompt.includes("LOCKED SERIES BLUEPRINT CHECKS"), "Part prompt carries the Blueprint rules");
        return partResponse(prompt, kind);
      }
      return base(kind, prompt, call);
    });
    assert.ifError(run.error);
    assert.strictEqual(planCalls, 2, "initial plan + one Blueprint repair");
    const bpPath = path.join(run.fixture.root, "series-blueprint.json");
    assert.strictEqual(run.result.seriesBlueprintPath, bpPath);
    const info = JSON.parse(await fs.readFile(path.join(run.fixture.root, "package-info.json"), "utf8"));
    assert.strictEqual(info.seriesBlueprintPath, bpPath, "package-info records the locked Blueprint");
    assert.strictEqual(info.sequentialSeriesEnabled, true, "other package-info fields untouched");
    // Exactly what dubbingService.importHighlightCut does for a sequential Series package.
    const blueprint = JSON.parse(await fs.readFile(bpPath, "utf8"));
    const manifest = JSON.parse(await fs.readFile(run.fixture.manifestPath, "utf8"));
    assert.deepStrictEqual(Serial.validateBlueprint(blueprint, { manifest, profile: "serialized_genz", sharedHook: false }).errors, []);
    assert.strictEqual(run.result.validFiles.length, 3);
    for (const file of run.result.validFiles) {
      const saved = JSON.parse(await fs.readFile(file, "utf8"));
      assert.deepStrictEqual(Serial.validateScriptAgainstBlueprint(saved, blueprint).errors, [], path.basename(file));
    }
    assert(run.messages.some((message) => message.startsWith("[SERIES_BLUEPRINT] LOCKED")));
    await fs.rm(run.fixture.root, { recursive: true, force: true });
  }

  // --- a Part that misses a locked beat is repaired in the same conversation.
  {
    let part3Calls = 0;
    const run = await runStage1((kind, prompt, call) => {
      if (kind === "series_plan") return { envelope: { artifacts: [{ filename: "series-plan.json", script: validPlan() }] } };
      if (kind === "phase_b_part" || kind === "phase_b_part_repair") {
        if (partScriptIdFromPrompt(prompt) === 3) {
          part3Calls += 1;
          if (kind === "phase_b_part_repair") assert(prompt.includes("p2_b2"), "repair names the missing locked beat");
          return partResponse(prompt, kind, { 3: script(3, { missBeat: part3Calls === 1 }) });
        }
        return partResponse(prompt, kind);
      }
      return base(kind, prompt, call);
    });
    assert.ifError(run.error);
    assert.strictEqual(part3Calls, 2);
    await fs.rm(run.fixture.root, { recursive: true, force: true });
  }

  // --- import-only rule (dialogue beat voiced over instead of original audio) also drives the repair.
  {
    let part1Calls = 0;
    const run = await runStage1((kind, prompt, call) => {
      if (kind === "series_plan") return { envelope: { artifacts: [{ filename: "series-plan.json", script: validPlan() }] } };
      if ((kind === "phase_b_part" || kind === "phase_b_part_repair") && partScriptIdFromPrompt(prompt) === 1) {
        part1Calls += 1;
        if (part1Calls === 1) {
          const voiced = script(1);
          voiced.segments[1] = { ...voiced.segments[1], audio_mode: "voiceover", voiceover_text: "He refuses." };
          return partResponse(prompt, kind, { 1: voiced });
        }
        assert(prompt.includes("Blueprint: Missing locked chapterBeat p1_b1"), "repair cites the import's own error");
        return partResponse(prompt, kind);
      }
      if (kind === "phase_b_part" || kind === "phase_b_part_repair") return partResponse(prompt, kind);
      return base(kind, prompt, call);
    });
    assert.ifError(run.error);
    assert.strictEqual(part1Calls, 2);
    await fs.rm(run.fixture.root, { recursive: true, force: true });
  }

  // --- AGY policy filter on inline evidence (live 2026-10-20 PHASE_B_SCRIPT_1): plan, Part and repair
  //     prompts are re-sent once with the evidence moved to a brief file.
  {
    const BLOCKED = { resultObject: { status: "SUCCESS", response: "The prompt could not be submitted. The prompt contains sensitive words that violate Google's [Generative AI Prohibited Use policy](https://policies.google.com/terms/generative-ai/use-policy). Try rephrasing the prompt.\n", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
    const seen = { plan: 0, part1: 0, part3: 0, repair3: 0 };
    const briefPrompts = [];
    const run = await runStage1((kind, prompt, call) => {
      const isBrief = prompt.includes("BRIEF_FILE:");
      if (isBrief) briefPrompts.push({ kind, prompt });
      if (kind === "series_plan") {
        seen.plan += 1;
        return seen.plan === 1 ? BLOCKED : { envelope: { artifacts: [{ filename: "series-plan.json", script: validPlan() }] } };
      }
      if (kind === "phase_b_part" && partScriptIdFromPrompt(prompt) === 1) {
        seen.part1 += 1;
        return seen.part1 === 1 ? BLOCKED : partResponse(prompt, kind);
      }
      if (kind === "phase_b_part" && partScriptIdFromPrompt(prompt) === 3) {
        seen.part3 += 1;
        return partResponse(prompt, kind, { 3: script(3, { missBeat: true }) });
      }
      if (kind === "phase_b_part_repair" && partScriptIdFromPrompt(prompt) === 3) {
        seen.repair3 += 1;
        return seen.repair3 === 1 ? BLOCKED : partResponse(prompt, kind);
      }
      if (kind === "phase_b_part" || kind === "phase_b_part_repair") return partResponse(prompt, kind);
      return base(kind, prompt, call);
    });
    assert.ifError(run.error);
    assert.deepStrictEqual(seen, { plan: 2, part1: 2, part3: 1, repair3: 2 });
    assert.strictEqual(briefPrompts.length, 3, "plan, Part 1 and Part 3 repair re-sent as brief pointers");
    for (const { prompt } of briefPrompts) {
      assert(!prompt.includes("Locked Part Specification") && !prompt.includes("Step out of the car"), "brief prompt carries no evidence text");
      const briefPath = prompt.match(/BRIEF_FILE: (.+)/)[1].trim();
      const brief = await fs.readFile(briefPath, "utf8");
      assert(brief.length > 200, "full original prompt saved in the brief file");
    }
    const part1Brief = await fs.readFile(path.join(run.fixture.root, "01-ANTIGRAVITY-RESULT", "phase-b-input", "script-1-brief.txt"), "utf8");
    assert(part1Brief.includes("Phase B Sequential Script Generation"));
    assert(run.messages.some((message) => message.includes("AGY từ chối prompt (policy filter")));
    assert.strictEqual(run.result.validFiles.length, 3);
    await fs.rm(run.fixture.root, { recursive: true, force: true });
  }

  // --- still mismatched after the repairs -> Stage 1 fails instead of claiming "hợp lệ".
  {
    const run = await runStage1((kind, prompt, call) => {
      if (kind === "series_plan") return { envelope: { artifacts: [{ filename: "series-plan.json", script: validPlan() }] } };
      if (kind === "phase_b_part" || kind === "phase_b_part_repair") return partResponse(prompt, kind, { 3: script(3, { missBeat: true }) });
      return base(kind, prompt, call);
    });
    assert(run.error, "must not report success");
    assert.strictEqual(run.error.kind, "series_blueprint_mismatch");
    assert(run.error.message.includes("script-3.json"));
    assert.strictEqual(run.calls.filter((call) => call.kind === "phase_b_part_repair" && partScriptIdFromPrompt(call.prompt) === 3).length, 2, "two repair turns in Blueprint mode");
    assert(!run.messages.some((message) => /Đã tạo \d JSON variant hợp lệ/.test(message)));
    await fs.rm(run.fixture.root, { recursive: true, force: true });
  }

  // --- Blueprint never valid -> no scripts are written at all.
  {
    const run = await runStage1((kind, prompt, call) => {
      if (kind === "series_plan" || kind === "series_plan_repair") return { envelope: { artifacts: [{ filename: "series-plan.json", script: legacyPlan() }] } };
      return base(kind, prompt, call);
    });
    assert(run.error && /SERIES_PLAN\] FAILED/.test(run.error.message));
    assert.strictEqual(run.calls.filter((call) => call.kind === "series_plan_repair").length, 2);
    assert.strictEqual(run.calls.filter((call) => call.kind === "phase_b_part").length, 0);
    await assert.rejects(fs.access(path.join(run.fixture.root, "series-blueprint.json")));
    await fs.rm(run.fixture.root, { recursive: true, force: true });
  }
}

(async () => {
  unitTests();
  await e2eTests();
  console.log("antigravitySeriesBlueprint tests passed (plan -> locked Blueprint v2, host-filled series fields, per-Part import check + repair, no false 'hợp lệ')");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
