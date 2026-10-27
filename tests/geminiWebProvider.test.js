"use strict";

// Gemini Web (experimental): bridge process manager + transport + the Series
// chat session running over ONE linear Gemini Web conversation.
const assert = require("assert");
const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const GeminiWebBridgeProcess = require("../electron/services/geminiWebBridgeProcess");
const GeminiWebTransport = require("../electron/services/geminiWebTransport");
const VertexSeriesStage1Service = require("../electron/services/vertexSeriesStage1Service");
const ConfiguredAiWorkflowService = require("../electron/services/configuredAiWorkflowService");
const Serial = require("../electron/services/serializedGeminiWorkflowService");
const Bridge = require("../electron/services/seriesBlueprintBridge");

const DURATION = 300;
const SCENES = Array.from({ length: 30 }, (_, i) => ({ sceneId: `scene_${String(i + 1).padStart(4, "0")}`, startSec: i * 10, endSec: (i + 1) * 10 }));

async function createPackage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-web-series-"));
  const pass1 = path.join(root, "01-GUI-GEMINI");
  const batch1 = path.join(pass1, "UPLOAD-BATCH-01");
  const batch2 = path.join(pass1, "UPLOAD-BATCH-02-FINAL");
  const next = path.join(root, "02-SERIES-SEQUENTIAL");
  for (const dir of [batch1, batch2, next]) await fs.mkdir(dir, { recursive: true });
  const manifest = { sourceVideo: "trunk-stop.mp4", videoDurationSec: DURATION, scenes: SCENES };
  const prompt = "GEMINI SERIALIZED TRUE CRIME — STAGE 0 OF 4 — SERIES BLUEPRINT ONLY\nReturn exactly ONE JSON code block (save as series-blueprint.json).";
  await fs.writeFile(path.join(pass1, "scene-manifest.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(pass1, "01-gemini-highlight-scripts-prompt.txt"), prompt, "utf8");
  await fs.writeFile(path.join(batch1, "analysis-proxy-chunk-001.mp4"), "v1", "utf8");
  await fs.writeFile(path.join(batch2, "analysis-proxy-chunk-002.mp4"), "v2", "utf8");
  await fs.writeFile(path.join(batch2, "scene-manifest.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(batch2, "proxy-chunks-manifest.json"), JSON.stringify({ chunks: [{ file: "analysis-proxy-chunk-001.mp4", sourceStartSec: 0, sourceEndSec: 150 }, { file: "analysis-proxy-chunk-002.mp4", sourceStartSec: 150, sourceEndSec: 300 }] }), "utf8");
  await fs.writeFile(path.join(batch2, "source-transcript.srt"), "1\n00:00:10,000 --> 00:00:14,000\nStep out of the car right now!\n", "utf8");
  for (const [id, n] of [[1, 1], [3, 2], [4, 3]]) {
    await fs.writeFile(path.join(next, `script-${id}-NEXT-PROMPT.txt`), `GEMINI SERIALIZED TRUE CRIME — STAGE ${n} OF 3 — SCRIPT ${id} ONLY\nWrite ONLY script-${id}.json.`, "utf8");
  }
  const info = {
    workflow: "manual_gemini_draft_review", sequentialSeriesEnabled: true, sequentialSeriesProfile: "serialized_genz", sequentialSeriesSharedHook: false,
    seriesBlueprintPath: "", packageDir: root, pass1UploadDir: pass1, proxyUploadBatchDirs: [batch1, batch2],
    manifestPath: path.join(pass1, "scene-manifest.json"), proxyChunksManifestPath: path.join(batch2, "proxy-chunks-manifest.json"),
    promptPath: path.join(pass1, "01-gemini-highlight-scripts-prompt.txt"), sequentialSeriesNextStepsDir: next
  };
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify(info, null, 2), "utf8");
  return { root, manifest, info };
}

const beat = (beatId, kind, role, a, b, sceneId) => ({ beatId, kind, role, sourceStartSec: a, sourceEndSec: b, sceneIds: [sceneId], sourceProof: `proof ${beatId}`, mustInclude: true });
function blueprint(manifest, info) {
  const bp = Bridge.buildBlueprintFromSeriesPlan({
    profile: "serialized_genz", shared_top_banner_text: "KNOCKING FROM THE TRUNK", centralViewerQuestion: "Who is in the trunk?", verifiedCausalChain: ["Stop", "Rescue"],
    source_narrator_ranges: [],
    parts: [
      { scriptId: 1, partNumber: 1, scope: "The stop", hook: { kind: "dialogue_conflict", sourceStartSec: 10, sourceEndSec: 18, hookProof: "Step out!" }, cliffhanger: "Knocking",
        chapterBeats: [beat("p1_b1", "dialogue", "setup", 45, 60, "scene_0005"), beat("p1_b2", "action", "cliffhanger", 70, 85, "scene_0008")] },
      { scriptId: 3, partNumber: 2, scope: "Questioning", hook: { kind: "mixed", sourceStartSec: 110, sourceEndSec: 118, hookProof: "Whose voice?" }, cliffhanger: "Latch",
        chapterBeats: [beat("p2_b1", "dialogue", "escalation", 125, 140, "scene_0013"), beat("p2_b2", "visual", "reveal", 165, 185, "scene_0017")] },
      { scriptId: 4, partNumber: 3, scope: "Rescue", hook: { kind: "visual_reveal", sourceStartSec: 210, sourceEndSec: 218, hookProof: "Trunk opens" }, payoff: "Arrest",
        chapterBeats: [beat("p3_b1", "action", "climax", 225, 245, "scene_0023"), beat("p3_b2", "dialogue", "consequence", 260, 275, "scene_0027")] }
    ]
  }, { manifest, packageInfo: info });
  delete bp.derivedFrom;
  for (const part of bp.parts) {
    const a = Number(part.hook.sourceStartSec);
    part.hookAudition = { chosenIndex: 0, why: "w", candidates: [0, 1, 2].map((k) => ({ sourceStartSec: a + k * 3, sourceEndSec: a + k * 3 + 5, first3sSeen: "s", first3sHeard: "h", viewerQuestion: "q" })) };
  }
  return bp;
}
function slices(ranges) {
  const out = [];
  for (const [a, b, extra = {}] of ranges) {
    for (let t = a; t < b; t = Math.min(b, (Math.floor(t / 10) + 1) * 10)) {
      out.push({ sceneId: `scene_${String(Math.floor(t / 10) + 1).padStart(4, "0")}`, sourceStartSec: t, sourceEndSec: Math.min(b, (Math.floor(t / 10) + 1) * 10), playbackSpeed: 1, audio_mode: "original_audio", voiceover_text: "", transitionReason: "cut", ...extra });
    }
  }
  return out;
}
function script(id) {
  const base = { artifactType: "highlight_cut_script", schemaVersion: 1, scriptId: id };
  if (id === 1) return { ...base, segments: slices([[10, 18, { storyFunction: "hook" }], [40, 60, { beatId: "p1_b1" }], [60, 70], [70, 90, { beatId: "p1_b2" }], [90, 108]]) };
  if (id === 3) return { ...base, segments: slices([[110, 118, { storyFunction: "hook" }], [120, 140, { beatId: "p2_b1" }], [140, 160], [160, 188, { beatId: "p2_b2" }]]) };
  return { ...base, segments: slices([[210, 218, { storyFunction: "hook" }], [220, 250, { beatId: "p3_b1" }], [250, 260], [260, 280, { beatId: "p3_b2" }], [280, 288]]) };
}

/** Fake bridge HTTP server: answers like Gemini Web would, per newest message only. */
async function fakeBridge({ fixture, served = null, failWith = null, models = ["gemini-3.6-flash", "gemini-3.1-pro"] }) {
  const state = { requests: [], inFlight: 0, maxInFlight: 0, n: 0 };
  const good = blueprint(fixture.manifest, fixture.info);
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${state.token}`) return send(401, { error: { code: "unauthorized" } });
    if (req.url === "/bridge/v1/status") return send(200, { version: "cineviral-bridge-1", healthy: state.healthy !== false, models });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    state.requests.push(body);
    if (failWith) return send(failWith.status, { error: { code: failWith.code, message: "fake" } });
    state.inFlight += 1; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((r) => setTimeout(r, 10));
    state.inFlight -= 1;
    state.n += 1;
    const p = String(body.prompt);
    let answer;
    if (/Only confirm receipt/.test(p)) answer = "OK";
    else if (/SERIES BLUEPRINT ONLY|attached file turn-instructions/.test(p)) answer = "```json\n" + JSON.stringify(good) + "\n```";
    else if (/EDITOR REVIEW/.test(p)) answer = "{\"violations\":[]}";
    else { const id = Number((p.match(/SCRIPT (\d) ONLY/) || p.match(/script-(\d)\.json/) || [])[1]); answer = "```json\n" + JSON.stringify(script(id)) + "\n```"; }
    send(200, { text: answer, model: served || body.model, requestedModel: body.model, downgraded: Boolean(served && served !== body.model), conversation: { cid: "c_1", rid: `r_${state.n}`, rcid: `rc_${state.n}` }, elapsedMs: 12 });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.port = server.address().port;
  return { server, state };
}

function processFor(fake, settings = {}) {
  // spawnImpl: no real exe; the fake server plays the bridge on the port the manager chose.
  const manager = new GeminiWebBridgeProcess({
    getSettings: () => ({ geminiWebCookiesEnc: "x", ...settings }),
    decryptCookies: () => "SID=a; __Secure-1PSID=p; __Secure-1PSIDTS=t",
    spawnImpl: (_bin, _args, options) => {
      fake.state.token = options.env.BRIDGE_TOKEN;
      fake.state.env = options.env;
      const child = new EventEmitter();
      child.pid = 0; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      return child;
    }
  });
  manager.binaryPath = () => __filename; // exists
  const realStart = manager.start.bind(manager);
  manager.start = async (args) => {
    const result = await realStart({ ...args, timeoutMs: 3000 }).catch((error) => { throw error; });
    return result;
  };
  // Route the manager to the fake server's port.
  const originalFetch = manager.fetchImpl;
  manager.fetchImpl = (url, init) => originalFetch(String(url).replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${fake.state.port}`), init);
  return manager;
}

