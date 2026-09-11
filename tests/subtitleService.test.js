const assert = require("assert");
const SubtitleService = require("../electron/services/subtitleService");
const {
  MAX_WHISPER_TIMEOUT_MS,
  chooseAutoAsrProfile,
  normalizeEngine
} = require("../electron/services/subtitleService");

assert.strictEqual(MAX_WHISPER_TIMEOUT_MS, 300000);
assert.strictEqual(new SubtitleService().whisperTimeoutMs, 300000);
assert.strictEqual(new SubtitleService().whisperEngine, "auto");
assert.strictEqual(new SubtitleService({ whisperTimeoutMs: 1800000 }).whisperTimeoutMs, 300000);
assert.strictEqual(new SubtitleService({ whisperTimeoutMs: 120000 }).whisperTimeoutMs, 120000);
assert.strictEqual(new SubtitleService({ whisperTimeoutMs: 1000 }).whisperTimeoutMs, 30000);
assert.strictEqual(normalizeEngine("faster-whisper"), "faster-whisper");
assert.strictEqual(normalizeEngine("nvidia-parakeet"), "nvidia-parakeet");
assert.strictEqual(normalizeEngine("unknown"), "auto");
assert.strictEqual(
  new SubtitleService({ whisperEngine: "nvidia-parakeet", whisperModel: "auto" }).whisperEngine,
  "nvidia-parakeet"
);

assert.deepStrictEqual(
  chooseAutoAsrProfile({ language: "en", totalMemoryGb: 4, cpuThreads: 2, nvidiaVramMb: 0 }),
  {
    engine: "faster-whisper",
    model: "base.en",
    device: "cpu",
    computeType: "int8",
    reason: "CPU 2 luồng, RAM 4.0 GB"
  }
);
assert.strictEqual(
  chooseAutoAsrProfile({ language: "en", totalMemoryGb: 16, cpuThreads: 8 }).model,
  "small.en"
);
assert.strictEqual(
  chooseAutoAsrProfile({ language: "auto", totalMemoryGb: 16, cpuThreads: 8 }).model,
  "small"
);
assert.strictEqual(
  chooseAutoAsrProfile({ language: "en", nvidiaVramMb: 4096 }).model,
  "distil-large-v3"
);
assert.strictEqual(
  chooseAutoAsrProfile({ language: "vi", nvidiaVramMb: 8192 }).model,
  "large-v3-turbo"
);

console.log("subtitleService tests passed");
