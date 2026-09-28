const fs = require('fs/promises');
const path = require('path');
const { Engine, initialize, read, write, publicStory } = require('./autoStorySourceEngine');
const compiler = require('./autoStoryTimelineCompiler');
const gates = require('./autoStorySourceGates');
const { schemas } = require('./autoStorySourceContracts');
const { StoryError, route, assertPatchSize } = require('./autoStoryRepairRouter');
const rhythm = require('./autoStoryRhythm');
async function identity(file) { const s=await fs.stat(file); return `${s.size}:${s.mtimeMs}`; }
function reviewScope(issues, script) {
  const indices=issues.map(i=>script.segments.findIndex(s=>i.outputSec>=s.outputStartSec && i.outputSec<s.outputEndSec));
  if (indices.some(i=>i<0)) throw new StoryError('STRUCTURAL_STORY','Review region cannot be mapped to the current timeline.');
  const start=Math.min(...indices),end=Math.max(...indices);
  assertPatchSize(end-start+1,script.segments.length);
  return {start,end};
}
async function check(engine,story,script,evidence,draft,final=false) {
  const meta=await engine.service.ffmpeg.probeVideo(draft);
  const expected=compiler.validateDuration(script,engine.config);
  if (!(meta.duration>0) || Math.abs(meta.duration-expected)>.75 || meta.hasAudio===false) throw new StoryError('TECHNICAL_NORMALIZATION','Rendered video duration/audio does not match compiled timeline.');
  if(meta.duration<engine.config.targetDurationMinSec-.25 || meta.duration>engine.config.targetDurationMaxSec+.25) throw new StoryError('REGIONAL_EDITORIAL','Rendered output outside requested duration.');
  if(script.segments.some(s=>s.measuredVoiceSec>s.end-s.start)) throw new StoryError('LOCAL_EDITORIAL','Actual voice exceeds rendered region.');
  await engine.service.ffmpeg.run(engine.service.ffmpeg.ffmpegPath,['-v','error','-xerror','-i',draft,'-f','null','-'],{captureStdout:false});
  const draftIdentity=await identity(draft);
  const review=await engine.ask(`v2-${final?'final':'review'}-${story.scriptId}`,{story:publicStory(story),actualOutputFile:path.basename(draft),
    actualDurationSec:meta.duration,draftIdentity,sourceDecisions:compiler.sourceView(script,evidence),rhythm:rhythm.analyzeV2(script,script.semanticAssessment)},schemas.review,
    `Review the ACTUAL OUTPUT file ${path.basename(draft)} from start to end as a ruthless viral retention critic, comparing factual claims against the source evidence files with SOURCE clocks. Do not mistake the output video for a source clip. Report issues at OUTPUT seconds only.
CRITICAL RETENTION AUDIT:
1. 0-3s Hook Drop-off: The first 3 seconds must hit the viewer with immediate absurd conflict, high stakes, or intense visual action. Flag any slow walking, silent establishing shots, polite greetings, or procedural stalling as critical retention failures.
2. Mid-video Procedural Lulls: Flag dead-air/silence > 1.5s or repetitive administrative procedure that halts narrative momentum without new information or reaction.
3. Lingering Outro: Video must cut to black within 2-3s after the payoff/resolution. Flag any lingering after-talk or wandering outro.
Review is a verdict, never a rewritten script. PASS requires no unresolved export issue, tight viral pacing, and high confidence. A long original exchange is not automatically interesting; look for information gain and reactions. Narration runs across cuts count as one run: identify an actual pacing problem, not a percentage quota. Vietnamese subtitles are preview-only: report their issues and verified corrections separately in previewSubtitleIssues; they must not change the export verdict. Do not claim to inspect a missing subtitle file.`,
    [{file:draft,sourceStart:0,duration:meta.duration,transcript:[]},...evidence],v=>gates.review(v,meta.duration),
    engine.service.settings.vertexAutoStoryReviewModel ? 'auto_story_review' : 'auto_story_plan');
  return {...review,draftIdentity};
}
async function repair(engine,story,script,evidence,issues) {
  let kind=route(issues,script.segments.length),scope;
  if(kind==='BAD_CANDIDATE') throw new StoryError(kind,'Review rejected this candidate; choose another verified story.');
  if(kind!=='STRUCTURAL_STORY') { try { scope=reviewScope(issues,script); } catch(error) { if(error.kind!=='STRUCTURAL_STORY') throw error; kind='STRUCTURAL_STORY'; } }
  if(kind==='STRUCTURAL_STORY') {
    await engine.metric(`v2-rebuild-${story.scriptId}`,{structuralRebuilds:1});
    const result=await engine.ask(`v2-blueprint_rebuild-${story.scriptId}`,{story:publicStory(story),issues},schemas.blueprint,
      'Rebuild the causal story blueprint to solve these structural/factual issues. Do not produce a large segment patch. Keep the verified hook; change the causal path and exclusions as needed using only source evidence. Reject if this hook promise cannot be fulfilled.',evidence,
      v=>{gates.access(v);gates.blueprint(v.blueprint,engine.duration);},'auto_story_edit');
    story={...story,...result.blueprint};
    const edited=await engine.edit(story,issues);
    return {...edited,story};
  }
  const original=compiler.sourceView(script,evidence);
  const region=original.slice(scope.start,scope.end+1);
  const focus=await engine.prepare(region,4);
  const input={story:publicStory(story),region,issues:issues.map(({outputSec,...i})=>i),
    before:original[scope.start-1]||null,after:original[scope.end+1]||null,
    targetDuration:[engine.config.targetDurationMinSec,engine.config.targetDurationMaxSec]};
  let merged;
  const patch=await engine.ask(`v2-region_repair-${story.scriptId}`,input,schemas.region,
    'Replace ONLY the supplied region with at most four source-range decisions in viewing order. No IDs/order arrays. Do not alter the neighbors. Leave narration wording to the next text-only stage. Your assessment must evaluate whether this region replacement resolves the reported problem in the surrounding story. If the change needs a different whole story, fail the assessment.',focus,v=>{
      gates.access(v);assertPatchSize(v.decisions?.length||0,original.length);
      for(const d of v.decisions||[]) if(!focus.some(e=>d.sourceStartSec>=e.sourceStart && d.sourceEndSec<=e.sourceStart+e.duration)) throw new StoryError('EVIDENCE_REQUIRED','Repair selects footage outside its inspected region.');
      merged={decisions:[...original.slice(0,scope.start),...v.decisions,...original.slice(scope.end+1)],assessment:v.assessment,accessGranted:true};
      gates.layout(merged,story,[...evidence,...focus],engine.config,engine.duration);
      // A rhythm repair is not successful if its original long block remains.
      if(issues.some(i=>i.type==='rhythm')) {
        const mock={segments:merged.decisions.map(d=>({start:d.sourceStartSec,end:d.sourceEndSec,audioMode:d.audioIntent==='narration'?'voiceover_only':'original_audio'}))};
        if(rhythm.analyze(mock).runs.some(r=>r.duration>20)) throw new StoryError('STRUCTURAL_STORY','Rhythm postcondition still fails; rebuild required.');
      }
    },'auto_story_repair',{noCache:true});
  await engine.metric(`v2-region_repair-${story.scriptId}`,{patchSize:patch.decisions.length,repairCount:1});
  const allEvidence=[...evidence,...focus];
  return {script:await engine.finish(merged,story,allEvidence),evidence:allEvidence,story};
}
async function run(service,opts) {
  const {root,project:initial}=await initialize(service,opts);
  const source=initial.autoStorySourceV2;
  const engine=new Engine(service,{project:initial,root,cache:source.cache,sourceHash:source.identity,duration:source.duration,
    config:initial.autoStoryEditorialConfig,cues:[],signal:opts.signal,onProgress:opts.onProgress});
  const plan=await read(path.join(root,'plan.json')),audits=[];
  for(let story of plan.stories) {
    if(opts.scriptId && story.scriptId!==opts.scriptId) continue;
    const id=story.scriptId;engine.scriptId=id;
    const record=path.join(root,`review-state-${id}.json`),snapshotPath=path.join(root,`before-review-${id}.json`);
    const journal=await read(record).catch(()=>null);
    if(journal?.pending) {
      const snapshot=await read(snapshotPath);
      await service.store.updateProject(opts.workspaceRoot,opts.projectId,{analysis:snapshot.analysis,artifacts:snapshot.artifacts});
      await write(path.join(root,`edit-${id}.json`),snapshot.edit);
      await write(path.join(root,`evidence-${id}.json`),snapshot.evidence);
      if (snapshot.story) { story=snapshot.story;plan.stories=plan.stories.map(s=>s.scriptId===id?story:s);await write(path.join(root,'plan.json'),plan); }
    }
    let project=await service.store.getProject(opts.workspaceRoot,opts.projectId);
    engine.project=project;
    const variant=project.analysis?.highlightVariants?.find(v=>Number(v.scriptId)===id);
    if(!variant?.artifacts?.fastDraftVideoPath) continue;
    const draft=variant.artifacts.fastDraftVideoPath;
    const draftIdentity=await identity(draft);
    let script=await read(path.join(root,`edit-${id}.json`));
    let evidence=await read(path.join(root,`evidence-${id}.json`));
    const checkpointKey=compiler.hash({script,config:engine.config,story,policy:2});
    if(journal?.complete && journal.contractVersion===2 && journal.checkpointKey===checkpointKey && journal.draft===draft && journal.draftIdentity===draftIdentity && !journal.needsUserReview) { audits.push(journal);continue; }
    const snapshot={analysis:project.analysis,artifacts:project.artifacts,edit:script,evidence,story};
    let changed=false;
    try {
      let reviewed=await check(engine,story,script,evidence,draft),finalDraft=draft;
      if(reviewed.verdict==='PASS' && reviewed.confidence<.85) reviewed=await check(engine,story,script,evidence,draft,true);
      if(reviewed.verdict==='REVISE') {
        let revised;
        try { revised=await repair(engine,story,script,evidence,reviewed.issues); }
        catch(error) { if(error.kind!=='STRUCTURAL_STORY') throw error;
          revised=await repair(engine,story,script,evidence,[{type:'structure',reason:error.message}]); }
        const translations=revised.script.segments.filter(s=>s.voiceoverText).map(s=>({text:s.voiceoverText,vi:s.previewVi}));
        const jsonPath=path.join(root,`reviewed-script-${id}.json`);
        await write(jsonPath,require('./autoStoryFastService').highlight(revised.script,revised.story,revised.evidence));
        await write(snapshotPath,snapshot);await write(record,{pending:true,complete:false,scriptId:id});
        await service.store.updateProject(opts.workspaceRoot,opts.projectId,{autoStoryVoiceCache:{...project.autoStoryVoiceCache,...service.voiceCache},
          autoStoryNarrationTranslations:[...translations,...(project.autoStoryNarrationTranslations||[])],
          analysis:{...project.analysis,activeVariantId:variant.id,segments:variant.segments}});
        const imported=await service.dubbing.importReviewedScriptProject({workspaceRoot:opts.workspaceRoot,projectId:opts.projectId,settings:service.settings,jsonPath});
        const selected=imported.analysis.highlightVariants.find(v=>Number(v.scriptId)===id);
        const started=Date.now();
        const rendered=await service.dubbing.renderHighlightFastDraft({workspaceRoot:opts.workspaceRoot,projectId:opts.projectId,settings:service.settings,
          project:{...imported,analysis:{...imported.analysis,activeVariantId:selected.id,segments:selected.segments}},onProgress:opts.onProgress});
        await engine.metric(`v2-render-${id}`,{renderMs:Date.now()-started});
        finalDraft=rendered.outputPath;script=revised.script;evidence=revised.evidence;story=revised.story;changed=true;
        reviewed=await check(engine,story,script,evidence,finalDraft,true);
        // Save the revision only after technical validation and an actual final review.
        await write(path.join(root,`pre-revision-script-${id}.json`),snapshot.edit);
        await write(path.join(root,`edit-${id}.json`),script);await write(path.join(root,`evidence-${id}.json`),evidence);
        plan.stories=plan.stories.map(s=>s.scriptId===id?story:s);await write(path.join(root,'plan.json'),plan);
      }
      const passed=reviewed.verdict==='PASS' && reviewed.confidence>=.85;
      const audit={...reviewed,scriptId:id,complete:true,contractVersion:2,checkpointKey:compiler.hash({script,config:engine.config,story,policy:2}),
        pending:false,applied:changed,originalDraft:draft,draft:finalDraft,needsUserReview:!passed,revisedDraftAiVerified:changed&&passed,
        rhythmPolicyVersion:2,rhythmReport:rhythm.analyzeV2(script,script.semanticAssessment),
        finalCheck:{complete:true,scope:'full',verdict:passed?'PASS':'NEEDS_ATTENTION',issues:reviewed.issues.length ? reviewed.issues : passed ? [] : [{outputSec:0,reason:'AI chưa đủ tự tin để xác nhận chất lượng bản cuối.'}],identity:reviewed.draftIdentity,reviewPolicyVersion:2}};
      // Preview translation defects are kept separate from the export verdict.
      audit.previewSubtitleIssues=reviewed.previewSubtitleIssues.map(i=>({...i,segmentId:script.segments.find(s=>i.outputSec>=s.outputStartSec&&i.outputSec<s.outputEndSec)?.id}));
      await write(record,audit);audits.push(audit);
      await engine.metric(`v2-result-${id}`,{viralScore:reviewed.viralScore,finalViralScore:reviewed.viralScore});
      await opts.onDraft?.(await service.store.getProject(opts.workspaceRoot,opts.projectId));
    } catch(error) {
      await service.store.updateProject(opts.workspaceRoot,opts.projectId,{analysis:snapshot.analysis,artifacts:snapshot.artifacts});
      await write(path.join(root,`edit-${id}.json`),snapshot.edit);await write(path.join(root,`evidence-${id}.json`),snapshot.evidence);
      plan.stories=plan.stories.map(s=>s.scriptId===id?snapshot.story:s);await write(path.join(root,'plan.json'),plan);
      const failed={scriptId:id,contractVersion:2,pending:false,complete:false,error:error.message,kind:error.kind||'SERVICE_ERROR',draft};
      await write(record,failed);audits.push(failed);
      if(opts.signal?.aborted) throw error;
    }
  }
  return {project:await service.store.getProject(opts.workspaceRoot,opts.projectId),audits};
}
module.exports={run,check,repair,reviewScope};
