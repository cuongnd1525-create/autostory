const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const ProjectStore = require("../electron/services/projectStore");
const RenderJobService = require("../electron/services/renderJobService");

(async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recap-render-recovery-"));
  try {
    const projectStore = new ProjectStore();
    const project = await projectStore.createProject(workspaceRoot, {
      title: "Recovery test",
      sourceVideoPath: path.join(workspaceRoot, "source.mp4")
    });
    const firstSession = new RenderJobService(projectStore);
    const original = await firstSession.start({ workspaceRoot, projectId: project.id, type: "final" });
    firstSession.progress(original.id, { step: "voice", percent: 42, message: "Dang tao voice" });

    const restartedSession = new RenderJobService(projectStore);
    const recovered = await restartedSession.recoverInterruptedJobs({ workspaceRoot });
    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(recovered[0].id, original.id);
    assert.strictEqual(recovered[0].status, "interrupted");
    assert.strictEqual(recovered[0].canResume, true);

    const interruptedProject = await projectStore.getProject(workspaceRoot, project.id);
    assert.strictEqual(interruptedProject.status, "render_interrupted");
    assert.strictEqual(interruptedProject.artifacts.recoverableRenderJobId, original.id);

    const resumable = await restartedSession.prepareResume({ workspaceRoot, projectId: project.id });
    const resumed = await restartedSession.start({
      workspaceRoot,
      projectId: project.id,
      type: resumable.type,
      resumedFrom: resumable
    });
    assert.strictEqual(resumed.attempt, 2);
    assert.strictEqual(resumed.resumedFromJobId, original.id);
    await restartedSession.finish(resumed.id, "completed", "", { workspaceRoot, projectId: project.id });

    const completedProject = await projectStore.getProject(workspaceRoot, project.id);
    assert.strictEqual(completedProject.artifacts.activeRenderJobId, "");
    assert.strictEqual(completedProject.artifacts.recoverableRenderJobId, "");
    console.log("render job recovery tests passed");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
