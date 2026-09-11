const fs = require("fs/promises");
const path = require("path");

const FfmpegService = require("./ffmpegService");
const SubtitleService = require("./subtitleService");
const { parseGeminiJsonObject } = require("./geminiJsonArtifactService");
const {
  CANDIDATE_ARTIFACT_TYPE,
  ARTIFACT_TYPE,
  buildCompactDialogueParts,
  buildDialogueUnits,
  parseSrt,
  validateAccessAudit
} = require("./podcastViralService");

const MAX_CANDIDATES = 15;
const MAX_CANDIDATE_SEC = 180;
const MAX_CANDIDATE_SPANS = 8;
const MIN_SPAN_SEC = 0.3;
const MAX_REEL_SEC = 540;
const MAX_UPLOAD_FILES = 10;

function safeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

async function exists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

async function writeJson(filePath, payload, pretty = true) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, pretty ? 2 : 0), "utf8");
}

function isVisualMomentRole(role) {
  return /visual|physical|action|transformation/i.test(safeText(role));
}

function isPayoffMomentRole(role) {
  return /payoff|reveal|reaction|result|conclusion|outro|physical_action|dialogue_payoff/i.test(safeText(role));
}

function spansOverlap(left, right) {
  return left.sourceStartSec < right.sourceEndSec - 0.05
    && left.sourceEndSec > right.sourceStartSec + 0.05;
}

function candidateContainsRange(candidate, startSec, endSec) {
  return (candidate.sourceSpans || []).some((span) => (
    startSec >= span.sourceStartSec - 0.05 && endSec <= span.sourceEndSec + 0.05
  ));
}

function unitOverlapsCandidate(unit, candidate) {
  return (candidate.sourceSpans || []).some((span) => (
    unit.sourceStartSec < span.sourceEndSec && unit.sourceEndSec > span.sourceStartSec
  ));
}

function normalizeCandidateSpans(candidate, candidateId, sourceDuration) {
  const supplied = Array.isArray(candidate.sourceSpans) && candidate.sourceSpans.length
    ? candidate.sourceSpans
    : [{
      spanId: `${candidateId}_span_01`,
      editorialRole: "story",
      sourceStartSec: candidate.sourceStartSec,
      sourceEndSec: candidate.sourceEndSec
    }];
  if (supplied.length > MAX_CANDIDATE_SPANS) {
    throw new Error(`${candidateId}: có ${supplied.length} sourceSpans; tool nhận tối đa ${MAX_CANDIDATE_SPANS}.`);
  }
  const spanIds = new Set();
  const spans = supplied.map((span, spanIndex) => {
    const spanId = safeText(span.spanId || `${candidateId}_span_${String(spanIndex + 1).padStart(2, "0")}`);
    const sourceStartSec = Number(span.sourceStartSec);
    const sourceEndSec = Number(span.sourceEndSec);
    if (!/^[a-z0-9_-]+$/i.test(spanId) || spanIds.has(spanId)) {
      throw new Error(`${candidateId}: spanId "${spanId}" không hợp lệ hoặc bị trùng.`);
    }
    spanIds.add(spanId);
    if (
      !Number.isFinite(sourceStartSec)
      || !Number.isFinite(sourceEndSec)
      || sourceStartSec < 0
      || sourceEndSec > sourceDuration + 0.05
      || sourceEndSec - sourceStartSec < MIN_SPAN_SEC
      || sourceEndSec - sourceStartSec > MAX_CANDIDATE_SEC
    ) {
      throw new Error(
        `${candidateId}/${spanId}: khoảng nguồn ${sourceStartSec}-${sourceEndSec}s không hợp lệ; `
        + `mỗi span phải dài ${MIN_SPAN_SEC}-${MAX_CANDIDATE_SEC}s và nằm trong video.`
      );
    }
    return {
      spanId,
      editorialRole: safeText(span.editorialRole || span.role || "story"),
      sourceStartSec: round(sourceStartSec),
      sourceEndSec: round(sourceEndSec),
      durationSec: round(sourceEndSec - sourceStartSec),
      transcriptAnchor: safeText(span.transcriptAnchor),
      visualAnchor: safeText(span.visualAnchor)
    };
  }).sort((left, right) => left.sourceStartSec - right.sourceStartSec);
  for (let index = 1; index < spans.length; index += 1) {
    if (spansOverlap(spans[index - 1], spans[index])) {
      throw new Error(`${candidateId}: sourceSpans "${spans[index - 1].spanId}" và "${spans[index].spanId}" bị chồng lấn.`);
    }
  }
  const totalDuration = spans.reduce((sum, span) => sum + span.durationSec, 0);
  if (totalDuration < 3 || totalDuration > MAX_CANDIDATE_SEC) {
    throw new Error(
      `${candidateId}: tổng thời lượng sourceSpans là ${round(totalDuration)}s; `
      + `mỗi ứng viên phải chứa tổng cộng 3-${MAX_CANDIDATE_SEC}s footage hữu ích.`
    );
  }
  return spans;
}

