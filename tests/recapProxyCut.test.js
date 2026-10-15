const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const Media = require("../electron/services/recap/recapMediaService");

(async () => {
  await fs.mkdir(path.resolve(__dirname, "../.tmp"), { recursive: true });
  const root = await fs.mkdtemp(path.resolve(__dirname, "../.tmp/recap-cut-"));
  const media = new Media(), source = path.join(root, "long-gop.mp4");
  try {
    await media.runCommand(media.ffmpegPath, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=duration=16:size=320x180:rate=8",
      "-c:v", "libx264", "-g", "128", "-keyint_min", "128", "-sc_threshold", "0", source]);
    const chunk = { chunkIndex: 1, sourceStartSec: 7.125, durationSec: 3.125 };
    const cut = await media.extractProxyChunk({ proxyPath: source, chunk, outputDir: root });
    assert.ok(Math.abs((await media.probeVideo(cut)).duration - 3.125) <= .125, "non-keyframe cut must not include preroll");
    for (const [name, input, seek] of [["expected", source, 7.125], ["actual", cut, 0]]) {
      await media.runCommand(media.ffmpegPath, ["-y", "-v", "error", "-ss", String(seek), "-i", input, "-frames:v", "1", path.join(root, `${name}.png`)]);
    }
    // Compare luminance to avoid confusing chroma subsampling/quantization with a seek error.
    const comparison = await media.runCommand(media.ffmpegPath, ["-i", path.join(root, "expected.png"), "-i", path.join(root, "actual.png"), "-lavfi", "[0:v]format=gray[a];[1:v]format=gray[b];[a][b]ssim", "-frames:v", "1", "-f", "null", "-"]);
    const firstFrameSsim = Number(comparison.stderr.match(/All:([\d.]+)/)?.[1]);
    assert.ok(firstFrameSsim > .98, `first frame must match requested source timestamp (SSIM ${firstFrameSsim})`);
    const cachedAt = (await fs.stat(cut)).mtimeMs;
    await media.extractProxyChunk({ proxyPath: source, chunk, outputDir: root });
    assert.equal((await fs.stat(cut)).mtimeMs, cachedAt, "verified cuts must reuse cache");
    await media.extractProxyChunk({ proxyPath: source, chunk: { ...chunk, durationSec: 2 }, outputDir: root });
    assert.ok(Math.abs((await media.probeVideo(cut)).duration - 2) <= .125, "changed interval must invalidate cache");
    console.log("recapProxyCut: real long-GOP timing, first frame and cache invalidation passed");
  } finally {
    // Only remove the workspace-owned fixture directory created above.
    assert.ok(root.startsWith(path.resolve(__dirname, "../.tmp") + path.sep));
    if (!process.env.RECAP_KEEP_CUT_FIXTURE) await fs.rm(root, { recursive: true, force: true });
    else console.log(root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
