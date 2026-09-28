// AutoStory v3 — Phase 8: deterministic audio-role decision.
// "Narrator sets up the moment -> footage delivers the moment."
//
// This is the single place that decides, per beat, whether the tool speaks or
// stays silent and lets original bodycam audio carry the moment. It never
// depends on the model grading itself.
//
// Input per beat (all optional, safe defaults):
//   tension            0..1   editorial intensity of the moment
//   audioEvent         bool   a high-impact non-speech event lands in this beat
//                             (gunshot/crash/slam/scream/sudden silence)
//   highImpactRole     bool   role is confrontation/apprehension/reveal/reversal/pursuit
//   infoGapEmpty       bool   footage + original dialogue already say everything needed
//   needsSetupBefore   bool   the viewer needs a fact BEFORE the moment lands
//   audioDisposition   'CLEAN' | 'REPLACE' | 'VERIFY'  (from autoStoryAudioClassifier)
//   narrationEnabled   bool   user allows tool narration at all
//
// Output: { strategy, speak, reason } where strategy is one of AUDIO_STRATEGIES.

const { AUDIO_STRATEGIES } = require('./autoStoryV3Taxonomy');

const HIGH_TENSION = 0.7;

function decideAudioRole(beat = {}) {
  const tension = clamp01(beat.tension);
  const narrationEnabled = beat.narrationEnabled !== false;
  const disposition = beat.audioDisposition || 'VERIFY';
  const unclean = disposition === 'REPLACE'; // external narrator / mixed source speech

  // 0) Narration globally disabled -> footage only.
  if (!narrationEnabled) {
    return strat('original', false, 'narration disabled by user');
  }

  // 1) High-impact moment -> let the real audio breathe, narrator silent.
  // (Unless there's a required info gap, in which case we must narrate)
  const highImpact = beat.highImpactRole === true || beat.audioEvent === true || tension >= HIGH_TENSION;
  if (highImpact && !unclean && beat.infoGapEmpty === true) {
    return strat('original', false, `high-impact moment (tension ${tension.toFixed(2)}${beat.audioEvent ? ', audio event' : ''}); let footage deliver it`);
  }

  // 2) No information gap -> footage already tells it.
  if (beat.infoGapEmpty === true && !unclean) {
    return strat('original', false, 'no information gap; footage/dialogue already communicate it');
  }

  // 3) Missing info must be delivered BEFORE the moment -> setup then hand off.
  if (beat.needsSetupBefore === true && !unclean) {
    return strat('setup_then_original', true, 'context needed before the moment; narrator sets up, source ducks then returns');
  }

  // 4) Original audio unusable (host/mixed) -> narrator over, source muted.
  if (unclean) {
    return strat('narrator_over', true, 'source audio contaminated (external narrator/mixed); narrate over muted source');
  }

  // 5) Default -> narrator over ducked clean source.
  return strat('narrator_over', true, 'information gap present; narrate over ducked source');
}

function strat(strategy, speak, reason) {
  if (!AUDIO_STRATEGIES.includes(strategy)) throw new Error(`Unknown audio strategy ${strategy}`);
  return { strategy, speak, reason };
}
function clamp01(n) { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }

module.exports = { decideAudioRole, HIGH_TENSION };
