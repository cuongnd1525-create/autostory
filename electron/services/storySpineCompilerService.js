function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function number(value, fallback = NaN) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function isStorySpineScript(payload = {}) {
  const nested = payload?.revisedScript || payload?.revised_script || payload;
  return Array.isArray(nested?.narrativeBeats || nested?.narrative_beats)
    && (nested.narrativeBeats || nested.narrative_beats).length > 0;
}

function normalizeContract(script = {}) {
  const source = script.storyContract
    || script.story_contract
    || script.narrative_contract
    || script.narrativeContract
    || {};
  const climax = source.climax || {};
  const payoff = source.payoff || source.mandatoryResolution || {};
  return {
    centralViewerQuestion: text(source.centralViewerQuestion || source.primaryAudienceQuestion),
    hookPromise: text(source.hookPromise),
    primaryStoryline: text(source.primaryStoryline || source.primaryConflict),
    climax: {
      summary: text(climax.summary || climax.event || climax.description || source.climaxSummary),
      evidenceIds: list(climax.evidenceIds || source.climaxEvidenceIds),
      sourceStartSec: number(climax.sourceStartSec, null),
      sourceEndSec: number(climax.sourceEndSec, null)
    },
    payoff: {
      summary: text(payoff.summary || payoff.verifiedOutcome || payoff.description || source.payoffSummary),
      evidenceIds: list(payoff.evidenceIds || source.payoffEvidenceIds),
      sourceStartSec: number(payoff.sourceStartSec, null),
      sourceEndSec: number(payoff.sourceEndSec, null)
    },
    causalChain: list(source.causalChain || source.escalationPath)
  };
}

function intersectingScenes(manifest = {}, startSec, endSec) {
  return (Array.isArray(manifest?.scenes) ? manifest.scenes : [])
    .filter((scene) => number(scene?.endSec, -1) > startSec + 0.001
      && number(scene?.startSec, Infinity) < endSec - 0.001)
    .sort((left, right) => number(left.startSec, 0) - number(right.startSec, 0));
}

function normalizeStoryFunction(value) {
  const normalized = text(value).toLowerCase();
  const aliases = {
    hook_teaser: "hook",
    rewind: "context",
    rewind_context: "context",
    build: "escalation",
    climax_return: "climax",
    aftermath: "payoff",
    aftermath_payoff: "payoff",
    consequence: "payoff"
  };
  return aliases[normalized] || normalized;
}

function normalizeHookTriggerAudit(payload = {}, script = {}) {
  const source = payload.hookTriggerAudit
    || payload.hook_trigger_audit
    || script.hookTriggerAudit
    || script.hook_trigger_audit
    || {};
  return {
    present: Boolean(Object.keys(source).length),
    verifiedAgainstHookAuditClip: source.verifiedAgainstHookAuditClip === true
      || source.verified_against_hook_audit_clip === true,
    hookAuditFile: text(source.hookAuditFile || source.hook_audit_file),
    triggerSourceSec: number(source.triggerSourceSec ?? source.trigger_source_sec, null),
    hookInPointSec: number(source.hookInPointSec ?? source.hook_in_point_sec, null),
    triggerType: text(source.triggerType || source.trigger_type),
    exactTrigger: text(source.exactTrigger || source.exact_trigger),
    setupBeforeTriggerSec: number(source.setupBeforeTriggerSec ?? source.setup_before_trigger_sec, null),
    autoTrimApproved: source.autoTrimApproved === true || source.auto_trim_approved === true
  };
}

function normalizeTeaserClimaxAudit(payload = {}, script = {}) {
  const source = payload.teaserClimaxAudit
    || payload.teaser_climax_audit
    || script.teaserClimaxAudit
    || script.teaser_climax_audit
    || {};
  return {
    present: Boolean(Object.keys(source).length),
    teaserEventId: text(source.teaserEventId || source.teaser_event_id),
    climaxEventId: text(source.climaxEventId || source.climax_event_id),
    reprisePolicy: text(source.reprisePolicy || source.reprise_policy || "continue_after_teaser").toLowerCase(),
    climaxResumeSourceSec: number(source.climaxResumeSourceSec ?? source.climax_resume_source_sec, null),
    allowedReplaySec: Math.max(0, number(source.allowedReplaySec ?? source.allowed_replay_sec, 0.5))
  };
}

