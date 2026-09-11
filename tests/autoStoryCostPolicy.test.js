const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { taskFor, modelFields } = require('../electron/services/autoStoryCostPolicy');
const Vertex = require('../electron/services/vertexAiService');
const Service = require('../electron/services/autoStoryFastService');
const media = require('../electron/services/autoStoryMediaPack');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cost-policy-'));
  const vertex = new Vertex({ vertexAnalysisModel: 'my-analysis', vertexQualityModel: 'my-quality' });
  try {
    assert.equal(vertex.getModel(taskFor('voice-text-1-s2')), 'my-analysis');
    assert.equal(vertex.getModel(taskFor('final-check-1')), 'my-analysis');
    assert.equal(vertex.getModel(taskFor('edit-1')), 'my-quality');
    for (const [type, fields] of Object.entries(modelFields)) {
      vertex.settings[fields[0]] = `custom-${type}`;
      assert.equal(vertex.getModel(type), `custom-${type}`);
    }
    let calls = 0;
    const service = new Service({ vertexAutoStoryMaxCalls: 1 }, {}, { vertex: {
      getModel: () => 'chosen', generateJsonFromFiles: async args => { calls++; assert.equal(args.taskType, 'auto_story_review'); return { ok: true }; }
    } });
    await service.stage(root, 'review-1', {}, { prompt: 'test' }, v => assert(v.ok));
    await service.stage(root, 'review-1', {}, { prompt: 'test' }, v => assert(v.ok));
    assert.equal(calls, 1, 'cache does not consume request allowance');
    await assert.rejects(service.stage(root, 'review-2', {}, { prompt: 'test' }, () => {}), /giới hạn/);
    const invalid = new Service({}, {}, { vertex: { generateJsonFromFiles: async () => { calls++; return {}; } } });
    const before = calls;
    await assert.rejects(invalid.stage(root, 'review-invalid', {}, { filePaths: ['video.mp4'], prompt: 'x' }, () => { throw new Error('bad schema'); }), /bad schema/);
    assert.equal(calls - before, 2, 'one bounded corrective request after validation error');
    let resumedPrompt;
    invalid.vertex.generateJsonFromFiles = async args => { resumedPrompt = args.prompt; return { ok: true }; };
    await invalid.stage(root, 'review-invalid', {}, { filePaths: ['video.mp4'], prompt: 'x' }, v => assert(v.ok));
    assert.match(resumedPrompt, /PREVIOUS ARTIFACT/);
    assert.match(resumedPrompt, /bad schema/);
    let networkCalls = 0;
    invalid.vertex.generateJsonFromFiles = async () => { networkCalls++; throw new Error('ENOTFOUND'); };
    await assert.rejects(invalid.stage(root, 'network', {}, { filePaths: ['video.mp4'], prompt: 'x' }, () => {}), /ENOTFOUND/);
    assert.equal(networkCalls, 1, 'network failure must not start a content repair');
    const file = path.join(root, 'source.mp4'); await fs.writeFile(file, 'mock');
    let sent = 0;
    const ffmpeg = { probeVideo: async f => ({ duration: Number(await fs.readFile(f, 'utf8')) }),
      createAutoStoryEvidenceReel: async (entries, out) => { sent = entries.reduce((s, e) => s + e.duration, 0); await fs.writeFile(out, String(sent)); } };
    const evidence = [{ id: 'e', file, sourceStart: 1000, duration: 600, sourceUnits: [],
      transcript: [{ start: 100, end: 110, text: 'selected' }, { start: 300, end: 301, text: 'not sent' }] }];
    const script = { segments: [{ id: 's', evidenceId: 'e', start: 100, end: 110, audioMode: 'original_audio', voiceoverText: '' }] };
    const packed = await media.packSelected(ffmpeg, evidence, script, {}, root, null, { candidates: false, padding: 4 });
    assert.equal(sent, 20, '10 seconds plus context, not the entire 600-second source');
    assert.equal(packed.evidence[0].duration, 600, 'stable local coordinate domain');
    assert.equal(packed.evidence[0].mediaLocations[0].clipStart, 95);
    assert.equal(packed.evidence[0].transcript.length, 1);
    media.assertSelectedChanges(script, script, packed.evidence);
    assert.throws(() => media.assertSelectedChanges({ segments: [{ ...script.segments[0], start: 300, end: 310 }] }, script, packed.evidence), /chưa được gửi/);
    console.log('Auto Story model, scope, request ceiling and no-video-retry tests passed');
  } finally { await vertex.dispatcher.close(); await fs.rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
