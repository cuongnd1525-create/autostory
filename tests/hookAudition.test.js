const assert = require("assert");
const {
  parseSrtCues,
  findDialogueCandidates,
  mineHookCandidateRegions
} = require("../electron/services/hookMiningService");
const HookAuditionService = require("../electron/services/hookAuditionService");
const {
  buildHookContract,
  validateHookContract,
  injectHookContractToPrompt
} = require("../electron/services/hookContractService");

async function runTests() {
  console.log("Starting Hook Audition & Contract Tests...");

  // 1. Test SRT Cue Parsing
  const sampleSrt = `1
00:01:14,200 --> 00:01:17,500
Officer: Open the door right now!

2
00:01:17,800 --> 00:01:21,000
Suspect: I am not opening this door!

3
00:03:10,000 --> 00:03:13,200
Officer: Why is there a child in the trunk?

4
00:03:13,500 --> 00:03:16,000
Suspect: That's not my child!
`;

  const cues = parseSrtCues(sampleSrt);
  assert.strictEqual(cues.length, 4, "Should parse 4 cues");
  assert.strictEqual(cues[0].startSec, 74.2);
  assert.strictEqual(cues[0].endSec, 77.5);
  console.log("✓ SRT cue parsing passed");

  // 2. Test Dialogue Candidate Mining
  const dialogueHits = findDialogueCandidates(cues, 300);
  assert.strictEqual(dialogueHits.length, 2, "Should find 2 high-tension dialogue regions");
  
  // First region should be the door refusal
  const doorRegion = dialogueHits.find((h) => /door/i.test(h.keyDialogue));
  assert.ok(doorRegion, "Should find door confrontation region");
  assert.strictEqual(doorRegion.triggerType, "physical_friction");
  assert.ok(doorRegion.sourceStartSec < 74.2, "Should start slightly before cue");

  // Second region should be the shocking discovery in the trunk
  const trunkRegion = dialogueHits.find((h) => /trunk|child/i.test(h.keyDialogue));
  assert.ok(trunkRegion, "Should find trunk/child revelation region");
  assert.strictEqual(trunkRegion.triggerType, "shocking_discovery");
  console.log("✓ Dialogue candidate mining passed");

  // 3. Test mineHookCandidateRegions with Action Candidates
  const actionCandidates = [
    {
      actionCandidateId: "action_0001",
      sourceStartSec: 73.0,
      sourceEndSec: 85.0,
      motionScore: 8.5,
      audioEnergyScore: 7.2,
      actionPriorityScore: 8.8
    },
    {
      actionCandidateId: "action_0002",
      sourceStartSec: 150.0,
      sourceEndSec: 165.0,
      motionScore: 9.0,
      audioEnergyScore: 8.0,
      actionPriorityScore: 9.2
    }
  ];

  const mined = mineHookCandidateRegions({
    transcriptCues: cues,
    actionCandidates,
    durationSec: 300,
    maxCandidates: 10
  });

  assert.ok(mined.length >= 2, "Should mine candidates");
  const doorHybrid = mined.find((m) => m.sourceStartSec <= 75 && m.sourceEndSec >= 80);
  assert.ok(doorHybrid, "Should find merged door hybrid region");
  assert.ok(doorHybrid.scores.overall > 60, "Door hybrid should score highly");
  console.log("✓ Candidate regions mining and merging passed");

  // 4. Test HookAuditionService
  const auditionService = new HookAuditionService();
  const auditionResult = await auditionService.audition({
    transcriptCues: cues,
    actionCandidates,
    durationSec: 300,
    topCount: 3
  });

  assert.strictEqual(auditionResult.success, true);
  assert.ok(auditionResult.topCandidates.length >= 2, "Should return top candidates");
  const top1 = auditionResult.topCandidates[0];
  assert.ok(top1.scores.overall >= 50, "Top 1 should have high score");
  assert.ok(top1.rationale, "Top 1 should have rationale");
  console.log("✓ HookAuditionService passed:", top1.title, `(${top1.scores.overall}/100)`);

  // 5. Test HookContract
  const contract = buildHookContract({
    candidate: top1,
    userAnchorRange: { startSec: 74.0, endSec: 84.0 },
    trimmingTolerance: { startOffsetMaxSec: 2.0, endOffsetMaxSec: 3.0 }
  });

  assert.strictEqual(contract.anchorRange.startSec, 74.0);
  assert.strictEqual(contract.anchorRange.endSec, 84.0);
  assert.strictEqual(contract.trimmingTolerance.startOffsetMaxSec, 2.0);

  const validation = validateHookContract(contract, 300);
  assert.strictEqual(validation.valid, true, "Contract must be valid");
  console.log("✓ HookContract build and validate passed");

  // 6. Test Prompt Injection
  const mockBasePrompt = `DIRECT HIGHLIGHT CONTENT RULES:
- Write the final edit scripts directly from the video.`;

  const injected = injectHookContractToPrompt(mockBasePrompt, contract);
  assert.ok(injected.includes("HOOK CONTRACT (USER-LOCKED EDITORIAL ANCHOR"), "Must contain Hook Contract header");
  assert.ok(injected.includes("VIRAL NON-LINEAR STORYTELLING STRUCTURE:"), "Must contain Non-Linear Storytelling directives");
  assert.ok(injected.includes("BEAT 2 (REWIND / CONTEXT):"), "Must contain Rewind directive");
  assert.ok(injected.includes("74.000s - 84.000s"), "Must contain anchor range");
  // 7. Test Multi-Variant Hook Contract and Duplicate Divergence Protocol
  const candidateA = auditionResult.topCandidates[0];
  const candidateB = auditionResult.topCandidates[1] || candidateA;
  
  // Test with duplicates: Variant 1 & Variant 2 share candidateA, Variant 3 has candidateB
  const multiContractWithDup = buildHookContract({
    isMultiVariant: true,
    isUserLocked: true,
    variants: {
      variant_01: {
        scriptId: 1,
        variantName: "Variant 01",
        candidate: candidateA,
        userAnchorRange: { startSec: 74.0, endSec: 84.0 },
        trimmingTolerance: { startOffsetMaxSec: 2.0, endOffsetMaxSec: 3.0 }
      },
      variant_02: {
        scriptId: 3,
        variantName: "Variant 02",
        candidate: candidateA, // DUPLICATE!
        userAnchorRange: { startSec: 74.0, endSec: 84.0 },
        trimmingTolerance: { startOffsetMaxSec: 1.5, endOffsetMaxSec: 2.5 }
      },
      variant_03: {
        scriptId: 4,
        variantName: "Variant 03",
        candidate: candidateB,
        userAnchorRange: { startSec: 190.0, endSec: 202.0 },
        trimmingTolerance: { startOffsetMaxSec: 2.0, endOffsetMaxSec: 3.0 }
      }
    }
  });

  assert.strictEqual(multiContractWithDup.isMultiVariant, true, "Should be multi-variant");
  assert.strictEqual(multiContractWithDup.hasDuplicates, true, "Should detect duplicates between V1 and V2");
  const multiValidation = validateHookContract(multiContractWithDup, 300);
  assert.strictEqual(multiValidation.valid, true, "Multi-variant contract should be valid");

  const injectedMulti = injectHookContractToPrompt(mockBasePrompt, multiContractWithDup);
  assert.ok(injectedMulti.includes("HOOK CONTRACT (USER-LOCKED EDITORIAL ANCHORS FOR ALL 3 VARIANTS)"), "Must include 3-variant contract header");
  assert.ok(injectedMulti.includes("CRITICAL MANDATE: DUPLICATE HOOK DIVERGENCE PROTOCOL (ZERO OVERLAP RULE)"), "Must include Duplicate Divergence Protocol");
  assert.ok(injectedMulti.includes("ZERO DUPLICATE VOICEOVER LINES:"), "Must include Zero Duplicate VO rule");
  assert.ok(injectedMulti.includes("SCRIPT 1 (VARIANT 01) — Hook Anchor:"), "Must include Script 1 Anchor");
  assert.ok(injectedMulti.includes("SCRIPT 3 (VARIANT 02) — Hook Anchor:"), "Must include Script 3 Anchor");
  assert.ok(injectedMulti.includes("SCRIPT 4 (VARIANT 03) — Hook Anchor:"), "Must include Script 4 Anchor");
  console.log("✓ Multi-Variant Contract & Duplicate Divergence Protocol passed");

  console.log("\nALL HOOK AUDITION & CONTRACT TESTS PASSED SUCCESSFULLY! 🎉");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