function validateCandidateMap(payload, sourceMap, expectedOutputCount, targetMinSec = 0) {
  if (safeText(payload?.artifactType) !== CANDIDATE_ARTIFACT_TYPE) {
    throw new Error(`Candidate Map phải có artifactType="${CANDIDATE_ARTIFACT_TYPE}".`);
  }
  validateAccessAudit(payload);
  if (safeText(payload.sourceMatchId) !== safeText(sourceMap.sourceMatchId)) {
    throw new Error("Candidate Map thuộc sourceMatchId khác gói Podcast hiện tại.");
  }
  const raw = Array.isArray(payload.candidates) ? payload.candidates : [];
  if (raw.length < expectedOutputCount) {
    throw new Error(`Candidate Map chỉ có ${raw.length} ứng viên; cần ít nhất ${expectedOutputCount}.`);
  }
  if (raw.length > MAX_CANDIDATES) {
    throw new Error(`Candidate Map có ${raw.length} ứng viên; tool nhận tối đa ${MAX_CANDIDATES}.`);
  }
  const usedIds = new Set();
  const warnings = [];
  const duration = Number(sourceMap.localDurationSec || 0);
  const candidates = raw.map((candidate, index) => {
    const candidateId = safeText(candidate.candidateId || `candidate_${String(index + 1).padStart(3, "0")}`);
    if (!/^candidate_[a-z0-9_-]+$/i.test(candidateId)) {
      throw new Error(`Ứng viên ${index + 1}: candidateId không hợp lệ.`);
    }
    if (usedIds.has(candidateId)) throw new Error(`candidateId "${candidateId}" bị trùng.`);
    usedIds.add(candidateId);
    const sourceSpans = normalizeCandidateSpans(candidate, candidateId, duration);
    const sourceStartSec = sourceSpans[0].sourceStartSec;
    const sourceEndSec = sourceSpans.at(-1).sourceEndSec;
    const candidateDuration = sourceSpans.reduce((sum, span) => sum + span.durationSec, 0);
    if (Number(targetMinSec) > 0 && candidateDuration + 0.05 < Number(targetMinSec)) {
      throw new Error(
        `${candidateId}: chỉ có ${round(candidateDuration)}s footage hữu ích, không đủ dựng một output tối thiểu ${Number(targetMinSec)}s. `
        + `Hãy bổ sung các sourceSpans cùng một câu chuyện; không kéo dài bằng dead air.`
      );
    }
    const sceneScore = Number(candidate.sceneScore || 0);
    if (!Number.isFinite(sceneScore) || sceneScore < 8) {
      warnings.push(`${candidateId} chỉ đạt ${Number.isFinite(sceneScore) ? sceneScore : 0}/10; vẫn giữ để user quyết định.`);
    }
    if (!safeText(candidate.hookQuote)) warnings.push(`${candidateId} thiếu hookQuote nguyên văn.`);
    if (!safeText(candidate.payoff)) warnings.push(`${candidateId} thiếu payoff cụ thể.`);
    const rawMoments = Array.isArray(candidate.mustIncludeMoments) ? candidate.mustIncludeMoments : [];
    if (!rawMoments.length) {
      throw new Error(
        `${candidateId}: thiếu mustIncludeMoments. Mọi story candidate phải khóa ít nhất một action/reveal/reaction/payoff `
        + `thực sự trả lời centralViewerQuestion; không phụ thuộc primaryTrigger.`
      );
    }
    const mustIncludeMoments = rawMoments.map((moment, momentIndex) => {
      const momentId = safeText(moment.momentId || `${candidateId}_moment_${String(momentIndex + 1).padStart(2, "0")}`);
      const momentStartSec = Number(moment.sourceStartSec);
      const momentEndSec = Number(moment.sourceEndSec);
      if (
        !/^candidate_[a-z0-9_-]+_moment_[a-z0-9_-]+$/i.test(momentId)
        || !Number.isFinite(momentStartSec)
        || !Number.isFinite(momentEndSec)
        || !candidateContainsRange({ sourceSpans }, momentStartSec, momentEndSec)
        || momentEndSec - momentStartSec < 0.3
        || momentEndSec - momentStartSec > 45
      ) {
        throw new Error(
          `${candidateId}: mustIncludeMoments[${momentIndex}] phải nằm trong candidate, dài 0.3-45s và có momentId hợp lệ.`
        );
      }
      return {
        momentId,
        role: safeText(moment.role || "visual_payoff"),
        momentType: safeText(moment.momentType || moment.role || "payoff"),
        sourceStartSec: round(momentStartSec),
        sourceEndSec: round(momentEndSec),
        durationSec: round(momentEndSec - momentStartSec),
        description: safeText(moment.description),
        verificationBasis: safeText(moment.verificationBasis || "candidate_reel_required")
      };
    });
    if (!mustIncludeMoments.some((moment) => isPayoffMomentRole(`${moment.role} ${moment.momentType}`))) {
      throw new Error(`${candidateId}: mustIncludeMoments chưa có action/reveal/reaction/payoff để hoàn thành Hook Promise.`);
    }
    if (safeText(candidate.primaryTrigger) === "visual_action" && !mustIncludeMoments.some((moment) => (
      isVisualMomentRole(`${moment.role} ${moment.momentType}`)
    ))) {
      throw new Error(`${candidateId}: visual_action bắt buộc khóa ít nhất một physical/visual payoff moment.`);
    }
    return {
      candidateId,
      sourceStartSec: round(sourceStartSec),
      sourceEndSec: round(sourceEndSec),
      durationSec: round(candidateDuration),
      temporalCoverageSec: round(sourceEndSec - sourceStartSec),
      sourceSpans,
      primaryTrigger: safeText(candidate.primaryTrigger),
      sceneScore: Number.isFinite(sceneScore) ? sceneScore : 0,
      hookQuote: safeText(candidate.hookQuote),
      centralViewerQuestion: safeText(candidate.centralViewerQuestion),
      payoff: safeText(candidate.payoff),
      visualEvidence: safeText(candidate.visualEvidence),
      selectionReason: safeText(candidate.selectionReason),
      mustIncludeMoments
    };
  });
  return { candidates, warnings };
}

