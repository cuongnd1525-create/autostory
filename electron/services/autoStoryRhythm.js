const VERSION = 1;
function analyze(script) {
  let total = 0, narration = 0, hook = 0, opening = true, run = null;
  const runs = [];
  for (const s of script.segments || []) {
    const duration = Math.max(0, Number(s.end) - Number(s.start));
    if (!Number.isFinite(duration)) continue;
    if (opening && s.storyRole === 'hook') hook += duration; else opening = false;
    const isNarration = s.audioMode === 'voiceover_only' || s.audioMode === 'mixed_ducking' || Boolean(s.voiceoverText?.trim());
    if (isNarration) {
      narration += duration;
      if (!run) { run = { start: total, duration: 0, ids: [] }; runs.push(run); }
      run.duration += duration; run.ids.push(s.id);
    } else run = null;
    total += duration;
  }
  const ratio = total ? narration / total : 0;
  return { totalSec: total, hookSec: hook, narrationSec: narration, originalSec: total - narration,
    narrationRatio: ratio, originalRatio: total ? 1 - ratio : 0, runs,
    longRuns: runs.filter(r => r.duration > 12),
    needsReview: ratio > 0.60 || runs.some(r => r.duration > 20),
    severe: ratio > 0.68 || runs.some(r => r.duration > 25) };
}
const policy = `BODYCAM AUDIO-FIRST & AUDIO-SANDWICH EDITING: Aim for a balanced distribution between authentic on-scene audio and gripping tool narration (up to 50-65% narration for TikTok narrative-led shorts, or 30-40% for dialogue-heavy cases), measured in actual output seconds, not segment counts. This is a storytelling target, not permission to pad or fabricate. Select substantial meaningful participant exchanges/actions FIRST; write bridges only for missing context, chronology, cognitive framing, or an evidenced contradiction. Do not retell visible actions or replace a usable participant account with a summary. Never restore external host audio to meet a ratio.
Treat consecutive narrator segments as ONE continuous block even across cuts or role changes. Blocks over about 20 seconds need scrutiny; over 25 seconds need correction or a specific evidence-based exception (e.g. Type B opening hook over arrival footage). Do not evade this by inserting token silent/irrelevant original-audio clips. DEAD AIR RULE: Never allow uninterrupted silent scene footage without dialogue or narration to exceed 3.0 seconds. Preserve complete thoughts and necessary participant reactions. Keep aftermath concise; omit a long procedural trial recap unless it answers the central question. Evidence-grounded irony or an optional genuine viewer question may help, but never force insults or a CTA.
If clean source audio is genuinely insufficient, report rhythmException explaining specific unavailable/host-contaminated evidence and why the remaining narration is essential. Do not add filler to reach a minimum duration or narration percentage. A short strong original-led film need not add narration just to reach 30%.`;
function analyzeV2(script, assessment) {
  const base = analyze(script);
  return { ...base, policyVersion: 2, targetOriginalRatio: [.7, .85], targetNarrationRatio: [.15, .3],
    needsReview: base.runs.some(r => r.duration > 20) || base.narrationRatio > .3,
    semanticProvenance: assessment ? 'AI assessment, not deterministic measurement' : 'not assessed',
    informationGain: assessment?.informationGain ?? null, storyProgression: assessment?.storyProgression ?? null,
    deadStorySpans: assessment?.deadStorySpans ?? null, procedureDensity: assessment?.procedureDensity ?? null,
    duplicateMeaning: assessment?.duplicateMeaning ?? null, reactionDensity: assessment?.reactionDensity ?? null,
    narrationDependency: assessment?.narrationDependency ?? null };
}
module.exports = { VERSION, analyze, analyzeV2, policy };
