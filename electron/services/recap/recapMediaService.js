const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const SceneDetectionService = require("../sceneDetectionService");

class RecapMediaService {
  constructor(settings = {}) {
    this.ffmpegPath = settings.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    this.ffprobePath = settings.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
    this.sceneDetector = new SceneDetectionService(settings);
    this.settings = settings;
  }

  async runCommand(binary, args, timeoutMs = 600000) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { windowsHide: true });
      const stdoutChunks = [];
      const stderrChunks = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`${binary} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      child.stdout.on("data", (c) => stdoutChunks.push(c));
      child.stderr.on("data", (c) => stderrChunks.push(c));
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        if (code !== 0) {
          reject(new Error(`${binary} exited with code ${code}: ${stderr || stdout}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async probeVideo(videoPath) {
    const { stdout } = await this.runCommand(this.ffprobePath, [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      videoPath
    ], 30000);

    const parsed = JSON.parse(stdout || "{}");
    const videoStream = (parsed.streams || []).find((s) => s.codec_type === "video") || {};
    const audioStream = (parsed.streams || []).find((s) => s.codec_type === "audio") || null;
    const format = parsed.format || {};

    const duration = Number(videoStream.duration || format.duration || 0);
    const width = Number(videoStream.width || 0);
    const height = Number(videoStream.height || 0);

    let fps = 25;
    if (videoStream.avg_frame_rate && videoStream.avg_frame_rate.includes("/")) {
      const [num, den] = videoStream.avg_frame_rate.split("/").map(Number);
      if (den > 0) fps = num / den;
    } else if (videoStream.r_frame_rate && videoStream.r_frame_rate.includes("/")) {
      const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
      if (den > 0) fps = num / den;
    }

    return {
      duration: Number(duration.toFixed(3)),
      width,
      height,
      fps: Number(fps.toFixed(3)),
      videoCodec: videoStream.codec_name || "unknown",
      hasAudio: Boolean(audioStream),
      audioCodec: audioStream ? audioStream.codec_name : null,
      sizeBytes: Number(format.size || 0),
      bitrate: Number(format.bit_rate || 0)
    };
  }

  computeFileFingerprint(filePath, stat) {
    const data = JSON.stringify({
      path: path.resolve(filePath).toLowerCase(),
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs)
    });
    return crypto.createHash("sha256").update(data).digest("hex").slice(0, 20);
  }

  /**
   * Generates a lightweight analysis proxy:
   * - Maximum ~480p width
   * - Reduced frame rate (8 fps)
   * - Reduced video & audio bitrates
   * - Burned source timecode for visual grounding
   * Preserves exact timeline mapping to the original source.
   */
  async ensureAnalysisProxy({ sourceVideoPath, outputDir, onProgress }) {
    await fs.mkdir(outputDir, { recursive: true });
    const stat = await fs.stat(sourceVideoPath);
    const fingerprint = this.computeFileFingerprint(sourceVideoPath, stat);
    const proxyPath = path.join(outputDir, `recap-proxy-${fingerprint}.mp4`);

    try {
      const existing = await fs.stat(proxyPath);
      if (existing.size > 1024) {
        onProgress?.({ percent: 100, message: "Dùng proxy phân tích đã cache" });
        return proxyPath;
      }
    } catch (_err) {
      // Create new proxy
    }

    onProgress?.({ percent: 10, message: "Đang tạo proxy phân tích video (480p/8fps)..." });

    // Video filter:
    // Scale to max 480 width preserving aspect ratio, ensure even dimensions, force 8 fps, burn timecode
    const vf = [
      "scale='min(480,iw)':-2",
      "fps=8",
      "drawtext=timecode='00\\:00\\:00\\:00':r=8:fontcolor=white:box=1:boxcolor=black@0.6:fontsize=16:x=10:y=10"
    ].join(",");

    const tempPath = `${proxyPath}.tmp.mp4`;
    await fs.unlink(tempPath).catch(() => {});

    await this.runCommand(this.ffmpegPath, [
      "-y",
      "-i", sourceVideoPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "30",
      "-c:a", "aac",
      "-b:a", "48k",
      "-ac", "1",
      "-ar", "22050",
      "-movflags", "+faststart",
      tempPath
    ], 1800000); // 30 min max for very long source

    await fs.rename(tempPath, proxyPath);
    onProgress?.({ percent: 100, message: "Đã tạo xong proxy phân tích" });
    return proxyPath;
  }

  /**
   * Detects scene boundaries on the proxy.
   */
  async detectScenes({ proxyPath, sourceDuration, onProgress }) {
    onProgress?.({ percent: 30, message: "Đang phân tích ranh giới cảnh (scene detection)..." });
    const result = await this.sceneDetector.detectScenes({
      videoPath: proxyPath,
      sourceDuration
    });
    return result.scenes || [];
  }

  /**
   * Plans chunk intervals for long videos.
   * Chunks respect natural scene boundaries with a 2s overlap.
   * Target chunk duration: ~180s - 300s.
   */
  planChunks({ scenes, sourceDuration, targetChunkSec = 240, overlapSec = 2 }) {
    if (sourceDuration <= targetChunkSec + 30) {
      // Short video: single chunk
      return [{
        chunkIndex: 1,
        sourceStartSec: 0,
        sourceEndSec: Number(sourceDuration.toFixed(3)),
        durationSec: Number(sourceDuration.toFixed(3)),
        isSingleChunk: true
      }];
    }

    const chunks = [];
    let currentStart = 0;
    let chunkIndex = 1;

    while (currentStart < sourceDuration - 10) {
      let idealEnd = Math.min(sourceDuration, currentStart + targetChunkSec);
      
      if (idealEnd < sourceDuration) {
        // Find a scene boundary near idealEnd
        const candidateScenes = scenes.filter((s) => s.endSec >= idealEnd - 45 && s.endSec <= idealEnd + 45);
        if (candidateScenes.length > 0) {
          // Pick closest boundary
          candidateScenes.sort((a, b) => Math.abs(a.endSec - idealEnd) - Math.abs(b.endSec - idealEnd));
          idealEnd = candidateScenes[0].endSec;
        }
      }

      const chunkEnd = Math.min(sourceDuration, idealEnd);
      chunks.push({
        chunkIndex,
        sourceStartSec: Number(currentStart.toFixed(3)),
        sourceEndSec: Number(chunkEnd.toFixed(3)),
        durationSec: Number((chunkEnd - currentStart).toFixed(3)),
        isSingleChunk: false
      });

      if (chunkEnd >= sourceDuration - 0.5) break;

      // Next start includes small overlap
      currentStart = Math.max(0, chunkEnd - overlapSec);
      chunkIndex += 1;
    }

    return chunks;
  }

  /**
   * Extracts a chunk file from the proxy.
   */
  async extractProxyChunk({ proxyPath, chunk, outputDir }) {
    await fs.mkdir(outputDir, { recursive: true });
    const chunkFileName = `recap-proxy-chunk-${String(chunk.chunkIndex).padStart(3, "0")}.mp4`;
    const outputPath = path.join(outputDir, chunkFileName);

    try {
      const existing = await fs.stat(outputPath);
      if (existing.size > 1024) return outputPath;
    } catch (_err) {
      // Extract
    }

    const tempPath = `${outputPath}.tmp.mp4`;
    await fs.unlink(tempPath).catch(() => {});

    await this.runCommand(this.ffmpegPath, [
      "-y",
      "-ss", String(chunk.sourceStartSec),
      "-t", String(chunk.durationSec),
      "-i", proxyPath,
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      tempPath
    ], 120000);

    await fs.rename(tempPath, outputPath);
    return outputPath;
  }
}

module.exports = RecapMediaService;
