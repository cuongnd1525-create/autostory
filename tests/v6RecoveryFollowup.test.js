'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  BOUNDARY_CACHE_VERSION,
  detectSourceEndingBoundary
} = require('../electron/services/sourceEndingBoundaryService');
const Director = require('../electron/services/editorialDirectorService');
const { narrateBlocks } = require('../electron/services/blockNarrationService');
const narrationGate = require('../electron/services/narrationGate');
const { verifyHookTitle } = require('../electron/services/hookAuditionService');
const { runFinalQualityGate, verifyFinalQaBinding } = require('../electron/services/finalQualityGateService');
const DubbingService = require('../electron/services/dubbingService');

function runFfmpegSync(args) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 45000
  });
  if (res.status !== 0) {
    throw new Error(`ffmpeg fixture generation failed (${res.status}): ${res.stderr}`);
  }
}

/**
 * Builds a valid Director EDL fixture adhering to the canonical v5/v6 Director & Delivery contracts.
 */
function makeDirectorEdlFixture({
  scopeEndSec = 120,
  beats = null,
  deliveryBlocks = null,
  transitionChecks = null
} = {}) {
  const scope = {
    contract: 'story_scope_v1',
    storyScopeId: 'scope_unit_1',
    title: 'Roadside Escalation Over Misuse Warning',
    centralConflict: 'A stranded motorist treats an emergency dispatch line like roadside customer service and refuses lawful orders.',
    centralViewerQuestion: 'What happens when a motorist hangs up on dispatch and challenges the deputy who tracks her down?',
    payoffTarget: 'Deputies place the motorist in handcuffs and explain why refusing identification escalated a warning into an arrest.',
    scopeWindows: [
      {
        scopeWindowId: 'sw_1',
        startSec: 0,
        endSec: scopeEndSec,
        purpose: 'incident',
        purposes: ['hook_material', 'incident', 'ending_material'],
        purposeRanges: [{ purpose: 'ending_material', startSec: Math.max(0, scopeEndSec - 35), endSec: scopeEndSec }]
      }
    ],
    targetDurationSec: 75,
    targetDurationMinSec: 65,
    targetDurationMaxSec: 90
  };
  const reel = {
    contract: 'scope_reel_v1',
    ranges: [{ scopeWindowId: 'sw_1', segmentId: 'seg_1', sourceStartSec: 0, sourceEndSec: scopeEndSec, windowStartSec: 0, windowEndSec: scopeEndSec }],
    manifest: [{ segmentIndex: 0, reelIndex: 0, reelStartSec: 0, reelEndSec: scopeEndSec, sourceStartSec: 0, sourceEndSec: scopeEndSec }],
    totalSec: scopeEndSec,
    logicalWindowCount: 1,
    fileCount: 1
  };
  const defaultBeats = beats || [
    {
      beatId: 'b1',
      sourceStartSec: 4.0,
      sourceEndSec: 12.0,
      narrativeRole: 'hook',
      observedInFootage: 'Dispatcher warns caller about emergency-only 911 line before she hangs up.',
      whyNecessaryNow: 'Opens directly on friction and plants the central question.',
      editIntent: 'keep_full'
    },
    {
      beatId: 'b2',
      sourceStartSec: 16.0,
      sourceEndSec: 28.0,
      narrativeRole: 'context',
      observedInFootage: 'Cruiser exterior approaching parked vehicle along roadside shoulder.',
      whyNecessaryNow: 'Clean visual setup window for narrator context.',
      editIntent: 'keep_full'
    },
    {
      beatId: 'b3',
      sourceStartSec: 32.0,
      sourceEndSec: 52.0,
      narrativeRole: 'escalation',
      observedInFootage: 'Motorist argues with deputy through window and refuses to step out.',
      whyNecessaryNow: 'Preserves high-value verbal confrontation in raw audio.',
      editIntent: 'keep_full'
    },
    {
      beatId: 'b4',
      sourceStartSec: 55.0,
      sourceEndSec: 67.0,
      narrativeRole: 'escalation',
      observedInFootage: 'Deputy steps aside silently while backup unit pulls behind.',
      whyNecessaryNow: 'Clean silent action window for analytical narrator re-hook.',
      editIntent: 'keep_full'
    },
    {
      beatId: 'b5',
      sourceStartSec: 70.0,
      sourceEndSec: 88.0,
      narrativeRole: 'climax',
      observedInFootage: 'Deputies place motorist in handcuffs beside cruiser.',
      whyNecessaryNow: 'Delivers concrete legal consequence answering the central question.',
      editIntent: 'keep_full'
    },
    {
      beatId: 'b6',
      sourceStartSec: 92.0,
      sourceEndSec: 99.0,
      narrativeRole: 'ending',
      observedInFootage: 'Deputies secure patrol door on roadside.',
      whyNecessaryNow: 'Clean visual aftermath for grounded closing reflection.',
      editIntent: 'keep_full'
    }
  ];
  const defaultBlocks = deliveryBlocks || [
    {
      blockId: 'db_1',
      mode: 'raw_evidence',
      beatIds: ['b1'],
      footageFunction: 'CONFLICT',
      narratorFunction: 'NONE',
      sourceAudio: 'original_audio',
      blockSummary: 'Cold open dispatch warning and hang-up.',
      viewerStateChanges: 1,
      ownershipReason: 'Raw call clash immediately hooks the viewer.'
    },
    {
      blockId: 'db_2',
      mode: 'narrated_story',
      beatIds: ['b2'],
      footageFunction: 'CHARACTER_REVEAL',
      narratorFunction: 'CONTEXT',
      narrationIntent: 'Explain why dispatch flagged the call and what she expected deputies to do.',
      commentaryValue: 'Frames the gap between emergency law and her expectation.',
      heldBackForFootage: 'Withhold her exact retort inside the vehicle.',
      sourceAudio: 'voiceover_with_ambient',
      blockSummary: 'Narrator frames why deputies traced the hang-up call.',
      viewerStateChanges: 1,
      ownershipReason: 'Clean cruiser approach B-roll allows crisp context.'
    },
    {
      blockId: 'db_3',
      mode: 'raw_evidence',
      beatIds: ['b3'],
      footageFunction: 'REAL_EVIDENCE',
      narratorFunction: 'NONE',
      sourceAudio: 'original_audio',
      blockSummary: 'Motorist argues that being rude is not illegal.',
      viewerStateChanges: 2,
      ownershipReason: 'Her exact words carry irreplaceable character reveal.'
    },
    {
      blockId: 'db_4',
      mode: 'narrated_story',
      beatIds: ['b4'],
      footageFunction: 'TURNING_POINT',
      narratorFunction: 'COMMENTARY',
      narrationIntent: 'Highlight how refusing lawful commands turns a warning into obstruction.',
      commentaryValue: 'Clarifies the exact legal turning point before handcuffs come out.',
      sourceAudio: 'voiceover_with_ambient',
      blockSummary: 'Narrator interprets the legal turning point as backup arrives.',
      viewerStateChanges: 1,
      ownershipReason: 'Silent backup arrival window supports analytical commentary.'
    },
    {
      blockId: 'db_5',
      mode: 'raw_evidence',
      beatIds: ['b5'],
      footageFunction: 'CONSEQUENCE',
      narratorFunction: 'NONE',
      sourceAudio: 'original_audio',
      blockSummary: 'Deputies place motorist under arrest.',
      viewerStateChanges: 1,
      ownershipReason: 'Real arrest audio delivers visceral consequence.'
    },
    {
      blockId: 'db_6',
      mode: 'narrated_story',
      beatIds: ['b6'],
      footageFunction: 'PAYOFF',
      narratorFunction: 'CLOSING',
      narrationIntent: 'Reflect on how a preventable roadside dispute escalated into jail.',
      commentaryValue: 'Synthesizes the consequence cleanly.',
      sourceAudio: 'voiceover_only',
      blockSummary: 'Grounded closing reflection as patrol door closes.',
      viewerStateChanges: 1,
      ownershipReason: 'Narrator closes the story arc without dead air.'
    }
  ];
  const defaultTransitions = transitionChecks || defaultBlocks.slice(1).map((b, idx) => ({
    fromBlockId: defaultBlocks[idx].blockId,
    toBlockId: b.blockId,
    coldViewerUnderstandsWhy: true,
    howTheViewerKnows: 'Causal progression across blocks'
  }));
  return {
    scope,
    reel,
    edl: {
      storyScopeId: scope.storyScopeId,
      hookPromise: 'Calling Emergency Dispatch Over a Tow Escalates Fast',
      centralViewerQuestion: scope.centralViewerQuestion,
      openingChoice: {
        hookOptionsConsidered: [
          { optionId: 'opt_1', sourceStartSec: 4.0, sourceEndSec: 12.0, openingType: 'in_media_res_clash', whyConsidered: 'Immediate verbal clash' },
          { optionId: 'opt_2', sourceStartSec: 70.0, sourceEndSec: 76.0, openingType: 'arrest_teaser', whyConsidered: 'High tension cuffing' }
        ],
        chosenOptionId: 'opt_1',
        selectionRationale: 'Starts directly on the dispatch confrontation without spoiling the arrest.'
      },
      beats: defaultBeats,
      deliveryBlocks: defaultBlocks,
      transitionChecks: defaultTransitions,
      payoffBeatId: 'b5',
      endingBeatId: 'b6',
      whyEndingFeelsComplete: 'Consequence and closing synthesis resolve the central question.'
    }
  };
}

