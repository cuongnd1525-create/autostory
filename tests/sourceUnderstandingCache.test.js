"use strict";

// Cache lifecycle tests for the persistent Antigravity source understanding.
// These use the REAL ManualGeminiPackService.create() (ffmpeg required, as in
// the app) so that the package rebuild — which deletes 01-GUI-GEMINI — is part
// of the test, and a fake `agy` CLI that records every process and view_file.

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ManualGeminiPackService = require("../electron/services/manualGeminiPackService");
const ManualAntigravityStage1Service = require("../electron/services/manualAntigravityStage1Service");
const {
  createPhaseAwareSpawn,
  defaultResponder,
  buildUnderstanding
} = require("./helpers/fakeAntigravity");

const BASE_PROMPT = "USER TASK INSTRUCTION - TEST\n- prompt_profile: independent_test\nNarrator style: documentary.\nVoice: en-US-GuyNeural.";
const CRIME_PROMPT = "USER TASK INSTRUCTION - BUILD TIKTOK VIRAL BODYCAM\n- prompt_profile: viral_tiktok_crime_part1\n- Target total duration: 110 to 125 seconds\nNarrator style: Gen-Z hype.\nVoice: en-US-AriaNeural.";

function makeVideo(filePath, { durationSec = 20, frequency = 440, pattern = "testsrc" } = {}) {
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `${pattern}=size=320x240:rate=12`,
    "-f", "lavfi", "-i", `sine=frequency=${frequency}`,
    "-t", String(durationSec), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", filePath
  ]);
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch (_error) { return false; }
}

async function listUnderstandingCacheFiles(cacheDir) {
  try {
    return (await fs.readdir(cacheDir)).filter((name) => /^source-understanding-v2-[0-9a-f]+\.json$/.test(name));
  } catch (_error) {
    return [];
  }
}

async function createPack(root, sourcePath, prompt = BASE_PROMPT, settings = {}) {
  const service = new ManualGeminiPackService({ workspaceRoot: path.join(root, "workspace"), ...settings });
  return service.create({
    sourceVideoPath: sourcePath,
    destinationRoot: path.join(root, "packages"),
    prompt,
    workflow: "manual_gemini_draft_review",
    autoWhisper: false,
    onProgress: () => {}
  });
}

async function runStage1(packageDir, { respond = defaultResponder(), settings = {} } = {}) {
  const calls = [];
  const progress = [];
  const service = new ManualAntigravityStage1Service({
    antigravityCommand: "agy",
    antigravityModel: "gemini-3.8-flash-high",
    antigravityTimeoutMs: 15000,
    ...settings
  }, { spawn: createPhaseAwareSpawn({ calls, respond }) });
  let result = null;
  let error = null;
  try {
    result = await service.run({ packageDir, onProgress: (item) => progress.push(item) });
  } catch (caught) {
    error = caught;
  }
  const messages = progress.map((item) => item.message || "");
  const videoViews = (kindFilter) => calls
    .filter((call) => kindFilter(call.kind))
    .length;
  return { calls, result, error, messages, videoViews };
}