function buildVisualMomentUnits(candidates = []) {
  return candidates.flatMap((candidate) => (
    (candidate.mustIncludeMoments || []).map((moment, index) => {
      const visualMoment = isVisualMomentRole(`${moment.role} ${moment.momentType}`);
      const dialogueUnitId = `${visualMoment ? "visual" : "moment"}_${candidate.candidateId}_${String(index + 1).padStart(2, "0")}`;
      const label = `[${visualMoment ? "VISUAL" : "REQUIRED"} ${safeText(moment.role || "payoff").toUpperCase()} - MUST INCLUDE] ${safeText(moment.description)}`.trim();
      return {
        dialogueUnitId,
        unitType: visualMoment ? "visual_moment" : "required_moment",
        required: true,
        visualMomentId: moment.momentId,
        candidateId: candidate.candidateId,
        speaker: visualMoment ? "visual_action" : "required_moment",
        sourceStartSec: moment.sourceStartSec,
        sourceEndSec: moment.sourceEndSec,
        durationSec: moment.durationSec,
        transcriptText: label,
        contextBefore: "",
        contextAfter: "",
        words: [],
        cutOptions: [{
          cutOptionId: `${dialogueUnitId}_full`,
          label: "Giữ trọn hành động/payoff vật lý đã khóa",
          sourceSpans: [{ startSec: moment.sourceStartSec, endSec: moment.sourceEndSec }],
          retainedWordIds: [],
          resultText: label,
          durationSec: moment.durationSec,
          editRisk: "lowest"
        }]
      };
    })
  ));
}

function groupCandidatesForReels(candidates, maxReelSec = MAX_REEL_SEC) {
  const groups = [];
  let current = [];
  let duration = 0;
  candidates.forEach((candidate) => {
    if (current.length && duration + candidate.durationSec > maxReelSec) {
      groups.push(current);
      current = [];
      duration = 0;
    }
    current.push(candidate);
    duration += candidate.durationSec;
  });
  if (current.length) groups.push(current);
  return groups;
}

function findReelEntry(entries, timeSec) {
  return entries.find((entry, index) => (
    timeSec >= entry.reelStartSec - 0.08
    && (timeSec < entry.reelEndSec - 0.001 || index === entries.length - 1)
  ));
}

function mapReelTime(entry, reelTimeSec) {
  const local = Math.max(0, Math.min(entry.durationSec, Number(reelTimeSec) - entry.reelStartSec));
  return round(entry.sourceStartSec + local);
}

function mapReelTranscript(cues, wordPayload, entries) {
  const mappedWords = [];
  for (const [segmentIndex, segment] of (Array.isArray(wordPayload?.segments) ? wordPayload.segments : []).entries()) {
    for (const word of Array.isArray(segment.words) ? segment.words : []) {
      const midpoint = (Number(word.start || 0) + Number(word.end || 0)) / 2;
      const entry = findReelEntry(entries, midpoint);
      if (!entry) continue;
      const start = mapReelTime(entry, Math.max(Number(word.start || 0), entry.reelStartSec));
      const end = mapReelTime(entry, Math.min(Number(word.end || 0), entry.reelEndSec));
      if (end - start < 0.01) continue;
      mappedWords.push({
        ...word,
        start,
        end,
        candidateId: entry.candidateId,
        spanId: entry.spanId,
        segmentIndex
      });
    }
  }
  if (mappedWords.length) {
    const runs = [];
    mappedWords.forEach((word) => {
      const current = runs.at(-1);
      if (
        !current
        || current.candidateId !== word.candidateId
        || current.spanId !== word.spanId
        || current.segmentIndex !== word.segmentIndex
      ) {
        runs.push({ candidateId: word.candidateId, spanId: word.spanId, segmentIndex: word.segmentIndex, words: [word] });
      } else {
        current.words.push(word);
      }
    });
    return {
      cues: runs.map((run) => ({
        startSec: run.words[0].start,
        endSec: run.words.at(-1).end,
        text: run.words.map((word) => safeText(word.word || word.text)).filter(Boolean).join(" ")
          .replace(/\s+([,.!?;:])/g, "$1"),
        candidateId: run.candidateId,
        spanId: run.spanId
      })).filter((cue) => cue.text && cue.endSec - cue.startSec >= 0.05),
      wordPayload: {
        artifactType: "word_timestamps",
        schemaVersion: 1,
        segments: runs.map((run) => ({
          start: run.words[0].start,
          end: run.words.at(-1).end,
          candidateId: run.candidateId,
          spanId: run.spanId,
          words: run.words.map(({
            candidateId: _candidateId,
            spanId: _spanId,
            segmentIndex: _segmentIndex,
            ...word
          }) => word)
        }))
      }
    };
  }

  const mappedCues = [];
  cues.forEach((cue) => {
    const midpoint = (cue.startSec + cue.endSec) / 2;
    const entry = findReelEntry(entries, midpoint);
    if (!entry) return;
    const startSec = mapReelTime(entry, Math.max(cue.startSec, entry.reelStartSec));
    const endSec = mapReelTime(entry, Math.min(cue.endSec, entry.reelEndSec));
    if (endSec - startSec < 0.05) return;
    mappedCues.push({
      startSec,
      endSec,
      text: cue.text,
      candidateId: entry.candidateId,
      spanId: entry.spanId
    });
  });
  return {
    cues: mappedCues,
    wordPayload: { artifactType: "word_timestamps", schemaVersion: 1, segments: [] }
  };
}

