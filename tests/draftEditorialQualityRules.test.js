"use strict";

// Rules distilled from the Gemini review of drafts B/C vs a viral reference (Ticket 112).
const assert = require("assert");
const Q = require("../electron/services/draftEditorialQualityRules");
const Rules = require("../electron/services/seriesEditorialRules");
const Serial = require("../electron/services/serializedGeminiWorkflowService");
const Bridge = require("../electron/services/seriesBlueprintBridge");

const ts = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0").replace(".", ",")}`;
};
// YouTube rolling captions: [prev line + new line] cue, a 10 ms cue, and a lone "\r" line.
function rolling(lines) {
  let out = "", n = 1, prev = "";
  for (const [a, b, text] of lines) {
    out += `${n++}\n${ts(a)} --> ${ts(b)}\n\r\n${prev ? prev + "\n" : ""}${text}\n\n`;
    out += `${n++}\n${ts(b)} --> ${ts(b + 0.01)}\n\r\n${text}\n \n\n`;
    prev = text;
  }
  return out;
}
const srt = rolling([
  [189.6, 192.3, "Baby, the cops are on my ass. What do I do?"],
  [205.8, 227.7, "Baby, I'm heading toward your dad's house."],
  [227.8, 229.9, "Oh, I'm shaking. How did that happen?"],
  [821.6, 826.0, "Dude, are my pinkies doing a problem to you?"],
  [753.5, 756.0, "Hey, hey, right here! Show me your hands!"]
].sort((x, y) => x[0] - y[0]));

const manifest = { videoDurationSec: 964, scenes: [
  { sceneId: "scene_a", startSec: 580, endSec: 593 }, { sceneId: "scene_b", startSec: 593, endSec: 600 }
] };
const seg = (a, b, extra = {}) => ({ sceneId: "scene_x", sourceStartSec: a, sourceEndSec: b, playbackSpeed: 1, audio_mode: "original_audio", voiceover_text: "", ...extra });
const vo = (a, b, text, extra = {}) => seg(a, b, { audio_mode: "voiceover_only", voiceover_text: text, storyFunction: "voiceover_bridge", ...extra });

