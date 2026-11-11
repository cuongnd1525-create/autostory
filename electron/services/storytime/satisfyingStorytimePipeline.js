const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const StorytimeBlueprintService = require("./storytimeBlueprintService");
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
    this.blueprintService = new StorytimeBlueprintService(settings);
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
    blueprintId = "artisan_fair_price",
    customBlueprint = null,
    durationMode = "preserve_full", // 'preserve_full' | 'smart_trim'
    localeFlavor = "uk_craftsman",  // 'uk_craftsman' | 'us_tradesman' | 'auto_preserve'
    persona = "contractor",
    customPersonaText = "",
    conflict = "contract_dispute",
    customConflictText = "",
    controversyLevel = 2,
    customIdea = "",
    sourceText = "",
    headerStickerText = "",
    voiceProvider = "kokoro",
    voiceId = "am_adam",
    ttsStability = 0.40,
    injectPauses = true,
    pauseMs = 300,
    enableWordTimestamps = true,
    highlightColor = "yellow", // 'cyan' | 'yellow' | 'neon_green'
    enableHeaderCard = true,
    headerStyle = "native_pill", // 'native_pill' | 'white_box' | 'none'
    wordsPerGroup = 3,
    selectiveHighlight = true,
    maskSourceSubtitles = false, // Default false: rely on thick stroke + deep drop shadow instead of blur box
    syncVideoToVoice = true,
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
      const activeBlueprint = this.blueprintService.getBlueprint(blueprintId, customBlueprint, this.settings);
      const defaultProfile = activeBlueprint.defaultRenderProfile || {};
      const effectiveHeaderStyle = !enableHeaderCard
        ? "none"
        : (headerStyle || defaultProfile.headerStyle || "native_pill");
      const effectiveWordsPerGroup = Math.max(1, Math.min(3, Number(wordsPerGroup || defaultProfile.wordsPerGroup || 3)));
      const effectiveSelectiveHighlight = selectiveHighlight !== undefined
        ? Boolean(selectiveHighlight)
        : Boolean(defaultProfile.selectiveHighlight ?? true);
      const effectiveHighlightColor = highlightColor || defaultProfile.highlightColor || "yellow";

      // Step 1: Probe source video
      onProgress({ percent: 5, stage: "probing", message: "Analyzing input footage..." });
      const videoMeta = await this.probeVideo(sourceVideoPath);
      const targetDurationSec = Math.max(20, Math.min(180, Number((videoMeta.durationSec || 68.6).toFixed(1))));

      // Step 2: Generate or validate Script
      let finalScript = script;
      if (!finalScript || !Array.isArray(finalScript.segments) || finalScript.segments.length === 0) {
        onProgress({ percent: 15, stage: "scripting", message: `Generating story with Blueprint "${activeBlueprint.name}" (${durationMode})...` });
        finalScript = await this.scriptService.generateStory({
          videoPath: sourceVideoPath,
          targetDurationSec,
          durationMode,
          localeFlavor,
          blueprintId,
          customBlueprint,
          persona,
          customPersonaText,
          conflict,
          customConflictText,
          controversyLevel,
          customIdea,
          sourceText,
          headerStickerText,
          signal,
          onProgress: (p) => onProgress({ percent: 20, stage: "scripting", message: p.message })
        });
      }

      onProgress({ percent: 30, stage: "script_ready", message: `Script ready: "${finalScript.title}"` });

      // Step 3: Narration TTS Voiceover (with Stability 0.35-0.45, 300ms pause injection & Whisper word timestamps)
      onProgress({ percent: 35, stage: "tts", message: "Synthesizing voiceover narrative..." });
      const audioDir = path.join(tempDir, "audio");
      const narrationResult = await this.audioService.synthesizeNarration({
        segments: finalScript.segments,
        storyText: finalScript.storyText,
        outputDir: audioDir,
        voiceProvider,
        voiceId,
        stability: ttsStability,
        injectPauses,
        pauseMs,
        enableWordTimestamps,
        signal,
        onProgress: (p) => onProgress({
          percent: 35 + Math.round((p.percent || 0) * 0.2),
          stage: "tts",
          message: p.message
        })
      });

      // Probe actual total voice duration
      const voiceDurationSec = narrationResult.totalDurationSec || await this.audioService.probeAudioDuration(narrationResult.fullAudioPath);
      const isSmartTrim = (finalScript.durationMode || durationMode) === "smart_trim";
      const masterDurationSec = isSmartTrim
        ? Math.max(10, voiceDurationSec > 0 ? voiceDurationSec + 0.35 : targetDurationSec)
        : Math.max(10, syncVideoToVoice ? (voiceDurationSec > 0 ? voiceDurationSec + 0.45 : targetDurationSec) : targetDurationSec);

      // Step 3b: If smart_trim mode is enabled, cut and stitch the selected visual scenes from sourceVideoPath
      let effectiveVideoSourcePath = sourceVideoPath;
      if (isSmartTrim && narrationResult.segments.length > 0 && videoMeta.durationSec > 5) {
        onProgress({ percent: 52, stage: "trimming", message: "Smart-trimming redundant scenes to match narrative beats..." });
        const trimmedClips = [];
        for (let i = 0; i < narrationResult.segments.length; i += 1) {
          const seg = narrationResult.segments[i];
          const srcStart = Math.max(0, Math.min(videoMeta.durationSec - 0.5, Number(seg.sourceStartSec ?? seg.startSec ?? 0)));
          const rawSrcEnd = Number(seg.sourceEndSec ?? (srcStart + (seg.actualDurationSec || seg.durationSec || 3.5)));
          const srcEnd = Math.max(srcStart + 0.4, Math.min(videoMeta.durationSec, rawSrcEnd));
          const srcDur = Math.max(0.4, srcEnd - srcStart);
          const targetClipDur = Math.max(0.4, Number(seg.actualDurationSec || seg.durationSec || srcDur) + (i < narrationResult.segments.length - 1 ? 0.08 : 0.35));
          const ptsFactor = (targetClipDur / srcDur).toFixed(5);
          const clipOut = path.join(tempDir, `trim_seg_${String(i + 1).padStart(2, "0")}.mp4`);
          await this.runCommand(this.ffmpegPath, [
            "-y",
            "-ss", String(srcStart.toFixed(3)),
            "-t", String(srcDur.toFixed(3)),
            "-i", sourceVideoPath,
            "-vf", `setpts=${ptsFactor}*PTS,fps=30`,
            "-an",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "18",
            clipOut
          ], { signal, timeoutMs: 60000 });
          trimmedClips.push(clipOut);
        }
        if (trimmedClips.length > 0) {
          const concatListPath = path.join(tempDir, "trim_concat.txt");
          const concatContent = trimmedClips.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
          await fs.writeFile(concatListPath, concatContent, "utf8");
          const stitchedVideoPath = path.join(tempDir, "smart_trimmed_source.mp4");
          await this.runCommand(this.ffmpegPath, [
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", concatListPath,
            "-c", "copy",
            stitchedVideoPath
          ], { signal, timeoutMs: 90000 });
          effectiveVideoSourcePath = stitchedVideoPath;
        }
      }

      // Step 4: Foley ASMR & Master Audio Ducking (or 100% Muted Original Audio)
      let foleyAudioPath = null;
      if (enableFoleyDuck && Number(foleyVolume) > 0 && videoMeta.hasAudio) {
        onProgress({ percent: 55, stage: "foley", message: "Extracting and filtering raw Foley ASMR..." });
        foleyAudioPath = path.join(tempDir, "foley_asmr.wav");
        await this.audioService.extractFoleyAudio({
          sourceVideoPath,
          outputPath: foleyAudioPath,
          durationSec: masterDurationSec
        });
      }

      onProgress({
        percent: 62,
        stage: "mixing",
        message: enableFoleyDuck && Number(foleyVolume) > 0
          ? `Mixing voice and reduced ambient Foley (${Math.round(Number(foleyVolume) * 100)}%)...`
          : "Preparing clean voiceover track (source audio muted 100%)..."
      });
      const masterAudioPath = path.join(tempDir, "master_audio.wav");
      await this.audioService.mixMasterAudio({
        voiceAudioPath: narrationResult.fullAudioPath,
        foleyAudioPath: enableFoleyDuck && Number(foleyVolume) > 0 ? foleyAudioPath : null,
        outputPath: masterAudioPath,
        foleyVolume: enableFoleyDuck ? Number(foleyVolume) : 0,
        bgmPath,
        bgmVolume,
        durationSec: masterDurationSec
      });

      // Step 5: Visual Overlays (Top Native Pill / 3-Line Header Card & Kinetic Captions)
      const canvasWidth = 1080;
      const canvasHeight = 1920;

      let cardPngPath = null;
      const stickerText = String(
        headerStickerText || finalScript.headerSticker || finalScript.headerCard?.line1 || "Why does NOBODY do this ? 🙄"
      ).trim();

      if (effectiveHeaderStyle === "native_pill") {
        onProgress({ percent: 70, stage: "header_card", message: "Rendering TikTok Native Pill Sticker..." });
        const pillSvg = this.overlayService.generateNativePillSvg({
          stickerText,
          width: canvasWidth,
          height: canvasHeight
        });
        const cardRawPath = path.join(tempDir, "header_card.png");
        cardPngPath = await this.overlayService.renderCardToPng({
          svgContent: pillSvg,
          outputPath: cardRawPath,
          width: canvasWidth,
          height: canvasHeight
        });
      } else if (effectiveHeaderStyle === "white_box" && finalScript.headerCard) {
        onProgress({ percent: 70, stage: "header_card", message: "Rendering 3-Line Top Header Card..." });
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

      const hasPngCard = Boolean(cardPngPath && cardPngPath.endsWith(".png"));

      // Generate Kinetic Subtitles ASS (1-3 words per phrase, thick black stroke + deep drop shadow, no blur box)
      onProgress({ percent: 75, stage: "subtitles", message: "Generating kinetic word-highlight subtitles..." });
      const assContent = this.overlayService.generateKineticAssSubtitles({
        segments: narrationResult.segments.length > 0 ? narrationResult.segments : finalScript.segments,
        headerCard: effectiveHeaderStyle === "white_box" ? finalScript.headerCard : null,
        headerSticker: effectiveHeaderStyle === "native_pill" ? stickerText : "",
        headerStyle: effectiveHeaderStyle,
        includeAssHeader: effectiveHeaderStyle !== "none" && !hasPngCard,
        selectiveHighlight: effectiveSelectiveHighlight,
        durationSec: masterDurationSec,
        width: canvasWidth,
        height: canvasHeight,
        highlightColor: effectiveHighlightColor,
        wordsPerGroup: effectiveWordsPerGroup,
        fontSize: 68,
        outline: 6.5,
        shadow: 3.5,
        marginV: 445
      });
      const assPath = path.join(tempDir, "subtitles.ass");
      await fs.writeFile(assPath, assContent, "utf8");

      // Step 6: Final 9:16 Video Render
      onProgress({ percent: 80, stage: "rendering", message: "Assembling final TikTok vertical video..." });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      const encoder = await this.hardwareService.detectBestEncoder();
      const ffmpegArgs = ["-y"];

      const canSmoothRetime = !isSmartTrim
        && syncVideoToVoice
        && videoMeta.durationSec > 5
        && Math.abs(masterDurationSec - videoMeta.durationSec) / videoMeta.durationSec <= 0.35;

      if (!canSmoothRetime && !isSmartTrim && videoMeta.durationSec > 0 && videoMeta.durationSec < masterDurationSec) {
        ffmpegArgs.push("-stream_loop", "-1");
      }
      ffmpegArgs.push("-i", effectiveVideoSourcePath); // Input 0: Video (source audio ignored via -map 1:a:0)
      ffmpegArgs.push("-i", masterAudioPath); // Input 1: Master Audio

      let cardInputIndex = -1;
      if (hasPngCard) {
        ffmpegArgs.push("-i", cardPngPath);
        cardInputIndex = 2;
      }

      // Filter graph: Scale & Crop to 9:16 vertical 1080x1920 (+ optional smooth PTS fit so visual payoff aligns with ending)
      const vfSteps = [];
      if (canSmoothRetime && Math.abs(masterDurationSec - videoMeta.durationSec) > 0.15) {
        const ptsRatio = (masterDurationSec / videoMeta.durationSec).toFixed(5);
        vfSteps.push(`setpts=${ptsRatio}*PTS`);
      }
      vfSteps.push("scale=1080:1920:force_original_aspect_ratio=increase");
      vfSteps.push("crop=1080:1920");
      vfSteps.push("setsar=1");
      vfSteps.push("fps=30");

      let filterComplex = `[0:v]${vfSteps.join(",")}[vscaled];`;
      let nextVLabel = "vscaled";

      // Optional clean blur mask over existing burnt-in source subtitles (only when explicitly requested)
      if (maskSourceSubtitles) {
        filterComplex += `[${nextVLabel}]split=2[vmain][vsubsrc];[vsubsrc]crop=720:142:180:1384,gblur=sigma=26[vsubblur];[vmain][vsubblur]overlay=180:1384[vmasked];`;
        nextVLabel = "vmasked";
      }

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
        "-map", "1:a:0",
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
        blueprintId: activeBlueprint.id,
        blueprintName: activeBlueprint.name,
        durationMode: finalScript.durationMode || durationMode,
        localeFlavor: finalScript.localeFlavor || localeFlavor,
        ttsStability: narrationResult.stability,
        headerSticker: stickerText,
        headerCard: finalScript.headerCard,
        hook: finalScript.hook,
        storyText: finalScript.storyText,
        totalWords: finalScript.totalWords,
        durationSec: Number(masterDurationSec.toFixed(2)),
        sourceAudioMuted: !enableFoleyDuck || Number(foleyVolume) <= 0,
        segments: narrationResult.segments
      };
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (_cleanupErr) {
        // Ignore temp file cleanup errors
      }
    }
  }
}

module.exports = SatisfyingStorytimePipeline;
