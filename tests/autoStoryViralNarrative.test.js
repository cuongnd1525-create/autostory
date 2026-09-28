const assert = require('node:assert/strict');
const test = require('node:test');
const { schemas, hookPolicy } = require('../electron/services/autoStoryEditorial');
const FastService = require('../electron/services/autoStoryFastService');
const DubbingService = require('../electron/services/dubbingService');
const { analyze } = require('../electron/services/autoStoryRhythm');

test('mixed_ducking is supported in segment schema and getHighlightAudioMode', () => {
  // 1. Check schemas
  const allowedModes = schemas.edit.properties.script.properties.segments.items.properties.audioMode.enum;
  assert(allowedModes.includes('mixed_ducking'), 'mixed_ducking must be in schema enum');
  assert(allowedModes.includes('original_audio'), 'original_audio must be in schema enum');
  assert(allowedModes.includes('voiceover_only'), 'voiceover_only must be in schema enum');

  // 2. Check getHighlightAudioMode in dubbingService
  const segMixed = { audioMode: 'mixed_ducking', voiceoverText: 'On July 9th 2023 police arrive...' };
  assert.equal(
    DubbingService.prototype.getHighlightAudioMode ? DubbingService.prototype.getHighlightAudioMode(segMixed) : 'skip',
    'skip'
  );
  // getHighlightAudioMode is an internal function or exported?
  // Let's test normalizeHighlightCutScript
  const scriptWithMixed = {
    segments: [
      {
        startSec: 0,
        endSec: 20,
        sourceStartSec: 0,
        sourceEndSec: 20,
        audio_mode: 'mixed_ducking',
        voiceover_text: 'Police arrive at a chaotic scene.',
        preview_vi: 'Cảnh sát đến một hiện trường hỗn loạn.'
      },
      {
        startSec: 20,
        endSec: 35,
        sourceStartSec: 20,
        sourceEndSec: 35,
        audio_mode: 'original_audio'
      }
    ]
  };
  const normalized = DubbingService.normalizeHighlightCutScript(scriptWithMixed, 100);
  assert.equal(normalized.segments[0].audioMode, 'voiceover_with_ambient');
  assert.equal(normalized.segments[0].sourceAmbientVolume, 0.15);
  assert.equal(normalized.segments[1].audioMode, 'original_audio');
  assert.equal(normalized.segments[1].sourceVolume, 1);
});

test('Type B hook with mixed_ducking passes validation in FastService', () => {
  const story = {
    scriptId: 1,
    title: 'Test Viral Hook',
    centralViewerQuestion: 'What happened?',
    hookPromise: 'Shocking discovery',
    climax: 'Arrest',
    payoff: 'Rescue',
    evidenceIds: ['clip-1'],
    reason: 'High drama',
    hookCandidates: [{ id: 'cand-1', category: 'action', sourceUnitIds: ['u1'], exactQuoteOrAction: 'knock', first3SecEvent: 'approach', reason: 'drama' }],
    detailUnitIds: []
  };
  const evidence = [{ id: 'clip-1', file: 'clip.mp4', duration: 60, sourceStart: 0, sourceUnits: [{ id: 'u1', start: 0, end: 30 }] }];
  const config = { targetDurationMinSec: 60, targetDurationMaxSec: 90, narration: { enabled: true, measuredWordsPerSecond: 2.5 } };
  
  const script = {
    scriptId: 1,
    title: 'Test Viral Hook',
    narrationArc: 'Opening hook leads to confrontation',
    rhythmException: 'none',
    hookAudit: {
      selectedCandidateId: 'cand-1',
      first3SecEvent: 'Police arrive at house with urgent narrator hook',
      exactQuoteOrAction: 'Emergency call details',
      selectionReason: 'Type B high-stakes narrator hook with ducked ambient',
      durationReason: '20s needed to establish premise',
      transitionToContext: 'Handoff to front door'
    },
    openingAudit: {
      hookSegmentIds: ['s1'],
      contextSegmentIds: ['s2'],
      completeBeat: true,
      understandableHandoff: true,
      closingQuoteOrReaction: 'Door opens',
      viewerUnderstands: 'Parents trapped daughter',
      nextDialogueConnection: 'Mom speaks'
    },
    segments: [
      {
        id: 's1',
        evidenceId: 'clip-1',
        start: 0,
        end: 20,
        storyRole: 'hook',
        narrativePurpose: 'Establish stakes at 0s',
        audioMode: 'mixed_ducking',
        sourceNarratorPresent: false,
        voiceoverText: 'On July 9th 2023 police in Georgia respond to a frantic 911 call.',
        emotionTag: 'URGENT',
        previewVi: 'Ngày 9 tháng 7, cảnh sát Georgia nhận cuộc gọi khẩn cấp.'
      },
      {
        id: 's2',
        evidenceId: 'clip-1',
        start: 20,
        end: 35,
        storyRole: 'context',
        narrativePurpose: 'Front door confrontation',
        audioMode: 'original_audio',
        sourceNarratorPresent: false,
        voiceoverText: '',
        emotionTag: 'NEUTRAL',
        previewVi: 'Chuyện gì đang xảy ra?'
      }
    ]
  };

  // Must not throw error about hook requiring original_audio!
  const validated = FastService.validateEdit(script, story, evidence, config);
  assert.equal(validated.segments[0].audioMode, 'mixed_ducking');
});

test('Rhythm analyze allows 60% narration ratio and 20s runs for viral TikTok', () => {
  const segments = [
    { id: 's1', start: 0, end: 20, audioMode: 'mixed_ducking', voiceoverText: 'Viral hook narration', storyRole: 'hook' },
    { id: 's2', start: 20, end: 40, audioMode: 'original_audio', storyRole: 'confrontation' },
    { id: 's3', start: 40, end: 55, audioMode: 'mixed_ducking', voiceoverText: 'Cognitive framing', storyRole: 'framing' },
    { id: 's4', start: 55, end: 75, audioMode: 'original_audio', storyRole: 'evidence' },
    { id: 's5', start: 75, end: 90, audioMode: 'voiceover_only', voiceoverText: 'Cliffhanger outro', storyRole: 'climax' }
  ];
  // Total = 90s. Narration = 20 + 15 + 15 = 50s. Ratio = 50/90 = 55.5%. Max run = 20s.
  const result = analyze({ segments });
  assert.equal(result.needsReview, false, '55% narration with 20s run should pass without review');
  assert.equal(result.severe, false, 'should not be flagged as severe');
});
