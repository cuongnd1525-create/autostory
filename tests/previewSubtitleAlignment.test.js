const assert = require("assert");
const {
  buildDraftVoiceTranscriptEntries,
  buildTimedSubtitlePhrases,
  getOriginalAudioTranscriptCandidate,
  normalizeRollingSubtitleCues,
  shouldUseOriginalAudioTranscriptCandidate,
  splitSubtitlePhrases
} = require("../electron/services/dubbingService");

const phrases = splitSubtitlePhrases(
  "They claimed that I was abusing my son. But the evidence told a different story."
);
assert.deepStrictEqual(phrases, [
  "They claimed that I was abusing my son.",
  "But the evidence told a different story."
]);

const cues = buildTimedSubtitlePhrases({
  id: "highlight_0002",
  text: "They claimed that I was abusing my son. But the evidence told a different story.",
  startSec: 12,
  endSec: 20
});
assert.strictEqual(cues.length, 2);
assert.strictEqual(cues[0].startSec, 12);
assert.strictEqual(cues[1].endSec, 20);
assert(cues[0].endSec <= cues[1].startSec);
assert(cues.every((cue) => cue.id.startsWith("highlight_0002__voice_")));

const originalCandidate = getOriginalAudioTranscriptCandidate({
  translatedText: "He was admitted to a crib that had poop on it. It had somebody else's name tag taped to it. I have been complaining about it the whole time, and they would not let me move him to a safer hospital.",
  caption: "Hospital argument"
});
assert(originalCandidate.startsWith("He was admitted"));
assert.strictEqual(shouldUseOriginalAudioTranscriptCandidate({
  candidateText: originalCandidate,
  startSec: 22.875,
  endSec: 42.875,
  cues: [{ startSec: 26.445, endSec: 42.715, text: "Incorrect partial ASR transcript" }]
}), true);
assert.strictEqual(shouldUseOriginalAudioTranscriptCandidate({
  candidateText: originalCandidate,
  startSec: 22.875,
  endSec: 42.875,
  cues: [{ startSec: 22.9, endSec: 42.7, text: "Complete ASR transcript" }]
}), false);

const rollingCues = normalizeRollingSubtitleCues([
  { startSec: 3.83, endSec: 3.84, text: "On January 3rd, an officer with" },
  { startSec: 3.84, endSec: 6.3, text: "On January 3rd, an officer with the police department was" },
  { startSec: 6.3, endSec: 6.31, text: "the police department was" },
  { startSec: 6.31, endSec: 8.3, text: "the police department was dispatched to the store" }
]);
assert.deepStrictEqual(rollingCues.map((cue) => cue.text), [
  "On January 3rd, an officer with the police department was",
  "dispatched to the store"
]);
assert.deepStrictEqual(normalizeRollingSubtitleCues([
  { startSec: 0, endSec: 2, text: "I do not know." },
  { startSec: 2.1, endSec: 4, text: "I do not know what happened." }
]).map((cue) => cue.text), [
  "I do not know.",
  "I do not know what happened."
]);

const voiceEntries = buildDraftVoiceTranscriptEntries({
  entries: [
    { index: 1, reelStartSec: 0, reelEndSec: 5, renderedText: "The first bridge explains the original call." },
    { index: 3, reelStartSec: 5.45, reelEndSec: 10, renderedText: "The second bridge explains the pursuit." }
  ],
  wordTimestampPayload: {
    segments: [{
      words: [
        { word: "The", start: 0.1, end: 0.3 },
        { word: "call.", start: 3.9, end: 4.2 },
        { word: "The", start: 5.6, end: 5.8 },
        { word: "pursuit.", start: 9.1, end: 9.5 }
      ]
    }]
  }
});
assert.strictEqual(voiceEntries.length, 2);
assert(voiceEntries[0].cues.map((cue) => cue.text).join(" ").includes("first bridge"));
assert(voiceEntries[1].cues.map((cue) => cue.text).join(" ").includes("second bridge"));
assert(!voiceEntries[1].cues.map((cue) => cue.text).join(" ").includes("first bridge"));

console.log("preview subtitle alignment tests passed");
