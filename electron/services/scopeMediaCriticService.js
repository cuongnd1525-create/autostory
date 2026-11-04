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
  // Editorial readiness (story quality beyond structural validity).
  'stronger_hook_buried',          // a clearly stronger verified hook sits later in the edit while the opening is routine
  'low_information_footage',       // static/blocked picture that adds no new information (e.g. dashboard, redaction box)
  'ending_cuts_mid_line',          // the final cut interrupts a sentence or an action before it completes
  'payoff_unsatisfying',           // the ending does not answer the question the opening raised
  'external_overlay'               // someone else's branding/subscribe graphic/subtitles burned into the picture
];
const DELIVERY_ISSUES = new Set(ISSUE_TYPES.slice(ISSUE_TYPES.indexOf('unbridged_perspective_shift'), ISSUE_TYPES.indexOf('opening_lacks_curiosity') + 1));

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const responseSchema = object({
  scopeSurvived: { type: 'boolean' },
  centralQuestionActiveThroughout: { type: 'boolean' },
  endingIsConsequenceOfCentralConflict: { type: 'boolean' },
  finalFootageUsable: { type: 'boolean' },
  observedStory: { type: 'string' },
  coldViewerCanFollow: { type: 'boolean' },
  coldViewerNotes: { type: 'string' },
  // Delivery pass: explicit, visual judgments (not inferred from the transcript).
  openingCuriosity: object({ firstSecondsDescription: { type: 'string' }, createsCuriosity: { type: 'boolean' },
    strongerHookAtOutputSec: { type: 'number' }, strongerHookEvidence: { type: 'string' } }),
  payoffFulfillsOpeningPromise: { type: 'boolean' },
  externalOverlays: object({
    brandingVisible: { type: 'boolean' }, burnedInSubtitlesVisible: { type: 'boolean' }, promoGraphicVisible: { type: 'boolean' }, evidence: { type: 'string' },
    regions: { type: 'array', items: object({ outputStartSec: { type: 'number' }, outputEndSec: { type: 'number' }, kind: { type: 'string', enum: ['branding', 'subtitles', 'promo_graphic'] } }) }
  }),
  transitions: {
    type: 'array',
    items: object({
      outputSec: { type: 'number' },
      change: { type: 'string', enum: ['scene', 'time', 'place', 'perspective'] },
      whatViewerSeesAndHears: { type: 'string' },
      coldViewerUnderstandsWhy: { type: 'boolean' }
    })
  },
  finalSeconds: object({ visualDescription: { type: 'string' }, subjectClearlyVisible: { type: 'boolean' },
    lastWordsHeard: { type: 'string' }, endsAtCompleteBoundary: { type: 'boolean' } }),
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

function beatsInRegion(timeline, s, e) {
  return timeline.filter(t => Math.min(e, t.outputEndSec) - Math.max(s, t.outputStartSec) > 0.05).map(t => t.beatId);
}

function buildPrompt(spine, timeline, durationSec, delivery = null) {
  const scope = spine.storyScope || {};
  const lines = timeline.map((t, i) => {
    const b = spine.beats[i] || {};
    return `- ${t.outputStartSec.toFixed(1)}-${t.outputEndSec.toFixed(1)}s [${b.beatId}] ${b.scopeMembership || ''} ${b.audioMode || ''}: intended "${String(b.newInformation || b.whyNecessaryNow || '').slice(0, 160)}"`;
  }).join('\n');
  return `You are a senior short-form story editor reviewing a RENDERED edit. Watch the whole attached video (${durationSec.toFixed(2)}s). Judge STORY and EDIT DECISIONS: scope, causal flow, dialogue function, hook, ending. Ignore the app's own caption styling, fonts, framing, blur, music, colour and FPS — but DO report material burned into the source picture by someone else (question 10).

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
4. finalFootageUsable: LOOK at the picture of the last 3-5 seconds itself. Is the subject/action clearly visible, or is the frame blocked, dark, covered, pointed away or unreadable? Describe what you literally see there in finalSeconds.visualDescription and set finalSeconds.subjectClearlyVisible. The transcript or a resolved story is NOT evidence that the picture is usable.
5. issues: every genuine problem, with its output-time region: ${ISSUE_TYPES.join(', ')}. 'blocking' means a viewer would lose the story or feel it is assembled from unrelated moments. 'minor' means it could be better. Do not report a problem just because the location or speaker stays the same: a continuous exchange that keeps changing the conflict is fine. A large source-time jump is fine when the edit makes clear why we are there.
6. transitions: list EVERY major visual, time, place or perspective change you see in the rendered video (outputSec, change, whatViewerSeesAndHears) and for each judge coldViewerUnderstandsWhy — does the picture, dialogue or narration tell a first-time viewer why we are now seeing this? Inspect each transition as you watch; do not rely on the transcript flowing on. When a cold-open teaser rewinds backward in source time to an earlier scene, or when the edit jumps across locations/perspectives without narration or spoken orientation explaining the rewind/jump, set coldViewerUnderstandsWhy=false.
   coldViewerCanFollow: could a viewer who has NEVER seen the source understand who is speaking, why we moved here, what changed, and why the next raw clip matters? It cannot be true while a listed transition is not understood. coldViewerNotes: where that breaks, if anywhere.
   openingCuriosity: describe the first seconds (firstSecondsDescription) and judge whether they create immediate curiosity for a cold viewer (createsCuriosity).
7. DELIVERY PASS — judge each separately as you watch: opening curiosity (opening_lacks_curiosity); raw/narrator ownership; whether an explanatory raw stretch should have been compressed; perspective and time transitions; narrator->raw handoffs; raw->narrator handoffs; final visual usability. Issue types: a perspective shift nobody bridges (unbridged_perspective_shift), a time/place jump with no reason given (unexplained_time_jump), raw audio spending long stretches on explanation a narrator could compress (raw_explanation_overlong), a place where one narrated passage would orient a lost viewer (narration_underused), narration talking over or paraphrasing a moment that should speak for itself (narration_overwrites_evidence), a narrator passage that does not set up why the next real moment matters (weak_narrator_to_raw_handoff), or a real moment the narration does not connect forward (weak_raw_to_narrator_handoff). When a 911 waveform/map screen or a prolonged van/roadside argument plays raw for over 16-20 seconds without a narrator stepping in to compress the repetition and deliver editorial commentary, report raw_explanation_overlong or narration_underused as blocking. Report only what you actually experience while watching, with its output-time region.
8. EDITORIAL READINESS — a technically valid edit can still be weak. Judge from what you saw:
   - openingCuriosity.strongerHookAtOutputSec: if a LATER moment in THIS rendered edit would hook a cold viewer clearly better than the opening (a sharper line, conflict or reveal you actually saw/heard), give its output second and describe it in strongerHookEvidence; otherwise -1. A routine exchange that only becomes interesting later is not a hook. If the opening beat prematurely gives away the final criminal charge or outcome that should be withheld, report hook_spends_payoff as blocking.
   - finalSeconds.lastWordsHeard: the last words spoken before the video ends. finalSeconds.endsAtCompleteBoundary: false if the cut interrupts a sentence or an action mid-way.
   - payoffFulfillsOpeningPromise: does the ending answer or pay off the question/promise the opening raised (not just "time runs out", and NEVER ending on an unanswered question from the subject such as "How did I...?" or "Why am I...?" without the answer)?
   - Report a static or blocked picture that adds no new information for several seconds (including static map/waveform graphics) as low_information_footage, and an ending that drags after the conflict is resolved as low_value_stretch.
9. observedStory: 2-3 sentences on the story as a viewer experiences it. summary: one sentence.
10. externalOverlays: material burned into the SOURCE picture by a third party — channel watermark/logo (brandingVisible), the source's own subtitles (burnedInSubtitlesVisible), subscribe/like/end-screen promotional graphics (promoGraphicVisible — only set true for actual channel subscribe/like/end-screen promo banners, NOT for 911 dispatch audio waveform/map screens shown while a 911 call is playing). List the output-time regions where a promo graphic or other overlay is visible.
Return JSON only.`;
}

function normalizeCritique(raw, { durationSec, timeline, deliveryAware = false, deliveryBlocks = null, narrationActive = false }) {
  const invalid = summary => ({ status: 'MEDIA_CRITIC_INVALID', isCompliant: false, summary, issues: [], weakWindows: [], weakRegions: [] });
  if (!raw || typeof raw !== 'object') return invalid('Critic returned no object.');
  for (const k of ['scopeSurvived', 'centralQuestionActiveThroughout', 'endingIsConsequenceOfCentralConflict', 'finalFootageUsable']) {
    if (typeof raw[k] !== 'boolean') return invalid(`Critic field '${k}' must be boolean.`);
  }
  if (!Array.isArray(raw.issues)) return invalid('Critic issues must be an array.');
  if (deliveryAware && typeof raw.coldViewerCanFollow !== 'boolean') return invalid("Critic field 'coldViewerCanFollow' must be boolean.");
  if (deliveryAware && !Array.isArray(raw.transitions)) return invalid("Critic field 'transitions' must list the rendered video's transitions.");
  if (deliveryAware && typeof raw.finalSeconds?.subjectClearlyVisible !== 'boolean') return invalid("Critic field 'finalSeconds.subjectClearlyVisible' must be boolean (inspect the last 3-5 seconds visually).");
  if (deliveryAware && typeof raw.openingCuriosity?.createsCuriosity !== 'boolean') return invalid("Critic field 'openingCuriosity.createsCuriosity' must be boolean.");
  // Visual evidence wins over story resolution: an ending whose picture is not
  // clearly visible is unusable, and a cold viewer cannot follow past a transition
  // the critic itself says is not understood.
  const transitions = (Array.isArray(raw.transitions) ? raw.transitions : []).filter(t => t && Number.isFinite(Number(t.outputSec)));
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
  // Editorial readiness verdicts become repairable blocking regions (same call, no new model).
  const firstRegion = timeline[0] ? [timeline[0].outputStartSec, timeline[0].outputEndSec] : [0, Math.min(5, durationSec)];
  for (const it of issues) {
    if (it.type === 'hook_spends_payoff' && it.severity === 'minor' && it.outputStartSec <= firstRegion[1] + 0.5) {
      it.severity = 'blocking';
      it.derivedFromVerdict = 'hook_spends_payoff@opening';
    }
    if ((it.type === 'raw_explanation_overlong' || it.type === 'narration_underused') && it.severity === 'minor' && (it.outputEndSec - it.outputStartSec) >= 16) {
      it.severity = 'blocking';
      it.derivedFromVerdict = `${it.type}@overlong_stretch`;
    }
  }
  if (Array.isArray(deliveryBlocks) && deliveryBlocks.length) {
    const isNarrationActive = narrationActive || deliveryBlocks.some(d => d.mode === 'narrated_story');
    if (isNarrationActive) {
      const narratedBlocks = deliveryBlocks.filter(d => d.mode === 'narrated_story');
      const overlongRaw = deliveryBlocks.filter(d => d.mode === 'raw_evidence' && (Number(d.outputEndSec) - Number(d.outputStartSec)) >= 22)
        .sort((a, b) => (b.outputEndSec - b.outputStartSec) - (a.outputEndSec - a.outputStartSec))[0];
      if (narratedBlocks.length <= 1 && overlongRaw && !issues.some(x => x.severity === 'blocking' && DELIVERY_ISSUES.has(x.type))) {
        const s = Number(overlongRaw.outputStartSec), e = Number(overlongRaw.outputEndSec);
        issues.push({
          type: 'raw_explanation_overlong', severity: 'blocking', outputStartSec: s, outputEndSec: e,
          evidence: `Raw block ${overlongRaw.blockId} runs uninterrupted for ${(e - s).toFixed(1)}s while the edit has only ${narratedBlocks.length} narrated block(s).`,
          whyItFails: 'An overlong raw stretch plays without narrator compression or editorial commentary; split or compress part of this stretch into a narrated_story commentary block.',
          beatIds: beatsInRegion(timeline, s, e), derivedFromVerdict: 'delivery.overlong_raw_stretch'
        });
      }
    }
  }
  const hookAt = Number(raw.openingCuriosity?.strongerHookAtOutputSec);
  if (Number.isFinite(hookAt) && hookAt >= 0 && !issues.some(x => x.severity === 'blocking' && x.type === 'stronger_hook_buried')) {
    const at = Math.max(0, Math.min(durationSec, hookAt));
    issues.push({ type: 'stronger_hook_buried', severity: 'blocking', outputStartSec: firstRegion[0], outputEndSec: firstRegion[1], strongerHookAtOutputSec: at,
      evidence: raw.openingCuriosity?.strongerHookEvidence || '', whyItFails: `A stronger verified hook appears later (output ${at}s) while the opening is weaker.`,
      beatIds: [...new Set([...beatsInRegion(timeline, firstRegion[0], firstRegion[1]), ...beatsInRegion(timeline, at, Math.min(durationSec, at + 1))])], derivedFromVerdict: 'openingCuriosity.strongerHookAtOutputSec' });
  }
  if (raw.finalSeconds?.endsAtCompleteBoundary === false && !issues.some(x => x.severity === 'blocking' && x.type === 'ending_cuts_mid_line')) {
    issues.push({ type: 'ending_cuts_mid_line', severity: 'blocking', outputStartSec: tail[0], outputEndSec: tail[1], evidence: raw.finalSeconds?.lastWordsHeard || '',
      whyItFails: 'Critic verdict: the final cut interrupts a sentence or action before it completes.', beatIds: beatsInRegion(timeline, tail[0], tail[1]), derivedFromVerdict: 'finalSeconds.endsAtCompleteBoundary' });
  }
  const lastWords = String(raw.finalSeconds?.lastWordsHeard || '').trim();
  const endsOnUnansweredQuestion = /\?\s*["']?$/.test(lastWords) && /^(how|why|what|for what|are you|who)\b/i.test(lastWords.replace(/^["'\s]+/, ''));
  const endDrags = issues.some(x => x.type === 'low_value_stretch' && x.severity === 'minor' && x.outputEndSec >= tail[0] + 0.05 && x.outputStartSec < tail[1]);
  if ((raw.payoffFulfillsOpeningPromise === false || endDrags || endsOnUnansweredQuestion) && !issues.some(x => x.severity === 'blocking' && x.type === 'payoff_unsatisfying')) {
    const why = raw.payoffFulfillsOpeningPromise === false
      ? 'Critic verdict: the ending does not pay off the opening promise.'
      : endsOnUnansweredQuestion
        ? `The edit ends on an unanswered question ("${lastWords}") instead of a completed consequence or authoritative answer.`
        : 'The final beat itself was reported as a low-value stretch: the story ends on filler, not a payoff.';
    issues.push({ type: 'payoff_unsatisfying', severity: 'blocking', outputStartSec: tail[0], outputEndSec: tail[1], evidence: endsOnUnansweredQuestion ? lastWords : (raw.observedStory || ''),
      whyItFails: why,
      beatIds: beatsInRegion(timeline, tail[0], tail[1]), derivedFromVerdict: raw.payoffFulfillsOpeningPromise === false ? 'payoffFulfillsOpeningPromise' : endsOnUnansweredQuestion ? 'finalSeconds.lastWordsHeard@unanswered_question' : 'low_value_stretch@ending' });
  }
  for (const r of (Array.isArray(raw.externalOverlays?.regions) ? raw.externalOverlays.regions : [])) {
    let s = Number(r?.outputStartSec), e = Number(r?.outputEndSec);
    if (r?.kind !== 'promo_graphic' || !Number.isFinite(s) || !Number.isFinite(e)) continue; // branding/subtitles span the source: not an EDL choice
    s = Math.max(0, Math.min(durationSec, s)); e = Math.max(s + 0.5, Math.min(durationSec, e));
    issues.push({ type: 'external_overlay', severity: 'blocking', outputStartSec: s, outputEndSec: e, evidence: raw.externalOverlays?.evidence || 'promo graphic',
      whyItFails: 'A third-party subscribe/promo graphic is visible; pick footage without it.', beatIds: beatsInRegion(timeline, s, e), derivedFromVerdict: 'externalOverlays.regions' });
  }
  if (raw.scopeSurvived === false && !issues.some(x => x.severity === 'blocking')) {
    issues.push({ type: 'out_of_scope_branch', severity: 'blocking', outputStartSec: 0, outputEndSec: durationSec, evidence: raw.observedStory || '', whyItFails: 'Critic verdict: the intended scope did not survive the render.', beatIds: timeline.map(t => t.beatId), derivedFromVerdict: 'scopeSurvived' });
  }
  const blocking = issues.filter(x => x.severity === 'blocking');
  const isCompliant = raw.scopeSurvived && raw.centralQuestionActiveThroughout && raw.endingIsConsequenceOfCentralConflict && verdict.finalFootageUsable
    && verdict.coldViewerCanFollow !== false && verdict.openingCreatesCuriosity !== false && blocking.length === 0;
  const weakRegions = blocking.map(x => ({ type: x.type, outputStartSec: x.outputStartSec, outputEndSec: x.outputEndSec, beatIds: x.beatIds, reason: x.whyItFails, evidence: x.evidence,
    ...(DELIVERY_ISSUES.has(x.type) ? { deliveryIssue: true } : {}) }));
  return {
    status: 'SCOPED_MEDIA_CRITIC_OK', critic: 'scope-media-critic-v1', isCompliant,
    scopeSurvived: raw.scopeSurvived, centralQuestionActiveThroughout: raw.centralQuestionActiveThroughout,
    endingIsConsequence: raw.endingIsConsequenceOfCentralConflict, finalFootageUsable: verdict.finalFootageUsable,
    finalFootageUsableReported: raw.finalFootageUsable, finalSeconds: raw.finalSeconds || null,
    openingCuriosity: raw.openingCuriosity || null, transitions,
    payoffFulfillsOpeningPromise: typeof raw.payoffFulfillsOpeningPromise === 'boolean' ? raw.payoffFulfillsOpeningPromise : null,
    externalOverlays: raw.externalOverlays && typeof raw.externalOverlays === 'object' ? raw.externalOverlays : null,
    observedStory: raw.observedStory || '', summary: raw.summary || '', issues, weakRegions,
    coldViewerCanFollow: verdict.coldViewerCanFollow, coldViewerCanFollowReported: typeof raw.coldViewerCanFollow === 'boolean' ? raw.coldViewerCanFollow : null, coldViewerNotes: raw.coldViewerNotes || '',
    deliveryIssues: issues.filter(x => DELIVERY_ISSUES.has(x.type)),
    // Envelope fields the V4 review-state writer already persists.
    weakWindows: weakRegions, mp4Duration: durationSec, criticObservedScore: null, averageRetentionScore: null,
    outputTimeline: timeline
  };
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
    return { status: 'MEDIA_CRITIC_INVALID', isCompliant: false, summary: `Critic call failed: ${error.message}`, issues: [], weakWindows: [], weakRegions: [] };
  }
  const narrationActive = Boolean(delivery?.some(d => d.mode === 'narrated_story') || script?.narration_enabled);
  const out = normalizeCritique(raw, { durationSec: actualMp4DurationSec, timeline, deliveryAware: Boolean(delivery), deliveryBlocks: delivery, narrationActive });
  if (delivery && out.status === 'SCOPED_MEDIA_CRITIC_OK') {
    out.deliveryTimeline = delivery;
    out.weakRegions = out.weakRegions.map(r => ({ ...r, deliveryBlockIds: [...new Set(timeline.filter(t => (r.beatIds || []).includes(t.beatId)).map(t => t.deliveryBlockId).filter(Boolean))] }));
    out.weakWindows = out.weakRegions;
  }
  return out;
}

module.exports = { ISSUE_TYPES, DELIVERY_ISSUES, responseSchema, outputTimeline, deliveryTimeline, beatsInRegion, buildPrompt, normalizeCritique, critiqueScopedRender };
