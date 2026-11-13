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
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        if (code !== 0) {
          const detail = (stderr || stdout).trim().split(/[\r\n]+/).slice(-12).join("\n").slice(-2400);
          reject(Object.assign(new Error(`${binary} exited with code ${code}${signal ? ` (${signal})` : ""}: ${detail}`),
            { kind: "media_process_exit", exitCode: code, signal, stderr, command: { binary, args: [...args] } }));
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
      audioDurationSec: audioStream ? this.streamDuration(audioStream) : null,
      sizeBytes: Number(format.size || 0),
      bitrate: Number(format.bit_rate || 0)
    };
  }

  streamDuration(stream) {
    if (Number(stream.duration) > 0) return Number(stream.duration);
    const parts = String(stream.tags?.DURATION || "").match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    return parts ? Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]) : null;
  }

  async validateAnalysisProxy(file, source, { decode = true } = {}) {
    const stat = await fs.stat(file), meta = await this.probeVideo(file);
    if (stat.size <= 1024 || meta.videoCodec !== "h264" || !meta.width || meta.width > 480 || !meta.height
      || meta.width % 2 || meta.height % 2 || Math.abs(meta.fps - 8) > .01
      || Math.abs(meta.duration - source.duration) > .25 || (source.hasAudio && !meta.hasAudio)
      || (source.audioDurationSec > 0 && (!(meta.audioDurationSec > 0) || Math.abs(meta.audioDurationSec - source.audioDurationSec) > .35)))
      throw new Error(`Proxy chưa đầy đủ hoặc sai định dạng/thời lượng (${meta.duration}s / nguồn ${source.duration}s).`);
    if (decode) await this.runCommand(this.ffmpegPath, ["-hide_banner", "-nostdin", "-v", "error", "-xerror",
      "-threads", "2", "-i", file, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], 120000);
    return stat;
  }

  async recordProxyFailure(error, outputDir) {
    const diagnostic = path.join(outputDir, `recap-proxy-error-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.log`);
    try { await fs.writeFile(diagnostic, `${JSON.stringify({ exitCode: error.exitCode, command: error.command,
      message: error.message }, null, 2)}\n\n${error.stderr || ""}`); return diagnostic; }
    catch (_) { return null; }
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
  async ensureAnalysisProxy({ sourceVideoPath, sourceMeta, outputDir, onProgress }) {
    await fs.mkdir(outputDir, { recursive: true });
    const stat = await fs.stat(sourceVideoPath);
    const fingerprint = this.computeFileFingerprint(sourceVideoPath, stat);
    const proxyPath = path.join(outputDir, `recap-proxy-${fingerprint}.mp4`);
    const source = sourceMeta || await this.probeVideo(sourceVideoPath);
    const manifestPath = `${proxyPath}.verified.json`;
    const signature = info => JSON.stringify([1, fingerprint, info.size, info.mtimeMs]);
    const markVerified = async file => {
      const info = await fs.stat(file), temp = `${manifestPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(temp, JSON.stringify({ signature: signature(info) })); await fs.rename(temp, manifestPath);
    };

    try {
      const existing = await fs.stat(proxyPath);
      if (existing.size > 1024) {
        let manifest; try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch (_) {}
        await this.validateAnalysisProxy(proxyPath, source, { decode: manifest?.signature !== signature(existing) });
        await markVerified(proxyPath);
        onProgress?.({ percent: 100, message: "Dùng proxy phân tích đã kiểm tra và cache" });
        return proxyPath;
      }
    } catch (_err) {
      // Create new proxy
    }

    onProgress?.({ percent: 10, message: "Đang tạo proxy phân tích video (480p/8fps)..." });

    // Video filter:
    // Scale to max 480 width preserving aspect ratio, ensure even dimensions, force 8 fps, burn timecode
    const vf = [
      "scale='trunc(min(480,iw)/2)*2':-2",
      "fps=8",
      "drawtext=timecode='00\\:00\\:00\\:00':r=8:fontcolor=white:box=1:boxcolor=black@0.6:fontsize=16:x=10:y=10"
    ].join(",");
    const fontFile = process.platform === "win32" ? path.join(process.env.WINDIR || "C:\\Windows", "Fonts", "arial.ttf")
      : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
    const filter = fsSync.existsSync(fontFile) ? vf.replace("drawtext=", `drawtext=fontfile='${fontFile.replace(/\\/g, "/").replace(/:/g, "\\:")}':`) : vf;
    const tempPath = `${proxyPath}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp.mp4`;
    const args = safe => [
      "-hide_banner", "-nostdin", "-loglevel", "warning", "-nostats", "-y",
      "-filter_threads", safe ? "1" : "2", "-threads", safe ? "1" : "4",
      "-i", sourceVideoPath,
      "-map", "0:v:0", "-map", "0:a?", "-vf", filter,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "30",
      "-c:a", "aac",
      "-b:a", "48k",
      "-ac", "1",
      "-ar", "22050",
      "-movflags", "+faststart",
      "-threads:v", safe ? "2" : "4", "-threads:a", "1",
      tempPath
    ];
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.runCommand(this.ffmpegPath, args(attempt > 0), 1800000);
          await this.validateAnalysisProxy(tempPath, source);
          break;
        } catch (error) {
          const diagnostic = await this.recordProxyFailure(error, outputDir);
          const nativeCrash = Number.isInteger(error.exitCode) && (error.exitCode >>> 0) === 0xc0000005;
          if (nativeCrash) {
            try {
              await this.validateAnalysisProxy(tempPath, source);
              onProgress?.({ level: "WARNING", message: `FFmpeg crash khi kết thúc nhưng proxy đã đủ hình/tiếng và giải mã toàn bộ không lỗi; dùng bản đã kiểm chứng.${diagnostic ? ` Log: ${diagnostic}` : ""}` });
              break;
            } catch (_) { /* Retry only the known native crash, never accept incomplete media. */ }
          }
          if (!nativeCrash || attempt > 0) {
            if (diagnostic) error.message += `\nLog đầy đủ: ${diagnostic}`;
            throw error;
          }
          await fs.unlink(tempPath).catch(() => {});
          onProgress?.({ level: "WARNING", message: "FFmpeg crash 0xC0000005; đang tạo lại riêng proxy với ít luồng hơn (1/1)..." });
        }
      }
      await fs.rename(tempPath, proxyPath);
      await markVerified(proxyPath);
    } finally { await fs.unlink(tempPath).catch(() => {}); }
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
    // Stream-copy seeking includes keyframe preroll and changes the actual
    // source interval. Version the cache so incorrect old clips are not reused.
    const chunkFileName = `recap-proxy-chunk-${String(chunk.chunkIndex).padStart(3, "0")}-accurate-v2.mp4`;
    const outputPath = path.join(outputDir, chunkFileName);
    const proxyStat = await fs.stat(proxyPath);
    const signature = JSON.stringify([2, proxyPath, proxyStat.size, proxyStat.mtimeMs, chunk.sourceStartSec, chunk.durationSec]);
    const manifestPath = `${outputPath}.json`;

    try {
      const existing = await fs.stat(outputPath);
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (existing.size > 1024 && manifest.signature === signature) return outputPath;
    } catch (_err) {
      // Extract
    }

    const tempPath = `${outputPath}.tmp.mp4`;
    await fs.unlink(tempPath).catch(() => {});

    await this.runCommand(this.ffmpegPath, [
      "-y",
      "-ss", String(chunk.sourceStartSec),
      "-i", proxyPath,
      "-t", String(chunk.durationSec),
      "-map", "0:v:0", "-map", "0:a?",
      "-vf", "setpts=PTS-STARTPTS",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
      "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-ar", "22050",
      "-movflags", "+faststart",
      tempPath
    ], 120000);

    const actual = await this.probeVideo(tempPath);
    if (Math.abs(actual.duration - chunk.durationSec) > 0.2) {
      await fs.unlink(tempPath).catch(() => {});
      throw new Error(`Proxy chunk sai thời lượng: yêu cầu ${chunk.durationSec}s, thực tế ${actual.duration}s. Không gửi clip lệch timeline cho AI.`);
    }

    await fs.rename(tempPath, outputPath);
    await fs.writeFile(manifestPath, JSON.stringify({ signature, durationSec: actual.duration }), "utf8");
    return outputPath;
  }
}

module.exports = RecapMediaService;
