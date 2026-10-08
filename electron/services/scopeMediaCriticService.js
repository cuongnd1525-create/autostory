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
  'hook_promise_unresolved',       // a hook must lead to an observed payoff
  'audio_gap_unexplained'          // unintentional long silent stretch
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
  hookPromiseResolved: { type: 'boolean' },
  hookPromiseEvidence: object({ payoffOutputSec: { type: 'number' }, observedPayoff: { type: 'string' } }),
  observationWindows: {
    type: 'array', items: object({
      windowStartSec: { type: 'number' }, windowEndSec: { type: 'number' },
      observedAction: { type: 'string' }, observedNewInformation: { type: 'string' },
      meaningfulProgress: { type: 'boolean' }, causalConnectionClear: { type: 'boolean' },
      unexplainedAudioGap: { type: 'boolean' }
    })
  },
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
  return `You are a senior short-form story editor reviewing a RENDERED edit. Watch the whole attached video (${durationSec.toFixed(2)}s). Judge STORY and EDIT DECISIONS only: scope, causal flow, dialogue function, hook, ending. Ignore captions, fonts, framing, blur, music, colour and FPS.

INTENDED STORY SCOPE
- Central conflict: ${scope.centralConflict || ''}
- Central viewer question: ${scope.centralViewerQuestion || ''}
- Opening promise: ${spine.hookPromise || ''}
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
6. transitions: list EVERY major visual, time, place or perspective change you see in the rendered video (outputSec, change, whatViewerSeesAndHears) and for each judge coldViewerUnderstandsWhy — does the picture, dialogue or narration tell a first-time viewer why we are now seeing this? Inspect each transition as you watch; do not rely on the transcript flowing on.
   coldViewerCanFollow: could a viewer who has NEVER seen the source understand who is speaking, why we moved here, what changed, and why the next raw clip matters? It cannot be true while a listed transition is not understood. coldViewerNotes: where that breaks, if anywhere.
   openingCuriosity: describe the first seconds (firstSecondsDescription) and judge whether they create immediate curiosity for a cold viewer (createsCuriosity).
7. DELIVERY PASS — judge each separately as you watch: opening curiosity (opening_lacks_curiosity); raw/narrator ownership; whether an explanatory raw stretch should have been compressed; perspective and time transitions; narrator->raw handoffs; raw->narrator handoffs; final visual usability. Issue types: a perspective shift nobody bridges (unbridged_perspective_shift), a time/place jump with no reason given (unexplained_time_jump), raw audio spending long stretches on explanation a narrator could compress (raw_explanation_overlong), a place where one narrated passage would orient a lost viewer (narration_underused), narration talking over or paraphrasing a moment that should speak for itself (narration_overwrites_evidence), a narrator passage that does not set up why the next real moment matters (weak_narrator_to_raw_handoff), or a real moment the narration does not connect forward (weak_raw_to_narrator_handoff). Report only what you actually experience while watching, with its output-time region.
8. HOOK PROMISE: hookPromiseResolved true ONLY if the actual video pays off its opening promise, or ends with a clearly named in-scope forward consequence. A suspenseful cold-open from the future that is never explained is NOT a payoff. Supply hookPromiseEvidence.payoffOutputSec (0 when missing) and observedPayoff describing what is really seen/heard.
9. CONTINUOUS MP4 REVIEW: observationWindows must cover EVERY output second from 0 to the exact MP4 duration without gaps. Divide the video into consecutive 5-8 second windows (last may be shorter). For each window report observed action and new information, meaningfulProgress (not just different camera/angle), causalConnectionClear and unexplainedAudioGap (true only for silence that harms comprehension, not intentional suspense). All output-time windows are mandatory. Do not infer evidence from the EDL; inspect the actual video. A long repetitive stretch must be marked without progress.
10. observedStory: 2-3 sentences on the story as a viewer experiences it. summary: one sentence.
Return JSON only.`;
}

function validateObservationCoverage(windows, durationSec) {
  if (!Array.isArray(windows) || !windows.length) return 'Critic omitted observationWindows.';
  let cursor = 0;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i], s = Number(w?.windowStartSec), e = Number(w?.windowEndSec);
    if (!Number.isFinite(s) || !Number.isFinite(e) || Math.abs(s - cursor) > 0.65 || e <= s || e - s > 9.5) {
      return 'observationWindows[' + i + '] has a gap, overlap, invalid range, or exceeds 9.5s.';
    }
    if (!String(w.observedAction || '').trim() || !String(w.observedNewInformation || '').trim() ||
      typeof w.meaningfulProgress !== 'boolean' || typeof w.causalConnectionClear !== 'boolean' ||
      typeof w.unexplainedAudioGap !== 'boolean') return 'observationWindows[' + i + '] lacks observations/verdicts.';
    cursor = e;
  }
  if (Math.abs(cursor - durationSec) > 0.65) return 'observationWindows do not reach the actual MP4 ending.';
  return null;
}

