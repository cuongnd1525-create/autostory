const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const FfmpegService = require("../electron/services/ffmpegService");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-ffmpeg-test-"));
  const sourcePath = path.join(root, "source.mp4");
  const outputPath = path.join(root, "extended.mp4");
  const videoOnlyPath = path.join(root, "extended-video-only.mp4");
  const voicePath = path.join(root, "voice.wav");
  const ambientMixedPath = path.join(root, "ambient-mixed.mp4");
  const ffmpeg = new FfmpegService({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
  try {
    await ffmpeg.run("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "testsrc2=size=320x180:rate=30:duration=2",
      "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=44100:duration=2",
      "-shortest",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-c:a", "aac",
      sourcePath
    ], { captureStdout: false });
    await ffmpeg.extractVoiceDrivenClipWithAudio({
      sourcePath,
      outputPath,
      startSec: 0,
      sourceDurationSec: 2,
      targetDurationSec: 3,
      width: 320,
      preset: "ultrafast",
      crf: 30
    });
    const output = await ffmpeg.probeVideo(outputPath);
    assert.ok(Math.abs(output.duration - 3) <= 0.15, `Expected 3s output, received ${output.duration}s`);
    assert.strictEqual(output.hasAudio, true);
    await ffmpeg.extractVoiceDrivenClipWithAudio({
      sourcePath,
      outputPath: videoOnlyPath,
      startSec: 0,
      sourceDurationSec: 2,
      targetDurationSec: 3,
      width: 320,
      preset: "ultrafast",
      crf: 30,
      includeAudio: false
    });
    const videoOnly = await ffmpeg.probeVideo(videoOnlyPath);
    assert.ok(Math.abs(videoOnly.duration - 3) <= 0.15, `Expected 3s video-only output, received ${videoOnly.duration}s`);
    assert.strictEqual(videoOnly.hasAudio, false, "voiceover-only extraction must remove source audio before TTS muxing");
    await ffmpeg.run("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=880:sample_rate=44100:duration=3",
      "-c:a", "pcm_s16le",
      voicePath
    ], { captureStdout: false });
    await ffmpeg.mixVideoAudioWithVoice({
      videoPath: outputPath,
      voicePath,
      outputPath: ambientMixedPath,
      sourceVolume: 0.15,
      voiceVolume: 1,
      limiter: true
    });
    const ambientMixed = await ffmpeg.probeVideo(ambientMixedPath);
    assert.strictEqual(ambientMixed.hasAudio, true, "voiceover-with-ambient render must retain a mixed audio track");
    assert.ok(Math.abs(ambientMixed.duration - 3) <= 0.15, `Expected 3s ambient mix, received ${ambientMixed.duration}s`);
    console.log("ffmpeg voice-driven clip tests passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
