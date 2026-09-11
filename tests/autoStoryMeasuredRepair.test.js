const assert = require('assert/strict');
const Service = require('../electron/services/autoStoryFastService');
const editorial = require('../electron/services/autoStoryEditorial');
require('../electron/services/autoStoryMediaPack').packSelected = async (_f, evidence) => ({
  filePaths: [], evidence: evidence.map(e => ({ ...e, mediaLocations: [{ clipStart: 0, clipEnd: e.duration }] }))
});

(async () => {
  const service = new Service({}, {}, { vertex: {}, ffmpeg: {}, dubbing: {} });
  const story = { scriptId: 1 };
  const config = { targetDurationMinSec: 65, targetDurationMaxSec: 150, narration: { enabled: true, measuredWordsPerSecond: 2.5 } };
  const evidence = [{ id: 'clip', file: 'clip.mp4', duration: 100, transcript: [] }];
  const original = { scriptId: 1, segments: [
    { id: 'hook', evidenceId: 'clip', start: 0, end: 4, storyRole: 'hook', audioMode: 'original_audio', sourceNarratorPresent: false, voiceoverText: '', previewVi: '' },
    { id: 'context', evidenceId: 'clip', start: 94, end: 100, storyRole: 'context', audioMode: 'voiceover_only', sourceNarratorPresent: true, voiceoverText: 'Essential context and relationships.', previewVi: 'Verified translation.' }
  ] };
  const audit = { hookSegmentIds: ['hook'], contextSegmentIds: ['context'], completeBeat: true,
    understandableHandoff: true, closingQuoteOrReaction: 'Complete reaction.', viewerUnderstands: 'Who called and why.', nextDialogueConnection: 'The caller continues.' };
  Service.validateEdit({ ...original, openingAudit: audit }, story, evidence, config);
  assert.throws(() => Service.validateEdit({ ...original, openingAudit: { ...audit, completeBeat: false } }, story, evidence, config), /Opening audit/);
  assert.throws(() => Service.validateEdit({ ...original, openingAudit: { ...audit, hookSegmentIds: ['imaginary'] } }, story, evidence, config), /Opening audit/);
  assert.throws(() => Service.validateEdit({ ...original, openingAudit: { ...audit, contextSegmentIds: ['hook'] } }, story, evidence, config), /Opening audit/);
  assert(editorial.schemas.edit.properties.script.required.includes('openingAudit'));

  service.measuredVoice = async () => ({ meta: { duration: 5.05 } });
  const short = structuredClone(original);
  short.segments[0].end = 55.88;
  short.segments[1].start = 60;
  short.segments[1].end = 75;
  await assert.rejects(service.measure(short, story, evidence, config, {}, '.'), e => {
    assert.equal(e.kind, 'total_duration');
    assert.equal(e.segmentId, undefined);
    assert(Math.abs(e.measuredDuration - 60.93) < 0.001);
    assert.equal(e.measuredScript.segments[1].measuredVoiceSec, 5.05);
    return true;
  });

  const overflow = Object.assign(new Error('voice overflow'), { segmentId: 'context', measurements: [{ seconds: 9, availableSeconds: 6 }] });
  let measures = 0, compression = 0, corrections = 0, saved;
  service.measure = async s => { if (++measures === 1) throw overflow; return s; };
  service.repairVoice = async () => { compression++; throw new Error('must relocate first'); };
  service.stage = async (root, key, input, args, validate) => {
    corrections++;
    assert.equal(input.mode, 'relocate-patch-v1');
    assert(args.prompt.includes('Keep ALL narration wording'));
    const script = structuredClone(original);
    script.segments[1].start = 50;
    script.segments[1].end = 59;
    const result = { accessGranted: true, found: true, segmentId: 'context', evidenceId: 'clip', start: 50, end: 59 };
    validate(result);
    assert.throws(() => validate({ ...result, segmentId: 'hook' }), /segmentId/);
    assert.throws(() => validate({ ...result, end: 200 }), /evidence/);
    return result;
  };
  const fitted = await service.fitMeasured(original, story, evidence, config, {}, '.', { filePaths: [] }, null, null, s => { saved = s; });
  assert.equal(fitted.segments[1].voiceoverText, original.segments[1].voiceoverText);
  assert.equal(fitted.segments[1].start, 50);
  assert.equal(compression, 0);
  assert.deepEqual(saved, fitted);

  // A total-runtime failure has no segmentId. It must reach repair, not abort review.
  measures = 0;
  service.measure = async s => {
    if (++measures === 1) throw Object.assign(new Error('60.93s'), { kind: 'total_duration', measuredDuration: 60.93,
      measuredScript: s, measurements: [{ id: 'context', seconds: 9 }] });
    return s;
  };
  service.stage = async (root, key, input, args, validate) => {
    corrections++;
    assert.equal(input.mode, 'duration');
    assert(args.prompt.includes('65-150s'));
    assert(args.prompt.includes('Never pad silence'));
    const result = { access: { accessGranted: true }, script: structuredClone(fitted) };
    validate(result); return result;
  };
  await service.fitMeasured(fitted, story, evidence, config, {}, '.', { filePaths: [] });
  assert.equal(corrections, 2);
  // Repeated failures stop after three corrections, preserving the last checkpoint.
  service.measure = async s => { throw Object.assign(new Error('still too short'), { measurements: [], measuredScript: s }); };
  service.stage = async () => ({ script: fitted });
  let checkpoints = 0;
  await assert.rejects(service.fitMeasured(fitted, story, evidence, config, {}, '.', { filePaths: [] }, null, null,
    () => { checkpoints++; }), /still too short/);
  assert.equal(checkpoints, 3);
  console.log('Auto Story measured repair tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
