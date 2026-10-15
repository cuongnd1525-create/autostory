const assert = require('node:assert/strict');
const Gate = require('../electron/services/autoStoryReleaseGate');
const pass = { finalCheck: { verdict: 'PASS' }, needsUserReview: false };
const media = { width: 1080, height: 1920, duration: 78.4, hasAudio: true };
const cfg = { targetDurationMinSec: 65, targetDurationMaxSec: 90 };
assert.equal(Gate.assess({ audit: pass, media, bytes: 100000, file: 'final.mp4', config: cfg, renderQa: { passed: true } }).status, 'ready_to_publish');
assert.equal(Gate.assess({ audit: pass, media: { ...media, width: 1920, height: 1080 }, bytes: 100000, file: 'final.mp4', config: cfg, renderQa: { passed: true } }).status, 'needs_attention');
assert.equal(Gate.assess({ audit: pass, media, bytes: 100000, file: 'final.mp4', config: cfg, renderQa: { passed: false } }).status, 'needs_attention');
assert.equal(Gate.assess({ audit: { finalCheck: { verdict: 'FAIL' } }, media, bytes: 100000, file: 'final.mp4', config: cfg, renderQa: { passed: true } }).status, 'needs_attention');
assert.equal(Gate.assess({ audit: pass, media, bytes: 0, file: 'final.mp4', config: cfg, renderQa: { passed: true } }).status, 'needs_attention');
assert.equal(Gate.assess({ audit: pass, media, bytes: 100000, file: 'final.mp4', config: cfg }).status, 'needs_attention');
(async () => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'v4-final-editorial-gate-'));
  try {
    const root = path.join(temp, 'auto-story-fast');
    await fs.mkdir(root, {recursive:true});
    const video = path.join(temp, 'final.mp4');
    await fs.writeFile(video, Buffer.alloc(5000));
    const store = {
      getProjectPaths: () => ({analysisDir:temp}),
      getProject: async () => ({
        autoStoryContractVersion:4, autoStoryConfig:cfg,
        analysis:{ highlightVariants:[{scriptId:1,artifacts:{
          finalVideoPath:video, finalRenderedAt:'2026-10-15T01:00:00.000Z',
          fastDraftRenderedAt:'2026-10-15T00:00:00.000Z',
          renderQaPath:path.join(temp,'qa.json')
        }}]}
      })
    };
    await fs.writeFile(path.join(temp,'qa.json'), JSON.stringify({passed:true}));
    const withoutAi = await Gate.finalizeVariant({
      store, dubbing:{renderHighlightCutProject:async()=>{throw Error('must reuse final')}},
      workspaceRoot:temp,projectId:'p',scriptId:1, settings:{}, audit:pass,
      probe:async()=>media
    });
    assert.equal(withoutAi.needsUserReview,true,
      'V4 may not claim ready-to-publish with no independent final review');
    assert.ok(withoutAi.releaseGate.issues.some(s=>s.includes('Independent final editorial review unavailable')));

    await fs.writeFile(path.join(root,'script-1.json'), JSON.stringify({
      story_contract:{ beats:[{beatId:'hook', sourceStartSec:1,sourceEndSec:4}],
        storyScope:{ centralConflict:'The real suspicion' },hookPromise:'Will the officer find it?' }
    }));
    const critic = require('../electron/services/scopeMediaCriticService');
    const original = critic.critiqueScopedRender;
    try {
      let seen = null;
      critic.critiqueScopedRender = async (spine,args) => {
        seen = {spine,args};
        return {status:'SCOPED_MEDIA_CRITIC_OK', isCompliant:false,
          summary:'Unnatural narrator and repetitive raw procedure',
          weakRegions:[{type:'narration_robotic',outputStartSec:8,outputEndSec:12}]};
      };
      const blocked = await Gate.finalizeVariant({
        store, dubbing:{renderHighlightCutProject:async()=>{throw Error('must reuse final')}},
        workspaceRoot:temp,projectId:'p',scriptId:1,settings:{},audit:pass,
        aiService:{generateJsonFromFiles:async()=>{}},probe:async()=>media
      });
      assert.equal(blocked.needsUserReview,true);
      assert.equal(seen.args.mp4Path,video,'review REAL final MP4, not draft');
      assert.equal(seen.spine.beats[0].beatId,'hook');
      const auditFile = JSON.parse(await fs.readFile(path.join(root,'final-editorial-audit-1.json'),'utf8'));
      assert.equal(auditFile.isCompliant,false);
      critic.critiqueScopedRender = async ()=>({
        status:'SCOPED_MEDIA_CRITIC_OK', isCompliant:true,summary:'Final MP4 passed'
      });
      const approved = await Gate.finalizeVariant({
        store, dubbing:{renderHighlightCutProject:async()=>{throw Error('must reuse final')}},
        workspaceRoot:temp,projectId:'p',scriptId:1,settings:{},audit:pass,
        aiService:{generateJsonFromFiles:async()=>{}},probe:async()=>media
      });
      assert.equal(approved.needsUserReview,false,
        'a grounded and independently accepted full-quality MP4 can publish');
    } finally { critic.critiqueScopedRender = original; }
  } finally {await fs.rm(temp,{recursive:true,force:true});}
  console.log('V4 independent final-MP4 editorial review gates passed');
})().catch(err=>{ console.error(err); process.exitCode=1; });
console.log('autoStoryReleaseGate tests passed');
