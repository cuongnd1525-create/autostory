const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const category = key => /^v2-/.test(key) ? (/discovery|audition|blueprint|ranking/.test(key) ? 'planning' : /final/.test(key) ? 'verification' : /review/.test(key) ? 'review' : /repair|rebuild/.test(key) ? 'voiceRepair' : 'editing') : key === "story-plan" ? "planning" : key.startsWith("final-check") ? "verification"
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
    if (e.local) continue;
    const id = e.scriptId || "shared";
    const g = groups[id] ||= { totalUsd: 0, calls: 0, cacheHits: 0, unknownCalls: 0, stages: {} };
    if (e.cached) { g.cacheHits++; continue; }
    g.calls++;
    if (e.usd == null) { g.unknownCalls++; continue; }
    g.totalUsd += e.usd; g.stages[e.category] = (g.stages[e.category] || 0) + e.usd;
  }
  const latestRunId = entries.filter(e => e.runId).at(-1)?.runId;
  const runs = {};
  for (const e of entries.filter(e => e.runId)) {
    const r = runs[e.runId] ||= { runId:e.runId, aiCalls:0, repairCalls:0, cacheHits:0, totalTokens:0, totalUsd:0, queueMs:0, prepareMs:0,
      modelMs:0, validationMs:0, ttsMs:0, renderMs:0, retryCount:0, candidateRejects:0, structuralRebuilds:0, finalViralScores:{} };
    if (e.cached) r.cacheHits++; else if (!e.local) { r.aiCalls++; if(e.repairCount) r.repairCalls++; }
    r.totalTokens += Number(e.inputTokens||0)+Number(e.outputTokens||0);
    r.totalUsd += Number(e.usd||0);
    for(const k of ['queueMs','prepareMs','modelMs','validationMs','ttsMs','renderMs','retryCount','candidateRejects','structuralRebuilds']) r[k]+=Number(e[k]||0);
    if(e.finalViralScore!=null && e.scriptId) r.finalViralScores[e.scriptId]=e.finalViralScore;
  }
  return { groups, runs, latestRun: runs[latestRunId] || null, totalUsd: Object.values(groups).reduce((n, g) => n + g.totalUsd, 0),
    unknownCalls: Object.values(groups).reduce((n, g) => n + g.unknownCalls, 0) };
}
async function estimate(root, key, model) {
  const { entries } = await read(path.join(root, "run-costs.json"));
  const samples = entries.filter(e => !e.cached && e.model === model && e.category === category(key) && e.usd != null).slice(-5);
  return samples.length ? { usd: samples.reduce((n, e) => n + e.usd, 0) / samples.length, samples: samples.length } : null;
}
module.exports = { append, estimate, summarize, category };
