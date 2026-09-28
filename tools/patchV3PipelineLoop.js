const fs = require('fs');
let code = fs.readFileSync('electron/services/autoStoryV3Pipeline.js', 'utf8');

const regex = /async function auditDrafts\(service, opts\) \{[\s\S]*?module\.exports = \{ run, auditDrafts, assignAudioRoles, buildScript,/;
const replacement = `async function auditDrafts(service, opts) {
  const { workspaceRoot, projectId, scriptId, signal, onProgress, onDraft } = opts;
  const project = await service.store.getProject(workspaceRoot, projectId);
  const root = require('path').join(service.store.getProjectPaths(workspaceRoot, projectId).analysisDir, "auto-story-fast");
  
  const audits = [];
  const plan = JSON.parse(await fs.promises.readFile(require('path').join(root, 'plan.json'), 'utf8').catch(() => '{"stories":[]}'));
  
  for (let story of plan.stories) {
    if (scriptId && story.scriptId !== scriptId) continue;
    const id = story.scriptId;
    const record = require('path').join(root, \`review-state-\${id}.json\`);
    
    let variant = project.analysis?.highlightVariants?.find(v => Number(v.scriptId) === id);
    if (!variant?.artifacts?.fastDraftVideoPath) continue;
    let draft = variant.artifacts.fastDraftVideoPath;
    
    let script = JSON.parse(await fs.promises.readFile(require('path').join(root, \`script-\${id}.json\`), 'utf8'));
    let spineData = JSON.parse(await fs.promises.readFile(require('path').join(root, 'story-spine.json'), 'utf8').catch(() => '{}'));
    let spine = spineData.spines ? spineData.spines[0] : spineData;
    if (!spine || !spine.beats) spine = script;

    const { critiqueMediaGroundedTimeline, generateTargetedRepairSpecification } = require('./structuralCriticService');
    const VertexAiService = require('./vertexAiService');
    const configPath = require('path').join(require('os').homedir(), 'AppData', 'Roaming', 'cineviral-studio', 'config.json');
    const aiConfig = JSON.parse(await fs.promises.readFile(configPath, 'utf8').catch(() => '{}'));
    const ai = new VertexAiService(aiConfig);
    
    const { Engine } = require('./autoStorySourceEngine');
    const engine = new Engine(service, { project, root, config: project.autoStoryEditorialConfig, signal, onProgress });
    const { buildScript } = require('./autoStoryV3Pipeline');
    
    let passes = 0;
    let maxPasses = 2;
    let critique = null;
    let isInitial = true;

    while (passes <= maxPasses) {
      const meta = await service.ffmpeg.probeVideo(draft);
      onProgress?.({ stage: 'reviewing', message: \`Script \${id}: [V4] Chạy Media-Grounded Critic (Pass \${passes})...\` });
      
      critique = await critiqueMediaGroundedTimeline(spine, {
        aiService: ai,
        mp4Path: draft,
        actualMp4DurationSec: meta.duration,
        targetWindowSec: 5.5
      });
      
      if (isInitial) {
        console.log(\`[V4] Initial media score: \${critique.criticObservedScore}\`);
        if (critique.weakWindows.length) console.log(\`[V4] Weak windows: \${critique.weakWindows.length}\`);
        await fs.promises.writeFile(require('path').join(root, 'initial-story-spine.json'), JSON.stringify(spine, null, 2));
        await fs.promises.writeFile(require('path').join(root, 'initial-media-audit.json'), JSON.stringify(critique, null, 2));
        isInitial = false;
      } else {
        console.log(\`[V4] Repaired media score: \${critique.criticObservedScore}\`);
        await fs.promises.writeFile(require('path').join(root, 'repaired-story-spine.json'), JSON.stringify(spine, null, 2));
        await fs.promises.writeFile(require('path').join(root, 'repaired-media-audit.json'), JSON.stringify(critique, null, 2));
      }

      if (critique.isCompliant && critique.weakWindows.length === 0) {
        if (passes > 0) console.log('[V4] Repaired EDL accepted');
        const passedAudit = {
          scriptId: id, complete: true, contractVersion: 4, pending: false, needsUserReview: false,
          finalCheck: { complete: true, verdict: 'PASS', issues: [] }
        };
        await fs.promises.writeFile(record, JSON.stringify(passedAudit, null, 2));
        audits.push(passedAudit);
        break;
      }

      if (passes >= maxPasses) {
        console.log(\`[V4] Max repair passes reached. Failed explicitly.\`);
        const failedAudit = {
          scriptId: id, complete: true, contractVersion: 4, pending: false, needsUserReview: true,
          finalCheck: { complete: true, verdict: 'FAIL', issues: [{ reason: 'Failed to meet criteria after 2 repairs.' }] }
        };
        await fs.promises.writeFile(record, JSON.stringify(failedAudit, null, 2));
        audits.push(failedAudit);
        break;
      }

      // Repair Loop
      console.log(\`[V4] Targeted repair started\`);
      const repairSpec = generateTargetedRepairSpecification(critique);
      await fs.promises.writeFile(require('path').join(root, 'repair-specification.json'), JSON.stringify({spec: repairSpec, windows: critique.weakWindows}, null, 2));
      
      const repairedSpines = await buildStoryDesign(engine, await require('./sourceStoryModelService').loadCached(engine), root, (st, msg, pct) => onProgress?.({stage: st, message: msg, percent: pct}), repairSpec);
      spine = repairedSpines[0];
      
      const rebuilt = await buildScript(engine, service, opts, story, await require('./sourceStoryModelService').loadCached(engine), root, (st, msg, pct) => onProgress?.({stage: st, message: msg, percent: pct}), spine);
      const scriptPath = require('path').join(root, \`script-\${id}.json\`);
      await fs.promises.writeFile(scriptPath, JSON.stringify(rebuilt.script, null, 2));
      
      const importedProject = await service.dubbing.importReviewedScriptProject({ workspaceRoot, projectId, settings: service.settings, jsonPath: scriptPath });
      const selectedVariant = importedProject.analysis.highlightVariants.find(v => Number(v.scriptId) === id);
      
      console.log(\`[V4] Re-render started\`);
      const rendered = await service.dubbing.renderHighlightFastDraft({
        workspaceRoot, projectId, settings: service.settings,
        project: { ...importedProject, analysis: { ...importedProject.analysis, activeVariantId: selectedVariant.id, segments: selectedVariant.segments } },
        onProgress
      });
      draft = rendered.outputPath;
      passes++;
    }
  }
  
  return { project: await service.store.getProject(workspaceRoot, projectId), audits };
}
module.exports = { run, auditDrafts, assignAudioRoles, buildScript,`;

code = code.replace(regex, replacement);
fs.writeFileSync('electron/services/autoStoryV3Pipeline.js', code);
