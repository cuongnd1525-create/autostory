// AutoStory v3 — Phases 17/18: ONE authoritative v3 contract. Shared preamble
// (grounding + anti-fabrication + epistemic rules) defined once, then focused
// response schemas per pass. Mirrors the object()/choice() style of
// autoStorySourceContracts so the same schema-boundary validator applies.

const { base } = require('./autoStorySourceContracts');
const { NARRATIVE_ROLES, NARRATOR_FUNCTIONS, INFORMATION_CLASSES, EPISTEMIC } = require('./autoStoryV3Taxonomy');

const object = properties => ({ type: 'object', required: Object.keys(properties), properties, additionalProperties: false });
const text = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const list = (items, maxItems = 40) => ({ type: 'array', items, maxItems });
const choice = (...values) => ({ type: 'string', enum: values });

// Shared v3 preamble: reuse the elite-editor base, add the epistemic contract.
const preamble = `${base}

EPISTEMIC CONTRACT (MANDATORY for true-crime / bodycam):
- Tag every quote with one status: ${EPISTEMIC.join(' | ')}.
- A suspect statement, police allegation, officer claim, witness statement or inference is NEVER an established fact.
- Downstream narration may only state as fact what is tagged known_fact. Everything else must be attributed or hedged.
- Setup-now / payoff-later (foreshadowing an event that a later beat delivers) is allowed and is NOT fabrication, as long as the fact is real and source-referenced.`;

// ---- Pass 0: Source Story Model ----
// Bounded to keep the whole-source JSON well under the model output limit
// (previous 200-quote / 120-event caps let a dialogue-heavy source explode into
// near-transcript reconstruction and hit MAX_TOKENS). Compact objects only.
const audioTypeEnum = choice('participant_speech', 'officer_speech', 'external_narrator', 'mixed', 'uncertain', 'scene_sound');
const person = object({ id: text, label: text, role: text, firstSeenSec: number });
const modelEvent = object({
  id: text, startSec: number, endSec: number, type: text, summary: text, location: text,
  peopleIds: list(text, 8), tension: number, visualQuality: number, novelty: number,
  dialogueImpact: number, isReveal: boolean, audioType: audioTypeEnum, audioConfidence: number
});
// Compact quote: id, event ref, speaker, timing, verbatim text, epistemic, editorialValue.
// No speakerRole / no event-summary duplication; editorialValue drives selection.
const modelQuote = object({
  id: text, eventId: text, speaker: text, startSec: number, endSec: number, text,
  epistemic: choice(...EPISTEMIC), editorialValue: number
});
const sourceModel = object({
  accessGranted: boolean, people: list(person, 24), events: list(modelEvent, 40), quotes: list(modelQuote, 60)
});
// Even tighter schema used for MAX_TOKENS recovery (compact whole-source).
const compactSourceModel = object({
  accessGranted: boolean, people: list(person, 16), events: list(modelEvent, 25), quotes: list(modelQuote, 40)
});
// SMALL per-WINDOW schema for chunk-first extraction: one time window contributes
// only a few events/quotes; the canonical merged model is still globally capped.
const chunkSourceModel = object({
  accessGranted: boolean, people: list(person, 8), events: list(modelEvent, 12), quotes: list(modelQuote, 16)
});

// ---- Pass 1: Gemini Editorial Director (Exact EDL Output) ----
const objectFlexible = (requiredProps, optionalProps = {}) => ({
  type: 'object',
  required: Object.keys(requiredProps),
  properties: { ...requiredProps, ...optionalProps },
  additionalProperties: true
});

const infoBudget = object({ immediate: list(text, 20), deferred: list(text, 20), reveals: list(text, 20), omit: list(text, 20) });
const openLoop = object({ id: text, question: text, opensAtBeat: text, closesAtBeat: text });

// V4 Story Scope Model
const storyScope = objectFlexible({
  storyArchetype: text,
  centralIncident: text,
  centralViewerQuestion: text,
  episodeStartSec: number,
  episodeEndSec: number,
  primaryPeople: list(text, 10),
  primaryConflict: text,
  initialState: text,
  targetEndState: text,
  mainOpenLoop: text,
  supportingOpenLoops: list(text, 10),
  coreEvidenceChain: list(text, 10),
  criticalEscalations: list(text, 10),
  possiblePayoffs: list(text, 10),
  possibleCliffhangers: list(text, 10)
});

