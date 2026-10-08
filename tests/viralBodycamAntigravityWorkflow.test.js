// Tests the actual manual Gemini Draft Review / Antigravity Bodycam Part1 profile.
// Run: node tests/viralBodycamAntigravityWorkflow.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Review = require('../electron/services/geminiDraftReviewService');

const variant = {
  id: 'variant_01', scriptId: 1, partNumber: 1,
  promptProfile: 'viral_tiktok_crime_part1',
  workflow: 'highlight_cut',
  revisionNumber: 1,
  segments: [],
  title: 'Verified crash response'
};
const prompt = Review.buildReviewPrompt({
  variant,
  draftTimeline: { segments: [], totalDurationSec: 119.4 },
  sourceProxyFiles: ['analysis-proxy.mp4'],
  hasTranscript: false,
  sourceCoverageComplete: true
});
assert.match(prompt, /VIRAL BODYCAM PART 1 \/ 8-BEAT SANDWICH REVIEW/);
assert.match(prompt, /promised.*event|Hook contract/i);
assert.match(prompt, /110.?125 seconds/);
assert.match(prompt, /rebuild story_blueprint/i);
assert.match(prompt, /wrong Hook|Wrong Hook/i);
assert.match(prompt, /original_audio.*voiceover_only/);

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const stage1 = fs.readFileSync(path.join(__dirname, '..', 'electron/services/manualAntigravityStage1Service.js'), 'utf8');
assert.match(renderer, /function buildViralTikTokCrimePart1PromptTemplate/);
assert.match(renderer, /SOURCE-DRIVEN INCIDENT GATE/);
assert.match(renderer, /never pad static procedural footage/i);
assert.match(stage1, /name: "The Incident Begins"/);
assert.match(stage1, /name: "The Investigation Deepens"/);
assert.match(stage1, /name: "The Verified Outcome"/);

const other = Review.buildReviewPrompt({
  variant: { ...variant, promptProfile: 'viral_police_blotter' },
  draftTimeline: { segments: [], totalDurationSec: 119.4 },
  sourceProxyFiles: [],
  hasTranscript: false,
  sourceCoverageComplete: false
});
assert.doesNotMatch(other, /VIRAL BODYCAM PART 1 \/ 8-BEAT SANDWICH REVIEW/,
  'Bodycam Part1 override must not affect other modes');
console.log('Antigravity bodycam prompt routing assertions passed.');

// Deterministic hard gate regression: complete MP4 windows and source-grounded
// Hook + usable ending are mandatory. An AI "PASS" without evidence must fail.
const Gate = require('../electron/services/bodycamQualityGate');
const ranges = [[0,8],[8,16]];
const audit = {
  bodycamQualityAudit: {
    observationWindows: ranges.map(([startSec,endSec]) => ({
      startSec, endSec, visibleAction:'Officer response',
      audibleContent:'Dialogue', storyProgress:'New verified fact',
      narratorNaturalness:'not_applicable', captionReadability:'readable',
      framingUsability:'usable', weak:false, reason:''
    })),
    hookPromise: { promise:'What happened?', payoffEvidence:'Verified later footage',
      payoffSourceSec:81, resolvedWithinPart:true, verifiedNextPartOpenLoop:false },
    ending: { usableAudio:true, usablePicture:true, grounded:true, sourceEvidence:'Verified ending frame' }
  },
  revisedScript: { prompt_profile:'viral_tiktok_crime_part1', scriptId:1,
    segments: [{sourceStartSec:0,sourceEndSec:60,audio_mode:'original_audio'},
      {sourceStartSec:60,sourceEndSec:115,audio_mode:'voiceover_only'}] }
};
assert.equal(Gate.checkReview(audit,{durationSec:16,scriptId:1}).passed,true);
assert.equal(Gate.checkReview({...audit,bodycamQualityAudit:undefined},{durationSec:16,scriptId:1}).passed,false);
assert.equal(Gate.checkReview({...audit,bodycamQualityAudit:{
  ...audit.bodycamQualityAudit,observationWindows:[audit.bodycamQualityAudit.observationWindows[0]]
}},{durationSec:16,scriptId:1}).passed,false);
assert.equal(Gate.checkReview({...audit,bodycamQualityAudit:{
  ...audit.bodycamQualityAudit, hookPromise: {...audit.bodycamQualityAudit.hookPromise,
    payoffEvidence:'',resolvedWithinPart:false,verifiedNextPartOpenLoop:false}
}},{durationSec:16,scriptId:1}).passed,false);
assert.equal(Gate.checkReview({...audit,bodycamQualityAudit:{
  ...audit.bodycamQualityAudit, ending:{ ...audit.bodycamQualityAudit.ending,usablePicture:false}
}},{durationSec:16,scriptId:1}).passed,false);
assert.equal(Gate.checkReview({...audit,bodycamQualityAudit:{
  ...audit.bodycamQualityAudit, observationWindows:[
    {...audit.bodycamQualityAudit.observationWindows[0],framingUsability:undefined},
    audit.bodycamQualityAudit.observationWindows[1]
  ]
}},{durationSec:16,scriptId:1}).passed,false);
assert.deepEqual(Gate.parseSilence('[silencedetect] silence_start: 88.9\\n[silencedetect] silence_end: 94.95 | silence_duration: 6.05'),
  [{startSec:88.9,endSec:94.95,durationSec:6.05}]);
console.log('Bodycam MP4 coverage, Hook, ending, audio parser gate assertions passed.');
