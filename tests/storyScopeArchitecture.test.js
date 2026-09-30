// Story Scope + media-grounded Editorial Director architecture tests.
// Run: node tests/storyScopeArchitecture.test.js
//
// These tests exercise the REAL pipeline modules (autoStoryV3Pipeline.run,
// buildScript, auditDrafts, compileV3, Service.stage, Engine.ask/prepare) with a
// scripted provider, and assert the architecture contracts:
//   A scope before EDL · B director receives scope · C director receives media +
//   manifest · D no silent out-of-scope injection · E retention arc does not reorder ·
//   F duration failure returns to Gemini · G exact duplicate guard · H repair gets
//   scope+EDL+weak region+media · I legacy path unchanged · no benchmark literals.
// The fixture is a GENERIC synthetic incident (not the benchmark source).

const assert = require('node:assert');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const svc = p => path.join(__dirname, '..', 'electron', 'services', p);
const Store = require(svc('projectStore.js'));
const Service = require(svc('autoStoryFastService.js'));
const Pipeline = require(svc('autoStoryV3Pipeline.js'));
const Scope = require(svc('storyScopeService.js'));
const Director = require(svc('editorialDirectorService.js'));
const Critic = require(svc('scopeMediaCriticService.js'));
const sourceModel = require(svc('sourceStoryModelService.js'));
const { compileV3 } = require(svc('autoStoryV3Compile.js'));
const { augmentCoverage } = require(svc('beatCoverageService.js'));
const durationFit = require(svc('autoStoryDurationFit.js'));
const SchemaBoundary = require(svc('autoStorySchemaBoundary.js'));

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

// ------------------------------------------------------------------ fixture
const SOURCE_SEC = 300;
const MODEL = {
  modelVersion: sourceModel.MODEL_VERSION, durationSec: SOURCE_SEC,
  people: [{ id: 'p1', label: 'Officer', role: 'police', firstSeenSec: 2 }, { id: 'p2', label: 'Driver', role: 'subject', firstSeenSec: 10 }],
  events: [
    { id: 'e1', startSec: 2, endSec: 14, type: 'stop', summary: 'Officer stops a car for swerving', location: 'roadside', peopleIds: ['p1'], tension: 0.3, visualQuality: 0.8, novelty: 0.5, dialogueImpact: 0.4, isReveal: false, audioType: 'officer_speech', audioConfidence: 0.9 },
    { id: 'e2', startSec: 14, endSec: 34, type: 'questioning', summary: 'Driver claims he had no drinks', location: 'driver window', peopleIds: ['p1', 'p2'], tension: 0.5, visualQuality: 0.8, novelty: 0.6, dialogueImpact: 0.7, isReveal: false, audioType: 'participant_speech', audioConfidence: 0.9 },
    { id: 'e3', startSec: 34, endSec: 58, type: 'contradiction', summary: 'Open container spotted in console', location: 'driver window', peopleIds: ['p1', 'p2'], tension: 0.7, visualQuality: 0.8, novelty: 0.8, dialogueImpact: 0.8, isReveal: true, audioType: 'participant_speech', audioConfidence: 0.9 },
    { id: 'e4', startSec: 58, endSec: 84, type: 'test', summary: 'Field sobriety test falters', location: 'roadside', peopleIds: ['p1', 'p2'], tension: 0.8, visualQuality: 0.8, novelty: 0.7, dialogueImpact: 0.6, isReveal: false, audioType: 'officer_speech', audioConfidence: 0.9 },
    { id: 'e5', startSec: 84, endSec: 110, type: 'arrest_decision', summary: 'Officer announces detention', location: 'roadside', peopleIds: ['p1', 'p2'], tension: 0.9, visualQuality: 0.8, novelty: 0.8, dialogueImpact: 0.9, isReveal: true, audioType: 'officer_speech', audioConfidence: 0.9 },
    // A dramatic but OUT-OF-SCOPE branch (later, different conflict).
    { id: 'e9', startSec: 240, endSec: 262, type: 'unrelated_fight', summary: 'Bystander brawl across the street', location: 'parking lot', peopleIds: [], tension: 1, visualQuality: 1, novelty: 1, dialogueImpact: 1, isReveal: true, audioType: 'mixed', audioConfidence: 0.9 }
  ],
  quotes: [{ id: 'q1', eventId: 'e2', speaker: 'Driver', startSec: 20, endSec: 23, text: 'I did not drink anything tonight.', epistemic: 'suspect_statement', editorialValue: 0.9 }],
  audioEvents: []
};

function scopeCandidate(overrides = {}) {
  return {
    storyScopeId: 'scope_stop_to_detention',
    centralConflict: 'Driver denies drinking while the evidence builds against him.',
    centralViewerQuestion: 'Will his denial survive what the officer finds?',
    scopeStartState: 'Routine stop for swerving.',
    scopeEndTarget: 'forward_cliffhanger',
    whyThisIsOneStory: 'One stop, one denial, one escalating evidence chain, one consequence.',
    primaryEntities: ['Officer', 'Driver'],
    causalSpine: [
      { eventId: 'e1', sourceStartSec: 2, sourceEndSec: 14, role: 'setup', whyInScope: 'Starts the conflict' },
      { eventId: 'e2', sourceStartSec: 14, sourceEndSec: 34, role: 'claim', whyInScope: 'The denial' },
      { eventId: 'e3', sourceStartSec: 34, sourceEndSec: 58, role: 'contradiction', whyInScope: 'Evidence contradicts the denial' },
      { eventId: 'e5', sourceStartSec: 84, sourceEndSec: 110, role: 'consequence', whyInScope: 'Detention follows' }
    ],
    scopeWindows: [
      { startSec: 2, endSec: 84, purpose: 'core', why: 'stop through test' },
      { startSec: 84, endSec: 110, purpose: 'ending_material', why: 'detention announcement' }
    ],
    mustResolve: ['Is he impaired?'], mustWithhold: ['The detention outcome'],
    allowedSupportingContext: [{ description: 'Earlier call about a swerving car', sourceStartSec: 0, sourceEndSec: 2, treatment: 'narration_only' }],
    explicitScopeBoundary: { startSec: 0, endSec: 112, rationale: 'The stop until the detention decision.' },
    outOfScopeBranches: [{ description: 'Bystander brawl across the street', sourceStartSec: 240, sourceEndSec: 262, whyExcluded: 'Different conflict; does not affect the denial.' }],
    targetDurationSec: 75,
    candidateEndingEvents: [{ eventId: 'e5', sourceStartSec: 96, sourceEndSec: 110, endingType: 'forward_cliffhanger', whyItIsAConsequence: 'The failed test leads to detention.' }],
    footageAvailability: 'Continuous bodycam, clear audio.',
    ...overrides
  };
}
const selection = (cands = [scopeCandidate()], chosen = cands[0].storyScopeId) => ({ accessGranted: true, candidates: cands, chosenStoryScopeId: chosen, selectionRationale: 'Clear single conflict with strong ending.' });

