"use strict";

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const Stage1 = require("../electron/services/manualAntigravityStage1Service");
const MapReduce = require("../electron/services/sourceUnderstandingMapReduce");
const {
  createPhaseAwareSpawn,
  defaultResponder,
  partScriptIdFromPrompt,
  proxyPathsFromPrompt,
  buildScript
} = require("./helpers/fakeAntigravity");

const DURATION = 300;
const CHUNKS = [
  [0, 100],
  [100, 200],
  [200, 300]
];

async function createSeriesPackage(profile = "viral_tiktok_crime_part1") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-seq-phaseb-"));
  const pass1Dir = path.join(root, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const promptPath = path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt");
  await fs.writeFile(
    promptPath,
    `### SELECTED PROMPT PROFILE\n- prompt_profile: ${profile}\nGenerate Script 1, Script 3 and Script 4.`,
    "utf8"
  );
  const scenes = Array.from({ length: 30 }, (_, index) => ({
    sceneId: `scene_${String(index + 1).padStart(4, "0")}`,
    startSec: index * 10,
    endSec: (index + 1) * 10
  }));
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({ videoDurationSec: DURATION, scenes }), "utf8");
  const chunks = CHUNKS.map(([start, end], index) => ({
    chunkId: `proxy_chunk_00${index + 1}`,
    file: `analysis-proxy-chunk-00${index + 1}.mp4`,
    sourceStartSec: start,
    sourceEndSec: end,
    durationSec: end - start
  }));
  for (const chunk of chunks) {
    await fs.writeFile(path.join(pass1Dir, chunk.file), `video-${chunk.chunkId}`, "utf8");
  }
  await fs.writeFile(path.join(pass1Dir, "proxy-chunks-manifest.json"), JSON.stringify({ sourceDurationSec: DURATION, chunks }), "utf8");
  await fs.writeFile(
    path.join(pass1Dir, "source-transcript.srt"),
    "1\n00:00:05,000 --> 00:00:09,000\nStep out of the car right now!\n\n2\n00:02:10,000 --> 00:02:15,000\nYou told us two different stories.\n\n3\n00:04:20,000 --> 00:04:26,000\nPlace your hands behind your back, you are under arrest.\n",
    "utf8"
  );
  const cacheDir = path.join(root, "source-cache");
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review",
    pass1UploadDir: pass1Dir,
    promptPath,
    proxyChunksManifestPath: path.join(pass1Dir, "proxy-chunks-manifest.json"),
    proxyChunkCount: 3,
    cache: { sourceFingerprint: `fp-seq-${profile}`, cacheDir }
  }), "utf8");
  return { root, pass1Dir, cacheDir };
}

