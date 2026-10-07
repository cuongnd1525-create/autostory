"use strict";

// Regression tests for the real-world Phase A failure of 2026-10-07:
//   3 proxies, 12.9 min source, coverage reached 100%, then the process ran
//   until "[agy] print timeout after 44m0s", the timeout was classified as
//   "server busy" (an unanchored /503/ matched the stream), a FRESH Phase A
//   re-watched all 3 proxies and finally failed with 401.

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const { createPhaseAwareSpawn, buildUnderstanding, defaultResponder, proxyPathsFromPrompt, contextPathsFromPrompt } = require("./helpers/fakeAntigravity");

const DURATION = 771.901;
const CHUNKS = [[0, 239.25], [239.25, 480.5], [480.5, 771.901]];

function buildSrt(cueCount = 750) {
  const blocks = [];
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ts = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(Math.floor(sec) % 60)},${pad(Math.round((sec % 1) * 1000), 3)}`;
  for (let index = 0; index < cueCount; index += 1) {
    const start = (index * DURATION) / cueCount;
    blocks.push(`${index + 1}\n${ts(start)} --> ${ts(start + 0.9)}\nline ${index + 1} word${index}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

async function createPackage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-phase-a-recovery-"));
  const pass1Dir = path.join(root, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const promptPath = path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt");
  await fs.writeFile(promptPath, "Generate Script 1, Script 3 and Script 4.", "utf8");
  const scenes = Array.from({ length: 87 }, (_, index) => ({
    sceneId: `scene_${String(index + 1).padStart(4, "0")}`,
    startSec: Number(((index * DURATION) / 87).toFixed(3)),
    endSec: Number((((index + 1) * DURATION) / 87).toFixed(3))
  }));
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({ videoDurationSec: DURATION, scenes }), "utf8");
  const chunks = CHUNKS.map(([start, end], index) => ({
    chunkId: `proxy_chunk_00${index + 1}`, file: `analysis-proxy-chunk-00${index + 1}.mp4`, sourceStartSec: start, sourceEndSec: end, durationSec: end - start
  }));
  for (const chunk of chunks) await fs.writeFile(path.join(pass1Dir, chunk.file), `video-${chunk.chunkId}`, "utf8");
  await fs.writeFile(path.join(pass1Dir, "proxy-chunks-manifest.json"), JSON.stringify({ sourceDurationSec: DURATION, chunks }), "utf8");
  await fs.writeFile(path.join(pass1Dir, "source-transcript.srt"), buildSrt(), "utf8");
  const cacheDir = path.join(root, "source-cache");
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review",
    pass1UploadDir: pass1Dir,
    promptPath,
    proxyChunksManifestPath: path.join(pass1Dir, "proxy-chunks-manifest.json"),
    proxyChunkCount: 3,
    cache: { sourceFingerprint: "fp-phase-a-recovery", cacheDir }
  }), "utf8");
  return { root, pass1Dir, cacheDir };
}

async function cacheFiles(cacheDir) {
  try { return (await fs.readdir(cacheDir)).filter((name) => /^source-understanding-v2-.*\.json$/.test(name)); } catch (_error) { return []; }
}

// Misleading numbers that previously matched /503/ in the full stdout.
const MISLEADING_EVENT = { event: "step_update", step_update: { step_index: 50, state: "DONE", step_type: "agent_response", duration_seconds: 503.874, usage: { input_tokens: 85030, output_tokens: 1503 } } };
const PRINT_TIMEOUT = { omitResult: true, exitCode: 1, stderr: "W1007 poll.go:188] Print mode: print timeout after 9m18s with turn in progress\n[agy] print timeout after 9m18s with turn in progress\n" };
const AUTH_401 = {
  omitResult: false,
  rawResult: "",
  exitCode: 1,
  stderr: 'Error: UNAUTHENTICATED (code 401): Request had invalid authentication credentials.\nAGY_ERROR: {"short_error":"UNAUTHENTICATED (code 401)","status":"UNAUTHENTICATED","error_code":401,"retryable":false}\n'
};
const CAPACITY_503 = {
  exitCode: 1,
  stderr: 'AGY_ERROR: {"short_error":"UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server","status":"UNAVAILABLE","error_code":503,"retryable":true}\n'
};

