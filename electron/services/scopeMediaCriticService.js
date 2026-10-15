// AutoStory — SCOPE-AWARE MEDIA CRITIC.
//
// Watches the ACTUAL rendered MP4 and reports whether the intended Story Scope
// survived the render. It identifies problems with output-time regions. It does
// NOT own the timeline and does not compute a quality score: the Editorial
// Director repairs whatever the critic finds.
//
// JS here only (a) validates the critic's JSON, (b) maps output-time regions to
// beat ids from the compiled timeline, and (c) derives compliance from the
// critic's own findings (no blocking issue + scope/ending/footage verdicts true).

const ISSUE_TYPES = [
  'causal_break',              // the viewer cannot tell why this follows the previous moment
  'low_value_stretch',         // a stretch that adds little to the central question
  'repeated_dialogue_function',// the same argument/claim restated without changing anything
  'out_of_scope_branch',       // material from a different branch of the incident
  'hook_spends_payoff',        // the cold open gives away what the story should withhold
  'ending_not_consequence',    // the ending is not a consequence of the central conflict
  'hook_unfulfilled',          // the actual edit never delivers what the hook promised
  'ending_without_payoff',     // final seconds show continuing procedure, not a consequence
  'procedural_repetition',     // repetitive searching/restated questions without new story progress
  'unusable_footage',          // black / blocked / unreadable picture where it matters
  'comprehension_gap',         // the viewer lacks a fact needed to follow the story
  // Delivery (who owns the audio) — judged by watching, never by duration rules.
  'unbridged_perspective_shift',   // we switch to another person's account and nobody tells us whose
  'unexplained_time_jump',         // we jump in time/place and the viewer is not told why we are here
  'raw_explanation_overlong',      // raw audio spends a long stretch explaining what a narrator could compress
  'narration_underused',           // the viewer is lost where one narrated passage would orient them
  'narration_overwrites_evidence', // narration talks over / paraphrases a moment that should speak for itself
  'weak_narrator_to_raw_handoff',  // the narrator does not set up why the next real moment matters
  'weak_raw_to_narrator_handoff',  // coming out of a real moment, the narrator does not connect it forward
  'opening_lacks_curiosity',       // the first seconds give a cold viewer no reason to keep watching
  'narration_robotic',             // audible TTS rhythm/inflection makes narration unengaging
  'narration_fragmented',          // isolated unnatural phrases or rushed short blocks
  'narration_unnecessary',         // narration repeats visible action or already-understood dialogue
  'narration_handoff_confusing',   // words do not lead naturally into/out of real dialogue
  'narration_masks_dialogue',      // source speech and voiceover compete or unintelligibly overlap
  'raw_dialogue_unintelligible',   // the essential original words cannot be heard
  'small_active_footage',         // main picture occupies too little of 9:16 to read action
  'unreadable_on_screen_text',     // relevant on-screen captions/evidence cannot be read
  'pacing_without_progress'       // a timed region stalls despite cuts or original dialogue
];
const DELIVERY_ISSUES = new Set(ISSUE_TYPES.slice(ISSUE_TYPES.indexOf('unbridged_perspective_shift')));
const VISUAL_PRESENTATION_ISSUES = new Set(['small_active_footage', 'unreadable_on_screen_text']);
// These are audible/visual MP4 delivery faults. The Editorial Director can repair
// speech ownership or the EDL, but cannot magically correct a renderer layout.
const AUDIO_PRESENTATION_ISSUES = new Set(['narration_robotic', 'narration_fragmented',
  'narration_unnecessary', 'narration_handoff_confusing', 'narration_masks_dialogue',
  'raw_dialogue_unintelligible']);

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const responseSchema = object({
  scopeSurvived: { type: 'boolean' },
  centralQuestionActiveThroughout: { type: 'boolean' },
  endingIsConsequenceOfCentralConflict: { type: 'boolean' },
  hookPromiseSupported: { type: 'boolean' },
  observableEndingConsequence: { type: 'boolean' },
  repetitiveProcedureWithoutProgress: { type: 'boolean' },
  finalFootageUsable: { type: 'boolean' },
  observedStory: { type: 'string' },
  coldViewerCanFollow: { type: 'boolean' },
  coldViewerNotes: { type: 'string' },
  // Delivery pass: explicit, visual judgments (not inferred from the transcript).
  openingCuriosity: object({ firstSecondsDescription: { type: 'string' }, createsCuriosity: { type: 'boolean' } }),
  transitions: {
    type: 'array',
    items: object({
      outputSec: { type: 'number' },
      change: { type: 'string', enum: ['scene', 'time', 'place', 'perspective'] },
      whatViewerSeesAndHears: { type: 'string' },
      coldViewerUnderstandsWhy: { type: 'boolean' }
    })
  },
  finalSeconds: object({ visualDescription: { type: 'string' }, subjectClearlyVisible: { type: 'boolean' } }),
  // Real rendered MP4 only. Every false verdict MUST describe a directly
  // observed problem in issues[] with an output timestamp, not just self-grade.
  productionQuality: object({
    narratorSoundsNatural: { type: 'boolean' },
    narratorAddsNecessaryContext: { type: 'boolean' },
    narratorHandoffsClean: { type: 'boolean' },
    essentialDialogueClear: { type: 'boolean' },
    activeFootageReadable: { type: 'boolean' },
    importantVisualTextReadable: { type: 'boolean' },
    pacingMaintainsProgress: { type: 'boolean' },
    audibleObservation: { type: 'string' },
    visualObservation: { type: 'string' },
    pacingObservation: { type: 'string' }
  }),
  issues: {
    type: 'array',
    items: object({
      type: { type: 'string', enum: ISSUE_TYPES },
      severity: { type: 'string', enum: ['blocking', 'minor'] },
      outputStartSec: { type: 'number' },
      outputEndSec: { type: 'number' },
      evidence: { type: 'string' },
      whyItFails: { type: 'string' }
    })
  },
  summary: { type: 'string' }
});

