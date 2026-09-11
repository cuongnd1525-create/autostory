const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const Service = require("../electron/services/autoStoryFastService");
const metrics = require("../electron/services/autoStoryRunMetrics");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-metrics-"));
  try {
    const summary = metrics.summarize([
      { scriptId: null, category: "planning", usd: 0.1 },
      { scriptId: 1, category: "editing", usd: 0.4 },
      { scriptId: 1, cached: true, usd: 0 },
      { scriptId: 2, category: "review", usd: null }
    ]);
    assert.equal(summary.totalUsd, 0.5); assert.equal(summary.unknownCalls, 1);
    assert.equal(summary.groups[1].cacheHits, 1); assert.equal(summary.groups.shared.totalUsd, 0.1);
    await metrics.append(root, { category: "editing", usd: 0.4, model: "pro" });
    assert.deepEqual(await metrics.estimate(root, "edit-1", "pro"), { usd: 0.4, samples: 1 });
    assert.equal(await metrics.estimate(root, "edit-1", "flash"), null);
    let synth = 0;
    const ffmpeg = { probeAudio: async file => {
      const value = await fs.readFile(file, "utf8");
      return { duration: value === "valid" ? 2 : 0 };
    } };
    const dubbing = { synthesizeFastDraftVoice: async ({ outputPath }) => { synth++; await fs.writeFile(outputPath, "valid"); } };
    const a = new Service({}, {}, { ffmpeg, dubbing, vertex: {} });
    const b = new Service({}, {}, { ffmpeg, dubbing, vertex: {} });
    a.sharedVoiceRoot = b.sharedVoiceRoot = path.join(root, "shared");
    const first = path.join(root, "project-a"), second = path.join(root, "project-b");
    await fs.mkdir(first); await fs.mkdir(second);
    const project = { voiceProvider: "kokoro", voiceId: "am_adam" };
    await a.measuredVoice(project, "Same words", first);
    await b.measuredVoice(project, "Same words", second);
    assert.equal(synth, 1, "second project reuses measured audio");
    await b.measuredVoice({ ...project, voiceId: "am_michael" }, "Same words", second);
    assert.equal(synth, 2, "voice change invalidates shared audio");
    const clone = { ...project, cloneSourceVoice: true };
    await a.measuredVoice(clone, "Clone", first); await b.measuredVoice(clone, "Clone", second);
    assert.equal(synth, 4, "unfingerprinted reference voices cannot share across projects");
    const c = new Service({}, {}, { ffmpeg, dubbing, vertex: {} }); c.sharedVoiceRoot = a.sharedVoiceRoot;
    const third = path.join(root, "project-c"); await fs.mkdir(third);
    for (const file of await fs.readdir(a.sharedVoiceRoot)) await fs.writeFile(path.join(a.sharedVoiceRoot, file), "corrupt");
    await c.measuredVoice(project, "Same words", third);
    assert.equal(synth, 5, "corrupt cache is regenerated");
    let calls = 0, saved;
    const tracking = new Service({}, { updateProject: async (_w, _id, patch) => { saved = patch.autoStoryCosts; } }, {
      vertex: { getModel: () => "pro", generateJsonFromFiles: async function () {
        calls++; this.lastUsage = { estimatedCostUsd: 0.2, model: "pro" }; return { valid: calls > 1 };
      } }
    });
    tracking.metricsRoot = path.join(root, "cost-test"); tracking.runWorkspace = root; tracking.runProjectId = "p";
    await fs.mkdir(tracking.metricsRoot);
    const validate = v => { if (!v.valid) throw new Error("invalid response"); };
    await tracking.stage(tracking.metricsRoot, "edit-1", {}, { taskType: "quality", prompt: "test" }, validate);
    assert.equal(saved.totalUsd, 0.4, "both charged responses counted even when first failed validation");
    await tracking.stage(tracking.metricsRoot, "edit-1", {}, { taskType: "quality", prompt: "test" }, validate);
    assert.equal(saved.totalUsd, 0.4); assert.equal(saved.groups[1].cacheHits, 1);
    assert.equal(calls, 2);
    console.log("Auto Story metrics and shared voice tests passed");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
