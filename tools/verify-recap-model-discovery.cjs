const fs = require("node:fs/promises");
const path = require("node:path");
const Provider = require("../electron/services/recap/recapProviderService");
async function main() {
  const settings = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, "cineviral-studio", "config.json"), "utf8"));
  const provider = new Provider({ ...settings, aiProvider: "antigravity_cli" });
  const obsolete = "gemini-3.7-flash-low";
  const plan = await provider.prepareModels(obsolete, { filePaths: ["fixture.mp4"], force: true });
  if (plan.includes(obsolete) || plan.some((value) => !provider.availableModels.some((model) => model.value === value))) throw new Error("Fallback contains an unavailable model.");
  const report = { passed: true, inferenceCalls: 0, obsolete, videoPlan: plan, availableModels: provider.availableModels };
  const folder = path.resolve(__dirname, "../.tmp/recap-model-discovery"); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, availableModels: provider.availableModels.map((model) => model.value) }));
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
