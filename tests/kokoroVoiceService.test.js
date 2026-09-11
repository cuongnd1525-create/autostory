const assert = require("assert");
const KokoroVoiceService = require("../electron/services/kokoroVoiceService");
const {
  getEdgeRateWithDelivery,
  getSegmentVoiceRenderOptions,
  getVoiceCacheInfo,
  splitTextAfterPhrase
} = require("../electron/services/dubbingService");

const service = new KokoroVoiceService();
const voices = service.listVoices();

assert(voices.length >= 10);
assert(voices.every((voice) => voice.provider === "kokoro"));
assert(voices.every((voice) => voice.labels.locale === "en-US"));
assert(voices.some((voice) => voice.voice_id === "af_heart"));
assert.strictEqual(KokoroVoiceService.normalizeLanguage("en"), "a");
assert.strictEqual(KokoroVoiceService.normalizeLanguage("en-US"), "a");
assert.strictEqual(KokoroVoiceService.normalizeLanguage("en-GB"), "b");
assert.throws(() => KokoroVoiceService.normalizeLanguage("vi"), /chưa hỗ trợ/i);

const delivery = getSegmentVoiceRenderOptions({
  deliveryProfile: "mystery_hook",
  pauseAfterPhrase: "secret",
  pauseDurationMs: 350
});
assert.strictEqual(delivery.speechRateMultiplier, 0.92);
assert.deepStrictEqual(splitTextAfterPhrase("I hid one secret inside this ceiling.", "secret"), {
  before: "I hid one secret",
  after: "inside this ceiling."
});
assert.strictEqual(getEdgeRateWithDelivery(5, { speechRateMultiplier: 0.92 }), -3);

const cacheBase = {
  settings: { defaultVoiceProvider: "kokoro", kokoroSpeed: 1 },
  project: { voiceProvider: "kokoro", voiceId: "af_heart", language: "en" },
  text: "I hid one secret inside this ceiling.",
  outputPath: "C:\\temp\\voice.wav"
};
const naturalCache = getVoiceCacheInfo({ ...cacheBase, voiceRenderOptions: { deliveryProfile: "natural", speechRateMultiplier: 1 } });
const hookCache = getVoiceCacheInfo({ ...cacheBase, voiceRenderOptions: delivery });
assert.notStrictEqual(naturalCache.cacheKey, hookCache.cacheKey, "Delivery changes must invalidate the voice cache.");

console.log("kokoroVoiceService tests passed");
