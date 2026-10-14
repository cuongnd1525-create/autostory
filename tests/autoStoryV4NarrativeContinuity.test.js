const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Continuity = require('../electron/services/autoStoryV4NarrativeContinuityGate');
const Director = require('../electron/services/editorialDirectorService');
const Pipeline = require('../electron/services/autoStoryV3Pipeline');

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
const audit = Continuity.check(original);
assert.equal(audit.passed, false, 'real 88s video with 18 all-raw beats is unacceptable');
assert.ok(audit.violations.length >= 5, 'detects rewind and long jumps even inside one raw block');
assert.ok(audit.violations.some(v=>v.sourceGapSec < -80), 'teaser rewind is unbridged');
assert.ok(audit.violations.some(v=>v.sourceGapSec > 50), 'final jump has no narrator');
assert.ok(audit.violations.every(v=>v.code==='UNBRIDGED_EDL_TIME_JUMP'));

// The gate is not a narrator quota: continuous source evidence passes raw.
const continuous = { ...original, beats: [{ beatId:'a',sourceStartSec:10,sourceEndSec:17 },
  {beatId:'b',sourceStartSec:20,sourceEndSec:27}],
  deliveryBlocks:[{blockId:'raw',mode:'raw_evidence',beatIds:['a','b']}] };
assert.equal(Continuity.check(continuous).passed,true);

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
