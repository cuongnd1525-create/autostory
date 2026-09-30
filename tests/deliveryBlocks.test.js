// AutoStory V5 — continuous narrated story blocks (pure / unit tests).
const assert = require('node:assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const svc = p => path.join(__dirname, '..', 'electron', 'services', p);
const Delivery = require(svc('deliveryBlockService.js'));
const BlockNarration = require(svc('blockNarrationService.js'));
const Director = require(svc('editorialDirectorService.js'));
const { compileV3, highlightV3 } = require(svc('autoStoryV3Compile.js'));
const DubbingService = require(svc('dubbingService.js'));
const compiler = require(svc('autoStoryTimelineCompiler.js'));

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

const beat = (id, s, e, extra = {}) => ({ beatId: id, sourceStartSec: s, sourceEndSec: e, chronologyMode: 'chronological', narrativeRole: 'escalation',
  scopeMembership: 'core', observedInFootage: `seen ${s}-${e}`, viewerStateBefore: `before ${id}`, viewerStateAfter: `after ${id}`,
  newInformation: `info ${id}`, whyNecessaryNow: 'needed', ...extra });
const BEATS = [
  beat('h', 60, 66, { narrativeRole: 'teaser_conflict', chronologyMode: 'teaser', scopeMembership: 'hook' }),
  beat('n1', 8.5, 13.5), beat('n2', 13.5, 19), beat('n3', 19, 24.5),
  beat('r1', 30, 44), beat('r2', 46, 58), beat('end', 98, 110, { narrativeRole: 'cliffhanger', scopeMembership: 'ending' })
];
const BLOCKS = () => [
  { blockId: 'raw_hook', mode: 'raw_evidence', beatIds: ['h'], storyFunction: 'hook', evidenceFunction: 'the confrontation' },
  { blockId: 'story_setup', mode: 'narrated_story', beatIds: ['n1', 'n2', 'n3'], storyFunction: 'rewind and set up the call', narratorFunction: 'CONTEXT',
    narrationIntent: 'who called, what was reported, and that the officer does not know what waits inside', sourceAudioTreatment: 'voiceover_with_ambient', handoffTargetBeatId: 'r1' },
  { blockId: 'raw_door', mode: 'raw_evidence', beatIds: ['r1', 'r2'], storyFunction: 'discovery', evidenceFunction: 'what the officer finds' },
  { blockId: 'raw_end', mode: 'raw_evidence', beatIds: ['end'], storyFunction: 'consequence', evidenceFunction: 'the decision' }
];
const PASSAGE = 'Officers were responding to a report of an assault in progress. The caller said his girlfriend was inside the house being attacked by her parents. But as the officer approached the door, he still had no idea what was waiting inside.';
const CONFIG = { targetDurationMinSec: 30, targetDurationMaxSec: 90, narration: { enabled: true, measuredWordsPerSecond: 3.0 } };
const EVIDENCE = [{ id: 'clip', sourceStart: 0, duration: 300 }];
const codes = v => v.map(x => x.code);

function compiledScript(blocks = BLOCKS(), passage = PASSAGE) {
  const withModes = Delivery.applyDeliveryBlocks(BEATS, blocks).map(b => ({ ...b,
    audioStrategy: b.audioMode === 'original_audio' ? 'original' : 'narrator_over', speaks: b.audioMode !== 'original_audio', narratorText: '' }));
  const narrated = Delivery.blockTimeline(withModes, blocks).map(b => (b.mode === 'narrated_story' ? { ...b, narrationText: passage, previewVi: 'vi' } : b));
  const script = compileV3(withModes, { story: { scriptId: 1, title: 't' }, evidence: EVIDENCE, config: CONFIG, sourceDuration: 300, deliveryBlocks: narrated });
  return { script, highlight: highlightV3(script, { scriptId: 1 }, EVIDENCE) };
}

(async () => {
  console.log('Delivery blocks — continuous narrated story blocks');

  await ok('1. every EDL beat belongs to exactly one delivery block', async () => {
    assert.deepStrictEqual(Delivery.validateDeliveryBlocks(BEATS, BLOCKS()), []);
    const missing = BLOCKS().filter(b => b.blockId !== 'raw_end');
    assert.deepStrictEqual(codes(Delivery.validateDeliveryBlocks(BEATS, missing)), ['DELIVERY_BEAT_UNASSIGNED']);
    const twice = BLOCKS(); twice[3].beatIds = ['r2', 'end'];
    assert.ok(codes(Delivery.validateDeliveryBlocks(BEATS, twice)).includes('DELIVERY_BEAT_IN_MULTIPLE_BLOCKS'));
    const unknown = BLOCKS(); unknown[3].beatIds = ['end', 'ghost'];
    assert.ok(codes(Delivery.validateDeliveryBlocks(BEATS, unknown)).includes('DELIVERY_BLOCK_UNKNOWN_BEAT'));
    assert.deepStrictEqual(codes(Delivery.validateDeliveryBlocks(BEATS, undefined)), ['DELIVERY_BLOCKS_MISSING']);
  });

  await ok('2. non-contiguous beat membership is invalid', async () => {
    const gap = BLOCKS();
    gap[1].beatIds = ['n1', 'n3']; gap[2].beatIds = ['n2', 'r1', 'r2'];
    const v = codes(Delivery.validateDeliveryBlocks(BEATS, gap));
    assert.ok(v.includes('DELIVERY_BLOCK_NOT_CONTIGUOUS'), v.join());
  });

  await ok('3. block ordering cannot reorder EDL beats', async () => {
    const inner = BLOCKS(); inner[1].beatIds = ['n2', 'n1', 'n3'];
    assert.ok(codes(Delivery.validateDeliveryBlocks(BEATS, inner)).includes('DELIVERY_BLOCK_REORDERS_BEATS'));
    const swapped = BLOCKS(); [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
    assert.ok(codes(Delivery.validateDeliveryBlocks(BEATS, swapped)).includes('DELIVERY_BLOCK_ORDER'));
    // Applying valid blocks never changes order or ranges.
    const applied = Delivery.applyDeliveryBlocks(BEATS, BLOCKS());
    assert.deepStrictEqual(applied.map(b => [b.beatId, b.sourceStartSec, b.sourceEndSec]), BEATS.map(b => [b.beatId, b.sourceStartSec, b.sourceEndSec]));
    // The director validator reports block structure as repairable violations.
    const r = Director.validateDirectorEdl({ beats: BEATS, deliveryBlocks: inner }, null, { durationSec: 300, targetDurationMinSec: 1, targetDurationMaxSec: 300 });
    assert.ok(codes(r.violations).includes('DELIVERY_BLOCK_REORDERS_BEATS'));
  });

  await ok('4. narrated_story produces ONE canonical narration passage (compile -> artifact -> import)', async () => {
    const { script, highlight } = compiledScript();
    const members = script.segments.filter(s => s.deliveryBlockId === 'story_setup');
    assert.strictEqual(members.length, 3);
    assert.deepStrictEqual(members.map(s => Boolean(s.blockNarrationText)), [true, false, false], 'passage lives once, on the first member');
    assert.ok(members.every(s => s.voiceoverText === '' && s.audioMode === 'voiceover_with_ambient'), 'no member carries a per-segment line');
    assert.strictEqual(script.deliveryBlocks.find(b => b.blockId === 'story_setup').narrationText, PASSAGE);
    const hs = highlight.segments.filter(s => s.delivery_block_id === 'story_setup');
    assert.deepStrictEqual(hs.map(s => s.block_narration_text || ''), [PASSAGE, '', '']);
    assert.ok(hs.every(s => s.voiceover_text === ''));
    assert.strictEqual(highlight.delivery_contract, Delivery.DELIVERY_CONTRACT);
    // Import survives: the importer keeps block membership + the single passage.
    const norm = DubbingService.normalizeHighlightCutScript(highlight, 300);
    const runs = DubbingService.narratedBlockRuns(norm.segments);
    assert.deepStrictEqual(runs, [{ blockId: 'story_setup', start: 1, end: 3 }]);
    assert.deepStrictEqual(norm.segments.slice(1, 4).map(s => [s.deliveryMode, s.audioMode, s.voiceoverText, Boolean(s.blockNarrationText)]),
      [['narrated_story', 'voiceover_with_ambient', '', true], ['narrated_story', 'voiceover_with_ambient', '', false], ['narrated_story', 'voiceover_with_ambient', '', false]]);
    // A second passage on an internal member is rejected at import (would synthesize twice).
    const bad = JSON.parse(JSON.stringify(highlight)); bad.segments[2].block_narration_text = 'again';
    assert.throws(() => DubbingService.normalizeHighlightCutScript(bad, 300), /exactly one block_narration_text/);
  });

  await ok('5. safe word ceiling is based on the WHOLE block duration (a ceiling, not a quota)', async () => {
    const timeline = Delivery.blockTimeline(BEATS, BLOCKS());
    const k = timeline.findIndex(b => b.blockId === 'story_setup');
    const payload = BlockNarration.blockPayload(timeline, k, { events: [], quotes: [] }, 3.0);
    assert.strictEqual(payload.blockVisualDurationSec, 16);
    assert.strictEqual(payload.safeWords, Math.floor(16 * 3.0 * 0.92));
    assert.strictEqual(payload.safeWords, compiler.budget(16, 3.0));
    // The 42-word passage is far over any single beat's budget (5.5s -> 15 words)...
    assert.ok(compiler.words(PASSAGE) > compiler.budget(5.5, 3.0));
    // ...but fits the block and compiles.
    assert.ok(compiler.words(PASSAGE) <= payload.safeWords);
    assert.doesNotThrow(() => compiledScript());
    // Over the whole-block ceiling -> VOICE_BUDGET (never silently trimmed).
    assert.throws(() => compiledScript(BLOCKS(), `${PASSAGE} ${PASSAGE}`), e => e.kind === 'VOICE_BUDGET');
    // Context for the writer: whole block, neighbours, handoff.
    assert.strictEqual(payload.beats.length, 3);
    assert.strictEqual(payload.precedingRawBlock.blockId, 'raw_hook');
    assert.strictEqual(payload.followingRawBlock.blockId, 'raw_door');
    assert.strictEqual(payload.handoffTargetBeatId, 'r1');
    assert.strictEqual(payload.viewerStateEntering, 'before n1');
    assert.strictEqual(payload.viewerStateLeaving, 'after n3');
    assert.doesNotMatch(BlockNarration.INSTRUCTION, /<=\s*10 words/);
  });

  await ok('6. raw_evidence remains original audio end to end', async () => {
    const { script, highlight } = compiledScript();
    const raw = script.segments.filter(s => s.deliveryMode === 'raw_evidence');
    assert.strictEqual(raw.length, 4);
    assert.ok(raw.every(s => s.audioMode === 'original_audio' && !s.voiceoverText && !s.blockNarrationText));
    const norm = DubbingService.normalizeHighlightCutScript(highlight, 300);
    assert.ok(norm.segments.filter(s => s.deliveryMode === 'raw_evidence').every(s => s.audioMode === 'original_audio' && s.sourceVolume === 1));
    assert.strictEqual(script.deliveryBlocks.find(b => b.blockId === 'raw_door').sourceAudioTreatment, 'original_audio');
  });

  await ok('7. narration-disabled mode: narrated blocks are rejected; all-raw delivery still compiles', async () => {
    assert.ok(codes(Delivery.validateDeliveryBlocks(BEATS, BLOCKS(), { narrationEnabled: false })).includes('NARRATION_DISABLED'));
    const allRaw = [{ blockId: 'all', mode: 'raw_evidence', beatIds: BEATS.map(b => b.beatId), storyFunction: 'story' }];
    const beats = Delivery.applyDeliveryBlocks(BEATS, allRaw).map(b => ({ ...b, audioStrategy: 'original', speaks: false, narratorText: '' }));
    const script = compileV3(beats, { story: { scriptId: 1 }, evidence: EVIDENCE, config: { ...CONFIG, narration: { enabled: false } }, sourceDuration: 300,
      deliveryBlocks: Delivery.blockTimeline(beats, allRaw) });
    assert.ok(script.segments.every(s => s.audioMode === 'original_audio'));
  });

  await ok('8. old scripts without deliveryBlocks still import and use the per-segment path', async () => {
    const old = { segments: [
      { sourceStartSec: 8.5, sourceEndSec: 13.5, audio_mode: 'voiceover_with_ambient', voiceover_text: 'Officers were responding to a report.' },
      { sourceStartSec: 13.5, sourceEndSec: 19, audio_mode: 'original_audio' }] };
    const norm = DubbingService.normalizeHighlightCutScript(old, 300);
    assert.deepStrictEqual(DubbingService.narratedBlockRuns(norm.segments), []);
    assert.strictEqual(norm.segments[0].audioMode, 'voiceover_with_ambient');
    assert.strictEqual(norm.segments[0].voiceoverText, 'Officers were responding to a report.');
    assert.strictEqual(norm.segments[1].audioMode, 'original_audio');
    assert.ok(norm.segments.every(s => s.deliveryBlockId === '' && s.blockNarrationText === ''));
    // Spines produced before delivery blocks map to one legacy block per beat (old model).
    const legacy = Delivery.blocksOf({ beats: [{ ...BEATS[0], audioMode: 'original_audio' }, { ...BEATS[1], audioMode: 'voiceover_with_ambient' }] });
    assert.ok(Delivery.isLegacy(legacy));
    assert.deepStrictEqual(legacy.map(b => b.mode), ['raw_evidence', 'narrated_story']);
  });

  await ok('9. block text / membership change the block fingerprint and the draft reuse key', async () => {
    const blk = { ...BLOCKS()[1], narrationText: PASSAGE };
    const f0 = Delivery.blockFingerprint(blk, BEATS);
    assert.notStrictEqual(Delivery.blockFingerprint({ ...blk, narrationText: `${PASSAGE} Now.` }, BEATS), f0, 'text');
    assert.notStrictEqual(Delivery.blockFingerprint({ ...blk, beatIds: ['n1', 'n2'] }, BEATS), f0, 'membership');
    assert.notStrictEqual(Delivery.blockFingerprint({ ...blk, sourceAudioTreatment: 'voiceover_only' }, BEATS), f0, 'treatment');
    const a = compiledScript().script.deliveryBlocks[1].fingerprint;
    assert.notStrictEqual(compiledScript(BLOCKS(), PASSAGE.replace('door', 'house')).script.deliveryBlocks[1].fingerprint, a);
    // Draft reuse key (renderer cache) follows the block passage.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blk-key-'));
    const src = path.join(dir, 'source.mp4'); await fs.writeFile(src, 'x');
    const project = { sourceVideoPath: src, voiceProvider: 'kokoro', voiceId: 'am_adam', analysis: { highlightVariants: [] } };
    const segsFor = passage => DubbingService.normalizeHighlightCutScript(compiledScript(BLOCKS(), passage).highlight, 300).segments;
    const k1 = await DubbingService.autoStoryDraftKey(project, { id: 'v1', segments: segsFor(PASSAGE) }, {});
    const k2 = await DubbingService.autoStoryDraftKey(project, { id: 'v1', segments: segsFor(PASSAGE.replace('door', 'house')) }, {});
    const k3 = await DubbingService.autoStoryDraftKey(project, { id: 'v1', segments: segsFor(PASSAGE) }, {});
    assert.notStrictEqual(k1, k2); assert.strictEqual(k1, k3);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await ok('10. no Story Scope / EDL timestamps are mutated by blocks, narration or compile', async () => {
    const before = JSON.stringify(BEATS);
    const { script } = compiledScript();
    assert.strictEqual(JSON.stringify(BEATS), before);
    assert.deepStrictEqual(script.segments.map(s => [s.beatId, s.sourceStartSec, s.sourceEndSec]), BEATS.map(b => [b.beatId, b.sourceStartSec, b.sourceEndSec]));
    assert.deepStrictEqual(script.segments.map(s => Number((s.outputEndSec - s.outputStartSec).toFixed(6))), BEATS.map(b => Number((b.sourceEndSec - b.sourceStartSec).toFixed(6))));
    const blk = script.deliveryBlocks.find(b => b.blockId === 'story_setup');
    assert.deepStrictEqual([blk.outputStartSec, blk.outputEndSec, blk.durationSec], [6, 22, 16]);
    // Compression pruning drops only references to removed beats.
    const pruned = Delivery.pruneRemovedBeats(BLOCKS(), BEATS.filter(b => b.beatId !== 'n2'));
    assert.deepStrictEqual(pruned[1].beatIds, ['n1', 'n3']);
    assert.deepStrictEqual(Delivery.validateDeliveryBlocks(BEATS.filter(b => b.beatId !== 'n2'), pruned), []);
  });

  // ---------------------------------------------------------------- renderer primitive (mocked ffmpeg/TTS)
  const fakeRender = (voiceSec) => {
    const calls = { extract: [], normalize: [], concat: [], synth: [], fit: [], mix: [] };
    const ffmpeg = {
      extractVoiceDrivenClipWithAudio: async a => { calls.extract.push(a); },
      normalizeVideoKeepAudio: async a => { calls.normalize.push(a); },
      concatSegmentsByFilter: async (paths, out) => { calls.concat.push({ paths, out }); },
      probeAudio: async () => ({ duration: voiceSec }),
      fitDubbingClusterAudio: async a => { calls.fit.push(a); return { outputDuration: a.targetDuration, fitStrategy: 'pad_silence' }; },
      mixVideoAudioWithVoice: async a => { calls.mix.push(a); }
    };
    const svc = Object.create(DubbingService.prototype);
    svc.synthesizeFastDraftVoice = async a => { calls.synth.push(a); };
    svc.recordVoiceProfileSample = async () => null;
    return { svc, ffmpeg, calls };
  };
  const blockMembers = () => DubbingService.normalizeHighlightCutScript(compiledScript().highlight, 300).segments.slice(1, 4);
  const renderArgs = (ffmpeg) => ({ ffmpeg, project: { sourceVideoPath: '/src.mp4', mixer: { sourceVolume: 28, voiceVolume: 100, narrationSourceAudioOverride: true, narrationDuckDefault: true } },
    settings: {}, workspaceRoot: '/w', paths: { audioDir: '/a', clipsDir: '/c' }, variantSuffix: 'v', draftVoiceProvider: 'kokoro', draftVoiceExt: '.wav',
    autoStorySourceStat: null, members: blockMembers(), startIndex: 1 });

  await ok('Render primitive: ONE synthesis, ONE fit over the whole block, ONE ducked mix; visual cuts kept at EDL durations', async () => {
    const { svc, ffmpeg, calls } = fakeRender(14.2);
    const out = await svc.renderNarratedDeliveryBlock(renderArgs(ffmpeg));
    assert.strictEqual(calls.synth.length, 1);
    assert.strictEqual(calls.synth[0].text, PASSAGE);
    assert.deepStrictEqual(calls.extract.map(a => [a.startSec, a.sourceDurationSec, a.targetDurationSec]), [[8.5, 5, 5], [13.5, 5.5, 5.5], [19, 5.5, 5.5]]);
    assert.strictEqual(calls.concat.length, 1); assert.strictEqual(calls.concat[0].paths.length, 3);
    assert.strictEqual(calls.fit.length, 1); assert.strictEqual(calls.fit[0].targetDuration, 16);
    assert.ok(calls.fit[0].allowTrim === false && calls.fit[0].allowSlowDown === false);
    assert.strictEqual(calls.mix.length, 1); assert.strictEqual(calls.mix[0].duck, true); assert.strictEqual(calls.mix[0].sourceVolume, 0.28);
    assert.deepStrictEqual(out.report.internalCutOffsetsSec, [5, 10.5]);
    assert.strictEqual(out.memberReports.length, 3);
    assert.ok(out.memberReports.every(r => r.mode === 'narrated_block_member' && !r.fittedVoicePath && !r.renderedText));
  });

  await ok('Render primitive: a passage that cannot fit is reported (BLOCK_VOICE_OVERFLOW), never trimmed or dropped', async () => {
    const { svc, ffmpeg, calls } = fakeRender(18.5);
    await assert.rejects(svc.renderNarratedDeliveryBlock(renderArgs(ffmpeg)), e => e.code === 'BLOCK_VOICE_OVERFLOW' && e.details.blockTimelineSec === 16);
    assert.strictEqual(calls.mix.length, 0);
    assert.strictEqual(calls.fit.length, 0);
  });


  // ---------------------------------------------------------------- block narration writer + voice fit
  const narrEngine = (responses, config = CONFIG) => ({ config, project: {}, cache: '/tmp', asks: [],
    async ask(key, input, schema, instruction, evidence, validate) { const r = responses.shift(); this.asks.push({ key, input, instruction }); if (!r) throw new Error(`unexpected ask ${key}`); return validate(typeof r === 'function' ? r(input) : r) || r; } });
  const line = (text, extra = {}) => ({ accessGranted: true, narrations: [{ blockId: 'story_setup', narrationText: text, previewVi: 'vi', narratorFunction: 'CONTEXT', newInformation: ['call'], newInformationRefs: ['e1'], emotionTag: 'NEUTRAL', ...extra }] });
  const MODEL = { events: [{ id: 'e1', startSec: 8, endSec: 25, summary: 'the call', isReveal: false }], quotes: [] };
  const withModes = () => Delivery.applyDeliveryBlocks(BEATS, BLOCKS());

  await ok('Writer: ONE request covers the block; voice measured ONCE against the whole block', async () => {
    const engine = narrEngine([line(PASSAGE)]);
    const measured = [];
    const service = { measuredVoice: async (_p, text) => { measured.push(text); return { meta: { duration: 13.6 } }; } };
    const out = await BlockNarration.narrateBlocks({ engine, service, story: { scriptId: 1 }, model: MODEL, beats: withModes(), blocks: BLOCKS(), evidence: [] });
    assert.strictEqual(engine.asks.length, 1);
    assert.strictEqual(engine.asks[0].input.blocks.length, 1);
    assert.deepStrictEqual(engine.asks[0].input.blocks[0].beats.map(b => b.beatId), ['n1', 'n2', 'n3']);
    assert.deepStrictEqual(measured, [PASSAGE]);
    const blk = out.blocks.find(b => b.blockId === 'story_setup');
    assert.strictEqual(blk.narrationText, PASSAGE);
    assert.strictEqual(blk.rawBlockVoiceSec, 13.6);
    assert.strictEqual(blk.fitRatio, 0.85);
    assert.strictEqual(out.blocks.filter(b => b.mode === 'raw_evidence').length, 3);
  });

  await ok('Writer: voice that cannot fit -> text-only rewrite FIRST; still unfit -> director repair request (never dropped/trimmed)', async () => {
    const shorter = 'Officers raced to a reported assault. The caller said his girlfriend was being attacked inside. The officer had no idea what waited.';
    const engine = narrEngine([line(PASSAGE), line(shorter)]);
    const durations = { [PASSAGE]: 18.4, [shorter]: 11.2 };
    const service = { measuredVoice: async (_p, text) => ({ meta: { duration: durations[text] } }) };
    const out = await BlockNarration.narrateBlocks({ engine, service, story: { scriptId: 1 }, model: MODEL, beats: withModes(), blocks: BLOCKS(), evidence: [] });
    assert.strictEqual(engine.asks.length, 2);
    assert.match(engine.asks[1].key, /_rewrite1-/);
    assert.match(engine.asks[1].input.blocks[0].rewriteReason, /18\.40s of speech for a 16s block/);
    assert.strictEqual(out.blocks.find(b => b.blockId === 'story_setup').narrationText, shorter);
    const stuck = narrEngine([line(PASSAGE), line(PASSAGE), line(PASSAGE)]);
    await assert.rejects(BlockNarration.narrateBlocks({ engine: stuck, service: { measuredVoice: async () => ({ meta: { duration: 19 } }) }, story: { scriptId: 1 }, model: MODEL, beats: withModes(), blocks: BLOCKS(), evidence: [] }),
      e => e.kind === 'DIRECTOR_REPAIR_REQUIRED' && e.details.violations[0].code === 'NARRATED_BLOCK_VOICE_OVERFLOW' && e.details.violations[0].blockId === 'story_setup');
    assert.strictEqual(stuck.asks.length, 3, 'initial + 2 text rewrites, then report');
  });

  await ok('Writer: the existing narration gates run on the block passage (e.g. ungrounded claim -> rewrite)', async () => {
    const engine = narrEngine([line(PASSAGE, { newInformationRefs: ['nope'] }), line(PASSAGE)]);
    const out = await BlockNarration.narrateBlocks({ engine, service: { measuredVoice: async () => ({ meta: { duration: 13 } }) }, story: { scriptId: 1 }, model: MODEL, beats: withModes(), blocks: BLOCKS(), evidence: [] });
    assert.strictEqual(engine.asks.length, 2);
    assert.match(engine.asks[1].input.blocks[0].rewriteReason, /ungrounded/);
    assert.strictEqual(out.audit.rewrites[0].blocks[0].code, 'BLOCK_NARRATION_GATE');
  });

  // ---------------------------------------------------------------- media critic: delivery
  await ok('Critic: delivery issues map to regions + delivery blocks; cold-viewer verdict is enforced', async () => {
    const Critic = require(svc('scopeMediaCriticService.js'));
    for (const t of ['unbridged_perspective_shift', 'unexplained_time_jump', 'raw_explanation_overlong', 'narration_underused', 'narration_overwrites_evidence', 'weak_narrator_to_raw_handoff', 'weak_raw_to_narrator_handoff']) {
      assert.ok(Critic.ISSUE_TYPES.includes(t), t);
    }
    const tl = [{ beatId: 'n1', outputStartSec: 6, outputEndSec: 11 }, { beatId: 'r1', outputStartSec: 22, outputEndSec: 36 }];
    const base = { scopeSurvived: true, centralQuestionActiveThroughout: true, endingIsConsequenceOfCentralConflict: true, finalFootageUsable: true, observedStory: '', summary: '' };
    const n = Critic.normalizeCritique({ ...base, coldViewerCanFollow: true, issues: [{ type: 'weak_narrator_to_raw_handoff', severity: 'blocking', outputStartSec: 20, outputEndSec: 24, evidence: 'x', whyItFails: 'y' }] }, { durationSec: 60, timeline: tl, deliveryAware: true });
    assert.strictEqual(n.isCompliant, false);
    assert.ok(n.weakRegions[0].deliveryIssue && n.weakRegions[0].beatIds.includes('r1'));
    assert.strictEqual(n.deliveryIssues.length, 1);
    const lost = Critic.normalizeCritique({ ...base, coldViewerCanFollow: false, coldViewerNotes: 'who is talking at 22s?', issues: [] }, { durationSec: 60, timeline: tl, deliveryAware: true });
    assert.strictEqual(lost.isCompliant, false);
    assert.strictEqual(lost.issues[0].derivedFromVerdict, 'coldViewerCanFollow');
    assert.strictEqual(Critic.normalizeCritique({ ...base, issues: [] }, { durationSec: 60, timeline: tl, deliveryAware: true }).status, 'MEDIA_CRITIC_INVALID');
    const prompt = Critic.buildPrompt({ storyScope: {}, beats: [{ beatId: 'n1' }, { beatId: 'r1' }] }, tl, 60,
      [{ blockId: 'story_setup', mode: 'narrated_story', beatIds: ['n1'], outputStartSec: 6, outputEndSec: 22, narrationText: PASSAGE }]);
    assert.match(prompt, /INTENDED DELIVERY/);
    assert.match(prompt, /who is speaking,\s*why we moved here,\s*what changed,\s*and why the next raw clip matters/);
    assert.match(prompt, /NARRATOR \(voiceover\): "Officers were responding/);
  });

  console.log(`\n${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
