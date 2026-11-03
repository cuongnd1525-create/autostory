// Re-derives Experiment D's acceptance path from persisted artifacts.
// Usage: node tools/audit-d-acceptance.js <projectDir> > D-acceptance-audit.json
const fs = require('fs');
const path = require('path');
const Director = require('../../../electron/services/editorialDirectorService');

const projectDir = process.argv[2];
const root = path.join(projectDir, 'analysis', 'auto-story-fast');
const bench = path.join(__dirname, '..');
const j = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const r2 = n => Math.round(n * 100) / 100;

const project = j(path.join(projectDir, 'project.json'));
const SOURCE_DURATION_SEC = 549.741; // project.json source probe "duration"
const scopeDoc = j(path.join(root, 'story-scope.json'));
const finalSpine = j(path.join(root, 'story-spine.json')).spines[0];
const scope = finalSpine.storyScope;
const reel = finalSpine.scopeReel;
const cfgUi = project.autoStoryConfig || {};
const timeline = beats => beats.map(b => ({ beatId: b.beatId, sourceStartSec: b.sourceStartSec, sourceEndSec: b.sourceEndSec,
  durationSec: r2(b.sourceEndSec - b.sourceStartSec), narrativeRole: b.narrativeRole, chronologyMode: b.chronologyMode,
  reelCoverage: r2(Director.coveredByReel(b, reel.ranges)) }));
const total = beats => r2(beats.reduce((n, b) => n + (b.sourceEndSec - b.sourceStartSec), 0));

function validate(spine, hardMin, hardMax) {
  const t = Director.durationTargets(scope, { targetDurationMinSec: hardMin, targetDurationMaxSec: hardMax });
  const rep = Director.validateDirectorEdl(spine, scope, { durationSec: SOURCE_DURATION_SEC, targetDurationMinSec: t.hardMinSec,
    targetDurationMaxSec: t.hardMaxSec, reel, preferredDurationSec: t.targetDurationSec, targetBandMinSec: t.targetBandMinSec,
    targetBandMaxSec: t.targetBandMaxSec, requireDeliveryBlocks: true, narrationEnabled: true });
  return { config: `${hardMin}-${hardMax}s`, durationTargets: t, valid: rep.valid, violationCodes: rep.violations.map(v => v.code),
    violations: rep.violations.map(v => ({ code: v.code, message: v.message })), metrics: rep.metrics,
    insidePreferredBand: rep.metrics.totalSec >= t.targetBandMinSec && rep.metrics.totalSec <= t.targetBandMaxSec };
}

const initial = j(path.join(root, 'initial-story-spine-1.json'));
const repaired = j(path.join(root, 'repair-1-story-spine-1.json'));
const script = j(path.join(root, 'script-1.json'));
const initialAudit = j(path.join(root, 'initial-media-audit-1.json'));
const repairAudit = j(path.join(root, 'repair-1-media-audit-1.json'));
const review = j(path.join(root, 'review-state-1.json'));
const benchD = j(path.join(bench, 'D-media-editorial-director.json'));
const benchEdl = (benchD.passes.find(p => p.directorSpine) || {}).directorSpine || {};
const respInitial = j(path.join(bench, 'director-D-run', 'v5-editorial-director-1-last-response.json'));
const respRepair = j(path.join(bench, 'director-D-run', 'v5-editorial-director-repair-1-1_fix1-last-response.json'));
const pick = x => (x.beats ? x : (x.spine || x.response || x.result || x.parsed || x));

const segs = (script.segments || []).map(s => ({ start: s.sourceStartSec ?? s.start ?? s.source_start, end: s.sourceEndSec ?? s.end ?? s.source_end }));
const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x.sourceStartSec - b[i].sourceStartSec) < 1e-6 && Math.abs(x.sourceEndSec - b[i].sourceEndSec) < 1e-6);
let downstreamIntact;
try { downstreamIntact = Director.assertEdlIntact(repaired.beats, finalSpine.beats, SOURCE_DURATION_SEC); } catch (e) { downstreamIntact = e.message; }

