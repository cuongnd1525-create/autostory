const fs = require("fs/promises");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");
const FixedRenderer = require("../electron/services/recap/recapRenderer");

function command(binary, args) {
  const r = spawnSync(binary, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw r.error || new Error(r.stderr?.toString());
  return r.stdout;
}
function frequency(buffer) {
  let count = 0;
  for (let i = 2; i < buffer.length; i += 2) if (buffer.readInt16LE(i - 2) <= 0 && buffer.readInt16LE(i) > 0) count++;
  return Math.round(count / (buffer.length / 2 / 24000));
}
async function main() {
  const root = path.resolve(__dirname, "../.tmp/recap-audio-audit/format-reproduction");
  await fs.mkdir(root, { recursive: true });
  const tone = path.join(root, "mono24.wav");
  command("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=24000", "-ac", "1", tone]);
  const source = command("git", ["show", "HEAD:electron/services/recap/recapRenderer.js"]).toString();
  const baselineModule = new Module(path.resolve(__dirname, "../electron/services/recap/recapRenderer.js"));
  baselineModule.filename = baselineModule.id;
  baselineModule.paths = Module._nodeModulePaths(path.dirname(baselineModule.filename));
  baselineModule._compile(source, baselineModule.filename);
  const decisions = [{ speech_unit_id: "test", audio_path: tone, audio_duration: 3, voice_tempo: 1, clips: [{ output_start: 0, output_end: 4, lead_ms: 250 }] }];
  for (const [label, Renderer] of [["Before", baselineModule.exports], ["Fixed", FixedRenderer]]) {
    const tempDir = path.join(root, label); await fs.mkdir(tempDir, { recursive: true });
    const file = await new Renderer().buildNarrationTrack({ decisions, totalDurationSec: 4, tempDir });
    const sample = command("ffmpeg", ["-v", "error", "-ss", "0.35", "-i", file, "-t", "0.4", "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1"]);
    console.log(label, "440 Hz input rendered as", frequency(sample), "Hz");
  }
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