function buildTransitionCoveragePlan(beats = []) {
  const boundaries = [];
  for (let index = 1; index < beats.length; index += 1) {
    const previous = beats[index - 1];
    const current = beats[index];
    const sourceGapSec = current.sourceStartSec - previous.sourceEndSec;
    const sameSourceRun = Boolean(
      previous.sourceRunId
      && current.sourceRunId
      && previous.sourceRunId === current.sourceRunId
    );
    const nonContiguous = !sameSourceRun && Math.abs(sourceGapSec) > 0.35;
    const backward = current.sourceStartSec < previous.sourceStartSec - 0.35;
    const requiresBridge = nonContiguous || backward;
    const explainedBy = current.transitionExplainedBy;
    const voiceoverResolved = explainedBy === "voiceover"
      && current.audioMode !== "original_audio"
      && Boolean(current.voiceoverText);
    const dialogueResolved = explainedBy === "direct_dialogue" && Boolean(current.directDialogueAnchor);
    const visualResolved = explainedBy === "visual_match" && Boolean(current.visualMatchAnchor);
    const sourceContinuityResolved = !requiresBridge;
    const resolved = sourceContinuityResolved || voiceoverResolved || dialogueResolved || visualResolved;
    boundaries.push({
      boundaryId: `transition_${String(index).padStart(3, "0")}`,
      previousBeatId: previous.beatId,
      nextBeatId: current.beatId,
      sourceGapSec: Number(sourceGapSec.toFixed(3)),
      backward,
      requiresBridge,
      explainedBy: explainedBy || "none",
      visualMatchAnchor: current.visualMatchAnchor,
      directDialogueAnchor: current.directDialogueAnchor,
      resolved
    });
  }
  const required = boundaries.filter((item) => item.requiresBridge);
  const resolvedRequired = required.filter((item) => item.resolved);
  return {
    boundaries,
    requiredBoundaryCount: required.length,
    resolvedBoundaryCount: resolvedRequired.length,
    unresolvedBoundaryCount: required.length - resolvedRequired.length,
    coverageRatio: required.length ? Number((resolvedRequired.length / required.length).toFixed(3)) : 1
  };
}

function buildStoryBlueprint(contract, beats) {
  const explicitContext = beats.find((beat) => beat.storyFunction === "context");
  const contextSummary = text(explicitContext?.summary) || contract.primaryStoryline;
  return {
    centralCharacter: "",
    primaryConflict: contract.primaryStoryline,
    audienceQuestion: contract.centralViewerQuestion,
    storySpine: {
      centralViewerQuestion: contract.centralViewerQuestion,
      hookPromise: contract.hookPromise,
      rewindContext: contextSummary,
      escalationPath: beats
        .filter((beat) => beat.storyFunction === "escalation")
        .map((beat) => beat.summary || beat.advancesViewerQuestion)
        .filter(Boolean),
      climax: contract.climax.summary,
      climaxEvidenceIds: contract.climax.evidenceIds,
      payoff: contract.payoff.summary,
      payoffEvidenceIds: contract.payoff.evidenceIds,
      finalOutcomeRequired: false,
      finalOutcome: "",
      finalOutcomeEvidenceIds: []
    },
    setup: contextSummary,
    escalation: beats.filter((beat) => beat.storyFunction === "escalation").map((beat) => beat.summary).filter(Boolean).join(" "),
    climax: contract.climax.summary,
    consequence: contract.payoff.summary,
    finalPayoff: contract.payoff.summary,
    macroBlocks: beats.map((beat) => ({
      macroBlockId: beat.beatId,
      storyFunction: beat.storyFunction,
      sourceRunIds: [beat.sourceRunId].filter(Boolean),
      summary: beat.summary
    }))
  };
}

