const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { getCancelToken, throwIfCancelled, trackChild } = require("./cancelToken");

function formatSeconds(value) {
  return Number(value).toFixed(3);
}

function escapePathForFilter(filePath) {
  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function escapeDrawText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function buildAtempoFilterChain(rate) {
  const safeRate = Number(rate) > 0 ? Number(rate) : 1;
  const filters = [];
  let remaining = safeRate;

  while (remaining > 2) {
    filters.push("atempo=2.0");
    remaining /= 2;
  }

  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }

  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(",");
}

const SUPPORTED_XFADE_TRANSITIONS = new Set([
  "fade",
  "fadeblack",
  "fadewhite",
  "distance",
  "wipeleft",
  "wiperight",
  "wipeup",
  "wipedown",
  "slideleft",
  "slideright",
  "slideup",
  "slidedown",
  "smoothleft",
  "smoothright",
  "smoothup",
  "smoothdown",
  "circlecrop",
  "rectcrop",
  "circleopen",
  "circleclose",
  "vertopen",
  "vertclose",
  "horzopen",
  "horzclose",
  "dissolve",
  "pixelize",
  "radial",
  "hlslice",
  "hrslice",
  "vuslice",
  "vdslice",
  "squeezeh",
  "squeezev"
]);

function getSafeXfadeTransition(type) {
  const normalized = String(type || "fade").toLowerCase();
  return SUPPORTED_XFADE_TRANSITIONS.has(normalized) ? normalized : "fade";
}

function buildVisualProfileFilter(role, genreMode, width, height) {
  const safeRole = role || "escalation";
  const safeGenre = genreMode || "thriller";

  const isComedy = safeGenre === "comedy";
  const isMystery = safeGenre === "mystery";
  const isSciFi = safeGenre === "sci-fi";
  const isDrama = safeGenre === "drama";

  if (safeRole === "hook") {
    if (safeGenre === "healing" || isDrama) {
      return `scale=${Math.round(width * 1.06)}:${Math.round(height * 1.06)},crop=${width}:${height},eq=contrast=1.10:saturation=1.12:brightness=0.08:gamma=1.18`;
    }
    if (isComedy) {
      return `scale=${Math.round(width * 1.06)}:${Math.round(height * 1.06)},crop=${width}:${height},eq=contrast=1.12:saturation=1.35:brightness=0.06:gamma=1.10`;
    }
    if (isMystery) {
      return `scale=${Math.round(width * 1.08)}:${Math.round(height * 1.08)},crop=${width}:${height},eq=contrast=1.20:saturation=0.80:brightness=-0.05:gamma=1.15`;
    }
    if (isSciFi) {
      return `scale=${Math.round(width * 1.10)}:${Math.round(height * 1.10)},crop=${width}:${height},eq=contrast=1.25:saturation=1.15:brightness=0.05:gamma=1.10,unsharp=5:5:0.85`;
    }
    return `scale=${Math.round(width * 1.10)}:${Math.round(height * 1.10)},crop=${width}:${height},eq=contrast=1.18:saturation=1.22:brightness=0.02:gamma=1.12,unsharp=5:5:0.85`;
  }

  if (safeRole === "setup") {
    if (safeGenre === "thriller" || isMystery) {
      return `eq=contrast=1.04:saturation=0.88:brightness=-0.02:gamma=1.10`;
    }
    if (safeGenre === "healing" || isDrama) {
      return `eq=contrast=1.02:saturation=1.08:brightness=0.08:gamma=1.20`;
    }
    if (isComedy) {
      return `eq=contrast=1.05:saturation=1.25:brightness=0.05:gamma=1.15`;
    }
    if (isSciFi) {
      return `eq=contrast=1.10:saturation=1.10:brightness=0.02:gamma=1.15`;
    }
    return `eq=contrast=1.03:saturation=0.95:brightness=0.05:gamma=1.15`;
  }

  if (safeRole === "cliffhanger") {
    if (isComedy) {
      return `scale=${Math.round(width * 1.06)}:${Math.round(height * 1.06)},crop=${width}:${height},eq=contrast=1.15:saturation=1.30:brightness=0.05:gamma=1.10`;
    }
    if (isMystery) {
      return `scale=${Math.round(width * 1.04)}:${Math.round(height * 1.04)},crop=${width}:${height},eq=contrast=1.10:saturation=0.85:brightness=-0.02:gamma=1.15`;
    }
    return `scale=${Math.round(width * 1.04)}:${Math.round(height * 1.04)},crop=${width}:${height},eq=contrast=1.06:saturation=0.90:brightness=0.03:gamma=1.12`;
  }

  if (safeRole === "escalation") {
    if (safeGenre === "action" || isSciFi) {
      return `scale=${Math.round(width * 1.10)}:${Math.round(height * 1.10)},crop=${width}:${height},eq=contrast=1.18:saturation=1.25:brightness=0.03:gamma=1.12,unsharp=5:5:0.90`;
    }
    if (safeGenre === "healing" || isDrama) {
      return `scale=${Math.round(width * 1.04)}:${Math.round(height * 1.04)},crop=${width}:${height},eq=contrast=1.08:saturation=1.10:brightness=0.06:gamma=1.15`;
    }
    if (isComedy) {
      return `scale=${Math.round(width * 1.08)}:${Math.round(height * 1.08)},crop=${width}:${height},eq=contrast=1.15:saturation=1.35:brightness=0.05:gamma=1.10`;
    }
    if (isMystery) {
      return `scale=${Math.round(width * 1.08)}:${Math.round(height * 1.08)},crop=${width}:${height},eq=contrast=1.20:saturation=0.85:brightness=-0.04:gamma=1.15`;
    }
    return `scale=${Math.round(width * 1.08)}:${Math.round(height * 1.08)},crop=${width}:${height},eq=contrast=1.15:saturation=1.18:brightness=0.02:gamma=1.12,unsharp=5:5:0.75`;
  }

  // conflict
  if (safeGenre === "healing" || isDrama) {
    return `scale=${Math.round(width * 1.04)}:${Math.round(height * 1.04)},crop=${width}:${height},eq=contrast=1.06:saturation=1.05:brightness=0.06:gamma=1.15`;
  }
  if (isComedy) {
    return `scale=${Math.round(width * 1.06)}:${Math.round(height * 1.06)},crop=${width}:${height},eq=contrast=1.10:saturation=1.30:brightness=0.05:gamma=1.10`;
  }
  if (isMystery) {
    return `scale=${Math.round(width * 1.06)}:${Math.round(height * 1.06)},crop=${width}:${height},eq=contrast=1.15:saturation=0.85:brightness=-0.03:gamma=1.15`;
  }
  if (isSciFi) {
    return `scale=${Math.round(width * 1.06)}:${Math.round(height * 1.06)},crop=${width}:${height},eq=contrast=1.15:saturation=1.15:brightness=0.02:gamma=1.12`;
  }
  return `scale=${Math.round(width * 1.06)}:${Math.round(height * 1.06)},crop=${width}:${height},eq=contrast=1.10:saturation=1.10:brightness=0.04:gamma=1.13`;
}

function buildFocusedCropExpression(subjectX, subjectY, width, height) {
  const safeX = Math.max(0.05, Math.min(0.95, Number(subjectX) || 0.5));
  const safeY = Math.max(0.08, Math.min(0.92, Number(subjectY) || 0.5));
  return {
    cropX: `max(0,min(iw-${width},iw*${safeX.toFixed(3)}-${Math.round(width / 2)}))`,
    cropY: `max(0,min(ih-${height},ih*${safeY.toFixed(3)}-${Math.round(height / 2)}))`
  };
}

