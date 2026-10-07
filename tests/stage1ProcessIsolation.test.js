"use strict";

// Process isolation + map recovery for the chunked Phase A.
// Live run 2026-10-07 11:20 (concurrency 2, 3 chunks):
//   chunk-001: AGY answered in ~2 s with "The prompt could not be submitted ...
//              Prohibited Use policy" (0 tokens) -> host reported "coverage".
//   chunk-002/003: view_file OK, then server-side INTERNAL 500 / 503 inside AGY
//              ("The stream was interrupted"), AGY's own print timeout 5m26s.
// These tests pin down that concurrent AGY children never share mutable state
// and that every chunk-local recovery stays chunk-local.

const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { PassThrough, Writable } = require("stream");

const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const { createPhaseAwareSpawn, defaultResponder, mapTaskFromPrompt, buildChunkUnderstanding } = require("./helpers/fakeAntigravity");

const DURATION = 771.901;
const CHUNKS = [[0, 239.25], [239.25, 480.5], [480.5, 771.901]];

// ---------------------------------------------------------------- controlled children
function controlledSpawn(registry) {
  return (command, args) => {
    const name = (args.find((arg) => arg.startsWith("--print=")) || "").slice("--print=".length);
    const child = new EventEmitter();
    child.pid = 50000 + registry.size;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.killed = false;
    child.closed = false;
    child.line = (object) => child.stdout.write(`${JSON.stringify(object)}\n`);
    child.close = (code = 0) => {
      if (child.closed) return;
      child.closed = true;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", code));
    };
    child.kill = () => {
      child.killed = true;
      child.close(1);
    };
    registry.set(name, child);
    return child;
  };
}

const viewEvent = (conversation, index, file) => ({ event: "step_update", step_update: { conversation_id: conversation, step_index: index, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: file } } } });
const resultEvent = (conversation, payload) => ({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response: JSON.stringify(payload), usage: { total_tokens: 10 } } });
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

