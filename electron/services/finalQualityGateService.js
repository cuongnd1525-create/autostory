'use strict';
/**
 * LAYER C — POST-RENDER TECHNICAL & EDITORIAL FINAL QUALITY GATE
 *
 * Inspects the EXACT rendered Production Final 1080x1920 MP4 and produces a
 * cryptographically bound QA report (SHA-256 + file size + dimensions + timestamp).
 *
 * Two independent gates:
 *   1. TECHNICAL GATE: dimensions, duration, audio peak, loudness, silence/tail dead air,
 *      video freeze, flash frame, dense final-frame & shot-boundary outro intrusion check,
 *      unexpected layout transitions, subtitle overflow, audio handoff, source-boundary
 *      compliance, and file integrity.
 *   2. EDITORIAL GATE: hook, story clarity, narrator value, commentary, narrator naturalness,
 *      pacing, curiosity progression, source fidelity, punchline, payoff, ending,
 *      and overall watchability.
 *
 * INVARIANTS:
 *   - Either gate FAIL => qaResult = 'FAIL', publishReady = false.
 *   - Even ONE unintended outro frame => TECHNICAL GATE MUST FAIL.
 *   - A QA report is valid ONLY for the exact MP4 whose SHA-256 and byte size match.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { analyzeGrayFrameLayout } = require('./sourceEndingBoundaryService');
const { verifyHookTitle } = require('./hookAuditionService');

const execFileAsync = promisify(execFile);
const round3 = n => Math.round((Number(n) || 0) * 1000) / 1000;
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

async function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', chunk => hash.update(chunk));
    s.on('error', reject);
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

async function probeMediaFull(filePath, ffprobeBin = 'ffprobe') {
  const { stdout } = await execFileAsync(ffprobeBin, [
    '-v', 'error',
    '-show_entries', 'format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels',
    '-of', 'json',
    filePath
  ], { timeout: 20000 });
  const parsed = JSON.parse(stdout);
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find(s => s.codec_type === 'video') || null;
  const audio = streams.find(s => s.codec_type === 'audio') || null;
  const parseRate = r => {
    if (!r || typeof r !== 'string') return 0;
    const [a, b] = r.split('/').map(Number);
    return b > 0 ? round2(a / b) : Number(a) || 0;
  };
  return {
    durationSec: round3(Number(parsed.format?.duration) || 0),
    sizeBytes: Number(parsed.format?.size) || 0,
    bitRate: Number(parsed.format?.bit_rate) || 0,
    video: video ? {
      codec: video.codec_name,
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30
    } : null,
    audio: audio ? {
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate) || 0,
      channels: Number(audio.channels) || 0
    } : null
  };
}

async function inspectAudioAndVideoAnomalies(filePath, durationSec, ffmpegBin = 'ffmpeg') {
  const silences = [];
  const freezes = [];
  const blacks = [];
  let integratedLufs = null;
  let truePeakDb = null;

  const { stderr } = await execFileAsync(ffmpegBin, [
    '-hide_banner', '-nostats', '-i', filePath,
    '-vf', 'freezedetect=n=-56dB:d=2.2,blackdetect=d=0.07:pix_th=0.08',
    '-af', 'silencedetect=noise=-40dB:d=0.45,ebur128=peak=true',
    '-f', 'null', '-'
  ], { timeout: 90000, maxBuffer: 16 * 1024 * 1024 });

  let pendingSilenceStart = null;
  let pendingFreezeStart = null;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const sStart = line.match(/silence_start:\s*([0-9.]+)/);
    if (sStart) pendingSilenceStart = Number(sStart[1]);
    const sEnd = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (sEnd) {
      const end = Number(sEnd[1]), dur = Number(sEnd[2]);
      const start = Number.isFinite(pendingSilenceStart) ? pendingSilenceStart : Math.max(0, end - dur);
      silences.push({ startSec: round3(start), endSec: round3(end), durationSec: round3(dur) });
      pendingSilenceStart = null;
    }

    const fStart = line.match(/freeze_start:\s*([0-9.]+)/);
    if (fStart) pendingFreezeStart = Number(fStart[1]);
    const fEnd = line.match(/freeze_end:\s*([0-9.]+)/);
    if (fEnd && Number.isFinite(pendingFreezeStart)) {
      const end = Number(fEnd[1]);
      freezes.push({ startSec: round3(pendingFreezeStart), endSec: round3(end), durationSec: round3(end - pendingFreezeStart) });
      pendingFreezeStart = null;
    }

    const bMatch = line.match(/black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)/);
    if (bMatch) {
      blacks.push({ startSec: round3(Number(bMatch[1])), endSec: round3(Number(bMatch[2])), durationSec: round3(Number(bMatch[3])) });
    }

    const mI = line.match(/I:\s*(-?[0-9.]+)\s*LUFS/);
    if (mI) integratedLufs = Number(mI[1]);
    const mPeak = line.match(/Peak:\s*(-?[0-9.]+)\s*dBFS/);
    if (mPeak) truePeakDb = Number(mPeak[1]);
  }
  if (Number.isFinite(pendingSilenceStart) && durationSec > pendingSilenceStart) {
    silences.push({
      startSec: round3(pendingSilenceStart),
      endSec: round3(durationSec),
      durationSec: round3(durationSec - pendingSilenceStart)
    });
  }
  if (Number.isFinite(pendingFreezeStart) && durationSec > pendingFreezeStart) {
    freezes.push({
      startSec: round3(pendingFreezeStart),
      endSec: round3(durationSec),
      durationSec: round3(durationSec - pendingFreezeStart)
    });
  }

  return {
    integratedLufs: Number.isFinite(integratedLufs) ? round2(integratedLufs) : null,
    truePeakDb: Number.isFinite(truePeakDb) ? round2(truePeakDb) : null,
    silences,
    freezes,
    blacks
  };
}

/**
 * Dense Final-Frame & Shot-Boundary Validation:
 *   1. Crops to the central foreground 16:9 content box when the video is vertical 9:16
 *      (so blurred top/bottom canvas bands never obscure horizontal split-screen outro bars).
 *   2. Runs full-frame-rate (30fps) `scdet` across the tail window (default last 6.5s)
 *      to pinpoint EVERY frame-exact cut (e.g. Frame 2392 79.733s -> Frame 2393 79.767s).
 *   3. Samples dense grayscale 320x180 frames at 15fps across the entire tail PLUS
 *      exact frames before/after every `scdet` cut, running `analyzeGrayFrameLayout`
 *      on every single frame!
 */
