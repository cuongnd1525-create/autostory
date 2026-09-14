const assert = require('assert/strict');
const media = require('../electron/services/autoStoryMediaPack');
const { generate } = require('../electron/services/autoStoryEditRecovery');
(async () => {
  const saved = media.packSelected;
  const evidence = [{ id: 'e', sourceStart: 100, duration: 30, transcript: [], mediaLocations: [{ clipStart: 0, clipEnd: 30 }] }];
  const original = { scriptId: 1, segments: [{ id: 'hook', evidenceId: 'e', start: 2, end: 5, storyRole: 'hook' }, { id: 'body', evidenceId: 'e', start: 6, end: 12 }] };
  let focus, calls = 0;
  media.packSelected = async (_f, _e, selection) => { focus = selection; return { filePaths: ['focus.mp4'], evidence }; };
  try {
    const service = { ffmpeg: {}, stage: async (_root, key, _input, args, validate) => {
      calls++;
      if (key === 'edit-1') { const e = new Error('Hook mismatch'); e.invalidArtifact = { access: { accessGranted: true }, script: original }; throw e; }
      assert.equal(args.taskType, 'auto_story_repair');
      assert.deepEqual(args.filePaths, ['focus.mp4']);
      assert(args.responseSchema.properties.patch);
      const value = { access: { accessGranted: true }, verdict: 'MINOR_REVISE', patch: { order: ['hook', 'body'], changedSegments: [{ ...original.segments[0], start: 1 }] } };
      validate(value); return value;
    } };
    const result = await generate(service, '.', { scriptId: 1 }, evidence, {}, {}, v => assert.equal(v.script.scriptId, 1));
    assert.equal(calls, 2);
    assert.equal(focus.segments.length, 1);
    assert.equal(result.script.segments[0].start, 1);
    assert.deepEqual(result.script.segments[1], original.segments[1]);
    assert.equal(original.segments[0].start, 2);
    service.stage = async (_root, key, _input, args, validate) => {
      if (key === 'edit-1') throw new Error('MAX_TOKENS');
      assert(args.responseSchema.properties.script, 'without complete JSON, request a compact complete script');
      assert(!args.prompt.includes('undefined.partial'));
      const value = { access: { accessGranted: true }, script: original };
      validate(value); return value;
    };
    const fallback = await generate(service, 'missing-test-checkpoint', { scriptId: 1 }, evidence, {}, {}, () => {});
    assert.equal(fallback.script, original);
    service.stage = async () => { throw new Error('ECONNRESET'); };
    await assert.rejects(generate(service, '.', { scriptId: 1 }, evidence, {}, {}, () => {}), /ECONNRESET/);
    console.log('Edit recovery: focused patch, preserved body, immutable rejected input, no network content retry passed');
  } finally { media.packSelected = saved; }
})().catch(e => { console.error(e); process.exitCode = 1; });
