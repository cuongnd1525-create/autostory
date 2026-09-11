const path = require('path');
const crypto = require('crypto');
const media = require('./autoStoryMediaPack');

// Fallback only: inspect bounded draft regions, then require a whole-draft check.
async function recover(service, root, key, input, args, validate, progress, signal) {
  const script = input.script, story = args.recovery.story, evidence = args.recovery.evidence;
  const changed = new Map(), removed = new Set(), issues = [], subtitles = [];
  const segmentSchema = args.responseSchema.properties.patch.properties.changedSegments.items;
  const responseSchema = { type: 'object', required: ['accessGranted', 'issues', 'changedSegments', 'removedIds', 'previewSubtitleIssues'], properties: {
    accessGranted: { type: 'boolean' }, issues: args.responseSchema.properties.issues,
    changedSegments: { type: 'array', maxItems: 4, items: segmentSchema },
    removedIds: { type: 'array', maxItems: 4, items: { type: 'string' } },
    previewSubtitleIssues: args.responseSchema.properties.previewSubtitleIssues
  } };
  let cursor = 0;
  const timed = script.segments.map(s => { const start = cursor; cursor += s.end - s.start; return { s, start, end: cursor }; });
  for (let i = 0; i < timed.length; i += 4) {
    signal?.throwIfAborted();
    const group = timed.slice(i, i + 4), ids = new Set(group.map(t => t.s.id));
    const start = Math.max(0, group[0].start - 3), end = Math.min(cursor, group.at(-1).end + 3);
    const name = crypto.createHash('sha256').update(JSON.stringify([input.draftIdentity, start, end])).digest('hex').slice(0, 20);
    const file = path.join(root, `review-recovery-${name}.mp4`);
    try { const m = await service.ffmpeg.probeVideo(file); if (Math.abs(m.duration - (end - start)) > .2) throw new Error('duration'); }
    catch (_) { await service.ffmpeg.createAnalysisProxyChunk({ videoPath: input.draft, outputPath: file, startSec: start, durationSec: end - start, width: 640, fps: 8 }); }
    const focused = await media.packSelected(service.ffmpeg, evidence, { segments: group.map(t => t.s) }, story, root, signal, { padding: 4, candidates: false });
    progress?.({ stage: key, message: `Review chia nhỏ phần ${i / 4 + 1}/${Math.ceil(timed.length / 4)}; bản cuối vẫn kiểm tra toàn video` });
    const result = await service.stage(root, `${key}-part-${i / 4 + 1}`, { group, draftIdentity: input.draftIdentity, script }, {
      filePaths: [file, ...focused.filePaths], videoFps: 1, videoFpsByPath: focused.videoFpsByPath,
      taskType: args.taskType, temperature: .1, responseSchema,
      prompt: `Inspect the first attached video as a REGION of the actual draft. It begins at OUTPUT ${start}s; outputSec = local video seconds + ${start}. Other media are source evidence. Do not claim to inspect unseen regions. Return only concrete issues, changedSegments for these IDs, removedIds, and previewSubtitleIssues. At most four changes; no full rewritten script, no new IDs. Preserve meaning, verified facts, hook and payoff. Fix excessive/redundant narration, clipped words, missing context, host leakage using provided media. Keep narration and original speech separate. Use only evidence locations supplied. Mark accessGranted=false if inaccessible. Preview subtitles do not determine export quality. If repair requires a broader reorder or unseen footage, report the unresolved issue rather than guessing. The tool will check the WHOLE draft afterward.\nSTORY:${JSON.stringify(story)}\nCURRENT SCRIPT CONTEXT:${JSON.stringify(script)}\nEDITABLE GROUP:${JSON.stringify(group)}\nSOURCE MAP:${JSON.stringify(focused.evidence)}`
    }, v => {
      if (v.accessGranted !== true || !Array.isArray(v.changedSegments) || !Array.isArray(v.removedIds) || !Array.isArray(v.issues)) throw new Error('Incomplete regional review.');
      if (v.changedSegments.some(s => !ids.has(s.id)) || v.removedIds.some(id => !ids.has(id) || /^(hook|climax|payoff)$/.test(script.segments.find(s => s.id === id).storyRole))) throw new Error('Regional review changed locked IDs.');
      media.assertSelectedChanges({ segments: v.changedSegments }, script, focused.evidence);
      if ([...v.issues, ...(v.previewSubtitleIssues || [])].some(x => !Number.isFinite(x.outputSec) || x.outputSec < start || x.outputSec > end)) throw new Error('Regional review timestamp outside supplied OUTPUT range.');
    }, progress, signal);
    result.changedSegments.forEach(s => changed.set(s.id, s)); result.removedIds.forEach(id => removed.add(id));
    issues.push(...result.issues); subtitles.push(...(result.previewSubtitleIssues || []));
  }
  const value = { access: { accessGranted: true, missingInputs: [] }, verdict: changed.size || removed.size || issues.length ? 'MINOR_REVISE' : 'PASS',
    issues, previewSubtitleIssues: subtitles, patchRecovery: true,
    patch: { order: script.segments.map(s => s.id).filter(id => !removed.has(id)), changedSegments: [...changed.values()].filter(s => !removed.has(s.id)) } };
  validate(value);
  return value;
}
module.exports = { recover };