function buildCandidateRepairPrompt({ errorMessage, outputCount, targetMinSec, targetMaxSec, sourceMap }) {
  return `USER TASK INSTRUCTION - REPAIR PODCAST CANDIDATE MAP

The previous Candidate Map failed the local quality gate:
${safeText(errorMessage)}

Repair the Candidate Map using the complete locked transcript parts and podcast-source-map.json attached here.

NON-NEGOTIABLE REPAIR:
- Return exactly ONE podcast_candidate_map JSON object with schemaVersion=2 inside one Markdown json code block and no prose.
- Preserve sourceMatchId="${sourceMap.sourceMatchId}" and provide at least ${outputCount} distinct story candidates.
- Every returned candidate must independently contain at least ${targetMinSec}s of useful sourceSpans so it can produce one ${targetMinSec}-${targetMaxSec}s output. Do not count temporal gaps or dead air toward this duration.
- Each candidate is a complete viewer question, not one broad continuous excerpt.
- Use sourceSpans[] to collect non-contiguous Hook/setup, action/reveal, and reaction/payoff footage without carrying dead air between them.
- Every candidate MUST contain mustIncludeMoments[] with at least one action/reveal/reaction/result/conclusion/payoff that directly answers centralViewerQuestion.
- Every mustIncludeMoment must be fully contained inside one sourceSpan.
- A transformation/challenge story is invalid if it stops at an instruction or promise before the physical action, visible result, and useful reaction.
- In transcript_locked mode, locate later beats from exact transcript anchors and use verificationBasis="transcript_anchor_needs_reel_verification". Do not invent visual evidence.
- All spans must be inside 0-${sourceMap.localDurationSec}s, listed in source-time order, non-overlapping, and total 3-${MAX_CANDIDATE_SEC}s useful footage per candidate.
- Do not return an EDL, selections, output timeline, rewritten dialogue, or prose.

Use the schema demonstrated by the original Stage 1 prompt. Rebuild invalid candidates instead of making a cosmetic timestamp edit.`;
}

