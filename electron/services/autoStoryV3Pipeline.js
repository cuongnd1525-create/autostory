// AutoStory v3 orchestrator (Phases 0-6). Gated behind autoStoryContractVersion===3.
// Reuses the v2 Engine primitives, the Highlight renderer contract, measured
// voice-fit, and the deterministic v3 modules. Never runs unless explicitly
// selected, so v2 is untouched.
//
// Flow: source model (once, cached) -> story design (text) -> deterministic beat
// casting -> deterministic audio-role -> narration (info-gap only) -> BLOCKING
// narration gate + targeted repair -> compile -> Highlight render contract.

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Engine, initialize, write } = require('./autoStorySourceEngine');
const compiler = require('./autoStoryTimelineCompiler');
const Legacy = require('./autoStoryPipelineService');
const Dubbing = require('./dubbingService');
const V3 = require('./autoStoryV3Contracts');
const sourceModel = require('./sourceStoryModelService');
const { castBeats } = require('./beatCastingService');
const { augmentCoverage, computeEditorialMetrics } = require('./beatCoverageService');
const { decideAudioRole } = require('./audioRoleStateMachine');
const narrationGate = require('./narrationGate');
const audioClassifier = require('./autoStoryAudioClassifier');
const { compileV3, highlightV3 } = require('./autoStoryV3Compile');
const durationFit = require('./autoStoryDurationFit');
const audioEvents = require('./audioEventService');
const { StoryError } = require('./autoStoryRepairRouter');
const { planRetentionArc } = require('./retentionArcPlanService');
const { validateEdlQuality } = require('./edlQualityValidator');

const SETUP_FUNCTIONS = new Set(['FORESHADOW', 'CONTEXT', 'IDENTITY', 'TIME_JUMP', 'LOCATION_CHANGE', 'CLARIFICATION']);
const HIGH_IMPACT_ROLES = new Set(['confrontation', 'apprehension', 'reveal', 'reversal', 'pursuit', 'complication']);
const round1 = n => Math.round((Number(n) || 0) * 10) / 10;

// ---- Text-only pass validation (Story Design, Narration) ----
// These passes send NO video — they operate purely on the already-verified
// Source Story Model text. They therefore validate (a) that the required
// structured TEXT input exists and (b) that the output schema is well-formed.
// They must NEVER require media-access confirmation (accessGranted): gating a
// text-only response on it is the stale-validator bug that rejected a fully
// successful v3-story-design response with "AI chưa xác minh truy cập input".
// Media-access verification stays where it belongs — the multimodal Source Story
// Model pass (sourceStoryModelService), which is unchanged.
function assertStoryModelInput(model) {
  if (!model || !Array.isArray(model.events) || model.events.length === 0)
    throw new StoryError('INPUT_MISSING', 'v3: Story Design requires a Source Story Model with at least one event.');
}
function validateStoryDesign(v) {
  if (!v || !Array.isArray(v.spines) || !v.spines.length) throw new StoryError('INVALID_RESPONSE', 'No story spines.');
  return v;
}
// A spine is USABLE downstream only if it has beats to cast. Prefer spines the model
// marked strong, but if it only returned weak-but-complete spines, use them (best
// effort) rather than discarding real work — the empty case is what triggers repair.
function completeSpines(design) {
  return (design?.spines || []).filter(s => s && Array.isArray(s.beats) && s.beats.length > 0);
}
function chooseSpines(design) {
  const complete = completeSpines(design);
  const strong = complete.filter(s => s.strongEnough !== false);
  return strong.length ? strong : complete;
}
const STORY_DESIGN_REPAIR = `REPAIR — your previous Story Design returned NO usable story spine (empty or beat-less). The supplied Source Story Model contains meaningful state-changing events, so a story IS possible. You MUST set accessGranted=true and return at least ONE complete spine that satisfies the schema: a centralViewerQuestion, a hookPromise, an informationBudget, and an ordered beats array (each beat naming a real sourceEventId from the model). Do NOT return an empty spines array, do NOT set accessGranted=false, and do NOT return a spine with no beats. Prefer the single strongest story.`;

// Story Design with raw/normalized/metadata persistence BEFORE validation and ONE
// bounded, text-only targeted repair. Evaluates EDL quality guardrails (teaser borrow budget,
// compact cold-open, micro-beats, strict chronology, and strong cliffhanger).
// Never fabricates or heuristically alters the EDL; Gemini owns the timeline 100%.
async function buildStoryDesign(engine, model, root, emit, externalRepairInstruction = null, currentSpine = null) {
  assertStoryModelInput(model);
  const metaOf = () => {
    const m = engine.service?.vertex?.lastResponseMetadata || {}; const u = m.usage || {};
    return { finishReason: m.finishReason || '', requestedMaxOutputTokens: m.requestedMaxOutputTokens ?? null,
      requestedThinkingBudget: m.requestedThinkingBudget ?? null, promptTokenCount: u.promptTokenCount ?? null,
      candidatesTokenCount: u.candidatesTokenCount ?? null, thoughtsTokenCount: u.thoughtsTokenCount ?? null,
      totalTokenCount: u.totalTokenCount ?? null };
  };
  const runOnce = async (customRepairInstruction) => {
    customRepairInstruction = customRepairInstruction || externalRepairInstruction;
    let formattedInstruction = '';
    if (customRepairInstruction) {
      if (currentSpine) {
        formattedInstruction = `TARGETED STRUCTURAL REPAIR DIRECTIVE FROM MEDIA-GROUNDED CRITIC:
Return a COMPLETE repaired spine, but change ONLY beats necessary to resolve the specified media-critic failure.
Preserve all unaffected beats exactly unless transition continuity requires a specific adjacent change.

CURRENT SPINE TO REPAIR:
${JSON.stringify(currentSpine, null, 2)}

REPAIR SPECIFICATION:
${typeof customRepairInstruction === 'string' ? customRepairInstruction : JSON.stringify(customRepairInstruction, null, 2)}`;
      } else {
        formattedInstruction = typeof customRepairInstruction === 'string'
          ? customRepairInstruction
          : JSON.stringify(customRepairInstruction, null, 2);
      }
    }
    const instruction = customRepairInstruction
      ? `${V3.instructions.storyDesign}\n\n${formattedInstruction}`
      : V3.instructions.storyDesign;
    let value = null, raw = null, error = null;
    const inputData = {
      model,
      targetDurationMinSec: engine.config.targetDurationMinSec || 70,
      targetDurationMaxSec: engine.config.targetDurationMaxSec || 90,
      storyMode: 'serialized_part',
      ...(customRepairInstruction ? { repairSpecification: customRepairInstruction } : {}),
      ...(currentSpine ? { currentSpine } : {})
    };
    try {
      value = await engine.ask(
        `v3-story-design${customRepairInstruction ? '_repair' : ''}`,
        inputData,
        V3.schemas.storyDesign,
        instruction,
        [],
        validateStoryDesign,
        'auto_story_edit',
        customRepairInstruction ? { noCache: true } : {}
      );
      raw = value;
    } catch (e) { error = e; raw = (e && e.invalidArtifact) || null; }
    return { value, raw, error, metadata: metaOf() };
  };
  const persist = async (attempt, r, usableCount, qualityReport) => {
    const suffix = attempt === 0 ? '' : '-repair';
    await write(path.join(root, `v3-story-design${suffix}-raw.json`), r.raw ?? { error: r.error?.message || 'no response captured' });
    await write(path.join(root, `v3-story-design${suffix}-request-metadata.json`), r.metadata);
    await write(path.join(root, `v3-story-design${suffix}-normalized.json`), {
      topLevelKeys: r.raw && typeof r.raw === 'object' ? Object.keys(r.raw) : [],
      spineCount: Array.isArray(r.raw?.spines) ? r.raw.spines.length : null,
      completeSpineCount: completeSpines(r.raw).length, usableSpineCount: usableCount,
      error: r.error?.message || null, repaired: attempt > 0,
      qualityValid: qualityReport?.valid ?? null,
      violations: qualityReport?.violations || []
    });
    if (qualityReport) {
      await write(path.join(root, 'edl-quality-report.json'), qualityReport);
    }
  };

  const targetMin = engine.config.targetDurationMinSec || 65;
  const targetMax = engine.config.targetDurationMaxSec || 90;
  const valOpts = { minTimelineDurationSec: targetMin, maxTimelineDurationSec: targetMax };

  const first = await runOnce(null);
  let usable = chooseSpines(first.value || first.raw);
  let firstQuality = usable.length ? validateEdlQuality(usable[0], valOpts) : { valid: false, violations: [{ code: 'EMPTY_SPINE', message: 'No usable spine generated.' }] };
  await persist(0, first, usable.length, firstQuality);

  if (usable.length && firstQuality.valid) {
    emit('design', `[V3] Story Design completed — 1 spine passing all EDL retention & quality checks.`, 40);
    return usable;
  }

  // Construct targeted repair prompt with exact violations
  let repairPrompt = STORY_DESIGN_REPAIR;

  if (usable.length && !firstQuality.valid) {
    const criticHeader = externalRepairInstruction
      ? `TARGETED STRUCTURAL REPAIR DIRECTIVE FROM MEDIA-GROUNDED CRITIC:\n${typeof externalRepairInstruction === 'string' ? externalRepairInstruction : JSON.stringify(externalRepairInstruction, null, 2)}\n\n`
      : '';
    repairPrompt = `${criticHeader}TARGETED EDL QUALITY REPAIR PASS — Your previous EDL contained critical retention/pacing defects that MUST be resolved:
VIOLATIONS DETECTED BY GUARDRAIL:
${firstQuality.violations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`).join('\n')}

