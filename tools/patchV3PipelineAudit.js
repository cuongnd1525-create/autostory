const fs = require('fs');
let code = fs.readFileSync('electron/services/autoStoryV3Pipeline.js', 'utf8');

const auditDraftsFunc = `
async function auditDrafts(service, opts) {
  const { workspaceRoot, projectId, scriptId, signal, onProgress, onDraft } = opts;
  const project = await service.store.getProject(workspaceRoot, projectId);
  const root = path.join(service.store.getProjectPaths(workspaceRoot, projectId).analysisDir, "auto-story-fast");
  
  const audits = [];
  const plan = JSON.parse(await fs.promises.readFile(path.join(root, 'plan.json'), 'utf8').catch(() => '{"stories":[]}'));
  
  for (let story of plan.stories) {
    if (scriptId && story.scriptId !== scriptId) continue;
    const id = story.scriptId;
    const record = path.join(root, \`review-state-\${id}.json\`);
    let journal = await fs.promises.readFile(record, 'utf8').catch(() => null);
    if (journal) journal = JSON.parse(journal);
    
    const variant = project.analysis?.highlightVariants?.find(v => Number(v.scriptId) === id);
    if (!variant?.artifacts?.fastDraftVideoPath) continue;
    const draft = variant.artifacts.fastDraftVideoPath;
    
    let script = JSON.parse(await fs.promises.readFile(path.join(root, \`script-\${id}.json\`), 'utf8'));
    let evidence = JSON.parse(await fs.promises.readFile(path.join(root, \`v3-evidence-\${id}.json\`), 'utf8').catch(() => '[]'));
    
    // We run the Media-Grounded Critic
    const { critiqueMediaGroundedTimeline, generateTargetedRepairSpecification } = require('./structuralCriticService');
    const VertexAiService = require('./vertexAiService');
    const configPath = require('path').join(require('os').homedir(), 'AppData', 'Roaming', 'cineviral-studio', 'config.json');
    const aiConfig = JSON.parse(await fs.promises.readFile(configPath, 'utf8').catch(() => '{}'));
    const ai = new VertexAiService(aiConfig);
    
    const meta = await service.ffmpeg.probeVideo(draft);
    
    let spineData = JSON.parse(await fs.promises.readFile(path.join(root, 'story-spine.json'), 'utf8').catch(() => '{}'));
    let spine = spineData.spines ? spineData.spines[0] : spineData;
    if (!spine || !spine.beats) spine = script; // fallback

    onProgress?.({ stage: 'reviewing', message: \`Script \${id}: Chạy Media-Grounded Critic trên Draft MP4...\` });
    
    let critique = await critiqueMediaGroundedTimeline(spine, {
      aiService: ai,
      mp4Path: draft,
      actualMp4DurationSec: meta.duration,
      targetWindowSec: 5.5
    });
    
    if (critique.isCompliant || critique.weakWindows.length === 0) {
      // Pass
      const passedAudit = {
        scriptId: id, complete: true, contractVersion: 3, pending: false, needsUserReview: false,
        finalCheck: { complete: true, verdict: 'PASS', issues: [] }
      };
      await fs.promises.writeFile(record, JSON.stringify(passedAudit, null, 2));
      audits.push(passedAudit);
      continue;
    }
    
    // FAIL -> Repair Loop (Max 1 loop to prevent infinite runs)
    onProgress?.({ stage: 'repairing', message: \`Script \${id}: Phát hiện \${critique.weakWindows.length} điểm yếu. Yêu cầu sửa lỗi EDL...\` });
    
    const repairSpec = generateTargetedRepairSpecification(critique);
    
    // Engine setup for rebuild
    const { Engine } = require('./autoStorySourceEngine');
    const engine = new Engine(service, { project, root, config: project.autoStoryEditorialConfig, signal, onProgress });
    
    // Call buildStoryDesign with repair instruction!
    const repairedSpines = await buildStoryDesign(engine, await require('./sourceStoryModelService').loadCached(engine), root, (st, msg, pct) => onProgress?.({stage: st, message: msg, percent: pct}), repairSpec);
    const repairedSpine = repairedSpines[0];
    
    // Rebuild Script
    const { buildScript } = require('./autoStoryV3Pipeline');
    const rebuilt = await buildScript(engine, service, opts, story, await require('./sourceStoryModelService').loadCached(engine), root, (st, msg, pct) => onProgress?.({stage: st, message: msg, percent: pct}), repairedSpine);
    
    // Save new script
    const scriptPath = path.join(root, \`script-\${id}.json\`);
    await fs.promises.writeFile(scriptPath, JSON.stringify(rebuilt.script, null, 2));
    
    // Save the new spine so the next audit evaluates the repaired one
    await fs.promises.writeFile(path.join(root, 'story-spine.json'), JSON.stringify(repairedSpine, null, 2));
    
    // Mark pending review
    const pendingAudit = {
      scriptId: id, complete: false, pending: true, needsUserReview: true,
      finalCheck: { complete: false, verdict: 'NEEDS_ATTENTION', issues: [{ reason: 'Repaired timeline pending re-render and re-review' }] }
    };
    await fs.promises.writeFile(record, JSON.stringify(pendingAudit, null, 2));
    audits.push(pendingAudit);
    
    // Import repaired script back to DB for render
    const importedProject = await service.dubbing.importReviewedScriptProject({
        workspaceRoot, projectId, settings: service.settings, jsonPath: scriptPath
    });
    
    onDraft?.(importedProject);
  }
  
  return { project: await service.store.getProject(workspaceRoot, projectId), audits };
}
`;

code = code.replace(/module\.exports = \{ run, assignAudioRoles, buildScript,/, 
`${auditDraftsFunc}\nmodule.exports = { run, auditDrafts, assignAudioRoles, buildScript,`);

fs.writeFileSync('electron/services/autoStoryV3Pipeline.js', code);
