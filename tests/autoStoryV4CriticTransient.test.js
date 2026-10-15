'use strict';
// Regression for 1015_01: draft is rendered (116.56s, 13 segments),
// but Vertex's independent media critic returns 429 Resource exhausted.
// A model outage MUST NOT be represented as a negative editorial verdict,
// nor trigger another full render / automated publish.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Critic = require('../electron/services/scopeMediaCriticService');
const Pipeline = require('../electron/services/autoStoryV3Pipeline');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v4-critic-429-'));
  try {
    const mp4 = path.join(root, 'already-rendered-draft.mp4');
    await fs.writeFile(mp4, 'draft bytes preserved');
    const spine = {
      centralViewerQuestion: 'Who took the truck?',
      hookPromise: 'Witness has phone footage',
      beats: [
        {beatId:'hook',sourceStartSec:42,sourceEndSec:48},
        {beatId:'ending',sourceStartSec:235,sourceEndSec:245}
      ]
    };
    let calls = 0;
    const ai = { generateJsonFromFiles: async () => {
      calls++;
      const e = new Error('Vertex AI request failed (429): Resource exhausted. Please try again later.');
      e.httpStatus = 429; throw e;
    }};
    const direct = await Critic.critiqueScopedRender(spine, {
      aiService:ai, mp4Path:mp4, actualMp4DurationSec:116.566
    });
    assert.equal(direct.status,'MEDIA_CRITIC_UNAVAILABLE');
    assert.equal(direct.retryable,true);
    assert.equal(direct.isCompliant,false);
    assert.equal(direct.providerStatus,429);
    assert.equal(calls,1,'no rapid retry of saturated preview model pool');

    calls=0;
    const notes=[];
    const record=path.join(root,'review-state-1.json');
    const audit=await Pipeline.auditDirectorDraft({
      service:{ffmpeg:{probeVideo:async()=>({duration:116.566})}},
      opts:{workspaceRoot:root,projectId:'p',onProgress:x=>notes.push(x)},
      engine:{},model:{},root,id:1,record,currentMp4:mp4,spine,
      script:{segments:[]},ai
    });
    assert.equal(calls,1,'no second expensive MP4 upload on transient 429');
    assert.equal(audit.status,'MEDIA_CRITIC_PENDING');
    assert.equal(audit.pending,true);
    assert.equal(audit.complete,false);
    assert.equal(audit.needsUserReview,true);
    assert.equal(audit.retryable,true);
    assert.equal(audit.finalCheck.complete,false);
    assert.equal(audit.finalCheck.verdict,'PENDING');
    assert.equal(audit.draftVideoPath,mp4);
    assert.ok(notes.some(x=>/Draft MP4 preserved/.test(x.message)));
    assert.equal((await fs.readFile(mp4,'utf8')),'draft bytes preserved');
    assert.equal(JSON.parse(await fs.readFile(record,'utf8')).status,'MEDIA_CRITIC_PENDING');

    const cadenceFile=JSON.parse(await fs.readFile(path.join(root,'audio-cadence-audit-1.json'),'utf8'));
    assert.equal(cadenceFile.advisoryOnly,true);
    assert.equal(cadenceFile.beatCount,2);
    assert.deepEqual(cadenceFile.advisoryFlags,[]);

    const exampleBeats=[
      ['h',0,8],['a',8,45],['n1',45,51],['b',51,91],['n2',91,99],['end',99,117]
    ].map(([beatId,sourceStartSec,sourceEndSec])=>({beatId,sourceStartSec,sourceEndSec}));
    const exampleBlocks=[
      {blockId:'raw1',mode:'raw_evidence',beatIds:['h','a']},
      {blockId:'narr1',mode:'narrated_story',beatIds:['n1']},
      {blockId:'raw2',mode:'raw_evidence',beatIds:['b']},
      {blockId:'narr2',mode:'narrated_story',beatIds:['n2']},
      {blockId:'raw3',mode:'raw_evidence',beatIds:['end']}
    ];
    const cadence=Critic.deliveryCadenceMetrics({beats:exampleBeats,deliveryBlocks:exampleBlocks});
    assert.equal(cadence.totalSec,117);
    assert.equal(cadence.narratedSec,14);
    assert.equal(cadence.rawSec,103);
    assert.equal(cadence.narratedBlockCount,2);
    assert.equal(cadence.singleBeatNarrationBlocks,2);
    assert.ok(cadence.longestRawRunSec>=40);
    assert.ok(cadence.advisoryFlags.includes('LONG_RAW_EXPOSITION_TO_INSPECT'));
    assert.ok(cadence.advisoryFlags.includes('NARRATION_ONLY_ON_SINGLE_BEATS_TO_INSPECT'));
    assert.equal(cadence.advisoryOnly,true,
      'the metrics must not impose an arbitrary narrator quota or auto-PASS');

    const temporary=await Critic.critiqueScopedRender(spine,{
      aiService:{generateJsonFromFiles:async()=>{throw new Error('request failed (503) Service Unavailable')}},
      mp4Path:mp4,actualMp4DurationSec:116.566
    });
    assert.equal(temporary.status,'MEDIA_CRITIC_UNAVAILABLE');
    assert.equal(temporary.providerStatus,503);

    // Malformed response is NOT a 429; this remains an actual invalid response
    // and cannot be misclassified as a recoverable provider outage.
    const malformed=await Critic.critiqueScopedRender(spine,{
      aiService:{generateJsonFromFiles:async()=>{throw new Error('malformed JSON response')}},
      mp4Path:mp4,actualMp4DurationSec:116.566
    });
    assert.equal(malformed.status,'MEDIA_CRITIC_INVALID');
    assert.notEqual(malformed.retryable,true);
    console.log('V4 transient MP4 media critic: 429/503 pending, draft preserved, no false PASS or repeat calls');
  } finally {
    await fs.rm(root,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