(() => {
  // Transcript parsing survives rolling captions and the lone "\r" lines.
  const words = Q.buildWordTimeline({ transcriptSrt: srt });
  assert.strictEqual(words.filter((w) => /^Baby,$/.test(w.word)).length, 2, "rolled-over lines are not counted twice");
  const shaking = words.find((w) => w.word === "shaking.");
  assert(shaking && shaking.start > 227.7 && shaking.start < 230, "text after a lone \\r line is kept with its cue");

  // TOOL = facts only. Judgement words never appear as tool findings.
  const partB = { part_number: 2, segments: [
    seg(189.6, 195, { storyFunction: "hook" }),
    seg(208.9, 225, { storyFunction: "action_escalation", actionOverride: true }),
    vo(225, 235, "He's pushing the stolen cop car to its absolute limit, hitting speeds over 120 miles per hour. And his escape plan? It's completely unhinged."),
    seg(237.4, 245.5),
    vo(482.75, 490, "He's now on foot. But the cops are bringing in the K9 unit, and they are not playing around.")
  ] };
  const b = Q.checkScript({ script: partB, manifest, options: { voWordsPerSec: 2.35 } });
  const rules = (r) => r.findings.map((f) => f.rule);
  assert.deepStrictEqual(rules(b), ["VO_DOES_NOT_FIT"], JSON.stringify(b.findings));
  assert.strictEqual(b.findings[0].segment, 5, "19 words cannot be voiced in a 7.25s bed; the 24-word line fits its 10s bed");
  for (const banned of ["VO_OVER_DIALOGUE", "DEAD_AIR", "HOOK_LOW_AROUSAL", "HOOK_DEAD_START", "GENERIC_CLIFFHANGER", "CUT_MID_SENTENCE", "PROOF_NOT_IN_TRANSCRIPT"]) {
    assert(!require("fs").readFileSync(require.resolve("../electron/services/draftEditorialQualityRules"), "utf8").includes(`"${banned}"`), `${banned} is Gemini's call, not the tool's`);
  }
  // ...but the transcript is handed to Gemini as evidence for those windows.
  const evidence = Q.scriptEvidence({ script: partB, transcriptSrt: srt });
  assert(/pointers only/.test(evidence));
  assert(/VO bed of segment 3 \(A 03:45.0-A 03:55.0[^)]*\): A 03:47.\d "Oh, I'm shaking/.test(evidence), evidence);
  assert(/Hook opening/.test(evidence) && /Part ending/.test(evidence));

  // C-02: chronology is arithmetic.
  const partC = { part_number: 3, segments: [
    seg(717.8, 725.6, { storyFunction: "hook" }),
    vo(625.6, 633, "Part 3. The K9 unit is closing in."),
    seg(584.1, 593.4),
    seg(753.0, 754.3)
  ] };
  const c = Q.checkScript({ script: partC, manifest });
  assert(c.findings.some((f) => f.rule === "SOURCE_ORDER" && f.segment === 3), JSON.stringify(c.findings));
  assert(c.findings.every((f) => f.severity === "fact"));

  // Isolated fragments and shot-change spill (scene manifest).
  const orphan = Q.checkScript({ manifest, script: { segments: [seg(100, 110, { storyFunction: "hook" }), seg(300, 300.7), seg(586, 593.6), seg(700, 710)] } });
  assert(orphan.findings.some((f) => f.rule === "ISOLATED_FRAGMENT" && f.segment === 2));
  assert(orphan.findings.some((f) => f.rule === "SHOT_SPILL" && f.segment === 3 && /593/.test(f.message)), "0.6 s flash of scene_b");

  // VO fit uses the measured TTS speed; consecutive VO segments are one block (BLOCK_VOICE_OVERFLOW 8.60 > 8.13 s).
  const block = { segments: [seg(10, 20, { storyFunction: "hook" }),
    vo(77.9, 80, "This guy was just busted for a stolen motorcycle."),
    vo(80, 86, "The officers think it's a routine stop, but they have no idea what he's about to do. Not even a clue at all."),
    seg(90, 100)] };
  assert(Q.checkScript({ script: block, options: { voWordsPerSec: 2.35 } }).findings.some((f) => f.rule === "VO_DOES_NOT_FIT" && /segments 2-3/.test(f.message)));
  assert(!Q.checkScript({ script: block, options: { voWordsPerSec: 4.2 } }).findings.some((f) => f.rule === "VO_DOES_NOT_FIT"), "a faster measured voice fits");

  // Gemini's own bed_check contradicting its VO choice is a logical fact.
  const bed = Q.checkScript({ script: { segments: [seg(10, 20, { storyFunction: "hook" }), vo(30, 36, "Short line here.", { bed_check: { has_dialogue: false, has_burned_in_dialogue_captions: true } })] } });
  assert(bed.findings.some((f) => f.rule === "BED_CHECK_CONTRADICTION"));

  // Mid-word cuts only with real word timestamps.
  const precise = [{ word: "not", start: 724.6, end: 724.9 }, { word: "far.", start: 725.3, end: 725.9 }];
  assert(Q.checkScript({ script: partC, words: precise }).findings.some((f) => f.rule === "CUT_INSIDE_WORD" && f.segment === 1));
  assert(!Q.checkScript({ script: partC, transcriptSrt: srt }).findings.some((f) => f.rule === "CUT_INSIDE_WORD"), "caption estimates are not used for cut verdicts");

  // Blueprint: tool checks the STRUCTURE of Gemini's hook audition, never the choice.
  const audition = (chosenIndex, n = 3) => ({ candidates: Array.from({ length: n }, (_, i) => ({ sourceStartSec: 700 + i * 20, sourceEndSec: 706 + i * 20, first3sSeen: "x", first3sHeard: "y", viewerQuestion: "z" })), chosenIndex, why: "w" });
  const bpOk = { parts: [{ part_number: 3, hook: { sourceStartSec: 740, sourceEndSec: 746 }, hookAudition: audition(2) }] };
  assert.deepStrictEqual(Q.checkBlueprintStructure({ blueprint: bpOk, manifest }).findings, []);
  const bpBad = { parts: [{ part_number: 3, hook: { sourceStartSec: 717.5, sourceEndSec: 725 }, hookAudition: audition(2) }, { part_number: 2, hook: { sourceStartSec: 1, sourceEndSec: 5 }, hookAudition: audition(0, 1) }] };
  const bf = Q.checkBlueprintStructure({ blueprint: bpBad, manifest }).findings.map((f) => f.message);
  assert(bf.some((m) => /Part 3: the chosen hookAudition candidate does not overlap/.test(m)), JSON.stringify(bf));
  assert(bf.some((m) => /Part 2: hookAudition must list at least 3/.test(m)));
  const bpEvidence = Q.blueprintEvidence({ blueprint: { parts: [{ part_number: 3, hook: { sourceStartSec: 717.5, sourceEndSec: 725, hookProof: "'Show me your hands!'" }, chapterBeats: [] }] }, transcriptSrt: srt });
  assert(bpEvidence.includes("Part 3 Hook A 11:57.5-A 12:05.0") && bpEvidence.trim().endsWith("(no caption line)"), bpEvidence);
  assert(Rules.blueprintRules().includes("hookAudition") && Serial.blueprintPrompt.toString().length > 0);
  assert(/PROOF_MISPLACED/.test(Rules.blueprintCriticPrompt()) && /HOOK_WEAK/.test(Rules.blueprintCriticPrompt()));
  assert(!/753|Show me your hands|shaking/i.test(Rules.criticPrompt("x") + Rules.blueprintCriticPrompt() + Rules.partRules()), "prompts carry no facts from one specific video");

  // Prompts carry the rules; the Bridge carries a per-Part banner.
  assert(Serial.partPrompt(3).includes(Rules.PART_MARKER));
  assert(/<= 18 words/.test(Serial.partPrompt(4)));
  assert(Rules.appendIfMissing("x", Rules.partRules(), Rules.PART_MARKER).includes("AUDIO OWNERSHIP"));
  assert.strictEqual(Rules.appendIfMissing(`x\n${Rules.PART_MARKER}`, "dup", Rules.PART_MARKER), `x\n${Rules.PART_MARKER}`);
  const bridged = Bridge.applyBlueprintToScript({ scriptId: 4, segments: [] }, { seriesId: "s", shared_top_banner_text: "SERIES", parts: [{ scriptId: 4, part_number: 3, part_top_banner_text: "ESCAPED IN CUFFS VS POLICE K9" }] }).script;
  assert.strictEqual(bridged.part_top_banner_text, "ESCAPED IN CUFFS VS POLICE K9");
  assert.strictEqual(bridged.shared_top_banner_text, "SERIES");

  // Shared SRT parser keeps text that follows a lone "\r" line (hook mining, editorial gate).
  const { parseSrtCues } = require("../electron/services/hookMiningService");
  const cues = parseSrtCues(srt);
  assert(cues.some((cue) => /pinkies/.test(cue.text)), "YouTube cue text after a lone \\r line is kept");
  assert.deepStrictEqual(parseSrtCues("1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\nHello\n").map((cue) => cue.text), ["Hello"], "an empty cue does not swallow the next index");

  // Render: audio edge fades only at hard joins; 4:3 crop + blur default; per-Part banner.
  const Dub = require("../electron/services/dubbingService");
  const fades = Dub.buildClipEdgeFades([[seg(0, 5)], [seg(5, 9)], [vo(20, 25, "x", { audio_mode: "voiceover_with_ambient" })], [seg(25, 30)]]);
  assert.deepStrictEqual(fades.map((f) => [f.in > 0, f.out > 0]), [[true, false], [false, true], [true, true], [true, true]]);
  const ambient = Dub.normalizeHighlightCutScript({ segments: [
    vo(0, 6, "Clean bed line.", { audio_mode: "voiceover_with_ambient", clean_ambient_verified: true }),
    vo(6, 12, "Dirty bed line.", { audio_mode: "voiceover_with_ambient", clean_ambient_verified: true, bed_check: { has_dialogue: true } }),
    seg(12, 20)] }, 100).segments;
  const manualProject = { analysisWorkflow: "manual_gemini_draft_review" };
  assert.strictEqual(Dub.getHighlightAudioMode(ambient[0], true, manualProject), "voiceover_with_ambient", "verified clean bed keeps ambience");
  assert.strictEqual(Dub.getHighlightAudioMode(ambient[1], true, manualProject), "voiceover_only", "self-reported dialogue bed stays muted");
  const Art = require("../electron/services/dubbingArtifactService");
  assert.strictEqual(Art.resolveFramingSettings(manualProject).foregroundCropAspect, "4:3");
  assert.strictEqual(Art.resolveFramingSettings(manualProject).blurBackgroundEnabled, true);
  assert.strictEqual(Art.resolveFramingSettings({ ...manualProject, videoDecoration: { foregroundCropAspect: "source" } }).foregroundCropAspect, "source", "explicit choice wins");
  assert.strictEqual(Art.resolveFramingSettings({}).foregroundCropAspect, "source", "other workflows unchanged");
  const bannerProject = { analysis: { sharedTopBannerText: "HE STOLE A COP CAR 😳", activeVariantId: "v3", highlightVariants: [{ id: "v3", partTopBannerText: "ESCAPED IN CUFFS VS POLICE K9 😳" }] },
    videoDecoration: { topCaptionEnabled: true, topCaptionText: "He stole a cop car 😳" } };
  assert.strictEqual(Art.resolvePartTopBanner(bannerProject), "ESCAPED IN CUFFS VS POLICE K9 😳");
  assert.strictEqual(Art.resolvePartTopBanner({ ...bannerProject, videoDecoration: { topCaptionText: "My own title" } }), "", "user-typed caption kept");

  console.log("draftEditorialQualityRules tests passed (tool facts only; transcript as evidence for Gemini; hook audition structure; render helpers)");
})();
