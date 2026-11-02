const fs = require("node:fs/promises"), path = require("node:path"), assert = require("node:assert/strict");
const Renderer = require("../electron/services/recap/recapRenderer");
const Preflight = require("../electron/services/recap/recapNarrativePreflightService");
const Editorial = require("../electron/services/recap/recapEditorialService");
const Ai = require("../electron/services/recap/recapAiService");

async function main() {
  const projectDirectory = process.argv[2]; if (!projectDirectory) throw new Error("Provide a saved real project directory.");
  const project = JSON.parse(await fs.readFile(path.join(projectDirectory, "project.json"), "utf8"));
  const state = JSON.parse(await fs.readFile(path.join(projectDirectory, "analysis", "recap_state.json"), "utf8"));
  const root = path.resolve(__dirname, "../.tmp/recap-upgrade", `${Date.now()}-${process.pid}`); await fs.mkdir(root, { recursive: true });
  const report = { originalProjectModified: false, fullRecapApproved: false, artifacts: root };
  const preflight = new Preflight(), options = { ...Editorial.optionsFor(project), allowShotReuse: Boolean(project.allowShotReuse) };
  report.scriptEstimate = preflight.estimate({ speechUnits: state.speechUnits, events: state.visualEvents, options,
    wordsPerSecond: 2.6, audioTracks: state.audioTracks });
  if (process.argv.includes("--preflight")) {
    const settings = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, "cineviral-studio", "config.json"), "utf8"));
    const index = process.argv.indexOf("--daily-limit"), limit = Number(process.argv[index + 1]);
    if (index < 0 || !(limit > 0 && limit <= 5 && (!settings.vertexDailyLimitUsd || limit <= settings.vertexDailyLimitUsd)))
      throw new Error("Live preflight requires --daily-limit at or below both $5 and the configured daily limit.");
    settings.vertexDailyLimitUsd = limit; settings.recapVertexMaxOutputTokens = 16384;
    const ai = new Ai(settings), started = Date.now();
    const result = await preflight.run({ speechUnits: state.speechUnits, events: state.visualEvents, recapPlan: state.recapPlan,
      options, wordsPerSecond: report.scriptEstimate.wordsPerSecond, audioTracks: state.audioTracks, voiceKey: "native-verification",
      ai, onProgress: item => { if (item.message) console.log(item.message); } });
    await fs.writeFile(path.join(root, "preflight.json"), JSON.stringify(result, null, 2));
    report.livePreflight = { seconds: (Date.now() - started) / 1000, repaired: result.report.repaired,
      initialEditorialScore: result.report.review.overall_score,
      beforeWords: result.report.before.wordCount, afterWords: result.report.after.wordCount,
      beforeEstimatedSec: result.report.before.duration.actual, afterEstimatedSec: result.report.after.duration.actual,
      predictedOverflowGroupsBefore: result.report.before.clauseBudgets.length, predictedOverflowGroupsAfter: result.report.after.clauseBudgets.length };
  }
  if (!process.argv.includes("--preflight-only")) {
    const renderer = new Renderer(); await renderer.hardwareService.detectBestEncoder();
    const runs = [];
    for (const name of ["cold", "warm"]) {
      const outputPath = path.join(root, `${name}.mp4`); let hits = 0, segments = 0; const started = Date.now();
      await renderer.renderDraft({ sourceVideoPath: project.sourceVideoPath, proxyVideoPath: state.proxyPath,
        decisions: state.decisions, muteSourceAudio: Boolean(project.recapMuteSourceAudio), presentation: { aspect: project.recapAspectRatio || "original", captions: "off" },
        outputPath, onProgress: item => { if (typeof item.cacheHit === "boolean") { segments++; if (item.cacheHit) hits++; } } });
      runs.push({ name, seconds: (Date.now() - started) / 1000, cacheHits: hits, segments, outputPath });
    }
    assert.equal(runs[1].cacheHits, runs[1].segments, "unchanged real clips must all reuse cache");
    const checksum = async (file, stream) => (await renderer.runCommand(renderer.ffmpegPath,
      ["-v", "error", "-i", file, "-map", stream, "-f", "hash", "-hash", "sha256", "-"], { captureStdout: true })).trim();
    for (const stream of ["0:v:0", "0:a:0"]) assert.equal(await checksum(runs[0].outputPath, stream), await checksum(runs[1].outputPath, stream), "cached render must preserve decoded video/audio");
    report.renderBenchmark = { runs, decodedVideoAndAudioIdentical: true, speedup: Number((runs[0].seconds / runs[1].seconds).toFixed(2)),
      timeReductionPercent: Number(((1 - runs[1].seconds / runs[0].seconds) * 100).toFixed(1)), scope: "repeat_draft_render_only" };
  }
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, scriptEstimate: { words: report.scriptEstimate.wordCount, seconds: report.scriptEstimate.duration.actual } }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
