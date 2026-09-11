// Explicit live smoke test. Credentials are read in memory, never copied to the test workspace.
const fs = require("fs/promises");
const path = require("path");
const Service = require("../electron/services/autoStoryFastService");
const ProjectStore = require("../electron/services/projectStore");
const Dubbing = require("../electron/services/dubbingService");

async function main() {
  const [configPath, projectPath, ...flags] = process.argv.slice(2);
  if (!configPath || !projectPath) throw new Error("Usage: node tools/verifyAutoStoryFast.js config.json project.json [--run-ai] [--render] [--review]");
  const settings = JSON.parse(await fs.readFile(configPath, "utf8"));
  const original = JSON.parse(await fs.readFile(projectPath, "utf8"));
  const workspaceRoot = path.resolve(".tmp/auto-story-live-check");
  await fs.mkdir(workspaceRoot, { recursive: true });
  settings.workspaceRoot = workspaceRoot;
  const store = new ProjectStore();
  const dubbing = new Dubbing(store);
  const service = new Service(settings, store, { dubbing });
  const voice = await service.measuredVoice({ ...original, draftVoiceMode: "final" }, "The officer asks a simple question, but the answer changes what happens next.", workspaceRoot);
  console.log(JSON.stringify({ step: "real_voice", seconds: voice.meta.duration, provider: original.voiceProvider, voiceId: original.voiceId }));
  if (!flags.includes("--run-ai") && !flags.includes("--render-existing")) return;
  const existing = flags.includes("--render-existing");
  if (existing && path.resolve(path.dirname(projectPath)) !== path.resolve(store.getProjectPaths(workspaceRoot, original.id).rootDir)) throw new Error("Only disposable live-check projects can be replayed.");
  const project = existing ? original : await store.createProject(workspaceRoot, { ...original, title: "Auto Story live verification",
    exportRoot: workspaceRoot,
    autoStoryConfig: { ...original.autoStoryConfig, outputCount: 1 }, analysisWorkflow: "vertex_auto_story" });
  console.log(JSON.stringify({ step: "test_project", id: project.id }));
  const onProgress = p => console.log(JSON.stringify({ step: p.stage || p.step, percent: p.percent, message: p.message }));
  if (!existing) await service.run({ workspaceRoot, projectId: project.id, onProgress });
  if (existing) {
    const analysisDir = store.getProjectPaths(workspaceRoot, project.id).analysisDir;
    const translations = [];
    for (const variant of original.analysis.highlightVariants) {
      const edit = JSON.parse(await fs.readFile(path.join(analysisDir, "auto-story-fast", `edit-${variant.scriptId}.json`), "utf8"));
      translations.push(...edit.segments.filter(s => s.audioMode === "voiceover_only").map(s => ({ text: s.voiceoverText.trim(), vi: s.previewVi })));
    }
    await store.updateProject(workspaceRoot, project.id, { autoStoryNarrationTranslations: translations,
      videoDecoration: { ...original.videoDecoration, canvasEnabled: true, canvasAspect: "9:16", blurBackgroundEnabled: true } });
  }
  if (!flags.includes("--render")) return;
  if (!existing) await dubbing.importHighlightCutProject({ workspaceRoot, projectId: project.id, settings, onProgress });
  await dubbing.renderAllHighlightFastDraftVariants({ workspaceRoot, projectId: project.id, settings, onProgress });
  if (flags.includes("--review")) await service.auditDrafts({ workspaceRoot, projectId: project.id, onProgress });
  const final = await store.getProject(workspaceRoot, project.id);
  console.log(JSON.stringify({ step: "complete", id: final.id, artifacts: final.artifacts, audits: final.analysis?.autoStoryAudits }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => {
    require("../electron/services/kokoroVoiceService").shutdownPersistentWorkers();
    require("../electron/services/localTranslationService").shutdownPersistentWorkers();
  });
