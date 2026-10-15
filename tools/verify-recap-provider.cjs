const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const Ai = require("../electron/services/recap/recapAiService");
const { buildCliEnv } = require("../electron/services/cliEnv");

async function command(file, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: buildCliEnv(), windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-3000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

async function main() {
  const settings = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, "cineviral-studio", "config.json"), "utf8"));
  if (process.argv.includes("--vertex")) settings.aiProvider = "vertex_ai";
  const folder = path.resolve(__dirname, "../.tmp/recap-provider-check");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "moving-pattern.mp4");
  await command(settings.ffmpegPath || "ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=duration=6:size=320x240:rate=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  const ai = new Ai(settings);
  console.log("Selected provider:", ai.providerService.label);
  const result = await ai.analyzeVideoChunk({ chunkPath: file, chunkInfo: { chunkIndex: 1, sourceStartSec: 0, sourceEndSec: 6, durationSec: 6 }, signal: AbortSignal.timeout(180000), onProgress: (progress) => console.log(progress.message) });
  if (!result.events.length) throw new Error("Provider returned no visible events.");
  console.log("Real video analysis OK:", result.summary, "Events:", result.events.length);
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
