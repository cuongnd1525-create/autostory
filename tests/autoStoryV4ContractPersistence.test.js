const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Pipeline = require('../electron/services/autoStoryV3Pipeline');
const SourceModel = require('../electron/services/sourceStoryModelService');

async function checkContract(initialVersion, architecture, expectedVersion) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'autostory-v4-contract-'));
  const source = path.join(workspaceRoot, 'source.mp4');
  await fs.writeFile(source, 'test source');
  let project = {
    sourceVideoPath: source,
    autoStoryContractVersion: initialVersion,
    autoStoryPipelineVersion: initialVersion === 3 && architecture ? 'source-story-v3' : undefined,
    autoStoryEditorialArchitecture: architecture,
    autoStoryConfig: { outputCount: 1, targetDurationMinSec: 65,
      targetDurationMaxSec: 90, narration: { enabled: false } },
    mixer: {}, videoDecoration: {}
  };
  const logs = [];
  const service = {
    store: {
      getProject: async () => project,
      getProjectPaths: () => ({ analysisDir: path.join(workspaceRoot, 'analysis') }),
      updateProject: async (_root, _id, patch) => (project = { ...project, ...patch })
    },
    ffmpeg: { probeVideo: async () => ({ duration: 120 }) },
    measuredVoice: async () => ({ meta: { duration: 10 } })
  };
  const original = SourceModel.loadCached;
  SourceModel.loadCached = async () => { throw new Error('STOP_AFTER_SOURCE_START'); };
  try {
    await assert.rejects(Pipeline.run(service, {
      workspaceRoot, projectId: 'p1',
      onProgress: p => logs.push(p.message)
    }), /STOP_AFTER_SOURCE_START/);
    assert.equal(project.autoStoryContractVersion, expectedVersion,
      'persisted contract must reflect selected V4/V3 architecture');
    const tag = expectedVersion === 4 ? '[V4]' : '[V3]';
    assert.ok(logs.some(m => m.includes(tag + ' Source Story Model started')),
      'visible progress must identify the true engine');
  } finally {
    SourceModel.loadCached = original;
    await fs.rm(workspaceRoot, { force: true, recursive: true });
  }
}

(async () => {
  await checkContract(4, undefined, 4);
  await checkContract(3, 'scope_media_director', 4); // old V4 downgraded by previous bug
  await checkContract(3, undefined, 3); // true V3 remains V3
  console.log('AutoStory V4 contract persistence, legacy recovery and progress labels passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
