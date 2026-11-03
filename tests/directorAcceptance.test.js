// V4 Director EDL acceptance: explicit ACCEPTED / REJECTED / NEEDS_EDITORIAL_REVIEW
// from the real beat sum, viewed media, duplicates, downstream order, rendered length
// and the media critic. Synthetic, case-neutral fixtures only.
const assert = require("assert");
const Director = require("../electron/services/editorialDirectorService");
const { ACCEPTANCE } = Director;

const SOURCE_SEC = 600;
const scope = {
  storyScopeId: "scope_test", targetDurationSec: 80,
  scopeWindows: [
    { windowId: "w1", startSec: 20, endSec: 120, purpose: "core" },
    { windowId: "w2", startSec: 200, endSec: 330, purpose: "core" },
    { windowId: "w3", startSec: 400, endSec: 470, purpose: "ending_material" }
  ],
  candidateEndingEvents: [{ sourceStartSec: 440, sourceEndSec: 470 }]
};
const reel = { storyScopeId: "scope_test", ranges: scope.scopeWindows.map((w, i) => ({
  reelFile: `reel_0${i + 1}`, sourceStartSec: w.startSec - 2, sourceEndSec: w.endSec + 2, windowStartSec: w.startSec, windowEndSec: w.endSec, scopeWindowId: w.windowId })) };
const beat = (id, s, e, role = "escalation") => ({ beatId: id, sourceStartSec: s, sourceEndSec: e, narrativeRole: role, observedInFootage: "seen and heard in range", whyNecessaryNow: "advances the question" });
const spineOf = beats => ({ editorialContract: Director.DIRECTOR_CONTRACT, storyScope: scope, scopeReel: reel, beats });
const segmentsOf = beats => beats.map(b => ({ beat_id: b.beatId, sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec, playbackSpeed: 1 }));
const pass = { isCompliant: true, scopeSurvived: true, centralQuestionActiveThroughout: true, endingIsConsequence: true, finalFootageUsable: true, issues: [] };
const sum = beats => beats.reduce((n, b) => n + b.sourceEndSec - b.sourceStartSec, 0);
const accept = (beats, cfg, extra = {}) => Director.acceptanceReport(spineOf(beats), {
  config: cfg, durationSec: SOURCE_SEC, scriptSegments: segmentsOf(beats), renderedDurationSec: sum(beats), critique: pass, ...extra });
const R6590 = { targetDurationMinSec: 65, targetDurationMaxSec: 90 };
const R65150 = { targetDurationMinSec: 65, targetDurationMaxSec: 150 };

// 1. A 122s, 9-beat EDL can never be accepted under a 65-90s hard range.
const long122 = [beat("b1", 35, 45, "cold_open_hook"), beat("b2", 45, 63), beat("b3", 63, 72), beat("b4", 210, 215), beat("b5", 215, 224),
  beat("b6", 260, 270), beat("b7", 270, 280), beat("b8", 280, 312), beat("b9", 445, 464, "resolution")];
assert.strictEqual(sum(long122), 122);
const a122 = accept(long122, R6590);
assert.strictEqual(a122.status, ACCEPTANCE.REJECTED);
assert.ok(a122.technical.violations.some(v => v.code === "TOTAL_DURATION_OVER_MAX"));
assert.strictEqual(a122.technical.timelineSec, 122, "duration is the real beat sum, not a declared target");
// The same EDL inside a configured 65-150s range is technically valid, and the
// preferred-band deviation is reported, not hidden and not used to reject.
const a122wide = accept(long122, R65150);
assert.strictEqual(a122wide.status, ACCEPTANCE.ACCEPTED, JSON.stringify(a122wide.technical.violations));
assert.strictEqual(a122wide.technical.insidePreferredBand, false);

// 2. Long complete beats are allowed (no per-beat ceiling, no beat-count rule).
const longBeats = [beat("b1", 30, 40, "cold_open_hook"), beat("b2", 40, 85), beat("b3", 440, 465, "resolution")];
assert.strictEqual(accept(longBeats, R6590).status, ACCEPTANCE.ACCEPTED, JSON.stringify(accept(longBeats, R6590).technical.violations));

