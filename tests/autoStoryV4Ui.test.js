// True Crime Auto Story V4 (StoryScope + media-grounded Editorial Director) from the setup UI.
// Run: node tests/autoStoryV4Ui.test.js
//
// Regression for the UI -> project -> pipeline path:
//   1. the V4 option exists and readProjectPayload() builds its fields from src/autoStoryEngine.js;
//   2. a V4 payload is persisted with autoStoryContractVersion 4 and
//      autoStoryConfig.editorialArchitecture "scope_media_director" (save + reload from disk);
//   3. that project runs the REAL autoStoryV3Pipeline.run through Story Scope -> Editorial
//      Director (scripted provider), never the legacy text-only Story Design;
//   4. after the run the backend stores contract 3, and the Studio badge still says V4
//      (read from autoStoryEditorialArchitecture), and auditDrafts keeps the director path;
//   5. V2 and V3 payloads are unchanged (V3 still runs the legacy text design).
// Fixture copied from tests/storyScopeArchitecture.test.js (generic synthetic incident).
const assert = require('node:assert');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const svc = p => path.join(root, 'electron', 'services', p);
const Store = require(svc('projectStore.js'));
const Service = require(svc('autoStoryFastService.js'));
const Pipeline = require(svc('autoStoryV3Pipeline.js'));
const sourceModel = require(svc('sourceStoryModelService.js'));
const Engine = require(path.join(root, 'src', 'autoStoryEngine.js'));

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
// Delivery blocks for a fixture: consecutive beats with the same audio mode share a block.
function autoBlocks(beats) {
  const blocks = [];
  for (const b of beats) {
    const mode = b.audioMode && b.audioMode !== 'original_audio' ? 'narrated_story' : 'raw_evidence';
    const last = blocks[blocks.length - 1];
    if (last && last.mode === mode && (mode === 'raw_evidence' || last.sourceAudioTreatment === b.audioMode)) { last.beatIds.push(b.beatId); continue; }
    blocks.push({ blockId: `blk${blocks.length + 1}`, mode, beatIds: [b.beatId], storyFunction: b.narrativeRole,
      blockSummary: `block around ${b.beatId}`, viewerStateChanges: 1, ownershipReason: mode === 'raw_evidence' ? 'the real exchange is the proof' : 'orients the viewer',
      ...(mode === 'narrated_story' ? { sourceAudioTreatment: b.audioMode, narratorFunction: 'CONTEXT', narrationIntent: b.narrationIntent || 'orient the viewer' } : { evidenceFunction: 'the real moment' }) });
  }
  return blocks;
}
const transitionsFor = blocks => blocks.slice(1).map((b, i) => ({ fromBlockId: blocks[i].blockId, toBlockId: b.blockId, coldViewerUnderstandsWhy: true, howTheViewerKnows: 'the dialogue continues the confrontation' }));
const openingFor = beats => ({ chronologicalOption: 'open on the stop itself', conflictTeaserOption: 'open on the denial at the window, then rewind',
  chosen: beats[0]?.chronologyMode === 'teaser' ? 'conflict_teaser_rewind' : 'chronological', why: 'stronger immediate curiosity' });
const withBlocks = edl => { const deliveryBlocks = autoBlocks(edl.spine.beats);
  return { ...edl, spine: { ...edl.spine, deliveryBlocks, transitionChecks: transitionsFor(deliveryBlocks), openingStrategy: openingFor(edl.spine.beats) } }; };