function validateCoherence(contract, beats, options = {}) {
  const errors = [];
  const warnings = [];
  [
    ["centralViewerQuestion", contract.centralViewerQuestion],
    ["hookPromise", contract.hookPromise],
    ["primaryStoryline", contract.primaryStoryline],
    ["climax.summary", contract.climax.summary],
    ["payoff.summary", contract.payoff.summary]
  ].forEach(([field, value]) => {
    if (!value) errors.push(`Story Contract thiếu ${field}.`);
  });
  if (!contract.causalChain.length) errors.push("Story Contract thiếu causalChain.");
  if (beats[0]?.storyFunction !== "hook") errors.push("Narrative Beat đầu tiên phải có storyFunction=hook.");
  for (const required of ["context", "escalation", "climax", "payoff"]) {
    if (!beats.some((beat) => beat.storyFunction === required)) {
      if (required === "context" && options.allowIntegratedContext) {
        warnings.push(
          "Narrative Beats thiếu beat context riêng; tool dùng primaryStoryline làm rewindContext và vẫn cho phép import. "
          + "Bản draft cần được review để bảo đảm Hook đã cung cấp đủ bối cảnh cho người xem mới."
        );
      } else {
        errors.push(`Narrative Beats thiếu beat ${required}.`);
      }
    }
  }
  beats.forEach((beat, index) => {
    if (index > 0 && !beat.causalLinkFromPrevious) {
      errors.push(`${beat.beatId} thiếu causalLinkFromPrevious.`);
    }
    if (!beat.advancesViewerQuestion) {
      errors.push(`${beat.beatId} chưa nêu cách beat này tiến gần câu trả lời trung tâm.`);
    }
  });
  const climaxIndexes = beats
    .map((beat, index) => beat.storyFunction === "climax" ? index : -1)
    .filter((index) => index >= 0);
  const payoffIndexes = beats
    .map((beat, index) => beat.storyFunction === "payoff" ? index : -1)
    .filter((index) => index >= 0);
  const firstPayoffIndex = payoffIndexes[0] ?? -1;
  const lastClimaxIndex = climaxIndexes.at(-1) ?? -1;
  if (lastClimaxIndex >= 0 && firstPayoffIndex >= 0 && firstPayoffIndex < lastClimaxIndex) {
    errors.push("Payoff đang xuất hiện trước Climax.");
  }
  const contractMatchesBeat = (contractEvent, beat) => {
    if (!beat) return false;
    const evidenceMatch = contractEvent.evidenceIds.length
      && contractEvent.evidenceIds.some((evidenceId) => beat.evidenceIds.includes(evidenceId));
    const rangeMatch = Number.isFinite(contractEvent.sourceStartSec)
      && Number.isFinite(contractEvent.sourceEndSec)
      && beat.sourceStartSec < contractEvent.sourceEndSec - 0.001
      && beat.sourceEndSec > contractEvent.sourceStartSec + 0.001;
    return Boolean(evidenceMatch || rangeMatch);
  };
  if (climaxIndexes.length && !climaxIndexes.some((index) => contractMatchesBeat(contract.climax, beats[index]))) {
    errors.push("Climax beat không khớp evidence/timestamp đã khóa trong Story Contract.");
  }
  if (payoffIndexes.length && !payoffIndexes.some((index) => contractMatchesBeat(contract.payoff, beats[index]))) {
    errors.push("Payoff beat không khớp evidence/timestamp đã khóa trong Story Contract.");
  }
  const unrelated = beats.filter((beat) => beat.relevanceToPrimaryStory === "weak");
  if (unrelated.length) warnings.push(`${unrelated.length} beat tự đánh dấu liên quan yếu với primaryStoryline.`);
  return { errors, warnings };
}

