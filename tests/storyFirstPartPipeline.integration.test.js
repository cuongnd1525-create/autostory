"use strict";

// Default Story-First Phase B: one compact packet + one AGY process per Part,
// parallel writers/critics/repairs, deterministic structure gate, non-fatal
// repair failures and content-addressed resume (real run 2026-10-13: a single
// 38-turn conversation for 3 Parts, then one timed-out repair aborted 45 min).
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const { createPhaseAwareSpawn, defaultResponder, mapTaskFromPrompt } = require("./helpers/fakeAntigravity");

const DURATION = 90;
const SCRIPTS = [1, 3, 4];
const SRT = "1\n00:00:01,000 --> 00:00:05,000\nDon't move\n\n2\n00:00:31,000 --> 00:00:34,000\nWhere were you?\n\n3\n00:01:01,000 --> 00:01:04,000\nYou're under arrest.\n";
const PRINT_TIMEOUT = { omitResult: true, exitCode: 1, stderr: "[agy] print timeout after 3m0s with turn in progress\n" };

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-part-pipeline-"));
  const pass1Dir = path.join(root, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const promptPath = path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt");
  await fs.writeFile(promptPath, [
    "JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY",
    "- Return exactly 3 independent Markdown JSON code blocks and nothing else.",
    "",
    "LOCAL ACTION CANDIDATES:",
    "{\"artifactType\":\"action_candidates\",\"candidates\":[{\"actionCandidateId\":\"RAW_DUMP_MARKER\"}]}",
    "",
    "### SELECTED PROMPT PROFILE",
    "- prompt_profile: viral_tiktok_crime_part1",
    "- Target total duration: 110 to 125 seconds.",
    "Generate Script 1, Script 3 and Script 4.",
    "VOICE CALIBRATION PARAMETERS PROVIDED BY USER:",
    "- measuredWordsPerSecond: 2.209"
  ].join("\n"));
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({ videoDurationSec: DURATION, scenes: [{ sceneId: "scene_0001", startSec: 0, endSec: DURATION }] }));
  await fs.writeFile(path.join(pass1Dir, "source-transcript.srt"), SRT);
  await fs.writeFile(path.join(pass1Dir, "action-candidates.json"), JSON.stringify({ candidates: [{ actionCandidateId: "action_0001", sourceStartSec: 2, sourceEndSec: 5, actionPriorityScore: 9, mustReview: true }] }));
  await fs.writeFile(path.join(pass1Dir, "analysis-proxy.mp4"), "proxy-test-bytes");
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review", pass1UploadDir: pass1Dir, promptPath,
    cache: { sourceFingerprint: "part-pipeline-test", cacheDir: path.join(root, "source-cache") }
  }));
  return root;
}
const segment = (start, end, audio_mode, voiceover_text = "") => ({ id: `s_${String(start).replace(".", "_")}`, sceneId: "scene_0001", sourceStartSec: start, sourceEndSec: end, audio_mode, voiceover_text });
function goodScript(id) {
  const base = { 1: 0, 3: 30, 4: 60 }[id];
  return {
    artifactType: "highlight_cut_script", schemaVersion: 1, scriptId: id, title: `Part ${id}`,
    segments: [
      segment(base + 1, base + 4, "original_audio"),
      segment(base + 8, base + 11, "voiceover_only", "But officers had received a different explanation earlier."),
      segment(base + 13, base + 17, "original_audio"),
      segment(base + 19, base + 22, "voiceover_only", "Before they could leave, the new evidence changed their questions."),
      segment(base + 27, base + 30, "original_audio")
    ]
  };
}
const weakScript = (id) => ({ ...goodScript(id), segments: [goodScript(id).segments[0]] });
const writerId = (prompt) => Number(prompt.match(/for ONE Part only: Script (\d+)/)?.[1] || 0);
const repairId = (prompt) => Number(prompt.match(/Repair EXACTLY Part Script (\d+)/)?.[1] || 0);
const criticId = (prompt) => Number(prompt.match(/Judge ONE proposed edit \(Script (\d+)\)/)?.[1] || 0);
const envelope = (id, script) => ({ envelope: { artifacts: [{ filename: `script-${id}.json`, script }] } });
function review(id, accepted) {
  return { envelope: { artifacts: [{ filename: "audience-review.json", script: {
    artifactType: "audience_review", schemaVersion: 1, parts: [{
      scriptId: id, score: accepted ? 90 : 55, accepted,
      hookQuestion: "What did the officers learn after the confrontation?",
      hookHandoffAssessment: "The opening orients the viewer to the stop and the people.",
      narratorContribution: "The narrator explains what changed and yields to source audio.",
      weakestMoment: "The middle beat is slightly slow but still advances the case.",
      endingPayoffAssessment: "The final beat delivers the locked chapter ending.",
      issues: accepted ? [] : [{ code: "causal_gap", segmentIndex: 1, sourceEventId: "e05", whyViewerLeaves: "The jump to questioning is not explained to the viewer.", requiredChange: "Add a spoken bridge explaining why questioning starts." }]
    }]
  } }] } };
}

