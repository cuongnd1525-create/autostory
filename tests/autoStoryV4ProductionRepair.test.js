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

  // Item 4: Full Media Audit Coverage Determinism (Cases A, B, C, D)
  {
    console.log('Checking Item 4: Deterministic media coverage validation (Cases A, B, C, D)...');
    const dummySpine = { beats: [{ beatId: 'b1', sourceStartSec: 0, sourceEndSec: 16.5, narrativeRole: 'hook' }] };
    const dur = 16.5; // 3 windows of 5.5s each: 0-5.5, 5.5-11.0, 11.0-16.5

    // Case A: Missing middle window
    const mockCaseA = {
      generateJsonFromFiles: async () => ({
        windows: [
          { windowIndex: 0, windowStart: 0, windowEnd: 5.5, observedFunction: 'context_setup', observedAction: 'A0', observedNewInformation: 'I0' },
          { windowIndex: 2, windowStart: 11.0, windowEnd: 16.5, observedFunction: 'consequence', observedAction: 'A2', observedNewInformation: 'I2' }
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
          { windowIndex: 0, windowStart: 0, windowEnd: 5.5, observedFunction: 'context_setup', observedAction: 'A0', observedNewInformation: 'I0' },
          { windowIndex: 0, windowStart: 0, windowEnd: 5.5, observedFunction: 'context_setup', observedAction: 'A0 dup', observedNewInformation: 'I0' },
          { windowIndex: 1, windowStart: 5.5, windowEnd: 11.0, observedFunction: 'officer_action', observedAction: 'A1', observedNewInformation: 'I1' }
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
          { windowIndex: 0, windowStart: 0, windowEnd: 5.5, observedFunction: 'context_setup', observedAction: 'A0', observedNewInformation: 'I0' },
          { windowIndex: 1, windowStart: 7.0, windowEnd: 11.0, observedFunction: 'officer_action', observedAction: 'A1', observedNewInformation: 'I1' }, // 1.5s gap from 5.5 to 7.0
          { windowIndex: 2, windowStart: 11.0, windowEnd: 16.5, observedFunction: 'consequence', observedAction: 'A2', observedNewInformation: 'I2' }
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
          { windowIndex: 0, windowStart: 0, windowEnd: 5.5, observedFunction: 'context_setup', observedAction: 'A0', observedNewInformation: 'I0', newFact: true, viewerBeliefChange: true, caseStateChange: true, stakesChange: true, futureConsequenceChange: true, isForwardConsequence: true },
          { windowIndex: 1, windowStart: 5.5, windowEnd: 11.0, observedFunction: 'officer_action', observedAction: 'A1', observedNewInformation: 'I1', newFact: true, viewerBeliefChange: true, caseStateChange: true, stakesChange: true, futureConsequenceChange: true, isForwardConsequence: true },
          { windowIndex: 2, windowStart: 11.0, windowEnd: 16.5, observedFunction: 'consequence', observedAction: 'A2', observedNewInformation: 'I2', newFact: true, viewerBeliefChange: true, caseStateChange: true, stakesChange: true, futureConsequenceChange: true, isForwardConsequence: true }
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
