// Editorial readiness regressions: a technically valid V4 edit can still be weak.
// Covers: a routine opening displacing a stronger verified hook, long low-information
// stretches, an ending that cuts a speaker mid-sentence, a valid EDL with no real
// payoff, external branding/subtitles burned into the source, ending windows
// declared via purposes[], and drifting Source Story Model timestamps.
// Synthetic, case-neutral fixtures only.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Director = require("../electron/services/editorialDirectorService");
const Critic = require("../electron/services/scopeMediaCriticService");
const SM = require("../electron/services/sourceStoryModelService");
const { ACCEPTANCE } = Director;

const SOURCE_SEC = 600;
const win = (windowId, startSec, endSec, purposes) => ({ windowId, startSec, endSec, purposes, purpose: purposes[0], purposeRanges: purposes.map(p => ({ purpose: p, startSec, endSec })) });
const scope = { storyScopeId: "scope_test", targetDurationSec: 75,
  // The ending window's PRIMARY purpose is 'core' (as normalized scopes are).
  scopeWindows: [win("w1", 20, 120, ["core"]), win("w2", 200, 330, ["core"]), win("w3", 400, 480, ["core", "ending_material"])] };
const reel = { ranges: scope.scopeWindows.map((w, i) => ({ reelFile: `r${i}`, sourceStartSec: w.startSec - 2, sourceEndSec: w.endSec + 2, windowStartSec: w.startSec, windowEndSec: w.endSec, scopeWindowId: w.windowId })) };
const beat = (id, s, e, role = "escalation") => ({ beatId: id, sourceStartSec: s, sourceEndSec: e, narrativeRole: role, observedInFootage: "seen and heard", whyNecessaryNow: "moves the question" });
const beats = [beat("b1", 30, 52, "cold_open_hook"), beat("b2", 210, 230), beat("b3", 260, 282), beat("b4", 440, 458, "resolution")];
const spine = { editorialContract: Director.DIRECTOR_CONTRACT, storyScope: scope, scopeReel: reel, beats };
const total = beats.reduce((n, b) => n + b.sourceEndSec - b.sourceStartSec, 0);
const segments = beats.map(b => ({ beat_id: b.beatId, sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec, playbackSpeed: 1 }));
const timeline = Critic.outputTimeline(spine, { segments });
const R = { targetDurationMinSec: 65, targetDurationMaxSec: 90 };
const rawPass = { scopeSurvived: true, centralQuestionActiveThroughout: true, endingIsConsequenceOfCentralConflict: true, finalFootageUsable: true, observedStory: "x", summary: "x",
  coldViewerCanFollow: true, coldViewerNotes: "", transitions: [], issues: [],
  openingCuriosity: { firstSecondsDescription: "x", createsCuriosity: true, strongerHookAtOutputSec: -1, strongerHookEvidence: "" },
  finalSeconds: { visualDescription: "subject visible", subjectClearlyVisible: true, lastWordsHeard: "done.", endsAtCompleteBoundary: true },
  payoffFulfillsOpeningPromise: true,
  externalOverlays: { brandingVisible: false, burnedInSubtitlesVisible: false, promoGraphicVisible: false, evidence: "", regions: [] } };
const critique = raw => Critic.normalizeCritique(raw, { durationSec: total, timeline });
const accept = (c, extra = {}) => Director.acceptanceReport(spine, { config: R, durationSec: SOURCE_SEC, scriptSegments: segments, renderedDurationSec: total, critique: c, ...extra });

// 0. Baseline: a clean critic + clean ending boundary is ACCEPTED; ending window via purposes[].
const clean = critique(rawPass);
assert.strictEqual(clean.isCompliant, true, JSON.stringify(clean.issues));
const v = Director.validateDirectorEdl(spine, scope, { durationSec: SOURCE_SEC, ...R, reel });
assert.ok(!v.violations.some(x => x.code === "ENDING_NOT_IN_SCOPE"), "an ending_material purpose on a core window counts as an ending");
assert.strictEqual(accept(clean).status, ACCEPTANCE.ACCEPTED, JSON.stringify(accept(clean).editorial));

// 1. Routine opening displacing a stronger verified hook.
const buried = critique({ ...rawPass, openingCuriosity: { ...rawPass.openingCuriosity, strongerHookAtOutputSec: 25, strongerHookEvidence: "the sharpest line of the edit" } });
assert.strictEqual(buried.isCompliant, false);
const hookRegion = buried.weakRegions.find(r => r.type === "stronger_hook_buried");
assert.ok(hookRegion && hookRegion.beatIds.includes("b1") && hookRegion.beatIds.includes("b2"), "repair region names the opening and the buried hook");
assert.ok(accept(buried).editorial.readiness.findings.some(f => f.code === "STRONGER_HOOK_BURIED"));
assert.notStrictEqual(accept(buried).status, ACCEPTANCE.ACCEPTED);

// 2. Long low-information stretch (static/blocked picture) is a blocking finding when reported so,
//    and an ending the critic calls a low-value stretch is not a payoff even if only 'minor'.
const stat = critique({ ...rawPass, issues: [{ type: "low_information_footage", severity: "blocking", outputStartSec: 24, outputEndSec: 34, evidence: "static dashboard", whyItFails: "no new information" }] });
assert.strictEqual(stat.isCompliant, false);
const draggingEnd = critique({ ...rawPass, issues: [{ type: "low_value_stretch", severity: "minor", outputStartSec: total - 14, outputEndSec: total, evidence: "repeats excuses", whyItFails: "conflict already resolved" }] });
assert.strictEqual(draggingEnd.isCompliant, false, "a minor low-value stretch on the final beat still fails the payoff");
assert.ok(draggingEnd.weakRegions.some(r => r.type === "payoff_unsatisfying" && r.beatIds.includes("b4")));

