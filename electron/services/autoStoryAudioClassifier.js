const { StoryError } = require('./autoStoryRepairRouter');
const CLEAN = new Set(['participant_speech', 'officer_speech', 'scene_sound']);
function disposition(audio) {
  if (!audio || ![...CLEAN, 'external_narrator', 'mixed'].includes(audio.audioType) || !Number.isFinite(audio.confidence) || audio.confidence < .85 || audio.confidence > 1) return 'VERIFY';
  return CLEAN.has(audio.audioType) ? 'CLEAN' : 'REPLACE';
}
function requireOriginal(audio) {
  const result = disposition(audio);
  if (result === 'VERIFY') throw new StoryError('VERIFY_AUDIO', 'Original audio requires a focused listening verification.');
  if (result !== 'CLEAN') throw new StoryError('BAD_CANDIDATE', 'Source audio contains an external narrator or mixed speech; select a clean original moment.');
}
module.exports = { disposition, requireOriginal };
