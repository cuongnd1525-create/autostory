const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const ConfigStore = require("../electron/services/configStore");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-config-store-"));
  try {
    const configPath = path.join(root, "config.json");
    const workspaceRoot = path.join(root, "projects");
    const store = new ConfigStore(configPath, workspaceRoot);
    const defaults = await store.ensureLoaded();

    assert.strictEqual(defaults.geminiAnalysisRoot, path.join(root, "GeminiData"));
    assert.strictEqual(defaults.sourceDownloadRoot, path.join(root, "sources"));
    assert.strictEqual(defaults.ytDlpCommand, "yt-dlp");

    const customRoot = path.join(root, "custom-gemini-data");
    await store.saveSettings({ geminiAnalysisRoot: customRoot });

    const reloaded = new ConfigStore(configPath, workspaceRoot);
    const persisted = await reloaded.ensureLoaded();
    assert.strictEqual(persisted.geminiAnalysisRoot, customRoot);

    console.log("configStore tests passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
