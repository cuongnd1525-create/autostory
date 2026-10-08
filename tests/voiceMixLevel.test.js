"use strict";

// Regression (2026-10-08): TTS sounded normal when previewed but very quiet in
// the draft / final render. Measured on the real filters: the plain voice +
// ambient mix lost 6 dB (amix normalize=1 divides by the input count) and every
// stereo mix lost 3 dB more (aformat upmix of the mono TTS). The voice must
// reach the rendered video at the level of the fitted/normalized voice file.

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const FfmpegService = require("../electron/services/ffmpegService");

function meanVolume(filePath, extraArgs = []) {
  const output = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", filePath, ...extraArgs, "-af", "volumedetect", "-f", "null", "-"]).stderr.toString();
  const match = output.match(/mean_volume: (-?[\d.]+) dB/);
  assert(match, `volumedetect failed for ${filePath}`);
  return Number(match[1]);
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-mix-level-"));
  const voice = path.join(dir, "voice.wav");
  const video = path.join(dir, "video.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=4", "-af", "volume=0.25,tremolo=f=4:d=0.7", voice]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=30:duration=4", "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.05:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-shortest", video]);
  const ffmpeg = new FfmpegService({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
  const fitted = path.join(dir, "fitted.m4a");
  await ffmpeg.fitDubbingClusterAudio({ inputPath: voice, outputPath: fitted, targetDuration: 4, normalize: true, allowTrim: false, allowSlowDown: false, allowSpeedUp: true });
  const voiceLevel = meanVolume(fitted);

  // Near-zero ambient isolates the voice level through each mix path.
  const cases = [
    ["voice only (replace)", { sourceVolume: 0 }],
    ["voice + ambient (amix)", { sourceVolume: 0.001 }],
    ["voice + ambient (duck)", { sourceVolume: 0.001, duck: true }],
    ["narrated block (duck, separate ambient)", { sourceVolume: 0.001, duck: true, separateAmbientInput: true }]
  ];
  for (const [label, options] of cases) {
    const output = path.join(dir, `${label.replace(/\W+/g, "_")}.mp4`);
    await ffmpeg.mixVideoAudioWithVoice({ videoPath: video, voicePath: fitted, outputPath: output, voiceVolume: 1, limiter: true, ...options });
    const level = meanVolume(output);
    assert(Math.abs(level - voiceLevel) <= 1.5, `${label}: voice ${level} dB vs fitted ${voiceLevel} dB (must not drop 3-6 dB)`);
    const channels = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", output]).toString().trim();
    assert.strictEqual(channels, "2", `${label}: stereo output so concat does not upmix again`);
  }

  // Ambient still mixes in at the configured level (not halved any more).
  const withAmbient = path.join(dir, "ambient.mp4");
  const silentVoice = path.join(dir, "silent.wav");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "4", silentVoice]);
  await ffmpeg.mixVideoAudioWithVoice({ videoPath: video, voicePath: silentVoice, outputPath: withAmbient, sourceVolume: 0.5, voiceVolume: 1, limiter: false });
  const sourceLevel = meanVolume(video);
  const ambientLevel = meanVolume(withAmbient);
  assert(Math.abs(ambientLevel - (sourceLevel - 6.02)) <= 1.5, `ambient at sourceVolume 0.5 = -6 dB (${ambientLevel} vs source ${sourceLevel})`);

  // Narration-track mixers keep the voice gain they apply (no -3 dB upmix loss).
  const narrated = path.join(dir, "narrated.mp4");
  await ffmpeg.mixVideoAndNarration({ videoPath: video, narrationPath: fitted, outputPath: narrated, targetDuration: 4, sourceAudioVolume: 0.001 });
  assert(meanVolume(narrated) >= voiceLevel - 1, `mixVideoAndNarration keeps the voice level (${meanVolume(narrated)} vs ${voiceLevel})`);

  await fs.rm(dir, { recursive: true, force: true });
  console.log("voiceMixLevel tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
