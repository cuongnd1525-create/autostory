const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough, Writable } = require("stream");

const ManualAntigravityStage1Service = require("../electron/services/manualAntigravityStage1Service");

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
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({ scenes: [] }), "utf8");
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review",
    pass1UploadDir: pass1Dir,
    promptPath
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
    spawn: createFakeSpawn(envelope, calls)
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
  assert.deepStrictEqual((await fs.readdir(fixture.pass1Dir)).sort(), beforeFiles, "Stage 1 input folder must stay unchanged");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.cwd, result.resultDir, "Antigravity may write only inside its dedicated result folder");
  const printArg = calls[0].args.find((arg) => arg.startsWith("--print="));
  assert(printArg, "Antigravity prompt must be attached directly to --print");
  assert(printArg.includes("STAGE_1_INPUT_FOLDER"));
  assert(printArg.includes("Do NOT stop after making an implementation plan"));
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
  service.activeChild = { kill() { killed = true; } };
  assert.strictEqual(service.cancel(), true, "active Antigravity process should be cancellable");
  assert.strictEqual(killed, true);

  await fs.rm(fixture.root, { recursive: true, force: true });
  console.log("manualAntigravityStage1Service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
