const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const EdgeTtsService = require("../edgeTtsService");
const ElevenLabsService = require("../elevenLabsService");
const WindowsVoiceService = require("../windowsVoiceService");
const KokoroVoiceService = require("../kokoroVoiceService");
const OmniVoiceService = require("../omniVoiceService");
const VoiceProfileService = require("../voiceProfileService");

class RecapTtsService {
  constructor(settings = {}, dependencies = {}) {
    this.settings = settings;
    this.providers = dependencies.providers || {};
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
    const isMale = project.voiceGender === "male" || this.settings.defaultVoiceGender === "male";
    const language = project.recapNarrationLanguage || this.settings.recapNarrationLanguage || "en";
    const requestedVoice = project.voiceId || this.settings.defaultVoiceId || "";
    if (provider === "edge_neural" && language === "vi" && !requestedVoice.startsWith("vi-")) {
      return isMale ? "vi-VN-NamMinhNeural" : "vi-VN-HoaiMyNeural";
    }
    if (provider === "edge_neural" && language === "en" && requestedVoice.startsWith("vi-")) return isMale ? "en-US-ChristopherNeural" : "en-US-JennyNeural";
    if (provider === "elevenlabs") {
      if (project.voiceId || this.settings.defaultVoiceId) {
        return project.voiceId || this.settings.defaultVoiceId;
      }
      return isMale ? "pNInz6obpgDQGcFmaJgB" : "21m00Tcm4TlvDq8ikWAM"; // Adam (male narrator) or Rachel (female) default
    }
    if (provider === "kokoro") {
      if (project.voiceId || this.settings.defaultVoiceId) {
        return project.voiceId || this.settings.defaultVoiceId;
      }
      return isMale ? "am_adam" : "af_heart";
    }
    if (provider === "windows_local") {
      return project.voiceId || this.settings.defaultWindowsVoice || "";
    }
    if (project.voiceId || this.settings.defaultVoiceId) {
      return project.voiceId || this.settings.defaultVoiceId;
    }
    return isMale ? "en-US-ChristopherNeural" : "en-US-JennyNeural";
  }

  /**
   * Synthesize raw audio for a single text block.
   */
  async synthesizeRaw({ text, outputPath, provider, voiceId, signal }) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const language = this.settings.recapNarrationLanguage || "en";
    const speed = Math.max(0.85, Math.min(1.3, Number(this.settings.voiceSpeed || 1)));

    if (provider === "elevenlabs") {
      const service = this.providers.elevenlabs || new ElevenLabsService(this.settings);
      await service.synthesizeSpeech({
        text,
        voiceId,
        languageCode: language,
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
      const service = this.providers.kokoro || new KokoroVoiceService(this.settings);
      await service.synthesizeSpeech({
        text,
        voiceName: voiceId,
        language,
        outputPath,
        speed: (this.settings.kokoroSpeed || 1.0) * speed
      });
      return outputPath;
    }

    if (provider === "omnivoice") {
      const service = this.providers.omnivoice || new OmniVoiceService(this.settings);
      await service.synthesizeSpeech({
        text,
        voiceName: voiceId,
        language,
        outputPath,
        instruct: this.settings.omniVoiceInstruct || ""
      });
      return outputPath;
    }

    if (provider === "windows_local") {
      const service = this.providers.windows_local || new WindowsVoiceService(this.settings);
      await service.synthesizeSpeech({
        text,
        voiceName: voiceId,
        outputPath,
        rate: this.settings.windowsVoiceRate || 0
      });
      return outputPath;
    }

    // Default: Edge Neural
    const edgeService = this.providers.edge_neural || new EdgeTtsService(this.settings);
    await edgeService.synthesizeSpeech({
      text,
      voiceName: voiceId,
      language,
      outputPath,
      rate: Math.round((speed - 1) * 100),
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

    const cacheKey = crypto.createHash("sha256").update(JSON.stringify({ text: speechUnit.text, provider, voiceId,
      kokoroSpeed: this.settings.kokoroSpeed, kokoroModel: this.settings.kokoroModel,
      elevenLabsModel: this.settings.elevenLabsModel, windowsVoiceRate: this.settings.windowsVoiceRate,
      language: this.settings.recapNarrationLanguage, voiceSpeed: this.settings.voiceSpeed })).digest("hex").slice(0, 16);
    const fileId = `${String(speechUnit.id).replace(/[^a-zA-Z0-9_-]/g, "_")}-${cacheKey}`;
    const rawPath = path.join(outputDir, `${fileId}_raw.wav`);
    const trimmedPath = path.join(outputDir, `${fileId}_trimmed.wav`);

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
    signal?.throwIfAborted();

    const rawDuration = await this.probeAudioDuration(rawPath);
    await this.trimAudioSilence(rawPath, trimmedPath);
    signal?.throwIfAborted();
    const trimmedDuration = await this.probeAudioDuration(trimmedPath);
    const finalDuration = trimmedDuration > 0.05 ? trimmedDuration : rawDuration;

    // Record sample in voice profile service to learn actual duration
    if (workspaceRoot) {
      await this.voiceProfileService.recordSample(
        workspaceRoot,
        { provider, voiceId, language: this.settings.recapNarrationLanguage || "en", style: "recap" },
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
      language: this.settings.recapNarrationLanguage || "en",
      style: "recap"
    });
  }

  /**
   * Synthesize all SpeechUnits for a project in batch.
   */
  async synthesizeAll({ speechUnits = [], outputDir, workspaceRoot, project, signal, onProgress }) {
    await fs.mkdir(outputDir, { recursive: true });
    const audioTracks = {};
    const total = speechUnits.length;
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const unit = speechUnits[i];
      onProgress?.({
        stage: "tts_synthesis",
        percent: Math.round(((i + 1) / Math.max(1, total)) * 100),
        message: `Synthesizing narration ${i + 1} of ${total}...`
      });
      const result = await this.processSpeechUnit({
        speechUnit: unit,
        outputDir,
        workspaceRoot,
        project,
        signal,
        onProgress
      });
      audioTracks[unit.id] = {
        audioPath: result.audio_path,
        rawPath: result.raw_path,
        durationSec: result.duration,
        text: result.text,
        isCached: result.isCached
      };
    }
    return audioTracks;
  }
}

module.exports = RecapTtsService;