test('Stage A (1): Post-render Final Quality Gate catches Frame 2393 split-screen outro intrusion and 0.95s audio tail silence', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-qa-outro-'));
  try {
    // 1A. Deterministic synthetic 1080x1920 30fps MP4 with 3-panel split-screen outro inside foreground viewport + 0.95s silent tail
    const syntheticBuggyMp4 = path.join(tmpDir, 'synthetic-outro-bug.mp4');
    runFfmpegSync([
      '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=3.8',
      '-f', 'lavfi', '-i',
      'color=c=0x3a4f66:s=1080x1920:r=30:d=1.2,drawbox=x=0:y=830:w=1080:h=16:color=black@1:t=fill,drawbox=x=0:y=1060:w=1080:h=16:color=black@1:t=fill',
      '-f', 'lavfi', '-i', 'sine=frequency=260:duration=4.05',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=0.95',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]volume=0.65,aformat=sample_rates=44100:channel_layouts=stereo[a0];[a0][3:a]concat=n=2:v=0:a=1[a]',
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      syntheticBuggyMp4
    ]);

    const synthQa = await runFinalQualityGate({
      mp4Path: syntheticBuggyMp4,
      minDurationSec: 3.5,
      maxDurationSec: 8.0
    });
    assert.equal(synthQa.qaResult, 'FAIL');
    assert.equal(synthQa.publishReady, false);
    assert.equal(synthQa.technicalGate.status, 'FAIL');
    const synthCodes = synthQa.blockingFindings.map(f => f.code);
    assert.ok(synthCodes.includes('OUTRO_INTRUSION_DETECTED'), `Expected OUTRO_INTRUSION_DETECTED, got ${synthCodes.join(', ')}`);
    assert.ok(synthCodes.includes('AUDIO_TAIL_SILENCE'), `Expected AUDIO_TAIL_SILENCE, got ${synthCodes.join(', ')}`);

    // 1B. Verify on actual buggy V6 Recovery artifact if present on workspace machine
    const realBuggyPath = 'D:\\Video\\v6-recovery-storyteller-benchmark-final.mp4';
    if (fs.existsSync(realBuggyPath)) {
      const realQa = await runFinalQualityGate({
        mp4Path: realBuggyPath,
        endingBoundary: { hasOutro: true, outroStartSec: 530.03, liveActionEndSec: 529.83, confidence: 0.99, uncertain: false },
        topCaptionText: "24yo Abuses 911 Then Gets a Reality Check She Won't Forget",
        referenceTitle: "24yo Abuses 911 Then Gets a Realty Check She Won't Forget",
        cues: [{ startSec: 0, endSec: 5, text: '911 what is the address of your emergency' }]
      });
      assert.equal(realQa.qaResult, 'FAIL');
      assert.equal(realQa.publishReady, false);
      const realCodes = realQa.blockingFindings.map(f => f.code);
      assert.ok(realCodes.includes('OUTRO_INTRUSION_DETECTED'), 'Real buggy MP4 must trigger OUTRO_INTRUSION_DETECTED');
      assert.ok(realCodes.includes('UNEXPECTED_LAYOUT_TRANSITION'), 'Real buggy MP4 must trigger UNEXPECTED_LAYOUT_TRANSITION at ~79.767s');
      assert.ok(realCodes.includes('AUDIO_TAIL_SILENCE'), 'Real buggy MP4 must trigger AUDIO_TAIL_SILENCE at ~79.803s');
      assert.ok(realCodes.includes('UNVERIFIED_AGE_IN_TITLE'), 'Real buggy MP4 title "24yo" must trigger UNVERIFIED_AGE_IN_TITLE');

      const layoutFinding = realQa.blockingFindings.find(f => f.code === 'UNEXPECTED_LAYOUT_TRANSITION');
      assert.ok(layoutFinding.timestampSec >= 79.65 && layoutFinding.timestampSec <= 79.85, `Expected cut transition near 79.767s, got ${layoutFinding.timestampSec}s`);
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Stage A (2): EDL boundary validator rejects middle and ending beats exceeding liveActionEndSec and blocks uncertain boundaries from auto-PASS', () => {
  const { scope, reel, edl } = makeDirectorEdlFixture({ scopeEndSec: 540 });
  // Mutate b3 (middle beat) and b6 (ending beat) to cross liveActionEndSec = 529.83s
  const invalidEdl = {
    ...edl,
    beats: edl.beats.map(b => {
      if (b.beatId === 'b3') return { ...b, sourceStartSec: 518.0, sourceEndSec: 530.4 };
      if (b.beatId === 'b6') return { ...b, sourceStartSec: 528.5, sourceEndSec: 531.0 };
      return b;
    })
  };

  const val = Director.validateDirectorEdl(invalidEdl, scope, {
    reel,
    durationSec: 553.0,
    liveActionEndSec: 529.83,
    targetDurationMinSec: 65,
    targetDurationMaxSec: 90
  });
  assert.equal(val.valid, false);
  const codes = val.violations.map(v => v.code);
  assert.ok(codes.includes('BEAT_CUTS_INTO_OUTRO'), `Middle beat crossing liveActionEndSec must emit BEAT_CUTS_INTO_OUTRO (${codes.join(', ')})`);
  assert.ok(codes.includes('ENDING_CUTS_INTO_OUTRO'), `Ending beat crossing liveActionEndSec must emit ENDING_CUTS_INTO_OUTRO (${codes.join(', ')})`);

  // Even if an EDL stays inside liveActionEndSec, an uncertain boundary must block auto-ACCEPTED
  const cleanFixture = makeDirectorEdlFixture({ scopeEndSec: 120 });
  const stampedSpine = {
    ...cleanFixture.edl,
    editorialContract: Director.DIRECTOR_CONTRACT,
    storyScope: cleanFixture.scope,
    scopeReel: cleanFixture.reel
  };
  const uncertainAcceptance = Director.acceptanceReport(stampedSpine, {
    durationSec: 140,
    liveActionEndSec: 118.0,
    endingBoundary: { hasOutro: true, liveActionEndSec: 118.0, confidence: 0.62, uncertain: true },
    renderedDurationSec: 75.0,
    critique: {
      status: 'COMPLETED',
      isCompliant: true,
      scopeSurvived: true,
      centralQuestionActiveThroughout: true,
      endingIsConsequence: true,
      finalFootageUsable: true,
      issues: [],
      weakRegions: []
    }
  });
  assert.notEqual(uncertainAcceptance.status, Director.ACCEPTANCE.ACCEPTED, 'Uncertain source boundary must not auto-ACCEPT without visual verification');
  assert.ok(
    uncertainAcceptance.technical.violations.some(v => v.code === 'SOURCE_BOUNDARY_UNCERTAIN'),
    `Expected SOURCE_BOUNDARY_UNCERTAIN in technical violations, got ${JSON.stringify(uncertainAcceptance.technical.violations)}`
  );
});

test('Stage A (3): Source-boundary cache invalidates stale v1 metadata and refreshes on sourceFingerprint change', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-boundary-cache-'));
  try {
    const cacheFile = path.join(tmpDir, 'source-ending-boundary.json');
    // Seed stale v1 cache entry that previously let 530.5s slip through
    await fsp.writeFile(cacheFile, JSON.stringify({
      version: 1,
      liveActionEndSec: 530.5,
      hasOutro: true,
      outroStartSec: 531.0
    }, null, 2));

    const cues = [
      { startSec: 510.0, endSec: 515.0, text: 'Step inside the transport van please.' },
      { startSec: 530.5, endSec: 536.0, text: 'She later pleaded guilty and all other charges were dropped.' }
    ];
    const sceneManifest = {
      scenes: [
        { sceneId: 's1', startSec: 500.0, endSec: 530.03 },
        { sceneId: 's2', startSec: 530.03, endSec: 553.0 }
      ]
    };

    const refreshed = await detectSourceEndingBoundary({
      sourcePath: '',
      durationSec: 553.0,
      cues,
      sceneManifest,
      cacheDir: tmpDir,
      sourceHash: 'hash_abc_1',
      skipMediaProbe: true
    });
    assert.equal(refreshed.version, BOUNDARY_CACHE_VERSION);
    assert.ok(refreshed.liveActionEndSec < 530.0, `Expected stale 530.5s cache invalidated, got ${refreshed.liveActionEndSec}s`);
    assert.equal(refreshed.outroStartSec, 530.03);

    const diskAfterRefresh = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    assert.equal(diskAfterRefresh.version, BOUNDARY_CACHE_VERSION);
    assert.equal(diskAfterRefresh.sourceFingerprint, refreshed.sourceFingerprint);

    // Changing sourceHash invalidates fingerprint even with same version=2
    const invalidatedByHash = await detectSourceEndingBoundary({
      sourcePath: '',
      durationSec: 553.0,
      cues: [{ startSec: 520.0, endSec: 524.0, text: 'Thanks for watching and subscribe for more.' }],
      sceneManifest: { scenes: [{ sceneId: 's1', startSec: 500.0, endSec: 520.0 }, { sceneId: 's2', startSec: 520.0, endSec: 553.0 }] },
      cacheDir: tmpDir,
      sourceHash: 'hash_abc_2',
      skipMediaProbe: true
    });
    assert.notEqual(invalidatedByHash.sourceFingerprint, refreshed.sourceFingerprint);
    assert.equal(invalidatedByHash.outroStartSec, 520.0);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Stage A (4) & (9): QA report rejects 540x960 draft reuse for Production Final AND invalidates SHA-256 binding on 1-byte mutation', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-qa-binding-'));
  try {
    const draftMp4 = path.join(tmpDir, 'fast-draft-540p.mp4');
    const finalMp4 = path.join(tmpDir, 'production-final-1080p.mp4');

    runFfmpegSync([
      '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30:duration=4.0',
      '-f', 'lavfi', '-i', 'sine=frequency=320:duration=4.0',
      '-filter_complex', '[1:a]volume=0.65[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      draftMp4
    ]);

    runFfmpegSync([
      '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=4.0',
      '-f', 'lavfi', '-i', 'sine=frequency=320:duration=4.0',
      '-filter_complex', '[1:a]volume=0.65[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      finalMp4
    ]);

    // Case 4: Draft QA fails production resolution gate and cannot bind to Final MP4
    const draftQa = await runFinalQualityGate({
      mp4Path: draftMp4,
      minDurationSec: 3.0,
      maxDurationSec: 6.0
    });
    assert.equal(draftQa.publishReady, false);
    assert.ok(draftQa.blockingFindings.some(f => f.code === 'DIMENSIONS_MISMATCH'));

    const crossCheck = await verifyFinalQaBinding(draftQa, finalMp4);
    assert.equal(crossCheck.valid, false);
    assert.ok(crossCheck.reasons.some(r => r.startsWith('QA_PATH_MISMATCH')));
    assert.ok(crossCheck.reasons.some(r => r.startsWith('QA_SHA256_MISMATCH')));
    assert.ok(crossCheck.reasons.some(r => r.startsWith('QA_NOT_PRODUCTION_RESOLUTION')));

    // Case 9: Valid 1080x1920 Final QA binds cleanly until 1 byte is mutated
    const finalQa = await runFinalQualityGate({
      mp4Path: finalMp4,
      minDurationSec: 3.0,
      maxDurationSec: 6.0,
      topCaptionText: 'Routine Roadside Stop Turns Into Dramatic Confrontation Over Dispatch',
      spine: {
        beats: [
          { beatId: 'b1', sourceStartSec: 0, sourceEndSec: 1.4 },
          { beatId: 'b2', sourceStartSec: 1.4, sourceEndSec: 2.8 },
          { beatId: 'b3', sourceStartSec: 2.8, sourceEndSec: 4.0 }
        ],
        deliveryBlocks: [
          { blockId: 'db1', mode: 'narrated_story', narratorFunction: 'CONTEXT', commentaryValue: 'Setup framing', beatIds: ['b1'] },
          { blockId: 'db2', mode: 'narrated_story', narratorFunction: 'COMMENTARY', commentaryValue: 'Analytical framing', beatIds: ['b2'] },
          { blockId: 'db3', mode: 'narrated_story', narratorFunction: 'CLOSING', commentaryValue: 'Closing synthesis', beatIds: ['b3'] }
        ]
      },
      narrationAudit: {
        summary: {
          narratorBlockCount: 3,
          narratorShareBySpeakingPct: 36.0,
          maxUninterruptedRawSec: 2.5,
          hasSpoiler: false,
          hasRushedVoice: false
        },
        blocks: [
          { wpm: 160, potentialSpoiler: { hasSpoiler: false, spoiledQuotes: [] } },
          { wpm: 164, potentialSpoiler: { hasSpoiler: false, spoiledQuotes: [] } },
          { wpm: 158, potentialSpoiler: { hasSpoiler: false, spoiledQuotes: [] } }
        ]
      }
    });
    assert.equal(finalQa.qaResult, 'PASS', `Expected PASS on clean 1080x1920 fixture, got ${JSON.stringify(finalQa.blockingFindings)}`);
    assert.equal(finalQa.publishReady, true);

    const validBinding = await verifyFinalQaBinding(finalQa, finalMp4);
    assert.equal(validBinding.valid, true, `Expected valid binding, got ${JSON.stringify(validBinding.reasons)}`);

    // Mutate file by 1 byte after QA
    await fsp.appendFile(finalMp4, Buffer.from([0x00]));
    const mutatedBinding = await verifyFinalQaBinding(finalQa, finalMp4);
    assert.equal(mutatedBinding.valid, false);
    assert.ok(mutatedBinding.reasons.some(r => r.startsWith('QA_SHA256_MISMATCH')));
    assert.ok(mutatedBinding.reasons.some(r => r.startsWith('QA_FILESIZE_MISMATCH')));
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Stage A (5) & (6): Visual ownership map exposes clean B-roll windows and repair validator blocks narrator deletion & lost punchlines', () => {
  const { edl: beforeEdl, reel } = makeDirectorEdlFixture({ scopeEndSec: 120 });
  const cues = [
    { startSec: 4.2, endSec: 11.5, text: '911 is for emergencies only, do not hang up on dispatch.' },
    { startSec: 33.0, endSec: 38.5, text: 'Being rude is not illegal, you cannot arrest me for hanging up!' },
    { startSec: 71.0, endSec: 77.0, text: 'Turn around and put your hands behind your back right now.' }
  ];
  const model = {
    events: [
      { id: 'ev1', startSec: 16.0, endSec: 28.0, summary: 'Deputies arrive on roadside shoulder and inspect parked vehicle' },
      { id: 'ev2', startSec: 55.0, endSec: 67.0, summary: 'Deputy walks back to cruiser before supervisor arrives' }
    ],
    quotes: [
      { id: 'q1', startSec: 33.0, endSec: 38.5, text: 'Being rude is not illegal, you cannot arrest me for hanging up!', speaker: 'Driver' }
    ]
  };

  // Case 5A: Clean B-roll windows & high-value quotes surfaced to Director
  const ownershipMap = Director.buildVisualOwnershipMap(reel, model, cues);
  assert.ok(ownershipMap.cleanVisualBrollWindows.length >= 2, `Expected >=2 clean B-roll windows, got ${ownershipMap.cleanVisualBrollWindows.length}`);
  assert.ok(ownershipMap.highValueRawQuotes.some(q => /Being rude is not illegal/i.test(q.text)), 'Expected high-value raw quote detected dynamically');

  // Case 5B: Repair that deletes narrator blocks (3 narrated blocks / 31s -> 1 narrated block / 7s) is rejected
  const regressedNarratorEdl = {
    ...beforeEdl,
    deliveryBlocks: beforeEdl.deliveryBlocks.map(b =>
      (b.blockId === 'db_2' || b.blockId === 'db_4')
        ? {
            ...b,
            mode: 'raw_evidence',
            narratorFunction: 'NONE',
            narrationIntent: '',
            sourceAudio: 'original_audio'
          }
        : b
    )
  };
  const cmp = Director.compareNarratorPlans(beforeEdl, regressedNarratorEdl, { pacingMode: 'commentary_led', narrationEnabled: true });
  assert.equal(cmp.regressed, true);
  assert.ok(cmp.violations.some(v => v.code === 'NARRATOR_REGRESSION_IN_REPAIR'));

  // Case 6: Repair that drops the high-value raw quote beat (33.0-38.5s) is rejected
  const droppedPunchlineEdl = {
    ...beforeEdl,
    beats: beforeEdl.beats.map(b =>
      b.beatId === 'b3' ? { ...b, sourceStartSec: 39.5, sourceEndSec: 59.5 } : b
    )
  };
  const punchlineViolations = Director.punchlinePreservationViolations(
    beforeEdl,
    droppedPunchlineEdl,
    ownershipMap.highValueRawQuotes
  );
  assert.ok(
    punchlineViolations.some(v => v.code === 'HIGH_VALUE_QUOTE_LOST_IN_REPAIR'),
    `Expected HIGH_VALUE_QUOTE_LOST_IN_REPAIR, got ${punchlineViolations.map(v => v.code).join(', ')}`
  );
});

