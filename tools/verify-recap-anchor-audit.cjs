const fs = require("node:fs/promises"), path = require("node:path");
const Audit = require("../electron/services/recap/recapAnchorAuditService");
const Ai = require("../electron/services/recap/recapAiService");
async function main() {
  const sourceDir = process.argv[2], eventIds = (process.argv[3] || "").split(",").filter(Boolean);
  if (!sourceDir || !eventIds.length) throw new Error("Provide a saved source project and comma-separated event IDs.");
  const settings = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, "cineviral-studio", "config.json"), "utf8"));
  const project = JSON.parse(await fs.readFile(path.join(sourceDir, "project.json"), "utf8"));
  const state = JSON.parse(await fs.readFile(path.join(sourceDir, "analysis", "recap_state.json"), "utf8"));
  const root = path.resolve(__dirname, "../.tmp/recap-anchor-audit-live");
  const events = await new Audit(settings).repair({ sourceVideoPath: project.sourceVideoPath, sourceDuration: state.sourceMeta.duration,
    events: state.visualEvents, eventIds, issues: state.qualityIssues || [], scenes: state.scenes, directory: root,
    ai: new Ai(settings), onProgress: value => { if (value.message) console.log(value.message); } });
  const report = { passed: true, provider: settings.aiProvider, events: events.filter(event => eventIds.includes(event.id)) };
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