CURRENT METRICS FROM YOUR PREVIOUS ATTEMPT:
- Total timeline duration: ${firstQuality.metrics?.totalTimelineDuration?.toFixed(1) || '?'}s (Target budget: ${targetMin}s to ${targetMax}s)
- Teaser duration: ${firstQuality.metrics?.teaserDuration?.toFixed(1) || '?'}s (Target: 7s - 12s across 3 beats if teaser archetype, 0s if forward escalation)
- Teaser-to-main overlap: ${firstQuality.metrics?.teaserToMainSourceOverlapSeconds?.toFixed(1) || '?'}s (Budget: <= 3.0s)
- Max beat duration: ${firstQuality.metrics?.maxMacroBeatDuration?.toFixed(1) || '?'}s (Ceiling: <= 7.0s)
- Unanchored backward jumps: ${firstQuality.metrics?.unanchoredBackwardJumpCount || 0} (Must be 0)
- Same visual state run: ${firstQuality.metrics?.sameVisualStateRunSec?.toFixed(1) || '?'}s (Must be <= 12.0s)

MANDATORY EDITORIAL REPAIR ACTIONS:
1. TOTAL DURATION BUDGET (${targetMin}s to ${targetMax}s, target 74-82s): Output between 13 and 16 micro-beats of 3.5-6.5s each. Do NOT output an under-duration timeline (< ${targetMin}s) and do NOT exceed ${targetMax}s!
2. ZERO MACRO-BEATS (HARD CEILING 7.0s): EVERY single beat MUST have (sourceEndSec - sourceStartSec) <= 7.0s! If an event or quote in the model spans 15s to 55s, choose ONLY a 4-6s sub-window. NEVER copy a 20s+ event verbatim!
3. ZERO TEASER REPLAY AFTER REWIND: Any range shown in the teaser MUST NOT be replayed in post-rewind main story. Total overlap must be <= 3.0s (target 0s)! The post-rewind story must feature unshown footage from the source model.
4. STRICT FORWARD CHRONOLOGY & ANTI-PLATEAU NOVELTY: Chronological beats must strictly advance forward in source time without unanchored backward jumps (sourceStartSec_i >= sourceEndSec_{i-1} - 0.5s). Max run in any single visual state is 12.0s! Forbid consecutive beats of repetitive talking or deflection. Alternate perspectives (officer physical actions, suspect statements, evidence inspection, bystander/victim statements).
5. COMPACT COLD-OPEN: If using a teaser, exactly 3 rapid beats totaling 7-10s, cutting after 2-3s of partial reveal before full resolution.
6. CONCRETE CLIFFHANGER: Final beat must have narrativeRole: 'cliffhanger', payoffTiming: 'part_2', concrete specific fact, consequenceMagnitude ('charges'|'arrest'|'violence'|'evidence_found'|'confession'), and no arrest/transport spoiler.

Return the repaired complete spine satisfying all constraints.`;
  }

  emit('design', `[V3] Story Design requires repair (${firstQuality.violations.length ? firstQuality.violations.map(v => v.code).join(', ') : 'schema/empty'}); one targeted AI repair pass.`, 'WARNING');
  let second = await runOnce(repairPrompt);
  usable = chooseSpines(second.value || second.raw);
  let secondQuality = usable.length ? validateEdlQuality(usable[0], valOpts) : { valid: false, violations: [{ code: 'EMPTY_SPINE', message: 'No usable spine after repair.' }] };
  await persist(1, second, usable.length, secondQuality);

  let currentAttempt = 1;
  let currentSpineQuality = secondQuality;
  let currentResponse = second;

  while (currentAttempt < 2 && usable.length && !currentSpineQuality.valid) {
    currentAttempt++;
    const remainingViolations = currentSpineQuality.violations;
    const secondRepairPrompt = `TARGETED EDL QUALITY REPAIR PASS #${currentAttempt} — Remaining defect(s) MUST be fixed:
