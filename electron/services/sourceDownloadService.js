const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { buildCliEnv } = require("./cliEnv");
const { fetchYoutubeSubtitle, parseSrt } = require("./podcastViralService");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);

function safeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function slugify(value) {
  return safeText(value || "video")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "video";
}

function validateSourceUrl(value) {
  let parsed;
  try {
    parsed = new URL(safeText(value));
  } catch (_error) {
    throw new Error("Liên kết không hợp lệ. Hãy nhập URL YouTube hoặc TikTok đầy đủ.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Liên kết phải bắt đầu bằng http:// hoặc https://.");
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const isYoutube = host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  const isTikTok = host === "tiktok.com" || host.endsWith(".tiktok.com");
  if (!isYoutube && !isTikTok) {
    throw new Error("Tool hiện chỉ hỗ trợ liên kết YouTube và TikTok.");
  }
  return {
    url: parsed.toString(),
    platform: isYoutube ? "youtube" : "tiktok"
  };
}

function runExternal(command, args, { timeoutMs = 2 * 60 * 60 * 1000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let settled = false;
    const child = spawn(command, args, {
      windowsHide: true,
      env: buildCliEnv()
    });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const consume = (chunk, target, bufferName) => {
      const text = chunk.toString("utf8");
      target.push(chunk);
      let buffer = bufferName === "stdout" ? stdoutBuffer : stderrBuffer;
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      if (bufferName === "stdout") stdoutBuffer = buffer;
      else stderrBuffer = buffer;
      lines.forEach((line) => onLine?.(line));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out while downloading the source video.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => consume(chunk, stdout, "stdout"));
    child.stderr.on("data", (chunk) => consume(chunk, stderr, "stderr"));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutBuffer) onLine?.(stdoutBuffer);
      if (stderrBuffer) onLine?.(stderrBuffer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        const detail = safeText(stderrText || stdoutText).slice(-1200);
        const error = new Error(`${command} exited with code ${code}: ${detail}`);
        error.stdout = stdoutText;
        error.stderr = stderrText;
        reject(error);
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

function parseMetadata(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_error) {
      // yt-dlp may print warnings before the JSON payload.
    }
  }
  throw new Error("yt-dlp không trả về metadata hợp lệ cho liên kết này.");
}

async function findDownloadedVideo(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath);
    if (stat.size > 0) candidates.push({ filePath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.filePath || "";
}

async function publishDownloadedVideo(stagedPath, destinationDir, sourceId) {
  const extension = VIDEO_EXTENSIONS.has(path.extname(stagedPath).toLowerCase())
    ? path.extname(stagedPath).toLowerCase()
    : ".mp4";
  const destinationPath = path.join(destinationDir, `source-${sourceId}${extension}`);
  await fs.copyFile(stagedPath, destinationPath);
  return destinationPath;
}

function explainDownloadError(error) {
  const message = safeText(error?.message);
  if (/unable to open for writing|no such file or directory|filename or extension is too long|enametoolong/i.test(message)
    && /\.part(?:-Frag\d+)?\.part|Frag\d+/i.test(message)) {
    return new Error("Không thể ghi fragment tải video trên Windows. Tool đã chuyển sang đường dẫn tải tạm ngắn; hãy thử tải lại. Nếu lỗi vẫn lặp lại, kiểm tra quyền ghi thư mục Temp và thư mục nguồn trong Cài đặt.");
  }
  return error;
}

function parseDownloadedPath(stdout) {
  const matches = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("__CINEVIRAL_FILE__:"));
  return matches.length ? matches.at(-1).slice("__CINEVIRAL_FILE__:".length).trim() : "";
}

function progressFromLine(line) {
  const match = String(line || "").match(/__CINEVIRAL_PROGRESS__:\s*([\d.]+)%?\|([^|]*)\|([^|]*)/);
  if (!match) return null;
  return {
    percent: Math.max(0, Math.min(100, Number(match[1]) || 0)),
    speed: safeText(match[2]),
    eta: safeText(match[3])
  };
}

function formatSrtTimestamp(value) {
  const totalMs = Math.max(0, Math.round(Number(value || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

async function normalizeSubtitleToSrt(inputPath, outputPath) {
  if (path.extname(inputPath).toLowerCase() === ".srt") {
    if (path.resolve(inputPath) !== path.resolve(outputPath)) await fs.copyFile(inputPath, outputPath);
    return outputPath;
  }
  const cues = parseSrt(await fs.readFile(inputPath, "utf8"));
  if (!cues.length) throw new Error("Transcript tải được nhưng không có cue hợp lệ để chuyển sang SRT.");
  const contents = cues.map((cue, index) => [
    index + 1,
    `${formatSrtTimestamp(cue.startSec)} --> ${formatSrtTimestamp(cue.endSec)}`,
    cue.text
  ].join("\n")).join("\n\n");
  await fs.writeFile(outputPath, `${contents}\n`, "utf8");
  return outputPath;
}

class SourceDownloadService {
  constructor(settings = {}, dependencies = {}) {
    this.settings = settings;
    this.runExternal = dependencies.runExternal || runExternal;
    this.fetchEnglishSubtitle = dependencies.fetchEnglishSubtitle || fetchYoutubeSubtitle;
  }

  async download({ url, onProgress } = {}) {
    const source = validateSourceUrl(url);
    const command = this.settings.ytDlpCommand || "yt-dlp";
    const destinationRoot = this.settings.sourceDownloadRoot
      || path.join(path.dirname(this.settings.workspaceRoot), "sources");
    const progress = (stage, percent, message, detail = "") => onProgress?.({
      stage,
      percent,
      message,
      detail
    });

    progress("metadata", 2, "Đang đọc thông tin video");
    const metadataResult = await this.runExternal(command, [
      "--no-playlist",
      "--skip-download",
      "--dump-single-json",
      source.url
    ], { timeoutMs: 120000 });
    const metadata = parseMetadata(metadataResult.stdout);
    const sourceId = slugify(metadata.id || `${source.platform}-${Date.now()}`);
    const title = safeText(metadata.title || `${source.platform}-${sourceId}`);
    // Keep both directory and media basename short. yt-dlp appends long fragment
    // suffixes while downloading, which can otherwise exceed Windows path limits.
    const destinationDir = path.join(destinationRoot, `${source.platform}-${sourceId}`);
    const stagingDir = path.join(os.tmpdir(), `cvdl-${sourceId}-${process.pid}-${Date.now()}`);
    await fs.mkdir(destinationDir, { recursive: true });
    await fs.mkdir(stagingDir, { recursive: true });

    progress("video", 8, "Đang tải video tối đa 1080p");
    const outputTemplate = path.join(stagingDir, `source-${sourceId}.%(ext)s`);
    let videoPath = "";
    try {
      const downloadResult = await this.runExternal(command, [
        "--no-playlist",
        "--newline",
        "--continue",
        "--no-overwrites",
        "--windows-filenames",
        "--retries", "10",
        "--fragment-retries", "10",
        "--format", "bv*+ba/b",
        "--format-sort", "res:1080",
        "--merge-output-format", "mp4",
        "--output", outputTemplate,
        "--print", "after_move:__CINEVIRAL_FILE__:%(filepath)s",
        "--progress-template", "download:__CINEVIRAL_PROGRESS__:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        source.url
      ], {
        onLine: (line) => {
          const current = progressFromLine(line);
          if (!current) return;
          const scaledPercent = 8 + current.percent * 0.77;
          const detail = [current.speed, current.eta && `còn ${current.eta}`].filter(Boolean).join(" · ");
          progress("video", scaledPercent, `Đang tải video ${current.percent.toFixed(0)}%`, detail);
        }
      });

      let stagedVideoPath = parseDownloadedPath(downloadResult.stdout);
      try {
        if (!stagedVideoPath || !(await fs.stat(stagedVideoPath)).isFile()) stagedVideoPath = "";
      } catch (_error) {
        stagedVideoPath = "";
      }
      if (!stagedVideoPath) stagedVideoPath = await findDownloadedVideo(stagingDir);
      if (!stagedVideoPath) throw new Error("Đã chạy yt-dlp nhưng không tìm thấy file video sau khi tải.");
      videoPath = await publishDownloadedVideo(stagedVideoPath, destinationDir, sourceId);
    } catch (error) {
      throw explainDownloadError(error);
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }

    let subtitlePath = "";
    let subtitleProvider = "";
    const warnings = [];
    progress("transcript", 88, "Đang tìm transcript tiếng Anh có sẵn");
    try {
      const subtitle = await this.fetchEnglishSubtitle({
        command,
        youtubeUrl: source.url,
        outputDir: path.join(destinationDir, "english-transcript")
      });
      subtitlePath = path.join(destinationDir, `${path.parse(videoPath).name}.en.srt`);
      await normalizeSubtitleToSrt(subtitle.subtitlePath, subtitlePath);
      subtitleProvider = subtitle.provider || "platform_subtitles";
    } catch (error) {
      warnings.push(`Video không có transcript tiếng Anh tải được: ${safeText(error.message)}`);
    }

    progress("complete", 100, subtitlePath
      ? "Đã tải video và transcript tiếng Anh"
      : "Đã tải video; không tìm thấy transcript tiếng Anh");
    return {
      sourceUrl: source.url,
      platform: source.platform,
      title,
      sourceId,
      durationSec: Number(metadata.duration || 0),
      videoPath,
      subtitlePath,
      subtitleProvider,
      destinationDir,
      warnings
    };
  }
}

module.exports = SourceDownloadService;
module.exports.validateSourceUrl = validateSourceUrl;
module.exports.parseMetadata = parseMetadata;
module.exports.progressFromLine = progressFromLine;
module.exports.normalizeSubtitleToSrt = normalizeSubtitleToSrt;