function watchAll(prompt) {
  return [...proxyPathsFromPrompt(prompt), ...contextPathsFromPrompt(prompt)];
}

async function run(fixture, respond, { authProbe } = {}) {
  const calls = [];
  const progress = [];
  const service = new Stage1(
    { antigravityCommand: "agy", antigravityModel: "gemini-3.8-flash-high" },
    { spawn: createPhaseAwareSpawn({ calls, respond }), authProbe: authProbe || (async () => ({ expiresAt: new Date(Date.now() + 50 * 60000), expiredFlag: false })) }
  );
  let result = null;
  let error = null;
  try {
    result = await service.run({ packageDir: fixture.root, onProgress: (item) => progress.push(item.message || "") });
  } catch (caught) {
    error = caught;
  }
  const timing = JSON.parse(await fs.readFile(path.join(fixture.root, "01-ANTIGRAVITY-RESULT", "timing-report.json"), "utf8").catch(() => "null"));
  const videoViews = calls.reduce((sum, call) => sum + proxyPathsFromPrompt("").length + (call.viewedMp4 || 0), 0);
  void videoViews;
  return { calls, result, error, progress, timing };
}

function mp4ViewsEmitted(calls) {
  // DONE view_file events actually delivered for .mp4 files (a kill stops emission).
  return calls.reduce((sum, call) => sum + (call.mp4Views || 0), 0);
}

