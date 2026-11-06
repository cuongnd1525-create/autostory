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


