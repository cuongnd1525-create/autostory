const fs = require("fs/promises");
const path = require("path");
const Kokoro = require("../electron/services/kokoroVoiceService");
const Translation = require("../electron/services/localTranslationService");
const Subtitle = require("../electron/services/subtitleService");
const { localPythonCommand } = require("../electron/services/pythonRuntimeService");

async function main() {
  const folder = path.resolve(__dirname, "../.tmp/recap-runtime-check");
  await fs.mkdir(folder, { recursive: true });
  const python = localPythonCommand();
  const settings = { kokoroPythonCommand: python, localTranslationPythonCommand: python, whisperPythonCommand: python,
    kokoroDevice: "cpu", localTranslationDevice: "cpu", whisperEngine: "faster-whisper", whisperModel: "tiny.en", whisperDevice: process.argv.includes("--gpu") ? "cuda" : "cpu", whisperComputeType: process.argv.includes("--gpu") ? "float16" : "int8" };
  console.log("Runtime:", python);
  const voice = new Kokoro(settings);
  const audio = path.join(folder, "kokoro-test.wav");
  await voice.synthesizeSpeech({ text: "The town falls silent as the family discovers the truth.", voiceName: "am_adam", outputPath: audio, language: "en", onProgress: console.log });
  console.log("Kokoro synthesis OK:", (await fs.stat(audio)).size, "bytes");
  const translation = await new Translation(settings).translateToVietnamese({ segments: [{ id: "test", text: "The family discovers the truth." }], sourceLanguage: "en", onProgress: console.log });
  if (!translation[0]?.translatedText) throw new Error("Translation output is empty.");
  console.log("OPUS-MT translation OK:", translation[0].translatedText);
  const subtitle = new Subtitle(settings);
  const profile = await subtitle.detectRuntime({ language: "en" });
  if (!profile.fasterWhisperAvailable) throw new Error(JSON.stringify(profile.runtimeError));
  console.log("ASR device:", profile.device, "CUDA runtime:", profile.cudaRuntimeAvailable ?? "not required");
  const asr = await subtitle.transcribeWithFasterWhisper({ audioPath: audio, outputDir: folder, narrationLanguage: "en", cacheDir: path.join(folder, "asr-cache"), profile, timeoutMs: 300000 });
  const text = await fs.readFile(asr.subtitlePath, "utf8");
  if (!text.trim()) throw new Error("ASR subtitle is empty.");
  console.log("faster-whisper transcription OK:", text.trim());
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  Kokoro.shutdownPersistentWorkers();
  Translation.shutdownPersistentWorkers();
});
