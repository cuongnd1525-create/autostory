const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const EdgeTtsService = require("../edgeTtsService");
const ElevenLabsService = require("../elevenLabsService");
const WindowsVoiceService = require("../windowsVoiceService");
const KokoroVoiceService = require("../kokoroVoiceService");
const OmniVoiceService = require("../omniVoiceService");
const VoiceProfileService = require("../voiceProfileService");

class RecapTtsService {
  constructor(settings = {}) {
    this.settings = settings;
    this.ffmpegPath = settings.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    this.ffprobePath = settings.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
    this.voiceProfileService = new VoiceProfileService();
  }

  async runCommand(binary, args, timeoutMs = 60000) {
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

  async probeAudioDuration(audioPath) {
    try {
      const { stdout } = await this.runCommand(this.ffprobePath, [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        audioPath
      ], 15000);
      const val = parseFloat(stdout.trim());
      return Number.isFinite(val) ? Number(val.toFixed(3)) : 0;
    } catch (_err) {
      return 0;
    }
  }

  /**
   * Trims leading and trailing silence from TTS audio without destroying
   * natural internal pauses between words.
   * Uses double silenceremove + areverse.
   */
  async trimAudioSilence(inputPath, outputPath) {
    // 1. Remove leading silence (-45dB, > 30ms)
    // 2. Reverse audio
    // 3. Remove leading silence (which was original trailing silence)
    // 4. Reverse back to original orientation
    const filter = "silenceremove=start_periods=1:start_duration=0.03:start_threshold=-45dB:detection=peak,areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-45dB:detection=peak,areverse";

    const tempPath = `${outputPath}.tmp.wav`;
    await fs.unlink(tempPath).catch(() => {});

    try {
      await this.runCommand(this.ffmpegPath, [
        "-y",
        "-i", inputPath,
        "-af", filter,
        "-c:a", "pcm_s16le",
        "-ar", "24000",
        tempPath
      ], 30000);

      await fs.rename(tempPath, outputPath);
      return true;
    } catch (_err) {
      // If silenceremove failed (e.g. file is entirely quiet or very short), copy input to output
      await fs.copyFile(inputPath, outputPath);
      return false;
    }
  }

  resolveProvider(project = {}) {
    return project.voiceProvider || this.settings.defaultVoiceProvider || "edge_neural";
  }

  resolveVoiceId(provider, project = {}) {
    if (provider === "elevenlabs") {
      return project.voiceId || this.settings.defaultVoiceId || "21m00Tcm4TlvDq8ikWAM"; // Rachel default
    }
    if (provider === "kokoro") {
      return project.voiceId || "af_heart";
    }
    if (provider === "windows_local") {
      return project.voiceId || this.settings.defaultWindowsVoice || "";
    }
    return project.voiceId || "en-US-JennyNeural";
  }

  /**
   * Synthesize raw audio for a single text block.
   */
  async synthesizeRaw({ text, outputPath, provider, voiceId, signal }) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    if (provider === "elevenlabs") {
      const service = new ElevenLabsService(this.settings);
      await service.synthesize({
        text,
        voiceId,
        outputPath,
        model: this.settings.elevenLabsModel,
        stability: this.settings.elevenLabsStability,
        similarityBoost: this.settings.elevenLabsSimilarityBoost,
        style: this.settings.elevenLabsStyle,
        speakerBoost: this.settings.elevenLabsSpeakerBoost
      });
      return outputPath;
    }

    if (provider === "kokoro") {
      const service = new KokoroVoiceService(this.settings);
      await service.synthesize({
        text,
        voice: voiceId,
        outputPath,
        speed: this.settings.kokoroSpeed || 1.0
      });
      return outputPath;
    }

    if (provider === "omnivoice") {
      const service = new OmniVoiceService(this.settings);
      await service.synthesize({
        text,
        outputPath,
        instruct: this.settings.omniVoiceInstruct || ""
      });
      return outputPath;
    }

    if (provider === "windows_local") {
      const service = new WindowsVoiceService(this.settings);
      await service.synthesize({
        text,
        voiceName: voiceId,
        outputPath,
        rate: this.settings.windowsVoiceRate || 0
      });
      return outputPath;
    }

    // Default: Edge Neural
    const edgeService = new EdgeTtsService(this.settings);
    await edgeService.synthesize({
      text,
      voice: voiceId,
      outputPath,
      rate: "+0%",
      pitch: "+0Hz",
      volume: 100
    });
    return outputPath;
  }

  /**
   * Synthesizes a SpeechUnit, trims silence, measures duration, and updates voice profile.
   */
  async processSpeechUnit({ speechUnit, outputDir, workspaceRoot, project, signal, onProgress }) {
    await fs.mkdir(outputDir, { recursive: true });
    const provider = this.resolveProvider(project);
    const voiceId = this.resolveVoiceId(provider, project);

    const rawPath = path.join(outputDir, `${speechUnit.id}_raw.wav`);
    const trimmedPath = path.join(outputDir, `${speechUnit.id}_trimmed.wav`);

    // Check if trimmed audio already exists and is valid
    try {
      const stat = await fs.stat(trimmedPath);
      if (stat.size > 512) {
        const cachedDuration = await this.probeAudioDuration(trimmedPath);
        if (cachedDuration > 0.1) {
          return {
            speech_unit_id: speechUnit.id,
            audio_path: trimmedPath,
            raw_path: rawPath,
            duration: cachedDuration,
            text: speechUnit.text,
            isCached: true
          };
        }
      }
    } catch (_err) {
      // Synthesize
    }

    onProgress?.({ message: `TTS (${provider}): "${speechUnit.text.slice(0, 45)}..."` });

    await this.synthesizeRaw({
      text: speechUnit.text,
      outputPath: rawPath,
      provider,
      voiceId,
      signal
    });

    const rawDuration = await this.probeAudioDuration(rawPath);
    await this.trimAudioSilence(rawPath, trimmedPath);
    const trimmedDuration = await this.probeAudioDuration(trimmedPath);
    const finalDuration = trimmedDuration > 0.05 ? trimmedDuration : rawDuration;

    // Record sample in voice profile service to learn actual duration
    if (workspaceRoot) {
      await this.voiceProfileService.recordSample(
        workspaceRoot,
        { provider, voiceId, language: "en", style: "recap" },
        { text: speechUnit.text, measuredDurationSec: finalDuration }
      ).catch(() => {});
    }

    return {
      speech_unit_id: speechUnit.id,
      audio_path: trimmedPath,
      raw_path: rawPath,
      duration: finalDuration,
      raw_duration: rawDuration,
      text: speechUnit.text,
      isCached: false
    };
  }

  async getVoiceProfile(workspaceRoot, project = {}) {
    const provider = this.resolveProvider(project);
    const voiceId = this.resolveVoiceId(provider, project);
    return this.voiceProfileService.getProfile(workspaceRoot, {
      provider,
      voiceId,
      language: "en",
      style: "recap"
    });
  }
}

module.exports = RecapTtsService;