async function exercise(root, { writer, repair, critic, coldViewer = false, settings = {}, mapEvidence = false } = {}) {
  const calls = [];
  const live = { active: 0, maxActive: 0 };
  const normal = defaultResponder({ durationSec: DURATION });
  const respond = (kind, prompt, call) => {
    if (kind === "map" && mapEvidence) {
      const response = normal(kind, prompt, call);
      const data = response.envelope.artifacts[0].script;
      const task = mapTaskFromPrompt(prompt);
      data.sceneEvidence = Array.from({ length: 30 }, (_, index) => ({
        sceneIds: [`scene_${String(index + 1).padStart(4, "0")}`], sourceStartSec: index * 3, sourceEndSec: index * 3 + 3,
        people: ["Officer A"], seen: `frame of scene_${String(index + 1).padStart(4, "0")}`, action: "talks", heard: "", evidence: []
      })).filter((row) => row.sourceStartSec >= task.startSec - 4 && row.sourceEndSec <= task.endSec + 4);
      return response;
    }
    if (prompt.includes("INDEPENDENT COLD VIEWER")) return critic(criticId(prompt), prompt, call);
    if (kind === "phase_b" && prompt.includes("EDITORIAL REPAIR")) return repair(repairId(prompt), prompt, call);
    if (kind === "phase_b") return writer(writerId(prompt), prompt, call);
    return normal(kind, prompt, call);
  };
  const base = createPhaseAwareSpawn({ calls, respond });
  const spawn = (command, args, options) => {
    const child = base(command, args, options);
    const call = calls[calls.length - 1];
    if (call.kind === "phase_b" || call.prompt.includes("INDEPENDENT COLD VIEWER")) {
      live.active += 1;
      live.maxActive = Math.max(live.maxActive, live.active);
      child.on("close", () => { live.active -= 1; });
    }
    return child;
  };
  const service = new Stage1({
    antigravityCommand: "agy", antigravityModel: "test-model",
    storyFirstEditorialEnabled: true, storyFirstColdViewerEnabled: coldViewer,
    storyFirstUnifiedPreflightEnabled: false, ...settings
  }, { spawn, authProbe: async () => ({ expiresAt: new Date(Date.now() + 3600000), expiredFlag: false }) });
  const messages = [];
  let value = null, error = null;
  try { value = await service.run({ packageDir: root, onProgress: (item) => messages.push(String(item.message || "")) }); } catch (caught) { error = caught; }
  const resultDir = path.join(root, "01-ANTIGRAVITY-RESULT");
  const report = JSON.parse(await fs.readFile(path.join(resultDir, "editorial-quality-report.json"), "utf8").catch(() => "null"));
  const timing = JSON.parse(await fs.readFile(path.join(resultDir, "timing-report.json"), "utf8").catch(() => "null"));
  return { calls, live, value, error, report, timing, messages, resultDir,
    writers: calls.filter((c) => c.kind === "phase_b" && !c.prompt.includes("EDITORIAL REPAIR")),
    repairs: calls.filter((c) => c.kind === "phase_b" && c.prompt.includes("EDITORIAL REPAIR")),
    critics: calls.filter((c) => c.prompt.includes("INDEPENDENT COLD VIEWER")) };
}

