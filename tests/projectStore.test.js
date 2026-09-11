const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const ProjectStore = require("../electron/services/projectStore");
const VoiceProfileService = require("../electron/services/voiceProfileService");
const DubbingService = require("../electron/services/dubbingService");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cineviral-store-test-"));
  try {
    const store = new ProjectStore();
    const project = await store.createProject(root, {
      title: "test",
      sourceVideoPath: path.join(root, "source.mp4")
    });
    await Promise.all([
      store.updateProject(root, project.id, { status: "rendering" }),
      store.updateProject(root, project.id, { progressPercent: 50 }),
      store.updateProject(root, project.id, { artifacts: { previewVideoPath: "preview.mp4" } })
    ]);
    const updated = await store.getProject(root, project.id);
    assert.strictEqual(updated.status, "rendering");
    assert.strictEqual(updated.progressPercent, 50);
    assert.strictEqual(updated.artifacts.previewVideoPath, "preview.mp4");
    assert.ok(updated.revision >= 4);

    const profiles = new VoiceProfileService();
    const base = {
      provider: "elevenlabs",
      voiceId: "voice-a",
      language: "en",
      settings: {
        elevenLabsModel: "eleven_multilingual_v2",
        elevenLabsVoiceSettingsMode: "custom",
        elevenLabsStability: 0.3
      },
      project: { genreMode: "drama" }
    };
    const changed = {
      ...base,
      settings: { ...base.settings, elevenLabsStability: 0.8 }
    };
    assert.notStrictEqual(
      profiles.buildProfileKey(base).key,
      profiles.buildProfileKey(changed).key
    );

    await profiles.recordSample(root, {
      provider: "kokoro",
      voiceId: "am_adam",
      language: "en",
      style: "thriller",
      settings: { kokoroVoicePreset: "documentary", kokoroSpeed: 1.05 },
      project: { genreMode: "thriller", voiceId: "am_adam" }
    }, {
      text: "This measured sentence verifies that a stored voice profile can be reused.",
      measuredDurationSec: 4,
      source: "test"
    });
    const dubbing = new DubbingService(store);
    const storedContext = await dubbing.getVoiceProfileContext({
      workspaceRoot: root,
      settings: { kokoroVoicePreset: "documentary", kokoroSpeed: 1.05 },
      payload: {
        mode: "highlight_cut",
        voiceProvider: "kokoro",
        voiceId: "am_adam",
        language: "en",
        style: "thriller"
      }
    });
    assert.strictEqual(storedContext.profile.sampleCount, 1);
    assert.ok(storedContext.profile.wordsPerSecond > 0);
    assert.strictEqual(storedContext.wordBudgets.length, 7);
    console.log("projectStore tests passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
