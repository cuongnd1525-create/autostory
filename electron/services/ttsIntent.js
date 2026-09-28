// AutoStory v3 — Phase 12: carry storytelling intent (emotionTag + prosody)
// from the script all the way to each TTS engine, adapting to what each engine
// actually supports. Pure functions so they are unit-testable and cheap.
//
// emotionTag vocabulary (normalized): NEUTRAL, TENSE, URGENT, GRAVE, WHISPER,
// SHOCK, IRONIC, SAD, HOPEFUL. Free text is lower-cased and mapped.

const EMOTION_ALIASES = {
  neutral: 'NEUTRAL', calm: 'NEUTRAL', normal: 'NEUTRAL',
  tense: 'TENSE', suspense: 'TENSE', suspenseful: 'TENSE', ominous: 'TENSE',
  urgent: 'URGENT', fast: 'URGENT', panic: 'URGENT',
  grave: 'GRAVE', serious: 'GRAVE', somber: 'GRAVE',
  whisper: 'WHISPER', quiet: 'WHISPER', hushed: 'WHISPER',
  shock: 'SHOCK', shocking: 'SHOCK', wtf: 'SHOCK',
  ironic: 'IRONIC', dry: 'IRONIC', sarcastic: 'IRONIC',
  sad: 'SAD', tragic: 'SAD',
  hopeful: 'HOPEFUL'
};

// Per-emotion prosody deltas (relative). rateDelta/pitchDelta are fractional
// (0.05 = +5%). Chosen conservatively so no engine goes robotic.
const EMOTION_PROSODY = {
  NEUTRAL: { rateDelta: 0, pitchDelta: 0, volumeDelta: 0 },
  TENSE:   { rateDelta: -0.03, pitchDelta: -0.02, volumeDelta: 0 },
  URGENT:  { rateDelta: 0.08, pitchDelta: 0.04, volumeDelta: 0.06 },
  GRAVE:   { rateDelta: -0.06, pitchDelta: -0.05, volumeDelta: 0 },
  WHISPER: { rateDelta: -0.05, pitchDelta: -0.03, volumeDelta: -0.12 },
  SHOCK:   { rateDelta: 0.05, pitchDelta: 0.06, volumeDelta: 0.06 },
  IRONIC:  { rateDelta: -0.02, pitchDelta: 0.01, volumeDelta: 0 },
  SAD:     { rateDelta: -0.07, pitchDelta: -0.04, volumeDelta: -0.04 },
  HOPEFUL: { rateDelta: 0.02, pitchDelta: 0.03, volumeDelta: 0 }
};

// ElevenLabs performanceMode presets that already exist in elevenLabsService.
const ELEVEN_PERFORMANCE = {
  NEUTRAL: 'story', TENSE: 'cliffhanger', URGENT: 'panic', GRAVE: 'story',
  WHISPER: 'story', SHOCK: 'panic', IRONIC: 'story', SAD: 'story', HOPEFUL: 'story'
};

function normalizeEmotion(tag) {
  if (!tag) return 'NEUTRAL';
  const up = String(tag).trim().toUpperCase();
  if (EMOTION_PROSODY[up]) return up;
  return EMOTION_ALIASES[String(tag).trim().toLowerCase()] || 'NEUTRAL';
}

// Resolve a segment's intent, merging explicit prosody over the emotion default.
function resolveTtsIntent(segment = {}) {
  const emotionTag = normalizeEmotion(segment.emotionTag || segment.emotion);
  const base = EMOTION_PROSODY[emotionTag] || EMOTION_PROSODY.NEUTRAL;
  const p = segment.prosody || {};
  const prosody = {
    rateDelta: num(p.rateDelta, base.rateDelta),
    pitchDelta: num(p.pitchDelta, base.pitchDelta),
    volumeDelta: num(p.volumeDelta, base.volumeDelta ?? 0),
    pauseBeforeSec: Math.max(0, num(p.pauseBeforeSec, 0)),
    pauseAfterSec: Math.max(0, num(p.pauseAfterSec, 0)),
    emphasisWordIndices: Array.isArray(p.emphasisWordIndices) ? p.emphasisWordIndices.filter(Number.isFinite) : []
  };
  return { emotionTag, prosody };
}

// Translate an intent into concrete params for one engine. `base` carries the
// engine's baseline (e.g. edge base rate percent) so we only apply deltas.
function applyToEngine(engineName, intent, base = {}) {
  const { emotionTag, prosody } = intent;
  switch (engineName) {
    case 'edge_neural':
    case 'edge': {
      // Edge accepts +/-N% strings for rate/volume and +Nhz/-Nhz for pitch.
      const baseRatePct = num(base.ratePct, 0);
      const ratePct = clampInt(baseRatePct + Math.round(prosody.rateDelta * 100), -40, 40);
      const volPct = clampInt(Math.round(prosody.volumeDelta * 100), -40, 40);
      const pitchHz = clampInt(Math.round(prosody.pitchDelta * 200), -60, 60); // ~200hz span
      return {
        rate: `${ratePct >= 0 ? '+' : ''}${ratePct}%`,
        volume: `${volPct >= 0 ? '+' : ''}${volPct}%`,
        pitch: `${pitchHz >= 0 ? '+' : ''}${pitchHz}Hz`,
        pauseBeforeSec: prosody.pauseBeforeSec,
        pauseAfterSec: prosody.pauseAfterSec
      };
    }
    case 'elevenlabs':
      return {
        performanceMode: ELEVEN_PERFORMANCE[emotionTag] || 'story',
        // style pushes expressiveness up for high-arousal tags
        styleBoost: ['URGENT', 'SHOCK', 'TENSE'].includes(emotionTag) ? 0.25 : 0
      };
    case 'kokoro': {
      const speed = clampFloat(1 + prosody.rateDelta, 0.7, 1.3);
      return { speed, pauseBeforeSec: prosody.pauseBeforeSec, pauseAfterSec: prosody.pauseAfterSec };
    }
    case 'omnivoice': {
      const bits = [];
      if (emotionTag === 'WHISPER') bits.push('whisper');
      if (emotionTag === 'URGENT' || emotionTag === 'SHOCK') bits.push('high energy, faster');
      if (emotionTag === 'GRAVE' || emotionTag === 'SAD') bits.push('low pitch, slow');
      if (emotionTag === 'TENSE') bits.push('low, controlled');
      return { instructSuffix: bits.length ? `, ${bits.join(', ')}` : '', speed: clampFloat(1 + prosody.rateDelta, 0.7, 1.3) };
    }
    case 'windows_local':
    default: {
      // Only integer rate available.
      return { rate: clampInt(Math.round(prosody.rateDelta * 10), -10, 10) };
    }
  }
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }
function clampFloat(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

module.exports = { resolveTtsIntent, applyToEngine, normalizeEmotion, EMOTION_PROSODY, ELEVEN_PERFORMANCE };
