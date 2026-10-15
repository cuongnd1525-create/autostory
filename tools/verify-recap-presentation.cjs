const fs = require("fs/promises");
const path = require("path");
const assert = require("assert/strict");
const Renderer = require("../electron/services/recap/recapRenderer");
const { localPythonCommand } = require("../electron/services/pythonRuntimeService");
async function main() {
  const folder = path.resolve(__dirname, "../.tmp/recap-presentation-check"); await fs.mkdir(folder, { recursive: true });
  const renderer = new Renderer({ settings: { whisperPythonCommand: localPythonCommand(), whisperEngine: "faster-whisper", whisperDevice: "cuda", whisperComputeType: "float16", recapCaptionAsrModel: "tiny.en" } });
  const source = path.join(folder, "source.mp4");
  await renderer.runCommand("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=duration=5:size=640x360:rate=24", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
  const audio = path.resolve(__dirname, "../.tmp/recap-runtime-check/kokoro-test.wav");
  const duration = (await renderer.probeVideo(audio)).durationSec;
  const decisions = [{ speech_unit_id: "presentation", text: "The town falls silent as the family discovers the truth.", audio_path: audio, audio_duration: duration, voice_tempo: 1,
    clips: [{ source_start: 0, source_end: 5, output_start: 0, output_end: duration + .5, video_speed: 1, lead_ms: 250, focus_x: .7, focus_y: .5 }] }];
  for (const [method, framing, captions] of [["renderDraft", "fit_blur", "phrase"], ["renderFinal", "fit_blur", "karaoke"], ["renderDraft", "smart_crop", "phrase"]]) {
    const outputPath = path.join(folder, `${method}-${framing}-${captions}.mp4`);
    await renderer[method]({ sourceVideoPath: source, decisions, muteSourceAudio: method === "renderDraft", outputPath, captionDirectory: path.join(folder, "captions"),
      presentation: { aspect: "9:16", framing, captions, language: "en" }, onProgress: (p) => console.log(p.message) });
    const result = await renderer.probeVideo(outputPath);
    assert.equal(result.width, method === "renderDraft" ? 360 : 1080); assert.equal(result.height, method === "renderDraft" ? 640 : 1920);
    assert.ok(Math.abs(result.durationSec - duration - .5) < .15); assert.equal(result.hasAudio, true);
    console.log("Verified:", path.basename(outputPath), JSON.stringify(result));
  }
  await renderer.runCommand("ffmpeg", ["-y", "-ss", "1", "-i", path.join(folder, "renderFinal-fit_blur-karaoke.mp4"), "-frames:v", "1", path.join(folder, "portrait-preview.png")]);
  const cache = await fs.readdir(path.join(folder, "captions"));
  const aligned = JSON.parse(await fs.readFile(path.join(folder, "captions", cache.find((name) => name.endsWith("-aligned.json"))), "utf8"));
  assert.ok(aligned.matchedRatio >= .65); console.log("Original-text caption alignment:", aligned.matchedRatio);
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
