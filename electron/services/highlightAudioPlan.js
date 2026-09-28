// AutoStory v3 — Phase 13: duck, don't mute.
//
// Decides, per rendered segment, whether original source audio is kept and
// DUCKED under narration or hard-muted. Muting is the exception, not the default.
// Pure function so the renderer can call it and tests can assert it.
//
// segment: { audio_mode, audioStrategy?, sourceNarratorDetected?, audioUnclean? }
// project: { narrationDuckDefault?, mixer? }
//
// Returns { audioMode, sourceVolume(0..1), duck, mute, reason }.

const DEFAULT_DUCK_SOURCE_VOLUME = 0.28; // pre-sidechain source gain when ducking

function resolveSegmentAudio(segment = {}, project = {}) {
  const mode = segment.audio_mode || segment.audioMode;

  // Original-audio segments: full source, no narration.
  if (mode === 'original_audio' || !mode) {
    return { audioMode: 'original_audio', sourceVolume: 1, duck: false, mute: false, reason: 'original audio beat' };
  }

  const duckEnabled = project.narrationDuckDefault === true;
  const unclean = segment.audioUnclean === true
    || segment.sourceNarratorDetected === true
    || segment.audioStrategy === 'narrator_over_unclean';

  // Unclean source (external host / mixed voices) -> must mute even in v3.
  if (unclean) {
    return { audioMode: 'voiceover_only', sourceVolume: 0, duck: false, mute: true,
      reason: 'source contaminated (external narrator/mixed); mute and narrate' };
  }

  // v3 default: duck the real bodycam bed under narration.
  if (duckEnabled || mode === 'voiceover_with_ambient') {
    const configured = project.mixer && Number.isFinite(project.mixer.sourceVolume)
      ? Math.max(0, Math.min(1, project.mixer.sourceVolume / 100))
      : DEFAULT_DUCK_SOURCE_VOLUME;
    const sourceVolume = configured > 0 ? configured : DEFAULT_DUCK_SOURCE_VOLUME;
    return { audioMode: 'voiceover_with_ambient', sourceVolume, duck: true, mute: false,
      reason: 'narration over ducked source (sidechain)' };
  }

  // Legacy v2 behavior preserved when duck default is off.
  return { audioMode: 'voiceover_only', sourceVolume: 0, duck: false, mute: true, reason: 'legacy voiceover_only (mute)' };
}

module.exports = { resolveSegmentAudio, DEFAULT_DUCK_SOURCE_VOLUME };