async function processIsolationTests() {
  const children = new Map();
  const service = new Stage1({ antigravityCommand: "agy" }, { spawn: controlledSpawn(children), timers: { heartbeatMs: 10, hardTimeoutGraceMs: 40 } });
  const start = (name, timeoutMs, extra = {}) => settle(service.runCli({ command: "agy", args: [`--print=${name}`], prompt: name, cwd: os.tmpdir(), timeoutMs, label: name, ...extra }));

  // A finishes while B continues.
  const runA = start("A", 60000);
  const runB = start("B", 60000);
  await tick();
  assert.deepStrictEqual(service.listActiveRuns().map((run) => run.label).sort(), ["A", "B"], "registry holds both children");
  const a = children.get("A");
  const b = children.get("B");
  a.line(resultEvent("conv-a", { ok: true }));
  a.close(0);
  const doneA = await runA;
  assert(doneA.ok, "A resolves");
  assert.strictEqual(doneA.value.stats.terminationReason, "exit_ok");
  assert.strictEqual(b.killed, false, "A finishing must not kill B");
  assert.deepStrictEqual(service.listActiveRuns().map((run) => run.label), ["B"], "A finishing must not clear B's state");

  // A2 times out (host inactivity) while B continues.
  const runA2 = start("A2", 60);
  await tick(200);
  const doneA2 = await runA2;
  assert(!doneA2.ok && /timeout/.test(doneA2.error.kind), `A2 times out (${doneA2.error?.kind})`);
  assert.strictEqual(children.get("A2").killed, true, "only A2 is terminated");
  assert.strictEqual(b.killed, false, "A2's timeout must not kill B");
  assert(/^host_(inactivity|hard)_timeout$/.test(doneA2.error.stats.terminationReason));
  assert.deepStrictEqual(service.listActiveRuns().map((run) => run.label), ["B"]);
  b.line({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response" } });

  // Global cancel intentionally terminates every running child.
  const runC = start("C", 60000);
  await tick();
  service.cancel();
  const [doneB, doneC] = await Promise.all([runB, runC]);
  assert.strictEqual(b.killed, true);
  assert.strictEqual(children.get("C").killed, true);
  assert.strictEqual(doneB.error.kind, "cancelled");
  assert.strictEqual(doneC.error.kind, "cancelled");
  assert.deepStrictEqual(service.listActiveRuns(), [], "registry empty after cancel");

  // Coverage auditing under concurrency: interleaved streams, no cross-contamination.
  const service2 = new Stage1({ antigravityCommand: "agy" }, { spawn: controlledSpawn(children), timers: { heartbeatMs: 10, hardTimeoutGraceMs: 40 } });
  const proxy1 = { id: "p1", filename: "analysis-proxy-chunk-001.mp4", absolutePath: "D:\\pack\\01-GUI-GEMINI\\analysis-proxy-chunk-001.mp4" };
  const proxy2 = { id: "p2", filename: "analysis-proxy-chunk-002.mp4", absolutePath: "D:\\pack\\01-GUI-GEMINI\\analysis-proxy-chunk-002.mp4" };
  const viewed1 = new Set();
  const viewed2 = new Set();
  const run1 = settle(service2.runCli({ command: "agy", args: ["--print=M1"], prompt: "M1", cwd: os.tmpdir(), timeoutMs: 60000, expectedProxyList: [proxy1], viewedProxySet: viewed1 }));
  const run2 = settle(service2.runCli({ command: "agy", args: ["--print=M2"], prompt: "M2", cwd: os.tmpdir(), timeoutMs: 60000, expectedProxyList: [proxy2], viewedProxySet: viewed2 }));
  await tick();
  const m1 = children.get("M1");
  const m2 = children.get("M2");
  m1.line(viewEvent("c1", 1, proxy1.absolutePath));
  m2.line(viewEvent("c2", 1, proxy2.absolutePath));
  await tick();
  m2.line(resultEvent("c2", {}));
  m1.line(resultEvent("c1", {}));
  m2.close(0);
  m1.close(0);
  const [r1, r2] = await Promise.all([run1, run2]);
  assert(r1.ok && r2.ok);
  const coverage1 = Stage1.validateVideoCoverage([proxy1, proxy2], viewed1);
  const coverage2 = Stage1.validateVideoCoverage([proxy1, proxy2], viewed2);
  assert.deepStrictEqual(coverage1.viewedProxyFiles, ["analysis-proxy-chunk-001.mp4"], "chunk-001 coverage = file1 only");
  assert.deepStrictEqual(coverage2.viewedProxyFiles, ["analysis-proxy-chunk-002.mp4"], "chunk-002 coverage = file2 only");
  assert.strictEqual(r1.value.stats.viewFileVideoCount, 1);
  assert.strictEqual(r2.value.stats.viewFileVideoCount, 1);
  assert.notStrictEqual(r1.value.stats.runId, r2.value.stats.runId);

  // Real AGY transcript.jsonl double-encodes tool args; the auditor must still see the view.
  const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-transcript-"));
  const abridged = path.join(transcriptDir, "transcript.jsonl");
  await fs.writeFile(abridged, `${JSON.stringify({ step_index: 1, tool_calls: [{ name: "view_file", args: { AbsolutePath: JSON.stringify(proxy2.absolutePath.replace(/\\/g, "\\\\")) } }] })}\n`, "utf8");
  const audited = await Stage1.auditTranscriptForViewedProxies(null, [proxy2], new Set(), abridged);
  assert.strictEqual(audited.isComplete, true, "double-encoded transcript.jsonl args are recognised");
  await fs.rm(transcriptDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- package fixture
async function createPackage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-isolation-"));
  const pass1Dir = path.join(root, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const promptPath = path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt");
  await fs.writeFile(promptPath, "Generate Script 1, Script 3 and Script 4.", "utf8");
  const scenes = Array.from({ length: 30 }, (_, index) => ({ sceneId: `scene_${String(index + 1).padStart(4, "0")}`, startSec: (index * DURATION) / 30, endSec: ((index + 1) * DURATION) / 30 }));
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({ videoDurationSec: DURATION, scenes }), "utf8");
  const chunks = CHUNKS.map(([start, end], index) => ({ chunkId: `proxy_chunk_00${index + 1}`, file: `analysis-proxy-chunk-00${index + 1}.mp4`, sourceStartSec: start, sourceEndSec: end }));
  for (const chunk of chunks) await fs.writeFile(path.join(pass1Dir, chunk.file), `video-${chunk.chunkId}`, "utf8");
  await fs.writeFile(path.join(pass1Dir, "proxy-chunks-manifest.json"), JSON.stringify({ chunks }), "utf8");
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ts = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(Math.floor(sec) % 60)},000`;
  const cues = [];
  for (let sec = 2, index = 1; sec < DURATION - 2; sec += 20, index += 1) cues.push(`${index}\n${ts(sec)} --> ${ts(sec + 2)}\nOpen the door! line ${index}`);
  await fs.writeFile(path.join(pass1Dir, "source-transcript.srt"), `${cues.join("\n\n")}\n`, "utf8");
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review", pass1UploadDir: pass1Dir, promptPath,
    proxyChunksManifestPath: path.join(pass1Dir, "proxy-chunks-manifest.json"),
    cache: { sourceFingerprint: "fp-isolation", cacheDir: path.join(root, "source-cache") }
  }), "utf8");
  return { root, pass1Dir };
}

async function runPhaseA(fixture, respond, { settings = {}, authProbe } = {}) {
  const calls = [];
  const messages = [];
  let probes = 0;
  const service = new Stage1(
    { antigravityCommand: "agy", antigravityModel: "gemini-3.8-flash-high", antigravityCapacityRetryBaseMs: 0, ...settings },
    { spawn: createPhaseAwareSpawn({ calls, respond }), authProbe: async (info) => { probes += 1; return (authProbe || (async () => ({ expiresAt: new Date(Date.now() + 50 * 60000), expiredFlag: false })))(info); } }
  );
  let result = null;
  let error = null;
  try {
    result = await service.run({ packageDir: fixture.root, stopAfter: "source_understanding", onProgress: (item) => messages.push(String(item.message || "")) });
  } catch (caught) {
    error = caught;
  }
  const timing = JSON.parse(await fs.readFile(path.join(fixture.root, "pipeline-timing.json"), "utf8").catch(() => "null"));
  const chunkOf = (call) => (call.kind === "map" ? mapTaskFromPrompt(call.prompt).chunkId : null);
  return { calls, messages, result, error, timing, probes, chunkOf, su: timing?.sourceUnderstanding };
}

const happy = defaultResponder({ durationSec: DURATION });
const BLOCKED = { resultObject: { status: "SUCCESS", response: "The prompt could not be submitted. The prompt contains sensitive words that violate Google's [Generative AI Prohibited Use policy](https://policies.google.com/terms/generative-ai/use-policy). Try rephrasing the prompt.\n", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };

async function mapRecoveryTests() {
  // --- chunk-001 prompt rejected by the policy filter -> one retry with file context; other chunks untouched.
  {
    const fixture = await createPackage();
    let blocked = 0;
    const respond = (kind, prompt, call) => {
      if (kind === "map" && mapTaskFromPrompt(prompt).chunkId === "chunk-001" && prompt.includes("TEXT CONTEXT FOR THIS INTERVAL")) {
        blocked += 1;
        return BLOCKED;
      }
      if (kind === "map" && mapTaskFromPrompt(prompt).chunkId === "chunk-001") {
        const task = mapTaskFromPrompt(prompt);
        const contextFile = [...prompt.matchAll(/view_file\("([^"]+-context\.txt)"/g)].map((match) => match[1]);
        assert.strictEqual(contextFile.length, 1, "retry reads the chunk-local context file");
        assert(contextFile[0].includes(path.join("map", "chunk-001")), "context file lives in the chunk workspace");
        return { viewFiles: [task.proxy, contextFile[0]], envelope: { artifacts: [{ filename: "x.json", script: buildChunkUnderstanding("chunk-001", task.startSec, task.endSec) }] } };
      }
      return happy(kind, prompt, call);
    };
    const run = await runPhaseA(fixture, respond);
    assert.ifError(run.error);
    assert.strictEqual(blocked, 1);
    const mapChunks = run.calls.filter((call) => call.kind === "map").map(run.chunkOf);
    assert.deepStrictEqual(mapChunks.filter((id) => id === "chunk-001").length, 2, "chunk-001: blocked attempt + one file-context retry");
    assert.deepStrictEqual(mapChunks.filter((id) => id !== "chunk-001").sort(), ["chunk-002", "chunk-003"], "other chunks ran once");
    const chunk1 = run.su.map.chunks[0];
    assert.strictEqual(chunk1.promptBlockRetryCount, 1);
    assert.strictEqual(chunk1.promptBlocked, true);
    assert.strictEqual(chunk1.contextMode, "file");
    assert.strictEqual(chunk1.attempts[0].kind, "prompt_blocked", "classified as prompt_blocked, not coverage");
    assert(run.messages.some((message) => message.startsWith("[MAP chunk-001] RETRY: AGY từ chối prompt")));
    assert(!run.calls.some((call) => call.kind === "phase_b" || call.kind === "series_plan"), "stopAfter=source_understanding runs Phase A only");
    // Per-chunk workspaces: distinct cwd for every concurrent process, reducer separate.
    const cwds = run.calls.map((call) => call.options.cwd);
    for (const call of run.calls.filter((item) => item.kind === "map")) assert(call.options.cwd.endsWith(path.join("map", run.chunkOf(call))));
    assert(run.calls.find((call) => call.kind === "reduce").options.cwd.endsWith(`${path.sep}reduce`));
    assert.strictEqual(new Set(cwds.filter((cwd) => cwd.includes(`${path.sep}map${path.sep}`))).size, 3);
    assert(!run.messages.some((message) => message.includes("viết kịch bản")), "map/reduce progress must not claim to write scripts");
    assert(run.messages.some((message) => /^\[MAP chunk-002\] OK · 1 video view · 4 events · cache written/.test(message)));
    assert(run.messages.some((message) => /^\[REDUCE\] OK · 0 video view/.test(message)));
    const diag = JSON.parse(await fs.readFile(path.join(fixture.root, "01-ANTIGRAVITY-RESULT", "map", "chunk-002", "diagnostics.json"), "utf8"));
    for (const field of ["chunkId", "runIds", "pids", "conversationIds", "cacheHit", "sourceStartSec", "sourceEndSec", "startedAt", "endedAt", "viewFileCount", "coverage", "agentTurns", "terminationReason", "timeoutMs", "streamInterrupted", "coverageRetryCount", "serializationRepair"]) {
      assert(field in diag, `chunk diagnostics include ${field}`);
    }
    assert.strictEqual(diag.terminationReason, "exit_ok");
    assert.strictEqual(diag.coverage.complete, true);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- model answers without view_file -> ONE strict coverage retry of that chunk only.
  {
    const fixture = await createPackage();
    const respond = (kind, prompt, call) => {
      if (kind === "map" && mapTaskFromPrompt(prompt).chunkId === "chunk-002" && !prompt.includes("MANDATORY: your FIRST tool action")) {
        const task = mapTaskFromPrompt(prompt);
        return { viewFiles: [], envelope: { artifacts: [{ filename: "chunk-understanding-chunk-002.json", script: buildChunkUnderstanding("chunk-002", task.startSec, task.endSec) }] } };
      }
      return happy(kind, prompt, call);
    };
    const run = await runPhaseA(fixture, respond);
    assert.ifError(run.error);
    const chunk2Calls = run.calls.filter((call) => run.chunkOf(call) === "chunk-002");
    assert.strictEqual(chunk2Calls.length, 2);
    assert(chunk2Calls[1].prompt.includes('MANDATORY: your FIRST tool action must be view_file("'));
    assert.strictEqual(run.su.map.chunks[1].coverageRetryCount, 1);
    assert.strictEqual(run.calls.filter((call) => run.chunkOf(call) === "chunk-001").length, 1);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- bare root object (no artifacts wrapper) and truncated output are accepted deterministically.
  {
    const fixture = await createPackage();
    const respond = (kind, prompt, call) => {
      if (kind === "map") {
        const task = mapTaskFromPrompt(prompt);
        const data = buildChunkUnderstanding(task.chunkId, task.startSec, task.endSec, 5);
        if (task.chunkId === "chunk-001") return { viewFiles: [task.proxy], rawResult: `\`\`\`json\n${JSON.stringify(data)}\n\`\`\`` };
        if (task.chunkId === "chunk-002") {
          const text = JSON.stringify(data, null, 1);
          const cut = text.indexOf('"eventId": "e5"');
          return { viewFiles: [task.proxy], rawResult: text.slice(0, cut + 30) };
        }
      }
      return happy(kind, prompt, call);
    };
    const run = await runPhaseA(fixture, respond);
    assert.ifError(run.error);
    assert.strictEqual(run.calls.filter((call) => call.kind === "map_repair").length, 0, "no AGY repair needed");
    assert.strictEqual(run.su.map.chunks[0].outputSource, "stream", "bare root object accepted");
    assert.strictEqual(run.su.map.chunks[1].serializationRepair, "local_truncation_repair");
    assert.strictEqual(run.su.map.chunks[1].eventCount, 4, "only complete events kept");
    const written = JSON.parse(await fs.readFile(path.join(fixture.root, "01-ANTIGRAVITY-RESULT", "map", "chunk-001", "chunk-understanding-chunk-001.json"), "utf8"));
    assert.strictEqual(written.chunkId, "chunk-001", "host writes the chunk result file itself");
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- stream interrupted + AGY print timeout: fail that chunk only, no same-conversation repair.
  {
    const fixture = await createPackage();
    const respond = (kind, prompt, call) => {
      if (kind === "map" && mapTaskFromPrompt(prompt).chunkId === "chunk-003") {
        return {
          viewFiles: [mapTaskFromPrompt(prompt).proxy],
          resultObject: { status: "ERROR", response: "", error: "The stream was interrupted. Please continue the task you were working on." },
          extraEvents: [{ event: "step_update", step_update: { step_index: 4, state: "DONE", step_type: "error_message" } }],
          stderr: "[agy] print timeout after 5m26s with turn in progress; returning partial output\n",
          exitCode: 1
        };
      }
      return happy(kind, prompt, call);
    };
    const run = await runPhaseA(fixture, respond);
    assert(run.error);
    const chunk3 = run.su.map.chunks[2];
    assert.strictEqual(chunk3.failureKind, "print_timeout");
    assert.strictEqual(chunk3.streamInterrupted, true);
    assert.strictEqual(chunk3.terminationReason, "agy_print_timeout", "AGY's own timeout, not a host kill");
    assert.strictEqual(run.calls.filter((call) => call.kind === "map_repair").length, 0);
    assert.deepStrictEqual(run.calls.filter((call) => call.kind === "map").map(run.chunkOf).sort(), ["chunk-001", "chunk-002", "chunk-003"]);
    assert(run.error.message.includes("stream was interrupted"));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- auth TTL guard: token shorter than map timeout + 120 s -> fail before ANY AGY process.
  {
    const fixture = await createPackage();
    const run = await runPhaseA(fixture, happy, { authProbe: async () => ({ expiresAt: new Date(Date.now() + 5 * 60000), expiredFlag: false }) });
    assert(run.error);
    assert.strictEqual(run.error.kind, "auth_ttl");
    assert.strictEqual(run.calls.length, 0, "no AGY process, no view_file");
    assert(run.error.message.includes("Mở Antigravity"));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
  // --- auth probe is reused across chunk processes (one `agy models`, not one per chunk).
  {
    const fixture = await createPackage();
    const run = await runPhaseA(fixture, happy);
    assert.ifError(run.error);
    assert.strictEqual(run.probes, 1, "one auth probe for 3 maps + reducer");
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  // --- reducer prompt rejected -> one retry without dialogue quotes, still text-only.
  {
    const fixture = await createPackage();
    let reduceCalls = 0;
    const respond = (kind, prompt, call) => {
      if (kind === "reduce") {
        reduceCalls += 1;
        if (reduceCalls === 1) {
          assert(prompt.includes("Open the door!"));
          return BLOCKED;
        }
        assert(!prompt.includes("Open the door!"), "retry drops verbatim dialogue");
      }
      return happy(kind, prompt, call);
    };
    const run = await runPhaseA(fixture, respond);
    assert.ifError(run.error);
    assert.strictEqual(reduceCalls, 2);
    assert.strictEqual(run.su.reduce.promptBlockRetryCount, 1);
    assert.strictEqual(run.su.reduce.videoViewFileCount, 0);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

function rollingCaptionTest() {
  // Real source SRT: rolling captions repeat the previous cue's tail.
  const srt = [
    "1\n00:00:03,640 --> 00:00:05,320\nYou need some help?",
    "2\n00:00:05,320 --> 00:00:09,150\nYou need some help? Yep.",
    "3\n00:00:09,160 --> 00:00:11,160\nI have a impact wrench. I'll do you one",
    "4\n00:00:11,160 --> 00:00:12,550\nI have a impact wrench. I'll do you one better. Give me 1 second. I'll come help",
    "5\n00:00:12,550 --> 00:00:12,560\nbetter. Give me 1 second. I'll come help",
    "6\n00:00:12,560 --> 00:00:14,070\nbetter. Give me 1 second. I'll come help you.",
    "7\n00:00:20,000 --> 00:00:21,000\nyou. Later line after a gap keeps its words."
  ].join("\n\n");
  const cues = Stage1.parseSrtForContext(srt);
  assert.strictEqual(cues.map((cue) => cue.text).join(" "), "You need some help? Yep. I have a impact wrench. I'll do you one better. Give me 1 second. I'll come help you. you. Later line after a gap keeps its words.");
}

(async () => {
  rollingCaptionTest();
  await processIsolationTests();
  await mapRecoveryTests();
  console.log("stage1ProcessIsolation tests passed (finish/timeout/cancel isolation, concurrent coverage, prompt block, coverage retry, bare/truncated JSON, stream interruption, auth TTL, reducer block)");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