// V4 Causal-Retention Edge
const causalEdge = objectFlexible({
  fromEventId: text,
  toEventId: text,
  relation: choice(...(require('./autoStoryV3Taxonomy').CAUSAL_RELATIONS || ['CAUSES', 'REVEALS', 'CONTRADICTS', 'ESCALATES'])),
  rationale: text
});

// V4 Energy Curve
const energyCurve = objectFlexible({
  overallTrajectory: text,
  peaks: list(text, 10)
});

const designBeat = objectFlexible({
  beatId: text,
  beatIndex: number,
  sourceStartSec: number,
  sourceEndSec: number,
  chronologyMode: choice('teaser', 'chronological', 'rewind', 'callback'),
  narrativeRole: choice(...NARRATIVE_ROLES),
  viewerQuestion: text,
  informationRevealed: text,
  openLoop: text,
  payoffTiming: choice('immediate', 'delayed', 'part_2', 'none'),
  audioMode: choice('original_audio', 'voiceover_with_ambient', 'voiceover_only'),
  narrationPurpose: choice('NONE', 'SETUP', 'CONTEXT', 'EVIDENCE_SUMMARY', 'CLIFFHANGER', 'BRIDGE'),
  wantsNarration: boolean,
  narratorFunction: choice(...NARRATOR_FUNCTIONS, 'NONE'),
  sourceEventId: text,
  tensionBefore: number,
  tensionAfter: number,
  // Micro-beat retention fields
  retentionReason: choice('new_fact', 'contradiction', 'reaction', 'escalation', 'visual_reveal', 'strong_quote', 'new_question', 'partial_payoff'),
  newInformation: text,
  viewerStateBefore: text,
  viewerStateAfter: text,
  tensionDelta: number,
  openLoopDelta: text,
  // Cliffhanger signals
  cliffhangerQuestion: text,
  cliffhangerNewInformation: text,
  cliffhangerExpectedNextPayoff: text
}, {
  // V4 Retention Blueprint & Causal Graph extensions
  viewerQuestionBefore: text,
  openLoopCreated: text,
  openLoopAdvanced: text,
  openLoopResolved: text,
  evidenceDelta: text,
  stakesDelta: text,
  causalParentBeat: text,
  causalRelation: text,
  whyThisBeatNow: text,
  contextDebtCreated: text,
  contextDebtResolved: text,
  evidenceType: choice(...(require('./autoStoryV3Taxonomy').EVIDENCE_TYPES || ['statement', 'physical_marks', 'none'])),
  evidenceStrengthBefore: number,
  evidenceStrengthAfter: number,
  energyBefore: number,
  energyAfter: number,
  reasonForEnergyChange: text,
  jumpSeconds: number,
  jumpReason: text,
  causalLink: text,
  bridgeRequired: boolean,
  bridgeTextOrAudio: text,
  teaserInformationUsed: text,
  teaserPayoffCompletion: text,
  postTeaserNovelty: text,
  cliffhangerSpecificFact: text,
  viewerBeliefBefore: text,
  viewerBeliefAfter: text,
  informationDelta: text,
  isForwardConsequence: boolean,
  newCaseState: text,
  expectedNextConsequence: text,
  whyCutHere: text,
  consequenceMagnitude: choice('charges', 'arrest', 'violence', 'evidence_found', 'confession', 'none'),
  unresolvedConsequence: text
});

const spine = objectFlexible({
  centralViewerQuestion: text, hookPromise: text, hookStrategy: text, strongEnough: boolean, reason: text,
  informationBudget: infoBudget, openLoops: list(openLoop, 12), beats: list(designBeat, 40)
}, {
  storyScope: storyScope,
  causalRetentionGraph: list(causalEdge, 30),
  energyCurve: energyCurve
});
const storyDesign = object({ accessGranted: boolean, spines: list(spine, 5) });

// ---- Pass 3: Narration (only for requested narrator beats) ----
const narrationLine = object({
  beatId: text, voiceoverText: text, previewVi: text, narratorFunction: choice(...NARRATOR_FUNCTIONS),
  newInformation: list(text, 10), newInformationRefs: list(text, 10), emotionTag: text
});
const narration = object({ accessGranted: boolean, narrations: list(narrationLine, 40) });

const schemas = { sourceModel, compactSourceModel, chunkSourceModel, storyDesign, narration };

