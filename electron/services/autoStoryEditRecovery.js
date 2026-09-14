const fs = require('fs/promises');
const path = require('path');
const media = require('./autoStoryMediaPack');
const editorial = require('./autoStoryEditorial');
const patches = require('./autoStoryReviewPatch');

async function generate(service, root, story, evidence, config, args, validate, progress, signal) {
  let original, failure;
  try {
    return await service.stage(root, `edit-${story.scriptId}`, { story, evidence, config },
      { ...args, localRepair: true }, validate, progress, signal);
  } catch (error) {
    if (signal?.aborted || (!error.invalidArtifact && !/MAX_TOKENS/.test(error.message))) throw error;
    failure = error.message;
    original = error.invalidArtifact;
    if (!original) {
      // Only complete JSON from this stage can seed a repair, never truncated text.
      try { original = JSON.parse(await fs.readFile(path.join(root, `edit-${story.scriptId}-last-response.json`), 'utf8')); }
      catch (_) { /* No complete prior draft: use the compact evidence fallback. */ }
    }
  }
  if (original?.access?.accessGranted === false) throw new Error(failure);
  let current = original?.script;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const offending = current?.segments?.find(s => failure.startsWith(`${s.id}:`));
    const hook = /hook|opening/i.test(failure);
    const selected = offending ? [offending] : hook && current?.segments
      ? current.segments.filter(s => /hook|context/i.test(s.storyRole)) : [];
    // Invalid coordinates cannot be used as slicing instructions. Include the
    // complete implicated evidence clip and candidate units for verified repair.
    const valid = selected.filter(s => evidence.some(e => e.id === s.evidenceId
      && s.start >= 0 && s.end > s.start && s.end <= e.duration));
    const invalidIds = new Set(selected.filter(s => !valid.includes(s)).map(s => s.evidenceId));
    const wanted = evidence.filter(e => !current || invalidIds.has(e.id));
    const focus = { segments: [...valid, ...wanted.map(e => ({ id: e.id, evidenceId: e.id, start: 0, end: e.duration }))] };
    const packed = await media.packSelected(service.ffmpeg, evidence, focus, story, root, signal, { padding: 4, candidates: true });
    const compact = packed.evidence.map(e => ({ id: e.id, sourceStart: e.sourceStart, duration: e.duration,
      mediaLocations: e.mediaLocations, transcript: e.transcript }));
    progress?.({ stage: 'edit_repair', message: `Script ${story.scriptId}: sửa cục bộ từ evidence (${attempt + 1}/2)` });
    try {
      const result = await service.stage(root, `edit-repair-${story.scriptId}-${attempt}`, { current, failure, compact, config, story }, {
        filePaths: packed.filePaths, videoFpsByPath: Object.fromEntries(packed.filePaths.map(f => [f, 1])),
        videoFps: 1, taskType: 'auto_story_repair', localRepair: true,
        responseSchema: current ? patches.schema(editorial.scriptSchemaFor(story, evidence, true)) : editorial.scriptSchemaFor(story, evidence),
        prompt: `${editorial.hookPolicy}\n${current ? 'Repair only the invalid opening/segment. Return patch.order and only changedSegments; preserve all other segments and the causal story. Use MINOR_REVISE for any change.' : 'Build one concise complete edit fulfilling the story question, hook promise, climax and payoff. Return no long explanations.'}\nUse clip-local coordinates, not source or reel time. Inspect supplied media; report missing access honestly. Preserve verified facts, complete dialogue and natural narration. No padding or invented scenes. Output duration ${config.targetDurationMinSec}-${config.targetDurationMaxSec}s.\nSTORY:${JSON.stringify(story)}\nFAILURE:${failure}\nCURRENT:${JSON.stringify(current)}\nSOURCE MAP:${JSON.stringify(compact)}`
      }, value => {
        const merged = current ? { access: value.access, script: patches.apply(value, current).revisedScript } : value;
        validate(merged);
        media.assertSelectedChanges(merged.script, current || { segments: [] }, packed.evidence);
      }, progress, signal);
      return current ? { access: result.access, script: patches.apply(result, current).revisedScript } : result;
    } catch (error) {
      if (signal?.aborted || !error.invalidArtifact) throw error;
      failure = error.message;
      // Keep the original intact; never apply a rejected patch.
    }
  }
  throw new Error(failure);
}
module.exports = { generate };