// Delivery layout in output time (narrated passage vs raw evidence), from the
// rendered script artifact when available, else from the spine.
function deliveryTimeline(spine, script, timeline) {
  const compiled = Array.isArray(script?.delivery_blocks) ? script.delivery_blocks : null;
  if (compiled) return compiled.map(b => ({ blockId: b.blockId, mode: b.mode, beatIds: b.beatIds, outputStartSec: b.outputStartSec, outputEndSec: b.outputEndSec,
    narrationText: b.narrationText || '', storyFunction: b.storyFunction || '', evidenceFunction: b.evidenceFunction || '', sourceAudioTreatment: b.sourceAudioTreatment || '' }));
  const blocks = Array.isArray(spine?.deliveryBlocks) ? spine.deliveryBlocks : null;
  if (!blocks) return null;
  return blocks.map(b => {
    const rows = timeline.filter(t => (b.beatIds || []).includes(t.beatId));
    return { blockId: b.blockId, mode: b.mode, beatIds: b.beatIds, outputStartSec: rows[0]?.outputStartSec ?? 0, outputEndSec: rows[rows.length - 1]?.outputEndSec ?? 0,
      narrationText: '', storyFunction: b.storyFunction || '', evidenceFunction: b.evidenceFunction || '', sourceAudioTreatment: b.sourceAudioTreatment || '' };
  });
}

// Output-time map of the compiled timeline: segments are contiguous in beat order.
function outputTimeline(spine, script) {
  const beats = spine?.beats || [];
  const segs = Array.isArray(script?.segments) ? script.segments : [];
  let cursor = 0;
  return beats.map((b, i) => {
    const seg = segs[i];
    const len = seg && Number.isFinite(seg.sourceEndSec) && Number.isFinite(seg.sourceStartSec)
      ? seg.sourceEndSec - seg.sourceStartSec
      : Math.max(0, (Number(b.sourceEndSec) || 0) - (Number(b.sourceStartSec) || 0));
    const row = { beatId: b.beatId, outputStartSec: cursor, outputEndSec: cursor + len, sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec };
    cursor += len;
    return row;
  });
}

// Audit every major source-time discontinuity, including two raw beats inside
// the SAME delivery block (previously invisible to the Critic transition list).
function majorSourceJumps(timeline = []) {
  const out = [];
  for (let i = 1; i < timeline.length; i++) {
    const before = timeline[i - 1], after = timeline[i];
    const gap = Number(after.sourceStartSec) - Number(before.sourceEndSec);
    if (Number.isFinite(gap) && Math.abs(gap) >= 20) out.push({
      outputSec: after.outputStartSec, fromBeatId: before.beatId,
      toBeatId: after.beatId, sourceGapSec: Math.round(gap * 10) / 10
    });
  }
  return out;
}

function beatsInRegion(timeline, s, e) {
  return timeline.filter(t => Math.min(e, t.outputEndSec) - Math.max(s, t.outputStartSec) > 0.05).map(t => t.beatId);
}

