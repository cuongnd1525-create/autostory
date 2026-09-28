// Data models and validation schemas for AI Video Recap Mode.
// Enforces hierarchical representation:
// Story -> Scene -> Shot -> VisualEvent -> NarrationClause

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeText(value, fallback = "") {
  return String(value ?? "").trim() || fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Validates a VisualEvent object.
 * A VisualEvent is something visible that can anchor narration clauses.
 */
function validateVisualEvent(event, index = 0) {
  if (!event || typeof event !== "object") {
    throw new Error(`VisualEvent at index ${index} must be an object.`);
  }
  const id = safeText(event.id || event.eventId || `event_${String(index + 1).padStart(4, "0")}`);
  const source_start = safeNumber(event.source_start ?? event.sourceStartSec ?? event.start, -1);
  const source_end = safeNumber(event.source_end ?? event.sourceEndSec ?? event.end, -1);
  if (source_start < 0 || source_end <= source_start) {
    throw new Error(`VisualEvent ${id} has invalid source range [${source_start}, ${source_end}].`);
  }
  return {
    id,
    scene_id: safeText(event.scene_id || event.sceneId || ""),
    shot_id: safeText(event.shot_id || event.shotId || ""),
    source_start: Number(source_start.toFixed(3)),
    source_end: Number(source_end.toFixed(3)),
    duration: Number((source_end - source_start).toFixed(3)),
    description: safeText(event.description || event.title || "Visual event"),
    subjects: safeArray(event.subjects || event.participants),
    actions: safeArray(event.actions),
    objects: safeArray(event.objects),
    location: safeText(event.location || ""),
    importance: Math.max(0, Math.min(1, safeNumber(event.importance, 0.5))),
    motion_level: Math.max(0, Math.min(1, safeNumber(event.motion_level ?? event.motionIntensity, 0.5))),
    dialogue_present: Boolean(event.dialogue_present || event.dialoguePresent || event.dialogue),
    face_closeup: Boolean(event.face_closeup || event.faceCloseup),
    lip_sync_risk: Boolean(event.lip_sync_risk || event.lipSyncRisk || (event.face_closeup && event.dialogue_present))
  };
}

/**
 * Validates a Global Story Model.
 * Compact global representation of characters, arcs, and causal links.
 */
function validateStoryModel(model) {
  if (!model || typeof model !== "object") {
    throw new Error("StoryModel must be an object.");
  }
  return {
    title: safeText(model.title || "Recap Story"),
    logline: safeText(model.logline || model.summary || model.videoSummary || ""),
    characters: safeArray(model.characters).map((char, idx) => ({
      id: safeText(char.id || `char_${idx + 1}`),
      name: safeText(char.name || `Character ${idx + 1}`),
      role: safeText(char.role || "protagonist"),
      description: safeText(char.description || ""),
      relationship_notes: safeText(char.relationship_notes || "")
    })),
    locations: safeArray(model.locations).map((loc, idx) => ({
      id: safeText(loc.id || `loc_${idx + 1}`),
      name: safeText(loc.name || `Location ${idx + 1}`),
      significance: safeText(loc.significance || "")
    })),
    story_arcs: safeArray(model.story_arcs || model.arcs).map((arc, idx) => ({
      id: safeText(arc.id || `arc_${idx + 1}`),
      name: safeText(arc.name || `Arc ${idx + 1}`),
      description: safeText(arc.description || "")
    })),
    major_events: safeArray(model.major_events || model.events).map((ev, idx) => ({
      id: safeText(ev.id || `maj_${idx + 1}`),
      event_ref_id: safeText(ev.event_ref_id || ev.eventId || ""),
      title: safeText(ev.title || ""),
      description: safeText(ev.description || ""),
      significance: safeText(ev.significance || ""),
      causes: safeArray(ev.causes),
      consequences: safeArray(ev.consequences)
    })),
    turning_points: safeArray(model.turning_points).map((tp) => ({
      event_ref_id: safeText(tp.event_ref_id || tp.eventId || ""),
      description: safeText(tp.description || ""),
      impact: safeText(tp.impact || "")
    })),
    conflict: safeText(model.conflict || model.mainConflict || ""),
    climax: safeText(model.climax || ""),
    ending: typeof model.ending === "object" ? model.ending : { description: safeText(model.ending || "") }
  };
}

/**
 * Validates a Recap Edit Plan.
 */
function validateRecapPlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new Error("RecapPlan must be an object.");
  }
  const selected_event_ids = safeArray(plan.selected_event_ids || plan.selectedEvents);
  if (!selected_event_ids.length) {
    throw new Error("RecapPlan must contain at least one selected_event_id.");
  }
  return {
    target_duration_sec: Math.max(10, safeNumber(plan.target_duration_sec ?? plan.targetDuration, 60)),
    estimated_duration_sec: safeNumber(plan.estimated_duration_sec, 0),
    hook_strategy: safeText(plan.hook_strategy || "Curiosity hook establishing tension"),
    hook_event_ids: safeArray(plan.hook_event_ids || plan.hookEvents),
    selected_event_ids,
    beats: safeArray(plan.beats).map((beat, idx) => ({
      beat_id: safeText(beat.beat_id || `beat_${idx + 1}`),
      role: safeText(beat.role || "story_beat"),
      purpose: safeText(beat.purpose || ""),
      visual_event_ids: safeArray(beat.visual_event_ids || beat.eventIds),
      must_preserve: safeText(beat.must_preserve || ""),
      can_omit: safeText(beat.can_omit || "")
    }))
  };
}

