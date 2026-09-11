const assert = require('assert/strict');
const Dubbing = require('../electron/services/dubbingService');
(async () => {
  const service = new Dubbing({ updateProject: async () => {} });
  service.ensureHighlightPreviewTranscript = async () => [{ startSec: 10, endSec: 12, text: 'Tiffany bad ASR' }];
  service.buildHighlightDraftVoiceTranscript = async () => new Map();
  const project = { autoStoryPipelineVersion: 'editorial-v1', analysis: {
    activeVariantId: 'v1', highlightVariants: [{ id: 'v1', scriptId: 1 }]
  }, autoStoryPreviewSubtitleRepairs: [{ scriptId: 1, segmentId: 's1', audioMode: 'original_audio',
    sourceStartSec: 10, sourceEndSec: 12, correctedVi: 'Tôi nghĩ có tiếng súng ở đây.' }] };
  const result = await service.buildHighlightFastDraftPreviewSubtitles({ project, settings: {}, segments: [
    { id: 's1', sourceStartSec: 10, sourceEndSec: 12, duration: 2, audioMode: 'original_audio' }
  ] });
  assert(result[0].previewSubtitleCues.every(c => c.subtitleSource === 'reviewed_preview_translation'));
  assert(!result[0].previewSubtitleCues.some(c => c.text.includes('Tiffany')));
  assert.equal(result[0].previewSubtitleVi, project.autoStoryPreviewSubtitleRepairs[0].correctedVi);
  service.ensureHighlightPreviewTranscript = async () => [{ startSec: 10, endSec: 14, text: 'Lời khác đã có dấu.' }];
  for (const change of ['variant', 'range']) {
    const other = structuredClone(project);
    if (change === 'variant') other.analysis.highlightVariants[0].scriptId = 2;
    const output = await service.buildHighlightFastDraftPreviewSubtitles({ project: other, settings: {}, segments: [
      { id: 's1', sourceStartSec: 10, sourceEndSec: change === 'range' ? 13 : 12, duration: 2, audioMode: 'original_audio' }
    ] });
    assert(!output[0].previewSubtitleCues.some(c => c.subtitleSource === 'reviewed_preview_translation'), 'never reuse correction across scripts or changed footage');
  }
  console.log('Reviewed preview subtitle tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
