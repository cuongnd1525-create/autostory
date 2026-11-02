// Two-Phase Video Rendering Engine for AI Video Recap Mode.
// Handles:
// 1. Fast draft render for Gemini quality review and user preview.
// 2. Full-resolution pristine final render cut from original source.
// 3. Audio mixing with ducked ambient sound (20%) and synchronized narration.
// 4. Zero A/V desync with frame-accurate timestamp management.

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const RecapHardwareService = require("./recapHardwareService");
const { throwIfCancelled, trackChild } = require("../cancelToken");
const RecapCaptionService = require("./recapCaptionService");
const RecapRenderCacheService = require("./recapRenderCacheService");

class RecapRenderer {
  constructor(options = {}) {
    this.ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    this.ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
    this.hardwareService = options.hardwareService || new RecapHardwareService({ ffmpegPath: this.ffmpegPath });
    this.logger = options.logger || console;
    this.captionService = options.captionService || new RecapCaptionService(options.settings || {});
    this.segmentCache = options.segmentCache || new RecapRenderCacheService();
  }

  async runCommand(binary, args, { cancelToken = null, captureStdout = false } = {}) {
    return new Promise((resolve, reject) => {
      try {
        throwIfCancelled(cancelToken);
      } catch (err) {
        return reject(err);
      }

      const stdoutChunks = [];
      const stderrChunks = [];
      const child = spawn(binary, args, { windowsHide: true });
      const untrackChild = trackChild(child, cancelToken);

      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

      child.on("error", (err) => {
        untrackChild();
        reject(err);
      });

      child.on("close", (code) => {
        untrackChild();
        if (cancelToken && cancelToken.cancelled) {
          return reject(new Error(cancelToken.reason || "Render cancelled by user."));
        }
        const stderr = Buffer.concat(stderrChunks).toString();
        if (code !== 0) {
          const causes = stderr.split(/[\r\n]+/).filter(line => /error|failed|cannot allocate|pthread|out of memory|resource temporarily unavailable|no space|permission denied/i.test(line));
          const detail = [...new Set([...causes.slice(0, 6), ...stderr.trim().split(/[\r\n]+/).slice(-5)])].join("\n");
          return reject(Object.assign(new Error(`FFmpeg failed (code ${code}): ${detail.slice(0, 2400)}`), {
            kind: "ffmpeg_exit", exitCode: code, stderr, command: { binary, args: [...args] }
          }));
        }
        resolve(captureStdout ? Buffer.concat(stdoutChunks).toString() : stderr);
      });
    });
  }

  videoThreadArgs(args, concurrency = 1, safe = false) {
    const cpus = Math.max(1, os.availableParallelism?.() || os.cpus().length || 1);
    const threads = safe ? Math.min(2, cpus) : Math.max(1, Math.min(8, Math.floor(cpus / concurrency)));
    const input = args.indexOf("-i");
    if (input < 0) throw new Error("Render command is missing its input.");
    // Input decoder, filter pools and output encoder each have separate thread
    // settings. Three encoders must not each allocate the whole machine.
    return ["-filter_threads", safe ? "1" : "2", "-filter_complex_threads", safe ? "1" : "2",
      ...args.slice(0, input), "-threads", safe ? "1" : "2", ...args.slice(input, -1),
      "-threads:v", String(threads), args.at(-1)];
  }

  canRetryVideo(error) {
    return error.kind === "ffmpeg_exit"
      && !/no space left|permission denied|invalid argument|no such file|unknown encoder|not divisible by 2/i.test(error.stderr || "")
      && /generic error in an external library|cannot allocate memory|out of memory|pthread_create|resource temporarily unavailable|thread.*(?:failed|error)|error (?:while )?opening encoder/i.test(error.stderr || "");
  }

