const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Continuity = require('../electron/services/autoStoryV4NarrativeContinuityGate');
const Director = require('../electron/services/editorialDirectorService');
const Pipeline = require('../electron/services/autoStoryV3Pipeline');
const Critic = require('../electron/services/scopeMediaCriticService');

const times = [
  [422.4,426.8], [334.6,340.8], [364.3,369.8], [369.8,377.4],
  [378.6,383], [384.7,388.8], [388.8,396], [402,406.6], [406.6,411.2],
  [420,426.8], [435.3,438.4], [439.5,440.9], [440.9,445.3],
  [448.1,450.8], [476.2,480.6], [480.6,488.2], [488.2,491.2],
  [542.3,548.6]
];
const beats = times.map(([sourceStartSec, sourceEndSec], index) => ({
  beatId: `beat-${index+1}`, sourceStartSec, sourceEndSec,
  narrativeRole: index===0?'cold_open':index===17?'payoff':'escalation'
}));
const originalRanges = beats.map(b => [b.beatId,b.sourceStartSec,b.sourceEndSec]);
const original = {
  editorialContract: Director.DIRECTOR_CONTRACT,
  beats, storyScope: { storyScopeId: 'driver-search' },
  deliveryBlocks: [{ blockId: 'all_raw', mode: 'raw_evidence', beatIds: beats.map(b=>b.beatId),
    ownershipReason:'Real interaction', storyFunction:'Evidence', viewerStateChanges:1, blockSummary:'Search' }]
};
// Critic must not certify an MP4 without explicitly listening at each major
// source-time boundary. A planned narrator block alone is NOT audio evidence.
const timeline = [
  { beatId:'a', sourceStartSec:60, sourceEndSec:66, outputStartSec:0, outputEndSec:6 },
  { beatId:'b', sourceStartSec:4, sourceEndSec:18, outputStartSec:6, outputEndSec:20 }
];
assert.equal(Critic.majorSourceJumps(timeline).length,1);
const mediaReply = {
  scopeSurvived:true, centralQuestionActiveThroughout:true,
  endingIsConsequenceOfCentralConflict:true, finalFootageUsable:true,
  hookPromiseSupported:true, observableEndingConsequence:true,
  repetitiveProcedureWithoutProgress:false,
  coldViewerCanFollow:true, coldViewerNotes:'', observedStory:'Clear rewind and payoff.',
  openingCuriosity:{firstSecondsDescription:'The denial',createsCuriosity:true},
  finalSeconds:{visualDescription:'Known result',subjectClearlyVisible:true},
  transitions:[], issues:[], summary:'Coherent',
  productionQuality: { narratorSoundsNatural:true, narratorAddsNecessaryContext:true,
    narratorHandoffsClean:true, essentialDialogueClear:true, activeFootageReadable:true,
    importantVisualTextReadable:true, pacingMaintainsProgress:true,
    audibleObservation:'Audible narrator clearly orients the rewind',
    visualObservation:'Officer and action remain readable in the frame',
    pacingObservation:'Each moment adds a new consequence' }
};
let report = Critic.normalizeCritique(mediaReply,{timeline,durationSec:20,deliveryAware:true});
assert.equal(report.status,'MEDIA_CRITIC_INVALID','AI cannot omit the important rewind');
report = Critic.normalizeCritique({ ...mediaReply, transitions:[{
  outputSec:6, change:'time', whatViewerSeesAndHears:'Narrator audibly explains that we are returning to the original roadside stop.',
  coldViewerUnderstandsWhy:true
}] },{timeline,durationSec:20,deliveryAware:true});
assert.equal(report.isCompliant,true,'verified audible transition allows the edit');
// Even a 2s source-time gap may create an unexplained topic/person switch.
const shortCut = [
  { beatId: 'context', sourceStartSec: 10, sourceEndSec: 14, outputStartSec: 0, outputEndSec: 4 },
  { beatId: 'conflict', sourceStartSec: 16, sourceEndSec: 22, outputStartSec: 4, outputEndSec: 10 }
];
assert.equal(Critic.majorSourceJumps(shortCut).length, 0);
assert.equal(Critic.normalizeCritique(mediaReply, { timeline: shortCut, durationSec: 10, deliveryAware: true }).status,
  'MEDIA_CRITIC_INVALID', 'a short but omitted scene transition must not be accepted');

