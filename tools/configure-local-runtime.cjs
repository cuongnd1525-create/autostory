const fs = require("fs/promises");
const path = require("path");
const ConfigStore = require("../electron/services/configStore");
const { localPythonCommand } = require("../electron/services/pythonRuntimeService");

async function main() {
  const configPath = path.join(process.env.APPDATA, "cineviral-studio", "config.json");
  const current = JSON.parse(await fs.readFile(configPath, "utf8"));
  const store = new ConfigStore(configPath, current.workspaceRoot);
  await store.ensureLoaded();
  const python = localPythonCommand();
  if (!path.isAbsolute(python)) throw new Error("Install the local runtime before configuring it.");
  const backup = `${configPath}.before-recap-runtime-fix`;
  await fs.copyFile(configPath, backup, require("fs").constants.COPYFILE_EXCL).catch((error) => { if (error.code !== "EEXIST") throw error; });
  await store.saveSettings({ whisperPythonCommand: python, kokoroPythonCommand: python, localTranslationPythonCommand: python });
  console.log("Configured ASR, Kokoro and local translation:", python);
  console.log("Previous configuration backup:", backup);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