(async () => {
  // ------------------------------------------------------------------ static checks
  const timeoutA = Stage1.resolvePhaseTimeoutMs("phase_a", {}, { sourceDurationSec: DURATION });
  assert(timeoutA < 10 * 60000, `Phase A timeout for 12.9 min must be < 10 min, got ${timeoutA}ms`);
  assert.notStrictEqual(timeoutA, 2640000, "Phase A must not reuse the 3*480+1200s combined formula");
  assert.strictEqual(Stage1.resolvePhaseTimeoutMs("phase_a", { antigravityPhaseATimeoutMs: 480000 }, { sourceDurationSec: DURATION }), 480000, "Phase A timeout is configurable");
  assert.strictEqual(Stage1.classifyAgyFailure({ kind: "print_timeout", stdout: JSON.stringify(MISLEADING_EVENT) }), "print_timeout");
  assert.strictEqual(Stage1.classifyAgyFailure({ stdout: `${JSON.stringify(MISLEADING_EVENT)}\n`, stderr: "" }), "cli_error", "numbers in stdout must never be read as HTTP 503");
  assert.strictEqual(Stage1.classifyAgyFailure({ stderr: AUTH_401.stderr }), "auth");
  assert.strictEqual(Stage1.classifyAgyFailure({ stderr: CAPACITY_503.stderr }), "capacity");
  const expiry = Stage1.parseKeyringExpiry("I1007 08:50:39.706934      48 keyring.go:64] keyringAuth: loaded token, expiry=2026-10-07 09:44:35.1397635 +0700 +07 expired=false");
  assert.strictEqual(expiry.expiresAt.toISOString(), "2026-10-07T02:44:35.000Z");
  const context = Stage1.buildPhaseAContext({
    sceneManifest: { scenes: Array.from({ length: 87 }, (_, i) => ({ sceneId: `scene_${i}`, startSec: i, endSec: i + 1 })) },
    transcriptText: buildSrt(), expectedProxyList: [], videoDurationSec: DURATION
  });
  assert.strictEqual(context.cueCount, 750, "every transcript cue is kept");
  for (let index = 0; index < 750; index += 1) assert(context.text.includes(`word${index}`), `cue ${index} text kept`);
  assert(context.lineCount < 400, `context fits one view_file call (${context.lineCount} lines vs 3,000-line SRT)`);

  // SRT variant seen in the real source: a blank line between timing and text,
  // plus a rolling-caption duplicate. No spoken words may be dropped.
  const oddSrt = "1\n00:00:03,640 --> 00:00:05,310\n\nYou need some help?\n\n2\n00:00:05,310 --> 00:00:05,320\nYou need some help?\n \n\n3\n00:00:05,320 --> 00:00:09,150\n\nNo, I'm good, 42 miles.\n";
  const oddContext = Stage1.buildPhaseAContext({ sceneManifest: { scenes: [] }, transcriptText: oddSrt, expectedProxyList: [], videoDurationSec: 10 });
  assert(oddContext.text.includes("You need some help?"));
  assert(oddContext.text.includes("No, I'm good, 42 miles."));
  assert.strictEqual(oddContext.cueCount, 2, "rolling duplicate collapsed, nothing else dropped");

  // Count mp4 DONE views per call by wrapping respond.
  const counting = (respond) => (kind, prompt, call) => {
    const response = respond(kind, prompt, call) || {};
    call.mp4Views = (response.viewFiles || []).filter((file) => /\.mp4$/i.test(file)).length;
    return response;
  };

  // ------------------------------------------------------------------ 1. timeout after 100% coverage -> same-conversation serialization succeeds
  {
    const fixture = await createPackage();
    const outcome = await run(fixture, counting((kind, prompt) => {
      if (kind === "phase_a") return { viewFiles: watchAll(prompt), extraEvents: [MISLEADING_EVENT], ...PRINT_TIMEOUT };
      if (kind === "phase_a_repair") return { envelope: { artifacts: [{ filename: "source-understanding.json", script: buildUnderstanding(DURATION) }] } };
      return defaultResponder({ durationSec: DURATION })(kind, prompt);
    }));
    assert.ifError(outcome.error);
    const kinds = outcome.calls.map((call) => call.kind);
    assert.deepStrictEqual(kinds, ["phase_a", "phase_a_repair", "phase_b"], kinds.join(","));
    assert.strictEqual(kinds.filter((kind) => kind === "phase_a").length, 1, "full multimodal process count = 1");
    assert(outcome.calls[1].resumed, "serialization resumes the SAME conversation");
    assert.strictEqual(outcome.calls[1].conversationId, outcome.calls[0].conversationId);
    assert(outcome.calls[1].prompt.startsWith("You have already inspected 100% of the required source proxy videos."));
    assert(outcome.calls[1].prompt.includes("DO NOT call view_file."));
    assert.strictEqual(mp4ViewsEmitted(outcome.calls), 3, "view_file total = 3");
    const su = outcome.timing.sourceUnderstanding;
    assert.strictEqual(su.viewFileCount, 3);
    assert.strictEqual(su.duplicateVideoViewCount, 0);
    assert.strictEqual(su.transcriptReadCount, 0, "raw SRT is never paged");
    assert.strictEqual(su.manifestReadCount, 0);
    assert.strictEqual(su.contextReadCount, 1);
    assert.strictEqual(su.timeoutOccurred, true);
    assert.strictEqual(su.serializationRepairUsed, "same_conversation");
    assert.strictEqual(su.fullMultimodalRestartCount, 0);
    assert.strictEqual(su.proxyCount, 3);
    assert.strictEqual(su.sourceVideoDurationSec, DURATION);
    assert(Number.isInteger(su.inputTokens) && Number.isInteger(su.outputTokens), "token counts come from AGY usage events");
    assert(Number.isInteger(su.agentTurnCount) && su.agentTurnCount >= 1);
    assert(!outcome.progress.some((message) => /tạm bận|server busy/i.test(message)), "a print timeout is never reported as server busy");
    assert.strictEqual((await cacheFiles(fixture.cacheDir)).length, 1, "cache written once");
    // The attempt logs are kept separately (the first attempt's log is no longer overwritten).
    const resultFiles = await fs.readdir(path.join(fixture.root, "01-ANTIGRAVITY-RESULT"));
    assert(resultFiles.includes("antigravity-output-phaseA-attempt1.log"));
    assert(resultFiles.some((name) => name.startsWith("antigravity-output-phaseA-serialize-attempt")));
  }

  // ------------------------------------------------------------------ 2. timeout + serialization fails -> explicit failure, no rewatch, no cache
  {
    const fixture = await createPackage();
    const outcome = await run(fixture, counting((kind, prompt) => {
      if (kind === "phase_a") return { viewFiles: watchAll(prompt), ...PRINT_TIMEOUT };
      if (kind === "phase_a_repair") return { rawResult: "Sure, here is a summary of the video." };
      return defaultResponder({ durationSec: DURATION })(kind, prompt);
    }));
    assert(outcome.error, "must fail explicitly");
    assert(outcome.error.message.startsWith("[PHASE_A] FAILED"), outcome.error.message);
    assert.deepStrictEqual(outcome.calls.map((call) => call.kind), ["phase_a", "phase_a_repair"]);
    assert.strictEqual(mp4ViewsEmitted(outcome.calls), 3);
    assert.strictEqual((await cacheFiles(fixture.cacheDir)).length, 0, "no cache after an unrecoverable result");
    assert.strictEqual(outcome.timing.sourceUnderstanding.failed, true);
    assert.strictEqual(outcome.timing.sourceUnderstanding.fullMultimodalRestartCount, 0);
    assert.strictEqual(outcome.timing.sourceUnderstanding.timeoutOccurred, true);
  }

  // ------------------------------------------------------------------ 3. serialization tries view_file -> process killed, mp4 views stay 3
  {
    const fixture = await createPackage();
    const outcome = await run(fixture, counting((kind, prompt) => {
      if (kind === "phase_a") return { viewFiles: watchAll(prompt), ...PRINT_TIMEOUT };
      if (kind === "phase_a_repair") {
        return {
          viewFiles: watchAll(`view_file("${path.join(fixture.pass1Dir, "analysis-proxy-chunk-001.mp4")}")`),
          envelope: { artifacts: [{ filename: "source-understanding.json", script: buildUnderstanding(DURATION) }] }
        };
      }
      return defaultResponder({ durationSec: DURATION })(kind, prompt);
    }));
    assert(outcome.error, "a serialization that tries to re-view video is rejected");
    const repair = outcome.calls.find((call) => call.kind === "phase_a_repair");
    assert.strictEqual(repair.killed, true, "the continuation is terminated at the first forbidden tool call");
    assert.strictEqual(outcome.timing.sourceUnderstanding.viewFileCount, 3, "no additional completed mp4 view_file");
    assert.strictEqual(outcome.timing.sourceUnderstanding.serializationVideoViews, 0);
    assert(outcome.timing.sourceUnderstanding.failureKinds.includes("forbidden_tool"));
    assert.strictEqual(outcome.calls.filter((call) => call.kind === "phase_a").length, 1);
  }

  // ------------------------------------------------------------------ 4. Case C: partial stdout holds a truncated JSON -> local repair, no AGY continuation needed to succeed
  {
    const fixture = await createPackage();
    const full = JSON.stringify({ artifacts: [{ filename: "source-understanding.json", script: buildUnderstanding(DURATION) }] });
    const cut = full.slice(0, full.indexOf('"hookCandidates"') + 30); // cut inside the candidate lists
    const outcome = await run(fixture, counting((kind, prompt) => {
      if (kind === "phase_a") {
        return { viewFiles: watchAll(prompt), extraEvents: [{ event: "result", result: { status: "ERROR", response: cut, error: "stream interrupted" } }], omitResult: true, exitCode: 1, stderr: PRINT_TIMEOUT.stderr };
      }
      if (kind === "phase_a_repair") return { rawResult: "" };
      return defaultResponder({ durationSec: DURATION })(kind, prompt);
    }));
    assert.ifError(outcome.error);
    assert.strictEqual(outcome.timing.sourceUnderstanding.serializationRepairUsed, "same_conversation+local_truncation_repair");
    assert.strictEqual(mp4ViewsEmitted(outcome.calls), 3);
    assert.strictEqual((await cacheFiles(fixture.cacheDir)).length, 1, "a recovered result is cached only after full validation");
  }

  // ------------------------------------------------------------------ 5. 401 during Phase A -> immediate auth failure, no rewatch
  {
    const fixture = await createPackage();
    const outcome = await run(fixture, counting((kind, prompt) => {
      if (kind === "phase_a") return { viewFiles: watchAll(prompt).slice(0, 2), ...AUTH_401 };
      return defaultResponder({ durationSec: DURATION })(kind, prompt);
    }));
    assert(outcome.error);
    assert.strictEqual(outcome.error.kind, "auth");
    assert(/401|UNAUTHENTICATED/.test(outcome.error.message));
    assert.deepStrictEqual(outcome.calls.map((call) => call.kind), ["phase_a"], "no automatic source rewatch after 401");
    assert.strictEqual(outcome.timing.sourceUnderstanding.failureKind, "auth");
  }

  // ------------------------------------------------------------------ 6. 401 during serialization -> fail, still no rewatch
  {
    const fixture = await createPackage();
    const outcome = await run(fixture, counting((kind, prompt) => {
      if (kind === "phase_a") return { viewFiles: watchAll(prompt), ...PRINT_TIMEOUT };
      if (kind === "phase_a_repair") return AUTH_401;
      return defaultResponder({ durationSec: DURATION })(kind, prompt);
    }));
    assert(outcome.error && outcome.error.kind === "auth");
    assert.deepStrictEqual(outcome.calls.map((call) => call.kind), ["phase_a", "phase_a_repair"]);
    assert.strictEqual(mp4ViewsEmitted(outcome.calls), 3);
  }

  // ------------------------------------------------------------------ 7. expired token before spawning -> zero AGY processes
  {
    const fixture = await createPackage();
    const outcome = await run(fixture, defaultResponder({ durationSec: DURATION }), {
      authProbe: async () => ({ expiresAt: new Date(Date.now() - 1000), expiredFlag: true })
    });
    assert(outcome.error && outcome.error.kind === "auth");
    assert.strictEqual(outcome.calls.length, 0, "no AGY process is started with an expired token");
  }

  // ------------------------------------------------------------------ 8. 503 before any video -> one fresh retry; 503 after videos -> no fresh restart
  {
    const fixture = await createPackage();
    let first = true;
    const outcome = await run(fixture, counting((kind, prompt) => {
      if (kind === "phase_a" && first) { first = false; return CAPACITY_503; }
      return defaultResponder({ durationSec: DURATION })(kind, prompt);
    }));
    assert.ifError(outcome.error);
    assert.deepStrictEqual(outcome.calls.map((call) => call.kind), ["phase_a", "phase_a", "phase_b"]);
    assert.strictEqual(outcome.timing.sourceUnderstanding.freshRetryBeforeAnyVideoCount, 1);
    assert.strictEqual(outcome.timing.sourceUnderstanding.fullMultimodalRestartCount, 0);
  }
  {
    const fixture = await createPackage();
    const outcome = await run(fixture, counting((kind, prompt) => {
      if (kind === "phase_a") return { viewFiles: watchAll(prompt), ...CAPACITY_503 };
      if (kind === "phase_a_repair") return { envelope: { artifacts: [{ filename: "source-understanding.json", script: buildUnderstanding(DURATION) }] } };
      return defaultResponder({ durationSec: DURATION })(kind, prompt);
    }));
    assert.ifError(outcome.error);
    assert.deepStrictEqual(outcome.calls.map((call) => call.kind), ["phase_a", "phase_a_repair", "phase_b"], "503 after the videos were watched resumes, never restarts");
    assert.strictEqual(mp4ViewsEmitted(outcome.calls), 3);
  }

  // ------------------------------------------------------------------ 9. warm run after a recovered cold run: cache hit, 0 video views
  {
    const fixture = await createPackage();
    const respond = counting((kind, prompt) => {
      if (kind === "phase_a") return { viewFiles: watchAll(prompt), ...PRINT_TIMEOUT };
      if (kind === "phase_a_repair") return { envelope: { artifacts: [{ filename: "source-understanding.json", script: buildUnderstanding(DURATION) }] } };
      return defaultResponder({ durationSec: DURATION })(kind, prompt);
    });
    await run(fixture, respond);
    const warm = await run(fixture, respond);
    assert.ifError(warm.error);
    assert.deepStrictEqual(warm.calls.map((call) => call.kind), ["phase_b"]);
    assert.strictEqual(warm.timing.sourceUnderstanding.cacheHit, true);
    assert.strictEqual(warm.timing.sourceUnderstanding.viewFileCount, 0);
    assert(warm.progress.some((message) => message.startsWith("[SOURCE_UNDERSTANDING] CACHE HIT")));
    assert(warm.progress.some((message) => message.startsWith("[PHASE_A] SKIPPED")));
  }

  console.log("phaseARecovery tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