function buildBlueprintV2SeriesPlan(durationSec = DURATION) {
  const third = durationSec / 3;
  return {
    artifactType: "series_plan",
    schemaVersion: 2,
    profile: "viral_tiktok_crime_part1",
    centralViewerQuestion: "Why did the suspect lock the passenger inside the trunk before deputies arrived?",
    hookPromise: "A frantic knocking from inside the trunk during a routine traffic stop.",
    verifiedCausalChain: [
      "Deputies stop the vehicle at 12s after hearing knocking.",
      "Driver gives contradictory answers at 130s during roadside questioning.",
      "Deputies unlock the trunk and arrest the driver at 260s."
    ],
    source_narrator_ranges: [
      { startSec: 0, endSec: 4, summary: "Third-party documentary intro voiceover" }
    ],
    parts: [
      {
        scriptId: 1,
        partNumber: 1,
        partBadge: "PART 1",
        scope: "The Confrontation",
        hook: { sourceStartSec: 10, sourceEndSec: 18, kind: "part1_cold_open", hookProof: "Step out of the car right now!" },
        chapterBeats: [
          { beatId: "p1_b1", kind: "hook", role: "Cold open standoff", sourceStartSec: 10, sourceEndSec: 25, sceneIds: ["scene_0002"], sourceProof: "Officer draws taser at driver window", mustInclude: true },
          { beatId: "p1_b2", kind: "confrontation", role: "Driver refuses to hand over keys", sourceStartSec: 45, sourceEndSec: 75, sceneIds: ["scene_0005"], sourceProof: "Driver clutches keys", mustInclude: true }
        ],
        mustNotReveal: ["arrest", "trunk unlocked"],
        cliffhanger: "Deputies hear knocking from the trunk, but the driver swallows the key fob.",
        cliffhangerRange: { sourceStartSec: 70, sourceEndSec: 85 }
      },
      {
        scriptId: 3,
        partNumber: 2,
        partBadge: "PART 2",
        scope: "The Interrogation",
        hook: { sourceStartSec: 110, sourceEndSec: 120, kind: "part2_previously_on_and_escalation", hookProof: "Whose voice is coming from the back?" },
        chapterBeats: [
          { beatId: "p2_b1", kind: "interrogation", role: "Roadside contradiction", sourceStartSec: 120, sourceEndSec: 150, sceneIds: ["scene_0013"], sourceProof: "You told us two different stories.", mustInclude: true },
          { beatId: "p2_b2", kind: "evidence", role: "Phone message discovery", sourceStartSec: 165, sourceEndSec: 190, sceneIds: ["scene_0017"], sourceProof: "Text message on dashboard screen", mustInclude: true }
        ],
        mustNotReveal: ["arrest"],
        cliffhanger: "Fire rescue pries the trunk latch open as everyone steps back.",
        cliffhangerRange: { sourceStartSec: 185, sourceEndSec: 195 }
      },
      {
        scriptId: 4,
        partNumber: 3,
        partBadge: "PART 3",
        scope: "The Verdict & Arrest",
        hook: { sourceStartSec: 210, sourceEndSec: 222, kind: "part3_final_payoff_open", hookProof: "Trunk pops open" },
        chapterBeats: [
          { beatId: "p3_b1", kind: "climax", role: "Trunk opened and victim rescued", sourceStartSec: 215, sourceEndSec: 245, sceneIds: ["scene_0022"], sourceProof: "Deputies help passenger out", mustInclude: true },
          { beatId: "p3_b2", kind: "arrest", role: "Suspect handcuffed and read charges", sourceStartSec: 255, sourceEndSec: 290, sceneIds: ["scene_0026"], sourceProof: "Place your hands behind your back", mustInclude: true }
        ],
        mustNotReveal: [],
        payoff: "The passenger is rescued unharmed and the driver is arrested for kidnapping.",
        payoffRanges: [{ sourceStartSec: 255, sourceEndSec: 295 }]
      }
    ],
    sharedRanges: [],
    duplicatePrevention: "Each Part covers one 100s chapter of the 300s source."
  };
}