// 3. Chronological and teaser-and-rewind stories are both acceptable.
const chrono = [beat("b1", 30, 42, "cold_open_hook"), beat("b2", 42, 70), beat("b3", 210, 240), beat("b4", 445, 460, "resolution")];
const teaser = [beat("b1", 300, 306, "teaser_conflict"), beat("b2", 30, 60, "rewind_context"), beat("b3", 210, 240), beat("b4", 445, 460, "resolution")];
for (const [name, b] of [["chronological", chrono], ["teaser-rewind", teaser]]) {
  const r = accept(b, R6590);
  assert.strictEqual(r.status, ACCEPTANCE.ACCEPTED, `${name}: ${JSON.stringify(r.technical.violations)}`);
}

// 4. Technical PASS is not an editorial PASS.
const weak = accept(chrono, R6590, { critique: { ...pass, isCompliant: false, issues: [{ severity: "blocking", type: "low_value_stretch" }] } });
assert.strictEqual(weak.technical.verdict, "PASS");
assert.strictEqual(weak.status, ACCEPTANCE.NEEDS_EDITORIAL_REVIEW);
const brokenPayoff = accept(chrono, R6590, { critique: { ...pass, endingIsConsequence: false } });
assert.strictEqual(brokenPayoff.status, ACCEPTANCE.NEEDS_EDITORIAL_REVIEW, "hook-to-payoff continuity failure is never accepted");
assert.strictEqual(accept(chrono, R6590, { critique: null }).status, ACCEPTANCE.NEEDS_EDITORIAL_REVIEW, "no critic verdict -> not accepted");

// 5. Unsupported footage and duplicates are rejected.
const outside = [beat("b1", 30, 42, "cold_open_hook"), beat("b2", 140, 180), beat("b3", 445, 470, "resolution")];
assert.ok(accept(outside, R6590).technical.violations.some(v => v.code === "OUTSIDE_SCOPE_REEL"));
const dup = [...chrono.slice(0, 3), { ...chrono[2], beatId: "b3dup" }, chrono[3]];
const aDup = accept(dup, R6590);
assert.strictEqual(aDup.status, ACCEPTANCE.REJECTED);
assert.ok(aDup.technical.violations.some(v => v.code === "EXACT_EDL_DUPLICATE"));

// 6. Downstream must keep the director's order and ranges.
const reordered = Director.acceptanceReport(spineOf(chrono), { config: R6590, durationSec: SOURCE_SEC, critique: pass,
  scriptSegments: segmentsOf([chrono[1], chrono[0], chrono[2], chrono[3]]), renderedDurationSec: sum(chrono) });
assert.strictEqual(reordered.status, ACCEPTANCE.REJECTED);
assert.strictEqual(reordered.technical.orderPreserved, false);

// 7. Rendered length must match the EDL: padding/truncation is surfaced, never accepted,
//    and the acceptance check never edits the EDL itself.
const before = JSON.stringify(chrono);
const padded = accept(chrono, R6590, { renderedDurationSec: sum(chrono) + 6 });
assert.strictEqual(padded.status, ACCEPTANCE.NEEDS_EDITORIAL_REVIEW);
assert.ok(padded.technical.renderViolations.some(v => v.code === "RENDER_DURATION_MISMATCH"));
assert.strictEqual(JSON.stringify(chrono), before, "acceptance is read-only");
assert.strictEqual(accept(chrono, R6590, { renderedDurationSec: sum(chrono) + 0.04 }).status, ACCEPTANCE.ACCEPTED, "container rounding tolerated");

// 8. Missing scope/reel provenance cannot be accepted.
const bare = Director.acceptanceReport({ beats: chrono }, { config: R6590, durationSec: SOURCE_SEC, critique: pass });
assert.strictEqual(bare.status, ACCEPTANCE.REJECTED);

console.log("directorAcceptance tests passed");
