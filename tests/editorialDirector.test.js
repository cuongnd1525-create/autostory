const assert = require('assert');
const { castBeats } = require('../electron/services/beatCastingService');
const { augmentCoverage } = require('../electron/services/beatCoverageService');
const { planDurationFit } = require('../electron/services/autoStoryDurationFit');
const { planRetentionArc } = require('../electron/services/retentionArcPlanService');
const { schemas } = require('../electron/services/autoStoryV3Contracts');
const schemaBoundary = require('../electron/services/autoStorySchemaBoundary');

console.log('Testing Gemini Editorial Director Architecture...');

// Mock Editorial Director EDL response (Benchmark retention arc)
const mockEditorialDirectorOutput = {
  accessGranted: true,
  spines: [
    {
      centralViewerQuestion: 'Why were parents violently holding their 19-year-old daughter hostage?',
      hookPromise: 'A mother calm facade shatters when violent screams erupt upstairs',
      hookStrategy: 'teaser_cold_open',
      strongEnough: true,
      reason: 'Classic true-crime retention arc matching viral benchmark',
      informationBudget: {
        immediate: ['Mother deflecting', 'Upstairs screams', 'Bathroom struggle'],
        deferred: ['Why they were holding her down'],
        reveals: ['Hostage dispute over packing backpack'],
        omit: ['Arrest resolution in patrol car']
      },
      openLoops: [
        { id: 'LOOP_1', question: 'What is happening upstairs?', opensAtBeat: 'b0', closesAtBeat: 'b2' },
        { id: 'LOOP_2', question: 'Why are parents doing this?', opensAtBeat: 'b2', closesAtBeat: 'b6' }
      ],
      beats: [
        {
          beatId: 'b0',
          beatIndex: 0,
          sourceStartSec: 32.5,
          sourceEndSec: 36.5,
          chronologyMode: 'teaser',
          narrativeRole: 'teaser_conflict',
          viewerQuestion: 'What are police doing at this quiet suburban house?',
          informationRevealed: 'Mother calmly answers door, deflecting questions about daughter.',
          openLoop: 'Why are police here?',
          payoffTiming: 'immediate',
          audioMode: 'original_audio',
          narrationPurpose: 'NONE',
          wantsNarration: false,
          narratorFunction: 'NONE',
          sourceEventId: 'ev_door',
          tensionBefore: 0.3,
          tensionAfter: 0.5,
          retentionReason: 'escalation',
          newInformation: 'Mother answers door deflecting questions.',
          viewerStateBefore: 'Cold viewer.',
          viewerStateAfter: 'Hooked at door.',
          tensionDelta: 0.2,
          openLoopDelta: 'LOOP_DOOR',
          cliffhangerQuestion: '',
          cliffhangerNewInformation: '',
          cliffhangerExpectedNextPayoff: ''
        },
        {
          beatId: 'b1',
          beatIndex: 1,
          sourceStartSec: 44.0,
          sourceEndSec: 50.0,
          chronologyMode: 'teaser',
          narrativeRole: 'escalation',
          viewerQuestion: 'Who is screaming upstairs?',
          informationRevealed: 'Violent screams erupt upstairs; officer shouts and rushes up stairs.',
          openLoop: 'Can officer reach victim in time?',
          payoffTiming: 'immediate',
          audioMode: 'original_audio',
          narrationPurpose: 'NONE',
          wantsNarration: false,
          narratorFunction: 'NONE',
          sourceEventId: 'ev_scream',
          tensionBefore: 0.5,
          tensionAfter: 0.9,
          retentionReason: 'escalation',
          newInformation: 'Screams erupt upstairs.',
          viewerStateBefore: 'At door.',
          viewerStateAfter: 'Rushing stairs.',
          tensionDelta: 0.4,
          openLoopDelta: 'LOOP_SCREAM',
          cliffhangerQuestion: '',
          cliffhangerNewInformation: '',
          cliffhangerExpectedNextPayoff: ''
        },
        {
          beatId: 'b2',
          beatIndex: 2,
          sourceStartSec: 54.0,
          sourceEndSec: 60.0,
          chronologyMode: 'teaser',
          narrativeRole: 'micro_payoff',
          viewerQuestion: 'What is happening inside the bathroom?',
          informationRevealed: 'Large man pinning teenage girl face down on bathroom floor.',
          openLoop: 'Why is he holding her down?',
          payoffTiming: 'delayed',
          audioMode: 'original_audio',
          narrationPurpose: 'NONE',
          wantsNarration: false,
          narratorFunction: 'NONE',
          sourceEventId: 'ev_bathroom',
          tensionBefore: 0.9,
          tensionAfter: 0.95,
          retentionReason: 'visual_reveal',
          newInformation: 'Man pinning teenage girl in bathroom.',
          viewerStateBefore: 'On stairs.',
          viewerStateAfter: 'Shocked by visual reveal.',
          tensionDelta: 0.05,
          openLoopDelta: 'LOOP_BATHROOM',
          cliffhangerQuestion: '',
          cliffhangerNewInformation: '',
          cliffhangerExpectedNextPayoff: ''
        },
        {
          beatId: 'b3',
          beatIndex: 3,
          sourceStartSec: 0.0,
          sourceEndSec: 8.5,
          chronologyMode: 'rewind',
          narrativeRole: 'rewind_context',
          viewerQuestion: 'How did police get called here?',
          informationRevealed: 'Boyfriend called 911 reporting girlfriend being attacked by parents.',
          openLoop: 'Will parents face criminal charges?',
          payoffTiming: 'delayed',
          audioMode: 'voiceover_with_ambient',
          narrationPurpose: 'CONTEXT',
          wantsNarration: true,
          narratorFunction: 'CONTEXT',
          sourceEventId: 'ev_call',
          tensionBefore: 0.8,
          tensionAfter: 0.75,
          retentionReason: 'new_fact',
          newInformation: '911 call from boyfriend.',
          viewerStateBefore: 'Left hanging at bathroom door.',
          viewerStateAfter: 'Understands call origin.',
          tensionDelta: -0.05,
          openLoopDelta: 'LOOP_ORIGIN',
          cliffhangerQuestion: '',
          cliffhangerNewInformation: '',
          cliffhangerExpectedNextPayoff: ''
        },
        {
          beatId: 'b4',
          beatIndex: 4,
          sourceStartSec: 12.0,
          sourceEndSec: 20.0,
          chronologyMode: 'chronological',
          narrativeRole: 'progressive_evidence',
          viewerQuestion: 'What did boyfriend witness?',
          informationRevealed: 'Boyfriend points to house as officer approaches porch.',
          openLoop: '',
          payoffTiming: 'none',
          audioMode: 'voiceover_with_ambient',
          narrationPurpose: 'SETUP',
          wantsNarration: true,
          narratorFunction: 'BRIDGE',
          sourceEventId: 'ev_approach',
          tensionBefore: 0.75,
          tensionAfter: 0.8,
          retentionReason: 'strong_quote',
          newInformation: 'Boyfriend points to house.',
          viewerStateBefore: 'Cruiser arrival.',
          viewerStateAfter: 'Boyfriend testimony.',
          tensionDelta: 0.05,
          openLoopDelta: '',
          cliffhangerQuestion: '',
          cliffhangerNewInformation: '',
          cliffhangerExpectedNextPayoff: ''
        },
        {
          beatId: 'b5',
          beatIndex: 5,
          sourceStartSec: 60.0,
          sourceEndSec: 85.0,
          chronologyMode: 'chronological',
          narrativeRole: 'confrontation',
          viewerQuestion: 'Will stepfather let girl go?',
          informationRevealed: 'Officer orders stepfather off girl; stepfather argues while girl weeps.',
          openLoop: 'Who will police believe?',
          payoffTiming: 'delayed',
          audioMode: 'original_audio',
          narrationPurpose: 'NONE',
          wantsNarration: false,
          narratorFunction: 'NONE',
          sourceEventId: 'ev_confront',
          tensionBefore: 0.8,
          tensionAfter: 0.95,
          retentionReason: 'reaction',
          newInformation: 'Officer intervenes in bathroom.',
          viewerStateBefore: 'At porch.',
          viewerStateAfter: 'Bathroom confrontation.',
          tensionDelta: 0.15,
          openLoopDelta: 'LOOP_BELIEF',
          cliffhangerQuestion: '',
          cliffhangerNewInformation: '',
          cliffhangerExpectedNextPayoff: ''
        },
        {
          beatId: 'b6',
          beatIndex: 6,
          sourceStartSec: 85.0,
          sourceEndSec: 110.0,
          chronologyMode: 'chronological',
          narrativeRole: 'contradiction',
          viewerQuestion: 'What really started the fight?',
          informationRevealed: 'Girl reveals dispute began over packing her backpack to leave.',
          openLoop: 'Will mother be arrested for false imprisonment?',
          payoffTiming: 'part_2',
          audioMode: 'original_audio',
          narrationPurpose: 'NONE',
          wantsNarration: false,
          narratorFunction: 'NONE',
          sourceEventId: 'ev_contradiction',
          tensionBefore: 0.9,
          tensionAfter: 0.85,
          retentionReason: 'contradiction',
          newInformation: 'Fight started over packing bags to leave.',
          viewerStateBefore: 'Scene calmed.',
          viewerStateAfter: 'Truth revealed.',
          tensionDelta: -0.05,
          openLoopDelta: 'LOOP_CONTRADICT',
          cliffhangerQuestion: '',
          cliffhangerNewInformation: '',
          cliffhangerExpectedNextPayoff: ''
        },
        {
          beatId: 'b7',
          beatIndex: 7,
          sourceStartSec: 120.0,
          sourceEndSec: 135.0,
          chronologyMode: 'chronological',
          narrativeRole: 'cliffhanger',
          viewerQuestion: 'What will happen to the mother?',
          informationRevealed: 'Mother self-justification seals her fate under Georgia domestic law.',
          openLoop: 'Watch Part 2 for the arrest!',
          payoffTiming: 'part_2',
          audioMode: 'voiceover_with_ambient',
          narrationPurpose: 'CLIFFHANGER',
          wantsNarration: true,
          narratorFunction: 'CONSEQUENCE',
          sourceEventId: 'ev_cliffhanger',
          tensionBefore: 0.85,
          tensionAfter: 0.95,
          retentionReason: 'new_question',
          newInformation: 'Mother self-justification seals her fate.',
          viewerStateBefore: 'Waiting for resolution.',
          viewerStateAfter: 'Left hanging on impending arrest.',
          tensionDelta: 0.1,
          openLoopDelta: 'LOOP_PART2',
          cliffhangerQuestion: 'Will the mother be arrested under Georgia law?',
          cliffhangerNewInformation: 'Mother admits on bodycam to unlawfully restraining daughter.',
          cliffhangerExpectedNextPayoff: 'Part 2 reveals police decision and charges.'
        }
      ]
    }
  ]
};

