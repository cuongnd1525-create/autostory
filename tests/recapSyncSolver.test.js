const assert = require("assert");
const { RecapSyncSolver } = require("../electron/services/recap/recapSyncSolver");

const visualEvents = [
  {
    id: "ev_01",
    source_start: 10.0,
    source_end: 14.0,
    duration: 4.0,
    description: "Opening hook: detective arrives in rain",
    face_closeup: false,
    lip_sync_risk: false
  },
  {
    id: "ev_02",
    source_start: 20.0,
    source_end: 26.0,
    duration: 6.0,
    description: "Finding secret room behind bookshelf",
    face_closeup: false,
    lip_sync_risk: false
  },
  {
    id: "ev_03",
    source_start: 40.0,
    source_end: 45.0,
    duration: 5.0,
    description: "Climax confrontation",
    face_closeup: true,
    dialogue_present: true,
    lip_sync_risk: true
  }
];

const scenes = [
  { startSec: 8.0, endSec: 16.0 },
  { startSec: 18.0, endSec: 30.0 },
  { startSec: 38.0, endSec: 50.0 }
];

const speechUnits = [
  {
    id: "su_1",
    text: "Detective Vance arrives at the Blackwood mansion amidst a torrential downpour.",
    visual_event_ids: ["ev_01"]
  },
  {
    id: "su_2",
    text: "Behind an ornate bookshelf, he discovers a hidden passageway untouched for decades.",
    visual_event_ids: ["ev_02"]
  },
  {
    id: "su_3",
    text: "Cornered, the suspect finally confesses the truth.",
    visual_event_ids: ["ev_03"]
  }
];

const audioTracks = {
  su_1: { durationSec: 3.8 },
  su_2: { durationSec: 5.2 },
  su_3: { durationSec: 4.5 }
};

// 1. Solve with default settings (allowShotReuse = false)
{
  const solver = new RecapSyncSolver({
    allowShotReuse: false,
    targetVisualLeadSec: 0.25
  });

  const solution = solver.solve({
    speechUnits,
    visualEvents,
    audioTracks,
    scenes,
    sourceDurationSec: 60.0
  });

  assert.strictEqual(solution.decisions.length, 3);
  assert.strictEqual(solution.traceability.length, 3);

  // Check visual lead
  for (const t of solution.traceability) {
    assert.ok(t.leadMs >= 100 && t.leadMs <= 450, `Lead ${t.leadMs}ms must be within 100-450ms`);
  }

  // Check timeline monotonicity
  for (let i = 1; i < solution.decisions.length; i++) {
    const prev = solution.decisions[i - 1].clips[0];
    const curr = solution.decisions[i].clips[0];
    assert.ok(curr.output_start >= prev.output_end, "Timeline must be strictly monotonic");
  }

  // Check lip sync risk handling on su_3
  const decision3 = solution.decisions[2];
  assert.strictEqual(decision3.clips[0].lip_sync_risk, true);
  assert.ok(
    decision3.clips[0].video_speed >= 0.98 && decision3.clips[0].video_speed <= 1.02,
    "Lip sync risk video speed must stay within [0.98, 1.02]"
  );

  // Check metrics
  assert.strictEqual(solution.metrics.totalSpeechUnits, 3);
  assert.strictEqual(solution.metrics.totalClips, 3);
  assert.ok(solution.metrics.totalTimelineDurationSec > 10);
}

// 2. Test Tier 1 rewrite recommendation on extreme duration mismatch
{
  const solver = new RecapSyncSolver();
  const mismatchUnits = [
    {
      id: "su_huge",
      text: "A very long detailed monologue that goes on and on describing every single little piece of furniture in the room.",
      visual_event_ids: ["ev_01"] // only 4s long
    }
  ];
  const mismatchAudio = {
    su_huge: { durationSec: 12.0 } // 12s vs 4s event -> 300% delta
  };

  const solution = solver.solve({
    speechUnits: mismatchUnits,
    visualEvents,
    audioTracks: mismatchAudio,
    scenes,
    sourceDurationSec: 60.0
  });

  assert.strictEqual(solution.rewriteRecommendations.length, 1);
  assert.strictEqual(solution.rewriteRecommendations[0].speechUnitId, "su_huge");
  assert.ok(solution.rewriteRecommendations[0].deltaRatio > 0.35);
}

console.log("recapSyncSolver.test.js PASSED");