(async () => {
  // ---------------------------------------------------------------- A: parallel writers + repair
  const root = await fixture();
  try {
    const a = await exercise(root, {
      writer: (id, prompt) => {
        const packet = prompt.match(/then write the script: (.+)/)?.[1]?.trim();
        // Reading a harmless package input must NOT kill the step (2026-10-13).
        return { viewFiles: [packet, path.join(root, "01-GUI-GEMINI", "action-candidates.json")], ...envelope(id, weakScript(id)) };
      },
      repair: (id, prompt) => ({ viewFiles: [prompt.match(/view_file \(2-4 calls may be needed for the whole file\): (.+)/)?.[1]?.trim()].filter(Boolean), ...envelope(id, goodScript(id)) })
    });
    assert(!a.error, a.error?.stack || String(a.error));
    assert(a.report.accepted && a.report.partPipeline);
    assert.deepStrictEqual(a.writers.map((c) => writerId(c.prompt)).sort(), [1, 3, 4], "one writer process per Part");
    assert(a.live.maxActive >= 2, `writers/repairs run in parallel (max ${a.live.maxActive})`);
    assert.deepStrictEqual(a.repairs.map((c) => repairId(c.prompt)).sort(), [1, 3, 4]);
    assert(a.writers.every((c) => c.prompt.length < 24000 && /part-\d-writer-packet\.txt/.test(c.prompt)));
    assert(a.writers.every((c) => !c.prompt.includes("source-transcript.srt") && !c.prompt.includes("scene-manifest.json")), "writers never get the full transcript/manifest");
    const packet = await fs.readFile(path.join(a.resultDir, "phase-b-input", "part-1-writer-packet.txt"), "utf8");
    assert(packet.includes("HOST STORY-STRUCTURE GATE") && packet.includes("THIS PART'S LOCKED CONTRACT") && packet.includes("Don't move"));
    assert(!packet.includes("RAW_DUMP_MARKER") && !packet.includes("Return exactly 3 independent Markdown"), "irrelevant GUI blocks are stripped");
    assert(!packet.includes("You're under arrest"), "other Parts' transcript is not in Part 1's packet");
    assert.strictEqual(a.timing.scriptGeneration.mode, "per_part");
    assert.strictEqual(a.value.validFiles.length, 3);
    const saved = await Promise.all(a.value.validFiles.map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))));
    assert(saved.every((script) => script.shared_hook_enabled === false && script.prompt_profile === "viral_tiktok_crime_part1"));

    // ---------------------------------------------------------------- B: resume = zero AI work
    const b = await exercise(root, {
      writer: () => { throw new Error("writer must not run on resume"); },
      repair: () => { throw new Error("repair must not run on resume"); }
    });
    assert(!b.error, b.error?.stack || String(b.error));
    assert.strictEqual(b.calls.length, 0, `fully cached rerun starts no AGY process (got ${b.calls.map((c) => c.kind).join(",")})`);
    assert(b.messages.some((m) => m.includes("best_cache_passed")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }

  // ---------------------------------------------------------------- C: a timed-out repair is NOT fatal; rerun resumes
  const rootC = await fixture();
  try {
    const c = await exercise(rootC, {
      writer: (id) => envelope(id, weakScript(id)),
      repair: (id) => (id === 3 ? PRINT_TIMEOUT : envelope(id, goodScript(id)))
    });
    assert(c.error && c.error.kind === "editorial_quality", `final gate decides, not the timeout (${c.error?.kind}: ${c.error?.message})`);
    assert(/Part 3/.test(c.error.message) && !/Part 1:/.test(c.error.message), c.error.message);
    assert(c.messages.some((m) => /Part 3 vòng 1: không nhận được bản sửa hợp lệ \(print_timeout\)/.test(m)));
    assert(c.report.results.find((r) => r.scriptId === 1).passed && c.report.results.find((r) => r.scriptId === 4).passed);
    const resumed = await exercise(rootC, {
      writer: () => { throw new Error("writer must not rerun"); },
      repair: (id) => envelope(id, goodScript(id))
    });
    assert(!resumed.error, resumed.error?.stack || String(resumed.error));
    assert.deepStrictEqual(resumed.writers.length, 0, "writers are cached");
    assert.deepStrictEqual(resumed.repairs.map((call) => repairId(call.prompt)), [3], "only the still-failing Part is repaired");
  } finally { await fs.rm(rootC, { recursive: true, force: true }); }

  // ---------------------------------------------------------------- D: cold viewer per Part, cached by content
  const rootD = await fixture();
  try {
    let reviewsOf3 = 0;
    const d = await exercise(rootD, {
      coldViewer: true,
      writer: (id) => envelope(id, goodScript(id)),
      repair: (id) => envelope(id, { ...goodScript(id), title: `Part ${id} repaired` }),
      critic: (id) => {
        if (id !== 3) return review(id, true);
        reviewsOf3 += 1;
        return review(id, reviewsOf3 > 1);
      }
    });
    assert(!d.error, d.error?.stack || String(d.error));
    assert.deepStrictEqual(d.critics.map((call) => criticId(call.prompt)).sort(), [1, 3, 3, 4], "only the repaired Part is reviewed again");
    assert.deepStrictEqual(d.repairs.map((call) => repairId(call.prompt)), [3]);
    assert(d.critics.every((call) => !call.prompt.includes(".mp4") && call.prompt.length < 24000));
  } finally { await fs.rm(rootD, { recursive: true, force: true }); }

  // ---------------------------------------------------------------- E: deterministic structure gate
  const rootE = await fixture();
  try {
    const e = await exercise(rootE, {
      writer: (id) => envelope(id, id === 4 ? { ...goodScript(4), segments: goodScript(4).segments.slice(0, 4) } : goodScript(id)),
      repair: (id) => envelope(id, goodScript(id))
    });
    assert(!e.error, e.error?.stack || String(e.error));
    assert.deepStrictEqual(e.repairs.map((call) => repairId(call.prompt)), [4], "only the Part that dropped its payoff is repaired");
    const packet = await fs.readFile(path.join(e.resultDir, "part-4-repair-round1-packet.txt"), "utf8");
    assert(packet.includes("missing_payoff_range"), "the repair packet names the deterministic failure");
  } finally { await fs.rm(rootE, { recursive: true, force: true }); }

  // ---------------------------------------------------------------- F: an unusable cold viewer does not discard the run
  const rootF = await fixture();
  try {
    const f = await exercise(rootF, {
      coldViewer: true,
      writer: (id) => envelope(id, goodScript(id)),
      repair: () => { throw new Error("no repair expected"); },
      critic: (id) => (id === 4 ? { rawResult: "I could not review this." } : review(id, true))
    });
    assert(!f.error, f.error?.stack || String(f.error));
    assert.deepStrictEqual(f.report.audienceReviewUnavailableParts, [4]);
    assert.strictEqual(f.critics.filter((call) => criticId(call.prompt) === 4).length, 2, "one fresh retry, then host gates only");
    assert(f.messages.some((m) => m.includes("[COLD_VIEWER] Part 4 KHÔNG KHẢ DỤNG")));
  } finally { await fs.rm(rootF, { recursive: true, force: true }); }

  // ---------------------------------------------------------------- G: bounded reasoning per step + lower-reasoning retry
  // Real 2026-10-13: flash-HIGH writers/repairs burned 52-63K thinking tokens
  // per turn, hit the output-token ceiling and timed out.
  const rootG = await fixture();
  try {
    const modelOf = (call) => call.args[call.args.indexOf("--model") + 1];
    let part3Writes = 0;
    const g = await exercise(rootG, {
      settings: { antigravityModel: "gemini-3.8-flash-high" },
      writer: (id) => {
        if (id === 3 && ++part3Writes === 1) {
          return { resultObject: { status: "ERROR", error: "Your previous response was cut off because it exceeded the output token limit" }, exitCode: 1 };
        }
        return envelope(id, weakScript(id));
      },
      repair: (id, _prompt, call) => (id === 4 && !modelOf(call).endsWith("-low") ? PRINT_TIMEOUT : envelope(id, goodScript(id)))
    });
    assert(!g.error, g.error?.stack || String(g.error));
    const firstWriters = g.writers.slice(0, 3);
    assert(firstWriters.every((call) => modelOf(call) === "gemini-3.8-flash-medium"), firstWriters.map(modelOf).join(","));
    const retryWriter = g.writers[3];
    assert.strictEqual(writerId(retryWriter.prompt), 3);
    assert.strictEqual(modelOf(retryWriter), "gemini-3.8-flash-low", "the token-limit failure is retried one reasoning level lower");
    assert(g.messages.some((m) => /Part 3\] FAILED \(output_token_limit\)/.test(m)), `token-limit failures are named: ${g.messages.filter((m) => m.includes("FAILED")).join(" / ")}`);
    const part4Repairs = g.repairs.filter((call) => repairId(call.prompt) === 4).map(modelOf);
    assert.deepStrictEqual(part4Repairs, ["gemini-3.8-flash-medium", "gemini-3.8-flash-low"]);
    const candidate = JSON.parse(await fs.readFile(path.join(g.resultDir, "script-3-v1-candidate.json"), "utf8"));
    assert.strictEqual(candidate.shared_hook_enabled, false, "per-Part hooks are declared before any gate runs");
  } finally { await fs.rm(rootG, { recursive: true, force: true }); }

  // ---------------------------------------------------------------- H: cold viewer is advisory after repairs, facts are not
  const rootH = await fixture();
  try {
    const h = await exercise(rootH, {
      coldViewer: true,
      writer: (id) => envelope(id, goodScript(id)),
      repair: (id) => envelope(id, { ...goodScript(id), title: `Part ${id} r${Math.random()}` }),
      critic: (id) => review(id, id !== 3)
    });
    assert(!h.error, h.error?.stack || String(h.error));
    const part3 = h.report.results.find((item) => item.scriptId === 3);
    assert(part3.passed && part3.acceptedWithAudienceWarnings && part3.advisoryAudienceIssues.length);
    assert(h.messages.some((m) => m.includes("chuyển thành CẢNH BÁO")));
  } finally { await fs.rm(rootH, { recursive: true, force: true }); }
  const rootI = await fixture();
  try {
    const falseClaim = (id) => {
      const r = review(id, false);
      r.envelope.artifacts[0].script.parts[0].issues[0].code = "false_claim";
      return r;
    };
    const i = await exercise(rootI, {
      coldViewer: true,
      writer: (id) => envelope(id, goodScript(id)),
      repair: (id) => envelope(id, { ...goodScript(id), title: `Part ${id} r${Math.random()}` }),
      critic: (id) => (id === 4 ? falseClaim(id) : review(id, true))
    });
    assert(i.error && i.error.kind === "editorial_quality" && /Part 4: chặn bởi false_claim/.test(i.error.message), "a factual error about real people still blocks");
  } finally { await fs.rm(rootI, { recursive: true, force: true }); }

  // ---------------------------------------------------------------- J: AI chooses beats, host computes; repairs are edit ops; scene ledger
  const rootJ = await fixture();
  try {
    const scenesJ = Array.from({ length: 30 }, (_, index) => ({ sceneId: `scene_${String(index + 1).padStart(4, "0")}`, startSec: index * 3, endSec: index * 3 + 3 }));
    await fs.writeFile(path.join(rootJ, "01-GUI-GEMINI", "scene-manifest.json"), JSON.stringify({ videoDurationSec: DURATION, scenes: scenesJ }));
    const sceneOf = (sec) => scenesJ.find((scene) => scene.startSec <= sec && scene.endSec > sec).sceneId;
    const span = (from, to) => scenesJ.filter((scene) => scene.startSec >= from - 0.01 && scene.endSec <= to + 0.01).map((scene) => scene.sceneId);
    const beatsFor = (id) => {
      const base = { 1: 0, 3: 30, 4: 60 }[id];
      return [
        { beatId: "b1", sceneIds: [sceneOf(base + 1)], audio: "original", role: "hook" },
        { beatId: "b2", sceneIds: span(base + 6, base + 12), audio: "narration", narration: "But officers had received a different explanation earlier.", role: "context" },
        { beatId: "b3", sceneIds: span(base + 12, base + 18), audio: "original", role: "evidence" },
        { beatId: "b4", sceneIds: span(base + 18, base + 24), audio: "narration", narration: "Before they could leave, the new evidence changed their questions.", role: "bridge" },
        { beatId: "b5", sceneIds: span(base + 27, base + 30), audio: "original", role: id === 4 ? "payoff" : "cliffhanger" }
      ];
    };
    const writerPrompts = [];
    const j = await exercise(rootJ, {
      coldViewer: true,
      settings: { sourceUnderstandingSceneLedger: true },
      writer: (id, prompt) => {
        writerPrompts.push(prompt);
        const beats = beatsFor(id);
        return { envelope: { artifacts: [{ filename: `beats-${id}.json`, script: { artifactType: "story_beat_plan", scriptId: id, title: `PART ${id} TITLE`, beats: id === 4 ? beats.slice(0, 4) : beats } }] } };
      },
      repair: (id, prompt) => {
        assert(prompt.includes(`beat-edits-${id}.json`), "repairs ask for edit operations");
        return { envelope: { artifacts: [{ filename: `beat-edits-${id}.json`, script: { artifactType: "story_beat_edits", scriptId: id, edits: [
          { op: "insert_after", beatId: "b4", beat: beatsFor(id)[4] }
        ] } }] } };
      },
      critic: (id, prompt) => review(id, true),
      mapEvidence: true
    });
    assert(!j.error, j.error?.stack || String(j.error));
    assert(writerPrompts.every((prompt) => prompt.includes("story_beat_plan")), "writers are asked for a beat plan");
    const packet = await fs.readFile(path.join(j.resultDir, "phase-b-input", "part-1-writer-packet.txt"), "utf8");
    assert(packet.includes("SCENE CATALOG") && packet.includes("seen: frame of scene_0001"), "the writer sees the frame-level ledger");
    assert(packet.includes("OUTPUT = A BEAT PLAN"));
    const coldPacket = await fs.readFile(path.join(j.resultDir, "part-1-cold-viewer-initial-packet.txt"), "utf8");
    assert(coldPacket.includes("SEEN: frame of scene_"), "the critic checks narration against frame facts");
    assert.deepStrictEqual(j.repairs.map((call) => repairId(call.prompt)), [4], "only Part 4 (missing payoff) is repaired");
    const final4 = JSON.parse(await fs.readFile(j.value.validFiles[2], "utf8"));
    assert.deepStrictEqual(final4.segments.map((segment) => segment.beatId), ["b1", "b2", "b3", "b4", "b5"]);
    assert.strictEqual(final4.segments[4].sourceEndSec, 90, "host computed the payoff range from the scene ids");
    assert.strictEqual(final4.hostCompile.compiler, "host_beat_compiler_v1");
    assert(j.messages.some((m) => /Part 4 vòng 1: áp dụng 1 thao tác/.test(m)));
    assert(j.messages.some((m) => /\[SCENE_LEDGER\] \d+\/30 cảnh/.test(m)));
  } finally { await fs.rm(rootJ, { recursive: true, force: true }); }

  console.log("story-first per-Part pipeline tests passed (parallel writers, resume, non-fatal repair, per-Part cold viewer, structure gate)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
