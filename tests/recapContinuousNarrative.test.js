const assert = require("assert");
const RecapAiService = require("../electron/services/recap/recapAiService");
const RecapTtsService = require("../electron/services/recap/recapTtsService");

async function testContinuousNarrativeEnhancements() {
  console.log("1. Testing RecapAiService parameter resilience and prompt structures...");
  const aiService = new RecapAiService({ vertexAnalysisModel: "gemini-2.5-flash" });

  const dummyEvents = [
    { id: "ev_01", source_start: 0.0, source_end: 4.5, description: "A peasant gazes at the burning village", importance: 0.9 },
    { id: "ev_02", source_start: 4.5, source_end: 9.0, description: "Mounted samurai approach in formation", importance: 0.95 }
  ];

  const dummyStoryModel = {
    title: "The Peasant's Reckoning",
    logline: "A lone farmer struggles to survive the brutal feudal wars of 15th century Japan.",
    conflict: "Peasants caught between starving warlords and merciless tax collectors.",
    characters: [{ id: "c1", name: "Jiro", role: "protagonist", description: "Young rice farmer" }],
    climax: "Jiro confronts the warlord's vanguard.",
    ending: { description: "He chooses defiance over submission." }
  };

  const dummyPlan = {
    target_duration_sec: 15,
    selected_event_ids: ["ev_01", "ev_02"],
    beats: [
      {
        beat_id: "beat_01",
        role: "hook",
        visual_event_ids: ["ev_01", "ev_02"]
      }
    ]
  };

  // Mock runVertexCall to inspect prompt composition
  let capturedPrompt = "";
  aiService.runVertexCall = async ({ prompt }) => {
    capturedPrompt = prompt;
    return {
      speech_units: [
        {
          id: "speech_0001",
          beat_id: "beat_01",
          text: "As the dawn mist hung over the village, a peasant took his first breath of what could be his final morning.",
          visual_event_ids: ["ev_01", "ev_02"],
          clauses: [
            { clause_id: "c1", text: "As the dawn mist hung over the village,", visual_event_ids: ["ev_01"] },
            { clause_id: "c2", text: "a peasant took his first breath of what could be his final morning.", visual_event_ids: ["ev_02"] }
          ]
        }
      ]
    };
  };

  // Test calling generateNarration with events array (as called by pipeline)
  const result = await aiService.generateNarration({
    recapPlan: dummyPlan,
    events: dummyEvents,
    storyModel: dummyStoryModel,
    wordsPerSecond: 2.6,
    densityMultiplier: 1.2
  });

  assert.ok(Array.isArray(result) && result.length === 1, "Should return 1 speech unit");
  assert.strictEqual(result[0].clauses.length, 2, "Should have 2 grounded clauses");
  assert.ok(capturedPrompt.includes("GLOBAL STORY SPINE"), "Prompt must include Global Story Spine");
  assert.ok(capturedPrompt.includes("The Peasant's Reckoning"), "Prompt must include Story title");
  assert.ok(capturedPrompt.includes("CONTINUOUS THROUGH-LINE"), "Prompt must mandate continuous through-line");
  assert.ok(capturedPrompt.includes("CLAUSE-LEVEL VISUAL GROUNDING"), "Prompt must mandate clause visual grounding");
  console.log("   ✓ generateNarration passed with full Story Spine and Continuous Essay prompt.");

  // 2. Test RecapTtsService voice resolution
  console.log("2. Testing RecapTtsService voice resolution...");
  const ttsService = new RecapTtsService();

  const maleElevenVoice = ttsService.resolveVoiceId("elevenlabs", { voiceGender: "male" });
  assert.strictEqual(maleElevenVoice, "pNInz6obpgDQGcFmaJgB", "Default male ElevenLabs voice should be Adam");

  const femaleElevenVoice = ttsService.resolveVoiceId("elevenlabs", { voiceGender: "female" });
  assert.strictEqual(femaleElevenVoice, "21m00Tcm4TlvDq8ikWAM", "Default female ElevenLabs voice should be Rachel");

  const maleKokoroVoice = ttsService.resolveVoiceId("kokoro", { voiceGender: "male" });
  assert.strictEqual(maleKokoroVoice, "am_adam", "Default male Kokoro voice should be am_adam");

  const maleEdgeVoice = ttsService.resolveVoiceId("edge_neural", { voiceGender: "male" });
  assert.strictEqual(maleEdgeVoice, "en-US-ChristopherNeural", "Default male Edge voice should be Christopher");
  console.log("   ✓ resolveVoiceId passed with cinematic narrative voice defaults.");

  console.log("\nALL RECAP QUALITY & CONTINUOUS NARRATIVE TESTS PASSED SUCCESSFULLY!");
}

testContinuousNarrativeEnhancements().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
