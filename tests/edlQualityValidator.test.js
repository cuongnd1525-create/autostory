'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateEdlQuality, computeIntervalOverlap } = require('../electron/services/edlQualityValidator.js');

console.log('Testing AutoStory V3 EDL Quality Validator & Negative Fixture...');

// 1. Test unit interval overlap calculation
{
  const a = [[10, 20], [30, 40]];
  const b = [[15, 25], [35, 45]];
  // Overlaps: [15, 20] (5s) + [35, 40] (5s) = 10s
  const overlap = computeIntervalOverlap(a, b);
  assert.strictEqual(overlap, 10, 'Overlap should be exactly 10s');
}

// 2. Test Negative Fixture (The Real Failed EDL)
{
  const fixturePath = path.join(__dirname, 'fixtures', 'failed-edl-spine.json');
  assert.ok(fs.existsSync(fixturePath), 'failed-edl-spine.json fixture must exist');
  const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const failedSpine = fixtureData.spines[0];

  const report = validateEdlQuality(failedSpine);

  console.log('Negative Fixture Validation Result:');
  console.log(' - valid:', report.valid);
  console.log(' - violations found:', report.violations.map(v => v.code));
  console.log(' - metrics:', report.metrics);

  // The failed EDL MUST fail validation
  assert.strictEqual(report.valid, false, 'Failed EDL must be rejected by validator');

  const violationCodes = new Set(report.violations.map(v => v.code));

  // Failure #1: Large Teaser/Main Overlap
  assert.ok(violationCodes.has('LARGE_TEASER_MAIN_OVERLAP'), 'Must detect LARGE_TEASER_MAIN_OVERLAP');
  assert.ok(report.metrics.teaserToMainSourceOverlapSeconds > 3.0, 'Overlap seconds should be > 3s');

  // Failure #2: Overlong Teaser (> 14s)
  assert.ok(violationCodes.has('OVERLONG_TEASER'), 'Must detect OVERLONG_TEASER');
  assert.ok(report.metrics.teaserDuration > 14.0, 'Teaser duration should be > 14s');

  // Failure #3: Macro beat exceeds max duration (> 10s)
  assert.ok(violationCodes.has('MACRO_BEAT_EXCEEDS_MAX'), 'Must detect MACRO_BEAT_EXCEEDS_MAX');
  assert.ok(report.metrics.maxMacroBeatDuration > 10.0, 'Max macro beat should be > 10s');

  // Failure #4: Unanchored backward jump (beat 7 at 160.5s -> beat 8 at 109s)
  assert.ok(violationCodes.has('UNANCHORED_BACKWARD_JUMP'), 'Must detect UNANCHORED_BACKWARD_JUMP');
  assert.ok(report.metrics.unanchoredBackwardJumpCount > 0, 'Unanchored backward jump count should be > 0');

  console.log('PASS: Negative regression fixture correctly failed on all 4 core defect counts.');
}