test('Stage A (7): Narrator punchline spoiler detector and Hook Title factual/copycat verifier catch violations', () => {
  const nextRawQuotes = ['Being rude is not illegal, you have no right to hold me here.'];

  // Verbatim pre-quote spoils the punchline
  const spoiled = narrationGate.detectPunchlineSpoiler(
    'She pushes back immediately and argues that being rude is not illegal.',
    nextRawQuotes
  );
  assert.equal(spoiled.hasSpoiler, true);

  // Grounded anticipation builds curiosity without quoting the punchline
  const cleanSetup = narrationGate.detectPunchlineSpoiler(
    'Instead of stepping out quietly, she offers an unexpected legal theory of her own.',
    nextRawQuotes
  );
  assert.equal(cleanSetup.hasSpoiler, false);

  // Hook title verifier catches unverified "24yo", reference copycat, and withheld payoff spoilers
  const cues = [
    { startSec: 0, endSec: 6, text: '911 is for emergencies only, maam, do not call back unless there is danger.' },
    { startSec: 30, endSec: 36, text: 'Being rude is not illegal.' }
  ];
  const unverifiedAge = verifyHookTitle(
    "24yo Abuses 911 Then Gets a Reality Check She Won't Forget",
    {
      referenceTitle: "24yo Abuses 911 Then Gets a Realty Check She Won't Forget",
      cues,
      mustWithhold: ['pleaded guilty']
    }
  );
  assert.equal(unverifiedAge.valid, false);
  const issueCodes = unverifiedAge.issues.map(i => i.code);
  assert.ok(issueCodes.includes('UNVERIFIED_AGE_IN_TITLE'), `Expected UNVERIFIED_AGE_IN_TITLE in ${issueCodes.join(', ')}`);
  assert.ok(issueCodes.includes('TITLE_COPIES_REFERENCE'), `Expected TITLE_COPIES_REFERENCE in ${issueCodes.join(', ')}`);

  const cleanTitle = verifyHookTitle(
    'She Treated 911 Like Roadside Assistance — Until Deputies Tracked Her Down',
    {
      referenceTitle: "24yo Abuses 911 Then Gets a Realty Check She Won't Forget",
      cues,
      mustWithhold: ['handcuffed inside the transport van']
    }
  );
  assert.equal(cleanTitle.valid, true, `Clean grounded title should pass, got ${JSON.stringify(cleanTitle.issues)}`);
});

test('Stage A (8): Closing 4-word stub triggers advisory expansion and Production Final isolates native Full-HD clip cache', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-tts-closing-'));
  try {
    // 8A: narrateBlocks expands undersized 4-word closing stub ("Was her arrest justified?") on a 4.8s closing block
    let askCount = 0;
    const fakeService = {
      measuredVoice: async (_project, text) => {
        const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
        return { meta: { duration: Math.max(0.8, words / 2.65) } };
      }
    };
    const fakeEngine = {
      cache: tmpDir,
      config: { narration: { enabled: true, measuredWordsPerSecond: 2.65 } },
      project: { voiceProvider: 'kokoro', voiceId: 'am_adam', kokoroSpeed: 1.04 },
      ask: async () => {
        askCount += 1;
        if (askCount === 1) {
          return { narrations: [{ blockId: 'db_close', narrationText: 'Was her arrest justified?', newInformationRefs: ['ev_end'] }] };
        }
        return {
          narrations: [{
            blockId: 'db_close',
            narrationText: 'What began as a roadside complaint ended in handcuffs that night.',
            newInformationRefs: ['ev_end']
          }]
        };
      }
    };
    const beats = [{ beatId: 'b6', sourceStartSec: 520.0, sourceEndSec: 524.8, duration: 4.8, narrativeRole: 'ending' }];
    const blocks = [{
      blockId: 'db_close',
      mode: 'narrated_story',
      beatIds: ['b6'],
      narratorFunction: 'CLOSING',
      footageFunction: 'PAYOFF',
      narrationIntent: 'Close on the real consequence of refusing lawful orders.',
      sourceAudio: 'voiceover_only',
      blockSummary: 'Closing reflection',
      viewerStateChanges: 1,
      ownershipReason: 'Closing takeaway'
    }];
    const story = {
      scriptId: 1,
      title: 'Roadside Escalation',
      centralViewerQuestion: 'What happens next?',
      beats,
      deliveryBlocks: blocks
    };
    const model = {
      events: [{ id: 'ev_end', startSec: 520.0, endSec: 525.0, summary: 'Deputies secure patrol van door after arrest.' }],
      quotes: []
    };
    const narrated = await narrateBlocks({
      engine: fakeEngine,
      service: fakeService,
      story,
      model,
      beats,
      blocks,
      evidence: []
    });
    assert.equal(askCount, 2, 'Expected 4-word closing stub to trigger advisory expansion pass');
    const finalClosingWords = narrated.blocks[0].narrationText.trim().split(/\s+/).length;
    assert.ok(finalClosingWords >= 10, `Expected expanded closing line >= 10 words, got ${finalClosingWords}: "${narrated.blocks[0].narrationText}"`);

    // 8B: renderNarratedDeliveryBlock uses width=540/crf=32 for draft vs width=null/crf=20 & closing ambient=0.14 for Production Final
    const extractCalls = [];
    const mixCalls = [];
    const fitCalls = [];
    const fakeFfmpeg = {
      extractVoiceDrivenClipWithAudio: async (opts) => {
        extractCalls.push(opts);
        await fsp.writeFile(opts.outputPath, Buffer.alloc(2048, 1));
      },
      normalizeMediaDuration: async (opts) => {
        await fsp.writeFile(opts.outputPath, Buffer.alloc(2048, 2));
      },
      concatSegmentsByFilter: async (_inputs, outputPath) => {
        await fsp.writeFile(outputPath, Buffer.alloc(2048, 3));
      },
      probeAudio: async () => ({ duration: 4.05 }),
      fitDubbingClusterAudio: async (opts) => {
        fitCalls.push(opts);
        await fsp.writeFile(opts.outputPath, Buffer.alloc(2048, 4));
        return { appliedSpeed: 1.0, outputDuration: opts.targetDuration };
      },
      mixVideoAudioWithVoice: async (opts) => {
        mixCalls.push(opts);
        await fsp.writeFile(opts.outputPath, Buffer.alloc(2048, 5));
      },
      probeVideo: async () => ({ duration: 4.5, width: 1080, height: 1920 })
    };

    const dub = Object.create(DubbingService.prototype);
    dub.synthesizeFastDraftVoice = async ({ outputPath }) => {
      await fsp.writeFile(outputPath, Buffer.alloc(2048, 6));
      return { cacheHit: false, cacheKey: 'voice_key_1' };
    };

    const clipsDir = path.join(tmpDir, 'clips');
    const audioDir = path.join(tmpDir, 'audio');
    await fsp.mkdir(clipsDir, { recursive: true });
    await fsp.mkdir(audioDir, { recursive: true });
    const fakeSource = path.join(tmpDir, 'fake-source.mp4');
    await fsp.writeFile(fakeSource, Buffer.alloc(4096, 7));
    const sourceStat = await fsp.stat(fakeSource);

    const commonArgs = {
      ffmpeg: fakeFfmpeg,
      project: {
        sourceVideoPath: fakeSource,
        draftVoiceMode: 'final',
        voiceProvider: 'kokoro',
        voiceId: 'am_adam',
        kokoroSpeed: 1.04,
        mixer: { voiceVolume: 100, narrationDuckDefault: true }
      },
      settings: {},
      workspaceRoot: tmpDir,
      paths: { clipsDir, audioDir },
      variantSuffix: 'v1',
      draftVoiceProvider: 'kokoro',
      draftVoiceExt: '.wav',
      autoStorySourceStat: sourceStat,
      members: [{
        deliveryBlockId: 'db_close',
        blockNarrationText: 'What began as a roadside complaint ended in handcuffs.',
        blockSourceAudio: 'voiceover_only',
        sourceStartSec: 10.0,
        sourceEndSec: 14.5,
        duration: 4.5
      }],
      startIndex: 0
    };

    // First render as Fast Draft (isFinal = false, isClosingBlock = false)
    await dub.renderNarratedDeliveryBlock({ ...commonArgs, isFinal: false, isClosingBlock: false });
    assert.equal(extractCalls[0].width, 540);
    assert.equal(extractCalls[0].crf, 32);
    assert.equal(fitCalls[0].allowSlowDown, false);
    assert.equal(mixCalls[0].sourceVolume, 0.05);

    // Second render as Production Final Closing Block (isFinal = true, isClosingBlock = true) -> MUST NOT hit 540p draft cache!
    await dub.renderNarratedDeliveryBlock({ ...commonArgs, isFinal: true, isClosingBlock: true });
    assert.equal(extractCalls.length, 2, 'Production Final must bypass 540p fast-draft clip cache');
    assert.equal(extractCalls[1].width, null, 'Production Final must preserve native source resolution');
    assert.equal(extractCalls[1].crf, 20, 'Production Final must use high-quality CRF 20');
    assert.equal(fitCalls[1].allowSlowDown, true, 'Closing block with fitRatio ~0.90 allows gentle slowdown');
    assert.equal(mixCalls[1].sourceVolume, 0.12, 'Clean closing block ducks ambient to subtle 0.12 room presence');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Stage A (10) & (11): Boundary detector handles no-outro videos and non-911 outro timestamps dynamically', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-multi-source-'));
  try {
    // Case 10: Continuous live-action source with NO outro -> hasOutro: false, liveActionEndSec === durationSec
    const noOutroMp4 = path.join(tmpDir, 'continuous-no-outro.mp4');
    runFfmpegSync([
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=12.0',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=12.0',
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      noOutroMp4
    ]);
    const noOutroRes = await detectSourceEndingBoundary({
      sourcePath: noOutroMp4,
      durationSec: 12.0
    });
    assert.equal(noOutroRes.hasOutro, false);
    assert.equal(noOutroRes.outroStartSec, null);
    assert.equal(noOutroRes.liveActionEndSec, 12.0);

    // Case 11: Non-911 source (14.0s total) where a 3-panel split-screen outro begins at 9.5s
    const customOutroMp4 = path.join(tmpDir, 'custom-9p5s-outro.mp4');
    runFfmpegSync([
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=9.5',
      '-f', 'lavfi', '-i',
      'color=c=0x34495e:s=640x360:r=30:d=4.5,drawbox=x=0:y=116:w=640:h=8:color=black@1:t=fill,drawbox=x=0:y=236:w=640:h=8:color=black@1:t=fill',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=9.5',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=4.5',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]aformat=sample_rates=44100:channel_layouts=stereo[a0];[a0][3:a]concat=n=2:v=0:a=1[a]',
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      customOutroMp4
    ]);
    const customRes = await detectSourceEndingBoundary({
      sourcePath: customOutroMp4,
      durationSec: 14.0
    });
    assert.equal(customRes.hasOutro, true, `Expected outro detected at ~9.5s, got ${JSON.stringify(customRes)}`);
    assert.ok(customRes.outroStartSec >= 9.2 && customRes.outroStartSec <= 9.8, `Expected outroStartSec near 9.5s, got ${customRes.outroStartSec}s`);
    assert.ok(customRes.liveActionEndSec <= 9.5, `Expected liveActionEndSec <= 9.5s, got ${customRes.liveActionEndSec}s`);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Stage A (12): Validator allows ducked narration over physical closing/transition B-roll (preventing outro push) while blocking substantive dialogue overlap', () => {
  const cues = [
    { startSec: 455.8, endSec: 459.0, text: 'Being rude to an officer is not against the law and you know that.' },
    { startSec: 459.1, endSec: 462.5, text: 'I only asked a simple question about where you took my car today.' },
    { startSec: 524.5, endSec: 527.0, text: 'I am going to close the door.' },
    { startSec: 527.1, endSec: 529.0, text: 'Okay. Got it. Thank you.' }
  ];
  const scope = {
    liveActionEndSec: 529.83,
    candidateEndingEvents: [{ sourceStartSec: 520.0, sourceEndSec: 529.83 }]
  };
  const reel = {
    ranges: [{ sourceStartSec: 0, sourceEndSec: 529.83 }]
  };

  // Valid edit: raw_evidence for substantive quote (455.8-461.0s) + narrated_story (voiceover_with_ambient) over physical van-door-closing B-roll (524.5-529.83s)
  const cleanSpine = {
    beats: [
      { beatId: 'b01', sourceStartSec: 10, sourceEndSec: 25, narrativeRole: 'hook', observedInFootage: 'Officer stops pedestrian on street', whyNecessaryNow: 'hook' },
      { beatId: 'b02', sourceStartSec: 455.8, sourceEndSec: 461.0, narrativeRole: 'confrontation', observedInFootage: 'Suspect argues her point in transport van', whyNecessaryNow: 'quote' },
      { beatId: 'b03', sourceStartSec: 524.5, sourceEndSec: 529.83, narrativeRole: 'button', observedInFootage: 'Deputy shuts and latches the transport van door in parking lot', whyNecessaryNow: 'closing' }
    ],
    deliveryBlocks: [
      { blockId: 'blk_1', mode: 'raw_evidence', beatIds: ['b01', 'b02'], evidenceFunction: 'conflict', footageFunction: 'CONFLICT' },
      { blockId: 'blk_2', mode: 'narrated_story', beatIds: ['b03'], narrationIntent: 'synthesize legal takeaway', narratorFunction: 'CLOSING', sourceAudioTreatment: 'voiceover_with_ambient' }
    ]
  };
  const cleanRes = Director.validateDirectorEdl(cleanSpine, scope, {
    durationSec: 550,
    targetDurationMinSec: 20,
    targetDurationMaxSec: 40,
    reel,
    narrationEnabled: true,
    cues,
    liveActionEndSec: 529.83
  });
  assert.equal(cleanRes.valid, true, `Expected cleanRes.valid === true on physical closing B-roll <= 529.83s, got ${JSON.stringify(cleanRes.violations)}`);

  // Invalid edit: narrated_story running over substantive multi-sentence argument (455.8-462.5s) -> MUST flag NARRATED_BLOCK_ACTIVE_DIALOGUE
  const badSpine = {
    beats: [
      { beatId: 'b01', sourceStartSec: 10, sourceEndSec: 25, narrativeRole: 'hook', observedInFootage: 'Officer stops pedestrian on street', whyNecessaryNow: 'hook' },
      { beatId: 'b02', sourceStartSec: 455.8, sourceEndSec: 462.5, narrativeRole: 'confrontation', observedInFootage: 'Suspect arguing that being rude is legal inside cabin', whyNecessaryNow: 'climax' },
      { beatId: 'b03', sourceStartSec: 524.5, sourceEndSec: 529.83, narrativeRole: 'button', observedInFootage: 'Deputy shuts and latches the transport van door in parking lot', whyNecessaryNow: 'closing' }
    ],
    deliveryBlocks: [
      { blockId: 'blk_1', mode: 'raw_evidence', beatIds: ['b01'], evidenceFunction: 'hook', footageFunction: 'CONFLICT' },
      { blockId: 'blk_2', mode: 'narrated_story', beatIds: ['b02', 'b03'], narrationIntent: 'interpret argument', narratorFunction: 'INTERPRETATION', sourceAudioTreatment: 'voiceover_with_ambient' }
    ]
  };
  const badRes = Director.validateDirectorEdl(badSpine, scope, {
    durationSec: 550,
    targetDurationMinSec: 20,
    targetDurationMaxSec: 40,
    reel,
    narrationEnabled: true,
    cues,
    liveActionEndSec: 529.83
  });
  assert.ok(
    badRes.violations.some(v => v.code === 'NARRATED_BLOCK_ACTIVE_DIALOGUE' && v.beatId === 'b02'),
    `Expected NARRATED_BLOCK_ACTIVE_DIALOGUE on b02 substantive dialogue, got ${JSON.stringify(badRes.violations)}`
  );
  assert.equal(
    badRes.violations.some(v => v.code === 'NARRATED_BLOCK_ACTIVE_DIALOGUE' && v.beatId === 'b03'),
    false,
    `Expected physical door-closing b03 NOT to be flagged, got ${JSON.stringify(badRes.violations)}`
  );
});