const audit = Continuity.check(original);
assert.equal(audit.passed, false, 'real 88s video with 18 all-raw beats is unacceptable');
assert.ok(audit.violations.length >= 4, 'detects rewind and long jumps even inside one raw block');
assert.ok(audit.violations.some(v=>v.sourceGapSec < -80), 'teaser rewind is unbridged');
assert.ok(audit.violations.some(v=>v.sourceGapSec > 50), 'final jump has no narrator');
assert.ok(audit.violations.every(v=>v.code==='UNBRIDGED_EDL_TIME_JUMP'));

// The gate is not a narrator quota: continuous source evidence passes raw.
const continuous = { ...original, beats: [{ beatId:'a',sourceStartSec:10,sourceEndSec:17 },
  {beatId:'b',sourceStartSec:20,sourceEndSec:27}],
  deliveryBlocks:[{blockId:'raw',mode:'raw_evidence',beatIds:['a','b']}] };
assert.equal(Continuity.check(continuous).passed,true);
const shortRewind = { ...continuous, beats: [
  { beatId: 'a', chronologyMode: 'teaser', sourceStartSec: 20, sourceEndSec: 26 },
  { beatId: 'b', chronologyMode: 'rewind', sourceStartSec: 17, sourceEndSec: 19 }
] };
assert.equal(Continuity.check(shortRewind).passed, false,
  'an explicit rewind needs a handoff even if the source time gap is under 20s');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'v4-continuity-'));
  try {
    let called = 0, built = 0;
    const engine = { project: { autoStoryContractVersion: 4 },
      config: { narration: { enabled: true } } };
    const makeGuided = source => ({
      ...source, deliveryBlocks: beats.map((b,i)=>({
        blockId: `block-${i+1}`,
        beatIds: [b.beatId],
        mode: 'narrated_story',
        narrationIntent: `Orient the viewer to the verified change leading into ${b.beatId} and prepare the next raw moment`
      }))
    });
    const result = await Pipeline.buildDirectorScript({
      engine, service:{},opts:{},model:{},root,emit:()=>{},scriptId:1
    },{...original,scriptId:1},{
      build: async (_eng,_srv,_opts,story) => {
        built++;
        assert.equal(Continuity.check(story).passed,true);
        assert.deepEqual(story.beats.map(b=>[b.beatId,b.sourceStartSec,b.sourceEndSec]),originalRanges);
        return { script: {segments:[]} };
      },
      deliveryRepair: async (_eng,request) => {
        called++;
        assert.ok(request.violations.some(v=>v.code==='UNBRIDGED_EDL_TIME_JUMP'));
        return { spine: makeGuided(request.spine) };
      },
      repair:async()=>{throw Error('Must not rewrite EDL for bridge-only issue');}
    });
    assert.equal(called,1);
    assert.equal(built,1);
    assert.ok(result.repairedSpine);
    const continuityLog=JSON.parse(await fs.readFile(path.join(root,'narrative-continuity-1.json'),'utf8'));
    assert.equal(continuityLog.passed,false);
    const after=JSON.parse(await fs.readFile(path.join(root,'narrative-continuity-1-repair-1.json'),'utf8'));
    assert.equal(after.passed,true);

    await assert.rejects(()=>Pipeline.buildDirectorScript({
      engine, service:{},opts:{},model:{},root,emit:()=>{},scriptId:2
    },{...original,scriptId:2},{
      build:async()=>{throw Error('must not render when all raw');},
      deliveryRepair:async(_e,request)=>({spine:request.spine})
    }),e=>e.kind==='DIRECTOR_EDL_INVALID'&&/unbridged scene transitions/.test(e.message),
    'quality gate must fail closed when Gemini cannot produce a causal bridge');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
  console.log('V4 narrator continuity and locked-EDL repair tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