// 3. Test Compliant Repaired EDL
{
  const compliantSpine = {
    centralViewerQuestion: 'Why is the stepfather holding the daughter down?',
    hookPromise: 'Shocking 9-second cold open of a house confrontation that cuts before resolution.',
    beats: [
      // Compact Cold-Open (9s total: 3s + 3s + 3s, cuts before full payoff)
      {
        beatId: 'beat_0',
        beatIndex: 0,
        sourceStartSec: 32.5,
        sourceEndSec: 35.5,
        chronologyMode: 'teaser',
        narrativeRole: 'teaser_conflict',
        audioMode: 'original_audio',
        retentionReason: 'escalation',
        newInformation: 'Mother deflecting at front door claims daughter is unruly.',
        viewerStateBefore: 'Cold viewer.',
        viewerStateAfter: 'Hooked on door confrontation.'
      },
      {
        beatId: 'beat_1',
        beatIndex: 1,
        sourceStartSec: 44.0,
        sourceEndSec: 47.0,
        chronologyMode: 'teaser',
        narrativeRole: 'escalation',
        audioMode: 'original_audio',
        retentionReason: 'escalation',
        newInformation: 'Screaming erupts upstairs; officer charges the staircase.',
        viewerStateBefore: 'Watching door.',
        viewerStateAfter: 'Shocked by screams upstairs.'
      },
      {
        beatId: 'beat_2',
        beatIndex: 2,
        sourceStartSec: 54.0,
        sourceEndSec: 57.0,
        chronologyMode: 'teaser',
        narrativeRole: 'micro_payoff',
        audioMode: 'original_audio',
        retentionReason: 'visual_reveal',
        newInformation: 'Visual flash of adult male pinning daughter in bathroom; CUT before resolution!',
        viewerStateBefore: 'Charging upstairs.',
        viewerStateAfter: 'Sees violent restraint; left hanging!'
      },
      // Rewind Context (Non-overlapping with cold open teaser)
      {
        beatId: 'beat_3',
        beatIndex: 3,
        sourceStartSec: 0.0,
        sourceEndSec: 6.0,
        chronologyMode: 'rewind',
        narrativeRole: 'rewind_context',
        audioMode: 'voiceover_with_ambient',
        retentionReason: 'new_fact',
        newInformation: 'Police car arrives; 911 dispatch audio explains domestic violence call.',
        viewerStateBefore: 'Left hanging at bathroom door.',
        viewerStateAfter: 'Understands call origin.'
      },
      // Progressive Evidence Micro-Beats (Outside residence 12-23s, <= 11s run)
      {
        beatId: 'beat_4',
        beatIndex: 4,
        sourceStartSec: 12.0,
        sourceEndSec: 17.0,
        chronologyMode: 'chronological',
        narrativeRole: 'progressive_evidence',
        audioMode: 'voiceover_with_ambient',
        retentionReason: 'new_fact',
        newInformation: 'Boyfriend Nathan intercepts officer outside, frantic for help.',
        viewerStateBefore: 'Cruiser arriving.',
        viewerStateAfter: 'Witness testimony introduced.'
      },
      {
        beatId: 'beat_5',
        beatIndex: 5,
        sourceStartSec: 17.0,
        sourceEndSec: 23.0,
        chronologyMode: 'chronological',
        narrativeRole: 'progressive_evidence',
        audioMode: 'voiceover_with_ambient',
        retentionReason: 'strong_quote',
        newInformation: 'Nathan quotes: "They are hurting her inside, please get her out!"',
        viewerStateBefore: 'Witness introduced.',
        viewerStateAfter: 'Immediate peril confirmed.'
      },
      // Confrontation Micro-Beats inside bathroom (58-70s — AFTER the teaser cut!)
      {
        beatId: 'beat_6',
        beatIndex: 6,
        sourceStartSec: 58.0,
        sourceEndSec: 64.0,
        chronologyMode: 'chronological',
        narrativeRole: 'confrontation',
        audioMode: 'original_audio',
        retentionReason: 'reaction',
        newInformation: 'Officer intervenes in bathroom, ordering stepfather to release girl.',
        viewerStateBefore: 'Entering house.',
        viewerStateAfter: 'Physical confrontation halted.'
      },
      {
        beatId: 'beat_7',
        beatIndex: 7,
        sourceStartSec: 64.0,
        sourceEndSec: 70.0,
        chronologyMode: 'chronological',
        narrativeRole: 'confrontation',
        audioMode: 'original_audio',
        retentionReason: 'reaction',
        newInformation: 'Stepfather complies and releases girl while daughter sobs on floor.',
        viewerStateBefore: 'Intervention.',
        viewerStateAfter: 'Conflicting claims at scene.'
      },
      // Short hallway defense micro-beat (102-107s, 5.0s <= 12.0s)
      {
        beatId: 'beat_8',
        beatIndex: 8,
        sourceStartSec: 102.0,
        sourceEndSec: 107.0,
        chronologyMode: 'chronological',
        narrativeRole: 'contradiction',
        audioMode: 'voiceover_with_ambient',
        retentionReason: 'contradiction',
        newInformation: 'Mother insists "we do not abuse our children", claiming daughter went ballistic.',
        viewerStateBefore: 'Physical scene calmed.',
        viewerStateAfter: 'Mother caught in blatant lie.'
      },
      // Officer Handcuffs Action (247.8 - 253.0s, 5.2s)
      {
        beatId: 'beat_9',
        beatIndex: 9,
        sourceStartSec: 247.8,
        sourceEndSec: 253.0,
        chronologyMode: 'chronological',
        narrativeRole: 'escalation',
        audioMode: 'original_audio',
        retentionReason: 'escalation',
        newInformation: 'Officer moves in with handcuffs: "We got to get you in handcuffs for now, okay?"',
        viewerStateBefore: 'Mother deflecting.',
        viewerStateAfter: 'Officer taking physical control with handcuffs.'
      },
      // Movement / Suspect Reaction (254.0 - 258.0s, 4.0s)
      {
        beatId: 'beat_10',
        beatIndex: 10,
        sourceStartSec: 254.0,
        sourceEndSec: 258.0,
        chronologyMode: 'chronological',
        narrativeRole: 'reaction',
        audioMode: 'original_audio',
        retentionReason: 'reaction',
        newInformation: 'Suspect being stood up, daughter cries: "Can you get him off me?"',
        viewerStateBefore: 'Officer taking control.',
        viewerStateAfter: 'Physical separation underway.'
      },
      // Restraint: Double Locking Handcuffs (309.0 - 314.5s, 5.5s)
      {
        beatId: 'beat_11',
        beatIndex: 11,
        sourceStartSec: 309.0,
        sourceEndSec: 314.5,
        chronologyMode: 'chronological',
        narrativeRole: 'escalation',
        audioMode: 'original_audio',
        retentionReason: 'escalation',
        newInformation: 'Officer double locks handcuffs so they do not tighten as suspect is secured.',
        viewerStateBefore: 'Separation underway.',
        viewerStateAfter: 'Suspect secured in handcuffs.'
      },
      // Visual Reveal: Daughter testimony & marks (863.0 - 867.5s, 4.5s)
      {
        beatId: 'beat_12',
        beatIndex: 12,
        sourceStartSec: 863.0,
        sourceEndSec: 867.5,
        chronologyMode: 'chronological',
        narrativeRole: 'progressive_evidence',
        audioMode: 'voiceover_with_ambient',
        retentionReason: 'visual_reveal',
        newInformation: 'Cut to daughter Melody in cuffs: "my mom grabs my wrist... you are not going upstairs."',
        viewerStateBefore: 'Suspect secured.',
        viewerStateAfter: 'Direct victim testimony of assault.'
      },
      // Evidence: Daughter physical request (867.5 - 871.5s, 4.0s)
      {
        beatId: 'beat_13',
        beatIndex: 13,
        sourceStartSec: 867.5,
        sourceEndSec: 871.5,
        chronologyMode: 'chronological',
        narrativeRole: 'progressive_evidence',
        audioMode: 'voiceover_with_ambient',
        retentionReason: 'visual_reveal',
        newInformation: 'Daughter reveals: "Let me go. Please do not touch me physically right now."',
        viewerStateBefore: 'Victim testimony.',
        viewerStateAfter: 'Victim describes physical assault.'
      },
      // Strong Concrete Cliffhanger (1100.0 - 1105.5s, 5.5s)
      {
        beatId: 'beat_14',
        beatIndex: 14,
        sourceStartSec: 1100.0,
        sourceEndSec: 1105.5,
        chronologyMode: 'chronological',
        narrativeRole: 'cliffhanger',
        audioMode: 'voiceover_with_ambient',
        retentionReason: 'strong_quote',
        newInformation: 'Daughter reveals explosive battery claim: "He punched me and I am pretty sure he hit my boyfriend also!"',
        viewerStateBefore: 'Victim describes assault.',
        viewerStateAfter: 'Felony battery allegation revealed right before cut.',
        payoffTiming: 'part_2',
        cliffhangerQuestion: 'Will Georgia police arrest and charge the stepfather with felony battery in Part 2?',
        cliffhangerNewInformation: 'The daughter explicitly reveals the stepfather punched both her and her boyfriend.',
        cliffhangerExpectedNextPayoff: 'Part 2 reveals whether felony battery charges are filed against the stepfather.'
      }
    ]
  };

  const report = validateEdlQuality(compliantSpine);
  console.log('Compliant EDL Validation Result:');
  console.log(' - valid:', report.valid);
  console.log(' - violations:', report.violations);
  console.log(' - metrics:', report.metrics);

  assert.strictEqual(report.valid, true, 'Compliant EDL must pass validation');
  assert.strictEqual(report.violations.length, 0, 'Compliant EDL must have 0 violations');
  assert.ok(report.metrics.teaserDuration <= 14.0, 'Teaser duration within bound');
  assert.ok(report.metrics.teaserToMainSourceOverlapSeconds <= 3.0, 'Overlap within 3s budget');
  assert.ok(report.metrics.maxMacroBeatDuration <= 10.0, 'All beats are micro-beats <= 10s');
  assert.strictEqual(report.metrics.unanchoredBackwardJumpCount, 0, 'Zero unanchored backward jumps');
  assert.strictEqual(report.metrics.cliffhangerStrengthSignals.isStrong, true, 'Cliffhanger is strong');

  console.log('PASS: Compliant EDL passed all validator checks!');
}

console.log('All EDL Quality Validator tests PASSED successfully!');
