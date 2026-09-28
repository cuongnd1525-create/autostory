// AutoStory v3 shared taxonomy + alias maps.
// Central place so schema, casting, compiler-mapping and gates agree.

// Full v3 narrative-role vocabulary (Phase 5).
const NARRATIVE_ROLES = [
  'teaser_conflict', 'escalation', 'micro_payoff', 'rewind_context', 'progressive_evidence',
  'confrontation', 'contradiction', 'delayed_payoff', 'cliffhanger',
  'cold_open', 'cold_open_hook', 'hook', 'setup', 'context', 'crisis_context',
  'complication', 'reveal', 'evidence_reveal',
  'reversal', 'pursuit', 'apprehension', 'climax', 'payoff',
  'resolution', 'aftermath', 'button'
];

// v2 renderer/compiler storyRole enum (must not change — renderer consumes it).
const V2_STORY_ROLES = ['hook', 'context', 'escalation', 'turning_point', 'climax', 'payoff'];

// Map each rich v3 role down to the v2 storyRole the existing compiler/renderer understand.
const ROLE_TO_V2 = {
  teaser_conflict: 'hook',
  micro_payoff: 'hook',
  rewind_context: 'context',
  progressive_evidence: 'context',
  cold_open: 'hook',
  cold_open_hook: 'hook',
  hook: 'hook',
  setup: 'context',
  context: 'context',
  crisis_context: 'context',
  escalation: 'escalation',
  complication: 'escalation',
  contradiction: 'escalation',
  reveal: 'turning_point',
  evidence_reveal: 'turning_point',
  reversal: 'turning_point',
  confrontation: 'escalation',
  pursuit: 'escalation',
  apprehension: 'climax',
  climax: 'climax',
  payoff: 'payoff',
  delayed_payoff: 'payoff',
  cliffhanger: 'payoff',
  resolution: 'payoff',
  aftermath: 'payoff',
  button: 'payoff'
};

// Narrator functions (Phase 10). A narration line MUST carry one of these.
const NARRATOR_FUNCTIONS = [
  'CONTEXT', 'BRIDGE', 'FORESHADOW', 'OPEN_LOOP', 'ESCALATION', 'CLARIFICATION',
  'TIME_JUMP', 'LOCATION_CHANGE', 'IDENTITY', 'CONSEQUENCE', 'RECAP', 'PAYOFF_SETUP'
];

// Information classes (Phase 6).
const INFORMATION_CLASSES = ['immediate', 'deferred', 'reveal', 'payoff', 'omit'];

// Story Archetypes (V4 Bodycam / True-Crime)
const STORY_ARCHETYPES = [
  'MYSTERY_DISCOVERY', 'ESCALATION', 'DECEPTION_CONTRADICTION', 'RESCUE',
  'PURSUIT', 'EVIDENCE_BUILD', 'INTERROGATION', 'CONSEQUENCE'
];

// Causal Graph Relations (V4 Causal-Retention Graph)
const CAUSAL_RELATIONS = [
  'CAUSES', 'REVEALS', 'CONTRADICTS', 'CONFIRMS', 'ESCALATES',
  'RESPONDS_TO', 'RESULTS_IN', 'EXPLAINS', 'PAYS_OFF',
  'OPENS_QUESTION', 'RESOLVES_QUESTION'
];

// Evidence Types for Evidence Ladder (V4)
const EVIDENCE_TYPES = [
  'statement', 'admission', 'contradiction', 'physical_marks',
  'weapon', 'document', 'officer_observation', 'digital', 'none'
];

// Audio strategies (Phase 8). These are v3-level; they map to the renderer's
// audio_mode ('original_audio' | 'voiceover_only' | 'voiceover_with_ambient').
const AUDIO_STRATEGIES = [
  'original', 'setup_then_original', 'narrator_over', 'original_then_narrator', 'silence', 'music_only'
];

// Epistemic status (Phase 1.4 / Rule 8).
const EPISTEMIC = [
  'known_fact', 'police_allegation', 'officer_claim', 'suspect_statement',
  'witness_statement', 'inference', 'unknown'
];
// Anything not a plain known_fact must be hedged when narrated.
const NON_FACT_EPISTEMIC = new Set(EPISTEMIC.filter(e => e !== 'known_fact'));

function toV2Role(role) {
  return ROLE_TO_V2[role] || (V2_STORY_ROLES.includes(role) ? role : 'context');
}

// Map a v3 audio strategy to the renderer audio_mode + whether source ducks or mutes.
// unclean=true means original source carries an external narrator / mixed voices and
// must be muted rather than ducked.
function strategyToAudioMode(strategy, { unclean = false } = {}) {
  switch (strategy) {
    case 'original':
      return { audioMode: 'original_audio', audioIntent: 'original', duck: false, mute: false };
    case 'silence':
    case 'music_only':
      // No usable source speech to preserve; treated as original at low level by renderer.
      return { audioMode: 'original_audio', audioIntent: 'original', duck: false, mute: false };
    case 'narrator_over':
    case 'setup_then_original':
    case 'original_then_narrator':
      if (unclean) return { audioMode: 'voiceover_only', audioIntent: 'narration', duck: false, mute: true };
      return { audioMode: 'voiceover_with_ambient', audioIntent: 'narration', duck: true, mute: false };
    default:
      return { audioMode: 'voiceover_only', audioIntent: 'narration', duck: false, mute: true };
  }
}

module.exports = {
  NARRATIVE_ROLES, V2_STORY_ROLES, ROLE_TO_V2, NARRATOR_FUNCTIONS, INFORMATION_CLASSES,
  STORY_ARCHETYPES, CAUSAL_RELATIONS, EVIDENCE_TYPES,
  AUDIO_STRATEGIES, EPISTEMIC, NON_FACT_EPISTEMIC, toV2Role, strategyToAudioMode
};