function fullSourceViewCalls(calls) {
  return calls.filter((call) => call.kind === "phase_a" || call.kind === "phase_a_coverage_retry" || call.kind === "map");
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-su-cache-"));
  const sourcePath = path.join(root, "bodycam-source.mp4");
  makeVideo(sourcePath);

  // ---------------------------------------------------------------- Test A
  // Cold run: no understanding cache yet.
  const packA = await createPack(root, sourcePath);
  const cacheDir = packA.cache.cacheDir;
  assert(cacheDir.includes(path.join(".cineviral", "cache", "gemini-analysis")), "cache must live in the persistent source cache");
  assert(!cacheDir.startsWith(packA.pass1UploadDir), "cache must NOT live inside 01-GUI-GEMINI");
  assert.strictEqual((await listUnderstandingCacheFiles(cacheDir)).length, 0);

  const runA = await runStage1(packA.packageDir);
  assert.ifError(runA.error);
  assert.deepStrictEqual(runA.calls.map((call) => call.kind), ["map", "reduce", "phase_b"], "cold run = Phase A map + text-only reduce + Phase B");
  const timingA = runA.result.timing;
  assert.strictEqual(timingA.sourceUnderstanding.cacheHit, false);
  assert.strictEqual(timingA.sourceUnderstanding.expectedProxyCount, 1);
  assert.strictEqual(timingA.sourceUnderstanding.viewedProxyCount, 1, "Phase A must view the expected proxy count");
  assert.strictEqual(timingA.sourceUnderstanding.videoViewFileCount, 1);
  assert.strictEqual(timingA.sourceUnderstanding.agyProcessCount, 2, "1 map + 1 reducer");
  assert.strictEqual(timingA.sourceUnderstanding.architecture, "chunked_map_reduce");
  assert.strictEqual(timingA.sourceUnderstanding.reduce.videoViewFileCount, 0);
  assert.strictEqual(timingA.scriptGeneration.agyProcessCount, 1);
  assert.strictEqual(timingA.scriptGeneration.videoViewFileCount, 0);
  assert(runA.messages.some((message) => message.startsWith("[SOURCE_UNDERSTANDING] CACHE MISS")));
  assert(runA.messages.some((message) => message.startsWith("[PHASE_A] START")));
  const cacheFilesA = await listUnderstandingCacheFiles(cacheDir);
  assert.strictEqual(cacheFilesA.length, 1, "persistent understanding cache created");
  const cachePathA = path.join(cacheDir, cacheFilesA[0]);
  assert.strictEqual(runA.result.sourceUnderstanding.cachePath, cachePathA);
  const envelopeA = JSON.parse(await fs.readFile(cachePathA, "utf8"));
  assert.strictEqual(envelopeA.artifactType, "source_understanding_cache");
  assert.strictEqual(envelopeA.keyComponents.sourceFingerprint, packA.cache.sourceFingerprint);
  assert.deepStrictEqual(envelopeA.phaseA.coverage.viewedProxyFiles, ["analysis-proxy.mp4"]);
  assert.strictEqual(envelopeA.data.schemaVersion, 2);
  assert.strictEqual(envelopeA.data.artifactType, "source_understanding");
  const pipelineTiming = JSON.parse(await fs.readFile(path.join(packA.packageDir, "pipeline-timing.json"), "utf8"));
  assert.strictEqual(pipelineTiming.sourceUnderstanding.cacheHit, false);
  assert(Number.isFinite(pipelineTiming.totalMs));
  assert(pipelineTiming.preprocessMs > 0, "preprocess time from package creation must be reported");

  // ---------------------------------------------------------------- Test B
  // Second run with the same source: rebuild the package (deletes 01-GUI-GEMINI),
  // then Stage 1 must hit the persistent cache and never view the full source.
  const packB = await createPack(root, sourcePath);
  assert.strictEqual(packB.packageDir, packA.packageDir);
  assert(await exists(cachePathA), "createManualGeminiAnalysisPack() must NOT delete the understanding cache");
  const runB = await runStage1(packB.packageDir);
  assert.ifError(runB.error);
  assert.deepStrictEqual(runB.calls.map((call) => call.kind), ["phase_b"], "warm run = Phase B only");
  assert.strictEqual(fullSourceViewCalls(runB.calls).length, 0, "Phase A skipped");
  assert.strictEqual(runB.result.timing.sourceUnderstanding.cacheHit, true);
  assert.strictEqual(runB.result.timing.sourceUnderstanding.phaseASkipped, true);
  assert.strictEqual(runB.result.timing.sourceUnderstanding.agyProcessCount, 0);
  assert.strictEqual(runB.result.timing.sourceUnderstanding.videoViewFileCount, 0, "0 full-source view_file calls");
  assert.strictEqual(runB.result.timing.scriptGeneration.videoViewFileCount, 0);
  assert(runB.messages.some((message) => message.startsWith("[SOURCE_UNDERSTANDING] CACHE HIT")));
  assert(runB.messages.some((message) => message.startsWith("[PHASE_A] SKIPPED")));
  assert.strictEqual(runB.result.coverage.source, "source_understanding_cache");
  const phaseBPrompt = runB.calls[0].prompt;
  assert(phaseBPrompt.includes(path.join(packB.packageDir, "01-ANTIGRAVITY-RESULT", "phase-b-input", "source-understanding.json")));
  assert(phaseBPrompt.length < ManualAntigravityStage1Service.MAX_PRINT_PROMPT_CHARS, "Phase B prompt must stay under the Windows command-line limit");

  // ---------------------------------------------------------------- Test C
  // Prompt/settings change (voice, narrator style, hook, duration, profile)
  // without changing the source: the understanding stays reusable.
  const packC = await createPack(root, sourcePath, CRIME_PROMPT, {
    defaultVoiceProvider: "kokoro",
    edgeVoiceRate: 15
  });
  const candidate = packC.hookAuditionResult?.topCandidates?.[0] || { hookId: "h1", sourceStartSec: 1, sourceEndSec: 4, title: "Door" };
  await new ManualGeminiPackService({}).lockHookContract({
    packageDir: packC.packageDir,
    variants: {
      variant_01: { scriptId: 1, candidate, storyAngle: "part_1_confrontation" },
      variant_02: { scriptId: 3, candidate, storyAngle: "part_2_interrogation" },
      variant_03: { scriptId: 4, candidate, storyAngle: "part_3_verdict_arrest" }
    }
  });
  const lockedPrompt = await fs.readFile(packC.promptPath, "utf8");
  assert(!lockedPrompt.includes("3-VARIANT NARRATIVE DIFFERENTIATION MATRIX"), "series profiles must not get the 3-separate-stories matrix");
  assert(lockedPrompt.includes("SERIES HOOK CONTRACT"), "series hook contract must be injected");
  const runC = await runStage1(packC.packageDir);
  assert.ifError(runC.error);
  assert.deepStrictEqual(runC.calls.map((call) => call.kind), ["series_plan", "phase_b"], "settings change: cache HIT, plan locked before scripts");
  assert.strictEqual(runC.result.timing.sourceUnderstanding.cacheHit, true);
  assert.strictEqual(fullSourceViewCalls(runC.calls).length, 0);
  assert(await exists(path.join(packC.packageDir, "01-ANTIGRAVITY-RESULT", "series-plan.json")), "series-plan.json written");
  assert(runC.calls[1].prompt.includes("LOCKED_SERIES_PLAN"), "Phase B must receive the locked plan");
  assert(runC.calls[1].prompt.includes("SERIES LOCK"));
  assert.strictEqual(runC.result.timing.seriesPlan.agyProcessCount, 1);
  assert.strictEqual(runC.result.warnings.filter((warning) => warning.includes("series-plan.json")).length, 0, "scripts inside their Parts produce no adherence warning");

  // ---------------------------------------------------------------- Test D
  // Source changes -> new fingerprint -> CACHE MISS -> Phase A reruns.
  await fs.rm(sourcePath);
  makeVideo(sourcePath, { frequency: 880, pattern: "smptebars" });
  const packD = await createPack(root, sourcePath);
  assert.notStrictEqual(packD.cache.sourceFingerprint, packA.cache.sourceFingerprint, "changed source must change the fingerprint");
  const runD = await runStage1(packD.packageDir);
  assert.ifError(runD.error);
  assert.deepStrictEqual(runD.calls.map((call) => call.kind), ["map", "reduce", "phase_b"], "changed source: Phase A reruns");
  assert.strictEqual(runD.result.timing.sourceUnderstanding.cacheHit, false);
  assert(runD.messages.some((message) => message.startsWith("[SOURCE_UNDERSTANDING] CACHE MISS")));

  // Transcript change (same source) also invalidates, because the understanding cross-checks it.
  const transcriptPath = path.join(packD.pass1UploadDir, "source-transcript.srt");
  await fs.writeFile(transcriptPath, "1\n00:00:01,000 --> 00:00:03,000\nOpen the door!\n", "utf8");
  const infoPathD = path.join(packD.packageDir, "package-info.json");
  const infoD = JSON.parse(await fs.readFile(infoPathD, "utf8"));
  infoD.transcriptPath = transcriptPath;
  await fs.writeFile(infoPathD, JSON.stringify(infoD, null, 2), "utf8");
  const runD2 = await runStage1(packD.packageDir);
  assert.ifError(runD2.error);
  assert.strictEqual(runD2.result.timing.sourceUnderstanding.cacheHit, false, "transcript change must miss");
  assert.deepStrictEqual(runD2.calls.map((call) => call.kind), ["map", "reduce", "phase_b"], "the chunk transcript slice changed, so that chunk is rewatched");

  // ---------------------------------------------------------------- Test E
  // Corrupt cache: never silently accepted.
  const cacheDirD = packD.cache.cacheDir;
  const cacheFileD = path.join(cacheDirD, (await listUnderstandingCacheFiles(cacheDirD))
    .find((name) => runD2.result.sourceUnderstanding.cachePath.endsWith(name)));
  // E1: malformed global JSON -> INVALID -> only the text-only reducer reruns
  // (the chunk understanding is still a valid cache entry: no video rewatch).
  await fs.writeFile(cacheFileD, "{ this is not json", "utf8");
  const runE1 = await runStage1(packD.packageDir);
  assert.ifError(runE1.error);
  assert.deepStrictEqual(runE1.calls.map((call) => call.kind), ["reduce", "phase_b"]);
  assert.strictEqual(runE1.result.timing.sourceUnderstanding.videoViewFileCount, 0);
  assert.strictEqual(runE1.result.timing.sourceUnderstanding.cacheStatus, "invalid");
  assert(runE1.messages.some((message) => message.startsWith("[SOURCE_UNDERSTANDING] CACHE INVALID")));
  assert.strictEqual(JSON.parse(await fs.readFile(cacheFileD, "utf8")).artifactType, "source_understanding_cache", "cache rewritten with a valid envelope");

  // E2: the legacy fake cache shape ({raw:true}) is not a hit.
  const valid = JSON.parse(await fs.readFile(cacheFileD, "utf8"));
  await fs.writeFile(cacheFileD, JSON.stringify({ ...valid, data: { raw: true, notes: "Could not parse Phase A cleanly" } }), "utf8");
  const runE2 = await runStage1(packD.packageDir);
  assert.ifError(runE2.error);
  assert.strictEqual(runE2.result.timing.sourceUnderstanding.cacheStatus, "invalid");
  assert.strictEqual(fullSourceViewCalls(runE2.calls).length, 0, "only the reducer reruns");

  // E3: metadata mismatch (e.g. written by an older understanding prompt) is not a hit.
  const validAgain = JSON.parse(await fs.readFile(cacheFileD, "utf8"));
  await fs.writeFile(cacheFileD, JSON.stringify({
    ...validAgain,
    keyComponents: { ...validAgain.keyComponents, reducePromptVersion: 0 }
  }), "utf8");
  const runE3 = await runStage1(packD.packageDir);
  assert.strictEqual(runE3.result.timing.sourceUnderstanding.cacheStatus, "invalid");

  // E4: the map returns unparseable output -> that chunk fails clearly, NO cache written
  // (no same-conversation serialization by default; no reducer without valid chunks).
  await fs.rm(cacheFileD);
  await fs.rm(path.join(cacheDirD, "chunk-understanding"), { recursive: true, force: true });
  const brokenRespond = (kind, prompt) => {
    if (kind === "map") {
      return { viewFiles: [...prompt.matchAll(/view_file\("([^"]+)"\)/g)].map((m) => m[1]), rawResult: "I watched the video. It is about police." };
    }
    return defaultResponder()(kind, prompt);
  };
  const runE4 = await runStage1(packD.packageDir, { respond: brokenRespond });
  assert(runE4.error, "unparseable map output must fail");
  assert(runE4.error.message.startsWith("[PHASE_A] FAILED"), runE4.error.message);
  assert.deepStrictEqual(runE4.calls.map((call) => call.kind), ["map"], "only the failed chunk; no reducer, no rewatch");
  assert.strictEqual(await exists(cacheFileD), false, "no fake cache may be written after a parse failure");
  assert.deepStrictEqual(await fs.readdir(path.join(cacheDirD, "chunk-understanding")).catch(() => []), [], "no chunk cache after a parse failure");

  // E5: truncated understanding (stops half way) is rejected, not cached.
  const truncatedRespond = (kind, prompt) => {
    const truncated = buildUnderstanding(20);
    truncated.storyTimeline = truncated.storyTimeline.slice(0, 4);
    if (kind === "reduce") return { envelope: { artifacts: [{ filename: "source-understanding.json", script: truncated }] } };
    return defaultResponder()(kind, prompt);
  };
  const runE5 = await runStage1(packD.packageDir, { respond: truncatedRespond });
  assert(runE5.error && runE5.error.message.includes("[PHASE_A_REDUCE] FAILED"), runE5.error?.message);
  assert.deepStrictEqual(runE5.calls.map((call) => call.kind), ["map", "reduce", "reduce"], "one text-only reducer retry, never a video rewatch");
  assert.strictEqual(await exists(cacheFileD), false);

  // Phase B silently opening every proxy is surfaced (not silent).
  await runStage1(packD.packageDir); // rebuild a valid cache
  const rewatchRespond = defaultResponder({ phaseBViewFiles: [path.join(packD.pass1UploadDir, "analysis-proxy.mp4")] });
  const runF = await runStage1(packD.packageDir, { respond: rewatchRespond });
  assert.ifError(runF.error);
  assert.strictEqual(runF.result.timing.scriptGeneration.fullSourceRewatched, true);
  assert(runF.messages.some((message) => message.startsWith("[PHASE_B] WARNING")));
  assert(runF.result.warnings.some((warning) => warning.includes("xem lại toàn bộ")));

  await fs.rm(root, { recursive: true, force: true });
  console.log("sourceUnderstandingCache tests passed (A cold, B warm after package rebuild, C settings change, D source change, E corrupt cache)");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
