const assert = require("assert");

const {
  scoreViralCandidate,
  buildViralAnalysis,
  buildRetentionPlan,
  buildViralTimeline,
  buildAttentionQa,
  buildViralFactGuard,
  ViralIntelligenceService
} = require("../electron/services/viralIntelligenceService");

function makeSegments() {
  return [
    {
      sceneId: "s001",
      beatId: "beat_hook",
      role: "hook",
      timelineStart: 0,
      timelineEnd: 3,
      renderDuration: 3,
      description: "monster attack in forest",
      whatChanged: "the hunter becomes prey",
      narrationLine: "Why is the hunter suddenly running from something he cannot see?",
      metadataSummary: { motionIntensity: "HIGH", audioEnergy: "LOUD", localVisualTags: ["monster", "forest", "running"] }
    },
    {
      sceneId: "s002",
      beatId: "beat_context",
      role: "context",
      timelineStart: 3,
      timelineEnd: 12,
      renderDuration: 9,
      description: "the team enters the jungle",
      narrationLine: "A rescue mission pulls the team into the jungle, but the trees are already watching them."
    },
    {
      sceneId: "s003",
      beatId: "beat_conflict",
      role: "conflict",
      timelineStart: 12,
      timelineEnd: 28,
      renderDuration: 16,
      description: "the enemy attacks",
      narrationLine: "Every trap they set only proves the enemy understands them faster than they understand it."
    },
    {
      sceneId: "s004",
      beatId: "beat_loop",
      role: "cliffhanger",
      timelineStart: 28,
      timelineEnd: 36,
      renderDuration: 8,
      description: "final threat remains",
      narrationLine: "So if the forest was only the first test, what is waiting outside it?"
    }
  ];
}

function testScoreFormulaRewardsRetention() {
  const strong = scoreViralCandidate({
    role: "hook",
    description: "monster attack chase danger secret",
    visualImpactScore: 9,
    plotImportanceScore: 8,
    curiosityScore: 9,
    spoilerRisk: 2,
    contextCost: 2
  }, "thriller", 0);
  const weak = scoreViralCandidate({
    role: "setup",
    description: "quiet room conversation with lots of backstory",
    visualImpactScore: 2,
    plotImportanceScore: 3,
    contextCost: 9,
    spoilerRisk: 7
  }, "thriller", 0);
  assert(strong.finalRetentionScore > weak.finalRetentionScore, "viral score should reward hook-worthy scenes");
}

function testHookRequiredInFirstThreeSeconds() {
  const segments = makeSegments();
  const viralAnalysis = buildViralAnalysis({ videoId: "p1", targetDuration: 36, genreMode: "thriller", segments });
  const retentionPlan = buildRetentionPlan({ viralAnalysis, targetDuration: 36, voiceSpeed: 1 });
  const viralTimeline = buildViralTimeline({ segments, retentionPlan, genreMode: "thriller" });
  const qa = buildAttentionQa({ segments, retentionPlan, viralTimeline });
  assert(qa.hookScore >= 0.8, "strong first segment should pass hook QA");

  const weak = [{ ...segments[0], narrationLine: "This movie is about a team in a jungle." }, ...segments.slice(1)];
  const weakQa = buildAttentionQa({ segments: weak, retentionPlan, viralTimeline });
  assert(weakQa.issues.some((issue) => issue.issue === "weak_hook"), "generic premise should be flagged as weak_hook");
}

function testRevealCannotAppearBeforeSetup() {
  const segments = makeSegments();
  segments[1].narrationLine = "The secret truth is revealed before anyone understands the mission.";
  const viralAnalysis = buildViralAnalysis({ videoId: "p1", targetDuration: 36, genreMode: "mystery", segments });
  const retentionPlan = buildRetentionPlan({ viralAnalysis, targetDuration: 36, voiceSpeed: 1 });
  const viralTimeline = buildViralTimeline({ segments, retentionPlan, genreMode: "mystery" });
  const qa = buildAttentionQa({ segments, retentionPlan, viralTimeline });
  assert(qa.issues.some((issue) => issue.issue === "reveal_too_early"), "early reveal should be flagged");
}

function testNoFifteenSecondGapWithoutRetentionBeat() {
  const segments = makeSegments();
  segments[2] = {
    ...segments[2],
    timelineStart: 31,
    timelineEnd: 38,
    narrationLine: "The group walks and looks around the area."
  };
  const viralAnalysis = buildViralAnalysis({ videoId: "p1", targetDuration: 45, genreMode: "drama", segments });
  const retentionPlan = buildRetentionPlan({ viralAnalysis, targetDuration: 45, voiceSpeed: 1 });
  const viralTimeline = buildViralTimeline({ segments, retentionPlan, genreMode: "drama" });
  const qa = buildAttentionQa({ segments, retentionPlan, viralTimeline });
  assert(qa.issues.some((issue) => issue.issue === "no_curiosity_gap"), "long retention gap should be flagged");
}

function testSceneCaptioningStyleDetection() {
  const segments = makeSegments();
  segments[1].narrationLine = "The man walks into the room and looks at the table.";
  const viralAnalysis = buildViralAnalysis({ videoId: "p1", targetDuration: 36, genreMode: "drama", segments });
  const retentionPlan = buildRetentionPlan({ viralAnalysis, targetDuration: 36, voiceSpeed: 1 });
  const viralTimeline = buildViralTimeline({ segments, retentionPlan, genreMode: "drama" });
  const qa = buildAttentionQa({ segments, retentionPlan, viralTimeline });
  assert(qa.issues.some((issue) => issue.issue === "scene_captioning_style"), "caption-like line should be flagged");
}