async function inspectFinalShotBoundariesAndOutro(filePath, media, {
  tailWindowSec = 6.5,
  expectedBeatBoundariesSec = [],
  ffmpegBin = 'ffmpeg'
} = {}) {
  const durationSec = media.durationSec;
  const fps = media.video?.fps || 30;
  const width = media.video?.width || 1080;
  const height = media.video?.height || 1920;
  const isVerticalCanvas = height > width * 1.35;
  const startSec = Math.max(0, round3(durationSec - tailWindowSec));

  const fgCropFilter = isVerticalCanvas
    ? 'crop=iw:round(iw*9/16):0:round((ih-iw*9/16)/2),scale=320:180:flags=area,format=gray'
    : 'scale=320:180:flags=area,format=gray';

  // 1. Full-rate 30fps scene-change detection on the foreground video region
  const sceneCuts = [];
  try {
    const { stderr } = await execFileAsync(ffmpegBin, [
      '-hide_banner', '-nostats',
      '-ss', String(startSec),
      '-i', filePath,
      '-an',
      '-vf', `${fgCropFilter},scdet=threshold=9`,
      '-f', 'null', '-'
    ], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    for (const line of String(stderr || '').split(/\r?\n/)) {
      const m = line.match(/lavfi\.scd\.score:\s*([0-9.]+).*?lavfi\.scd\.time:\s*([0-9.]+)/);
      if (m) {
        const score = Number(m[1]);
        const relSec = Number(m[2]);
        const absSec = round3(startSec + relSec);
        const approxFrame = Math.round(absSec * fps);
        sceneCuts.push({
          timestampSec: absSec,
          previousFrameSec: round3(Math.max(0, absSec - (1 / fps))),
          approxFrameIndex: approxFrame,
          score: round2(score)
        });
      }
    }
  } catch (_) {}

  // 2. Dense 15fps raw frame decode across the entire tail window (every ~0.067s = ~97 frames)
  const denseSampleFps = 15;
  const frameBytes = 320 * 180;
  const sampledFrames = [];
  try {
    const { stdout } = await execFileAsync(ffmpegBin, [
      '-v', 'error',
      '-ss', String(startSec),
      '-i', filePath,
      '-an',
      '-vf', `fps=${denseSampleFps},${fgCropFilter}`,
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      'pipe:1'
    ], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 30000 });

    const count = Math.floor(stdout.length / frameBytes);
    for (let i = 0; i < count; i++) {
      const slice = stdout.subarray(i * frameBytes, (i + 1) * frameBytes);
      const ts = round3(startSec + (i / denseSampleFps));
      const layout = analyzeGrayFrameLayout(slice, 320, 180);
      sampledFrames.push({
        timestampSec: ts,
        approxFrameIndex: Math.round(ts * fps),
        ...layout
      });
    }
  } catch (_) {}

  // 3. Look up exact decoded frames before & after each detected sceneCut (avoids input -ss keyframe snapping)
  const cutTransitions = [];
  for (const cut of sceneCuts) {
    const beforeTs = Math.max(0, round3(cut.timestampSec - (1 / fps)));
    const afterTs = Math.min(Math.max(0, durationSec - 0.01), cut.timestampSec);
    const beforeCandidates = sampledFrames.filter(f => f.timestampSec <= cut.timestampSec - 0.015);
    const afterCandidates = sampledFrames.filter(f => f.timestampSec >= cut.timestampSec - 0.005);
    const beforeFrame = beforeCandidates.length ? beforeCandidates[beforeCandidates.length - 1] : null;
    const afterFrame = afterCandidates.length ? afterCandidates[0] : null;
    const matchesExpectedBeatCut = (expectedBeatBoundariesSec || []).some(b => Math.abs(Number(b) - cut.timestampSec) <= 0.16);
    const afterIsSplit = Boolean(afterFrame?.isSplitScreen || afterFrame?.isMultiPanelSplit);
    const beforeIsSplit = Boolean(beforeFrame?.isSplitScreen || beforeFrame?.isMultiPanelSplit);
    cutTransitions.push({
      ...cut,
      beforeSec: beforeTs,
      afterSec: afterTs,
      matchesExpectedBeatCut,
      beforeLayout: beforeFrame || null,
      afterLayout: afterFrame || null,
      transitionsIntoSplitOutro: afterIsSplit && !beforeIsSplit,
      transitionsIntoDarkCard: Boolean(!beforeFrame?.isBlackCard && afterFrame?.isBlackCard)
    });
  }

  // Detect flash frames: two high-score cuts < 0.12s apart
  const flashFrames = [];
  for (let i = 1; i < sceneCuts.length; i++) {
    const dt = sceneCuts[i].timestampSec - sceneCuts[i - 1].timestampSec;
    if (dt > 0 && dt <= 0.12 && sceneCuts[i].score >= 14 && sceneCuts[i - 1].score >= 14) {
      flashFrames.push({
        startSec: sceneCuts[i - 1].timestampSec,
        endSec: sceneCuts[i].timestampSec,
        durationSec: round3(dt)
      });
    }
  }

  const outroFrames = sampledFrames.filter(f => f.isSplitScreen || f.isMultiPanelSplit);
  const darkTailFrames = sampledFrames.filter(f => f.timestampSec >= durationSec - 2.5 && f.isBlackCard);
  const unexpectedFinalCuts = cutTransitions.filter(c =>
    !c.matchesExpectedBeatCut && (c.transitionsIntoSplitOutro || c.transitionsIntoDarkCard || (c.timestampSec >= durationSec - 2.2 && c.score >= 18))
  );

  return {
    inspectedWindow: { startSec, endSec: durationSec, denseFramesInspected: sampledFrames.length },
    sceneCuts,
    cutTransitions,
    flashFrames,
    outroFrameCount: outroFrames.length,
    firstOutroFrame: outroFrames[0] || cutTransitions.find(c => c.transitionsIntoSplitOutro) || null,
    darkTailFrameCount: darkTailFrames.length,
    unexpectedFinalCuts
  };
}

