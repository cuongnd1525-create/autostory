const fs = require("node:fs/promises"), path = require("node:path");
const Audit = require("../electron/services/recap/recapAnchorAuditService");
const Ai = require("../electron/services/recap/recapAiService");
async function main() {
  const sourceDir = process.argv[2], eventIds = (process.argv[3] || "").split(",").filter(Boolean);
  if (!sourceDir || !eventIds.length) throw new Error("Provide a saved source project and comma-separated event IDs.");
  const settings = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, "cineviral-studio", "config.json"), "utf8"));
  const limitIndex = process.argv.indexOf("--daily-limit");
  if (limitIndex >= 0) {
    const limit = Number(process.argv[limitIndex + 1]);
    if (!(limit > 0 && limit <= 5 && (!settings.vertexDailyLimitUsd || limit <= settings.vertexDailyLimitUsd))) throw new Error("Audit verification may only reduce the configured spending limit, within $5/day.");
    settings.vertexDailyLimitUsd = limit;
  }
  const project = JSON.parse(await fs.readFile(path.join(sourceDir, "project.json"), "utf8"));
  const state = JSON.parse(await fs.readFile(path.join(sourceDir, "analysis", "recap_state.json"), "utf8"));
  const root = path.resolve(__dirname, "../.tmp/recap-anchor-audit-live");
  const ai = new Ai(settings), invoke = ai.runVertexCall.bind(ai), startedAt = Date.now();
  let aiCalls = 0, cacheHits = 0;
  ai.runVertexCall = request => { aiCalls++; return invoke(request); };
  const events = await new Audit(settings).repair({ sourceVideoPath: project.sourceVideoPath, sourceDuration: state.sourceMeta.duration,
    events: state.visualEvents, eventIds, issues: state.qualityIssues || [], narration: state.speechUnits || [], scenes: state.scenes, directory: root,
    ai, onProgress: value => { if (value.cacheHit) cacheHits++; if (value.message) console.log(value.message); } });
  const report = { passed: true, scope: "source_anchor_audit_only", fullRecapApproved: false,
    elapsedSec: (Date.now() - startedAt) / 1000, aiCalls, cacheHits,
    provider: settings.aiProvider, events: events.filter(event => eventIds.includes(event.id)) };
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
