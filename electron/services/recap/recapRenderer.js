// Two-Phase Video Rendering Engine for AI Video Recap Mode.
// Handles:
// 1. Fast draft render for Gemini quality review and user preview.
// 2. Full-resolution pristine final render cut from original source.
// 3. Audio mixing with ducked ambient sound (20%) and synchronized narration.
// 4. Zero A/V desync with frame-accurate timestamp management.

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const RecapHardwareService = require("./recapHardwareService");
const { throwIfCancelled, trackChild } = require("../cancelToken");

class RecapRenderer {
  constructor(options = {}) {
    this.ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    this.ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
    this.hardwareService = options.hardwareService || new RecapHardwareService({ ffmpegPath: this.ffmpegPath });
    this.logger = options.logger || console;
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
          const errMsg = `FFmpeg failed (code ${code}): ${stderr.slice(-600)}`;
          return reject(new Error(errMsg));
        }
        resolve(captureStdout ? Buffer.concat(stdoutChunks).toString() : stderr);
      });
    });
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

    let currentAudioTimeline = 0.0;
    const concatEntries = [];
    let silenceIndex = 0;

    for (let dIdx = 0; dIdx < decisions.length; dIdx++) {
      throwIfCancelled(cancelToken);
      const dec = decisions[dIdx];
      if (!dec.audio_path) continue;

      // First clip in decision determines the speech unit's timeline start
      const firstClip = dec.clips && dec.clips.length > 0 ? dec.clips[0] : null;
      const targetSpeechStart = firstClip
        ? Number((firstClip.output_start + (firstClip.lead_ms || 250) / 1000).toFixed(3))
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

      // Retime audio if voice_tempo != 1.0
      let unitAudioPath = dec.audio_path;
      const tempo = Number(dec.voice_tempo || 1.0);
      if (Math.abs(tempo - 1.0) > 0.005) {
        const retimedPath = path.join(retimedAudioDir, `speech_retimed_${dIdx}.wav`);
        await this.runCommand(this.ffmpegPath, [
          "-y",
          "-i", dec.audio_path,
          "-filter:a", `atempo=${tempo.toFixed(4)},aresample=44100`,
          "-c:a", "pcm_s16le",
          retimedPath
        ], { cancelToken });
        unitAudioPath = retimedPath;
      }

      concatEntries.push(`file '${unitAudioPath.replace(/\\/g, "/")}'`);

      // Update current timeline position with retimed duration
      const effectiveDuration = (dec.audio_duration || 3.0) / tempo;
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

  /**
   * Renders the draft proxy video for AI quality review and preview.
   */
  async renderDraft({
    sourceVideoPath,
    proxyVideoPath = null,
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

      const encoder = await this.hardwareService.detectBestEncoder();
      const draftEncArgs = this.hardwareService.getFastDraftEncoderArgs(encoder);
      const allClips = decisions.flatMap((d) => d.clips || []);

      if (!allClips.length) {
        throw new Error("Cannot render recap: no edit decision clips provided.");
      }

      const totalVideoDuration = allClips[allClips.length - 1].output_end;
      onProgress({ percent: 10, stage: "draft_audio", message: "Generating narration master track..." });
      const narrationTrack = await this.buildNarrationTrack({
        decisions,
        totalDurationSec: totalVideoDuration,
        tempDir,
        cancelToken
      });

      // Render individual draft segments
      const segmentDir = path.join(tempDir, "segments");
      await fs.mkdir(segmentDir, { recursive: true });
      const concatEntries = [];

      for (let i = 0; i < allClips.length; i++) {
        throwIfCancelled(cancelToken);
        const clip = allClips[i];
        const segPath = path.join(segmentDir, `seg_${String(i).padStart(4, "0")}.mp4`);
        const rawDur = clip.source_end - clip.source_start;
        const speed = clip.video_speed || 1.0;

        const vfFilters = [
          `setpts=${(1 / speed).toFixed(4)}*PTS`,
          `scale=640:360:force_original_aspect_ratio=decrease`,
          `pad=640:360:(ow-iw)/2:(oh-ih)/2`,
          `setsar=1`,
          `fps=24`
        ];

        const clipArgs = [
          "-y",
          "-ss", String(clip.source_start),
          "-t", String(rawDur),
          "-i", inputVideo,
          "-vf", vfFilters.join(","),
          ...draftEncArgs,
          "-an",
          segPath
        ];

        await this.runCommand(this.ffmpegPath, clipArgs, { cancelToken });
        concatEntries.push(`file '${segPath.replace(/\\/g, "/")}'`);

        const progressPercent = 10 + Math.round(((i + 1) / allClips.length) * 65);
        onProgress({
          percent: progressPercent,
          stage: "draft_segments",
          message: `Rendering draft segment ${i + 1} of ${allClips.length}...`
        });
      }

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

      await this.runCommand(this.ffmpegPath, [
        "-y",
        "-i", assembledVideo,
        "-i", narrationTrack,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "128k",
        outputPath
      ], { cancelToken });

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
      const encoder = await this.hardwareService.detectBestEncoder();
      const allClips = decisions.flatMap((d) => d.clips || []);

      if (!allClips.length) {
        throw new Error("Cannot render final recap: no edit decision clips provided.");
      }

      const totalVideoDuration = allClips[allClips.length - 1].output_end;
      onProgress({ percent: 5, stage: "final_audio", message: "Assembling narration track..." });
      const narrationTrack = await this.buildNarrationTrack({
        decisions,
        totalDurationSec: totalVideoDuration,
        tempDir,
        cancelToken
      });

      // Render pristine segments from original source
      const segmentDir = path.join(tempDir, "segments");
      await fs.mkdir(segmentDir, { recursive: true });
      const concatEntries = [];

      for (let i = 0; i < allClips.length; i++) {
        throwIfCancelled(cancelToken);
        const clip = allClips[i];
        const segPath = path.join(segmentDir, `final_seg_${String(i).padStart(4, "0")}.mp4`);
        const rawDur = clip.source_end - clip.source_start;
        const speed = clip.video_speed || 1.0;

        const vfFilters = [
          `setpts=${(1 / speed).toFixed(4)}*PTS`,
          `setsar=1`,
          `fps=30`
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
        if (sourceMeta.hasAudio) {
          const atempoStr = Math.abs(speed - 1.0) > 0.01 ? `atempo=${speed.toFixed(4)},` : "";
          clipArgs.push("-af", `${atempoStr}volume=0.20,aresample=44100`, "-c:a", "aac", "-b:a", "192k");
        } else {
          clipArgs.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-shortest", "-c:a", "aac", "-b:a", "192k");
        }

        clipArgs.push(segPath);
        await this.runCommand(this.ffmpegPath, clipArgs, { cancelToken });
        concatEntries.push(`file '${segPath.replace(/\\/g, "/")}'`);

        const progressPercent = 5 + Math.round(((i + 1) / allClips.length) * 75);
        onProgress({
          percent: progressPercent,
          stage: "final_segments",
          message: `Rendering master cut ${i + 1} of ${allClips.length} (${encoder.label})...`
        });
      }

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
        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]",
        "-map", "0:v:0",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "320k",
        "-movflags", "+faststart",
        outputPath
      ];

      await this.runCommand(this.ffmpegPath, finalMuxArgs, { cancelToken });

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