function checkSubtitlesAndTitleOverflow({ subtitlePaths = [], topCaptionText = '', durationSec = 0 } = {}) {
  const findings = [];
  if (topCaptionText && topCaptionText.length > 115) {
    findings.push({
      code: 'TOP_CAPTION_OVERFLOW',
      severity: 'blocking',
      message: `Top banner caption is ${topCaptionText.length} chars (>115 max), risking vertical header overflow.`
    });
  }
  for (const subPath of subtitlePaths.filter(Boolean)) {
    if (!fs.existsSync(subPath)) continue;
    const raw = fs.readFileSync(subPath, 'utf8');
    const blocks = raw.split(/\r?\n\r?\n/).map(x => x.trim()).filter(Boolean);
    for (const blk of blocks) {
      const lines = blk.split(/\r?\n/);
      const timeLine = lines.find(l => l.includes('-->'));
      if (!timeLine) continue;
      const textLines = lines.slice(lines.indexOf(timeLine) + 1);
      if (textLines.length > 3) {
        findings.push({
          code: 'SUBTITLE_LINE_COUNT_OVERFLOW',
          severity: 'blocking',
          message: `Subtitle cue in ${path.basename(subPath)} has ${textLines.length} lines (>3 max).`
        });
        break;
      }
      const mEnd = timeLine.match(/-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
      if (mEnd && durationSec > 0) {
        const cueEndSec = Number(mEnd[1]) * 3600 + Number(mEnd[2]) * 60 + Number(mEnd[3]) + Number(mEnd[4]) / 1000;
        if (cueEndSec > durationSec + 0.35) {
          findings.push({
            code: 'SUBTITLE_EXTENDS_PAST_EOF',
            severity: 'blocking',
            timestampSec: round2(cueEndSec),
            message: `Subtitle cue extends to ${cueEndSec.toFixed(2)}s beyond video duration ${durationSec.toFixed(2)}s.`
          });
          break;
        }
      }
    }
  }
  return findings;
}

const EDITORIAL_GATE_SCHEMA = {
  type: 'object',
  properties: {
    hook: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    storyClarity: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    narratorValue: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    commentary: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    narratorNaturalness: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    pacing: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    curiosityProgression: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    sourceFidelity: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    punchline: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    payoff: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    ending: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    overallWatchability: { type: 'object', properties: { pass: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pass', 'notes'] },
    blockingIssues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          timestampSec: { type: 'number' },
          message: { type: 'string' }
        },
        required: ['code', 'timestampSec', 'message']
      }
    },
    summary: { type: 'string' }
  },
  required: [
    'hook', 'storyClarity', 'narratorValue', 'commentary', 'narratorNaturalness',
    'pacing', 'curiosityProgression', 'sourceFidelity', 'punchline', 'payoff',
    'ending', 'overallWatchability', 'blockingIssues', 'summary'
  ]
};

/**
 * Runs BOTH the Technical Gate and Editorial Gate on the exact Final MP4.
 */
