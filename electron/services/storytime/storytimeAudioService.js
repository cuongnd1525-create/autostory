const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const RecapTtsService = require("../recap/recapTtsService");

class StorytimeAudioService {
  constructor(settings = {}) {
    this.settings = settings;
    this.ffmpegPath = settings.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    this.ffprobePath = settings.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
    this.ttsService = new RecapTtsService(settings);
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
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString();
          reject(new Error(`${binary} failed (code ${code}): ${stderr.slice(-600)}`));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString()
        });
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
   * Synthesizes the full narration speech units and returns audio paths and timed segments.
   */
  async synthesizeNarration({ segments = [], storyText, outputDir, voiceProvider = "kokoro", voiceId = "am_adam", signal, onProgress }) {
    await fs.mkdir(outputDir, { recursive: true });
    const provider = voiceProvider || this.settings.defaultVoiceProvider || "kokoro";
    const resolvedVoice = voiceId || (provider === "kokoro" ? "am_adam" : (provider === "elevenlabs" ? "pNInz6obpgDQGcFmaJgB" : "en-US-ChristopherNeural"));

    onProgress?.({ message: `Synthesizing narration using ${provider} (${resolvedVoice})...` });

    // Synthesize full narrative text as unified track for maximum prosody flow
    const fullAudioPath = path.join(outputDir, "storytime_voice_full.wav");
    await this.ttsService.synthesizeRaw({
      text: storyText,
      outputPath: fullAudioPath,
      provider,
      voiceId: resolvedVoice,
      signal
    });

    // Also synthesize segment clips for precise timeline alignment and caching
    const synthesizedSegments = [];
    for (let i = 0; i < segments.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const seg = segments[i];
      const segPath = path.join(outputDir, `seg_${String(i + 1).padStart(2, "0")}.wav`);
      
      onProgress?.({
        percent: Math.round(((i + 1) / segments.length) * 50),
        message: `Synthesizing audio segment ${i + 1}/${segments.length}...`
      });

      await this.ttsService.synthesizeRaw({
        text: seg.text,
        outputPath: segPath,
        provider,
        voiceId: resolvedVoice,
        signal
      });

      const dur = await this.probeAudioDuration(segPath);
      synthesizedSegments.push({
        ...seg,
        audioPath: segPath,
        actualDurationSec: dur
      });
    }

    return {
      fullAudioPath,
      segments: synthesizedSegments
    };
  }

  /**
   * Extracts raw Foley/ASMR audio from the source video (e.g. scraping, excavating, cleaning).
   */
  async extractFoleyAudio({ sourceVideoPath, outputPath, durationSec = 0 }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const args = ["-y", "-i", sourceVideoPath];
    if (durationSec > 0) {
      args.push("-t", String(durationSec));
    }
    args.push(
      "-vn",
      "-af", "highpass=f=75,lowpass=f=12000,volume=1.0",
      "-c:a", "pcm_s16le",
      "-ar", "44100",
      outputPath
    );

    await this.runCommand(this.ffmpegPath, args, 60000);
    return outputPath;
  }

  /**
   * Mixes Voiceover (at 0dB) with Source Foley ASMR (ducked at -16dB) into master audio.
   */
  async mixMasterAudio({
    voiceAudioPath,
    foleyAudioPath = null,
    outputPath,
    foleyVolume = 0.16, // -16dB
    bgmPath = null,
    bgmVolume = 0.08,   // -22dB
    durationSec = 0
  }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    // Case 1: Pure Voice (no Foley)
    if (!foleyAudioPath) {
      await fs.copyFile(voiceAudioPath, outputPath);
      return outputPath;
    }

    // Case 2: Voice + Foley ASMR (+ optional BGM)
    const inputs = ["-i", voiceAudioPath, "-i", foleyAudioPath];
    let filterComplex = "";

    if (bgmPath) {
      inputs.push("-i", bgmPath);
      // [0:a] voice 1.0x, [1:a] foley at foleyVolume, [2:a] bgm at bgmVolume
      filterComplex = `[1:a]volume=${foleyVolume}[foley];[2:a]volume=${bgmVolume}[bgm];[0:a][foley][bgm]amix=inputs=3:duration=first:dropout_transition=2[out]`;
    } else {
      // [0:a] voice 1.0x, [1:a] foley at foleyVolume
      filterComplex = `[1:a]volume=${foleyVolume}[foley];[0:a][foley]amix=inputs=2:duration=first:dropout_transition=2[out]`;
    }

    const args = [
      "-y",
      ...inputs,
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-c:a", "pcm_s16le",
      "-ar", "44100"
    ];

    if (durationSec > 0) {
      args.push("-t", String(durationSec));
    }
    args.push(outputPath);

    await this.runCommand(this.ffmpegPath, args, 60000);
    return outputPath;
  }
}

module.exports = StorytimeAudioService;
