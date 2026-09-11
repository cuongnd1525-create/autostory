const assert = require("assert");
const path = require("path");

const OmniVoiceService = require("../electron/services/omniVoiceService");
const { normalizeOmniVoiceInstruct } = OmniVoiceService;
const { shouldUseStorytimeVoiceBatch } = require("../electron/services/dubbingService");

const normalized = normalizeOmniVoiceInstruct(
  "male, young adult, low pitch, tense cinematic narrator, fast natural speech"
);
assert.strictEqual(normalized.instruct, "male, young adult, low pitch");
assert.deepStrictEqual(normalized.removed, ["tense cinematic narrator", "fast natural speech"]);

const aliases = normalizeOmniVoiceInstruct("female, adult, medium pitch, urgent");
assert.strictEqual(aliases.instruct, "female, middle-aged, moderate pitch");
assert.deepStrictEqual(aliases.removed, ["urgent"]);

const chinese = normalizeOmniVoiceInstruct("男，青年，低音调");
assert.strictEqual(chinese.instruct, "男，青年，低音调");
assert.deepStrictEqual(chinese.removed, []);

const service = new OmniVoiceService({
  omniVoiceModel: "test/model",
  omniVoiceInstruct: ""
});
const args = service.buildArgs({
  text: "Xin chào, đây là đoạn thử giọng.",
  voiceName: "male, low pitch, dramatic narrator",
  outputPath: path.join("C:\\", "Temp", "voice.wav"),
  language: "vi"
});
assert.strictEqual(args[args.indexOf("--text") + 1], "Xin chào, đây là đoạn thử giọng.");
assert.strictEqual(args[args.indexOf("--instruct") + 1], "male, low pitch");
assert.strictEqual(args[args.indexOf("--language") + 1], "vi");

const workerPayload = service.buildWorkerPayload({
  text: "Hello",
  voiceName: "female, medium pitch, cinematic",
  outputPath: path.join("C:\\", "Temp", "worker.wav"),
  language: "en",
  durationSec: 4.5,
  numStep: 8
});
assert.strictEqual(workerPayload.instruct, "female, moderate pitch");
assert.strictEqual(workerPayload.durationSec, 4.5);
assert.strictEqual(workerPayload.numStep, 8);

const voices = service.listVoices();
voices
  .filter((voice) => voice.voice_id && !path.isAbsolute(voice.voice_id))
  .forEach((voice) => {
    const result = normalizeOmniVoiceInstruct(voice.voice_id);
    assert.strictEqual(result.removed.length, 0, `${voice.name} contains unsupported instruct items`);
  });

assert.strictEqual(shouldUseStorytimeVoiceBatch({
  voiceProvider: "omnivoice",
  storytimeVoiceRenderMode: "clustered",
  omniVoiceRenderMode: "segment",
  useContinuousStorytimeVoice: false
}), false);
assert.strictEqual(shouldUseStorytimeVoiceBatch({
  voiceProvider: "omnivoice",
  storytimeVoiceRenderMode: "clustered",
  omniVoiceRenderMode: "batch",
  useContinuousStorytimeVoice: false
}), true);
assert.strictEqual(shouldUseStorytimeVoiceBatch({
  voiceProvider: "edge_neural",
  storytimeVoiceRenderMode: "clustered",
  omniVoiceRenderMode: "segment",
  useContinuousStorytimeVoice: false
}), true);

console.log("omniVoiceService tests passed");
