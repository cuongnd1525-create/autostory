const assert = require("assert");

const {
  validateCandidateMap,
  groupCandidatesForReels,
  mapReelTranscript,
  buildAssemblyPrompt,
  buildVisualMomentUnits
} = require("../electron/services/podcastCandidateService");

const sourceMap = {
  sourceMatchId: "podcast-source-1",
  localDurationSec: 600,
  dialogueUnitCount: 120,
  dialogueUnitPartCount: 2
};
const accessAudit = {
  accessGranted: true,
  accessMode: "transcript_locked",
  transcriptCoverageVerified: true,
  dialogueUnitsParsed: true,
  dialogueUnitPartsParsed: true,
  dialogueUnitCountVerified: true,
  sourceMapParsed: true,
  sourceMatchVerified: true
};
const candidatePayload = {
  artifactType: "podcast_candidate_map",
  sourceMatchId: sourceMap.sourceMatchId,
  accessAudit,
  candidates: [
    {
      candidateId: "candidate_001",
      sourceSpans: [
        {
          spanId: "candidate_001_span_01",
          editorialRole: "hook",
          sourceStartSec: 10,
          sourceEndSec: 20
        },
        {
          spanId: "candidate_001_span_02",
          editorialRole: "payoff",
          sourceStartSec: 30,
          sourceEndSec: 50
        }
      ],
      primaryTrigger: "visual_action",
      sceneScore: 9,
      hookQuote: "Can you take the makeup off?",
      payoff: "The guest reveals the result.",
      mustIncludeMoments: [{
        momentId: "candidate_001_moment_01",
        role: "visual_payoff",
        sourceStartSec: 30,
        sourceEndSec: 36,
        description: "The guest physically removes the makeup."
      }]
    },
    {
      candidateId: "candidate_002",
      sourceStartSec: 200,
      sourceEndSec: 250,
      primaryTrigger: "controversial_hot_take",
      sceneScore: 8.5,
      hookQuote: "Do it.",
      payoff: "The challenge begins.",
      mustIncludeMoments: [{
        momentId: "candidate_002_moment_01",
        role: "dialogue_payoff",
        momentType: "dialogue",
        sourceStartSec: 244,
        sourceEndSec: 249,
        description: "The speaker delivers the conclusion."
      }]
    }
  ]
};

const validated = validateCandidateMap(candidatePayload, sourceMap, 2);
assert.strictEqual(validated.candidates.length, 2);
assert.strictEqual(validated.candidates[0].durationSec, 30);
assert.strictEqual(validated.candidates[0].temporalCoverageSec, 40);
assert.strictEqual(validated.candidates[0].sourceSpans.length, 2);
const visualUnits = buildVisualMomentUnits(validated.candidates);
assert.strictEqual(visualUnits.length, 2);
assert.strictEqual(visualUnits[0].dialogueUnitId, "visual_candidate_001_01");
assert.strictEqual(visualUnits[0].unitType, "visual_moment");
assert.strictEqual(visualUnits[1].unitType, "required_moment");
assert.throws(
  () => validateCandidateMap(candidatePayload, sourceMap, 2, 45),
  /không đủ dựng một output tối thiểu 45s/
);
assert.throws(
  () => validateCandidateMap({ ...candidatePayload, sourceMatchId: "wrong" }, sourceMap, 2),
  /sourceMatchId khác/
);
assert.throws(
  () => validateCandidateMap({ ...candidatePayload, candidates: candidatePayload.candidates.slice(0, 1) }, sourceMap, 2),
  /cần ít nhất 2/
);
assert.throws(
  () => validateCandidateMap({
    ...candidatePayload,
    candidates: [{ ...candidatePayload.candidates[0], mustIncludeMoments: [] }]
  }, sourceMap, 1),
  /thiếu mustIncludeMoments/
);
assert.throws(
  () => validateCandidateMap({
    ...candidatePayload,
    candidates: [{
      ...candidatePayload.candidates[0],
      mustIncludeMoments: [{
        momentId: "candidate_001_moment_01",
        role: "visual_payoff",
        sourceStartSec: 24,
        sourceEndSec: 26
      }]
    }]
  }, sourceMap, 1),
  /phải nằm trong candidate/
);

const groups = groupCandidatesForReels([
  { candidateId: "a", durationSec: 300 },
  { candidateId: "b", durationSec: 300 },
  { candidateId: "c", durationSec: 120 }
], 540);
assert.deepStrictEqual(groups.map((group) => group.map((item) => item.candidateId)), [["a"], ["b", "c"]]);

const mapped = mapReelTranscript([], {
  segments: [{
    start: 29.7,
    end: 30.3,
    words: [
      { word: "ending", start: 29.7, end: 29.95 },
      { word: "beginning", start: 30.05, end: 30.3 }
    ]
  }]
}, [
  { candidateId: "candidate_001", sourceStartSec: 10, durationSec: 30, reelStartSec: 0, reelEndSec: 30 },
  { candidateId: "candidate_002", sourceStartSec: 200, durationSec: 50, reelStartSec: 30, reelEndSec: 80 }
]);
assert.strictEqual(mapped.cues.length, 2);
assert.strictEqual(mapped.cues[0].candidateId, "candidate_001");
assert.strictEqual(mapped.cues[1].candidateId, "candidate_002");
assert.ok(mapped.cues[0].endSec <= 40);
assert.ok(mapped.cues[1].startSec >= 200);

const assemblyPrompt = buildAssemblyPrompt({
  outputCount: 3,
  targetMinSec: 45,
  targetMaxSec: 60,
  sourceMap,
  candidateMap: candidatePayload,
  reelFiles: ["candidate-reel-part-01.mp4"]
});
assert.ok(assemblyPrompt.includes("PODCAST VIRAL ASSEMBLY / PASS 2"));
assert.ok(assemblyPrompt.includes("strongest Hook -> minimum necessary context"));
assert.ok(assemblyPrompt.includes('"accessMode": "candidate_reel"'));
assert.ok(assemblyPrompt.includes("exactly 3 independent Markdown json code blocks"));
assert.ok(assemblyPrompt.includes("RENDERING BOUNDARY - SUPREME"));
assert.ok(assemblyPrompt.includes("NEVER request the original full video, an FFmpeg command"));
assert.ok(assemblyPrompt.includes("Rendering preferences are NEVER a valid reason to stop"));
assert.ok(assemblyPrompt.includes("REQUIRED STORY MOMENT LOCK"));
assert.ok(assemblyPrompt.includes("NON-LINEAR RETENTION TEST"));
assert.ok(assemblyPrompt.includes('"promisePayoffAudit"'));

console.log("podcast candidate service tests passed");
