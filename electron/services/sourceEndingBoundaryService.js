// AutoStory V6 — Source-Aware Ending Boundary Detection Service
//
// Detects the true boundary between live-action incident footage and
// post-incident outro/recap graphics, end-screens, or promotional credits.
// Replaces brittle hardcoded timestamps with dynamic, source-specific analysis.

const fs = require('fs/promises');
const path = require('path');

const OUTRO_TEXT_PATTERNS = [
  /thanks for watching/i,
  /see you on the next/i,
  /like and subscribe/i,
  /subscribe for more/i,
  /comment below/i,
  /patreon/i,
  /next ride along/i,
  /pleaded guilty|pleading guilty/i,
  /all other charges were dropped|charge would eventually get dropped|charges were dropped/i,
  /was sentenced to|sentenced to a minimum|sentenced to prison/i,
  /booking officer would put her bond/i,
  /the officer charged her with/i,
  /was charged with misuse of/i,
  /end of watch/i
];

/**
 * Detects the live-action encounter ending boundary for a source video.
 * @param {Object} options
 * @param {string} options.sourcePath - Path to source video file
 * @param {number} options.durationSec - Total video duration in seconds
 * @param {Array} [options.cues] - Normalized SRT subtitle cues
 * @param {Object} [options.sceneManifest] - Manifest with scenes array
 * @param {Object} [options.model] - Source story model
 * @param {string} [options.cacheDir] - Directory to persist/load detected boundary
 * @returns {Promise<{ hasOutro: boolean, liveActionEndSec: number, confidence: number, outroType: string, reason: string }>}
 */
async function detectSourceEndingBoundary({
  sourcePath,
  durationSec,
  cues = [],
  sceneManifest = null,
  model = null,
  cacheDir = null
}) {
  const dur = Number(durationSec) || 0;
  if (dur <= 0) {
    return { hasOutro: false, liveActionEndSec: 0, confidence: 1.0, outroType: 'none', reason: 'Invalid source duration' };
  }

  // 1. Check cache if provided
  const cacheFile = cacheDir ? path.join(cacheDir, 'source-ending-boundary.json') : null;
  if (cacheFile) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (cached && Number.isFinite(cached.liveActionEndSec) && Math.abs(cached.sourceDurationSec - dur) < 1.0) {
        return cached;
      }
    } catch (_) {}
  }

  // 2. Trailing region inspection (typically last 20% or last 120 seconds, whichever is smaller)
  const inspectWindowSec = Math.min(120, dur * 0.25);
  const inspectStartSec = Math.max(0, dur - inspectWindowSec);

  // A. Subtitle cues check for channel outro phrases
  let outroCueStartSec = null;
  let matchingPattern = '';
  if (Array.isArray(cues) && cues.length > 0) {
    const trailingCues = cues.filter(c => Number(c.startSec) >= inspectStartSec);
    for (const cue of trailingCues) {
      const text = String(cue.text || cue.translatedText || '');
      for (const pattern of OUTRO_TEXT_PATTERNS) {
        if (pattern.test(text)) {
          outroCueStartSec = Number(cue.startSec);
          matchingPattern = pattern.toString();
          break;
        }
      }
      if (outroCueStartSec !== null) break;
    }
  }

  let liveActionCutSec = dur;
  let hasOutro = false;
  let outroType = 'none';
  let reason = 'Live action continues to end of video';
  let confidence = 1.0;

  let scenes = Array.isArray(sceneManifest?.scenes) ? sceneManifest.scenes : [];
  if (!scenes.length && sourcePath) {
    const filename = path.basename(sourcePath, path.extname(sourcePath));
    const potentialPaths = [
      path.join(path.dirname(sourcePath), 'scene-manifest.json'),
      path.join('D:\\Video', `${filename}-gemini-analysis-pack`, '01-GUI-GEMINI', 'scene-manifest.json'),
      path.join('D:\\Video', `source-${filename.replace(/^source-/, '')}-gemini-analysis-pack`, '01-GUI-GEMINI', 'scene-manifest.json')
    ];
    for (const p of potentialPaths) {
      try {
        const loaded = JSON.parse(await fs.readFile(p, 'utf8'));
        if (loaded && Array.isArray(loaded.scenes) && loaded.scenes.length) {
          scenes = loaded.scenes;
          break;
        }
      } catch (_) {}
    }
  }

  if (outroCueStartSec !== null) {
    hasOutro = true;
    outroType = 'channel_recap_outro';
    // Find scene where outro starts or scene boundary immediately preceding it
    const sceneContainingOutro = scenes.find(s => Number(s.startSec) <= outroCueStartSec + 0.5 && Number(s.endSec) >= outroCueStartSec);

    if (sceneContainingOutro && Number(sceneContainingOutro.startSec) > inspectStartSec) {
      // Clean scene transition into outro graphics: cut right before this scene
      liveActionCutSec = Number((Number(sceneContainingOutro.startSec) - 0.2).toFixed(2));
      reason = `Detected outro text '${matchingPattern}' at ${outroCueStartSec.toFixed(1)}s; clean scene cut at ${sceneContainingOutro.startSec}s (capped to ${liveActionCutSec}s)`;
      confidence = 0.95;
    } else {
      const precedingScene = [...scenes]
        .reverse()
        .find(s => Number(s.endSec) <= outroCueStartSec + 0.5 && Number(s.endSec) >= inspectStartSec);
      if (precedingScene && Number(precedingScene.endSec) > 0) {
        liveActionCutSec = Number((Number(precedingScene.endSec) - 0.2).toFixed(2));
        reason = `Detected outro text '${matchingPattern}' at ${outroCueStartSec.toFixed(1)}s; preceding scene cut at ${precedingScene.endSec}s`;
        confidence = 0.90;
      } else {
        liveActionCutSec = Number(Math.max(inspectStartSec, outroCueStartSec - 1.0).toFixed(2));
        reason = `Detected outro text '${matchingPattern}' at ${outroCueStartSec.toFixed(1)}s; no scene boundary found`;
        confidence = 0.80;
      }
    }
  } else if (scenes.length > 0) {
    // Check for trailing scene that is explicitly marked as recap or outro in story model
    const trailingEvents = Array.isArray(model?.events)
      ? model.events.filter(e => Number(e.startSec) >= inspectStartSec)
      : [];
    const outroEvent = trailingEvents.find(e => /outro|recap|end\s*screen|credits|graphic/i.test(`${e.type} ${e.summary} ${e.label}`));
    if (outroEvent) {
      hasOutro = true;
      outroType = 'model_identified_outro';
      liveActionCutSec = Number(Number(outroEvent.startSec).toFixed(2));
      reason = `Source model marked event ${outroEvent.id} as outro at ${outroEvent.startSec}s`;
      confidence = 0.90;
    }
  }

  const result = {
    sourceDurationSec: dur,
    hasOutro,
    liveActionEndSec: liveActionCutSec,
    confidence,
    outroType,
    reason
  };

  // 3. Cache result if dir provided
  if (cacheFile) {
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(result, null, 2), 'utf8');
    } catch (_) {}
  }

  return result;
}

module.exports = {
  OUTRO_TEXT_PATTERNS,
  detectSourceEndingBoundary
};