VIOLATIONS TO RESOLVE:
${remainingViolations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`).join('\n')}

INSTRUCTIONS:
${remainingViolations.map(v => {
  if (v.code === 'UNANCHORED_BACKWARD_JUMP') {
    return `- Fix beat '${v.beatId}': Ensure sourceStartSec >= previous beat's sourceEndSec! Remove or advance the backwards clip so time strictly moves forward.`;
  }
  if (v.code === 'TOTAL_DURATION_UNDER_MIN' || v.code === 'TOTAL_DURATION_OVER_MAX') {
    return `- Adjust total duration to fall strictly within ${targetMin}-${targetMax}s (target 74-82s) across 13-16 beats.`;
  }
  if (v.code === 'MACRO_BEAT_EXCEEDS_MAX') {
    return `- Trim beat '${v.beatId}' to <= 7.0s duration!`;
  }
  if (v.code === 'LARGE_TEASER_MAIN_OVERLAP') {
    return `- Eliminate any teaser overlap after rewind (total overlap must be <= 3.0s, target 0s).`;
  }
  if (v.code === 'VISUAL_STATE_COLLAPSE') {
    return `- Consecutive run in same visual state exceeds 12.0s! Switch to officer physical actions, physical evidence discovery, or witness/victim testimony from unused moments in the source model.`;
  }
  if (v.code === 'STATIC_SPEAKER_PLATEAU') {
    return `- Do not string together consecutive beats of the same speaker repeating claims. Alternate with physical action or visual reveals.`;
  }
  if (v.code === 'SEMANTIC_REPETITION_COLLAPSE') {
    return `- At most 1 beat of suspect excuses. Replace repeated excuses with physical actions or concrete contradictory facts.`;
  }
  if (v.code === 'WEAK_CLIFFHANGER') {
    return `- Provide concrete cliffhanger with narrativeRole: 'cliffhanger', payoffTiming: 'part_2', specificNewFact, consequenceMagnitude ('charges'|'arrest'|'violence'|'evidence_found'|'confession'), and unresolvedConsequence, without spoiling the arrest.`;
  }
  return `- Resolve violation ${v.code} according to schema constraints.`;
}).join('\n')}

Return the repaired complete spine satisfying all constraints.`;

    emit('design', `[V3] Story Design performing targeted AI repair pass #${currentAttempt} for remaining notice(s): ${remainingViolations.map(v => v.code).join(', ')}.`, 'WARNING');
    currentResponse = await runOnce(secondRepairPrompt);
    usable = chooseSpines(currentResponse.value || currentResponse.raw);
    currentSpineQuality = usable.length ? validateEdlQuality(usable[0], valOpts) : { valid: false, violations: [{ code: 'EMPTY_SPINE', message: 'No usable spine after repair.' }] };
    await persist(currentAttempt, currentResponse, usable.length, currentSpineQuality);
  }

  if (usable.length) {
    if (currentSpineQuality.valid) {
      emit('design', `[V3] Story Design recovered via targeted EDL repair — all quality checks passed.`, 40);
    } else {
      emit('design', `[V3] Story Design repaired (${currentSpineQuality.violations.length} remaining notices: ${currentSpineQuality.violations.map(v => v.code).join(', ')}). Proceeding with AI EDL.`, 'WARNING');
    }
    return usable;
  }

  throw new StoryError('STORY_DESIGN_INVALID',
    `Story Design returned no usable spine after repair passes (first: ${first.error?.message || 'empty/beat-less'}; retry: ${currentResponse.error?.message || 'empty/beat-less'}). Raw responses persisted (v3-story-design*-raw.json).`);
}
function validateNarration(v) {
  if (!v || !Array.isArray(v.narrations)) throw new StoryError('INVALID_RESPONSE', 'Missing narrations.');
  return v;
}

