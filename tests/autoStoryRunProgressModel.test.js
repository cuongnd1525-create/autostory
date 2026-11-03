"use strict";
// Weighted phase model of an Auto Story run (electron/services/autoStoryRunProgress.js) and its
// wiring in autoStoryRunner. Run: node tests/autoStoryRunProgressModel.test.js
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const RunProgress = require("../electron/services/autoStoryRunProgress");
const Runner = require("../electron/services/autoStoryRunner");

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t, at: (sec) => { c.t = start + sec * 1000; } };
  return c;
}

let passed = 0;
const ok = async (name, fn) => { await fn(); passed += 1; console.log("  ok -", name); };

(async () => {
  console.log("Auto Story run progress model");

  // Replay of the real V4 run "1011_01" (549.7 s source, 1 script, 1343 s): the percent must track
  // the elapsed share of the run, not jump to the end of a phase.
  await ok("V4 real-run replay: percent follows elapsed time within 6 points at every checkpoint", async () => {
    const c = clock();
    const p = new RunProgress({ engine: "v4", outputs: 1, generate: true, sourceSec: 549.7, now: c.now });
    const total = 1343;
    const seen = [];
    const at = (sec, event) => { c.at(sec); const value = p.event(event || {}); seen.push(value); return value; };
    const near = (value, sec, label) => assert.ok(Math.abs(value - (sec / total) * 100) <= 6, `${label}: ${value}% vs ${(sec / total * 100).toFixed(1)}% elapsed`);
    at(0, { stage: "preprocess" });
    near(at(10, { stage: "understand" }), 10, "understand starts");
    // ffmpeg reports source seconds done; 570 s of wall time for the 549.7 s source.
    for (let s = 15; s <= 585; s += 57) near(at(s, { stage: "source_media", heartbeat: true, mediaDoneSec: Math.min(549.7, (s - 15) / 570 * 549.7), mediaTotalSec: 549.7 }), s, `media ${s}s`);
    at(585, { stage: "source_media", heartbeat: true, mediaDoneSec: 549.7, mediaTotalSec: 549.7 });
    near(at(610, { stage: "v3-source-model", heartbeat: true }), 610, "source model request");
    near(at(630, { stage: "design" }), 630, "Story Scope starts");
    near(at(720, { stage: "v5-editorial-director-1", heartbeat: true }), 720, "director request");
    near(at(818, { stage: "editing" }), 818, "scripts start");
    near(at(1000, { stage: "editing", heartbeat: true }), 1000, "scripting");
    c.at(1170); p.scriptReady(); p.generationDone(); p.renderStart(1);
    near(p.percent(), 1170, "script ready");
    near(at(1215, { scriptId: 1, step: "draft", percent: 50 }), 1215, "draft render 50%");
    c.at(1260); p.reviewStart(1);
    near(p.percent(), 1260, "draft ready");
    near(at(1300, { stage: "draft_audit", scriptId: 1, heartbeat: true }), 1300, "review");
    assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1] - 0.05), `monotonic: ${seen.join(",")}`);
    c.at(1343); p.scriptDone(1);
    assert.equal(p.percent(), 99, "99 until the runner's final event");
  });

  await ok("source model cache HIT: the skipped media/AI work counts as done when Story Scope starts", async () => {
    const c = clock();
    const p = new RunProgress({ engine: "v4", outputs: 1, generate: true, sourceSec: 549.7, now: c.now });
    p.event({ stage: "preprocess" });
    c.at(8); p.event({ stage: "understand" });
    c.at(9); const after = p.event({ stage: "design" });
    const share = (15 + 50 + 549.7) / (15 + 50 + 549.7 + 190 + 350 + 90 + 100) * 100;
    assert.ok(Math.abs(after - share) < 1, `${after} ≈ ${share.toFixed(1)}`);
  });

  await ok("time-based phases hold below 95% of their weight until they really end", async () => {
    const c = clock();
    const p = new RunProgress({ engine: "v3", outputs: 1, generate: true, sourceSec: 0, now: c.now });
    p.event({ stage: "design" });
    c.at(10_000);
    const stuck = p.percent();
    const designEnd = (15 + 50 + 60 * 0.95) / (15 + 50 + 60 + 90 + 90 + 100) * 100;
    assert.ok(Math.abs(stuck - designEnd) < 0.2, `${stuck} vs ${designEnd}`);
    p.event({ stage: "editing" });
    assert.ok(p.percent() > stuck);
  });

  await ok("two scripts: production of script 1 overlaps generation of script 2; draft render uses the real render percent of that script only", async () => {
    const c = clock();
    const p = new RunProgress({ engine: "v4", outputs: 2, generate: true, sourceSec: 100, now: c.now });
    p.event({ stage: "editing" });
    c.at(1); p.scriptReady(); p.renderStart(1);
    const before = p.percent();
    p.event({ scriptId: 1, step: "draft", percent: 80 });
    p.event({ scriptId: 2, step: "draft", percent: 100 }); // script 2 not rendering: ignored
    const est = RunProgress.DEFAULTS.v4;
    const total = est.preprocess + est.understandAi + 100 * est.mediaPerSourceSec + est.design + 2 * est.script + 2 * (est.render + est.review);
    assert.ok(Math.abs(p.percent() - before - (est.render * 0.8) / total * 100) < 0.2);
    p.event({ scriptId: 1, step: "highlight", percent: 100 }); // import step does not move the render
    assert.ok(Math.abs(p.percent() - before - (est.render * 0.8) / total * 100) < 0.2);
  });

  await ok("generation produced fewer scripts than planned: their production weight is dropped", async () => {
    const c = clock();
    const p = new RunProgress({ engine: "v3", outputs: 3, generate: true, now: c.now });
    p.event({ stage: "editing" }); c.at(5); p.scriptReady(); p.generationDone();
    const three = p.percent();
    p.setProductionCount(1);
    assert.ok(p.percent() > three);
    assert.equal(p.slots.length, 1);
  });

  await ok("history: measured durations are blended (EWMA) and drive the next run's weights", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-progress-history-"));
    const c = clock();
    const p = new RunProgress({ engine: "v4", outputs: 1, generate: true, sourceSec: 100, now: c.now });
    p.event({ stage: "preprocess" });
    c.at(5); p.event({ stage: "understand" });
    c.at(6); p.event({ stage: "source_media", mediaDoneSec: 0, mediaTotalSec: 100 });
    c.at(206); p.event({ stage: "source_media", mediaDoneSec: 100, mediaTotalSec: 100 });
    c.at(236); p.event({ stage: "design" });
    c.at(536); p.event({ stage: "editing" });
    c.at(636); p.scriptReady(); p.generationDone(); p.renderStart(1);
    c.at(696); p.reviewStart(1);
    c.at(816); p.scriptDone(1);
    const measured = p.measured();
    assert.deepEqual(Object.keys(measured).sort(), ["design", "mediaPerSourceSec", "preprocess", "render", "review", "script", "understandAi"]);
    assert.equal(measured.mediaPerSourceSec, 2);
    assert.equal(measured.understandAi, 31);
    const saved = p.saveHistory(dir);
    const d = RunProgress.DEFAULTS.v4;
    assert.equal(saved.v4.design, Math.round((d.design * 0.6 + 300 * 0.4) * 1000) / 1000);
    assert.deepEqual(RunProgress.loadHistory(dir).v4, saved.v4, "written to <workspace>/.cineviral/auto-story-progress.json");
    const next = new RunProgress({ engine: "v4", outputs: 1, generate: true, sourceSec: 100, history: RunProgress.loadHistory(dir) });
    assert.equal(next.expected("design"), saved.v4.design);
    // A cache hit (understand < 3 s) teaches nothing about the source model.
    const hit = new RunProgress({ engine: "v4", outputs: 1, generate: true, sourceSec: 100, now: c.now });
    c.at(0); hit.event({ stage: "understand" }); c.at(1); hit.event({ stage: "design" });
    assert.ok(!("understandAi" in hit.measured()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ok("engine of the project: V2 / V3 / V4 (V4 after the run is contract 3 + scope_media_director)", async () => {
    assert.equal(RunProgress.engineOf({}), "v2");
    assert.equal(RunProgress.engineOf({ autoStoryContractVersion: 3 }), "v3");
    assert.equal(RunProgress.engineOf({ autoStoryContractVersion: 4 }), "v4");
    assert.equal(RunProgress.engineOf({ autoStoryContractVersion: 3, autoStoryEditorialArchitecture: "scope_media_director" }), "v4");
  });

  await ok("runner: one monotonic percent for the whole run, 100 only on the final event, render percent attributed to its script", async () => {
    const analysisDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-progress-runner-"));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "run-progress-ws-"));
    const variant = { scriptId: 1, id: "variant_01", sourceJsonPath: "/x/script-1.json", segments: [{ id: "s1" }], artifacts: {} };
    let project = { id: "p1", autoStoryContractVersion: 4, sourceVideoPath: "/x/source.mp4", analysis: { highlightVariants: [] },
      autoStoryConfig: { outputCount: 1, editorialArchitecture: "scope_media_director" }, autoStoryState: {} };
    const store = {
      getProject: async () => project,
      getProjectPaths: () => ({ analysisDir, rootDir: analysisDir }),
      updateProject: async (_w, _p, patch) => { project = { ...project, ...patch }; return project; },
      writeText: async () => {}
    };
    const dubbing = {
      importHighlightCutProject: async ({ onProgress }) => { onProgress?.({ step: "highlight", percent: 100, message: "imported" }); project = { ...project, analysis: { highlightVariants: [variant], activeVariantId: "variant_01", segments: variant.segments } }; return project; },
      renderHighlightFastDraft: async ({ onProgress }) => { for (const percent of [10, 50, 90, 100]) onProgress?.({ step: "draft", percent, message: `draft ${percent}` }); }
    };
    require("../electron/services/dubbingService").canReuseAutoStoryDraft = async () => false;
    const service = {
      vertex: { dispatcher: { close: async () => {} } },
      ffmpeg: { probeVideo: async () => ({ duration: 120 }) },
      recoverScriptIds: async () => project,
      run: async ({ onProgress, onScriptReady }) => {
        for (const [stage, percent] of [["preprocess", 1], ["understand", 8], ["design", 30], ["editing", 45]]) onProgress({ stage, percent, message: stage });
        onProgress({ stage: "v5-editorial-director-1", percent: 100, message: "Vertex AI hoàn tất" });
        onScriptReady({ scriptId: 1, scriptPath: "/x/script-1.json" });
        return { scriptPaths: ["/x/script-1.json"], failures: [] };
      },
      auditDrafts: async ({ onProgress }) => { onProgress({ stage: "draft_audit", percent: 100, message: "review" }); fs.writeFileSync(path.join(analysisDir, "auto-story-fast", "review-state-1.json"), JSON.stringify({ scriptId: 1, complete: true })); return { audits: [{ scriptId: 1, complete: true }] }; },
      mergePreservedVariants: async () => project
    };
    fs.mkdirSync(path.join(analysisDir, "auto-story-fast"), { recursive: true });
    const events = [];
    await new Runner({}, store, dubbing, () => service).run({ workspaceRoot, projectId: "p1", onProgress: (e) => events.push(e) });
    const percents = events.map((e) => e.percent);
    assert.ok(percents.slice(0, -1).every((v) => v < 100), `no 100 before the end: ${percents}`);
    assert.equal(events.at(-1).percent, 100);
    assert.equal(events.at(-1).final, true);
    let max = 0;
    for (const value of percents.slice(0, -1)) { assert.ok(value >= max - 0.05, `monotonic: ${percents}`); max = Math.max(max, value); }
    const drafts = events.filter((e) => e.step === "draft");
    assert.ok(drafts.every((e) => e.scriptId === 1), "render events carry their script");
    assert.ok(drafts.at(-1).percent > drafts[0].percent, "the draft render moves the run percent");
    assert.ok(fs.existsSync(path.join(workspaceRoot, ".cineviral", "auto-story-progress.json")), "run durations saved for the next estimate");
    fs.rmSync(analysisDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  console.log(`\nAll ${passed} run progress model assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
