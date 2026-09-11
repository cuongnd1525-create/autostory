const assert = require("assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ffmpeg = require("../electron/services/ffmpegService");
const mediaPack = require("../electron/services/autoStoryMediaPack");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-story-hook-media-"));
  const ffmpeg = new Ffmpeg({});
  try {
    const source = path.join(root, "source.mp4");
    const output = path.join(root, "candidate.mp4");
    await ffmpeg.run(ffmpeg.ffmpegPath, ["-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", source]);
    await ffmpeg.createAnalysisProxyChunk({ videoPath: source, outputPath: output,
      startSec: 1, durationSec: 2, width: 640, fps: 8 });
    const data = JSON.parse(execFileSync(ffmpeg.ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output], { encoding: "utf8", windowsHide: true }));
    const video = data.streams.find(s => s.codec_type === "video");
    assert.equal(video.width, 640);
    assert.equal(video.height, 360);
    assert.equal(video.avg_frame_rate, "8/1");
    assert(data.streams.some(s => s.codec_type === "audio"), "keep real source audio for hook audition");
    assert(Math.abs(Number(data.format.duration) - 2) < 0.15);
    const evidence = [{ id: "a", file: output, sourceStart: 0, duration: 2, sourceUnits: [{ id: "u1", start: 0, end: 1 }] },
      { id: "b", file: output, sourceStart: 100, duration: 2, sourceUnits: [{ id: "u2", start: 100, end: 101 }] }];
    const packed = await mediaPack.pack(ffmpeg, evidence, { hookCandidates: [{ sourceUnitIds: ["u2"] }] }, root);
    assert.equal(packed.filePaths.length, 2);
    assert.deepEqual(Object.values(packed.videoFpsByPath), [1, 4]);
    assert.equal(packed.evidence[1].mediaLocations[0].reelStart, 2, "98s source gap must not be uploaded");
    assert.equal(packed.evidence[1].mediaLocations[1].clipStart, 0);
    assert(Math.abs((await ffmpeg.probeVideo(packed.filePaths[0])).duration - 4) < 0.15);
    const timestamps = await Promise.all(packed.filePaths.map(f => fs.stat(f).then(s => s.mtimeMs)));
    await mediaPack.pack(ffmpeg, evidence, { hookCandidates: [{ sourceUnitIds: ["u2"] }] }, root);
    assert.deepEqual(await Promise.all(packed.filePaths.map(f => fs.stat(f).then(s => s.mtimeMs))), timestamps, "unchanged reels reused");
    console.log("Auto Story hook media render passed (640x360, 8fps, audio, correct duration)");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
