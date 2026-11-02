const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { RecapSyncSolver } = require("../electron/services/recap/recapSyncSolver");
async function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error("Specify the saved project directory. This check makes no AI requests.");
  const project = JSON.parse(await fs.readFile(path.join(directory, "project.json"), "utf8"));
  const state = JSON.parse(await fs.readFile(path.join(directory, "analysis/recap_state.json"), "utf8"));
  const byId = new Map(state.visualEvents.map(event => [event.id, event]));
  const violations = decisions => decisions.flatMap(decision => decision.clips.map(clip => ({ unit: decision.speech_unit_id, clip })))
    .filter(({ clip }) => {
      const event = byId.get(clip.event_id);
      return event && (event.anchorMethod === "scene_frames" || event.anchorAudit)
        && (clip.source_start < event.source_start - .0015 || clip.source_end > event.source_end + .0015);
    }).map(({ unit, clip }) => ({ unit, event: clip.event_id, source: [clip.source_start, clip.source_end],
      verified: [byId.get(clip.event_id).source_start, byId.get(clip.event_id).source_end] }));
  const solved = new RecapSyncSolver({ allowShotReuse: Boolean(project.allowShotReuse),
    targetVisualLeadSec: Number(project.visualLeadSec ?? .25) }).solve({ speechUnits: state.speechUnits,
    visualEvents: state.visualEvents, audioTracks: state.audioTracks, scenes: state.scenes, sourceDurationSec: state.sourceMeta.duration });
  const current = violations(solved.decisions);
  assert.ok(solved.decisions.flatMap(decision => decision.clips).length > 0, "Check must contain real selected clips.");
  assert.equal(current.length, 0, "A source anchor may not borrow footage outside its verified action.");
  const report = { scope: "source_bounds_only", passed: true, fullRecapApproved: false, projectId: project.id,
    checkedClips: solved.decisions.flatMap(decision => decision.clips).length,
    previousViolations: violations(state.decisions || []), remainingTimingRepairs: solved.metrics.semanticTimingMismatchCount };
  const output = path.resolve(__dirname, "../.tmp/recap-log-diagnosis/source-bounds-verification.json");
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, previousViolations: report.previousViolations.length, output }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
