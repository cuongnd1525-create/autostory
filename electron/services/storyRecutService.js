function text(value) {
  return String(value || "").trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function storyRole(segment = {}, evidence = {}) {
  return text(
    segment.storyFunction
    || segment.story_function
    || segment.narrativeRole
    || segment.narrative_role
    || segment.scene_type
    || evidence.narrativePhase
  ).toLowerCase();
}

function scoreStoryRecutVariant({
  script = {},
  normalizedScript = {},
  evidencePayload = null
} = {}) {
  const segments = Array.isArray(normalizedScript.segments) ? normalizedScript.segments : [];
  const rawSegments = Array.isArray(script.segments) ? script.segments : [];
  const evidenceById = new Map(
    (evidencePayload?.evidence || []).map((item) => [text(item.evidenceId), item])
  );
  if (!segments.length) {
    return {
      score: 0,
      grade: "D",
      passed: false,
      issues: ["Story Recut không có segment."],
      strengths: [],
      diagnostics: {},
      metrics: { workflow: "story_recut" }
    };
  }

  const issues = [];
  const strengths = [];
  let score = 100;
  const durationSec = number(normalizedScript.totalDuration);
  const durationWithinProfile = durationSec >= 60;
  const originalAudioDurationSec = segments
    .filter((segment) => segment.audioMode === "original_audio")
    .reduce((sum, segment) => sum + number(segment.duration), 0);
  const originalAudioRatio = durationSec > 0 ? originalAudioDurationSec / durationSec : 0;
  const nonOriginalAudioSegments = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.audioMode !== "original_audio");
  const shortFragments = segments.filter((segment, index) => {
    if (number(segment.duration) >= 4) return false;
    const previous = segments[index - 1];
    const next = segments[index + 1];
    const sourceContinuesBefore = previous
      && Math.abs(number(segment.sourceStartSec) - number(previous.sourceEndSec)) <= 0.35;
    const sourceContinuesAfter = next
      && Math.abs(number(next.sourceStartSec) - number(segment.sourceEndSec)) <= 0.35;
    return !sourceContinuesBefore && !sourceContinuesAfter;
  });
  const roles = new Set(segments.map((segment, index) => (
    storyRole(rawSegments[index] || {}, evidenceById.get(text(segment.evidenceId)) || {})
  )).filter(Boolean));
  const hasHook = [...roles].some((role) => /hook|cold.open/.test(role));
  const hasContext = [...roles].some((role) => /context|setup/.test(role));
  const hasEscalation = [...roles].some((role) => /escalat|conflict|twist/.test(role));
  const hasClimax = [...roles].some((role) => /climax|peak/.test(role));
  const hasEnding = [...roles].some((role) => /consequence|resolution|aftermath|payoff|outro/.test(role));
  const macroBlockIds = [...new Set(rawSegments.map((segment, index) => (
    text(segment.macroBlockId || segment.macro_block_id)
    || `unassigned_${index + 1}`
  )))];
  const sourceJumps = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (Math.abs(number(current.sourceStartSec) - number(previous.sourceEndSec)) > 0.35) {
      sourceJumps.push({
        fromSegment: index,
        toSegment: index + 1,
        gapSec: Number(Math.abs(number(current.sourceStartSec) - number(previous.sourceEndSec)).toFixed(3))
      });
    }
  }
  const missingTransitionSegments = rawSegments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment, index }) => index > 0 && !text(segment.transitionReason || segment.transition_reason))
    .map(({ index }) => index + 1);
  const unsafeEvidenceSegments = segments
    .map((segment, index) => ({
      segment: index + 1,
      evidence: evidenceById.get(text(segment.evidenceId))
    }))
    .filter(({ evidence }) => evidence && (evidence.completeBeat === false || text(evidence.cutSafety).toLowerCase() === "unsafe"))
    .map(({ segment }) => segment);
  const duplicateEvidence = [];
  const evidenceUsage = new Map();
  segments.forEach((segment, index) => {
    const evidenceId = text(segment.evidenceId);
    if (!evidenceId) return;
    const previous = evidenceUsage.get(evidenceId);
    if (previous !== undefined) duplicateEvidence.push({ evidenceId, firstSegment: previous + 1, repeatedSegment: index + 1 });
    evidenceUsage.set(evidenceId, index);
  });
  const macroBlocks = new Map();
  segments.forEach((segment, index) => {
    const raw = rawSegments[index] || {};
    const id = text(raw.macroBlockId || raw.macro_block_id) || `unassigned_${index + 1}`;
    const item = macroBlocks.get(id) || { macroBlockId: id, durationSec: 0, segments: [], sourceRunIds: new Set() };
    item.durationSec += number(segment.duration);
    item.segments.push(index + 1);
    if (segment.sourceRunId) item.sourceRunIds.add(segment.sourceRunId);
    macroBlocks.set(id, item);
  });
  const weakMacroBlocks = [...macroBlocks.values()]
    .filter((block, index) => index > 0 && block.durationSec < 8)
    .map((block) => ({
      macroBlockId: block.macroBlockId,
      durationSec: Number(block.durationSec.toFixed(3)),
      segments: block.segments
    }));
  const fragmentedMacroBlocks = [...macroBlocks.values()]
    .filter((block) => block.sourceRunIds.size > 2)
    .map((block) => ({
      macroBlockId: block.macroBlockId,
      sourceRunCount: block.sourceRunIds.size,
      segments: block.segments
    }));
  const first = segments[0];
  const firstEvidence = evidenceById.get(text(first.evidenceId)) || {};
  const hookScore = number(firstEvidence.hookScore, number(firstEvidence.viralScore, 0));
  const hookDurationSec = number(first.duration);

  if (text(script.mode).toLowerCase() !== "story_recut") {
    score -= 8;
    issues.push('JSON phải khai báo "mode": "story_recut".');
  }
  if (!durationWithinProfile) {
    score -= 30;
    issues.push(`Thời lượng ${durationSec.toFixed(1)}s chưa đạt mức tối thiểu 60s của Story Recut.`);
  }
  if (first.audioMode !== "original_audio") {
    score -= 14;
    issues.push("Hook phải dùng original_audio để giữ cú mở đầu chân thực.");
  }
  if (hookDurationSec < 5) {
    score -= 7;
    issues.push(`Hook chỉ dài ${hookDurationSec.toFixed(1)}s; cần ít nhất 5s và phải giữ trọn beat.`);
  }
  if (hookScore && hookScore < 8) {
    score -= 10;
    issues.push(`Hook evidence chỉ đạt ${hookScore.toFixed(1)}/10; cần chọn ứng viên hook mạnh hơn.`);
  }
  if (!script.story_blueprint && !script.storyBlueprint) {
    score -= 12;
    issues.push("Thiếu story_blueprint nên chưa chứng minh được mạch kể trước khi đảo macro-block.");
  }
  if (macroBlockIds.length < 3) {
    score -= 10;
    issues.push(`Chỉ có ${macroBlockIds.length} macro-block; Story Recut cần ít nhất 3 khối để hình thành Hook, thân truyện và payoff.`);
  }
  if (!(hasHook && hasContext && hasEscalation && hasClimax && hasEnding)) {
    score -= 14;
    issues.push("Mạch truyện chưa đủ Hook → Context → Escalation → Climax → Consequence/Payoff.");
  }
  if (sourceJumps.length > 4) {
    score -= Math.min(24, (sourceJumps.length - 4) * 6);
    issues.push(`Có ${sourceJumps.length} lần nhảy xa trên timeline nguồn; giới hạn Story Recut là 4.`);
  }
  if (shortFragments.length > Math.max(1, Math.floor(segments.length * 0.2))) {
    score -= 12;
    issues.push(`${shortFragments.length}/${segments.length} segment ngắn dưới 4s và đứng cô lập khỏi mạch nguồn; bản dựng có nguy cơ bị băm vụn.`);
  }
  if (weakMacroBlocks.length) {
    score -= Math.min(15, weakMacroBlocks.length * 5);
    issues.push(`${weakMacroBlocks.length} macro-block (không tính Hook) ngắn dưới 8s.`);
  }
  if (fragmentedMacroBlocks.length) {
    score -= Math.min(18, fragmentedMacroBlocks.length * 6);
    issues.push(`${fragmentedMacroBlocks.length} macro-block trộn quá hai sourceRun; cần giữ khối nguồn liền mạch hơn.`);
  }
  if (originalAudioRatio < 0.999 || nonOriginalAudioSegments.length) {
    score -= 24;
    issues.push(`Âm thanh gốc chỉ chiếm ${Math.round(originalAudioRatio * 100)}%; Story Recut yêu cầu 100% âm thanh nguồn và không tạo TTS.`);
  } else {
    strengths.push("Toàn bộ video dùng âm thanh nguyên bản của các đoạn nguồn.");
  }
  if (missingTransitionSegments.length) {
    score -= Math.min(12, missingTransitionSegments.length * 2);
    issues.push(`Thiếu transitionReason ở segment ${missingTransitionSegments.join(", ")}.`);
  }
  if (unsafeEvidenceSegments.length) {
    score -= Math.min(15, unsafeEvidenceSegments.length * 5);
    issues.push(`Segment ${unsafeEvidenceSegments.join(", ")} cắt evidence chưa trọn beat hoặc chưa an toàn.`);
  }
  if (duplicateEvidence.length) {
    score -= Math.min(10, duplicateEvidence.length * 4);
    issues.push(`${duplicateEvidence.length} evidence bị dùng lặp lại mà không có replayPurpose rõ ràng.`);
  }

  score = Math.round(clamp(score, 0, 100));
  const grade = score >= 85 ? "A" : score >= 72 ? "B" : score >= 58 ? "C" : "D";
  return {
    score,
    grade,
    passed: score >= 72
      && durationSec >= 60
      && originalAudioRatio >= 0.999
      && nonOriginalAudioSegments.length === 0,
    issues,
    strengths,
    diagnostics: {
      sourceJumps,
      shortFragments: shortFragments.map((segment) => ({
        segment: number(segment.index, segments.indexOf(segment)) + 1,
        durationSec: number(segment.duration),
        evidenceId: text(segment.evidenceId)
      })),
      nonOriginalAudioSegments: nonOriginalAudioSegments.map(({ segment, index }) => ({
        segment: index + 1,
        audioMode: text(segment.audioMode),
        durationSec: number(segment.duration),
        evidenceId: text(segment.evidenceId),
        requiredFix: 'Đổi audio_mode thành "original_audio" và để voiceover_text rỗng.'
      })),
      weakMacroBlocks,
      fragmentedMacroBlocks,
      missingTransitionSegments,
      unsafeEvidenceSegments,
      duplicateEvidence
    },
    metrics: {
      workflow: "story_recut",
      durationSec: Number(durationSec.toFixed(3)),
      durationWithinProfile,
      monetizationEligible: durationSec >= 60,
      hookDurationSec: Number(hookDurationSec.toFixed(3)),
      hookScore: Number(hookScore.toFixed(2)),
      originalAudioRatio: Number(originalAudioRatio.toFixed(3)),
      voiceoverCount: nonOriginalAudioSegments.length,
      nonOriginalAudioCount: nonOriginalAudioSegments.length,
      sourceJumpCount: sourceJumps.length,
      maxSourceJumps: 4,
      macroBlockCount: macroBlockIds.length,
      minMacroBlocks: 3,
      maxMacroBlocks: null,
      hasStoryBlueprint: Boolean(script.story_blueprint || script.storyBlueprint),
      shortFragmentCount: shortFragments.length,
      unsafeEvidenceCount: unsafeEvidenceSegments.length
    }
  };
}

