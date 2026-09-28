const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ConfigStore = require('../electron/services/configStore');
const ProjectStore = require('../electron/services/projectStore');
const DubbingService = require('../electron/services/dubbingService');
const AutoStoryFastService = require('../electron/services/autoStoryFastService');
const autoStoryV3Pipeline = require('../electron/services/autoStoryV3Pipeline');

const CONFIG_PATH = 'C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json';
const WORKSPACE_ROOT = 'D:\\OutputVideo';
const PROJECT_ID = '0925-v3-edl-quality-rebuild';

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function main() {
  const settings = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  const store = new ProjectStore();
  const dubbing = new DubbingService(store);
  const service = new AutoStoryFastService(settings, store, { dubbing });

  // MOCK the generation steps to inject our repaired spine!
  const originalBuildStoryDesign = service.buildStoryDesign.bind(service);
  service.buildStoryDesign = async function(model, options) {
    log('MOCKING buildStoryDesign to inject repaired spine...');
    const repaired = JSON.parse(await fsp.readFile('scratch/repaired-story-spine-real.json', 'utf8'));
    return repaired;
  };
  
  service.compileStorySpine = async function(model, design) {
    log('MOCKING compileStorySpine to inject repaired spine...');
    const repaired = JSON.parse(await fsp.readFile('scratch/repaired-story-spine-real.json', 'utf8'));
    return repaired;
  };

  log('Running pipeline with repaired spine...');
  const pipelineResult = await autoStoryV3Pipeline.run(service, {
    workspaceRoot: WORKSPACE_ROOT,
    projectId: PROJECT_ID,
    storyMode: 'serialized_part',
    preferCliffhanger: true,
    onProgress: (p) => {
      if (p.message) log(`[Pipeline] ${p.stage || 'progress'}: ${p.message}`);
    }
  });

  log(`Pipeline completed. Scripts: ${pipelineResult.scriptPaths?.length}`);
}

main().catch(console.error);