function enforceIndependentReviewNarrationBalance(script, beats, warnings) {
  const workflow = text(script.workflow).toLowerCase();
  const profile = text(script.prompt_profile || script.promptProfile).toLowerCase();
  if (workflow !== "manual_gemini_draft_review" || profile !== "independent") return;
  const scriptId = number(script.scriptId ?? script.script_id, 0);
  const durationOf = (beat) => Math.max(0, beat.sourceEndSec - beat.sourceStartSec) / Math.max(0.1, beat.playbackSpeed || 1);
  const totalDuration = beats.reduce((sum, beat) => sum + durationOf(beat), 0);
  if (!totalDuration) return;
  const voiceBeats = beats.filter((beat) => beat.audioMode !== "original_audio" && beat.voiceoverText);
  const currentVoiceDuration = voiceBeats.reduce((sum, beat) => sum + durationOf(beat), 0);
  const ratio = currentVoiceDuration / totalDuration;
  if (ratio > 0.85) {
    warnings.push(
      `Narration balance warning: Script ${scriptId} dùng tool voice khoảng ${Math.round(ratio * 100)}% timeline. `
      + "Tool giữ nguyên lựa chọn biên tập, nhưng nên review lại các quote, command, reaction và action sound có thể trả về original_audio."
    );
  }
}

function estimateNarrationDurationSec(value) {
  const words = text(value).split(/\s+/).filter(Boolean).length;
  return words ? words / 3.2 : 0;
}

function auditIndependentNarrationBlocks(script, beats, warnings) {
  const workflow = text(script.workflow).toLowerCase();
  const profile = text(script.prompt_profile || script.promptProfile).toLowerCase();
  if (workflow !== "manual_gemini_draft_review" || profile !== "independent") return;

  beats.forEach((beat, index) => {
    if (beat.audioMode === "original_audio" || !beat.voiceoverText) return;
    const estimatedSec = estimateNarrationDurationSec(beat.voiceoverText);
    const maxSec = beat.sourceNarratorDetected ? 10 : 8;
    if (estimatedSec > maxSec + 0.05) {
      warnings.push(
        `Narration block gate: ${beat.beatId} ước tính ${estimatedSec.toFixed(1)}s TTS, vượt giới hạn ${maxSec.toFixed(1)}s. `
        + "Gemini phải tách thành VO bridge 3-8s -> original_audio evidence -> VO bridge tùy chọn; tool không tự cắt câu vì có thể làm sai nghĩa."
      );
    }
    const previous = beats[index - 1];
    if (previous?.audioMode !== "original_audio" && previous?.voiceoverText) {
      warnings.push(
        `Narration adjacency gate: ${previous.beatId} và ${beat.beatId} đều là voiceover_only liên tiếp. `
        + "Phải chèn một original_audio beat có bằng chứng thật giữa hai đoạn narrator."
      );
    }
  });
}

