const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { spawn } = require("child_process");
const Provider = require("../electron/services/recap/recapProviderService");

async function main() {
  let child, childClosed, folder, lockCode = null, calls = 0;
  const service = new Provider({ aiProvider: "antigravity_cli" }, {
    antigravityFactory: () => ({ buildCommand: () => ({ args: [] }), cancel() {},
      runCli: async ({ cwd }) => {
        folder = cwd; calls++;
        child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setTimeout(() => {}, 1200)"], { cwd, windowsHide: true });
        childClosed = new Promise((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
        await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
        return { stdout: '{"ok":true}', viewedProxySet: new Set() };
      } }),
    removeTempDirectory: async (target, options) => {
      assert.equal(path.dirname(path.resolve(target)), path.resolve(os.tmpdir()));
      assert.match(path.basename(target), /^recap-ai-[A-Za-z0-9]+$/);
      // First demonstrate the old no-retry deletion failure while a child keeps
      // its working directory open, then use the provider's new retry policy.
      try { await fs.rm(target, { recursive: true, force: true }); }
      catch (error) { lockCode = error.code; await fs.rm(target, options); }
    }
  });
  assert.deepEqual(await service.generateJsonFromFiles({ prompt: "test", responseSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } }), { ok: true });
  await childClosed;
  if (process.platform === "win32") assert.equal(lockCode, "EBUSY");
  assert.equal(calls, 1);
  await assert.rejects(fs.access(folder), { code: "ENOENT" });
  console.log(`Native cleanup verified: lock=${lockCode || "none on this OS"}, AI calls=${calls}, valid result retained, folder removed.`);
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
