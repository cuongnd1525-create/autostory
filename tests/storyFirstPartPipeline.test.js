"use strict";

// Unit tests for the per-Part pipeline helpers, on the REAL artifacts of the
// failed 2026-10-13 run (bwq*) and the accepted 2026-10-09 run (frw*).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Parts = require("../electron/services/storyFirstPartPipeline");
const Stage1 = require("../electron/services/manualAntigravityStage1Service");

const FIX = path.join(__dirname, "fixtures", "story-first-structure-2026-10-13");
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const text = (name) => fs.readFileSync(path.join(FIX, name), "utf8");

// 1. JSON transport: the real 23KB series plan lacked one "]" and was discarded.
{
  const raw = text("bwq-series-plan-attempt1-response.txt");
  assert.throws(() => JSON.parse(raw));
  const repaired = JSON.parse(Parts.repairJsonBrackets(raw));
  assert.strictEqual(repaired.artifacts[0].filename, "series-plan.json");
  assert.strictEqual(repaired.artifacts[0].script.parts.length, 3);
  assert.strictEqual(repaired.notes, "");
  const envelope = Stage1.findArtifactEnvelope(raw);
  assert.strictEqual(envelope.artifacts[0].script.artifactType, "series_plan", "the host parser now recovers it");
  assert.deepStrictEqual(JSON.parse(Parts.repairJsonBrackets("{\"a\":[1,{\"b\":\"x]}\"}")), { a: [1, { b: "x]}" }] }, "string content is never touched");
  assert.deepStrictEqual(JSON.parse(Parts.repairJsonBrackets("{\"a\":[1,2")), { a: [1, 2] }, "truncated tail is closed");
}

// 2. Read-only guard: package inputs are readable, everything else is stopped.
{
  const guard = Parts.buildPackageReadOnlyGuard({ roots: ["D:\\Video\\pack\\01-GUI-GEMINI", "D:\\Video\\pack\\01-ANTIGRAVITY-RESULT"] });
  assert.strictEqual(guard({ toolName: "view_file", file: "D:\\Video\\pack\\01-GUI-GEMINI\\action-candidates.json" }), null, "the read that killed the 2026-10-13 repair is allowed");
  assert.strictEqual(guard({ toolName: "view_file", file: "d:/video/pack/01-ANTIGRAVITY-RESULT/phase-b-input/x.txt" }), null);
  assert(guard({ toolName: "view_file", file: "D:\\Video\\pack\\01-GUI-GEMINI\\analysis-proxy-chunk-001.mp4" }));
  assert(guard({ toolName: "view_file", file: "D:\\Project\\cineviral-studio\\electron\\main.js" }));
  assert(guard({ toolName: "run_command", file: "" }));
  assert(guard({ toolName: "write_to_file", file: "D:\\Video\\pack\\01-ANTIGRAVITY-RESULT\\script-1.json" }));
}

// 3. Timeouts are sized from the work: an 11KB repair gets > 300s, not 180s.
{
  const ms = Parts.estimateWriteTimeoutMs({ outputChars: 11311 * 1.1, inputChars: 40000, minSec: 300, maxSec: 900 });
  assert(ms > 300000 && ms <= 900000, String(ms));
  assert.strictEqual(Parts.estimateWriteTimeoutMs({ outputChars: 100, minSec: 300 }), 300000);
  assert.strictEqual(Parts.estimateWriteTimeoutMs({ outputChars: 1e7, maxSec: 900 }), 900000);
}

// 4. Deterministic structure gate on real scripts.
{
  const bwqPlan = load("bwq-series-plan.json");
  const codes = (id) => Parts.evaluateStoryStructure(load(`bwq-script-${id}-v1.json`), { seriesPlan: bwqPlan, scriptId: id }).errors.map((e) => e.code);
  assert.deepStrictEqual(codes(1), ["hook_moment_skipped"], "Part 1 skipped the hook moment (cold viewer: 330s -> 389s)");
  assert.deepStrictEqual(codes(3), []);
  assert.deepStrictEqual(codes(4).sort(), ["missing_payoff_range", "temporal_ping_pong"], "Part 3 dropped e21 and ping-ponged");
  const frwPlan = load("frw-series-plan.json");
  for (const id of [1, 3, 4]) {
    const result = Parts.evaluateStoryStructure(load(`frw-script-${id}-accepted.json`), { seriesPlan: frwPlan, scriptId: id });
    assert.deepStrictEqual(result.errors, [], `accepted 2026-10-09 Part ${id} must still pass (teaser hook + compressed events)`);
  }
  assert(Parts.evaluateStoryStructure(load("frw-script-4-accepted.json"), { seriesPlan: frwPlan, scriptId: 4 }).warnings.length > 0,
    "skipped minor planned events are advisory only");
}

