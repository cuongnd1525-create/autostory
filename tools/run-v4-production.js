const path = require('path');
const fs = require('fs');

const WORKSPACE_ROOT = 'D:\\OutputVideo';
const PROJECT_ID = '0925-v3-edl-quality-rebuild';

async function main() {
  const settingsFile = path.join(process.env.APPDATA, 'cineviral-studio', 'config.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

  const Store = require('../electron/services/projectStore');
  const store = new Store();
  
  const FfmpegService = require('../electron/services/ffmpegService');
  const dubbingSettings = { ...settings };
  const ffmpegService = new FfmpegService(dubbingSettings);
  
  // Set up dubbing service
  const DubbingService = require('../electron/services/dubbingService');
  const dubbingService = new DubbingService(dubbingSettings, store, { ffmpeg: ffmpegService });

  const AutoStoryRunner = require('../electron/services/autoStoryRunner');
  const runner = new AutoStoryRunner(settings, store, dubbingService);

  console.log('Starting AutoStory V4 Production Pipeline...');
  
  const result = await runner.run({
    workspaceRoot: WORKSPACE_ROOT,
    projectId: PROJECT_ID,
    onProgress: (p) => {
      if (p.message) {
        console.log(`[Progress ${p.percent || ''}%] [${p.stage || 'info'}] ${p.message}`);
      }
    }
  });

  console.log('Pipeline Completed!');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
