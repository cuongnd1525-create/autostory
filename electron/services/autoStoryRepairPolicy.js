// Pure policy: change only weak regions when the story is sound.
// A broken story premise needs a fresh Director/Scope, not a local beat patch.
function chooseRepairStrategy(critic = {}, durationSec = 0) {
  const blocking = (critic.issues || []).filter(i => i.severity === 'blocking');
  if (critic.scopeSurvived === false || blocking.some(i => i.type === 'out_of_scope_branch')) {
    return { mode: 'scope_rebuild', reason: 'Rendered story crosses the selected Story Scope.' };
  }
  if (critic.hookPromiseResolved === false || critic.endingIsConsequence === false ||
      critic.centralQuestionActiveThroughout === false) {
    return { mode: 'edl_rebuild', reason: 'The hook, central question or ending fails at whole-story level.' };
  }
  // A targeted repair cannot safely lock unaffected beats if the critic has not
  // mapped an actual blocking region back to any EDL beat.
  if (blocking.some(i => !Array.isArray(i.beatIds) || !i.beatIds.length)) {
    return { mode: 'edl_rebuild', reason: 'Blocking MP4 finding cannot be mapped to any editable EDL beat.' };
  }
  const totalBadSeconds = blocking.reduce((sum, i) =>
    sum + Math.max(0, Math.min(durationSec, Number(i.outputEndSec) || 0) -
      Math.max(0, Number(i.outputStartSec) || 0)), 0);
  if (durationSec > 0 && totalBadSeconds / durationSec >= 0.42) {
    return { mode: 'edl_rebuild', reason: 'Blocking problems span too much of the timeline for a local patch.' };
  }
  return { mode: 'targeted', reason: 'Problems are localized to known output regions.' };
}
module.exports = { chooseRepairStrategy };
