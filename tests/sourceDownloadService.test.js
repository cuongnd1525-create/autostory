const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const SourceDownloadService = require("../electron/services/sourceDownloadService");
const { validateSourceUrl, progressFromLine, normalizeSubtitleToSrt } = require("../electron/services/sourceDownloadService");

assert.strictEqual(validateSourceUrl("https://youtu.be/test123").platform, "youtube");
assert.strictEqual(validateSourceUrl("https://www.youtube.com/watch?v=test123").platform, "youtube");
assert.strictEqual(validateSourceUrl("https://vm.tiktok.com/test123/").platform, "tiktok");
assert.throws(() => validateSourceUrl("https://example.com/video"), /chỉ hỗ trợ liên kết YouTube và TikTok/);
assert.deepStrictEqual(
  progressFromLine("__CINEVIRAL_PROGRESS__: 42.5%|3.2MiB/s|00:14"),
  { percent: 42.5, speed: "3.2MiB/s", eta: "00:14" }
);

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-source-download-"));
  const progressEvents = [];
  let downloadArgs = [];
  try {
    const vttPath = path.join(root, "sample.vtt");
    const convertedSrtPath = path.join(root, "sample.srt");
    await fs.writeFile(vttPath, "WEBVTT\n\n00:00:00.000 --> 00:00:01.250\nHello from source\n");
    await normalizeSubtitleToSrt(vttPath, convertedSrtPath);
    const convertedSrt = await fs.readFile(convertedSrtPath, "utf8");
    assert.ok(convertedSrt.includes("00:00:00,000 --> 00:00:01,250"));
    assert.ok(convertedSrt.includes("Hello from source"));

    const runExternal = async (_command, args, options = {}) => {
      if (args.includes("--dump-single-json")) {
        return {
          stdout: `${JSON.stringify({ id: "abc123", title: "A Great Source", duration: 95.5 })}\n`,
          stderr: ""
        };
      }
      downloadArgs = args;
      const outputTemplate = args[args.indexOf("--output") + 1];
      const videoPath = path.join(path.dirname(outputTemplate), "A Great Source [abc123].mp4");
      await fs.writeFile(videoPath, "video");
      options.onLine?.("__CINEVIRAL_PROGRESS__:50.0%|2MiB/s|00:05");
      return { stdout: `__CINEVIRAL_FILE__:${videoPath}\n`, stderr: "" };
    };
    const fetchEnglishSubtitle = async ({ outputDir }) => {
      await fs.mkdir(outputDir, { recursive: true });
      const subtitlePath = path.join(outputDir, "source.en.srt");
      await fs.writeFile(subtitlePath, "1\n00:00:00,000 --> 00:00:01,000\nHello\n");
      return { subtitlePath, provider: "youtube_author_subtitles" };
    };
    const service = new SourceDownloadService({
      workspaceRoot: path.join(root, "projects"),
      sourceDownloadRoot: path.join(root, "sources"),
      ytDlpCommand: "yt-dlp"
    }, { runExternal, fetchEnglishSubtitle });
    const result = await service.download({
      url: "https://www.youtube.com/watch?v=abc123",
      onProgress: (payload) => progressEvents.push(payload)
    });

    assert.strictEqual(result.platform, "youtube");
    assert.strictEqual(result.subtitleProvider, "youtube_author_subtitles");
    assert.ok(result.videoPath.endsWith(".mp4"));
    assert.strictEqual(path.basename(result.videoPath), "source-abc123.mp4");
    assert.strictEqual(path.basename(result.destinationDir), "youtube-abc123");
    assert.ok(result.subtitlePath.endsWith(".en.srt"));
    assert.strictEqual(await fs.readFile(result.videoPath, "utf8"), "video");
    assert.ok(downloadArgs.includes("bv*+ba/b"));
    assert.ok(downloadArgs.includes("res:1080"));
    assert.ok(downloadArgs.includes("--fragment-retries"));
    const downloadTemplate = downloadArgs[downloadArgs.indexOf("--output") + 1];
    assert.strictEqual(path.basename(downloadTemplate), "source-abc123.%(ext)s");
    assert.ok(path.dirname(downloadTemplate).startsWith(os.tmpdir()));
    assert.ok(!downloadTemplate.includes("%(title)"));
    assert.ok(progressEvents.some((event) => event.stage === "video" && event.percent > 40));
    assert.strictEqual(progressEvents.at(-1).percent, 100);

    const noSubtitleService = new SourceDownloadService({
      workspaceRoot: path.join(root, "projects"),
      sourceDownloadRoot: path.join(root, "sources-no-sub")
    }, {
      runExternal,
      fetchEnglishSubtitle: async () => {
        throw new Error("no English captions");
      }
    });
    const withoutSubtitle = await noSubtitleService.download({ url: "https://www.tiktok.com/@creator/video/123" });
    assert.strictEqual(withoutSubtitle.subtitlePath, "");
    assert.strictEqual(withoutSubtitle.warnings.length, 1);

    console.log("sourceDownloadService tests passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