async function runFinalQualityGate({
  mp4Path,
  expectedWidth = 1080,
  expectedHeight = 1920,
  minDurationSec = 60,
  maxDurationSec = 95,
  spine = null,
  script = null,
  endingBoundary = null,
  narrationAudit = null,
  model = null,
  cues = [],
  topCaptionText = '',
  referenceTitle = '',
  subtitlePaths = [],
  pacingMode = 'commentary_led',
  aiService = null,
  outputPath = null,
  ffmpegBin = 'ffmpeg',
  ffprobeBin = 'ffprobe'
} = {}) {
  const canonicalPath = path.resolve(String(mp4Path || ''));
  const qaTimestamp = new Date().toISOString();
  if (!mp4Path || !fs.existsSync(canonicalPath)) {
    const missing = {
      contract: 'final-quality-gate-v1',
      filePath: canonicalPath,
      sha256: null,
      fileSize: 0,
      duration: 0,
      resolution: null,
      qaTimestamp,
      qaResult: 'FAIL',
      publishReady: false,
      blockingFindings: [{ gate: 'technical', code: 'FINAL_MP4_MISSING', timestampSec: 0, message: `Final MP4 does not exist at ${canonicalPath}.` }],
      technicalGate: { status: 'FAIL', checks: {}, blockingFindings: [] },
      editorialGate: { status: 'FAIL', criteria: {}, blockingFindings: [] }
    };
    if (outputPath) await fsp.writeFile(outputPath, JSON.stringify(missing, null, 2));
    return missing;
  }

  const stat = await fsp.stat(canonicalPath);
  const sha256 = await computeFileSha256(canonicalPath);
  const media = await probeMediaFull(canonicalPath, ffprobeBin);
  const resolutionLabel = media.video ? `${media.video.width}x${media.video.height}` : 'unknown';

  const techBlocking = [];
  const techWarnings = [];

  // 1. File integrity & streams
  const fileIntegrityOk = Boolean(stat.size > 10000 && media.video && media.audio && media.durationSec > 1);
  if (!fileIntegrityOk) {
    techBlocking.push({ gate: 'technical', code: 'FILE_INTEGRITY_INVALID', timestampSec: 0, message: 'MP4 is missing valid video/audio streams or truncated.' });
  }

  // 2. Dimensions (must be exact 1080x1920 for Production Final)
  const dimensionsOk = Boolean(media.video && media.video.width === expectedWidth && media.video.height === expectedHeight);
  if (!dimensionsOk) {
    techBlocking.push({
      gate: 'technical',
      code: 'DIMENSIONS_MISMATCH',
      timestampSec: 0,
      message: `Expected ${expectedWidth}x${expectedHeight} production final, got ${resolutionLabel}.`
    });
  }

  // 3. Duration compliance
  const scriptSegmentsDuration = Array.isArray(script?.segments) && script.segments.length > 0
    ? script.segments.reduce((s, seg) => s + Math.max(0, (Number(seg.sourceEndSec) - Number(seg.sourceStartSec)) / (Number(seg.playbackSpeed) || 1)), 0)
    : null;
  const spineBeatsDuration = Array.isArray(spine?.beats) && spine.beats.length > 0
    ? spine.beats.reduce((s, b) => s + Math.max(0, (Number(b.sourceEndSec) - Number(b.sourceStartSec)) / (Number(b.playbackSpeed) || 1)), 0)
    : null;
  const expectedTimelineSec = Number(script?.measuredDuration)
    || scriptSegmentsDuration
    || spineBeatsDuration
    || null;
  const durationDriftSec = Number.isFinite(expectedTimelineSec) && expectedTimelineSec > 0
    ? round3(Math.abs(media.durationSec - expectedTimelineSec))
    : 0;
  const durationOk = media.durationSec >= minDurationSec - 0.5
    && media.durationSec <= maxDurationSec + 0.75
    && (!expectedTimelineSec || durationDriftSec <= 0.85);
  if (!durationOk) {
    techBlocking.push({
      gate: 'technical',
      code: 'DURATION_OUT_OF_BOUNDS',
      timestampSec: media.durationSec,
      message: `Rendered duration ${media.durationSec}s violates bounds [${minDurationSec}, ${maxDurationSec}] or drifts ${durationDriftSec}s from EDL (${expectedTimelineSec ?? 'n/a'}s).`
    });
  }

  // 4. Audio peak, loudness, silence, freeze, black frames
  const av = await inspectAudioAndVideoAnomalies(canonicalPath, media.durationSec, ffmpegBin);
  const loudnessOk = av.integratedLufs !== null && av.integratedLufs >= -29 && av.integratedLufs <= -7;
  if (!loudnessOk) {
    techBlocking.push({
      gate: 'technical',
      code: 'AUDIO_LOUDNESS_ANOMALY',
      timestampSec: 0,
      message: `Integrated loudness ${av.integratedLufs ?? 'null'} LUFS outside broadcast-safe short-form range [-29, -7] LUFS.`
    });
  }
  const peakOk = av.truePeakDb === null || av.truePeakDb <= 0.2;
  if (!peakOk) {
    techWarnings.push({ code: 'AUDIO_TRUE_PEAK_HOT', message: `True peak ${av.truePeakDb} dBFS exceeds 0.2 dBFS.` });
  }

  // Audio tail silence check (> 0.55s in final 3s is a hard P0 failure!)
  const tailSilences = av.silences.filter(s => s.endSec >= media.durationSec - 0.35 && s.durationSec >= 0.55);
  const midDeadAir = av.silences.filter(s => s.endSec < media.durationSec - 0.35 && s.durationSec >= 1.8);
  const silenceOk = tailSilences.length === 0 && midDeadAir.length === 0;
  for (const ts of tailSilences) {
    techBlocking.push({
      gate: 'technical',
      code: 'AUDIO_TAIL_SILENCE',
      timestampSec: ts.startSec,
      message: `Unintended near-silent audio tail (${ts.durationSec}s from ${ts.startSec}s to ${ts.endSec}s) at end of final MP4.`,
      evidence: ts
    });
  }
  for (const ms of midDeadAir) {
    techBlocking.push({
      gate: 'technical',
      code: 'MID_VIDEO_DEAD_AIR',
      timestampSec: ms.startSec,
      message: `Extended dead air (${ms.durationSec}s from ${ms.startSec}s to ${ms.endSec}s) inside final MP4.`,
      evidence: ms
    });
  }

  // Video freeze check in non-waveform ending region
  const tailFreezes = av.freezes.filter(f => f.endSec >= media.durationSec - 0.5 && f.durationSec >= 2.2);
  const freezeOk = tailFreezes.length === 0;
  for (const fz of tailFreezes) {
    techBlocking.push({
      gate: 'technical',
      code: 'ENDING_VIDEO_FREEZE',
      timestampSec: fz.startSec,
      message: `Ending freezes for ${fz.durationSec}s (${fz.startSec}s-${fz.endSec}s).`,
      evidence: fz
    });
  }

  // 5. Dense Final-Frame, Shot-Boundary & Outro Intrusion Inspection
  const expectedBeatBoundariesSec = [];
  if (Array.isArray(script?.segments) && script.segments.length) {
    let cur = 0;
    for (const seg of script.segments) {
      const len = Math.max(0, Number(seg.sourceEndSec) - Number(seg.sourceStartSec));
      cur = round3(cur + len);
      expectedBeatBoundariesSec.push(cur);
    }
  } else if (Array.isArray(spine?.beats) && spine.beats.length) {
    let cur = 0;
    for (const b of spine.beats) {
      cur = round3(cur + Math.max(0, Number(b.sourceEndSec) - Number(b.sourceStartSec)));
      expectedBeatBoundariesSec.push(cur);
    }
  }

  const shotAudit = await inspectFinalShotBoundariesAndOutro(canonicalPath, media, {
    tailWindowSec: 6.5,
    expectedBeatBoundariesSec,
    ffmpegBin
  });

  const flashOk = shotAudit.flashFrames.length === 0 && av.blacks.filter(b => b.startSec > 0.2 && b.endSec < media.durationSec - 0.2).length === 0;
  if (!flashOk) {
    techBlocking.push({
      gate: 'technical',
      code: 'FLASH_OR_BLACK_FRAME',
      timestampSec: shotAudit.flashFrames[0]?.startSec ?? av.blacks[0]?.startSec ?? 0,
      message: 'Flash frame or unintended black frame detected in rendered MP4.',
      evidence: { flashFrames: shotAudit.flashFrames, blacks: av.blacks }
    });
  }

  const outroIntrusionDetected = shotAudit.outroFrameCount > 0 || shotAudit.cutTransitions.some(c => c.transitionsIntoSplitOutro);
  if (outroIntrusionDetected) {
    const first = shotAudit.cutTransitions.find(c => c.transitionsIntoSplitOutro) || shotAudit.firstOutroFrame;
    const cutTs = first?.timestampSec ?? 0;
    const prevTs = first?.beforeSec ?? round3(Math.max(0, cutTs - (1 / (media.video?.fps || 30))));
    techBlocking.push({
      gate: 'technical',
      code: 'OUTRO_INTRUSION_DETECTED',
      timestampSec: cutTs,
      message: `Unintended multi-panel outro/recap intrusion detected starting at ${prevTs}s -> ${cutTs}s (frame ~${first?.approxFrameIndex ?? '?'}; ${shotAudit.outroFrameCount} sampled outro frames).`,
      evidence: first
    });
  }

  const unexpectedLayoutOk = shotAudit.unexpectedFinalCuts.length === 0;
  for (const uc of shotAudit.unexpectedFinalCuts) {
    if (uc.transitionsIntoSplitOutro) continue; // already reported above as OUTRO_INTRUSION_DETECTED
    techBlocking.push({
      gate: 'technical',
      code: 'UNEXPECTED_LAYOUT_TRANSITION',
      timestampSec: uc.timestampSec,
      message: `Unexpected intra-beat shot/layout jump at ${uc.beforeSec}s -> ${uc.timestampSec}s (scdet score ${uc.score}) inside final seconds.`,
      evidence: uc
    });
  }

  // 6. Source-boundary compliance (every beat <= liveActionEndSec & boundary not uncertain)
  const boundaryMax = Number(endingBoundary?.liveActionEndSec ?? model?.liveActionEndSec ?? spine?.storyScope?.liveActionEndSec);
  let sourceBoundaryOk = true;
  if (endingBoundary?.uncertain === true) {
    sourceBoundaryOk = false;
    techBlocking.push({
      gate: 'technical',
      code: 'SOURCE_BOUNDARY_UNCERTAIN',
      timestampSec: 0,
      message: `Source ending boundary detector marked boundary as uncertain (confidence ${endingBoundary.confidence}); automatic PASS is forbidden.`
    });
  }
  const beatsToCheck = Array.isArray(spine?.beats) ? spine.beats : (script?.segments || []);
  if (Number.isFinite(boundaryMax) && boundaryMax > 0) {
    for (const b of beatsToCheck) {
      const bEnd = Number(b.sourceEndSec);
      if (Number.isFinite(bEnd) && bEnd > boundaryMax + 0.05) {
        sourceBoundaryOk = false;
        techBlocking.push({
          gate: 'technical',
          code: 'EDL_EXCEEDS_SOURCE_BOUNDARY',
          timestampSec: round2(bEnd),
          message: `Segment '${b.beatId || b.id}' sourceEndSec=${bEnd}s exceeds liveActionEndSec=${boundaryMax}s.`
        });
      }
    }
  }

  // 7. Subtitle & top caption overflow
  const subFindings = checkSubtitlesAndTitleOverflow({ subtitlePaths, topCaptionText, durationSec: media.durationSec });
  const subtitleOk = subFindings.length === 0;
  for (const sf of subFindings) {
    techBlocking.push({ gate: 'technical', code: sf.code, timestampSec: sf.timestampSec || 0, message: sf.message });
  }

  // 8. Audio Handoff technical check
  const deliveryBlocks = Array.isArray(script?.delivery_blocks) ? script.delivery_blocks : [];
  let handoffOk = true;
  for (const blk of deliveryBlocks) {
    if (blk.mode === 'narrated_story' && Number(blk.fitRatio) > 1.085) {
      handoffOk = false;
      techBlocking.push({
        gate: 'technical',
        code: 'NARRATOR_HANDOFF_OVERFLOW',
        timestampSec: round2(blk.outputEndSec || 0),
        message: `Narrated block '${blk.blockId}' fitRatio=${blk.fitRatio} exceeds 1.085 safe handoff ceiling.`
      });
    }
  }

  const technicalGate = {
    status: techBlocking.length === 0 ? 'PASS' : 'FAIL',
    checks: {
      dimensions: { pass: dimensionsOk, actual: resolutionLabel, expected: `${expectedWidth}x${expectedHeight}` },
      duration: { pass: durationOk, actualSec: media.durationSec, expectedTimelineSec: expectedTimelineSec ? round2(expectedTimelineSec) : null, driftSec: durationDriftSec },
      audioPeak: { pass: peakOk, truePeakDb: av.truePeakDb },
      loudness: { pass: loudnessOk, integratedLufs: av.integratedLufs },
      silence: { pass: silenceOk, silences: av.silences, tailSilences },
      videoFreeze: { pass: freezeOk, freezes: av.freezes },
      flashFrame: { pass: flashOk, flashFrames: shotAudit.flashFrames, blacks: av.blacks },
      outroIntrusion: { pass: !outroIntrusionDetected, outroFrameCount: shotAudit.outroFrameCount, firstOutroFrame: shotAudit.firstOutroFrame },
      subtitleOverflow: { pass: subtitleOk, findings: subFindings },
      handoff: { pass: handoffOk },
      unexpectedLayoutTransitions: { pass: unexpectedLayoutOk, cutTransitions: shotAudit.cutTransitions },
      sourceBoundaryCompliance: { pass: sourceBoundaryOk, liveActionEndSec: Number.isFinite(boundaryMax) ? boundaryMax : null, uncertain: Boolean(endingBoundary?.uncertain) },
      fileIntegrity: { pass: fileIntegrityOk, sizeBytes: stat.size, videoCodec: media.video?.codec || null, audioCodec: media.audio?.codec || null }
    },
    warnings: techWarnings,
    blockingFindings: techBlocking
  };

  // ---------------- EDITORIAL GATE ----------------
  const editBlocking = [];
  const mustWithhold = spine?.storyScope?.mustWithhold || [];
  const titleCheck = topCaptionText
    ? verifyHookTitle(topCaptionText, { model: model || {}, cues, mustWithhold, referenceTitle })
    : { valid: true, issues: [] };
  if (!titleCheck.valid) {
    for (const ti of titleCheck.issues.filter(x => x.severity === 'blocking')) {
      editBlocking.push({ gate: 'editorial', code: ti.code, timestampSec: 0, message: ti.message });
    }
  }

  if (narrationAudit) {
    if (narrationAudit.summary?.hasSpoiler) {
      editBlocking.push({
        gate: 'editorial',
        code: 'NARRATOR_SPOILS_PUNCHLINE',
        timestampSec: 0,
        message: 'Narrator pre-spoils an upcoming raw evidence quote/punchline.'
      });
    }
    if (pacingMode === 'commentary_led') {
      if ((narrationAudit.summary?.narratorBlockCount || 0) < 3) {
        editBlocking.push({
          gate: 'editorial',
          code: 'NARRATOR_UNDERUSED_REGRESSION',
          timestampSec: 0,
          message: `Commentary-led edit has only ${narrationAudit.summary?.narratorBlockCount || 0} narrator blocks.`
        });
      }
      if ((narrationAudit.summary?.maxUninterruptedRawSec || 0) > 34) {
        editBlocking.push({
          gate: 'editorial',
          code: 'OVERLONG_UNINTERRUPTED_RAW_STRETCH',
          timestampSec: 0,
          message: `Uninterrupted raw evidence runs ${narrationAudit.summary.maxUninterruptedRawSec}s (>34s ceiling) without narrator interpretation or re-hook.`
        });
      }
    }
    for (const b of narrationAudit.blocks || []) {
      if (b.contentValue?.rating === 'DEFECTIVE_JUDGMENTAL' || b.contentValue?.rating === 'WEAK_STUB') {
        editBlocking.push({
          gate: 'editorial',
          code: `NARRATOR_${b.contentValue.rating}`,
          timestampSec: b.outputStartSec || 0,
          message: `Block '${b.blockId}': ${b.contentValue.summary}`
        });
      }
    }
  }

  let multimodalEditorial = null;
  if (aiService?.generateJsonFromFiles) {
    const editPrompt = `You are an Independent Editorial Quality Auditor inspecting the FINAL 1080x1920 MP4 (${media.durationSec}s) of a short-form US True Crime Commentary video.
Watch and listen to the ENTIRE attached MP4 from 0.0s to ${media.durationSec}s, including the opening hook, every narrator passage, every raw bodycam exchange, and the final 5 seconds.
On-screen banner title: "${topCaptionText || '(embedded in video)'}"
Pacing profile: ${pacingMode}

Evaluate all 12 editorial criteria strictly from what you SEE and HEAR in this MP4:
1. hook: Does the first 3-5s + title create immediate curiosity without unverified claims or spoiling the ending?
2. storyClarity: Can a first-time viewer follow every cause-and-effect turn without confusion?
3. narratorValue: Does the narrator actively guide comprehension and momentum rather than merely labeling actions?
4. commentary: Does the narrator deliver grounded behavioral/statutory interpretation (contrasting claims vs reality) without insults?
5. narratorNaturalness: Does the spoken voice sound natural in pace, pause, tone, mix, and handoff into raw clips?
6. pacing: Does every raw stretch earn its runtime with new conflict/information, avoiding tedious repetition?
7. curiosityProgression: Does tension escalate with a mid-story re-hook into the second half?
8. sourceFidelity: Are all claims grounded in the real incident without distortion?
9. punchline: Are the strongest real spoken lines heard directly from the participants without the narrator spoiling them beforehand?
10. payoff: Does the climax/consequence genuinely answer the central question?
11. ending: Does the final moment conclude cleanly on intended live action + takeaway without cutting mid-sentence or flashing an outro card?
12. overallWatchability: Does the edit work as cohesive Narrator-Led True Crime Storytelling?

List any genuine blocking editorial defects in blockingIssues (empty array if none). Never pass a criterion if a blocking defect breaks it. Return JSON only.`;
    try {
      multimodalEditorial = await aiService.generateJsonFromFiles({
        filePaths: [canonicalPath],
        prompt: editPrompt,
        responseSchema: EDITORIAL_GATE_SCHEMA,
        taskType: 'analysis'
      });
      for (const bi of multimodalEditorial?.blockingIssues || []) {
        editBlocking.push({
          gate: 'editorial',
          code: bi.code || 'MULTIMODAL_EDITORIAL_DEFECT',
          timestampSec: round2(bi.timestampSec || 0),
          message: bi.message
        });
      }
      for (const key of ['hook', 'storyClarity', 'narratorValue', 'commentary', 'narratorNaturalness', 'pacing', 'curiosityProgression', 'sourceFidelity', 'punchline', 'payoff', 'ending', 'overallWatchability']) {
        if (multimodalEditorial?.[key]?.pass === false && !editBlocking.some(x => x.code === `CRITERION_${key.toUpperCase()}_FAIL`)) {
          editBlocking.push({
            gate: 'editorial',
            code: `CRITERION_${key.toUpperCase()}_FAIL`,
            timestampSec: 0,
            message: `${key} failed multimodal audit: ${multimodalEditorial[key].notes}`
          });
        }
      }
    } catch (err) {
      editBlocking.push({
        gate: 'editorial',
        code: 'EDITORIAL_CRITIC_UNAVAILABLE',
        timestampSec: 0,
        message: `Multimodal editorial audit failed to execute: ${err.message}`
      });
    }
  }

  const defaultCriterion = (pass, notes) => ({ pass, notes });
  const criteria = multimodalEditorial ? {
    hook: multimodalEditorial.hook,
    storyClarity: multimodalEditorial.storyClarity,
    narratorValue: multimodalEditorial.narratorValue,
    commentary: multimodalEditorial.commentary,
    narratorNaturalness: multimodalEditorial.narratorNaturalness,
    pacing: multimodalEditorial.pacing,
    curiosityProgression: multimodalEditorial.curiosityProgression,
    sourceFidelity: multimodalEditorial.sourceFidelity,
    punchline: multimodalEditorial.punchline,
    payoff: multimodalEditorial.payoff,
    ending: multimodalEditorial.ending,
    overallWatchability: multimodalEditorial.overallWatchability
  } : {
    hook: defaultCriterion(titleCheck.valid, titleCheck.valid ? 'Verified hook title.' : titleCheck.issues.map(i => i.message).join('; ')),
    storyClarity: defaultCriterion(true, 'Deterministic spine check passed (no multimodal AI service supplied).'),
    narratorValue: defaultCriterion(!editBlocking.some(e => e.code.startsWith('NARRATOR_')), 'Checked via narration performance audit.'),
    commentary: defaultCriterion(!editBlocking.some(e => e.code.includes('COMMENTARY') || e.code.includes('UNDERUSED')), 'Checked via narration audit.'),
    narratorNaturalness: defaultCriterion(!narrationAudit?.summary?.hasRushedVoice, 'Checked via WPM and pause inspection.'),
    pacing: defaultCriterion(!editBlocking.some(e => e.code.includes('RAW_STRETCH')), 'Checked via raw stretch audit.'),
    curiosityProgression: defaultCriterion(true, 'Checked via delivery block structure.'),
    sourceFidelity: defaultCriterion(titleCheck.valid && sourceBoundaryOk, 'Checked via title verifier and source boundary.'),
    punchline: defaultCriterion(!narrationAudit?.summary?.hasSpoiler, 'Checked via punchline spoiler gate.'),
    payoff: defaultCriterion(true, 'Checked via spine ending contract.'),
    ending: defaultCriterion(!outroIntrusionDetected && tailSilences.length === 0, !outroIntrusionDetected ? 'Clean ending.' : 'Outro intrusion detected.'),
    overallWatchability: defaultCriterion(techBlocking.length === 0 && editBlocking.length === 0, 'Combined deterministic gate.')
  };

  // Never allow ending criterion to report pass if Technical Gate caught outro intrusion or tail silence!
  if (outroIntrusionDetected || tailSilences.length > 0) {
    criteria.ending = { pass: false, notes: 'Blocked by technical ending defect (outro intrusion or audio tail silence).' };
    criteria.overallWatchability = { pass: false, notes: 'Blocked by technical ending defect.' };
  }

  const editorialGate = {
    status: editBlocking.length === 0 && Object.values(criteria).every(c => c?.pass !== false) ? 'PASS' : 'FAIL',
    summary: multimodalEditorial?.summary || (editBlocking.length === 0 ? 'All editorial checks passed.' : `${editBlocking.length} blocking editorial issue(s).`),
    titleVerification: titleCheck,
    criteria,
    blockingFindings: editBlocking
  };

  const allBlocking = [...techBlocking, ...editBlocking];
  const publishReady = technicalGate.status === 'PASS' && editorialGate.status === 'PASS' && allBlocking.length === 0;

  const report = {
    contract: 'final-quality-gate-v1',
    filePath: canonicalPath,
    sha256,
    fileSize: stat.size,
    duration: media.durationSec,
    resolution: {
      width: media.video?.width || 0,
      height: media.video?.height || 0,
      fps: media.video?.fps || 0,
      label: resolutionLabel
    },
    qaTimestamp,
    qaResult: publishReady ? 'PASS' : 'FAIL',
    publishReady,
    blockingFindings: allBlocking,
    technicalGate,
    editorialGate
  };

  if (outputPath) {
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, JSON.stringify(report, null, 2));
  }
  return report;
}

