// Hook authority regressions: automatic (radar) hook candidates are advisory hints,
// only a hook a person locked is a mandate, and radar labels never claim events
// nobody watched. Cases are generic (no source-specific names/times/quotes).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseSrtCues, mineHookCandidateRegions } = require("../electron/services/hookMiningService");
const HookAuditionService = require("../electron/services/hookAuditionService");
const { buildHookContract, injectHookContractToPrompt } = require("../electron/services/hookContractService");
const { buildSeriesPlanPrompt } = require("../electron/services/manualAntigravityStage1Service");

const SERIES_BASE = "- prompt_profile: viral_tiktok_crime_part1\nDIRECT HIGHLIGHT CONTENT RULES:\n- Watch the complete video input";
const PLAIN_BASE = "DIRECT HIGHLIGHT CONTENT RULES:\n- Watch the complete video input";
const srt = (rows) => rows.map(([a, b, t], i) => `${i + 1}\n${a} --> ${b}\n${t}\n`).join("\n");
const SEMANTIC_CLAIM = /barricad|struggles with|draws weapon|denies obvious|not my child/i;

async function audition(cuesText, actionCandidates, durationSec) {
  return new HookAuditionService().audition({ transcriptCues: parseSrtCues(cuesText), actionCandidates, durationSec, topCount: 5 });
}