function compileStorySpineScript(payload = {}, options = {}) {
  const script = payload?.revisedScript || payload?.revised_script || payload;
  const rawBeats = script.narrativeBeats || script.narrative_beats;
  if (!Array.isArray(rawBeats) || !rawBeats.length) return script;
  const videoDuration = number(options.videoDuration ?? options.manifest?.videoDurationSec, 0);
  const contract = normalizeContract(script);
  const hookTriggerAudit = normalizeHookTriggerAudit(payload, script);
  const teaserClimaxAudit = normalizeTeaserClimaxAudit(payload, script);
  const seenIds = new Set();
  const compilationWarnings = [];
  const beats = rawBeats.map((rawBeat, index) => {
    const beatId = text(rawBeat.beatId || rawBeat.beat_id) || `beat_${String(index + 1).padStart(3, "0")}`;
    if (seenIds.has(beatId)) throw new Error(`Narrative Beat trùng beatId "${beatId}".`);
    seenIds.add(beatId);
    const sourceStartSec = number(rawBeat.sourceStartSec ?? rawBeat.source_start_sec, -1);
    const sourceEndSec = number(rawBeat.sourceEndSec ?? rawBeat.source_end_sec, -1);
    if (sourceStartSec < 0 || sourceEndSec <= sourceStartSec) {
      throw new Error(`${beatId} thiếu sourceStartSec/sourceEndSec hợp lệ.`);
    }
    if (videoDuration && sourceEndSec > videoDuration + 0.5) {
      throw new Error(`${beatId} vượt thời lượng video (${sourceEndSec.toFixed(3)}s > ${videoDuration.toFixed(3)}s).`);
    }
    const scenes = intersectingScenes(options.manifest, sourceStartSec, sourceEndSec);
    if (Array.isArray(options.manifest?.scenes) && options.manifest.scenes.length && !scenes.length) {
      throw new Error(`${beatId} không giao với scene nào trong scene-manifest.json.`);
    }
    let audioMode = text(rawBeat.audioMode || rawBeat.audio_mode || "original_audio").toLowerCase();
    if (!new Set(["original_audio", "voiceover_only", "voiceover_with_ambient"]).has(audioMode)) {
      audioMode = "original_audio";
      compilationWarnings.push(`${beatId}: audioMode không được hỗ trợ; tool đã dùng original_audio.`);
    }
    let voiceoverText = text(rawBeat.voiceoverText || rawBeat.voiceover_text);
    const sourceNarratorDetected = rawBeat.sourceNarratorDetected === true || rawBeat.source_narrator_detected === true;
    if (audioMode !== "original_audio" && !voiceoverText) {
      const verifiedReplacement = text(
        rawBeat.replacementText
        || rawBeat.replacement_text
        || rawBeat.sourceNarratorText
        || rawBeat.source_narrator_text
      );
      if (sourceNarratorDetected && verifiedReplacement) {
        voiceoverText = verifiedReplacement;
        audioMode = "voiceover_only";
        compilationWarnings.push(`${beatId}: đã dùng replacementText đã xác minh để thay narrator nguồn.`);
      } else if (!sourceNarratorDetected) {
        audioMode = "original_audio";
        compilationWarnings.push(
          `${beatId}: Gemini chọn chế độ voiceover nhưng không viết voiceoverText; tool đã giữ âm thanh gốc thay vì chặn toàn bộ import.`
        );
      } else {
        throw new Error(
          `${beatId} có narrator nguồn nhưng thiếu voiceoverText/replacementText đã xác minh. `
          + "Không thể giữ âm gốc vì sẽ làm lọt narrator nguồn."
        );
      }
    }
    if (audioMode === "original_audio" && voiceoverText) {
      if (sourceNarratorDetected) {
        audioMode = "voiceover_only";
        compilationWarnings.push(
          `${beatId}: nguồn có narrator ngoài; tool giữ voiceoverText, chuyển sang voiceover_only và tắt hoàn toàn âm nguồn.`
        );
      } else {
        voiceoverText = "";
        compilationWarnings.push(
          `${beatId}: Gemini ghi original_audio nhưng chèn thừa voiceoverText; tool đã bỏ phần narrator để giữ nguyên âm thanh hiện trường.`
        );
      }
    }
    if (sourceNarratorDetected && audioMode === "voiceover_with_ambient") {
      audioMode = "voiceover_only";
      compilationWarnings.push(
        `${beatId}: nguồn có narrator ngoài nên tool đã đổi voiceover_with_ambient thành voiceover_only để không lẫn hai giọng.`
      );
    }
    const storyFunction = normalizeStoryFunction(rawBeat.storyFunction || rawBeat.story_function || rawBeat.narrativePurpose);
    return {
      beatId,
      storyFunction,
      narrativePurpose: text(rawBeat.narrativePurpose || rawBeat.narrative_purpose || storyFunction),
      summary: text(rawBeat.summary || rawBeat.beatSummary || rawBeat.storyMeaning),
      advancesViewerQuestion: text(rawBeat.advancesViewerQuestion || rawBeat.advances_viewer_question),
      causalLinkFromPrevious: index === 0
        ? text(rawBeat.causalLinkFromPrevious || rawBeat.causal_link_from_previous || "opening promise")
        : text(rawBeat.causalLinkFromPrevious || rawBeat.causal_link_from_previous),
      relevanceToPrimaryStory: text(rawBeat.relevanceToPrimaryStory || rawBeat.relevance_to_primary_story || "strong").toLowerCase(),
      sourceStartSec,
      sourceEndSec,
      playbackSpeed: Math.max(0.25, Math.min(4, number(rawBeat.playbackSpeed ?? rawBeat.playback_speed, 1))),
      audioMode,
      voiceoverText,
      sourceAmbientVolume: Math.max(0.1, Math.min(0.2, number(
        rawBeat.sourceAmbientVolume ?? rawBeat.source_ambient_volume,
        0.15
      ))),
      evidenceIds: list(rawBeat.evidenceIds || rawBeat.evidence_ids || [rawBeat.evidenceId || rawBeat.evidence_id]),
      sceneIds: scenes.map((scene) => text(scene.sceneId)).filter(Boolean),
      sourceRunId: text(rawBeat.sourceRunId || rawBeat.source_run_id),
      actionSequenceId: text(rawBeat.actionSequenceId || rawBeat.action_sequence_id),
      teaserEventId: text(rawBeat.teaserEventId || rawBeat.teaser_event_id),
      climaxEventId: text(rawBeat.climaxEventId || rawBeat.climax_event_id),
      reprisePolicy: text(rawBeat.reprisePolicy || rawBeat.reprise_policy),
      climaxResumeSourceSec: number(rawBeat.climaxResumeSourceSec ?? rawBeat.climax_resume_source_sec, null),
      transitionExplainedBy: text(rawBeat.transitionExplainedBy || rawBeat.transition_explained_by).toLowerCase(),
      bridgePurpose: text(rawBeat.bridgePurpose || rawBeat.bridge_purpose),
      visualMatchAnchor: text(rawBeat.visualMatchAnchor || rawBeat.visual_match_anchor),
      directDialogueAnchor: text(rawBeat.directDialogueAnchor || rawBeat.direct_dialogue_anchor),
      sourceNarratorDetected,
      previewVi: text(rawBeat.previewVi || rawBeat.preview_vi),
      actionNotes: text(rawBeat.actionNotes || rawBeat.action_notes),
      caption: text(rawBeat.caption)
    };
  });
  const compiledDurationSec = beats.reduce(
    (sum, beat) => sum + Math.max(0, beat.sourceEndSec - beat.sourceStartSec) / Math.max(0.25, beat.playbackSpeed || 1),
    0
  );
  const maxDurationSec = number(options.maxDurationSec, 0);
  if (maxDurationSec > 0 && compiledDurationSec > maxDurationSec + 0.05) {
    throw new Error(
      `Kịch bản dài ${compiledDurationSec.toFixed(1)}s, vượt giới hạn user đã đặt ${maxDurationSec.toFixed(1)}s. `
      + "Gemini phải bỏ dead air/beat phụ và trả lại timeline nằm trong giới hạn; tool không tự cắt giữa câu thoại hoặc cao trào."
    );
  }
  const firstHook = beats.find((beat) => beat.storyFunction === "hook");
  if (firstHook && hookTriggerAudit.present) {
    const triggerSourceSec = hookTriggerAudit.triggerSourceSec;
    const requestedInPoint = Number.isFinite(hookTriggerAudit.hookInPointSec)
      ? hookTriggerAudit.hookInPointSec
      : Number.isFinite(triggerSourceSec) ? triggerSourceSec - 0.35 : null;
    const triggerInsideHook = Number.isFinite(triggerSourceSec)
      && triggerSourceSec >= firstHook.sourceStartSec - 0.05
      && triggerSourceSec <= firstHook.sourceEndSec + 0.05;
    if (!hookTriggerAudit.verifiedAgainstHookAuditClip || !triggerInsideHook) {
      compilationWarnings.push(
        "Hook Trigger Audit chưa đủ bằng chứng clip hoặc trigger nằm ngoài Hook; tool không tự trim sourceStartSec."
      );
    } else {
      const measuredSetupSec = Math.max(0, triggerSourceSec - firstHook.sourceStartSec);
      hookTriggerAudit.setupBeforeTriggerSec = Number(measuredSetupSec.toFixed(3));
      if (measuredSetupSec > 0.5 && hookTriggerAudit.autoTrimApproved && Number.isFinite(requestedInPoint)) {
        const safeInPoint = Math.max(firstHook.sourceStartSec, Math.min(triggerSourceSec, requestedInPoint));
        firstHook.sourceStartSec = Number(safeInPoint.toFixed(3));
        firstHook.sceneIds = intersectingScenes(options.manifest, firstHook.sourceStartSec, firstHook.sourceEndSec)
          .map((scene) => text(scene.sceneId))
          .filter(Boolean);
        hookTriggerAudit.hookInPointSec = firstHook.sourceStartSec;
        hookTriggerAudit.setupBeforeTriggerSec = Number((triggerSourceSec - firstHook.sourceStartSec).toFixed(3));
        compilationWarnings.push(
          `Hook Trigger Gate đã trim Hook đến ${firstHook.sourceStartSec.toFixed(3)}s; còn ${hookTriggerAudit.setupBeforeTriggerSec.toFixed(3)}s trước trigger.`
        );
      } else if (measuredSetupSec > 0.5) {
        compilationWarnings.push(
          `Hook Trigger Gate: Hook còn ${measuredSetupSec.toFixed(3)}s setup trước trigger; nên rebuild hoặc cho phép auto trim.`
        );
      }
    }
  }
  const transitionCoveragePlan = buildTransitionCoveragePlan(beats);
  if (transitionCoveragePlan.unresolvedBoundaryCount) {
    compilationWarnings.push(
      `Transition Coverage Gate: ${transitionCoveragePlan.unresolvedBoundaryCount}/${transitionCoveragePlan.requiredBoundaryCount} cú nhảy nguồn chưa có voiceover, direct-dialogue anchor hoặc visual-match anchor hợp lệ.`
    );
  }
  const hookBeats = beats.filter((beat) => beat.storyFunction === "hook");
  const climaxBeats = beats.filter((beat) => beat.storyFunction === "climax");
  const hookClimaxOverlapSec = hookBeats.reduce((sum, hookBeat) => sum + climaxBeats.reduce((inner, climaxBeat) => (
    inner + Math.max(0, Math.min(hookBeat.sourceEndSec, climaxBeat.sourceEndSec)
      - Math.max(hookBeat.sourceStartSec, climaxBeat.sourceStartSec))
  ), 0), 0);
  const semanticEventRepeated = Boolean(
    teaserClimaxAudit.teaserEventId
    && teaserClimaxAudit.climaxEventId
    && teaserClimaxAudit.teaserEventId === teaserClimaxAudit.climaxEventId
  );
  const teaserClimaxHandoff = {
    ...teaserClimaxAudit,
    hookClimaxOverlapSec: Number(hookClimaxOverlapSec.toFixed(3)),
    semanticEventRepeated,
    passed: hookClimaxOverlapSec <= teaserClimaxAudit.allowedReplaySec + 0.001
      && (!semanticEventRepeated || teaserClimaxAudit.reprisePolicy === "continue_after_teaser")
  };
  if (!teaserClimaxHandoff.passed) {
    compilationWarnings.push(
      "Teaser-Climax Handoff chưa đạt: Climax đang lặp lại Hook quá mức hoặc chưa dùng reprisePolicy=continue_after_teaser."
    );
  }
  enforceIndependentReviewNarrationBalance(script, beats, compilationWarnings);
  auditIndependentNarrationBlocks(script, beats, compilationWarnings);
  const allowIntegratedContext = text(script.workflow).toLowerCase() === "manual_gemini_draft_review"
    && text(script.prompt_profile || script.promptProfile).toLowerCase() === "independent";
  const coherence = validateCoherence(contract, beats, { allowIntegratedContext });
  if (coherence.errors.length) {
    throw new Error(`Story Spine chưa đạt coherence gate: ${coherence.errors.join(" ")}`);
  }
  const segments = beats.map((beat, index) => ({
    id: `highlight_${String(index + 1).padStart(4, "0")}`,
    segmentId: `highlight_${String(index + 1).padStart(4, "0")}`,
    evidenceId: beat.evidenceIds[0] || "",
    evidenceIds: beat.evidenceIds,
    sceneId: beat.sceneIds[0] || "",
    sceneIds: beat.sceneIds,
    sourceRunId: beat.sourceRunId || `story_run_${String(index + 1).padStart(3, "0")}`,
    macroBlockId: beat.beatId,
    sourceStartSec: Number(beat.sourceStartSec.toFixed(3)),
    sourceEndSec: Number(beat.sourceEndSec.toFixed(3)),
    playbackSpeed: beat.playbackSpeed,
    scene_type: beat.storyFunction,
    storyFunction: beat.storyFunction,
    narrativePurpose: beat.narrativePurpose,
    narrationBeatId: beat.audioMode !== "original_audio" ? beat.beatId : "",
    transitionReason: beat.causalLinkFromPrevious,
    transitionExplainedBy: beat.transitionExplainedBy
      || (beat.audioMode !== "original_audio" ? "voiceover" : "none"),
    bridgePurpose: beat.bridgePurpose,
    visualMatchAnchor: beat.visualMatchAnchor,
    directDialogueAnchor: beat.directDialogueAnchor,
    actionSequenceId: beat.actionSequenceId,
    teaserEventId: beat.teaserEventId,
    climaxEventId: beat.climaxEventId,
    reprisePolicy: beat.reprisePolicy,
    climaxResumeSourceSec: beat.climaxResumeSourceSec,
    completeNarrativeBeat: true,
    sustainedBeatId: beat.beatId,
    audio_mode: beat.audioMode,
    voiceover_text: beat.voiceoverText,
    source_ambient_volume: beat.sourceAmbientVolume,
    source_narrator_detected: beat.sourceNarratorDetected,
    preview_vi: beat.previewVi,
    action_notes: beat.actionNotes,
    caption: beat.caption
  }));
  const storyBlueprint = buildStoryBlueprint(contract, beats);
  return {
    ...script,
    reviewDecision: text(payload.reviewDecision || payload.review_decision || script.reviewDecision || script.review_decision),
    hookReplacementAudit: payload.hookReplacementAudit || payload.hook_replacement_audit || script.hookReplacementAudit || script.hook_replacement_audit || null,
    viralMomentInventory: payload.viralMomentInventory || payload.viral_moment_inventory || script.viralMomentInventory || script.viral_moment_inventory || null,
    hookTournamentAudit: payload.hookTournamentAudit || payload.hook_tournament_audit || script.hookTournamentAudit || script.hook_tournament_audit || null,
    inputAccessAudit: payload.inputAccessAudit || payload.input_access_audit || script.inputAccessAudit || script.input_access_audit || null,
    hookTriggerAudit,
    teaserClimaxAudit: teaserClimaxHandoff,
    transitionCoveragePlan,
    artifactType: "highlight_cut_script",
    schemaVersion: Math.max(2, number(script.schemaVersion, 2)),
    story_spine_compiled: true,
    storyContract: contract,
    story_contract: contract,
    narrative_contract: {
      hookPromise: contract.hookPromise,
      primaryAudienceQuestion: contract.centralViewerQuestion,
      primaryStoryline: contract.primaryStoryline,
      mandatoryResolution: {
        required: true,
        evidenceIds: contract.payoff.evidenceIds,
        verifiedOutcome: contract.payoff.summary
      }
    },
    story_blueprint: storyBlueprint,
    narration_arc: script.narrationArc || script.narration_arc || null,
    narrativeBeats: beats,
    storyCompiler: {
      version: 2,
      coherencePassed: true,
      warnings: [...coherence.warnings, ...compilationWarnings],
      logicalBeatCount: beats.length,
      technicalSceneCount: new Set(beats.flatMap((beat) => beat.sceneIds)).size
    },
    _toolValidationWarnings: [
      ...(Array.isArray(script._toolValidationWarnings) ? script._toolValidationWarnings : []),
      ...coherence.warnings,
      ...compilationWarnings,
      `Story Spine Compiler đã biên dịch ${beats.length} Narrative Beat thành timeline kỹ thuật; sceneId chỉ dùng để kiểm chứng nguồn.`
    ],
    segments
  };
}

module.exports = {
  auditIndependentNarrationBlocks,
  buildTransitionCoveragePlan,
  compileStorySpineScript,
  enforceIndependentReviewNarrationBalance,
  isStorySpineScript,
  normalizeContract,
  normalizeHookTriggerAudit,
  normalizeTeaserClimaxAudit,
  validateCoherence
};