class FfmpegService {
  constructor(settings) {
    this.autoStoryResourceManaged = settings.autoStoryResourceManaged === true;
    this.ffmpegPath = settings.ffmpegPath || "ffmpeg";
    this.ffprobePath = settings.ffprobePath || "ffprobe";
    this.verticalWidth = Number(settings.verticalWidth || 1080);
    this.verticalHeight = Number(settings.verticalHeight || 1920);
  }

  async run(binary, args, options = {}) {
    if (this.autoStoryResourceManaged && binary === this.ffmpegPath) {
      return require("./autoStoryWorkQueue").serial("auto-story-encode", () => this.runDirect(binary, args, options));
    }
    return this.runDirect(binary, args, options);
  }
  async runDirect(binary, args, options = {}) {
    return new Promise((resolve, reject) => {
      const token = getCancelToken();
      try {
        throwIfCancelled(token);
      } catch (error) {
        reject(error);
        return;
      }
      const stdoutChunks = [];
      const stderrChunks = [];
      const child = spawn(binary, args, { windowsHide: true });
      const untrackChild = trackChild(child, token);
      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
      child.on("error", (error) => {
        untrackChild();
        reject(error);
      });
      child.on("close", (code) => {
        untrackChild();
        if (token?.cancelled) {
          reject(new Error(token.reason || "Đã dừng xuất video."));
          return;
        }
        const stderr = Buffer.concat(stderrChunks).toString();
        if (code !== 0) {
          const signedCode = Number(code) > 2147483647 ? Number(code) - 4294967296 : Number(code);
          const diskHint = signedCode === -28
            ? " FFmpeg reported an I/O/no-space error. Free disk space on the workspace drive or move the workspace to a larger drive."
            : "";
          reject(new Error(`ffmpeg exited with code ${code}${signedCode !== code ? ` (${signedCode})` : ""}.${diskHint} ${stderr}`));
        } else {
          resolve(options.captureStdout !== false ? Buffer.concat(stdoutChunks).toString() : stderr);
        }
      });
    });
  }

  async probeVideo(videoPath) {
    const output = await this.run(this.ffprobePath, [
      "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", videoPath
    ], { captureStdout: true });
    const parsed = JSON.parse(output);
    const videoStream = (parsed.streams || []).find((stream) => stream.codec_type === "video");
    const audioStream = (parsed.streams || []).find((stream) => stream.codec_type === "audio");
    return {
      duration: Number(parsed.format?.duration || 0),
      width: videoStream?.width || 0,
      height: videoStream?.height || 0,
      hasAudio: Boolean(audioStream)
    };
  }

  async probeAudio(audioPath) {
    const output = await this.run(this.ffprobePath, [
      "-v", "quiet", "-print_format", "json", "-show_format", audioPath
    ], { captureStdout: true });
    const parsed = JSON.parse(output);
    return { duration: Number(parsed.format?.duration || 0) };
  }

  async extractThumbnail(videoPath, outputPath, seekSec = 2) {
    await this.run(this.ffmpegPath, [
      "-y", "-ss", String(seekSec), "-i", videoPath, "-frames:v", "1", "-q:v", "2", outputPath
    ], { captureStdout: false });
  }

  async extractVerticalClip({
    sourcePath,
    outputPath,
    startSec,
    clipDuration,
    targetDuration,
    includeSourceAudio,
    role = "escalation",
    genreMode = "thriller",
    sourceAudioVolume = 0.18,
    screenText = "",
    speedFactor = 1.0,
    visual_energy = 5,
    audio_vibe = "Suspense",
    font_style = "standard",
    reframe = null,
    includeSilentAudio = false
  }) {
    const requestedSpeed = Math.max(0.5, Math.min(2.0, Number(speedFactor) || 1.0));
    const effectiveDuration = Math.max(0.3, Number(targetDuration || clipDuration));
    const clipDurationSafe = Math.max(0.3, Number(clipDuration));
    const noFreezeSpeedLimit = clipDurationSafe / effectiveDuration;
    const speed = Math.max(0.25, Math.min(requestedSpeed, noFreezeSpeedLimit > 0 ? noFreezeSpeedLimit : requestedSpeed));
    const freezePad = Math.max(0, effectiveDuration - (clipDurationSafe / speed));
    const fadeOutStart = Math.max(0, effectiveDuration - 0.18);
    const visualProfileFilter = buildVisualProfileFilter(role, genreMode, this.verticalWidth, this.verticalHeight);
    const safeScreenText = escapeDrawText(screenText);
      
    let fontColor = "white";
    let textX = "(w-text_w)/2";
    let textY = "h*0.12";
    
    if (font_style === "horror_red") {
      fontColor = "red";
    } else if (font_style === "shake_intense") {
      textX = "(w-text_w)/2+sin(t*30)*8";
      textY = "h*0.12+cos(t*35)*8";
      fontColor = "yellow";
    }

    const screenTextFilter = screenText
      ? `,drawtext=text='${safeScreenText}':fontsize=40:fontcolor=${fontColor}:borderw=3:bordercolor=black:x=${textX}:y=${textY}:enable='between(t\\,0.3\\,${formatSeconds(Math.min(3.0, effectiveDuration - 0.3))})'`
      : "";
    const speedFilter = speed !== 1.0 ? `,setpts=PTS/${speed.toFixed(3)}` : "";
    let zoomFilter = "";
    if (visual_energy >= 8) {
      zoomFilter = `,eq=saturation=1.3,noise=alls=15:allf=t,zoompan=z='min(zoom+0.002\\,1.20)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${this.verticalWidth}x${this.verticalHeight}:fps=30,crop=iw-20:ih-20:10+sin(t*15)*8:10+cos(t*20)*8,scale=${this.verticalWidth}:${this.verticalHeight}`;
    }
    const subjectX = Math.max(0, Math.min(1, Number(reframe?.subject_x ?? reframe?.subjectX ?? 0.5)));
    const subjectY = Math.max(0, Math.min(1, Number(reframe?.subject_y ?? reframe?.subjectY ?? 0.5)));
    const reframeConfidence = Math.max(0, Math.min(1, Number(reframe?.confidence || 0)));
    const reframeSource = String(reframe?.source || reframe?.mode || "");
    const useFocusedCrop = reframeConfidence >= 0.38 && /face|person|subject|edge|track/.test(reframeSource);
    const overlayX = reframeConfidence >= 0.2
      ? `max(0,min(W-w,(W-w)*${(1 - subjectX).toFixed(3)}))`
      : "(W-w)/2";
    const { cropX, cropY } = buildFocusedCropExpression(subjectX, subjectY, this.verticalWidth, this.verticalHeight);

    const filterParts = useFocusedCrop
      ? [
          `[0:v]scale=${this.verticalWidth}:${this.verticalHeight}:force_original_aspect_ratio=increase,crop=${this.verticalWidth}:${this.verticalHeight}:x='${cropX}':y='${cropY}'[fg]`,
          `[fg]${speedFilter ? speedFilter.slice(1) : "setpts=PTS"}${freezePad > 0 ? `,tpad=stop_mode=clone:stop_duration=${formatSeconds(freezePad)}` : ""}${zoomFilter},${visualProfileFilter},trim=duration=${formatSeconds(effectiveDuration)},setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.10,fade=t=out:st=${formatSeconds(fadeOutStart)}:d=0.18${screenTextFilter},format=yuv420p[v]`
        ]
      : [
          `[0:v]scale=${this.verticalWidth}:${this.verticalHeight}:force_original_aspect_ratio=increase,crop=${this.verticalWidth}:${this.verticalHeight},boxblur=18:6[bg]`,
          `[0:v]scale=${this.verticalWidth}:${this.verticalHeight}:force_original_aspect_ratio=decrease[fg]`,
          `[bg][fg]overlay=${overlayX}:(H-h)/2${speedFilter}${freezePad > 0 ? `,tpad=stop_mode=clone:stop_duration=${formatSeconds(freezePad)}` : ""}${zoomFilter},${visualProfileFilter},trim=duration=${formatSeconds(effectiveDuration)},setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.10,fade=t=out:st=${formatSeconds(fadeOutStart)}:d=0.18${screenTextFilter},format=yuv420p[v]`
        ];

    if (includeSourceAudio && Number(sourceAudioVolume) > 0) {
      const safeVolume = Number(sourceAudioVolume) || 0.18;
      const audioSpeedFilter = speed !== 1.0 ? `,${buildAtempoFilterChain(speed)}` : "";
      const audioFadeOutStart = Math.max(0, effectiveDuration - 0.22);
      
      let vibeAudioFilter = "";
      if (audio_vibe === "Suspense") {
        vibeAudioFilter = ",lowpass=f=800,bass=g=5";
      } else if (audio_vibe === "Shock") {
        vibeAudioFilter = ",treble=g=5,compand=attacks=0:decays=0.2:points=-90/-900|-70/-70|-30/-9|0/-3"; // punchy
      } else if (audio_vibe === "Sadness") {
        vibeAudioFilter = ",aecho=0.8:0.88:60:0.4"; // slight reverb
      }

      filterParts.push(
        `[0:a]volume=${safeVolume.toFixed(2)}${audioSpeedFilter}${vibeAudioFilter},afade=t=in:st=0:d=0.08,afade=t=out:st=${formatSeconds(audioFadeOutStart)}:d=0.22,apad=pad_dur=${formatSeconds(Math.max(0, freezePad) + 0.2)},atrim=0:${formatSeconds(effectiveDuration)},asetpts=N/SR/TB[a]`
      );
    } else if (includeSilentAudio) {
      filterParts.push(
        `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${formatSeconds(effectiveDuration)},asetpts=N/SR/TB[a]`
      );
    }

    const args = [
      "-y",
      "-ss",
      formatSeconds(startSec),
      "-t",
      formatSeconds(Math.max(clipDurationSafe, effectiveDuration * speed)),
      "-i",
      sourcePath,
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      "[v]"
    ];

    if ((includeSourceAudio && Number(sourceAudioVolume) > 0) || includeSilentAudio) {
      args.push("-map", "[a]");
      args.push("-c:a", "aac", "-b:a", "160k");
    } else {
      args.push("-an");
    }

    args.push(
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      outputPath
    );

    await this.run(this.ffmpegPath, args, { captureStdout: false });
  }

