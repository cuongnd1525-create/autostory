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
const Packer = require(svc('scopeReelPacker.js'));

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
      calls.push({ kind, prompt: p, filePaths: args.filePaths || [], args });
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
    createAnalysisProxyChunk: async ({ outputPath, durationSec }) => { await fs.writeFile(outputPath, 'proxy'); durations.set(outputPath, durationSec); },
    reels: [],
    async createScopeReel({ entries, outputPath }) {
      await fs.writeFile(outputPath, 'reel');
      const d = entries.reduce((n, e) => n + (e.sourceEndSec - e.sourceStartSec), 0);
      durations.set(outputPath, d); durations.set(outputPath.replace(/\.\d+\.tmp\.mp4$/, ''), d);
      this.reels.push(entries); return true;
    }
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

async function makeProjectCache(dir) {
  const base = path.join(dir, '.cineviral', 'auto-story-source');
  const [hash] = await fs.readdir(base);
  return path.join(base, hash, 'source-contract-v3');
}

// Fake engine for unit-level director/scope tests (no disk, no provider).
const FAKE_CACHE = fsSync.mkdtempSync(path.join(os.tmpdir(), 'scope-cache-'));
function fakeEngine(asks) {
  return {
    duration: SOURCE_SEC,
    cache: FAKE_CACHE,
    project: { sourceVideoPath: '/src/source.mp4' },
    service: { ffmpeg: makeFfmpeg() },
    cues: [],
    config: { targetDurationMinSec: 65, targetDurationMaxSec: 90, narration: { enabled: false, measuredWordsPerSecond: 2.5 } },
    prepared: [],
    async prepare(ranges) { this.prepared.push(ranges); return ranges.map((r, i) => ({ id: `clip${i}`, file: `/reel/clip${i}.mp4`, sourceStart: r.sourceStartSec, duration: r.sourceEndSec - r.sourceStartSec, transcript: [] })); },
    async ask(key, input, schema, instruction, evidence, validate, task, options) {
      const r = asks.shift();
      this.lastAsks = (this.lastAsks || []).concat([{ key, input, instruction, evidence, options }]);
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
    assert.ok(manifest.length >= 1 && manifest.length <= 10 && manifest.every(m => m.composite && m.segments.length >= 1));
    const segs = manifest.flatMap(m => m.segments);
    assert.ok(segs.every(g => Number.isFinite(g.sourceStartSec) && Number.isFinite(g.reelStartSec) && g.scopeWindowId));
    assert.ok(segs.every(g => g.sourceEndSec <= 112 + 1e-6), 'reel stays inside the scope (out-of-scope branch not sent)');
    assert.ok(!segs.some(g => g.sourceStartSec < 262 && g.sourceEndSec > 240), 'out-of-scope branch footage is not in the reel');
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
    // 12 short (non-compactable) windows totalling more media than the budget, most outside the boundary.
    const bad = scopeCandidate({ scopeWindows: Array.from({ length: 12 }, (_, i) => ({ startSec: 2 + i * 24, endSec: 22 + i * 24, purpose: 'core', why: 'x' })), explicitScopeBoundary: { startSec: 0, endSec: 120, rationale: 'x' } });
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
  const MAXE = Scope.SCOPE_LIMITS.candidateEndingEvents.max;
  const nWindows = n => Array.from({ length: n }, (_, i) => ({ windowId: `w${i + 1}`, startSec: 2 + i * 10, endSec: 2 + i * 10 + 8, purposes: ['core'], why: 'x' }));
  // A generic scope with n logical windows spread over a long boundary.
  const wideScope = (n, extra = {}) => scopeCandidate({
    scopeWindows: nWindows(n), explicitScopeBoundary: { startSec: 0, endSec: 2 + n * 10 + 10, rationale: 'x' },
    causalSpine: [{ eventId: 'e1', sourceStartSec: 2, sourceEndSec: 10 }, { eventId: 'e2', sourceStartSec: 12, sourceEndSec: 20 }],
    candidateEndingEvents: [{ eventId: 'eN', sourceStartSec: 2 + (n - 1) * 10, sourceEndSec: 2 + (n - 1) * 10 + 8, endingType: 'forward_cliffhanger' }], ...extra });
  const endings = n => Array.from({ length: n }, (_, i) => ({ eventId: `e${i}`, sourceStartSec: 96 + i, sourceEndSec: 97 + i, endingType: 'forward_cliffhanger' }));

  await ok('Scope contract: limits have one source of truth (instruction + validator, no opaque schema maxItems); "contains N; maximum M"', async () => {
    assert.ok(Scope.instruction.includes(`candidateEndingEvents 1-${MAXE}`), 'instruction states the limit');
    assert.ok(Scope.instruction.includes('scopeWindows >= 1 (no count cap)'), 'logical windows are not count-capped');
    assert.strictEqual(Scope.schemas.storyScope.properties.scopeWindows.maxItems, undefined);
    assert.strictEqual(Scope.schemas.storyScope.properties.candidateEndingEvents.maxItems, undefined);
    const over = scopeCandidate({ candidateEndingEvents: endings(MAXE + 1) });
    SchemaBoundary.validate(selection([over]), Scope.schemas.storyScopeSelection); // schema accepts; the validator decides
    const r = Scope.validateStoryScope(over, { durationSec: SOURCE_SEC, targetDurationMinSec: 65 });
    const v = r.violations.find(x => x.code === 'SCOPE_COUNT_OVER_LIMIT' && x.field === 'candidateEndingEvents');
    assert.ok(v, JSON.stringify(r.violations));
    assert.match(v.message, new RegExp(`candidateEndingEvents contains ${MAXE + 1} items; maximum allowed is ${MAXE}`));
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
    // No footage is sent twice: media segments never overlap.
    const segs = Scope.planScopeReel(r.normalizedScope, { durationSec: SOURCE_SEC }).ranges;
    for (let i = 1; i < segs.length; i++) assert.ok(segs[i].sourceStartSec >= segs[i - 1].sourceEndSec - 1e-6);
  });

  await ok('Scope repair: initial over-limit -> repair with explicit count + failing candidate -> valid repair is returned', async () => {
    const bad = scopeCandidate({ storyScopeId: 'scope_over', candidateEndingEvents: endings(MAXE + 1) });
    const good = scopeCandidate({ storyScopeId: 'scope_over', candidateEndingEvents: endings(MAXE) });
    const engine = fakeEngine([selection([bad]), selection([good])]);
    const out = await Scope.selectStoryScope(engine, MODEL);
    assert.deepStrictEqual(out.attempts.map(a => a.valid), [false, true]);
    const repairAsk = engine.lastAsks[1];
    assert.strictEqual(repairAsk.input.failingStoryScopeId, 'scope_over');
    assert.strictEqual(repairAsk.input.previousSelection.candidates[0].candidateEndingEvents.length, MAXE + 1, 'repair receives the failing candidate');
    assert.ok(repairAsk.input.violations.some(v => v.field === 'candidateEndingEvents' && v.count === MAXE + 1 && v.max === MAXE));
    assert.match(repairAsk.instruction, new RegExp(`candidateEndingEvents contains ${MAXE + 1} items; maximum allowed is ${MAXE}`));
    assert.match(repairAsk.instruction, /Returning the same object unchanged will fail again/);
    assert.strictEqual(out.scope.candidateEndingEvents.length, MAXE, 'the repaired selection replaced the invalid one');
    assert.notStrictEqual(out.attempts[0].selectionFingerprint, out.attempts[1].selectionFingerprint);
  });

  await ok('Scope repair: repair #1 still invalid, repair #2 valid -> the SECOND repaired selection is returned', async () => {
    const bad = scopeCandidate({ storyScopeId: 's', candidateEndingEvents: endings(MAXE + 2) });
    const stillBad = scopeCandidate({ storyScopeId: 's', candidateEndingEvents: endings(MAXE + 1) });
    const good = scopeCandidate({ storyScopeId: 's', centralViewerQuestion: 'second repair question' });
    const engine = fakeEngine([selection([bad]), selection([stillBad]), selection([good])]);
    const out = await Scope.selectStoryScope(engine, MODEL);
    assert.deepStrictEqual(out.attempts.map(a => a.valid), [false, false, true]);
    assert.strictEqual(out.scope.centralViewerQuestion, 'second repair question');
    assert.strictEqual(engine.lastAsks[2].input.previousSelection.candidates[0].candidateEndingEvents.length, MAXE + 1, 'repair #2 is given repair #1 output');
    assert.match(engine.lastAsks[2].instruction, new RegExp(`contains ${MAXE + 1} items`));
    const stuck = fakeEngine([selection([bad]), selection([bad]), selection([bad])]);
    await assert.rejects(Scope.selectStoryScope(stuck, MODEL), e => e.kind === 'STORY_SCOPE_INVALID' && e.details.violations.some(v => /maximum allowed is/.test(v.message)));
  });

  await ok('Scope contract: an unchosen invalid candidate does not block a valid chosen scope', async () => {
    const engine = fakeEngine([selection([scopeCandidate(), scopeCandidate({ storyScopeId: 'alt', candidateEndingEvents: endings(MAXE + 3) })], 'scope_stop_to_detention')]);
    const out = await Scope.selectStoryScope(engine, MODEL);
    assert.strictEqual(out.scope.storyScopeId, 'scope_stop_to_detention');
    assert.deepStrictEqual(Scope.alternateScopes(out.selection, 'scope_stop_to_detention', { durationSec: SOURCE_SEC, targetDurationMinSec: 65 }), [], 'invalid alternate is not used');
  });

  // ---------------------------------------------------------------- media packing (logical windows vs reel files)
  const MAXF = Packer.PROVIDER_MAX_VIDEO_FILES;
  await ok('Pack A: 13 logical scopeWindows are a VALID Story Scope (no count cap on editorial windows)', async () => {
    const r = Scope.validateStoryScope(wideScope(13), { durationSec: SOURCE_SEC, targetDurationMinSec: 65 });
    assert.ok(r.valid, JSON.stringify(r.violations));
    assert.strictEqual(r.normalization.uniqueCount, 13);
    assert.ok(!r.violations.some(v => v.field === 'scopeWindows'));
  });

  await ok('Pack B/C: 13 logical windows pack into <= provider-limit reel files; manifest maps every segment to exact source time', async () => {
    const scope = wideScope(13);
    const reel = Scope.planScopeReel(scope, { durationSec: SOURCE_SEC });
    assert.ok(reel.fileCount <= MAXF, `files ${reel.fileCount}`);
    assert.strictEqual(reel.logicalWindowCount, 13);
    assert.strictEqual(new Set(reel.manifest.map(m => m.scopeWindowId)).size, 13, 'every logical window keeps its identity');
    for (const f of reel.files) {
      const rows = reel.manifest.filter(m => m.reelFile === f.reelId);
      let cursor = 0;
      for (const m of rows) {
        assert.ok(Math.abs(m.reelStartSec - cursor) < 1e-6, 'segments are contiguous in reel time');
        assert.ok(Math.abs((m.reelEndSec - m.reelStartSec) - (m.sourceEndSec - m.sourceStartSec)) < 1e-6, 'reel length == source length');
        const win = scope.scopeWindows.find(w => w.windowId === m.scopeWindowId);
        assert.ok(m.sourceStartSec <= win.startSec + 1e-6 && m.sourceEndSec >= win.endSec - 1e-6, 'segment covers its whole (uncompacted) window');
        const mid = (m.reelStartSec + m.reelEndSec) / 2;
        const back = Packer.reelToSource(reel, f.reelId, mid);
        assert.strictEqual(back.scopeWindowId, m.scopeWindowId);
        assert.ok(Math.abs(back.sourceSec - (m.sourceStartSec + (mid - m.reelStartSec))) < 0.01);
        cursor = m.reelEndSec;
      }
      assert.ok(Math.abs(cursor - f.durationSec) < 1e-6);
    }
  });

  await ok('Pack D: two distant windows packed into the SAME reel file remain separate logical windows', async () => {
    const scope = scopeCandidate({ scopeWindows: [{ windowId: 'near', startSec: 10, endSec: 20, purposes: ['core'] }, { windowId: 'far', startSec: 200, endSec: 212, purposes: ['ending_material'] }] });
    const reel = Scope.planScopeReel(scope, { durationSec: SOURCE_SEC, maxReelFiles: 1 });
    assert.strictEqual(reel.fileCount, 1);
    const [a, b] = reel.manifest;
    assert.deepStrictEqual([a.reelFile, a.scopeWindowId, a.sourceStartSec, a.sourceEndSec], ['reel_01', 'near', 8, 22]);
    assert.deepStrictEqual([b.reelFile, b.scopeWindowId, b.sourceStartSec, b.sourceEndSec], ['reel_01', 'far', 198, 214]);
    assert.strictEqual(b.reelStartSec, a.reelEndSec);
    assert.deepStrictEqual(Packer.reelToSource(reel, 'reel_01', a.reelEndSec + 1), { sourceSec: 199, scopeWindowId: 'far', segmentId: 'far' });
  });

  await ok('Pack: a broad window is compacted for MEDIA only (event/quote anchored); the logical window is unchanged', async () => {
    const events = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, startSec: 60 + i * 20, endSec: 62 + i * 20 }));
    const broad = scopeCandidate({ scopeWindows: [{ windowId: 'broad', startSec: 50, endSec: 230, purposes: ['core'] }, { windowId: 'end', startSec: 230, endSec: 240, purposes: ['ending_material'] }],
      explicitScopeBoundary: { startSec: 0, endSec: 250, rationale: 'x' }, candidateEndingEvents: [{ sourceStartSec: 232, sourceEndSec: 238, endingType: 'forward_cliffhanger' }],
      causalSpine: [{ eventId: 'x0', sourceStartSec: 60, sourceEndSec: 62 }, { eventId: 'x5', sourceStartSec: 160, sourceEndSec: 162 }] });
    const reel = Scope.planScopeReel(broad, { durationSec: SOURCE_SEC, maxScopeReelSec: 150, model: { events, quotes: [] } });
    assert.ok(reel.withinBudget && reel.totalSec <= 150, `media ${reel.totalSec}s`);
    assert.deepStrictEqual(reel.compactedWindowIds, ['broad']);
    const parts = reel.manifest.filter(m => m.scopeWindowId === 'broad');
    assert.ok(parts.length > 1 && parts.every(p => p.compacted && p.windowStartSec === 50 && p.windowEndSec === 230));
    assert.ok(parts.some(p => p.sourceStartSec <= 50) && parts.some(p => p.sourceEndSec >= 230), 'head and tail context kept');
    assert.ok(events.every(e => parts.some(p => p.sourceStartSec <= e.startSec && p.sourceEndSec >= e.endSec)), 'every event inside the window is in the media');
    assert.ok(reel.fileCount <= MAXF);
    // Without budget pressure the same window is sent whole.
    assert.deepStrictEqual(Scope.planScopeReel(broad, { durationSec: SOURCE_SEC, model: { events, quotes: [] } }).compactedWindowIds, []);
    // Validation uses the PACKED media: valid when compaction fits the budget.
    assert.ok(Scope.validateStoryScope(broad, { durationSec: SOURCE_SEC, targetDurationMinSec: 65, maxScopeReelSec: 150, model: { events, quotes: [] } }).valid);
  });

  await ok('Pack E/F: director receives <= provider-limit packed files + full manifest; the file limit never caps scope windows', async () => {
    const scope = wideScope(25, { explicitScopeBoundary: { startSec: 0, endSec: 290, rationale: 'x' } });
    assert.ok(Scope.validateStoryScope(scope, { durationSec: SOURCE_SEC, targetDurationMinSec: 65 }).valid, 'a 25-window scope is valid');
    const beats = [
      beat('b1', 102, 108, { chronologyMode: 'teaser', narrativeRole: 'teaser_conflict', scopeMembership: 'hook' }),
      ...Array.from({ length: 9 }, (_, i) => beat(`c${i}`, 2 + i * 10, 2 + i * 10 + 8)),
      beat('end', 242, 250, { narrativeRole: 'cliffhanger', scopeMembership: 'ending' })
    ];
    const engine = fakeEngine([{ ...directorEdl(), spine: { ...directorEdl().spine, beats } }]);
    const out = await Director.directEdl(engine, { model: MODEL, scope: { ...scope, candidateEndingEvents: [{ sourceStartSec: 242, sourceEndSec: 250, endingType: 'forward_cliffhanger' }] } });
    const ask = engine.lastAsks[0];
    assert.ok(ask.evidence.length <= MAXF && ask.evidence.length >= 1, `files ${ask.evidence.length}`);
    assert.ok(ask.evidence.every(e => e.composite && e.segments.length >= 1));
    assert.strictEqual(ask.evidence.reduce((n, e) => n + e.segments.length, 0), 25, 'all 25 windows present across the packed files');
    assert.strictEqual(ask.input.scopeReelManifest.length, 25, 'full mapping manifest in the director input');
    assert.ok(ask.input.scopeReelManifest.every(m => m.reelFile && Number.isFinite(m.reelStartSec) && Number.isFinite(m.sourceStartSec) && m.scopeWindowId));
    assert.strictEqual(out.spine.scopeReel.fileCount, ask.evidence.length);
    // The provider limit is enforced on reel FILES only.
    const reel = Scope.planScopeReel(scope, { durationSec: SOURCE_SEC });
    await assert.rejects(Packer.buildReelFiles(engine, { ...reel, fileCount: MAXF + 1, maxReelFiles: MAXF }), /provider limit is 10/);
  });

  await ok('Pack G: no EDL beat may map outside the original logical scope windows (context padding / compaction gaps are not cuttable)', async () => {
    const scope = scopeCandidate({ scopeWindows: [{ windowId: 'a', startSec: 10, endSec: 60, purposes: ['core'] }, { windowId: 'z', startSec: 200, endSec: 240, purposes: ['core', 'ending_material'] }],
      explicitScopeBoundary: { startSec: 0, endSec: 250, rationale: 'x' }, candidateEndingEvents: [{ sourceStartSec: 230, sourceEndSec: 240, endingType: 'forward_cliffhanger' }] });
    const reel = Scope.planScopeReel(scope, { durationSec: SOURCE_SEC });
    const v = beats => Director.validateDirectorEdl({ beats }, scope, { durationSec: SOURCE_SEC, targetDurationMinSec: 1, targetDurationMaxSec: 300, reel });
    const hook = beat('h', 20, 26, { chronologyMode: 'teaser', narrativeRole: 'teaser_conflict' });
    const end = beat('e', 232, 238, { narrativeRole: 'cliffhanger' });
    assert.ok(v([hook, beat('in', 30, 40), end]).valid, 'inside logical windows is fine');
    const pad = v([hook, beat('pad', 8, 12), end]); // 8-10 is context padding of window 'a'
    assert.ok(pad.violations.some(x => x.code === 'OUTSIDE_SCOPE_REEL' && x.beatId === 'pad'));
    const gap = v([hook, beat('gap', 100, 110), end]); // between windows
    assert.ok(gap.violations.some(x => x.code === 'OUTSIDE_SCOPE_REEL' && x.beatId === 'gap'));
    const span = v([hook, beat('span', 55, 205), end]); // spans two distant segments
    assert.ok(span.violations.some(x => x.code === 'OUTSIDE_SCOPE_REEL' && x.beatId === 'span'));
  });

  // ---------------------------------------------------------------- duration control (target band, lightweight repair, technical adjustment)
  const edlOf = beats => ({ ...directorEdl(), spine: { ...directorEdl().spine, beats } });
  const hookB = (s, e) => beat('h', s, e, { chronologyMode: 'teaser', narrativeRole: 'teaser_conflict', scopeMembership: 'hook' });
  const endB = (s, e) => beat('end', s, e, { narrativeRole: 'cliffhanger', scopeMembership: 'ending', payoffTiming: 'part_2' });
  // 64.6s, inside the scope windows, with free watched footage next to several beats.
  const edl646 = () => edlOf([hookB(60, 66), beat('b2', 4, 14), beat('b3', 16, 30), beat('b4', 36, 50), beat('b5', 67, 79.6), endB(98, 106)]);

  await ok('Duration A: director aims at Story Scope targetDurationSec (75, derived) band 72-78; a 59s EDL is repaired toward ~75s, not 65s', async () => {
    const t = Director.durationTargets(scopeCandidate(), { targetDurationMinSec: 65, targetDurationMaxSec: 90 });
    assert.deepStrictEqual([t.hardMinSec, t.hardMaxSec, t.targetDurationSec, t.targetBandMinSec, t.targetBandMaxSec], [65, 90, 75, 72, 78]);
    assert.strictEqual(Director.durationTargets(scopeCandidate({ targetDurationSec: 82 }), {}).targetDurationSec, 82, 'derived from the scope, not hardcoded');
    assert.strictEqual(Director.durationTargets(scopeCandidate({ targetDurationSec: 60 }), {}).targetDurationSec, 70, 'clamped into the hard range with margin');
    const e59 = edlOf([hookB(60, 66), beat('b2', 4, 14), beat('b3', 16, 30), beat('b4', 36, 50), beat('b5', 67, 74), endB(98, 106)]); // 59s
    const e75 = edlOf([hookB(60, 66), beat('b2', 4, 14), beat('b3', 16, 30), beat('b4', 36, 50), beat('b5', 67, 84), endB(96, 110)]); // 75s, same beats
    const engine = fakeEngine([e59, e75]);
    const out = await Director.directEdl(engine, { model: MODEL, scope: scopeCandidate() });
    assert.strictEqual(Director.timelineSec(out.spine.beats), 75);
    assert.strictEqual(out.spine.directorMeta.attempts[1].mode, 'duration_lightweight');
    const first = engine.lastAsks[0].input;
    assert.deepStrictEqual([first.targetDurationSec, first.targetBandMinSec, first.targetBandMaxSec, first.targetDurationMinSec, first.targetDurationMaxSec], [75, 72, 78, 65, 90]);
    assert.match(Director.instruction, /do NOT aim at its minimum/);
    const rep = engine.lastAsks[1];
    const v = rep.input.violations.find(x => x.code === 'TOTAL_DURATION_UNDER_MIN');
    assert.deepStrictEqual([v.currentDurationSec, v.minimumDurationSec, v.targetDurationSec, v.missingToMinimumSec, v.missingToTargetSec], [59, 65, 75, 6, 16]);
    assert.match(v.message, /Do not add only 6s — repair toward approximately 75s/);
    assert.strictEqual(rep.input.durationRepair.targetDurationSec, 75);
  });

  await ok('Duration B: 64.6s, duration is the ONLY violation, safe contiguous watched footage -> technical adjustment >= 65s, no further Gemini call', async () => {
    const engine = fakeEngine([edl646()]);
    const out = await Director.directEdl(engine, { model: MODEL, scope: scopeCandidate() });
    assert.strictEqual(engine.lastAsks.length, 1, 'no second (media or text) Gemini call');
    const adj = out.spine.technicalDurationAdjustment;
    assert.ok(adj && adj.addedSec === 0.4 && Math.abs(adj.newEndSec - adj.oldEndSec - 0.4) < 1e-9 && adj.sourceWindowId, JSON.stringify(adj));
    assert.ok(Director.timelineSec(out.spine.beats) >= 65 - 1e-9);
    assert.ok(out.spine.directorMeta.attempts[0].technicalDurationAdjustment.beatId === adj.beatId);
    const b = out.spine.beats.find(x => x.beatId === adj.beatId);
    assert.deepStrictEqual([b.sourceStartSec, b.sourceEndSec], [adj.newStartSec, adj.newEndSec]);
  });

  // Scope whose first two windows are tiled exactly by the EDL (no contiguous room anywhere),
  // plus a third in-scope window the director already watched but did not use.
  const tightScope = () => scopeCandidate({
    scopeWindows: [{ windowId: 'A', startSec: 10, endSec: 40, purposes: ['core'] }, { windowId: 'B', startSec: 50, endSec: 84.6, purposes: ['core', 'ending_material'] }, { windowId: 'C', startSec: 120, endSec: 140, purposes: ['core'] }],
    explicitScopeBoundary: { startSec: 0, endSec: 150, rationale: 'x' },
    causalSpine: [{ eventId: 'e2', sourceStartSec: 20, sourceEndSec: 30 }, { eventId: 'e4', sourceStartSec: 60, sourceEndSec: 80 }],
    candidateEndingEvents: [{ sourceStartSec: 70, sourceEndSec: 84.6, endingType: 'forward_cliffhanger' }] });
  const tiled = () => edlOf([hookB(10, 20), beat('a', 20, 40), endB(50, 84.6)]); // 64.6s, every edge blocked

  await ok('Duration C: 64.6s with no safe contiguous extension -> lightweight text-only duration repair (no media re-upload)', async () => {
    const fixed = edlOf([hookB(10, 20), beat('a', 20, 40), beat('x', 120, 130), endB(50, 84.6)]);
    const engine = fakeEngine([tiled(), fixed]);
    const out = await Director.directEdl(engine, { model: MODEL, scope: tightScope() });
    const rep = engine.lastAsks[1];
    assert.ok(/_duration1$/.test(rep.key), rep.key);
    assert.deepStrictEqual(rep.evidence, [], 'no video re-uploaded for a duration-only repair');
    assert.strictEqual(rep.instruction, Director.DURATION_REPAIR_INSTRUCTION);
    assert.ok(rep.input.currentEdl && rep.input.cuttableRanges.length === 3 && rep.input.scopeReelManifest.length >= 3);
    assert.strictEqual(rep.input.durationRepair.missingToTargetSec, 10.4);
    assert.strictEqual(out.spine.directorMeta.attempts[0].technicalDurationAdjustment.applied, false);
    assert.strictEqual(out.spine.directorMeta.attempts[1].mode, 'duration_lightweight');
    assert.strictEqual(out.spine.directorMeta.attempts[1].mediaFiles, 0);
    assert.strictEqual(Director.timelineSec(out.spine.beats), 74.6);
    // A lightweight repair that reorders/removes existing beats is rejected.
    const reordered = edlOf([hookB(10, 20), endB(50, 84.6), beat('a', 20, 40), beat('x', 120, 130)]);
    const bad = Director.storyPreservationViolations(tiled().spine, reordered.spine);
    assert.ok(bad.some(v => v.code === 'DURATION_REPAIR_REORDERED'));
    assert.ok(Director.storyPreservationViolations(tiled().spine, edlOf([hookB(10, 20), endB(50, 84.6)]).spine).some(v => v.code === 'DURATION_REPAIR_REMOVED_BEATS'));
  });

  await ok('Duration D: 64.6s + another violation (OUTSIDE_SCOPE_REEL) -> NO technical adjustment; full multimodal repair', async () => {
    const withOutside = edlOf([hookB(60, 66), beat('b2', 4, 14), beat('b3', 16, 30), beat('b4', 36, 50), beat('bad', 242, 254.6), endB(98, 106)]); // 64.6s
    const engine = fakeEngine([withOutside, directorEdl()]);
    const out = await Director.directEdl(engine, { model: MODEL, scope: scopeCandidate() });
    const a0 = out.spine.directorMeta.attempts[0];
    assert.ok(a0.violations.some(v => v.code === 'OUTSIDE_SCOPE_REEL') && a0.violations.some(v => v.code === 'TOTAL_DURATION_UNDER_MIN'));
    assert.strictEqual(a0.technicalDurationAdjustment, undefined);
    assert.ok(/_fix1$/.test(engine.lastAsks[1].key) && engine.lastAsks[1].evidence.length > 0, 'multimodal repair with the reel media');
  });

  await ok('Duration E/F: technical adjustment never crosses a logical window / watched segment, never overlaps another beat', async () => {
    const scope = tightScope();
    const reel = Scope.planScopeReel(scope, { durationSec: SOURCE_SEC });
    // E: every beat edge sits on its window edge or on another beat -> refused.
    const e = Director.technicalDurationAdjustment(tiled().spine, reel, { hardMinSec: 65, durationSec: SOURCE_SEC });
    assert.strictEqual(e.applied, false, JSON.stringify(e));
    // E: room exists only by crossing into the gap/next window (40->40.4 is padding, not window) -> refused.
    const crossing = edlOf([hookB(10.4, 20), beat('a', 20, 40), endB(50, 84.6)]).spine; // 64.2s: needs 0.8s, only 0.4 in-window
    assert.strictEqual(Director.technicalDurationAdjustment(crossing, reel, { hardMinSec: 65, durationSec: SOURCE_SEC }).applied, false);
    // F: in-window room exists only by overlapping a neighbour -> refused; with room elsewhere it picks that.
    const f = edlOf([hookB(10, 20), beat('a', 20.2, 40), endB(50, 84.6)]).spine; // 64.4s, gap 20-20.2 is 0.2 only
    assert.strictEqual(Director.technicalDurationAdjustment(f, reel, { hardMinSec: 65, durationSec: SOURCE_SEC }).applied, false);
    // Deficit > 1.0s is never technical.
    const big = edlOf([hookB(60, 66), beat('b2', 4, 14), beat('b3', 16, 30), beat('b4', 36, 50), beat('b5', 67, 78.5), endB(98, 106)]).spine; // 63.5s
    assert.match(Director.technicalDurationAdjustment(big, Scope.planScopeReel(scopeCandidate(), { durationSec: SOURCE_SEC }), { hardMinSec: 65 }).reason, /exceeds 1s/);
    // A successful adjustment stays inside its window and touches no other range.
    const ok1 = Director.technicalDurationAdjustment(edl646().spine, Scope.planScopeReel(scopeCandidate(), { durationSec: SOURCE_SEC }), { hardMinSec: 65, durationSec: SOURCE_SEC });
    assert.ok(ok1.applied);
    const moved = ok1.spine.beats.find(b => b.beatId === ok1.adjustment.beatId);
    const win = scopeCandidate().scopeWindows.find(w => moved.sourceStartSec >= w.startSec && moved.sourceEndSec <= w.endSec);
    assert.ok(win, 'adjusted beat still inside one logical window');
    for (const o of ok1.spine.beats) if (o !== moved && o.beatId !== 'b5' && o.beatId !== 'h') assert.ok(Math.min(o.sourceEndSec, moved.sourceEndSec) - Math.max(o.sourceStartSec, moved.sourceStartSec) <= 0);
  });

  await ok('Duration G: the 65-90s hard acceptance range is unchanged', async () => {
    const scope = scopeCandidate();
    const reel = Scope.planScopeReel(scope, { durationSec: SOURCE_SEC });
    const total = beats => Director.validateDirectorEdl({ beats }, scope, { durationSec: SOURCE_SEC, targetDurationMinSec: 65, targetDurationMaxSec: 90, reel }).violations.map(v => v.code);
    assert.ok(total(edl646().spine.beats).includes('TOTAL_DURATION_UNDER_MIN'), '64.6s is still rejected');
    assert.ok(!total(directorEdl().spine.beats).some(c => c.startsWith('TOTAL_DURATION')), '72s accepted');
    const d = Director.durationTargets(scope, { targetDurationMinSec: 65, targetDurationMaxSec: 90 });
    assert.deepStrictEqual([d.hardMinSec, d.hardMaxSec], [65, 90]);
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


  // ---------------------------------------------------------------- director output fuse (MAX_TOKENS)
  const prose = (n, seed) => `${seed} ` + 'the officer keeps pressing the driver about the open container on the seat'.slice(0, n);
  const normalEdl = () => {
    const out = directorEdl();
    // ~14 beats x ~1k chars ≈ 3.5-4k tokens: the size of real, valid director EDLs.
    const spans = [[60, 66], [4, 8], [8, 12], [16, 20], [20, 24], [24, 30], [36, 40], [40, 45], [45, 50], [58, 60], [67, 72], [72, 78], [78, 82], [98, 106]];
    out.spine.beats = spans.map(([a, b], i) => beat(`b${i + 1}`, a, b, {
      ...(i === 0 ? { chronologyMode: 'teaser', narrativeRole: 'teaser_conflict', scopeMembership: 'hook', payoffTiming: 'part_2' } : {}),
      ...(i === 1 ? { chronologyMode: 'rewind', narrativeRole: 'rewind_context' } : {}),
      ...(i === spans.length - 1 ? { narrativeRole: 'cliffhanger', scopeMembership: 'ending', payoffTiming: 'part_2', isForwardConsequence: true, expectedNextConsequence: 'detention' } : {}),
      observedInFootage: prose(150, `b${i + 1} seen`), viewerStateBefore: prose(70, 'before'), viewerStateAfter: prose(110, 'after'),
      newInformation: prose(90, 'info'), whyNecessaryNow: prose(120, 'needed') }));
    return out;
  };

  await ok('Output fuse 1: a normal ~4k-token director JSON still parses, validates and is classified complete', async () => {
    const edl = normalEdl();
    const text = JSON.stringify(edl, null, 2);
    assert.ok(text.length > 11000 && text.length < 20000, `fixture size ${text.length}`);
    SchemaBoundary.validate(JSON.parse(text), Director.schemas.directorEdl);
    Director.validateShape(JSON.parse(text));
    assert.strictEqual(Director.diagnoseDirectorOutput(text).classification, 'complete_json');
    const engine = fakeEngine([edl]);
    const out = await Director.directEdl(engine, { model: MODEL, scope: scopeCandidate() });
    assert.strictEqual(out.spine.beats.length, 14);
    assert.ok(Director.timelineSec(out.spine.beats) >= 65);
  });

  await ok('Output fuse 2: every director call carries an explicit finite output ceiling (12k-16k) and explicit thinking budget', async () => {
    assert.ok(Number.isFinite(Director.DIRECTOR_MAX_OUTPUT_TOKENS) && Director.DIRECTOR_MAX_OUTPUT_TOKENS >= 12000 && Director.DIRECTOR_MAX_OUTPUT_TOKENS <= 16000);
    assert.strictEqual(Director.DIRECTOR_THINKING_BUDGET, 0);
    // multimodal + lightweight duration repair both carry the fuse.
    const e59 = edlOf([hookB(60, 66), beat('b2', 4, 14), beat('b3', 16, 30), beat('b4', 36, 50), beat('b5', 67, 74), endB(98, 106)]);
    const e75 = edlOf([hookB(60, 66), beat('b2', 4, 14), beat('b3', 16, 30), beat('b4', 36, 50), beat('b5', 67, 84), endB(96, 110)]);
    const engine = fakeEngine([e59, e75]);
    await Director.directEdl(engine, { model: MODEL, scope: scopeCandidate() });
    assert.strictEqual(engine.lastAsks.length, 2);
    for (const a of engine.lastAsks) assert.deepStrictEqual(a.options, { maxOutputTokens: Director.DIRECTOR_MAX_OUTPUT_TOKENS, thinkingBudget: 0 }, a.key);
    // End-to-end: the ceiling reaches the provider request.
    const { dir, store, projectId } = await makeProject();
    const vertex = makeVertex({ scope: selection(), director: directorEdl() });
    await Pipeline.run(makeService(store, vertex, makeFfmpeg()), { workspaceRoot: dir, projectId, onProgress: () => {} });
    const d = vertex.calls.find(c => c.kind === 'director');
    assert.strictEqual(d.args.maxOutputTokens, Director.DIRECTOR_MAX_OUTPUT_TOKENS);
    assert.strictEqual(d.args.thinkingBudget, 0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await ok('Output fuse 3: a MAX_TOKENS director response is never imported, never resent, raw kept, telemetry split', async () => {
    const { dir, store, projectId } = await makeProject();
    const loop = 'The officer walks to the car because the call came in first. '.repeat(400);
    const raw = `{"accessGranted": true, "reelObservations": "x", "spine": {"centralViewerQuestion": "q", "hookPromise": "p", "beats": [{"beatId": "b1", "sourceStartSec": 4, "sourceEndSec": 14, "whyNecessaryNow": "${loop}`;
    const vertex = makeVertex({ scope: selection(), director: () => {
      vertex.lastResponseText = raw;
      vertex.lastResponseMetadata = { finishReason: 'MAX_TOKENS', model: 'gemini-test', requestedMaxOutputTokens: 16000, requestedThinkingBudget: 0, modelMs: 1,
        usage: { promptTokenCount: 45000, candidatesTokenCount: 16000, totalTokenCount: 61000 } };
      vertex.lastUsage = { model: 'gemini-test', inputTokens: 45000, outputTokens: 16000, estimatedCostUsd: 0.05 };
      throw new Error('Vertex AI không hoàn tất response: MAX_TOKENS');
    } });
    const service = makeService(store, vertex, makeFfmpeg());
    let res, thrown;
    try { res = await Pipeline.run(service, { workspaceRoot: dir, projectId, onProgress: () => {} }); } catch (e) { thrown = e; }
    const failure = thrown || res.failures?.[0];
    assert.ok(failure, 'the run must fail');
    assert.strictEqual(failure.kind, 'DIRECTOR_OUTPUT_LIMIT', `${failure.kind}: ${failure.message || failure.error}`);
    assert.strictEqual(vertex.calls.filter(c => c.kind === 'director').length, 1, 'the same multimodal request is not resent');
    assert.ok(!vertex.calls.some(c => ['scope_critic', 'narration'].includes(c.kind)), 'nothing downstream ran on a partial EDL');
    const root = path.join(store.getProjectPaths(dir, projectId).analysisDir, 'auto-story-fast');
    assert.ok(!fsSync.existsSync(path.join(root, 'story-spine.json')) || JSON.parse(await fs.readFile(path.join(root, 'story-spine.json'), 'utf8')).spines.length === 0, 'no spine imported');
    const cacheDir = (await makeProjectCache(dir));
    const files = await fs.readdir(cacheDir);
    assert.ok(files.includes('v5-editorial-director-1-raw-response.txt'), 'raw response preserved');
    assert.ok(!files.some(f => /^v5-editorial-director-1-[0-9a-f]{20}\.json$/.test(f)), 'partial JSON never cached as a result');
    const details = failure.details || {};
    const diag = details.diagnosis || details.failures?.[0]?.details?.diagnosis;
    assert.strictEqual(diag?.classification, 'repetition_loop', JSON.stringify(Object.keys(details)));
    const costs = JSON.parse(await fs.readFile(path.join(root, 'run-costs.json'), 'utf8')).entries.find(e => e.stage === 'v5-editorial-director-1');
    assert.deepStrictEqual([costs.promptTokens, costs.candidatesTokens, costs.thoughtsTokens, costs.totalTokens, costs.finishReason, costs.requestedMaxOutputTokens],
      [45000, 16000, 0, 61000, 'MAX_TOKENS', 16000]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await ok('Output fuse 4: a huge / repeated response fails fast (diagnosed; a closed looping string is rejected without repair)', async () => {
    const sentence = 'The officer approaches the house as the next action after the call. ';
    const truncated = `{"accessGranted": true, "spine": {"beats": [{"beatId": "b1", "whyNecessaryNow": "short."}, {"beatId": "b2", "whyNextFollows": "${sentence.repeat(3000)}`;
    const d = Director.diagnoseDirectorOutput(truncated);
    assert.deepStrictEqual([d.classification, d.beatIdCount, d.longestString.key, d.endsInsideString], ['repetition_loop', 2, 'whyNextFollows', true]);
    assert.ok(d.topRepeatedSentence.count >= 2999 && d.head.length <= 160 && d.tail.length <= 160, 'compact stats only');
    const runaway = `{"spine": {"beats": [${Array.from({ length: 60 }, (_, i) => `{"beatId": "b${i}", "newInformation": "fact ${i} about beat number ${i}."}`).join(',')}`;
    assert.strictEqual(Director.diagnoseDirectorOutput(runaway).classification, 'runaway_beats');
    // A loop that happened to close under the ceiling is not imported and not sent back for repair.
    const closed = directorEdl();
    closed.spine.beats[2].whyNecessaryNow = sentence.repeat(60);
    const engine = fakeEngine([closed, directorEdl()]);
    await assert.rejects(Director.directEdl(engine, { model: MODEL, scope: scopeCandidate() }), e => e.kind === 'DIRECTOR_OUTPUT_DEGENERATE');
    assert.strictEqual(engine.lastAsks.length, 1, 'no repair call re-feeding the loop');
    // MAX_TOKENS surfacing from the provider -> typed failure, one call only.
    const eng2 = fakeEngine([() => { throw new Error('Vertex AI đã chạm giới hạn sinh nội dung (MAX_TOKENS — trần kỹ thuật 16000 token của stage).'); }]);
    eng2.service.vertex = { lastResponseText: truncated, lastResponseMetadata: { finishReason: 'MAX_TOKENS', requestedMaxOutputTokens: 16000, requestedThinkingBudget: 0,
      usage: { promptTokenCount: 45668, candidatesTokenCount: 16000, totalTokenCount: 61668 } } };
    await assert.rejects(Director.directEdl(eng2, { model: MODEL, scope: scopeCandidate() }), e => e.kind === 'DIRECTOR_OUTPUT_LIMIT'
      && e.details.telemetry.candidatesTokenCount === 16000 && e.details.telemetry.thoughtsTokenCount === 0 && e.details.diagnosis.classification === 'repetition_loop');
    assert.strictEqual(eng2.lastAsks.length, 1);
  });

  await ok('Output fuse 5: telemetry separates prompt / candidate / thinking / total tokens and finishReason', async () => {
    const t = Service.tokenTelemetry({ finishReason: 'STOP', requestedMaxOutputTokens: 16000, requestedThinkingBudget: 512,
      usage: { promptTokenCount: 45582, candidatesTokenCount: 3649, thoughtsTokenCount: 700, totalTokenCount: 49931 } });
    assert.deepStrictEqual(t, { promptTokens: 45582, candidatesTokens: 3649, thoughtsTokens: 700, totalTokens: 49931, finishReason: 'STOP', requestedMaxOutputTokens: 16000, requestedThinkingBudget: 512 });
    assert.strictEqual(Service.tokenTelemetry({ usage: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }).thoughtsTokens, 0, 'absent thoughts = 0, not collapsed');
    assert.deepStrictEqual(Service.tokenTelemetry(null), {});
  });

  await ok('Output fuse 6: compact contract keeps every field downstream uses; drops only the unused whyNextFollows', async () => {
    const b = Director.schemas.directorBeat;
    const consumed = ['beatId', 'sourceStartSec', 'sourceEndSec', 'chronologyMode', 'narrativeRole', 'audioMode', 'scopeMembership', 'observedInFootage', 'newInformation', 'whyNecessaryNow', 'viewerStateBefore', 'viewerStateAfter'];
    for (const k of consumed) assert.ok(b.required.includes(k), `required ${k}`);
    for (const k of ['narrationIntent', 'narratorFunction', 'wantsNarration', 'payoffTiming', 'isForwardConsequence', 'expectedNextConsequence', 'cliffhangerQuestion', 'whyCutHere']) assert.ok(b.properties[k], `optional ${k}`);
    assert.ok(!b.properties.whyNextFollows, 'whyNextFollows is not consumed by any validator, critic, repair or compiler');
    const electronDir = path.join(__dirname, '..', 'electron');
    const users = fsSync.readdirSync(electronDir, { recursive: true }).filter(f => String(f).endsWith('.js')).filter(f => fsSync.readFileSync(path.join(electronDir, f), 'utf8').includes('whyNextFollows'));
    assert.deepStrictEqual(users, [], `still referenced in ${users}`);
    assert.strictEqual(Director.schemas.directorSpine.properties.beats.maxItems, 40, 'beat ceiling unchanged (no editorial beat-count rule)');
    assert.doesNotMatch(Director.instruction, /13[-–]16 beats|\b1[3-6] beats\b/);
    assert.match(Director.instruction, /ONE short sentence/);
    assert.match(Director.instruction, /The JSON you return is final/);
    assert.doesNotMatch(Director.instruction + Director.DURATION_REPAIR_INSTRUCTION, /Before answering, add up|adjust until|step by step|think/i);
  });

  await ok('Output fuse 7: duration targeting stays 72-78 for a 75s scope; grounding + duration validators unchanged', async () => {
    const t = Director.durationTargets(scopeCandidate(), { targetDurationMinSec: 65, targetDurationMaxSec: 90 });
    assert.deepStrictEqual([t.hardMinSec, t.hardMaxSec, t.targetDurationSec, t.targetBandMinSec, t.targetBandMaxSec], [65, 90, 75, 72, 78]);
    const scope = scopeCandidate();
    const reel = Scope.planScopeReel(scope, { durationSec: SOURCE_SEC });
    const v = beats => Director.validateDirectorEdl({ beats }, scope, { durationSec: SOURCE_SEC, targetDurationMinSec: 65, targetDurationMaxSec: 90, reel, preferredDurationSec: 75 });
    assert.ok(v(directorEdl().spine.beats).valid);
    assert.ok(v(edl646().spine.beats).violations.some(x => x.code === 'TOTAL_DURATION_UNDER_MIN'));
    assert.ok(v([...directorEdl().spine.beats.slice(0, 5), beat('bad', 242, 250), directorEdl().spine.beats[5]]).violations.some(x => x.code === 'OUTSIDE_SCOPE_REEL'));
    const noObs = directorEdl().spine.beats.map((b, i) => i === 2 ? { ...b, observedInFootage: '' } : b);
    assert.ok(v(noObs).violations.some(x => x.code === 'BEAT_NOT_GROUNDED'));
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
