const assert = require("assert");
const { RecapSyncSolver } = require("../electron/services/recap/recapSyncSolver");

const solver = new RecapSyncSolver({
  minVoiceSpeed: 0.97,
  maxVoiceSpeed: 1.05,
  minVideoSpeedNormal: 0.92,
  maxVideoSpeedNormal: 1.08,
  minVideoSpeedTalking: 0.98,
  maxVideoSpeedTalking: 1.02
});

// Test 1: Normal action video speed clamping under extreme mismatch
{
  const unit = {
    id: "unit_speed_1",
    text: "He runs through the corridor as fast as he can.",
    visual_event_ids: ["ev_norm"]
  };
  const visualEvents = [
    {
      id: "ev_norm",
      source_start: 10.0,
      source_end: 25.0, // 15s raw duration
      description: "Running down hall",
      face_closeup: false,
      lip_sync_risk: false
    }
  ];
  // Narration is very short (3s), requiring huge speedup if unconstrained
  const audioTracks = {
    unit_speed_1: { durationSec: 2.5 }
  };

  const solution = solver.solve({
    speechUnits: [unit],
    visualEvents,
    audioTracks,
    sourceDurationSec: 60
  });

  const clip = solution.decisions[0].clips[0];
  assert.ok(
    clip.video_speed >= 0.92 && clip.video_speed <= 1.08,
    `Normal action speed ${clip.video_speed} must be clamped to [0.92, 1.08]`
  );
}

// Test 2: Talking head / lip sync risk clamping
{
  const unit = {
    id: "unit_speed_2",
    text: "She speaks directly to the interrogator.",
    visual_event_ids: ["ev_talking"]
  };
  const visualEvents = [
    {
      id: "ev_talking",
      source_start: 5.0,
      source_end: 9.0, // 4s raw duration
      description: "Character talking closeup",
      face_closeup: true,
      dialogue_present: true,
      lip_sync_risk: true
    }
  ];
  const audioTracks = {
    unit_speed_2: { durationSec: 7.0 }
  };

  const solution = solver.solve({
    speechUnits: [unit],
    visualEvents,
    audioTracks,
    sourceDurationSec: 60
  });

  const clip = solution.decisions[0].clips[0];
  assert.ok(
    clip.video_speed >= 0.98 && clip.video_speed <= 1.02,
    `Talking head video speed ${clip.video_speed} must be tightly clamped to [0.98, 1.02]`
  );
}

// Test 3: Voice tempo retiming bounds
{
  const unit = {
    id: "unit_speed_3",
    text: "A quick narration that needs minor fitting.",
    visual_event_ids: ["ev_voice_test"]
  };
  const visualEvents = [
    {
      id: "ev_voice_test",
      source_start: 1.0,
      source_end: 4.0,
      description: "Action beat",
      lip_sync_risk: false
    }
  ];
  const audioTracks = {
    unit_speed_3: { durationSec: 6.0 }
  };

  const solution = solver.solve({
    speechUnits: [unit],
    visualEvents,
    audioTracks,
    sourceDurationSec: 60
  });

  const tempo = solution.decisions[0].voice_tempo;
  assert.ok(
    tempo >= 0.97 && tempo <= 1.05,
    `Voice tempo ${tempo} must be clamped to [0.97, 1.05]`
  );
}

console.log("recapSpeedMath.test.js PASSED");