function beat(id, s, e, extra = {}) {
  return {
    beatId: id, sourceStartSec: s, sourceEndSec: e, chronologyMode: 'chronological', narrativeRole: 'escalation',
    audioMode: 'original_audio', wantsNarration: false, narratorFunction: 'NONE', narrationIntent: '', scopeMembership: 'core',
    sourceEventId: '', observedInFootage: `seen ${s}-${e}`, viewerQuestion: 'Will the denial hold?', viewerStateBefore: 'before', viewerStateAfter: 'after',
    newInformation: `info ${id}`, whyNecessaryNow: 'advances the denial vs evidence', whyNextFollows: 'next step of the stop', payoffTiming: 'delayed', ...extra
  };
}
// A valid 72s director EDL: teaser from later in scope, rewind, chronological, ending.
function directorEdl({ beats } = {}) {
  return {
    accessGranted: true,
    reelObservations: 'Continuous roadside stop; denial at the window; container visible; wobbly test; detention.',
    spine: {
      centralViewerQuestion: 'Will his denial survive what the officer finds?', hookPromise: 'He swears he is sober.', hookStrategy: 'teaser then rewind', reason: 'one conflict',
      beats: beats || [
        beat('b1', 60, 66, { chronologyMode: 'teaser', narrativeRole: 'teaser_conflict', scopeMembership: 'hook', payoffTiming: 'part_2' }),
        beat('b2', 4, 14, { chronologyMode: 'rewind', narrativeRole: 'rewind_context' }),
        beat('b3', 16, 30),
        beat('b4', 36, 50, { narrativeRole: 'contradiction' }),
        beat('b5', 58, 82, { narrativeRole: 'escalation' }),
        beat('b6', 98, 106, { narrativeRole: 'cliffhanger', scopeMembership: 'ending', payoffTiming: 'part_2', isForwardConsequence: true, expectedNextConsequence: 'detention' })
      ]
    }
  };
}

// Scripted provider: routes by pass marker and records every call.
function makeVertex(script) {
  const calls = [];
  return {
    calls,
    getModel: () => 'gemini-test',
    generateJsonFromFiles: async args => {
      const p = String(args.prompt || '');
      const kind = p.includes('PASS 1A — STORY SCOPE SELECTION') ? 'scope'
        : p.includes('PASS 1B — MEDIA-GROUNDED EDITORIAL DIRECTOR') ? 'director'
        : p.includes('PASS 1 — GEMINI EDITORIAL DIRECTOR') ? 'legacy_design'
        : p.includes('PASS 3 — NARRATION') ? 'narration'
        : p.includes('reviewing a RENDERED edit') ? 'scope_critic'
        : 'other';
      calls.push({ kind, prompt: p, filePaths: args.filePaths || [] });
      const handler = script[kind];
      if (!handler) throw new Error(`unscripted provider call: ${kind}`);
      return typeof handler === 'function' ? handler(calls.filter(c => c.kind === kind).length, args) : handler;
    }
  };
}

function makeFfmpeg() {
  const durations = new Map();
  return {
    durations,
    probeVideo: async file => {
      if (durations.has(file)) return { duration: durations.get(file), width: 640, height: 360 };
      if (/source\.mp4$/.test(file)) return { duration: SOURCE_SEC, width: 1920, height: 1080 };
      if (/draft.*\.mp4$/.test(file)) return { duration: 72, width: 1080, height: 1920 };
      throw new Error(`missing ${file}`);
    },
    createAnalysisProxyChunk: async ({ outputPath, durationSec }) => { await fs.writeFile(outputPath, 'proxy'); durations.set(outputPath, durationSec); }
  };
}

