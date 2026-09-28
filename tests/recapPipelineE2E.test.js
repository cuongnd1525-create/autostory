const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const RecapMediaService = require("../electron/services/recap/recapMediaService");
const RecapHardwareService = require("../electron/services/recap/recapHardwareService");
const { RecapSyncSolver } = require("../electron/services/recap/recapSyncSolver");
const RecapRenderer = require("../electron/services/recap/recapRenderer");
const ProjectStore = require("../electron/services/projectStore");

function runCommand(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${binary} failed with code ${code}: ${stderr}`));
    });
  });
}

async function runE2ETest() {
  const tempDir = path.join(os.tmpdir(), `recap-e2e-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });

  const sourceVideo = path.join(tempDir, "synth_source.mp4");
  const draftOutput = path.join(tempDir, "draft_output.mp4");
  const finalOutput = path.join(tempDir, "final_output.mp4");

  try {
    console.log("1. Generating synthetic 12s test video...");
    // 12s test video, 1280x720, 25fps with audio
    await runCommand("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "testsrc=duration=12:size=1280x720:rate=25",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=12",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      sourceVideo
    ]);

    // 2. Test Media Service
    console.log("2. Probing video and creating 480p/8fps analysis proxy...");
    const mediaService = new RecapMediaService();
    const probe = await mediaService.probeVideo(sourceVideo);
    assert.strictEqual(Math.round(probe.duration), 12, "Probed duration should be ~12s");
    assert.strictEqual(probe.width, 1280, "Probed width should be 1280");
    assert.strictEqual(probe.hasAudio, true, "Source should have audio");

    const proxyDir = path.join(tempDir, "proxy");
    const proxyPath = await mediaService.ensureAnalysisProxy({
      sourceVideoPath: sourceVideo,
      outputDir: proxyDir
    });
    assert.ok(proxyPath && (await fs.stat(proxyPath)).size > 0, "Proxy file must be generated");

    const proxyProbe = await mediaService.probeVideo(proxyPath);
    assert.ok(proxyProbe.width <= 480, `Proxy width should be <= 480 (got ${proxyProbe.width})`);
    assert.strictEqual(Math.round(proxyProbe.fps), 8, `Proxy fps should be 8 (got ${proxyProbe.fps})`);

    // 3. Generate dummy TTS speech audio with edge silence
    console.log("3. Generating speech units and synthetic audio...");
    const audioDir = path.join(tempDir, "audio");
    await fs.mkdir(audioDir, { recursive: true });

    const speech1Audio = path.join(audioDir, "speech_1.wav");
    const speech2Audio = path.join(audioDir, "speech_2.wav");

    // Generate 2.5s speech audio track 1
    await runCommand("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=260:duration=2.5",
      "-c:a", "pcm_s16le",
      speech1Audio
    ]);

    // Generate 3.0s speech audio track 2
    await runCommand("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=330:duration=3.0",
      "-c:a", "pcm_s16le",
      speech2Audio
    ]);

    const speechUnits = [
      {
        id: "su_01",
        text: "The mystery begins as the clock ticks forward.",
        visual_event_ids: ["ev_1"],
        target_duration_budget: 3.0
      },
      {
        id: "su_02",
        text: "Suddenly, the tension rises to its peak.",
        visual_event_ids: ["ev_2"],
        target_duration_budget: 3.5
      }
    ];

    const visualEvents = [
      {
        id: "ev_1",
        source_start: 1.0,
        source_end: 4.5,
        duration: 3.5,
        description: "Opening clock visual",
        face_closeup: false,
        lip_sync_risk: false
      },
      {
        id: "ev_2",
        source_start: 6.0,
        source_end: 10.0,
        duration: 4.0,
        description: "Tension visual",
        face_closeup: false,
        lip_sync_risk: false
      }
    ];

    const audioTracks = {
      su_01: { audioPath: speech1Audio, durationSec: 2.5 },
      su_02: { audioPath: speech2Audio, durationSec: 3.0 }
    };

    // 4. Solve Semantic Synchronization
    console.log("4. Solving semantic synchronization...");
    const solver = new RecapSyncSolver({
      allowShotReuse: false,
      targetVisualLeadSec: 0.25
    });

    const solution = solver.solve({
      speechUnits,
      visualEvents,
      audioTracks,
      sourceDurationSec: probe.duration
    });

    assert.strictEqual(solution.decisions.length, 2);
    assert.strictEqual(solution.traceability.length, 2);
    assert.ok(solution.decisions[0].clips[0].lead_ms > 0, "Lead ms should be positive");

    // 5. Render Draft Proxy Video
    console.log("5. Rendering draft proxy video...");
    const hardwareService = new RecapHardwareService();
    const renderer = new RecapRenderer({ hardwareService });

    await renderer.renderDraft({
      sourceVideoPath: sourceVideo,
      proxyVideoPath: proxyPath,
      decisions: solution.decisions,
      outputPath: draftOutput
    });

    const draftProbe = await mediaService.probeVideo(draftOutput);
    assert.ok(draftProbe.duration > 4, `Draft duration should be > 4s (got ${draftProbe.duration}s)`);
    assert.strictEqual(draftProbe.hasAudio, true, "Draft should have mixed audio");
    console.log(`   Draft reel rendered successfully: ${draftProbe.duration}s`);

    // 6. Render Final Master Video from original source
    console.log("6. Rendering final master video from pristine source...");
    await renderer.renderFinal({
      sourceVideoPath: sourceVideo,
      decisions: solution.decisions,
      outputPath: finalOutput
    });

    const finalProbe = await mediaService.probeVideo(finalOutput);
    assert.ok(finalProbe.duration > 4, `Final duration should be > 4s (got ${finalProbe.duration}s)`);
    assert.strictEqual(finalProbe.width, 1280, "Final master should preserve native 1280 resolution");
    assert.strictEqual(finalProbe.hasAudio, true, "Final master should have mixed audio");
    console.log(`   Final master rendered successfully: ${finalProbe.width}x${finalProbe.height}, ${finalProbe.duration}s`);

    console.log("\n==========================================");
    console.log("recapPipelineE2E.test.js PASSED COMPLETELY");
    console.log("==========================================\n");
  } finally {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (_err) {}
  }
}

runE2ETest().catch((err) => {
  console.error("recapPipelineE2E.test.js FAILED:", err);
  process.exit(1);
});