function buildPrompt(spine, timeline, durationSec, delivery = null) {
  const scope = spine.storyScope || {};
  const lines = timeline.map((t, i) => {
    const b = spine.beats[i] || {};
    return `- ${t.outputStartSec.toFixed(1)}-${t.outputEndSec.toFixed(1)}s [${b.beatId}] ${b.scopeMembership || ''} ${b.audioMode || ''}: intended "${String(b.newInformation || b.whyNecessaryNow || '').slice(0, 160)}"`;
  }).join('\n');
  const majorJumps = majorSourceJumps(timeline);
  const everyCut = timeline.slice(1).map((t, i) => ({
    outputSec: t.outputStartSec, previous: timeline[i], current: t
  }));
  return `You are a senior short-form story editor reviewing a RENDERED edit. Watch the whole attached video (${durationSec.toFixed(2)}s). Judge the WHOLE REAL MP4 as a TikTok-ready edit: story, retention, original dialogue, narrator TEXT AND AUDIBLE TTS DELIVERY, transitions, visual composition and final readability. Never infer voice quality from the text or intended script.
MANDATORY MAJOR SOURCE CUT CHECK (${majorJumps.length} boundary/boundaries):
${majorJumps.map(g => `- At OUTPUT ${g.outputSec.toFixed(1)}s, source jumps ${g.sourceGapSec > 0 ? 'forward' : 'backward'} ${Math.abs(g.sourceGapSec)}s: ${g.fromBeatId} -> ${g.toBeatId}. Check whether what is actually SPOKEN (narrator or original participants) or SHOWN explains this change.`).join('\n') || '- No major >20s source jumps in this EDL.'}
MANDATORY COLD-VIEWER AUDIT OF EVERY EDL CUT (${everyCut.length} boundaries, even when the time gap is short):
${everyCut.map(c => `- OUTPUT ${Number(c.outputSec).toFixed(1)}s: ${c.previous.beatId} -> ${c.current.beatId}. Source ${c.previous.sourceEndSec}s -> ${c.current.sourceStartSec}s. What ACTUAL words or pictures explain the relationship and new information?`).join('\n') || '- One continuous shot.'}
For EVERY CUT above return a DISTINCT transitions[] entry at exactly that output time, with whatViewerSeesAndHears (literal, from the MP4), change (scene/time/place/perspective) and coldViewerUnderstandsWhy. Never skip a cut only because the source clocks are nearby. Do not assume the narrator actually speaks just because a delivery block claims one. The first 1-3 seconds AFTER a cut must orient a cold viewer or genuinely continue an intelligible raw conversation; if not, mark false and explain where the narration/causal handoff is missing. If the same hook footage is replayed with no new information, report a blocking repeated_dialogue_function issue rather than calling it a payoff.

INTENDED STORY SCOPE
- Central conflict: ${scope.centralConflict || ''}
- Central viewer question: ${scope.centralViewerQuestion || ''}
- Scope boundary: ${scope.explicitScopeBoundary ? `${scope.explicitScopeBoundary.startSec}-${scope.explicitScopeBoundary.endSec}s of the source — ${scope.explicitScopeBoundary.rationale || ''}` : ''}
- Deliberately out of scope: ${(scope.outOfScopeBranches || []).map(b => b.description).join(' | ')}
- Must be withheld until the end: ${(scope.mustWithhold || []).join(' | ')}
- Intended ending type: ${scope.scopeEndTarget || ''}

INTENDED EDL (output time in the rendered video)
${lines}
${delivery ? `
INTENDED DELIVERY (who owns the audio, output time)
${delivery.map(d => `- ${Number(d.outputStartSec).toFixed(1)}-${Number(d.outputEndSec).toFixed(1)}s [${d.blockId}] ${d.mode === 'narrated_story' ? `NARRATOR (${d.sourceAudioTreatment || 'voiceover'}): "${String(d.narrationText || d.storyFunction).slice(0, 400)}"` : `RAW EVIDENCE: ${String(d.evidenceFunction || d.storyFunction).slice(0, 200)}`} (beats ${(d.beatIds || []).join(', ')})`).join('\n')}
The narrator owns comprehension, compression, orientation, causal connection, anticipation and momentum. Source audio owns proof, confrontation, emotion, authenticity, the strongest quote, reaction, discovery and consequence.
` : ''}
Answer from what you actually SEE and HEAR:
1. scopeSurvived: does the rendered video tell this one mini-story?
2. centralQuestionActiveThroughout: does the viewer question stay open and relevant from start to end?
3. endingIsConsequenceOfCentralConflict: is the ending a payoff, or a named forward consequence, of this conflict (not a new question from another branch)?
3A. hookPromiseSupported: COMPARE the actual opening/hook promise with what the VIEWER literally sees/hears by the END. A claim of a serious discovery cannot pass if the video only shows police still searching. Do not infer a payoff from the script title, plan or transcript. If unsupported, mark false.
3B. observableEndingConsequence: Does the final scene itself deliver a specific observed change or consequence of the central conflict? A routine search continuing with no finding, admission, contradiction or known outcome is false. An intentionally unresolved Part 1 may pass only if there is a real consequential revelation before the ending and the hook honestly promises an unresolved question.
3C. repetitiveProcedureWithoutProgress: Is a substantial stretch spent on repeated searches, questioning or handling objects that do not change what the viewer knows or expects? If so mark true even when each camera shot is visually different. Name the region as a blocking procedural_repetition issue. If the repeated actions reveal new evidence, mark false.
4. finalFootageUsable: LOOK at the picture of the last 3-5 seconds itself. Is the subject/action clearly visible, or is the frame blocked, dark, covered, pointed away or unreadable? Describe what you literally see there in finalSeconds.visualDescription and set finalSeconds.subjectClearlyVisible. The transcript or a resolved story is NOT evidence that the picture is usable.
5. issues: every genuine problem, with its output-time region: ${ISSUE_TYPES.join(', ')}. 'blocking' means a viewer would lose the story or feel it is assembled from unrelated moments. 'minor' means it could be better. Do not report a problem just because the location or speaker stays the same: a continuous exchange that keeps changing the conflict is fine. A large source-time jump is fine when the edit makes clear why we are there.
6. transitions: list EVERY major visual, time, place or perspective change you see in the rendered video (outputSec, change, whatViewerSeesAndHears) and for each judge coldViewerUnderstandsWhy — does the picture, dialogue or narration tell a first-time viewer why we are now seeing this? Inspect each transition as you watch; do not rely on the transcript flowing on.
   coldViewerCanFollow: could a viewer who has NEVER seen the source understand who is speaking, why we moved here, what changed, and why the next raw clip matters? It cannot be true while a listed transition is not understood. coldViewerNotes: where that breaks, if anywhere.
   openingCuriosity: describe the first seconds (firstSecondsDescription) and judge whether they create immediate curiosity for a cold viewer (createsCuriosity).
7. DELIVERY PASS — judge each separately as you watch: opening curiosity (opening_lacks_curiosity); raw/narrator ownership; whether an explanatory raw stretch should have been compressed; perspective and time transitions; narrator->raw handoffs; raw->narrator handoffs; final visual usability. Issue types: a perspective shift nobody bridges (unbridged_perspective_shift), a time/place jump with no reason given (unexplained_time_jump), raw audio spending long stretches on explanation a narrator could compress (raw_explanation_overlong), a place where one narrated passage would orient a lost viewer (narration_underused), narration talking over or paraphrasing a moment that should speak for itself (narration_overwrites_evidence), a narrator passage that does not set up why the next real moment matters (weak_narrator_to_raw_handoff), or a real moment the narration does not connect forward (weak_raw_to_narrator_handoff). Report only what you actually experience while watching, with its output-time region.
8. PRODUCTION QUALITY (mandatory): actually LISTEN to the rendered narration. In productionQuality report narratorSoundsNatural, narratorAddsNecessaryContext, narratorHandoffsClean, essentialDialogueClear, activeFootageReadable, importantVisualTextReadable, pacingMaintainsProgress, and grounded audibleObservation, visualObservation and pacingObservation (each an observation about the ACTUAL MP4, not a plan). If no narrator occurs, narrator-related verdicts are true and explain that no narrator is audible. If no important captions/text are relied on, importantVisualTextReadable=true and say so. Notice mechanical inflection, clipped 2-4-word phrases, narrator repeating what the officer already says, poor ducking or loud clashes, long procedural stretches, and a tiny central 16:9 strip swimming in blurred top/bottom space. Treat the picture as readable only when a mobile viewer can discern the actual action and evidence without zooming. Do NOT penalize necessary wide shots automatically; the actual key action must be legible. For EVERY false productionQuality field add at least ONE specifically TIMED blocking issue in issues[] with literal observed MP4 evidence. Choose the relevant exact issue type (narration_robotic, narration_fragmented, narration_unnecessary, narration_handoff_confusing, narration_masks_dialogue, raw_dialogue_unintelligible, small_active_footage, unreadable_on_screen_text, pacing_without_progress). A static picture showing a developing exchange may still be excellent; judge information gain rather than movement. Do not invent a poor moment just to fill a checklist.
9. observedStory: 2-3 sentences on the story as a viewer experiences it. summary: one sentence.
Return JSON only.`;
}

