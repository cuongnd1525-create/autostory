const assert = require("assert");

const DubbingService = require("../electron/services/dubbingService");

async function run() {
  const variants = ["variant_01", "variant_02", "variant_03"].map((id, index) => ({
    id,
    label: `Variant ${index + 1}`,
    segments: [{ id: `segment_${index + 1}`, startSec: 0, endSec: 5 }],
    warnings: [],
    artifacts: {}
  }));
  let project = {
    id: "queue-test",
    mode: "highlight_cut",
    analysis: {
      activeVariantId: variants[0].id,
      highlightVariants: variants,
      segments: variants[0].segments,
      scenes: []
    }
  };
  const projectStore = {
    async getProject() {
      return project;
    },
    async updateProject(_workspaceRoot, _projectId, partial) {
      project = {
        ...project,
        ...partial,
        analysis: partial.analysis || project.analysis
      };
      return project;
    }
  };
  const service = new DubbingService(projectStore);
  service.renderHighlightCutProject = async ({ project: selectedProject, onProgress }) => {
    const activeId = selectedProject.analysis.activeVariantId;
    onProgress?.({ step: "rendering", percent: 50, message: `Rendering ${activeId}` });
    if (activeId === "variant_02") {
      throw new Error("Synthetic render failure");
    }
    const updatedVariants = selectedProject.analysis.highlightVariants.map((variant) => (
      variant.id === activeId
        ? { ...variant, artifacts: { finalVideoPath: `${activeId}.mp4` } }
        : variant
    ));
    project = {
      ...selectedProject,
      analysis: {
        ...selectedProject.analysis,
        highlightVariants: updatedVariants
      }
    };
    return project;
  };

  const events = [];
  const result = await service.renderAllHighlightCutVariants({
    workspaceRoot: "C:\\queue-test",
    projectId: project.id,
    settings: {},
    onProgress: (payload) => events.push(payload)
  });

  const statuses = result.analysis.variantExportBatch.items.map((item) => item.status);
  assert.deepStrictEqual(statuses, ["done", "failed", "done"]);
  assert.strictEqual(result.analysis.variantExportBatch.failures.length, 1);
  assert.strictEqual(result.analysis.activeVariantId, "variant_01");
  assert.ok(events.some((event) => (
    event.variantBatch?.items?.[0]?.status === "done"
    && event.variantBatch?.items?.[1]?.status === "processing"
    && event.variantBatch?.items?.[2]?.status === "waiting"
  )));
  assert.ok(events.every((event) => event.variantBatch?.items?.length === 3));

  const draftVariants = variants.map((variant) => ({
    ...variant,
    artifacts: {}
  }));
  let draftProject = {
    id: "draft-queue-test",
    mode: "highlight_cut",
    artifacts: {},
    analysis: {
      activeVariantId: draftVariants[0].id,
      highlightVariants: draftVariants,
      segments: draftVariants[0].segments,
      scenes: []
    }
  };
  const draftStore = {
    async getProject() {
      return draftProject;
    },
    async updateProject(_workspaceRoot, _projectId, partial) {
      draftProject = {
        ...draftProject,
        ...partial,
        artifacts: partial.artifacts || draftProject.artifacts,
        analysis: partial.analysis || draftProject.analysis
      };
      return draftProject;
    }
  };
  const draftService = new DubbingService(draftStore);
  draftService.renderHighlightFastDraft = async ({ project: selectedProject, onProgress }) => {
    const activeId = selectedProject.analysis.activeVariantId;
    onProgress?.({ step: "draft", percent: 50, message: `Drafting ${activeId}` });
    if (activeId === "variant_02") {
      throw new Error("Synthetic draft failure");
    }
    const outputPath = `${activeId}-draft.mp4`;
    const updatedVariants = selectedProject.analysis.highlightVariants.map((variant) => (
      variant.id === activeId
        ? { ...variant, artifacts: { fastDraftVideoPath: outputPath, fastDraftRenderedAt: "2026-08-05T00:00:00.000Z" } }
        : variant
    ));
    draftProject = {
      ...selectedProject,
      analysis: {
        ...selectedProject.analysis,
        highlightVariants: updatedVariants
      }
    };
    return { outputPath };
  };

  const draftEvents = [];
  const draftResult = await draftService.renderAllHighlightFastDraftVariants({
    workspaceRoot: "C:\\draft-queue-test",
    projectId: draftProject.id,
    settings: {},
    onProgress: (payload) => draftEvents.push(payload)
  });
  assert.deepStrictEqual(
    draftResult.analysis.variantDraftBatch.items.map((item) => item.status),
    ["done", "failed", "done"]
  );
  assert.strictEqual(draftResult.analysis.variantDraftBatch.failures.length, 1);
  assert.strictEqual(draftResult.analysis.activeVariantId, "variant_01");
  assert.strictEqual(
    draftResult.analysis.highlightVariants[0].artifacts.fastDraftVideoPath,
    "variant_01-draft.mp4"
  );
  assert.strictEqual(
    draftResult.analysis.highlightVariants[2].artifacts.fastDraftVideoPath,
    "variant_03-draft.mp4"
  );
  assert.ok(draftEvents.some((event) => event.step === "variant_draft_batch"));
  assert.ok(draftEvents.every((event) => event.variantBatch?.kind === "fast_draft"));

  console.log("highlight variant queue tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
