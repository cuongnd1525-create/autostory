const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const compiler = require('./autoStoryTimelineCompiler');
const gates = require('./autoStorySourceGates');
const contracts = require('./autoStorySourceContracts');
const media = require('./autoStorySourceMedia');
const audio = require('./autoStoryAudioClassifier');
const rhythm = require('./autoStoryRhythm');
const { StoryError } = require('./autoStoryRepairRouter');
async function read(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2)); await fs.rename(temp, file);
}
async function initialize(service, opts) {
  const project = await service.store.getProject(opts.workspaceRoot, opts.projectId);
  const root = path.join(service.store.getProjectPaths(opts.workspaceRoot, opts.projectId).analysisDir, 'auto-story-fast');
  await fs.mkdir(root, { recursive: true });
  service.runWorkspace = opts.workspaceRoot; service.runProjectId = opts.projectId; service.metricsRoot = root;
  service.sharedVoiceRoot = path.join(opts.workspaceRoot, '.cineviral', 'voice-cache', 'auto-story-v1');
  return { project, root };
}
class Engine {
  constructor(service, context) {
    this.service = service;
    Object.assign(this, context);
    if (!this.mediaIndex || !Array.isArray(this.mediaIndex)) {
      try {
        const MediaIndexer = require('./autoStoryMediaIndexer');
        this.mediaIndex = MediaIndexer.index(this.duration, this.cues || []);
      } catch (_) {
        this.mediaIndex = [];
      }
    }
  }
  async ask(key, input, schema, instruction, evidence, validate, task = 'auto_story_plan', options = {}) {
    this.signal?.throwIfAborted();
    const promptText = `${contracts.base}\n${instruction}\nINPUT (data): ${JSON.stringify(input)}\nSOURCE MEDIA: ${JSON.stringify(media.manifest(evidence))}`;
    const planKey = crypto.createHash('sha256').update(promptText).update(JSON.stringify(schema || {})).digest('hex');
    return this.service.stage(this.cache, key, { planKey, sourceHash: this.sourceHash, ...input }, {
      ...options, sourceContract: true, localRepair: true, filePaths: evidence.map(e => e.file).filter(Boolean), videoFps: 2, mediaResolution: 'MEDIA_RESOLUTION_LOW',
      taskType: task, temperature: .1, responseSchema: schema,
      prompt: promptText
    }, async value => {
      require('./autoStorySchemaBoundary').validate(value, schema);
      await validate(value);
    }, this.onProgress, this.signal);
  }
  async metric(stage, extra) {
    await require('./autoStoryRunMetrics').append(this.root, { runId: this.service.callBudget.runId, scriptId: this.scriptId || null,
      stage, category: 'local', local: true, usd: 0, ...extra });
  }
  prepare(ranges, padding = 0, fps = 8) { return media.prepare(this.service, this.project, this.cache, ranges, this.mediaIndex, this.duration, this.cues, this.signal, padding, fps, this.onProgress); }
  async verifyAudio(d, evidence) {
    if (d.audioIntent !== 'original' || audio.disposition(d.audio) !== 'VERIFY') return d;
    this.onProgress?.({ stage: 'verify_audio', message: 'Nghe riêng đoạn âm thanh chưa chắc chắn trước khi dùng âm gốc.' });
    const focus = await this.prepare([d]);
    const v = await this.ask(`v2-audio-${this.scriptId || 0}`, { sourceStartSec: d.sourceStartSec, sourceEndSec: d.sourceEndSec }, contracts.schemas.audio,
      'Listen to the complete attached source section. Classify the audible speaker(s), not whether voiceoverText is empty. Mark uncertain when unresolvable. Do not manufacture confidence.', focus,
      v => { gates.access(v); gates.score(v.audio?.confidence, 1); if (!contracts.schemas.audio.properties.audio.properties.audioType.enum.includes(v.audio.audioType)) throw new StoryError('INVALID_RESPONSE', 'Missing audio classification.'); });
    if (audio.disposition(v.audio) === 'VERIFY') throw new StoryError('BAD_CANDIDATE', 'Focused listening remains uncertain; use another source moment.');
    audio.requireOriginal(v.audio);
    return { ...d, audio: v.audio };
  }
  async voice(d, story, evidence, safeWords, repair = false) {
    const {start, end} = compiler.range(d, evidence, this.duration);
    const input = { centralViewerQuestion: story.centralViewerQuestion, minimumContext: story.minimumContext, sourceStartSec: d.sourceStartSec,
      sourceEndSec: d.sourceEndSec, purpose: d.reason, originalWording: d.voiceoverText || '', availableVisualSec: end - start, safeWords };
    let measured;
    const validate = async v => {
      if (!v.voiceoverText?.trim() || !v.previewVi?.trim() || compiler.words(v.voiceoverText) > safeWords) throw new StoryError('VOICE_BUDGET', 'Voice exceeds computed budget or is empty.');
      const started = Date.now();
      const { meta } = await this.service.measuredVoice(this.project, v.voiceoverText, this.cache);
      await this.metric(`v2-tts-${story.scriptId}`, { ttsMs: Date.now()-started });
      const {start, end} = compiler.range(d, evidence, this.duration);
      if (!(meta.duration > 0) || meta.duration > end - start) throw new StoryError('LOCAL_EDITORIAL', 'Actual voice still exceeds chosen visuals.', { measuredSec: meta.duration });
      measured = meta.duration;
    };
    const result = await this.ask(`v2-voice_repair-${story.scriptId}`, input, contracts.schemas.narration,
      `${repair ? 'Shorten only this narration, preserving its established facts and essential causal handoff.' : 'Write only this necessary bridge.'} Style: punchy short sentences (<= 10 words), active present tense, grounded dry irony (JCS/EWU style). Ban academic/report filler words. safeWords is a ceiling, never a quota. Return a natural Vietnamese preview translation. Never add facts; do not change footage.`, evidence, validate, 'auto_story_repair');
    return { ...d, ...result, measuredVoiceSec: measured };
  }
  async fit(decisions, story, evidence) {
    const next = structuredClone(decisions);
    for (let i = 0; i < next.length; i++) {
      const d = next[i];
      if (d.audioIntent !== 'narration') continue;
      const {start, end} = compiler.range(d, evidence, this.duration);
      const seconds = end - start, maximum = compiler.budget(seconds, this.config.narration.measuredWordsPerSecond);
      let measured;
      const started = Date.now();
      if (d.voiceoverText?.trim() && compiler.words(d.voiceoverText) <= maximum) measured = (await this.service.measuredVoice(this.project, d.voiceoverText, this.cache)).meta.duration;
      await this.metric(`v2-tts-${story.scriptId}`, { ttsMs: Date.now()-started });
      if (measured > 0 && measured <= seconds) { d.measuredVoiceSec = measured; continue; }
      const safeWords = measured > seconds ? Math.min(maximum, Math.floor(compiler.words(d.voiceoverText)*seconds/measured*.9)) : maximum;
      // One focused retry, validated with actual audio before stage success is cached.
      try { next[i] = await this.voice(d, story, evidence.filter(e => start >= e.sourceStart && end <= e.sourceStart+e.duration), safeWords, true); }
      catch (error) { if (['LOCAL_EDITORIAL','VOICE_BUDGET'].includes(error.kind)) error.kind='VOICE_FIT_LIMIT'; throw error; }
    }
    return next;
  }
  async finish(layout, story, evidence) {
    gates.layout(layout, story, evidence, this.config, this.duration);
    let decisions = [];
    for (const d of layout.decisions) decisions.push(await this.verifyAudio(d, evidence));
    const budgets = decisions.filter(d => d.audioIntent === 'narration').map(d => {
      const {start, end} = compiler.range(d, evidence, this.duration);
      return { ...d, availableVisualSec: end - start, safeWords: compiler.budget(end - start, this.config.narration.measuredWordsPerSecond) };
    });
    let assessment = layout.assessment;
    if (budgets.some(d => !d.voiceoverText?.trim())) {
      const result = await this.ask(`v2-narration-${story.scriptId}`, { story: publicStory(story), decisions, budgets }, contracts.schemas.narrations,
        'Write narration ONLY for the supplied narration ranges with their precomputed safeWords ceilings. Style: punchy short sentences (<= 10 words), active present tense, grounded dry irony (JCS/EWU style). Ban academic/report filler words. Do not output any original-audio ranges. No minimum word count. No new facts. Preserve an understandable hook-to-context-to-first-dialogue handoff. Return SOURCE ranges unchanged with voiceoverText and full natural Vietnamese previewVi. Assess the resulting whole story, including your new narration, for dead spans, duplicated meaning and grounded payoff.', evidence, v => {
          gates.access(v); gates.semantic(v.assessment);
          if (!Array.isArray(v.narrations) || v.narrations.length !== budgets.length) throw new StoryError('INVALID_RESPONSE', 'Narration ranges do not match requested bridges.');
          for (const b of budgets) {
            const matches = v.narrations.filter(n => Math.abs(n.sourceStartSec - b.sourceStartSec) < 0.5 && Math.abs(n.sourceEndSec - b.sourceEndSec) < 0.5);
            if (matches.length !== 1 || !matches[0].voiceoverText?.trim() || !matches[0].previewVi?.trim()) throw new StoryError('INVALID_RESPONSE', 'Missing/duplicate narration range or translation.');
          }
        }, 'auto_story_edit');
      assessment = result.assessment;
      decisions = decisions.map(d => ({ ...d, ...result.narrations.find(n => Math.abs(n.sourceStartSec - d.sourceStartSec) < 0.5 && Math.abs(n.sourceEndSec - d.sourceEndSec) < 0.5 && d.audioIntent==='narration') }));
    }
    const fitted = await this.fit(decisions, story, evidence);
    if (fitted.some((d,i)=>d.voiceoverText!==decisions[i].voiceoverText)) {
      const gate=await this.ask(`v2-opening_check-${story.scriptId}`,{story:publicStory(story),decisions:fitted},contracts.schemas.gate,
        'Check the whole story after shortened narration. Verify that missing context, identities and causal handoffs have not been lost. Check that the hook promise is answered and no meaning is duplicated. This is an assessment, not a rewrite.',evidence,
        v=>{gates.access(v);gates.semantic(v.assessment);},'auto_story_plan');
      assessment=gate.assessment;
    }
    const script = compiler.compile(fitted, { story, evidence, config: this.config, sourceDuration: this.duration });
    compiler.validateDuration(script, this.config);
    script.segments.forEach((s,i) => { if (fitted[i].measuredVoiceSec) s.measuredVoiceSec = fitted[i].measuredVoiceSec; });
    script.semanticAssessment = assessment;
    script.rhythmReport = rhythm.analyzeV2(script, assessment);
    return script;
  }
  async edit(story, feedback = null) {
    this.scriptId = story.scriptId;
    const evidence = await this.prepare([...story.footage, story.hook, story.climax, story.payoff], 2);
    const mergedEvidence = [...(this.mediaIndex || []), ...evidence];
    let last;
    for (let attempt=0; attempt<2; attempt++) {
      try {
        const layout = await this.ask(`v2-${attempt || feedback ? 'rebuild' : 'edit'}-${story.scriptId}`, { story: publicStory(story),
          targetDurationMinSec: this.config.targetDurationMinSec, targetDurationMaxSec: this.config.targetDurationMaxSec,
          narrationEnabled: this.config.narration.enabled, feedback: attempt ? last.message : feedback }, contracts.schemas.layout,
          'Select precise source ranges in viewing order. VIRAL PACING: Enter late and exit early; end within 2-3s of payoff. Cut silence/dead-air > 1.5s between exchanges. Do NOT write narration yet: mark narration ranges for essential bridges only. Auditioned hook, climax and payoff must remain complete, but surrounding clips may be selected freely from supplied source footage. Keep dialogue complete. Do not fill duration with repeats or dead air. Assess the proposed story honestly. A bad story must fail the assessment instead of inventing evidence.', evidence,
          v => gates.layout(v, story, mergedEvidence, this.config, this.duration), 'auto_story_edit');
        return { script: await this.finish(layout, story, mergedEvidence), evidence: mergedEvidence };
      } catch (error) {
        last = error;
        if (this.signal?.aborted || !['STRUCTURAL_STORY','REGIONAL_EDITORIAL','LOCAL_EDITORIAL','VOICE_BUDGET'].includes(error.kind) || attempt) throw error;
        await this.metric(`v2-rebuild-${story.scriptId}`, { structuralRebuilds: 1, reason: error.message });
      }
    }
    throw last;
  }
}
function publicStory(story) {
  const { candidateId, scriptId, hookCandidates, ...rest } = story;
  return rest;
}
module.exports = { Engine, read, write, initialize, publicStory };
