const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough, Writable } = require("stream");

const ManualAntigravityStage1Service = require("../electron/services/manualAntigravityStage1Service");
const { createPhaseAwareSpawn, defaultResponder } = require("./helpers/fakeAntigravity");

function buildScript(scriptId) {
  return {
    artifactType: "highlight_cut_script",
    schemaVersion: 1,
    scriptId,
    title: `Script ${scriptId}`,
    segments: [{
      id: `highlight_${scriptId}_001`,
      sourceStartSec: 0,
      sourceEndSec: 6,
      startSec: 0,
      endSec: 6,
      playbackSpeed: 1,
      audio_mode: "original_audio",
      voiceover_text: ""
    }]
  };
}

function createFakeSpawn(envelope, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 43210;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.stdin.on("finish", () => {
      process.nextTick(() => {
        child.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify(envelope) }));
        child.stdout.end();
        child.emit("close", 0);
      });
    });
    child.kill = () => child.emit("close", 1);
    return child;
  };
}

async function createPackage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-antigravity-"));
  const pass1Dir = path.join(root, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const promptPath = path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt");
  await fs.writeFile(promptPath, "Generate Script 1, Script 3 and Script 4.", "utf8");
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({ videoDurationSec: 20, scenes: [] }), "utf8");
  await fs.writeFile(path.join(pass1Dir, "analysis-proxy.mp4"), "proxy-bytes", "utf8");
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review",
    pass1UploadDir: pass1Dir,
    promptPath,
    cache: { sourceFingerprint: "fp-stage1-test", cacheDir: path.join(root, "source-cache") }
  }), "utf8");
  return { root, pass1Dir };
}

