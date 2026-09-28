const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Engine, read, write, initialize, publicStory } = require('./autoStorySourceEngine');
const { schemas } = require('./autoStorySourceContracts');
const gates = require('./autoStorySourceGates');
const { range } = require('./autoStoryTimelineCompiler');
const { StoryError } = require('./autoStoryRepairRouter');
const Legacy = require('./autoStoryPipelineService');
const Dubbing = require('./dubbingService');
async function sourceHash(file, signal) {
  return new Promise((resolve,reject) => {
    const stream = require('fs').createReadStream(file, { signal }); const h = crypto.createHash('sha256');
    stream.on('data', b => h.update(b)).on('error',reject).on('end',() => resolve(h.digest('hex')));
  });
}
async function loadDiscovery(engine, overview) {
  return engine.ask('v2-discovery', { duration: engine.duration, transcript: engine.cues,
    candidateCount: 8, outputDuration: [engine.config.targetDurationMinSec,engine.config.targetDurationMaxSec] }, schemas.discovery,
    'Inspect the full source. Discover 6-10 distinct promising story/angle windows before any full edit. Include contradiction, denial, confession, bizarre excuse, entitlement, officer comeback, evidence reveal, arrest realization, emotional reaction, physical escalation and instant consequence when actually present. Score each dimension 0-10; dependency scores increase with dependency. Prefer truthful complete stories over a forced count; capacityReason explains fewer candidates. Source ranges must include the actual climax AND immediate aftermath, not merely a promise of action.', overview,
    v => { gates.access(v); if (!Array.isArray(v.candidates) || v.candidates.length>10 || (v.candidates.length<6 && !v.capacityReason?.trim())) throw new StoryError('INVALID_RESPONSE','Missing discovery capacity assessment.'); }, 'auto_story_plan', {recoverValidatedArtifact:true});
}
async function discover(engine, overview, outputCount) {
  const MediaIndexer = require('./autoStoryMediaIndexer');
  engine.mediaIndex = MediaIndexer.index(engine.duration, engine.cues);
  const result = await loadDiscovery(engine,overview);
  const resolved = await require('./autoStorySourceDiscovery').resolve(engine,result,overview, engine.mediaIndex);
  const ranked = resolved.ranked;
  await write(path.join(engine.root,'candidate-ranking-v2.json'), { candidates: ranked, capacityReason: result.capacityReason,
    rejected:resolved.rejected, originalRejected:resolved.originalRejected, corrections:resolved.corrections, repairError:resolved.repairError });
  await engine.metric('v2-ranking', { candidateCount: ranked.length, candidateRejects: ranked.filter(c => !c.eligible).length });
  const selected = ranked.filter(c => c.eligible).slice(0, Math.max(3, Math.min(7,outputCount+2)));
  if (!selected.length) return { stories: [], rejected: [...resolved.rejected,...ranked], capacityWarning: result.capacityReason || 'Không có ứng viên đủ mạnh với mốc nguồn đã xác minh.' };
  const evidence = await engine.prepare(selected, 2);
  const hooks = await require('./autoStoryHookSelection').select(engine,selected,evidence,outputCount);
  const good = hooks.good, rejected = [...resolved.rejected,...ranked.filter(c=>!c.eligible),...hooks.rejected];
  // Keep blueprint alternatives cheap; only accepted production slots reach full editing.
  const shortlist = good.slice(0,Math.max(3,outputCount));
  if (!shortlist.length) return { stories:[], rejected, capacityWarning:'Các hook được nghe kiểm tra chưa đủ sạch hoặc chưa trọn ý.' };
  const response = await engine.ask('v2-blueprints', { candidates: shortlist.map(publicStory), productionCount:outputCount }, schemas.blueprints,
    'Create compact story blueprints for the auditioned candidates, not full scripts. Match each candidate by its exact SOURCE window. Identify ONE viewer question, hook promise, minimum context, escalation, turning point, source-grounded climax, payoff, ending and whatToExclude. Exclude repetitive procedure, paperwork, and unrelated aftermath. Do not exclude host narration; you may use scenes with host commentary because we will mute and replace it with our own TTS. Include only necessary source footage windows. Independently reject a weak story using strongEnough=false or insufficient authentic footage; never rescue it with narrator filler.', overview,
    v => { gates.access(v); if(!Array.isArray(v.stories)) throw new StoryError('INVALID_RESPONSE','Invalid blueprint count.');
      if(v.stories.length > shortlist.length) v.stories.length = shortlist.length;
      const used = new Set(); for(let i=0; i<v.stories.length; i++) {
        const s = v.stories[i];
        let c = shortlist.find(c => Math.abs(c.sourceStartSec - s.sourceStartSec) < 2 && Math.abs(c.sourceEndSec - s.sourceEndSec) < 2);
        if (!c) c = shortlist.find(c => !used.has(c.candidateId)); // fallback
        if (!c || used.has(c.candidateId)) throw new StoryError('INVALID_RESPONSE', 'Blueprint does not match a unique candidate.');
        s.sourceStartSec = c.sourceStartSec; s.sourceEndSec = c.sourceEndSec; // normalize
        used.add(c.candidateId);
      } }, 'auto_story_plan', {relaxedSchema:true});
  const stories=[];
  for (const c of shortlist) {
    try {
      const b=response.stories.find(s=>s.sourceStartSec===c.sourceStartSec && s.sourceEndSec===c.sourceEndSec)?.blueprint;
      gates.blueprint(b, engine.mediaIndex, engine.duration);
      stories.push({ ...b, title:c.title, candidateId:c.candidateId, hook:c.hook, viralScore:c.viralScore });
    } catch(error) { if(error.kind!=='BAD_CANDIDATE') throw error; rejected.push({...c,rejection:error.message}); }
  }
  return { contractVersion:2, stories:stories.slice(0,outputCount).map((s,i)=>({...s,scriptId:i+1})), alternatives:stories.slice(outputCount), rejected,
    capacityWarning:stories.length<outputCount ? `Nguồn chỉ có ${stories.length}/${outputCount} câu chuyện qua kiểm tra trước dựng; không ép thêm bản yếu.` : '' };
}
async function run(service, opts) {
  const { root, project: original } = await initialize(service,opts);
  let project={...original,draftVoiceMode:'final'};
  const config=Legacy.normalizeConfig({...project.autoStoryConfig,outputCount:project.autoStoryConfig?.outputCount ?? 1},project);
  const update=patch=>service.store.updateProject(opts.workspaceRoot,opts.projectId,patch);
  const emit=(stage,message,percent)=>opts.onProgress?.({stage,message,...(percent===undefined?{}:{percent})});
  emit('preprocess','Kiểm tra nguồn và giọng đọc trước khi chọn câu chuyện.',1);
  if(config.narration.enabled) {
    const sample='What begins as a routine encounter takes a different turn when the officer asks one simple question.';
    const {meta}=await service.measuredVoice(project,sample,root);
    config.narration.measuredWordsPerSecond=sample.split(/\s+/).length/meta.duration;
  }
  const probe=await service.ffmpeg.probeVideo(project.sourceVideoPath);
  if(!(probe.duration>=config.targetDurationMinSec)) throw new Error('Video nguồn ngắn hơn thời lượng tối thiểu.');
  const identity=await sourceHash(project.sourceVideoPath,opts.signal);
  const cache=path.join(opts.workspaceRoot,'.cineviral','auto-story-source',identity,'source-contract-v2');
  await fs.mkdir(cache,{recursive:true});
  const cues=project.subtitleSourcePath ? Dubbing.normalizeRollingSubtitleCues(await service.dubbing.readSubtitleSegments(project.subtitleSourcePath)) : [];
  const MediaIndexer = require('./autoStoryMediaIndexer');
  const mediaIndex = MediaIndexer.index(probe.duration, cues);
  const engine=new Engine(service,{project,root,cache,config,cues,mediaIndex,sourceHash:identity,duration:probe.duration,signal:opts.signal,onProgress:opts.onProgress});
  project=await update({autoStoryContractVersion:2,autoStoryPipelineVersion:'editorial-v1',autoStoryConfig:{...project.autoStoryConfig,outputCount:config.outputCount},
    autoStoryEditorialConfig:config,autoStorySourceV2:{identity,cache,duration:probe.duration},draftVoiceMode:'final',showSubtitles:true,narrationLanguage:'en',
    mixer:{...project.mixer,sourceVolume:0,narrationSourceAudioOverride:true},
    videoDecoration:!original.autoStoryPipelineVersion&&!project.videoEditUpdatedAt ? {...project.videoDecoration,canvasEnabled:true,canvasAspect:'9:16',blurBackgroundEnabled:true}:project.videoDecoration});
  engine.project=project;
  let plan=await read(path.join(root,'plan.json')).catch(()=>null);
  const planKey=JSON.stringify({identity,config});
  if(plan?.contractVersion!==2 || plan.planKey!==planKey || require('./autoStoryHookSelection').needsRefresh(plan) || !plan.stories?.length) {
    emit('discovery','Tìm ứng viên, nghe hook và kiểm tra câu chuyện trước khi dựng.',6);
    const overview=await engine.prepare([{sourceStartSec:0,sourceEndSec:probe.duration}],0,4);
    plan=await discover(engine,overview,config.outputCount); plan.planKey=planKey;plan.contractVersion=2;
    plan.hookPolicyVersion=require('./autoStoryHookSelection').VERSION;
    await write(path.join(root,'plan.json'),plan);
  }
  await update({autoStoryCapacityWarning:plan.capacityWarning||'',autoStoryJobPath:path.join(root,'plan.json'),autoStoryState:{phase:'editing',failures:[]}});
  const scriptPaths=[],failures=[];
  const wanted=opts.scriptId ? [opts.scriptId] : Array.from({length:config.outputCount},(_,i)=>i+1);
  for(const id of wanted) {
    const current=await service.store.getProject(opts.workspaceRoot,opts.projectId);
    const existing=current.analysis?.highlightVariants?.find(v=>Number(v.scriptId)===id);
    if(existing) { if(existing.sourceJsonPath) scriptPaths.push(existing.sourceJsonPath);continue; }
    let story=plan.stories.find(s=>s.scriptId===id);
    if(!story) { failures.push({scriptId:id,kind:'BAD_CANDIDATE',error:plan.capacityWarning||'Không còn câu chuyện đủ mạnh đã được xác minh.'});continue; }
    try {
      emit('editing',`Script ${id}: chọn hình theo thời gian nguồn, viết cầu nối và đo voice.`,30);
      let result;
      try { result=await engine.edit(story); }
      catch(error) {
        require('fs').writeFileSync('err.txt', error.stack);
        if(!['BAD_CANDIDATE', 'STRUCTURAL_STORY', 'REGIONAL_EDITORIAL', 'LOCAL_EDITORIAL', 'VOICE_BUDGET', 'INVALID_RESPONSE'].includes(error.kind) || !plan.alternatives?.length) throw error;
        plan.rejected.push({...story,rejection:error.message});
        story={...plan.alternatives.shift(),scriptId:id};
        plan.stories=plan.stories.map(s=>s.scriptId===id?story:s);
        await write(path.join(root,'plan.json'),plan);
        await engine.metric(`v2-candidate_reject-${id}`,{candidateRejects:1});
        result=await engine.edit(story);
      }
      const {script,evidence}=result;
      await write(path.join(root,`evidence-${id}.json`),evidence);
      await write(path.join(root,`edit-${id}.json`),script);
      const scriptPath=path.join(root,`script-${id}.json`);
      await write(scriptPath,require('./autoStoryFastService').highlight(script,story,evidence));
      scriptPaths.push(scriptPath);
      const latest=await service.store.getProject(opts.workspaceRoot,opts.projectId);
      await update({autoStoryVoiceCache:{...latest.autoStoryVoiceCache,...service.voiceCache},
        autoStoryNarrationTranslations:[...script.segments.filter(s=>s.audioMode==='voiceover_only'||s.audioMode==='mixed_ducking').map(s=>({text:s.voiceoverText,vi:s.previewVi})),...(latest.autoStoryNarrationTranslations||[])]});
      opts.onScriptReady?.({scriptId:id,scriptPath});
    } catch(error) {
      if(opts.signal?.aborted) throw error;
      failures.push({scriptId:id,kind:error.kind||'SERVICE_ERROR',error:error.message});
      emit('failed',`Script ${id}: ${error.message}`);
    }
  }
  await write(path.join(root,'failures.json'),failures);
  project=await update({storyScriptPaths:scriptPaths,storyScriptPath:scriptPaths[0]||'',autoStoryState:{phase:failures.length?'review_failed':'ready_to_render',failures}});
  return {project,scriptPaths,config,analysisDir:root,failures};
}
module.exports={run,discover,sourceHash,loadDiscovery};
