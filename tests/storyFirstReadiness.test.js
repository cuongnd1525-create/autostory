"use strict";
const assert = require("assert");
const {
  isStoryFirstSeries, preflightReadiness,
  resolvePreviewSubtitleLanguage
} = require("../electron/services/storyFirstReadinessService");

const project = { analysisWorkflow: "manual_gemini_draft_review" };
const profile = "viral_tiktok_crime_part1";
const readiness = (score, editorial, technical, passed = score >= 72) => preflightReadiness(
  project, { promptProfile: profile, viralPreflight: {
    score, passed,
    scoreBreakdown: {
      editorialReadiness: { score: editorial },
      technicalReadiness: { score: technical }
    },
    issues: ["Missing causal handoff", "Narrator ground truth uncertain"]
  } }
);
assert(isStoryFirstSeries(project, {promptProfile: profile}));
assert.strictEqual(readiness(95,95,95).accepted,true);
const mismatch = readiness(41,95,95);
assert.strictEqual(mismatch.accepted,false);
assert(mismatch.reasons[0].includes("41/100"));
assert.strictEqual(readiness(90,65,95).accepted,false, "editorial deficit must block even if total score high");
assert.strictEqual(readiness(90,95,65).accepted,false, "audio/technical deficit must block even if total score high");
assert.strictEqual(readiness(85,95,95,false).accepted,false, "explicit failed preflight must not be overwritten");
assert.strictEqual(preflightReadiness(project, {promptProfile:profile}).accepted,false, "missing score cannot pass");
assert.strictEqual(preflightReadiness(project, {
  promptProfile:profile, viralPreflight:{ score:41, passed:false }
}, { storyFirstAllowLowQualityDraft:true }).overridden,true);
assert.strictEqual(preflightReadiness({analysisWorkflow:"standard_highlight"},{
  promptProfile:profile, viralPreflight:{score:41}
}).accepted,true,"legacy workflows stay untouched");
assert.strictEqual(preflightReadiness(project,{promptProfile:"independent",viralPreflight:{score:41}}).accepted,true);
assert.strictEqual(resolvePreviewSubtitleLanguage(project,{},{
  promptProfile:profile
}),"en","US bodycam series preview must not run English->Vietnamese MT");
assert.strictEqual(resolvePreviewSubtitleLanguage(project,{storyFirstPreviewSubtitleLanguage:"vi"},{
  promptProfile:profile
}),"vi","explicit Vietnamese preview preference is supported");
assert.strictEqual(resolvePreviewSubtitleLanguage({...project,storyFirstPreviewSubtitleLanguage:"off"}, {},{promptProfile:profile}),"off");
assert.strictEqual(resolvePreviewSubtitleLanguage(project, {},{promptProfile:"independent"}),"vi");
console.log("story-first normalized-preflight readiness and US subtitle policy tests passed");
