const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const category = key => key === "story-plan" ? "planning" : key.startsWith("final-check") ? "verification"
  : key.startsWith("review-") ? "review" : /^(voice-text|voice-fit|rhythm)-/.test(key) ? "voiceRepair" : "editing";
async function read(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return { entries: [] }; throw e; }
}
async function append(root, entry) {
  return require("./autoStoryWorkQueue").serial(`metrics:${path.resolve(root)}`, () => appendUnlocked(root, entry));
}
async function appendUnlocked(root, entry) {
  const file = path.join(root, "run-costs.json");
  const data = await read(file);
  data.entries.push({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(temp, JSON.stringify(data, null, 2)); await fs.rename(temp, file);
  return summarize(data.entries);
}
function summarize(entries) {
  const groups = {};
  for (const e of entries) {
    const id = e.scriptId || "shared";
    const g = groups[id] ||= { totalUsd: 0, calls: 0, cacheHits: 0, unknownCalls: 0, stages: {} };
    if (e.cached) { g.cacheHits++; continue; }
    g.calls++;
    if (e.usd == null) { g.unknownCalls++; continue; }
    g.totalUsd += e.usd; g.stages[e.category] = (g.stages[e.category] || 0) + e.usd;
  }
  return { groups, totalUsd: Object.values(groups).reduce((n, g) => n + g.totalUsd, 0),
    unknownCalls: Object.values(groups).reduce((n, g) => n + g.unknownCalls, 0) };
}
async function estimate(root, key, model) {
  const { entries } = await read(path.join(root, "run-costs.json"));
  const samples = entries.filter(e => !e.cached && e.model === model && e.category === category(key) && e.usd != null).slice(-5);
  return samples.length ? { usd: samples.reduce((n, e) => n + e.usd, 0) / samples.length, samples: samples.length } : null;
}
module.exports = { append, estimate, summarize, category };
