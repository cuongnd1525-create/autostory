const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const Service = require('../electron/services/autoStoryFastService');
const editorial = require('../electron/services/autoStoryEditorial');
const patches = require('../electron/services/autoStoryReviewPatch');
const media = require('../electron/services/autoStoryMediaPack');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-recovery-'));
  try {
    const file = path.join(root, 'source.mp4'); await fs.writeFile(file, '60');
    const segments = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, evidenceId: 'e', start: i * 10, end: (i + 1) * 10,
      storyRole: i ? 'escalation' : 'hook', audioMode: 'original_audio', sourceNarratorPresent: false, voiceoverText: '' }));
    const script = { scriptId: 1, segments }, story = { scriptId: 1 };
    const evidence = [{ id: 'e', file, duration: 60, sourceStart: 100, sourceUnits: [], transcript: [] }];
    const ffmpeg = { probeVideo: async f => ({ duration: Number(await fs.readFile(f, 'utf8')) }),
      createAnalysisProxyChunk: async ({ outputPath, durationSec }) => fs.writeFile(outputPath, String(durationSec)),
      createAutoStoryEvidenceReel: async (entries, out) => fs.writeFile(out, String(entries.reduce((n, e) => n + e.duration, 0))) };
    const packed = await media.packSelected(ffmpeg, evidence, script, story, root, null);
    assert(Object.values(packed.videoFpsByPath).includes(1));
    assert(Object.values(packed.videoFpsByPath).includes(4));
    let weightedSeconds = 0;
    for (const [p, fps] of Object.entries(packed.videoFpsByPath)) weightedSeconds += (await ffmpeg.probeVideo(p)).duration * fps;
    assert(weightedSeconds < 60 * 4, 'ordinary dialogue is not all high-fps');
    let mainCalls = 0, regionalCalls = 0;
    const service = new Service({}, {}, { ffmpeg, vertex: { generateJsonFromFiles: async args => {
      if (args.responseSchema.properties.patch) { mainCalls++; throw new Error('MAX_TOKENS'); }
      regionalCalls++;
      assert(args.prompt.includes('OUTPUT'));
      assert(args.filePaths[0].includes('review-recovery-'));
      return { accessGranted: true, issues: [], previewSubtitleIssues: [], changedSegments: [], removedIds: [] };
    } } });
    const args = { prompt: 'review', filePaths: [file], recovery: { story, evidence },
      responseSchema: patches.schema(editorial.schemas.review) };
    const input = { script, draft: file, draftIdentity: 'v1' };
    const check = v => { assert(v.patchRecovery); assert.equal(v.patch.order.length, 6); };
    const result = await service.reviewStage(root, 'review-1', input, args, check);
    assert(result.patchRecovery);
    assert.equal(mainCalls, 1); assert.equal(regionalCalls, 2);
    await service.reviewStage(root, 'review-1', input, args, check);
    assert.equal(mainCalls, 1, 'continuation must not repeat the exhausted whole-draft request');
    assert.equal(regionalCalls, 2, 'completed region checks are cached');

    let project = { analysis: { activeVariantId: 'v', highlightVariants: [{ id: 'v', scriptId: 1,
      segments: [{ id: 's0', sourceStartSec: 100, sourceEndSec: 110, duration: 10, resolvedPreviewStartSec: 0, resolvedPreviewEndSec: 10 }],
      artifacts: { fastDraftSubtitlesEmbedded: false, fastDraftVideoPath: file } }] } };
    const store = { getProject: async () => structuredClone(project), updateProject: async (_w, _id, p) => (project = { ...project, ...p }) };
    const subtitles = new Service({}, store, { dubbing: { renderHighlightFastDraft: async () => assert.fail('subtitle-only repair must not render') } });
    await fs.writeFile(path.join(root, 'edit-1.json'), JSON.stringify(script));
    const audit = { scriptId: 1, draft: file, draftIdentity: 'same', finalCheck: { verdict: 'PASS', complete: true,
      previewSubtitleIssues: [{ segmentId: 's0', verifiedSpeech: 'Hello', correctedVi: 'Xin chao' }] } };
    const fixed = await subtitles.repairPreviewSubtitles(root, 'p', audit, root);
    assert.equal(fixed.draftIdentity, 'same'); assert.equal(fixed.previewSubtitleRepair.overlayOnly, true);
    assert.equal(project.analysis.highlightVariants[0].segments[0].previewSubtitleCues[0].previewSubtitleVi, 'Xin chao');
    console.log('Adaptive media, MAX_TOKENS region recovery, resume and subtitle-overlay tests passed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
