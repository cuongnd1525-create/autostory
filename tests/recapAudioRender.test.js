const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const Renderer = require("../electron/services/recap/recapRenderer");

function command(binary, args) {
  const result = spawnSync(binary, args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr?.toString());
  return result.stdout;
}

function frequency(buffer) {
  let crossings = 0;
  for (let offset = 2; offset < buffer.length; offset += 2) {
    if (buffer.readInt16LE(offset - 2) <= 0 && buffer.readInt16LE(offset) > 0) crossings++;
  }
  return crossings / (buffer.length / 2 / 24000);
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-audio-format-"));
  try {
    const renderer = new Renderer();
    const mono = path.join(root, "mono24.wav"), stereo = path.join(root, "stereo48.wav");
    command("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=24000", "-ac", "1", mono]);
    command("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=660:duration=3:sample_rate=48000", "-ac", "2", stereo]);
    const decisions = [
      { speech_unit_id: "one", audio_path: mono, audio_duration: 3, voice_tempo: 1, clips: [{ output_start: 0, output_end: 3.25, lead_ms: 250 }] },
      { speech_unit_id: "two", audio_path: stereo, audio_duration: 3, voice_tempo: 1.05, clips: [{ output_start: 3.5, output_end: 7, lead_ms: 0 }] }
    ];
    const master = await renderer.buildNarrationTrack({ decisions, totalDurationSec: 7, tempDir: root });
    const info = JSON.parse(command("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,channels:format=duration", "-of", "json", master]).toString());
    assert.equal(info.streams[0].sample_rate, "44100");
    assert.equal(info.streams[0].channels, 2);
    assert.ok(Math.abs(Number(info.format.duration) - 7) < 0.05);
    const sample = (start) => command("ffmpeg", ["-v", "error", "-ss", String(start), "-i", master, "-t", "0.8", "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1"]);
    assert.ok(Math.abs(frequency(sample(0.6)) - 440) < 5, "mono 24 kHz speech must retain its pitch at tempo=1");
    assert.ok(Math.abs(frequency(sample(3.65)) - 660) < 5, "48 kHz speech must retain pitch during tempo adjustment and respect lead=0");
    const silence = command("ffmpeg", ["-v", "error", "-ss", "3.3", "-i", master, "-t", "0.1", "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1"]);
    let max = 0;
    for (let i = 0; i < silence.length; i += 2) max = Math.max(max, Math.abs(silence.readInt16LE(i)));
    assert.ok(max < 100, "the pause before the second speech unit must remain silent");
    assert.equal(renderer.segmentTiming(decisions.flatMap((d) => d.clips), 0, 30, 7).durationSec, 3.5, "video must include the scheduled 0.25s gap");
    console.log("recapAudioRender: sample formats, pitch, tempo, silence, zero lead and video timeline passed");
    const source = path.join(root, "source-with-audio.mp4");
    const voice = path.join(root, "voice880.wav");
    command("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", source]);
    command("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=0.8:sample_rate=24000", "-ac", "1", voice]);
    const voiceDecisions = [{ speech_unit_id: "voice", audio_path: voice, audio_duration: 0.8, voice_tempo: 1,
      clips: [{ source_start: 0, source_end: 2, output_start: 0, output_end: 2, video_speed: 1, lead_ms: 250 }] }];
    for (const method of ["renderDraft", "renderFinal"]) {
      for (const muted of [false, true]) {
        const outputPath = path.join(root, `${method}-${muted}.mp4`);
        await renderer[method]({ sourceVideoPath: source, decisions: voiceDecisions, muteSourceAudio: muted, outputPath });
        const beforeVoice = command("ffmpeg", ["-v", "error", "-ss", "0.07", "-i", outputPath, "-t", "0.1", "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1"]);
        let peak = 0;
        for (let offset = 0; offset < beforeVoice.length; offset += 2) peak = Math.max(peak, Math.abs(beforeVoice.readInt16LE(offset)));
        assert.ok(muted ? peak < 30 : peak > 100, `${method}: original audio must ${muted ? "be completely absent" : "remain audible"}`);
        if (muted) {
          const narrated = command("ffmpeg", ["-v", "error", "-ss", "0.4", "-i", outputPath, "-t", "0.3", "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1"]);
          assert.ok(Math.abs(frequency(narrated) - 880) < 6, `${method}: TTS must remain audible and unchanged`);
        }
      }
    }
    console.log("recapAudioRender: mute ON/OFF verified in draft and master; source removed, TTS preserved");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
