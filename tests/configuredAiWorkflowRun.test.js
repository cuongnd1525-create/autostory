const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const ConfiguredAiWorkflowService = require("../electron/services/configuredAiWorkflowService");

function buildScript(scriptId) {
  return {
    artifactType: "highlight_cut_script",
    schemaVersion: 1,
    scriptId,
    title: `Script ${scriptId}`,
    segments: [{
      id: `highlight_${scriptId}_001`,
      sourceStartSec: 0,
      sourceEndSec: 6,
      startSec: 0,
      endSec: 6,
      playbackSpeed: 1,
      audio_mode: "original_audio",
      voiceover_text: ""
    }]
  };
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-configured-ai-"));
  const pass1Dir = path.join(root, "01-GUI-GEMINI");
  await fs.mkdir(pass1Dir, { recursive: true });
  const promptPath = path.join(pass1Dir, "01-gemini-highlight-scripts-prompt.txt");
  await fs.writeFile(promptPath, "Generate independent scripts.", "utf8");
  await fs.writeFile(path.join(pass1Dir, "scene-manifest.json"), JSON.stringify({ scenes: [] }), "utf8");
  await fs.writeFile(path.join(root, "package-info.json"), JSON.stringify({
    workflow: "manual_gemini_draft_review",
    pass1UploadDir: pass1Dir,
    promptPath
  }), "utf8");

  const stage1 = new ConfiguredAiWorkflowService({
    aiProvider: "gemini",
    geminiApiKey: "test-key",
    geminiModel: "gemini-test"
  });
  stage1.runGemini = async ({ prompt }) => {
    assert(prompt.includes("AUTOMATED PROVIDER TRANSPORT OVERRIDE"));
    return {
      artifacts: [1, 3, 4].map((scriptId) => ({
        filename: `script-${scriptId}.json`,
        script: buildScript(scriptId)
      }))
    };
  };
  const stage1Result = await stage1.runStage1({ packageDir: root });
  assert.strictEqual(stage1Result.provider, "gemini");
  assert.strictEqual(stage1Result.validFiles.length, 3);
  assert.strictEqual(path.basename(stage1Result.resultDir), "01-CONFIGURED-AI-RESULT");

  const reviewRoot = path.join(root, "02-DRAFT-REVIEW", "variant-01-v1-test");
  const uploadDir = path.join(reviewRoot, "01-UPLOAD-TO-GEMINI");
  await fs.mkdir(uploadDir, { recursive: true });
  const reviewTarget = {
    projectId: "project-1",
    variantId: "variant-01",
    reviewedRevision: 1,
    reviewBindingId: "binding-1"
  };
  await fs.writeFile(path.join(reviewRoot, "review-package-info.json"), JSON.stringify({
    projectId: "project-1",
    variantId: "variant-01",
    revision: 1,
    reviewTarget
  }), "utf8");
  await fs.writeFile(path.join(uploadDir, "gemini-draft-review-prompt.txt"), "Review the complete draft.", "utf8");
  await fs.writeFile(path.join(uploadDir, "review-context.json"), JSON.stringify({ reviewTarget }), "utf8");

  const project = {
    id: "project-1",
    analysis: {
      highlightVariants: [{ id: "variant-01", artifacts: {} }]
    }
  };
  const updates = [];
  const projectStore = {
    async getProject() { return project; },
    async updateProject(_workspaceRoot, _projectId, partial) { updates.push(partial); }
  };
  const reviewService = new ConfiguredAiWorkflowService({
    aiProvider: "gemini",
    geminiApiKey: "test-key",
    geminiModel: "gemini-test"
  }, projectStore);
  reviewService.runGemini = async ({ prompt }) => {
    assert(prompt.includes("AUTOMATED PROVIDER EXECUTION"));
    return {
      artifactType: "gemini_draft_review",
      schemaVersion: 1,
      reviewTarget,
      revisedScript: buildScript(1)
    };
  };
  const reviewResult = await reviewService.runDraftReview({
    workspaceRoot: root,
    projectId: "project-1",
    packageDir: uploadDir
  });
  assert.strictEqual(reviewResult.provider, "gemini");
  assert.strictEqual(path.basename(reviewResult.resultPath), "gemini-draft-review.json");
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(
    updates[0].analysis.highlightVariants[0].artifacts.draftReviewAiResultPath,
    reviewResult.resultPath
  );

  await fs.rm(root, { recursive: true, force: true });
  console.log("configuredAiWorkflow run tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
