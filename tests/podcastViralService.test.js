const assert = require("assert");

const {
  parseSrt,
  buildDialogueUnits,
  buildCompactDialogueParts,
  buildPrompt,
  buildCandidateScoutPrompt,
  compilePodcastEdl,
  YOUTUBE_ENGLISH_SUBTITLE_TIERS
} = require("../electron/services/podcastViralService");

assert.deepStrictEqual(
  YOUTUBE_ENGLISH_SUBTITLE_TIERS.map((tier) => `${tier.automatic ? "auto" : "author"}:${tier.languageCode}`),
  ["author:en", "auto:en-orig", "auto:en"]
);

const cues = parseSrt(`1
00:00:01,000 --> 00:00:03,000
Host: Can you can you take the makeup off?

2
00:00:08,000 --> 00:00:10,500
Guest: Oh, that's right.

3
00:04:36,000 --> 00:04:38,000
Guest: This is it.
`);

assert.strictEqual(cues.length, 3);
assert.strictEqual(cues[2].startSec, 276);

const units = buildDialogueUnits(cues, { cleanupMode: "balanced" });
assert.strictEqual(units.length, 3);
assert.strictEqual(units[0].speaker, "host");
assert.ok(units[0].cutOptions.some((option) => option.cutOptionId.endsWith("_tight")));

const sourceMap = {
  sourceMatchId: "source-match-1",
  localDurationSec: 500
};
const unitsPayload = { dialogueUnits: units };
const accessAudit = {
  accessGranted: true,
  accessMode: "transcript_locked",
  youtubeUrlOpened: false,
  completeVideoReviewed: false,
  transcriptCoverageVerified: true,
  dialogueUnitsParsed: true,
  dialogueUnitPartsParsed: true,
  dialogueUnitCountVerified: true,
  sourceMapParsed: true,
  sourceMatchVerified: true
};
const payload = {
  artifactType: "podcast_edit_decision_list",
  schemaVersion: 1,
  workflow: "podcast_viral_cut",
  sourceMatchId: sourceMap.sourceMatchId,
  outputIndex: 1,
  outputCount: 2,
  title: "Makeup Reveal",
  targetDurationSec: 7,
  centralViewerQuestion: "Will the reveal change anything?",
  hookPromise: "The makeup comes off.",
  editingPattern: "selective_semantic_reorder",
  viralSelectionAudit: {
    primaryTrigger: "visual_action",
    sceneScore: 9,
    scrollStopReason: "The guest accepts a live reveal challenge.",
    verifiedHookQuote: "Can you take the makeup off?",
    visualEvidence: "",
    payoff: "The reveal closes the scene."
  },
  accessAudit,
  selections: [
    {
      selectionId: "selection_001",
      assemblyOrder: 1,
      narrativeBlock: "hook",
      dialogueUnitId: units[0].dialogueUnitId,
      cutOptionId: units[0].cutOptions[0].cutOptionId,
      chronologyChanged: false,
      stateCompatible: true,
      referentClear: true,
      transitionScore: 10
    },
    {
      selectionId: "selection_002",
      assemblyOrder: 2,
      narrativeBlock: "payoff",
      dialogueUnitId: units[2].dialogueUnitId,
      cutOptionId: units[2].cutOptions[0].cutOptionId,
      chronologyChanged: true,
      stateCompatible: true,
      referentClear: true,
      transitionScore: 8.5,
      transitionReason: "The final reaction closes the reveal."
    }
  ]
};

const compiled = compilePodcastEdl(payload, unitsPayload, sourceMap);
assert.strictEqual(compiled.artifactType, "highlight_cut_script");
assert.strictEqual(compiled.workflow, "podcast_viral_cut");
assert.strictEqual(compiled.segments.length, 2);
assert.strictEqual(compiled.segments[0].audio_mode, "original_audio");
assert.strictEqual(compiled.segments[0].startSec, 0);
assert.strictEqual(compiled.segments[1].startSec, compiled.segments[0].endSec);
assert.strictEqual(compiled.segments[1].sourceStartSec, 276);
assert.strictEqual(compiled.viralSelectionAudit.sceneScore, 9);

const fallbackCompiled = compilePodcastEdl({
  ...payload,
  targetDurationSec: 2,
  selections: [{
    ...payload.selections[1],
    selectionId: "selection_fallback",
    assemblyOrder: 1,
    cutOptionId: `${units[2].dialogueUnitId}_aggressive`,
    chronologyChanged: false
  }]
}, unitsPayload, sourceMap);
assert.strictEqual(fallbackCompiled.segments[0].cutOptionId, `${units[2].dialogueUnitId}_full`);
assert.ok(fallbackCompiled._toolValidationWarnings.some((warning) => warning.includes("tool tự dùng")));