(async () => {
  const fixture = await createPackage();
  const beforeFiles = (await fs.readdir(fixture.pass1Dir)).sort();
  const calls = [];
  const envelope = {
    artifacts: [1, 3, 4].map((scriptId) => ({
      filename: `script-${scriptId}.json`,
      script: buildScript(scriptId)
    }))
  };
  const service = new ManualAntigravityStage1Service({
    antigravityCommand: "agy",
    antigravityArgs: "",
    antigravityModel: "test-model",
    antigravityTimeoutMs: 15000
  }, {
    spawn: createPhaseAwareSpawn({ calls, respond: defaultResponder() })
  });

  const progress = [];
  const result = await service.run({
    packageDir: fixture.root,
    onProgress: (payload) => progress.push(payload)
  });

  assert.strictEqual(result.validFiles.length, 3, "all three independent variants should be accepted");
  assert.deepStrictEqual(
    result.validFiles.map((filePath) => path.basename(filePath)),
    ["script-1.json", "script-3.json", "script-4.json"]
  );
  assert.strictEqual(path.basename(result.resultDir), "01-ANTIGRAVITY-RESULT");
  assert.deepStrictEqual(
    (await fs.readdir(fixture.pass1Dir)).sort(),
    beforeFiles,
    "Stage 1 input folder must stay unchanged (the understanding cache lives in the persistent source cache)"
  );
  assert.deepStrictEqual(calls.map((call) => call.kind), ["map", "map_serialize", "reduce", "phase_b"], "cold run: video-only MAP, same-conversation serialize, text-only reduce, then Phase B");
  assert.strictEqual(calls[3].options.cwd, result.resultDir, "Phase B must run in result folder");
  const printArg = calls[0].args.find((arg) => arg.startsWith("--print="));
  assert(printArg, "Antigravity prompt must be attached directly to --print");
  assert(printArg.includes('view_file("') && printArg.includes("analysis-proxy.mp4"), "the MAP view turn watches its proxy chunk");
  assert(printArg.includes("reply only VIEW_DONE"), "video turn must hand off immediately after completed view");
  assert(!printArg.includes("TRANSCRIPT"), "video turn carries no transcript payload");
  assert(!printArg.includes("source-transcript.srt"), "video turn must not open the raw SRT");
  assert(!printArg.includes("scene-manifest.json"), "video turn must not open the raw scene manifest");
  assert(!printArg.includes("01-gemini-highlight-scripts-prompt.txt"), "MAP stays editorial-neutral (no editorial prompt)");
  assert(!/hook.contract/i.test(printArg), "MAP gets no Hook Contract");
  const serializePrint = calls[1].args.find((arg) => arg.startsWith("--print="));
  assert(serializePrint.includes("SAME conversation"), "serializer must resume the watched conversation");
  assert(serializePrint.includes("-context.txt"), "serializer reads the compact chunk context");
  assert(serializePrint.includes("Do NOT call view_file on any video again."), "serializer must never rewatch video");
  assert(!/view_file\("[^"]+\.mp4"\)/.test(serializePrint), "serializer prompt has no video view_file");
  const reducePrint = calls[2].args.find((arg) => arg.startsWith("--print="));
  assert(reducePrint.includes("TEXT ONLY") && reducePrint.includes("Do NOT call view_file"), "reducer is text-only");
  assert(!/\.mp4/i.test(reducePrint), "reducer prompt carries no video path");
  const phaseBPrint = calls[3].args.find((arg) => arg.startsWith("--print="));
  assert(phaseBPrint.includes("HOST-VERIFIED INPUT ACCESS OVERRIDE"), "Phase B must override the STEP 0 proxy gate");
  assert(phaseBPrint.includes("Do NOT call view_file (or any other tool) on any .mp4 file"));
  assert(!/view_file\("[^"]+\.mp4"\)/.test(phaseBPrint), "Phase B prompt must not ask to view proxies");
  assert(!calls[0].args.includes("--print"), "bare --print would consume --mode as its prompt");
  assert(calls[0].args.indexOf("--mode") < calls[0].args.indexOf(printArg));
  assert(calls[0].args.includes("accept-edits"));
  assert(calls[0].args.includes("--dangerously-skip-permissions"), "headless Stage 1 needs non-interactive file inspection permission");
  assert(!calls[0].args.some((arg) => arg === "--json-schema" || arg.startsWith("--json-schema=")), "agy 1.1.22 JSON schema transport must stay disabled");
  assert(calls[0].args.includes("test-model"));
  assert(progress.some((item) => item.percent === 100));

  const schemaArgService = new ManualAntigravityStage1Service({
    antigravityCommand: "agy",
    antigravityArgs: "--json-schema legacy-schema.json --mode plan --effort medium"
  });
  const schemaSafeCommand = schemaArgService.buildCommand("test", "new-schema.json", fixture.pass1Dir);
  assert(!schemaSafeCommand.args.some((arg) => arg === "--json-schema" || arg.startsWith("--json-schema=")));
  assert(schemaSafeCommand.args.includes("medium"));
  assert(!schemaSafeCommand.args.includes("plan"));
  assert(schemaSafeCommand.args.includes("accept-edits"));

  // Test Antigravity model normalization and effort compatibility
  const flashHighService = new ManualAntigravityStage1Service({
    antigravityCommand: "agy",
    antigravityModel: "Gemini 3.8 Flash (High)"
  });
  const flashHighCmd = flashHighService.buildCommand("test", "schema.json", fixture.pass1Dir);
  assert(flashHighCmd.args.includes("gemini-3.8-flash-high"), "Display label should be normalized to canonical ID");
  assert(!flashHighCmd.args.includes("--effort"), "--effort must not be passed to model with fixed effort");

  const claudeService = new ManualAntigravityStage1Service({
    antigravityCommand: "agy",
    antigravityModel: "Claude Sonnet 4.6 (Thinking)"
  });
  const claudeCmd = claudeService.buildCommand("test", "schema.json", fixture.pass1Dir);
  assert(claudeCmd.args.includes("claude-sonnet-4-6"));
  assert(!claudeCmd.args.includes("--effort"), "--effort must not be passed to Claude models");

  const argsWithConflictService = new ManualAntigravityStage1Service({
    antigravityCommand: "agy",
    antigravityArgs: '--model "Gemini 3.8 Flash (High)" --effort high'
  });
  const conflictCmd = argsWithConflictService.buildCommand("test", "schema.json", fixture.pass1Dir);
  assert(conflictCmd.args.includes("gemini-3.8-flash-high"));
  assert(!conflictCmd.args.includes("--effort"), "--effort in args must be stripped if model does not support it");

  const defaultModelService = new ManualAntigravityStage1Service({
    antigravityCommand: "agy",
    antigravityModel: ""
  });
  const defaultCmd = defaultModelService.buildCommand("test", "schema.json", fixture.pass1Dir);
  assert(defaultCmd.args.includes("--effort"), "--effort high should be passed for default model");

  const parsed = ManualAntigravityStage1Service.findArtifactEnvelope(JSON.stringify({
    result: `\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``
  }));
  assert.strictEqual(parsed.artifacts.length, 3, "wrapped CLI output should be parsed");
  const storySpineArtifact = ManualAntigravityStage1Service.normalizeArtifact({
    filename: "script-1.json",
    script: {
      artifactType: "story_spine_edit_script",
      scriptId: 1,
      narrativeBeats: [{ beatId: "beat_001" }]
    }
  });
  assert.strictEqual(storySpineArtifact.script.narrativeBeats.length, 1);

  let killed = false;
  service.activeRuns.set("run-test", { runId: "run-test", label: "test", pid: null, child: { kill() { killed = true; } } });
  assert.strictEqual(service.cancel(), true, "active Antigravity process should be cancellable");
  assert.strictEqual(killed, true);

  // Test resolveAntigravityTimeoutMs
  const { resolveAntigravityTimeoutMs } = ManualAntigravityStage1Service;
  assert.strictEqual(resolveAntigravityTimeoutMs(300000), 900000, "legacy 300000 must auto-upgrade to 900000");
  assert.strictEqual(resolveAntigravityTimeoutMs(undefined), 900000, "default should be 900000");
  assert.strictEqual(resolveAntigravityTimeoutMs(1800000), 1800000, "custom higher timeout preserved");
  // Multi-chunk video adaptive timeout: 3 chunks = (3 * 480 + 1200) * 1000 = 2640000 ms (44 min)
  assert.strictEqual(
    resolveAntigravityTimeoutMs(900000, { proxyChunkCount: 3, sceneCount: 72 }),
    2640000,
    "3 proxy chunks should scale timeout to at least 2640000 ms"
  );
  // Large scene count: > 50 scenes (though 1 chunk now overrides to 1680000)
  assert.strictEqual(
    resolveAntigravityTimeoutMs(900000, { proxyChunkCount: 1, sceneCount: 60 }),
    1680000,
    "> 50 scenes should scale timeout to at least 1500000 ms (now 1680000 ms due to higher base chunk scaling)"
  );

  // Test command builder defaults to stream-json and uses adaptive timeout
  const adaptiveService = new ManualAntigravityStage1Service({
    antigravityCommand: "agy",
    antigravityModel: "gemini-3.8-flash-high"
  });
  const adaptiveCmd = adaptiveService.buildCommand("test", "schema.json", fixture.pass1Dir, {
    packageInfo: { proxyChunkCount: 3, sceneCount: 72 }
  });
  assert(adaptiveCmd.args.includes("stream-json"), "default output format should be stream-json");
  assert(adaptiveCmd.args.includes("--print-timeout"), "--print-timeout flag should be present");
  const timeoutArgIdx = adaptiveCmd.args.indexOf("--print-timeout");
  assert.strictEqual(adaptiveCmd.args[timeoutArgIdx + 1], "2640s", "print timeout should adapt to 2640s for 3 chunks");
  assert.strictEqual(adaptiveCmd.timeoutMs, 2640000);

  // Test stream-json live progress updates in runCli
  const streamEvents = [
    JSON.stringify({ event: "init", init: {} }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "view_file",
        tool_info: { name: "view_file", parameters: { AbsolutePath: "D:\\test\\analysis-proxy-chunk-001.mp4" } }
      }
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "agent_response"
      }
    }),
    JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: JSON.stringify({
          artifacts: [1, 3, 4].map((id) => ({ filename: `script-${id}.json`, script: buildScript(id) }))
        })
      }
    })
  ].join("\n");

  const streamProgress = [];
  const streamChildCalls = [];
  const fakeStreamSpawn = (command, args, options) => {
    streamChildCalls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 54321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.stdin.on("finish", () => {
      process.nextTick(() => {
        child.stdout.write(streamEvents + "\n");
        child.stdout.end();
        child.emit("close", 0);
      });
    });
    child.kill = () => child.emit("close", 1);
    return child;
  };

  const streamTestService = new ManualAntigravityStage1Service({
    antigravityCommand: "agy",
    antigravityModel: "gemini-3.8-flash-high",
    antigravityTimeoutMs: 60000
  }, { spawn: fakeStreamSpawn });

  const streamResult = await streamTestService.runCli({
    command: "agy",
    args: ["--output-format", "stream-json"],
    prompt: "test",
    cwd: fixture.root,
    timeoutMs: 60000,
    onProgress: (p) => streamProgress.push(p)
  });
  assert(streamResult.stdout.includes('"status":"SUCCESS"'));
  assert(streamProgress.some((p) => p.message && p.message.includes("analysis-proxy-chunk-001.mp4")), "should report proxy chunk progress");
  assert(streamProgress.some((p) => p.message && p.message.includes("Antigravity đang phân tích")), "should report reasoning progress");

  // --- Test getExpectedProxyList with chunk manifest & batch dirs ---
  const chunkFixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-proxy-chunk-test-"));
  const batch1 = path.join(chunkFixtureDir, "UPLOAD-BATCH-01");
  const batch2 = path.join(chunkFixtureDir, "UPLOAD-BATCH-02-FINAL");
  await fs.mkdir(batch1, { recursive: true });
  await fs.mkdir(batch2, { recursive: true });
  const chunk1Path = path.join(batch1, "analysis-proxy-chunk-001.mp4");
  const chunk2Path = path.join(batch2, "analysis-proxy-chunk-002.mp4");
  await fs.writeFile(chunk1Path, "dummy video 1", "utf8");
  await fs.writeFile(chunk2Path, "dummy video 2", "utf8");
  const manifestContent = {
    chunks: [
      { chunkId: "chunk_001", file: "analysis-proxy-chunk-001.mp4", uploadRelativePath: "UPLOAD-BATCH-01/analysis-proxy-chunk-001.mp4", sourceStartSec: 0, sourceEndSec: 240, durationSec: 240 },
      { chunkId: "chunk_002", file: "analysis-proxy-chunk-002.mp4", uploadRelativePath: "UPLOAD-BATCH-02-FINAL/analysis-proxy-chunk-002.mp4", sourceStartSec: 240, sourceEndSec: 480, durationSec: 240 }
    ]
  };
  await fs.writeFile(path.join(chunkFixtureDir, "proxy-chunks-manifest.json"), JSON.stringify(manifestContent), "utf8");

  const expectedChunks = await ManualAntigravityStage1Service.getExpectedProxyList(chunkFixtureDir);
  assert.strictEqual(expectedChunks.length, 2, "must discover both chunks from manifest");
  assert.strictEqual(expectedChunks[0].filename, "analysis-proxy-chunk-001.mp4");
  assert.strictEqual(expectedChunks[1].filename, "analysis-proxy-chunk-002.mp4");
  assert(expectedChunks[0].absolutePath.includes("UPLOAD-BATCH-01"));

  // --- Test validateVideoCoverage ---
  const emptyViewed = new Set();
  const cov0 = ManualAntigravityStage1Service.validateVideoCoverage(expectedChunks, emptyViewed);
  assert.strictEqual(cov0.coveragePercent, 0);
  assert.strictEqual(cov0.isComplete, false);
  assert.strictEqual(cov0.missingProxyFiles.length, 2);

  const partialViewed = new Set(["analysis-proxy-chunk-001.mp4"]);
  const cov50 = ManualAntigravityStage1Service.validateVideoCoverage(expectedChunks, partialViewed);
  assert.strictEqual(cov50.coveragePercent, 50);
  assert.strictEqual(cov50.isComplete, false);
  assert.deepStrictEqual(cov50.missingProxyFiles, ["analysis-proxy-chunk-002.mp4"]);

  const fullViewed = new Set(["analysis-proxy-chunk-001.mp4", "analysis-proxy-chunk-002.mp4"]);
  const cov100 = ManualAntigravityStage1Service.validateVideoCoverage(expectedChunks, fullViewed);
  assert.strictEqual(cov100.coveragePercent, 100);
  assert.strictEqual(cov100.isComplete, true);
  assert.strictEqual(cov100.missingProxyFiles.length, 0);

  // --- Test Telemetry matching in runCli: proxy-chunks-manifest.json vs mp4 ---
  const telemetryEvents = [
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "view_file",
        tool_info: { name: "view_file", parameters: { AbsolutePath: path.join(chunkFixtureDir, "proxy-chunks-manifest.json") } }
      }
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "view_file",
        tool_info: { name: "view_file", parameters: { AbsolutePath: chunk1Path } }
      }
    })
  ].join("\n");

  const telemetryProgress = [];
  const fakeTelemetrySpawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 99991;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.stdin.on("finish", () => {
      process.nextTick(() => {
        child.stdout.write(telemetryEvents + "\n");
        child.stdout.end();
        child.emit("close", 0);
      });
    });
    return child;
  };

  const teleService = new ManualAntigravityStage1Service({ antigravityCommand: "agy" }, { spawn: fakeTelemetrySpawn });
  const liveViewedSet = new Set();
  await teleService.runCli({
    command: "agy",
    args: [],
    prompt: "test",
    cwd: chunkFixtureDir,
    timeoutMs: 15000,
    expectedProxyList: expectedChunks,
    viewedProxySet: liveViewedSet,
    onProgress: (p) => telemetryProgress.push(p)
  });

  const manifestMsg = telemetryProgress.find((p) => p.message && p.message.includes("proxy-chunks-manifest.json"));
  assert(manifestMsg, "manifest progress must be reported");
  assert(manifestMsg.message.includes("scene manifest"), "manifest must be labeled as scene manifest");
  assert(!manifestMsg.message.includes("xem proxy video"), "manifest must NEVER be labeled as proxy video");

  const videoMsg = telemetryProgress.find((p) => p.message && p.message.includes("analysis-proxy-chunk-001.mp4"));
  assert(videoMsg, "video chunk progress must be reported");
  assert(videoMsg.message.includes("xem proxy video"), "video chunk must be labeled as proxy video");
  assert(liveViewedSet.has("analysis-proxy-chunk-001.mp4"), "chunk must be added to live viewed set");

  // --- Test auditTranscriptForViewedProxies ---
  const mockTranscriptPath = path.join(chunkFixtureDir, "transcript.jsonl");
  const transcriptContent = [
    JSON.stringify({ step_index: 1, tool_calls: [{ name: "view_file", args: { AbsolutePath: chunk1Path } }] }),
    JSON.stringify({ step_index: 2, tool_calls: [{ name: "view_file", args: { AbsolutePath: chunk2Path } }] })
  ].join("\n");
  await fs.writeFile(mockTranscriptPath, transcriptContent, "utf8");

  const auditedCoverage = await ManualAntigravityStage1Service.auditTranscriptForViewedProxies(
    null,
    expectedChunks,
    new Set(),
    mockTranscriptPath
  );
  assert.strictEqual(auditedCoverage.isComplete, true, "transcript audit should find both chunks");
  assert.strictEqual(auditedCoverage.coveragePercent, 100);

  // --- Test Hard Validation Gate in service.run when video chunks missing ---
  const gatePackageDir = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-gate-test-"));
  const gatePass1 = path.join(gatePackageDir, "01-GUI-GEMINI");
  await fs.mkdir(gatePass1, { recursive: true });
  await fs.writeFile(path.join(gatePass1, "01-gemini-highlight-scripts-prompt.txt"), "Generate Script 1.", "utf8");
  await fs.writeFile(path.join(gatePass1, "scene-manifest.json"), JSON.stringify({ videoDurationSec: 20, scenes: [] }), "utf8");
  await fs.writeFile(path.join(gatePass1, "analysis-proxy-chunk-001.mp4"), "dummy mp4", "utf8");
  await fs.writeFile(path.join(gatePass1, "proxy-chunks-manifest.json"), JSON.stringify({
    chunks: [{ chunkId: "chk1", file: "analysis-proxy-chunk-001.mp4" }]
  }), "utf8");
  await fs.writeFile(path.join(gatePackageDir, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review",
    pass1UploadDir: gatePass1,
    promptPath: path.join(gatePass1, "01-gemini-highlight-scripts-prompt.txt"),
    cache: { sourceFingerprint: "fp-gate-test", cacheDir: path.join(gatePackageDir, "source-cache") }
  }), "utf8");

  const missingVideoCalls = [];
  const fakeMissingVideoSpawn = (command, args, options) => {
    missingVideoCalls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 88881;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.stdin.on("finish", () => {
      process.nextTick(() => {
        // Return valid envelope BUT never call view_file on chunk-001.mp4!
        const resultEnvelope = {
          artifacts: [{ filename: "script-1.json", script: buildScript(1) }]
        };
        child.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: JSON.stringify(resultEnvelope) } }) + "\n");
        child.stdout.end();
        child.emit("close", 0);
      });
    });
    return child;
  };

  const gateService = new ManualAntigravityStage1Service({
    antigravityCommand: "agy",
    antigravityTimeoutMs: 15000
  }, { spawn: fakeMissingVideoSpawn });

  let gateFailed = false;
  try {
    await gateService.run({ packageDir: gatePackageDir });
  } catch (err) {
    gateFailed = true;
    assert(err.message.includes("[PHASE_A] FAILED") && err.message.includes("không gọi view_file") && err.message.includes("coverage retry=1"), `must throw hard gate error (${err.message})`);
    assert.strictEqual(missingVideoCalls.length, 2, "exactly one targeted coverage retry of that chunk");
    assert(err.message.includes("analysis-proxy-chunk-001.mp4"), "must name missing chunk");
  }
  assert.strictEqual(gateFailed, true, "run must fail when video chunks were not viewed");

  // --- Test Hard Validation Gate in service.run when video chunks ARE viewed (100% coverage) ---
  const fakeViewedSpawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 88882;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.stdin.on("finish", () => {
      process.nextTick(() => {
        const streamEvents = [
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: "view_file",
              tool_info: { name: "view_file", parameters: { AbsolutePath: path.join(gatePass1, "analysis-proxy-chunk-001.mp4") } }
            }
          }),
          JSON.stringify({
            event: "result",
            result: {
              status: "SUCCESS",
              response: JSON.stringify({
                artifacts: [{ filename: "script-1.json", script: buildScript(1) }]
              })
            }
          })
        ].join("\n");
        child.stdout.write(streamEvents + "\n");
        child.stdout.end();
        child.emit("close", 0);
      });
    });
    return child;
  };

  assert.strictEqual(
    (await fs.readdir(path.join(gatePackageDir, "source-cache")).catch(() => [])).length,
    0,
    "a failed coverage gate must never write a source-understanding cache"
  );
  void fakeViewedSpawn;
  const successGateCalls = [];
  const successGateService = new ManualAntigravityStage1Service({
    antigravityCommand: "agy",
    antigravityTimeoutMs: 15000
  }, { spawn: createPhaseAwareSpawn({ calls: successGateCalls, respond: defaultResponder({ scriptIds: [1] }) }) });

  const successResult = await successGateService.run({ packageDir: gatePackageDir });
  assert.strictEqual(successResult.coverage.isComplete, true, "coverage must be complete");
  assert.strictEqual(successResult.coverage.coveragePercent, 100);
  assert.deepStrictEqual(successResult.coverage.viewedProxyFiles, ["analysis-proxy-chunk-001.mp4"]);

  const runInfoRaw = await fs.readFile(path.join(gatePackageDir, "01-ANTIGRAVITY-RESULT", "antigravity-run-info.json"), "utf8");
  const runInfo = JSON.parse(runInfoRaw);
  assert.strictEqual(runInfo.directMultimodalCoverage, true);
  assert.strictEqual(runInfo.videoCoveragePercent, 100);
  assert.deepStrictEqual(runInfo.expectedProxyFiles, ["analysis-proxy-chunk-001.mp4"]);
  assert.deepStrictEqual(runInfo.viewedProxyFiles, ["analysis-proxy-chunk-001.mp4"]);
  assert.deepStrictEqual(runInfo.missingProxyFiles, []);

  // --- Test timeout check on stderr ---
  const fakeStderrTimeoutSpawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 77771;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.stdin.on("finish", () => {
      process.nextTick(() => {
        child.stderr.write("[agy] print timeout after 15m0s\n", "utf8", () => {
          child.emit("close", 0);
        });
      });
    });
    return child;
  };

  const timeoutService = new ManualAntigravityStage1Service({ antigravityCommand: "agy" }, { spawn: fakeStderrTimeoutSpawn });
  let timeoutFailed = false;
  try {
    await timeoutService.runCli({
      command: "agy",
      args: [],
      prompt: "test",
      cwd: chunkFixtureDir,
      timeoutMs: 15000
    });
  } catch (err) {
    timeoutFailed = true;
    assert(err.message.includes("Antigravity timed out after 15m0s"), "must detect timeout from stderr");
  }
  assert.strictEqual(timeoutFailed, true, "stderr timeout must be detected");

  await fs.rm(chunkFixtureDir, { recursive: true, force: true });
  await fs.rm(gatePackageDir, { recursive: true, force: true });
  await fs.rm(fixture.root, { recursive: true, force: true });
  console.log("manualAntigravityStage1Service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
