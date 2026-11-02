const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const Renderer = require("../electron/services/recap/recapRenderer");
const { createScopedToken, cancelToken } = require("../electron/services/cancelToken");
const externalError = () => Object.assign(new Error("Generic error in an external library"), {
  kind: "ffmpeg_exit", exitCode: 3752568763,
  stderr: "[libx264] pthread_create failed: Resource temporarily unavailable\nGeneric error in an external library",
  command: { binary: "ffmpeg", args: ["-i", "source.webm", "output.mp4"] }
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test("FFmpeg errors retain the opening cause and complete stderr instead of only its generic trailer", async () => {
  const renderer = new Renderer();
  const cause = "[libx264] pthread_create failed: Resource temporarily unavailable";
  const stderr = `${cause}\n${"progress line\n".repeat(1000)}Output file is empty\nConversion failed!`;
  let failure;
  await assert.rejects(renderer.runCommand(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(stderr)});process.exit(1)`]), error => {
    failure = error; assert.match(error.message, /pthread_create failed/);
    assert.equal(error.stderr, stderr); assert.equal(error.kind, "ffmpeg_exit");
    assert.equal(error.exitCode, 1); return true;
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-render-error-"));
  try {
    await renderer.recordRenderFailure(failure, { outputPath: path.join(root, "final.mp4"), stage: "final_segments", index: 258 });
    const log = await fs.readFile(failure.diagnosticPath, "utf8");
    assert.ok(log.includes(stderr)); assert.match(log, /"segment": 259/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a failed master cut waits for its siblings, retries only that cut and reuses all successful cached segments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-render-drain-"));
  try {
    const renderer = new Renderer(), attempts = [], warnings = [];
    let release, active = 0;
    const sibling = new Promise(resolve => { release = resolve; });
    const render = (index, safe) => renderer.segmentCache.render({ directory: path.join(root, "segments"),
      inputIdentity: { path: "source.webm", size: 123, mtimeMs: 1 }, ffmpegPath: "ffmpeg", args: ["-ss", String(index), "-crf", "22"],
      render: async file => {
        attempts.push({ index, safe });
        if (safe) assert.equal(active, 0, "the failed batch must be fully drained before serialized recovery");
        active++;
        try {
          if (index === 2 && !safe) await sibling;
          await fs.writeFile(file, Buffer.alloc(256, index + 1));
          if (index === 1 && !safe) throw externalError();
        } finally { active--; }
      } });
    const request = { count: 5, concurrency: 3, render, outputPath: path.join(root, "final.mp4"), stage: "final_segments",
      onProgress: event => warnings.push(event) };
    const work = renderer.renderVideoBatches(request);
    // Wait for the first failure, while its sibling deliberately remains active.
    while (!attempts.some(row => row.index === 1)) await tick();
    await tick(); assert.ok(!attempts.some(row => row.safe));
    release(); await work;
    assert.deepEqual(attempts.filter(row => row.safe), [{ index: 1, safe: true }]);
    assert.equal(warnings[0].segmentIndex, 2); assert.equal(warnings[0].retry, 1);
    assert.ok(warnings[0].diagnosticPath);
    const completedAttempts = attempts.length;
    await renderer.renderVideoBatches(request);
    assert.equal(attempts.length, completedAttempts, "fresh execution preserves the completed segment cache");
    assert.equal((await fs.readdir(path.join(root, "segments"))).filter(file => file.endsWith(".tmp.mp4")).length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("persistent library errors stop after one retry, save both diagnostics and never launch another batch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-render-bounded-"));
  try {
    const renderer = new Renderer(), calls = [];
    await assert.rejects(renderer.renderVideoBatches({ count: 5, concurrency: 3, stage: "final_segments", outputPath: path.join(root, "final.mp4"),
      render: async (index, safe) => { calls.push({ index, safe }); if (index === 1) throw externalError(); }
    }), error => { assert.match(error.message, /final_segments 2\/5/); assert.ok(error.diagnosticPath); return true; });
    assert.deepEqual(calls, [{ index: 0, safe: false }, { index: 1, safe: false }, { index: 2, safe: false }, { index: 1, safe: true }]);
    assert.equal((await fs.readdir(path.join(root, ".recap-render-errors"))).length, 2);
    const invalid = Object.assign(externalError(), { stderr: "Error opening encoder: width not divisible by 2. Invalid argument" });
    calls.length = 0;
    await assert.rejects(renderer.renderVideoBatches({ count: 1, concurrency: 1, stage: "final_mux", outputPath: path.join(root, "final.mp4"),
      render: async (_index, safe) => { calls.push(safe); throw invalid; } }));
    assert.deepEqual(calls, [false], "invalid dimensions, file paths, permissions and disk errors must not be retried as resource pressure");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("cancellation drains the batch and prevents recovery or launching another batch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-render-cancel-"));
  try {
    const renderer = new Renderer(), token = createScopedToken("render-test"), calls = [];
    let release, finished = false;
    const sibling = new Promise(resolve => { release = resolve; });
    const work = renderer.renderVideoBatches({ count: 4, concurrency: 2, stage: "final_segments", outputPath: path.join(root, "final.mp4"), cancelToken: token,
      render: async (index, safe) => { calls.push({ index, safe }); if (index === 0) { cancelToken(token, "User stopped export"); throw externalError(); }
        await sibling; finished = true; } });
    await tick(); release();
    await assert.rejects(work, /User stopped export/); assert.equal(finished, true);
    assert.equal(calls.length, 2); assert.ok(calls.every(row => !row.safe));
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("decoder, filters and encoder receive separate bounded budgets without changing crop, codec, CRF or timing", () => {
  const renderer = new Renderer(), args = ["-y", "-ss", "1525.2", "-t", "3.007", "-i", "source.webm",
    "-vf", "scale=1080:1920", "-c:v", "libx264", "-crf", "22", "out.mp4"];
  const original = [...args], normal = renderer.videoThreadArgs(args, 3), safe = renderer.videoThreadArgs(args, 3, true);
  assert.deepEqual(args, original);
  for (const command of [normal, safe]) {
    assert.ok(command.indexOf("-threads") < command.indexOf("-i"));
    assert.ok(command.indexOf("-threads:v") > command.indexOf("-i"));
    assert.equal(command[command.indexOf("-vf") + 1], "scale=1080:1920");
    assert.equal(command[command.indexOf("-crf") + 1], "22");
    assert.equal(command.at(-1), "out.mp4");
  }
  assert.equal(safe[safe.indexOf("-threads") + 1], "1");
  assert.equal(safe[safe.indexOf("-filter_threads") + 1], "1");
  assert.ok(Number(safe[safe.indexOf("-threads:v") + 1]) <= 2);
});