function transportFor(fake, manager, settings = {}) {
  return new GeminiWebTransport(settings, { bridge: manager, fetchImpl: (url, init) => fetch(String(url).replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${fake.state.port}`), init) });
}

(async () => {
  // Cookie header validation.
  assert.strictEqual(GeminiWebBridgeProcess.normalizeCookieHeader("Cookie: NID=1; __Secure-1PSID=a;\n __Secure-1PSIDTS=b"), "NID=1; __Secure-1PSID=a; __Secure-1PSIDTS=b");
  assert.throws(() => GeminiWebBridgeProcess.normalizeCookieHeader("NID=1; __Secure-1PSID=a"), /__Secure-1PSIDTS/);

  // Series session over ONE linear Gemini Web conversation.
  {
    const fixture = await createPackage();
    const fake = await fakeBridge({ fixture });
    const manager = processFor(fake);
    const transport = transportFor(fake, manager, { geminiWebMaxFilesPerMessage: 2 });
    const messages = [];
    const service = new VertexSeriesStage1Service({ vertexSeriesContextCache: true, vertexSeriesPartMode: "parallel" }, { vertex: transport, tag: "GEMINI_WEB" });
    const result = await service.run({ packageDir: fixture.root, onProgress: (item) => messages.push(String(item.message || "")) });
    const reqs = fake.state.requests;
    assert.strictEqual(fake.state.env.HOST, "127.0.0.1", "bridge bound to loopback");
    assert(fake.state.env.BRIDGE_TOKEN.length >= 32, "random per-launch token");
    assert.strictEqual(fake.state.env.GEMINI_COOKIES, "SID=a; __Secure-1PSID=p; __Secure-1PSIDTS=t");
    // Upload batches: 2 videos + 3 text attachments, max 2 files per message.
    const uploads = reqs.filter((r) => /UPLOAD BATCH/.test(r.prompt));
    assert.strictEqual(uploads.length, 3, "5 files / 2 per message");
    assert.strictEqual(uploads[0].conversation, null, "first message opens the conversation");
    assert(uploads.slice(0, 2).every((r) => /Only confirm receipt/.test(r.prompt)));
    assert(/SERIES BLUEPRINT ONLY/.test(uploads[2].prompt), "the task rides the last batch");
    const files = uploads.flatMap((r) => r.files.map((f) => f.path));
    assert.deepStrictEqual(files.map((f) => path.basename(f)), ["analysis-proxy-chunk-001.mp4", "analysis-proxy-chunk-002.mp4", "source-transcript.srt.txt", "scene-manifest.json", "proxy-chunks-manifest.json"]);
    for (const f of files) await fs.access(f);
    assert(/absolute SOURCE 150\.000-300\.000s/.test(uploads[0].prompt + uploads[1].prompt), "chunk labels travel with the files");
    // Linear continuation: every later message replies to the previous answer, newest turn only, no re-upload.
    for (let i = 1; i < reqs.length; i += 1) {
      assert.strictEqual(reqs[i].conversation?.rid, `r_${i}`, `message ${i + 1} continues after answer ${i}`);
    }
    const later = reqs.slice(uploads.length);
    assert(later.every((r) => r.files.length === 0), "videos uploaded once");
    assert(later.every((r) => !/SERIES BLUEPRINT ONLY/.test(r.prompt)), "history is not resent");
    assert.strictEqual(fake.state.maxInFlight, 1, "one message at a time; Parts forced sequential");
    assert(later.some((r) => /EDITOR REVIEW of the series-blueprint/.test(r.prompt)));
    assert(later.some((r) => /SCRIPT 3 ONLY/.test(r.prompt)));
    // Result is comparable with Vertex runs.
    assert.strictEqual(result.provider, "gemini_web");
    assert.strictEqual(result.label, "Gemini Web");
    assert.strictEqual(result.model, "gemini-3.1-pro", "auto-picked the account's Pro model");
    assert.strictEqual(result.partMode, "sequential");
    assert.strictEqual(result.validFiles.length, 3);
    const info = JSON.parse(await fs.readFile(path.join(fixture.root, "01-CONFIGURED-AI-RESULT", "configured-ai-run-info.json"), "utf8"));
    assert.strictEqual(info.architecture, "gemini_web_series_session");
    assert.strictEqual(info.usage.estimatedCostUsd, 0);
    assert(info.calls.length >= 7 && info.timings.totalMs > 0);
    const locked = JSON.parse(await fs.readFile(path.join(fixture.root, "series-blueprint.json"), "utf8"));
    for (const file of result.validFiles) assert.deepStrictEqual(Serial.validateScriptAgainstBlueprint(JSON.parse(await fs.readFile(file, "utf8")), locked).errors, []);
    assert(messages.some((m) => m.startsWith("[GEMINI_WEB] DONE")), messages.slice(-3).join("\n"));
    fake.server.close();
  }

  // A quota downgrade stops the run (no silent quality comparison against Flash).
  {
    const fixture = await createPackage();
    const fake = await fakeBridge({ fixture, served: "gemini-3.6-flash" });
    const manager = processFor(fake);
    const service = new VertexSeriesStage1Service({ vertexSeriesContextCache: true }, { vertex: transportFor(fake, manager), tag: "GEMINI_WEB" });
    await assert.rejects(service.run({ packageDir: fixture.root }), (error) => error.kind === "model_downgraded");
    fake.server.close();
  }

  // Rate limit / expired login are never retried.
  for (const failWith of [{ status: 429, code: "rate_limited" }, { status: 401, code: "auth_expired" }]) {
    const fixture = await createPackage();
    const fake = await fakeBridge({ fixture, failWith });
    const manager = processFor(fake);
    const service = new VertexSeriesStage1Service({ vertexSeriesContextCache: true, vertexSeriesHttpRetries: 2 }, { vertex: transportFor(fake, manager), tag: "GEMINI_WEB", sleep: async () => {} });
    await assert.rejects(service.run({ packageDir: fixture.root }), (error) => error.kind === failWith.code);
    assert.strictEqual(fake.state.requests.length, 1, `${failWith.code} not retried`);
    fake.server.close();
  }

  // Long turns travel as an attached .txt (Gemini Web turns pastes into files too).
  {
    const fixture = await createPackage();
    const fake = await fakeBridge({ fixture });
    const manager = processFor(fake);
    const transport = transportFor(fake, manager, { geminiWebMaxPromptChars: 4000 });
    await transport.createCacheFromParts({ parts: [] });
    await transport.generateContent({ contents: [{ role: "user", parts: [{ text: "SERIES BLUEPRINT ONLY " + "x".repeat(9000) }] }], model: "gemini-3.1-pro" });
    const last = fake.state.requests.at(-1);
    assert(/attached file turn-instructions-/.test(last.prompt) && last.prompt.length < 2000);
    assert.strictEqual((await fs.readFile(last.files.at(-1).path, "utf8")).length, 9022);
    fake.server.close();
  }

  // Live 2026-10-21: last upload batch already full (10/10 files) + a long Stage 0 prompt
  // -> the instructions file goes in its own message; files are always sent as {path}.
  {
    const fixture = await createPackage();
    const fake = await fakeBridge({ fixture });
    const manager = processFor(fake);
    const transport = transportFor(fake, manager, { geminiWebMaxFilesPerMessage: 2, geminiWebMaxPromptChars: 4000 });
    const v1 = path.join(fixture.root, "01-GUI-GEMINI", "UPLOAD-BATCH-01", "analysis-proxy-chunk-001.mp4");
    const v2 = path.join(fixture.root, "01-GUI-GEMINI", "UPLOAD-BATCH-02-FINAL", "analysis-proxy-chunk-002.mp4");
    await transport.createCacheFromParts({ parts: [{ text: "UPLOADED FILES" }, { text: "FILE a:" }, await transport.buildVideoPart(v1), { text: "FILE b:" }, await transport.buildVideoPart(v2)] });
    await transport.generateContent({ contents: [{ role: "user", parts: [{ text: "SERIES BLUEPRINT ONLY " + "y".repeat(9000) }] }], model: "gemini-3.1-pro" });
    const [first, second] = fake.state.requests;
    assert.strictEqual(fake.state.requests.length, 2);
    // The plan keeps room for the instructions file in the final message (like the manual FINAL batch).
    assert.deepStrictEqual(first.files.map((f) => path.basename(f.path)), ["analysis-proxy-chunk-001.mp4"]);
    assert(/Only confirm receipt/.test(first.prompt));
    assert.strictEqual(second.conversation.rid, "r_1");
    assert.deepStrictEqual(second.files.map((f) => typeof f), ["object", "object"]);
    assert.strictEqual(path.basename(second.files[0].path), "analysis-proxy-chunk-002.mp4");
    assert(/turn-instructions-/.test(second.files[1].path) && /attached file turn-instructions-/.test(second.prompt));
    fake.server.close();
  }

  // Live 2026-10-21: the first turn (113 MB upload + watching the video) took 5 min 7 s and
  // Node's fetch gave up at 300 s ("fetch failed"). Bridge calls use node:http with our own timeout.
  {
    const slow = http.createServer((req, res) => setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{\"ok\":1}"); }, 150));
    await new Promise((r) => slow.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${slow.address().port}/x`;
    const okResponse = await GeminiWebTransport.localFetch(url, { method: "POST", body: "{}", timeoutMs: 5000 });
    assert.strictEqual((await okResponse.json()).ok, 1);
    await assert.rejects(GeminiWebTransport.localFetch(url, { timeoutMs: 30 }), (error) => error.code === "timeout");
    const controller = new AbortController();
    const pending = GeminiWebTransport.localFetch(url, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === "AbortError");
    assert(/localFetch/.test(String(new GeminiWebTransport({}, { bridge: {} }).fetchImpl.name)), "transport uses localFetch by default");
    slow.close();
  }

  // Live 2026-10-21: the upload turn got Gemini's canned refusal (91 chars) and the tool took it as "OK".
  {
    const fixture = await createPackage();
    const fake = await fakeBridge({ fixture });
    const manager = processFor(fake);
    const transport = transportFor(fake, manager, { geminiWebMaxFilesPerMessage: 1, geminiWebMaxPromptChars: 4000 });
    const v1 = path.join(fixture.root, "01-GUI-GEMINI", "UPLOAD-BATCH-01", "analysis-proxy-chunk-001.mp4");
    const v2 = path.join(fixture.root, "01-GUI-GEMINI", "UPLOAD-BATCH-02-FINAL", "analysis-proxy-chunk-002.mp4");
    await transport.createCacheFromParts({ parts: [{ text: "UPLOADED FILES" }, { text: "FILE a:" }, await transport.buildVideoPart(v1), { text: "FILE b:" }, await transport.buildVideoPart(v2)] });
    const realPost = transport.post.bind(transport);
    transport.post = async (body, signal) => ({ ...(await realPost(body, signal)), text: "I'm having a hard time fulfilling your request. Can I help you with something else instead?" });
    await assert.rejects(transport.generateContent({ contents: [{ role: "user", parts: [{ text: "SERIES BLUEPRINT ONLY" }] }], model: "gemini-3.1-pro" }), (error) => error.kind === "gemini_app_refused_upload");
    assert.strictEqual(fake.state.requests.length, 1, "stops at the refused upload turn");
    transport.post = async (body, signal) => ({ ...(await realPost(body, signal)), text: "Tôi không thể giúp bạn việc đó, vì tôi chỉ là một mô hình ngôn ngữ nên không thể hiểu điều đó." });
    await assert.rejects(transport.generateContent({ contents: [{ role: "user", parts: [{ text: "Review of this series-blueprint.json" }] }], model: "gemini-3.1-pro" }), (error) => error.kind === "gemini_app_error");
    fake.server.close();
  }

  // Live 2026-10-21: 6 proxy chunks in ONE message -> "I'm having a hard time fulfilling your request".
  // Upload plan = the manual UPLOAD-BATCH split: chunk 1 alone, then chunks 2-6 + texts + the prompt file.
  {
    const entry = (file) => ({ file });
    const real = [1, 2, 3, 4, 5, 6].map((n) => entry(`analysis-proxy-chunk-00${n}.mp4`))
      .concat(["scene-manifest.json", "proxy-chunks-manifest.json", "source-transcript.srt.txt", "action-candidates.json"].map(entry));
    const plan = GeminiWebTransport.planBatches(real, { maxFiles: 10, maxVideos: 5, reserveForPrompt: 1 }).map((batch) => batch.map((e) => e.file));
    assert.deepStrictEqual(plan, [
      ["analysis-proxy-chunk-001.mp4"],
      ["analysis-proxy-chunk-002.mp4", "analysis-proxy-chunk-003.mp4", "analysis-proxy-chunk-004.mp4", "analysis-proxy-chunk-005.mp4", "analysis-proxy-chunk-006.mp4", "scene-manifest.json", "proxy-chunks-manifest.json", "source-transcript.srt.txt", "action-candidates.json"]
    ]);
    for (const batch of GeminiWebTransport.planBatches(real.concat(real.slice(0, 6).map((e, i) => entry(`extra-${i}.mp4`))), { maxFiles: 10, maxVideos: 5, reserveForPrompt: 1 })) {
      assert(batch.filter((e) => /\.mp4$/.test(e.file)).length <= 5 && batch.length <= 10);
    }
  }

  // Unhealthy login -> clear auth error, bridge stopped.
  {
    const fixture = await createPackage();
    const fake = await fakeBridge({ fixture });
    fake.state.healthy = false;
    const manager = processFor(fake);
    await assert.rejects(manager.ensureStarted({ timeoutMs: 1500 }), (error) => error.code === "auth_expired");
    assert.strictEqual(manager.endpoint, null);
    fake.server.close();
  }

  // Routing: gemini_web needs a saved cookie; with one, GĐ1 runs the Series session tagged GEMINI_WEB.
  {
    await assert.rejects(new ConfiguredAiWorkflowService({ aiProvider: "gemini_web" }).runStage1({ packageDir: "x" }), /chưa có cookie/);
    const fixture = await createPackage();
    const fake = await fakeBridge({ fixture });
    const manager = processFor(fake);
    // the workflow builds its own transport; route its fetch to the fake through the manager's endpoint
    manager.ensureStarted = (async (orig) => { const r = await orig(); return { ...r, endpoint: `http://127.0.0.1:${fake.state.port}` }; }).bind(null, manager.ensureStarted.bind(manager));
    const messages = [];
    const workflow = new ConfiguredAiWorkflowService({ aiProvider: "gemini_web", geminiWebCookiesEnc: "x" }, null, { geminiWebBridge: manager });
    const result = await workflow.runStage1({ packageDir: fixture.root, onProgress: (item) => messages.push(String(item.message || "")) });
    assert.strictEqual(result.provider, "gemini_web");
    assert(messages.some((m) => m.startsWith("[GEMINI_WEB] START")));
    fake.server.close();
  }

  console.log("geminiWebProvider tests passed (cookie check, loopback+token bridge, one linear conversation, upload batches, no re-upload, downgrade stop, no retry on 429/auth, long turns as file, routing)");
})().catch((error) => { console.error(error); process.exit(1); });
