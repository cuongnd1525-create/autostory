const fs = require("fs/promises");
const path = require("path");
const Renderer = require("../electron/services/recap/recapRenderer");

async function main() {
  const folder = path.resolve(__dirname, "../.tmp/recap-audio-audit");
  const filename = (await fs.readdir(folder)).find((file) => file.endsWith("manifest.json"));
  if (!filename) throw new Error("Run audit-recap-audio.cjs first.");
  const manifest = JSON.parse(await fs.readFile(path.join(folder, filename), "utf8"));
  const renderer = new Renderer({ ...manifest.settings });
  const output = path.join(folder, path.basename(manifest.target).replace(/\.mp4$/i, "-audio-fixed.mp4"));
  const encoder = await renderer.hardwareService.detectBestEncoder();
  console.log("Rendering with:", encoder.label);
  let lastMessage = "";
  await renderer.renderFinal({ sourceVideoPath: manifest.project.sourceVideoPath, decisions: manifest.state.decisions, outputPath: output,
    onProgress: (progress) => { if (progress.message !== lastMessage) { console.log(progress.message); lastMessage = progress.message; } } });
  console.log("Repaired output:", output);
  console.log("Probe:", JSON.stringify(await renderer.probeVideo(output)));
  console.log("Expected timeline duration:", renderer.getTimelineDuration(manifest.state.decisions));
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
