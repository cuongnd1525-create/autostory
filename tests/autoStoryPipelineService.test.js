const assert = require("assert");
const AutoStoryPipelineService = require("../electron/services/autoStoryPipelineService");

const config = AutoStoryPipelineService.normalizeConfig({
  targetDurationMinSec: 20,
  targetDurationMaxSec: 40,
  outputCount: 9,
  audioBalance: "balanced"
});
assert.strictEqual(config.targetDurationMinSec, 65);
assert.strictEqual(config.targetDurationMaxSec, 65);
assert.strictEqual(config.outputCount, 5);
assert.strictEqual(config.candidatePoolSize, 5);
assert.strictEqual(config.narration.muteSourceDuringNarration, true);

const canonical = {
  inputAccessAudit: { accessGranted: true },
  events: [
    { eventId: "event_1", start: 0, end: 35 },
    { eventId: "event_2", start: 40, end: 75 }
  ],
  causalLinks: [{ fromEventId: "event_1", toEventId: "event_2", relation: "CAUSES" }]
};
assert.strictEqual(AutoStoryPipelineService.validateCanonical(canonical, 80), canonical);

const completeBareEvents = [
  { eventId: "event_1", start: 0, end: 20, visualEvidence: "Officer approaches the vehicle." },
  { eventId: "event_2", start: 20, end: 80, audioEvidence: "Verified source dialogue continues." }
];
const completeCoverage = AutoStoryPipelineService.canonicalEventCoverage(completeBareEvents, 80);
assert.strictEqual(completeCoverage.complete, true);
assert.strictEqual(completeCoverage.coverageStartSec, 0);
assert.strictEqual(completeCoverage.coverageEndSec, 80);

const incompleteCoverage = AutoStoryPipelineService.canonicalEventCoverage([
  { eventId: "event_1", start: 20, end: 40, visualEvidence: "Only the middle was inspected." }
], 80);
assert.strictEqual(incompleteCoverage.complete, false);

const mergedAbsolute = AutoStoryPipelineService.mergeCanonicalContinuation(completeBareEvents, {
  events: [{ eventId: "tail", start: 78, end: 100, visualEvidence: "The final outcome is shown." }]
}, { chunkStartSec: 75, chunkDurationSec: 25, previousCoverageEndSec: 80, sourceDurationSec: 100 });
assert.strictEqual(mergedAbsolute.at(-1).end, 100);
assert.strictEqual(mergedAbsolute.at(-1).eventId, "event_3");

const mergedLocal = AutoStoryPipelineService.mergeCanonicalContinuation(completeBareEvents, {
  events: [{ eventId: "tail", start: 3, end: 25, audioEvidence: "The final outcome is heard." }]
}, { chunkStartSec: 75, chunkDurationSec: 25, previousCoverageEndSec: 80, sourceDurationSec: 100 });
assert.strictEqual(mergedLocal.at(-1).start, 78);
assert.strictEqual(mergedLocal.at(-1).end, 100);

assert.strictEqual(AutoStoryPipelineService.canonicalEventsNeedTimestampRepair([
  { eventId: "event_1", start: 0, end: 101 }
], 100), true);
const timestampRepaired = AutoStoryPipelineService.applyCanonicalTimestampRepair([
  { eventId: "event_1", start: 0, end: 101, title: "Keep this content" }
], { events: [{ eventId: "event_1", start: 10, end: 20 }] }, 100);
assert.strictEqual(timestampRepaired[0].start, 10);
assert.strictEqual(timestampRepaired[0].end, 20);
assert.strictEqual(timestampRepaired[0].title, "Keep this content");

const chunkMerged = AutoStoryPipelineService.mergeCanonicalChunk([
  { eventId: "event_1", start: 0, end: 70, visualEvidence: "Opening" },
  { eventId: "event_2", start: 70, end: 80, visualEvidence: "Overlap to replace" }
], {
  inputAccessAudit: { accessGranted: true },
  events: [{ eventId: "local_tail", start: 4, end: 25, visualEvidence: "Continued scene" }]
}, { chunkStartSec: 75, chunkEndSec: 100, sourceDurationSec: 100 });
assert.strictEqual(chunkMerged.length, 2);
assert.strictEqual(chunkMerged[1].start, 79);
assert.strictEqual(chunkMerged[1].end, 100);

const locked = { lockedStories: [{
  scriptId: 1,
  candidateId: "candidate_1",
  centralViewerQuestion: "What happened?",
  hookPromise: "The confrontation is resolved.",
  mandatoryEvents: ["event_1"],
  resolutionEventIds: ["event_2"],
  lockedSequence: [{ eventIds: ["event_1", "event_2"] }]
}] };
const validEdl = {
  inputAccessAudit: { accessGranted: true },
  scripts: [{
    scriptId: 1,
    title: "Test",
    segments: [
      { segmentId: "beat_001", eventId: "event_1", sourceStart: 0, sourceEnd: 35, playbackSpeed: 1, audioMode: "original_audio", voiceoverText: "" },
      { segmentId: "beat_002", eventId: "event_2", sourceStart: 40, sourceEnd: 50, playbackSpeed: 1, audioMode: "voiceover_only", voiceoverText: "Instead of stopping, the suspect makes one choice that turns a routine encounter into a much more serious and dangerous confrontation.", previewVi: "Thay vì dừng lại, nghi phạm đưa ra một lựa chọn khiến cuộc chạm trán trở nên nghiêm trọng và nguy hiểm hơn nhiều." },
      { segmentId: "beat_003", eventId: "event_2", sourceStart: 50, sourceEnd: 75, playbackSpeed: 1, audioMode: "original_audio", voiceoverText: "" }
    ]
  }]
};
const normalized = AutoStoryPipelineService.validateEdl(validEdl, canonical, locked, {
  targetDurationMinSec: 65,
  targetDurationMaxSec: 90,
  narration: { enabled: true }
}, 80);
assert.ok(normalized.scripts[0].durationSec >= 65 && normalized.scripts[0].durationSec <= 90);

const invalidNarrator = JSON.parse(JSON.stringify(validEdl));
invalidNarrator.scripts[0].segments[0].sourceNarratorDetected = true;
assert.throws(() => AutoStoryPipelineService.validateEdl(invalidNarrator, canonical, locked, {
  targetDurationMinSec: 65,
  targetDurationMaxSec: 90,
  narration: { enabled: true }
}, 80), /narrator nguồn/);

const highlight = AutoStoryPipelineService.toHighlightScript(normalized.scripts[0], locked.lockedStories[0], config);
assert.strictEqual(highlight.prompt_profile, "vertex_auto_story");
assert.strictEqual(highlight.segments[1].audio_mode, "voiceover_only");
assert.match(highlight.segments[1].voiceover_text, /Instead of stopping/);
console.log("autoStoryPipelineService tests passed");
