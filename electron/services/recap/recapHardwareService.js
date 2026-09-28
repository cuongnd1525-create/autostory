const { spawn } = require("child_process");

class RecapHardwareService {
  constructor(settings = {}) {
    this.ffmpegPath = settings.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    this.cachedEncoder = null;
    this.probePromise = null;
  }

  async runProbeCommand(args, timeoutMs = 6000) {
    return new Promise((resolve) => {
      const child = spawn(this.ffmpegPath, args, { windowsHide: true });
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ ok: false, stderr: "Probe timed out" });
      }, timeoutMs);

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, stderr: err.message });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, stderr });
      });
    });
  }

  async testEncoder(encoderName) {
    // Attempt a minimal 0.5s dummy synthetic frame encode.
    // If GPU driver or DLL is missing (e.g. nvcuda.dll), FFmpeg will fail immediately.
    const testArgs = [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=320x240:d=0.5",
      "-c:v", encoderName,
      "-f", "null",
      "-"
    ];
    const result = await this.runProbeCommand(testArgs, 6000);
    return result.ok;
  }

  async detectBestEncoder(forceRefresh = false) {
    if (this.cachedEncoder && !forceRefresh) {
      return this.cachedEncoder;
    }
    if (this.probePromise && !forceRefresh) {
      return this.probePromise;
    }

    this.probePromise = (async () => {
      const candidates = [
        {
          name: "h264_nvenc",
          label: "NVIDIA NVENC",
          args: ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "22"],
          isHardware: true
        },
        {
          name: "h264_qsv",
          label: "Intel Quick Sync (QSV)",
          args: ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "22"],
          isHardware: true
        },
        {
          name: "h264_amf",
          label: "AMD AMF",
          args: ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_p", "22"],
          isHardware: true
        },
        {
          name: "h264_videotoolbox",
          label: "Apple VideoToolbox",
          args: ["-c:v", "h264_videotoolbox", "-q:v", "65"],
          isHardware: true
        }
      ];

      for (const candidate of candidates) {
        try {
          const works = await this.testEncoder(candidate.name);
          if (works) {
            this.cachedEncoder = candidate;
            return candidate;
          }
        } catch (_err) {
          // Continue to next candidate
        }
      }

      // Safe CPU fallback
      const cpuFallback = {
        name: "libx264",
        label: "Software CPU (libx264)",
        args: ["-c:v", "libx264", "-preset", "medium", "-crf", "22"],
        isHardware: false
      };
      this.cachedEncoder = cpuFallback;
      return cpuFallback;
    })();

    const result = await this.probePromise;
    this.probePromise = null;
    return result;
  }

  getFastDraftEncoderArgs(encoder) {
    if (encoder.name === "h264_nvenc") {
      return ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "28"];
    }
    if (encoder.name === "h264_qsv") {
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "28"];
    }
    if (encoder.name === "h264_amf") {
      return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_p", "28"];
    }
    if (encoder.name === "h264_videotoolbox") {
      return ["-c:v", "h264_videotoolbox", "-q:v", "50"];
    }
    return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"];
  }
}

module.exports = RecapHardwareService;