assert.throws(() => compilePodcastEdl({ ...payload, accessAudit: { ...accessAudit, transcriptCoverageVerified: false } }, unitsPayload, sourceMap), /transcriptCoverageVerified/);
assert.doesNotThrow(() => compilePodcastEdl({
  ...payload,
  accessAudit: {
    ...accessAudit,
    accessMode: "full_multimodal",
    youtubeUrlOpened: true,
    completeVideoReviewed: true,
    transcriptCoverageVerified: false
  }
}, unitsPayload, sourceMap));

const visualUnit = {
  dialogueUnitId: "visual_candidate_001_01",
  unitType: "visual_moment",
  required: true,
  visualMomentId: "candidate_001_moment_01",
  candidateId: "candidate_001",
  sourceStartSec: 20,
  sourceEndSec: 24,
  transcriptText: "[VISUAL PAYOFF - MUST INCLUDE] The guest removes makeup.",
  cutOptions: [{
    cutOptionId: "visual_candidate_001_01_full",
    sourceSpans: [{ startSec: 20, endSec: 24 }],
    resultText: "[VISUAL PAYOFF - MUST INCLUDE] The guest removes makeup.",
    durationSec: 4
  }]
};
const twoPassPayload = {
  ...payload,
  workflow: "podcast_viral_cut_two_pass",
  outputCount: 1,
  outputIndex: 1,
  accessAudit: {
    ...accessAudit,
    accessMode: "candidate_reel",
    candidateReelReviewed: true,
    transcriptCoverageVerified: false
  },
  candidateIds: ["candidate_001"],
  assemblyBlueprint: {
    visualPayoffUnitId: visualUnit.dialogueUnitId,
    requiredMomentUnitIds: [visualUnit.dialogueUnitId]
  },
  promisePayoffAudit: {
    hookPromiseResolved: true,
    payoffObservedInReel: true,
    observedEvidence: "The guest visibly removes the makeup in the candidate reel.",
    requiredMomentUnitIdsVerified: [visualUnit.dialogueUnitId],
    missingRequiredMomentIds: []
  },
  selections: [
    payload.selections[0],
    {
      selectionId: "selection_visual",
      assemblyOrder: 2,
      narrativeBlock: "payoff",
      dialogueUnitId: visualUnit.dialogueUnitId,
      cutOptionId: visualUnit.cutOptions[0].cutOptionId,
      chronologyChanged: false,
      transitionScore: 10
    }
  ]
};
assert.doesNotThrow(() => compilePodcastEdl(twoPassPayload, {
  dialogueUnits: [...units, visualUnit]
}, sourceMap));
assert.throws(() => compilePodcastEdl({
  ...twoPassPayload,
  selections: [payload.selections[0]]
}, { dialogueUnits: [...units, visualUnit] }, sourceMap), /chưa chọn action\/reveal\/reaction\/payoff/);
assert.throws(() => compilePodcastEdl({
  ...twoPassPayload,
  assemblyBlueprint: { visualPayoffUnitId: visualUnit.dialogueUnitId }
}, { dialogueUnits: [...units, visualUnit] }, sourceMap), /thiếu requiredMomentUnitIds/);
assert.throws(() => compilePodcastEdl({
  ...twoPassPayload,
  promisePayoffAudit: {
    ...twoPassPayload.promisePayoffAudit,
    payoffObservedInReel: false
  }
}, { dialogueUnits: [...units, visualUnit] }, sourceMap), /Promise\/Payoff gate/);
assert.throws(() => compilePodcastEdl({
  ...payload,
  accessAudit: { ...accessAudit, accessMode: "full_multimodal", youtubeUrlOpened: false }
}, unitsPayload, sourceMap), /full_multimodal/);
assert.throws(() => compilePodcastEdl({ ...payload, sourceMatchId: "wrong" }, unitsPayload, sourceMap), /sourceMatchId khác/);
assert.throws(() => compilePodcastEdl({ ...payload, outputCount: 6 }, unitsPayload, sourceMap), /outputCount không hợp lệ/);
assert.throws(() => compilePodcastEdl({ ...payload, outputIndex: 3 }, unitsPayload, sourceMap), /outputIndex 3 nằm ngoài/);
assert.throws(() => compilePodcastEdl({
  ...payload,
  selections: [{ ...payload.selections[1], stateCompatible: false }]
}, unitsPayload, sourceMap), /continuity gate chưa đạt/);

