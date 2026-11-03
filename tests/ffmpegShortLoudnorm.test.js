// A narrated block shorter than loudnorm's 3 s window must not come out ~35 dB quieter.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const FfmpegService = require("../electron/services/ffmpegService");

(async () => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch (_) { console.log("ffmpegShortLoudnorm skipped (no ffmpeg)"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "short-loudnorm-"));
  const ff = new FfmpegService({});
  const maxes = [];
  for (const [rawSec, targetSec] of [[2.5, 2.95], [3.9, 4.5]]) {
    const input = path.join(dir, `tone-${rawSec}.wav`);
    // Speech-like bursts (200 ms on / 100 ms near-silent), like a short TTS line.
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `anoisesrc=d=${rawSec}:c=pink:a=0.4,volume='if(lt(mod(t,0.3),0.2),1,0.02)':eval=frame`, "-ar", "24000", "-ac", "1", input]);
    const output = path.join(dir, `fit-${rawSec}.m4a`);
    const fit = await ff.fitDubbingClusterAudio({ inputPath: input, outputPath: output, targetDuration: targetSec, normalize: true, allowTrim: false, allowSlowDown: false, allowSpeedUp: true });
    const { spawnSync } = require("child_process");
    const err = spawnSync("ffmpeg", ["-hide_banner", "-i", output, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const max = Number((err.match(/max_volume: (-?[0-9.]+) dB/) || [])[1]);
    console.log(`  ${rawSec}s -> ${targetSec}s: max ${max} dB`);
    maxes.push(max);
    assert.ok(Math.abs(fit.outputDuration - targetSec) < 0.06, `duration ${fit.outputDuration} != ${targetSec}`);
  }
  // Same source level: the short clip must be normalized like the longer one, not ~35 dB down.
  assert.ok(Math.abs(maxes[0] - maxes[1]) < 6, `short clip ${maxes[0]} dB vs long clip ${maxes[1]} dB`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("ffmpegShortLoudnorm tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
