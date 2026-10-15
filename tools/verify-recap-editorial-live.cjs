const fs = require("fs/promises");
const path = require("path");
const assert = require("assert/strict");
const Store = require("../electron/services/projectStore");
const Pipeline = require("../electron/services/recap/recapPipelineService");
const Kokoro = require("../electron/services/kokoroVoiceService");
const Ai = require("../electron/services/recap/recapAiService");
const { createScopedToken } = require("../electron/services/cancelToken");
async function main() {
  const settings = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, "cineviral-studio/config.json"), "utf8"));
  if (process.argv.includes("--vertex")) settings.aiProvider = "vertex_ai";
  settings.recapCaptionAsrModel = "tiny.en";
  const audit = JSON.parse(await fs.readFile(path.resolve(__dirname, "../.tmp/recap-audio-audit/the-whole-springfield-is-devastated-by-radiation-4a61298b-manifest.json"), "utf8"));
  const root = path.resolve(__dirname, "../.tmp/recap-editorial-live"); await fs.mkdir(root, { recursive: true });
  const store = new Store();
  const resumeId = process.argv[process.argv.indexOf("--resume") + 1];
  const resuming = process.argv.includes("--resume");
  const project = resuming ? await store.getProject(root, resumeId) : await store.createProject(root, { title: "Simpsons recap upgrade check", sourceVideoPath: audit.project.sourceVideoPath, mode: "recap",
    targetDurationSec: 30, voiceProvider: "kokoro", voiceId: "am_adam", voiceSpeed: 1, allowShotReuse: true, recapMuteSourceAudio: true,
    recapEditorialSelection: "manual", recapNarrationLanguage: "en", recapNarrationStyle: "natural", recapAspectRatio: "9:16", recapFraming: "fit_blur", recapCaptionStyle: "phrase" });
  const paths = store.getProjectPaths(root, project.id);
  await fs.mkdir(paths.analysisDir, { recursive: true });
  const { sourceMeta, proxyPath, scenes, visualEvents, storyModel } = audit.state;
  if (!resuming) await fs.writeFile(path.join(paths.analysisDir, "recap_state.json"), JSON.stringify({ analysisVersion: 2, completedStages: [], sourceMeta, proxyPath, scenes, visualEvents, storyModel }));
  let latestAi;
  const service = new Pipeline({ projectStore: store, serviceFactories: { ai: (options) => (latestAi = new Ai(options)) } }); const cancelToken = createScopedToken("live upgrade verification");
  let last = "";
  const run = () => service.runRecapProject({ workspaceRoot: root, projectId: project.id, settings, cancelToken,
    onProgress: (progress) => { const message = `[${progress.stage}] ${progress.message}`; if (message !== last) { console.log(message); last = message; } } });
  console.log("Provider:", settings.aiProvider, "Project:", project.id);
  if (!resuming) {
    const choices = await run(); assert.equal(choices.status, "editorial_ready"); assert.equal(choices.editorial.hooks.length, 3);
    console.log("Grounded angles:", choices.editorial.angles.map((angle) => angle.title).join(" | "));
    await service.chooseEditorial(root, project.id, { angleId: choices.editorial.selectedAngleId, hookId: choices.editorial.selectedHookId, approve: true });
  }
  const result = await run();
  await fs.writeFile(path.join(root, "verification-result.json"), JSON.stringify(result, null, 2));
  if (latestAi.providerService.vertex?.lastResponseText) await fs.writeFile(path.join(root, "last-ai-response.txt"), latestAi.providerService.vertex.lastResponseText);
  assert.ok(["completed", "quality_blocked"].includes(result.status));
  console.log("Live verification result:", result.status, result.finalVideoPath || JSON.stringify(result.blockers));
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; }).finally(() => Kokoro.shutdownPersistentWorkers());
