const fs = require("node:fs/promises");
const path = require("node:path");
const Ai = require("../electron/services/recap/recapAiService");

async function main() {
  const projectDir = process.argv[2];
  if (!projectDir) throw new Error("Usage: node tools/verify-recap-analysis-speed.cjs <project-directory>");
  const settings = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, "cineviral-studio", "config.json"), "utf8"));
  const modelArg = process.argv.indexOf("--model");
  if (modelArg >= 0) settings.antigravityModel = process.argv[modelArg + 1];
  const state = JSON.parse(await fs.readFile(path.join(projectDir, "analysis", "recap_state.json"), "utf8"));
  const chunkArg = process.argv.indexOf("--chunk");
  const planned = JSON.parse(state.chunkAnalysisKey).chunks;
  const chunk = chunkArg >= 0 ? planned.find((value) => value.chunkIndex === Number(process.argv[chunkArg + 1])) : planned.at(-1);
  if (!chunk) throw new Error("Requested chunk not found.");
  const video = path.join(projectDir, "analysis", "chunks", `recap-proxy-chunk-${String(chunk.chunkIndex).padStart(3, "0")}.mp4`);
  await fs.access(video);
  const ai = new Ai(settings), controller = new AbortController();
  const modelCalls = [], fallbackCheck = process.argv.includes("--fallback-check"); let rawResultCharacters;
  if (fallbackCheck) {
    if (ai.providerService.provider !== "antigravity_cli") throw new Error("Fallback check requires Antigravity CLI.");
  }
  const actualCall = ai.providerService.generateJsonFromFiles.bind(ai.providerService);
  ai.providerService.generateJsonFromFiles = async (options) => {
      modelCalls.push(options.modelOverride);
      if (fallbackCheck && modelCalls.length === 1) {
        console.log("Simulating primary output-token failure to verify a real fallback call.");
        throw Object.assign(new Error("Simulated output token limit"), { kind: "output_limit" });
      }
      const result = await actualCall(options); rawResultCharacters = JSON.stringify(result).length;
      const auditFolder = path.resolve(__dirname, "../.tmp/recap-analysis-speed"); await fs.mkdir(auditFolder, { recursive: true });
      await fs.writeFile(path.join(auditFolder, `chunk-${chunk.chunkIndex}-raw.json`), JSON.stringify(result, null, 2));
      return result;
    };
  const timer = setTimeout(() => controller.abort(), 180000);
  const startedAt = Date.now(); let lastReportAt = 0;
  console.log(JSON.stringify({ provider: ai.providerService.label, model: ai.getAnalysisModel(), durationSec: chunk.durationSec }));
  try {
    const result = await ai.analyzeVideoChunk({ chunkVideoPath: video, chunkMetadata: chunk, signal: controller.signal,
      onProgress: (value) => {
        if (value.message) console.log(value.message);
        else if (Date.now() - lastReportAt >= 30000) { lastReportAt = Date.now(); console.log(`Waiting ${Math.round((Date.now() - startedAt) / 1000)}s...`); }
      } });
    const report = { passed: true, elapsedSec: (Date.now() - startedAt) / 1000,
      durationSec: chunk.durationSec, provider: ai.providerService.label, model: modelCalls.at(-1),
      events: result.events.length, rawResultCharacters, resultCharacters: JSON.stringify(result).length, modelCalls, ...(fallbackCheck ? { simulatedPrimaryFailure: true } : {}), result };
    if (!result.events.length) throw new Error("No grounded visual events returned.");
    const folder = path.resolve(__dirname, "../.tmp/recap-analysis-speed"); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, chunkArg >= 0 ? `chunk-${chunk.chunkIndex}-result.json` : fallbackCheck ? "fallback-result.json" : "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, result: undefined }));
  } finally { clearTimeout(timer); }
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