const prompt = buildPrompt({
  youtubeUrl: "https://www.youtube.com/watch?v=test",
  outputCount: 5,
  targetMinSec: 60.5,
  targetMaxSec: 90,
  cleanupMode: "balanced",
  sourceMap: {
    ...sourceMap,
    dialogueUnitCount: units.length,
    dialogueUnitPartCount: 1
  }
});
assert.ok(prompt.includes("Exactly 5 separate EDL JSON objects"));
assert.ok(prompt.includes("VERIFIED INPUT ACCESS GATE"));
assert.ok(prompt.includes("FAIL CLOSED - NEVER GUESS"));
assert.ok(prompt.includes("transcript_locked"));
assert.ok(prompt.includes("Do not request crop, aspect-ratio, or auto-cropping parameters"));
assert.ok(prompt.includes('artifactType="podcast_input_access_failure"'));
assert.ok(prompt.includes("Do NOT write sourceStartSec/sourceEndSec/startSec/endSec/playbackSpeed"));
assert.ok(prompt.includes("VIRAL SCENE-MINING METHOD"));
assert.ok(prompt.includes("Visual & Action Trigger"));
assert.ok(prompt.includes("High-Tension / Raw Emotion"));
assert.ok(prompt.includes("Controversial Hot Take"));
assert.ok(prompt.includes('"viralSelectionAudit"'));

const scoutPrompt = buildCandidateScoutPrompt({
  youtubeUrl: "https://www.youtube.com/watch?v=test",
  outputCount: 3,
  targetMinSec: 45,
  targetMaxSec: 60,
  sourceMap: {
    ...sourceMap,
    dialogueUnitCount: units.length,
    dialogueUnitPartCount: 1
  }
});
assert.ok(scoutPrompt.includes("PODCAST VIRAL SCENE SCOUT"));
assert.ok(scoutPrompt.includes('artifactType must be "podcast_candidate_map"'));
assert.ok(scoutPrompt.includes("Do not build the final edit"));
assert.ok(scoutPrompt.includes("STORY CANDIDATE, NOT ONE CONTINUOUS WINDOW"));
assert.ok(scoutPrompt.includes('"schemaVersion": 2'));
assert.ok(scoutPrompt.includes('"sourceSpans"'));
assert.ok(scoutPrompt.includes("PROMISE-PAYOFF COVERAGE GATE"));
assert.ok(scoutPrompt.includes("at least 45s of useful selected sourceSpans"));

assert.doesNotThrow(() => compilePodcastEdl({
  ...payload,
  accessAudit: {
    ...accessAudit,
    accessMode: "candidate_reel",
    candidateReelReviewed: true,
    transcriptCoverageVerified: false
  }
}, unitsPayload, sourceMap));

const manyUnits = Array.from({ length: 3192 }, (_value, index) => ({
  ...units[index % units.length],
  dialogueUnitId: `dialogue_${String(index + 1).padStart(5, "0")}`,
  transcriptText: `Dialogue ${index + 1} with enough words to exercise compact Gemini upload partitioning.`,
  words: Array.from({ length: 20 }, (_word, wordIndex) => ({
    id: `word_${index}_${wordIndex}`,
    text: "word",
    startSec: index + wordIndex / 20,
    endSec: index + (wordIndex + 1) / 20
  })),
  contextBefore: "Repeated context must not be included in Gemini compact payloads.",
  contextAfter: "Repeated context must not be included in Gemini compact payloads."
}));
const compactParts = buildCompactDialogueParts(manyUnits, {
  sourceMatchId: "source-match-many",
  targetBytes: 100000
});
assert.ok(compactParts.length >= 2 && compactParts.length <= 7);
assert.strictEqual(compactParts.reduce((sum, part) => sum + part.dialogueUnitCount, 0), manyUnits.length);
assert.ok(compactParts.every((part, index) => part.partIndex === index + 1 && part.partCount === compactParts.length));
assert.ok(compactParts.every((part) => part.units.every((unit) => Array.isArray(unit) && unit.length === 6)));
assert.ok(compactParts.every((part) => part.units.every((unit) => typeof unit[0] === "string" && Array.isArray(unit[5]))));
assert.ok(compactParts.every((part) => Buffer.byteLength(JSON.stringify(part), "utf8") < 200000));

console.log("podcast viral service tests passed");