// 5. Part-scoped packets: compact, complete, and never the raw GUI dumps.
{
  const plan = load("bwq-series-plan.json");
  const intelligence = {
    caseSummary: "Highway stop escalates into a fentanyl and gun investigation.",
    centralViewerQuestion: plan.centralViewerQuestion,
    events: [
      { eventId: "e01", sourceStartSec: 0, sourceEndSec: 34.9, storyRole: "setup", summary: "Officers stop the SUV.", visualFacts: ["Orange SUV on the shoulder."], dialogueFacts: [{ speaker: "Officer", quote: "License please.", sourceSec: 10.5 }] },
      { eventId: "e21", sourceStartSec: 872.4, sourceEndSec: 924.9, storyRole: "consequence", summary: "Hotel search evidence revealed.", visualFacts: [], dialogueFacts: [] }
    ]
  };
  const cues = [{ start: 10, end: 12, text: "License please." }, { start: 880, end: 884, text: "Seven phones in the room." }];
  const scenes = [{ sceneId: "scene_0001", startSec: 0, endSec: 20 }, { sceneId: "scene_0900", startSec: 880, endSec: 890 }];
  const p1 = Parts.buildPartContextPack({ scriptId: 1, seriesPlan: plan, intelligence, cues, scenes });
  assert(p1.text.includes("License please.") && !p1.text.includes("Seven phones"), "only this Part's transcript");
  assert(p1.text.includes("e01") && !p1.text.includes("e21 ["), "only this Part's events");
  const p4 = Parts.buildPartContextPack({ scriptId: 4, seriesPlan: plan, intelligence, cues, scenes });
  assert(p4.text.includes("Seven phones") && p4.text.includes("Previous Part ended on"));
  const rules = Parts.extractEditorialRules([
    "JSON CODE-BLOCK CONTRACT - HIGHEST PRIORITY", "- Return exactly 3 independent Markdown JSON code blocks.", "",
    "LOCAL ACTION CANDIDATES:", "{", "  \"candidates\": [{\"id\": \"DUMP\"}]", "}", "",
    "STEP 0 - VERIFIED INPUT ACCESS GATE (SUPREME; RUN FIRST)", "- open every uploaded video", "",
    "### SELECTED PROMPT PROFILE", "- prompt_profile: viral_tiktok_crime_part1", "- Target total duration: 110 to 125 seconds."
  ].join("\n"));
  assert(rules.includes("viral_tiktok_crime_part1") && !rules.includes("DUMP") && !rules.includes("Markdown JSON code blocks") && !rules.includes("open every uploaded video"));
  const writerPrompt = Parts.buildPartWriterPrompt({ scriptId: 4, partBadge: "PART 3", packetPath: "D:\\x\\part-4-writer-packet.txt" });
  assert(writerPrompt.length < 2000 && writerPrompt.includes("for ONE Part only: Script 4"));
  const repairPacket = Parts.buildPartRepairPacket({
    scriptId: 4, script: load("bwq-script-4-v1.json"), contextText: p4.text, cues,
    result: { errors: Parts.evaluateStoryStructure(load("bwq-script-4-v1.json"), { seriesPlan: plan, scriptId: 4 }).errors }
  });
  assert(repairPacket.includes("missing_payoff_range") && repairPacket.includes("CURRENT SCRIPT JSON"));
  const series = Parts.buildSeriesPlanPacket({ intelligence, hookContract: { isUserLocked: false, title: "Door", anchorRange: { startSec: 6, endSec: 22 } }, scenes, videoDurationSec: 924.881 });
  assert(series.includes("VERIFIED STORY TIMELINE") && series.includes("HOOK CONTRACT") && series.includes("scene_0900"));
}

console.log("storyFirstPartPipeline unit tests passed (JSON repair, guard, timeouts, structure gate, packets)");