  async recordRenderFailure(error, { outputPath, stage, index }) {
    const file = path.join(path.dirname(outputPath), ".recap-render-errors",
      `${stage}-${index + 1}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.log`);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify({ stage, segment: index + 1, exitCode: error.exitCode,
        command: error.command, message: error.message }, null, 2)}\n\n${error.stderr || ""}`);
      error.diagnosticPath = file;
    } catch (logError) { this.logger.warn?.(`Cannot save recap render diagnostic: ${logError.message}`); }
    return error;
  }

  async renderVideoBatches({ count, concurrency, render, outputPath, stage, onProgress = () => {}, cancelToken }) {
    for (let start = 0; start < count; start += concurrency) {
      throwIfCancelled(cancelToken);
      const indices = Array.from({ length: Math.min(concurrency, count - start) }, (_, i) => start + i);
      // Drain every sibling before retry/cleanup. Promise.all rejected while
      // other FFmpeg processes were still encoding the same batch.
      const settled = await Promise.allSettled(indices.map(index => render(index, false)));
      throwIfCancelled(cancelToken);
      const failures = [];
      for (let i = 0; i < settled.length; i++) if (settled[i].status === "rejected") {
        const error = await this.recordRenderFailure(settled[i].reason, { outputPath, stage, index: indices[i] });
        failures.push({ index: indices[i], error });
      }
      const terminal = failures.find(({ error }) => !this.canRetryVideo(error));
      if (terminal) throw this.renderFailureContext(terminal.error, stage, terminal.index, count);
      for (const { index, error } of failures) {
        throwIfCancelled(cancelToken);
        onProgress({ level: "WARNING", stage, segmentIndex: index + 1, retry: 1, diagnosticPath: error.diagnosticPath,
          message: `FFmpeg lỗi ở ${stage} ${index + 1}/${count}; đang thử lại riêng tác vụ này với ít luồng hơn. Log: ${error.diagnosticPath || error.message}` });
        try { await render(index, true); }
        catch (retryError) {
          throwIfCancelled(cancelToken);
          await this.recordRenderFailure(retryError, { outputPath, stage, index });
          throw this.renderFailureContext(retryError, stage, index, count);
        }
      }
    }
  }

  renderFailureContext(error, stage, index, count) {
    error.message = `${stage} ${index + 1}/${count}: ${error.message}${error.diagnosticPath ? `\nLog FFmpeg đầy đủ: ${error.diagnosticPath}` : ""}`;
    return error;
  }

  async probeVideo(filePath) {
    try {
      const output = await this.runCommand(this.ffprobePath, [
        "-v", "error",
        "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration",
        "-of", "json",
        filePath
      ], { captureStdout: true });
      const parsed = JSON.parse(output);
      const videoStream = parsed.streams?.find((s) => s.codec_type === "video") || {};
      const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");
      return {
        durationSec: Number(parsed.format?.duration || 0),
        width: Number(videoStream.width || 1920),
        height: Number(videoStream.height || 1080),
        hasAudio: Boolean(audioStream)
      };
    } catch (_err) {
      return { durationSec: 0, width: 1920, height: 1080, hasAudio: true };
    }
  }

  /**
   * Builds the composite narration master audio track by placing each retimed
   * speech unit at its exact timeline offset with silent padding in between.
   */
  async buildNarrationTrack({ decisions, totalDurationSec, tempDir, cancelToken }) {
    throwIfCancelled(cancelToken);
    const narrationListPath = path.join(tempDir, "narration_concat.txt");
    const retimedAudioDir = path.join(tempDir, "retimed_audio");
    await fs.mkdir(retimedAudioDir, { recursive: true });

    const normalizedUnits = new Array(decisions.length);
    const normalizeTasks = decisions
      .map((dec, dIdx) => ({ dec, dIdx }))
      .filter(({ dec }) => Boolean(dec.audio_path));

    const normalizeSingle = async ({ dec, dIdx }) => {
      throwIfCancelled(cancelToken);
      const tempo = Number(dec.voice_tempo || 1.0);
      if (!Number.isFinite(tempo) || tempo < 0.5 || tempo > 2) throw new Error(`Invalid narration tempo: ${tempo}`);
      const unitAudioPath = path.join(retimedAudioDir, `speech_normalized_${dIdx}.wav`);
      await this.runCommand(this.ffmpegPath, [
        "-y", "-i", dec.audio_path,
        "-filter:a", `${Math.abs(tempo - 1) > 0.0001 ? `atempo=${tempo.toFixed(4)},` : ""}aresample=44100`,
        "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", unitAudioPath
      ], { cancelToken });
      const effectiveDuration = (await this.probeVideo(unitAudioPath)).durationSec;
      if (!(effectiveDuration > 0)) throw new Error(`Cannot measure normalized narration: ${dec.speech_unit_id}`);
      normalizedUnits[dIdx] = { unitAudioPath, effectiveDuration };
    };

    for (let startIdx = 0; startIdx < normalizeTasks.length; startIdx += 4) {
      throwIfCancelled(cancelToken);
      await Promise.all(normalizeTasks.slice(startIdx, startIdx + 4).map(normalizeSingle));
    }

    let currentAudioTimeline = 0.0;
    const concatEntries = [];
    let silenceIndex = 0;

    for (let dIdx = 0; dIdx < decisions.length; dIdx++) {
      throwIfCancelled(cancelToken);
      const dec = decisions[dIdx];
      if (!dec.audio_path) continue;
      const { unitAudioPath, effectiveDuration } = normalizedUnits[dIdx];

      // First clip in decision determines the speech unit's timeline start
      const firstClip = dec.clips && dec.clips.length > 0 ? dec.clips[0] : null;
      const targetSpeechStart = firstClip
        ? Number((firstClip.output_start + (firstClip.lead_ms ?? 250) / 1000).toFixed(3))
        : currentAudioTimeline;

      // If there is a silence gap before this speech unit, generate silent padding
      const gap = Number((targetSpeechStart - currentAudioTimeline).toFixed(3));
      if (gap > 0.02) {
        const silencePath = path.join(retimedAudioDir, `silence_${silenceIndex++}.wav`);
        await this.runCommand(this.ffmpegPath, [
          "-y",
          "-f", "lavfi",
          "-i", "anullsrc=r=44100:cl=stereo",
          "-t", String(gap),
          "-c:a", "pcm_s16le",
          silencePath
        ], { cancelToken });
        concatEntries.push(`file '${silencePath.replace(/\\/g, "/")}'`);
        currentAudioTimeline = targetSpeechStart;
      }

      concatEntries.push(`file '${unitAudioPath.replace(/\\/g, "/")}'`);
      currentAudioTimeline = Number((currentAudioTimeline + effectiveDuration).toFixed(3));
    }

    // Trailing silence up to totalDurationSec if needed
    if (totalDurationSec && currentAudioTimeline < totalDurationSec - 0.05) {
      const remaining = Number((totalDurationSec - currentAudioTimeline).toFixed(3));
      const trailingSilence = path.join(retimedAudioDir, `silence_trailing.wav`);
      await this.runCommand(this.ffmpegPath, [
        "-y",
        "-f", "lavfi",
        "-i", "anullsrc=r=44100:cl=stereo",
        "-t", String(remaining),
        "-c:a", "pcm_s16le",
        trailingSilence
      ], { cancelToken });
      concatEntries.push(`file '${trailingSilence.replace(/\\/g, "/")}'`);
    }

    if (concatEntries.length === 0) {
      // Return 1s silent audio if no narration
      const emptyTrack = path.join(tempDir, "empty_narration.m4a");
      await this.runCommand(this.ffmpegPath, [
        "-y",
        "-f", "lavfi",
        "-i", "anullsrc=r=44100:cl=stereo",
        "-t", "1.0",
        "-c:a", "aac",
        "-b:a", "128k",
        emptyTrack
      ], { cancelToken });
      return emptyTrack;
    }

    await fs.writeFile(narrationListPath, concatEntries.join("\n"), "utf8");
    const masterNarrationPath = path.join(tempDir, "master_narration.m4a");
    await this.runCommand(this.ffmpegPath, [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", narrationListPath,
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      masterNarrationPath
    ], { cancelToken });

    return masterNarrationPath;
  }

  getTimelineDuration(decisions) {
    return Math.max(...decisions.flatMap((decision) => [
      ...(decision.clips || []).map((clip) => clip.output_end),
      (decision.clips?.[0]?.output_start || 0) + (decision.clips?.[0]?.lead_ms ?? 250) / 1000
        + Number(decision.audio_duration || 0) / Number(decision.voice_tempo || 1)
    ]), 0);
  }

  segmentTiming(clips, index, fps, totalDurationSec) {
    const startFrame = index === 0 ? 0 : Math.round(clips[index].output_start * fps);
    const endFrame = Math.round((clips[index + 1]?.output_start ?? totalDurationSec) * fps);
    if (endFrame <= startFrame) throw new Error("Recap clips have an invalid or overlapping output timeline.");
    return { durationSec: (endFrame - startFrame) / fps,
      initialGapSec: index === 0 ? Math.max(0, clips[index].output_start) : 0 };
  }

  framingFilter(presentation = {}, clip = {}, draft = false) {
    if (presentation.aspect !== "9:16") return draft ? "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2" : "null";
    const width = draft ? 360 : 1080, height = draft ? 640 : 1920;
    if (presentation.framing === "smart_crop") {
      const x = Math.max(0, Math.min(1, Number(clip.focus_x ?? 0.5))), y = Math.max(0, Math.min(1, Number(clip.focus_y ?? 0.5)));
      return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:x='max(0,min(iw-ow,iw*${x}-ow/2))':y='max(0,min(ih-oh,ih*${y}-oh/2))'`;
    }
    return `split=2[back][front];[back]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=20:1[blur];[front]scale=${width}:${height}:force_original_aspect_ratio=decrease[fit];[blur][fit]overlay=(W-w)/2:(H-h)/2`;
  }

  async captionFilter({ presentation, narrationPath, decisions, captionDirectory, width, height, onProgress }) {
    if (!presentation?.captions || presentation.captions === "off") return null;
    const caption = await this.captionService.prepare({ narrationPath, decisions, directory: captionDirectory,
      style: presentation.captions, language: presentation.language, width, height, onProgress });
    const escaped = caption.assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    return `ass='${escaped}'`;
  }

  /**
   * Renders the draft proxy video for AI quality review and preview.
   */
  async renderDraft({
    sourceVideoPath,
    proxyVideoPath = null,
    muteSourceAudio = false,
    presentation = {},
    captionDirectory,
    decisions = [],
    outputPath,
    onProgress = () => {},
    cancelToken = null
  }) {
    throwIfCancelled(cancelToken);
    const tempDir = path.join(os.tmpdir(), `recap-draft-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      const inputVideo = (proxyVideoPath && (await this._fileExists(proxyVideoPath)))
        ? proxyVideoPath
        : sourceVideoPath;
      const hasSourceAudio = !muteSourceAudio && (await this.probeVideo(inputVideo)).hasAudio;
      const sourceStat = await fs.stat(inputVideo);
      const inputIdentity = { path: path.resolve(inputVideo), size: sourceStat.size, mtimeMs: sourceStat.mtimeMs };

      const encoder = await this.hardwareService.detectBestEncoder();
      const draftEncArgs = this.hardwareService.getFastDraftEncoderArgs(encoder);
      const allClips = decisions.flatMap((d) => d.clips || []);

      if (!allClips.length) {
        throw new Error("Cannot render recap: no edit decision clips provided.");
      }

      const totalVideoDuration = this.getTimelineDuration(decisions);
      onProgress({ percent: 10, stage: "draft_audio", message: "Generating narration master track..." });
      const narrationTrack = await this.buildNarrationTrack({
        decisions,
        totalDurationSec: totalVideoDuration,
        tempDir,
        cancelToken
      });
      const caption = await this.captionFilter({ presentation, narrationPath: narrationTrack, decisions,
        captionDirectory: captionDirectory || path.join(path.dirname(outputPath), "captions"),
        width: presentation.aspect === "9:16" ? 360 : 640, height: presentation.aspect === "9:16" ? 640 : 360, onProgress });

      // Render individual draft segments with bounded concurrency
      const concatEntries = new Array(allClips.length);
      const isHwEncoder = /nvenc|qsv|amf/i.test(draftEncArgs.join(" "));
      const concurrency = isHwEncoder ? 2 : 3;
      let completedCount = 0;

      const renderDraftSegment = async (i, safe) => {
        throwIfCancelled(cancelToken);
        const clip = allClips[i];
        const rawDur = clip.source_end - clip.source_start;
        const speed = clip.video_speed || 1.0;
        const timing = this.segmentTiming(allClips, i, 24, totalVideoDuration);

        const vfFilters = [
          `setpts=${(1 / speed).toFixed(8)}*(PTS-STARTPTS)`,
          this.framingFilter(presentation, clip, true),
          `setsar=1`,
          `fps=24`,
          ...(timing.initialGapSec > 0 ? [`tpad=start_mode=clone:start_duration=${timing.initialGapSec}`] : []),
          `tpad=stop_mode=clone:stop_duration=${timing.durationSec}`,
          `trim=duration=${timing.durationSec}`, "setpts=PTS-STARTPTS"
        ];

        const clipArgs = [
          "-y",
          "-ss", String(clip.source_start),
          "-t", String(rawDur),
          "-i", inputVideo,
          "-vf", vfFilters.join(","),
          ...draftEncArgs,
          "-t", String(timing.durationSec),
        ];
        if (hasSourceAudio) {
          const tempoFilter = Math.abs(speed - 1) > 0.01 ? `atempo=${speed.toFixed(4)},` : "";
          clipArgs.push("-af", `${tempoFilter}volume=0.20,aresample=44100,aformat=channel_layouts=stereo,${timing.initialGapSec > 0 ? `adelay=${Math.round(timing.initialGapSec * 1000)}:all=1,` : ""}apad,atrim=duration=${timing.durationSec}`, "-ac", "2", "-c:a", "aac", "-b:a", "128k");
        } else clipArgs.push("-an");
        const cached = await this.segmentCache.render({ directory: path.join(path.dirname(outputPath), ".recap-segments"),
          inputIdentity, args: clipArgs, ffmpegPath: this.ffmpegPath, cancelToken,
          render: file => this.runCommand(this.ffmpegPath, this.videoThreadArgs([...clipArgs, file], concurrency, safe), { cancelToken }) });
        concatEntries[i] = `file '${cached.file.replace(/\\/g, "/")}'\nduration ${timing.durationSec}`;

        completedCount++;
        const progressPercent = 10 + Math.round((completedCount / allClips.length) * 65);
        onProgress({
          percent: progressPercent,
          stage: "draft_segments",
          message: `${cached.hit ? "Reusing" : "Rendering"} draft segment ${completedCount} of ${allClips.length}...`, cacheHit: cached.hit
        });
      };

      await this.renderVideoBatches({ count: allClips.length, concurrency, render: renderDraftSegment,
        outputPath, stage: "draft_segments", onProgress, cancelToken });

      // Concat segments
      throwIfCancelled(cancelToken);
      const concatList = path.join(tempDir, "segments_concat.txt");
      await fs.writeFile(concatList, concatEntries.join("\n"), "utf8");
      const assembledVideo = path.join(tempDir, "assembled_video.mp4");

      await this.runCommand(this.ffmpegPath, [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatList,
        "-c", "copy",
        assembledVideo
      ], { cancelToken });

      // Final draft mux with narration track
      throwIfCancelled(cancelToken);
      onProgress({ percent: 85, stage: "draft_mux", message: "Finalizing draft reel..." });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      const draftMuxArgs = [
        "-y",
        "-i", assembledVideo,
        "-i", narrationTrack,
        ...(hasSourceAudio ? ["-filter_complex", "[0:a:0][1:a:0]amix=inputs=2:duration=first:dropout_transition=2[aout]"] : []),
        "-map", "0:v:0",
        "-map", hasSourceAudio ? "[aout]" : "1:a:0",
        ...(caption ? ["-vf", caption, ...draftEncArgs] : ["-c:v", "copy"]),
        "-c:a", "aac",
        "-b:a", "128k",
        outputPath
      ];
      await this.renderVideoBatches({ count: 1, concurrency: 1, outputPath, stage: "draft_mux", onProgress, cancelToken,
        render: (_index, safe) => this.runCommand(this.ffmpegPath, this.videoThreadArgs(draftMuxArgs, 1, safe), { cancelToken }) });

      onProgress({ percent: 100, stage: "draft_complete", message: "Draft render completed." });
      return outputPath;
    } finally {
      await this._cleanupDir(tempDir);
    }
  }

  /**
   * Renders the final master recap video from original source with editor-grade mixing.
   */
  async renderFinal({
    sourceVideoPath,
    muteSourceAudio = false,
    presentation = {},
    captionDirectory,
    decisions = [],
    outputPath,
    onProgress = () => {},
    cancelToken = null
  }) {
    throwIfCancelled(cancelToken);
    const tempDir = path.join(os.tmpdir(), `recap-final-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      const sourceMeta = await this.probeVideo(sourceVideoPath);
      const sourceStat = await fs.stat(sourceVideoPath);
      const inputIdentity = { path: path.resolve(sourceVideoPath), size: sourceStat.size, mtimeMs: sourceStat.mtimeMs };
      const hasSourceAudio = !muteSourceAudio && sourceMeta.hasAudio;
      const encoder = await this.hardwareService.detectBestEncoder();
      const allClips = decisions.flatMap((d) => d.clips || []);

      if (!allClips.length) {
        throw new Error("Cannot render final recap: no edit decision clips provided.");
      }

      const totalVideoDuration = this.getTimelineDuration(decisions);
      onProgress({ percent: 5, stage: "final_audio", message: "Assembling narration track..." });
      const narrationTrack = await this.buildNarrationTrack({
        decisions,
        totalDurationSec: totalVideoDuration,
        tempDir,
        cancelToken
      });
      const caption = await this.captionFilter({ presentation, narrationPath: narrationTrack, decisions,
        captionDirectory: captionDirectory || path.join(path.dirname(outputPath), "captions"),
        width: presentation.aspect === "9:16" ? 1080 : sourceMeta.width,
        height: presentation.aspect === "9:16" ? 1920 : sourceMeta.height, onProgress });

      // Render pristine segments from original source with bounded concurrency
      const concatEntries = new Array(allClips.length);
      const isHwEncoder = /nvenc|qsv|amf/i.test((encoder.args || []).join(" "));
      const concurrency = isHwEncoder ? 2 : 3;
      let completedCount = 0;

      const renderFinalSegment = async (i, safe) => {
        throwIfCancelled(cancelToken);
        const clip = allClips[i];
        const rawDur = clip.source_end - clip.source_start;
        const speed = clip.video_speed || 1.0;
        const timing = this.segmentTiming(allClips, i, 30, totalVideoDuration);

        const vfFilters = [
          `setpts=${(1 / speed).toFixed(8)}*(PTS-STARTPTS)`,
          this.framingFilter(presentation, clip, false),
          `setsar=1`,
          `fps=30`,
          ...(timing.initialGapSec > 0 ? [`tpad=start_mode=clone:start_duration=${timing.initialGapSec}`] : []),
          `tpad=stop_mode=clone:stop_duration=${timing.durationSec}`,
          `trim=duration=${timing.durationSec}`, "setpts=PTS-STARTPTS"
        ];

        const clipArgs = [
          "-y",
          "-ss", String(clip.source_start),
          "-t", String(rawDur),
          "-i", sourceVideoPath,
          "-vf", vfFilters.join(","),
          ...encoder.args,
          "-pix_fmt", "yuv420p"
        ];

        // Duck source ambient audio to 20% if source has audio
        if (!hasSourceAudio) {
          clipArgs.push("-an");
        } else {
          const atempoStr = Math.abs(speed - 1.0) > 0.01 ? `atempo=${speed.toFixed(4)},` : "";
          clipArgs.push("-af", `${atempoStr}volume=0.20,aresample=44100,aformat=channel_layouts=stereo,${timing.initialGapSec > 0 ? `adelay=${Math.round(timing.initialGapSec * 1000)}:all=1,` : ""}apad,atrim=duration=${timing.durationSec}`, "-ac", "2", "-c:a", "aac", "-b:a", "192k");
        }

        clipArgs.push("-t", String(timing.durationSec));
        const cached = await this.segmentCache.render({ directory: path.join(path.dirname(outputPath), ".recap-segments"),
          inputIdentity, args: clipArgs, ffmpegPath: this.ffmpegPath, cancelToken,
          render: file => this.runCommand(this.ffmpegPath, this.videoThreadArgs([...clipArgs, file], concurrency, safe), { cancelToken }) });
        // AAC encoder padding must not accumulate as video timeline gaps.
        concatEntries[i] = `file '${cached.file.replace(/\\/g, "/")}'\nduration ${timing.durationSec}`;

        completedCount++;
        const progressPercent = 5 + Math.round((completedCount / allClips.length) * 75);
        onProgress({
          percent: progressPercent,
          stage: "final_segments",
          message: `${cached.hit ? "Reusing" : "Rendering"} master cut ${completedCount} of ${allClips.length} (${encoder.label})...`, cacheHit: cached.hit
        });
      };

      await this.renderVideoBatches({ count: allClips.length, concurrency, render: renderFinalSegment,
        outputPath, stage: "final_segments", onProgress, cancelToken });

      // Concat segments
      throwIfCancelled(cancelToken);
      const concatList = path.join(tempDir, "final_concat.txt");
      await fs.writeFile(concatList, concatEntries.join("\n"), "utf8");
      const assembledVideo = path.join(tempDir, "assembled_final_video.mp4");

      await this.runCommand(this.ffmpegPath, [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatList,
        "-c", "copy",
        assembledVideo
      ], { cancelToken });

      // Final master mux: combine assembled video (ducked ambient audio) + narration track
      throwIfCancelled(cancelToken);
      onProgress({ percent: 90, stage: "final_mux", message: "Mixing audio and writing master output..." });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      const finalMuxArgs = [
        "-y",
        "-i", assembledVideo,
        "-i", narrationTrack,
        ...(hasSourceAudio ? ["-filter_complex", "[0:a:0][1:a:0]amix=inputs=2:duration=first:dropout_transition=2[aout]"] : []),
        "-map", "0:v:0",
        "-map", hasSourceAudio ? "[aout]" : "1:a:0",
        ...(caption ? ["-vf", caption, ...encoder.args] : ["-c:v", "copy"]),
        "-c:a", "aac",
        "-b:a", "320k",
        "-movflags", "+faststart",
        outputPath
      ];

      await this.renderVideoBatches({ count: 1, concurrency: 1, outputPath, stage: "final_mux", onProgress, cancelToken,
        render: (_index, safe) => this.runCommand(this.ffmpegPath, this.videoThreadArgs(finalMuxArgs, 1, safe), { cancelToken }) });

      onProgress({ percent: 100, stage: "final_complete", message: "Final recap video rendered successfully." });
      return outputPath;
    } finally {
      await this._cleanupDir(tempDir);
    }
  }

  async _fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch (_e) {
      return false;
    }
  }

  async _cleanupDir(dirPath) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch (_err) {
      // Ignored
    }
  }
}

module.exports = RecapRenderer;