async function sourceHashOf(file, signal) {
  return new Promise((resolve, reject) => {
    const stream = require('fs').createReadStream(file, { signal });
    const h = crypto.createHash('sha256');
    stream.on('data', b => h.update(b)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function eventHasAudioEvent(ev, evs) {
  return (evs || []).some(ae => {
    const s = Number(ae.startSec), e = Number.isFinite(ae.endSec) ? ae.endSec : s;
    return Number.isFinite(s) && s <= ev.sourceEndSec && e >= ev.sourceStartSec && Number(ae.peak) >= 0.75;
  });
}

// Deterministic audio-role assignment for every cast beat.
function assignAudioRoles(beats, model, config) {
  return beats.map(beat => {
    // If Gemini Editorial Director explicitly assigned audioMode, honor it directly
    if (beat.audioMode === 'original_audio') {
      return { ...beat, audioStrategy: 'original', speaks: false, audioRoleReason: 'editorial director explicit original_audio' };
    }
    if (beat.audioMode === 'voiceover_with_ambient') {
      return { ...beat, audioStrategy: 'narrator_over', speaks: true, audioRoleReason: 'editorial director explicit voiceover_with_ambient' };
    }
    if (beat.audioMode === 'voiceover_only') {
      return { ...beat, audioStrategy: 'voiceover_only', speaks: true, audioRoleReason: 'editorial director explicit voiceover_only' };
    }

    const disposition = audioClassifier.disposition({ audioType: beat.audioType, confidence: beat.audioConfidence });
    const highImpactRole = HIGH_IMPACT_ROLES.has(beat.narrativeRole);
    const wants = beat.wantsNarration === true && (beat.newInformation?.length || SETUP_FUNCTIONS.has(beat.narratorFunction));
    const decision = decideAudioRole({
      tension: beat.tension,
      audioEvent: eventHasAudioEvent(beat, model.audioEvents),
      highImpactRole,
      infoGapEmpty: !wants,
      needsSetupBefore: wants && SETUP_FUNCTIONS.has(beat.narratorFunction) && !highImpactRole,
      audioDisposition: disposition,
      narrationEnabled: config.narration.enabled
    });
    return { ...beat, audioStrategy: decision.strategy, speaks: decision.speak, audioRoleReason: decision.reason };
  });
}

// Per-beat safeWords budget from measured voice speed.
function safeWordsFor(beat, config) {
  return compiler.budget(Math.max(0, beat.sourceEndSec - beat.sourceStartSec), config.narration.measuredWordsPerSecond);
}
function isOverflow(beat, config) {
  return beat.speaks && compiler.words(beat.narratorText || '') > safeWordsFor(beat, config);
}

// Pass 3 — narration for speaking beats only, with per-beat safeWords budgets.
// NOTE: overflow is NOT fatal here. A narration line that exceeds its safeWords
// budget is handled downstream by enforceSafeWords (targeted rewrite -> demote),
// so a single overlong line can never abort the whole script.
async function writeNarration(engine, story, model, speakingBeats, evidence, repair = false) {
  if (!speakingBeats.length) return new Map();
  const budgets = speakingBeats.map(b => {
    const seconds = Math.max(0, b.sourceEndSec - b.sourceStartSec);
    return { beatId: b.beatId, sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec,
      narratorFunction: b.narratorFunction, viewerQuestion: b.viewerQuestion,
      plannedNewInformation: b.newInformation || [], availableVisualSec: seconds,
      safeWords: compiler.budget(seconds, engine.config.narration.measuredWordsPerSecond) };
  });
  const instruction = repair
    ? `${V3.instructions.narration}\nREWRITE (SHORTEN): The previous narration for these beats exceeded its safeWords ceiling. Return a SHORTER complete thought for each beat, at or under safeWords, preserving the essential fact/handoff. Never exceed safeWords.`
    : V3.instructions.narration;
  const result = await engine.ask(
    `v3-narration${repair ? '_repair' : ''}-${story.scriptId}`,
    { spine: { centralViewerQuestion: story.centralViewerQuestion, hookPromise: story.hookPromise },
      beats: budgets, quotes: model.quotes, events: model.events.map(e => ({ id: e.id, summary: e.summary, isReveal: e.isReveal })),
      repair },
    V3.schemas.narration, instruction, evidence,
    validateNarration, 'auto_story_edit');
  return new Map(result.narrations.map(n => [n.beatId, n]));
}

// Bug-1 fix: enforce safeWords with targeted AI rewrite (<=2) then demote.
// repairFn(overBeats, budgets, attempt) -> [{beatId, voiceoverText, previewVi}].
// Local truncation is intentionally NOT used; an unfixable beat becomes original audio.
async function enforceSafeWords(beats, config, repairFn) {
  let current = beats;
  for (let attempt = 0; attempt < 2; attempt++) {
    const over = current.filter(b => isOverflow(b, config));
    if (!over.length) break;
    let repaired = [];
    try {
      repaired = await repairFn(over, over.map(b => ({ beatId: b.beatId, safeWords: safeWordsFor(b, config) })), attempt) || [];
    } catch (_) { repaired = []; }
    const map = new Map(repaired.filter(r => r && r.beatId).map(r => [r.beatId, r]));
    current = current.map(b => map.has(b.beatId)
      ? { ...b, narratorText: map.get(b.beatId).voiceoverText || '', previewVi: map.get(b.beatId).previewVi || b.previewVi }
      : b);
  }
  return demoteOverflow(current, config);
}

// Final safety net: any beat still over budget becomes original audio (0 words fits).
function demoteOverflow(beats, config) {
  return beats.map(b => isOverflow(b, config)
    ? { ...b, speaks: false, audioStrategy: 'original', narratorText: '', previewVi: '' }
    : b);
}

function applyNarration(beats, lines) {
  return beats.map(b => {
    if (!b.speaks) return { ...b, narratorText: '', audioStrategy: 'original', speaks: false };
    const line = lines.get(b.beatId);
    if (!line || !line.voiceoverText?.trim()) return { ...b, narratorText: '', audioStrategy: 'original', speaks: false };
    return { ...b, narratorText: line.voiceoverText, previewVi: line.previewVi || '',
      narratorFunction: line.narratorFunction || b.narratorFunction,
      newInformation: line.newInformation?.length ? line.newInformation : b.newInformation,
      newInformationRefs: line.newInformationRefs?.length ? line.newInformationRefs : b.newInformationRefs,
      emotionTag: line.emotionTag || b.emotionTag || 'NEUTRAL' };
  });
}

// Demote beats the gate rejected to original audio (safe fallback) so a bad
// narration line never blocks the whole render; only affected beats change.
function demote(beats, beatIds) {
  const set = new Set(beatIds);
  return beats.map(b => set.has(b.beatId) ? { ...b, speaks: false, audioStrategy: 'original', narratorText: '' } : b);
}

async function buildScript(engine, service, opts, story, model, root, emit = () => {}) {
  // Retention Arc Plan (Phase 3-6): translates Story Design into a structured retention arc
  const retentionArc = planRetentionArc(story, model, engine.config, opts);
  await write(path.join(root, `retention-arc-${story.scriptId}.json`), retentionArc);
  emit('editing', `[V3] Retention Arc Plan compiled (${retentionArc.beats.length} beats, ${retentionArc.openLoops.length} loops) for script ${story.scriptId}`);

  // Deterministic casting over the shared model using the retention arc beats
  const cast = castBeats(retentionArc.beats, model, { preferContinuity: retentionArc.isSerialized });
  let beats = cast.beats.filter(b => !b.unresolved);
  if (beats.length < 2) throw new StoryError('BAD_CANDIDATE', 'Not enough castable beats for this story.');

  // Coverage augmentation (deterministic, no Vertex): if casting produced a
  // structurally thin timeline (e.g. 16.8s of one scene for a 65s target), pull
  // in the highest-novelty UNUSED events as distinct scenes BEFORE narration, so
  // Duration Fit fine-tunes instead of stretching one clip. No-op when healthy.
  const coverage = augmentCoverage(beats, model, engine.config);
  if (coverage.augmented) {
    beats = coverage.beats;
    emit('editing', `[V3] Coverage: base=${coverage.base.toFixed(1)}s (${coverage.distinctBefore} distinct) -> ${coverage.after.toFixed(1)}s via +${coverage.added} distinct scene(s) for script ${story.scriptId}`);
  } else if (coverage.structural) {
    emit('editing', `[V3] Coverage: structural deficit but ${coverage.reason} (script ${story.scriptId})`);
  }
  emit('editing', `[V3] Beat Casting completed (${beats.length} beats) for script ${story.scriptId}`);
  beats = assignAudioRoles(beats, model, engine.config);
  emit('editing', `[V3] Audio roles planned for script ${story.scriptId}`);

  // Evidence for the chosen ranges (reuses the v2 media prep).
  const ranges = beats.map(b => ({ sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec }));
  let evidence = await engine.prepare(ranges, 2);

  // Narration pass (info-gap only), then BLOCKING gate + up to 2 targeted repairs.
  let lines = await writeNarration(engine, story, model, beats.filter(b => b.speaks), evidence);
  beats = applyNarration(beats, lines);
  emit('editing', `[V3] Narration generated for script ${story.scriptId}`);

  // Bug-1 fix: overlong narration is repaired per-beat (<=2 targeted rewrites),
  // then demoted to original audio — never fatal to the whole script.
  const beforeSafe = beats.filter(b => b.speaks).length;
  beats = await enforceSafeWords(beats, engine.config, async (over) => {
    const relines = await writeNarration(engine, story, model, over, evidence, true);
    return over.map(b => { const l = relines.get(b.beatId); return { beatId: b.beatId, voiceoverText: l?.voiceoverText || '', previewVi: l?.previewVi }; });
  });
  const afterSafe = beats.filter(b => b.speaks).length;
  if (afterSafe < beforeSafe) emit('editing', `[V3] safeWords fit: demoted ${beforeSafe - afterSafe} overlong beat(s) to original audio (script ${story.scriptId})`);

  let gateReport = narrationGate.inspect(beats.map((b, i) => ({ ...b, order: i, audioIntent: b.speaks ? 'narration' : 'original' })), model);
  for (let attempt = 0; attempt < 2 && !gateReport.passed; attempt++) {
    const repairIds = new Set(gateReport.repairBeatIds);
    const toFix = beats.filter(b => repairIds.has(b.beatId) && b.speaks);
    if (!toFix.length) break;
    try {
      lines = await writeNarration(engine, story, model, toFix, evidence);
      beats = applyNarration(beats, lines);
    } catch (_) { /* fall through to demotion */ }
    gateReport = narrationGate.inspect(beats.map((b, i) => ({ ...b, order: i, audioIntent: b.speaks ? 'narration' : 'original' })), model);
    if (!gateReport.passed) beats = demote(beats, gateReport.repairBeatIds);
    gateReport = narrationGate.inspect(beats.map((b, i) => ({ ...b, order: i, audioIntent: b.speaks ? 'narration' : 'original' })), model);
  }
  emit('editing', `[V3] Narration gates ${gateReport.passed ? 'passed' : `repaired/demoted (${gateReport.repairBeatIds.length})`} for script ${story.scriptId}`);
  // Gate rewrites could reintroduce an overlong line — final demote sweep before compile.
  // NOTE: demotion changes audio mode only, not beat durations, so the timeline
  // length is unchanged here; the Duration Fit stage below still runs regardless.
  beats = demoteOverflow(beats, engine.config);
  await write(path.join(root, `narration-gates-${story.scriptId}.json`), gateReport);

  // Deterministic Duration Fit (before final validation). Observability first.
  const cfg = engine.config;
  const beforeSec = durationFit.timelineSeconds(beats);
  const delta = beforeSec < cfg.targetDurationMinSec
    ? `shortBy=${(cfg.targetDurationMinSec - beforeSec).toFixed(1)}s`
    : beforeSec > cfg.targetDurationMaxSec ? `overBy=${(beforeSec - cfg.targetDurationMaxSec).toFixed(1)}s` : 'in range';
  emit('editing', `[V3] Duration check: actual=${beforeSec.toFixed(1)}s, requested=${cfg.targetDurationMinSec}-${cfg.targetDurationMaxSec}s, ${delta} (script ${story.scriptId})`);
  const fit = durationFit.planDurationFit(beats, { config: cfg, sourceDuration: engine.duration, model });
  if (fit.changed) {
    beats = fit.beats;
    // Ranges moved/added — re-prepare evidence so compile finds a covering clip per beat.
    evidence = await engine.prepare(beats.map(b => ({ sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec })), 2);
    emit('editing', `[V3] Duration fit: ${beforeSec.toFixed(1)}s -> ${fit.actualAfter.toFixed(1)}s via ${fit.operations.map(o => o.op).join('+') || 'no-op'} (script ${story.scriptId})`);
  }
  if (fit.impossible) {
    throw new StoryError('DURATION_FIT',
      `Duration fit failed: actual=${fit.actualAfter.toFixed(1)}s, requested=${cfg.targetDurationMinSec}-${cfg.targetDurationMaxSec}s after ${fit.passes} pass(es).`,
      { actual: fit.actualAfter, min: cfg.targetDurationMinSec, max: cfg.targetDurationMaxSec });
  }

  // Editorial quality metrics (observability + acceptance gate signal). Records
  // whether the timeline is structurally full and varied, or was stretched.
  const metrics = computeEditorialMetrics(beats, model, cfg, { extensionRatio: fit.extensionRatio });
  const editorial = {
    scriptId: story.scriptId,
    coverage: { augmented: coverage.augmented, added: coverage.added, base: round1(coverage.base),
      distinctBefore: coverage.distinctBefore, distinctAfter: coverage.distinctAfter ?? metrics.distinctEvents, reason: coverage.reason },
    durationFit: { changed: fit.changed, actualBefore: round1(fit.actualBefore), actualAfter: round1(fit.actualAfter),
      extensionRatio: fit.extensionRatio, structuralDeficit: fit.structuralDeficit, undercast: fit.undercast,
      operations: fit.operations },
    metrics
  };
  await write(path.join(root, `editorial-metrics-${story.scriptId}.json`), editorial);
  if (metrics.flags.length) emit('editing', `[V3] Editorial flags for script ${story.scriptId}: ${metrics.flags.join(', ')}`);
  emit('editing', `[V3] Editorial: ${metrics.beatCount} beats, ${metrics.distinctEvents} distinct events, ${metrics.distinctLocations} locations, coverageRatio=${metrics.coverageRatio}, maxSameSceneRun=${metrics.maxConsecutiveSameLocation}, extensionRatio=${metrics.extensionRatio} (script ${story.scriptId})`);

  const script = compileV3(beats, {
    story: { scriptId: story.scriptId, title: story.title, centralViewerQuestion: story.centralViewerQuestion,
      spine: story.spine, openLoops: story.openLoops },
    evidence, config: engine.config, sourceDuration: engine.duration
  });
  await write(path.join(root, `beat-casting-${story.scriptId}.json`), { beats, unresolved: cast.unresolved });
  return { script, evidence, editorial };
}

async function run(service, opts) {
  const { root, project: original } = await initialize(service, opts);
  let project = { ...original, draftVoiceMode: 'final' };
  const config = Legacy.normalizeConfig({ ...project.autoStoryConfig, outputCount: project.autoStoryConfig?.outputCount ?? 1 }, project);
  if (project.autoStoryConfig?.targetDurationMinSec) {
    config.targetDurationMinSec = Math.max(30, project.autoStoryConfig.targetDurationMinSec);
  }
  if (project.autoStoryConfig?.targetDurationMaxSec) {
    config.targetDurationMaxSec = Math.max(config.targetDurationMinSec, project.autoStoryConfig.targetDurationMaxSec);
  }
  const update = patch => service.store.updateProject(opts.workspaceRoot, opts.projectId, patch);
  const emit = (stage, message, percent) => opts.onProgress?.({ stage, message, ...(percent === undefined ? {} : { percent }) });

  emit('preprocess', 'v3: đo giọng đọc và nguồn trước khi hiểu toàn bộ video.', 1);
  if (config.narration.enabled) {
    const sample = 'What begins as a routine encounter takes a different turn when the officer asks one simple question.';
    const { meta } = await service.measuredVoice(project, sample, root);
    config.narration.measuredWordsPerSecond = sample.split(/\s+/).length / meta.duration;
  }
  const probe = await service.ffmpeg.probeVideo(project.sourceVideoPath);
  if (!(probe.duration >= config.targetDurationMinSec)) throw new Error('Video nguồn ngắn hơn thời lượng tối thiểu.');

  const identity = await sourceHashOf(project.sourceVideoPath, opts.signal);
  const cache = path.join(opts.workspaceRoot, '.cineviral', 'auto-story-source', identity, 'source-contract-v3');
  await fs.mkdir(cache, { recursive: true });
  const cues = project.subtitleSourcePath
    ? Dubbing.normalizeRollingSubtitleCues(await service.dubbing.readSubtitleSegments(project.subtitleSourcePath))
    : [];
  const MediaIndexer = require('./autoStoryMediaIndexer');
  const mediaIndex = MediaIndexer.index(probe.duration, cues);
  const engine = new Engine(service, { project, root, cache, config, cues, mediaIndex, sourceHash: identity, duration: probe.duration, signal: opts.signal, onProgress: opts.onProgress });

  // v3 sets duck-by-default (Phase 13): source preserved and ducked, not muted.
  project = await update({
    autoStoryContractVersion: 3, autoStoryPipelineVersion: 'source-story-v3',
    autoStoryConfig: { ...project.autoStoryConfig, outputCount: config.outputCount },
    autoStoryEditorialConfig: config, autoStorySourceV3: { identity, cache, duration: probe.duration },
    draftVoiceMode: 'final', showSubtitles: true, narrationLanguage: 'en',
    mixer: { ...project.mixer, sourceVolume: 28, narrationSourceAudioOverride: true, narrationDuckDefault: true },
    videoDecoration: (!original.autoStoryPipelineVersion && !project.videoEditUpdatedAt)
      ? { ...project.videoDecoration, canvasEnabled: true, canvasAspect: '9:16', blurBackgroundEnabled: true }
      : project.videoDecoration
  });
  engine.project = project;

  // Phase 0-2: whole-source understanding (cached), enriched with local audio events.
  emit('understand', '[V3] Source Story Model started — analyzing the whole source once.', 8);
  // CACHE-FIRST: the cache key is sha256(original source) + modelVersion (stable,
  // independent of the prepared proxy), so we can resolve a HIT WITHOUT the
  // multi-minute whole-source media preparation or any Vertex call. Only on a MISS
  // do we prepare the source and extract.
  let model = await sourceModel.loadCached(engine);
  if (model) {
    emit('understand', '[V3] Source Story Model cache HIT — skipping whole-source preparation.', 22);
  } else {
    const detectedAudio = await audioEvents.detect(service, project.sourceVideoPath, probe.duration, opts.signal).catch(() => []);
    const words = await audioEvents.loadWordTimestamps(project).catch(() => []);
    // Overview (whole-source proxy) is prepared LAZILY — chunk-first extraction skips
    // it entirely and prepares only its small per-window clips.
    const prepareOverview = () => engine.prepare([{ sourceStartSec: 0, sourceEndSec: probe.duration }], 0, 4);
    model = await sourceModel.build(engine, prepareOverview, {
      audioEvents: detectedAudio, words,
      schema: V3.schemas.sourceModel, instruction: V3.instructions.sourceModel,
      compactSchema: V3.schemas.compactSourceModel, compactInstruction: V3.instructions.sourceModelCompact,
      chunkSchema: V3.schemas.chunkSourceModel, chunkInstruction: V3.instructions.sourceModelChunk
    });
  }
  emit('understand', `[V3] Source Story Model completed — ${model.events.length} events, ${model.quotes.length} quotes, ${(model.audioEvents || []).length} audio events.`, 25);

  // Phase 4-5: story design (text only; no video re-sent). Persists raw/normalized/
  // metadata, does ONE bounded text-only repair on empty spines, and only then fails.
  emit('design', '[V3] Story Design started (text-only).', 30);
  let spines;
  try {
    spines = await buildStoryDesign(engine, model, root, emit);
  } catch (err) {
    if (err.kind === 'STORY_DESIGN_INVALID' || err.kind === 'INPUT_MISSING') {
      await update({ autoStoryCapacityWarning: `v3: ${err.message}`, autoStoryState: { phase: 'review_failed', failures: [] } });
      const failures = [{ scriptId: 1, kind: err.kind, error: err.message }];
      await write(path.join(root, 'failures.json'), failures);
      emit('failed', `v3 Story Design: ${err.message}`);
      return { project, scriptPaths: [], config, analysisDir: root, failures };
    }
    throw err;
  }
  await write(path.join(root, 'story-spine.json'), { spines });

  const scriptPaths = [], failures = [];
  const chosen = spines.slice(0, config.outputCount);
  for (let i = 0; i < chosen.length; i++) {
    const scriptId = i + 1;
    const story = { ...chosen[i], scriptId, title: chosen[i].hookPromise || `Story ${scriptId}`,
      spine: { centralViewerQuestion: chosen[i].centralViewerQuestion, hookPromise: chosen[i].hookPromise, informationBudget: chosen[i].informationBudget },
      openLoops: chosen[i].openLoops || [] };
    try {
      emit('editing', `[V3] Script ${scriptId}: casting beats, planning audio, writing narration.`, 45 + i * 10);
      const { script, evidence } = await buildScript(engine, service, opts, story, model, root, emit);
      const scriptPath = path.join(root, `script-${scriptId}.json`);
      await write(scriptPath, highlightV3(script, story, evidence));
      scriptPaths.push(scriptPath);
      emit('editing', `[V3] Script ${scriptId} ready — ${script.segments.length} segments compiled.`);
      opts.onScriptReady?.({ scriptId, scriptPath });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      failures.push({ scriptId, kind: error.kind || 'SERVICE_ERROR', error: error.message });
      emit('failed', `v3 Script ${scriptId}: ${error.message}`);
    }
  }

  await write(path.join(root, 'failures.json'), failures);
  project = await update({ storyScriptPaths: scriptPaths, storyScriptPath: scriptPaths[0] || '',
    autoStoryState: { phase: failures.length && !scriptPaths.length ? 'review_failed' : 'ready_to_render', failures } });
  return { project, scriptPaths, config, analysisDir: root, failures };
}


async function auditDrafts(service, opts) {
  const { workspaceRoot, projectId, signal, onProgress, onDraft } = opts;
  const project = await service.store.getProject(workspaceRoot, projectId);
  const root = path.join(service.store.getProjectPaths(workspaceRoot, projectId).analysisDir, "auto-story-fast");
  
  const scriptId = opts.scriptId ? Number(opts.scriptId) : null;

  // Canonical V3 artifacts — never depend on plan.json
  let spineData = null;
  try {
    spineData = JSON.parse(await fs.readFile(path.join(root, 'story-spine.json'), 'utf8'));
  } catch (_) {}
  const spines = Array.isArray(spineData?.spines) ? spineData.spines : (spineData?.beats ? [spineData] : []);

  let targetScriptIds = [];
  if (scriptId) {
    targetScriptIds = [scriptId];
  } else if (Array.isArray(project.analysis?.highlightVariants) && project.analysis.highlightVariants.length > 0) {
    targetScriptIds = project.analysis.highlightVariants.map(v => Number(v.scriptId)).filter(Number.isInteger);
  } else if (spines.length > 0) {
    targetScriptIds = spines.map((s, i) => Number(s.scriptId) || (i + 1));
  } else {
    targetScriptIds = [1];
  }
  targetScriptIds = [...new Set(targetScriptIds)];

  const audits = [];
  const { critiqueMediaGroundedTimeline, generateTargetedRepairSpecification } = require('./structuralCriticService');

  // Bug 6: Use already-configured vertex/ai service from service (never construct new Vertex or read %APPDATA%)
  const ai = service.vertex || service.ai;
  if (!ai) throw new Error('AutoStoryFastService missing configured vertex/ai service.');

  // Bug 4: Canonical source cache from project.autoStorySourceV3
  const sourceCachePath = project.autoStorySourceV3?.cache;
  if (!sourceCachePath) {
    throw new Error('Missing project.autoStorySourceV3.cache; cannot audit/repair V3 draft without source cache.');
  }
  const model = await sourceModel.load(sourceCachePath);
  if (!model || !Array.isArray(model.events)) {
    throw new Error(`Failed to load canonical Source Story Model from ${sourceCachePath}`);
  }

  const engine = new Engine(service, {
    project,
    root,
    cache: sourceCachePath,
    config: project.autoStoryEditorialConfig || project.autoStoryConfig || {},
    signal,
    onProgress,
    duration: project.autoStorySourceV3?.duration || project.analysis?.media?.duration || 0,
    sourceHash: project.autoStorySourceV3?.identity || ''
  });

  for (const id of targetScriptIds) {
    signal?.throwIfAborted();
    const record = path.join(root, `review-state-${id}.json`);

    let variant = project.analysis?.highlightVariants?.find(v => Number(v.scriptId) === id)
      || (project.analysis?.highlightVariants?.length === 1 ? project.analysis.highlightVariants[0] : null);
    if (!variant?.artifacts?.fastDraftVideoPath) continue;
    let currentMp4 = variant.artifacts.fastDraftVideoPath;

    let script = null;
    try {
      script = JSON.parse(await fs.readFile(path.join(root, `script-${id}.json`), 'utf8'));
    } catch (_) {}

    let spine = spines.find(s => Number(s.scriptId) === id) || spines[id - 1] || spines[0] || null;
    if (!spine || !Array.isArray(spine.beats)) spine = script || {};

    let story = {
      ...spine,
      scriptId: id,
      title: spine.hookPromise || spine.title || `Story ${id}`,
      spine: {
        centralViewerQuestion: spine.centralViewerQuestion,
        hookPromise: spine.hookPromise,
        informationBudget: spine.informationBudget
      },
      openLoops: spine.openLoops || []
    };

    let currentSpine = spine;

    // 1. Initial render audit
    const meta = await service.ffmpeg.probeVideo(currentMp4);
    onProgress?.({ stage: 'reviewing', message: `Script ${id}: [V4] Chạy Media-Grounded Critic (Initial)...` });

    let currentCritique = await critiqueMediaGroundedTimeline(currentSpine, {
      aiService: ai,
      mp4Path: currentMp4,
      actualMp4DurationSec: meta.duration,
      targetWindowSec: 5.5
    });

    if (currentCritique.status === 'STRUCTURAL_CRITIC_INCOMPLETE' || currentCritique.status === 'MEDIA_CRITIC_INVALID') {
      console.warn(`[V4] Initial critic returned ${currentCritique.status}. Retrying critic once on same MP4...`);
      currentCritique = await critiqueMediaGroundedTimeline(currentSpine, {
        aiService: ai,
        mp4Path: currentMp4,
        actualMp4DurationSec: meta.duration,
        targetWindowSec: 5.5
      });
    }

    console.log(`[V4] Initial media score: ${currentCritique.criticObservedScore}`);
    if (currentCritique.weakWindows?.length) console.log(`[V4] Weak windows: ${currentCritique.weakWindows.length}`);

    await fs.writeFile(path.join(root, `initial-story-spine-${id}.json`), JSON.stringify(currentSpine, null, 2));
    await fs.writeFile(path.join(root, `initial-media-audit-${id}.json`), JSON.stringify(currentCritique, null, 2));

    if (currentCritique.status === 'STRUCTURAL_CRITIC_INCOMPLETE' || currentCritique.status === 'MEDIA_CRITIC_INVALID') {
      console.error(`[V4] Initial critic retry failed with ${currentCritique.status}. Failing pipeline with MEDIA_CRITIC_FAILED.`);
      const criticFailedAudit = {
        scriptId: id, complete: true, contractVersion: 4, pending: false, needsUserReview: true,
        status: 'MEDIA_CRITIC_FAILED',
        failureType: 'MEDIA_CRITIC_FAILED',
        finalCheck: {
          complete: false,
          verdict: 'FAIL',
          issues: [{ reason: `MEDIA_CRITIC_FAILED: Critic model failed after retry (${currentCritique.status}: ${currentCritique.summary})` }]
        },
        metrics: {
          criticObservedScore: 0,
          averageRetentionScore: 0,
          mp4Duration: meta.duration
        },
        auditResult: currentCritique
      };
      await fs.writeFile(record, JSON.stringify(criticFailedAudit, null, 2));
      audits.push(criticFailedAudit);
      const criticErr = new Error(`MEDIA_CRITIC_FAILED: Critic model failed after retry (${currentCritique.status}: ${currentCritique.summary})`);
      criticErr.code = 'MEDIA_CRITIC_FAILED';
      criticErr.audit = criticFailedAudit;
      throw criticErr;
    }

    if (currentCritique.isCompliant) {
      const passedAudit = {
        scriptId: id, complete: true, contractVersion: 4, pending: false, needsUserReview: false,
        finalCheck: { complete: true, verdict: 'PASS', issues: [] },
        metrics: {
          criticObservedScore: currentCritique.criticObservedScore,
          averageRetentionScore: currentCritique.averageRetentionScore,
          mp4Duration: currentCritique.mp4Duration
        }
      };
      await fs.writeFile(record, JSON.stringify(passedAudit, null, 2));
      audits.push(passedAudit);
      continue;
    }

    // Repair Loop (max 2 passes)
    let repaired = false;
    for (let repairPass = 1; repairPass <= 2; repairPass++) {
      signal?.throwIfAborted();
      console.log(`[V4] Targeted repair pass #${repairPass} started`);
      const repairSpec = generateTargetedRepairSpecification(currentCritique, currentSpine);
      if (!repairSpec) {
        throw new Error(`Media critic non-compliant (status: ${currentCritique.status}, score: ${currentCritique.criticObservedScore}) but no repair specification could be generated.`);
      }
      await fs.writeFile(path.join(root, `repair-${repairPass}-specification-${id}.json`), JSON.stringify(repairSpec, null, 2));

      const emitProgress = (st, msg, pct) => onProgress?.({ stage: st, message: msg, percent: pct });
      const repairedSpines = await buildStoryDesign(engine, model, root, emitProgress, repairSpec, currentSpine);
      if (!repairedSpines || !repairedSpines.length) {
        throw new Error(`Repair pass ${repairPass} failed to produce a repaired spine.`);
      }
      currentSpine = repairedSpines[0];
      await fs.writeFile(path.join(root, `repair-${repairPass}-story-spine-${id}.json`), JSON.stringify(currentSpine, null, 2));

      // Bug 3: Repaired spine itself becomes the story passed to buildScript (no merging old beats)
      const repairedStory = {
        ...currentSpine,
        scriptId: id,
        title: currentSpine.hookPromise || currentSpine.title || story.title || `Story ${id}`,
        spine: {
          centralViewerQuestion: currentSpine.centralViewerQuestion || story.centralViewerQuestion,
          hookPromise: currentSpine.hookPromise || story.hookPromise,
          informationBudget: currentSpine.informationBudget || story.informationBudget
        },
        openLoops: currentSpine.openLoops || story.openLoops || [],
        beats: currentSpine.beats
      };

      const rebuilt = await buildScript(engine, service, opts, repairedStory, model, root, emitProgress);
      const scriptPath = path.join(root, `script-${id}.json`);
      await fs.writeFile(scriptPath, JSON.stringify(highlightV3(rebuilt.script, repairedStory, rebuilt.evidence), null, 2));

      const importedProject = await service.dubbing.importReviewedScriptProject({
        workspaceRoot,
        projectId,
        settings: service.settings,
        jsonPath: scriptPath
      });
      const selectedVariant = importedProject.analysis?.highlightVariants?.find(v => Number(v.scriptId) === id)
        || importedProject.analysis?.highlightVariants?.[0];

      console.log(`[V4] Re-render pass #${repairPass} started`);
      const rendered = await service.dubbing.renderHighlightFastDraft({
        workspaceRoot,
        projectId,
        settings: service.settings,
        project: {
          ...importedProject,
          analysis: {
            ...importedProject.analysis,
            activeVariantId: selectedVariant.id,
            segments: selectedVariant.segments
          }
        },
        onProgress
      });
      currentMp4 = rendered.outputPath || rendered.internalOutputPath || selectedVariant.artifacts?.fastDraftVideoPath;
      onDraft?.(await service.store.getProject(workspaceRoot, projectId));

      // Audit the newly rendered MP4 (each media audit receives MP4 from immediately preceding render)
      const repairMeta = await service.ffmpeg.probeVideo(currentMp4);
      onProgress?.({ stage: 'reviewing', message: `Script ${id}: [V4] Chạy Media-Grounded Critic (Pass ${repairPass})...` });
      currentCritique = await critiqueMediaGroundedTimeline(currentSpine, {
        aiService: ai,
        mp4Path: currentMp4,
        actualMp4DurationSec: repairMeta.duration,
        targetWindowSec: 5.5
      });

      if (currentCritique.status === 'STRUCTURAL_CRITIC_INCOMPLETE' || currentCritique.status === 'MEDIA_CRITIC_INVALID') {
        console.warn(`[V4] Repaired media critic (Pass ${repairPass}) returned ${currentCritique.status}. Retrying critic once on same MP4...`);
        currentCritique = await critiqueMediaGroundedTimeline(currentSpine, {
          aiService: ai,
          mp4Path: currentMp4,
          actualMp4DurationSec: repairMeta.duration,
          targetWindowSec: 5.5
        });
      }

      console.log(`[V4] Repaired media score (Pass ${repairPass}): ${currentCritique.criticObservedScore}`);
      await fs.writeFile(path.join(root, `repair-${repairPass}-media-audit-${id}.json`), JSON.stringify(currentCritique, null, 2));

      if (currentCritique.status === 'STRUCTURAL_CRITIC_INCOMPLETE' || currentCritique.status === 'MEDIA_CRITIC_INVALID') {
        console.error(`[V4] Repaired media critic retry failed with ${currentCritique.status}. Failing pipeline with MEDIA_CRITIC_FAILED.`);
        const criticFailedAudit = {
          scriptId: id, complete: true, contractVersion: 4, pending: false, needsUserReview: true,
          status: 'MEDIA_CRITIC_FAILED',
          failureType: 'MEDIA_CRITIC_FAILED',
          repairPasses: repairPass,
          finalCheck: {
            complete: false,
            verdict: 'FAIL',
            issues: [{ reason: `MEDIA_CRITIC_FAILED: Critic model failed after retry (${currentCritique.status}: ${currentCritique.summary})` }]
          },
          metrics: {
            criticObservedScore: 0,
            averageRetentionScore: 0,
            mp4Duration: repairMeta.duration
          },
          auditResult: currentCritique
        };
        await fs.writeFile(record, JSON.stringify(criticFailedAudit, null, 2));
        audits.push(criticFailedAudit);
        const criticErr = new Error(`MEDIA_CRITIC_FAILED: Critic model failed after retry (${currentCritique.status}: ${currentCritique.summary})`);
        criticErr.code = 'MEDIA_CRITIC_FAILED';
        criticErr.audit = criticFailedAudit;
        throw criticErr;
      }

      if (currentCritique.isCompliant) {
        console.log(`[V4] Repaired EDL accepted (Pass ${repairPass})`);

        // Atomically update story-spine.json in root with the accepted repaired spine
        // MUST happen BEFORE persisting review-state PASS!
        const spinePath = path.join(root, 'story-spine.json');
        try {
          let currentSpineData = { spines: [] };
          try {
            currentSpineData = JSON.parse(await fs.readFile(spinePath, 'utf8'));
          } catch (_) {}
          if (Array.isArray(currentSpineData.spines)) {
            const idx = currentSpineData.spines.findIndex(s => s.scriptId === id);
            if (idx >= 0) {
              currentSpineData.spines[idx] = { ...currentSpine, scriptId: id };
            } else if (currentSpineData.spines.length >= id) {
              currentSpineData.spines[id - 1] = { ...currentSpine, scriptId: id };
            } else {
              currentSpineData.spines.push({ ...currentSpine, scriptId: id });
            }
          } else {
            currentSpineData.spines = [{ ...currentSpine, scriptId: id }];
          }
          const tempPath = `${spinePath}.${crypto.randomUUID()}.tmp`;
          await fs.writeFile(tempPath, JSON.stringify(currentSpineData, null, 2));
          await fs.rename(tempPath, spinePath);
        } catch (err) {
          console.error(`[V4] PERSIST_ACCEPTED_EDL_FAILED: ${err.message}`);
          const failAudit = {
            scriptId: id, complete: true, contractVersion: 4, pending: false, needsUserReview: true,
            status: 'PERSIST_ACCEPTED_EDL_FAILED',
            failureType: 'PERSIST_ACCEPTED_EDL_FAILED',
            repairPasses: repairPass,
            finalCheck: { complete: false, verdict: 'FAIL', issues: [{ reason: `PERSIST_ACCEPTED_EDL_FAILED: ${err.message}` }] },
            metrics: {
              criticObservedScore: currentCritique.criticObservedScore,
              averageRetentionScore: currentCritique.averageRetentionScore,
              mp4Duration: currentCritique.mp4Duration
            }
          };
          await fs.writeFile(record, JSON.stringify(failAudit, null, 2)).catch(() => {});
          audits.push(failAudit);
          const persistErr = new Error(`PERSIST_ACCEPTED_EDL_FAILED: ${err.message}`);
          persistErr.code = 'PERSIST_ACCEPTED_EDL_FAILED';
          persistErr.audit = failAudit;
          throw persistErr;
        }

        // Only persist review-state PASS if canonical spine persistence succeeded
        const passedAudit = {
          scriptId: id, complete: true, contractVersion: 4, pending: false, needsUserReview: false,
          repairPasses: repairPass,
          finalCheck: { complete: true, verdict: 'PASS', issues: [] },
          metrics: {
            criticObservedScore: currentCritique.criticObservedScore,
            averageRetentionScore: currentCritique.averageRetentionScore,
            mp4Duration: currentCritique.mp4Duration
          }
        };
        await fs.writeFile(record, JSON.stringify(passedAudit, null, 2));
        audits.push(passedAudit);
        repaired = true;
        break;
      }
    }

    if (!repaired) {
      console.log(`[V4] Max repair passes reached. Failed explicitly.`);
      const failedAudit = {
        scriptId: id, complete: true, contractVersion: 4, pending: false, needsUserReview: true,
        repairPasses: 2,
        finalCheck: { complete: true, verdict: 'FAIL', issues: [{ reason: 'Failed to meet criteria after 2 repairs.' }] },
        metrics: {
          criticObservedScore: currentCritique.criticObservedScore,
          averageRetentionScore: currentCritique.averageRetentionScore,
          mp4Duration: currentCritique.mp4Duration
        }
      };
      await fs.writeFile(record, JSON.stringify(failedAudit, null, 2));
      audits.push(failedAudit);
    }
  }

  return { project: await service.store.getProject(workspaceRoot, projectId), audits };
}
module.exports = { run, auditDrafts, assignAudioRoles, buildScript, enforceSafeWords, demoteOverflow, safeWordsFor, isOverflow,
  assertStoryModelInput, validateStoryDesign, validateNarration, buildStoryDesign, chooseSpines, completeSpines };