// engine.ask() already prepends the elite-editor base; add only the epistemic
// contract so it is not duplicated.
const EPI = `EPISTEMIC CONTRACT: tag quotes as ${EPISTEMIC.join(' | ')}. A suspect statement, allegation, officer claim, witness statement or inference is NEVER an established fact; downstream narration must attribute or hedge anything not known_fact. Foreshadowing (setup now, payoff later) is allowed and is not fabrication when the fact is real and source-referenced.`;

const rawInstructions = {
  sourceModel: `PASS 0 — SOURCE STORY MODEL. Watch the ENTIRE attached low-fps source once and output a COMPACT structured model. STRICT OUTPUT BUDGET (this is an index, not a transcript):
- events: ONLY meaningful STATE-CHANGING moments (aim <= 25, hard max 40), spread across the WHOLE source (do not concentrate on one exchange). Each: start/end SECONDS, short type, a summary of AT MOST 12 words, a short location (<= 4 words, where it happens), peopleIds, 0-1 tension/visualQuality/novelty/dialogueImpact, isReveal, audio classification.
- quotes: ONLY editorially useful lines — confrontations, admissions, denials, key commands, reveals, strong emotion (aim <= 40, hard max 60, and AT MOST 3 per event). Do NOT reconstruct the transcript. Each: id, eventId, speaker, start/end SECONDS, the verbatim line (trimmed, one sentence), epistemic tag, and editorialValue 0-1 (how much a viewer needs this line).
- people: only named/role-bearing participants (<= 16).
Do NOT repeat an event's summary inside its quotes. Do NOT include narration, clips, or an EDL. Reference by ids/timestamps, never by pasting prose blocks. Tension/editorialValue: use the full 0-1 range honestly. Confirm accessGranted only after actually watching the video.`,
  sourceModelCompact: `PASS 0 (COMPACT RECOVERY) — the previous attempt exceeded the output limit. Produce a MUCH SMALLER Source Story Model: at most 25 events and at most 40 quotes total (<= 2 quotes per event), keeping ONLY the highest-value state-changing moments and the single most important line per key event. Summaries <= 10 words; verbatim quote lines trimmed to one short sentence. Same fields and epistemic/editorialValue rules. Never output a transcript. This pass IS multimodal: set accessGranted=true only after actually watching the attached source; if you cannot inspect it, return accessGranted=false.`,
  sourceModelChunk: `PASS 0 (CHUNK) — you are given ONE time window of the source, with the VIDEO for that window ATTACHED. Extract ONLY the state-changing events and the few editorially useful quotes INSIDE this window. Respect the per-window ceilings in the input: at most input.maxEvents events and input.maxQuotes quotes (hard caps 12 events / 16 quotes). Keep only the highest-value moments; do NOT pad to the ceiling. Use ABSOLUTE source SECONDS. Same compact fields (short summary <=12 words, short location, peopleIds, tension/visualQuality/novelty/dialogueImpact, isReveal, audio classification), epistemic and editorialValue rules. Never output a transcript. This pass IS multimodal: you MUST set accessGranted=true after actually watching the attached window video; if (and only if) you truly cannot inspect the attached media, return accessGranted=false. A window with no state-changing moment is valid — return accessGranted=true with an empty events array rather than inventing content.`,
  storyDesign: `PASS 1 — GEMINI EDITORIAL DIRECTOR (BODYCAM / TRUE-CRIME VIRAL STORY ENGINE V4).
You are the EXECUTIVE EDITORIAL DIRECTOR authoring a high-retention viral short-form true-crime video (target duration 65-85 seconds).
You own the exact EDL: exact timestamps (sourceStartSec, sourceEndSec), beat order, chronologyMode, audioMode, and narrativeRole.
Downstream services are pure guardrails — they will NOT rewrite or heuristically modify your timeline.

CORE ARCHITECTURAL INVARIANTS:
EVERY BEAT MUST BE BOTH: (1) NOVEL ENOUGH TO JUSTIFY SCREEN TIME AND (2) CAUSALLY COHERENT WITH THE ACTIVE STORY ARC.

1. DEFINE ACTIVE STORY SCOPE (storyScope) BEFORE TIMESTAMPS:
   - storyArchetype: Infer the true incident archetype (e.g. ESCALATION, DECEPTION_CONTRADICTION, RESCUE, PURSUIT, EVIDENCE_BUILD, INTERROGATION, CONSEQUENCE, MYSTERY_DISCOVERY). Do not force every incident into the same formula!
   - centralIncident & centralViewerQuestion: The core question driving viewer retention (e.g. 'Why did this routine stop turn violent?' or 'When will the suspect\\'s story collapse?').
   - episodeStartSec & episodeEndSec: Define the primary causal episode in source time. Events outside this range require a DIRECT causal relationship.
   - primaryPeople, primaryConflict, initialState, targetEndState, mainOpenLoop, coreEvidenceChain, criticalEscalations, possiblePayoffs, possibleCliffhangers.

2. BUILD A CAUSAL-RETENTION GRAPH (causalRetentionGraph):
   - Link events with causal relations: CAUSES, REVEALS, CONTRADICTS, CONFIRMS, ESCALATES, RESPONDS_TO, RESULTS_IN, EXPLAINS, PAYS_OFF, OPENS_QUESTION, RESOLVES_QUESTION.
   - For every beat in the EDL, specify causalParentBeat, causalRelation, and whyThisBeatNow. Never jump to an unrelated moment merely because it has high tension or looks visually different.

3. RETENTION BLUEPRINT & PULSE (EVERY 3–8 SECONDS):
   - Every micro-beat must produce a retention pulse answering: WHAT DOES THE VIEWER UNDERSTAND NOW THAT THEY DID NOT UNDERSTAND 5 SECONDS AGO?
   - Pulse types: surprising action, new evidence, contradiction, strong quote, emotional reaction, officer realization, reveal, escalation, new question, partial payoff, consequence becoming imminent.
   - Provide for EVERY beat: viewerStateBefore, viewerQuestionBefore, newInformation, viewerStateAfter, tensionDelta, stakesDelta, evidenceDelta, retentionReason.

4. HOOK = OPEN QUESTION (NOT MAXIMUM CHAOS):
   - Maximize Clarity × Curiosity × Stakes × Unresolved Consequence. Withhold enough that the viewer MUST continue.
   - For incident response / mystery / rescue stories (e.g. domestic disturbance, barricade, weapon call), ALWAYS START with a compact 3-beat teaser (7-10s total):
     * Beat 0: conflict introduction (2.5-3.0s)
     * Beat 1: escalation / screams / rush (2.5-3.0s)
     * Beat 2: visual flash / partial reveal (2.5-3.0s) -> HARD CUT TO REWIND BEFORE RESOLUTION!
     * Beat 3: chronologyMode='rewind' (police arrival / 911 dispatch, 4-6s)
     * Beat 4+: chronologyMode='chronological'
   - TEASER BORROW BUDGET: Ranges shown in the teaser MUST NOT be replayed in post-rewind story (overlap <= 3.0s, target 0s). The post-rewind story must feature unshown footage.

5. STRICT FORWARD SOURCE CHRONOLOGY & CONTEXT DEBT:
   - Bodycam time strictly moves FORWARD. Once chronological story begins (after rewind), every beat MUST have sourceStartSec[i] >= sourceEndSec[i-1] - 0.5s!
   - NEVER jump backwards in source time in 'chronological' mode (e.g. jumping from 58s back to 10s or 62s back to 32s is strictly forbidden). Backward jumps are only allowed in 'rewind' or 'callback' modes with explicit narrative anchors.
   - For forward jumps (> 15s in source time), provide: jumpSeconds, jumpReason, causalLink, bridgeRequired, bridgeTextOrAudio.

6. EVIDENCE & ESCALATION LADDER (SEMANTIC COMPRESSION):
   - Progress from suspicion/claim -> contradiction -> witness -> physical marks/evidence -> admission -> consequence.
   - Do NOT present the strongest evidence too early unless intentionally borrowed for the teaser.
   - SEMANTIC COMPRESSION: NEVER string together consecutive beats repeating the same defense/excuses/viewer belief.
   - For every beat, output: viewerBeliefBefore, viewerBeliefAfter, informationDelta.
   - If multiple candidate beats result in substantially the same viewerBeliefAfter, KEEP ONLY THE STRONGEST 4-6 second MOMENT and CUT THE REST.
   - Do not spend >8-10 seconds proving the same story state.
   - Max run in any single visual scene is 12.0s! Alternate perspectives between suspect, officer physical action, evidence inspection, and victim testimony.

7. ORIGINAL AUDIO AS EVIDENCE:
   - Prioritize original audio for confrontations, admissions, contradictions, emotional reactions, commands, threats, victim statements, and officer realizations.
   - Narration is for minimal context, bridging time jumps, explaining invisible facts, or connecting causal events.

8. ENDING / CLIFFHANGER LOGIC (FORWARD CONSEQUENCE):
   - Choose between PAYOFF ENDING and OPEN CONSEQUENCE CLIFFHANGER based on the archetype.
   - The final beat MUST move the story FORWARD. A late witness statement that merely explains past events is BACKSTORY. Do not label backstory as a cliffhanger.
   - FORWARD CONSEQUENCE REVEAL: A specific new fact that materially changes what is likely to happen next, making a consequence feel imminent.
   - Examples: victim reveals unknown assault, officer discovers weapon, suspect makes incriminating admission, officer announces detention.
   - Do NOT end merely on a statement that reconstructs the past. Move such context earlier.
   - For serialized Part 1, the FINAL BEAT MUST be a strong forward consequence cliffhanger: SPECIFIC NEW FACT -> IMPORTANT CONSEQUENCE IS NOW LIKELY -> CONSEQUENCE NOT SHOWN YET.
   - The final beat MUST have:
     * isForwardConsequence: boolean (true if it moves the present story forward)
     * newCaseState: how the case changed right now
     * expectedNextConsequence: what will likely happen
     * whyCutHere: justification for ending exactly here
     - Plus the existing cliffhanger fields:
     * narrativeRole: 'cliffhanger' (or 'open_loop_payoff' if resolved)
     * payoffTiming: 'part_2' (for serialized Part 1)
     * cliffhangerQuestion: specific open question for Part 2 (>= 8 chars)
     * cliffhangerNewInformation: specific concrete revelation/claim just made (>= 8 chars)
     * cliffhangerExpectedNextPayoff: what Part 2 will reveal (>= 6 chars)
     * cliffhangerSpecificFact: the concrete new fact/discovery just revealed (e.g. violent strike, contraband discovered, confession made)
     * consequenceMagnitude: 'charges' | 'arrest' | 'violence' | 'evidence_found' | 'confession'
     * unresolvedConsequence: what pending consequence hangs in the balance
   - ANTI-SPOILER: Never reveal the final patrol car transport or booking outcome.

9. TOTAL DURATION BUDGET (TARGET: 74s–82s ACROSS 13–16 MICRO-BEATS):
   - EVERY SINGLE BEAT MUST BE A MICRO-BEAT BETWEEN 3.5s AND 6.5s (HARD CEILING 7.0s per beat).
   - NEVER copy an entire 15s+ event range verbatim into a beat. If an event in the model spans 15s to 55s, select ONLY a punchy 4-6s sub-window!
   - OUTPUT BETWEEN 13 AND 16 MICRO-BEATS TOTAL. Their durations MUST sum up to between 70s and 84s (target 76s). Under-duration (< 65s) or over-duration (> 90s) will be rejected!
   - Set accessGranted=true after reviewing the model.`,
  narration: `PASS 3 — NARRATION (information gap only). Write narration ONLY for the requested beats. Each line must serve its narratorFunction and ADD information the footage and original dialogue cannot convey — never describe the obvious, never repeat the dialogue, never spoil a later reveal. State non-fact sources (suspect/allegation/claim/inference) with attribution, never as fact. Style: punchy short sentences (<= 10 words), active present tense, grounded dry irony (JCS/EWU). Return newInformationRefs for every factual claim and a natural Vietnamese previewVi. Respect each beat's safeWords ceiling.
LEGAL TRANSLATION INTEGRITY: In criminal bodycam/police contexts, translate legal terms accurately into Vietnamese:
- 'battery' = 'tội hành hung' / 'bạo hành thể xác' (NEVER 'cục pin' or 'dùng pin').
- 'primary aggressor' = 'kẻ khơi mào bạo lực chính' / 'đối tượng tấn công chính'.
- 'keep her story straight' = 'giữ lời khai nhất quán'.
- 'deadly weapon' = 'hung khí nguy hiểm' (only if actual weapon; do not exaggerate butter knives).`
};

const instructions = Object.fromEntries(Object.entries(rawInstructions).map(([k, v]) => [k, `${EPI}\n${v}`]));

module.exports = { preamble, schemas, instructions, EPI };