async function run() {
  // 1. Roadside encounter: car-door commands + a motion spike. The radar may find it,
  //    but it must not call it a barricade, and the auto contract must stay advisory.
  const roadside = await audition(srt([
    ["00:00:40,000", "00:00:43,000", "Officer: Ma'am, open the door and step out of the car."],
    ["00:00:44,000", "00:00:47,000", "Driver: Why? I didn't do anything."]
  ]), [{ sourceStartSec: 38, sourceEndSec: 50, motionScore: 8.2, audioEnergyScore: 6.1 }], 600);
  assert.ok(roadside.success && roadside.topCandidates.length, "roadside radar still discovers candidates");
  for (const c of roadside.topCandidates) {
    assert.ok(!SEMANTIC_CLAIM.test(`${c.title} ${c.archetype} ${c.coreEventDescription} ${c.rationale}`), `no unverified semantic claim: ${c.title} / ${c.archetype} / ${c.coreEventDescription}`);
    assert.strictEqual(c.semanticStatus, "unverified");
    assert.strictEqual(c.provenance, "deterministic_radar");
  }
  const best = roadside.defaultRecommendedHook;
  assert.ok(/^Transcript: "/.test(best.title), "title quotes only the matched transcript words");

  const autoContract = buildHookContract({ candidate: best, isUserLocked: false });
  assert.strictEqual(autoContract.isUserLocked, false);
  assert.strictEqual(autoContract.storyDirectives.authority, "advisory");
  assert.ok(!/Must be the opening beat/i.test(JSON.stringify(autoContract)), "advisory contract file carries no Beat 1 mandate");
  const autoSeries = injectHookContractToPrompt(SERIES_BASE, autoContract);
  assert.ok(autoSeries.includes("SERIES HOOK CONTRACT (AUTOMATIC RADAR CANDIDATES - ADVISORY, NOT USER-LOCKED)"));
  assert.ok(!/USER-LOCKED ANCHORS|Mandate:|MUST open/i.test(autoSeries), "auto candidate is never presented as a user mandate");
  assert.ok(/chronological opening and a teaser-then-rewind are both valid/.test(autoSeries), "both opening strategies stay allowed");
  const autoPlain = injectHookContractToPrompt(PLAIN_BASE, autoContract);
  assert.ok(autoPlain.includes("HOOK CONTRACT (AUTOMATIC RADAR CANDIDATES - ADVISORY, NOT USER-LOCKED)"));
  assert.ok(!/USER-LOCKED EDITORIAL ANCHOR|SCRIPT 1 MUST use this event|BEAT 1 \(HOOK\): 0/.test(autoPlain), "no forced Beat 1 / fixed structure for auto candidates");

  // 2. Default contract authority is advisory: a caller must opt in to a lock.
  assert.strictEqual(buildHookContract({ candidate: best }).isUserLocked, false);

  // 3. Genuine barricaded-door incident: radar still finds it; when a PERSON locks it,
  //    the mandate and the user's own range/title are preserved.
  const door = await audition(srt([
    ["00:02:00,000", "00:02:03,000", "Officer: Open the door now or we will force entry!"],
    ["00:02:03,500", "00:02:06,000", "Resident: I am not opening this door!"]
  ]), [{ sourceStartSec: 118, sourceEndSec: 130, motionScore: 9, audioEnergyScore: 8 }], 600);
  const doorHit = door.topCandidates.find((c) => c.sourceStartSec <= 121 && c.sourceEndSec >= 124);
  assert.ok(doorHit, "a real door standoff is still discovered");
  assert.ok(/not opening this door/i.test(doorHit.keyDialogue), "evidence dialogue preserved verbatim");
  const lockedCandidate = { ...doorHit, title: "Resident refuses to open the door" }; // human-written title
  const locked = buildHookContract({ candidate: lockedCandidate, userAnchorRange: { startSec: 119.5, endSec: 128 }, isUserLocked: true });
  assert.strictEqual(locked.storyDirectives.authority, "user_locked");
  const lockedSeries = injectHookContractToPrompt(SERIES_BASE, locked);
  assert.ok(lockedSeries.includes("SERIES HOOK CONTRACT (USER-LOCKED ANCHORS FOR ONE 3-PART STORY)"));
  assert.ok(lockedSeries.includes("Mandate: Script 1 Beat 1 MUST open with this anchor."));
  assert.ok(lockedSeries.includes("119.500s - 128.000s") && lockedSeries.includes("Resident refuses to open the door"));
  const lockedPlain = injectHookContractToPrompt(PLAIN_BASE, locked);
  assert.ok(lockedPlain.includes("HOOK CONTRACT (USER-LOCKED EDITORIAL ANCHOR)") && lockedPlain.includes("SCRIPT 1 MUST use this event"));

  // 4. Motion-only spike: location only, no event description.
  const spikeOnly = mineHookCandidateRegions({ actionCandidates: [{ sourceStartSec: 200, sourceEndSec: 212, motionScore: 9.5, audioEnergyScore: 9 }], durationSec: 600 });
  assert.strictEqual(spikeOnly[0].triggerType, "action_radar");
  assert.ok(!SEMANTIC_CLAIM.test(`${spikeOnly[0].archetype} ${spikeOnly[0].coreEventDescription}`));
  const spikeAud = await audition("", [{ sourceStartSec: 200, sourceEndSec: 212, motionScore: 9.5, audioEnergyScore: 9 }], 600);
  assert.ok(/^Motion\/audio spike at 03:20$/.test(spikeAud.topCandidates[0].title), spikeAud.topCandidates[0].title);

  // 5. A late (consequence-like) moment is scored for spoiler risk but never removed.
  const late = mineHookCandidateRegions({ actionCandidates: [{ sourceStartSec: 560, sourceEndSec: 572, motionScore: 9, audioEnergyScore: 9 }], durationSec: 600 });
  assert.strictEqual(late.length, 1, "late footage stays available as a candidate");
  assert.ok(late[0].scores.spoiler_risk > 50);

  // 6. Series Plan prompt follows the stored lock.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-authority-"));
  const series = { profile: "viral_tiktok_crime_part1", durationMinSec: 65, durationMaxSec: 90,
    parts: [{ scriptId: 1, partNumber: 1, partBadge: "PART 1", name: "A", scope: "a", ending: "cliffhanger" }] };
  const autoPath = path.join(tmp, "auto.json"); fs.writeFileSync(autoPath, JSON.stringify(autoContract));
  const lockPath = path.join(tmp, "lock.json"); fs.writeFileSync(lockPath, JSON.stringify(locked));
  const planAuto = buildSeriesPlanPrompt({ series, understandingPath: "u.json", hookContractPath: autoPath, hookContractUserLocked: false });
  assert.ok(/automatic radar candidates, NOT user-locked/.test(planAuto) && !/must be its variant_01 anchor/.test(planAuto));
  const planLocked = buildSeriesPlanPrompt({ series, understandingPath: "u.json", hookContractPath: lockPath, hookContractUserLocked: true });
  assert.ok(/user-locked hook anchors/.test(planLocked) && /must be its variant_01 anchor/.test(planLocked));
  fs.rmSync(tmp, { recursive: true, force: true });

  // 7. No source-specific hook text in production hook code.
  for (const f of ["hookMiningService.js", "hookAuditionService.js", "hookContractService.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron", "services", f), "utf8");
    assert.ok(!/repeatedly struggles with barricaded door|That's not my child|96 mph|rim grinding|passenger\/pet/i.test(src), `${f} has no case-specific hook text`);
  }
  console.log("hookAuthority tests passed");
}

run().catch((err) => { console.error(err); process.exit(1); });
