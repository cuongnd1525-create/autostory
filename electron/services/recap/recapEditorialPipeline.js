const path = require("path");
const Editorial = require("./recapEditorialService");
const { RecapSyncSolver } = require("./recapSyncSolver");
const { throwIfCancelled } = require("../cancelToken");
const ClauseAlignment = require("./recapClauseAlignmentService");
const AnchorAudit = require("./recapAnchorAuditService");
const NarrativePreflight = require("./recapNarrativePreflightService");
const ScopeRecovery = require("./recapScopeRecoveryService");

module.exports = (Base) => class RecapEditorialPipeline extends Base {
  clearRender(state) {
    for (const key of ["draftVideoPath", "finalVideoPath", "qualityScore", "qualitySummary", "qualityIssues", "qualityGate", "qualityDurationAssessment", "completed", "reviewReady", "reviewError"]) delete state[key];
    state.reviewIteration = 0; state.userApprovedFinal = false;
  }
  clearScript(state) {
    for (const key of ["recapPlan", "speechUnits", "audioTracks", "decisions", "traceability", "syncMetrics", "durationGate", "narrativePreflight", "scopeEstimate", "longFormNarration", "timingRepairError", "scopeBaseline", "sourceCoverageRecovery", "scopeRepairError", "scopeRevisionAttempts", "scopePlanningFailures"]) delete state[key];
    this.clearRender(state);
    delete state.manualDecisions;
  }
  needsStructuralRepair(budgets, speechUnits) {
    if (budgets.some(group => group.missingEventIds?.length || group.targetWordCount <= 3)) return true;
    const words = text => String(text || "").trim().split(/\s+/).filter(Boolean).length;
    const totalWords = speechUnits.reduce((sum, unit) => sum + words(unit.text), 0);
    const lostWords = budgets.reduce((sum, group) => sum + Math.max(0, words(group.text) - group.targetWordCount), 0);
    return totalWords > 0 && lostWords > totalWords * .15;
  }
  canSettleTiming(budgets) {
    return budgets.length > 0 && budgets.every(group => !group.missingEventIds?.length
      && group.currentDuration > group.targetDuration && group.currentDuration - group.targetDuration <= .5)
      && budgets.reduce((sum, group) => sum + group.currentDuration - group.targetDuration, 0) <= 1;
  }
  isSourceIssue(issue) {
    const type = String(issue.type || "").toLowerCase();
    if (/semantic|ground|source|scene|visual|character|actor|identity|fact|story|continuity|event|shot/.test(type)) return true;
    // Review labels are free text. An unfamiliar blocking type must not skip
    // source verification just because it is absent from a fixed whitelist.
    return ["high", "critical"].includes(issue.severity)
      && !/audio|voice|tts|subtitle|caption|pacing|duration|silence|loudness|pronunciation|music/.test(type);
  }
  qualityRepairFocus(review, decisions, speechUnits, gate) {
    const scopeOnly = gate?.blockers?.length && gate.blockers.every(issue => issue.type === "editorial_duration");
    // A missing causal step needs a narrative patch, not a source re-audit of
    // every nonblocking cutaway mentioned by the excerpt reviewers.
    const candidates = scopeOnly ? [...review.issues.filter(issue => ["story_scope", "narration_facts"].includes(issue.type)), ...gate.blockers] : review.issues;
    const blocking = candidates.filter(issue => ["high", "critical"].includes(issue.severity));
    const issues = scopeOnly ? candidates : blocking.length ? blocking : candidates;
    const feedback = { issues };
    const timed = issue => Number.isFinite(issue.output_start) && issue.output_end > issue.output_start;
    const known = new Set(speechUnits.map(unit => unit.id));
    if (issues.some(issue => !timed(issue) && (!issue.speech_unit_ids?.length || issue.speech_unit_ids.some(id => !known.has(id))))) return feedback;
    const affected = new Set(issues.flatMap(issue => issue.speech_unit_ids || []));
    for (const decision of decisions) if (decision.clips.some(clip => issues.some(issue => timed(issue)
      && clip.output_end > issue.output_start && clip.output_start < issue.output_end))) affected.add(decision.speech_unit_id);
    if (!affected.size) return feedback;
    // Adjacent units allow a reveal/explanation or causal bridge to move, while
    // preventing a local repair from rewriting and shrinking the whole story.
    feedback.focusUnitIds = speechUnits.filter((unit, i) => unit.id !== "opening_hook"
      && [speechUnits[i - 1]?.id, unit.id, speechUnits[i + 1]?.id].some(id => affected.has(id))).map(unit => unit.id);
    return feedback;
  }
  checkpointNarrativeRevision(state, events, options, voiceKey) {
    // Timing and rendered-video repairs happen AFTER preflight. Record their
    // exact inputs so resume continues that stage instead of rewriting the
    // whole script again. This never replaces the rendered-video quality gate.
    if (state.narrativePreflight?.completed) state.narrativePreflight.downstreamKey = new NarrativePreflight().key({
      speechUnits: state.speechUnits, recapPlan: state.recapPlan, events, options, voiceKey
    });
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
  multiExpansionBudgets(solution, state) {
    const deficit = state.durationGate.min + 1 - state.durationGate.actual;
    if (!(deficit > 0 && deficit <= 60)) return null;
    if (state.semanticTimingGate?.passed && deficit <= 15) {
      const single = this.expansionBudget(solution, state);
      if (single) return [single];
    }
    const overflowing = state.semanticTimingGate?.budgets || [];
    const overflowLoss = overflowing.reduce((sum, g) => sum + Math.max(0, (g.currentDuration || 0) - (g.targetDuration || 0)), 0);
    const needed = deficit + overflowLoss;
    const overflowingUnits = new Set(overflowing.map(g => g.speechUnitId));
    const allGroups = [...(solution.clauseBudgets || []), ...(solution.unitBudgets || [])];
    const occurrence = new Map();
    for (const group of allGroups) for (const id of group.visual_event_ids || []) occurrence.set(id, (occurrence.get(id) || 0) + 1);
    const candidates = allGroups.filter(group => group.passed
      && group.speechUnitId !== "opening_hook"
      && !overflowingUnits.has(group.speechUnitId)
      && (group.visual_event_ids || []).every(id => occurrence.get(id) === 1)
      && (group.maxGroundedDuration - group.currentDuration) >= 1.5)
      .sort((a, b) => (b.maxGroundedDuration - b.currentDuration) - (a.maxGroundedDuration - a.currentDuration))
      .slice(0, 20);
    const totalSpare = candidates.reduce((sum, g) => sum + Math.max(0, g.maxGroundedDuration - g.currentDuration - 0.4), 0);
    if (totalSpare < needed) return null;
    let remaining = needed;
    const expanded = [];
    for (const group of candidates) {
      if (remaining <= 0.2) break;
      const spare = Math.max(0, group.maxGroundedDuration - group.currentDuration - 0.4);
      const addSec = Math.min(spare, Math.max(1.0, remaining));
      if (addSec < 0.8) continue;
      const count = Math.max(1, String(group.text || "").split(/\s+/).filter(Boolean).length);
      const addedWords = Math.max(2, Math.ceil(addSec * count / Math.max(0.8, group.currentDuration)));
      expanded.push({
        ...group,
        targetDuration: Number((group.currentDuration + addSec).toFixed(3)),
        minimumWordCount: count + addedWords,
        targetWordCount: count + addedWords + 2
      });
      remaining -= addSec;
    }
    if (remaining > 0.5) return null;
    return [...overflowing, ...expanded];
  }
  async auditions({ hooks, events, tts, renderer, paths, project, workspaceRoot, options, cancelToken, progress }) {
    const auditions = [];
    const limit = options.selection === "auto" && !options.selectedHookId ? 1 : 3;
    for (const hook of hooks) {
      if (auditions.length >= limit && (!options.selectedHookId || auditions.some(item => item.id === options.selectedHookId))) break;
      throwIfCancelled(cancelToken); progress({ message: `Đang tạo hook thử ${auditions.length + 1}/${limit}...` });
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
    const strictTimingGate = Boolean(settings.strictDurationGate ?? savedProject.strictDurationGate ?? false);
    await this.projectStore.updateProject(workspaceRoot, projectId, { targetDurationSec: options.targetDurationSec, recapWorkflow: workflow, recapNarrationLanguage: options.language });
    const prepared = await super.runRecapProject({ ...request, settings: { ...settings, _recapPrepareOnly: true,
      targetDurationSec: options.targetDurationSec, recapNarrationLanguage: options.language, voiceSpeed } });
    const { state, statePath, project, paths, ai, tts, renderer, media } = prepared;
    project.recapNarrationLanguage = options.language;
    const sourceDurationSec = Number(state.sourceMeta?.duration);
    if (Number.isFinite(sourceDurationSec) && sourceDurationSec > 0) {
      const maxTarget = Math.max(15, Math.floor(sourceDurationSec));
      const clamped = Math.min(options.targetDurationSec, maxTarget);
      if (clamped !== options.targetDurationSec) {
        onProgress({ stage: "validate_inputs", percent: 3, level: "WARNING",
          message: `Thời lượng mục tiêu ${options.targetDurationSec}s dài hơn video gốc; tự giới hạn về ${clamped}s.` });
        options.targetDurationSec = clamped;
      }
      if (savedProject.sourceDurationSec !== sourceDurationSec || savedProject.targetDurationSec !== options.targetDurationSec) {
        await this.projectStore.updateProject(workspaceRoot, projectId, { sourceDurationSec, targetDurationSec: options.targetDurationSec });
      }
    }
    if (options.language === "vi" && tts.resolveProvider?.(project) === "kokoro") throw new Error("Kokoro chưa hỗ trợ tiếng Việt. Chọn Edge Neural hoặc đổi lời kể sang tiếng Anh.");
    const persist = () => this._saveState(statePath, state);
    const progress = (stage, percent, message) => onProgress({ stage, percent, message });
    // Provider-local progress is not completion of the whole video pipeline.
    const stagePercent = { story_angles: 43, hook_generation: 45, hook_audition: 47, edit_planning: 50,
      narration_generation: 54, source_coverage: 56, narrative_preflight: 57, tts_synthesis: 60, clause_alignment: 63, duration_repair: 65, draft_rendering: 77,
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
    if (settings.recapRecheck) {
      if (state.reviewError && state.draftVideoPath && await this._fileExists(state.draftVideoPath)) {
        for (const key of ["finalVideoPath", "qualityGate", "completed", "reviewReady", "reviewError"]) delete state[key];
        state.reviewIteration = 0; state.userApprovedFinal = false;
      } else {
        this.clearRender(state);
      }
    }
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
    const scriptKey = Editorial.fingerprint({ narrationVersion: options.targetDurationSec >= 300 ? 6 : 4, prefsKey, angle, hookId: hook?.id, hookText: hook?.text });
    if (state.scriptKey !== scriptKey) { this.clearScript(state); state.scriptKey = scriptKey; }
    let profile;
    if (options.targetDurationSec >= 300 && !state.speechUnits?.length && typeof ai.generateLongFormNarration === "function") {
      let chunks;
      try { chunks = JSON.parse(state.chunkAnalysisKey).chunks; } catch (_) { /* fail with actionable source error below */ }
      if (!chunks?.length && media?.planChunks && sourceDurationSec > 0) chunks = media.planChunks({
        scenes: state.scenes, sourceDuration: sourceDurationSec, targetChunkSec: 240, overlapSec: 2
      });
      if (!chunks?.length || !media) throw new Error("Thiếu phân đoạn nguồn để viết recap dài; cần chuẩn bị lại nguồn video.");
      chunks = chunks.map((chunk, index) => ({ ...chunk, summary: state.chunkAnalyses?.[String(index)]?.summary
        || [state.chunkAnalyses?.[`${index}:part1`]?.summary, state.chunkAnalyses?.[`${index}:part2`]?.summary].filter(Boolean).join(" ") }));
      profile = await tts.getVoiceProfile(workspaceRoot, project);
      state.longFormSections ||= {};
      const written = await ai.generateLongFormNarration({ media, chunks, events, storyModel,
        options: { ...options, allowShotReuse: reuse }, angle, hook, wordsPerSecond: profile.wordsPerSecond,
        proxyPath: state.proxyPath, directory: path.join(paths.analysisDir, "chunks"), cache: state.longFormSections,
        signal: cancelToken?.signal, onProgress: step("narration_generation"), onSection: async (key, raw) => {
          state.longFormSections[key] = raw; await persist();
        } });
      state.recapPlan = written.plan; state.speechUnits = written.speechUnits;
      state.visualEvents = events = written.events;
      state.longFormNarration = { metrics: written.metrics, sourceFiles: written.filePaths };
      await persist();
    }
    if (!state.recapPlan) {
      progress("edit_planning", 50, "Đang chọn nhịp kể và payoff...");
      const raw = await ai.planRecap({ storyModel, events, targetDurationSec: options.targetDurationSec, allowShotReuse: reuse,
        editorialOptions: options, angle, hook, cancelToken, onProgress: step("edit_planning") });
      state.recapPlan = Editorial.groundPlan(raw, events, hook); state.recapPlan.target_duration_sec = options.targetDurationSec; await persist();
    }
    const blockScope = async (description, estimate) => {
      const blockers = [{ severity: "high", type: "narrative_scope", description }];
      state.qualityGate = { passed: false, score: null, blockers }; state.reviewReady = false;
      state.scopeEstimate = estimate; await persist();
      await this.projectStore.updateProject(workspaceRoot, projectId, { status: "quality_blocked", finalVideoPath: "",
        artifacts: { finalVideoPath: "", previewVideoPath: state.draftVideoPath || "" },
        statusMessage: description, recap: { status: "quality_blocked", qualityIssues: blockers, speechUnits: state.speechUnits } });
      progress("quality_blocked", 57, description);
      return { status: "quality_blocked", projectId, blockers, scopeEstimate: estimate };
    };
    const shouldFillCoverage = strictTimingGate && !state.speechUnits?.length;
    if (shouldFillCoverage) {
      state.recapPlan = Editorial.fillPlanCoverage(state.recapPlan, events, options.targetDurationSec);
      const adjustment = state.recapPlan.coverageAdjustment;
      if (adjustment.addedEventIds.length) progress("edit_planning", 52,
        `Đã thêm ${adjustment.addedEventIds.length} hành động nguồn có bằng chứng; ${adjustment.availableSec.toFixed(1)}s cảnh cho mục tiêu ${options.targetDurationSec}s.`);
      await persist();
    }
    if (!state.speechUnits?.length) {
      profile = await tts.getVoiceProfile(workspaceRoot, project);
      progress("narration_generation", 54, "Đang viết lời kể theo góc kể và ngân sách thời lượng...");
      const raw = await ai.generateNarration({ recapPlan: state.recapPlan, storyModel, events, wordsPerSecond: profile.wordsPerSecond,
        scriptStyle: options.style, editorialOptions: { ...options, allowShotReuse: reuse }, angle, hook, cancelToken, onProgress: step("narration_generation") });
      state.speechUnits = Editorial.groundNarration(raw, events, state.recapPlan, hook); await persist();
    }
    const scope = new ScopeRecovery();
    const protectScope = !strictTimingGate && !state.manualDecisions && options.targetDurationSec >= 300;
    const scopeInputs = units => ({ speechUnits: units, events, options: { ...options, allowShotReuse: reuse },
      wordsPerSecond: profile?.wordsPerSecond, audioTracks: state.audioTracks });
    if (protectScope && !state.qualityGate?.passed) {
      profile ||= await tts.getVoiceProfile(workspaceRoot, project);
      if (scope.assess(scopeInputs(state.speechUnits)).shortfallRisk) {
        const beforeEvents = events;
        const recovered = await scope.recover({ state, options: { ...options, allowShotReuse: reuse }, prefsKey, hook, ai, media,
          sourceVideoPath: project.sourceVideoPath, directory: paths.analysisDir, signal: cancelToken?.signal,
          onProgress: step("source_coverage"), persist });
        if (recovered.changed) {
          events = state.visualEvents; this.clearRender(state); delete state.scopeRepairError;
          const retained = new NarrativePreflight().reuseVerifiedCoverage({ cached: state.narrativePreflight,
            speechUnits: state.speechUnits, recapPlan: state.recapPlan, beforeEvents, events,
            options: { ...options, angle, hook, allowShotReuse: reuse }, voiceKey: prefsKey,
            coverage: state.sourceCoverageRecovery, audioTracks: state.audioTracks, wordsPerSecond: profile.wordsPerSecond });
          if (retained) state.narrativePreflight = retained;
          await persist();
        }
      }
    }
    if (typeof ai.reviewNarration === "function" && !state.manualDecisions) {
      try {
        profile ||= await tts.getVoiceProfile(workspaceRoot, project);
        const preflight = await new NarrativePreflight().run({ speechUnits: state.speechUnits, events, recapPlan: state.recapPlan,
          options: { ...options, angle, hook, allowShotReuse: reuse }, wordsPerSecond: profile.wordsPerSecond,
          sourceFiles: state.longFormNarration?.sourceFiles,
          audioTracks: state.audioTracks, voiceKey: prefsKey, cached: state.narrativePreflight, ai, cancelToken, onProgress: step("narrative_preflight") });
        if (!preflight.reused) {
          state.recapPlan = preflight.recapPlan; state.speechUnits = preflight.speechUnits;
          state.narrativePreflight = preflight.report;
          if (preflight.report.repaired) this.clearRender(state);
          await persist();
        } else progress("narrative_preflight", 57, "Dùng lại kiểm tra kịch bản đã hoàn tất; không gọi AI lại cho nội dung không đổi.");
      } catch (error) {
        throwIfCancelled(cancelToken);
        if (error.kind === "scope_repair_rejected") {
          state.narrativePreflight = error.preflightReport;
          return blockScope(error.message, error.estimate);
        }
        if (["budget", "auth", "cancelled"].includes(error.kind) || error.name === "AbortError") throw error;
        onProgress({ stage: "narrative_preflight", percent: 57, level: "WARNING",
          message: `Chưa hoàn tất kiểm tra kịch bản sớm (${error.message}); vẫn bắt buộc kiểm tra bản dựng thực tế.` });
      }
    }
    if (!strictTimingGate && !state.manualDecisions && options.targetDurationSec >= 300) {
      profile ||= await tts.getVoiceProfile(workspaceRoot, project);
      let estimate = scope.assess(scopeInputs(state.speechUnits));
      const measuredAudioReady = (await Promise.all(state.speechUnits.map(async unit => {
        const track = state.audioTracks?.[unit.id];
        return track?.text === unit.text && Number(track.duration ?? track.durationSec) > 0
          && await this._fileExists(track.audioPath || track.audio_path || "");
      }))).every(Boolean);
      for (let planning = 0; planning < 2 && !measuredAudioReady && !estimate.duration.largeDeviation && estimate.fittingGate.largeDeviation && estimate.balancePlan; planning++) {
        progress("source_coverage", 58, "Phân bổ lại chi tiết theo ngân sách hình trước khi tạo TTS toàn bộ...");
        const key = Editorial.fingerprint({ speechUnits: state.speechUnits, events, prefsKey, cadence: estimate.wordsPerSecond });
        if (state.scopePlanningFailures?.[key]) return blockScope(state.scopePlanningFailures[key], estimate);
        let revised;
        try {
          revised = await ai.rewriteRecap({ storyModel, events, recapPlan: state.recapPlan, speechUnits: state.speechUnits,
            repairCache: state.clauseRepairCache ||= {}, onRepair: async (id, repair) => { state.clauseRepairCache[id] = repair; await persist(); },
            options: { ...options, angle, hook, allowShotReuse: reuse }, feedback: { qualityFirst: true, forceClauseRepair: true,
              duration: { ...estimate.duration, passed: true }, clauseBudgets: estimate.balancePlan }, cancelToken, onProgress: step("source_coverage") });
        } catch (error) {
          throwIfCancelled(cancelToken);
          if (error.kind !== "timing_repair_failed") throw error;
          state.scopePlanningFailures ||= {}; state.scopePlanningFailures[key] = error.message;
          return blockScope(error.message, estimate);
        }
        const plan = Editorial.groundPlan(revised.plan, events, hook); plan.target_duration_sec = options.targetDurationSec;
        const units = Editorial.groundNarration(revised.speech_units, events, plan, hook);
        const proposed = scope.assess({ ...scopeInputs(units), wordsPerSecond: estimate.wordsPerSecond, audioTracks: {} });
        if (proposed.duration.largeDeviation) {
          state.scopePlanningFailures ||= {};
          state.scopePlanningFailures[key] = `Không nhận bản phân bổ dự kiến ${proposed.duration.actual.toFixed(0)}s cho mục tiêu ${options.targetDurationSec}s. Giữ bản kể trước khi rút gọn; chưa tạo TTS mới.`;
          return blockScope(state.scopePlanningFailures[key], proposed);
        }
        state.recapPlan = plan; state.speechUnits = units;
        this.checkpointNarrativeRevision(state, events, { ...options, angle, hook, allowShotReuse: reuse }, prefsKey);
        estimate = proposed; await persist();
      }
      if (estimate.duration.largeDeviation) return blockScope(
        `Kịch bản ${estimate.wordCount} từ dự kiến ${estimate.duration.actual.toFixed(0)}s so với mục tiêu ${options.targetDurationSec}s. Phần hình đã xác minh hiện có ${estimate.sourceCoverage.availableSec.toFixed(0)}s. Chưa tạo TTS: cần phát triển nội dung có bằng chứng hoặc chọn mục tiêu phù hợp, thay vì rút câu rồi dừng muộn.`, estimate);
      if (estimate.fittingGate.largeDeviation && !measuredAudioReady) return blockScope(
        `Chưa tạo TTS: kịch bản dự kiến ${estimate.duration.actual.toFixed(0)}s nhưng nếu chỉ rút câu để vừa hình sẽ còn khoảng ${estimate.fittedDurationSec.toFixed(0)}s cho mục tiêu ${options.targetDurationSec}s. Cần phân bổ lại cảnh hỗ trợ; không chấp nhận rút ngắn hàng loạt rồi mới chặn xuất.`, estimate);
      if (!state.scopeBaseline || state.scopeBaseline.prefsKey !== prefsKey) {
        state.scopeBaseline = { prefsKey, evidenceKey: scope.evidenceKey(events), plan: structuredClone(state.recapPlan), speechUnits: structuredClone(state.speechUnits) }; await persist();
      }
    }
    const solver = new RecapSyncSolver({ allowShotReuse: reuse, targetVisualLeadSec: Number(settings.visualLeadSec ?? project.visualLeadSec ?? 0.25), logger: this.logger });
    if (state.syncTimingVersion !== 4) { this.clearRender(state); state.syncTimingVersion = 4; }
    const clauseAlignment = this.serviceFactories.clauseAlignment?.(settings) || new ClauseAlignment(settings);
    let reusableAudioTracks = state.audioTracks || {};
    const reviewPolicyKey = Editorial.fingerprint({ version: 3, qualityFirst: true, target: options.targetDurationSec, strictTimingGate });
    if (state.reviewPolicyKey !== reviewPolicyKey) {
      for (const key of ["qualityScore", "qualitySummary", "qualityIssues", "qualityGate", "qualityDurationAssessment", "finalVideoPath", "completed", "reviewReady", "reviewError"]) delete state[key];
      state.reviewIteration = 0; state.userApprovedFinal = false; state.reviewPolicyKey = reviewPolicyKey;
    }
    const fitTiming = async (maxAttempts = 2) => {
      let attemptLimit = maxAttempts, settling = false;
      for (let attempt = 0; attempt <= attemptLimit; attempt++) {
        throwIfCancelled(cancelToken);
        const audioAvailable = state.audioTracks && (await Promise.all(state.speechUnits.map((unit) => this._fileExists(state.audioTracks[unit.id]?.audioPath || state.audioTracks[unit.id]?.audio_path || "")))).every(Boolean);
        if (!audioAvailable || state.speechUnits.some((unit) => state.audioTracks[unit.id]?.text !== unit.text)) {
          state.audioTracks = await tts.synthesizeAll({ speechUnits: state.speechUnits, outputDir: paths.audioDir, workspaceRoot, project,
            existingAudioTracks: reusableAudioTracks, signal: cancelToken?.signal, onProgress: step("tts_synthesis") });
          reusableAudioTracks = { ...reusableAudioTracks, ...state.audioTracks };
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
        if (state.semanticTimingGate.passed) delete state.timingRepairError;
        const actualDuration = state.manualDecisions ? Math.max(...state.decisions.flatMap((d) => d.clips.map((c) => c.output_end)), 0) : solution.metrics.totalTimelineDurationSec;
        state.durationGate = Editorial.durationGate(actualDuration, options.targetDurationSec, { soft: !strictTimingGate }); await persist();
        const scopeMismatch = protectScope && state.durationGate.largeDeviation;
        if (state.semanticTimingGate.passed && (!strictTimingGate || state.durationGate.passed) && !scopeMismatch) {
          if (!state.durationGate.largeDeviation) { delete state.scopeRepairError; await persist(); }
          return;
        }
        if (protectScope && state.scopeRepairError) {
          const measured = scope.assess(scopeInputs(state.speechUnits));
          const key = Editorial.fingerprint({ speechUnits: state.speechUnits, events, prefsKey, cadence: measured.wordsPerSecond });
          if (state.scopeRevisionAttempts?.[key]?.completed) return;
        }
        if (attempt === attemptLimit) {
          if (!maxAttempts || settling || !this.canSettleTiming(state.semanticTimingGate.budgets)) return;
          settling = true; attemptLimit++;
        }
        progress("duration_repair", 65, state.semanticTimingGate.passed
          ? `TTS/dựng ${state.durationGate.actual.toFixed(1)}s; đang sửa để đạt ${options.targetDurationSec}s (${attempt + 1}/${attemptLimit})...`
          : `Đang sửa ${state.semanticTimingGate.budgets.length} nhóm mệnh đề dài hơn cảnh nguồn; giữ mục tiêu ${options.targetDurationSec}s (${attempt + 1}/${attemptLimit})...`);
        const expansionList = strictTimingGate && !state.durationGate.passed ? this.multiExpansionBudgets(solution, state) : null;
        const balanced = protectScope && !scopeMismatch && !settling ? scope.balance(solution, state.durationGate) : null;
        const forceStructuralRepair = scopeMismatch || (!settling && !expansionList && !balanced && this.needsStructuralRepair(state.semanticTimingGate.budgets, state.speechUnits));
        const clauseBudgets = settling ? state.semanticTimingGate.budgets.map(group => ({ ...group,
          targetWordCount: Math.max(2, group.targetWordCount - 1) })) : balanced || expansionList || state.semanticTimingGate.budgets;
        if (balanced) progress("duration_repair", 65, "Cân bằng nội dung trước TTS: rút phần vượt cảnh và phát triển chi tiết có bằng chứng ở các đoạn còn hình hỗ trợ; giữ phạm vi câu chuyện.");
        let revised;
        try {
          revised = await ai.rewriteRecap({ storyModel, events, recapPlan: state.recapPlan, speechUnits: state.speechUnits,
            repairCache: state.clauseRepairCache ||= {}, onRepair: async (key, repair) => {
              state.clauseRepairCache[key] = repair; await persist();
            },
            options: { ...options, angle, hook, allowShotReuse: reuse }, feedback: { qualityFirst: !strictTimingGate,
              duration: strictTimingGate ? state.durationGate : { ...state.durationGate, passed: true }, measuredUnits: state.audioTracks,
              durationPreference: state.durationGate, measuredScopeMismatch: Boolean(scopeMismatch),
              unusedEventIds: scopeMismatch ? events.filter(event => !state.speechUnits.some(unit => unit.visual_event_ids.includes(event.id))).map(event => event.id) : undefined,
              forceStructuralRepair, patchOnly: forceStructuralRepair && !strictTimingGate,
              scopeGuard: protectScope ? { minimumDurationSec: options.targetDurationSec * .65 + 1,
                currentDurationSec: state.durationGate.actual, preserveSupportedStory: true } : undefined,
              forceClauseRepair: Boolean(expansionList || balanced) || settling, clauseBudgets,
              rewriteRecommendations: solution.rewriteRecommendations },
            cancelToken, onProgress: step("duration_repair") });
          delete state.timingRepairError;
        } catch (error) {
          throwIfCancelled(cancelToken);
          if (error.kind !== "timing_repair_failed") throw error;
          state.timingRepairError = error.message; await persist(); return;
        }
        let nextPlan = Editorial.groundPlan(revised.plan, events, hook); nextPlan.target_duration_sec = options.targetDurationSec;
        let nextUnits = Editorial.groundNarration(revised.speech_units, events, nextPlan, hook);
        if (protectScope) {
          const measured = scope.assess(scopeInputs(state.speechUnits));
          const check = units => scope.assess({ ...scopeInputs(units), wordsPerSecond: measured.wordsPerSecond, audioTracks: {} });
          let proposed = check(nextUnits);
          if (proposed.atRisk) {
            const key = Editorial.fingerprint({ speechUnits: state.speechUnits, events, prefsKey, cadence: measured.wordsPerSecond });
            state.scopeRevisionAttempts ||= {};
            if (!state.scopeRevisionAttempts[key]?.completed) {
              state.scopeRevisionAttempts[key] = { rejectedWords: proposed.wordCount, rejectedDurationSec: proposed.duration.actual,
                rejectedFitSec: proposed.fittedDurationSec, completed: false }; await persist();
              progress("duration_repair", 65, `Từ chối bản sửa dự kiến ${proposed.duration.actual.toFixed(0)}s; đang phân bổ lại nội dung/cảnh một lần trước khi tạo TTS mới...`);
              const corrected = await ai.rewriteRecap({ storyModel, events, recapPlan: state.recapPlan, speechUnits: state.speechUnits,
                options: { ...options, angle, hook, allowShotReuse: reuse }, feedback: { patchOnly: true, forceStructuralRepair: true,
                  qualityFirst: true, durationPreference: state.durationGate, clauseBudgets: measured.clauseBudgets,
                  scopeGuard: { minimumDurationSec: options.targetDurationSec * .65 + 1, currentDurationSec: state.durationGate.actual,
                    rejectedDurationSec: proposed.duration.actual, rejectedFitSec: proposed.fittedDurationSec, preserveSupportedStory: true },
                  unusedEventIds: events.filter(event => !state.speechUnits.some(unit => unit.visual_event_ids.includes(event.id))).map(event => event.id) },
                cancelToken, onProgress: step("duration_repair") });
              nextPlan = Editorial.groundPlan(corrected.plan, events, hook); nextPlan.target_duration_sec = options.targetDurationSec;
              nextUnits = Editorial.groundNarration(corrected.speech_units, events, nextPlan, hook);
              proposed = check(nextUnits); state.scopeRevisionAttempts[key].completed = true; await persist();
            }
            if (proposed.atRisk) {
              state.scopeRepairError = `Không nhận bản sửa dự kiến ${proposed.duration.actual.toFixed(0)}s (sau căn hình khoảng ${proposed.fittedDurationSec.toFixed(0)}s) cho mục tiêu ${options.targetDurationSec}s. Giữ kịch bản và audio trước khi rút gọn; phần hình có bằng chứng hiện là ${proposed.sourceCoverage.availableSec.toFixed(0)}s. Cần bổ sung phân tích nguồn hoặc chọn mục tiêu phù hợp.`;
              await persist(); return;
            }
          }
          delete state.scopeRepairError;
        }
        state.recapPlan = nextPlan; state.speechUnits = nextUnits;
        this.checkpointNarrativeRevision(state, events, { ...options, angle, hook, allowShotReuse: reuse }, prefsKey);
        reusableAudioTracks = { ...reusableAudioTracks, ...(state.audioTracks || {}) };
        delete state.audioTracks; delete state.manualDecisions; this.clearRender(state); await persist();
      }
    };
    const hasExistingDraft = Boolean(state.draftVideoPath && await this._fileExists(state.draftVideoPath));
    await fitTiming(hasExistingDraft ? 0 : 2);
    const blocked = async (gate) => {
      state.qualityGate = gate; state.reviewReady = false; await persist();
      await this.projectStore.updateProject(workspaceRoot, projectId, { status: "quality_blocked", finalVideoPath: "", artifacts: { finalVideoPath: "", previewVideoPath: state.draftVideoPath || "" }, statusMessage: "Chưa xuất master: draft còn lỗi cần sửa.",
        recap: { status: "quality_blocked", draftVideoPath: state.draftVideoPath, qualityScore: gate.score, qualityIssues: gate.blockers, duration: state.durationGate,
          durationAssessment: state.qualityDurationAssessment, speechUnits: state.speechUnits } });
      progress("quality_blocked", 88, gate.blockers.map((issue) => issue.description).join(" "));
      return { status: "quality_blocked", projectId, draftVideoPath: state.draftVideoPath, blockers: gate.blockers };
    };
    const timingWarnings = [];
    const reviewContext = () => ({ qualityFirst: !strictTimingGate, duration: state.durationGate, preset: options.preset });
    const assess = review => Editorial.qualityGate(review, timingWarnings, reviewContext());
    const checkTimingGates = (afterQualityRepair = false) => {
      if (state.scopeRepairError) return Editorial.qualityGate(null, [{ severity: "high", type: "source_capacity", description: state.scopeRepairError }]);
      if (!state.durationGate.passed) {
        if (!strictTimingGate && options.targetDurationSec >= 300 && state.durationGate.largeDeviation) return Editorial.qualityGate(null, [{
          severity: "high", type: "duration_deviation",
          description: `TTS thực tế chỉ đạt ${state.durationGate.actual.toFixed(1)}s cho mục tiêu ${options.targetDurationSec}s, lệch quá 35%. Chưa dựng/review thêm draft sai phạm vi; cần phát triển nội dung có giá trị hoặc điều chỉnh mục tiêu.`
        }]);
        const description = afterQualityRepair
          ? "Bản sửa review chưa đạt thời lượng."
          : `Bản kể ${state.durationGate.actual.toFixed(1)}s lệch khoảng tham chiếu ${state.durationGate.min.toFixed(1)}–${state.durationGate.max.toFixed(1)}s. AI sẽ đánh giá độ đầy đủ và nhịp kể; không kéo dài chỉ để đủ giây.`;
        if (strictTimingGate) return Editorial.qualityGate(null, [{ severity: "high", type: "duration", description }]);
        timingWarnings.push({ severity: "medium", type: "duration", description: `${description} Tiếp tục dựng draft kèm cảnh báo.` });
        onProgress({ stage: "duration_repair", percent: 70, level: "WARNING", message: `${description} Tiếp tục dựng draft kèm cảnh báo.` });
      }
      if (!state.semanticTimingGate.passed) {
        const description = afterQualityRepair
          ? "Bản sửa review chưa khớp ngân sách hình cho từng mệnh đề."
          : state.timingRepairError || "Mệnh đề vẫn dài hơn cảnh nguồn sau các lượt sửa. Chưa dựng bằng cảnh sai hoặc giữ khung hình quá lâu.";
        return Editorial.qualityGate(null, [{ severity: "high", type: "semantic_duration", description, budgets: state.semanticTimingGate.budgets }]);
      }
      return null;
    };
    const initialTimingBlock = checkTimingGates(false);
    if (initialTimingBlock) return blocked(initialTimingBlock);
    const renderDraft = async () => {
      if (state.draftVideoPath && await this._fileExists(state.draftVideoPath)) return;
      progress("draft_rendering", 77, "Đang dựng draft với khung hình và phụ đề đã chọn...");
      state.draftVideoPath = await renderer.renderDraft({ sourceVideoPath: project.sourceVideoPath, proxyVideoPath: state.proxyPath, muteSourceAudio: mute,
        presentation: options, captionDirectory: path.join(paths.analysisDir, "captions"), decisions: state.decisions,
        outputPath: path.join(paths.outputDir, `${project.id}-draft-reel.mp4`), onProgress: step("draft_rendering"), cancelToken }); await persist();
    };
    await renderDraft();
    if (!state.qualityGate?.passed) {
      let lastRepairKey;
      for (let repair = 0; repair <= 2; repair++) {
        throwIfCancelled(cancelToken); progress("quality_review", 84, `Đang kiểm tra draft thực tế (${repair + 1}/3)...`);
        let review;
        try {
          const knownDefects = repair === 0 && typeof state.qualityScore === "number" && Array.isArray(state.qualityIssues)
            && (state.qualityGate?.passed === false || state.qualityIssues.some(issue => ["high", "critical"].includes(issue.severity)));
          review = knownDefects ? { overall_score: state.qualityScore, summary: state.qualitySummary, issues: state.qualityIssues,
            duration_assessment: state.qualityDurationAssessment }
            : await ai.reviewDraft({ draftVideoPath: state.draftVideoPath, decisions: state.decisions, storyModel,
              sourceEvents: events, editorialContext: reviewContext(), cancelToken, onProgress: step("quality_review") });
          delete state.reviewError;
        }
        catch (error) {
          throwIfCancelled(cancelToken);
          state.reviewError = error.message;
          return blocked(Editorial.qualityGate(null, [{ severity: "critical", type: "review_failed", description: `Không kiểm tra được draft: ${error.message}` }]));
        }
        state.qualityScore = review.overall_score; state.qualitySummary = review.summary; state.qualityDurationAssessment = review.duration_assessment;
        state.qualityIssues = [...(review.issues || []), ...timingWarnings];
        state.reviewIteration = (state.reviewIteration || 0) + 1;
        state.qualityGate = assess(review); await persist();
        if (state.qualityGate.passed) break;
        if (state.qualityGate.score === null) return blocked(state.qualityGate);
        const repairFocus = this.qualityRepairFocus(review, state.decisions, state.speechUnits, state.qualityGate);
        const repairKey = Editorial.fingerprint({ ids: repairFocus.focusUnitIds || ["global"],
          types: [...new Set(repairFocus.issues.map(issue => issue.type))].sort() });
        if (repair === 2 || repairKey === lastRepairKey) {
          return blocked(state.qualityGate);
        }
        lastRepairKey = repairKey;
        progress("quality_repair", 86, `Đang sửa các đoạn còn lỗi và dựng lại draft (${repair + 1}/2)...`);
        try {
          const visualIssues = repairFocus.issues.filter(issue => this.isSourceIssue(issue)
            && Number.isFinite(issue.output_start) && Number.isFinite(issue.output_end));
          const blockingVisualIssues = visualIssues.filter(issue => ["high", "critical"].includes(issue.severity));
          const anchorIssues = blockingVisualIssues.length ? blockingVisualIssues : visualIssues.filter(issue => issue.severity === "medium");
          const affectedDecisions = state.decisions.filter(decision => decision.clips.some(clip => anchorIssues.some(issue =>
            clip.output_end > issue.output_start && clip.output_start < issue.output_end)));
          const suspectIds = [...new Set(affectedDecisions.flatMap(decision => blockingVisualIssues.length
            ? [...decision.clips.map(clip => clip.event_id), ...(state.speechUnits.find(unit => unit.id === decision.speech_unit_id)?.visual_event_ids || [])]
            : decision.clips.filter(clip => anchorIssues.some(issue => clip.output_end > issue.output_start && clip.output_start < issue.output_end)).map(clip => clip.event_id)))];
          if (suspectIds.length) {
            try {
              const audit = this.serviceFactories.anchorAudit?.(settings) || new AnchorAudit(settings);
              events = await audit.repair({ sourceVideoPath: project.sourceVideoPath, sourceDuration: state.sourceMeta.duration,
                events, eventIds: suspectIds, issues: anchorIssues,
                narration: state.speechUnits.map(unit => ({ id: unit.id, text: unit.text, clauses: unit.clauses })),
                scenes: state.scenes, directory: path.join(paths.analysisDir, "anchor-audit"),
                ai, signal: cancelToken?.signal, onProgress: step("anchor_audit") });
              state.visualEvents = events;
              const verified = new Map(events.map(event => [event.id, event]));
              for (const analysis of Object.values(state.chunkAnalyses || {})) analysis.events = analysis.events.map(event => verified.get(event.id) || event);
              // Resume a failed rendered-video review at its repair stage even
              // if the next paid request is interrupted. The quality gate stays
              // blocked until the corrected draft receives a fresh review.
              this.checkpointNarrativeRevision(state, events, { ...options, angle, hook, allowShotReuse: reuse }, prefsKey);
              await persist();
            } catch (auditErr) {
              throwIfCancelled(cancelToken);
              if (auditErr?.name === "AbortError") throw auditErr;
              if (blockingVisualIssues.length) return blocked(Editorial.qualityGate(review, [{ severity: "critical", type: "source_audit_failed",
                description: `Chưa xác minh được cảnh bị review lỗi nghiêm trọng: ${auditErr.message}` }]));
              onProgress({ stage: "anchor_audit", percent: 85, level: "WARNING", message: `Bỏ qua xác minh khung hình (${auditErr.message}); tiếp tục sửa lời kể...` });
            }
          }
          const qualityScopeKey = Editorial.fingerprint({ stage: "quality_repair", speechUnits: state.speechUnits, events, prefsKey,
            focus: repairFocus, blockers: state.qualityGate.blockers, score: review.overall_score });
          if (state.scopePlanningFailures?.[qualityScopeKey]) return blocked(Editorial.qualityGate(review, [{ severity: "high", type: "source_capacity",
            description: state.scopePlanningFailures[qualityScopeKey] }]));
          const revised = await ai.rewriteRecap({ storyModel, events, recapPlan: state.recapPlan, speechUnits: state.speechUnits,
            options: { ...options, angle, hook, allowShotReuse: reuse }, feedback: { qualityFirst: !strictTimingGate, patchOnly: true,
              ...repairFocus, issues: [...repairFocus.issues, ...state.qualityGate.blockers.filter(issue => !review.issues.includes(issue))],
              scopeGuard: protectScope ? { minimumDurationSec: options.targetDurationSec * .65 + 1,
                currentDurationSec: state.durationGate.actual, preserveSupportedStory: true } : undefined,
              durationPreference: state.durationGate, durationAssessment: review.duration_assessment,
              score: review.overall_score, summary: review.summary }, cancelToken, onProgress: step("quality_repair") });
          const nextPlan = Editorial.groundPlan(revised.plan, events, hook); nextPlan.target_duration_sec = options.targetDurationSec;
          const nextUnits = Editorial.groundNarration(revised.speech_units, events, nextPlan, hook);
          if (protectScope) {
            const measured = scope.assess(scopeInputs(state.speechUnits));
            const proposed = scope.assess({ ...scopeInputs(nextUnits), wordsPerSecond: measured.wordsPerSecond, audioTracks: {} });
            if (proposed.atRisk) {
              const description = `Bản sửa chất lượng dự kiến ${proposed.duration.actual.toFixed(0)}s (sau căn hình ${proposed.fittedDurationSec.toFixed(0)}s). Giữ kịch bản/audio hiện có; cần phân bổ lại cảnh trước khi tạo TTS mới.`;
              state.scopePlanningFailures ||= {}; state.scopePlanningFailures[qualityScopeKey] = description;
              return blocked(Editorial.qualityGate(review, [{ severity: "high", type: "source_capacity", description }]));
            }
          }
          state.recapPlan = nextPlan; state.speechUnits = nextUnits;
          this.checkpointNarrativeRevision(state, events, { ...options, angle, hook, allowShotReuse: reuse }, prefsKey);
          reusableAudioTracks = { ...reusableAudioTracks, ...(state.audioTracks || {}) };
          delete state.audioTracks; delete state.manualDecisions;
          const iteration = state.reviewIteration; this.clearRender(state); state.reviewIteration = iteration;
          timingWarnings.length = 0;
          await fitTiming(1);
          const postRepairTimingBlock = checkTimingGates(true);
          if (postRepairTimingBlock) return blocked(postRepairTimingBlock);
          await renderDraft();
        } catch (error) {
          throwIfCancelled(cancelToken);
          return blocked(Editorial.qualityGate(review, [{ severity: "critical", type: "repair_failed", description: `Không sửa được draft: ${error.message}` }]));
        }
      }
    }
    if (!state.qualityGate?.passed) return blocked(state.qualityGate || Editorial.qualityGate(null));
    await this.projectStore.updateProject(workspaceRoot, projectId, { status: "review_ready", statusMessage: "Draft đã đạt kiểm tra chất lượng.", finalVideoPath: "", artifacts: { finalVideoPath: "", previewVideoPath: state.draftVideoPath }, recap: { status: "review_ready", draftVideoPath: state.draftVideoPath,
      qualityScore: state.qualityScore, qualityIssues: state.qualityIssues, duration: state.durationGate,
      durationAssessment: state.qualityDurationAssessment, speechUnits: state.speechUnits } });
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
      draftVideoPath: state.draftVideoPath, finalVideoPath, decisionsCount: state.decisions.length, qualityScore: state.qualityScore, qualityIssues: state.qualityIssues, duration: state.durationGate,
      durationAssessment: state.qualityDurationAssessment, speechUnits: state.speechUnits },
      artifacts: { ...(project.artifacts || {}), previewVideoPath: state.draftVideoPath, finalVideoPath } });
    progress("completed", 100, "Đã xuất video recap.");
    return { status: "completed", projectId, finalVideoPath, draftVideoPath: state.draftVideoPath, decisions: state.decisions, metrics: state.syncMetrics, qualityIssues: state.qualityIssues };
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