// A valid 72s director EDL: teaser from later in scope, rewind, chronological, ending.
function directorEdl({ beats } = {}) {
  return withBlocks(directorEdlNoBlocks({ beats }));
}
function directorEdlNoBlocks({ beats } = {}) {
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
        : p.includes('PASS 3B — BLOCK NARRATION') ? 'block_narration'
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


function makeService(store, vertex, ffmpeg, dubbing = {}) {
  const s = new Service({ vertexAutoStoryMaxCalls: 40 }, store, { vertex, ffmpeg, dubbing, callBudget: { calls: 0, runId: 'test' } });
  s.measuredVoice = async () => ({ meta: { duration: 2 } });
  return s;
}

// ------------------------------------------------------------------ UI -> project
// Mirrors readProjectPayload() for Auto Story: the engine select value goes through
// AutoStoryEngine.projectFields (same call as src/renderer.js), plus the UI config fields.
function uiPayload(engineValue, dir, extraConfig = {}) {
  const fields = Engine.projectFields(engineValue);
  return {
    title: `ui-${engineValue}`,
    sourceVideoPath: path.join(dir, 'source.mp4'),
    mode: 'highlight_cut',
    analysisWorkflow: 'vertex_auto_story',
    autoStoryConfig: {
      targetDurationMinSec: 65, targetDurationMaxSec: 90, outputCount: 1,
      narrationStyle: 'investigative', audioBalance: 'original_only', voiceProvider: '', voiceId: '', measuredWordsPerSecond: 0,
      ...extraConfig,
      ...fields.autoStoryConfigPatch
    },
    autoStoryContractVersion: fields.autoStoryContractVersion
  };
}

async function sourceDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v4-ui-'));
  const sourceData = `synthetic source ${crypto.randomUUID()}`;
  await fs.writeFile(path.join(dir, 'source.mp4'), sourceData);
  const hash = crypto.createHash('sha256').update(sourceData).digest('hex');
  const cache = path.join(dir, '.cineviral', 'auto-story-source', hash, 'source-contract-v3');
  await fs.mkdir(cache, { recursive: true });
  await sourceModel.persist(cache, MODEL);
  return dir;
}

