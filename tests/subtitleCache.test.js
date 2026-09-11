const assert = require("assert");
const { buildAudioCacheKey } = require("../electron/services/subtitleService");

(async () => {
  const first = await buildAudioCacheKey("C:/temp/source-one.wav");
  const same = await buildAudioCacheKey("C:/temp/source-one.wav");
  const second = await buildAudioCacheKey("C:/temp/source-two.wav");
  assert.strictEqual(first, same);
  assert.notStrictEqual(first, second);
  console.log("subtitle cache tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