function testLoopEndingDetection() {
  const segments = makeSegments();
  segments[segments.length - 1].narrationLine = "Then everything ends.";
  const viralAnalysis = buildViralAnalysis({ videoId: "p1", targetDuration: 36, genreMode: "thriller", segments });
  const retentionPlan = buildRetentionPlan({ viralAnalysis, targetDuration: 36, voiceSpeed: 1 });
  const viralTimeline = buildViralTimeline({ segments, retentionPlan, genreMode: "thriller" });
  const qa = buildAttentionQa({ segments, retentionPlan, viralTimeline });
  assert(qa.issues.some((issue) => issue.issue === "no_loop_ending"), "flat ending should be flagged");
}

function testFallbackWhenDisabledOrMissingAnalysis() {
  const service = new ViralIntelligenceService({ enabled: false });
  const result = service.buildAll({ segments: makeSegments(), targetDuration: 36 });
  assert.strictEqual(result.fallback, true, "disabled service should return fallback");

  const active = new ViralIntelligenceService();
  const built = active.buildAll({ segments: [], targetDuration: 36 });
  assert.strictEqual(built.fallback, false, "empty input should still return schema artifacts");
  assert(Array.isArray(built.viralAnalysis.topHookCandidates), "fallback schema should include hook candidates array");
}

function makeEvidenceGraph(text = "forest monster running danger") {
  return {
    schemaVersion: "evidence-graph.v1",
    nodes: [
      {
        id: "evidence:ev_scene_001_visual_01",
        type: "visual",
        label: text,
        sceneId: "s001",
        confidence: 0.8,
        evidenceLevel: "strong",
        data: { text }
      }
    ],
    facts: [{ text, evidenceId: "ev_scene_001_visual_01", sceneId: "s001" }],
    edges: []
  };
}

function testViralFactGuardRejectsUnsupportedFacts() {
  const viralAnalysis = {
    topHookCandidates: [
      {
        sceneId: "s001",
        hookLineIdea: "betrayal: the secret father reveals the truth",
        reason: "secret betrayal"
      }
    ],
    topTwistMoments: []
  };
  const guard = buildViralFactGuard({
    viralAnalysis,
    evidenceGraph: makeEvidenceGraph("forest monster running danger")
  });
  assert.strictEqual(guard.passed, false);
  assert(guard.issues.some((issue) => issue.code === "viral_fact_without_evidence" && issue.term === "betray"));
}

function testViralFactGuardAllowsSupportedDanger() {
  const viralAnalysis = {
    topHookCandidates: [
      {
        sceneId: "s001",
        hookLineIdea: "danger: the monster chases someone through the forest",
        reason: "monster chase"
      }
    ],
    topTwistMoments: []
  };
  const guard = buildViralFactGuard({
    viralAnalysis,
    evidenceGraph: makeEvidenceGraph("forest monster running danger chase")
  });
  assert.strictEqual(guard.passed, true);
  assert.strictEqual(guard.issues.length, 0);
}

function testViralFactGuardDoesNotMatchVietnameseSubstringAsFather() {
  const viralAnalysis = {
    topHookCandidates: [
      {
        sceneId: "s001",
        hookLineIdea: "Co gai chuyen tu bo chay sang chu dong chong tra.",
        reason: "active resistance"
      }
    ],
    topTwistMoments: []
  };
  const guard = buildViralFactGuard({
    viralAnalysis,
    evidenceGraph: makeEvidenceGraph("person runs and fights back")
  });
  assert.strictEqual(guard.issues.some((issue) => issue.term === "father"), false);
}

function testBuildAllFiltersUnsafeViralHook() {
  const segments = [
    {
      sceneId: "s001",
      role: "hook",
      description: "secret betrayal in a room",
      whatChanged: "the secret betrayal changes everything",
      narrationLine: "Something is wrong."
    },
    {
      sceneId: "s002",
      role: "conflict",
      description: "monster attack in forest",
      whatChanged: "the monster attacks",
      narrationLine: "The monster attacks in the forest.",
      metadataSummary: { localVisualTags: ["monster", "forest"] }
    }
  ];
  const result = new ViralIntelligenceService().buildAll({
    segments,
    targetDuration: 30,
    genreMode: "thriller",
    evidenceGraph: makeEvidenceGraph("monster attack forest")
  });
  assert.strictEqual(result.viralFactGuard.passed, false);
  assert(result.viralAnalysis.topHookCandidates.every((candidate) => !/betray|secret/i.test(candidate.hookLineIdea)));
}

testScoreFormulaRewardsRetention();
testHookRequiredInFirstThreeSeconds();
testRevealCannotAppearBeforeSetup();
testNoFifteenSecondGapWithoutRetentionBeat();
testSceneCaptioningStyleDetection();
testLoopEndingDetection();
testFallbackWhenDisabledOrMissingAnalysis();
testViralFactGuardRejectsUnsupportedFacts();
testViralFactGuardAllowsSupportedDanger();
testViralFactGuardDoesNotMatchVietnameseSubstringAsFather();
testBuildAllFiltersUnsafeViralHook();

console.log("viralIntelligenceService tests passed");