(async () => {
  console.log('AutoStory V4 from the setup UI');
  const html = fsSync.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  const renderer = fsSync.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');

  await ok('UI: V4 option next to V2/V3; engine module loaded before renderer; payload/badge use it', async () => {
    const select = html.match(/<select id="auto-story-engine-version">([\s\S]*?)<\/select>/)[1];
    assert.deepStrictEqual([...select.matchAll(/<option value="(\d)"/g)].map(m => m[1]), ['2', '3', '4']);
    assert.match(select, /<option value="2" selected>/, 'V2 stays the default');
    assert.match(select, /value="4">V4 — StoryScope \+ Editorial Director/);
    assert.ok(html.indexOf('src="./autoStoryEngine.js"') > 0 && html.indexOf('src="./autoStoryEngine.js"') < html.indexOf('src="./renderer.js"'));
    const payloadFn = renderer.slice(renderer.indexOf('function readProjectPayload()'), renderer.indexOf('manualGeminiPackPath: isManualGeminiWorkflowMode(setupMode)'));
    assert.match(payloadFn, /AutoStoryEngine\.projectFields\(el\.autoStoryEngineVersion\?\.value\)/);
    assert.match(payloadFn, /\.\.\.autoStoryEngineFields\.autoStoryConfigPatch/);
    assert.match(payloadFn, /autoStoryContractVersion: isAutoStoryMode\(setupMode\) \? autoStoryEngineFields\.autoStoryContractVersion : undefined/);
    assert.match(renderer, /AutoStoryEngine\.engineOfProject\(project\)/, 'Studio badge reads the project engine');
    assert.match(renderer, /AutoStoryEngine\.engine\(el\.autoStoryEngineVersion\?\.value\)\.shortLabel/, 'confirmation step label');
  });

  await ok('engine fields: V2 unchanged, V3 = contract 3, V4 = contract 4 + scope_media_director', async () => {
    assert.deepStrictEqual(Engine.projectFields('2'), { autoStoryContractVersion: undefined, autoStoryConfigPatch: {} });
    assert.deepStrictEqual(Engine.projectFields('3'), { autoStoryContractVersion: 3, autoStoryConfigPatch: {} });
    assert.deepStrictEqual(Engine.projectFields('4'), { autoStoryContractVersion: 4, autoStoryConfigPatch: { editorialArchitecture: 'scope_media_director' } });
    assert.deepStrictEqual(Engine.projectFields(undefined), Engine.projectFields('2'), 'unknown value -> V2');
    assert.strictEqual(Engine.SCOPE_MEDIA_DIRECTOR, Pipeline.SCOPE_MEDIA_DIRECTOR);
  });

  await ok('output count: V4 defaults to 1 the first time only; V3 keeps its 2 -> 1 convenience', async () => {
    assert.deepStrictEqual(Engine.outputCountOnSelect('4', '2', false), { count: '1', v4Defaulted: true });
    assert.deepStrictEqual(Engine.outputCountOnSelect('4', '3', true), { count: '3', v4Defaulted: true }, 'user change kept');
    assert.deepStrictEqual(Engine.outputCountOnSelect('2', '3', true), { count: '3', v4Defaulted: true });
    assert.deepStrictEqual(Engine.outputCountOnSelect('3', '2', false), { count: '1', v4Defaulted: false });
    assert.deepStrictEqual(Engine.outputCountOnSelect('3', '3', false), { count: '3', v4Defaulted: false });
    assert.deepStrictEqual(Engine.outputCountOnSelect('2', '2', false), { count: '2', v4Defaulted: false });
  });

  await ok('badge architecture mirrors autoStoryV3Pipeline.editorialArchitecture', async () => {
    const cases = [
      {}, { autoStoryContractVersion: 2 }, { autoStoryContractVersion: 3 }, { autoStoryContractVersion: 4 },
      { autoStoryContractVersion: 4, autoStoryConfig: { editorialArchitecture: 'legacy_v4' } },
      { autoStoryContractVersion: 3, autoStoryEditorialArchitecture: 'scope_media_director' },
      { autoStoryContractVersion: 3, autoStoryEditorialArchitecture: 'legacy_text_design' },
      { autoStoryContractVersion: 4, autoStoryConfig: { editorialArchitecture: 'scope_media_director' } }
    ];
    for (const project of cases) assert.strictEqual(Engine.resolvedArchitecture(project), Pipeline.editorialArchitecture(project), JSON.stringify(project));
    assert.strictEqual(Engine.engineOfProject({}).badge, 'AutoStory V2');
    assert.strictEqual(Engine.engineOfProject({ autoStoryContractVersion: 2, autoStoryPipelineVersion: 'editorial-v1' }).badge, 'AutoStory V2');
    assert.strictEqual(Engine.engineOfProject({ autoStoryContractVersion: 3, autoStoryPipelineVersion: 'source-story-v3', autoStoryEditorialArchitecture: 'legacy_text_design' }).badge, 'AutoStory V3');
    assert.strictEqual(Engine.engineOfProject({ autoStoryContractVersion: 4, autoStoryConfig: { editorialArchitecture: 'scope_media_director' } }).badge, 'AutoStory V4', 'before the run');
    assert.strictEqual(Engine.engineOfProject({ autoStoryContractVersion: 3, autoStoryPipelineVersion: 'source-story-v3', autoStoryEditorialArchitecture: 'scope_media_director' }).badge, 'AutoStory V4', 'after the run (contract normalized to 3)');
    assert.strictEqual(Engine.engineOfProject({ autoStoryContractVersion: 4, autoStoryConfig: { editorialArchitecture: 'legacy_v4' } }).badge, 'AutoStory V3', 'V4 contract opted out to the text design');
  });

  await ok('V4 payload persisted (disk + reload) and run through Story Scope -> Editorial Director, not legacy text design', async () => {
    const dir = await sourceDir();
    const store = new Store();
    const created = await store.createProject(dir, uiPayload('4', dir));
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, created.id, 'project.json'), 'utf8'));
    assert.strictEqual(onDisk.autoStoryContractVersion, 4);
    assert.strictEqual(onDisk.autoStoryConfig.editorialArchitecture, 'scope_media_director');
    assert.strictEqual(onDisk.autoStoryConfig.outputCount, 1);
    const reloaded = await store.getProject(dir, created.id);
    assert.strictEqual(Pipeline.editorialArchitecture(reloaded), Pipeline.SCOPE_MEDIA_DIRECTOR);
    assert.strictEqual(Engine.engineOfProject(reloaded).badge, 'AutoStory V4');

    const vertex = makeVertex({ scope: selection(), director: directorEdl() });
    const progress = [];
    const result = await Pipeline.run(makeService(store, vertex, makeFfmpeg()), { workspaceRoot: dir, projectId: created.id, onProgress: p => progress.push(p) });
    const kinds = vertex.calls.map(c => c.kind);
    assert.ok(kinds.includes('scope') && kinds.includes('director'), `scope + director ran: ${kinds}`);
    assert.ok(kinds.indexOf('scope') < kinds.indexOf('director'));
    assert.ok(!kinds.includes('legacy_design'), `no legacy text design: ${kinds}`);
    assert.ok(vertex.calls.find(c => c.kind === 'director').filePaths.length >= 1, 'director watched the scope reel');
    assert.deepStrictEqual(result.failures, [], JSON.stringify(result.failures));
    assert.strictEqual(result.scriptPaths.length, 1);
    const messages = progress.map(p => String(p.message || ''));
    assert.ok(messages.some(m => m.includes('[Scope] Story Scope selection started.')), 'log shows the Scope stage');
    assert.ok(!messages.some(m => m.includes('Story Design started')), 'log has no legacy Story Design stage');

    // After the run: contract normalized to 3, architecture kept -> badge V4, review stays on the director path.
    const after = await store.getProject(dir, created.id);
    assert.strictEqual(after.autoStoryContractVersion, 3);
    assert.strictEqual(after.autoStoryEditorialArchitecture, 'scope_media_director');
    assert.strictEqual(after.autoStoryEditorialConfig.editorialArchitecture, 'scope_media_director');
    assert.strictEqual(Pipeline.editorialArchitecture(after), Pipeline.SCOPE_MEDIA_DIRECTOR);
    assert.strictEqual(Engine.engineOfProject(after).badge, 'AutoStory V4');
    await fs.rm(dir, { recursive: true, force: true });
  });

  await ok('V3 payload unchanged: contract 3, no architecture field, legacy text-only Story Design', async () => {
    const dir = await sourceDir();
    const store = new Store();
    const created = await store.createProject(dir, uiPayload('3', dir));
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, created.id, 'project.json'), 'utf8'));
    assert.strictEqual(onDisk.autoStoryContractVersion, 3);
    assert.ok(!('editorialArchitecture' in onDisk.autoStoryConfig));
    const vertex = makeVertex({ legacy_design: { accessGranted: true, spines: [] }, scope: selection(), director: directorEdl() });
    await Pipeline.run(makeService(store, vertex, makeFfmpeg()), { workspaceRoot: dir, projectId: created.id, onProgress: () => {} });
    const kinds = vertex.calls.map(c => c.kind);
    assert.ok(kinds.includes('legacy_design') && !kinds.includes('scope') && !kinds.includes('director'), `V3 path: ${kinds}`);
    assert.strictEqual(Engine.engineOfProject(await store.getProject(dir, created.id)).badge, 'AutoStory V3');
    await fs.rm(dir, { recursive: true, force: true });
  });

  await ok('V2 payload unchanged: no contract field, no architecture, V2 badge', async () => {
    const dir = await sourceDir();
    const store = new Store();
    const created = await store.createProject(dir, uiPayload('2', dir));
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, created.id, 'project.json'), 'utf8'));
    assert.ok(!('autoStoryContractVersion' in onDisk));
    assert.ok(!('editorialArchitecture' in onDisk.autoStoryConfig));
    assert.strictEqual(Engine.engineOfProject(onDisk).badge, 'AutoStory V2');
    await fs.rm(dir, { recursive: true, force: true });
  });

  console.log(`\nAll ${passed} AutoStory V4 UI assertions passed.`);
})().catch(e => { console.error(e); process.exit(1); });
