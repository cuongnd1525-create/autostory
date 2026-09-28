const assert = require("assert");
const {
  validateVisualEvent,
  validateStoryModel,
  validateRecapPlan,
  validateSpeechUnit,
  validateEditDecision
} = require("../electron/services/recap/recapTypes");

// 1. VisualEvent validation
{
  const rawEvent = {
    id: "ev_01",
    source_start: 12.5,
    source_end: 18.2,
    description: "The detective inspects a broken window",
    subjects: ["detective"],
    actions: ["inspecting"],
    face_closeup: true,
    dialogue_present: true
  };
  const validated = validateVisualEvent(rawEvent, 0);
  assert.strictEqual(validated.id, "ev_01");
  assert.strictEqual(validated.duration, 5.7);
  assert.strictEqual(validated.lip_sync_risk, true, "Face closeup + dialogue should flag lip_sync_risk");
}

// 2. StoryModel validation
{
  const rawStory = {
    title: "The Mystery of Raven Hollow",
    logline: "A quiet town conceals a buried secret.",
    characters: [{ name: "Sarah", role: "investigator" }],
    turning_points: [{ description: "Sarah finds the hidden diary" }]
  };
  const validated = validateStoryModel(rawStory);
  assert.strictEqual(validated.title, "The Mystery of Raven Hollow");
  assert.strictEqual(validated.characters.length, 1);
  assert.strictEqual(validated.characters[0].name, "Sarah");
  assert.strictEqual(validated.turning_points.length, 1);
}

// 3. RecapPlan validation
{
  const rawPlan = {
    target_duration_sec: 75,
    hook_strategy: "Cold open murder discovery",
    selected_event_ids: ["ev_01", "ev_02", "ev_05"],
    beats: [
      { beat_id: "b1", visual_event_ids: ["ev_01"] },
      { beat_id: "b2", visual_event_ids: ["ev_02", "ev_05"] }
    ]
  };
  const validated = validateRecapPlan(rawPlan);
  assert.strictEqual(validated.target_duration_sec, 75);
  assert.strictEqual(validated.selected_event_ids.length, 3);
  assert.strictEqual(validated.beats.length, 2);
}

// 4. SpeechUnit validation & duration budgeting
{
  const rawUnit = {
    id: "su_01",
    text: "As Sarah stepped into the study, shattered glass crunched beneath her boots.",
    visual_event_ids: ["ev_01"],
    clauses: [
      { text: "As Sarah stepped into the study,", visual_event_ids: ["ev_01"] },
      { text: "shattered glass crunched beneath her boots.", visual_event_ids: ["ev_01"] }
    ],
    target_duration_budget: 4.5
  };
  const validated = validateSpeechUnit(rawUnit, 0);
  assert.strictEqual(validated.id, "su_01");
  assert.strictEqual(validated.clauses.length, 2);
  assert.strictEqual(validated.target_duration_budget, 4.5);
}

// 5. EditDecision validation
{
  const rawDecision = {
    speech_unit_id: "su_01",
    audio_path: "C:/tmp/audio.wav",
    audio_duration: 4.2,
    voice_tempo: 1.02,
    text: "As Sarah stepped into the study...",
    clips: [
      {
        clip_id: "clip_1",
        event_id: "ev_01",
        source_start: 12.5,
        source_end: 17.2,
        output_start: 0.0,
        output_end: 4.7,
        video_speed: 1.0,
        lead_ms: 250,
        lip_sync_risk: false
      }
    ]
  };
  const validated = validateEditDecision(rawDecision, 0);
  assert.strictEqual(validated.speech_unit_id, "su_01");
  assert.strictEqual(validated.voice_tempo, 1.02);
  assert.strictEqual(validated.clips[0].lead_ms, 250);
  assert.strictEqual(validated.total_video_duration, 4.7);
}

console.log("recapTimelineMath.test.js PASSED");