function normalizeCritique(raw, { durationSec, timeline, deliveryAware = false, expectedMajorJumps = null }) {
  const invalid = summary => ({ status: 'MEDIA_CRITIC_INVALID', isCompliant: false, summary, issues: [], weakWindows: [], weakRegions: [] });
  if (!raw || typeof raw !== 'object') return invalid('Critic returned no object.');
  for (const k of ['scopeSurvived', 'centralQuestionActiveThroughout', 'endingIsConsequenceOfCentralConflict', 'finalFootageUsable']) {
    if (typeof raw[k] !== 'boolean') return invalid(`Critic field '${k}' must be boolean.`);
  }
  if (!Array.isArray(raw.issues)) return invalid('Critic issues must be an array.');
  if (deliveryAware) for (const key of ['hookPromiseSupported', 'observableEndingConsequence', 'repetitiveProcedureWithoutProgress']) {
    if (typeof raw[key] !== 'boolean') return invalid(`Critic field '${key}' must be boolean for V4 acceptance.`);
  }
  if (deliveryAware && typeof raw.coldViewerCanFollow !== 'boolean') return invalid("Critic field 'coldViewerCanFollow' must be boolean.");
  if (deliveryAware && !Array.isArray(raw.transitions)) return invalid("Critic field 'transitions' must list the rendered video's transitions.");
  if (deliveryAware && typeof raw.finalSeconds?.subjectClearlyVisible !== 'boolean') return invalid("Critic field 'finalSeconds.subjectClearlyVisible' must be boolean (inspect the last 3-5 seconds visually).");
  if (deliveryAware && typeof raw.openingCuriosity?.createsCuriosity !== 'boolean') return invalid("Critic field 'openingCuriosity.createsCuriosity' must be boolean.");
  const qualityFlags = {
    narratorSoundsNatural: 'narration_robotic',
    narratorAddsNecessaryContext: 'narration_unnecessary',
    narratorHandoffsClean: 'narration_handoff_confusing',
    essentialDialogueClear: 'raw_dialogue_unintelligible',
    activeFootageReadable: 'small_active_footage',
    importantVisualTextReadable: 'unreadable_on_screen_text',
    pacingMaintainsProgress: 'pacing_without_progress'
  };
  if (deliveryAware) {
    const pq = raw.productionQuality;
    if (!pq || typeof pq !== 'object') return invalid('Rendered-MP4 productionQuality audit is missing.');
    for (const k of Object.keys(qualityFlags)) {
      if (typeof pq[k] !== 'boolean') return invalid(`productionQuality.${k} must be a boolean based on the rendered MP4.`);
    }
    for (const k of ['audibleObservation', 'visualObservation', 'pacingObservation']) {
      if (typeof pq[k] !== 'string' || !pq[k].trim())
        return invalid(`productionQuality.${k} requires an observation of the actual rendered MP4.`);
    }
  }
  // Visual evidence wins over story resolution: an ending whose picture is not
  // clearly visible is unusable, and a cold viewer cannot follow past a transition
  // the critic itself says is not understood.
  const transitions = (Array.isArray(raw.transitions) ? raw.transitions : []).filter(t => t && Number.isFinite(Number(t.outputSec)));
  // The MP4 must be audited at EVERY EDL cut. One answer must not serve
  // multiple cuts, and a short jump can be semantically as confusing as a long.
  const expected = deliveryAware
    ? (expectedMajorJumps || timeline.slice(1).map((t, i) => ({
      outputSec: t.outputStartSec, fromBeatId: timeline[i].beatId, toBeatId: t.beatId
    }))) : [];
  const matchedTransitions = new Set();
  for (const cut of expected) {
    const index = transitions.findIndex((t, i) => !matchedTransitions.has(i)
      && Math.abs(Number(t.outputSec) - Number(cut.outputSec)) <= 0.75
      && typeof t.coldViewerUnderstandsWhy === 'boolean'
      && String(t.whatViewerSeesAndHears || '').trim());
    if (index < 0) {
      return invalid(`Media Critic omitted mandatory source cut at output ${Number(cut.outputSec).toFixed(1)}s (${cut.fromBeatId} -> ${cut.toBeatId}); cannot certify story continuity.`);
    }
    matchedTransitions.add(index);
  }
  const lostAt = transitions.filter(t => t.coldViewerUnderstandsWhy === false);
  const verdict = {
    finalFootageUsable: raw.finalFootageUsable && raw.finalSeconds?.subjectClearlyVisible !== false,
    coldViewerCanFollow: typeof raw.coldViewerCanFollow === 'boolean' ? (raw.coldViewerCanFollow && !lostAt.length) : null,
    openingCreatesCuriosity: typeof raw.openingCuriosity?.createsCuriosity === 'boolean' ? raw.openingCuriosity.createsCuriosity : null
  };
  const issues = [];
  for (const [i, it] of raw.issues.entries()) {
    if (!it || !ISSUE_TYPES.includes(it.type) || !['blocking', 'minor'].includes(it.severity)) return invalid(`issues[${i}] has an unknown type/severity.`);
    let s = Number(it.outputStartSec), e = Number(it.outputEndSec);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return invalid(`issues[${i}] needs numeric outputStartSec/outputEndSec.`);
    s = Math.max(0, Math.min(durationSec, s)); e = Math.max(0, Math.min(durationSec, e));
    if (e <= s) e = Math.min(durationSec, s + 0.5);
    issues.push({ ...it, outputStartSec: s, outputEndSec: e, beatIds: beatsInRegion(timeline, s, e) });
  }
  // A blanket "sounds bad" or "tiny video" verdict is insufficient for a
  // repair: demand a local MP4 observation with output timestamps. Related
  // issue codes also count: narration can be BOTH robotic and fragmented;
  // pacing may be reported as procedural repetition rather than dead air.
  const qualityEvidenceTypes = {
    narratorSoundsNatural: ['narration_robotic', 'narration_fragmented'],
    narratorAddsNecessaryContext: ['narration_unnecessary', 'narration_underused', 'narration_handoff_confusing'],
    narratorHandoffsClean: ['narration_handoff_confusing', 'weak_narrator_to_raw_handoff', 'weak_raw_to_narrator_handoff', 'narration_masks_dialogue'],
    essentialDialogueClear: ['raw_dialogue_unintelligible', 'narration_masks_dialogue'],
    activeFootageReadable: ['small_active_footage', 'unusable_footage'],
    importantVisualTextReadable: ['unreadable_on_screen_text', 'small_active_footage'],
    pacingMaintainsProgress: ['pacing_without_progress', 'procedural_repetition', 'low_value_stretch', 'repeated_dialogue_function']
  };
  if (deliveryAware) for (const [flag, allowed] of Object.entries(qualityEvidenceTypes)) {
    if (raw.productionQuality[flag] === false && !issues.some(it =>
      allowed.includes(it.type) && it.severity === 'blocking' && String(it.evidence || '').trim())) {
      return invalid(`productionQuality.${flag}=false lacks an observed, timed blocking issue (${allowed.join('/')}).`);
    }
  }
  // A false verdict with no matching issue still needs a repairable region.
  const lastBeat = timeline[timeline.length - 1];
  const tail = lastBeat ? [lastBeat.outputStartSec, lastBeat.outputEndSec] : [Math.max(0, durationSec - 5), durationSec];
  const flagValue = flag => (flag in verdict ? verdict[flag] : raw[flag]);
  const ensure = (flag, type, region, why) => {
    if (flagValue(flag) === false && !issues.some(x => x.type === type && x.severity === 'blocking')) {
      issues.push({ type, severity: 'blocking', outputStartSec: region[0], outputEndSec: region[1], evidence: raw.observedStory || '', whyItFails: why, beatIds: beatsInRegion(timeline, region[0], region[1]), derivedFromVerdict: flag });
    }
  };
  ensure('endingIsConsequenceOfCentralConflict', 'ending_not_consequence', tail, 'Critic verdict: the ending is not a consequence of the central conflict.');
  if (raw.hookPromiseSupported === false) issues.push({
    type: 'hook_unfulfilled', severity: 'blocking', outputStartSec: 0, outputEndSec: durationSec,
    evidence: raw.observedStory || '', whyItFails: 'Viewer was promised a revelation the MP4 never demonstrates.',
    beatIds: timeline.map(t => t.beatId), derivedFromVerdict: 'hookPromiseSupported'
  });
  if (raw.observableEndingConsequence === false) issues.push({
    type: 'ending_without_payoff', severity: 'blocking', outputStartSec: tail[0], outputEndSec: tail[1],
    evidence: raw.finalSeconds?.visualDescription || '', whyItFails: 'Video ends in routine procedure without an observed consequence.',
    beatIds: beatsInRegion(timeline, tail[0], tail[1]), derivedFromVerdict: 'observableEndingConsequence'
  });
  if (raw.repetitiveProcedureWithoutProgress === true && !issues.some(x => x.type === 'procedural_repetition' && x.severity === 'blocking')) {
    issues.push({ type: 'procedural_repetition', severity: 'blocking', outputStartSec: 0, outputEndSec: durationSec,
      evidence: raw.observedStory || '', whyItFails: 'Multiple procedural moments repeat without meaningful new information.',
      beatIds: timeline.map(t => t.beatId), derivedFromVerdict: 'repetitiveProcedureWithoutProgress' });
  }
  ensure('finalFootageUsable', 'unusable_footage', tail, `Critic verdict: the final footage is not clearly observable${raw.finalSeconds?.visualDescription ? ` (${raw.finalSeconds.visualDescription})` : ''}.`);
  // Each transition the critic says a cold viewer does not understand is its own repair region.
  for (const t of lostAt) {
    const at = Math.max(0, Math.min(durationSec, Number(t.outputSec)));
    const type = t.change === 'perspective' ? 'unbridged_perspective_shift' : 'unexplained_time_jump';
    if (issues.some(x => x.severity === 'blocking' && DELIVERY_ISSUES.has(x.type) && x.outputStartSec <= at + 0.5 && x.outputEndSec >= at - 0.5)) continue;
    const region = [Math.max(0, at - 1), Math.min(durationSec, at + 2)];
    issues.push({ type, severity: 'blocking', outputStartSec: region[0], outputEndSec: region[1], evidence: t.whatViewerSeesAndHears || '', whyItFails: `Critic transition check: a cold viewer does not understand why we moved here (${t.change}).`, beatIds: beatsInRegion(timeline, region[0], region[1]), derivedFromVerdict: 'transitions' });
  }
  if (verdict.openingCreatesCuriosity === false && !issues.some(x => x.severity === 'blocking' && x.type === 'opening_lacks_curiosity')) {
    const first = timeline[0] ? [timeline[0].outputStartSec, timeline[0].outputEndSec] : [0, Math.min(5, durationSec)];
    issues.push({ type: 'opening_lacks_curiosity', severity: 'blocking', outputStartSec: first[0], outputEndSec: first[1], evidence: raw.openingCuriosity?.firstSecondsDescription || '', whyItFails: 'Critic verdict: the first seconds do not create immediate curiosity for a cold viewer.', beatIds: beatsInRegion(timeline, first[0], first[1]), derivedFromVerdict: 'openingCuriosity' });
  }
  if (raw.centralQuestionActiveThroughout === false && !issues.some(x => x.severity === 'blocking' && ['comprehension_gap', 'causal_break', 'low_value_stretch', 'out_of_scope_branch'].includes(x.type))) {
    // No localized cause given: the whole edit is the repair region (the director decides where).
    issues.push({ type: 'comprehension_gap', severity: 'blocking', outputStartSec: 0, outputEndSec: durationSec, evidence: raw.observedStory || '', whyItFails: 'Critic verdict: the central viewer question does not stay active through the edit.', beatIds: timeline.map(t => t.beatId), derivedFromVerdict: 'centralQuestionActiveThroughout' });
  }
  if (verdict.coldViewerCanFollow === false && !issues.some(x => x.severity === 'blocking' && (DELIVERY_ISSUES.has(x.type) || x.type === 'comprehension_gap'))) {
    issues.push({ type: 'comprehension_gap', severity: 'blocking', outputStartSec: 0, outputEndSec: durationSec, evidence: raw.coldViewerNotes || raw.observedStory || '', whyItFails: 'Critic verdict: a cold viewer cannot follow who is speaking, why we moved, what changed, or why the next raw clip matters.', beatIds: timeline.map(t => t.beatId), derivedFromVerdict: 'coldViewerCanFollow' });
  }
  if (raw.scopeSurvived === false && !issues.some(x => x.severity === 'blocking')) {
    issues.push({ type: 'out_of_scope_branch', severity: 'blocking', outputStartSec: 0, outputEndSec: durationSec, evidence: raw.observedStory || '', whyItFails: 'Critic verdict: the intended scope did not survive the render.', beatIds: timeline.map(t => t.beatId), derivedFromVerdict: 'scopeSurvived' });
  }
  const blocking = issues.filter(x => x.severity === 'blocking');
  const isCompliant = raw.scopeSurvived && raw.centralQuestionActiveThroughout && raw.endingIsConsequenceOfCentralConflict && verdict.finalFootageUsable
    && verdict.coldViewerCanFollow !== false && verdict.openingCreatesCuriosity !== false
    && raw.hookPromiseSupported !== false && raw.observableEndingConsequence !== false
    && raw.repetitiveProcedureWithoutProgress !== true
    && (!deliveryAware || Object.keys(qualityFlags).every(k => raw.productionQuality[k] === true))
    && blocking.length === 0;
  const weakRegions = blocking.map(x => ({ type: x.type, outputStartSec: x.outputStartSec, outputEndSec: x.outputEndSec, beatIds: x.beatIds, reason: x.whyItFails, evidence: x.evidence,
    ...(DELIVERY_ISSUES.has(x.type) ? { deliveryIssue: true } : {}),
    ...(VISUAL_PRESENTATION_ISSUES.has(x.type) ? { visualLayoutIssue: true } : {}),
    ...(AUDIO_PRESENTATION_ISSUES.has(x.type) ? { audioIssue: true } : {}) }));
  return {
    status: 'SCOPED_MEDIA_CRITIC_OK', critic: 'scope-media-critic-v1', isCompliant,
    scopeSurvived: raw.scopeSurvived, centralQuestionActiveThroughout: raw.centralQuestionActiveThroughout,
    endingIsConsequence: raw.endingIsConsequenceOfCentralConflict, finalFootageUsable: verdict.finalFootageUsable,
    finalFootageUsableReported: raw.finalFootageUsable, finalSeconds: raw.finalSeconds || null,
    hookPromiseSupported: raw.hookPromiseSupported ?? null,
    observableEndingConsequence: raw.observableEndingConsequence ?? null,
    repetitiveProcedureWithoutProgress: raw.repetitiveProcedureWithoutProgress ?? null,
    openingCuriosity: raw.openingCuriosity || null, transitions,
    observedStory: raw.observedStory || '', summary: raw.summary || '', issues, weakRegions,
    productionQuality: raw.productionQuality || null,
    coldViewerCanFollow: verdict.coldViewerCanFollow, coldViewerCanFollowReported: typeof raw.coldViewerCanFollow === 'boolean' ? raw.coldViewerCanFollow : null, coldViewerNotes: raw.coldViewerNotes || '',
    deliveryIssues: issues.filter(x => DELIVERY_ISSUES.has(x.type)),
    // Envelope fields the V4 review-state writer already persists.
    weakWindows: weakRegions, mp4Duration: durationSec, criticObservedScore: null, averageRetentionScore: null,
    outputTimeline: timeline
  };
}