(async () => {
  // 1. Series profile detection for all 3 serialized profiles
  for (const profileName of ["viral_tiktok_crime_part1", "serialized_genz", "serialized_interleaved"]) {
    const detected = Stage1.detectSeriesProfile(`- prompt_profile: ${profileName}`);
    assert(detected, `detectSeriesProfile should recognize ${profileName}`);
    assert.strictEqual(detected.profile, profileName);
    assert.strictEqual(detected.parts.length, 3);
  }

  // 2. Lossless Forensic Chunk Bundle preserves tones, burned-in caption flags, and narrator ranges
  const forensicBundle = MapReduce.buildForensicChunkBundle([
    {
      task: { chunkId: "chunk-001", sourceStartSec: 0, sourceEndSec: 100, proxy: { filename: "analysis-proxy-chunk-001.mp4" } },
      data: {
        chunkId: "chunk-001",
        sourceStartSec: 0,
        sourceEndSec: 100,
        openStateAtStart: "Routine patrol.",
        openStateAtEnd: "Driver detained.",
        charactersSeen: [{ id: "c1", nameOrRole: "Deputy Morales", description: "Lead officer" }],
        sourceNarratorRanges: [{ startSec: 0, endSec: 4.5, summary: "Channel host intro" }],
        importantEvents: [
          {
            eventId: "e1",
            sourceStartSec: 10,
            sourceEndSec: 25,
            sceneIds: ["scene_0002"],
            eventType: "confrontation",
            summary: "Deputy orders driver out of the car.",
            visualFacts: ["Driver's hands tremble on steering wheel", "Burned-in yellow subtitle at bottom"],
            burnedInCaptionsPresent: true,
            dialogueFacts: [{ sourceSec: 12.4, endSec: 15.1, speaker: "Deputy Morales", tone: "urgent, commanding", quote: "Step out of the car right now!" }],
            sourceNarratorPresent: false,
            importance: 92,
            viralValue: 95
          }
        ],
        candidateMoments: [{ sourceStartSec: 10, sourceEndSec: 25, sceneIds: ["scene_0002"], type: "hook", reason: "High tension command" }]
      }
    }
  ]);
  assert.strictEqual(forensicBundle.artifactType, "forensic_chunk_understandings");
  assert.strictEqual(forensicBundle.chunkCount, 1);
  assert.strictEqual(forensicBundle.sourceNarratorRanges.length, 1);
  assert.strictEqual(forensicBundle.chunks[0].importantEvents[0].burnedInCaptionsPresent, true);
  assert.strictEqual(forensicBundle.chunks[0].importantEvents[0].dialogueFacts[0].tone, "urgent, commanding");

  // 3. Blueprint V2 normalization, validation, and chapterBeats coverage check
  const series = Stage1.detectSeriesProfile("- prompt_profile: viral_tiktok_crime_part1");
  const rawPlanV2 = buildBlueprintV2SeriesPlan(DURATION);
  const normalizedPlan = Stage1.normalizeSeriesPlan(rawPlanV2, series);
  assert.strictEqual(normalizedPlan.parts[0].sceneAllocation.length, 2, "normalizeSeriesPlan derives sceneAllocation from chapterBeats when omitted");
  assert.deepStrictEqual(normalizedPlan.parts[0].hookRange, { sourceStartSec: 10, sourceEndSec: 18 });
  const v2Validation = Stage1.validateSeriesPlan(rawPlanV2, { series, videoDurationSec: DURATION });
  assert.strictEqual(v2Validation.ok, true, `Blueprint V2 should validate cleanly: ${v2Validation.errors.join("; ")}`);

  // Verify chapterBeats adherence check detects missing mustInclude beats
  const incompletePart1Script = {
    scriptId: 1,
    segments: [
      { sourceStartSec: 10, sourceEndSec: 24, audio_mode: "keep_original", voiceover_text: "" }
      // Missing p1_b2 (45-75s)!
    ]
  };
  const completePart1Script = {
    scriptId: 1,
    segments: [
      { sourceStartSec: 10, sourceEndSec: 24, audio_mode: "keep_original", voiceover_text: "Deputies immediately sense something is wrong." },
      { sourceStartSec: 46, sourceEndSec: 74, audio_mode: "keep_original", voiceover_text: "When asked for the keys, the driver freezes." }
    ]
  };
  const evalIncomplete = Stage1.evaluateScriptsAgainstSeriesPlan([incompletePart1Script], normalizedPlan);
  assert.deepStrictEqual(evalIncomplete.report[0].missingChapterBeats, ["p1_b2"]);
  assert(evalIncomplete.warnings.some((w) => w.includes("p1_b2")));
  const evalComplete = Stage1.evaluateScriptsAgainstSeriesPlan([completePart1Script], normalizedPlan);
  assert.strictEqual(evalComplete.report[0].adherence, 1);
  assert.strictEqual(evalComplete.report[0].missingChapterBeats, undefined);

  // 4. Targeted proxy chunk selection per Part
  const expectedProxies = CHUNKS.map(([start, end], index) => ({
    filename: `analysis-proxy-chunk-00${index + 1}.mp4`,
    absolutePath: `/tmp/analysis-proxy-chunk-00${index + 1}.mp4`,
    sourceStartSec: start,
    sourceEndSec: end
  }));
  const part1Proxies = Stage1.selectProxyChunksForPart({ partPlan: normalizedPlan.parts[0], expectedProxyList: expectedProxies, maxChunks: 2 });
  const part2Proxies = Stage1.selectProxyChunksForPart({ partPlan: normalizedPlan.parts[1], expectedProxyList: expectedProxies, maxChunks: 2 });
  const part3Proxies = Stage1.selectProxyChunksForPart({ partPlan: normalizedPlan.parts[2], expectedProxyList: expectedProxies, maxChunks: 2 });
  assert.deepStrictEqual(part1Proxies.map((p) => p.filename), ["analysis-proxy-chunk-001.mp4"]);
  assert.deepStrictEqual(part2Proxies.map((p) => p.filename), ["analysis-proxy-chunk-002.mp4"]);
  assert.deepStrictEqual(part3Proxies.map((p) => p.filename), ["analysis-proxy-chunk-003.mp4"]);

  // 5. End-to-End Sequential Phase B run with targeted video grounding, continuity handoff, and per-Part repair
  const fixture = await createSeriesPackage("serialized_genz");
  const calls = [];
  let part2Attempts = 0;
  const baseResponder = defaultResponder({ durationSec: DURATION });
  const respond = (kind, prompt, call) => {
    if (kind === "series_plan") {
      return {
        envelope: {
          artifacts: [{ filename: "series-plan.json", script: buildBlueprintV2SeriesPlan(DURATION) }]
        }
      };
    }
    if (kind === "phase_b_part") {
      const scriptId = partScriptIdFromPrompt(prompt);
      const targetedVideos = proxyPathsFromPrompt(prompt);
      if (scriptId === 1) {
        return {
          viewFiles: targetedVideos,
          envelope: {
            artifacts: [{
              filename: "script-1.json",
              script: {
                artifactType: "highlight_cut_script",
                schemaVersion: 1,
                scriptId: 1,
                title: "Part 1 - The Confrontation",
                segments: [
                  { id: "s1_1", sceneId: "scene_0002", sourceStartSec: 10, sourceEndSec: 24, audio_mode: "keep_original", voiceover_text: "A routine traffic stop turns into a standoff." },
                  { id: "s1_2", sceneId: "scene_0005", sourceStartSec: 46, sourceEndSec: 74, audio_mode: "keep_original", voiceover_text: "Then deputies hear knocking from inside the trunk." }
                ]
              }
            }]
          }
        };
      }
      if (scriptId === 3) {
        part2Attempts += 1;
        // First attempt misses beat p2_b2 (165-190s) to trigger per-Part repair!
        return {
          viewFiles: targetedVideos,
          envelope: {
            artifacts: [{
              filename: "script-3.json",
              script: {
                artifactType: "highlight_cut_script",
                schemaVersion: 1,
                scriptId: 3,
                title: "Part 2 - The Interrogation (incomplete)",
                segments: [
                  { id: "s3_1", sceneId: "scene_0013", sourceStartSec: 122, sourceEndSec: 148, audio_mode: "keep_original", voiceover_text: "Pressed about the sound in the trunk, his story falls apart." }
                ]
              }
            }]
          }
        };
      }
      if (scriptId === 4) {
        // Test file-first write_to_file transport for Part 3!
        const script4 = {
          artifactType: "highlight_cut_script",
          schemaVersion: 1,
          scriptId: 4,
          title: "Part 3 - The Verdict & Arrest",
          segments: [
            { id: "s4_1", sceneId: "scene_0022", sourceStartSec: 216, sourceEndSec: 244, audio_mode: "keep_original", voiceover_text: "Fire rescue forces the trunk open and pulls the passenger to safety." },
            { id: "s4_2", sceneId: "scene_0026", sourceStartSec: 256, sourceEndSec: 288, audio_mode: "keep_original", voiceover_text: "Within seconds, the driver is placed in handcuffs for kidnapping." }
          ]
        };
        return {
          viewFiles: targetedVideos,
          writeFiles: [{
            name: "script-4.json",
            content: { artifacts: [{ filename: "script-4.json", script: script4 }] }
          }],
          rawResult: "PART_DONE"
        };
      }
    }
    if (kind === "phase_b_part_repair") {
      return {
        envelope: {
          artifacts: [{
            filename: "script-3.json",
            script: {
              artifactType: "highlight_cut_script",
              schemaVersion: 1,
              scriptId: 3,
              title: "Part 2 - The Interrogation",
              segments: [
                { id: "s3_1", sceneId: "scene_0013", sourceStartSec: 122, sourceEndSec: 148, audio_mode: "keep_original", voiceover_text: "Pressed about the sound in the trunk, his story falls apart." },
                { id: "s3_2", sceneId: "scene_0017", sourceStartSec: 166, sourceEndSec: 189, audio_mode: "keep_original", voiceover_text: "A text message on the dashboard exposes the truth." }
              ]
            }
          }]
        }
      };
    }
    return baseResponder(kind, prompt, call);
  };

  const service = new Stage1(
    {
      antigravityCommand: "agy",
      antigravityModel: "gemini-3.8-flash-high",
      antigravityCapacityRetryBaseMs: 0,
      phaseBArchitecture: "sequential"
    },
    {
      spawn: createPhaseAwareSpawn({ calls, respond }),
      authProbe: async () => ({ expiresAt: new Date(Date.now() + 50 * 60000), expiredFlag: false })
    }
  );

  const result = await service.run({ packageDir: fixture.root });
  assert.strictEqual(result.validFiles.length, 3, "all 3 sequential Part scripts must be generated and validated");
  assert.deepStrictEqual(
    calls.map((c) => c.kind),
    ["map", "map", "map", "reduce", "series_plan", "phase_b_part", "phase_b_part", "phase_b_part_repair", "phase_b_part"],
    "sequential Phase B runs 1 turn per Part and repairs Part 2 when a required chapterBeat is missed"
  );
  assert.strictEqual(part2Attempts, 1);

  // Verify each Part turn only viewed its own targeted proxy chunk (1 chunk each = 3 targeted views in Phase B)
  const partCalls = calls.filter((c) => c.kind === "phase_b_part");
  assert.strictEqual(partCalls.length, 3);
  assert(partCalls[0].prompt.includes("analysis-proxy-chunk-001.mp4") && !partCalls[0].prompt.includes("analysis-proxy-chunk-002.mp4"));
  assert(partCalls[1].prompt.includes("analysis-proxy-chunk-002.mp4") && !partCalls[1].prompt.includes("analysis-proxy-chunk-001.mp4"));
  assert(partCalls[2].prompt.includes("analysis-proxy-chunk-003.mp4") && !partCalls[2].prompt.includes("analysis-proxy-chunk-001.mp4"));

  // Verify continuity handoff was injected into Part 2 and Part 3 prompts
  assert(!partCalls[0].prompt.includes("CONTINUITY & NON-DUPLICATION HANDOFF FROM PREVIOUS PARTS"));
  assert(partCalls[1].prompt.includes("CONTINUITY & NON-DUPLICATION HANDOFF FROM PREVIOUS PARTS"));
  assert(partCalls[1].prompt.includes("Then deputies hear knocking from inside the trunk."));
  assert(partCalls[2].prompt.includes("A text message on the dashboard exposes the truth."));

  // Verify forensic-chunk-understandings.json was written for Phase B
  assert(result.forensicChunksPath, "forensicChunksPath must be returned");
  const savedForensic = JSON.parse(await fs.readFile(result.forensicChunksPath, "utf8"));
  assert.strictEqual(savedForensic.artifactType, "forensic_chunk_understandings");
  assert.strictEqual(savedForensic.chunkCount, 3);

  // Verify timing & run-info diagnostics
  assert.strictEqual(result.timing.scriptGeneration.architecture, "sequential");
  assert.strictEqual(result.timing.scriptGeneration.videoViewFileCount, 3);
  assert.strictEqual(result.timing.scriptGeneration.fullSourceRewatched, false);
  assert.strictEqual(result.timing.scriptGeneration.parts.length, 3);
  assert(result.timing.scriptGeneration.parts.every((p) => p.ok && p.adherence === 1));

  await fs.rm(fixture.root, { recursive: true, force: true });
  console.log("antigravitySequentialPhaseB tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