// 1. Schema boundary validation
assert.doesNotThrow(() => {
  schemaBoundary.validate(mockEditorialDirectorOutput, schemas.storyDesign);
}, 'Editorial Director EDL output must strictly validate against storyDesign schema');

console.log('✓ Schema validation passed');

// 2. Retention Arc Plan processing
const spine = mockEditorialDirectorOutput.spines[0];
const mockModel = {
  durationSec: 1726.3,
  events: [
    { id: 'ev_door', startSec: 32.5, endSec: 36.5, type: 'confrontation', tension: 0.5 },
    { id: 'ev_scream', startSec: 44.0, endSec: 50.0, type: 'action', tension: 0.9 },
    { id: 'ev_bathroom', startSec: 54.0, endSec: 60.0, type: 'reveal', tension: 0.95 },
    { id: 'ev_call', startSec: 0.0, endSec: 8.5, type: 'context', tension: 0.6 },
    { id: 'ev_approach', startSec: 12.0, endSec: 20.0, type: 'context', tension: 0.6 },
    { id: 'ev_confront', startSec: 60.0, endSec: 85.0, type: 'confrontation', tension: 0.95 },
    { id: 'ev_contradiction', startSec: 85.0, endSec: 110.0, type: 'dialogue', tension: 0.85 },
    { id: 'ev_cliffhanger', startSec: 120.0, endSec: 135.0, type: 'dialogue', tension: 0.9 }
  ],
  quotes: []
};