function buildAssemblyPrompt({ outputCount, targetMinSec, targetMaxSec, sourceMap, candidateMap, reelFiles }) {
  return `USER TASK INSTRUCTION - PODCAST VIRAL ASSEMBLY / PASS 2

ROLE:
You are the final TikTok/Reels editor. The Scout already found the strongest source moments. Watch every candidate reel completely, then assemble exactly ${outputCount} DISTINCT final edits using only locked dialogue IDs.

INPUTS:
- ${reelFiles.length} candidate reel file(s): ${reelFiles.join(", ")}.
- podcast-candidate-map.resolved.json maps reel time back to candidateId and source time.
- podcast-assembly-dialogue-units-part-*.json contains word-refined dialogue and cut options.
- sourceMatchId="${sourceMap.sourceMatchId}".
- Each candidate may contain multiple non-contiguous sourceSpans. The reel concatenates those useful spans; the resolved map is the authority for every source/reel mapping.

================================================================================
RENDERING BOUNDARY - SUPREME, DO NOT ASK THE USER FOR MORE INPUT
================================================================================
- Your ONLY task is editorial selection and JSON EDL assembly. You are NOT rendering, cropping, reframing, encoding, or writing FFmpeg commands.
- The attached candidate reel file(s), resolved candidate map, source map, dialogue-unit parts, and this prompt are the COMPLETE required inputs for Pass 2.
- The candidate reels are exact visual/audio excerpts from the local source. Watch every attached reel completely. The local tool will map your locked IDs back to the full-resolution source.
- The local tool exclusively owns 9:16 layout, background blur, scale, crop policy, captions, FFmpeg parameters, codecs, and export settings AFTER JSON import.
- NEVER request the original full video, an FFmpeg command, aspect-ratio parameters, crop coordinates, auto-crop confirmation, render settings, or any additional files.
- Do not describe how to render 9:16. Do not put layout/crop/FFmpeg fields in the JSON.
- If every attached reel opens and every attached JSON parses, set accessMode="candidate_reel", candidateReelReviewed=true, and PROCEED immediately to the final EDL JSON files.
- Fail closed only when an attached candidate reel cannot be played or a required attached JSON file is actually missing, unreadable, truncated, or sourceMatchId-mismatched. Rendering preferences are NEVER a valid reason to stop.

EDITORIAL PRIORITY:
1. First decide the strongest independent story you would build from each candidate. Do not merely preserve source chronology.
2. Structure each output as: strongest Hook -> minimum necessary context -> commitment/action/escalation -> reveal -> reaction/payoff.
3. Use jump cuts to remove permission-seeking, waiting, counting, repeated setup, dead air, and commentary that does not advance the central viewer question.
4. Keep repetition only when it creates suspense, comedy, vulnerability, or raw emotion. In the first three seconds, prefer the tight option unless the repetition itself is the Hook.
5. Use selective semantic reordering when a candidate's Hook, action, reveal, and reaction come from non-contiguous sourceSpans. Chronological compression is valid only when it wins the required retention comparison and preserves the strongest payoff.
6. Never return a random quote montage. Every selected line must advance the same viewer question.
7. Target ${targetMinSec}-${targetMaxSec}s, but never pad with filler merely to reach the maximum.
8. No narrator, TTS, rewritten dialogue, invented captions, or generated clean_dialogue.
9. REQUIRED STORY MOMENT LOCK: Rows whose text contains "- MUST INCLUDE]" are locked action/reveal/reaction/payoff units. For every candidateId used by an output, select ALL matching requiredMomentUnitIds listed in podcast-candidate-map.resolved.json. This applies to visual_action, raw_emotion, and controversial_hot_take alike. A verbal promise without its locked answer/payoff is invalid.
   - Rows whose speaker is "visual_action" are physical footage, not invented speech. Watch them and select their exact full cutOptionId.
   - A required moment unit may overlap an ASR dialogue unit covering the same source seconds. Select the required unit for that interval and do not also select an overlapping dialogue unit unless it contributes distinct non-overlapping source content. Never duplicate the same footage merely to satisfy both labels.
   - Watch every required moment in the reel. If it does not actually contain the promised action/answer/reveal/reaction, do not pretend it passed. The final promisePayoffAudit must report the visible/audible evidence you personally verified.
10. WAITING/COUNTING CUT: Remove comment counting, permission seeking, repeated requests, and waiting intervals. Retain at most the shortest line needed to explain the decision, then jump directly to commitment/action. Do not preserve a long waiting block merely because it is chronological.
11. NON-LINEAR RETENTION TEST: Before choosing final order, compare at least: (A) tight chronological compression, (B) delayed payoff/reaction outro, and (C) strongest-reaction cold open. Select the clearest highest-retention assembly. Returning chronologyChanged=false for every selection is acceptable only when the nonLinearAudit explains why every tested reorder weakened clarity or payoff.

LOCKED CATALOG FORMAT:
- Unit row: [dialogueUnitId, sourceStartSec, sourceEndSec, speaker, transcriptText, cutOptions].
- Option row: [cutOptionId, durationSec, optionalResultText].
- Copy cutOptionId EXACTLY from the selected option row. Never construct a suffix. If a row only contains dialogue_00003_full, then dialogue_00003_tight and dialogue_00003_aggressive DO NOT EXIST.
- speaker="visual_action" identifies a selectable physical-action unit. speaker="required_moment" identifies another mandatory source payoff/reaction. Neither contains invented speech; both must be treated as source footage with original audio.

CONTINUITY:
- For every reordered selection: chronologyChanged=true, stateCompatible=true, referentClear=true, transitionScore>=7.5, and a concrete transitionReason.
- assemblyOrder is the final output order. The local tool owns every timestamp and 9:16 operation.

OUTPUT:
- Return exactly ${outputCount} independent Markdown json code blocks and no prose.
- One object per downloadable file, podcast-cut-01.json through podcast-cut-${String(outputCount).padStart(2, "0")}.json.
- Do not wrap outputs in an array.

{
  "artifactType": "${ARTIFACT_TYPE}",
  "schemaVersion": 1,
  "workflow": "podcast_viral_cut_two_pass",
  "sourceMatchId": "${sourceMap.sourceMatchId}",
  "outputIndex": 1,
  "outputCount": ${outputCount},
  "title": "short curiosity title",
  "targetDurationSec": ${targetMinSec},
  "centralViewerQuestion": "one concrete question",
  "hookPromise": "what the opening promises",
  "editingPattern": "chronological_compression | selective_semantic_reorder",
  "candidateIds": ["candidate_001"],
  "assemblyBlueprint": {
    "hook": "specific hook beat",
    "context": "minimum context",
    "actionOrEscalation": "specific progression",
    "reveal": "specific reveal",
    "reactionOrPayoff": "specific ending",
    "requiredMomentUnitIds": ["visual_candidate_001_01"],
    "visualPayoffUnitId": "visual_candidate_001_01 or empty when payoff is not visual"
  },
  "nonLinearAudit": {
    "alternativesTested": ["tight_chronological", "delayed_payoff_outro", "reaction_cold_open"],
    "selectedPattern": "selective_semantic_reorder",
    "reason": "specific continuity and retention reason"
  },
  "viralSelectionAudit": {
    "primaryTrigger": "visual_action | raw_emotion | controversial_hot_take",
    "sceneScore": 9,
    "scrollStopReason": "verified reason",
    "verifiedHookQuote": "exact source words",
    "visualEvidence": "verified from candidate reel",
    "payoff": "specific retained payoff"
  },
  "promisePayoffAudit": {
    "hookPromiseResolved": true,
    "payoffObservedInReel": true,
    "observedEvidence": "specific visible or audible result personally verified in the candidate reel",
    "requiredMomentUnitIdsVerified": ["visual_candidate_001_01"],
    "missingRequiredMomentIds": []
  },
  "accessAudit": {
    "accessGranted": true,
    "accessMode": "candidate_reel",
    "candidateReelReviewed": true,
    "dialogueUnitsParsed": true,
    "dialogueUnitPartsParsed": true,
    "dialogueUnitCountVerified": true,
    "sourceMapParsed": true,
    "sourceMatchVerified": true
  },
  "selections": [
    {
      "selectionId": "selection_001",
      "assemblyOrder": 1,
      "narrativeBlock": "hook | context | escalation | reveal | payoff | reaction",
      "dialogueUnitId": "dialogue_00001",
      "cutOptionId": "dialogue_00001_tight",
      "includeReactionAfterMs": 0,
      "chronologyChanged": false,
      "stateCompatible": true,
      "referentClear": true,
      "transitionScore": 10,
      "transitionReason": "verified reason",
      "visualTreatment": "none | punch_in | reaction_hold"
    }
  ]
}

FINAL SELF-CHECK:
- exactly ${outputCount} files with unique outputIndex;
- every selected ID and option exists;
- Hook begins immediately without disposable lead-in;
- no dead-air/filler unit is retained merely for duration;
- every output fulfills its Hook promise with a visible or audible payoff;
- every requiredMomentUnitId for every used candidate is present in selections;
- promisePayoffAudit confirms the actual reel contains the promised result; never mark true from labels alone;
- every reordered transition passes continuity.`;
}

