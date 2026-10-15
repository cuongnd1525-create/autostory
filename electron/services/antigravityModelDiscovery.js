const { spawn } = require("node:child_process");
const { buildCliEnv } = require("./cliEnv");
const Catalog = require("../../src/antigravityModelCatalog");
const cache = new Map();

function parseModels(output) {
  const models = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(.+\((High|Medium|Low|Thinking)\))$/i);
    if (!match) continue;
    const [, value, label, level] = match;
    const known = Catalog.parseModel(value);
    const familyId = known.known ? known.familyId : value.replace(/-(high|medium|low|thinking)$/i, "");
    models.push({ value, label, familyId, familyLabel: label.replace(/\s*\([^)]*\)$/, ""), reasoning: level.toLowerCase() });
  }
  return [...new Map(models.map((model) => [model.value, model])).values()];
}

function query(settings, { signal, spawnImpl = spawn } = {}) {
  const parts = (String(settings.antigravityCommand || process.env.ANTIGRAVITY_COMMAND || "agy").match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((part) => part.replace(/^"|"$/g, ""));
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let child, settled = false, stdout = "", stderr = "", timer;
    const finish = (error, models) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(models);
    };
    const stop = () => { try { child?.kill(); } catch (_) {} };
    const abort = () => { stop(); finish(new DOMException("Aborted", "AbortError")); };
    try { child = spawnImpl(parts[0] || "agy", [...parts.slice(1), "models"], { windowsHide: true, env: buildCliEnv(), stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { finish(error); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { stop(); finish(Object.assign(new Error("Không tải được danh sách model Antigravity trong 20 giây. Kiểm tra CLI/kết nối và thử lại."), { kind: "model_discovery_failed" })); }, 20000);
    child.stdout.on("data", (data) => { stdout = (stdout + data).slice(-100000); });
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-2000); });
    child.on("error", (error) => finish(Object.assign(error, { kind: "model_discovery_failed" })));
    child.on("close", (code) => {
      const models = parseModels(stdout);
      if (code !== 0 || !models.length) finish(Object.assign(new Error(`Không xác nhận được model Antigravity khả dụng. ${stderr.slice(-300)}`), { kind: "model_discovery_failed" }));
      else finish(null, models);
    });
    if (signal?.aborted) abort();
  });
}

async function list(settings = {}, { force = false, signal } = {}) {
  signal?.throwIfAborted();
  const key = settings.antigravityCommand || process.env.ANTIGRAVITY_COMMAND || "agy";
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < 300000) return cached.models;
  const models = await query(settings, { signal });
  cache.set(key, { models, at: Date.now() }); return models;
}
module.exports = { list, query, parseModels };