function normalizeCritique(raw, { durationSec, timeline, deliveryAware = false }) {
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
  if (deliveryAware && typeof raw.hookPromiseResolved !== 'boolean') return invalid('Missing hookPromiseResolved.');
  if (deliveryAware && (!raw.hookPromiseEvidence || !Number.isFinite(Number(raw.hookPromiseEvidence.payoffOutputSec)) ||
    !String(raw.hookPromiseEvidence.observedPayoff || '').trim())) return invalid('Missing observed hook payoff evidence.');
  if (deliveryAware && raw.hookPromiseResolved && (raw.hookPromiseEvidence.payoffOutputSec < 0 ||
    raw.hookPromiseEvidence.payoffOutputSec > durationSec + 0.65)) return invalid('Hook payoff timestamp outside rendered MP4.');
  const coverageFailure = deliveryAware ? validateObservationCoverage(raw.observationWindows, durationSec) : null;
  if (coverageFailure) return invalid(coverageFailure);
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
  // Independently derive actionable failures from the mandatory FULL video timeline.
  if (deliveryAware) {
    let stalled = null;
    for (const w of raw.observationWindows) {
      const start = Number(w.windowStartSec), end = Number(w.windowEndSec);
      if (!w.causalConnectionClear) {
        issues.push({ type: 'causal_break', severity: 'blocking', outputStartSec: start, outputEndSec: end,
          evidence: w.observedAction, whyItFails: 'Cold viewer cannot follow this section.', beatIds: beatsInRegion(timeline, start, end) });
      }
      if (w.unexplainedAudioGap && end - start >= 3) {
        issues.push({ type: 'audio_gap_unexplained', severity: 'blocking', outputStartSec: start, outputEndSec: end,
          evidence: w.observedAction, whyItFails: 'Unexplained audio absence damages comprehension.', beatIds: beatsInRegion(timeline, start, end) });
      }
      if (!w.meaningfulProgress) stalled ??= start;
      else if (stalled !== null) {
        if (start - stalled >= 10) issues.push({ type: 'low_value_stretch', severity: 'blocking',
          outputStartSec: stalled, outputEndSec: start, evidence: 'Consecutive observed windows without meaningful progress.',
          whyItFails: 'Extended stalled passage loses momentum.', beatIds: beatsInRegion(timeline, stalled, start) });
        stalled = null;
      }
    }
    if (stalled !== null && durationSec - stalled >= 10) {
      issues.push({ type: 'low_value_stretch', severity: 'blocking', outputStartSec: stalled, outputEndSec: durationSec,
        evidence: 'Video ends in a prolonged stalled passage.', whyItFails: 'Closing passage does not progress the story.',
        beatIds: beatsInRegion(timeline, stalled, durationSec) });
    }
    if (!raw.hookPromiseResolved) {
      const start = Math.max(0, durationSec - 12);
      issues.push({ type: 'hook_promise_unresolved', severity: 'blocking', outputStartSec: start, outputEndSec: durationSec,
        evidence: raw.hookPromiseEvidence.observedPayoff, whyItFails: 'The rendered video never fulfills the opening promise.',
        beatIds: beatsInRegion(timeline, start, durationSec) });
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
    && (!deliveryAware || raw.hookPromiseResolved) && blocking.length === 0;
  const weakRegions = blocking.map(x => ({ type: x.type, outputStartSec: x.outputStartSec, outputEndSec: x.outputEndSec, beatIds: x.beatIds, reason: x.whyItFails, evidence: x.evidence,
    ...(DELIVERY_ISSUES.has(x.type) ? { deliveryIssue: true } : {}) }));
  return {
    status: 'SCOPED_MEDIA_CRITIC_OK', critic: 'scope-media-critic-v1', isCompliant,
    scopeSurvived: raw.scopeSurvived, centralQuestionActiveThroughout: raw.centralQuestionActiveThroughout,
    endingIsConsequence: raw.endingIsConsequenceOfCentralConflict, finalFootageUsable: verdict.finalFootageUsable,
    finalFootageUsableReported: raw.finalFootageUsable, finalSeconds: raw.finalSeconds || null,
    openingCuriosity: raw.openingCuriosity || null, transitions,
    hookPromiseResolved: raw.hookPromiseResolved ?? null, hookPromiseEvidence: raw.hookPromiseEvidence || null,
    observationWindows: Array.isArray(raw.observationWindows) ? raw.observationWindows : [],
    observedStory: raw.observedStory || '', summary: raw.summary || '', issues, weakRegions,
    coldViewerCanFollow: verdict.coldViewerCanFollow, coldViewerCanFollowReported: typeof raw.coldViewerCanFollow === 'boolean' ? raw.coldViewerCanFollow : null, coldViewerNotes: raw.coldViewerNotes || '',
    deliveryIssues: issues.filter(x => DELIVERY_ISSUES.has(x.type)),
    // Envelope fields the V4 review-state writer already persists.
    weakWindows: weakRegions, mp4Duration: durationSec, criticObservedScore: null, averageRetentionScore: null,
    outputTimeline: timeline
  };
}

async function critiqueScopedRender(spine = {}, { aiService, mp4Path, actualMp4DurationSec, script = null, runReview = null } = {}) {
  if (!aiService || !mp4Path || !actualMp4DurationSec) throw new Error('Scope media critic requires aiService, mp4Path, and actualMp4DurationSec');
  const timeline = outputTimeline(spine, script);
  const delivery = deliveryTimeline(spine, script, timeline);
  // Beat -> delivery block in output time, so repair can target the block.
  if (delivery) timeline.forEach(t => { const d = delivery.find(x => (x.beatIds || []).includes(t.beatId)); if (d) { t.deliveryBlockId = d.blockId; t.deliveryMode = d.mode; } });
  const prompt = buildPrompt(spine, timeline, actualMp4DurationSec, delivery);
  let raw;
  try {
    const args = { filePaths: [mp4Path], prompt, responseSchema, taskType: 'auto_story_review', videoFps: 2,
      maxOutputTokens: 12000, temperature: 0 };
    raw = typeof runReview === 'function' ? await runReview(args) : await aiService.generateJsonFromFiles(args);
  } catch (error) {
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

module.exports = { ISSUE_TYPES, DELIVERY_ISSUES, responseSchema, validateObservationCoverage, outputTimeline, deliveryTimeline, beatsInRegion, buildPrompt, normalizeCritique, critiqueScopedRender };
