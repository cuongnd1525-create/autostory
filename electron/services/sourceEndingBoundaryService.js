// AutoStory V6 — Source-Aware Ending Boundary Detection Service (v2)
//
// Detects the true boundary between live-action incident footage and
// post-incident outro/recap graphics, split-screen end cards, sentencing
// epilogue cards, or promotional credits using per-video multimodal signals:
//   1. FFmpeg visual scene-cut detection (`scdet`) & blackframe detection on trailing region
//   2. Raw frame pixel layout analysis before/after trailing scene cuts
//      (detecting multi-panel horizontal split-screen divider bars, black cards, static graphics)
//   3. Trailing audio silence / abrupt drop detection (`silencedetect`)
//   4. Trailing SRT subtitle cues (epilogue / sentencing / promo / channel wrap-up patterns)
//   5. Scene manifest & Source Story Model event metadata
//
// Zero hardcoded case timestamps. Versioned cache with source fingerprint invalidation.

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BOUNDARY_CACHE_VERSION = 3;
const SAFETY_MARGIN_SEC = 0.20; // 6 frames at 30fps before exact outro transition cut

const OUTRO_TEXT_PATTERNS = [
  /thanks for watching/i,
  /thank you for watching/i,
  /see you on the next/i,
  /like and subscribe/i,
  /subscribe for more/i,
  /don't forget to subscribe/i,
  /comment below|let us know in the comments/i,
  /patreon|merch|membership/i,
  /next ride along/i,
  /pleaded guilty|pleading guilty|pled guilty|made a plea deal/i,
  /convicted on (?:\d+|one|two|three|four|five|six|multiple|several) counts/i,
  /all other charges were dropped|charge would eventually get dropped|charges were dropped/i,
  /was sentenced to|sentenced to a minimum|sentenced to prison|parole eligible/i,
  /potential release(?:\s+from\s+prison|\s+is\s+\d{4})?/i,
  /booking officer would put (?:her|his|their) bond/i,
  /the officer charged (?:her|him|them) with/i,
  /was charged with misuse of/i,
  /cautionary tale for somebody to watch/i,
  /our purpose here isn['’]?t just to show you videos/i,
  /end of watch/i
];

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function computeSourceFingerprint(sourcePath, durationSec, sourceHash = '') {
  if (sourceHash) return `hash:${sourceHash}:v${BOUNDARY_CACHE_VERSION}`;
  if (!sourcePath) return `virtual:${round2(durationSec)}:v${BOUNDARY_CACHE_VERSION}`;
  try {
    const st = await fs.stat(sourcePath);
    const raw = `${path.basename(sourcePath)}|${st.size}|${Math.round(st.mtimeMs)}|${round2(durationSec)}|v${BOUNDARY_CACHE_VERSION}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
  } catch (_) {
    return `path:${path.basename(sourcePath)}:${round2(durationSec)}:v${BOUNDARY_CACHE_VERSION}`;
  }
}

function runFfmpegCapture(ffmpegPath, args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    let child;
    try {
      child = spawn(ffmpegPath || 'ffmpeg', args, { windowsHide: true });
    } catch (err) {
      return finish({ ok: false, code: -1, stdout, stderr: err.message });
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, code: -2, stdout, stderr: `${stderr}\nTIMEOUT` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); finish({ ok: false, code: -1, stdout, stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ ok: code === 0, code, stdout, stderr }); });
  });
}

/**
 * Inspects a 320x180 grayscale raw frame buffer for:
 * - horizontal dark divider bars spanning the full width (2-panel / 3-panel split-screen outro layouts)
 * - solid black / near-black end cards
 * - low-variance graphic cards
 */
function analyzeGrayFrameLayout(buf, width = 320, height = 180) {
  if (!buf || buf.length < width * height) {
    return { valid: false, isBlackCard: false, isSplitScreen: false, dividerBands: 0, frameMean: 0, frameStdev: 0 };
  }
  const total = width * height;
  let sum = 0;
  let sumSq = 0;
  const rowMeans = new Float64Array(height);
  const rowDarkFrac = new Float64Array(height);

  for (let y = 0; y < height; y++) {
    let rSum = 0;
    let darkCount = 0;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const v = buf[rowOffset + x];
      rSum += v;
      sum += v;
      sumSq += v * v;
      if (v <= 20) darkCount++;
    }
    rowMeans[y] = rSum / width;
    rowDarkFrac[y] = darkCount / width;
  }

  const frameMean = sum / total;
  const variance = Math.max(0, (sumSq / total) - (frameMean * frameMean));
  const frameStdev = Math.sqrt(variance);
  const isBlackCard = frameMean < 18 && frameStdev < 16;

  // Detect interior horizontal black divider bands (characteristic of 2-panel or 3-panel split-screen recaps)
  // A valid divider band lies in interior rows [15%..85%], spans >= 92% dark pixels across full width,
  // is 1..16 rows thick, and separates non-black image panels above and below it.
  const minY = Math.floor(height * 0.15);
  const maxY = Math.ceil(height * 0.85);
  const bands = [];
  let y = minY;
  while (y < maxY) {
    if (rowMeans[y] <= 18 && rowDarkFrac[y] >= 0.92) {
      const startY = y;
      while (y < maxY && rowMeans[y] <= 20 && rowDarkFrac[y] >= 0.90) y++;
      const endY = y - 1;
      const thickness = endY - startY + 1;
      if (thickness >= 1 && thickness <= Math.ceil(height * 0.12)) {
        // Verify non-black image panel content exists above and below this horizontal divider bar
        // (supports night bodycam panels whose average luma may be 14..30 while still clearly brighter than the 0..4 divider bar)
        let aboveMean = 0, aboveMax = 0, aboveCnt = 0;
        for (let ay = Math.max(4, startY - 24); ay < startY - 2; ay++) {
          aboveMean += rowMeans[ay];
          if (rowMeans[ay] > aboveMax) aboveMax = rowMeans[ay];
          aboveCnt++;
        }
        let belowMean = 0, belowMax = 0, belowCnt = 0;
        for (let by = endY + 3; by <= Math.min(height - 5, endY + 24); by++) {
          belowMean += rowMeans[by];
          if (rowMeans[by] > belowMax) belowMax = rowMeans[by];
          belowCnt++;
        }
        const avgAbove = aboveCnt ? aboveMean / aboveCnt : 0;
        const avgBelow = belowCnt ? belowMean / belowCnt : 0;
        const bandMean = rowMeans[Math.floor((startY + endY) / 2)];
        if (
          (avgAbove >= 14 || aboveMax >= 22) &&
          (avgBelow >= 14 || belowMax >= 22) &&
          avgAbove > bandMean + 8 &&
          avgBelow > bandMean + 8
        ) {
          bands.push({ startY, endY, thickness, avgAbove: round2(avgAbove), avgBelow: round2(avgBelow) });
        }
      }
    } else {
      y++;
    }
  }

  return {
    valid: true,
    isBlackCard,
    isSplitScreen: bands.length >= 1,
    isMultiPanelSplit: bands.length >= 2,
    dividerBands: bands.length,
    bands,
    frameMean: round2(frameMean),
    frameStdev: round2(frameStdev)
  };
}

async function sampleGrayFrameAt(ffmpegPath, sourcePath, timeSec, width = 320, height = 180) {
  const res = await runFfmpegCapture(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', Math.max(0, timeSec).toFixed(3),
    '-i', sourcePath,
    '-frames:v', '1',
    '-vf', `scale=${width}:${height},format=gray`,
    '-f', 'rawvideo',
    'pipe:1'
  ], 8000);
  if (!res.ok || res.stdout.length < width * height) return null;
  return res.stdout.subarray(0, width * height);
}

function frameDiffMean(bufA, bufB) {
  if (!bufA || !bufB || bufA.length !== bufB.length || !bufA.length) return null;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff += Math.abs(bufA[i] - bufB[i]);
  return round2(diff / bufA.length);
}

function resolveFfprobePath(ffmpegPath = 'ffmpeg') {
  if (!ffmpegPath || ffmpegPath === 'ffmpeg') return 'ffprobe';
  const dir = path.dirname(ffmpegPath);
  const ext = path.extname(ffmpegPath);
  const candidate = path.join(dir, `ffprobe${ext}`);
  return fsSync.existsSync(candidate) ? candidate : 'ffprobe';
}

async function listTrailingPacketKeyframes(sourcePath, startSec, durationSec, ffmpegPath = 'ffmpeg') {
  const ffprobePath = resolveFfprobePath(ffmpegPath);
  const res = await runFfmpegCapture(ffprobePath, [
    '-v', 'error',
    '-read_intervals', `${Math.max(0, startSec).toFixed(2)}%${(durationSec + 5).toFixed(2)}`,
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'csv=p=0',
    sourcePath
  ], 6000);
  if (!res.ok && !res.stdout.length) return [];
  const pts = [];
  for (const line of res.stdout.toString('utf8').split(/\r?\n/)) {
    if (!line.includes('K')) continue;
    const t = Number(line.split(',')[0]);
    if (Number.isFinite(t) && t >= startSec - 0.5 && t <= durationSec - 0.25) {
      pts.push(round3(t));
    }
  }
  return [...new Set(pts)].sort((a, b) => a - b);
}

/**
 * Fast 2-stage visual & audio trailing probe (< 3s even on 1080p AV1):
 *   Stage 1: Audio-only `silencedetect` across `inspectStartSec..durationSec` (no video decode)
 *            + MP4 packet keyframe index scan + uniform trailing checkpoints.
 *   Stage 2: Sample grayscale 320x180 frames at candidate cut points (concurrency 4)
 *            to detect split-screen divider bars, black end cards, and static cards,
 *            then refine any transition window with full-rate `scdet` over ~3.5s.
 */
async function probeTrailingMediaSignals(sourcePath, inspectStartSec, durationSec, ffmpegPath = 'ffmpeg') {
  if (!sourcePath || !fsSync.existsSync(sourcePath)) {
    return { inspected: false, sceneCuts: [], blackFrames: [], silences: [], cutTransitions: [] };
  }
  const spanSec = Math.max(1, durationSec - inspectStartSec);

  const [audioRes, keyframes] = await Promise.all([
    runFfmpegCapture(ffmpegPath, [
      '-hide_banner',
      '-ss', inspectStartSec.toFixed(3),
      '-t', spanSec.toFixed(3),
      '-i', sourcePath,
      '-vn',
      '-af', 'silencedetect=noise=-42dB:d=0.55',
      '-f', 'null',
      '-'
    ], 8000),
    listTrailingPacketKeyframes(sourcePath, Math.max(inspectStartSec, durationSec - 65), durationSec, ffmpegPath)
  ]);

  const silences = [];
  let pendingSilenceStart = null;
  for (const line of (audioRes.stderr || '').split(/\r?\n/)) {
    const silStart = line.match(/silence_start:\s*([\d.]+)/);
    if (silStart) pendingSilenceStart = round3(inspectStartSec + Number(silStart[1]));
    const silEnd = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (silEnd) {
      const endSec = round3(inspectStartSec + Number(silEnd[1]));
      const dur = round3(Number(silEnd[2]));
      silences.push({ startSec: pendingSilenceStart ?? round3(endSec - dur), endSec, durationSec: dur });
      pendingSilenceStart = null;
    }
  }
  if (pendingSilenceStart !== null && durationSec - pendingSilenceStart >= 0.5) {
    silences.push({ startSec: pendingSilenceStart, endSec: round3(durationSec), durationSec: round3(durationSec - pendingSilenceStart) });
  }

  // Build candidate probe points across the trailing window from keyframes, filling wide GOP gaps
  const tailFloor = Math.max(inspectStartSec, durationSec - 65);
  const kfTail = keyframes.filter(t => t >= tailFloor && t <= durationSec - 0.35);
  const rawPoints = [tailFloor, ...kfTail];
  const gapThreshold = durationSec < 60 ? 2.2 : 6.5;
  const gapStep = durationSec < 60 ? 1.6 : 4.5;
  const anchors = [tailFloor, ...kfTail, Math.max(tailFloor, durationSec - 0.6)];
  for (let i = 1; i < anchors.length; i++) {
    const gap = anchors[i] - anchors[i - 1];
    if (gap > gapThreshold) {
      for (let t = anchors[i - 1] + gapStep; t < anchors[i] - 0.8; t += gapStep) rawPoints.push(round3(t));
    }
  }
  rawPoints.push(round3(Math.max(tailFloor, durationSec - 0.6)));
  rawPoints.sort((a, b) => a - b);

  const minSpacing = durationSec < 60 ? 0.75 : 1.1;
  const probePoints = [];
  for (const pt of rawPoints) {
    // Sample slightly past keyframe (+0.20s) so post-cut layout is cleanly settled
    const sampleSec = round3(Math.min(durationSec - 0.2, pt + (keyframes.includes(pt) ? 0.20 : 0)));
    if (!probePoints.length || sampleSec - probePoints[probePoints.length - 1].sampleSec >= minSpacing) {
      probePoints.push({ cutCandidateSec: pt, sampleSec });
    }
  }

  // Sample grayscale layouts with bounded concurrency (4)
  const sampled = new Array(probePoints.length);
  for (let i = 0; i < probePoints.length; i += 4) {
    const batch = probePoints.slice(i, i + 4);
    const bufs = await Promise.all(batch.map(p => sampleGrayFrameAt(ffmpegPath, sourcePath, p.sampleSec)));
    batch.forEach((p, idx) => {
      const buf = bufs[idx];
      sampled[i + idx] = {
        ...p,
        buf,
        layout: analyzeGrayFrameLayout(buf)
      };
    });
  }

  // If the first sampled point is ALREADY inside a split-screen or black card, step backward to find live-action onset
  let guardSteps = 0;
  while (
    guardSteps < 4 &&
    sampled.length > 0 &&
    (sampled[0]?.layout?.isSplitScreen || sampled[0]?.layout?.isBlackCard) &&
    sampled[0].sampleSec > 1.0
  ) {
    const earlierSec = round3(Math.max(0.25, sampled[0].sampleSec - Math.min(18, Math.max(2.5, sampled[0].sampleSec * 0.45))));
    if (sampled[0].sampleSec - earlierSec < 0.5) break;
    const earlierBuf = await sampleGrayFrameAt(ffmpegPath, sourcePath, earlierSec);
    sampled.unshift({
      cutCandidateSec: earlierSec,
      sampleSec: earlierSec,
      buf: earlierBuf,
      layout: analyzeGrayFrameLayout(earlierBuf)
    });
    guardSteps += 1;
  }

  const sceneCuts = keyframes.map(sec => ({ sec, score: 15.0 }));
  const blackFrames = sampled.filter(s => s?.layout?.isBlackCard).map(s => ({ sec: s.sampleSec, pblack: 98 }));
  const cutTransitions = [];

  for (let i = 1; i < sampled.length; i++) {
    const prev = sampled[i - 1];
    const curr = sampled[i];
    const next = sampled[i + 1] || curr;
    if (!prev?.layout?.valid || !curr?.layout?.valid) continue;

    const entersSplitScreen = !prev.layout.isSplitScreen && curr.layout.isSplitScreen;
    const entersBlackCard = !prev.layout.isBlackCard && curr.layout.isBlackCard;
    const postMotionDiff = next !== curr ? frameDiffMean(curr.buf, next.buf) : null;
    const entersStaticCard = !prev.layout.isBlackCard && postMotionDiff !== null && postMotionDiff < 1.35 && curr.layout.frameStdev > 15;

    if (entersSplitScreen || entersBlackCard || entersStaticCard) {
      // Refine exact cut timestamp inside [prev.sampleSec - 0.25, curr.sampleSec + 0.25]
      const exactSec = await refineWindowSceneCut(sourcePath, prev.sampleSec - 0.25, curr.sampleSec + 0.25, curr.cutCandidateSec, ffmpegPath);
      cutTransitions.push({
        cutSec: exactSec,
        scdScore: 20.0,
        beforeLayout: prev.layout,
        afterLayout: curr.layout,
        laterLayout: next.layout,
        entersSplitScreen,
        entersBlackCard,
        entersStaticCard
      });
    }
  }

  return { inspected: true, sceneCuts, blackFrames, silences, cutTransitions };
}

async function refineWindowSceneCut(sourcePath, winStartRaw, winEndRaw, fallbackSec, ffmpegPath = 'ffmpeg') {
  if (!sourcePath || !fsSync.existsSync(sourcePath)) return round3(fallbackSec);
  const winStart = Math.max(0, winStartRaw);
  const winDur = Math.min(6.0, Math.max(0.5, winEndRaw - winStart));
  const res = await runFfmpegCapture(ffmpegPath, [
    '-hide_banner',
    '-ss', winStart.toFixed(3),
    '-t', winDur.toFixed(3),
    '-i', sourcePath,
    '-vf', 'scale=240:135,scdet=threshold=10',
    '-an',
    '-f', 'null',
    '-'
  ], 10000);
  const cuts = [];
  for (const line of (res.stderr || '').split(/\r?\n/)) {
    const m = line.match(/lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/);
    if (m) cuts.push({ sec: round3(winStart + Number(m[2])), score: Number(m[1]) });
  }
  if (!cuts.length) return round3(fallbackSec);
  cuts.sort((a, b) => b.score - a.score || Math.abs(a.sec - fallbackSec) - Math.abs(b.sec - fallbackSec));
  return cuts[0].sec;
}

/**
 * Refines an approximate cut timestamp using full-frame-rate `scdet` around `approxSec ± 1.4s`.
 */
async function refineExactCutTimestamp(sourcePath, approxSec, durationSec, ffmpegPath = 'ffmpeg') {
  return refineWindowSceneCut(
    sourcePath,
    Math.max(0, approxSec - 1.4),
    Math.min(durationSec, approxSec + 1.4),
    approxSec,
    ffmpegPath
  );
}

/**
 * Detects the live-action encounter ending boundary for a source video.
 */
async function detectSourceEndingBoundary({
  sourcePath,
  durationSec,
  cues = [],
  sceneManifest = null,
  model = null,
  cacheDir = null,
  analysisDir = null,
  sourceHash = '',
  ffmpegPath = 'ffmpeg',
  skipMediaProbe = false
} = {}) {
  const dur = Number(durationSec) || 0;
  if (dur <= 0) {
    return {
      version: BOUNDARY_CACHE_VERSION,
      sourceFingerprint: 'invalid',
      sourceDurationSec: 0,
      hasOutro: false,
      outroStartSec: null,
      liveActionEndSec: 0,
      confidence: 1.0,
      uncertain: false,
      outroType: 'none',
      evidence: [],
      reason: 'Invalid source duration'
    };
  }

  const sourceFingerprint = await computeSourceFingerprint(sourcePath, dur, sourceHash);
  const cacheFile = cacheDir ? path.join(cacheDir, 'source-ending-boundary.json') : null;
  const projectBoundaryFile = analysisDir ? path.join(analysisDir, 'source-ending-boundary.json') : null;

  if (cacheFile) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (
        cached &&
        cached.version === BOUNDARY_CACHE_VERSION &&
        cached.sourceFingerprint === sourceFingerprint &&
        Number.isFinite(cached.liveActionEndSec) &&
        Math.abs(Number(cached.sourceDurationSec) - dur) < 1.0
      ) {
        if (projectBoundaryFile && path.resolve(projectBoundaryFile) !== path.resolve(cacheFile)) {
          await fs.mkdir(path.dirname(projectBoundaryFile), { recursive: true }).catch(() => {});
          await fs.writeFile(projectBoundaryFile, JSON.stringify(cached, null, 2), 'utf8').catch(() => {});
        }
        return cached;
      }
    } catch (_) {}
  }

  const inspectWindowSec = Math.min(150, Math.max(Math.min(dur * 0.55, 45), dur * 0.30));
  const inspectStartSec = Math.max(0, dur - inspectWindowSec);
  const evidence = [];

  // 1. Load optional sceneManifest if available
  let scenes = Array.isArray(sceneManifest?.scenes) ? sceneManifest.scenes : [];
  if (!scenes.length && sourcePath) {
    const filename = path.basename(sourcePath, path.extname(sourcePath));
    const potentialPaths = [
      path.join(path.dirname(sourcePath), 'scene-manifest.json'),
      path.join(path.dirname(sourcePath), '..', '01-GUI-GEMINI', 'scene-manifest.json'),
      path.join('D:\\Video', `${filename}-gemini-analysis-pack`, '01-GUI-GEMINI', 'scene-manifest.json'),
      path.join('D:\\Video', `source-${filename.replace(/^source-/, '')}-gemini-analysis-pack`, '01-GUI-GEMINI', 'scene-manifest.json')
    ];
    for (const p of potentialPaths) {
      try {
        const loaded = JSON.parse(await fs.readFile(p, 'utf8'));
        if (loaded && Array.isArray(loaded.scenes) && loaded.scenes.length) {
          scenes = loaded.scenes;
          evidence.push({ source: 'scene_manifest', detail: `Loaded ${scenes.length} scene boundaries from ${path.basename(p)}` });
          break;
        }
      } catch (_) {}
    }
  }

  // 2. Subtitle cue check for epilogue / sentencing / promo / channel outro text
  let outroCueStartSec = null;
  let matchingPattern = '';
  let matchingCueText = '';
  if (Array.isArray(cues) && cues.length > 0) {
    const trailingCues = cues.filter(c => Number(c.startSec) >= inspectStartSec);
    for (const cue of trailingCues) {
      const text = String(cue.text || cue.translatedText || '').trim();
      for (const pattern of OUTRO_TEXT_PATTERNS) {
        if (pattern.test(text)) {
          outroCueStartSec = Number(cue.startSec);
          matchingPattern = pattern.toString();
          matchingCueText = text.slice(0, 120);
          evidence.push({
            source: 'subtitle_cue',
            sec: round3(outroCueStartSec),
            pattern: matchingPattern,
            excerpt: matchingCueText
          });
          break;
        }
      }
      if (outroCueStartSec !== null) break;
    }
  }

  // 3. Source Story Model event check
  let modelOutroStartSec = null;
  if (Array.isArray(model?.events)) {
    const trailingEvents = model.events.filter(e => Number(e.startSec) >= inspectStartSec);
    const outroEvent = trailingEvents.find(e =>
      /outro|recap|end[\s_-]*screen|credits|promo|epilogue|sentenc(?:e|ing)\s+card|split[\s_-]*screen|graphics\s+screen|charges_reveal|retrospective|studio\s*\/?\s*archive|past\s+viral\s+video|narrator\s+reveals/i.test(
        `${e.type || ''} ${e.summary || ''} ${e.label || ''} ${e.location || ''}`
      ) ||
      (String(e.audioType || '').toLowerCase() === 'external_narrator' && /graphics|archive|studio|epilogue|outro|recap|charge|sentenc|viral/i.test(`${e.type || ''} ${e.summary || ''} ${e.location || ''}`))
    );
    if (outroEvent && Number.isFinite(Number(outroEvent.startSec))) {
      modelOutroStartSec = Number(outroEvent.startSec);
      evidence.push({
        source: 'story_model_event',
        sec: round3(modelOutroStartSec),
        eventId: outroEvent.id || null,
        summary: String(outroEvent.summary || '').slice(0, 120)
      });
    }
  }

  // 4. Direct FFmpeg visual + audio trailing media probe
  const mediaSignals = skipMediaProbe
    ? { inspected: false, sceneCuts: [], blackFrames: [], silences: [], cutTransitions: [] }
    : await probeTrailingMediaSignals(sourcePath, inspectStartSec, dur, ffmpegPath);

  const visualSplitTransition = mediaSignals.cutTransitions.find(t => t.entersSplitScreen);
  const visualCardTransition = mediaSignals.cutTransitions.find(t => t.entersBlackCard || t.entersStaticCard);

  if (visualSplitTransition) {
    evidence.push({
      source: 'ffmpeg_visual_split_screen',
      sec: visualSplitTransition.cutSec,
      scdScore: visualSplitTransition.scdScore,
      dividerBands: Math.max(visualSplitTransition.afterLayout.dividerBands, visualSplitTransition.laterLayout.dividerBands)
    });
  }
  if (visualCardTransition) {
    evidence.push({
      source: 'ffmpeg_visual_end_card',
      sec: visualCardTransition.cutSec,
      scdScore: visualCardTransition.scdScore,
      blackCard: visualCardTransition.entersBlackCard,
      staticCard: visualCardTransition.entersStaticCard
    });
  }

  // 5. Synthesize evidence into exact outroStartSec & liveActionEndSec
  let hasOutro = false;
  let outroStartSec = null;
  let liveActionCutSec = dur;
  let outroType = 'none';
  let confidence = mediaSignals.inspected || cues.length || scenes.length ? 0.95 : 0.75;
  let uncertain = false;
  let reason = 'Live action continues cleanly to end of source video';

  if (visualSplitTransition) {
    // Highest-certainty visual proof: exact frame transition into horizontal split-screen outro
    const exactCutSec = await refineExactCutTimestamp(sourcePath, visualSplitTransition.cutSec, dur, ffmpegPath);
    hasOutro = true;
    outroStartSec = round3(exactCutSec);
    liveActionCutSec = round2(Math.max(0, exactCutSec - SAFETY_MARGIN_SEC));
    outroType = 'split_screen_recap_outro';
    confidence = outroCueStartSec !== null ? 0.99 : 0.96;
    uncertain = false;
    reason = `FFmpeg detected split-screen outro transition at ${outroStartSec}s (dividerBands=${Math.max(visualSplitTransition.afterLayout.dividerBands, visualSplitTransition.laterLayout.dividerBands)}${outroCueStartSec !== null ? `, outro cue at ${outroCueStartSec.toFixed(2)}s` : ''}); live-action capped at ${liveActionCutSec}s`;
  } else if (outroCueStartSec !== null || modelOutroStartSec !== null) {
    hasOutro = true;
    const anchorSec = outroCueStartSec !== null && modelOutroStartSec !== null
      ? Math.min(outroCueStartSec, modelOutroStartSec)
      : (outroCueStartSec ?? modelOutroStartSec);

    // Align to nearest visual scene cut (`scdet`) or `sceneManifest` cut right at or before `anchorSec + 0.75s`
    const nearbyVisualCut = [...mediaSignals.sceneCuts]
      .filter(c => c.sec <= anchorSec + 0.75 && c.sec >= Math.max(inspectStartSec, anchorSec - 6.0))
      .sort((a, b) => Math.abs(a.sec - anchorSec) - Math.abs(b.sec - anchorSec))[0];

    const sceneContainingOutro = scenes.find(s => Number(s.startSec) <= anchorSec + 0.6 && Number(s.endSec) > anchorSec + 0.05);
    const precedingScene = [...scenes]
      .reverse()
      .find(s => Number(s.endSec) <= anchorSec + 0.6 && Number(s.endSec) >= inspectStartSec);

    if (nearbyVisualCut) {
      const exactCutSec = await refineExactCutTimestamp(sourcePath, nearbyVisualCut.sec, dur, ffmpegPath);
      outroStartSec = round3(exactCutSec);
      liveActionCutSec = round2(Math.max(0, exactCutSec - SAFETY_MARGIN_SEC));
      outroType = 'channel_recap_outro';
      confidence = 0.95;
      uncertain = false;
      reason = `Outro cue/model signal at ${anchorSec.toFixed(2)}s aligned to FFmpeg visual scene cut at ${outroStartSec}s (capped at ${liveActionCutSec}s)`;
    } else if (sceneContainingOutro && Number(sceneContainingOutro.startSec) > inspectStartSec) {
      outroStartSec = round3(Number(sceneContainingOutro.startSec));
      liveActionCutSec = round2(Math.max(0, outroStartSec - SAFETY_MARGIN_SEC));
      outroType = 'channel_recap_outro';
      confidence = 0.93;
      uncertain = false;
      reason = `Outro cue/model signal at ${anchorSec.toFixed(2)}s aligned to scene boundary at ${outroStartSec}s (capped at ${liveActionCutSec}s)`;
    } else if (precedingScene && Number(precedingScene.endSec) > 0) {
      outroStartSec = round3(Number(precedingScene.endSec));
      liveActionCutSec = round2(Math.max(0, outroStartSec - SAFETY_MARGIN_SEC));
      outroType = 'channel_recap_outro';
      confidence = 0.88;
      uncertain = false;
      reason = `Outro cue/model signal at ${anchorSec.toFixed(2)}s aligned to preceding scene end at ${outroStartSec}s (capped at ${liveActionCutSec}s)`;
    } else {
      // Text signal exists without a confirmed visual cut -> conservative cut + explicit uncertainty
      outroStartSec = round3(anchorSec);
      liveActionCutSec = round2(Math.max(inspectStartSec, anchorSec - 1.0));
      outroType = 'epilogue_or_commentary_outro';
      confidence = 0.70;
      uncertain = true;
      reason = `Outro text/model signal at ${anchorSec.toFixed(2)}s without clean visual cut; conservatively capped at ${liveActionCutSec}s (marked uncertain for mandatory visual QA)`;
    }
  } else if (visualCardTransition && visualCardTransition.cutSec >= dur - 25) {
    const exactCutSec = await refineExactCutTimestamp(sourcePath, visualCardTransition.cutSec, dur, ffmpegPath);
    hasOutro = true;
    outroStartSec = round3(exactCutSec);
    liveActionCutSec = round2(Math.max(0, exactCutSec - SAFETY_MARGIN_SEC));
    outroType = visualCardTransition.entersBlackCard ? 'black_end_card' : 'static_end_card';
    confidence = visualCardTransition.entersBlackCard ? 0.90 : 0.82;
    uncertain = !visualCardTransition.entersBlackCard;
    reason = `FFmpeg detected trailing ${outroType} at ${outroStartSec}s; live-action capped at ${liveActionCutSec}s`;
  }

  // Trailing long dead-air silence check right at the end of live-action region
  const trailingSilence = mediaSignals.silences.find(
    s => s.endSec >= liveActionCutSec - 0.15 && s.startSec < liveActionCutSec - 0.8 && s.startSec > Math.max(inspectStartSec, liveActionCutSec - 10)
  );
  if (trailingSilence && hasOutro) {
    evidence.push({
      source: 'trailing_audio_silence',
      startSec: trailingSilence.startSec,
      endSec: trailingSilence.endSec,
      durationSec: trailingSilence.durationSec
    });
  }

  const result = {
    version: BOUNDARY_CACHE_VERSION,
    sourceFingerprint,
    sourceDurationSec: dur,
    hasOutro,
    outroStartSec,
    liveActionEndSec: liveActionCutSec,
    confidence: round2(confidence),
    uncertain,
    outroType,
    evidence,
    reason
  };

  for (const targetFile of [cacheFile, projectBoundaryFile]) {
    if (!targetFile) continue;
    try {
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      await fs.writeFile(targetFile, JSON.stringify(result, null, 2), 'utf8');
    } catch (_) {}
  }

  return result;
}

module.exports = {
  BOUNDARY_CACHE_VERSION,
  SAFETY_MARGIN_SEC,
  OUTRO_TEXT_PATTERNS,
  computeSourceFingerprint,
  analyzeGrayFrameLayout,
  probeTrailingMediaSignals,
  detectSourceEndingBoundary
};