async function makeProject({ contractVersion = 4, architecture = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-arch-'));
  const store = new Store();
  const sourceData = `synthetic source ${crypto.randomUUID()}`;
  await fs.writeFile(path.join(dir, 'source.mp4'), sourceData);
  const hash = crypto.createHash('sha256').update(sourceData).digest('hex');
  const cache = path.join(dir, '.cineviral', 'auto-story-source', hash, 'source-contract-v3');
  await fs.mkdir(cache, { recursive: true });
  await sourceModel.persist(cache, MODEL);
  const proj = await store.createProject(dir, { name: 'scope test', autoStoryContractVersion: contractVersion, sourceVideoPath: path.join(dir, 'source.mp4') });
  await store.updateProject(dir, proj.id, {
    autoStoryConfig: { targetDurationMinSec: 65, targetDurationMaxSec: 90, outputCount: 1, audioBalance: 'original_only', ...(architecture ? { editorialArchitecture: architecture } : {}) }
  });
  return { dir, store, projectId: proj.id, cache };
}

function makeService(store, vertex, ffmpeg, dubbing = {}) {
  const s = new Service({ vertexAutoStoryMaxCalls: 40 }, store, { vertex, ffmpeg, dubbing, callBudget: { calls: 0, runId: 'test' } });
  s.measuredVoice = async () => ({ meta: { duration: 2 } });
  return s;
}

// Fake engine for unit-level director/scope tests (no disk, no provider).
function fakeEngine(asks) {
  return {
    duration: SOURCE_SEC,
    config: { targetDurationMinSec: 65, targetDurationMaxSec: 90, narration: { enabled: false, measuredWordsPerSecond: 2.5 } },
    prepared: [],
    async prepare(ranges) { this.prepared.push(ranges); return ranges.map((r, i) => ({ id: `clip${i}`, file: `/reel/clip${i}.mp4`, sourceStart: r.sourceStartSec, duration: r.sourceEndSec - r.sourceStartSec, transcript: [] })); },
    async ask(key, input, schema, instruction, evidence, validate) {
      const r = asks.shift();
      this.lastAsks = (this.lastAsks || []).concat([{ key, input, instruction, evidence }]);
      if (!r) throw new Error(`unexpected ask ${key}`);
      const value = typeof r === 'function' ? r(input) : r;
      // Mirror Engine.ask + Service.stage: local JSON-schema check, then the pass
      // validator; a failure surfaces the invalid artifact (sourceContract path).
      try { SchemaBoundary.validate(value, schema); await validate(value); }
      catch (e) { e.invalidArtifact = value; throw e; }
      return value;
    }
  };
}

(async () => {
  console.log('Story Scope + media-grounded Editorial Director');

  // ---------------------------------------------------------------- A, B, C
  await ok('A/B/C: run() selects Story Scope BEFORE the EDL; director receives the scope and scope-reel MEDIA + manifest', async () => {
    const { dir, store, projectId } = await makeProject();
    const vertex = makeVertex({ scope: selection(), director: directorEdl() });
    const ffmpeg = makeFfmpeg();
    const result = await Pipeline.run(makeService(store, vertex, ffmpeg), { workspaceRoot: dir, projectId, onProgress: () => {} });
    assert.deepStrictEqual(result.failures, [], JSON.stringify(result.failures));
    assert.strictEqual(result.scriptPaths.length, 1);
    const kinds = vertex.calls.map(c => c.kind);
    assert.ok(kinds.indexOf('scope') >= 0, 'scope pass ran');
    assert.ok(kinds.indexOf('scope') < kinds.indexOf('director'), `scope must precede director: ${kinds}`);
    assert.ok(!kinds.includes('legacy_design'), 'text-only legacy design must not run on the director path');
    const scopeCall = vertex.calls.find(c => c.kind === 'scope');
    assert.strictEqual(scopeCall.filePaths.length, 0, 'scope selection is text-only over the source model');
    const dCall = vertex.calls.find(c => c.kind === 'director');
    // B: the chosen scope is in the director's input.
    assert.match(dCall.prompt, /"storyScopeId":"scope_stop_to_detention"/);
    assert.match(dCall.prompt, /"centralViewerQuestion":"Will his denial survive what the officer finds\?"/);
    // C: director received video files covering ONLY the scope reel, plus the absolute-time manifest.
    assert.ok(dCall.filePaths.length >= 1, 'director must receive media files');
    const manifest = JSON.parse(dCall.prompt.split('SOURCE MEDIA: ')[1]);
    assert.ok(manifest.length >= 1 && manifest.every(m => Number.isFinite(m.sourceStartSec) && Number.isFinite(m.sourceEndSec)));
    assert.ok(manifest.every(m => m.sourceEndSec <= 112 + 1e-6), 'reel stays inside the scope (out-of-scope branch not sent)');
    assert.ok(!manifest.some(m => m.sourceStartSec < 262 && m.sourceEndSec > 240), 'out-of-scope branch footage is not in the reel');
    // Persisted artifacts: scope first-class, canonical spine carries scope + reel.
    const root = path.join(store.getProjectPaths(dir, projectId).analysisDir, 'auto-story-fast');
    const scopeArtifact = JSON.parse(await fs.readFile(path.join(root, 'story-scope.json'), 'utf8'));
    assert.strictEqual(scopeArtifact.chosen.storyScopeId, 'scope_stop_to_detention');
    const spine = JSON.parse(await fs.readFile(path.join(root, 'story-spine.json'), 'utf8')).spines[0];
    assert.strictEqual(spine.editorialContract, Director.DIRECTOR_CONTRACT);
    assert.strictEqual(spine.storyScope.storyScopeId, 'scope_stop_to_detention');
    // E (integration): compiled script keeps the director's exact order and ranges.
    const script = JSON.parse(await fs.readFile(result.scriptPaths[0], 'utf8'));
    assert.deepStrictEqual(script.segments.map(s => [s.sourceStartSec, s.sourceEndSec]), directorEdl().spine.beats.map(b => [b.sourceStartSec, b.sourceEndSec]));
    const arc = JSON.parse(await fs.readFile(path.join(root, 'retention-arc-1.json'), 'utf8'));
    assert.strictEqual(arc.mode, 'validator_only');
    await fs.rm(dir, { recursive: true, force: true });
  });

  await ok('A: invalid scope (reel over budget / window outside boundary) goes back to Gemini, never into an EDL', async () => {
    const bad = scopeCandidate({ scopeWindows: [{ startSec: 2, endSec: 290, purpose: 'core', why: 'everything' }], explicitScopeBoundary: { startSec: 0, endSec: 120, rationale: 'x' } });
    const report = Scope.validateStoryScope(bad, { durationSec: SOURCE_SEC, targetDurationMinSec: 65, maxScopeReelSec: 200 });
    const codes = report.violations.map(v => v.code);
    assert.ok(codes.includes('SCOPE_REEL_OVER_BUDGET') && codes.includes('SCOPE_WINDOW_OUTSIDE_BOUNDARY'), codes.join(','));
    const engine = fakeEngine([selection([bad]), selection()]);
    engine.config.maxScopeReelSec = 200;
    const out = await Scope.selectStoryScope(engine, MODEL);
    assert.strictEqual(out.attempts.length, 2);
    assert.ok(engine.lastAsks[1].input.violations.some(v => v.code === 'SCOPE_REEL_OVER_BUDGET'), 'repair request carries the violations');
    assert.ok(engine.lastAsks[1].key.includes('repair'));
  });

  // ---------------------------------------------------------------- Story Scope contract (count limits / normalization / repair)
  const MAXW = Scope.SCOPE_LIMITS.scopeWindows.max;
  const nWindows = n => Array.from({ length: n }, (_, i) => ({ windowId: `w${i + 1}`, startSec: 2 + i * 10, endSec: 2 + i * 10 + 8, purposes: ['core'], why: 'x' }));
  // A generic scope whose windows are spread over a long boundary (valid apart from the count under test).
  const wideScope = (n, extra = {}) => scopeCandidate({
    scopeWindows: nWindows(n), explicitScopeBoundary: { startSec: 0, endSec: 2 + n * 10 + 10, rationale: 'x' },
    causalSpine: [{ eventId: 'e1', sourceStartSec: 2, sourceEndSec: 10 }, { eventId: 'e2', sourceStartSec: 12, sourceEndSec: 20 }],
    candidateEndingEvents: [{ eventId: 'eN', sourceStartSec: 2 + (n - 1) * 10, sourceEndSec: 2 + (n - 1) * 10 + 8, endingType: 'forward_cliffhanger' }], ...extra });

  await ok('Scope contract: one source of truth — limit is in the instruction, NOT a schema maxItems, and the validator reports "contains N; maximum M"', async () => {
    assert.ok(Scope.instruction.includes(`scopeWindows 1-${MAXW}`), 'instruction states the scopeWindows limit');
    const winSchema = Scope.schemas.storyScope.properties.scopeWindows;
    assert.strictEqual(winSchema.maxItems, undefined, 'no opaque schema-level array bound');
    const over = wideScope(MAXW + 1);
    SchemaBoundary.validate(selection([over]), Scope.schemas.storyScopeSelection); // schema accepts; the validator decides
    const r = Scope.validateStoryScope(over, { durationSec: SOURCE_SEC, targetDurationMinSec: 65 });
    const v = r.violations.find(x => x.code === 'SCOPE_COUNT_OVER_LIMIT' && x.field === 'scopeWindows');
    assert.ok(v, JSON.stringify(r.violations));
    assert.match(v.message, new RegExp(`scopeWindows contains ${MAXW + 1} unique windows; maximum allowed is ${MAXW}`));
    assert.strictEqual(r.normalizedScope.scopeWindows.length, MAXW + 1, 'nothing truncated in JS');
  });

  await ok('Scope contract: a range with several roles is ONE window (lossless normalization, counted once)', async () => {
    const dupRoles = scopeCandidate({ scopeWindows: [
      { windowId: 'a', startSec: 2, endSec: 84, purpose: 'core' },
      { windowId: 'b', startSec: 60, endSec: 66, purpose: 'hook_material' },
      { windowId: 'c', startSec: 84, endSec: 110, purposes: ['core'] },
      { windowId: 'd', startSec: 84, endSec: 110, purposes: ['ending_material'] }
    ] });
    const r = Scope.validateStoryScope(dupRoles, { durationSec: SOURCE_SEC, targetDurationMinSec: 65 });
    assert.ok(r.valid, JSON.stringify(r.violations));
    assert.strictEqual(r.normalization.declaredCount, 4); assert.strictEqual(r.normalization.uniqueCount, 2);
    const [w1, w2] = r.normalizedScope.scopeWindows;
    assert.deepStrictEqual([w1.startSec, w1.endSec, w1.purposes], [2, 84, ['core', 'hook_material']]);
    assert.ok(w1.purposeRanges.some(p => p.purpose === 'hook_material' && p.startSec === 60 && p.endSec === 66), 'hook sub-range preserved');
    assert.deepStrictEqual(w2.purposes, ['core', 'ending_material']);
    assert.strictEqual(w1.purpose, 'core', 'primary purpose kept for downstream readers');
    // Media is identical before/after normalization.
    assert.deepStrictEqual(Scope.planScopeReel(r.normalizedScope, { durationSec: SOURCE_SEC }).ranges.map(x => [x.sourceStartSec, x.sourceEndSec]),
      Scope.planScopeReel(dupRoles, { durationSec: SOURCE_SEC }).ranges.map(x => [x.sourceStartSec, x.sourceEndSec]));
  });

  await ok('Scope repair: initial over-limit windows -> repair with explicit count + failing candidate -> valid repair is returned', async () => {
    const bad = wideScope(MAXW + 1, { storyScopeId: 'scope_over' });
    const good = wideScope(MAXW, { storyScopeId: 'scope_over' });
    const engine = fakeEngine([selection([bad]), selection([good])]);
    const out = await Scope.selectStoryScope(engine, MODEL);
    assert.strictEqual(out.attempts.length, 2);
    assert.strictEqual(out.attempts[0].valid, false); assert.strictEqual(out.attempts[1].valid, true);
    const repairAsk = engine.lastAsks[1];
    assert.strictEqual(repairAsk.input.failingStoryScopeId, 'scope_over');
    assert.strictEqual(repairAsk.input.previousSelection.candidates[0].scopeWindows.length, MAXW + 1, 'repair receives the failing candidate');
    assert.ok(repairAsk.input.violations.some(v => v.field === 'scopeWindows' && v.count === MAXW + 1 && v.max === MAXW));
    assert.match(repairAsk.instruction, new RegExp(`scopeWindows contains ${MAXW + 1} unique windows; maximum allowed is ${MAXW}`));
    assert.match(repairAsk.instruction, /Returning the same object unchanged will fail again/);
    assert.strictEqual(out.scope.scopeWindows.length, MAXW, 'the repaired selection replaced the invalid one');
    assert.notStrictEqual(out.attempts[0].selectionFingerprint, out.attempts[1].selectionFingerprint);
  });

  await ok('Scope repair: repair #1 still invalid, repair #2 valid -> the SECOND repaired selection is returned', async () => {
    const bad = wideScope(MAXW + 2, { storyScopeId: 's' });
    const stillBad = wideScope(MAXW + 1, { storyScopeId: 's' });
    const good = wideScope(MAXW, { storyScopeId: 's', centralViewerQuestion: 'second repair question' });
    const engine = fakeEngine([selection([bad]), selection([stillBad]), selection([good])]);
    const out = await Scope.selectStoryScope(engine, MODEL);
    assert.deepStrictEqual(out.attempts.map(a => a.valid), [false, false, true]);
    assert.strictEqual(out.scope.centralViewerQuestion, 'second repair question');
    assert.strictEqual(out.scope.scopeWindows.length, MAXW);
    assert.strictEqual(engine.lastAsks[2].input.previousSelection.candidates[0].scopeWindows.length, MAXW + 1, 'repair #2 is given repair #1 output');
    assert.match(engine.lastAsks[2].instruction, new RegExp(`contains ${MAXW + 1} unique windows`));
    // Exhausted: identical invalid output three times -> STORY_SCOPE_INVALID with the explicit violation.
    const stuck = fakeEngine([selection([bad]), selection([bad]), selection([bad])]);
    await assert.rejects(Scope.selectStoryScope(stuck, MODEL), e => e.kind === 'STORY_SCOPE_INVALID' && e.details.violations.some(v => /maximum allowed is/.test(v.message)));
  });

  await ok('Scope contract: an unchosen oversized candidate does not block a valid chosen scope', async () => {
    const engine = fakeEngine([selection([scopeCandidate(), wideScope(MAXW + 3, { storyScopeId: 'alt' })], 'scope_stop_to_detention')]);
    const out = await Scope.selectStoryScope(engine, MODEL);
    assert.strictEqual(out.scope.storyScopeId, 'scope_stop_to_detention');
    assert.deepStrictEqual(Scope.alternateScopes(out.selection, 'scope_stop_to_detention', { durationSec: SOURCE_SEC, targetDurationMinSec: 65 }), [], 'invalid alternate is not used');
  });

  // ---------------------------------------------------------------- D
  await ok('D: an out-of-scope dramatic beat is rejected back to Gemini; Coverage/DurationFit cannot inject it', async () => {
    const scope = scopeCandidate();
    const withOutlier = directorEdl({ beats: [...directorEdl().spine.beats.slice(0, 5), beat('bX', 242, 250, { scopeMembership: 'core' }), directorEdl().spine.beats[5]] });
    const engine = fakeEngine([withOutlier, directorEdl()]);
    const out = await Director.directEdl(engine, { model: MODEL, scope });
    const first = engine.lastAsks[0], second = engine.lastAsks[1];
    assert.ok(second.input.violations.some(v => v.code === 'OUTSIDE_SCOPE_REEL' && v.beatId === 'bX'), 'outside-reel beat is a violation, not silently accepted');
    assert.ok(!out.spine.beats.some(b => b.sourceStartSec >= 240), 'final EDL has no out-of-scope beat');
    assert.ok(first.evidence.length > 0); assert.deepStrictEqual(second.evidence.map(e => e.file), first.evidence.map(e => e.file), 'repair reuses the same reel media');
    // Coverage: director-locked beats are never augmented even when "thin".
    const thin = out.spine.beats.slice(0, 2).map(b => ({ ...b, castReason: 'editorial director explicit edl lock' }));
    const cov = augmentCoverage(thin, MODEL, { targetDurationMinSec: 65, targetDurationMaxSec: 90 });
    assert.strictEqual(cov.augmented, false); assert.strictEqual(cov.beats.length, 2);
    // DurationFit validator-only: reports, never adds the unused dramatic event.
    const fit = durationFit.planDurationFit(thin, { config: { targetDurationMinSec: 65, targetDurationMaxSec: 90 }, model: MODEL, sourceDuration: SOURCE_SEC, validateOnly: true });
    assert.strictEqual(fit.changed, false); assert.strictEqual(fit.impossible, true);
    assert.strictEqual(fit.beats.length, 2); assert.strictEqual(fit.violation.code, 'TOTAL_DURATION_UNDER_MIN');
    // Contrast: the legacy fit WOULD pull unused events (proves the guard matters).
    const legacy = durationFit.planDurationFit(thin.map(b => ({ ...b, castReason: undefined })), { config: { targetDurationMinSec: 65, targetDurationMaxSec: 90 }, model: MODEL, sourceDuration: SOURCE_SEC });
    assert.ok(legacy.changed, 'legacy mode modifies the timeline');
  });

  // ---------------------------------------------------------------- E
  await ok('E: buildScript never reorders / re-roles / re-times a director EDL (teaser-before-rewind preserved)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-e-'));
    const engine = fakeEngine([]);
    const scope = scopeCandidate();
    const reel = Scope.planScopeReel(scope, { durationSec: SOURCE_SEC });
    const spine = Director.stampSpine(directorEdl().spine, scope, reel);
    const story = { ...spine, scriptId: 1, title: 't', spine: {}, openLoops: [] };
    const { script } = await Pipeline.buildScript(engine, {}, {}, story, MODEL, dir, () => {});
    assert.deepStrictEqual(script.segments.map(s => s.sourceStartSec), spine.beats.map(b => b.sourceStartSec));
    assert.deepStrictEqual(script.segments.map(s => s.narrativeRoleV3), spine.beats.map(b => b.narrativeRole));
    assert.strictEqual(script.segments[0].storyRole, 'hook');
    // A mutated beat list is detected as an integrity failure.
    assert.throws(() => Director.assertEdlIntact(spine.beats, [...spine.beats].reverse()), e => e.kind === 'EDL_MUTATED');
    assert.throws(() => Director.assertEdlIntact(spine.beats, spine.beats.map((b, i) => i === 2 ? { ...b, sourceEndSec: b.sourceEndSec + 1 } : b)), e => e.kind === 'EDL_MUTATED');
    await fs.rm(dir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- F
  await ok('F: a duration failure goes back to Gemini (director) — JS selects no source material', async () => {
    // F1: director-level validation.
    const short = directorEdl({ beats: directorEdl().spine.beats.map(b => ({ ...b, sourceEndSec: b.sourceStartSec + 4 })) });
    const engine = fakeEngine([short, directorEdl()]);
    const out = await Director.directEdl(engine, { model: MODEL, scope: scopeCandidate() });
    assert.ok(engine.lastAsks[1].input.violations.some(v => v.code === 'TOTAL_DURATION_UNDER_MIN'));
    assert.ok(engine.lastAsks[1].input.currentEdl, 'repair receives the current EDL');
    assert.ok(Director.timelineSec(out.spine.beats) >= 65);
    // F2: downstream (buildScript) duration finding -> DIRECTOR_REPAIR_REQUIRED, not a JS edit.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-f-'));
    const scope = scopeCandidate();
    const spine = Director.stampSpine(short.spine, scope, Scope.planScopeReel(scope, { durationSec: SOURCE_SEC }));
    await assert.rejects(Pipeline.buildScript(fakeEngine([]), {}, {}, { ...spine, scriptId: 1, spine: {}, openLoops: [] }, MODEL, dir, () => {}),
      e => e.kind === 'DIRECTOR_REPAIR_REQUIRED' && e.details.violations[0].code === 'TOTAL_DURATION_UNDER_MIN');
    // F3: the downstream routing helper used by run() and auditDrafts sends the finding
    // back to the director (repairTechnical) with the violations, then rebuilds from the
    // DIRECTOR's repaired EDL — JS never edits the story itself.
    const seen = { builds: [], repairs: [] };
    const good = Director.stampSpine(directorEdl().spine, scope, Scope.planScopeReel(scope, { durationSec: SOURCE_SEC }));
    const outcome = await Pipeline.buildDirectorScript({ engine: fakeEngine([]), service: {}, opts: {}, model: MODEL, root: dir, emit: () => {}, scriptId: 1 },
      { ...spine, scriptId: 1 }, {
        build: async (_e, _s, _o, story) => { seen.builds.push(story.beats.map(b => b.sourceEndSec)); if (seen.builds.length === 1) throw Object.assign(new Error('short'), { kind: 'DIRECTOR_REPAIR_REQUIRED', details: { violations: [{ code: 'TOTAL_DURATION_UNDER_MIN' }] } }); return { script: 'ok' }; },
        repair: async (_e, args) => { seen.repairs.push(args); return { spine: good }; }
      });
    assert.strictEqual(seen.repairs.length, 1);
    assert.strictEqual(seen.repairs[0].violations[0].code, 'TOTAL_DURATION_UNDER_MIN');
    assert.strictEqual(seen.repairs[0].spine.storyScope.storyScopeId, scope.storyScopeId, 'repair gets the scope-bearing spine');
    assert.deepStrictEqual(seen.builds[1], good.beats.map(b => b.sourceEndSec), 'rebuild uses the director-repaired EDL');
    assert.strictEqual(outcome.repairedSpine, good);
    // Non-routable errors (code bugs such as EDL_MUTATED) are NOT papered over by a repair.
    await assert.rejects(Pipeline.buildDirectorScript({ engine: fakeEngine([]), service: {}, opts: {}, model: MODEL, root: dir, emit: () => {}, scriptId: 1 }, { ...spine, scriptId: 1 },
      { build: async () => { throw Object.assign(new Error('mut'), { kind: 'EDL_MUTATED' }); }, repair: async () => { throw new Error('must not repair'); } }), e => e.kind === 'EDL_MUTATED');
    await fs.rm(dir, { recursive: true, force: true });
  });

  await ok('F/budget: realistic narrated run fits the DEFAULT 16-call budget; director voiceover choice is honoured', async () => {
    const p = await makeProject();
    await p.store.updateProject(p.dir, p.projectId, { autoStoryConfig: { targetDurationMinSec: 65, targetDurationMaxSec: 90, outputCount: 1, audioBalance: 'balanced' } });
    const narrated = directorEdl({ beats: directorEdl().spine.beats.map(b => (b.beatId === 'b2' ? { ...b, audioMode: 'voiceover_with_ambient', wantsNarration: true, narratorFunction: 'CONTEXT', narrationIntent: 'Who called and why' } : b)) });
    const vertex = makeVertex({ scope: selection(), director: narrated,
      narration: { accessGranted: true, narrations: [{ beatId: 'b2', voiceoverText: 'A caller reported a car swerving.', previewVi: 'x', narratorFunction: 'CONTEXT', newInformation: ['call'], newInformationRefs: ['e1'], emotionTag: 'NEUTRAL' }] } });
    const service = new Service({}, p.store, { vertex, ffmpeg: makeFfmpeg(), dubbing: {}, callBudget: { calls: 0, runId: 't16' } });
    service.measuredVoice = async () => ({ meta: { duration: 6 } });
    const res = await Pipeline.run(service, { workspaceRoot: p.dir, projectId: p.projectId, onProgress: () => {} });
    assert.deepStrictEqual(res.failures, [], JSON.stringify(res.failures));
    const script = JSON.parse(await fs.readFile(res.scriptPaths[0], 'utf8'));
    const seg = script.segments[1];
    assert.notStrictEqual(seg.audio_mode, 'original_audio', 'director voiceover choice survives');
    assert.match(seg.voiceover_text, /caller/);
    assert.ok(service.callBudget.calls <= 16, `calls used ${service.callBudget.calls}`);
    await fs.rm(p.dir, { recursive: true, force: true });
  });

  await ok('Narration disabled: director voiceover beats are rejected back to the director (not silently re-roled)', async () => {
    const vo = directorEdl({ beats: directorEdl().spine.beats.map(b => (b.beatId === 'b2' ? { ...b, audioMode: 'voiceover_with_ambient' } : b)) });
    const engine = fakeEngine([vo, directorEdl()]);
    await Director.directEdl(engine, { model: MODEL, scope: scopeCandidate() });
    assert.strictEqual(engine.lastAsks[0].input.narrationEnabled, false);
    assert.ok(engine.lastAsks[1].input.violations.some(v => v.code === 'NARRATION_DISABLED' && v.beatId === 'b2'));
  });

  await ok('Coverage honours the director castLock marker on its own', async () => {
    const locked = directorEdl().spine.beats.slice(0, 2).map(b => ({ ...b, castLock: Director.DIRECTOR_CONTRACT }));
    const cov = augmentCoverage(locked, MODEL, { targetDurationMinSec: 65, targetDurationMaxSec: 90 });
    assert.strictEqual(cov.augmented, false); assert.strictEqual(cov.beats.length, 2);
  });

  // ---------------------------------------------------------------- G
  await ok('G: exact duplicate guard stays active (director validation AND compileV3)', async () => {
    const beats = directorEdl().spine.beats;
    const dup = [...beats.slice(0, 4), { ...beats[3], beatId: 'b4dup' }, ...beats.slice(4)];
    const report = Director.validateDirectorEdl({ beats: dup }, scopeCandidate(), { durationSec: SOURCE_SEC, reel: Scope.planScopeReel(scopeCandidate(), { durationSec: SOURCE_SEC }) });
    assert.ok(report.violations.some(v => v.code === 'EXACT_EDL_DUPLICATE'));
    // Partial in-context replay of the hook (not exact) is allowed.
    const replay = Director.validateDirectorEdl({ beats }, scopeCandidate(), { durationSec: SOURCE_SEC, reel: Scope.planScopeReel(scopeCandidate(), { durationSec: SOURCE_SEC }) });
    assert.ok(replay.valid, JSON.stringify(replay.violations));
    const evidence = [{ id: 'clip', sourceStart: 0, duration: SOURCE_SEC }];
    assert.throws(() => compileV3(dup.map(b => ({ ...b, audioStrategy: 'original' })), { story: { scriptId: 1 }, evidence, config: { targetDurationMinSec: 65, targetDurationMaxSec: 90, narration: {} }, sourceDuration: SOURCE_SEC }),
      e => /duplicate footage/i.test(e.message));
  });

  // ---------------------------------------------------------------- H
  await ok('H: critic finding -> repair receives scope + complete EDL + weak region + scope media; accepted EDL persisted', async () => {
    const p = await makeProject();
    const renderedFiles = [];
    const dubbing = {
      importReviewedScriptProject: async ({ jsonPath }) => {
        const cur = await p.store.getProject(p.dir, p.projectId);
        return { ...cur, analysis: { highlightVariants: [{ id: 'v1', scriptId: 1, segments: JSON.parse(await fs.readFile(jsonPath, 'utf8')).segments, artifacts: {} }] } };
      },
      renderHighlightFastDraft: async () => { const f = path.join(p.dir, `draft-${renderedFiles.length + 2}.mp4`); await fs.writeFile(f, 'mp4'); renderedFiles.push(f); return { outputPath: f }; }
    };
    const blocking = { scopeSurvived: true, centralQuestionActiveThroughout: true, endingIsConsequenceOfCentralConflict: true, finalFootageUsable: true, observedStory: 'x',
      issues: [{ type: 'low_value_stretch', severity: 'blocking', outputStartSec: 30, outputEndSec: 40, evidence: 'the same exchange repeats', whyItFails: 'adds nothing to the question' }], summary: 'one weak stretch' };
    const clean = { ...blocking, issues: [], summary: 'coherent' };
    const repairedEdl = directorEdl({ beats: directorEdl().spine.beats.map(b => (b.beatId === 'b4' ? { ...b, sourceStartSec: 38, sourceEndSec: 54 } : b)) });
    const vertex = makeVertex({ scope: selection(), director: n => (n === 1 ? directorEdl() : repairedEdl), scope_critic: n => (n === 1 ? blocking : clean) });
    const service = makeService(p.store, vertex, makeFfmpeg(), dubbing);
    const run = await Pipeline.run(service, { workspaceRoot: p.dir, projectId: p.projectId, onProgress: () => {} });
    assert.deepStrictEqual(run.failures, []);
    const first = path.join(p.dir, 'draft-1.mp4'); await fs.writeFile(first, 'mp4');
    await p.store.updateProject(p.dir, p.projectId, { analysis: { highlightVariants: [{ id: 'v1', scriptId: 1, artifacts: { fastDraftVideoPath: first } }] } });
    const res = await Pipeline.auditDrafts(makeService(p.store, vertex, makeFfmpeg(), dubbing), { workspaceRoot: p.dir, projectId: p.projectId, scriptId: 1, onProgress: () => {} });
    const audit = res.audits[0];
    assert.strictEqual(audit.finalCheck.verdict, 'PASS', JSON.stringify(audit));
    assert.strictEqual(audit.repairPasses, 1);
    const repairCall = vertex.calls.filter(c => c.kind === 'director')[1];
    assert.ok(repairCall.filePaths.length >= 1, 'repair watches the scope reel media');
    assert.match(repairCall.prompt, /TARGETED EDITORIAL REPAIR/);
    assert.match(repairCall.prompt, /"storyScopeId":"scope_stop_to_detention"/, 'repair receives the scope');
    assert.match(repairCall.prompt, /"currentEdl":\{/, 'repair receives the complete current EDL');
    assert.match(repairCall.prompt, /"weakRegions":\[\{"type":"low_value_stretch","outputStartSec":30,"outputEndSec":40,"beatIds":\["b4"/, 'repair receives the mapped weak region');
    const root = path.join(p.store.getProjectPaths(p.dir, p.projectId).analysisDir, 'auto-story-fast');
    const canonical = JSON.parse(await fs.readFile(path.join(root, 'story-spine.json'), 'utf8')).spines[0];
    assert.strictEqual(canonical.beats.find(b => b.beatId === 'b4').sourceStartSec, 38, 'accepted repaired EDL persisted canonically');
    assert.strictEqual(canonical.storyScope.storyScopeId, 'scope_stop_to_detention');
    // The critic watched the ACTUAL rendered MP4 of the repaired EDL.
    const criticCalls = vertex.calls.filter(c => c.kind === 'scope_critic');
    assert.deepStrictEqual(criticCalls.map(c => c.filePaths[0]), [first, renderedFiles[0]]);
    await fs.rm(p.dir, { recursive: true, force: true });
  });

  await ok('Critic: verdicts/issues map to beat ids; false ending verdict yields a repairable blocking region', async () => {
    const scope = scopeCandidate();
    const spine = Director.stampSpine(directorEdl().spine, scope, Scope.planScopeReel(scope, { durationSec: SOURCE_SEC }));
    const tl = Critic.outputTimeline(spine, null);
    const n = Critic.normalizeCritique({ scopeSurvived: true, centralQuestionActiveThroughout: true, endingIsConsequenceOfCentralConflict: false, finalFootageUsable: true, observedStory: '', issues: [], summary: '' }, { durationSec: 72, timeline: tl });
    assert.strictEqual(n.isCompliant, false);
    assert.deepStrictEqual(n.weakRegions[0].beatIds, ['b6']);
    const q = Critic.normalizeCritique({ scopeSurvived: true, centralQuestionActiveThroughout: false, endingIsConsequenceOfCentralConflict: true, finalFootageUsable: true, observedStory: '', issues: [{ type: 'low_value_stretch', severity: 'minor', outputStartSec: 10, outputEndSec: 12, evidence: '', whyItFails: '' }], summary: '' }, { durationSec: 72, timeline: tl });
    assert.strictEqual(q.isCompliant, false);
    assert.ok(q.weakRegions.length >= 1 && q.weakRegions[0].beatIds.length === tl.length, 'a question-lost verdict still yields a repair region');
    const bad = Critic.normalizeCritique({ scopeSurvived: 'yes', issues: [] }, { durationSec: 72, timeline: tl });
    assert.strictEqual(bad.status, 'MEDIA_CRITIC_INVALID');
  });

  await ok('Schema/shape failure (e.g. director did not watch the reel) is repaired by the director, not fatal', async () => {
    const notWatched = { ...directorEdl(), accessGranted: false };
    const engine = fakeEngine([notWatched, directorEdl()]);
    const out = await Director.directEdl(engine, { model: MODEL, scope: scopeCandidate() });
    assert.ok(engine.lastAsks[1].input.violations.some(v => v.code === 'SCHEMA_INVALID'));
    assert.strictEqual(out.spine.editorialContract, Director.DIRECTOR_CONTRACT);
    // Exhausted repairs -> DIRECTOR_EDL_INVALID (run() records a failure; no JS fallback EDL).
    const bad = fakeEngine([notWatched, notWatched, notWatched]);
    await assert.rejects(Director.directEdl(bad, { model: MODEL, scope: scopeCandidate() }), e => e.kind === 'DIRECTOR_EDL_INVALID');
  });

  // ---------------------------------------------------------------- I
  await ok('I: legacy paths unchanged (contract 3, and contract 4 with legacy_v4 opt-out) use text-only Story Design, no scope pass', async () => {
    for (const cfg of [{ contractVersion: 3 }, { contractVersion: 4, architecture: 'legacy_v4' }]) {
      const p = await makeProject(cfg);
      const vertex = makeVertex({ legacy_design: { accessGranted: true, spines: [] }, scope: selection(), director: directorEdl() });
      const res = await Pipeline.run(makeService(p.store, vertex, makeFfmpeg()), { workspaceRoot: p.dir, projectId: p.projectId, onProgress: () => {} });
      const kinds = vertex.calls.map(c => c.kind);
      assert.ok(kinds.includes('legacy_design'), `legacy design ran for ${JSON.stringify(cfg)}`);
      assert.ok(!kinds.includes('scope') && !kinds.includes('director'), `no scope/director calls for ${JSON.stringify(cfg)}: ${kinds}`);
      assert.strictEqual(res.failures[0].kind, 'STORY_DESIGN_INVALID');
      await fs.rm(p.dir, { recursive: true, force: true });
    }
    assert.strictEqual(Pipeline.editorialArchitecture({ autoStoryContractVersion: 4 }), Pipeline.SCOPE_MEDIA_DIRECTOR);
    assert.strictEqual(Pipeline.editorialArchitecture({ autoStoryContractVersion: 3 }), 'legacy_text_design');
  });

  // ---------------------------------------------------------------- overfitting guard
  await ok('No benchmark-specific literals in production AutoStory code', async () => {
    const dirs = [path.join(__dirname, '..', 'electron')];
    const forbidden = /\b(mother|daughter|bathroom|doorway|lawn|boyfriend|nathan|melody|nightmare|georgia)\b|\b(46\.5|223\.8|431\.6|749\.4|1327\.7|1410\.7)\b/i;
    // Pre-existing generic relationship lexicon of the movie-recap fact guard (not AutoStory, not benchmark-derived).
    const allow = [/^viralIntelligenceService\.js:\d+: \{ term: "mother", aliases: \["mother", "mom", "nguoi me"\], category: "relationship" \},/];
    const hits = [];
    const walk = d => { for (const e of fsSync.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.js')) fsSync.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (forbidden.test(l)) hits.push(`${path.basename(f)}:${i + 1}: ${l.trim()}`); }); } };
    dirs.forEach(walk);
    const real = hits.filter(h => !allow.some(a => a.test(h)));
    assert.deepStrictEqual(real, [], real.join('\n'));
  });

  console.log(`\n${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
