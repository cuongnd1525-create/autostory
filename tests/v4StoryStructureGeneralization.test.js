'use strict';

/**
 * AutoStory V4 — Multi-Archetype Generalization & Structural Viral Scoring Tests
 *
 * Validates that the V4 Viral Story Engine generalizes across 5 distinct bodycam/crime archetypes:
 * 1. Domestic Disturbance / Rescue
 * 2. Traffic Stop Escalation
 * 3. Foot Pursuit
 * 4. Suspect Deception / Contradiction
 * 5. Evidence Interrogation
 *
 * Asserts:
 * - Every archetype achieves Structural Viral Score >= 8.0/10.0
 * - Zero hard-cap violations across all archetypes
 * - Distinct structural characteristics appropriate to each incident type
 * - Structural Critic generates comprehensive ~5-8s window audit
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateEdlQuality, computeStructuralViralScore } = require('../electron/services/edlQualityValidator.js');
const { critiqueRenderedTimeline, formatRetentionAuditMarkdown } = require('../electron/services/structuralCriticService.js');

console.log('Testing AutoStory V4 Multi-Archetype Story Structure Generalization...');

const fixturesDir = path.join(__dirname, 'fixtures', 'archetypes');
const archetypes = [
  { file: 'domestic-rescue.json', name: 'Domestic Disturbance / Rescue', expectedArchetype: 'RESCUE' },
  { file: 'traffic-stop-escalation.json', name: 'Traffic Stop Escalation', expectedArchetype: 'ESCALATION' },
  { file: 'foot-pursuit.json', name: 'Foot Pursuit', expectedArchetype: 'PURSUIT' },
  { file: 'suspect-deception.json', name: 'Suspect Deception / Contradiction', expectedArchetype: 'DECEPTION_CONTRADICTION' },
  { file: 'evidence-interrogation.json', name: 'Evidence Interrogation', expectedArchetype: 'INTERROGATION' }
];

const results = [];

for (const arch of archetypes) {
  const filePath = path.join(fixturesDir, arch.file);
  assert.ok(fs.existsSync(filePath), `Fixture file must exist: ${arch.file}`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  console.log(`\n======================================================`);
  console.log(`Testing Archetype: ${arch.name} (${arch.file})`);
  console.log(`======================================================`);

  // 1. Run EDL Quality Validator
  const report = validateEdlQuality(data);
  const m = report.metrics;
  const svScore = m.structuralViralScore;

  console.log(`- Validation Result: valid=${report.valid}`);
  console.log(`- Structural Viral Score: ${svScore.score}/10.0 (raw: ${svScore.rawScore}/10.0)`);
  console.log(`- Hard Caps Triggered: [${svScore.hardCaps.join(', ') || 'none'}]`);
  console.log(`- Deductions: ${svScore.deductions.length}`);
  if (svScore.deductions.length > 0) {
    svScore.deductions.forEach(d => console.log(`    [${d.dimension}] -${d.deduction}: ${d.reason}`));
  }
  console.log(`- Metrics: duration=${m.totalTimelineDuration}s, beats=${m.totalBeats}, teaserDur=${m.teaserDuration}s, overlap=${m.teaserToMainSourceOverlapSeconds}s`);

  // Assertions for every archetype
  assert.strictEqual(report.valid, true, `${arch.name} must pass validateEdlQuality with 0 violations`);
  assert.ok(svScore.score >= 8.0, `${arch.name} Structural Viral Score must be >= 8.0/10.0 (got ${svScore.score})`);
  assert.strictEqual(svScore.hardCaps.length, 0, `${arch.name} must trigger 0 hard-cap violations`);
  assert.strictEqual(m.unanchoredBackwardJumpCount, 0, `${arch.name} must have 0 unanchored backward jumps`);
  assert.ok(m.totalTimelineDuration >= 60.0 && m.totalTimelineDuration <= 95.0, `${arch.name} duration must fit in 60-95s window`);

  // 2. Test Structural Critic Window Audit (~5-8s windows)
  const audit = critiqueRenderedTimeline(data, { 
    targetWindowSec: 5.5,
    actualMp4DurationSec: m.totalTimelineDuration
  });
  console.log(`- Structural Critic Windows: ${audit.windows.length} windows, avg score: ${audit.averageRetentionScore}/10.0, weak windows: ${audit.weakWindows.length}`);
  assert.ok(audit.isCompliant, `${arch.name} rendered timeline must be compliant according to Structural Critic`);
  assert.ok(audit.averageRetentionScore >= 8.0, `${arch.name} Structural Critic average score must be >= 8.0/10.0`);
  assert.strictEqual(audit.weakWindows.length, 0, `${arch.name} must have 0 weak windows in rendered draft`);

  results.push({
    name: arch.name,
    archetype: arch.expectedArchetype,
    score: svScore.score,
    rawScore: svScore.rawScore,
    duration: m.totalTimelineDuration,
    beats: m.totalBeats,
    criticAvg: audit.averageRetentionScore
  });
}

// 3. Assert Distinct Structural Characteristics across Archetypes
console.log(`\n======================================================`);
console.log(`Verifying Cross-Archetype Structural Diversity...`);
console.log(`======================================================`);

// 3a. Traffic Stop uses linear forward escalation without teaser (teaserDuration == 0)
const trafficStop = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'traffic-stop-escalation.json'), 'utf8'));
const trafficTeasers = trafficStop.beats.filter(b => b.chronologyMode === 'teaser');
assert.strictEqual(trafficTeasers.length, 0, 'Traffic Stop escalation must be pure forward chronology without teaser replay');
console.log('✓ Traffic Stop correctly uses 100% forward chronological escalation (no teaser)');

// 3b. Foot Pursuit has rapid kinetic micro-beat pacing (average duration <= 5.2s)
const pursuit = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'foot-pursuit.json'), 'utf8'));
const pursuitDur = pursuit.beats.reduce((s, b) => s + (b.sourceEndSec - b.sourceStartSec), 0);
const pursuitAvg = pursuitDur / pursuit.beats.length;
assert.ok(pursuitAvg <= 5.2, `Foot pursuit must have rapid kinetic micro-beats (avg <= 5.2s, got ${pursuitAvg.toFixed(2)}s)`);
console.log(`✓ Foot Pursuit correctly uses rapid kinetic pace (${pursuitAvg.toFixed(2)}s/beat)`);

// 3c. Suspect Deception features contradiction ladder
const deception = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'suspect-deception.json'), 'utf8'));
const contradictionBeats = deception.beats.filter(b => b.retentionReason === 'contradiction' || b.narrativeRole === 'contradiction');
assert.ok(contradictionBeats.length >= 2, 'Suspect Deception must feature multiple contradiction beats');
console.log(`✓ Suspect Deception correctly implements a multi-step contradiction ladder (${contradictionBeats.length} contradiction beats)`);

// 3d. Evidence Interrogation features progressive evidence build
const interrogation = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'evidence-interrogation.json'), 'utf8'));
const evidenceBeats = interrogation.beats.filter(b => b.retentionReason === 'visual_reveal' || b.retentionReason === 'contradiction');
assert.ok(evidenceBeats.length >= 4, 'Evidence Interrogation must feature dense physical evidence reveals');
console.log(`✓ Evidence Interrogation correctly implements progressive evidence build (${evidenceBeats.length} evidence reveal beats)`);

// 3e. Domestic Rescue features compact teaser with 0s overlap
const rescue = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'domestic-rescue.json'), 'utf8'));
const rescueReport = validateEdlQuality(rescue);
assert.strictEqual(rescueReport.metrics.teaserToMainSourceOverlapSeconds, 0, 'Domestic Rescue must have 0s teaser-to-main overlap');
assert.ok(rescueReport.metrics.teaserDuration <= 10.0, 'Domestic Rescue teaser must be <= 10s');
console.log(`✓ Domestic Rescue correctly implements compact teaser (9.0s) with 0.0s overlap`);

console.log(`\n======================================================`);
console.log(`Summary of Generalization Results:`);
console.log(`======================================================`);
console.table(results);

console.log(`\nALL 5 BODYCAM/CRIME ARCHETYPES PASSED STRUCTURAL VIRAL SCORE >= 8.0/10.0!`);