// Advisory-only: exact audio ownership statistics from the REAL compiled EDL,
// useful when provider 429 makes AI feedback unavailable. No narration quota.
function deliveryCadenceMetrics(spine = {}, script = null) {
  const timeline = outputTimeline(spine, script);
  const blocks = deliveryTimeline(spine, script, timeline) || [];
  const durationSec = timeline.length ? Number(timeline[timeline.length-1].outputEndSec) : 0;
  const r = n => Math.round(Math.max(0, n) * 100) / 100;
  const narrated = blocks.filter(b=>b.mode==='narrated_story');
  const raw = blocks.filter(b=>b.mode==='raw_evidence');
  const len = b => Math.max(0, Number(b.outputEndSec)-Number(b.outputStartSec));
  const narratedSec = narrated.reduce((n,b)=>n+len(b),0);
  const rawSec = raw.reduce((n,b)=>n+len(b),0);
  let longestRawRun=0, currentRaw=0;
  for (const block of [...blocks].sort((a,b)=>a.outputStartSec-b.outputStartSec)) {
    if (block.mode==='raw_evidence') {
      currentRaw += len(block); longestRawRun = Math.max(longestRawRun,currentRaw);
    } else currentRaw = 0;
  }
  const singleBeatNarrationBlocks=narrated.filter(b=>(b.beatIds||[]).length===1).length;
  const advisoryFlags=[];
  if (durationSec>=90 && rawSec/Math.max(durationSec,1)>.8 && longestRawRun>25)
    advisoryFlags.push('LONG_RAW_EXPOSITION_TO_INSPECT');
  if (narrated.length>1 && narrated.length===singleBeatNarrationBlocks)
    advisoryFlags.push('NARRATION_ONLY_ON_SINGLE_BEATS_TO_INSPECT');
  return {totalSec:r(durationSec),beatCount:timeline.length,deliveryBlockCount:blocks.length,
    narratedBlockCount:narrated.length,rawBlockCount:raw.length,
    narratedSec:r(narratedSec),rawSec:r(rawSec),longestRawRunSec:r(longestRawRun),
    singleBeatNarrationBlocks,narratorShare:Number((narratedSec/Math.max(durationSec,1)).toFixed(3)),
    advisoryFlags,advisoryOnly:true};
}

