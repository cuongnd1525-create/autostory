const path = require("path");
const Editorial = require("./recapEditorialService");
const { RecapSyncSolver } = require("./recapSyncSolver");
const { throwIfCancelled } = require("../cancelToken");
const ClauseAlignment = require("./recapClauseAlignmentService");
const AnchorAudit = require("./recapAnchorAuditService");

module.exports = (Base) => class RecapEditorialPipeline extends Base {
  clearRender(state) {
    for (const key of ["draftVideoPath", "finalVideoPath", "qualityScore", "qualitySummary", "qualityIssues", "qualityGate", "completed", "reviewReady", "reviewError"]) delete state[key];
    state.reviewIteration = 0; state.userApprovedFinal = false;
  }
  clearScript(state) {
    for (const key of ["recapPlan", "speechUnits", "audioTracks", "decisions", "traceability", "syncMetrics", "durationGate"]) delete state[key];
    this.clearRender(state);
    delete state.manualDecisions;
  }
  expansionBudget(solution, state) {
    const deficit = state.durationGate.min + 1 - state.durationGate.actual;
    if (!(deficit > 0 && deficit <= 15)) return null;
    const groups = solution.clauseBudgets || [];
    const occurrence = new Map();
    for (const group of groups) for (const id of group.visual_event_ids) occurrence.set(id, (occurrence.get(id) || 0) + 1);
    const group = groups.filter(group => group.passed && group.visual_event_ids.every(id => occurrence.get(id) === 1)
      && group.maxGroundedDuration - group.currentDuration >= deficit + .5)
      .sort((a, b) => b.maxGroundedDuration - b.currentDuration - (a.maxGroundedDuration - a.currentDuration))[0];
    if (!group) return null;
    const count = group.text.split(/\s+/).filter(Boolean).length;
    const added = Math.ceil(deficit * count / group.currentDuration);
    return { ...group, targetDuration: group.currentDuration + deficit, minimumWordCount: count + added,
      targetWordCount: count + added + 2 };
  }
  async auditions({ hooks, events, tts, renderer, paths, project, workspaceRoot, options, cancelToken, progress }) {
    const auditions = [];
    for (const hook of hooks) {
      if (auditions.length >= 3) break;
      throwIfCancelled(cancelToken); progress({ message: `Đang tạo hook thử ${auditions.length + 1}/3...` });
      const event = events.find((item) => item.id === hook.event_ids[0]);
      const audio = await tts.processSpeechUnit({ speechUnit: { id: `audition_${hook.id}`, text: hook.text },
        outputDir: path.join(paths.audioDir, "hook-auditions"), workspaceRoot, project, signal: cancelToken?.signal });
      if (audio.duration < 1 || audio.duration > 10) continue;
      const duration = audio.duration + 0.25;
      const clips = [{ source_start: event.source_start, source_end: Math.min(event.source_end, event.source_start + duration),
        output_start: 0, output_end: duration, video_speed: 1, lead_ms: 150, event_id: event.id, focus_x: event.focus_x, focus_y: event.focus_y }];
      const videoPath = path.join(paths.outputDir, `hook-${Editorial.fingerprint({ hook, options, audio: audio.audio_path }).slice(0, 16)}.mp4`);
      if (!(await this._fileExists(videoPath))) await renderer.renderDraft({ sourceVideoPath: project.sourceVideoPath, muteSourceAudio: true,
        decisions: [{ speech_unit_id: `audition_${hook.id}`, audio_path: audio.audio_path, audio_duration: audio.duration, voice_tempo: 1, text: hook.text, clips }],
        outputPath: videoPath, presentation: { ...options, captions: "off" }, cancelToken });
      auditions.push({ ...hook, durationSec: audio.duration, videoPath, audioPath: audio.audio_path });
    }
    if (!auditions.length) throw new Error("Các hook quá dài hoặc không có TTS hợp lệ. Hãy đổi góc kể/giọng đọc và thử lại.");
    return auditions;
  }

  async runRecapProject(request) {
    const { workspaceRoot, projectId, settings = {}, cancelToken, onProgress = () => {} } = request;
    const savedProject = await this.projectStore.getProject(workspaceRoot, projectId);
    if (!savedProject) throw new Error(`Project ${projectId} not found.`);
    const options = Editorial.optionsFor(savedProject, settings);
    if (options.language === "vi" && (savedProject.voiceProvider || settings.defaultVoiceProvider) === "kokoro") throw new Error("Kokoro chưa hỗ trợ tiếng Việt. Chọn Edge Neural hoặc đổi lời kể sang tiếng Anh.");
    const workflow = settings.recapWorkflow || savedProject.recapWorkflow || "full_auto";
    const mute = Boolean(settings.recapMuteSourceAudio ?? savedProject.recapMuteSourceAudio ?? false);
    const reuse = Boolean(settings.allowShotReuse ?? savedProject.allowShotReuse ?? false);
    const voiceSpeed = Number(settings.voiceSpeed ?? savedProject.voiceSpeed ?? 1);
    await this.projectStore.updateProject(workspaceRoot, projectId, { targetDurationSec: options.targetDurationSec, recapWorkflow: workflow, recapNarrationLanguage: options.language });
    const prepared = await super.runRecapProject({ ...request, settings: { ...settings, _recapPrepareOnly: true,
      targetDurationSec: options.targetDurationSec, recapNarrationLanguage: options.language, voiceSpeed } });
    const { state, statePath, project, paths, ai, tts, renderer } = prepared;
    project.recapNarrationLanguage = options.language;
    if (options.language === "vi" && tts.resolveProvider?.(project) === "kokoro") throw new Error("Kokoro chưa hỗ trợ tiếng Việt. Chọn Edge Neural hoặc đổi lời kể sang tiếng Anh.");
    const persist = () => this._saveState(statePath, state);
    const progress = (stage, percent, message) => onProgress({ stage, percent, message });
    // Provider-local progress is not completion of the whole video pipeline.
    const stagePercent = { story_angles: 43, hook_generation: 45, hook_audition: 47, edit_planning: 50,
      narration_generation: 54, tts_synthesis: 60, clause_alignment: 63, duration_repair: 65, draft_rendering: 77,
      quality_review: 84, anchor_audit: 85, quality_repair: 86, final_render: 92 };
    const step = (stage) => (value) => onProgress({ ...value, stage, percent: stagePercent[stage] });
    let events = state.visualEvents;
    const storyModel = state.storyModel;
    const renderKey = Editorial.fingerprint({ aspect: options.aspect, framing: options.framing, captions: options.captions, language: options.language, mute, version: 3 });
    if (state.renderKey !== renderKey) { this.clearRender(state); state.renderKey = renderKey; }
    const prefsKey = Editorial.fingerprint({ content: Editorial.narrativeKey(options), reuse, voiceSpeed,
      voiceId: tts.resolveVoiceId?.(tts.resolveProvider?.(project) || project.voiceProvider, project) || project.voiceId,
      provider: tts.resolveProvider?.(project) || project.voiceProvider,
      voiceSettings: [settings.kokoroSpeed, settings.kokoroModel, settings.elevenLabsModel, settings.elevenLabsStability,
        settings.elevenLabsSimilarityBoost, settings.elevenLabsStyle, settings.windowsVoiceRate, settings.omniVoiceInstruct] });
    if (state.prefsKey !== prefsKey) {
      this.clearScript(state);
      for (const key of ["angles", "hooks", "auditions", "hooksKey", "scriptKey"]) delete state[key];
      state.prefsKey = prefsKey;
    }
    if (settings.recapRecheck) this.clearRender(state);
    await persist();
    let angle = null, hook = null;
    if (options.viral) {
      if (!state.angles) {
        progress("story_angles", 43, "Đang đề xuất 3 góc kể có bằng chứng nguồn...");
        state.angles = await ai.proposeAngles({ storyModel, events, options, cancelToken, onProgress: step("story_angles") }); await persist();
      }
      angle = (options.selectedAngleId ? state.angles.find((item) => item.id === options.selectedAngleId) : null) || state.angles[0];
      if (!angle) throw new Error("Góc kể đã chọn không còn trong đề xuất. Hãy chọn lại góc kể.");
      const hooksKey = Editorial.fingerprint({ angle, language: options.language, style: options.style, spoiler: options.spoiler });
      if (state.hooksKey !== hooksKey) {
        state.hooks = await ai.proposeHooks({ angle, events, options, cancelToken, onProgress: step("hook_generation") });
        state.hooksKey = hooksKey; delete state.auditions; this.clearScript(state); await persist();
      }
      if (!state.auditions) {
        state.auditions = await this.auditions({ hooks: state.hooks, events, tts, renderer, paths, project, workspaceRoot, options, cancelToken, progress: step("hook_audition") }); await persist();
      }
      hook = (options.selectedHookId ? state.auditions.find((item) => item.id === options.selectedHookId) : null) || state.auditions[0];
      if (!hook) throw new Error("Hook đã chọn không còn trong các bản thử. Hãy chọn lại hook.");
      state.editorialKey = Editorial.fingerprint({ angleId: angle.id, hooksKey, hookId: hook.id });
      const editorial = { angles: state.angles, hooks: state.auditions, selectedAngleId: angle.id, selectedHookId: hook.id, key: state.editorialKey };
      await this.projectStore.updateProject(workspaceRoot, projectId, { recapEditorial: editorial });
      if (options.selection === "manual" && project.recapEditorialApprovedKey !== state.editorialKey) {
        await this.projectStore.updateProject(workspaceRoot, projectId, { status: "editorial_ready", statusMessage: "Chờ chọn góc kể và hook.", finalVideoPath: "",
          artifacts: { finalVideoPath: "", previewVideoPath: "" }, recap: { status: "editorial_ready" } });
        return { status: "editorial_ready", projectId, editorial };
      }
    }
    const scriptKey = Editorial.fingerprint({ narrationVersion: 2, prefsKey, angle, hookId: hook?.id, hookText: hook?.text });
    if (state.scriptKey !== scriptKey) { this.clearScript(state); state.scriptKey = scriptKey; }
    if (!state.recapPlan) {
      progress("edit_planning", 50, "Đang chọn nhịp kể và payoff...");
      const raw = await ai.planRecap({ storyModel, events, targetDurationSec: options.targetDurationSec, allowShotReuse: reuse,
        editorialOptions: options, angle, hook, cancelToken, onProgress: step("edit_planning") });
      state.recapPlan = Editorial.groundPlan(raw, events, hook); state.recapPlan.target_duration_sec = options.targetDurationSec; await persist();
    }
    if (state.analysisVersion >= 4 && !state.speechUnits?.length) {
      state.recapPlan = Editorial.fillPlanCoverage(state.recapPlan, events, options.targetDurationSec);
      const adjustment = state.recapPlan.coverageAdjustment;
      if (adjustment.addedEventIds.length) progress("edit_planning", 52,
        `Đã thêm ${adjustment.addedEventIds.length} hành động nguồn có bằng chứng; ${adjustment.availableSec.toFixed(1)}s cảnh cho mục tiêu ${options.targetDurationSec}s.`);
      await persist();
    }
    if (!state.speechUnits?.length) {
      const profile = await tts.getVoiceProfile(workspaceRoot, project);
      progress("narration_generation", 54, "Đang viết lời kể theo góc kể và ngân sách thời lượng...");
      const raw = await ai.generateNarration({ recapPlan: state.recapPlan, storyModel, events, wordsPerSecond: profile.wordsPerSecond,
        scriptStyle: options.style, editorialOptions: options, angle, hook, cancelToken, onProgress: step("narration_generation") });
      state.speechUnits = Editorial.groundNarration(raw, events, state.recapPlan, hook); await persist();
    }
    const solver = new RecapSyncSolver({ allowShotReuse: reuse, targetVisualLeadSec: Number(settings.visualLeadSec ?? project.visualLeadSec ?? 0.25), logger: this.logger });
    if (state.syncTimingVersion !== 3) { this.clearRender(state); state.syncTimingVersion = 3; }
    const clauseAlignment = this.serviceFactories.clauseAlignment?.(settings) || new ClauseAlignment(settings);
    const fitTiming = async () => {
      for (let attempt = 0; attempt <= 2; attempt++) {
        throwIfCancelled(cancelToken);
        const audioAvailable = state.audioTracks && (await Promise.all(state.speechUnits.map((unit) => this._fileExists(state.audioTracks[unit.id]?.audioPath || state.audioTracks[unit.id]?.audio_path || "")))).every(Boolean);
        if (!audioAvailable || state.speechUnits.some((unit) => state.audioTracks[unit.id]?.text !== unit.text)) {
          state.audioTracks = await tts.synthesizeAll({ speechUnits: state.speechUnits, outputDir: paths.audioDir, workspaceRoot, project,
            signal: cancelToken?.signal, onProgress: step("tts_synthesis") });
        }
        await clauseAlignment.prepare({ speechUnits: state.speechUnits, audioTracks: state.audioTracks,
          directory: path.join(paths.analysisDir, "clause-alignment"), language: options.language,
          signal: cancelToken?.signal, onProgress: step("clause_alignment") });
        const solution = solver.solve({ speechUnits: state.speechUnits, visualEvents: events, audioTracks: state.audioTracks, scenes: state.scenes, sourceDurationSec: state.sourceMeta.duration });
        if (!state.manualDecisions) state.decisions = solution.decisions;
        state.traceability = solution.traceability; state.syncMetrics = solution.metrics;
        state.rewriteRecommendations = solution.rewriteRecommendations;
        state.semanticTimingGate = { passed: !solution.metrics.semanticTimingMismatchCount,
          budgets: solution.rewriteRecommendations.flatMap(item => item.clauseBudgets || []).filter(group => !group.passed) };
        const actualDuration = state.manualDecisions ? Math.max(...state.decisions.flatMap((d) => d.clips.map((c) => c.output_end)), 0) : solution.metrics.totalTimelineDurationSec;
        state.durationGate = Editorial.durationGate(actualDuration, options.targetDurationSec); await persist();
        if ((state.durationGate.passed && state.semanticTimingGate.passed) || attempt === 2) return;
        progress("duration_repair", 65, state.semanticTimingGate.passed
          ? `TTS/dựng ${state.durationGate.actual.toFixed(1)}s; đang sửa để đạt ${options.targetDurationSec}s (${attempt + 1}/2)...`
          : `Đang sửa ${state.semanticTimingGate.budgets.length} nhóm mệnh đề dài hơn cảnh nguồn; giữ mục tiêu ${options.targetDurationSec}s (${attempt + 1}/2)...`);
        const expansion = state.semanticTimingGate.passed && !state.durationGate.passed ? this.expansionBudget(solution, state) : null;
        const revised = await ai.rewriteRecap({ storyModel, events, recapPlan: state.recapPlan, speechUnits: state.speechUnits,
          options: { ...options, angle, hook }, feedback: { duration: state.durationGate, measuredUnits: state.audioTracks,
            forceClauseRepair: Boolean(expansion), clauseBudgets: expansion ? [expansion] : state.semanticTimingGate.budgets,
            rewriteRecommendations: solution.rewriteRecommendations },
          cancelToken, onProgress: step("duration_repair") });
        state.recapPlan = Editorial.groundPlan(revised.plan, events, hook); state.recapPlan.target_duration_sec = options.targetDurationSec;
        state.speechUnits = Editorial.groundNarration(revised.speech_units, events, state.recapPlan, hook);
        delete state.audioTracks; delete state.manualDecisions; this.clearRender(state); await persist();
      }
    };
    await fitTiming();
    const blocked = async (gate) => {
      state.qualityGate = gate; state.reviewReady = false; await persist();
      await this.projectStore.updateProject(workspaceRoot, projectId, { status: "quality_blocked", finalVideoPath: "", artifacts: { finalVideoPath: "", previewVideoPath: state.draftVideoPath || "" }, statusMessage: "Chưa xuất master: draft còn lỗi cần sửa.",
        recap: { status: "quality_blocked", draftVideoPath: state.draftVideoPath, qualityScore: gate.score, qualityIssues: gate.blockers, duration: state.durationGate, speechUnits: state.speechUnits } });
      progress("quality_blocked", 88, gate.blockers.map((issue) => issue.description).join(" "));
      return { status: "quality_blocked", projectId, draftVideoPath: state.draftVideoPath, blockers: gate.blockers };
    };
    if (!state.durationGate.passed) return blocked(Editorial.qualityGate(null, [{ severity: "high", type: "duration", description: `Thời lượng ${state.durationGate.actual.toFixed(1)}s chưa nằm trong ${state.durationGate.min.toFixed(1)}–${state.durationGate.max.toFixed(1)}s sau 2 lượt sửa.` }]));
    if (!state.semanticTimingGate.passed) return blocked(Editorial.qualityGate(null, [{ severity: "high", type: "semantic_duration",
      description: "Mệnh đề vẫn dài hơn cảnh nguồn sau 2 lượt sửa. Chưa dựng bằng cảnh sai hoặc giữ khung hình quá lâu.", budgets: state.semanticTimingGate.budgets }]));
    const renderDraft = async () => {
      if (state.draftVideoPath && await this._fileExists(state.draftVideoPath)) return;
      progress("draft_rendering", 77, "Đang dựng draft với khung hình và phụ đề đã chọn...");
      state.draftVideoPath = await renderer.renderDraft({ sourceVideoPath: project.sourceVideoPath, proxyVideoPath: state.proxyPath, muteSourceAudio: mute,
        presentation: options, captionDirectory: path.join(paths.analysisDir, "captions"), decisions: state.decisions,
        outputPath: path.join(paths.outputDir, `${project.id}-draft-reel.mp4`), onProgress: step("draft_rendering"), cancelToken }); await persist();
    };
    await renderDraft();
    if (!state.qualityGate?.passed) {
      for (let repair = 0; repair <= 1; repair++) {
        throwIfCancelled(cancelToken); progress("quality_review", 84, `Đang kiểm tra draft thực tế (${repair + 1}/2)...`);
        let review;
        try {
          const knownDefects = repair === 0 && typeof state.qualityScore === "number" && Array.isArray(state.qualityIssues)
            && state.qualityIssues.some(issue => ["high", "critical"].includes(issue.severity));
          review = knownDefects ? { overall_score: state.qualityScore, summary: state.qualitySummary, issues: state.qualityIssues }
            : await ai.reviewDraft({ draftVideoPath: state.draftVideoPath, decisions: state.decisions, storyModel, cancelToken, onProgress: step("quality_review") });
          delete state.reviewError;
        }
        catch (error) {
          throwIfCancelled(cancelToken); state.reviewError = error.message;
          return blocked(Editorial.qualityGate(null, [{ severity: "critical", type: "review_failed", description: `Không kiểm tra được draft: ${error.message}` }]));
        }
        state.qualityScore = review.overall_score; state.qualitySummary = review.summary; state.qualityIssues = review.issues;
        state.reviewIteration = (state.reviewIteration || 0) + 1; state.qualityGate = Editorial.qualityGate(review); await persist();
        if (state.qualityGate.passed) break;
        if (repair === 1 || state.qualityGate.score === null) return blocked(state.qualityGate);
        progress("quality_repair", 86, "Đang sửa kế hoạch/lời kể và dựng lại draft (1 lượt)...");
        try {
          const anchorIssues = review.issues.filter(issue => (["high", "critical"].includes(issue.severity)
            && ["semantic_alignment", "pacing"].includes(issue.type)) || (issue.severity === "medium" && issue.type === "semantic_alignment"));
          const suspectIds = [...new Set(state.decisions.flatMap(decision => decision.clips).filter(clip => anchorIssues.some(issue =>
            clip.output_end > issue.output_start && clip.output_start < issue.output_end)).map(clip => clip.event_id))];
          if (suspectIds.length) {
            const audit = this.serviceFactories.anchorAudit?.(settings) || new AnchorAudit(settings);
            events = await audit.repair({ sourceVideoPath: project.sourceVideoPath, sourceDuration: state.sourceMeta.duration,
              events, eventIds: suspectIds, issues: anchorIssues, scenes: state.scenes, directory: path.join(paths.analysisDir, "anchor-audit"),
              ai, signal: cancelToken?.signal, onProgress: step("anchor_audit") });
            state.visualEvents = events;
            const verified = new Map(events.map(event => [event.id, event]));
            for (const analysis of Object.values(state.chunkAnalyses || {})) analysis.events = analysis.events.map(event => verified.get(event.id) || event);
            await persist();
          }
          const revised = await ai.rewriteRecap({ storyModel, events, recapPlan: state.recapPlan, speechUnits: state.speechUnits,
            options: { ...options, angle, hook }, feedback: { issues: review.issues, score: review.overall_score, summary: review.summary }, cancelToken, onProgress: step("quality_repair") });
          state.recapPlan = Editorial.groundPlan(revised.plan, events, hook); state.recapPlan.target_duration_sec = options.targetDurationSec;
          state.speechUnits = Editorial.groundNarration(revised.speech_units, events, state.recapPlan, hook);
          delete state.audioTracks; delete state.manualDecisions;
          const iteration = state.reviewIteration; this.clearRender(state); state.reviewIteration = iteration; await fitTiming();
          if (!state.durationGate.passed) return blocked(Editorial.qualityGate(null, [{ severity: "high", type: "duration", description: "Bản sửa review chưa đạt thời lượng." }]));
          if (!state.semanticTimingGate.passed) return blocked(Editorial.qualityGate(null, [{ severity: "high", type: "semantic_duration", description: "Bản sửa review chưa khớp ngân sách hình cho từng mệnh đề." }]));
          await renderDraft();
        } catch (error) {
          throwIfCancelled(cancelToken);
          return blocked(Editorial.qualityGate(review, [{ severity: "critical", type: "repair_failed", description: `Không sửa được draft: ${error.message}` }]));
        }
      }
    }
    if (!state.qualityGate?.passed) return blocked(state.qualityGate || Editorial.qualityGate(null));
    await this.projectStore.updateProject(workspaceRoot, projectId, { status: "review_ready", statusMessage: "Draft đã đạt kiểm tra chất lượng.", finalVideoPath: "", artifacts: { finalVideoPath: "", previewVideoPath: state.draftVideoPath }, recap: { status: "review_ready", draftVideoPath: state.draftVideoPath,
      qualityScore: state.qualityScore, qualityIssues: state.qualityIssues, duration: state.durationGate, speechUnits: state.speechUnits } });
    if ((workflow === "review" && !state.userApprovedFinal) || settings.recapDraftOnly) {
      state.reviewReady = true; await persist();
      return { status: "review_ready", projectId, draftVideoPath: state.draftVideoPath, decisions: state.decisions, speechUnits: state.speechUnits,
        storyModel, qualityScore: state.qualityScore, qualityIssues: state.qualityIssues };
    }
    progress("final_render", 92, "Draft đã đạt kiểm tra; đang xuất master...");
    const name = `${(project.title || project.id).replace(/[^a-zA-Z0-9_-]/g, "_")}-recap-final.mp4`;
    const finalVideoPath = await renderer.renderFinal({ sourceVideoPath: project.sourceVideoPath, muteSourceAudio: mute, presentation: options,
      captionDirectory: path.join(paths.analysisDir, "captions"), decisions: state.decisions,
      outputPath: path.join(project.exportRoot || paths.outputDir, name), onProgress: step("final_render"), cancelToken });
    state.finalVideoPath = finalVideoPath; state.completed = true; await persist();
    await this.projectStore.updateProject(workspaceRoot, projectId, { status: "completed", statusMessage: "Đã xuất video recap.", finalVideoPath, recap: { status: "completed", completed: true,
      draftVideoPath: state.draftVideoPath, finalVideoPath, decisionsCount: state.decisions.length, qualityScore: state.qualityScore, qualityIssues: state.qualityIssues, duration: state.durationGate, speechUnits: state.speechUnits },
      artifacts: { ...(project.artifacts || {}), previewVideoPath: state.draftVideoPath, finalVideoPath } });
    progress("completed", 100, "Đã xuất video recap.");
    return { status: "completed", projectId, finalVideoPath, draftVideoPath: state.draftVideoPath, decisions: state.decisions, metrics: state.syncMetrics };
  }

  async chooseEditorial(workspaceRoot, projectId, { angleId, hookId, approve = false }) {
    const state = await this.getReviewState(workspaceRoot, projectId);
    if (!state.angles?.some((angle) => angle.id === angleId)) throw new Error("Góc kể không tồn tại.");
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    if (project.recapEditorial?.selectedAngleId !== angleId) return this.projectStore.updateProject(workspaceRoot, projectId, {
      recapSelectedAngleId: angleId, recapSelectedHookId: "", recapEditorialApprovedKey: "" });
    if (!state.auditions?.some((hook) => hook.id === hookId)) throw new Error("Hook không có trong các bản thử.");
    const key = Editorial.fingerprint({ angleId, hooksKey: state.hooksKey, hookId });
    return this.projectStore.updateProject(workspaceRoot, projectId, { recapSelectedAngleId: angleId, recapSelectedHookId: hookId, recapEditorialApprovedKey: approve ? key : "" });
  }
  async updateReviewDecisions(workspaceRoot, projectId, { speechUnits, decisions, userApprovedFinal }) {
    const file = path.join(this.projectStore.getProjectPaths(workspaceRoot, projectId).analysisDir, "recap_state.json");
    const state = await this._loadState(file);
    if (speechUnits) { state.speechUnits = speechUnits; delete state.audioTracks; delete state.manualDecisions; this.clearRender(state); }
    if (decisions) { state.decisions = decisions; state.manualDecisions = true; this.clearRender(state); }
    if (userApprovedFinal !== undefined) state.userApprovedFinal = Boolean(userApprovedFinal);
    await this._saveState(file, state); return state;
  }
};
