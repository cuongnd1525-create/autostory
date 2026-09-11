const VERSION = 1;
function analyze(script) {
  let total = 0, narration = 0, hook = 0, opening = true, run = null;
  const runs = [];
  for (const s of script.segments || []) {
    const duration = Math.max(0, Number(s.end) - Number(s.start));
    if (!Number.isFinite(duration)) continue;
    if (opening && s.storyRole === 'hook') hook += duration; else opening = false;
    if (s.audioMode === 'voiceover_only') {
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
    needsReview: ratio > 0.405 || runs.some(r => r.duration > 12),
    severe: ratio > 0.405 || runs.some(r => r.duration > 20) };
}
const policy = `BODYCAM AUDIO-FIRST EDITING: Aim for 60-70% clean authentic scene audio and 30-40% tool narration, measured in actual output seconds, not segment counts. This is a storytelling target, not permission to pad or fabricate. Select substantial meaningful participant exchanges/actions FIRST; write bridges only for missing context, chronology or an evidenced contradiction. Do not retell visible actions or replace a usable participant account with a summary. Never restore external host audio to meet a ratio.
Treat consecutive narrator segments as ONE continuous block even across cuts or role changes. Blocks over about 12 seconds need scrutiny; over 20 seconds need correction or a specific evidence-based exception. Do not evade this by inserting token silent/irrelevant original-audio clips. Preserve complete thoughts and necessary participant reactions. Keep aftermath concise; omit a long procedural trial recap unless it answers the central question. Evidence-grounded irony or an optional genuine viewer question may help, but never force insults or a CTA. Hooks have no fixed duration: the actual selected action/quote plus necessary reaction must be understandable before narration begins.
If clean source audio is genuinely insufficient, report rhythmException explaining specific unavailable/host-contaminated evidence and why the remaining narration is essential. Do not add filler to reach a minimum duration or narration percentage. A short strong original-led film need not add narration just to reach 30%.`;
module.exports = { VERSION, analyze, policy };