  async mergeVideoAndAudio({ videoPath, audioPath, outputPath }) {
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-shortest",
      outputPath
    ], { captureStdout: false });
  }

  async extractAudioSegment({ sourcePath, outputPath, startSec, durationSec, padEndSec = 0 }) {
    const filter = [
      `atrim=start=${formatSeconds(startSec)}:duration=${formatSeconds(durationSec)}`,
      "asetpts=N/SR/TB",
      `apad=pad_dur=${formatSeconds(Math.max(0, padEndSec))}`,
      `atrim=0:${formatSeconds(Math.max(0.05, Number(durationSec) + Math.max(0, padEndSec)))}`
    ].join(",");

    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      sourcePath,
      "-filter:a",
      filter,
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      outputPath
    ], { captureStdout: false });
  }

  async extractVoiceReferenceAudio({ sourcePath, outputPath, startSec = 0, durationSec = 15 }) {
    await this.run(this.ffmpegPath, [
      "-y",
      "-ss",
      formatSeconds(Math.max(0, Number(startSec) || 0)),
      "-t",
      formatSeconds(Math.max(1, Number(durationSec) || 15)),
      "-i",
      sourcePath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "24000",
      "-af",
      "highpass=f=80,lowpass=f=7600,volume=1.4,dynaudnorm=f=150:g=15",
      "-c:a",
      "pcm_s16le",
      outputPath
    ], { captureStdout: false });
  }

  async mixVideoWithNarrationTrack({ videoPath, narrationPath, outputPath }) {
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-i",
      narrationPath,
      "-filter_complex",
      [
        "[0:a]volume=0.40,aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[bg_raw]",
        "[1:a]volume=1.10,aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[vo]",
        "[vo]asplit=2[vo_sc][vo_mix]",
        "[bg_raw][vo_sc]sidechaincompress=threshold=-30dB:ratio=10:attack=8:release=260:makeup=1[bg]",
        "[bg][vo_mix]amix=inputs=2:duration=first:weights='1.0 1.0':normalize=0[a]"
      ].join(";"),
      "-map",
      "0:v:0",
      "-map",
      "[a]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-shortest",
      outputPath
    ], { captureStdout: false });
  }

  async replaceVideoAudio({ videoPath, audioPath, outputPath, voiceVolume = 1.0, limiter = true }) {
    const safeVoiceVolume = Math.max(0, Number(voiceVolume) || 0);
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-filter_complex",
      `[1:a]volume=${safeVoiceVolume.toFixed(3)},aresample=async=1:first_pts=0${limiter ? ",alimiter=limit=0.95" : ""}[a]`,
      "-map",
      "0:v:0",
      "-map",
      "[a]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-shortest",
      outputPath
    ], { captureStdout: false });
  }

  // separateAmbientInput: read the ambient bed through a SECOND demuxer of the same
  // file. When the bed is filtered from the same input whose video is stream-copied,
  // ffmpeg ends that filter input early (measured 0.05-0.27s short) and -shortest then
  // truncates the copied video to it. Opt-in (continuous narrated blocks) so existing
  // per-segment output is byte-for-byte unchanged.
  async mixVideoAudioWithVoice({ videoPath, voicePath, outputPath, sourceVolume = 0.22, voiceVolume = 1.0, limiter = true, duck = false, separateAmbientInput = false }) {
    const safeSourceVolume = Math.max(0, Number(sourceVolume) || 0);
    const safeVoiceVolume = Math.max(0, Number(voiceVolume) || 0);
    const meta = await this.probeVideo(videoPath);
    if (!meta.hasAudio || safeSourceVolume <= 0.0001) {
      await this.replaceVideoAudio({ videoPath, audioPath: voicePath, outputPath, voiceVolume: safeVoiceVolume, limiter });
      return;
    }
    // AutoStory v3 (Phase 13): real sidechain ducking so the original bodycam
    // bed stays audible and dips only while the narrator speaks, then recovers.
    const bedInput = separateAmbientInput ? ["-i", videoPath] : [];
    const bed = separateAmbientInput ? "[2:a]" : "[0:a]";
    if (duck) {
      await this.run(this.ffmpegPath, [
        "-y", "-i", videoPath, "-i", voicePath, ...bedInput,
        "-filter_complex",
        [
          `${bed}volume=${safeSourceVolume.toFixed(3)},aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[bg_raw]`,
          `[1:a]volume=${safeVoiceVolume.toFixed(3)},aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[vo]`,
          `[vo]asplit=2[vo_sc][vo_mix]`,
          `[bg_raw][vo_sc]sidechaincompress=threshold=-30dB:ratio=10:attack=8:release=260:makeup=1[bg]`,
          `[bg][vo_mix]amix=inputs=2:duration=first:weights='1.0 1.0':normalize=0${limiter ? ",alimiter=limit=0.95" : ""}[a]`
        ].join(";"),
        "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-shortest", outputPath
      ], { captureStdout: false });
      return;
    }
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-i",
      voicePath,
      ...bedInput,
      "-filter_complex",
      `${bed}volume=${safeSourceVolume.toFixed(3)}[bg];[1:a]volume=${safeVoiceVolume.toFixed(3)}[vo];[bg][vo]amix=inputs=2:duration=first:dropout_transition=0,aresample=async=1:first_pts=0${limiter ? ",alimiter=limit=0.95" : ""}[a]`,
      "-map",
      "0:v:0",
      "-map",
      "[a]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-shortest",
      outputPath
    ], { captureStdout: false });
  }

  async normalizeMediaDuration({ inputPath, outputPath, targetDuration }) {
    const safeTargetDuration = Math.max(0.3, Number(targetDuration));
    const inputMeta = await this.probeVideo(inputPath);
    const videoFilter = `setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration=${formatSeconds(safeTargetDuration)},trim=start=0:end=${formatSeconds(safeTargetDuration)},setpts=PTS-STARTPTS`;

    if (!inputMeta.hasAudio) {
      await this.run(this.ffmpegPath, [
        "-y",
        "-i",
        inputPath,
        "-f",
        "lavfi",
        "-t",
        formatSeconds(safeTargetDuration),
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-filter_complex",
        `[0:v]${videoFilter},format=yuv420p[v]`,
        "-map",
        "[v]",
        "-map",
        "1:a:0",
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "320k",
        "-t",
        formatSeconds(safeTargetDuration),
        "-shortest",
        outputPath
      ], { captureStdout: false });
      return;
    }

    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-filter_complex",
      [
        `[0:v]${videoFilter},format=yuv420p[v]`,
        `[0:a]aresample=async=1:first_pts=0,apad=pad_dur=${formatSeconds(safeTargetDuration)},atrim=start=0:end=${formatSeconds(safeTargetDuration)},asetpts=N/SR/TB[a]`
      ].join(";"),
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-t",
      formatSeconds(safeTargetDuration),
      "-shortest",
      outputPath
    ], { captureStdout: false });
  }

  async normalizeVideoOnlyDuration({ inputPath, outputPath, targetDuration }) {
    const safeTargetDuration = Math.max(0.3, Number(targetDuration));
    const videoFilter = `setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration=${formatSeconds(safeTargetDuration)},trim=start=0:end=${formatSeconds(safeTargetDuration)},setpts=PTS-STARTPTS,format=yuv420p`;
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-vf",
      videoFilter,
      "-r",
      "30",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
      "-crf",
      "20",
      "-t",
      formatSeconds(safeTargetDuration),
      "-an",
      outputPath
    ], { captureStdout: false });
  }

  async normalizeVideoKeepAudio({ inputPath, outputPath, targetDuration }) {
    const safeTargetDuration = Math.max(0.3, Number(targetDuration));
    const inputMeta = await this.probeVideo(inputPath);
    const videoFilter = `setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration=${formatSeconds(safeTargetDuration)},trim=start=0:end=${formatSeconds(safeTargetDuration)},setpts=PTS-STARTPTS,format=yuv420p`;

    if (!inputMeta.hasAudio) {
      await this.run(this.ffmpegPath, [
        "-y",
        "-i",
        inputPath,
        "-f",
        "lavfi",
        "-t",
        formatSeconds(safeTargetDuration),
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-filter_complex",
        `[0:v]${videoFilter}[v]`,
        "-map",
        "[v]",
        "-map",
        "1:a:0",
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-t",
        formatSeconds(safeTargetDuration),
        "-shortest",
        outputPath
      ], { captureStdout: false });
      return;
    }

    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-filter_complex",
      `[0:v]${videoFilter}[v]`,
      "-map",
      "[v]",
      "-map",
      "0:a:0",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "copy",
      "-t",
      formatSeconds(safeTargetDuration),
      "-shortest",
      outputPath
    ], { captureStdout: false });
  }

  async fitAudioToDuration({ inputPath, outputPath, targetDuration }) {
    const audioMeta = await this.probeAudio(inputPath);
    const safeTargetDuration = Math.max(0.3, Number(targetDuration));
    const rawDuration = Math.max(0.3, Number(audioMeta.duration || safeTargetDuration));
    const requestedRate = rawDuration / safeTargetDuration;
    const rate = requestedRate < 0.96 ? 1 : Math.min(1.12, requestedRate);
    const narrationFilter = [
      buildAtempoFilterChain(rate),
      `apad=pad_dur=${formatSeconds(Math.max(0.2, safeTargetDuration))}`,
      `atrim=0:${formatSeconds(safeTargetDuration)}`,
      "asetpts=N/SR/TB"
    ].join(",");

    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-filter:a",
      narrationFilter,
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      outputPath
    ], { captureStdout: false });
  }

  async fitDubbingClusterAudio({
    inputPath,
    outputPath,
    targetDuration,
    maxStretchRatio = 0.08,
    normalize = true,
    allowTrim = false,
    allowSlowDown = true,
    allowSpeedUp = true
  }) {
    const audioMeta = await this.probeAudio(inputPath);
    const safeTargetDuration = Math.max(0.3, Number(targetDuration));
    const rawDuration = Math.max(0.3, Number(audioMeta.duration || safeTargetDuration));
    const ratio = rawDuration / safeTargetDuration;
    const safeOverflowSec = Math.min(0.5, Math.max(0.3, safeTargetDuration * 0.03));
    const overflowSec = Math.max(0, rawDuration - safeTargetDuration);
    const stretchLimit = Math.max(Number(maxStretchRatio || 0.08), safeOverflowSec / safeTargetDuration);
    const filters = [];
    let fitStrategy = "natural";

    if (allowSpeedUp && ratio > 1 && ratio <= 1 + stretchLimit) {
      filters.push(buildAtempoFilterChain(ratio));
      filters.push(`atrim=0:${formatSeconds(safeTargetDuration)}`);
      fitStrategy = "light_speed_up";
    } else if (allowSlowDown && ratio < 1 && ratio >= 1 - Number(maxStretchRatio || 0.08)) {
      filters.push(buildAtempoFilterChain(ratio));
      filters.push(`atrim=0:${formatSeconds(safeTargetDuration)}`);
      fitStrategy = "light_slow_down";
    } else if (ratio < 1) {
      filters.push(`apad=pad_dur=${formatSeconds(safeTargetDuration - rawDuration + 0.2)}`);
      filters.push(`atrim=0:${formatSeconds(safeTargetDuration)}`);
      fitStrategy = "pad_silence";
    } else if (!allowSpeedUp && ratio > 1) {
      filters.push(`atrim=0:${formatSeconds(safeTargetDuration)}`);
      fitStrategy = "trim_no_speed";
    } else if (allowTrim || overflowSec <= safeOverflowSec) {
      filters.push(buildAtempoFilterChain(Math.min(1 + Number(maxStretchRatio || 0.08), ratio)));
      filters.push(`atrim=0:${formatSeconds(safeTargetDuration)}`);
      fitStrategy = allowTrim ? "legacy_trim" : "safe_overflow_trim";
    } else {
      fitStrategy = "overflow_keep_full";
    }

    if (normalize) {
      filters.push("loudnorm=I=-16:TP=-2:LRA=11");
      filters.push("alimiter=limit=0.95");
    }
    filters.push("asetpts=N/SR/TB");

    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-filter:a",
      filters.join(","),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath
    ], { captureStdout: false });

    const fittedMeta = await this.probeAudio(outputPath).catch(() => ({ duration: rawDuration }));
    return {
      rawDuration,
      outputDuration: Number(fittedMeta.duration || rawDuration),
      targetDuration: safeTargetDuration,
      speedRatio: ratio,
      fitStrategy,
      trimmed: fitStrategy === "legacy_trim"
    };
  }

  async fitNarrationTrackToDuration({ inputPath, outputPath, targetDuration }) {
    const audioMeta = await this.probeAudio(inputPath);
    const safeTargetDuration = Math.max(0.3, Number(targetDuration));
    const rawDuration = Math.max(0.3, Number(audioMeta.duration || safeTargetDuration));
    const requestedRate = rawDuration / safeTargetDuration;
    if (requestedRate < 0.85 || requestedRate > 1.15) {
      throw new Error(
        `Narration duration is too far from target: ${rawDuration.toFixed(1)}s voice for ${safeTargetDuration.toFixed(1)}s output. ` +
        "The safe atempo range is 15%; extend the visual timeline or regenerate narration instead."
      );
    }

    const narrationFilter = [
      buildAtempoFilterChain(requestedRate),
      "volume=1.18",
      `apad=pad_dur=${formatSeconds(Math.max(0.2, safeTargetDuration))}`,
      `atrim=0:${formatSeconds(safeTargetDuration)}`,
      "asetpts=N/SR/TB"
    ].join(",");

    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-filter:a",
      narrationFilter,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath
    ], { captureStdout: false });
  }

  async mixVideoAndNarration({ videoPath, narrationPath, outputPath, targetDuration, sourceAudioVolume = 0.24 }) {
    const fadeOutStart = Math.max(0, Number(targetDuration) - 0.18);
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-i",
      narrationPath,
      "-filter_complex",
      [
        `[0:a]volume=${sourceAudioVolume},afade=t=in:st=0:d=0.06,afade=t=out:st=${formatSeconds(Math.max(0, Number(targetDuration) - 0.22))}:d=0.22,aformat=channel_layouts=stereo[bg_raw]`,
        `[1:a]volume=1.12,afade=t=in:st=0:d=0.04,afade=t=out:st=${formatSeconds(fadeOutStart)}:d=0.18,apad=pad_dur=0.2,atrim=0:${formatSeconds(targetDuration)},aformat=channel_layouts=stereo[vo]`,
        `[vo]asplit=2[vo_sc][vo_mix]`,
        `[bg_raw][vo_sc]sidechaincompress=threshold=-24dB:ratio=4:attack=5:release=50[bg]`,
        "[bg][vo_mix]amix=inputs=2:duration=first:weights='1.0 1.0':normalize=0[a]"
      ].join(";"),
      "-map",
      "0:v:0",
      "-map",
      "[a]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath
    ], { captureStdout: false });
  }

  async concatSegmentsWithTransitions(segmentPaths, segmentDurations, outputPath, transitions = 0.24) {
    if (!Array.isArray(segmentPaths) || segmentPaths.length === 0) {
      throw new Error("No segments were provided for final composition.");
    }

    if (segmentPaths.length === 1) {
      await this.run(this.ffmpegPath, [
        "-y",
        "-i",
        segmentPaths[0],
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        outputPath
      ], { captureStdout: false });
      return;
    }

    await this.concatSegmentsSafely(segmentPaths, outputPath);
    return;

    const transitionConfigs = [];
    for (let i = 0; i < segmentPaths.length - 1; i += 1) {
      if (typeof transitions === "number") {
        transitionConfigs.push({ type: "fade", duration: transitions });
      } else if (Array.isArray(transitions) && transitions[i]) {
        transitionConfigs.push(transitions[i]);
      } else {
        transitionConfigs.push({ type: "fade", duration: 0.24 });
      }
    }

    const allHardCuts = transitionConfigs.every((t) => t.type === "none" || t.duration <= 0.01);
    if (allHardCuts) {
      const listPath = require("path").join(require("os").tmpdir(), `concat-${Date.now()}.txt`);
      const content = segmentPaths
        .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
        .join("\n");
      await require("fs/promises").writeFile(listPath, content, "utf8");
      await this.run(this.ffmpegPath, [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k", outputPath
      ], { captureStdout: false });
      return;
    }

    const args = ["-y"];
    const filterParts = [];

    segmentPaths.forEach((segmentPath, index) => {
      args.push("-i", segmentPath);
      filterParts.push(`[${index}:v]settb=AVTB,fps=30,format=yuv420p[v${index}]`);
      filterParts.push(`[${index}:a]aresample=async=1:first_pts=0[a${index}]`);
    });

    let currentVideo = "v0";
    let currentAudio = "a0";
    let elapsed = Number(segmentDurations[0] || 0);

    for (let index = 1; index < segmentPaths.length; index += 1) {
      const nextVideo = `v${index}`;
      const nextAudio = `a${index}`;
      const outVideo = `vx${index}`;
      const outAudio = `ax${index}`;
      const config = transitionConfigs[index - 1];
      const isHardCut = config.type === "none" || config.duration <= 0.01;
      const dur = isHardCut ? 0 : config.duration;
      const offset = Math.max(0, elapsed - dur);

      if (isHardCut) {
        filterParts.push(
          `[${currentVideo}][${nextVideo}]xfade=transition=fade:duration=0.016:offset=${formatSeconds(offset)}[${outVideo}]`
        );
        filterParts.push(
          `[${currentAudio}][${nextAudio}]acrossfade=d=0.016:c1=tri:c2=tri[${outAudio}]`
        );
      } else {
        const transitionType = getSafeXfadeTransition(config.type);
        filterParts.push(
          `[${currentVideo}][${nextVideo}]xfade=transition=${transitionType}:duration=${formatSeconds(dur)}:offset=${formatSeconds(offset)}[${outVideo}]`
        );
        filterParts.push(
          `[${currentAudio}][${nextAudio}]acrossfade=d=${formatSeconds(dur)}:c1=tri:c2=tri[${outAudio}]`
        );
      }

      currentVideo = outVideo;
      currentAudio = outAudio;
      elapsed += Number(segmentDurations[index] || 0) - dur;
    }

    args.push(
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      `[${currentVideo}]`,
      "-map",
      `[${currentAudio}]`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath
    );

    await this.run(this.ffmpegPath, args, { captureStdout: false });
  }

  async concatSegmentsSafely(segmentPaths, outputPath) {
    const listPath = require("path").join(require("os").tmpdir(), `concat-safe-${Date.now()}.txt`);
    const content = segmentPaths
      .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await require("fs/promises").writeFile(listPath, content, "utf8");
    await this.run(this.ffmpegPath, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-fflags",
      "+genpts",
      "-i",
      listPath,
      "-avoid_negative_ts",
      "make_zero",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-movflags",
      "+faststart",
      outputPath
    ], { captureStdout: false });
  }

  // Composite scope reel for the Editorial Director: several (possibly distant)
  // source ranges cut from the original video into ONE low-res file, each segment
  // with its absolute SOURCE clock burned in. Returns true if the clock overlay was
  // rendered, false if this ffmpeg build could not draw text (plain fallback).
  async createScopeReel({ videoPath, entries, outputPath, fps = 4, width = 640 }) {
    const meta = await this.probeVideo(videoPath);
    const w = Math.max(2, Math.round(width / 2) * 2);
    const fontArg = process.platform === "win32" ? "fontfile='C\\:/Windows/Fonts/arial.ttf':" : "";
    const build = clock => {
      const args = ["-y"], filters = [];
      let inputs = "";
      entries.forEach((e, i) => {
        const d = Math.max(0.25, Number(e.sourceEndSec) - Number(e.sourceStartSec));
        args.push("-ss", String(Math.max(0, Number(e.sourceStartSec))), "-t", String(d), "-i", videoPath);
        const draw = clock ? `,drawtext=${fontArg}text='SOURCE %{pts\\:hms\\:${Number(e.sourceStartSec)}}':x=8:y=8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6` : "";
        filters.push(`[${i}:v]scale=${w}:-2,setsar=1,fps=${Math.max(1, Number(fps))},setpts=PTS-STARTPTS${draw},tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d}[v${i}]`);
        const audio = meta.hasAudio ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,apad` : "anullsrc=r=48000:cl=stereo";
        filters.push(`${audio},atrim=duration=${d}[a${i}]`);
        inputs += `[v${i}][a${i}]`;
      });
      filters.push(`${inputs}concat=n=${entries.length}:v=1:a=1[v][a]`);
      args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", outputPath);
      return args;
    };
    try {
      await this.run(this.ffmpegPath, build(true), { captureStdout: false });
      return true;
    } catch (_) {
      await this.run(this.ffmpegPath, build(false), { captureStdout: false });
      return false;
    }
  }

  async createAutoStoryEvidenceReel(entries, outputPath) {
    const args = ["-y"], filters = [];
    let inputs = "";
    for (const [i, e] of entries.entries()) {
      const meta = await this.probeVideo(e.file);
      args.push("-ss", String(e.start), "-t", String(e.end - e.start), "-i", e.file);
      filters.push(`[${i}:v]scale=640:-2,setsar=1,fps=8,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${e.duration},trim=duration=${e.duration}[v${i}]`);
      const audio = meta.hasAudio ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,apad` : "anullsrc=r=48000:cl=stereo";
      filters.push(`${audio},atrim=duration=${e.duration}[a${i}]`);
      inputs += `[v${i}][a${i}]`;
    }
    filters.push(`${inputs}concat=n=${entries.length}:v=1:a=1[v][a]`);
    args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", outputPath);
    await this.run(this.ffmpegPath, args, { captureStdout: false });
  }

  async concatSegmentsByFilter(segmentPaths, outputPath) {
    if (!Array.isArray(segmentPaths) || segmentPaths.length === 0) {
      throw new Error("No segments were provided for final composition.");
    }

    if (segmentPaths.length === 1) {
      await this.run(this.ffmpegPath, [
        "-y",
        "-i",
        segmentPaths[0],
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "320k",
        "-movflags",
        "+faststart",
        outputPath
      ], { captureStdout: false });
      return;
    }

    const args = ["-y"];
    const filterParts = [];
    let concatInputs = "";
    segmentPaths.forEach((segmentPath, index) => {
      args.push("-i", segmentPath);
      filterParts.push(`[${index}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=30,format=yuv420p[v${index}]`);
      filterParts.push(`[${index}:a]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB[a${index}]`);
      concatInputs += `[v${index}][a${index}]`;
    });
    filterParts.push(`${concatInputs}concat=n=${segmentPaths.length}:v=1:a=1[v][a]`);

    args.push(
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-movflags",
      "+faststart",
      outputPath
    );

    await this.run(this.ffmpegPath, args, { captureStdout: false });
  }

  async concatAudioSegments(audioPaths, outputPath) {
    if (!Array.isArray(audioPaths) || audioPaths.length === 0) {
      throw new Error("No audio segments were provided for narration composition.");
    }

    const listPath = require("path").join(require("os").tmpdir(), `concat-audio-${Date.now()}.txt`);
    const content = audioPaths
      .map((audioPath) => `file '${audioPath.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await require("fs/promises").writeFile(listPath, content, "utf8");
    await this.run(this.ffmpegPath, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-vn",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath
    ], { captureStdout: false });
  }

  async concatSegments(segmentPaths, outputPath, tempDir) {
    const listPath = path.join(tempDir, "concat-list.txt");
    const content = segmentPaths
      .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
      .join("\n");

    await fs.writeFile(listPath, content, "utf8");

    await this.run(this.ffmpegPath, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      outputPath
    ], { captureStdout: false });
  }

  async createMirrorFlipVideo({ inputPath, outputPath, intervalSec = 3 }) {
    const safeInterval = Math.max(0.5, Number(intervalSec) || 3);
    const cycle = safeInterval * 2;
    const mirrorFilter = `hflip=enable='gte(mod(t\\,${formatSeconds(cycle)})\\,${formatSeconds(safeInterval)})',format=yuv420p`;

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-filter:v",
      mirrorFilter,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputPath
    ], { captureStdout: false });
  }

  async applyVideoDecoration({
    inputPath,
    outputPath,
    titleTextPath = "",
    titleOverlayPath = "",
    blurBackgroundEnabled = false,
    blurStrength = 24,
    topCaptionEnabled = false,
    topCaptionFontSize = 52,
    topCaptionYPercent = 8,
    foregroundScalePercent = 100,
    foregroundXPercent = 50,
    foregroundYPercent = 50,
    width = 1080,
    height = 1920,
    preset = "fast",
    crf = 21,
    masterAudio = false
  }) {
    const targetWidth = Math.max(180, Math.round(Number(width) || 1080));
    const targetHeight = Math.max(180, Math.round(Number(height) || 1920));
    const safeBlur = Math.max(6, Math.min(40, Number(blurStrength) || 24));
    const foregroundScale = Math.max(0.5, Math.min(1.6, Number(foregroundScalePercent) / 100 || 1));
    const foregroundBoxWidth = Math.max(2, Math.round(targetWidth * foregroundScale / 2) * 2);
    const foregroundBoxHeight = Math.max(2, Math.round(targetHeight * foregroundScale / 2) * 2);
    const foregroundX = Math.max(0, Math.min(100, Number(foregroundXPercent) || 50)) / 100;
    const foregroundY = Math.max(0, Math.min(100, Number(foregroundYPercent) || 50)) / 100;
    const overlayPosition = `x=${Math.round(targetWidth * foregroundX)}-w/2:y=${Math.round(targetHeight * foregroundY)}-h/2`;
    const sizeScale = targetWidth / 1080;
    const fontSize = Math.max(16, Math.round((Number(topCaptionFontSize) || 52) * sizeScale));
    const horizontalInset = Math.max(8, Math.round(targetWidth * 0.09));
    const captionWidth = Math.max(80, targetWidth - (horizontalInset * 2));
    const verticalPadding = Math.max(6, Math.round(fontSize * 0.55));
    const lineSpacing = Math.max(3, Math.round(fontSize * 0.15));
    const captionY = Math.max(3, Math.min(75, Number(topCaptionYPercent) || 8)) / 100;
    const captionTop = Math.round(targetHeight * captionY);
    const escapedTitlePath = titleTextPath ? escapePathForFilter(titleTextPath) : "";
    const fontPath = "C\\:/Windows/Fonts/arialbd.ttf";
    let titleLineCount = 1;
    if (topCaptionEnabled && titleTextPath) {
      const titleText = await fs.readFile(titleTextPath, "utf8").catch(() => "");
      titleLineCount = Math.max(1, Math.min(3, String(titleText).split(/\r?\n/).filter(Boolean).length));
    }
    const captionHeight = Math.max(
      fontSize + (verticalPadding * 2),
      (titleLineCount * fontSize) + ((titleLineCount - 1) * lineSpacing) + (verticalPadding * 2)
    );
    const titleFilter = topCaptionEnabled && escapedTitlePath && !titleOverlayPath
      ? `,drawbox=x=${horizontalInset}:y=${captionTop}:w=${captionWidth}:h=${captionHeight}:color=white@0.96:t=fill,drawtext=fontfile='${fontPath}':textfile='${escapedTitlePath}':reload=0:fontcolor=black:fontsize=${fontSize}:line_spacing=${lineSpacing}:boxw=${captionWidth}:boxh=${captionHeight}:text_align=center+middle:fix_bounds=1:x=${horizontalInset}:y=${captionTop}`
      : "";
    const canvasLabel = titleOverlayPath ? "[canvas]" : "[v]";
    const baseFilter = blurBackgroundEnabled
      ? `[0:v]split=2[bgsrc][fgsrc];[bgsrc]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},boxblur=${safeBlur}:${Math.max(2, Math.round(safeBlur / 3))},eq=saturation=1.08[bg];[fgsrc]scale=${foregroundBoxWidth}:${foregroundBoxHeight}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=${overlayPosition}:shortest=1${titleFilter},format=rgba${canvasLabel}`
      : `color=c=black:s=${targetWidth}x${targetHeight}:r=30[bg];[0:v]scale=${foregroundBoxWidth}:${foregroundBoxHeight}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=${overlayPosition}:shortest=1${titleFilter},format=rgba${canvasLabel}`;
    const backgroundFilter = titleOverlayPath
      ? `${baseFilter};[1:v]scale=${targetWidth}:${targetHeight},format=rgba[title];[canvas][title]overlay=0:0:shortest=1,format=yuv420p[v]`
      : baseFilter.replace("format=rgba[v]", "format=yuv420p[v]");

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const inputArgs = ["-y", "-i", inputPath];
    if (titleOverlayPath) inputArgs.push("-loop", "1", "-framerate", "30", "-i", titleOverlayPath);

    const audioOutputArgs = masterAudio
      ? ["-filter:a", "loudnorm=I=-14:TP=-1.5:LRA=9,alimiter=limit=0.95", "-c:a", "aac", "-b:a", "192k"]
      : ["-c:a", "copy"];

    await this.run(this.ffmpegPath, [
      ...inputArgs,
      "-filter_complex",
      backgroundFilter,
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      preset,
      "-crf",
      String(crf),
      ...audioOutputArgs,
      "-shortest",
      "-movflags",
      "+faststart",
      outputPath
    ], { captureStdout: false });
  }

  async extractFastPreviewClip({ sourcePath, outputPath, startSec = 0, durationSec = 5, width = 540 }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await this.run(this.ffmpegPath, [
      "-y",
      "-ss",
      formatSeconds(Math.max(0, Number(startSec) || 0)),
      "-t",
      formatSeconds(Math.max(0.3, Number(durationSec) || 5)),
      "-i",
      sourcePath,
      "-vf",
      `scale='min(${Number(width) || 540},iw)':-2,format=yuv420p`,
      "-an",
      "-r",
      "24",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "32",
      outputPath
    ], { captureStdout: false });
  }

  async extractFastPreviewClipWithAudio({ sourcePath, outputPath, startSec = 0, durationSec = 5, width = 540 }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await this.run(this.ffmpegPath, [
      "-y",
      "-ss",
      formatSeconds(Math.max(0, Number(startSec) || 0)),
      "-t",
      formatSeconds(Math.max(0.3, Number(durationSec) || 5)),
      "-i",
      sourcePath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-vf",
      `scale='min(${Number(width) || 540},iw)':-2,format=yuv420p`,
      "-r",
      "24",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "32",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      outputPath
    ], { captureStdout: false });
  }

  async extractClipWithAudio({ sourcePath, outputPath, startSec = 0, durationSec = 5 }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await this.run(this.ffmpegPath, [
      "-y",
      "-ss",
      formatSeconds(Math.max(0, Number(startSec) || 0)),
      "-t",
      formatSeconds(Math.max(0.3, Number(durationSec) || 5)),
      "-i",
      sourcePath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputPath
    ], { captureStdout: false });
  }

  async extractRetimeClipWithAudio({
    sourcePath,
    outputPath,
    startSec = 0,
    sourceDurationSec = 5,
    targetDurationSec = 5,
    width = null,
    preset = "veryfast",
    crf = 22,
    includeAudio = true
  }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const safeSourceDuration = Math.max(0.3, Number(sourceDurationSec) || 5);
    const safeTargetDuration = Math.max(0.3, Number(targetDurationSec) || safeSourceDuration);
    const speed = Math.max(0.05, Math.min(8, safeSourceDuration / safeTargetDuration));
    const meta = await this.probeVideo(sourcePath);
    const scaleFilter = width
      ? `,scale='min(${Number(width) || 540},iw)':-2`
      : "";
    const videoFilter = `setpts=PTS/${speed.toFixed(6)},fps=${width ? 24 : 30}${scaleFilter},trim=duration=${formatSeconds(safeTargetDuration)},setpts=PTS-STARTPTS,format=yuv420p`;
    const args = [
      "-y",
      "-ss",
      formatSeconds(Math.max(0, Number(startSec) || 0)),
      "-t",
      formatSeconds(safeSourceDuration),
      "-i",
      sourcePath
    ];

    if (!includeAudio) {
      args.push(
        "-filter_complex",
        `[0:v]${videoFilter}[v]`,
        "-map",
        "[v]",
        "-an"
      );
    } else if (meta.hasAudio) {
      args.push(
        "-filter_complex",
        `[0:v]${videoFilter}[v];[0:a]${buildAtempoFilterChain(speed)},apad=pad_dur=${formatSeconds(safeTargetDuration)},atrim=0:${formatSeconds(safeTargetDuration)},asetpts=N/SR/TB[a]`,
        "-map",
        "[v]",
        "-map",
        "[a]"
      );
    } else {
      args.push(
        "-f",
        "lavfi",
        "-t",
        formatSeconds(safeTargetDuration),
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-filter_complex",
        `[0:v]${videoFilter}[v]`,
        "-map",
        "[v]",
        "-map",
        "1:a:0"
      );
    }

    args.push(
      "-r",
      width ? "24" : "30",
      "-c:v",
      "libx264",
      "-preset",
      preset,
      "-crf",
      String(crf),
      ...(includeAudio ? ["-c:a", "aac", "-b:a", width ? "160k" : "192k"] : []),
      "-t",
      formatSeconds(safeTargetDuration),
      "-movflags",
      "+faststart",
      outputPath
    );

    await this.run(this.ffmpegPath, args, { captureStdout: false });
  }

  async extractVoiceDrivenClipWithAudio({
    sourcePath,
    outputPath,
    startSec = 0,
    sourceDurationSec = 5,
    targetDurationSec = 5,
    width = null,
    preset = "veryfast",
    crf = 22,
    includeAudio = true
  }) {
    const safeSourceDuration = Math.max(0.3, Number(sourceDurationSec) || 5);
    const safeTargetDuration = Math.max(0.3, Number(targetDurationSec) || safeSourceDuration);

    if (safeTargetDuration <= safeSourceDuration + 0.03) {
      return this.extractRetimeClipWithAudio({
        sourcePath,
        outputPath,
        startSec,
        sourceDurationSec: Math.min(safeSourceDuration, safeTargetDuration),
        targetDurationSec: safeTargetDuration,
        width,
        preset,
        crf,
        includeAudio
      });
    }
    // Spread the slowdown across the complete source clip. Slowing only the
    // final frames creates the visible freeze/jerk that users reported.
    return this.extractRetimeClipWithAudio({
      sourcePath,
      outputPath,
      startSec,
      sourceDurationSec: safeSourceDuration,
      targetDurationSec: safeTargetDuration,
      width,
      preset,
      crf,
      includeAudio
    });
  }

  async ensureAudioTrack({ inputPath, outputPath, durationSec = 5 }) {
    const meta = await this.probeVideo(inputPath);
    const safeDuration = Math.max(0.3, Number(durationSec || meta.duration || 5));
    if (meta.hasAudio) {
      await this.run(this.ffmpegPath, [
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-t",
        formatSeconds(safeDuration),
        outputPath
      ], { captureStdout: false });
      return;
    }

    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-f",
      "lavfi",
      "-t",
      formatSeconds(safeDuration),
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      outputPath
    ], { captureStdout: false });
  }

  async createSceneDetectionProxy({ videoPath, outputPath, width = 480, fps = 8 }) {
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-map",
      "0:v:0",
      "-vf",
      `scale='min(${Number(width) || 480},iw)':-2,fps=${Math.max(2, Number(fps) || 8)},format=yuv420p`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "35",
      "-movflags",
      "+faststart",
      outputPath
    ], { captureStdout: false });
  }

  async createMultimodalAnalysisProxy({ videoPath, outputPath, width = 640, fps = 8 }) {
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      `fps=${Math.max(4, Number(fps) || 8)},scale='min(${Number(width) || 640},iw)':-2,format=yuv420p`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "32",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-movflags",
      "+faststart",
      outputPath
    ], { captureStdout: false });
  }

  async createAnalysisProxyChunk({ videoPath, outputPath, startSec, durationSec, width, fps }) {
    await this.run(this.ffmpegPath, [
      "-y",
      "-ss",
      String(Math.max(0, Number(startSec) || 0)),
      "-i",
      videoPath,
      "-t",
      String(Math.max(0.25, Number(durationSec) || 0.25)),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      ...(width && fps ? ["-vf", `scale=${Math.max(2, Math.round(width / 2) * 2)}:-2,fps=${Math.max(1, Number(fps))}`] : []),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "32",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-reset_timestamps",
      "1",
      "-movflags",
      "+faststart",
      outputPath
    ], { captureStdout: false });
  }

  async burnSubtitlesFast({
    videoPath,
    subtitlePath,
    outputPath,
    width = 540,
    fps = 24,
    videoBitrate = "",
    audioBitrate = "128k"
  }) {
    const subtitleFilter = subtitlePath.endsWith(".ass")
      ? `ass='${escapePathForFilter(subtitlePath)}'`
      : `subtitles='${escapePathForFilter(subtitlePath)}':force_style='FontName=Arial Bold,FontSize=12,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=35,Bold=1'`;
    const videoQualityArgs = videoBitrate
      ? ["-b:v", String(videoBitrate), "-maxrate", "900k", "-bufsize", "1300k"]
      : ["-crf", "32"];
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-vf",
      `scale='min(${Number(width) || 540},iw)':-2,${subtitleFilter},format=yuv420p`,
      "-r",
      String(Math.max(2, Number(fps) || 24)),
      "-c:v",
      "libx264",
      "-preset",
      videoBitrate ? "veryfast" : "ultrafast",
      ...videoQualityArgs,
      "-c:a",
      "aac",
      "-b:a",
      String(audioBitrate || "128k"),
      "-movflags",
      "+faststart",
      outputPath
    ], { captureStdout: false });
  }

  async burnSubtitles({ videoPath, subtitlePath, outputPath }) {
    const isAss = subtitlePath.endsWith(".ass");
    let subtitleFilter = "";
    if (isAss) {
      subtitleFilter = `ass='${escapePathForFilter(subtitlePath)}'`;
    } else {
      const forceStyle = [
        "FontName=Arial Bold",
        "FontSize=13",
        "PrimaryColour=&H00FFFFFF",
        "OutlineColour=&H00000000",
        "Outline=2",
        "Shadow=1",
        "ShadowColour=&H80000000",
        "BackColour=&H40000000",
        "Alignment=2",
        "MarginV=45",
        "Bold=1"
      ].join(",");
      subtitleFilter = `subtitles='${escapePathForFilter(subtitlePath)}':force_style='${forceStyle}'`;
    }
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-vf",
      subtitleFilter,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "copy",
      outputPath
    ], { captureStdout: false });
  }

  async copyMedia({ inputPath, outputPath }) {
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-c",
      "copy",
      outputPath
    ], { captureStdout: false });
  }

  async maskSubtitleArea({
    inputPath,
    outputPath,
    mode = "blur",
    xPercent = 0,
    widthPercent = 100,
    heightPercent = 16,
    bottomPercent = 6,
    blurStrength = 18,
    darkness = 0.62
  }) {
    const safeX = Math.max(0, Math.min(96, Number(xPercent) || 0)) / 100;
    const safeWidth = Math.max(0.04, Math.min(1 - safeX, (Number(widthPercent) || 100) / 100));
    const safeHeight = Math.max(4, Math.min(45, Number(heightPercent) || 16)) / 100;
    const safeBottom = Math.max(0, Math.min(1 - safeHeight, (Number(bottomPercent) || 0) / 100));
    const xExpr = `iw*${safeX.toFixed(4)}`;
    const wExpr = `iw*${safeWidth.toFixed(4)}`;
    const safeTop = Math.max(0, 1 - safeBottom - safeHeight);
    const yExpr = `ih*${safeTop.toFixed(4)}`;
    const overlayXExpr = `main_w*${safeX.toFixed(4)}`;
    const overlayYExpr = `main_h*${safeTop.toFixed(4)}`;
    const hExpr = `ih*${safeHeight.toFixed(4)}`;
    const filter = mode === "dark"
      ? `drawbox=x=${xExpr}:y=${yExpr}:w=${wExpr}:h=${hExpr}:color=black@${Math.max(0.1, Math.min(1, Number(darkness) || 0.62)).toFixed(2)}:t=fill`
      : `[0:v]split[base][mask];[mask]crop=${wExpr}:${hExpr}:${xExpr}:${yExpr},gblur=sigma=${Math.max(2, Math.min(50, Number(blurStrength) || 18))}:steps=2[blur];[base][blur]overlay=${overlayXExpr}:${overlayYExpr}`;
    const args = [
      "-y",
      "-i",
      inputPath,
      mode === "dark" ? "-vf" : "-filter_complex",
      filter,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "22",
      "-c:a",
      "copy",
      outputPath
    ];
    await this.run(this.ffmpegPath, args, { captureStdout: false });
  }

  async transcodeFastPreview({ inputPath, outputPath, width = 540 }) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await this.run(this.ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-vf",
      `scale='min(${Number(width) || 540},iw)':-2,format=yuv420p`,
      "-r",
      "24",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      outputPath
    ], { captureStdout: false });
  }
}

module.exports = FfmpegService;