class PodcastCandidateService {
  constructor(settings = {}, dependencies = {}) {
    this.settings = settings;
    this.ffmpeg = dependencies.ffmpeg || new FfmpegService(settings);
    this.subtitleService = dependencies.subtitleService || new SubtitleService({
      ...settings,
      whisperEngine: "faster-whisper"
    });
  }

  async importCandidates({ packageDir, candidatePath, onProgress }) {
    if (!packageDir || !candidatePath) throw new Error("Thiếu thư mục gói hoặc Candidate Map.");
    const upload1 = path.join(packageDir, "01-GUI-GEMINI");
    const stage2 = path.join(packageDir, "02-ASSEMBLY-GEMINI");
    const workDir = path.join(packageDir, ".candidate-work");
    const packageInfo = JSON.parse(await fs.readFile(path.join(packageDir, "package-info.json"), "utf8"));
    const sourceMap = JSON.parse(await fs.readFile(path.join(upload1, "podcast-source-map.json"), "utf8"));
    const fullUnitsPayload = JSON.parse(await fs.readFile(path.join(packageDir, "podcast-dialogue-units.full.json"), "utf8"));
    const candidateRaw = await fs.readFile(candidatePath, "utf8");
    const payload = parseGeminiJsonObject(candidateRaw, path.basename(candidatePath));
    const outputCount = Math.max(1, Math.min(5, Math.round(Number(packageInfo.outputCount || 1))));
    let candidates;
    let warnings;
    try {
      ({ candidates, warnings } = validateCandidateMap(
        payload,
        sourceMap,
        outputCount,
        Number(packageInfo.targetMinSec || 0)
      ));
    } catch (error) {
      const repairDir = path.join(packageDir, "02-CANDIDATE-REPAIR");
      await fs.rm(repairDir, { recursive: true, force: true });
      await fs.mkdir(repairDir, { recursive: true });
      await fs.copyFile(candidatePath, path.join(repairDir, "podcast-candidate-map-invalid.json"));
      await fs.copyFile(path.join(upload1, "podcast-source-map.json"), path.join(repairDir, "podcast-source-map.json"));
      const transcriptParts = (await fs.readdir(upload1))
        .filter((name) => /^podcast-dialogue-units-part-\d+\.json$/i.test(name))
        .sort();
      await Promise.all(transcriptParts.map((name) => (
        fs.copyFile(path.join(upload1, name), path.join(repairDir, name))
      )));
      await fs.writeFile(
        path.join(repairDir, "02-podcast-candidate-repair-prompt.txt"),
        buildCandidateRepairPrompt({
          errorMessage: error.message,
          outputCount,
          targetMinSec: Number(packageInfo.targetMinSec || 0),
          targetMaxSec: Number(packageInfo.targetMaxSec || MAX_CANDIDATE_SEC),
          sourceMap
        }),
        "utf8"
      );
      const repairFileCount = transcriptParts.length + 3;
      if (repairFileCount > MAX_UPLOAD_FILES) {
        await fs.rm(repairDir, { recursive: true, force: true });
        throw error;
      }
      throw new Error(`${error.message} Đã tạo gói yêu cầu Gemini sửa Candidate Map tại: ${repairDir}`);
    }
    const sourceVideoPath = packageInfo.sourceVideoPath;
    if (!(await exists(sourceVideoPath))) throw new Error("Không tìm thấy video local đã dùng để tạo gói Podcast.");

    await fs.rm(stage2, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.mkdir(stage2, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });

    const groups = groupCandidatesForReels(candidates);
    const reelFiles = [];
    const resolvedCandidates = [];
    let processed = 0;
    for (const [groupIndex, group] of groups.entries()) {
      const clipPaths = [];
      let reelCursor = 0;
      const reelName = `candidate-reel-part-${String(groupIndex + 1).padStart(2, "0")}.mp4`;
      const reelPath = path.join(stage2, reelName);
      for (const candidate of group) {
        processed += 1;
        onProgress?.({
          step: "podcast_candidates",
          percent: 10 + Math.round((processed / candidates.length) * 35),
          message: `Đang cắt candidate reel ${processed}/${candidates.length}`
        });
        const candidateReelStartSec = reelCursor;
        const resolvedSpans = [];
        for (const [spanIndex, span] of candidate.sourceSpans.entries()) {
          const clipPath = path.join(
            workDir,
            `${candidate.candidateId}-${String(spanIndex + 1).padStart(2, "0")}.mp4`
          );
          await this.ffmpeg.extractFastPreviewClipWithAudio({
            sourcePath: sourceVideoPath,
            outputPath: clipPath,
            startSec: span.sourceStartSec,
            durationSec: span.durationSec,
            width: 480
          });
          clipPaths.push(clipPath);
          resolvedSpans.push({
            ...span,
            candidateId: candidate.candidateId,
            reelFile: reelName,
            reelStartSec: round(reelCursor),
            reelEndSec: round(reelCursor + span.durationSec)
          });
          reelCursor += span.durationSec;
        }
        resolvedCandidates.push({
          ...candidate,
          sourceSpans: resolvedSpans,
          reelFile: reelName,
          reelStartSec: round(candidateReelStartSec),
          reelEndSec: round(reelCursor)
        });
      }
      if (clipPaths.length === 1) await fs.copyFile(clipPaths[0], reelPath);
      else await this.ffmpeg.concatSegmentsSafely(clipPaths, reelPath);
      reelFiles.push(reelName);
    }

    onProgress?.({ step: "podcast_candidates", percent: 52, message: "Đang đo word timestamp trên candidate reel" });
    const mappedCues = [];
    const mappedWordSegments = [];
    let asrSucceeded = true;
    for (const [reelIndex, reelName] of reelFiles.entries()) {
      const reelPath = path.join(stage2, reelName);
      const audioPath = path.join(workDir, `candidate-reel-${reelIndex + 1}.wav`);
      const asrDir = path.join(workDir, `asr-${reelIndex + 1}`);
      try {
        await this.ffmpeg.run(this.ffmpeg.ffmpegPath, [
          "-y", "-i", reelPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath
        ], { captureStdout: false });
        const transcript = await this.subtitleService.transcribeToSrt({
          audioPath,
          outputDir: asrDir,
          narrationLanguage: "en",
          cacheDir: path.join(packageDir, ".candidate-asr-cache")
        });
        const cues = parseSrt(await fs.readFile(transcript.subtitlePath, "utf8"));
        const words = transcript.wordTimestampsPath && await exists(transcript.wordTimestampsPath)
          ? JSON.parse(await fs.readFile(transcript.wordTimestampsPath, "utf8"))
          : { segments: [] };
        const entries = resolvedCandidates
          .filter((candidate) => candidate.reelFile === reelName)
          .flatMap((candidate) => candidate.sourceSpans);
        const mapped = mapReelTranscript(cues, words, entries);
        mappedCues.push(...mapped.cues);
        mappedWordSegments.push(...mapped.wordPayload.segments);
      } catch (error) {
        asrSucceeded = false;
        warnings.push(`Không tinh chỉnh được word timestamp cho ${reelName}: ${error.message}. Tool dùng timestamp transcript gốc.`);
        break;
      }
    }

    let assemblyUnits;
    if (asrSucceeded && mappedCues.length) {
      assemblyUnits = buildDialogueUnits(mappedCues, {
        cleanupMode: "aggressive",
        wordSidecar: { artifactType: "word_timestamps", schemaVersion: 1, segments: mappedWordSegments }
      });
      assemblyUnits.forEach((unit, index) => {
        unit.candidateId = mappedCues[index]?.candidateId || "";
        unit.sourceSpanId = mappedCues[index]?.spanId || "";
      });
    } else {
      const originalUnits = Array.isArray(fullUnitsPayload.dialogueUnits) ? fullUnitsPayload.dialogueUnits : [];
      assemblyUnits = originalUnits.filter((unit) => candidates.some((candidate) => (
        unitOverlapsCandidate(unit, candidate)
      ))).map((unit) => ({
        ...unit,
        candidateId: candidates.find((candidate) => (
          unitOverlapsCandidate(unit, candidate)
        ))?.candidateId || "",
        sourceSpanId: candidates
          .flatMap((candidate) => candidate.sourceSpans.map((span) => ({ ...span, candidateId: candidate.candidateId })))
          .find((span) => unit.sourceStartSec < span.sourceEndSec && unit.sourceEndSec > span.sourceStartSec)?.spanId || ""
      }));
    }
    assemblyUnits.push(...buildVisualMomentUnits(candidates));
    if (!assemblyUnits.length) throw new Error("Không tạo được dialogue unit cho lượt Assembly.");

    const reelFileCount = reelFiles.length;
    const maxUnitParts = Math.max(1, MAX_UPLOAD_FILES - reelFileCount - 3);
    const compactParts = buildCompactDialogueParts(assemblyUnits, {
      sourceMatchId: sourceMap.sourceMatchId,
      targetBytes: 80000,
      maxParts: maxUnitParts
    });
    const assemblySourceMap = {
      ...sourceMap,
      workflowStage: "podcast_assembly",
      dialogueUnitCount: assemblyUnits.length,
      dialogueUnitPartCount: compactParts.length,
      dialogueUnitPartFiles: compactParts.map((_part, index) => (
        `podcast-assembly-dialogue-units-part-${String(index + 1).padStart(2, "0")}.json`
      )),
      candidateCount: candidates.length,
      reelFiles
    };
    const resolvedMap = {
      artifactType: "podcast_candidate_map_resolved",
      schemaVersion: 1,
      sourceMatchId: sourceMap.sourceMatchId,
      asrRefined: asrSucceeded && mappedCues.length > 0,
      candidates: resolvedCandidates.map((candidate) => ({
        ...candidate,
        dialogueUnitIds: assemblyUnits
          .filter((unit) => unit.candidateId === candidate.candidateId || (
            unitOverlapsCandidate(unit, candidate)
          ))
          .map((unit) => unit.dialogueUnitId),
        requiredVisualUnitIds: assemblyUnits
          .filter((unit) => unit.candidateId === candidate.candidateId && unit.unitType === "visual_moment")
          .map((unit) => unit.dialogueUnitId),
        requiredMomentUnitIds: assemblyUnits
          .filter((unit) => unit.candidateId === candidate.candidateId && unit.required === true)
          .map((unit) => unit.dialogueUnitId)
      }))
    };
    const prompt = buildAssemblyPrompt({
      outputCount,
      targetMinSec: Number(packageInfo.targetMinSec || 45),
      targetMaxSec: Number(packageInfo.targetMaxSec || 60),
      sourceMap: assemblySourceMap,
      candidateMap: resolvedMap,
      reelFiles
    });

    await writeJson(path.join(packageDir, "podcast-candidate-map.json"), payload);
    await writeJson(path.join(packageDir, "podcast-assembly-dialogue-units.full.json"), {
      artifactType: "podcast_dialogue_units",
      schemaVersion: 1,
      sourceMatchId: sourceMap.sourceMatchId,
      cleanupMode: "viral_tight",
      dialogueUnitCount: assemblyUnits.length,
      dialogueUnits: assemblyUnits
    });
    await writeJson(path.join(stage2, "podcast-source-map.json"), assemblySourceMap);
    await writeJson(path.join(stage2, "podcast-candidate-map.resolved.json"), resolvedMap);
    await fs.writeFile(path.join(stage2, "02-podcast-assembly-prompt.txt"), prompt, "utf8");
    await Promise.all(compactParts.map((part, index) => fs.writeFile(
      path.join(stage2, `podcast-assembly-dialogue-units-part-${String(index + 1).padStart(2, "0")}.json`),
      JSON.stringify(part),
      "utf8"
    )));
    const uploadFileCount = reelFiles.length + compactParts.length + 3;
    if (uploadFileCount > MAX_UPLOAD_FILES) {
      throw new Error(`Gói Assembly có ${uploadFileCount} file, vượt giới hạn ${MAX_UPLOAD_FILES}.`);
    }
    const nextPackageInfo = {
      ...packageInfo,
      workflowStage: "podcast_assembly_pending",
      candidatePath,
      candidateCount: candidates.length,
      candidateReelCount: reelFiles.length,
      assemblyDialogueUnitCount: assemblyUnits.length,
      assemblyUploadFileCount: uploadFileCount,
      assemblyDir: stage2,
      updatedAt: new Date().toISOString()
    };
    await writeJson(path.join(packageDir, "package-info.json"), nextPackageInfo);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    onProgress?.({ step: "podcast_candidates", percent: 100, message: "Gói Podcast Assembly đã sẵn sàng" });
    return {
      candidatePath: path.join(packageDir, "podcast-candidate-map.json"),
      candidateMapPath: path.join(packageDir, "podcast-candidate-map.json"),
      candidateCount: candidates.length,
      candidateReelCount: reelFiles.length,
      reelCount: reelFiles.length,
      assemblyDialogueUnitCount: assemblyUnits.length,
      assemblyDir: stage2,
      stage2UploadDir: stage2,
      pass2UploadDir: stage2,
      scriptPromptPath: path.join(stage2, "02-podcast-assembly-prompt.txt"),
      outputCount,
      uploadFileCount,
      warnings
    };
  }
}

module.exports = PodcastCandidateService;
module.exports.validateCandidateMap = validateCandidateMap;
module.exports.groupCandidatesForReels = groupCandidatesForReels;
module.exports.mapReelTranscript = mapReelTranscript;
module.exports.buildAssemblyPrompt = buildAssemblyPrompt;
module.exports.buildVisualMomentUnits = buildVisualMomentUnits;