const out = {
  auditVersion: 1,
  generatedBy: 'analysis/truecrime-abcd-20261103/tools/audit-d-acceptance.js',
  project: { id: path.basename(projectDir), sourceDurationSec: SOURCE_DURATION_SEC,
    autoStoryConfig: cfgUi, editorialArchitecture: cfgUi.editorialArchitecture },
  constraintsActuallySupplied: {
    hardRangeSec: [cfgUi.targetDurationMinSec, cfgUi.targetDurationMaxSec], hardRangeSource: 'project.json autoStoryConfig (UI setting)',
    storyScopeTargetDurationSec: scopeDoc.chosen?.targetDurationSec ?? scope.targetDurationSec,
    directorTargets: Director.durationTargets(scope, { targetDurationMinSec: cfgUi.targetDurationMinSec, targetDurationMaxSec: cfgUi.targetDurationMaxSec })
  },
  scopeReel: { storyScopeId: reel.storyScopeId, files: reel.files, totalReelSec: reel.files.reduce((n, f) => n + f.durationSec, 0),
    cuttableRanges: reel.ranges.map(x => ({ reelFile: x.reelFile, windowStartSec: x.windowStartSec, windowEndSec: x.windowEndSec, scopeWindowId: x.scopeWindowId })) },
  edls: {
    initialDirector: { artifact: 'initial-story-spine-1.json', responseArtifact: 'director-D-run/v5-editorial-director-1-last-response.json',
      responseMatchesSpine: sameOrder(pick(respInitial).beats || [], initial.beats), totalSec: total(initial.beats), openingStrategy: initial.openingStrategy?.chosen,
      timeline: timeline(initial.beats), validation: [validate(initial, cfgUi.targetDurationMinSec, cfgUi.targetDurationMaxSec), validate(initial, 65, 90)],
      mediaCritic: { isCompliant: initialAudit.isCompliant, scopeSurvived: initialAudit.scopeSurvived, summary: initialAudit.summary,
        weakRegions: (initialAudit.weakRegions || []).map(w => ({ type: w.type, beatIds: w.beatIds, reason: w.reason })) },
      draft: { file: '…20261103042358.mp4', probedDurationSec: 86.534 }, status: 'REJECTED_BY_MEDIA_CRITIC' },
    criticRepairPass1: { artifact: 'repair-1-story-spine-1.json', responseArtifact: 'director-D-run/v5-editorial-director-repair-1-1_fix1-last-response.json',
      responseMatchesSpine: sameOrder(pick(respRepair).beats || [], repaired.beats), directorAttempts: (repaired.directorMeta?.attempts || []).map(a => ({ attempt: a.attempt, mode: a.mode, valid: a.valid, violationCodes: (a.violations || []).map(v => v.code) })),
      totalSec: total(repaired.beats), openingStrategy: repaired.openingStrategy?.chosen, timeline: timeline(repaired.beats),
      validation: [validate(repaired, cfgUi.targetDurationMinSec, cfgUi.targetDurationMaxSec), validate(repaired, 65, 90)],
      mediaCritic: { isCompliant: repairAudit.isCompliant, scopeSurvived: repairAudit.scopeSurvived, centralQuestionActiveThroughout: repairAudit.centralQuestionActiveThroughout,
        endingIsConsequence: repairAudit.endingIsConsequence, summary: repairAudit.summary } },
    finalPersisted: { artifact: 'story-spine.json', totalSec: total(finalSpine.beats), identicalToRepairPass1: sameOrder(repaired.beats, finalSpine.beats), assertEdlIntact: downstreamIntact },
    script: { artifact: 'script-1.json', segmentCount: segs.length, totalSec: r2(segs.reduce((n, s) => n + (s.end - s.start), 0)), sameRangesAndOrderAsFinalSpine: sameOrder(segs.map(s => ({ sourceStartSec: s.start, sourceEndSec: s.end })), finalSpine.beats) },
    finalDraft: { file: '…20261103042926.mp4', probedDurationSec: 122.034 },
    benchmarkReported: { file: 'D-media-editorial-director.json', totalSec: total(benchEdl.beats || []), identicalToFinalPersisted: sameOrder(benchEdl.beats || [], finalSpine.beats) }
  },
  acceptanceGate: {
    note: 'Director.acceptanceReport (added in this fix) re-run on the persisted final EDL with the critic verdict that accepted it.',
    asConfigured65to150: Director.acceptanceReport(finalSpine, { config: { targetDurationMinSec: cfgUi.targetDurationMinSec, targetDurationMaxSec: cfgUi.targetDurationMaxSec }, durationSec: SOURCE_DURATION_SEC, scriptSegments: script.segments, renderedDurationSec: 122.034, critique: repairAudit }),
    hypothetical65to90: Director.acceptanceReport(finalSpine, { config: { targetDurationMinSec: 65, targetDurationMaxSec: 90 }, durationSec: SOURCE_DURATION_SEC, scriptSegments: script.segments, renderedDurationSec: 122.034, critique: repairAudit })
  },
  reviewState: review,
  answers: {
    is122sIntermediateDraft: false,
    is122sFailedRepair: false,
    is122sAcceptedEdl: true,
    validateDirectorEdlRejectedDuration: 'No. The run used hard range 65-150s (UI setting), so 122s is valid. Under 65-90s the same EDL produces TOTAL_DURATION_OVER_MAX (see validation[1]).',
    finalSpinePersisted: true,
    downstreamChangedDurationOrOrder: false,
    whyBenchmarkMarksSuccess: 'review-state-1.json: media critic compliant after repair pass 1, finalCheck PASS, needsUserReview false.',
    benchmarkDiscrepancies: [
      "'68.0s target' does not exist in any run artifact. The value equals reel_03 durationSec (68s); Story Scope target was 110s, hard range 65-150s.",
      "blind-evaluation '122.0s Reel' mislabels the EDL total; reel_04 is also 122s, total reel media is 321s.",
      "D-media-editorial-director.json 'totalReelSec: 184.5' does not match the packed reel (321s).",
      'D telemetry reports only the repair call (67,152 prompt tokens); the run made Source Model + Scope + Director + Repair + 2 critic calls.',
      'The 122s EDL is above the Director preferred band (107-113s around target 110s) but inside the hard range; no artifact records that deviation.'
    ]
  }
};
process.stdout.write(JSON.stringify(out, null, 2));