const arc = planRetentionArc(spine, mockModel, { targetDurationMinSec: 70, targetDurationMaxSec: 95 }, { storyMode: 'serialized_part' });
assert.strictEqual(arc.beats.length, 8, 'Must preserve 8 beats');
assert.strictEqual(arc.beats[0].narrativeRole, 'teaser_conflict', 'Beat 0 must be teaser_conflict');
assert.strictEqual(arc.beats[1].narrativeRole, 'escalation', 'Beat 1 must be escalation');
assert.strictEqual(arc.beats[2].narrativeRole, 'micro_payoff', 'Beat 2 must be micro_payoff');
assert.strictEqual(arc.beats[7].narrativeRole, 'cliffhanger', 'Beat 7 must be cliffhanger');
assert.strictEqual(arc.beats[0].sourceStartSec, 32.5, 'Beat 0 sourceStartSec must match EDL');
assert.strictEqual(arc.beats[0].sourceEndSec, 36.5, 'Beat 0 sourceEndSec must match EDL');

console.log('✓ Retention Arc Plan preserved EDL timestamps and roles');

// 3. Beat Casting pass-through with EDL lock
const cast = castBeats(arc.beats, mockModel);
assert.strictEqual(cast.beats.length, 8, 'All 8 beats cast');
cast.beats.forEach((b, i) => {
  assert.strictEqual(b.castReason, 'editorial director explicit edl lock', `Beat ${i} must have EDL lock`);
  assert.strictEqual(b.sourceStartSec, spine.beats[i].sourceStartSec, `Beat ${i} startSec preserved`);
  assert.strictEqual(b.sourceEndSec, spine.beats[i].sourceEndSec, `Beat ${i} endSec preserved`);
  assert.strictEqual(b.audioMode, spine.beats[i].audioMode, `Beat ${i} audioMode preserved`);
  assert.strictEqual(b.chronologyMode, spine.beats[i].chronologyMode, `Beat ${i} chronologyMode preserved`);
});

console.log('✓ Beat Casting successfully locked exact EDL without alterations');

// 4. Coverage augmentation non-destructive guardrail
const coverage = augmentCoverage(cast.beats, mockModel, { targetDurationMinSec: 70, targetDurationMaxSec: 95 });
assert.strictEqual(coverage.augmented, false, 'Coverage augmentation must NOT inject filler in EDL lock mode');
assert.strictEqual(coverage.beats.length, 8, 'Beat count must remain 8');

console.log('✓ Beat Coverage guardrail prevented filler injection');

// 5. Duration Fit non-destructive guardrail
const fit = planDurationFit(cast.beats, {
  config: { targetDurationMinSec: 70, targetDurationMaxSec: 95 },
  sourceDuration: 1726.3,
  model: mockModel
});
assert.strictEqual(fit.changed, false, 'Duration fit must NOT alter an EDL timeline already in target bounds');
assert.strictEqual(fit.beats.length, 8, 'Duration fit must preserve all 8 beats');

console.log('✓ Duration Fit guardrail preserved EDL timeline');

console.log('ALL GEMINI EDITORIAL DIRECTOR TESTS PASSED!');