// 3. Ending that cuts a speaker mid-sentence: deterministic from the transcript, even
//    when the critic said PASS; a cut in a pause is fine.
const cues = [{ startSec: 457.5, endSec: 460.0, text: "and then the other person said something important" }];
const midLine = accept(clean, { transcriptCues: cues });
assert.strictEqual(midLine.technical.verdict, "PASS");
assert.strictEqual(midLine.status, ACCEPTANCE.NEEDS_EDITORIAL_REVIEW);
assert.ok(midLine.editorial.readiness.findings.some(f => f.code === "ENDING_MID_UTTERANCE"));
assert.strictEqual(accept(clean, { transcriptCues: [{ startSec: 450, endSec: 458.2, text: "a finished line." }] }).status, ACCEPTANCE.ACCEPTED, "caption timing slack is tolerated");
assert.strictEqual(accept(clean, { transcriptCues: [{ startSec: 457.5, endSec: 461, text: "Alright. But if you have nothing else then we are done here" }] }).status, ACCEPTANCE.ACCEPTED,
  "a rolling caption that merges two sentences does not flag a cut after the first one");
const criticHeardCut = critique({ ...rawPass, finalSeconds: { ...rawPass.finalSeconds, lastWordsHeard: "I know you", endsAtCompleteBoundary: false } });
assert.ok(criticHeardCut.weakRegions.some(r => r.type === "ending_cuts_mid_line"));

// 4. Technically valid EDL with an unsatisfying or missing payoff.
const noPayoff = critique({ ...rawPass, payoffFulfillsOpeningPromise: false });
assert.strictEqual(noPayoff.isCompliant, false);
const aNoPayoff = accept(noPayoff);
assert.strictEqual(aNoPayoff.technical.verdict, "PASS", "technically valid");
assert.strictEqual(aNoPayoff.status, ACCEPTANCE.NEEDS_EDITORIAL_REVIEW, "but not editorially ready");

// 5. Source footage with embedded external branding / subtitles / promo graphics.
const branded = critique({ ...rawPass, externalOverlays: { brandingVisible: true, burnedInSubtitlesVisible: true, promoGraphicVisible: false, evidence: "channel watermark", regions: [] } });
assert.strictEqual(branded.isCompliant, true, "a watermark across the source is not an EDL defect");
const aBranded = accept(branded);
assert.strictEqual(aBranded.status, ACCEPTANCE.NEEDS_EDITORIAL_REVIEW, "but the output is not publish-ready");
assert.deepStrictEqual(aBranded.presentation.findings.map(f => f.code).sort(), ["SOURCE_BRANDING_VISIBLE", "SOURCE_SUBTITLES_VISIBLE"]);
const promo = critique({ ...rawPass, externalOverlays: { brandingVisible: false, burnedInSubtitlesVisible: false, promoGraphicVisible: true, evidence: "subscribe button", regions: [{ outputStartSec: 60, outputEndSec: 63, kind: "promo_graphic" }] } });
assert.ok(promo.weakRegions.some(r => r.type === "external_overlay" && r.beatIds.includes("b3")), "a promo graphic is a repairable footage choice");
assert.ok(/burned into the source picture by someone else/.test(Critic.buildPrompt(spine, timeline, total)), "the critic is asked to report third-party overlays");

// 6. Source Story Model timing: impossible times are dropped and drift is detected.
const tcues = [
  { startSec: 40, endSec: 43, text: "you are not going to believe this one" },
  { startSec: 120, endSec: 124, text: "please put the phone down right now" },
  { startSec: 250, endSec: 254, text: "that is not how any of this works" },
  { startSec: 400, endSec: 404, text: "we are finished talking about it" }];
const quotes = (k) => [["q1", "You are not going to believe this one.", 40], ["q2", "Please put the phone down right now.", 120], ["q3", "That is not how any of this works.", 250], ["q4", "We are finished talking about it.", 400]]
  .map(([id, text, t]) => ({ id, text, startSec: t * k, endSec: t * k + 2 }));
const ev = (id, s, e) => ({ id, startSec: s, endSec: e, summary: "x" });
const drifted = SM.normalize({ events: [ev("e1", 30, 60), ev("e2", 610, 700)], quotes: quotes(1.6) }, { duration: SOURCE_SEC, cues: tcues });
assert.ok(drifted.events.every(e => e.startSec < SOURCE_SEC && e.endSec > e.startSec), "no event beyond the source and no inverted range");
assert.ok(drifted.timingAudit.outOfBoundsDropped.some(x => x.kind === "event"));
assert.strictEqual(drifted.timingAudit.reliable, false, JSON.stringify(drifted.timingAudit));
const good = SM.normalize({ events: [ev("e1", 30, 60)], quotes: quotes(1) }, { duration: SOURCE_SEC, cues: tcues });
assert.strictEqual(good.timingAudit.reliable, true);
assert.strictEqual(good.timingAudit.anchorCount, 4);
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-timing-"));
  await SM.persist(dir, { ...drifted, timingAudit: undefined });
  const miss = await SM.loadWithReason(dir, { cues: tcues, duration: SOURCE_SEC });
  assert.strictEqual(miss.model, null);
  assert.ok(/timing_unreliable/.test(miss.reason), miss.reason);
  await SM.persist(dir, good);
  assert.ok((await SM.loadWithReason(dir, { cues: tcues, duration: SOURCE_SEC })).model, "a consistent model is still a cache hit");
  assert.strictEqual(SM.selectStrategy(SOURCE_SEC, { modelVersion: SM.MODEL_VERSION, whole: "TIMING_UNRELIABLE" }).mode, "chunk-first");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("editorialReadiness tests passed");
})().catch(e => { console.error(e); process.exit(1); });