/**
 * Validates a SpeechUnit.
 * NarrationBlock -> SpeechUnit[] -> Clause[]
 */
function validateSpeechUnit(unit, index = 0) {
  if (!unit || typeof unit !== "object") {
    throw new Error(`SpeechUnit at index ${index} must be an object.`);
  }
  const id = safeText(unit.id || unit.speech_unit_id || `speech_${String(index + 1).padStart(4, "0")}`);
  const text = safeText(unit.text || unit.narration || "");
  if (!text) {
    throw new Error(`SpeechUnit ${id} cannot have empty text.`);
  }
  const visual_event_ids = safeArray(unit.visual_event_ids || unit.eventIds);
  const clauses = safeArray(unit.clauses).map((clause, cIdx) => ({
    clause_id: safeText(clause.clause_id || `${id}_c${cIdx + 1}`),
    text: safeText(clause.text || ""),
    visual_event_ids: safeArray(clause.visual_event_ids || visual_event_ids)
  }));

  return {
    id,
    beat_id: safeText(unit.beat_id || ""),
    text,
    visual_event_ids,
    clauses: clauses.length ? clauses : [{ clause_id: `${id}_c1`, text, visual_event_ids }],
    target_duration_budget: safeNumber(unit.target_duration_budget ?? unit.targetDuration, 0),
    max_duration_budget: safeNumber(unit.max_duration_budget ?? unit.maxDuration, 0),
    min_word_count: safeNumber(unit.min_word_count, 0),
    target_word_count: safeNumber(unit.target_word_count, 0),
    max_word_count: safeNumber(unit.max_word_count, 0)
  };
}

/**
 * Validates an EditDecision for the final timeline.
 */
function validateEditDecision(decision, index = 0) {
  if (!decision || typeof decision !== "object") {
    throw new Error(`EditDecision at index ${index} must be an object.`);
  }
  const speech_unit_id = safeText(decision.speech_unit_id || `decision_${index + 1}`);
  const audio_duration = safeNumber(decision.audio_duration, 0);
  const clips = safeArray(decision.clips).map((clip, clipIdx) => {
    const source_start = safeNumber(clip.source_start, 0);
    const source_end = safeNumber(clip.source_end, source_start + 1);
    const output_start = safeNumber(clip.output_start, 0);
    const output_end = safeNumber(clip.output_end, output_start + 1);
    const video_speed = Math.max(0.7, Math.min(1.5, safeNumber(clip.video_speed, 1.0)));
    return {
      clip_id: safeText(clip.clip_id || `clip_${index + 1}_${clipIdx + 1}`),
      event_id: safeText(clip.event_id || ""),
      source_start: Number(source_start.toFixed(3)),
      source_end: Number(source_end.toFixed(3)),
      output_start: Number(output_start.toFixed(3)),
      output_end: Number(output_end.toFixed(3)),
      video_speed: Number(video_speed.toFixed(3)),
      lead_ms: safeNumber(clip.lead_ms, 0),
      face_closeup: Boolean(clip.face_closeup),
      lip_sync_risk: Boolean(clip.lip_sync_risk)
    };
  });

  return {
    speech_unit_id,
    audio_path: safeText(decision.audio_path || ""),
    audio_duration: Number(audio_duration.toFixed(3)),
    voice_tempo: Number(Math.max(0.9, Math.min(1.15, safeNumber(decision.voice_tempo, 1.0))).toFixed(3)),
    text: safeText(decision.text || ""),
    clips,
    total_video_duration: Number(clips.reduce((sum, c) => sum + (c.output_end - c.output_start), 0).toFixed(3))
  };
}

/**
 * Validates a QualityIssue from AI Draft Review.
 */
function validateQualityIssue(issue, index = 0) {
  if (!issue || typeof issue !== "object") {
    throw new Error(`QualityIssue at index ${index} must be an object.`);
  }
  return {
    issue_id: safeText(issue.issue_id || `issue_${index + 1}`),
    severity: ["critical", "high", "medium", "low"].includes(String(issue.severity).toLowerCase())
      ? String(issue.severity).toLowerCase()
      : "medium",
    type: safeText(issue.type || "semantic_alignment"),
    output_start: safeNumber(issue.output_start, 0),
    output_end: safeNumber(issue.output_end, 0),
    description: safeText(issue.description || "Unspecified quality issue"),
    recommended_action: safeText(issue.recommended_action || "Adjust timing or rewrite"),
    fix_applied: Boolean(issue.fix_applied)
  };
}

module.exports = {
  safeNumber,
  safeText,
  safeArray,
  validateVisualEvent,
  validateStoryModel,
  validateRecapPlan,
  validateSpeechUnit,
  validateEditDecision,
  validateQualityIssue
};
