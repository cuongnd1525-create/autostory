const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const PodcastCandidateService = require("../electron/services/podcastCandidateService");
const { inspectGeminiJsonFiles } = require("../electron/services/geminiJsonArtifactService");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-candidate-flow-"));
  const packageDir = path.join(root, "pack");
  const stage1 = path.join(packageDir, "01-GUI-GEMINI");
  const sourceVideoPath = path.join(root, "source.mp4");
  await fs.mkdir(stage1, { recursive: true });
  await fs.writeFile(sourceVideoPath, "mock-video");
  await fs.writeFile(path.join(packageDir, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_podcast_cut",
    workflowMode: "quality_two_pass",
    sourceVideoPath,
    outputCount: 1,
    targetMinSec: 15,
    targetMaxSec: 30
  }));
  const sourceMap = {
    artifactType: "podcast_source_map",
    sourceMatchId: "source-1",
    localDurationSec: 30,
    dialogueUnitCount: 1,
    dialogueUnitPartCount: 1
  };
  await fs.writeFile(path.join(stage1, "podcast-source-map.json"), JSON.stringify(sourceMap));
  await fs.writeFile(path.join(packageDir, "podcast-dialogue-units.full.json"), JSON.stringify({
    dialogueUnits: [{
      dialogueUnitId: "dialogue_00001",
      speaker: "unknown",
      sourceStartSec: 3,
      sourceEndSec: 8,
      transcriptText: "Can you take it off?",
      words: [],
      cutOptions: [{
        cutOptionId: "dialogue_00001_full",
        sourceSpans: [{ startSec: 3, endSec: 8 }],
        resultText: "Can you take it off?",
        durationSec: 5
      }]
    }]
  }));
  const candidatePath = path.join(root, "candidate.json");
  await fs.writeFile(candidatePath, JSON.stringify({
    artifactType: "podcast_candidate_map",
    sourceMatchId: "source-1",
    accessAudit: {
      accessGranted: true,
      accessMode: "transcript_locked",
      transcriptCoverageVerified: true,
      dialogueUnitsParsed: true,
      dialogueUnitPartsParsed: true,
      dialogueUnitCountVerified: true,
      sourceMapParsed: true,
      sourceMatchVerified: true
    },
    candidates: [{
      candidateId: "candidate_001",
      sourceSpans: [
        {
          spanId: "candidate_001_span_01",
          editorialRole: "hook",
          sourceStartSec: 3,
          sourceEndSec: 11
        },
        {
          spanId: "candidate_001_span_02",
          editorialRole: "visual_payoff",
          sourceStartSec: 15,
          sourceEndSec: 23
        }
      ],
      primaryTrigger: "visual_action",
      sceneScore: 9,
      hookQuote: "Can you take it off?",
      payoff: "The challenge begins.",
      mustIncludeMoments: [{
        momentId: "candidate_001_moment_01",
        role: "visual_payoff",
        sourceStartSec: 18,
        sourceEndSec: 23,
        description: "The guest begins the physical reveal."
      }]
    }]
  }));
  const [inspection] = await inspectGeminiJsonFiles([candidatePath]);
  assert.strictEqual(inspection.type, "podcast_candidate_map");
  assert.strictEqual(inspection.importRoute, "podcast_candidates");

  const ffmpeg = {
    ffmpegPath: "ffmpeg",
    async extractFastPreviewClipWithAudio({ outputPath }) {
      await fs.writeFile(outputPath, "mock-reel");
    },
    async concatSegmentsSafely(_paths, outputPath) {
      await fs.writeFile(outputPath, "mock-reel");
    },
    async run(_command, args) {
      await fs.writeFile(args.at(-1), "mock-audio");
    }
  };
  const subtitleService = {
    async transcribeToSrt({ outputDir }) {
      await fs.mkdir(outputDir, { recursive: true });
      const subtitlePath = path.join(outputDir, "candidate.srt");
      const wordTimestampsPath = path.join(outputDir, "candidate.words.json");
      await fs.writeFile(subtitlePath, "1\n00:00:00,000 --> 00:00:02,000\nCan you take it off?\n");
      await fs.writeFile(wordTimestampsPath, JSON.stringify({
        segments: [{
          start: 0,
          end: 2,
          words: [
            { word: "Can", start: 0, end: 0.3 },
            { word: "you", start: 0.3, end: 0.6 },
            { word: "take", start: 0.6, end: 1 },
            { word: "it", start: 1, end: 1.3 },
            { word: "off?", start: 1.3, end: 2 }
          ]
        }]
      }));
      return { subtitlePath, wordTimestampsPath };
    }
  };

  const service = new PodcastCandidateService({}, { ffmpeg, subtitleService });
  const result = await service.importCandidates({ packageDir, candidatePath });
  assert.strictEqual(result.candidateCount, 1);
  assert.strictEqual(result.reelCount, 1);
  assert.strictEqual(result.outputCount, 1);
  assert.ok(result.uploadFileCount <= 10);
  const stage2Files = await fs.readdir(result.stage2UploadDir);
  assert.ok(stage2Files.includes("02-podcast-assembly-prompt.txt"));
  assert.ok(stage2Files.includes("candidate-reel-part-01.mp4"));
  assert.ok(stage2Files.includes("podcast-candidate-map.resolved.json"));
  const assembly = JSON.parse(await fs.readFile(
    path.join(packageDir, "podcast-assembly-dialogue-units.full.json"),
    "utf8"
  ));
  assert.strictEqual(assembly.dialogueUnits.length, 2);
  const dialogueUnit = assembly.dialogueUnits.find((unit) => unit.unitType !== "visual_moment");
  const visualUnit = assembly.dialogueUnits.find((unit) => unit.unitType === "visual_moment");
  assert.strictEqual(dialogueUnit.sourceStartSec, 3);
  assert.strictEqual(dialogueUnit.candidateId, "candidate_001");
  assert.strictEqual(visualUnit.dialogueUnitId, "visual_candidate_001_01");
  assert.strictEqual(visualUnit.sourceStartSec, 18);
  const resolved = JSON.parse(await fs.readFile(
    path.join(result.stage2UploadDir, "podcast-candidate-map.resolved.json"),
    "utf8"
  ));
  assert.strictEqual(resolved.candidates[0].sourceSpans.length, 2);
  assert.strictEqual(resolved.candidates[0].sourceSpans[1].reelStartSec, 8);
  assert.deepStrictEqual(resolved.candidates[0].requiredMomentUnitIds, ["visual_candidate_001_01"]);

  const invalidCandidatePath = path.join(root, "candidate-invalid.json");
  const invalidPayload = JSON.parse(await fs.readFile(candidatePath, "utf8"));
  invalidPayload.candidates[0].mustIncludeMoments = [];
  await fs.writeFile(invalidCandidatePath, JSON.stringify(invalidPayload));
  await assert.rejects(
    () => service.importCandidates({ packageDir, candidatePath: invalidCandidatePath }),
    /Đã tạo gói yêu cầu Gemini sửa Candidate Map/
  );
  const repairFiles = await fs.readdir(path.join(packageDir, "02-CANDIDATE-REPAIR"));
  assert.ok(repairFiles.includes("02-podcast-candidate-repair-prompt.txt"));
  assert.ok(repairFiles.includes("podcast-candidate-map-invalid.json"));

  await fs.rm(root, { recursive: true, force: true });
  console.log("podcast candidate workflow tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