test('Stage A (13): BlockNarration caps >10 evidence video files to 10 AND closing-block audio settle + masterAudio limiter pass Technical Gate', async () => {
  const { selectNarrationEvidence } = require('../electron/services/blockNarrationService');
  const twelveClips = Array.from({ length: 12 }, (_, idx) => ({
    id: `ev_${idx + 1}`,
    file: `/tmp/ev_${idx + 1}.mp4`,
    sourceStart: idx * 20,
    duration: 12
  }));
  const payloads = [
    {
      blockId: 'blk_ctx',
      beats: [{ sourceStartSec: 22, sourceEndSec: 30 }],
      precedingRawBlock: { beats: [{ sourceStartSec: 2, sourceEndSec: 10 }] },
      followingRawBlock: { beats: [{ sourceStartSec: 42, sourceEndSec: 50 }] }
    },
    {
      blockId: 'blk_close',
      beats: [{ sourceStartSec: 222, sourceEndSec: 228 }],
      precedingRawBlock: { beats: [{ sourceStartSec: 202, sourceEndSec: 210 }] },
      followingRawBlock: null
    }
  ];
  const selected = selectNarrationEvidence(twelveClips, payloads);
  assert.equal(selected.length, 10, `Expected <= 10 video files for Vertex AI limit, got ${selected.length}`);
  assert.ok(selected.some(e => e.id === 'ev_2'), 'Must retain narrated block clip ev_2');
  assert.ok(selected.some(e => e.id === 'ev_12'), 'Must retain closing narrated block clip ev_12');
  assert.ok(selected.some(e => e.id === 'ev_11'), 'Must retain preceding handoff clip ev_11');

  // Real FFmpeg test of fitDubbingClusterAudio(isClosingBlock: true) + masterAudio limiter -> Technical Gate PASS
  const FfmpegService = require('../electron/services/ffmpegService');
  const ffmpeg = new FfmpegService({});
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-closing-settle-'));
  try {
    const rawTtsWav = path.join(tmpDir, 'closing-raw-5p38s.wav');
    const fittedM4a = path.join(tmpDir, 'closing-fitted-6p00s.m4a');
    const rawVideoMp4 = path.join(tmpDir, 'closing-video-6p00s.mp4');
    const mixedMp4 = path.join(tmpDir, 'closing-mixed-6p00s.mp4');
    const decoratedMp4 = path.join(tmpDir, 'closing-final-1080p.mp4');

    // Simulate 5.38s TTS WAV containing 4.86s speech + 0.52s synthesizer trailing silence (exact Run #2 failure shape)
    runFfmpegSync([
      '-f', 'lavfi', '-i', 'sine=frequency=240:duration=4.86',
      '-af', 'volume=0.9,apad=whole_dur=5.38,atrim=0:5.38',
      '-c:a', 'pcm_s16le',
      rawTtsWav
    ]);

    const fit = await ffmpeg.fitDubbingClusterAudio({
      inputPath: rawTtsWav,
      outputPath: fittedM4a,
      targetDuration: 6.0,
      maxStretchRatio: 0.08,
      maxSlowDownRatio: 0.12,
      isClosingBlock: true,
      normalize: true,
      allowTrim: false,
      allowSlowDown: true,
      allowSpeedUp: true
    });
    assert.ok(fit.fitStrategy.startsWith('closing_'), `Expected closing_* fitStrategy, got ${fit.fitStrategy}`);
    assert.ok(Math.abs(fit.outputDuration - 6.0) <= 0.12, `Expected ~6.0s fitted audio, got ${fit.outputDuration}s`);

    runFfmpegSync([
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6.0',
      '-f', 'lavfi', '-i', 'sine=frequency=140:duration=6.0',
      '-filter_complex', '[1:a]volume=0.05[amb]',
      '-map', '0:v', '-map', '[amb]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      rawVideoMp4
    ]);

    await ffmpeg.mixVideoAudioWithVoice({
      videoPath: rawVideoMp4,
      voicePath: fittedM4a,
      outputPath: mixedMp4,
      sourceVolume: 0.16,
      voiceVolume: 1.0,
      limiter: true,
      duck: true,
      separateAmbientInput: true
    });

    await ffmpeg.applyVideoDecoration({
      inputPath: mixedMp4,
      outputPath: decoratedMp4,
      width: 1080,
      height: 1920,
      blurBackgroundEnabled: true,
      preset: 'ultrafast',
      crf: 23,
      masterAudio: true
    });

    const qa = await runFinalQualityGate({
      mp4Path: decoratedMp4,
      minDurationSec: 5.7,
      maxDurationSec: 6.3,
      maxTailSilenceSec: 0.65
    });
    assert.equal(qa.technicalGate.status, 'PASS', `Expected Technical Gate PASS after closing settle + masterAudio limiter, got findings: ${JSON.stringify(qa.technicalGate.findings)}`);
    assert.equal(qa.technicalGate.checks.silence.tailSilences.length, 0, `Expected 0 tail silences >= 0.65s, got ${JSON.stringify(qa.technicalGate.checks.silence.tailSilences)}`);
    assert.equal(qa.technicalGate.checks.audioPeak.pass, true, `Expected post-AAC truePeakDb <= -0.2 dBFS, got ${qa.technicalGate.checks.audioPeak.truePeakDb} dBFS`);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Stage A (14): Resolves 3-way Catch-22 between NARRATED_BLOCK_ACTIVE_DIALOGUE, ENDING_NOT_IN_SCOPE, and OUTSIDE_SCOPE_REEL padding overhang', () => {
  const scope = {
    liveActionEndSec: 1275.02,
    scopeWindows: [
      { windowId: 'win_breach', startSec: 506, endSec: 641, purpose: 'core', purposes: ['core', 'hook_material'] },
      { windowId: 'win_station', startSec: 680, endSec: 750, purpose: 'core', purposes: ['core', 'ending_material'], purposeRanges: [{ purpose: 'ending_material', startSec: 680, endSec: 750 }] },
      { windowId: 'win_suspension', startSec: 881, endSec: 940, purpose: 'core', purposes: ['core', 'ending_material'], purposeRanges: [{ purpose: 'ending_material', startSec: 881, endSec: 940 }] }
    ],
    candidateEndingEvents: [
      { eventId: 'evt_dancer', sourceStartSec: 680, sourceEndSec: 750 },
      { eventId: 'evt_susp', sourceStartSec: 881, sourceEndSec: 940 }
    ]
  };
  const reel = {
    ranges: [
      { scopeWindowId: 'win_breach', sourceStartSec: 504, sourceEndSec: 643, windowStartSec: 506, windowEndSec: 641 },
      { scopeWindowId: 'win_station', sourceStartSec: 678, sourceEndSec: 752, windowStartSec: 680, windowEndSec: 750 },
      { scopeWindowId: 'win_suspension', sourceStartSec: 879, sourceEndSec: 942, windowStartSec: 881, windowEndSec: 940 }
    ]
  };

  // 14A: When preceding ending beats (b2, b3) deliver the raw payoff inside ending_material (680-750s, 881-940s),
  // a final CLOSING narrated_story beat over clean in-scope custody B-roll (615-621.5s) passes ENDING_NOT_IN_SCOPE.
  const callbackSpine = {
    beats: [
      { beatId: 'b1', sourceStartSec: 506.13, sourceEndSec: 516.13, narrativeRole: 'teaser_conflict', scopeMembership: 'hook', observedInFootage: 'Sergeant warns driver', whyNecessaryNow: 'hook' },
      { beatId: 'b2', sourceStartSec: 680.93, sourceEndSec: 685.28, narrativeRole: 'reveal', scopeMembership: 'ending', observedInFootage: 'Driver asks to hide dancer job', whyNecessaryNow: 'reveal' },
      { beatId: 'b3', sourceStartSec: 886.06, sourceEndSec: 892.85, narrativeRole: 'payoff', scopeMembership: 'ending', observedInFootage: 'Officer announces 12-month suspension', whyNecessaryNow: 'payoff' },
      { beatId: 'b4', sourceStartSec: 615.0, sourceEndSec: 621.5, chronologyMode: 'callback', narrativeRole: 'button', scopeMembership: 'ending', audioMode: 'voiceover_with_ambient', observedInFootage: 'Officer escorts handcuffed driver to patrol car', whyNecessaryNow: 'closing B-roll' }
    ],
    deliveryBlocks: [
      { blockId: 'blk_1', mode: 'raw_evidence', beatIds: ['b1', 'b2', 'b3'], evidenceFunction: 'CONSEQUENCE', footageFunction: 'CONSEQUENCE' },
      { blockId: 'blk_2', mode: 'narrated_story', beatIds: ['b4'], narratorFunction: 'CLOSING', sourceAudioTreatment: 'voiceover_with_ambient', narrationIntent: 'Closing takeaway' }
    ]
  };
  const callbackVal = Director.validateDirectorEdl(callbackSpine, scope, {
    durationSec: 1275.02,
    targetDurationMinSec: 20,
    targetDurationMaxSec: 40,
    reel,
    narrationEnabled: true,
    liveActionEndSec: 1275.02
  });
  assert.equal(callbackVal.valid, true, `Expected callback closing B-roll after in-scope ending beats to pass, got ${JSON.stringify(callbackVal.violations)}`);

  // 14B: When a closing beat (935.86-941.77s) overhangs its logical scope window (881-940s) into the watched +2s reel padding (879-942s),
  // technicalWindowPaddingAdjustment deterministically clamps it to 935.86-940.0s (4.14s) so it passes validation.
  const overhangSpine = {
    ...callbackSpine,
    beats: [
      ...callbackSpine.beats.slice(0, 3),
      { beatId: 'b4', sourceStartSec: 935.86, sourceEndSec: 941.77, chronologyMode: 'chronological', narrativeRole: 'resolution', scopeMembership: 'ending', audioMode: 'voiceover_with_ambient', observedInFootage: 'Driver receives citation paperwork at counter', whyNecessaryNow: 'closing' }
    ]
  };
  const padFix = Director.technicalWindowPaddingAdjustment(overhangSpine, reel, { durationSec: 1275.02, liveActionEndSec: 1275.02 });
  assert.equal(padFix.applied, true);
  assert.equal(padFix.spine.beats[3].sourceStartSec, 935.86);
  assert.equal(padFix.spine.beats[3].sourceEndSec, 940.0);
  const clampedVal = Director.validateDirectorEdl(padFix.spine, scope, {
    durationSec: 1275.02,
    targetDurationMinSec: 20,
    targetDurationMaxSec: 40,
    reel,
    narrationEnabled: true,
    liveActionEndSec: 1275.02
  });
  assert.equal(clampedVal.valid, true, `Expected clamped padding overhang spine to pass validation, got ${JSON.stringify(clampedVal.violations)}`);
});

test('Stage A (15): Climax Flashpoint Hook + Post-Hook Case-File Rewind Intro + Scene-Transition Bridge payload enrichment', () => {
  const BlockNarration = require('../electron/services/blockNarrationService');
  const Delivery = require('../electron/services/deliveryBlockService');
  const Scope = require('../electron/services/storyScopeService');

  assert.match(Scope.instruction, /IN-MEDIAS-RES CLIMAX \/ PEAK-ESCALATION FLASHPOINT HOOK/);
  assert.match(Director.instruction, /STRICT ANTI-PLAY-BY-PLAY RULE/);
  assert.match(BlockNarration.INSTRUCTION, /POST-HOOK CASE-FILE REWIND INTRO/);
  assert.match(BlockNarration.INSTRUCTION, /SCENE-TRANSITION BRIDGE/);

  const model = {
    events: [
      { id: 'evt_preview', startSec: 0, endSec: 11, type: 'teaser', summary: 'Teaser intro' },
      { id: 'evt_dashcam', startSec: 23, endSec: 68, type: 'traffic_stop', summary: 'Dashcam captures vehicle swerving across center line into gas station.' },
      { id: 'evt_approach', startSec: 68, endSec: 119, type: 'interrogation', summary: 'Officer approaches driver at Casey gas station.' },
      { id: 'evt_refusal', startSec: 227, endSec: 301, type: 'verbal_standoff', summary: 'Driver refuses lawful order to step out.' },
      { id: 'evt_warnings', startSec: 323, endSec: 415, type: 'verbal_standoff', summary: 'Officer warns window will be smashed.' },
      { id: 'evt_sergeant', startSec: 416, endSec: 510, type: 'negotiation', summary: 'Sergeant arrives and gives final warning.' },
      { id: 'evt_breach', startSec: 581, endSec: 606, type: 'physical_breach', summary: 'Officers shatter window and extract driver.' }
    ],
    quotes: [],
    facts: []
  };
  const storyScope = {
    scopeStartState: 'Officer Von Seem stops a swerving Jeep at Casey gas station at 2:22 AM.',
    allowedSupportingContext: [
      { description: 'Dashcam shows the Jeep swerving across the center line before the stop.', sourceStartSec: 23, sourceEndSec: 68, treatment: 'narration_only' }
    ]
  };
  const beats = [
    { beatId: 'b1', sourceStartSec: 581, sourceEndSec: 589, narrativeRole: 'teaser_conflict', observedInFootage: 'Baton shatters window' },
    { beatId: 'b2', sourceStartSec: 68, sourceEndSec: 74, narrativeRole: 'rewind_context', observedInFootage: 'Cruiser pulls into gas station' },
    { beatId: 'b3', sourceStartSec: 240, sourceEndSec: 297, narrativeRole: 'confrontation', observedInFootage: 'Driver says I do not have to' },
    { beatId: 'b4', sourceStartSec: 365, sourceEndSec: 372.5, narrativeRole: 'escalation', observedInFootage: 'Silent roadside B-roll' },
    { beatId: 'b5', sourceStartSec: 581, sourceEndSec: 600, narrativeRole: 'climax', observedInFootage: 'Officers extract driver' }
  ];
  const blocks = [
    { blockId: 'blk_hook', mode: 'raw_evidence', beatIds: ['b1'] },
    { blockId: 'blk_intro', mode: 'narrated_story', beatIds: ['b2'], narratorFunction: 'CONTEXT' },
    { blockId: 'blk_refusal', mode: 'raw_evidence', beatIds: ['b3'] },
    { blockId: 'blk_bridge', mode: 'narrated_story', beatIds: ['b4'], narratorFunction: 'CAUSAL_BRIDGE' },
    { blockId: 'blk_climax', mode: 'raw_evidence', beatIds: ['b5'] }
  ];
  const timeline = Delivery.blockTimeline(beats, blocks);

  // Post-hook CONTEXT block receives early inciting events (evt_dashcam) + scopeStartState + allowedSupportingContext
  const introPayload = BlockNarration.blockPayload(timeline, 1, model, 2.5, storyScope);
  assert.ok(introPayload.sourceContext.events.some(e => e.id === 'evt_dashcam'), 'Post-hook intro should include early inciting dashcam event');
  assert.ok(introPayload.sourceContext.facts.some(f => f.id === 'scope_start_state'), 'Post-hook intro should include scopeStartState fact');

  // Mid-story bridge block (297s -> 581s) receives omitted events in the gap (evt_warnings, evt_sergeant)
  const bridgePayload = BlockNarration.blockPayload(timeline, 3, model, 2.5, storyScope);
  assert.ok(bridgePayload.sourceContext.events.some(e => e.id === 'evt_warnings'), 'Mid-story bridge should include omitted evt_warnings in gap');
  assert.ok(bridgePayload.sourceContext.events.some(e => e.id === 'evt_sergeant'), 'Mid-story bridge should include omitted evt_sergeant in gap');
});

test('Stage A (16): Resolves NARRATED_BLOCK_ACTIVE_DIALOGUE <-> NARRATIVE_PLAN_INCONSISTENT ping-pong on post-hook rewind intro and 3.0s clean B-roll windows', () => {
  const cues = [
    { startSec: 227.0, endSec: 230.2, text: "Okay. All right, we'll look for this after you step out." },
    { startSec: 230.3, endSec: 233.5, text: 'I need you to step out of the vehicle right now for me.' },
    { startSec: 241.0, endSec: 247.5, text: 'Under Pennsylvania versus Mimms I can order you out of the car anytime.' }
  ];
  const scope = {
    liveActionEndSec: 1275.02,
    commentaryOpportunities: [
      { sourceStartSec: 227, sourceEndSec: 240, editorialAngle: 'Post-hook case setup' },
      { sourceStartSec: 500, sourceEndSec: 511, editorialAngle: 'Escalation bridge' },
      { sourceStartSec: 930, sourceEndSec: 940, editorialAngle: 'Closing takeaway' }
    ],
    candidateEndingEvents: [{ sourceStartSec: 881, sourceEndSec: 940 }]
  };
  const reel = {
    ranges: [
      { scopeWindowId: 'win_refusal', sourceStartSec: 227, sourceEndSec: 301, windowStartSec: 227, windowEndSec: 301 },
      { scopeWindowId: 'win_breach', sourceStartSec: 500, sourceEndSec: 641, windowStartSec: 500, windowEndSec: 641 },
      { scopeWindowId: 'win_end', sourceStartSec: 881, sourceEndSec: 940, windowStartSec: 881, windowEndSec: 940 }
    ]
  };
  const makeSpineWithBeat02 = (startSec, endSec) => ({
    openingStrategy: {
      chronologicalOption: 'Start at 227s',
      conflictTeaserOption: 'Open at 506s ultimatum',
      chosen: 'conflict_teaser_rewind'
    },
    narrativePlan: {
      plannedNarratedMoments: [
        { targetBlockId: 'blk_02', role: 'CONTEXT' },
        { targetBlockId: 'blk_04', role: 'CAUSAL_BRIDGE' },
        { targetBlockId: 'blk_06', role: 'CLOSING' }
      ]
    },
    beats: [
      { beatId: 'beat_01', sourceStartSec: 506.13, sourceEndSec: 514, chronologyMode: 'teaser', narrativeRole: 'teaser_conflict', scopeMembership: 'hook', observedInFootage: 'Sergeant warns window will be broken; driver dares him.', whyNecessaryNow: 'hook' },
      { beatId: 'beat_02', sourceStartSec: startSec, sourceEndSec: endSec, chronologyMode: 'rewind', narrativeRole: 'setup', scopeMembership: 'core', observedInFootage: 'Officer Von Seem standing at green Jeep window ordering the driver to step out.', whyNecessaryNow: 'rewind intro' },
      { beatId: 'beat_03', sourceStartSec: 241, sourceEndSec: 259, chronologyMode: 'chronological', narrativeRole: 'confrontation', scopeMembership: 'core', observedInFootage: 'Officer cites Pennsylvania v. Mimms', whyNecessaryNow: 'escalation' },
      { beatId: 'beat_04', sourceStartSec: 500, sourceEndSec: 506, chronologyMode: 'chronological', narrativeRole: 'escalation', scopeMembership: 'core', observedInFootage: 'Sergeant approaches driver side door', whyNecessaryNow: 'bridge' },
      { beatId: 'beat_05', sourceStartSec: 581, sourceEndSec: 598, chronologyMode: 'chronological', narrativeRole: 'climax', scopeMembership: 'core', observedInFootage: 'Officers shatter window and extract driver', whyNecessaryNow: 'climax' },
      { beatId: 'beat_06', sourceStartSec: 881, sourceEndSec: 895, chronologyMode: 'chronological', narrativeRole: 'payoff', scopeMembership: 'ending', observedInFootage: 'Officer announces 12-month suspension', whyNecessaryNow: 'payoff' },
      { beatId: 'beat_07', sourceStartSec: 931, sourceEndSec: 937, chronologyMode: 'chronological', narrativeRole: 'button', scopeMembership: 'ending', observedInFootage: 'Driver receives paperwork at station counter', whyNecessaryNow: 'closing' }
    ],
    deliveryBlocks: [
      { blockId: 'blk_01', mode: 'raw_evidence', beatIds: ['beat_01'], ownershipReason: 'Raw hook', evidenceFunction: 'CONFLICT', footageFunction: 'CONFLICT', viewerStateChanges: 1, blockSummary: 'Hook' },
      { blockId: 'blk_02', mode: 'narrated_story', beatIds: ['beat_02'], ownershipReason: 'Narrator rewind', narratorFunction: 'CONTEXT', sourceAudioTreatment: 'voiceover_with_ambient', narrationIntent: 'Case rewind intro', commentaryValue: 'Context', viewerKnows: 'Hook', viewerWantsToKnow: 'Why', viewerStateChanges: 1, blockSummary: 'Intro' },
      { blockId: 'blk_03', mode: 'raw_evidence', beatIds: ['beat_03'], ownershipReason: 'Raw refusal', evidenceFunction: 'CONFLICT', footageFunction: 'CONFLICT', viewerStateChanges: 1, blockSummary: 'Refusal' },
      { blockId: 'blk_04', mode: 'narrated_story', beatIds: ['beat_04'], ownershipReason: 'Narrator bridge', narratorFunction: 'CAUSAL_BRIDGE', sourceAudioTreatment: 'voiceover_with_ambient', narrationIntent: 'Escalation bridge', commentaryValue: 'Bridge', viewerKnows: 'Refusal', viewerWantsToKnow: 'Breach', viewerStateChanges: 1, blockSummary: 'Bridge' },
      { blockId: 'blk_05', mode: 'raw_evidence', beatIds: ['beat_05', 'beat_06'], ownershipReason: 'Raw climax and payoff', evidenceFunction: 'PAYOFF', footageFunction: 'PAYOFF', viewerStateChanges: 2, blockSummary: 'Breach and payoff' },
      { blockId: 'blk_06', mode: 'narrated_story', beatIds: ['beat_07'], ownershipReason: 'Narrator closing', narratorFunction: 'CLOSING', sourceAudioTreatment: 'voiceover_with_ambient', narrationIntent: 'Closing takeaway', commentaryValue: 'Closing', viewerKnows: 'Suspended', viewerWantsToKnow: 'Worth it?', viewerStateChanges: 1, blockSummary: 'Closing' }
    ],
    transitionChecks: [
      { fromBlockId: 'blk_01', toBlockId: 'blk_02', coldViewerUnderstandsWhy: true, howTheViewerKnows: 'Rewind intro' },
      { fromBlockId: 'blk_02', toBlockId: 'blk_03', coldViewerUnderstandsWhy: true, howTheViewerKnows: 'Handoff to officer' },
      { fromBlockId: 'blk_03', toBlockId: 'blk_04', coldViewerUnderstandsWhy: true, howTheViewerKnows: 'Bridge to sergeant' },
      { fromBlockId: 'blk_04', toBlockId: 'blk_05', coldViewerUnderstandsWhy: true, howTheViewerKnows: 'Handoff to breach' },
      { fromBlockId: 'blk_05', toBlockId: 'blk_06', coldViewerUnderstandsWhy: true, howTheViewerKnows: 'Closing synthesis' }
    ]
  });

  // 16A: Attempt 0 spine with beat_02 at 227-233s (6.0s rewind setup over ducked procedural chatter) passes cleanly
  const attempt0Res = Director.validateDirectorEdl(makeSpineWithBeat02(227, 233), scope, {
    durationSec: 1275.02,
    targetDurationMinSec: 60,
    targetDurationMaxSec: 90,
    reel,
    narrationEnabled: true,
    requireDeliveryBlocks: true,
    cues,
    liveActionEndSec: 1275.02
  });
  assert.equal(attempt0Res.valid, true, `Expected Attempt 0 (227-233s) to pass, got ${JSON.stringify(attempt0Res.violations)}`);

  // 16B: Attempt 1 (fix1) spine with beat_02 at 237.97-240.97s (3.0s clean B-roll window) ALSO passes cleanly
  const attempt1Res = Director.validateDirectorEdl(makeSpineWithBeat02(237.97, 240.97), scope, {
    durationSec: 1275.02,
    targetDurationMinSec: 60,
    targetDurationMaxSec: 90,
    reel,
    narrationEnabled: true,
    requireDeliveryBlocks: true,
    cues,
    liveActionEndSec: 1275.02
  });
  assert.equal(attempt1Res.valid, true, `Expected Attempt 1 (237.97-240.97s, 3.0s) to pass, got ${JSON.stringify(attempt1Res.violations)}`);
});

test('Stage A (17): Universal Option B 2-Beat Smash-Cut Cold-Open Hook, StoryScope mustWithhold sanitation, and NarrationGate scope_start_state grounding', () => {
  const StoryScope = require('../electron/services/storyScopeService.js');
  const NarrationGate = require('../electron/services/narrationGate.js');

  // 17A: validateStoryScope strips anti-viral mustWithhold entries ("window-shattering moment during the cold open")
  // and ensures the physical climax window carries 'hook_material'
  const rawScope = {
    accessGranted: true,
    storyScopeId: 'scope_standoff_to_station_reckoning',
    whyThisIsOneStory: 'Full arc from refusal to breach to station suspension',
    scopeEndTarget: 'payoff',
    explicitScopeBoundary: { startSec: 227, endSec: 940 },
    centralConflict: 'Driver refuses lawful order to exit vehicle',
    centralViewerQuestion: 'Will officers breach the window and what charges follow?',
    storyStartState: 'Traffic stop on highway for reckless driving',
    causalSpine: [
      { role: 'initial_refusal', eventId: 'evt_05', sourceStartSec: 227, sourceEndSec: 301, summary: 'Driver refuses exit order', causalLinkToNext: 'Supervisor called' },
      { role: 'final_warning_ultimatum', eventId: 'evt_10', sourceStartSec: 506, sourceEndSec: 547, summary: 'Sergeant warns window will be broken; driver says Let us do it', causalLinkToNext: 'Breach' },
      { role: 'physical_climax', eventId: 'evt_11', sourceStartSec: 581, sourceEndSec: 606, summary: 'Officers shatter window and extract driver', causalLinkToNext: 'Station' }
    ],
    candidateEndingEvents: [
      { eventId: 'evt_16', sourceStartSec: 881, sourceEndSec: 940, endingRole: 'payoff', whyValidEnding: '12-month license suspension' }
    ],
    scopeWindows: [
      { windowId: 'win_refusal', startSec: 227, endSec: 301, purposes: ['core'], reason: 'Refusal' },
      { windowId: 'win_breach', startSec: 500, endSec: 641, purposes: ['core'], reason: 'Warning and window breach' },
      { windowId: 'win_station', startSec: 881, endSec: 940, purposes: ['ending_material'], reason: 'Suspension' }
    ],
    hookCandidates: [
      { hookId: 'hook_dare', sourceStartSec: 511.8, sourceEndSec: 514.2, hookType: 'defiant_dare_trigger', whyCuriosity: 'Let us do it dare' },
      { hookId: 'hook_breach', sourceStartSec: 581.5, sourceEndSec: 585.5, hookType: 'kinetic_climax_flashpoint', whyCuriosity: 'Glass shatters' }
    ],
    mustInclude: ['evt_05', 'evt_10', 'evt_11', 'evt_16'],
    mustWithhold: [
      'The window-shattering moment during the cold open',
      'The 12-month license suspension revealed at the station'
    ],
    excludedOutOfScopeRanges: []
  };
  const scopeValidation = StoryScope.validateStoryScope(rawScope, { durationSec: 1275.02, liveActionEndSec: 1275.02 });
  assert.equal(scopeValidation.valid, true, `Expected scope to validate cleanly, got ${JSON.stringify(scopeValidation.violations)}`);
  assert.deepEqual(scopeValidation.normalizedScope.mustWithhold, ['The 12-month license suspension revealed at the station']);
  const breachWin = scopeValidation.normalizedScope.scopeWindows.find(w => w.windowId === 'win_breach');
  assert.ok(breachWin.purposes.includes('hook_material'), 'Climax window must automatically include hook_material purpose');

  // 17B: NarrationGate accepts scope_start_state and scope_support_1 in newInformationRefs
  const gateRes = NarrationGate.inspect(
    [{
      beatId: 'blk_02',
      sourceStartSec: 237.97,
      sourceEndSec: 243.5,
      speaks: true,
      narratorText: 'Earlier that afternoon, troopers pulled over a Jeep after clocking it at 87 in a 55 zone.',
      narratorFunction: 'CONTEXT',
      newInformation: ['Pulled over for 87 in a 55 zone'],
      newInformationRefs: ['scope_start_state', 'scope_support_1']
    }],
    { events: [{ id: 'evt_05', startSec: 227, endSec: 301, summary: 'Refusal' }], quotes: [] }
  );
  assert.ok(!gateRes.issues.some(i => i.code === 'ungrounded'), `Expected scope_start_state to be accepted as grounded, got ${JSON.stringify(gateRes.issues)}`);

  // 17C: validateDirectorEdl flags HOOK_MISSING_CLIMAX_FLASHPOINT and HOOK_HAS_DEAD_AIR_PREAMBLE on a sluggish 1-beat 506.13-514s hook,
  // and passes cleanly on the universal Option B 2-Beat Smash-Cut Hook (beat_01: 511.8-514.2s Dare + beat_02: 581.5-585.5s Breach)
  const hookCues = [
    { startSec: 504.4, endSec: 509.28, text: "that and it's a lawful order." },
    { startSec: 512.0, endSec: 513.52, text: "Your window's going to end up getting broken. Let's do it." },
    { startSec: 581.0, endSec: 584.5, text: 'Watch your eyes. Here we go!' }
  ];
  const reel = {
    ranges: [
      { scopeWindowId: 'win_refusal', sourceStartSec: 227, sourceEndSec: 301, windowStartSec: 227, windowEndSec: 301 },
      { scopeWindowId: 'win_breach', sourceStartSec: 500, sourceEndSec: 641, windowStartSec: 500, windowEndSec: 641 },
      { scopeWindowId: 'win_station', sourceStartSec: 881, sourceEndSec: 940, windowStartSec: 881, windowEndSec: 940 }
    ]
  };
  const sluggishSpine = {
    openingStrategy: {
      chronologicalOption: 'Start at 227s',
      conflictTeaserOption: 'Smash-cut dare + breach',
      chosen: 'conflict_teaser_rewind'
    },
    beats: [
      { beatId: 'beat_01', sourceStartSec: 506.13, sourceEndSec: 514.0, chronologyMode: 'teaser', narrativeRole: 'teaser_conflict', scopeMembership: 'hook', observedInFootage: 'Sergeant warns window will be broken; driver dares him.', whyNecessaryNow: 'hook' },
      { beatId: 'beat_02', sourceStartSec: 235.0, sourceEndSec: 241.0, chronologyMode: 'rewind', narrativeRole: 'setup', scopeMembership: 'core', observedInFootage: 'Officer stands by Jeep window.', whyNecessaryNow: 'rewind intro' },
      { beatId: 'beat_03', sourceStartSec: 241.0, sourceEndSec: 261.0, chronologyMode: 'chronological', narrativeRole: 'confrontation', scopeMembership: 'core', observedInFootage: 'Officer cites Pennsylvania v. Mimms', whyNecessaryNow: 'escalation' },
      { beatId: 'beat_04', sourceStartSec: 581.0, sourceEndSec: 601.0, chronologyMode: 'chronological', narrativeRole: 'climax', scopeMembership: 'core', observedInFootage: 'Officers shatter window and extract driver', whyNecessaryNow: 'climax' },
      { beatId: 'beat_05', sourceStartSec: 881.0, sourceEndSec: 901.0, chronologyMode: 'chronological', narrativeRole: 'payoff', scopeMembership: 'ending', observedInFootage: 'Officer announces 12-month suspension', whyNecessaryNow: 'payoff' }
    ],
    deliveryBlocks: [
      { blockId: 'blk_01', mode: 'raw_evidence', beatIds: ['beat_01'], ownershipReason: 'Raw hook', evidenceFunction: 'CONFLICT', footageFunction: 'CONFLICT', viewerStateChanges: 1, blockSummary: 'Hook' },
      { blockId: 'blk_02', mode: 'narrated_story', beatIds: ['beat_02'], ownershipReason: 'Narrator rewind', narratorFunction: 'CONTEXT', sourceAudioTreatment: 'voiceover_with_ambient', narrationIntent: 'Case rewind intro', commentaryValue: 'Context', viewerKnows: 'Hook', viewerWantsToKnow: 'Why', viewerStateChanges: 1, blockSummary: 'Intro' },
      { blockId: 'blk_03', mode: 'raw_evidence', beatIds: ['beat_03', 'beat_04', 'beat_05'], ownershipReason: 'Raw story', evidenceFunction: 'PAYOFF', footageFunction: 'PAYOFF', viewerStateChanges: 2, blockSummary: 'Story' }
    ],
    transitionChecks: [
      { fromBlockId: 'blk_01', toBlockId: 'blk_02', coldViewerUnderstandsWhy: true, howTheViewerKnows: 'Rewind intro' },
      { fromBlockId: 'blk_02', toBlockId: 'blk_03', coldViewerUnderstandsWhy: true, howTheViewerKnows: 'Handoff' }
    ]
  };
  const sluggishRes = Director.validateDirectorEdl(sluggishSpine, rawScope, {
    durationSec: 1275.02,
    targetDurationMinSec: 50,
    targetDurationMaxSec: 90,
    reel,
    narrationEnabled: true,
    requireDeliveryBlocks: true,
    cues: hookCues,
    liveActionEndSec: 1275.02
  });
  assert.equal(sluggishRes.valid, false);
  const vCodes = sluggishRes.violations.map(v => v.code);
  assert.ok(vCodes.includes('HOOK_MISSING_CLIMAX_FLASHPOINT'), `Expected HOOK_MISSING_CLIMAX_FLASHPOINT in ${vCodes.join(', ')}`);
  assert.ok(vCodes.includes('HOOK_HAS_DEAD_AIR_PREAMBLE'), `Expected HOOK_HAS_DEAD_AIR_PREAMBLE in ${vCodes.join(', ')}`);

  // Option B 2-Beat Smash-Cut Hook (beat_01: 511.8-514.2s Dare + beat_02: 581.5-585.5s Breach Peak, Split-Climax Continuation at 585.0-601.0s)
  const smashCutSpine = {
    ...sluggishSpine,
    beats: [
      { beatId: 'beat_01', sourceStartSec: 511.8, sourceEndSec: 514.2, chronologyMode: 'teaser', narrativeRole: 'teaser_conflict', scopeMembership: 'hook', observedInFootage: 'Sergeant warns window will be broken; driver dares Let us do it.', whyNecessaryNow: 'verbal dare trigger' },
      { beatId: 'beat_02', sourceStartSec: 581.5, sourceEndSec: 585.5, chronologyMode: 'teaser', narrativeRole: 'cold_open_hook', scopeMembership: 'hook', observedInFootage: 'Sergeant strikes window with tool and glass shatters explosively.', whyNecessaryNow: 'climax flashpoint impact' },
      { beatId: 'beat_03', sourceStartSec: 235.0, sourceEndSec: 241.0, chronologyMode: 'rewind', narrativeRole: 'setup', scopeMembership: 'core', observedInFootage: 'Officer stands by Jeep window.', whyNecessaryNow: 'rewind intro' },
      { beatId: 'beat_04', sourceStartSec: 241.0, sourceEndSec: 261.0, chronologyMode: 'chronological', narrativeRole: 'confrontation', scopeMembership: 'core', observedInFootage: 'Officer cites Pennsylvania v. Mimms', whyNecessaryNow: 'escalation' },
      { beatId: 'beat_05', sourceStartSec: 585.0, sourceEndSec: 601.0, chronologyMode: 'chronological', narrativeRole: 'climax', scopeMembership: 'core', observedInFootage: 'Officers clear shattered glass, unlock door, and pull driver out', whyNecessaryNow: 'split-climax continuation' },
      { beatId: 'beat_06', sourceStartSec: 881.0, sourceEndSec: 901.0, chronologyMode: 'chronological', narrativeRole: 'payoff', scopeMembership: 'ending', observedInFootage: 'Officer announces 12-month suspension', whyNecessaryNow: 'payoff' }
    ],
    deliveryBlocks: [
      { blockId: 'blk_01', mode: 'raw_evidence', beatIds: ['beat_01', 'beat_02'], ownershipReason: '2-beat smash-cut cold open', evidenceFunction: 'CONFLICT', footageFunction: 'CONFLICT', viewerStateChanges: 2, blockSummary: 'Dare + glass shatter smash-cut hook' },
      { blockId: 'blk_02', mode: 'narrated_story', beatIds: ['beat_03'], ownershipReason: 'Narrator rewind', narratorFunction: 'CONTEXT', sourceAudioTreatment: 'voiceover_with_ambient', narrationIntent: 'Case rewind intro', commentaryValue: 'Context', viewerKnows: 'Hook', viewerWantsToKnow: 'Why', viewerStateChanges: 1, blockSummary: 'Intro' },
      { blockId: 'blk_03', mode: 'raw_evidence', beatIds: ['beat_04', 'beat_05', 'beat_06'], ownershipReason: 'Raw story', evidenceFunction: 'PAYOFF', footageFunction: 'PAYOFF', viewerStateChanges: 2, blockSummary: 'Story' }
    ]
  };
  const smashCutRes = Director.validateDirectorEdl(smashCutSpine, rawScope, {
    durationSec: 1275.02,
    targetDurationMinSec: 50,
    targetDurationMaxSec: 90,
    reel,
    narrationEnabled: true,
    narrationEnabled: true,
    requireDeliveryBlocks: true,
    cues: hookCues,
    liveActionEndSec: 1275.02
  });
  assert.equal(smashCutRes.valid, true, `Expected Option B 2-Beat Smash-Cut Hook to pass cleanly, got ${JSON.stringify(smashCutRes.violations)}`);
});

test('Stage A (18): MAX_TOKENS prevention, oversized repetition loop guard, compact single-candidate recovery, and graphics-screen outro boundary detection', async () => {
  const StoryScope = require('../electron/services/storyScopeService.js');
  const BlockNarration = require('../electron/services/blockNarrationService.js');
  const ScopeCritic = require('../electron/services/scopeMediaCriticService.js');
  const BoundaryService = require('../electron/services/sourceEndingBoundaryService.js');

  // 18A: Explicit generation limits exported across services
  assert.deepEqual(StoryScope.SCOPE_GENERATION, { maxOutputTokens: 16384, thinkingBudget: 0 });
  assert.deepEqual(BlockNarration.NARRATION_GENERATION, { maxOutputTokens: 8192, thinkingBudget: 0 });
  assert.equal(ScopeCritic.CRITIC_MAX_OUTPUT_TOKENS, 8192);
  assert.equal(ScopeCritic.CRITIC_THINKING_BUDGET, 0);

  // 18B: validateSelectionShape rejects degenerate token-repetition strings (> 1500 chars) like windowId digit loops
  const repeatedWindowId = `win_teaser_screaming_hookPartA${'8392102148'.repeat(180)}`;
  assert.throws(
    () => StoryScope.validateSelectionShape({
      chosenStoryScopeId: 'scope_01',
      selectionReasoning: 'ok',
      candidates: [{ storyScopeId: 'scope_01', scopeWindows: [{ windowId: repeatedWindowId }] }]
    }),
    /degenerate oversized text.*windowId/i
  );

  // 18C: selectStoryScope passes SCOPE_GENERATION and automatically recovers via v5-story-scope_compact on MAX_TOKENS
  const askCalls = [];
  const validScopeCandidate = {
    accessGranted: true,
    storyScopeId: 'scope_01',
    whyThisIsOneStory: 'Single coherent arrest escalation arc from refusal to jail transport.',
    scopeEndTarget: 'payoff',
    explicitScopeBoundary: { startSec: 25, endSec: 810 },
    centralConflict: 'Suspect refuses dispersal order and kicks deputy during arrest.',
    centralViewerQuestion: 'What happens after the suspect kicks a deputy in the chest?',
    storyStartState: 'Deputies respond to a 3:55 AM disturbance outside a bar.',
    causalSpine: [
      { role: 'inciting_incident', eventId: 'evt_1', sourceStartSec: 25, sourceEndSec: 70, summary: 'Deputies order group to disperse.', causalLinkToNext: 'Refusal' },
      { role: 'physical_climax', eventId: 'evt_2', sourceStartSec: 170, sourceEndSec: 215, summary: 'Suspect kicks deputy and is carried to cruiser.', causalLinkToNext: 'Booking' },
      { role: 'payoff', eventId: 'evt_3', sourceStartSec: 750, sourceEndSec: 805, summary: 'Suspect booked into jail on felony battery charges.', causalLinkToNext: 'End' }
    ],
    candidateEndingEvents: [
      { eventId: 'evt_3', sourceStartSec: 750, sourceEndSec: 805, endingRole: 'payoff', whyValidEnding: 'Completed jail booking consequence.' }
    ],
    scopeWindows: [
      { windowId: 'win_01', startSec: 25, endSec: 70, purposes: ['core'], reason: 'Initial dispersal order.' },
      { windowId: 'win_02', startSec: 165, endSec: 220, purposes: ['hook_material', 'core'], reason: 'Physical struggle and kick.' },
      { windowId: 'win_03', startSec: 745, endSec: 808, purposes: ['ending_material'], reason: 'Jail booking consequence.' }
    ],
    hookCandidates: [
      { hookId: 'hook_01', sourceStartSec: 170, sourceEndSec: 174, hookType: 'kinetic_climax_flashpoint', whyCuriosity: 'Suspect kicks deputy during struggle.' }
    ],
    mustInclude: ['evt_1', 'evt_2', 'evt_3'],
    mustWithhold: ['Felony battery on a law enforcement officer charge at booking'],
    excludedOutOfScopeRanges: []
  };

  const mockEngine = {
    duration: 906.84,
    config: { targetDurationMinSec: 65, targetDurationMaxSec: 90, maxScopeReelSec: 210 },
    async ask(name, input, schema, instr, files, check, task, options) {
      askCalls.push({ name, instr, options });
      if (name === 'v5-story-scope') {
        throw new Error('Vertex AI đã chạm giới hạn sinh nội dung (MAX_TOKENS — giới hạn mặc định của model; Auto Story không đặt trần token riêng).');
      }
      const res = {
        chosenStoryScopeId: 'scope_01',
        selectionReasoning: 'Strongest single-conflict arc with clear felony consequence.',
        candidates: [validScopeCandidate]
      };
      return check ? check(res) : res;
    }
  };
  const mockModel = {
    durationSec: 906.84,
    events: [
      { id: 'evt_1', startSec: 25, endSec: 70, type: 'confrontation', summary: 'Deputies order group to disperse.' },
      { id: 'evt_2', startSec: 170, endSec: 215, type: 'physical_climax', summary: 'Suspect kicks deputy and is carried to cruiser.' },
      { id: 'evt_3', startSec: 750, endSec: 805, type: 'payoff', summary: 'Suspect booked into jail.' }
    ],
    quotes: []
  };

  const scopeOut = await StoryScope.selectStoryScope(mockEngine, mockModel, { liveActionEndSec: 810.8 });
  assert.equal(askCalls.length, 2, 'Expected initial call + 1 compact anti-repetition recovery call');
  assert.equal(askCalls[0].name, 'v5-story-scope');
  assert.deepEqual(askCalls[0].options, { maxOutputTokens: 16384, thinkingBudget: 0 });
  assert.equal(askCalls[1].name, 'v5-story-scope_compact');
  assert.deepEqual(askCalls[1].options, { maxOutputTokens: 16384, thinkingBudget: 0, noCache: true, temperature: 0.25 });
  assert.match(askCalls[1].instr, /COMPACT ANTI-REPETITION RECOVERY/);
  assert.equal(scopeOut.scope.storyScopeId, 'scope_01');

  // 18D: CritiqueScopedRender retries with compact mode on MAX_TOKENS
  let criticCalls = 0;
  const criticRes = await ScopeCritic.critiqueScopedRender(
    {
      centralViewerQuestion: 'What happens next?',
      hookPromise: 'Arrest escalation',
      beats: [{ beatId: 'beat_01', sourceStartSec: 10, sourceEndSec: 20, narrativeRole: 'hook' }],
      deliveryBlocks: [{ blockId: 'blk_01', mode: 'raw_evidence', beatIds: ['beat_01'] }]
    },
    {
      mp4Path: 'dummy.mp4',
      actualMp4DurationSec: 10,
      aiService: {
        async generateJsonFromFiles(args) {
          criticCalls += 1;
          if (criticCalls === 1) {
            assert.equal(args.maxOutputTokens, 8192);
            assert.equal(args.thinkingBudget, 0);
            throw new Error('Vertex AI đã chạm giới hạn sinh nội dung (MAX_TOKENS)');
          }
          assert.equal(args.maxOutputTokens, 12288);
          assert.equal(args.temperature, 0.25);
          return {
            accessGranted: true,
            isCompliant: true,
            scopeSurvived: true,
            centralQuestionActiveThroughout: true,
            endingIsConsequenceOfCentralConflict: true,
            finalFootageUsable: true,
            finalSeconds: { subjectClearlyVisible: true, endsAtCompleteBoundary: true, lastWordsHeard: 'Okay.', visualDescription: 'Deputy closes cruiser door.' },
            openingCuriosity: { createsCuriosity: true },
            transitions: [],
            openingEarnsRetention: true,
            storyCoherent: true,
            payoffFulfillsOpeningPromise: true,
            coldViewerCanFollow: true,
            observedStory: 'Clear progression.',
            summary: 'Clean render.',
            issues: [],
            weakRegions: []
          };
        }
      }
    }
  );
  assert.equal(criticCalls, 2);
  assert.equal(criticRes.status, 'SCOPED_MEDIA_CRITIC_OK');
  assert.equal(criticRes.isCompliant, true);

  // 18E: sourceEndingBoundaryService detects trailing Graphics Screen / external_narrator charges_reveal outro (like J5zy6yVUSEg at 811s)
  const boundary = await BoundaryService.detectSourceEndingBoundary({
    sourcePath: '',
    durationSec: 906.84,
    skipMediaProbe: true,
    sceneManifest: {
      scenes: [
        { startSec: 745.0, endSec: 811.0 },
        { startSec: 811.0, endSec: 906.84 }
      ]
    },
    model: {
      events: [
        { id: 'evt_booking', startSec: 745, endSec: 811, type: 'booking', location: 'County Jail', audioType: 'dialogue', summary: 'Officers escort suspect into jail.' },
        { id: 'evt_jail_battery_charges', startSec: 811, endSec: 834, type: 'charges_reveal', location: 'Graphics Screen', audioType: 'external_narrator', summary: 'Narrator reveals charges and bond on graphics screen.' }
      ]
    }
  });
  assert.equal(boundary.hasOutro, true);
  assert.equal(boundary.outroStartSec, 811);
  assert.equal(boundary.liveActionEndSec, 810.8);
});

test('Stage A (19): Editorial Director resolves raw-wall repair without false NARRATIVE_PLAN_INCONSISTENT, HIGH_VALUE_QUOTE_LOST_IN_REPAIR, or -1.45s TOTAL_DURATION_UNDER_MIN failure', () => {
  // 19A: When commentaryOpportunities >= 3 (minForCommentaryLed = 3) and EDL already has 3 narrated_story blocks,
  // listing 4 items in plannedNarratedMoments does NOT trigger NARRATIVE_PLAN_INCONSISTENT.
  const scopeWith3Ops = {
    liveActionEndSec: 810,
    commentaryOpportunities: [
      { sourceStartSec: 36, sourceEndSec: 46, editorialAngle: 'Rewind setup' },
      { sourceStartSec: 120, sourceEndSec: 130, editorialAngle: 'Escalation bridge' },
      { sourceStartSec: 309, sourceEndSec: 315, editorialAngle: 'Mid-story bridge' },
      { sourceStartSec: 800, sourceEndSec: 808, editorialAngle: 'Closing takeaway' }
    ]
  };
  const edlWith3Narrated4Planned = {
    narrativePlan: {
      plannedNarratedMoments: [
        { targetBlockId: 'blk_02', role: 'CONTEXT' },
        { targetBlockId: 'blk_04', role: 'CAUSAL_BRIDGE' },
        { targetBlockId: 'blk_06', role: 'ESCALATION_FRAMING' },
        { targetBlockId: 'blk_08', role: 'CLOSING' }
      ]
    },
    deliveryBlocks: [
      { blockId: 'blk_01', mode: 'raw_evidence', beatIds: ['b1'] },
      { blockId: 'blk_02', mode: 'narrated_story', beatIds: ['b2'], narratorFunction: 'CONTEXT' },
      { blockId: 'blk_03', mode: 'raw_evidence', beatIds: ['b3'] },
      { blockId: 'blk_04', mode: 'narrated_story', beatIds: ['b4'], narratorFunction: 'CAUSAL_BRIDGE' },
      { blockId: 'blk_05', mode: 'raw_evidence', beatIds: ['b5'] },
      { blockId: 'blk_08', mode: 'narrated_story', beatIds: ['b6'], narratorFunction: 'CLOSING' }
    ]
  };
  const planBeats = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((beatId, i) => ({ beatId, sourceStartSec: 40 + i * 20, sourceEndSec: 50 + i * 20 }));
  const planViolations = Director.narrativePlanViolations(edlWith3Narrated4Planned, planBeats, scopeWith3Ops, { narrationEnabled: true });
  assert.equal(planViolations.length, 0, `Expected 0 narrativePlanViolations when 3 narrated blocks satisfy minForCommentaryLed=3, got ${JSON.stringify(planViolations)}`);

  // 19B: When repairing UNINTERRUPTED_RAW_WALL replaces 2 secondary officer warnings (q08, q09) with a narrated bridge
  // while preserving 6 core raw quotes (including hook and climax quotes), punchlinePreservationViolations returns 0 violations.
  const modelWithAllHighQuotes = {
    quotes: [
      { id: 'q03', startSec: 168.4, endSec: 171.75, text: 'Stop pulling away from me!', editorialValue: 0.85, spokenWordCount: 5 },
      { id: 'q04', startSec: 190.87, endSec: 195.8, text: 'Get in the car right now!', editorialValue: 0.9, spokenWordCount: 6 },
      { id: 'q05', startSec: 53.05, endSec: 57.6, text: 'We are not giving you the keys.', editorialValue: 0.85, spokenWordCount: 7 },
      { id: 'q06', startSec: 108.56, endSec: 112.9, text: 'You need to leave the property now.', editorialValue: 0.8, spokenWordCount: 7 },
      { id: 'q07', startSec: 256.8, endSec: 266.0, text: 'Wait until I get out of these cuffs.', editorialValue: 0.9, spokenWordCount: 8 },
      { id: 'q08', startSec: 299.16, endSec: 303.5, text: 'Stop kicking the door right now.', editorialValue: 0.8, spokenWordCount: 6 },
      { id: 'q09', startSec: 366.16, endSec: 371.27, text: 'Put your seatbelt on or stay back.', editorialValue: 0.8, spokenWordCount: 7 },
      { id: 'q10', startSec: 405.84, endSec: 416.0, text: 'Look what you did to my leg!', editorialValue: 0.9, spokenWordCount: 7 }
    ]
  };
  const attempt0Edl = {
    beats: [
      { beatId: 'beat_01', sourceStartSec: 168.4, sourceEndSec: 171.75 },
      { beatId: 'beat_02', sourceStartSec: 190.87, sourceEndSec: 195.8 },
      { beatId: 'beat_03', sourceStartSec: 36.0, sourceEndSec: 42.0 },
      { beatId: 'beat_04', sourceStartSec: 53.05, sourceEndSec: 57.6 },
      { beatId: 'beat_05', sourceStartSec: 108.56, sourceEndSec: 112.9 },
      { beatId: 'beat_06', sourceStartSec: 120.0, sourceEndSec: 126.0 },
      { beatId: 'beat_07', sourceStartSec: 256.8, sourceEndSec: 266.0 },
      { beatId: 'beat_08', sourceStartSec: 299.16, sourceEndSec: 303.5 },
      { beatId: 'beat_09', sourceStartSec: 366.16, sourceEndSec: 371.27 },
      { beatId: 'beat_10', sourceStartSec: 405.84, sourceEndSec: 416.0 },
      { beatId: 'beat_11', sourceStartSec: 800.0, sourceEndSec: 806.0 }
    ],
    deliveryBlocks: [
      { blockId: 'blk_01', mode: 'raw_evidence', beatIds: ['beat_01', 'beat_02'] },
      { blockId: 'blk_02', mode: 'narrated_story', beatIds: ['beat_03'] },
      { blockId: 'blk_03', mode: 'raw_evidence', beatIds: ['beat_04', 'beat_05'] },
      { blockId: 'blk_04', mode: 'narrated_story', beatIds: ['beat_06'] },
      { blockId: 'blk_05', mode: 'raw_evidence', beatIds: ['beat_07', 'beat_08', 'beat_09', 'beat_10'] },
      { blockId: 'blk_06', mode: 'narrated_story', beatIds: ['beat_11'] }
    ]
  };
  const attempt1Edl = {
    beats: [
      { beatId: 'beat_01', sourceStartSec: 168.4, sourceEndSec: 171.75 },
      { beatId: 'beat_02', sourceStartSec: 190.87, sourceEndSec: 195.8 },
      { beatId: 'beat_03', sourceStartSec: 36.0, sourceEndSec: 42.0 },
      { beatId: 'beat_04', sourceStartSec: 53.05, sourceEndSec: 57.6 },
      { beatId: 'beat_05', sourceStartSec: 108.56, sourceEndSec: 112.9 },
      { beatId: 'beat_06', sourceStartSec: 120.0, sourceEndSec: 126.0 },
      { beatId: 'beat_07', sourceStartSec: 256.8, sourceEndSec: 266.0 },
      { beatId: 'beat_08', sourceStartSec: 309.0, sourceEndSec: 315.0 },
      { beatId: 'beat_09', sourceStartSec: 405.84, sourceEndSec: 416.0 },
      { beatId: 'beat_10', sourceStartSec: 800.0, sourceEndSec: 806.0 }
    ],
    deliveryBlocks: [
      { blockId: 'blk_01', mode: 'raw_evidence', beatIds: ['beat_01', 'beat_02'] },
      { blockId: 'blk_02', mode: 'narrated_story', beatIds: ['beat_03'] },
      { blockId: 'blk_03', mode: 'raw_evidence', beatIds: ['beat_04', 'beat_05'] },
      { blockId: 'blk_04', mode: 'narrated_story', beatIds: ['beat_06'] },
      { blockId: 'blk_05', mode: 'raw_evidence', beatIds: ['beat_07'] },
      { blockId: 'blk_06', mode: 'narrated_story', beatIds: ['beat_08'] },
      { blockId: 'blk_07', mode: 'raw_evidence', beatIds: ['beat_09'] },
      { blockId: 'blk_08', mode: 'narrated_story', beatIds: ['beat_10'] }
    ]
  };
  const punchlineViolations = Director.punchlinePreservationViolations(
    attempt0Edl,
    attempt1Edl,
    modelWithAllHighQuotes,
    { priorViolations: [{ code: 'UNINTERRUPTED_RAW_WALL' }, { code: 'NARRATIVE_PLAN_INCONSISTENT' }] }
  );
  assert.equal(punchlineViolations.length, 0, `Expected 0 punchline violations when breaking up UNINTERRUPTED_RAW_WALL while keeping 6/8 quotes, got ${JSON.stringify(punchlineViolations)}`);
  // An explicit quote array (ownership-map contract) still protects every listed quote
  const strictViolations = Director.punchlinePreservationViolations(attempt0Edl, attempt1Edl, modelWithAllHighQuotes.quotes);
  assert.deepEqual(strictViolations.map(v => v.quoteId).sort(), ['q08', 'q09']);

  // 19C: Post-structural-repair technicalDurationAdjustment (maxDeficitSec = 3.0) reconciles a 63.55s timeline (-1.45s below 65.0s)
  // to 65.0s inside watched scope windows, while default maxDeficitSec (1.0s) leaves it untouched.
  const reel = {
    ranges: [
      { scopeWindowId: 'win_01', sourceStartSec: 30, sourceEndSec: 120, windowStartSec: 30, windowEndSec: 120 },
      { scopeWindowId: 'win_02', sourceStartSec: 165, sourceEndSec: 225, windowStartSec: 165, windowEndSec: 225 },
      { scopeWindowId: 'win_06', sourceStartSec: 745, sourceEndSec: 810, windowStartSec: 745, windowEndSec: 810 }
    ]
  };
  const underMin63p55Spine = {
    beats: [
      { beatId: 'beat_01', sourceStartSec: 168.4, sourceEndSec: 171.75 }, // 3.35s
      { beatId: 'beat_02', sourceStartSec: 190.87, sourceEndSec: 195.8 }, // 4.93s
      { beatId: 'beat_03', sourceStartSec: 36.0, sourceEndSec: 66.0 },    // 30.00s
      { beatId: 'beat_04', sourceStartSec: 750.0, sourceEndSec: 770.0 },  // 20.00s
      { beatId: 'beat_05', sourceStartSec: 800.0, sourceEndSec: 805.27 }  // 5.27s -> total 63.55s
    ]
  };
  const defaultAdjust = Director.technicalDurationAdjustment(underMin63p55Spine, reel, {
    hardMinSec: 65,
    durationSec: 906.84,
    liveActionEndSec: 810
  });
  assert.equal(defaultAdjust.applied, false, 'Default maxDeficitSec (1.0s) must remain unchanged for unit test contracts');

  const postRepairAdjust = Director.technicalDurationAdjustment(underMin63p55Spine, reel, {
    hardMinSec: 65,
    durationSec: 906.84,
    liveActionEndSec: 810,
    maxDeficitSec: Director.POST_STRUCTURAL_REPAIR_MAX_DEFICIT_SEC
  });
  assert.equal(postRepairAdjust.applied, true, `Post-structural-repair maxDeficitSec (3.0s) should reconcile -1.45s deficit, got ${postRepairAdjust.reason}`);
  assert.ok(Math.abs(Director.timelineSec(postRepairAdjust.spine.beats) - 65.0) < 0.01, `Expected ~65.0s, got ${Director.timelineSec(postRepairAdjust.spine.beats)}`);
  // Every adjusted beat stays inside its watched window and below liveActionEndSec
  for (const b of postRepairAdjust.spine.beats) {
    assert.ok(reel.ranges.some(r => b.sourceStartSec >= r.windowStartSec - 1e-6 && b.sourceEndSec <= r.windowEndSec + 1e-6), `${b.beatId} left its watched window`);
    assert.ok(b.sourceEndSec <= 810);
  }

  // 19D: A deficit beyond 3.0s still goes back to the media-grounded Director (no silent padding)
  const bigDeficit = Director.technicalDurationAdjustment(underMin63p55Spine, reel, {
    hardMinSec: 70,
    durationSec: 906.84,
    liveActionEndSec: 810,
    maxDeficitSec: Director.POST_STRUCTURAL_REPAIR_MAX_DEFICIT_SEC
  });
  assert.equal(bigDeficit.applied, false);
});