async function critiqueScopedRender(spine = {}, { aiService, mp4Path, actualMp4DurationSec, script = null } = {}) {
  if (!aiService || !mp4Path || !actualMp4DurationSec) throw new Error('Scope media critic requires aiService, mp4Path, and actualMp4DurationSec');
  const timeline = outputTimeline(spine, script);
  const delivery = deliveryTimeline(spine, script, timeline);
  // Beat -> delivery block in output time, so repair can target the block.
  if (delivery) timeline.forEach(t => { const d = delivery.find(x => (x.beatIds || []).includes(t.beatId)); if (d) { t.deliveryBlockId = d.blockId; t.deliveryMode = d.mode; } });
  const prompt = buildPrompt(spine, timeline, actualMp4DurationSec, delivery);
  let raw;
  try {
    raw = await aiService.generateJsonFromFiles({ filePaths: [mp4Path], prompt, responseSchema, taskType: 'analysis' });
  } catch (error) {
    // A provider capacity outage is NOT a judgment about the actual footage.
    // Do not convert Vertex 429 into an editorial FAIL, and do not immediately
    // resend the same large video to the saturated preview-model pool.
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
    const provider = require('./autoStoryProviderErrors');
    if (provider.isRateLimit(error) || /request failed \((502|503|504)\)|Service Unavailable/i.test(error?.message || '')) {
      return { status: 'MEDIA_CRITIC_UNAVAILABLE', isCompliant: false, retryable: true,
        providerStatus: provider.isRateLimit(error) ? 429 : Number(/(?:502|503|504)/.exec(error.message)?.[0]) || 503,
        summary: `Critic model temporarily unavailable: ${error.message}`,
        issues: [], weakWindows: [], weakRegions: [] };
    }
    return { status: 'MEDIA_CRITIC_INVALID', isCompliant: false, summary: `Critic call failed: ${error.message}`, issues: [], weakWindows: [], weakRegions: [] };
  }
  const out = normalizeCritique(raw, { durationSec: actualMp4DurationSec, timeline, deliveryAware: Boolean(delivery) });
  if (delivery && out.status === 'SCOPED_MEDIA_CRITIC_OK') {
    out.deliveryTimeline = delivery;
    out.weakRegions = out.weakRegions.map(r => ({ ...r, deliveryBlockIds: [...new Set(timeline.filter(t => (r.beatIds || []).includes(t.beatId)).map(t => t.deliveryBlockId).filter(Boolean))] }));
    out.weakWindows = out.weakRegions;
  }
  return out;
}

module.exports = { ISSUE_TYPES, DELIVERY_ISSUES, VISUAL_PRESENTATION_ISSUES, AUDIO_PRESENTATION_ISSUES, responseSchema, outputTimeline, deliveryTimeline, majorSourceJumps, beatsInRegion, buildPrompt, normalizeCritique, critiqueScopedRender, deliveryCadenceMetrics };
