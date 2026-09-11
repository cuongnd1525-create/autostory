const { spawn } = require("child_process");
const { getCancelToken, throwIfCancelled, trackChild } = require("./cancelToken");

function runCommand(command, args, timeoutMs = 180000) {
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
    const child = spawn(command, args, { windowsHide: true });
    const untrack = trackChild(child, token);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      untrack();
      reject(new Error(`${command} timed out during render QA.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      untrack();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      untrack();
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (token?.cancelled) {
        reject(new Error(token.reason || "Đã dừng thao tác."));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseEvents(pattern, text) {
  const events = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    events.push(Number(match[1]));
  }
  return events.filter((value) => Number.isFinite(value));
}

function parseSilenceEvents(text = "") {
  const starts = parseEvents(/silence_start:\s*([0-9.]+)/g, text);
  const ends = [];
  const pattern = /silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    ends.push({ endSec: Number(match[1]), durationSec: Number(match[2]) });
  }
  return ends.map((item, index) => ({
    startSec: Number.isFinite(starts[index]) ? starts[index] : Math.max(0, item.endSec - item.durationSec),
    endSec: item.endSec,
    durationSec: item.durationSec
  }));
}

function overlapDuration(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

class RenderQaService {
  constructor(settings = {}) {
    this.ffmpegPath = settings.ffmpegPath || "ffmpeg";
    this.ffprobePath = settings.ffprobePath || "ffprobe";
  }

  async probeVideo(videoPath) {
    const { stdout } = await runCommand(this.ffprobePath, [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      videoPath
    ]);
    const parsed = JSON.parse(stdout);
    const videoStream = (parsed.streams || []).find((stream) => stream.codec_type === "video");
    const audioStream = (parsed.streams || []).find((stream) => stream.codec_type === "audio");
    return {
      duration: Number(parsed.format?.duration || 0),
      width: Number(videoStream?.width || 0),
      height: Number(videoStream?.height || 0),
      hasAudio: Boolean(audioStream)
    };
  }

  async detectBlackAndFreeze(videoPath) {
    const { stderr } = await runCommand(this.ffmpegPath, [
      "-hide_banner",
      "-i",
      videoPath,
      "-vf",
      "blackdetect=d=0.45:pix_th=0.10,freezedetect=n=-55dB:d=0.65",
      "-an",
      "-f",
      "null",
      "-"
    ]);
    return {
      blackStarts: parseEvents(/black_start:([0-9.]+)/g, stderr),
      freezeStarts: parseEvents(/freeze_start:\s*([0-9.]+)/g, stderr),
      rawLog: stderr.slice(-6000)
    };
  }

  async measureAudio(videoPath) {
    try {
      const { stderr } = await runCommand(this.ffmpegPath, [
        "-hide_banner",
        "-i",
        videoPath,
        "-af",
        "volumedetect",
        "-vn",
        "-f",
        "null",
        "-"
      ]);
      const meanMatch = /mean_volume:\s*(-?[0-9.]+) dB/.exec(stderr);
      const maxMatch = /max_volume:\s*(-?[0-9.]+) dB/.exec(stderr);
      return {
        meanVolumeDb: meanMatch ? Number(meanMatch[1]) : null,
        maxVolumeDb: maxMatch ? Number(maxMatch[1]) : null
      };
    } catch (error) {
      return {
        meanVolumeDb: null,
        maxVolumeDb: null,
        error: error.message
      };
    }
  }

  async detectSilence(videoPath) {
    try {
      const { stderr } = await runCommand(this.ffmpegPath, [
        "-hide_banner",
        "-i",
        videoPath,
        "-af",
        "silencedetect=noise=-42dB:d=0.65",
        "-vn",
        "-f",
        "null",
        "-"
      ]);
      return { intervals: parseSilenceEvents(stderr) };
    } catch (error) {
      return { intervals: [], error: error.message };
    }
  }

  async inspect({
    videoPath,
    targetDuration,
    narrationPath,
    subtitlePath,
    syncReport,
    voiceVisualReport,
    narrationGroundingReport,
    attentionQa,
    expectedAudioSegments = [],
    expectedWidth = 0,
    expectedHeight = 0
  }) {
    const issues = [];
    const video = await this.probeVideo(videoPath);
    const expectedDuration = Number(targetDuration || 0);
    const strictDriftLimit = Number(syncReport?.maxAllowedDriftSec || 0.12);
    if (expectedDuration > 0) {
      const drift = Math.abs(video.duration - expectedDuration);
      const allowed = strictDriftLimit;
      if (drift > allowed) {
        issues.push({
          severity: "error",
          code: "duration_drift",
          message: `Output duration ${video.duration.toFixed(3)}s differs from target ${expectedDuration.toFixed(3)}s by ${drift.toFixed(3)}s.`
        });
      }
    }

    if (expectedWidth > 0 && expectedHeight > 0 && (video.width !== expectedWidth || video.height !== expectedHeight)) {
      issues.push({
        severity: "warning",
        code: "unexpected_canvas",
        message: `Output canvas is ${video.width}x${video.height}; expected ${expectedWidth}x${expectedHeight}.`
      });
    }

    if (!video.hasAudio) {
      issues.push({
        severity: "error",
        code: "missing_audio",
        message: "Final output has no audio stream."
      });
    }

    const visual = await this.detectBlackAndFreeze(videoPath).catch((error) => ({
      blackStarts: [],
      freezeStarts: [],
      error: error.message
    }));
    if (visual.blackStarts.length) {
      issues.push({
        severity: "warning",
        code: "black_frames",
        message: `Detected possible black frames at ${visual.blackStarts.slice(0, 5).map((value) => `${value.toFixed(1)}s`).join(", ")}.`
      });
    }
    if (visual.freezeStarts.length) {
      issues.push({
        severity: "warning",
        code: "frozen_frames",
        message: `Detected possible frozen visuals at ${visual.freezeStarts.slice(0, 5).map((value) => `${value.toFixed(1)}s`).join(", ")}.`
      });
    }

    const audio = await this.measureAudio(videoPath);
    const silence = await this.detectSilence(videoPath);
    if (audio.meanVolumeDb !== null && audio.meanVolumeDb < -30) {
      issues.push({
        severity: "warning",
        code: "low_audio",
        message: `Final audio is quiet: mean ${audio.meanVolumeDb.toFixed(1)} dB.`
      });
    }
    if (audio.maxVolumeDb !== null && audio.maxVolumeDb > -0.2) {
      issues.push({
        severity: "warning",
        code: "clipping_risk",
        message: `Final audio peaks near clipping: max ${audio.maxVolumeDb.toFixed(1)} dB.`
      });
    }
    const longSilences = silence.intervals.filter((item) => item.durationSec >= 1.25);
    if (longSilences.length) {
      issues.push({
        severity: "warning",
        code: "long_silence",
        message: `Detected ${longSilences.length} silent interval(s) longer than 1.25s.`
      });
    }
    for (const segment of expectedAudioSegments) {
      const startSec = Number(segment.startSec || 0);
      const endSec = Number(segment.endSec || startSec);
      const durationSec = Math.max(0.2, endSec - startSec);
      const silentSec = silence.intervals.reduce(
        (sum, item) => sum + overlapDuration(startSec, endSec, item.startSec, item.endSec),
        0
      );
      if (silentSec >= Math.min(1.25, durationSec * 0.35)) {
        issues.push({
          severity: "warning",
          code: "segment_audio_gap",
          segmentId: segment.segmentId || "",
          message: `Segment ${segment.segmentId || "unknown"} has about ${silentSec.toFixed(2)}s of detected silence although audio is expected.`
        });
      }
    }

    if (narrationPath) {
      const narration = await this.probeVideo(narrationPath).catch(() => null);
      if (narration?.duration && Math.abs(video.duration - narration.duration) > strictDriftLimit) {
        issues.push({
          severity: "error",
          code: "voice_video_duration_mismatch",
          message: `Narration is ${narration.duration.toFixed(3)}s but final video is ${video.duration.toFixed(3)}s.`
        });
      }
    }

    if (syncReport) {
      if (!syncReport.passed) {
        issues.push({
          severity: "error",
          code: "strict_sync_failed",
          message: `Strict sync failed. Max segment drift is ${Number(syncReport.maxSegmentDriftSec || 0).toFixed(3)}s; allowed ${strictDriftLimit.toFixed(3)}s.`
        });
      }
      const failedSegments = Array.isArray(syncReport.segments)
        ? syncReport.segments.filter((segment) => !segment.passed)
        : [];
      if (failedSegments.length) {
        issues.push({
          severity: "error",
          code: "segment_sync_drift",
          message: `Segment duration drift exceeded the strict limit in ${failedSegments.length} segment(s).`
        });
      }
    }

    if (voiceVisualReport) {
      const alignmentIssues = Array.isArray(voiceVisualReport.issues) ? voiceVisualReport.issues : [];
      const severeAlignmentIssues = alignmentIssues.filter((issue) => issue.severity === "error");
      if (severeAlignmentIssues.length) {
        issues.push({
          severity: "error",
          code: "voice_visual_alignment_failed",
          message: `Voice/visual alignment failed in ${severeAlignmentIssues.length} segment(s).`
        });
      }
      const weakMatches = alignmentIssues.filter((issue) => issue.code === "low_voice_visual_match");
      if (weakMatches.length) {
        issues.push({
          severity: "warning",
          code: "weak_voice_visual_match",
          message: `Voice may not match the selected visual in ${weakMatches.length} segment(s).`
        });
      }
    }

    if (narrationGroundingReport) {
      const groundingIssues = Array.isArray(narrationGroundingReport.issues) ? narrationGroundingReport.issues : [];
      const severeGroundingIssues = groundingIssues.filter((issue) => issue.severity === "error");
      if (severeGroundingIssues.length) {
        issues.push({
          severity: "error",
          code: "narration_grounding_failed",
          message: `Narration does not map to the selected scene/event in ${severeGroundingIssues.length} segment(s).`
        });
      }
      const narrativeCodes = new Set([
        "low_event_grounding",
        "missing_plot_event",
        "character_identity_mismatch",
        "character_goal_mismatch",
        "relationship_mismatch",
        "knowledge_state_mismatch",
        "emotion_not_supported",
        "event_order_violation",
        "reveal_before_setup",
        "weak_inference_overstated",
        "scene_only_captioning"
      ]);
      const weakGrounding = groundingIssues.filter((issue) => narrativeCodes.has(issue.code));
      if (weakGrounding.length) {
        issues.push({
          severity: "warning",
          code: "weak_narration_grounding",
          message: `Narration has weak scene/event/character grounding in ${weakGrounding.length} segment issue(s).`
        });
      }
    }

    if (attentionQa) {
      const attentionIssues = Array.isArray(attentionQa.issues) ? attentionQa.issues : [];
      const severeAttentionIssues = attentionIssues.filter((issue) => issue.severity === "high");
      if (Number(attentionQa.hookScore || 1) < 0.8) {
        issues.push({
          severity: "warning",
          code: "weak_attention_hook",
          message: `Attention QA hook score is ${Number(attentionQa.hookScore || 0).toFixed(2)}. First 3 seconds may not stop scrolling.`
        });
      }
      if (Number(attentionQa.completionLikelihood || 1) < 0.7) {
        issues.push({
          severity: "warning",
          code: "retention_drop_risk",
          message: `Attention QA completion likelihood is ${Number(attentionQa.completionLikelihood || 0).toFixed(2)}. Review weak segments before publishing.`
        });
      }
      if (severeAttentionIssues.length) {
        issues.push({
          severity: "warning",
          code: "attention_qa_high_issues",
          message: `Attention QA found ${severeAttentionIssues.length} high-risk retention issue(s).`
        });
      }
    }

    if (!subtitlePath) {
      issues.push({
        severity: "warning",
        code: "missing_subtitles",
        message: "No subtitle artifact was produced."
      });
    }

    return {
      passed: !issues.some((issue) => issue.severity === "error"),
      inspectedAt: new Date().toISOString(),
      video,
      visual,
      audio,
      silence,
      attention: attentionQa ? {
        overallScore: attentionQa.overallScore,
        hookScore: attentionQa.hookScore,
        curiosityScore: attentionQa.curiosityScore,
        emotionCurveScore: attentionQa.emotionCurveScore,
        conflictDensityScore: attentionQa.conflictDensityScore,
        groundingSafetyScore: attentionQa.groundingSafetyScore,
        completionLikelihood: attentionQa.completionLikelihood,
        issueCount: Array.isArray(attentionQa.issues) ? attentionQa.issues.length : 0
      } : null,
      issues
    };
  }
}

module.exports = RenderQaService;