function joinDistinctText(values = []) {
  const seen = new Set();
  return values
    .map((value) => text(value))
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function consolidateStoryRecutSegments(segments = [], options = {}) {
  const maxSourceGapSec = Math.max(0, number(options.maxSourceGapSec, 4));
  const groups = [];

  segments.forEach((segment, sourceIndex) => {
    const sourceStartSec = number(segment.sourceStartSec);
    const sourceEndSec = number(segment.sourceEndSec);
    const macroBlockId = text(segment.macroBlockId);
    const sourceRunId = text(segment.sourceRunId);
    const evidenceIds = Array.isArray(segment.evidenceIds)
      ? segment.evidenceIds.map(text).filter(Boolean)
      : [text(segment.evidenceId)].filter(Boolean);
    const sceneIds = Array.isArray(segment.sceneIds)
      ? segment.sceneIds.map(text).filter(Boolean)
      : [text(segment.sceneId)].filter(Boolean);
    const member = {
      index: sourceIndex,
      id: text(segment.id),
      evidenceId: text(segment.evidenceId),
      sceneId: text(segment.sceneId),
      sourceStartSec,
      sourceEndSec
    };
    const previous = groups.at(-1);
    const sourceGapSec = previous ? sourceStartSec - previous.sourceEndSec : Number.POSITIVE_INFINITY;
    const canMerge = Boolean(
      previous
      && macroBlockId
      && sourceRunId
      && previous.macroBlockId === macroBlockId
      && previous.sourceRunId === sourceRunId
      && sourceGapSec >= -0.12
      && sourceGapSec <= maxSourceGapSec
      && previous.audioMode === "original_audio"
      && segment.audioMode === "original_audio"
      && !previous.voiceoverText
      && !segment.voiceoverText
    );

    if (!canMerge) {
      groups.push({
        ...segment,
        sourceStartSec,
        sourceEndSec,
        sourceDuration: sourceEndSec - sourceStartSec,
        playbackSpeed: 1,
        evidenceIds,
        sceneIds,
        technicalSegments: [member],
        filledSourceGapSec: 0
      });
      return;
    }

    previous.sourceEndSec = Math.max(previous.sourceEndSec, sourceEndSec);
    previous.sourceDuration = previous.sourceEndSec - previous.sourceStartSec;
    previous.playbackSpeed = 1;
    previous.evidenceIds = [...new Set([...previous.evidenceIds, ...evidenceIds])];
    previous.sceneIds = [...new Set([...previous.sceneIds, ...sceneIds])];
    previous.technicalSegments.push(member);
    previous.filledSourceGapSec += Math.max(0, sourceGapSec);
    previous.id = `${previous.technicalSegments[0].id || "recut"}__${member.id || `segment_${sourceIndex + 1}`}`;
    previous.text = joinDistinctText([previous.text, segment.text]);
    previous.previewSubtitleVi = joinDistinctText([previous.previewSubtitleVi, segment.previewSubtitleVi]);
    previous.previewVi = previous.previewSubtitleVi;
    previous.caption = joinDistinctText([previous.caption, segment.caption]);
    previous.translatedText = joinDistinctText([previous.translatedText, segment.translatedText]);
    previous.originalText = joinDistinctText([previous.originalText, segment.originalText]);
    previous.actionNotes = joinDistinctText([previous.actionNotes, segment.actionNotes]);
    if (previous.storyFunction !== segment.storyFunction) {
      previous.storyFunctions = [...new Set([
        ...(previous.storyFunctions || [previous.storyFunction]),
        segment.storyFunction
      ].map(text).filter(Boolean))];
    }
  });

  let outputCursor = 0;
  return groups.map((segment, index) => {
    const duration = Math.max(0.3, number(segment.sourceEndSec) - number(segment.sourceStartSec));
    const startSec = outputCursor;
    const endSec = startSec + duration;
    outputCursor = endSec;
    return {
      ...segment,
      index,
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      sourceDuration: Number(duration.toFixed(3)),
      filledSourceGapSec: Number(number(segment.filledSourceGapSec).toFixed(3))
    };
  });
}

module.exports = {
  consolidateStoryRecutSegments,
  scoreStoryRecutVariant
};
