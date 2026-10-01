const assert = require("assert");
const {
  secondsToAssTime,
  buildTikTokKaraokeAssEvents,
  buildTikTokKaraokeAssContent
} = require("../electron/services/karaokeSubtitleService");

(() => {
  // Test secondsToAssTime
  assert.strictEqual(secondsToAssTime(0), "0:00:00.00");
  assert.strictEqual(secondsToAssTime(8.28), "0:00:08.28");
  assert.strictEqual(secondsToAssTime(65.5), "0:01:05.50");

  // Test buildTikTokKaraokeAssEvents
  const sampleWords = [
    { word: "What's", start: 8.92, end: 9.42 },
    { word: "going", start: 9.42, end: 9.56 },
    { word: "on?", start: 9.56, end: 9.74 }
  ];

  const events = buildTikTokKaraokeAssEvents(sampleWords, { wordsPerGroup: 3 });
  assert.strictEqual(events.length, 3);
  assert.ok(events[0].text.includes("{\\c&H00FFFF00&}WHAT'S{\\c&H00FFFFFF&} GOING ON?"));
  assert.ok(events[1].text.includes("WHAT'S {\\c&H00FFFF00&}GOING{\\c&H00FFFFFF&} ON?"));
  assert.ok(events[2].text.includes("WHAT'S GOING {\\c&H00FFFF00&}ON?{\\c&H00FFFFFF&}"));

  // Test buildTikTokKaraokeAssContent
  const assText = buildTikTokKaraokeAssContent(sampleWords, { width: 1080, height: 1920 });
  assert.ok(assText.includes("[Script Info]"));
  assert.ok(assText.includes("PlayResX: 1080"));
  assert.ok(assText.includes("PlayResY: 1920"));
  assert.ok(assText.includes("Style: TikTokKaraoke"));
  assert.ok(assText.includes("Dialogue: 0,0:00:08.92,0:00:09.42,TikTokKaraoke,,0,0,0,,{\\c&H00FFFF00&}WHAT'S{\\c&H00FFFFFF&} GOING ON?"));

  // Test buildWordTimestampsFromSegments
  const sampleSegments = [
    { startSec: 0, endSec: 5, voiceover_text: "Inpatient, what's going on?" },
    { startSec: 5, endSec: 10, words: [{ word: "Up", start: 5.1, end: 5.3 }, { word: "here", start: 5.4, end: 5.8 }] }
  ];
  const { buildWordTimestampsFromSegments } = require("../electron/services/karaokeSubtitleService");
  const resolvedWords = buildWordTimestampsFromSegments(sampleSegments);
  assert.strictEqual(resolvedWords.length, 6); // 4 interpolated + 2 explicit
  assert.strictEqual(resolvedWords[0].word, "Inpatient,");
  assert.strictEqual(resolvedWords[4].word, "Up");

  // Test detectGeminiArtifact with viral attributes
  const { detectGeminiArtifact } = require("../electron/services/geminiJsonArtifactService");
  const viralScript = {
    artifactType: "highlight_cut_script",
    scriptId: 1,
    suggestedTitle: "ABUSIVE MOM'S WORST NIGHTMARE CAME TRUE",
    titleStyle: "viral_green",
    partBadge: "PART 1",
    cameraLabel: "CAM 1",
    subtitleStyle: "tiktok_karaoke",
    segments: [
      { id: "beat_01", audioMode: "original_audio", sourceStartSec: 0, sourceEndSec: 15 }
    ]
  };
  const artifact = detectGeminiArtifact(viralScript);
  assert.strictEqual(artifact.suggestedTitle, "ABUSIVE MOM'S WORST NIGHTMARE CAME TRUE");
  assert.strictEqual(artifact.titleStyle, "viral_green");
  assert.strictEqual(artifact.partBadge, "PART 1");
  assert.strictEqual(artifact.cameraLabel, "CAM 1");
  assert.strictEqual(artifact.subtitleStyle, "tiktok_karaoke");

  console.log("karaokeSubtitleService tests passed successfully.");
})();
