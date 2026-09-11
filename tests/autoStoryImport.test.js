const assert = require("assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const Store = require("../electron/services/projectStore");
const Dubbing = require("../electron/services/dubbingService");
const Ffmpeg = require("../electron/services/ffmpegService");
async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-story-import-"));
  const probe = Ffmpeg.prototype.probeVideo;
  try {
    Ffmpeg.prototype.probeVideo = async () => ({ duration: 120, width: 640, height: 360 });
    const paths = [];
    for (const id of [2, 1, 3]) {
      const file = path.join(root, `script-${id}.json`);
      await fs.writeFile(file, JSON.stringify({ artifactType: "vertex_auto_story_script", scriptId: id, title: `Story ${id}`,
        segments: [{ id: "hook", sourceStartSec: 0, sourceEndSec: 10, audio_mode: "original_audio", voiceover_text: "", source_narrator_detected: false }] }));
      paths.push(file);
    }
    const store = new Store();
    const project = await store.createProject(root, { title: "IDs", sourceVideoPath: path.join(root, "source.mp4"), mode: "highlight_cut", analysisWorkflow: "vertex_auto_story", storyScriptPaths: paths });
    const imported = await new Dubbing(store).importHighlightCutProject({ workspaceRoot: root, projectId: project.id, settings: {} });
    assert.deepEqual(imported.analysis.highlightVariants.map(v => v.scriptId), [2, 1, 3]);
    const persisted = await store.getProject(root, project.id);
    assert(persisted.analysis.highlightVariants.every(v => Number.isInteger(v.scriptId)));
    console.log("autoStoryImport tests passed");
  } finally { Ffmpeg.prototype.probeVideo = probe; await fs.rm(root, { recursive: true, force: true }); }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
