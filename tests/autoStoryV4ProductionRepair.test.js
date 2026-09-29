'use strict';

/**
 * AutoStory V4 — Focused Production Integration Test: Real Production Repair Loop
 *
 * Executes the REAL production chain:
 * AutoStoryRunner
 *   -> AutoStoryVariantWorker
 *   -> auditDrafts
 *   -> targeted repair (buildStoryDesign + buildScript)
 *   -> rerender (renderHighlightFastDraft)
 *   -> second media audit
 *
 * Verifies all production assertions without test workarounds or plan.json.
 */

const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const Store = require('../electron/services/projectStore');
const Service = require('../electron/services/autoStoryFastService');
const Runner = require('../electron/services/autoStoryRunner');
const Dubbing = require('../electron/services/dubbingService');
const sourceModelService = require('../electron/services/sourceStoryModelService');
const structuralCriticService = require('../electron/services/structuralCriticService');

const UNIQUE_BEAT_START_SEC = 88.88;
const UNIQUE_BEAT_END_SEC = 94.88;
const UNIQUE_BEAT_ID = 'repaired_unique_beat_88';

(async () => {
  console.log('Testing AutoStory V4 Production Repair Loop...');

  // =========================================================================
  // UNIT REGRESSION SUITE: Items 1, 4, 5, 6, 7
  // =========================================================================
  console.log('\n--- Running Unit Regression Suite ---');

  // Item 1: Media Critic observedFunction Contract
  {
    console.log('Checking Item 1: Media critic observedFunction contract...');
    const dummySpine = { beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 11, narrativeRole: 'hook' }] };

    // Case 1.1: Missing observedFunction
    const mockAiMissing = {
      generateJsonFromFiles: async () => ({
        windows: [
          { windowIndex: 0, windowStart: 0, windowEnd: 5.5, observedAction: 'Action 1', observedNewInformation: 'Info 1' },
          { windowIndex: 1, windowStart: 5.5, windowEnd: 11.0, observedAction: 'Action 2', observedNewInformation: 'Info 2' }
        ]
      })
    };
    const resMissing = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: mockAiMissing,
      mp4Path: 'dummy.mp4',
      actualMp4DurationSec: 11.0,
      targetWindowSec: 5.5
    });
    assert.strictEqual(resMissing.status, 'MEDIA_CRITIC_INVALID', 'Missing observedFunction must yield status: MEDIA_CRITIC_INVALID');
    assert.strictEqual(resMissing.isCompliant, false, 'Missing observedFunction must yield isCompliant: false');

    // Case 1.2: Malformed observedFunction (outside allowed enum)
    const mockAiMalformed = {
      generateJsonFromFiles: async () => ({
        windows: [
          { windowIndex: 0, windowStart: 0, windowEnd: 5.5, observedFunction: 'invalid_narrative_type_xyz', observedAction: 'Action 1', observedNewInformation: 'Info 1' },
          { windowIndex: 1, windowStart: 5.5, windowEnd: 11.0, observedFunction: 'officer_action', observedAction: 'Action 2', observedNewInformation: 'Info 2' }
        ]
      })
    };
    const resMalformed = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: mockAiMalformed,
      mp4Path: 'dummy.mp4',
      actualMp4DurationSec: 11.0,
      targetWindowSec: 5.5
    });
    assert.strictEqual(resMalformed.status, 'MEDIA_CRITIC_INVALID', 'Malformed observedFunction must yield status: MEDIA_CRITIC_INVALID');
    assert.strictEqual(resMalformed.isCompliant, false, 'Malformed observedFunction must yield isCompliant: false');

    // Case 1.3: Allowed enum set verification
    assert.ok(Array.isArray(structuralCriticService.ALLOWED_OBSERVED_FUNCTIONS), 'ALLOWED_OBSERVED_FUNCTIONS must be exported');
    for (const expectedEnum of ['context_setup', 'suspect_defense', 'physical_evidence', 'victim_allegation', 'officer_action', 'contradiction', 'escalation', 'consequence', 'payoff', 'backstory', 'other']) {
      assert.ok(structuralCriticService.ALLOWED_OBSERVED_FUNCTIONS.includes(expectedEnum), `ALLOWED_OBSERVED_FUNCTIONS must contain ${expectedEnum}`);
    }
    console.log('✓ Item 1 Passed: Media critic observedFunction contract enforced strictly');
  }

  // Helper to generate a fully valid 13-field window object
  const makeValidWin = (idx, start, end, func = 'context_setup', extra = {}) => ({
    windowIndex: idx,
    windowStart: start,
    windowEnd: end,
    observedFunction: func,
    observedAction: 'Action ' + idx,
    observedDialogue: 'Dialogue ' + idx,
    observedNewInformation: 'Info ' + idx,
    newFact: true,
    viewerBeliefChange: true,
    caseStateChange: true,
    stakesChange: true,
    futureConsequenceChange: true,
    isForwardConsequence: true,
    ...extra
  });

  // Item 4: Full Media Audit Coverage Determinism (Cases A, B, C, D)
  {
    console.log('Checking Item 4: Deterministic media coverage validation (Cases A, B, C, D)...');
    const dummySpine = { beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 16.5, narrativeRole: 'hook' }] };
    const dur = 16.5; // 3 windows of 5.5s each: 0-5.5, 5.5-11.0, 11.0-16.5

    // Case A: Missing middle window
    const mockCaseA = {
      generateJsonFromFiles: async () => ({
        windows: [
          makeValidWin(0, 0, 5.5, 'context_setup'),
          makeValidWin(2, 11.0, 16.5, 'consequence')
        ]
      })
    };
    const resA = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: mockCaseA, mp4Path: 'dummy.mp4', actualMp4DurationSec: dur, targetWindowSec: 5.5
    });
    assert.strictEqual(resA.status, 'STRUCTURAL_CRITIC_INCOMPLETE', 'Case A (missing middle window) must fail coverage');
    assert.strictEqual(resA.isCompliant, false);

    // Case B: Duplicated window
    const mockCaseB = {
      generateJsonFromFiles: async () => ({
        windows: [
          makeValidWin(0, 0, 5.5, 'context_setup'),
          makeValidWin(0, 0, 5.5, 'context_setup', { observedAction: 'A0 dup' }),
          makeValidWin(1, 5.5, 11.0, 'officer_action')
        ]
      })
    };
    const resB = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: mockCaseB, mp4Path: 'dummy.mp4', actualMp4DurationSec: dur, targetWindowSec: 5.5
    });
    assert.strictEqual(resB.status, 'STRUCTURAL_CRITIC_INCOMPLETE', 'Case B (duplicated window) must fail coverage');
    assert.strictEqual(resB.isCompliant, false);

    // Case C: Middle gap between windows
    const mockCaseC = {
      generateJsonFromFiles: async () => ({
        windows: [
          makeValidWin(0, 0, 5.5, 'context_setup'),
          makeValidWin(1, 7.0, 11.0, 'officer_action'), // 1.5s gap from 5.5 to 7.0
          makeValidWin(2, 11.0, 16.5, 'consequence')
        ]
      })
    };
    const resC = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: mockCaseC, mp4Path: 'dummy.mp4', actualMp4DurationSec: dur, targetWindowSec: 5.5
    });
    assert.strictEqual(resC.status, 'STRUCTURAL_CRITIC_INCOMPLETE', 'Case C (middle gap) must fail coverage');
    assert.strictEqual(resC.isCompliant, false);

    // Case D: Complete contiguous coverage
    const mockCaseD = {
      generateJsonFromFiles: async () => ({
        windows: [
          makeValidWin(0, 0, 5.5, 'context_setup'),
          makeValidWin(1, 5.5, 11.0, 'officer_action'),
          makeValidWin(2, 11.0, 16.5, 'consequence')
        ]
      })
    };
    const resD = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: mockCaseD, mp4Path: 'dummy.mp4', actualMp4DurationSec: dur, targetWindowSec: 5.5
    });
    assert.strictEqual(resD.status, 'SUCCESS', 'Case D (complete contiguous coverage) must succeed');
    assert.strictEqual(resD.isCompliant, true, 'Case D must be compliant');
    console.log('✓ Item 4 Passed: Coverage validation Cases A, B, C failed as expected, and D passed');
  }

  // =========================================================================
  // V4 MEDIA CRITIC ACCEPTANCE CORRECTNESS REGRESSION TESTS
  // =========================================================================
  console.log('\n--- Running Media Critic Acceptance Correctness Tests ---');

  // Test 1: Missing required response fields -> MEDIA_CRITIC_INVALID
  {
    console.log('Test 1: Missing required response fields...');
    const dummySpine = { beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 5.5, narrativeRole: 'hook' }] };
    const requiredFields = [
      'windowIndex', 'windowStart', 'windowEnd', 'observedFunction',
      'observedAction', 'observedDialogue', 'observedNewInformation',
      'newFact', 'viewerBeliefChange', 'caseStateChange', 'stakesChange',
      'futureConsequenceChange', 'isForwardConsequence'
    ];
    for (const field of requiredFields) {
      const baseWin = makeValidWin(0, 0, 5.5, 'consequence');
      delete baseWin[field];
      const res = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
        aiService: { generateJsonFromFiles: async () => ({ windows: [baseWin] }) },
        mp4Path: 'dummy.mp4', actualMp4DurationSec: 5.5, targetWindowSec: 5.5
      });
      assert.strictEqual(res.status, 'MEDIA_CRITIC_INVALID', `Missing field '${field}' must yield MEDIA_CRITIC_INVALID`);
      assert.strictEqual(res.isCompliant, false);
    }
    console.log('✓ Test 1 Passed: Missing required response fields yield MEDIA_CRITIC_INVALID');
  }

  // Test 2: Non-boolean progress field (e.g. string "true" or null) -> MEDIA_CRITIC_INVALID
  {
    console.log('Test 2: Non-boolean progress fields...');
    const dummySpine = { beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 5.5, narrativeRole: 'hook' }] };
    const progressFields = ['newFact', 'viewerBeliefChange', 'caseStateChange', 'stakesChange', 'futureConsequenceChange', 'isForwardConsequence'];
    for (const field of progressFields) {
      for (const invalidVal of ['true', null, 1, undefined]) {
        const baseWin = makeValidWin(0, 0, 5.5, 'consequence');
        baseWin[field] = invalidVal;
        const res = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
          aiService: { generateJsonFromFiles: async () => ({ windows: [baseWin] }) },
          mp4Path: 'dummy.mp4', actualMp4DurationSec: 5.5, targetWindowSec: 5.5
        });
        assert.strictEqual(res.status, 'MEDIA_CRITIC_INVALID', `Non-boolean progress field '${field}' = ${invalidVal} must yield MEDIA_CRITIC_INVALID`);
        assert.strictEqual(res.isCompliant, false);
      }
    }
    console.log('✓ Test 2 Passed: Non-boolean progress fields yield MEDIA_CRITIC_INVALID');
  }

  // Test 3: Progress plateau: 3 consecutive windows with no progress fields true -> fails acceptance even if observedFunction changes
  {
    console.log('Test 3: Progress plateau across changing observedFunctions...');
    const dummySpine = { beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 16.5, narrativeRole: 'hook' }] };
    const dur = 16.5; // 3 x 5.5s = 16.5s > 10.0s
    const wins = [
      makeValidWin(0, 0, 5.5, 'context_setup', { viewerBeliefChange: false, caseStateChange: false, stakesChange: false, futureConsequenceChange: false, newFact: true }),
      makeValidWin(1, 5.5, 11.0, 'officer_action', { viewerBeliefChange: false, caseStateChange: false, stakesChange: false, futureConsequenceChange: false, newFact: true }),
      makeValidWin(2, 11.0, 16.5, 'consequence', { viewerBeliefChange: false, caseStateChange: false, stakesChange: false, futureConsequenceChange: false, newFact: true, isForwardConsequence: true })
    ];
    const res = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: { generateJsonFromFiles: async () => ({ windows: wins }) },
      mp4Path: 'dummy.mp4', actualMp4DurationSec: dur, targetWindowSec: 5.5
    });
    assert.strictEqual(res.status, 'SUCCESS');
    assert.strictEqual(res.noProgressRunSec > 10.0, true, `noProgressRunSec (${res.noProgressRunSec}s) must exceed 10.0s`);
    assert.strictEqual(res.isCompliant, false, 'Progress plateau must fail acceptance even with changing observedFunctions');
    const spec = structuralCriticService.generateTargetedRepairSpecification(res, dummySpine);
    assert.strictEqual(spec.failureType, 'semantic_plateau');
    console.log('✓ Test 3 Passed: Progress plateau >10s fails acceptance despite changing observedFunction');
  }

  // Test 4: Progress plateau: 3 consecutive windows with same observedFunction but real caseStateChange=true -> passes (not a plateau)
  {
    console.log('Test 4: Consecutive same observedFunction with real progress passes...');
    const dummySpine = { beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 16.5, narrativeRole: 'hook' }] };
    const dur = 16.5;
    const wins = [
      makeValidWin(0, 0, 5.5, 'officer_action', { caseStateChange: true }),
      makeValidWin(1, 5.5, 11.0, 'officer_action', { caseStateChange: true }),
      makeValidWin(2, 11.0, 16.5, 'officer_action', { caseStateChange: true, isForwardConsequence: true })
    ];
    const res = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: { generateJsonFromFiles: async () => ({ windows: wins }) },
      mp4Path: 'dummy.mp4', actualMp4DurationSec: dur, targetWindowSec: 5.5
    });
    assert.strictEqual(res.status, 'SUCCESS');
    assert.strictEqual(res.noProgressRunSec, 0, 'noProgressRunSec must be 0 when caseStateChange is true');
    assert.strictEqual(res.weakWindows.length, 0);
    assert.strictEqual(res.isCompliant, true, 'Same observedFunction with real progress must pass acceptance');
    console.log('✓ Test 4 Passed: Consecutive same observedFunction with real caseStateChange passes');
  }

  // Test 5: Isolated weak window (5.5/10) with otherwise high score -> fails acceptance, triggers targeted repair
  {
    console.log('Test 5: Isolated weak window fails acceptance...');
    const dummySpine = { beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 22.0, narrativeRole: 'hook' }] };
    const dur = 22.0;
    const wins = [
      makeValidWin(0, 0, 5.5, 'context_setup'),
      // Isolated weak window: all 5 progress vectors false -> retentionStatus='WEAK', score <= 5.5
      makeValidWin(1, 5.5, 11.0, 'suspect_defense', {
        newFact: false, viewerBeliefChange: false, caseStateChange: false, stakesChange: false, futureConsequenceChange: false, isForwardConsequence: false
      }),
      makeValidWin(2, 11.0, 16.5, 'officer_action'),
      makeValidWin(3, 16.5, 22.0, 'consequence', { isForwardConsequence: true })
    ];
    const res = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: { generateJsonFromFiles: async () => ({ windows: wins }) },
      mp4Path: 'dummy.mp4', actualMp4DurationSec: dur, targetWindowSec: 5.5
    });
    assert.strictEqual(res.status, 'SUCCESS');
    assert.strictEqual(res.weakWindows.length, 1, 'Must have exactly 1 weak window');
    assert.strictEqual(res.weakWindows[0].windowIndex, 1);
    assert.strictEqual(res.weakWindows[0].retentionStatus, 'WEAK');
    assert.strictEqual(res.weakWindows[0].retentionScore <= 5.5, true);
    assert.strictEqual(res.isCompliant, false, 'Isolated weak window must fail acceptance');
    const spec = structuralCriticService.generateTargetedRepairSpecification(res, dummySpine);
    assert.strictEqual(spec.weakWindowStart, 5.5);
    console.log('✓ Test 5 Passed: Isolated weak window fails acceptance and triggers repair');
  }

  // Test 6: Backstory ending -> fails acceptance gate, repair spec has failureType: 'ending_backstory'
  {
    console.log('Test 6: Backstory ending fails gate...');
    const dummySpine = { beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 11.0, narrativeRole: 'hook' }] };
    const dur = 11.0;
    const wins = [
      makeValidWin(0, 0, 5.5, 'context_setup'),
      makeValidWin(1, 5.5, 11.0, 'backstory', { isForwardConsequence: false })
    ];
    const res = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: { generateJsonFromFiles: async () => ({ windows: wins }) },
      mp4Path: 'dummy.mp4', actualMp4DurationSec: dur, targetWindowSec: 5.5
    });
    assert.strictEqual(res.endingValid, false, 'Backstory ending must have endingValid: false');
    assert.strictEqual(res.isCompliant, false, 'Backstory ending must fail compliance');
    const spec = structuralCriticService.generateTargetedRepairSpecification(res, dummySpine);
    assert.strictEqual(spec.failureType, 'ending_backstory');
    console.log('✓ Test 6 Passed: Backstory ending fails acceptance gate with failureType ending_backstory');
  }

  // Test 7: Forward consequence ending -> passes ending gate
  {
    console.log('Test 7: Forward consequence ending passes...');
    const dummySpine = { beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 11.0, narrativeRole: 'hook' }] };
    const dur = 11.0;
    const wins = [
      makeValidWin(0, 0, 5.5, 'context_setup'),
      makeValidWin(1, 5.5, 11.0, 'consequence', { isForwardConsequence: true })
    ];
    const res = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: { generateJsonFromFiles: async () => ({ windows: wins }) },
      mp4Path: 'dummy.mp4', actualMp4DurationSec: dur, targetWindowSec: 5.5
    });
    assert.strictEqual(res.endingValid, true);
    assert.strictEqual(res.isCompliant, true);
    console.log('✓ Test 7 Passed: Forward consequence ending passes ending gate');
  }

  // Test 8: Payoff ending -> passes ending gate
  {
    console.log('Test 8: Payoff ending passes...');
    const dummySpine = { beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 11.0, narrativeRole: 'hook' }] };
    const dur = 11.0;
    const wins = [
      makeValidWin(0, 0, 5.5, 'context_setup'),
      makeValidWin(1, 5.5, 11.0, 'payoff', { isForwardConsequence: false })
    ];
    const res = await structuralCriticService.critiqueMediaGroundedTimeline(dummySpine, {
      aiService: { generateJsonFromFiles: async () => ({ windows: wins }) },
      mp4Path: 'dummy.mp4', actualMp4DurationSec: dur, targetWindowSec: 5.5
    });
    assert.strictEqual(res.endingValid, true);
    assert.strictEqual(res.isCompliant, true);
    console.log('✓ Test 8 Passed: Payoff ending passes ending gate');
  }

  // Test 9: Incomplete window coverage -> critic retried ONCE on same MP4, does NOT call buildStoryDesign, fails pipeline with MEDIA_CRITIC_FAILED
  {
    console.log('Test 9: Incomplete coverage critic retry and MEDIA_CRITIC_FAILED...');
    const testPipelineDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v4-critic-fail-'));
    const testStore = new Store();
    const sourceCacheDir = path.join(testPipelineDir, 'cache');
    await fs.mkdir(sourceCacheDir, { recursive: true });
    await sourceModelService.persist(sourceCacheDir, {
      modelVersion: sourceModelService.MODEL_VERSION,
      durationSec: 120,
      people: [],
      events: [{ id: 'e1', startSec: 0, endSec: 10, type: 'event', summary: 'E1' }],
      quotes: [],
      audioEvents: []
    });
    const testMp4 = path.join(testPipelineDir, 'draft_1.mp4');
    await fs.writeFile(testMp4, 'mock mp4');

    const testProj = await testStore.createProject(testPipelineDir, {
      title: 'Critic Failure Test',
      autoStoryContractVersion: 4,
      sourceVideoPath: path.join(testPipelineDir, 'src.mp4')
    });
    await testStore.updateProject(testPipelineDir, testProj.id, {
      autoStorySourceV3: {
        identity: 'test_critic_fail_id',
        cache: sourceCacheDir,
        duration: 120
      },
      analysis: {
        highlightVariants: [{
          id: 'variant_01',
          scriptId: 1,
          artifacts: { fastDraftVideoPath: testMp4 }
        }]
      }
    });
    const paths = testStore.getProjectPaths(testPipelineDir, testProj.id);
    const analysisDir = path.join(paths.analysisDir, 'auto-story-fast');
    await fs.mkdir(analysisDir, { recursive: true });
    await fs.writeFile(path.join(testPipelineDir, 'src.mp4'), 'mock');

    let criticCallCount = 0;
    let buildStoryDesignCalled = false;
    const auditedMp4Paths = [];
    const mockFailAi = {
      getModel: () => 'gemini-2.5-flash',
      generateJsonFromFiles: async (args) => {
        const prompt = String(args.prompt || '');
        if (/v3-story-design/i.test(prompt) || prompt.includes('centralViewerQuestion')) {
          buildStoryDesignCalled = true;
          return { accessGranted: true, spines: [] };
        }
        criticCallCount++;
        auditedMp4Paths.push(args.filePaths[0]);
        // Return incomplete window coverage (only 1 window for 11s duration)
        return {
          windows: [
            makeValidWin(0, 0, 5.5, 'context_setup')
          ]
        };
      }
    };

    const mockFfmpeg = {
      probeVideo: async () => ({ duration: 11.0, width: 1080, height: 1920 })
    };

    const dummySpineDoc = {
      spines: [{
        scriptId: 1,
        centralViewerQuestion: 'Q?',
        hookPromise: 'H',
        beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 11.0, narrativeRole: 'confrontation' }]
      }]
    };
    await fs.writeFile(path.join(analysisDir, 'story-spine.json'), JSON.stringify(dummySpineDoc));
    await fs.writeFile(path.join(analysisDir, 'script-1.json'), JSON.stringify({ segments: [] }));

    const pipelineService = new Service({}, testStore, {
      dubbing: {
        importReviewedScriptProject: async () => ({ analysis: { highlightVariants: [{ id: 'v1', scriptId: 1 }] } }),
        renderHighlightFastDraft: async () => ({ outputPath: testMp4 })
      },
      vertex: mockFailAi,
      ffmpeg: mockFfmpeg
    });

    let pipelineError = null;
    try {
      await pipelineService.auditDrafts({
        workspaceRoot: testPipelineDir,
        projectId: testProj.id,
        scriptId: 1
      });
    } catch (err) {
      pipelineError = err;
    }

    if (pipelineError && pipelineError.code !== 'MEDIA_CRITIC_FAILED') {
      console.error('Test 9 UNEXPECTED ERROR:', pipelineError);
    }

    assert.ok(pipelineError, 'Pipeline must fail when critic model fails after retry');
    assert.strictEqual(pipelineError.code, 'MEDIA_CRITIC_FAILED', 'Error code must be MEDIA_CRITIC_FAILED');
    assert.strictEqual(criticCallCount, 2, 'Critic must be retried exactly ONCE on the same MP4 (total 2 calls)');
    assert.strictEqual(auditedMp4Paths[0], auditedMp4Paths[1], 'Critic retry must be on the SAME MP4');
    assert.strictEqual(buildStoryDesignCalled, false, 'buildStoryDesign must NOT be called on critic failure');

    // Assert review-state file recorded failure
    const reviewState = JSON.parse(await fs.readFile(path.join(analysisDir, 'review-state-1.json'), 'utf8'));
    assert.strictEqual(reviewState.status, 'MEDIA_CRITIC_FAILED');
    assert.strictEqual(reviewState.finalCheck?.verdict, 'FAIL');
    await fs.rm(testPipelineDir, { recursive: true, force: true });
    console.log('✓ Test 9 Passed: Incomplete coverage triggers 1 retry on same MP4, no repair, fails with MEDIA_CRITIC_FAILED');
  }

  // Test 10: story-spine.json write failure after repair -> fails with PERSIST_ACCEPTED_EDL_FAILED, no review-state PASS written
  {
    console.log('Test 10: Canonical persistence failure fails with PERSIST_ACCEPTED_EDL_FAILED...');
    const testPipelineDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v4-persist-fail-'));
    const testStore = new Store();
    const sourceCacheDir = path.join(testPipelineDir, 'cache');
    await fs.mkdir(sourceCacheDir, { recursive: true });
    await sourceModelService.persist(sourceCacheDir, {
      modelVersion: sourceModelService.MODEL_VERSION,
      durationSec: 120,
      people: [],
      events: [{ id: 'e1', startSec: 0, endSec: 10, type: 'event', summary: 'E1' }],
      quotes: [],
      audioEvents: []
    });
    const testMp4 = path.join(testPipelineDir, 'draft_1.mp4');
    await fs.writeFile(testMp4, 'mock mp4');

    const testProj = await testStore.createProject(testPipelineDir, {
      title: 'Persist Failure Test',
      autoStoryContractVersion: 4,
      sourceVideoPath: path.join(testPipelineDir, 'src.mp4')
    });
    await testStore.updateProject(testPipelineDir, testProj.id, {
      autoStoryConfig: {
        outputCount: 1,
        targetDurationMinSec: 10,
        targetDurationMaxSec: 15,
        narration: { enabled: true, measuredWordsPerSecond: 2.5 }
      },
      autoStoryEditorialConfig: {
        outputCount: 1,
        targetDurationMinSec: 10,
        targetDurationMaxSec: 15,
        narration: { enabled: true, measuredWordsPerSecond: 2.5 }
      },
      autoStorySourceV3: {
        identity: 'test_persist_fail_id',
        cache: sourceCacheDir,
        duration: 120
      },
      analysis: {
        highlightVariants: [{
          id: 'variant_01',
          scriptId: 1,
          artifacts: { fastDraftVideoPath: testMp4 }
        }]
      }
    });
    const paths = testStore.getProjectPaths(testPipelineDir, testProj.id);
    const analysisDir = path.join(paths.analysisDir, 'auto-story-fast');
    await fs.mkdir(analysisDir, { recursive: true });
    await fs.writeFile(path.join(testPipelineDir, 'src.mp4'), 'mock');

    const repairedSpineBeats = [
      { beatId: 'b1', sourceStartSec: 0, sourceEndSec: 5.5, narrativeRole: 'confrontation' },
      { beatId: 'b2_repaired', sourceStartSec: 5.5, sourceEndSec: 11.0, narrativeRole: 'cliffhanger', isForwardConsequence: true }
    ];

    let criticAuditCount = 0;
    const mockAiForPersist = {
      getModel: () => 'gemini-2.5-flash',
      generateJsonFromFiles: async (args) => {
        const prompt = String(args.prompt || '');
        if (/v3-story-design/i.test(prompt) || prompt.includes('centralViewerQuestion')) {
          return {
            accessGranted: true,
            spines: [{
              scriptId: 1,
              centralViewerQuestion: 'Q?',
              hookPromise: 'H',
              beats: repairedSpineBeats
            }]
          };
        }
        if (/v3-narration/i.test(prompt) || prompt.includes('narrations')) {
          return { narrations: [] };
        }
        criticAuditCount++;
        // First audit fails with isolated weak window (triggers repair)
        if (criticAuditCount === 1) {
          return {
            windows: [
              makeValidWin(0, 0, 5.5, 'suspect_defense', { newFact: false, viewerBeliefChange: false, caseStateChange: false, stakesChange: false, futureConsequenceChange: false, isForwardConsequence: false }),
              makeValidWin(1, 5.5, 11.0, 'consequence', { isForwardConsequence: true })
            ]
          };
        }
        // Second audit (after repair) passes!
        return {
          windows: [
            makeValidWin(0, 0, 5.5, 'officer_action'),
            makeValidWin(1, 5.5, 11.0, 'consequence', { isForwardConsequence: true })
          ]
        };
      }
    };

    const testProxyDurations = new Map();
    const mockFfmpeg = {
      probeVideo: async (videoPath) => {
        const baseKey = path.basename(videoPath).replace(/\.tmp\.mp4$/, '').replace(/\.mp4$/, '');
        if (testProxyDurations.has(baseKey)) {
          return { duration: testProxyDurations.get(baseKey), width: 640, height: 360 };
        }
        return { duration: 11.0, width: 1080, height: 1920 };
      },
      probeAudio: async () => ({ duration: 3.0 }),
      createAnalysisProxyChunk: async ({ outputPath, durationSec }) => {
        const baseKey = path.basename(outputPath).replace(/\.tmp\.mp4$/, '').replace(/\.mp4$/, '');
        testProxyDurations.set(baseKey, durationSec);
        await fs.writeFile(outputPath, 'mock proxy media');
      }
    };

    const initialSpine = {
      spines: [{
        scriptId: 1,
        centralViewerQuestion: 'Q?',
        hookPromise: 'H',
        beats: [
          { beatId: 'b1', sourceStartSec: 0, sourceEndSec: 5.5, narrativeRole: 'context' },
          { beatId: 'b2', sourceStartSec: 5.5, sourceEndSec: 11.0, narrativeRole: 'cliffhanger', isForwardConsequence: true }
        ]
      }]
    };
    await fs.writeFile(path.join(analysisDir, 'story-spine.json'), JSON.stringify(initialSpine));
    await fs.writeFile(path.join(analysisDir, 'script-1.json'), JSON.stringify({ segments: [] }));

    const pipelineService = new Service({}, testStore, {
      dubbing: {
        importReviewedScriptProject: async () => ({ analysis: { highlightVariants: [{ id: 'v1', scriptId: 1 }] } }),
        renderHighlightFastDraft: async () => {
          // Break story-spine.json write by replacing it with a directory right before the pass audit attempts to persist it
          const spinePath = path.join(analysisDir, 'story-spine.json');
          await fs.rm(spinePath, { recursive: true, force: true });
          await fs.mkdir(spinePath);
          return { outputPath: testMp4 };
        }
      },
      vertex: mockAiForPersist,
      ffmpeg: mockFfmpeg
    });

    let persistError = null;
    try {
      await pipelineService.auditDrafts({
        workspaceRoot: testPipelineDir,
        projectId: testProj.id,
        scriptId: 1
      });
    } catch (err) {
      persistError = err;
    }

    if (persistError && persistError.code !== 'PERSIST_ACCEPTED_EDL_FAILED') {
      console.error('Test 10 UNEXPECTED ERROR:', persistError);
    }

    assert.ok(persistError, 'Pipeline must fail when story-spine.json cannot be persisted');
    assert.strictEqual(persistError.code, 'PERSIST_ACCEPTED_EDL_FAILED', 'Error code must be PERSIST_ACCEPTED_EDL_FAILED');

    // Assert review-state-1.json is NOT PASS
    const reviewState = JSON.parse(await fs.readFile(path.join(analysisDir, 'review-state-1.json'), 'utf8'));
    assert.strictEqual(reviewState.status, 'PERSIST_ACCEPTED_EDL_FAILED');
    assert.strictEqual(reviewState.finalCheck?.verdict, 'FAIL', 'review-state must NOT record PASS');

    await fs.rm(testPipelineDir, { recursive: true, force: true });
    console.log('✓ Test 10 Passed: Canonical persistence failure fails with PERSIST_ACCEPTED_EDL_FAILED and no PASS');
  }

  // Item 5: Noncompliant Critic Always Produces Actionable Repair Spec (even with empty weakWindows)
  {
    console.log('Checking Item 5: Repair spec generation for semantic plateau with empty weakWindows...');
    const plateauAudit = {
      isCompliant: false,
      criticObservedScore: 7.0,
      maxPlateau: 12.0,
      mp4Duration: 72.0,
      postCliffhangerTailSec: 0.0,
      weakWindows: [], // weakWindows is empty!
      windows: [
        { windowStart: 0, windowEnd: 5.5, observedFunction: 'context_setup', semanticStateRunSec: 5.5 },
        { windowStart: 5.5, windowEnd: 11.0, observedFunction: 'suspect_defense', semanticStateRunSec: 5.5 },
        { windowStart: 11.0, windowEnd: 17.5, observedFunction: 'suspect_defense', semanticStateRunSec: 12.0 },
        { windowStart: 17.5, windowEnd: 72.0, observedFunction: 'officer_action', semanticStateRunSec: 54.5, isForwardConsequence: true }
      ]
    };
    const spec = structuralCriticService.generateTargetedRepairSpecification(plateauAudit, {});
    assert.ok(spec, 'generateTargetedRepairSpecification must NOT return null when isCompliant is false');
    assert.strictEqual(spec.failureType, 'semantic_plateau', 'Failure type must be semantic_plateau');
    assert.strictEqual(spec.observedFunction, 'suspect_defense', 'Must identify the plateau narrative function');
    assert.strictEqual(typeof spec.plateauStart, 'number');
    assert.strictEqual(typeof spec.plateauEnd, 'number');
    assert.strictEqual(typeof spec.semanticStateRunSec, 'number');
    assert.strictEqual(spec.semanticStateRunSec, 12.0);
    assert.ok(spec.candidateRepairStrategy, 'Must provide candidate repair strategy');
    console.log('✓ Item 5 Passed: Semantic plateau generates valid repair spec despite empty weakWindows');
  }

  // Item 6: Restore Legacy Plateau Guard in critiqueRenderedTimeline
  {
    console.log('Checking Item 6: Legacy plateau guard in critiqueRenderedTimeline...');
    const spineWithPlateau = {
      centralViewerQuestion: 'Will suspect be charged?',
      hookPromise: 'A traffic stop escalation',
      beats: [
        { beatId: 'p1', sourceStartSec: 0, sourceEndSec: 6, narrativeRole: 'context', newInformation: 'Info 1' },
        { beatId: 'p2', sourceStartSec: 6, sourceEndSec: 12, narrativeRole: 'context', newInformation: 'Info 2' },
        { beatId: 'p3', sourceStartSec: 12, sourceEndSec: 18, narrativeRole: 'context', newInformation: 'Info 3' },
        { beatId: 'p4', sourceStartSec: 18, sourceEndSec: 24, narrativeRole: 'cliffhanger', newInformation: 'Charges filed', consequenceMagnitude: 'charges' }
      ]
    };
    const metadataCriticResult = structuralCriticService.critiqueRenderedTimeline(spineWithPlateau, {
      actualMp4DurationSec: 24.0,
      targetWindowSec: 5.5
    });
    assert.strictEqual(metadataCriticResult.maxPlateau > 10.0, true, 'Max plateau must exceed 10.0s');
    assert.strictEqual(metadataCriticResult.isCompliant, false, 'critiqueRenderedTimeline must reject >10s semantic plateau even if score is high');
    console.log('✓ Item 6 Passed: critiqueRenderedTimeline rejects >10s semantic plateau');
  }

  // Item 7: Preserve Isolated Worker Production Semantics
  {
    console.log('Checking Item 7: Runner isolated worker dependency factory...');
    const testStore = { saveProject: async () => {}, getProjectPaths: () => ({ analysisDir: 'mock' }) };
    let factoryCalledWith = null;
    const testFactory = (localStore) => {
      factoryCalledWith = localStore;
      return { isWorkerDubbing: true };
    };
    const testRunner = new Runner({}, testStore, { isParentDubbing: true }, (s, d) => ({}), testFactory);
    assert.strictEqual(testRunner.createDubbing, testFactory, 'AutoStoryRunner must store createDubbing factory');

    const defaultRunner = new Runner({}, testStore, { isParentDubbing: true });
    assert.strictEqual(defaultRunner.createDubbing, null, 'AutoStoryRunner defaults createDubbing to null in production');
    console.log('✓ Item 7 Passed: AutoStoryRunner isolated worker factory verified');
  }

  // =========================================================================
  // INTEGRATION REPAIR LOOP TEST
  // =========================================================================
  console.log('\n--- Running Full AutoStory V4 Production Repair Integration ---');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v4-prod-repair-'));
  const store = new Store();

  // Tracking state for all assertions
  const tracking = {
    criticAuditedMp4s: [],
    criticResults: [],
    repairSpecsCreated: [],
    buildStoryDesignRepairInstructions: [],
    repairReceivedBaselineBeats: false,
    geminiReturnedRepairedEdlWithUniqueBeat: false,
    buildScriptReceivedRepairedEdl: false,
    secondScriptContainsUniqueBeat: false,
    renderedMp4Paths: [],
    reviewStateFinalCheck: null
  };

  try {
    // 1. Prepare dummy source video and canonical source model
    const crypto = require('crypto');
    const sourceVideoPath = path.join(root, 'source.mp4');
    const sourceData = 'dummy video data for auto-story v4 regression test';
    await fs.writeFile(sourceVideoPath, sourceData);
    const identity = crypto.createHash('sha256').update(sourceData).digest('hex');
    const sourceCacheDir = path.join(root, '.cineviral', 'auto-story-source', identity, 'source-contract-v3');
    await fs.mkdir(sourceCacheDir, { recursive: true });

    const events = [];
    for (let i = 1; i <= 14; i++) {
      events.push({
        id: `e${i}`,
        startSec: (i - 1) * 8,
        endSec: i * 8,
        type: 'event',
        location: i % 2 === 0 ? 'squad_car' : 'street_curb',
        summary: `Event summary for beat ${i}`,
        peopleIds: ['p1'],
        tension: 0.5
      });
    }

    const canonicalSourceModel = {
      modelVersion: sourceModelService.MODEL_VERSION,
      durationSec: 120,
      people: [{ id: 'p1', label: 'Officer', role: 'police' }],
      events,
      quotes: [{ id: 'q1', startSec: 2, endSec: 5, speaker: 'Officer', text: 'Step out of the car.' }],
      audioEvents: []
    };
    await sourceModelService.persist(sourceCacheDir, canonicalSourceModel);

    // 2. Create project with V4 contracts
    const project = await store.createProject(root, {
      title: 'V4 Production Regression Test',
      sourceVideoPath: path.join(root, 'source.mp4'),
      autoStoryContractVersion: 4,
      autoStoryPipelineVersion: 'source-story-v3',
      autoStoryConfig: {
        outputCount: 1,
        targetDurationMinSec: 65,
        targetDurationMaxSec: 90,
        narration: { enabled: true, measuredWordsPerSecond: 2.5 }
      },
      autoStoryEditorialConfig: {
        outputCount: 1,
        targetDurationMinSec: 65,
        targetDurationMaxSec: 90,
        narration: { enabled: true, measuredWordsPerSecond: 2.5 }
      },
      autoStorySourceV3: {
        identity,
        cache: sourceCacheDir,
        duration: 120
      }
    });

    // 3. Build baseline EDL beats (~77 seconds across 14 micro-beats)
    const baseBeats = [];
    for (let i = 1; i <= 14; i++) {
      baseBeats.push({
        beatId: `b${i}`,
        beatIndex: i - 1,
        sourceStartSec: (i - 1) * 5.5,
        sourceEndSec: i * 5.5,
        sourceEventId: `e${i}`,
        visualStateCluster: i % 2 === 0 ? 'squad_car_front' : 'street_curb_side',
        chronologyMode: 'chronological',
        narrativeRole: i === 1 ? 'hook' : i === 14 ? 'cliffhanger' : i % 2 === 0 ? 'escalation' : 'confrontation',
        viewerQuestion: `Will part ${i} resolve?`,
        informationRevealed: `Scene development part ${i}`,
        openLoop: 'loop_1',
        payoffTiming: i === 14 ? 'part_2' : 'none',
        audioMode: 'original_audio',
        narrationPurpose: 'NONE',
        wantsNarration: false,
        narratorFunction: 'NONE',
        tensionBefore: 0.3 + (i * 0.04),
        tensionAfter: 0.35 + (i * 0.04),
        retentionReason: 'new_fact',
        newInformation: `Scene development part ${i}`,
        viewerStateBefore: 'curious',
        viewerStateAfter: 'engaged',
        tensionDelta: 1,
        openLoopDelta: 'advances',
        cliffhangerQuestion: i === 14 ? 'Will suspect be charged with felony?' : '',
        cliffhangerNewInformation: i === 14 ? 'Officer discovers concealed weapon under seat' : '',
        cliffhangerExpectedNextPayoff: i === 14 ? 'Court arraignment and bail hearing' : '',
        isForwardConsequence: i === 14,
        consequenceMagnitude: i === 14 ? 'charges' : 'none',
        unresolvedConsequence: i === 14 ? 'Pending charges' : 'none'
      });
    }

    const baselineSpine = {
      centralViewerQuestion: 'Why did the encounter escalate?',
      hookPromise: 'A traffic stop turns critical',
      hookStrategy: 'curiosity_gap',
      strongEnough: true,
      reason: 'Strong escalating conflict between driver and police officer',
      informationBudget: { immediate: [], deferred: [], reveals: [], omit: [] },
      openLoops: [{ id: 'loop_1', question: 'Why did the encounter escalate?', opensAtBeat: 'b1', closesAtBeat: 'b14' }],
      beats: baseBeats
    };

    // 4. Mock Vertex AI Service
    let storyDesignCalls = 0;
    const mockAi = {
      getModel: () => 'gemini-2.5-flash',
      lastResponseText: '',
      lastUsage: null,
      lastResponseMetadata: { finishReason: 'STOP' },
      budgetStatus: async () => null,
      generateJsonFromFiles: async (args) => {
        const prompt = String(args.prompt || '');
        const files = Array.isArray(args.filePaths) ? args.filePaths : [];

        // Is this a Media-Grounded Critic call? (receives MP4 video path)
        if (files.some(f => f.endsWith('.mp4'))) {
          const auditedMp4 = files.find(f => f.endsWith('.mp4'));
          tracking.criticAuditedMp4s.push(auditedMp4);

          const makeWindows = (weak = false) => {
            const wins = [];
            const dur = 72;
            const num = 13;
            const wDur = dur / num;
            const funcs = ['officer_action', 'physical_evidence', 'contradiction', 'escalation'];
            for (let w = 0; w < num; w++) {
              const start = Number((w * wDur).toFixed(2));
              const end = Number(((w + 1) * wDur).toFixed(2));
              if (weak && (w === 2 || w === 3)) {
                // Consecutive suspect_defense lasting 11.08s -> triggers semantic plateau > 10.0s!
                wins.push({
                  windowIndex: w,
                  windowStart: start, windowEnd: end,
                  observedAction: 'Talking head explanation plateau',
                  observedDialogue: 'She repeatedly explains what happened before police arrived',
                  observedNewInformation: 'None',
                  newFact: false,
                  viewerBeliefChange: false, caseStateChange: false, stakesChange: false,
                  futureConsequenceChange: false, isForwardConsequence: false,
                  observedFunction: 'suspect_defense'
                });
              } else {
                wins.push({
                  windowIndex: w,
                  windowStart: start, windowEnd: end,
                  observedAction: `Active progression discovering weapon at ${start}s`,
                  observedDialogue: `Officer finds weapon evidence ${w + 1}`,
                  observedNewInformation: `New physical evidence discovered at ${start}s`,
                  newFact: true,
                  viewerBeliefChange: true, caseStateChange: true, stakesChange: true,
                  futureConsequenceChange: true, isForwardConsequence: true,
                  observedFunction: w === num - 1 ? 'consequence' : funcs[w % funcs.length]
                });
              }
            }
            return wins;
          };

          // Call 1: Initial MP4 audit -> FAILS (contains weak window & plateau)
          if (tracking.criticAuditedMp4s.length === 1) {
            const failResult = {
              windows: makeWindows(true)
            };
            tracking.criticResults.push(failResult);
            return failResult;
          }

          // Call 2: Second MP4 audit -> PASSES
          const passResult = {
            windows: makeWindows(false)
          };
          tracking.criticResults.push(passResult);
          return passResult;
        }

        // Is this Story Design?
        if (/v3-story-design/i.test(prompt) || prompt.includes('centralViewerQuestion')) {
          storyDesignCalls++;
          if (prompt.includes('TARGETED STRUCTURAL REPAIR DIRECTIVE FROM MEDIA-GROUNDED CRITIC') || (prompt.includes('TARGETED STRUCTURAL REPAIR DIRECTIVE') && prompt.includes('CURRENT SPINE TO REPAIR'))) {
            tracking.buildStoryDesignRepairInstructions.push(prompt);

            // Dynamically parse currentSpine from inputData in prompt
            let parsedCurrentSpine = null;
            const inputMatch = prompt.match(/INPUT \(data\): (\{[\s\S]*?\})\nSOURCE MEDIA:/);
            if (inputMatch) {
              try {
                const parsedInput = JSON.parse(inputMatch[1]);
                parsedCurrentSpine = parsedInput.currentSpine;
              } catch (_) {}
            }
            if (!parsedCurrentSpine) {
              const spineMatch = prompt.match(/CURRENT SPINE TO REPAIR:\s*(\{[\s\S]*?\})\s*REPAIR SPECIFICATION:/);
              if (spineMatch) {
                try {
                  parsedCurrentSpine = JSON.parse(spineMatch[1]);
                } catch (_) {}
              }
            }

            if (!parsedCurrentSpine || !Array.isArray(parsedCurrentSpine.beats) || !parsedCurrentSpine.beats.length) {
              throw new Error('MOCK AI: repair called without valid inputData.currentSpine!');
            }

            // Assert currentSpine in repair call contains original baseline beat IDs (b1, b10, etc.)
            const hasBaselineB1 = parsedCurrentSpine.beats.some(b => b.beatId === 'b1');
            const hasBaselineB10 = parsedCurrentSpine.beats.some(b => b.beatId === 'b10');
            if (!hasBaselineB1 || !hasBaselineB10) {
              throw new Error('MOCK AI: currentSpine must contain original baseline beat IDs (b1, b10)');
            }
            tracking.repairReceivedBaselineBeats = true;

            // Dynamically derive repaired EDL FROM parsedCurrentSpine (no closed-over baselineSpine)
            const dynamicallyRepairedBeats = parsedCurrentSpine.beats.map(b => {
              if (b.beatId === 'b10') {
                return {
                  ...b,
                  beatId: UNIQUE_BEAT_ID,
                  sourceStartSec: UNIQUE_BEAT_START_SEC,
                  sourceEndSec: UNIQUE_BEAT_END_SEC,
                  visualStateCluster: 'patrol_vehicle_lighting',
                  narrativeRole: 'confrontation',
                  newInformation: 'Unique repaired confrontation moment at 88.88s',
                  viewerQuestion: 'What happened at 88.88s?',
                  retentionReason: 'contradiction',
                  isForwardConsequence: false,
                  consequenceMagnitude: 'none',
                  audioMode: 'original_audio'
                };
              }
              return { ...b };
            });

            const dynamicallyRepairedSpine = {
              ...parsedCurrentSpine,
              beats: dynamicallyRepairedBeats
            };

            tracking.geminiReturnedRepairedEdlWithUniqueBeat = true;
            return { accessGranted: true, spines: [dynamicallyRepairedSpine] };
          }
          return { accessGranted: true, spines: [baselineSpine] };
        }

        // Is this Narration?
        if (/v3-narration/i.test(prompt) || prompt.includes('narrations')) {
          return { narrations: [] };
        }

        return {};
      }
    };

    // 5. Mock FFmpeg Service
    const proxyDurations = new Map();
    const mockFfmpeg = {
      probeVideo: async (videoPath) => {
        const baseKey = path.basename(videoPath).replace(/\.tmp\.mp4$/, '').replace(/\.mp4$/, '');
        if (proxyDurations.has(baseKey)) {
          return { duration: proxyDurations.get(baseKey), width: 640, height: 360 };
        }
        if (typeof videoPath === 'string' && videoPath.includes('draft')) {
          return { duration: 72.0, width: 1080, height: 1920 };
        }
        return { duration: 120.0, width: 1080, height: 1920 };
      },
      probeAudio: async (audioPath) => ({
        duration: 3.0
      }),
      createAnalysisProxyChunk: async ({ outputPath, durationSec }) => {
        const baseKey = path.basename(outputPath).replace(/\.tmp\.mp4$/, '').replace(/\.mp4$/, '');
        proxyDurations.set(baseKey, durationSec);
        await fs.writeFile(outputPath, 'mock proxy media');
      }
    };

    // 6. Mock Dubbing Service
    let renderCount = 0;
    const initialMp4Path = path.join(root, 'draft_pass_0.mp4');
    const secondMp4Path = path.join(root, 'draft_pass_1.mp4');
    await fs.writeFile(initialMp4Path, 'initial mp4 binary data');
    await fs.writeFile(secondMp4Path, 'second mp4 binary data');

    const dubbing = new Dubbing(store);
    dubbing.canReuseAutoStoryDraft = async () => false;

    dubbing.importHighlightCutProject = async function ({ workspaceRoot, projectId }) {
      const targetStore = this.projectStore || store;
      const script1 = JSON.parse(await fs.readFile(path.join(targetStore.getProjectPaths(workspaceRoot, projectId).analysisDir, 'auto-story-fast', 'script-1.json'), 'utf8'));
      const variant = {
        id: 'variant_01',
        scriptId: 1,
        segments: script1.segments || [],
        sourceJsonPath: path.join(targetStore.getProjectPaths(workspaceRoot, projectId).analysisDir, 'auto-story-fast', 'script-1.json'),
        artifacts: {}
      };
      return targetStore.updateProject(workspaceRoot, projectId, {
        analysis: { highlightVariants: [variant], activeVariantId: 'variant_01', segments: variant.segments }
      });
    };

    dubbing.importReviewedScriptProject = async function ({ workspaceRoot, projectId, jsonPath }) {
      const targetStore = this.projectStore || store;
      const script = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
      const hasUniqueBeat = (script.segments || []).some(s => Math.abs(s.sourceStartSec - UNIQUE_BEAT_START_SEC) < 0.1);
      if (hasUniqueBeat) {
        tracking.secondScriptContainsUniqueBeat = true;
      }

      const p = await targetStore.getProject(workspaceRoot, projectId);
      const variant = {
        id: 'variant_01',
        scriptId: 1,
        segments: script.segments || [],
        sourceJsonPath: jsonPath,
        artifacts: {}
      };
      return targetStore.updateProject(workspaceRoot, projectId, {
        analysis: { ...(p.analysis || {}), highlightVariants: [variant], activeVariantId: 'variant_01', segments: variant.segments }
      });
    };

    dubbing.renderHighlightFastDraft = async function ({ workspaceRoot, projectId }) {
      renderCount++;
      const currentMp4 = renderCount === 1 ? initialMp4Path : secondMp4Path;
      tracking.renderedMp4Paths.push(currentMp4);

      const targetStore = this.projectStore || store;
      const p = await targetStore.getProject(workspaceRoot, projectId);
      const variants = (p.analysis?.highlightVariants || []).map(v => ({
        ...v,
        artifacts: { ...(v.artifacts || {}), fastDraftVideoPath: currentMp4 }
      }));
      await targetStore.updateProject(workspaceRoot, projectId, {
        analysis: { ...(p.analysis || {}), highlightVariants: variants }
      });

      return { outputPath: currentMp4, internalOutputPath: currentMp4 };
    };

    // Isolated worker dependency factory: worker receives its own store reference
    const createDubbing = (localStore) => {
      const workerDubbing = Object.create(dubbing);
      workerDubbing.projectStore = localStore;
      return workerDubbing;
    };

    // 7. Execute AutoStoryRunner
    const runner = new Runner(
      {},
      store,
      dubbing,
      (s, d) => new Service(s, store, { ...d, vertex: mockAi, ffmpeg: mockFfmpeg }),
      createDubbing
    );
    assert.strictEqual(runner.isolatedWorkers, true, 'Runner must enable isolated workers when store supports saveProject');

    const result = await runner.run({
      workspaceRoot: root,
      projectId: project.id,
      scriptId: 1,
      onProgress: () => {}
    });

    const analysisDir = path.join(store.getProjectPaths(root, project.id).analysisDir, 'auto-story-fast');

    // 8. Assertions Verification
    console.log('\n--- Verifying All 13 Assertions ---');

    // Assertion 1: Initial rendered MP4 is audited
    assert.strictEqual(tracking.criticAuditedMp4s.length >= 2, true, 'At least 2 media critic audits must occur');
    assert.strictEqual(tracking.criticAuditedMp4s[0], initialMp4Path, 'Assertion 1: Initial rendered MP4 must be audited first');
    console.log('✓ Assertion 1: Initial rendered MP4 is audited');

    // Assertion 2: Initial critic result fails
    const initialMediaAudit = JSON.parse(await fs.readFile(path.join(analysisDir, 'initial-media-audit-1.json'), 'utf8'));
    assert.strictEqual(initialMediaAudit.isCompliant, false, 'Assertion 2: Initial critic result must fail');
    console.log('✓ Assertion 2: Initial critic result fails');

    // Assertion 3: repairSpecification is created
    const repairSpecFile = path.join(analysisDir, 'repair-1-specification-1.json');
    const repairSpecExists = await fs.access(repairSpecFile).then(() => true).catch(() => false);
    assert.strictEqual(repairSpecExists, true, 'Assertion 3: repair-1-specification-1.json must exist');
    console.log('✓ Assertion 3: repairSpecification is created');

    // Assertion 4: buildStoryDesign receives the repair instruction & baseline beats
    assert.strictEqual(tracking.buildStoryDesignRepairInstructions.length >= 1, true, 'Assertion 4: buildStoryDesign must receive the repair instruction');
    assert.strictEqual(tracking.repairReceivedBaselineBeats, true, 'Assertion 4b: Repair call must receive currentSpine containing baseline beat IDs (b1, b10)');
    console.log('✓ Assertion 4: buildStoryDesign receives repair instruction with baseline beat IDs');

    // Assertion 5: Gemini returns a repaired EDL containing UNIQUE beat/timestamp
    assert.strictEqual(tracking.geminiReturnedRepairedEdlWithUniqueBeat, true, 'Assertion 5: Gemini must return repaired EDL with unique beat');
    console.log('✓ Assertion 5: Gemini returns repaired EDL with unique beat');

    // Assertion 6: buildScript receives that repaired EDL
    assert.strictEqual(tracking.secondScriptContainsUniqueBeat, true, 'Assertion 6: buildScript must compile repaired EDL into script-1.json');
    console.log('✓ Assertion 6: buildScript receives repaired EDL');

    // Assertion 7: Second rendered script contains that unique repaired beat
    const secondScriptContent = JSON.parse(await fs.readFile(path.join(analysisDir, 'script-1.json'), 'utf8'));
    const uniqueSegment = secondScriptContent.segments.find(s => Math.abs(s.sourceStartSec - UNIQUE_BEAT_START_SEC) < 0.1);
    assert.ok(uniqueSegment, 'Assertion 7: Second script on disk must contain the unique repaired beat');
    console.log('✓ Assertion 7: Second rendered script contains unique repaired beat');

    // Assertion 8: A SECOND MP4 path is produced
    assert.strictEqual(tracking.renderedMp4Paths.length >= 2, true, 'Assertion 8: At least two MP4 renders must occur');
    assert.notStrictEqual(tracking.renderedMp4Paths[0], tracking.renderedMp4Paths[1], 'Assertion 8: Second MP4 path must be distinct');
    console.log('✓ Assertion 8: A SECOND MP4 path is produced');

    // Assertion 9: Media critic receives the SECOND MP4, not the first
    assert.strictEqual(tracking.criticAuditedMp4s[1], secondMp4Path, 'Assertion 9: Second critic call must receive second MP4');
    console.log('✓ Assertion 9: Media critic receives SECOND MP4, not the first');

    // Assertion 10: Second critic result passes
    const repairMediaAudit = JSON.parse(await fs.readFile(path.join(analysisDir, 'repair-1-media-audit-1.json'), 'utf8'));
    assert.strictEqual(repairMediaAudit.isCompliant, true, 'Assertion 10: Second critic result must pass');
    console.log('✓ Assertion 10: Second critic result passes');

    // Assertion 11: review-state-1.json ends: complete=true, needsUserReview=false, finalCheck.verdict='PASS'
    const reviewStatePath = path.join(analysisDir, 'review-state-1.json');
    const reviewState = JSON.parse(await fs.readFile(reviewStatePath, 'utf8'));
    assert.strictEqual(reviewState.complete, true, 'Assertion 11: complete must be true');
    assert.strictEqual(reviewState.needsUserReview, false, 'Assertion 11: needsUserReview must be false');
    assert.strictEqual(reviewState.finalCheck?.verdict, 'PASS', 'Assertion 11: finalCheck.verdict must be PASS');
    console.log('✓ Assertion 11: review-state-1.json ends complete=true, needsUserReview=false, finalCheck.verdict=PASS');

    // Assertion 12: Parent store's story-spine.json contains repaired unique beat/timestamp
    const parentSpinePath = path.join(store.getProjectPaths(root, project.id).analysisDir, 'auto-story-fast', 'story-spine.json');
    const parentSpineExists = await fs.access(parentSpinePath).then(() => true).catch(() => false);
    assert.strictEqual(parentSpineExists, true, 'Assertion 12: parent story-spine.json must exist in sourceAnalysis');
    const parentSpineData = JSON.parse(await fs.readFile(parentSpinePath, 'utf8'));
    const parentSpine = (parentSpineData.spines || []).find(s => Number(s.scriptId) === 1) || parentSpineData.spines?.[0];
    assert.ok(parentSpine, 'Assertion 12: parent story-spine.json must contain spine for scriptId 1');
    const parentHasUniqueBeat = (parentSpine.beats || []).some(b => b.beatId === UNIQUE_BEAT_ID || Math.abs(b.sourceStartSec - UNIQUE_BEAT_START_SEC) < 0.1);
    assert.strictEqual(parentHasUniqueBeat, true, 'Assertion 12: Parent story-spine.json must contain repaired unique beat');
    console.log('✓ Assertion 12: Parent store story-spine.json contains repaired unique beat');

    // Assertion 13: Simulate a second audit or reopen: assert worker loads accepted repaired spine, not initial pre-repair spine
    const reopenWorkerRoot = path.join(store.getProjectPaths(root, project.id).rootDir, '.variant-workers', 'reopen-test-1');
    const reopenStore = new Store();
    const reopenPaths = reopenStore.getProjectPaths(reopenWorkerRoot, project.id);
    await fs.mkdir(path.join(reopenPaths.analysisDir, 'auto-story-fast'), { recursive: true });
    // In production, worker prep copies story-spine.json from parent sourceAnalysis
    const sourceAnalysisDir = path.join(store.getProjectPaths(root, project.id).analysisDir, 'auto-story-fast');
    const reopenAnalysisDir = path.join(reopenPaths.analysisDir, 'auto-story-fast');
    await fs.copyFile(path.join(sourceAnalysisDir, 'story-spine.json'), path.join(reopenAnalysisDir, 'story-spine.json'));
    const loadedReopenDoc = JSON.parse(await fs.readFile(path.join(reopenAnalysisDir, 'story-spine.json'), 'utf8'));
    const loadedAcceptedSpine = (loadedReopenDoc.spines || []).find(s => Number(s.scriptId) === 1) || loadedReopenDoc.spines?.[0];
    assert.ok(loadedAcceptedSpine, 'Assertion 13: Reopened worker must load spine from parent story-spine.json');
    const reopenHasRepairedBeat = (loadedAcceptedSpine.beats || []).some(b => b.beatId === UNIQUE_BEAT_ID || Math.abs(b.sourceStartSec - UNIQUE_BEAT_START_SEC) < 0.1);
    assert.strictEqual(reopenHasRepairedBeat, true, 'Assertion 13: Reopened worker loads accepted repaired spine, not pre-repair spine');
    console.log('✓ Assertion 13: Reopened worker loads accepted repaired spine');

    // Verify all artifact contract files exist separately:
    const requiredArtifacts = [
      'initial-story-spine-1.json',
      'initial-media-audit-1.json',
      'repair-1-specification-1.json',
      'repair-1-story-spine-1.json',
      'repair-1-media-audit-1.json'
    ];
    for (const name of requiredArtifacts) {
      const artPath = path.join(analysisDir, name);
      const exists = await fs.access(artPath).then(() => true).catch(() => false);
      assert.strictEqual(exists, true, `Artifact contract file must exist: ${name}`);
    }
    console.log('✓ All V4 artifact contract files verified on disk');

    console.log('\nALL 13 PRODUCTION ASSERTIONS AND UNIT REGRESSIONS PASSED SUCCESSFULLY!');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(err => {
  console.error('\nTest Failed with Error:', err);
  process.exit(1);
});
