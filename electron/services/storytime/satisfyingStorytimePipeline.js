const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const StorytimeScriptService = require("./storytimeScriptService");
const StorytimeAudioService = require("./storytimeAudioService");
const StorytimeOverlayService = require("./storytimeOverlayService");
const RecapHardwareService = require("../recap/recapHardwareService");

function escapePathForFilter(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

class SatisfyingStorytimePipeline {
  constructor(settings = {}) {
    this.settings = settings;
    this.ffmpegPath = settings.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    this.ffprobePath = settings.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
    this.scriptService = new StorytimeScriptService(settings);
    this.audioService = new StorytimeAudioService(settings);
    this.overlayService = new StorytimeOverlayService(settings);
    this.hardwareService = new RecapHardwareService(settings);
  }

  async runCommand(binary, args, { signal, timeoutMs = 300000 } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        return reject(new DOMException("Pipeline cancelled", "AbortError"));
      }

      const child = spawn(binary, args, { windowsHide: true });
      const stdoutChunks = [];
      const stderrChunks = [];
      let settled = false;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new DOMException("Pipeline cancelled by user", "AbortError"));
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

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
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
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

  async probeVideo(filePath) {
    try {
      const { stdout } = await this.runCommand(this.ffprobePath, [
        "-v", "error",
        "-show_entries", "stream=codec_type,width,height:format=duration",
        "-of", "json",
        filePath
      ], { timeoutMs: 15000 });
      const parsed = JSON.parse(stdout);
      const vStream = parsed.streams?.find((s) => s.codec_type === "video") || {};
      const aStream = parsed.streams?.find((s) => s.codec_type === "audio");
      return {
        durationSec: Number(parsed.format?.duration || 0),
        width: Number(vStream.width || 1080),
        height: Number(vStream.height || 1920),
        hasAudio: Boolean(aStream)
      };
    } catch (_err) {
      return { durationSec: 60, width: 1080, height: 1920, hasAudio: false };
    }
  }

  /**
   * Master execution function for Satisfying Storytime Mode.
   */
  async run({
    sourceVideoPath,
    outputPath,
    script = null, // Pre-generated or user-edited script object
    persona = "contractor",
    customPersonaText = "",
    conflict = "contract_dispute",
    customConflictText = "",
    controversyLevel = 2,
    customIdea = "",
    sourceText = "",
    voiceProvider = "kokoro",
    voiceId = "am_adam",
    highlightColor = "cyan", // 'cyan' | 'yellow' | 'neon_green'
    enableHeaderCard = true,
    enableFoleyDuck = true,
    foleyVolume = 0.16, // -16dB
    bgmPath = null,
    bgmVolume = 0.08,   // -22dB
    signal,
    onProgress = () => {}
  }) {
    const tempDir = path.join(os.tmpdir(), `storytime-run-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      // Step 1: Probe source video
      onProgress({ percent: 5, stage: "probing", message: "Analyzing input footage..." });
      const videoMeta = await this.probeVideo(sourceVideoPath);
      const targetDurationSec = Math.max(45, Math.min(90, Math.round(videoMeta.durationSec || 70)));

      // Step 2: Generate or validate Script
      let finalScript = script;
      if (!finalScript || !finalScript.storyText) {
        onProgress({ percent: 15, stage: "scripting", message: "Generating story via Modular Story Matrix..." });
        finalScript = await this.scriptService.generateStory({
          videoPath: sourceVideoPath,
          targetDurationSec,
          persona,
          customPersonaText,
          conflict,
          customConflictText,
          controversyLevel,
          customIdea,
          sourceText,
          signal,
          onProgress: (p) => onProgress({ percent: 20, stage: "scripting", message: p.message })
        });
      }

      onProgress({ percent: 30, stage: "script_ready", message: `Script ready: "${finalScript.title}"` });

      // Step 3: Narration TTS Voiceover
      onProgress({ percent: 35, stage: "tts", message: "Synthesizing voiceover narrative..." });
      const audioDir = path.join(tempDir, "audio");
      const narrationResult = await this.audioService.synthesizeNarration({
        segments: finalScript.segments,
        storyText: finalScript.storyText,
        outputDir: audioDir,
        voiceProvider,
        voiceId,
        signal,
        onProgress: (p) => onProgress({
          percent: 35 + Math.round((p.percent || 0) * 0.2),
          stage: "tts",
          message: p.message
        })
      });

      // Probe actual total voice duration
      const voiceDurationSec = await this.audioService.probeAudioDuration(narrationResult.fullAudioPath);
      const masterDurationSec = Math.max(10, voiceDurationSec > 0 ? voiceDurationSec + 0.8 : targetDurationSec);

      // Step 4: Foley ASMR & Master Audio Ducking
      let foleyAudioPath = null;
      if (enableFoleyDuck && videoMeta.hasAudio) {
        onProgress({ percent: 55, stage: "foley", message: "Extracting and filtering raw Foley ASMR..." });
        foleyAudioPath = path.join(tempDir, "foley_asmr.wav");
        await this.audioService.extractFoleyAudio({
          sourceVideoPath,
          outputPath: foleyAudioPath,
          durationSec: masterDurationSec
        });
      }

      onProgress({ percent: 62, stage: "mixing", message: "Mixing voice and ducked ambient Foley..." });
      const masterAudioPath = path.join(tempDir, "master_audio.wav");
      await this.audioService.mixMasterAudio({
        voiceAudioPath: narrationResult.fullAudioPath,
        foleyAudioPath,
        outputPath: masterAudioPath,
        foleyVolume,
        bgmPath,
        bgmVolume,
        durationSec: masterDurationSec
      });

      // Step 5: Visual Overlays (Header Hook Card & Kinetic Captions)
      const canvasWidth = 1080;
      const canvasHeight = 1920;

      let cardPngPath = null;
      if (enableHeaderCard && finalScript.headerCard) {
        onProgress({ percent: 70, stage: "header_card", message: "Rendering viral Top Header Hook Card..." });
        const cardSvg = this.overlayService.generateHeaderCardSvg({
          headerCard: finalScript.headerCard,
          width: canvasWidth,
          height: canvasHeight
        });
        const cardRawPath = path.join(tempDir, "header_card.png");
        cardPngPath = await this.overlayService.renderCardToPng({
          svgContent: cardSvg,
          outputPath: cardRawPath,
          width: canvasWidth,
          height: canvasHeight
        });
      }

      // Generate Kinetic Subtitles ASS with Header Hook Card
      onProgress({ percent: 75, stage: "subtitles", message: "Generating kinetic word-highlight subtitles & header card..." });
      const assContent = this.overlayService.generateKineticAssSubtitles({
        segments: narrationResult.segments.length > 0 ? narrationResult.segments : finalScript.segments,
        headerCard: enableHeaderCard ? finalScript.headerCard : null,
        durationSec: masterDurationSec,
        width: canvasWidth,
        height: canvasHeight,
        highlightColor,
        wordsPerGroup: 3,
        fontSize: 64,
        marginV: 640
      });
      const assPath = path.join(tempDir, "subtitles.ass");
      await fs.writeFile(assPath, assContent, "utf8");

      // Step 6: Final 9:16 Video Render
      onProgress({ percent: 80, stage: "rendering", message: "Assembling final TikTok US vertical video..." });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      const encoder = await this.hardwareService.detectBestEncoder();

      // Build FFmpeg command
      const ffmpegArgs = ["-y"];

      // If source video duration is shorter than voice duration, loop video
      if (videoMeta.durationSec > 0 && videoMeta.durationSec < masterDurationSec) {
        ffmpegArgs.push("-stream_loop", "-1");
      }
      ffmpegArgs.push("-i", sourceVideoPath); // Input 0: Video
      ffmpegArgs.push("-i", masterAudioPath); // Input 1: Master Audio

      let cardInputIndex = -1;
      if (cardPngPath && cardPngPath.endsWith(".png")) {
        ffmpegArgs.push("-i", cardPngPath);
        cardInputIndex = 2;
      }

      // Filter graph: Scale & Crop to 9:16 vertical 1080x1920
      const vfSteps = [];
      vfSteps.push("scale=1080:1920:force_original_aspect_ratio=increase");
      vfSteps.push("crop=1080:1920");
      vfSteps.push("setsar=1");
      vfSteps.push("fps=30");

      let currentV = "[0:v]" + vfSteps.join(",") + "[vscaled]";
      let filterComplex = currentV + ";";

      let nextVLabel = "vscaled";
      if (cardInputIndex > 0) {
        filterComplex += `[${nextVLabel}][${cardInputIndex}:v]overlay=0:0[vcard];`;
        nextVLabel = "vcard";
      }

      // Subtitle burn via libass
      const escapedAss = escapePathForFilter(assPath);
      filterComplex += `[${nextVLabel}]ass='${escapedAss}'[vout]`;

      ffmpegArgs.push(
        "-filter_complex", filterComplex,
        "-map", "[vout]",
        "-map", "1:a",
        ...encoder.args,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-t", String(masterDurationSec.toFixed(2)),
        "-movflags", "+faststart",
        outputPath
      );

      await this.runCommand(this.ffmpegPath, ffmpegArgs, { signal, timeoutMs: 360000 });

      onProgress({ percent: 100, stage: "completed", message: "Video rendering complete!" });

      return {
        outputPath,
        title: finalScript.title,
        headerCard: finalScript.headerCard,
        hook: finalScript.hook,
        storyText: finalScript.storyText,
        totalWords: finalScript.totalWords,
        durationSec: Number(masterDurationSec.toFixed(2)),
        masterAudioPath,
        assPath,
        segments: narrationResult.segments
      };
    } finally {
      // Clean up temporary workspace
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (_cleanupErr) {
        // Silently ignore temp file cleanup errors
      }
    }
  }
}

module.exports = SatisfyingStorytimePipeline;
