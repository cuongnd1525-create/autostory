const assert = require('assert/strict');
const Service = require('../electron/services/autoStoryFastService');
(async () => {
  const service = new Service({ autoStoryBoundedRun: true }, {}, { vertex: {}, ffmpeg: {}, dubbing: {} });
  let measures = 0, patches = 0;
  const script = { segments: [{ id: 's', audioMode: 'voiceover_only', voiceoverText: 'A complete thought.' }] };
  service.measure = async () => { measures++; const error = new Error('too long'); error.measurements = {}; throw error; };
  // A duration correction consumes one pass, then actual measurement must pass.
  const originalFit = service.fitMeasured.bind(service);
  service.ffmpeg = {};
  service.fitMeasured = async value => value;
  const short = { segments: [{ id: 's', audioMode: 'original_audio', start: 0, end: 8 }] };
  const checked = await service.fitRhythm(short, {}, [], {}, {}, '', {}, null);
  assert.equal(checked, short);
  service.fitReviewed = async () => { patches++; return short; };
  await service.fitRhythm(script, {}, [], {}, {}, '', {}, null);
  assert.equal(patches, 1, 'pre-render rhythm must use the bounded repair gate');
  service.measure = async () => { measures++; const error = new Error('cannot verify'); throw error; };
  await assert.rejects(originalFit(script, {}, [], {}, {}, '', {}, null), /cannot verify/);
  assert.equal(measures, 1, 'unverified failures must not trigger speculative repair');
  console.log('Bounded pre-render gate and non-repairable failure tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
