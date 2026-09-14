function taskFor(key) {
  if (key.startsWith('edit-repair-')) return 'auto_story_repair';
  if (key.startsWith('story-plan')) return 'auto_story_plan';
  if (key.startsWith('final-check')) return 'auto_story_final';
  if (key.startsWith('review-')) return 'auto_story_review';
  if (/^(voice-text|voice-fit|rhythm)-/.test(key)) return 'auto_story_repair';
  if (key.startsWith('edit-')) return 'auto_story_edit';
  return null;
}
const modelFields = {
  auto_story_plan: ['vertexAutoStoryPlanModel', 'vertexAnalysisModel', 'gemini-2.5-flash'],
  auto_story_edit: ['vertexAutoStoryEditModel', 'vertexQualityModel', 'gemini-2.5-pro'],
  auto_story_review: ['vertexAutoStoryReviewModel', 'vertexQualityModel', 'gemini-2.5-pro'],
  auto_story_repair: ['vertexAutoStoryRepairModel', 'vertexAnalysisModel', 'gemini-2.5-flash'],
  auto_story_final: ['vertexAutoStoryFinalModel', 'vertexAnalysisModel', 'gemini-2.5-flash']
};
module.exports = { taskFor, modelFields };