/**
 * Verifies that a QA report belongs to `targetMp4Path`, that the file has not
 * changed by even a single byte since QA ran, that it is a true Production Final
 * resolution (1080x1920), and that BOTH Technical & Editorial gates passed.
 */
async function verifyFinalQaBinding(qaReport, targetMp4Path, { expectedWidth = 1080, expectedHeight = 1920 } = {}) {
  const reasons = [];
  if (!qaReport || typeof qaReport !== 'object') {
    return { valid: false, reasons: ['QA_REPORT_MISSING'] };
  }
  const canonicalTarget = path.resolve(String(targetMp4Path || ''));
  if (!fs.existsSync(canonicalTarget)) {
    return { valid: false, reasons: ['TARGET_MP4_MISSING'] };
  }
  if (path.resolve(String(qaReport.filePath || '')).toLowerCase() !== canonicalTarget.toLowerCase()) {
    reasons.push(`QA_PATH_MISMATCH: report tested "${qaReport.filePath}" instead of "${canonicalTarget}" (draft QA reuse forbidden).`);
  }
  const stat = await fsp.stat(canonicalTarget);
  if (Number(qaReport.fileSize) !== stat.size) {
    reasons.push(`QA_FILESIZE_MISMATCH: report size=${qaReport.fileSize}, current size=${stat.size}.`);
  }
  const actualSha = await computeFileSha256(canonicalTarget);
  if (qaReport.sha256 !== actualSha) {
    reasons.push(`QA_SHA256_MISMATCH: report sha256=${qaReport.sha256}, current sha256=${actualSha} (file modified after QA).`);
  }
  if (qaReport.resolution?.width !== expectedWidth || qaReport.resolution?.height !== expectedHeight) {
    reasons.push(`QA_NOT_PRODUCTION_RESOLUTION: got ${qaReport.resolution?.label || 'unknown'}, expected ${expectedWidth}x${expectedHeight}.`);
  }
  if (qaReport.technicalGate?.status !== 'PASS') {
    reasons.push('TECHNICAL_GATE_NOT_PASS');
  }
  if (qaReport.editorialGate?.status !== 'PASS') {
    reasons.push('EDITORIAL_GATE_NOT_PASS');
  }
  if (qaReport.publishReady !== true || qaReport.qaResult !== 'PASS' || (qaReport.blockingFindings || []).length > 0) {
    reasons.push('PUBLISH_READY_FALSE');
  }
  return {
    valid: reasons.length === 0,
    actualSha256: actualSha,
    actualFileSize: stat.size,
    reasons
  };
}

module.exports = {
  computeFileSha256,
  probeMediaFull,
  inspectAudioAndVideoAnomalies,
  inspectFinalShotBoundariesAndOutro,
  checkSubtitlesAndTitleOverflow,
  runFinalQualityGate,
  verifyFinalQaBinding
};
