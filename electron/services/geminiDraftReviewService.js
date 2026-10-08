const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { buildGeminiInputAccessGate } = require("./geminiInputAccessGate");
const FfmpegService = require("./ffmpegService");

const DEFAULT_WORDS_PER_SECOND = 2.35;

function safeText(value = "") {
  return String(value || "").trim();
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildReviewBinding({ projectId, variant, revision, draftTimeline }) {
  const reviewBindingId = crypto.createHash("sha256").update(JSON.stringify({
    projectId: safeText(projectId),
    variantId: safeText(variant?.id),
    scriptId: safeNumber(variant?.scriptId, 0),
    reviewedRevision: revision,
    durationSec: safeNumber(draftTimeline?.totalOutputDurationSec, 0),
    segments: (Array.isArray(draftTimeline?.segments) ? draftTimeline.segments : []).map((segment) => ({
      id: safeText(segment.id || segment.segmentId),
      sourceStartSec: safeNumber(segment.sourceStartSec, 0),
      sourceEndSec: safeNumber(segment.sourceEndSec, 0)
    }))
  })).digest("hex").slice(0, 24);
  return {
    projectId: safeText(projectId),
    variantId: safeText(variant?.id),
    scriptId: safeNumber(variant?.scriptId, 0),
    reviewedRevision: revision,
    draftFile: `draft-v${revision}.mp4`,
    reviewBindingId
  };
}

const INDEPENDENT_HOOK_TYPES = ["high_action", "dialogue_conflict", "psychological_wtf", "evidence_reveal"];

function independentReviewOptionRules(variant = {}) {
  const options = variant.independentPromptOptions || {};
  const requested = Array.isArray(options.hookPriority) ? options.hookPriority : [];
  const priority = requested.filter((item, index) => INDEPENDENT_HOOK_TYPES.includes(item) && requested.indexOf(item) === index);
  INDEPENDENT_HOOK_TYPES.forEach((item) => {
    if (!priority.includes(item)) priority.push(item);
  });
  const hookMaxSec = Math.max(4, Math.min(30, safeNumber(options.hookMaxSec, 30)));
  return `INDEPENDENT USER OPTIONS - PRESERVE DURING V2 REVIEW:
- Hook priority order: ${priority.join(" -> ")}.
- Re-evaluate every Hook category in that exact order against the rendered draft and complete supplied source coverage. Fall through only when the higher category has no candidate that passes cold-viewer comprehension, verified timestamps, intelligible core action/words, zero external source narrator, and a complete beat within ${hookMaxSec}s.
- Populate revisedScript.hook_selection_audit with requestedPriority, selectedType, fallbackLevel, selectedEvidenceIds, reason, and concrete rejectedHigherPriorityCandidates. Do not keep V1's selected type merely because it already rendered.
- Preserve independent_prompt_options exactly: ${JSON.stringify(options)}.
- Narrator tone=${safeText(options.narratorTone || "profile_default")}; audio balance=${safeText(options.audioBalance || "original_first")}; pacing=${safeText(options.pacing || "balanced")}; ending=${safeText(options.ending || "verified_payoff")}; overlays=${options.overlays !== false}.
- These choices are editorial preferences only. Factuality, source-narrator muting, protected original audio, Actor Identity, Hook Transition, timestamp validity, and standalone payoff remain mandatory.`;
}

function sanitizeFilePart(value = "") {
  return safeText(value || "variant")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56) || "variant";
}

function countWords(value = "") {
  return safeText(value).split(/\s+/).filter(Boolean).length;
}

function parseSrtTimestamp(value = "") {
  const match = safeText(value).match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return NaN;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]) + (Number(match[4]) / 1000);
}

function parseSrtCues(source = "") {
  const normalized = String(source || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  return normalized.split(/\n{2,}/).map((block, index) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return null;
    const [startRaw, endRaw] = lines[timingIndex].split("-->").map((value) => value.trim().split(/\s+/)[0]);
    const startSec = parseSrtTimestamp(startRaw);
    const endSec = parseSrtTimestamp(endRaw);
    const text = safeText(lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec || !text) return null;
    return {
      cueId: `source_cue_${String(index + 1).padStart(5, "0")}`,
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      text
    };
  }).filter(Boolean);
}

const EXPLICIT_SPEAKER_PATTERNS = [
  ["officer", /^(?:\[|\()?\s*(?:officer|cop|deputy|detective|sergeant|trooper)\s*(?:\]|\))?\s*[:>-]\s*/i],
  ["suspect", /^(?:\[|\()?\s*(?:suspect|subject|driver)\s*(?:\]|\))?\s*[:>-]\s*/i],
  ["dispatcher", /^(?:\[|\()?\s*(?:dispatcher|dispatch|911 operator|operator)\s*(?:\]|\))?\s*[:>-]\s*/i],
  ["victim", /^(?:\[|\()?\s*(?:victim|caller)\s*(?:\]|\))?\s*[:>-]\s*/i],
  ["witness", /^(?:\[|\()?\s*witness\s*(?:\]|\))?\s*[:>-]\s*/i],
  ["source_narrator", /^(?:\[|\()?\s*(?:narrator|host|reporter|news anchor)\s*(?:\]|\))?\s*[:>-]\s*/i]
];

function detectExplicitSpeaker(text = "") {
  const source = safeText(text);
  const bracketLabel = source.match(/^\[\s*([^\]]+)\s*\]\s*/);
  if (bracketLabel) {
    const normalized = bracketLabel[1].toLowerCase();
    const mapped = normalized.match(/officer|cop|deputy|detective|sergeant|trooper/) ? "officer"
      : normalized.match(/suspect|subject|driver/) ? "suspect"
      : normalized.match(/dispatcher|dispatch|911 operator|operator/) ? "dispatcher"
      : normalized.match(/victim|caller/) ? "victim"
      : normalized.match(/witness/) ? "witness"
      : normalized.match(/narrator|host|reporter|news anchor/) ? "source_narrator"
      : "";
    if (mapped) return { speakerRole: mapped, speakerEvidence: "explicit_transcript_label" };
  }
  for (const [speakerRole, pattern] of EXPLICIT_SPEAKER_PATTERNS) {
    if (pattern.test(source)) {
      return { speakerRole, speakerEvidence: "explicit_transcript_label" };
    }
  }
  return { speakerRole: "unknown", speakerEvidence: "none" };
}

function scoreDialogueCue(text = "") {
  const source = safeText(text);
  const lower = source.toLowerCase();
  const signals = [];
  let score = 0;
  const add = (signal, points, pattern) => {
    if (pattern.test(lower)) {
      signals.push(signal);
      score += points;
    }
  };
  add("denial_or_contradiction", 2.2, /\b(?:didn'?t|don'?t|not me|never|no way|that'?s not|you'?re lying|i swear)\b/);
  add("entitlement_or_threat", 2.4, /\b(?:sue|lawsuit|my rights|you can'?t|how dare|do you know who|i own|you'?ll pay)\b/);
  add("confession_or_admission", 2.8, /\b(?:i did|i took|i stole|i hit|i shot|i killed|i lied|my fault|i admit)\b/);
  add("sarcasm_or_irony", 2.0, /\b(?:honey|smart move|good job|genius|dumbest|stupid|karma|brilliant)\b/);
  add("evidence_or_consequence", 1.8, /\b(?:gun|weapon|drugs?|warrant|felony|arrest|charged?|jail|prison|bond|evidence|blood|body)\b/);
  add("bizarre_logic", 2.0, /\b(?:because i|so what|who cares|doesn'?t count|everybody does|had to|made me)\b/);
  add("high_conflict_or_profanity", 1.8, /\b(?:fuck|fucking|shit|bitch|damn|shut up|get back|get down|hands up|stop now)\b/);
  if (/[?!]/.test(source)) score += 0.4;
  if (countWords(source) >= 4 && countWords(source) <= 28) score += 0.6;
  return { semanticSignals: signals, semanticScore: Number(Math.min(10, score).toFixed(1)) };
}

function buildSemanticDialogueCandidates(cues = [], limit = 100) {
  const candidates = cues.map((cue, index) => {
    const speaker = detectExplicitSpeaker(cue.text);
    const semantics = scoreDialogueCue(cue.text);
    return {
      dialogueCandidateId: `dialogue_candidate_${String(index + 1).padStart(5, "0")}`,
      cueId: cue.cueId,
      startSec: cue.startSec,
      endSec: cue.endSec,
      text: cue.text,
      previousText: safeText(cues[index - 1]?.text),
      nextText: safeText(cues[index + 1]?.text),
      ...speaker,
      ...semantics
    };
  }).filter((candidate) => candidate.semanticScore > 0 || candidate.speakerRole !== "unknown")
    .sort((left, right) => right.semanticScore - left.semanticScore || left.startSec - right.startSec)
    .slice(0, Math.max(1, limit));
  return {
    artifactType: "semantic_dialogue_candidates",
    schemaVersion: 1,
    policy: "discovery_hints_only_full_srt_is_authoritative",
    speakerPolicy: "explicit_labels_only_otherwise_unknown",
    cueCount: cues.length,
    candidateCount: candidates.length,
    candidates
  };
}

function countRawSrtCues(source = "") {
  const matches = String(source || "").match(/\d+\s*\r?\n\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/g);
  return matches ? matches.length : 0;
}

function buildTranscriptInput({ transcriptText = "", embedded = false } = {}) {
  const source = String(transcriptText || "");
  const cues = parseSrtCues(source);
  const rawCues = countRawSrtCues(source);
  return {
    available: Boolean(source.trim() && cues.length),
    embedded: Boolean(embedded && source.trim()),
    file: source.trim() ? (embedded ? "review-context.json" : "source-transcript.srt") : "",
    location: source.trim() ? (embedded ? "review-context.json.sourceTranscriptSrt" : "source-transcript.srt") : "",
    cueCount: rawCues || cues.length,
    dialogueCueCount: cues.length,
    durationSec: cues.length ? Number(Math.max(...cues.map((cue) => cue.endSec)).toFixed(3)) : 0,
    sha256: source.trim() ? crypto.createHash("sha256").update(source).digest("hex") : ""
  };
}

function semanticDialogueAuditRules({ hasTranscript, transcriptInputName = "source-transcript.srt" } = {}) {
  if (!hasTranscript) return `SEMANTIC DIALOGUE AUDIT - BEFORE ACTION RADAR:
- No reliable source transcript is available. Do not invent quotes, speakers, admissions, charges, or outcomes. Use only verified audiovisual evidence.`;
  return `SEMANTIC DIALOGUE AUDIT - BEFORE ACTION RADAR (HIGHEST EDITORIAL PRIORITY):
1. Read the COMPLETE transcript at ${transcriptInputName}. Note that SRT files may contain empty subtitle reset cues; inspect the available dialogue cues and set semanticQuoteAudit.fullTranscriptInspected=true. Do not reject or fail the review due to empty cue count differences.
2. Inspect review-context.json.semanticDialogueCandidates, then independently scan the full transcript. The candidate list is a discovery aid, not a substitute for the complete SRT.
3. Before consulting action/motion/audio ranks, identify the strongest verified dialogue for: contradiction or denial, entitlement or threat, confession or admission, sarcasm or irony, bizarre logic, evidence reveal, legal consequence, and high-conflict commands.
4. Never assign Officer, Suspect, Victim, Witness, Dispatcher, or source narrator from wording alone. Use an explicit transcript label or audiovisual proof; otherwise speakerRole MUST be "unknown".
5. Verify every shortlisted quote against supplied footage before using it. Reject a quote when identity, words, timing, or source context cannot be verified.
6. Only after this semantic audit may action-candidates, motionScore, or audioEnergyScore help locate supporting visuals. They never outrank verified narrative meaning.
7. Do not let a missing optional review-context.json.sourceTranscriptSrt field override transcriptInput.available=true or transcriptInput.location.`;
}

function compactTimestamp(value = new Date()) {
  return value.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

async function existingFile(candidates = []) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 0) return candidate;
    } catch (_error) {
      // Try the next compatible package layout.
    }
  }
  return "";
}

async function readJsonIfAvailable(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function selectReviewProxyChunks(proxyManifest = {}, segments = [], maxFiles = 6) {
  const chunks = (Array.isArray(proxyManifest?.chunks) ? proxyManifest.chunks : [])
    .map((chunk, index) => ({ ...chunk, _index: index }))
    .sort((left, right) => safeNumber(left.sourceStartSec) - safeNumber(right.sourceStartSec));

  const ranges = (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      startSec: safeNumber(segment.sourceStartSec, -1),
      endSec: safeNumber(segment.sourceEndSec, -1)
    }))
    .filter((range) => range.startSec >= 0 && range.endSec > range.startSec);

  if (!ranges.length) {
    return chunks.slice(0, maxFiles).map(({ _index, ...chunk }) => chunk);
  }

  const overlappingChunks = chunks
    .map((chunk) => {
      const startSec = safeNumber(chunk.sourceStartSec, -1);
      const endSec = safeNumber(chunk.sourceEndSec, -1);
      const overlapSec = ranges.reduce((sum, range) => (
        sum + Math.max(0, Math.min(endSec, range.endSec) - Math.max(startSec, range.startSec))
      ), 0);
      return { ...chunk, _overlapSec: overlapSec };
    })
    .filter((chunk) => chunk._overlapSec > 0);

  return overlappingChunks
    .sort((left, right) => right._overlapSec - left._overlapSec || left._index - right._index)
    .slice(0, maxFiles)
    .sort((left, right) => safeNumber(left.sourceStartSec) - safeNumber(right.sourceStartSec))
    .map(({ _index, _overlapSec, ...chunk }) => chunk);
}

async function linkOrCopy(sourcePath, targetPath) {
  if (!sourcePath) return "";
  await fs.rm(targetPath, { force: true }).catch(() => {});
  try {
    await fs.link(sourcePath, targetPath);
  } catch (_error) {
    await fs.copyFile(sourcePath, targetPath);
  }
  return targetPath;
}

function getActiveVariant(project = {}) {
  const analysis = project.analysis || {};
  const variants = Array.isArray(analysis.highlightVariants) ? analysis.highlightVariants : [];
  const activeId = analysis.activeVariantId || variants[0]?.id || "";
  return variants.find((variant) => variant.id === activeId) || variants[0] || null;
}

function buildScriptJson(variant = {}) {
  const segments = Array.isArray(variant.segments) ? variant.segments : [];
  const totalDuration = segments.reduce((sum, segment) => (
    sum + Math.max(0, safeNumber(segment.duration, safeNumber(segment.endSec) - safeNumber(segment.startSec)))
  ), 0);
  return {
    artifactType: "highlight_cut_script",
    scriptId: safeNumber(variant.scriptId, 0),
    title: variant.title || variant.label || "Highlight Draft",
    language: variant.language || "en",
    sourceLanguage: variant.sourceLanguage || "en",
    total_target_sec: Number(totalDuration.toFixed(3)),
    style: variant.style || "True Crime Bodycam Highlight",
    workflow: variant.workflow || undefined,
    prompt_profile: variant.promptProfile || undefined,
    series_mode: variant.seriesMode || undefined,
    series_id: variant.seriesId || undefined,
    part_number: safeNumber(variant.partNumber, 0) || undefined,
    part_badge: variant.partBadge || undefined,
    target_duration_min_sec: safeNumber(variant.targetDurationMinSec, 0) || undefined,
    target_duration_max_sec: safeNumber(variant.targetDurationMaxSec, 0) || undefined,
    series_pacing: variant.seriesPacing || undefined,
    shared_hook_enabled: variant.seriesMode ? variant.sharedHookEnabled !== false : undefined,
    interleaved_audio_enabled: variant.seriesMode ? variant.interleavedAudioEnabled !== false : undefined,
    cinematic_narrator_enabled: variant.seriesMode ? variant.cinematicNarratorEnabled !== false : undefined,
    cliffhanger_enabled: variant.seriesMode ? variant.cliffhangerEnabled !== false : undefined,
    audio_strategy: variant.audioStrategy || undefined,
    voiceover_enabled: variant.voiceoverEnabled !== false,
    source_narrator_policy: variant.sourceNarratorPolicy || undefined,
    timeline_policy: variant.timelinePolicy || undefined,
    independent_prompt_options: variant.independentPromptOptions || undefined,
    hook_selection_audit: variant.hookSelectionAudit || undefined,
    hook_cold_viewer_test: variant.hookColdViewerTest || undefined,
    hook_transition_test: variant.hookTransitionTest || undefined,
    actor_identity_map: Array.isArray(variant.actorIdentityMap) ? variant.actorIdentityMap : [],
    narrative_contract: variant.narrativeContract || variant.narrative_contract || undefined,
    narration_arc: variant.narrationArc || variant.narration_arc || undefined,
    shared_top_banner_text: variant.sharedTopBannerText || "",
    top_header: variant.topHeader || "",
    top_banner_text: variant.topHeader || "",
    on_screen_elements: Array.isArray(variant.onScreenElements) ? variant.onScreenElements : [],
    story_blueprint: variant.storyBlueprint || variant.story_blueprint || undefined,
    segments: segments.map((segment, index) => {
      const segmentId = segment.id || segment.segmentId || `highlight_${String(index + 1).padStart(4, "0")}`;
      const startSec = Number(safeNumber(segment.startSec ?? segment.outputStartSec).toFixed(3));
      const endSec = Number(safeNumber(segment.endSec ?? segment.outputEndSec).toFixed(3));
      return {
        id: segmentId,
        segmentId,
        evidenceId: segment.evidenceId || "",
        sceneId: segment.sceneId || "",
        sourceRunId: segment.sourceRunId || "",
        macroBlockId: segment.macroBlockId || "",
        sourceStartSec: Number(safeNumber(segment.sourceStartSec).toFixed(3)),
        sourceEndSec: Number(safeNumber(segment.sourceEndSec).toFixed(3)),
        startSec,
        endSec,
        outputStartSec: startSec,
        outputEndSec: endSec,
        playbackSpeed: Number(Math.max(0.1, safeNumber(segment.playbackSpeed, 1)).toFixed(4)),
        scene_type: segment.sceneType || "",
        storyFunction: segment.storyFunction || "",
        narrativePurpose: segment.narrativePurpose || "",
        narrationBeatId: segment.narrationBeatId || "",
        microCutPurpose: segment.microCutPurpose || "none",
        transitionReason: segment.transitionReason || "",
        transitionExplainedBy: segment.transitionExplainedBy || "none",
        bridgePurpose: segment.bridgePurpose || "",
        timelinePhase: segment.timelinePhase || "",
        jargonExplanation: segment.jargonExplanation || "",
        completeNarrativeBeat: segment.completeNarrativeBeat === true,
        completeNarrativeBeatType: segment.completeNarrativeBeatType || "",
        sustainedBeatId: segment.sustainedBeatId || "",
        sustainedBeatOverride: segment.sustainedBeatOverride === true,
        actionSequenceId: segment.actionSequenceId || "",
        actionOverride: segment.actionOverride === true,
        source_narrator_detected: segment.sourceNarratorDetected === true,
        actor_ids: Array.isArray(segment.actorIds) ? segment.actorIds : [],
        primary_actor_id: segment.primaryActorId || "",
        speaker_actor_id: segment.speakerActorId || "",
        original_audio_value_score: safeNumber(segment.originalAudioValueScore, 0),
        original_audio_value_reason: segment.originalAudioValueReason || "",
        original_audio_protected: segment.originalAudioProtected === true,
        audio_mode: segment.audioMode || "original_audio",
        voiceover_text: segment.voiceoverText || "",
        caption: segment.caption || "",
        preview_vi: segment.previewVi || segment.previewSubtitleVi || "",
        visual_layout: segment.visualLayout || segment.visual_layout || "fullscreen",
        caption_emphasis_words: Array.isArray(segment.captionEmphasisWords || segment.caption_emphasis_words)
          ? (segment.captionEmphasisWords || segment.caption_emphasis_words).slice(0, 2)
          : [],
        action_notes: segment.actionNotes || ""
      };
    })
  };
}

function buildDraftTimeline(variant = {}) {
  let cursor = 0;
  const independentEditorialMode = safeText(variant.promptProfile || "independent").toLowerCase() === "independent"
    && variant.seriesMode !== "interleaved_multipart";
  const segments = (variant.segments || []).map((segment, index) => {
    const playbackSpeed = Number(Math.max(0.1, safeNumber(segment.playbackSpeed, 1)));
    const sourceDuration = Math.max(0, safeNumber(segment.sourceEndSec) - safeNumber(segment.sourceStartSec));
    const calculatedDuration = sourceDuration / playbackSpeed;
    const explicitDuration = Number.isFinite(Number(segment.endSec)) && Number.isFinite(Number(segment.startSec)) 
      ? Number(segment.endSec) - Number(segment.startSec) 
      : calculatedDuration;
    const requestedDuration = Math.max(
      0.2,
      safeNumber(segment.duration, explicitDuration)
    );
    const outputStartSec = Number.isFinite(Number(segment.resolvedPreviewStartSec))
      ? Number(segment.resolvedPreviewStartSec)
      : cursor;
    const outputEndSec = Number.isFinite(Number(segment.resolvedPreviewEndSec))
      ? Number(segment.resolvedPreviewEndSec)
      : outputStartSec + safeNumber(segment.fastDraftResolvedTimelineSec, requestedDuration);
    cursor = outputEndSec;
    const voiceText = safeText(segment.voiceoverText);
    const profileWordsPerSecond = Math.max(
      0.8,
      safeNumber(segment.fastDraftVoiceProfileWordsPerSecond, DEFAULT_WORDS_PER_SECOND)
    );
    const voiceTargetDuration = Math.max(0.2, outputEndSec - outputStartSec);
    return {
      segmentIndex: index + 1,
      segmentId: segment.id || `highlight_${String(index + 1).padStart(4, "0")}`,
      sceneId: segment.sceneId || "",
      evidenceId: segment.evidenceId || "",
      outputStartSec: Number(outputStartSec.toFixed(3)),
      outputEndSec: Number(outputEndSec.toFixed(3)),
      outputDurationSec: Number((outputEndSec - outputStartSec).toFixed(3)),
      sourceStartSec: Number(safeNumber(segment.sourceStartSec).toFixed(3)),
      sourceEndSec: Number(safeNumber(segment.sourceEndSec).toFixed(3)),
      playbackSpeed: Number(Math.max(0.1, safeNumber(segment.playbackSpeed, 1)).toFixed(4)),
      audioMode: segment.audioMode || "original_audio",
      voiceoverText: voiceText,
      voiceWordCount: countWords(voiceText),
      measuredVoiceSec: Number(safeNumber(segment.fastDraftVoiceSec).toFixed(3)),
      measuredCoverageRatio: Number(safeNumber(segment.fastDraftFitRatio).toFixed(3)),
      measuredVoiceStatus: segment.fastDraftVoiceStatus || (voiceText ? "unknown" : "not_applicable"),
      measuredWordsPerSecond: Number(profileWordsPerSecond.toFixed(3)),
      targetWordBudget: voiceText
        ? independentEditorialMode
          ? {
            maxWords: Math.ceil(voiceTargetDuration * profileWordsPerSecond * 0.78),
            policy: "maximum_only_no_filler"
          }
          : {
            minWords: Math.floor(voiceTargetDuration * profileWordsPerSecond * 0.9),
            maxWords: Math.ceil(voiceTargetDuration * profileWordsPerSecond * 0.98),
            policy: "fit_window"
          }
        : null,
      previewVi: segment.previewVi || segment.previewSubtitleVi || "",
      actionNotes: segment.actionNotes || ""
    };
  });
  return {
    artifactType: "draft_timeline",
    timelineType: "rendered_output_timeline",
    generatedAt: new Date().toISOString(),
    variantId: variant.id || "variant_01",
    revision: Math.max(1, safeNumber(variant.revisionNumber, 1)),
    totalOutputDurationSec: Number(cursor.toFixed(3)),
    segments
  };
}

function buildReviewContext({
  variant,
  draftTimeline,
  sceneManifest,
  voiceTimingReport,
  resolvedTimeline,
  proxyChunksManifest,
  hookAuditMedia,
  sourceTranscriptSrt,
  transcriptInput,
  semanticDialogueCandidates,
  reviewTarget
}) {
  return {
    artifactType: "gemini_draft_review_context",
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    reviewTarget: reviewTarget || null,
    script: buildScriptJson(variant),
    draftTimeline,
    sceneManifest: sceneManifest || null,
    voiceTimingReport: voiceTimingReport || null,
    resolvedTimeline: resolvedTimeline || null,
    sourceProxyManifest: proxyChunksManifest || null,
    hookAuditMedia: hookAuditMedia || null,
    transcriptInput: transcriptInput || buildTranscriptInput(),
    semanticDialogueCandidates: semanticDialogueCandidates || buildSemanticDialogueCandidates([]),
    ...(safeText(sourceTranscriptSrt) ? { sourceTranscriptSrt } : {})
  };
}

function buildStorySpineReviewPrompt({
  variant,
  draftTimeline,
  sourceProxyFiles = [],
  hasTranscript,
  sourceCoverageComplete = false,
  hookAuditMedia = null
}) {
  const revision = Math.max(1, safeNumber(variant.revisionNumber, 1));
  const reviewTarget = variant.reviewTarget || {};
  const draftDurationSec = safeNumber(draftTimeline?.totalOutputDurationSec, 0);
  const proxyList = sourceProxyFiles.length ? sourceProxyFiles.map((file) => `- ${path.basename(file)}`).join("\n") : "- No source proxy supplied";
  const scriptId = safeNumber(variant.scriptId, 0);
  const audioProfile = scriptId === 1
    ? "Script 1 is narrator-led. Use multiple non-adjacent tool-narration beats that connect the Hook, rewind/context, causal escalation, and Payoff to build a 60/40 Audio Sandwich. You MUST inject narrator voice frequently so that original audio without voiceover NEVER runs continuously for more than 15 seconds."
    : scriptId === 3
    ? "Script 3 is a balanced mini-documentary. Use roughly 40-50% tool narration and preserve decisive authentic source proof."
    : "Script 4 is authenticity-led, not narration-free. Preserve raw audio only when it both carries emotional proof and keeps the story understandable. Every unresolved chronology, location, actor, or causal jump requires a concise bridge; do not chase an audio percentage.";
  const transcriptInputName = safeText(variant.transcriptInputName || "source-transcript.srt");
  return `${buildGeminiInputAccessGate({
    stage: "draft_review_story_spine",
    requiredInputs: [
      "draft-vN.mp4",
      "review-context.json",
      ...(hookAuditMedia ? [hookAuditMedia.file] : []),
      "all supplied source proxy chunks",
      ...(hasTranscript ? [transcriptInputName] : [])
    ]
  })}

You are independently rebuilding a rendered true-crime/bodycam short as a ruthless American TikTok viral retention editor.

REVIEW ORDER - HIGHEST PRIORITY (RUTHLESS VIRAL RETENTION CRITIC):
1. Watch the complete rendered draft from 0.000s to end.
CRITICAL RETENTION CHECKS:
   - 0-3s Hook Drop-off: The first 3 seconds must hit the viewer with immediate absurd conflict, high stakes, or intense action. Flag any slow walking, silent establishing shots, polite greetings, or procedural stalling. If the rendered draft opens weak, you MUST rebuild the Hook.
   - Mid-video Lulls: Flag and eliminate any dead-air/silence > 1.5s or repetitive administrative procedure that halts narrative momentum without new information or reaction.
   - Lingering Outro: Video must cut to black within 2-3s after the payoff/resolution. Flag any lingering after-talk or wandering outro.
   - Viral TikTok Voiceover Style: Voiceover lines must be punchy and high-energy (<= 25 words), in present tense, adopting a sensational, rage-baiting conversational tone that exposes suspect lies. Rewrite any bureaucratic or documentary-style narration.
2. Before judging V${revision}, independently define the strongest edit you would build from the supplied source: Central Viewer Question -> Hook Promise -> minimum rewind context -> causal escalation -> full promised Climax -> immediate Payoff.
3. Independently run a fresh Semantic Hook Tournament across at least five verified candidates: high_action, dialogue_conflict, psychological_wtf, rage_irony, and evidence_reveal. Judge what is actually visible/audible in the first 3 seconds, not the V1 label or local motion/audio rank.
4. Only then compare V${revision} with that ideal. Do not let V${revision} anchor the story.
5. HOOK REPLACEMENT GATE: score the V1 Hook and the strongest source Hook with the same 0-10 rubric. If the source winner exceeds V1 by 1.0 point or more, reviewDecision MUST be "rebuild" and revisedScript MUST use the stronger Hook. A patch/keep decision is invalid in that case.
6. Set reviewDecision="patch" only when the Hook, Story Contract, beat order, promised Climax, and Payoff are already correct and only local trims/wording need changes. Otherwise set reviewDecision="rebuild" and replace the complete beat structure.

${semanticDialogueAuditRules({ hasTranscript, transcriptInputName })}

HOOK TOURNAMENT RUBRIC:
- Score immediateShock, coldViewerClarity, rageOrIrony, payoffPromise, and sourceAudioValue from 0-10, then provide one comparable total score from 0-10.
- high_action automatically fails when the rendered/source first 3 seconds contain only driving, a moving patrol car, camera shake, casual walking, routine vehicle approach, sirens without a visible event, or an establishing shot.
- DISTINGUISH ROUTINE FROM HIGH-FRICTION ACTIONS: Casual walking or opening an ordinary car door is banned filler. BUT high-friction physical actions (e.g., repeatedly rattling a locked door handle, banging on a barricaded entrance, demanding forced entry, taser unholstering, or resisting an order) are Tier-S Hook contenders.
- NO SPOILER HOOKS: Do not select the empty aftermath (e.g., empty room after breach) or an already-handcuffed suspect as the hook if it spoils the central mystery. The hook must establish the open question and tension, not give away the final reveal at second 0.
- action-candidates rank, motionScore, and audioEnergyScore are discovery hints only and cannot justify a Hook.
- State the exact first3SecEvent and exactQuoteOrAction for V1 and every challenger.
- HOOK TRIGGER GATE: the expected rendered draft duration is ${draftDurationSec.toFixed(3)}s. The draft inputAccessAudit entry must cover 0-${draftDurationSec.toFixed(3)}s within 1.0s; 0-0 coverage is a failed review.
${hookAuditMedia ? `- Inspect ${hookAuditMedia.file} directly (do not extract frames or run python scripts). It maps local 0.000s to source ${safeNumber(hookAuditMedia.sourceStartSec).toFixed(3)}s and local ${safeNumber(hookAuditMedia.durationSec).toFixed(3)}s to source ${safeNumber(hookAuditMedia.sourceEndSec).toFixed(3)}s. Populate hookTriggerAudit from this clip, not from scene labels or memory.` : "- No focused Hook audit clip is available. Do not claim sub-second trigger verification; set verifiedAgainstHookAuditClip=false."}
- Set triggerSourceSec to the exact first frame/word containing the selected command, impact, accusation, reveal, or peak action. Maximum setup before trigger is 0.5s. Driving, unbuckling, casual walking, opening an ordinary car door, generic sirens, or routine approach footage does not count as the trigger. Active locked-door rattling, barrier pounding, or sudden refusal does count as a valid trigger.

VIRAL MOMENT INVENTORY:
- Build hookCandidates, interactionGold, and payoffCandidates before rebuilding the timeline.
- Preserve at least one clean verified interactionGold moment when available: a bizarre excuse, contradiction, sharp officer line, confession, audacity, irony, or emotionally revealing exchange.
- Select the payoff that directly answers revisedScript.storyContract.centralViewerQuestion. A generic ending or unrelated legal fact is not a payoff.

STORY COHERENCE GATE:
- Every retained beat advances ONE centralViewerQuestion.
- Every transition has a concrete causal or explanatory link.
- The body returns to the exact Climax promised by the Hook.
- Payoff directly answers the opening question.
- Narration is written as one global arc after beat order is final. It must continue prior knowledge and hand off to the next authentic beat; never describe clips in isolation.
- Interesting but unrelated footage must be removed.

AUDIO EDITORIAL GATE - DECIDE AUDIO BEFORE WRITING NARRATION:
- ${audioProfile}
- original_audio is an intentional editorial choice, not a placeholder. Use it for clean direct dialogue, commands, denials, confessions, reactions, radio calls, impacts, and sustained action that carry the story themselves.
- voiceover_only is only for verified context, a necessary causal/chronology bridge, source-narrator replacement, or payoff information that the pictures/direct dialogue cannot explain.
- voiceover_with_ambient may be used for concise narration over verified clean ambience or non-verbal B-roll. It keeps source ambience at 10-20%, but is forbidden over external narration, participant dialogue, commands, confessions, reactions, radio calls, or indispensable action sound.
- narrationArc is a planning layer; it does NOT mean every Narrative Beat receives voiceoverText.
- For every original_audio beat, voiceoverText MUST be exactly "". Put any planning explanation in summary, advancesViewerQuestion, causalLinkFromPrevious, or actionNotes instead.
- Do not convert all beats to voiceover_only merely to make narration sound continuous. Continuity must alternate connected narration with authentic proof when strong source audio exists.

${scriptId === 1 ? `SCRIPT 1 NARRATOR PRESENCE GATE - HARD EDITORIAL REQUIREMENT:
- revisedScript MUST contain at least two concise, non-adjacent voiceover_only Narrative Beats and a matching narration_arc. This is a functional minimum for the Narrated Raw Reality profile, not a request to fill time.
- At least one voiceover_only beat must perform rewind_context, context, or an indispensable causal/chronology bridge after the Hook and before the promised Climax.
- At least one additional voiceover_only beat must advance escalation, resolve a confusing transition/stake, or deliver a verified Payoff. A later charge/sentence line cannot be the only tool narration.
- Trim long raw ranges to their strongest complete proof. Do not keep 30-60 seconds of routine original audio merely to avoid writing a concise bridge.
- Reject and rebuild revisedScript before responding when it has fewer than two voiceover_only beats, when narration exists only in the final outcome, or when a voiceover beat is not mapped one-to-one to narration_arc through narrationBeatId.` : ""}

NARRATION BLOCK LIMIT - HARD EDITORIAL RULE:
- No continuous tool-generated narration block may exceed 8.0 seconds.
- A source-narrator replacement may extend to 10.0 seconds only when verified context cannot be communicated more briefly and no valuable participant dialogue or action audio exists.
- Never shorten a long narration line while keeping one 30-60 second voiceover_only source range. Split that range into consecutive Narrative Beats: a concise 3-8 second voiceover_only bridge, then an original_audio beat containing the strongest verified quote, command, reaction, discovery, or action, followed by an optional second 3-6 second voiceover_only bridge only when new context is required.
- Two voiceover_only Narrative Beats must never be adjacent. Authentic source proof must separate them.
- Every voiceover_only beat must hand off to a specific source event that proves or advances what the narration introduced.
- Hook and Climax must remain original_audio whenever clean participant dialogue or action sound exists.
- The renderer supports audioMode="voiceover_only", audioMode="voiceover_with_ambient", and audioMode="original_audio". Never output "mix", "mixed_ducking", "original_audio_only", or another invented mode.

TECHNICAL RESPONSIBILITY:
- You select only verified sourceStartSec/sourceEndSec, playbackSpeed, audioMode, voiceoverText, and evidenceIds.
- The local Story Spine Compiler derives output timestamps, technical scene spans, macro-blocks, and renderer fields.
- Narrative Beats may cross consecutive scene boundaries. Never fragment a complete action, exchange, or narration sentence because of scene detection.
- Do not return startSec/endSec/outputStartSec/outputEndSec.
- External source narrator must never remain audible. original_audio is only direct participants/dispatchers/interviews or clean action sound.
- AUDIO CONTRACT - ZERO AMBIGUITY: audioMode="original_audio" requires voiceoverText="". A beat with tool narration uses voiceover_only or voiceover_with_ambient and requires non-empty voiceoverText. sourceNarratorDetected=true always forces voiceover_only. voiceover_with_ambient requires sourceNarratorDetected=false and clean non-verbal source ambience.
- Before returning JSON, inspect every narrativeBeat and repair any audioMode/voiceoverText contradiction. Never place proposed narration text inside an original_audio beat.
- ${hasTranscript ? "Use the supplied transcript for exact spoken lines and boundaries." : "No reliable transcript is available; do not invent dialogue."}
- Source coverage is ${sourceCoverageComplete ? "complete" : "partial"}. Never claim to review footage that is not supplied.

SOURCE PROXIES:
${proxyList}

TRANSITION COVERAGE - TOOL-VERIFIABLE:
- Audit every boundary between Narrative Beats. A non-contiguous source jump is unresolved unless one of these is true: (a) a concise narration beat explains it, (b) direct participant dialogue self-orients the viewer and directDialogueAnchor quotes the exact words, or (c) a concrete visual match exists and visualMatchAnchor names the matching object/action/actor visible on both sides.
- Never label a jump visual_match merely because both beats use original audio. If no concrete anchor exists, insert a 2-6 second connected bridge using voiceover_only or voiceover_with_ambient over verified clean non-verbal footage.
- Bridge count is adaptive. Use exactly the number required to make every jump understandable; no fixed narrator quota and no raw-audio quota.

TEASER-CLIMAX HANDOFF:
- A Hook teaser and later Climax may use the same event, but the Climax must continue from the first important frame not already revealed. Default reprisePolicy="continue_after_teaser" and allow at most 0.5s replay for a smooth handoff.
- Direct timestamp overlap and semantic repetition are separate checks. Even zero-overlap ranges fail when they replay the same approach/setup instead of continuing the promised action.

OUTPUT CONTRACT:
- Return exactly one valid JSON object inside one Markdown json code block, with no prose outside it.
- revisedScript must use this Story Spine schema; do not return renderer segments.
- Copy reviewTarget EXACTLY from review-context.json. Never change reviewedRevision, projectId, variantId, scriptId, draftFile, or reviewBindingId.

{
  "artifactType": "gemini_draft_review",
  "schemaVersion": 2,
  "reviewTarget": ${JSON.stringify(reviewTarget)},
  "inputAccessAudit": { "accessGranted": true, "stage": "draft_review_story_spine", "accessMode": "proxy_multimodal", "expectedDraftDurationSec": ${draftDurationSec.toFixed(3)}, "inspectedInputs": [], "sourceIdentityMatched": true, "timelineCoverageVerified": true, "noGuessingConfirmed": true },
  "semanticQuoteAudit": {
    "transcriptLocation": "${hasTranscript ? transcriptInputName : ""}",
    "fullTranscriptInspected": ${hasTranscript ? "true" : "false"},
    "cueCountInspected": 0,
    "selectedQuotes": [{ "startSec": 0, "endSec": 0, "text": "", "speakerRole": "unknown", "category": "contradiction|entitlement|confession|sarcasm_irony|bizarre_logic|evidence_reveal|legal_consequence|high_conflict", "editorialUse": "hook|escalation|payoff|reject", "visualVerification": "" }],
    "rejectedHighMotionCandidates": [{ "candidateId": "", "reason": "" }]
  },
  "hookTriggerAudit": {
    "hookAuditFile": "${hookAuditMedia?.file || ""}",
    "verifiedAgainstHookAuditClip": ${hookAuditMedia ? "true" : "false"},
    "triggerSourceSec": 0,
    "hookInPointSec": 0,
    "setupBeforeTriggerSec": 0,
    "triggerType": "command|impact|quote|accusation|reveal|peak_action",
    "exactTrigger": "",
    "autoTrimApproved": true
  },
  "teaserClimaxAudit": {
    "teaserEventId": "event_001",
    "climaxEventId": "event_001",
    "reprisePolicy": "continue_after_teaser",
    "climaxResumeSourceSec": 0,
    "allowedReplaySec": 0.5
  },
  "reviewedRevision": ${revision},
  "reviewDecision": "patch|rebuild",
  "review": {
    "scoreBefore": 0,
    "scoreAfterEstimated": 0,
    "summary": "",
    "issues": [{
      "beatId": "beat_001",
      "severity": "warning|error",
      "category": "story_question|hook_promise|causality|climax|payoff|narration_continuity|voice_visual_match|pacing",
      "problem": "",
      "action": "keep|trim|rewrite_voice|replace_beat|remove_beat|rebuild",
      "reason": ""
    }]
  },
  "idealEditAudit": {
    "centralViewerQuestion": "",
    "hookPromise": "",
    "climax": "",
    "payoff": "",
    "whyV1Differs": ""
  },
  "hookReplacementAudit": {
    "v1HookCandidateId": "v1_hook",
    "v1Score": 0,
    "sourceWinnerCandidateId": "hook_candidate_01",
    "sourceWinnerScore": 0,
    "scoreDelta": 0,
    "replacementRequired": false,
    "first3SecComparison": ""
  },
  "viralMomentInventory": {
    "hookCandidates": [{
      "candidateId": "hook_candidate_01",
      "hookType": "high_action|dialogue_conflict|psychological_wtf|rage_irony|evidence_reveal",
      "sourceStartSec": 0,
      "sourceEndSec": 8,
      "evidenceIds": ["evidence_0001"],
      "exactQuoteOrAction": "",
      "first3SecEvent": "",
      "scores": { "immediateShock": 0, "coldViewerClarity": 0, "rageOrIrony": 0, "payoffPromise": 0, "sourceAudioValue": 0, "total": 0 },
      "qualification": "pass|fail",
      "rejectionReason": ""
    }],
    "interactionGold": [],
    "payoffCandidates": []
  },
  "revisedScript": {
    "artifactType": "story_spine_edit_script",
    "schemaVersion": 2,
    "workflow": "manual_gemini_draft_review",
    "scriptId": ${safeNumber(variant.scriptId, 0)},
    "prompt_profile": "independent",
    "title": "",
    "language": "en",
    "sourceLanguage": "en",
    "source_narrator_policy": "forbidden",
    "storyContract": {
      "centralViewerQuestion": "",
      "hookPromise": "",
      "primaryStoryline": "",
      "climax": { "summary": "", "evidenceIds": [], "sourceStartSec": 0, "sourceEndSec": 0 },
      "payoff": { "summary": "", "evidenceIds": [], "sourceStartSec": 0, "sourceEndSec": 0 },
      "causalChain": [""]
    },
    "narrationArc": {
      "openingFrame": "",
      "bridges": [{
        "bridgeId": "bridge_001",
        "previousBeatId": "beat_001",
        "nextBeatId": "beat_002",
        "transitionPurpose": "",
        "voiceoverText": ""
      }],
      "closingAnswer": ""
    },
    "source_narrator_ranges": [],
    "narrativeBeats": [{
      "beatId": "beat_001",
      "sourceStartSec": 0,
      "sourceEndSec": 10,
      "playbackSpeed": 1,
      "storyFunction": "hook|context|escalation|climax|payoff",
      "narrativePurpose": "hook_teaser|rewind_context|cause|escalation|climax_return|aftermath_payoff|indispensable_bridge",
      "summary": "",
      "advancesViewerQuestion": "",
      "causalLinkFromPrevious": "",
      "transitionExplainedBy": "none|voiceover|direct_dialogue|visual_match",
      "bridgePurpose": "none|context|causal|time_jump|payoff",
      "visualMatchAnchor": "Concrete shared visual anchor, required for visual_match",
      "directDialogueAnchor": "Exact self-orienting source words, required for direct_dialogue",
      "actionSequenceId": "",
      "teaserEventId": "",
      "climaxEventId": "",
      "reprisePolicy": "continue_after_teaser|no_reprise",
      "climaxResumeSourceSec": null,
      "relevanceToPrimaryStory": "strong",
      "evidenceIds": ["evidence_0001"],
      "audioMode": "original_audio|voiceover_only|voiceover_with_ambient",
      "voiceoverText": "",
      "sourceAmbientVolume": 0.15,
      "sourceNarratorDetected": false,
      "previewVi": "",
      "actionNotes": ""
    }]
  }
}`;
}

function buildReviewPrompt({
  variant,
  draftTimeline,
  sourceProxyFiles = [],
  hasTranscript,
  sourceCoverageComplete = false
}) {
  const revision = Math.max(1, safeNumber(variant.revisionNumber, 1));
  const transcriptInputName = safeText(variant.transcriptInputName || "source-transcript.srt");
  const isSerialized = variant.seriesMode === "interleaved_multipart";
  const serializedProfile = safeText(variant.promptProfile).toLowerCase() === "serialized_genz"
    ? "serialized_genz"
    : "serialized_interleaved";
  const isSerializedGenZ = isSerialized && serializedProfile === "serialized_genz";
  const isPoliceBlotter = safeText(variant.promptProfile).toLowerCase() === "viral_police_blotter";
  const isViralBodycamPart1 = safeText(variant.promptProfile).toLowerCase() === "viral_tiktok_crime_part1";
  const isDiyStoryRemix = safeText(variant.workflow).toLowerCase() === "diy_story_remix";
  const isIndependent = !isSerialized && !isPoliceBlotter && !isDiyStoryRemix
    && safeText(variant.promptProfile || "independent").toLowerCase() === "independent";
  if (isIndependent) {
    return buildStorySpineReviewPrompt({
      variant,
      draftTimeline,
      sourceProxyFiles,
      hasTranscript,
      sourceCoverageComplete,
      hookAuditMedia: variant.hookAuditMedia || null
    });
  }
  const serializedReviewRules = isSerialized
    ? `SERIALIZED PART REVIEW OVERRIDE - HIGHER PRIORITY THAN GENERIC RESTRUCTURING:
- You are reviewing Part ${safeNumber(variant.partNumber, 1)} of a three-Part serialized case, series_id="${safeText(variant.seriesId)}".
- Preserve prompt_profile="${serializedProfile}", series_mode="interleaved_multipart", part_number, part_badge, series_id, duration bounds, and series pacing in revisedScript.
- ${variant.sharedHookEnabled !== false ? "Preserve the exact shared pure-original-audio hook used by the series. It may last 5-30 seconds when the complete action or confrontation requires it. Trim it immediately before any source narrator begins; never shorten a complete high-value beat merely to fit an obsolete 10-second target." : "Keep a complete source-grounded hook appropriate to this Part."}
- ${variant.interleavedAudioEnabled !== false ? "Preserve the selected Voiceover / Original Audio sandwich rhythm unless a complete quote or causal exchange requires a longer source block." : "Choose audio mode according to story comprehension."}
- Preserve every sustainedBeatOverride=true Complete Narrative Beat as uninterrupted original_audio. Never insert voiceover inside a high-stakes physical, emotional, or verbal conflict merely to satisfy the selected pacing profile.
- ${variant.cliffhangerEnabled !== false && safeNumber(variant.partNumber, 1) < 3 ? "End on a verified unresolved beat that naturally drives the viewer to the next Part. Do not invent a cliffhanger." : "Deliver the verified resolution or final available consequence."}
- SPOILER BAN: Part 1 and Part 2 must not reveal the final plot twist, decisive hidden evidence, test result, formal arrest, court sentence or ultimate legal consequence. Remove any such spoiler introduced by V1. Only Part 3 may deliver those verified reveals. Never repeat the arrest, sentence or final Karma payoff across Parts.
- Part 1 must stop at a verified unresolved confrontation, suspicious lie, request to search or equivalent open question. Part 2 must stop at the strongest verified boiling-point pre-climax turn. Part 3 owns the verified resolution.
- ANTI-HALLUCINATION VISUAL RULE: Do not describe fighting, resisting arrest or a violent struggle unless the rendered/source frames visibly show physical fighting, wrestling, restraint or handcuffs being applied. Keep verbal arguing, crying, blame and tantrums described as what is actually visible.
- Review this Part as one chapter of the same story. Do not convert it into one of the legacy independent Script 1/3/4 profiles.
- Preserve shared_top_banner_text exactly as the one common banner for the complete three-Part story. Do not create a different banner for this Part. Retain part_badge and on_screen_elements as editor metadata. Never claim an overlay was rendered unless it is visibly present in the draft.`
    : "";
  const serializedGenZReviewRules = isSerializedGenZ
    ? `SERIALIZED GEN-Z TONE REVIEW OVERRIDE - HIGHER PRIORITY THAN GENERIC NARRATOR STYLE:
- Keep fast-paced, conversational Gen-Z/Millennial internet English. The narrator sounds like a viewer reacting to a wild verified situation, never a news anchor, documentary host, or police report.
- The first voiceover sentence in this Part must contain a curiosity gap: a question, verified contradiction, or evidence-supported absurdity. Rewrite a flat scene description.
- Use voiceover as the audience's inner voice. React to verified absurdity, add verified hidden context, expose evidence-supported contradictions, or sharpen stakes; never narrate an action that is already obvious on screen.
- Remove formal words including "erratic", "inexplicably", "ironclad", "unprovoked assault", "devastating charges", and "altercation". Replace them with natural casual language without changing the underlying facts.
- Tone and factuality are decoupled: energetic slang is allowed, but every claim remains supported. Do not turn arguing into fighting, refusal into physical resistance, or crying into violence.
- Preserve prompt_profile="serialized_genz" in revisedScript. Do not normalize it back to serialized_interleaved.`
    : "";
  const policeBlotterReviewRules = isPoliceBlotter
    ? `VIRAL POLICE BLOTTER REVIEW OVERRIDE - HIGHER PRIORITY THAN GENERIC PROFILE RULES:
- Preserve prompt_profile="viral_police_blotter" in revisedScript. Do not convert this variant to the default independent or serialized profile.
- Preserve the existing pipeline and Highlight Cut JSON schema.
- The revised script must contain exactly one opening original_audio Hook plus exactly four voiceover_only narrator blocks in this order: Police_Report_Intro, Shocking_Reveal, Moral_Contrast, Specific_Cliffhanger.
- Judge the Hook by actual stopping power in the rendered first 0-3 seconds. It may start mid-exchange when the selected words remain intelligible. Replace a weak Hook with a stronger verified quote/action from the supplied source proxy when available.
- Police_Report_Intro must immediately follow the Hook and state only verified date/location/unit/call reason/initial scene facts. Omit unavailable variables; never invent them.
- Shocking_Reveal must sit immediately before footage that visibly delivers the exact promised discovery. Replace or reorder footage when the draft promises evidence but shows only a talking head or unrelated scene.
- Moral_Contrast must follow the decisive raw confrontation/climax and contrast expected behavior with visible/audible verified behavior. Remove invented motives, diagnoses, remorse, charges, or outcomes.
- Specific_Cliffhanger must be the final segment, name a concrete verified lie/object/witness/dispatch call/document/location/next action, and end before that later source event is revealed. Ban generic endings such as "everything was about to change" or "what happened next shocked everyone".
- Keep exactly four voiceover_only segments after revision. Never place them over indispensable source dialogue, commands, confessions, reactions, radio calls, or action sound.
- Every script remains at least 60.5 seconds. Use relevant source footage rather than filler, freezes, silence, credits, or repeated clips.`
    : "";
  const viralBodycamReviewRules = isViralBodycamPart1
    ? `VIRAL BODYCAM PART 1 / 8-BEAT SANDWICH REVIEW — HIGHEST PRIORITY FOR THIS PROFILE:
- Preserve prompt_profile="viral_tiktok_crime_part1", original scriptId/part_number mapping (1->Part1, 3->Part2, 4->Part3), and 8 LOGICAL audio beats alternating original_audio / voiceover_only. Scene-boundary cuts may split a logical beat into multiple technical segments.
- Judge the REAL source incident, NOT a hostage, house-entry, interrogation, takedown or arrest story invented from template examples. Identify the actual central question, actors, incident, time sequence and consequence from source media/transcript. Rebuild story_blueprint when V1 picked the wrong premise.
- Hook contract: specify what the first 3 rendered seconds make the viewer expect; identify the exact source event and a later within-Part payoff or explicitly source-grounded next-Part question. A later hospital/physical teaser cannot appear only at 0s while the body stops earlier in chronology.
- Part1 and Part2 need their own meaningful verified near-term consequence and a specific next event supported by source evidence. Generic "watch Part2 for the arrest" when no arrest exists is not acceptable. Part3 ends at the strongest FINAL VERIFIED source outcome; do not invent legal charges or convictions.
- For EVERY raw/narrator block establish new information, causal connection to previous block, and relevance to the Part's active viewer question. Remove or shorten routine car interior, administrative waiting, repetitive questioning, irrelevant 911 audio over dead pictures. Never delete a meaningful authentic quote, command or reaction.
- Explicitly bridge source time/location/perspective jumps among dispatch, crash site, roadside, ambulance and hospital. Never join two high-adrenaline events merely because both look dramatic.
- Ending must be understandable and visually/audibly usable for the final 3-5 seconds, with either a within-Part payoff or truthful grounded cliffhanger. Obscured/black camera, unrelated scene switch or unexplained silence does not qualify.
- Headline must match THIS Part's actual Hook and central conflict. When UI decoration carries a misleading shared title, flag it for user adjustment rather than claiming the revised JSON automatically changed an already-rendered banner.
- Target 110–125 seconds of actual output only with VERIFIED meaningful source material; never pad footage to reach duration. Clearly report if this source cannot support the requested profile.
- Wrong Hook, broken causal story, missing payoff or unusable ending requires a FULL revisedScript restructuring; mark review.issues actions replace_scene/remove_segment as needed. Do not limit the repair to narrator/caption polish.
- Review coverage may be partial: do not claim an omitted source moment was inspected unless its proxy is truly supplied.
- OUTPUT A MANDATORY TOP-LEVEL bodycamQualityAudit JSON object with observationWindows covering the entire actual draft in contiguous non-overlapping windows no longer than 8 seconds (last shorter window allowed). Each window MUST contain numeric startSec/endSec and non-empty visibleAction, audibleContent and storyProgress (say "no progress" if static), plus weak:Boolean and reason:String. Timestamps refer to DRAFT output, not source.
- bodycamQualityAudit.hookPromise MUST include promise:String, payoffEvidence:String, payoffSourceSec:Number, resolvedWithinPart:Boolean, verifiedNextPartOpenLoop:Boolean. If an open loop is left for the next Part, give evidence of the later event; never mark a nonexistent event verified.
- bodycamQualityAudit.ending MUST include usableAudio:Boolean, usablePicture:Boolean, grounded:Boolean, sourceEvidence:String. False values are an explicit failure, not a signal to fabricate approval.
- For each observationWindow tagged weak, the V2 timeline must remove, replace or meaningfully shorten that source moment unless direct audiovisual evidence proves it indispensable; mention the corrective choice in review.issues.
- Missing or invented audit fields, fake full coverage, missing Hook evidence, invalid V2 duration, or unwatchable ending cause a local hard quality-gate failure. Never claim publish-ready until the re-rendered V2 has also been inspected.`
    : "";
  const diyStoryReviewRules = isDiyStoryRemix
    ? `DIY STORY REMIX REVIEW OVERRIDE - HIGHER PRIORITY THAN TRUE-CRIME RULES:
- Review this as a DIY transformation story, not a police, crime, suspect, confrontation, or legal-outcome video.
- Preserve workflow="diy_story_remix" and every locked evidenceId/visualBeatId.
- Check object-state continuity: initial state -> operation -> resulting state. The Hook may flash forward, but after returning to the beginning the physical dependency order must remain valid.
- Voiceover must match the exact visible operation and add truthful context or narrative connection. Reject lines that describe a different tool, material, step, state or result.
- Prefer connected storytelling over isolated step descriptions. Every narration line must lead naturally into the next visual block.
- Preserve complete DIY operations as understandable macro-blocks. Do not fragment one continuous action into rapid unrelated cuts.
- Keep source audio only for useful satisfying operation sounds when no source speech is audible. Otherwise use voiceover_only to prevent source narrator overlap.
- Do not invent cost, elapsed time, motivation, skill, ownership, measurements, materials, failure or success.
- Judge the Hook by curiosity and visible transformation stakes, not aggression, profanity, arrests or audio loudness.
- The ending must visibly deliver the promised result or an honestly unresolved source-grounded outcome.`
    : "";
  const independentReviewRules = isIndependent
    ? `THREE INDEPENDENT SCRIPT REVIEW OVERRIDE - APPLY TO SCRIPT 1, SCRIPT 3, AND SCRIPT 4:
${independentReviewOptionRules(variant)}
- Preserve prompt_profile="independent", scriptId, and the selected independent editorial angle. Do not convert the variant into a serialized Part.
- Treat the V1 script and story_blueprint as a hypothesis, not a structure to preserve. You may replace the Hook, rebuild every macro-block, remove working segments, and choose unused source footage when the rendered story is weak.
- STORY SPINE IS THE HIGHEST EDITORIAL PRIORITY. Before examining V1 as an edit, independently identify one central viewer question, the Hook promise, minimum rewind context, escalating causal path, the source climax that fulfills the promise, and the immediate payoff. Then choose the minimum sustained source blocks needed to prove that story.
- NARRATION ARC IS THE CONTINUITY ENGINE. Before revising individual voiceover lines, write one connected narration_arc that carries the same central question through Context, escalation, promised climax, and Payoff. Every voiceover_only segment must reference a narrationBeatId and continue from what the viewer already knows instead of describing its clip in isolation.
- Preferred structure: CLIMAX TEASER / HIGH-STAKES HOOK -> brief rewind/context -> escalating events -> return to the promised climax -> immediate aftermath/payoff.
- Every revised segment must declare narrativePurpose and must advance the central viewer question. Remove footage that is merely interesting, loud, or technically convenient.
- Rebuild and verify actor_identity_map before revising the timeline. Reuse stable actorId values across the source, draft, and revisedScript. Every segment must declare actor_ids, primary_actor_id, and speaker_actor_id. Reject any wording that attaches one person's action, arrest, or consequence to another person.
- Set source_narrator_policy="forbidden". External YouTube hosts, news anchors, documentary narrators, and recap narrators must never remain audible in original_audio.
- The Hook may come from anywhere. It may be one continuous source range or a controlled 1-4 segment montage from separate source ranges when those segments form one understandable shock/threat -> action/line -> reaction/payoff-tease mini-arc. Select it with the user-ranked fallback policy above. It must pass hook_cold_viewer_test: a new viewer understands at least two of actor, conflict, and stake within the first 3 seconds.
- Evaluate the Hook together with the first 15 seconds after it and populate hook_transition_test. If the post-Hook reset introduces different actors, the bridge must explicitly identify their verified relationship and explain the chronology. Generic bridge text does not pass. Prefer a linear-action Hook when a nonlinear Hook creates excessive identity or reset cost.
- Starting mid-exchange is allowed; starting mid-clause with orphaned pronouns, objects, or references is not.
- After the Hook, use minimum Context and order source beats by the causal/emotional logic of storySpine. Chronological order is preferred when equally strong, but backward or forward thematic jumps are allowed when they reveal new information, escalate the same conflict, return to the promised climax, or deliver Payoff.
- Every non-contiguous or backward jump must advance the same central question and contain a concrete transitionReason. Use a voiceover_only narration beat whenever picture/direct dialogue cannot explain the jump immediately. Reject random peak montages and unresolved identity changes.
- Preserve original_audio whenever a clean source range contains an indispensable authentic quote, accusation, denial, confession, command, emotional reaction, impact, radio call, or confrontation. Mark original_audio_protected=true and never replace that range with tool narration. External source narration remains forbidden and is never protected.
- Script 1 must preserve audio_strategy="clean_hybrid" and voiceover_enabled=true. It is narrator-led: use multiple narrator beats to build a 60/40 Audio Sandwich. Dead air (original audio running without narrator) must NEVER exceed 15 seconds. All narrator-covered ranges must use voiceover_only which ducks source audio to 20% volume so ambient sound is preserved.
- Every revised independent script must deliver a verified standalone payoff before ending.`
    : "";
  const timestampGate = isIndependent
    ? `EDITORIAL MACRO-BLOCK TIMESTAMP CONTRACT - INDEPENDENT REVIEW:
- Choose continuous sourceStartSec/sourceEndSec ranges and playbackSpeed only. Omit startSec/endSec/outputStartSec/outputEndSec; the local tool derives and reflows the output timeline.
- One revisedScript segment is one continuous editorial macro-block and may cross consecutive scene-manifest boundaries. Set sceneId to the scene containing sourceStartSec and list all crossed IDs in sceneIds.
- Never split a natural narration sentence, complete exchange, or sustained action merely because scene detection created a boundary.
- Never join non-contiguous source ranges inside one segment. Represent a jump cut or Hook montage as multiple consecutive segments with separate valid ranges.
- A controlled 1.5-4 second micro-cut is allowed for hook_montage, impact, reaction, evidence_insert, visual_proof, contradiction, or climax_punctuation. Populate microCutPurpose. Reject routine/filler micro-cuts and more than three consecutive micro-cuts outside the Hook.`
    : `ONE-SCENE-PER-SEGMENT TIMESTAMP GATE - HIGHEST PRIORITY:
- Every revisedScript segment must satisfy scene.startSec <= sourceStartSec < sourceEndSec <= scene.endSec for exactly one sceneId.
- Never cross a scene-manifest boundary in one JSON segment. Split a logical beat at every boundary, preserve macroBlockId/sourceRunId/actionSequenceId and source order, and divide voiceover into non-duplicated complete phrases.
- Do not return output timeline fields (startSec/endSec/outputStartSec/outputEndSec); the local tool derives them after splitting. A cross-scene segment is an invalid revisedScript.`;
  const mandatoryReviewMethod = isDiyStoryRemix
    ? `MANDATORY REVIEW METHOD - DIY STORY REMIX:
1. Watch the complete draft and judge the first 3 seconds by visual curiosity and transformation stakes.
2. Keep the strongest verified failure, surprising operation or payoff as a short flash-forward Hook when it works.
3. After the Hook, return clearly to the initial state and preserve the physical dependency order of the complete build.
4. Remove dead time, but never cut a meaningful operation before the visible state change becomes understandable.
5. Rewrite or move any voice line that names an object, material, tool, operation or result not visible in its assigned beat.
6. Do not calculate or return startSec/endSec/outputStartSec/outputEndSec or durations. The local tool derives the output timeline from sourceStartSec/sourceEndSec and playbackSpeed.
7. Do not use blank padding, freeze frames or unrelated repeated footage.`
    : isIndependent
    ? `MANDATORY REVIEW METHOD - THREE INDEPENDENT TIKTOK SCRIPTS (RUTHLESS VIRAL RETENTION CRITIC):
1. IDEAL EDIT FIRST - ANTI-ANCHORING: Before judging V1, independently determine the strongest edit you would build from the complete source using this retention pattern: strongest Hook/climax teaser -> minimum necessary rewind/context -> connected narrator-led escalation interrupted by decisive authentic proof -> return to the promised climax -> immediate emotional/factual payoff.
CRITICAL RETENTION CHECKS:
- 0-3s Hook Drop-off: The first 3 seconds must hit the viewer with immediate absurd conflict, high stakes, or intense action. Flag any slow walking, silent establishing shots, polite greetings, or procedural stalling. If V1 opens weak, you MUST rebuild the Hook.
- Mid-video Procedural Lulls: Flag and eliminate dead-air/silence > 1.5s or repetitive administrative procedure that halts narrative momentum without new information or reaction.
- Lingering Outro: Video must cut to black within 2-3s after the payoff/resolution. Flag any lingering after-talk or wandering outro.
- Viral TikTok Voiceover Style: Voiceover lines must be punchy and high-energy (<= 25 words), in present tense, adopting a sensational, rage-baiting conversational tone that exposes suspect lies. Rewrite any bureaucratic or documentary-style narration.
2. Write this ideal structure into revisedScript.story_blueprint.storySpine: centralViewerQuestion, hookPromise, rewindContext, escalationPath, climax, climaxEvidenceIds, payoff, and payoffEvidenceIds. Do not let V1 determine what the story should be.
3. Only after forming the ideal Story Spine, watch the complete draft and compare V1 against it. Search all supplied source coverage and transcript for stronger omitted action, quote, contradiction, reveal, climax, and payoff.
4. Rebuild from scratch when V1 chose the wrong premise, Hook, causal spine, climax, or payoff. Preserve a V1 segment only because it remains the strongest choice, never because it already renders correctly.
5. Replace a weak Hook with the strongest verified action or psychological beat. Use one continuous range when it is strongest, or a controlled 1-4 segment Hook montage when separate verified beats create a clearer and stronger mini-arc.
6. After the Hook, use minimum Context, then move causally toward the promised climax. Thematic nonlinear jumps are allowed only when they advance the same central question and are explicitly bridged; do not abandon it for a secondary legal outcome.
7. Remove dead air, routine procedure, and repetition without cutting a decisive line, physical action, or immediate reaction in half.
8. Audit every original_audio range against source_narrator evidence. Split at the exact narrator boundary only when audio policy requires it; otherwise preserve sustained content across technical scene boundaries.
9. Audit the Hook plus the next 15 seconds as one sequence. Fail and rebuild it when identity/chronology is unclear or when the reset does not begin answering the Hook's question.
10. Audit narration_arc before auditing individual voiceover_only segments. Rewrite disconnected clip descriptions into one continuous story voice. Restore clean original_audio when an authentic quote, command, reaction, impact, or confrontation carries more proof/emotional value, but do not collapse a narrator-led profile back into sparse utility bridges.
10A. SCRIPT 1 NARRATOR PRESENCE: For scriptId=1, reject and rebuild any revision with fewer than two non-adjacent voiceover_only beats, no narrator-led rewind/context before the promised Climax, or narration only in the final legal outcome. Each tool-voice beat must reference a unique valid narrationBeatId.
11. Write narrative_contract from the ideal Story Spine before finalizing the timeline. The Hook promise and primary audience question must match the Story Spine.
12. Place mandatory resolution before later_outcome. FRAME-FIRST VISUAL SCAN / VISUAL-FIRST PAYOFF: independently scrub source frames for the actual rescue, safe victim, removed hazard, recovered object, crash aftermath, or physical evidence even when SRT is empty, quiet, unrelated, or procedural. Transcript density and audio loudness must not choose the payoff. Procedural conversation or casual verbal confirmation cannot replace stronger visual proof.
13. Treat V2 as a structural rebuild when V1 failed Story Spine, stake/payoff, or causal-story gates. Reordering and replacing weak source blocks is required; wording-only cleanup does not pass.
14. Remove or explain low-value police codes, radio shorthand, and procedural jargon. Use bridgePurpose="jargon_clarity" only when necessary.
15. FINAL OUTCOME COMPLETION: When the source verifies a later sentence, legal result, arrest status, or current status, set storySpine.finalOutcomeRequired=true and narrative_contract.secondaryPayoff.required=true/mustBeFinal=true. End the last meaningful segment on that verified outcome. Never stop on a suspect excuse, interview answer, or cliffhanger before it.
16. Reject and rebuild revisedScript if it does not return to the promised climax, fulfill hookPromise, answer centralViewerQuestion, and deliver every required finalOutcome. Each variant remains standalone and at least 60.5 seconds. Return source ranges only; the local tool compiles output timestamps.`
    : `MANDATORY REVIEW METHOD - TIKTOK VIRAL EDITING:
1. Watch the complete draft. Your primary objective is VIEWER RETENTION (0-3 second hook is critical).
2. AGGRESSIVE RESTRUCTURING: Do NOT simply preserve the chronological order. Move the strongest verified retention moment to the first 0-3 seconds (The Hook), even if it breaks the timeline.
   HOOK OVERRIDE CRITERIA (Choose the strongest fit):
   - BARRICADE & PHYSICAL FRICTION OVERRIDE: If the scene features active physical resistance, locked barrier tension, or mystery behind a door/window (e.g., repeatedly rattling a locked door, pounding on a barricaded entrance, refusing entry commands), place this immediately at second 0. It creates intense auditory impact and curiosity without spoiling the payoff.
   - PSYCHOLOGICAL WTF HOOK OVERRIDE: Scan the complete source and transcript for the most psychologically absurd, manipulative, contradictory, entitled, bizarre or shocking soundbite. A seemingly calm but deeply disturbing denial or victim-playing statement may outrank loud profanity, a generic argument or an arrest struggle. Start at the core quote, even mid-sentence, and do not pad backward with polite or procedural lead-in. If an external source narrator follows, cut exactly before the narrator begins and transition to the next block.
   - NO SPOILER HOOK: Never hook with the empty room or final arrest if it ruins the central suspense. Hook the tension/question, not the final answer.
3. VISUAL OVER AUDIO (NO DEAD SCREENS): For 911 calls or radio audio, replace static waveforms or black screens with relevant verified CCTV footage.
4. KILL THE DEAD AIR: remove pauses, silences, or non-essential dialogue longer than 0.5 seconds.
5. PLATFORM SAFETY: Do not show a gunshot visibly hitting a person; cut before impact or use a safe reaction shot.
6. DYNAMIC CAPTIONS: Put 1-2 verified high-impact words in caption_emphasis_words when appropriate.
7. Do not calculate or return startSec/endSec/outputStartSec/outputEndSec or durations. The local tool derives the output timeline from sourceStartSec/sourceEndSec and playbackSpeed.
8. Do not use blank padding or freeze frames to reach 60.5 seconds.`;
  const reviewRubric = isDiyStoryRemix
    ? `REVIEW RUBRIC (0-100):
- 25 points: Hook curiosity and visible transformation stakes.
- 25 points: valid object-state continuity and understandable process.
- 20 points: actual voice/audio pacing with no dead air or clipped speech.
- 20 points: semantic match between narration and visible DIY operation.
- 10 points: visible payoff and clean ending.`
    : isIndependent
    ? `REVIEW RUBRIC (0-100):
- 15 points: Hook and first 3-second stopping power.
- 40 points: one central viewer question, clear Hook promise, causal escalation, return to the promised climax, and immediate payoff.
- 15 points: actor identity and understandable transitions.
- 10 points: actual voice/audio pacing with no dead air, procedural bloat, clipped speech, or unexplained jargon.
- 10 points: semantic match between spoken words and visible action.
- 10 points: visual-first resolution before any secondary later-time outcome.`
    : `REVIEW RUBRIC (0-100):
- 25 points: Hook and first 3-second stopping power.
- 25 points: coherent causal story and understandable transitions.
- 20 points: actual voice/audio pacing with no dead air or clipped speech.
- 20 points: semantic match between spoken words and visible action.
- 10 points: climax, consequence, and clean ending.`;
  const hasSourceProxy = sourceProxyFiles.length > 0;
  const reviewTarget = variant.reviewTarget || {};
  const sourceProxyReference = hasSourceProxy
    ? sourceProxyFiles.length === 1 && sourceProxyFiles[0] === "analysis-proxy.mp4"
      ? "analysis-proxy.mp4"
      : `the supplied source proxy chunks (${sourceProxyFiles.join(", ")})`
    : "the source proxy";
  return `${buildGeminiInputAccessGate({
    stage: "draft_review",
    requiredInputs: ["draft-vN.mp4", "review-context.json", ...(hasSourceProxy ? ["all supplied source proxy chunks"] : []), ...(hasTranscript ? [transcriptInputName] : [])]
  })}

USER TASK INSTRUCTION - REVIEW THE ACTUAL RENDERED DRAFT

You are the independent second-pass reviewer and senior ${isDiyStoryRemix ? "DIY transformation storytelling" : "TikTok true-crime"} editor. Watch draft-v${revision}.mp4 from beginning to end before judging it. This is the actual rendered result, so visual timing, audible pacing, silence, cuts, and voice-to-scene alignment in this video outrank assumptions from the original script.

FILES IN THIS REVIEW PACKAGE:
- draft-v${revision}.mp4: the actual rendered draft to review.
- review-context.json: the combined technical context. Read all keys before editing:
  - script: the exact script used for that draft.
  - draftTimeline: authoritative output timestamps, source mapping, segmentId, measured voice timing, and word budgets.
  - voiceTimingReport: machine-measured TTS duration when available. Treat it as authoritative.
  - sceneManifest: legal source timestamp boundaries.
  - resolvedTimeline: the renderer's resolved timeline when available.
  - sourceProxyManifest: absolute source ranges for supplied proxy chunks when available.
${hasSourceProxy ? `- ${sourceProxyReference}: source footage with sceneId and absolute SOURCE timestamps. Use it when replacing a scene.` : "- No source proxy is available. Do not invent replacement source timestamps."}
${hasSourceProxy ? `- Source replacement coverage: ${sourceCoverageComplete ? "COMPLETE across every available proxy chunk. Search beyond footage already used in V1." : "PARTIAL coverage. You may replace scenes only inside the supplied source ranges; report missing coverage instead of inventing footage."}` : ""}
${hasTranscript ? "- Transcript: use review-context.json.transcriptInput.location as the authoritative location; verify cueCount and sha256 metadata before quote mining." : "- No transcript is available. Do not invent dialogue or legal outcomes."}

${semanticDialogueAuditRules({ hasTranscript, transcriptInputName })}

PRIMARY GOAL:
Create a revised script that is more coherent, more emotionally compelling, and better aligned with the actual pictures and audio while remaining fully source-grounded. ${isViralBodycamPart1 ? "For this selected Bodycam Part profile, target 110–125 seconds of meaningful actual output; 60.5 seconds is NOT the chosen duration." : "The final duration must remain at least 60.5 seconds."} ${isIndependent ? "This is an independent re-edit, not a patch: replace the complete V1 structure whenever a different source selection tells a stronger verified story." : ""}

OUTPUT TIMELINE IS DERIVED, NOT EDITORIAL:
- Choose verified sourceStartSec/sourceEndSec (and playbackSpeed only for a justified speed change; default 1). Do not return output timestamps.
- The local tool will reflow them and its calculation is authoritative.

${timestampGate}

${serializedReviewRules}
${serializedGenZReviewRules}
${policeBlotterReviewRules}
${viralBodycamReviewRules}
${diyStoryReviewRules}
${independentReviewRules}

${isDiyStoryRemix ? `================================================================================
CRITICAL DIY EDITORIAL REVIEW RULES
================================================================================

1. PROCESS TRUTH: Treat the locked Visual Process Map as factual. Never rename a tool, material, object state, operation, failure or result.
2. PHYSICAL CONTINUITY: A flash-forward Hook may preview a later beat once. The body must then return to the initial state and respect every requiredBefore dependency.
3. VISUAL PAYOFF: A narrated promise about a cut, pour, repair, reveal, texture or transformation must be followed by the matching visible operation or result.
4. CONNECTED STORY: Rewrite isolated step descriptions into a causal story. Keep each sentence assigned to the visual beat that proves it.
5. SOURCE AUDIO: Use original_audio only for a useful satisfying sound when sourceSpeechPresent=false. Otherwise use voiceover_only so the selected tool voice remains clean.
6. COMPLETE OPERATIONS: Preserve a continuous operation until its visible state change is understandable. Remove idle time around it, not the proof of change.
7. FACT SAFETY: Do not infer cost, elapsed time, motivation, ownership, skill, measurements, materials, failure or success beyond the locked visual facts.` : `================================================================================
CRITICAL EDITORIAL REVIEW RULES - PROMPT PATCH V3.0
================================================================================

1. ANTI-CLONE VOICEOVER RULE
- The first voiceover_only segment after the shared cold open must serve this Part's unique chapter role, not repeat a generic series introduction.
- Part 1 establishes the verified premise and stakes; Part 2 rapidly bridges the previous chapter into its new verified conflict; Part 3 orients the verified final chapter, consequence, or unresolved question.
- Rewrite a copied or lightly paraphrased opening. Do not introduce an event, motive, charge, or outcome that is absent from the supplied evidence and source.

2. ZERO-TOLERANCE SOURCE NARRATOR FILTER (SUPREME OVERRIDE)
- Do not preserve a third-party YouTube host, news anchor or documentary narrator inside original_audio. The source narrator must never be audible in revisedScript.
- A source_narrator_ranges entry is valid ONLY when direct audiovisual/transcript evidence verifies it and the entry includes non-empty replacementText containing the verified factual meaning. Never output a timestamp-only narrator range. If narrator identity or wording cannot be verified, omit the range and do not guess.
- original_audio requires source_narrator_detected=false, locked sourceNarratorPresent=false, and speech belonging only to direct subjects, officers, suspects, victims, witnesses, interview subjects or dispatchers, or clean authentic action sound.
- This rule overrides sustainedBeatOverride, Complete Narrative Beat, actionOverride, Action Sequence and pacing. If a narrator starts inside a valuable beat, split immediately before that speech and switch to voiceover_only or another verified source timestamp.
- When source narrator and direct character speech overlap and cannot be separated, use voiceover_only for the complete overlapping range, mute the source soundtrack, and recreate only verified factual meaning with the user's selected tool voice.

3. ACTION PAYOFF & VISUAL MATCHING
- Every narrated promise of a chase, escape, weapon, crash, struggle, arrest, or confrontation must be followed immediately by footage that visibly delivers that exact verified action.
- Preserve the matching actionSequenceId as a complete actionOverride/sustainedBeatOverride run. Do not jump from the promise to static aftermath or unrelated footage.

4. NON-REDUNDANT NARRATION
- Remove narration that only repeats an action already obvious in the draft.
- Replacement narration may add only verified context, causal connection, timeline orientation, stakes, background, or consequence supported by the supplied files. Never invent internal thoughts or motives.

5. SCENE BRIDGING & CONTEXT TRANSITIONS
- Identify every major location, time, or story-phase jump that a cold viewer cannot understand.
- Give it a concrete transitionReason and, when the pictures or authentic source dialogue cannot carry the transition, place a concise evidence-grounded voiceover_only bridge immediately before the jump.
- Never interrupt an actionOverride or sustainedBeatOverride sequence to manufacture a bridge; bridge only after the complete beat ends.

6. CRITICAL ANTI-TALKING-HEAD REVIEW & PROCEDURAL BLOAT REVIEW
- Reject a draft that mainly shows interviews, roadside explanations, interrogations, or people describing a major physical event while omitting the actual event available in ${sourceProxyReference}.
- Reject routine administrative footage without intense emotion, contradiction, direct conflict, or unique evidence: officers requesting written statements, collecting phone numbers, spelling names, filling forms, discussing report details, or asking people to visit the station.
- If the title, script, witness dialogue, or source evidence promises a caught-on-camera impact, crash, pursuit, escape, abduction attempt, struggle, weapon draw, or takedown, the revisedScript must include the matching visible action and immediate reaction even when it has no SRT dialogue.
- Do not count testimony about an event as visual payoff. A casual verbal confirmation also cannot replace the actual rescue, safe victim, removed hazard, crash aftermath, or physical evidence when that visual exists in the source. Replace redundant talking-head/procedural footage with that verified visual action or outcome, using actionOverride/sustainedBeatOverride to preserve it.
- VISUAL EVIDENCE OVERRIDE: Perform a frame-first search independent of transcript density and audio energy. A quiet visual proof scene must be selected over louder descriptive dialogue when it resolves the same stake.
- FINAL-OUTCOME AUDIT: Search the complete source/context for a verified sentence, legal result, arrest status, or current status. If one exists, the revised script must end with it after the primary visual payoff. Do not let an interview excuse become the accidental ending.

7. ANTI-HALLUCINATION AND CROSS-CASE CONTAMINATION
- Never fill a missing consequence with a name, charge, plea, sentence, jail term, death, motive, or outcome from memory, another case, a previous draft, an earlier Gemini conversation, or general web knowledge.
- A field named climax, consequence, outcome, or finalPayoff does not require a court sentence. When the supplied source ends at arrest, custody, rescue, medical response, or an ongoing investigation, end there and explicitly leave later legal outcome unestablished.
- Compare every proper name and legal claim in voiceover_text against the supplied source files. Remove it when exact support is absent.`}

${mandatoryReviewMethod}

SOURCE GROUNDING AND VOICE FIT - STILL MANDATORY:
- Identify every concrete issue by segmentId and rendered output timestamp.
- ${(isIndependent || isViralBodycamPart1) ? "Write a fresh story_blueprint from the strongest verified source evidence. Do not preserve the V1 blueprint when its premise, causal chain, Hook, or payoff is weak." : "Preserve the complete story_blueprint from review-context.json -> script unless the revised segment order genuinely requires updating it."} revisedScript must always contain a non-empty story_blueprint.macroBlocks array.
- For independent scripts, rebuild narrative_contract before choosing the final timeline. State the exact promise made by the revised Hook, the primary audience question, the victim/person/object/hazard at stake, and the locked evidence that resolves it. A later arrest, interview, surrender, charge, or sentence does not resolve an earlier victim-safety or physical-hazard question.
- Every narrative_contract.mandatoryResolution.evidenceId must appear in revisedScript before timelinePhase="later_outcome". If V1 skipped that payoff, V2 must structurally rebuild the timeline rather than polish V1 wording.
- Macro-block count, source-jump count, narrator frequency, and audio ratios are descriptive references only. Never preserve weak footage, omit climax/payoff evidence, or add filler merely to meet a number.
- If selected source audio contains police codes, radio shorthand, procedural jargon, or unexplained street callouts, either omit the weak range or add one concise bridgePurpose="jargon_clarity" explanation. Do not preserve a confusing dead zone just because it is loud.
- Every revised segment must retain or provide macroBlockId, sourceRunId, storyFunction and transitionReason. Do not strip structural metadata from an unchanged segment.
- ${isIndependent ? "A technically working V1 segment has no preservation priority. Keep it only when it is still the strongest editorial choice." : "Preserve a working segment unless moving, trimming, or replacing it materially improves retention or continuity."}
- For a voice-to-visual mismatch, first rewrite voiceover_text to match the visible action. Replace footage only when the current visual cannot carry the necessary verified story fact.
- Use only sceneId/sourceStartSec/sourceEndSec verified by scene-manifest.json and ${sourceProxyReference}. Never invent source timestamps.
- ${isIndependent ? "For every voiceover_only segment, obey only targetWordBudget.maxWords from review-context.json -> draftTimeline. There is no minimum word quota; one concise complete sentence is valid." : "For every voiceover_only segment, obey targetWordBudget from review-context.json -> draftTimeline. Machine-measured timing is authoritative."}
- Keep voiceover_text empty for original_audio. ${isDiyStoryRemix ? "Never retain source speech under the tool narration." : "Never mute an indispensable verified quote, command, reaction, impact, radio call, or confession."}
- ${isDiyStoryRemix ? "Do not add unsupported process details, materials, measurements, elapsed time, motives or outcomes." : "Do not add unsupported names, charges, motives, weapons, outcomes, or moral claims."}

${reviewRubric}

OUTPUT CONTRACT - HIGHEST PRIORITY:
- Validate it with JSON.parse before responding.
- Always output the final response as a single, valid JSON object wrapped tightly inside a Markdown code block using \`\`\`json and \`\`\`.
- Do not generate any conversational prose before or after the code block.
- The JSON code block is the complete content to download and save as "gemini-draft-review.json".
- Never include [cite: N], footnotes or source-reference tokens in voiceover_text or any other revisedScript string.
- Copy reviewTarget EXACTLY from review-context.json. Never change reviewedRevision, projectId, variantId, scriptId, draftFile, or reviewBindingId.

REQUIRED ROOT SCHEMA:
{
  "artifactType": "gemini_draft_review",
  "schemaVersion": 1,
  "reviewTarget": ${JSON.stringify(reviewTarget)},
  "inputAccessAudit": { "accessGranted": true, "stage": "draft_review", "accessMode": "proxy_multimodal", "inspectedInputs": [], "sourceIdentityMatched": true, "timelineCoverageVerified": true, "noGuessingConfirmed": true },
  "semanticQuoteAudit": {
    "transcriptLocation": "${hasTranscript ? "Copy review-context.json.transcriptInput.location" : ""}",
    "fullTranscriptInspected": ${hasTranscript ? "true" : "false"},
    "cueCountInspected": 0,
    "selectedQuotes": [{ "startSec": 0, "endSec": 0, "text": "", "speakerRole": "unknown", "category": "contradiction|entitlement|confession|sarcasm_irony|bizarre_logic|evidence_reveal|legal_consequence|high_conflict", "editorialUse": "hook|escalation|payoff|reject", "visualVerification": "" }],
    "rejectedHighMotionCandidates": [{ "candidateId": "", "reason": "" }]
  },
  "reviewedRevision": ${revision},
  ${isViralBodycamPart1 ? `"bodycamQualityAudit": {
    "observationWindows": [{"startSec":0,"endSec":8,"visibleAction":"observable action","audibleContent":"actual speech or quiet ambience","storyProgress":"specific new event or no progress","weak":false,"reason":""}],
    "hookPromise":{"promise":"","payoffEvidence":"","payoffSourceSec":0,"resolvedWithinPart":false,"verifiedNextPartOpenLoop":false},
    "ending":{"usableAudio":false,"usablePicture":false,"grounded":false,"sourceEvidence":""}
  },` : ""}
  "review": {
    "scoreBefore": 0,
    "scoreAfterEstimated": 0,
    "summary": "",
    "strengths": [""],
    "issues": [
      {
        "segmentId": "highlight_0001",
        "outputStartSec": 0,
        "outputEndSec": 0,
        "severity": "warning|error",
        "category": "hook|continuity|voice_timing|voice_visual_match|source_audio|grounding|ending",
        "problem": "",
        "action": "keep|rewrite_voice|replace_scene|extend_source|trim_source|remove_segment",
        "reason": ""
      }
    ]
  },
  "revisedScript": {
    "artifactType": "highlight_cut_script",
    "workflow": "${safeText(variant.workflow)}",
    "scriptId": ${safeNumber(variant.scriptId, 0)},
    "prompt_profile": "${isSerialized ? serializedProfile : safeText(variant.promptProfile)}",
    "series_mode": "${isSerialized ? "interleaved_multipart" : safeText(variant.seriesMode)}",
    "series_id": "${safeText(variant.seriesId)}",
    "part_number": ${safeNumber(variant.partNumber, 0)},
    "part_badge": "${safeText(variant.partBadge)}",
    "title": "",
    "language": "en",
    "sourceLanguage": "en",
    "total_target_sec": 60.5,
    "style": "${isDiyStoryRemix ? "DIY Story Remix" : "True Crime Bodycam Highlight"}",
    "target_duration_min_sec": ${safeNumber(variant.targetDurationMinSec, 60.5)},
    "target_duration_max_sec": ${safeNumber(variant.targetDurationMaxSec, 120)},
    "series_pacing": "${safeText(variant.seriesPacing)}",
    "shared_hook_enabled": ${isSerialized ? variant.sharedHookEnabled !== false : false},
    "interleaved_audio_enabled": ${isSerialized ? variant.interleavedAudioEnabled !== false : false},
    "cinematic_narrator_enabled": ${isSerialized ? variant.cinematicNarratorEnabled !== false : false},
    "cliffhanger_enabled": ${isSerialized ? variant.cliffhangerEnabled !== false : false},
    "shared_top_banner_text": "${safeText(variant.sharedTopBannerText).replace(/"/g, "'")}",
    "top_banner_text": "${safeText(variant.topHeader).replace(/"/g, "'")}",
    "source_narrator_policy": "${isIndependent ? "forbidden" : safeText(variant.sourceNarratorPolicy)}",
    "timeline_policy": "${isIndependent ? "story_driven_non_linear_with_explicit_bridges" : safeText(variant.timelinePolicy)}",
    "independent_prompt_options": ${JSON.stringify(isIndependent ? (variant.independentPromptOptions || {}) : null, null, 2)},
    "hook_selection_audit": ${isIndependent ? `{
      "requestedPriority": ${JSON.stringify(Array.isArray(variant.independentPromptOptions?.hookPriority) ? variant.independentPromptOptions.hookPriority : INDEPENDENT_HOOK_TYPES)},
      "selectedType": "high_action|dialogue_conflict|psychological_wtf|evidence_reveal",
      "fallbackLevel": 1,
      "selectedEvidenceIds": ["evidence_0001"],
      "reason": "",
      "rejectedHigherPriorityCandidates": []
    }` : "null"},
    "hook_cold_viewer_test": {
      "passes": true,
      "first3SecQuoteOrAction": "",
      "identifiedActor": "",
      "identifiedConflict": "",
      "identifiedStake": "",
      "contextSource": "audio|visual|top_header",
      "reason": ""
    },
    "hook_transition_test": {
      "passes": true,
      "hookActorIds": ["actor_001"],
      "postHookActorIds": ["actor_001", "actor_002"],
      "timelineResetUsed": true,
      "relationshipExplained": true,
      "bridgeText": "",
      "first15SecCausalLink": "",
      "reason": ""
    },
    "actor_identity_map": [{
      "actorId": "actor_001",
      "displayLabel": "Verified name or stable descriptive label",
      "visualIdentity": "Visible source-grounded identity cues",
      "role": "officer|suspect|victim|witness|dispatcher|parent|relative|unknown",
      "aliases": [],
      "relationshipFacts": [],
      "firstSeenSec": 0,
      "confidence": 0.95
    }],
    "narrative_contract": {
      "hookPromise": "Exact promise made by the revised Hook",
      "primaryAudienceQuestion": "The one concrete question a cold viewer expects this edit to answer",
      "primaryStakeType": "victim_safety|physical_hazard|evidence_reveal|suspect_outcome|legal_outcome|other",
      "stakeActorIds": ["actor_001"],
      "mandatoryResolution": {
        "required": true,
        "resolutionType": "victim_resolution|hazard_resolution|evidence_resolution|suspect_resolution|legal_resolution",
      "evidenceIds": ["evidence_0002"],
      "preferredVisualEvidenceIds": ["evidence_0003"],
      "fallbackVerbalEvidenceIds": ["evidence_0002"],
      "visualFirstRequired": true,
      "mustAppearBeforeLaterTimeJump": true,
        "verifiedOutcome": "Exact source-grounded answer"
      },
      "secondaryPayoff": {
        "required": true,
        "mustBeFinal": true,
        "question": "",
        "evidenceIds": [],
        "verifiedOutcome": ""
      }
    },
    "on_screen_elements": [],
    "narration_arc": ${isIndependent ? `{
      "openingFrame": "",
      "beats": [{
        "narrationBeatId": "narration_001",
        "priorKnowledge": "",
        "newInformation": "",
        "setupForNext": "",
        "handoffToOriginalAudio": "",
        "spoilerGuard": ""
      }],
      "closingAnswer": ""
    }` : "null"},
    "story_blueprint": {
      "centralCharacter": "",
      "primaryConflict": "",
      "audienceQuestion": "",
      "storySpine": {
        "centralViewerQuestion": "",
        "hookPromise": "",
        "rewindContext": "",
        "escalationPath": [""],
        "climax": "",
        "climaxEvidenceIds": ["evidence_0002"],
        "payoff": "",
        "payoffEvidenceIds": ["evidence_0003"],
        "finalOutcomeRequired": true,
        "finalOutcome": "",
        "finalOutcomeEvidenceIds": ["evidence_0004"]
      },
      "setup": "",
      "escalation": "",
      "climax": "",
      "consequence": "",
      "finalPayoff": "",
      "macroBlocks": [
        {
          "macroBlockId": "macro_hook_01",
          "storyFunction": "hook",
          "sourceRunIds": ["source_run_hook_001"],
          "summary": ""
        }
      ]
    },
    "segments": [
      {
        "id": "highlight_0001",
        "segmentId": "highlight_0001",
        "evidenceId": "evidence_0001",
        "sceneId": "scene_0001",
        ${isIndependent ? '"sceneIds": ["scene_0001", "scene_0002"],' : ""}
        "sourceRunId": "source_run_hook_001",
        "macroBlockId": "macro_hook_01",
        "sourceStartSec": 0,
        "sourceEndSec": 5,
        "playbackSpeed": 1,
        "scene_type": "Hook_Original_Audio",
        "storyFunction": "${isDiyStoryRemix ? "hook|setup|process|obstacle|fix|payoff" : "hook|context|escalation|climax|consequence"}",
        "narrativePurpose": "${isIndependent ? "hook_teaser|rewind_context|context|escalation|climax_return|aftermath_payoff|indispensable_bridge" : ""}",
        "narrationBeatId": "${isIndependent ? "narration_001 or empty for original_audio" : ""}",
        "microCutPurpose": "${isIndependent ? "none|hook_montage|impact|reaction|evidence_insert|visual_proof|contradiction|climax_punctuation" : "none"}",
        "transitionReason": "",
        "transitionExplainedBy": "none|voiceover|direct_dialogue|visual_match",
        "bridgePurpose": "none|context|causal|stake_resolution|time_jump|jargon_clarity|payoff",
        "timelinePhase": "hook|immediate_event|immediate_resolution|later_outcome",
        "jargonExplanation": "",
        "completeNarrativeBeat": true,
        "completeNarrativeBeatType": "physical_action|emotional_conflict|verbal_conflict|none",
        "sustainedBeatId": "sustained_beat_001",
        "sustainedBeatOverride": true,
        "actionSequenceId": "action_sequence_001",
        "actionOverride": false,
        "source_narrator_detected": false,
        "actor_ids": ["actor_001"],
        "primary_actor_id": "actor_001",
        "speaker_actor_id": "actor_001",
        "original_audio_value_score": 9,
        "original_audio_value_reason": "Exact authentic line, reaction, command, or sound worth preserving",
        "original_audio_protected": true,
        "audio_mode": "original_audio|voiceover_only",
        "voiceover_text": "",
        "caption": "",
        "preview_vi": "",
        "visual_layout": "fullscreen",
        "caption_emphasis_words": [],
        "action_notes": ""
      }
    ]
  }
}

The revisedScript.segments array must contain the complete final script, not a patch and not only changed segments. Preserve stable segment IDs whenever possible. id and segmentId must be identical. Do not return derived output timeline fields (startSec/endSec/outputStartSec/outputEndSec); the tool compiles them. visual_layout and caption_emphasis_words are required for every segment. visual_layout must be exactly one of fullscreen, split_screen_911, or blur_censored; never return the pipe-separated schema example as a literal value. caption_emphasis_words must contain zero to two exact words or short phrases that also appear in action_notes.`;
}

const {
  planReviewEvidenceReel,
  buildReviewEvidenceReel,
  buildEvidenceReelPromptBlock
} = require("./reviewEvidenceReelService");

async function loadSourceUnderstandingForPack(manualPack) {
  if (!manualPack) return null;
  const runInfo = await readJsonIfAvailable(path.join(manualPack, "01-ANTIGRAVITY-RESULT", "antigravity-run-info.json"));
  const cachePath = runInfo?.sourceUnderstanding?.cachePath;
  if (!cachePath) return null;
  const envelope = await readJsonIfAvailable(cachePath);
  return envelope?.artifactType === "source_understanding_cache" ? envelope.data : null;
}

// Sources up to this length are reviewed against the complete proxy (full
// coverage costs no more than an evidence reel would).
const FULL_PROXY_REVIEW_MAX_SEC = 360;

class GeminiDraftReviewService {
  constructor(projectStore) {
    this.projectStore = projectStore;
  }

  async createPackage({ workspaceRoot, projectId, settings = {} }) {
    const packageStartedAt = Date.now();
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    if (project.mode !== "highlight_cut") {
      throw new Error("Gói Gemini Draft Review hiện chỉ hỗ trợ Highlight Cut.");
    }
    const variant = getActiveVariant(project);
    if (!variant) throw new Error("Project chưa có variant Highlight để review.");
    const draftPath = await existingFile([
      variant.artifacts?.fastDraftVideoPath,
      project.artifacts?.fastDraftVideoPath,
      project.analysis?.artifacts?.fastDraftVideoPath
    ]);
    if (!draftPath) {
      throw new Error("Chưa có video draft của variant đang chọn. Hãy render nháp nhanh trước.");
    }

    const revision = Math.max(1, safeNumber(variant.revisionNumber, 1));
    const projectPaths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const analysisDir = projectPaths.analysisDir;
    const packageRoot = project.manualGeminiPackPath
      || path.join(projectPaths.rootDir, "gemini-draft-review");
    const reviewDir = path.join(
      packageRoot,
      "02-DRAFT-REVIEW",
      `${sanitizeFilePart(variant.id)}-v${revision}-${compactTimestamp()}`
    );
    await fs.mkdir(reviewDir, { recursive: true });
    const uploadDir = path.join(reviewDir, "01-UPLOAD-TO-GEMINI");
    await fs.rm(uploadDir, { recursive: true, force: true });
    await fs.mkdir(uploadDir, { recursive: true });

    const manualPack = project.manualGeminiPackPath || "";
    const manualPackageInfo = await readJsonIfAvailable(manualPack && path.join(manualPack, "package-info.json"));
    const pass1Dir = manualPackageInfo?.pass1UploadDir
      || (manualPack ? path.join(manualPack, "01-GUI-GEMINI") : "");
    const proxyChunksManifestPath = await existingFile([
      manualPackageInfo?.proxyChunksManifestPath,
      pass1Dir && path.join(pass1Dir, "proxy-chunks-manifest.json")
    ]);
    const proxyChunksManifest = await readJsonIfAvailable(proxyChunksManifestPath);
    const allProxyChunks = Array.isArray(proxyChunksManifest?.chunks) ? proxyChunksManifest.chunks : [];
    // Full proxy with burned sceneId + SOURCE timestamps (for chunked packages it
    // lives in the persistent cache as analysis-proxy-<key>.mp4).
    const fullProxyPath = await existingFile([
      pass1Dir && path.join(pass1Dir, "analysis-proxy.mp4"),
      manualPack && path.join(manualPack, "analysis-proxy.mp4"),
      manualPackageInfo?.proxyPath,
      project.analysis?.artifacts?.sourceProxyPath,
      project.artifacts?.sourceProxyPath,
      path.join(analysisDir, "auto-story", "overview-v1.mp4"),
      path.join(analysisDir, "analysis-proxy.mp4")
    ]);
    const sceneManifestForReel = await readJsonIfAvailable(await existingFile([
      pass1Dir && path.join(pass1Dir, "scene-manifest.json"),
      manualPack && path.join(manualPack, "scene-manifest.json"),
      project.analysis?.artifacts?.sceneManifestPath,
      project.artifacts?.sceneManifestPath
    ]));
    const sourceDurationSec = safeNumber(sceneManifestForReel?.videoDurationSec, safeNumber(proxyChunksManifest?.sourceDurationSec, 0));
    // Evidence selection: complete proxy for short sources; otherwise a real
    // evidence reel; whole proxy chunks only as a controlled fallback.
    let evidenceMode = "none";
    let evidenceReel = null;
    let evidenceReelWarning = "";
    let sourceProxy = "";
    let selectedProxyChunks = [];
    const useFullProxy = Boolean(fullProxyPath) && (!allProxyChunks.length) && (!sourceDurationSec || sourceDurationSec <= FULL_PROXY_REVIEW_MAX_SEC);
    if (useFullProxy) {
      sourceProxy = fullProxyPath;
      evidenceMode = "full_proxy";
    } else if (fullProxyPath || project.sourceVideoPath) {
      try {
        const hookCandidatesData = await readJsonIfAvailable(await existingFile([
          manualPackageInfo?.hookCandidatesPath,
          pass1Dir && path.join(pass1Dir, "hook-candidates.json")
        ]));
        const actionCandidatesData = await readJsonIfAvailable(await existingFile([
          manualPackageInfo?.actionCandidatesPath,
          pass1Dir && path.join(pass1Dir, "action-candidates.json")
        ]));
        // Semantic candidates from the persisted Phase A source understanding
        // (when Stage 1 ran with Antigravity) outrank motion/audio radar candidates.
        const understanding = await loadSourceUnderstandingForPack(manualPack);
        const understandingHooks = (Array.isArray(understanding?.hookCandidates) ? understanding.hookCandidates : [])
          .slice()
          .sort((left, right) => safeNumber(right.strength, 0) - safeNumber(left.strength, 0));
        const understandingReplacements = [
          ...(Array.isArray(understanding?.climaxCandidates) ? understanding.climaxCandidates : []),
          ...(Array.isArray(understanding?.consequenceCandidates) ? understanding.consequenceCandidates : []),
          ...(Array.isArray(understanding?.interrogationCandidates) ? understanding.interrogationCandidates : [])
        ].map((item) => ({ ...item, actionPriorityScore: 100 }));
        const plan = planReviewEvidenceReel({
          segments: variant.segments || [],
          hookCandidates: [
            ...understandingHooks,
            ...(Array.isArray(hookCandidatesData?.topCandidates) ? hookCandidatesData.topCandidates : [])
          ],
          actionCandidates: [
            ...understandingReplacements,
            ...(Array.isArray(actionCandidatesData?.candidates) ? actionCandidatesData.candidates : [])
          ],
          sourceDurationSec,
          options: settings.reviewEvidenceReel || {}
        });
        evidenceReel = await buildReviewEvidenceReel({
          sourcePath: fullProxyPath || project.sourceVideoPath,
          outputDir: uploadDir,
          plan,
          settings,
          sourceVideo: path.basename(project.sourceVideoPath || ""),
          sourceDurationSec,
          sourceHasBurnedTimestamps: Boolean(fullProxyPath)
        });
        evidenceMode = "evidence_reel";
      } catch (error) {
        evidenceReel = null;
        evidenceReelWarning = `Không tạo được review-evidence-reel.mp4 (${error.message}); dùng proxy chunk dự phòng.`;
      }
    }
    if (!evidenceReel && !sourceProxy) {
      selectedProxyChunks = selectReviewProxyChunks(proxyChunksManifest, variant.segments, 6);
      if (selectedProxyChunks.length) {
        evidenceMode = "proxy_chunks_fallback";
      } else if (fullProxyPath) {
        sourceProxy = fullProxyPath;
        evidenceMode = "full_proxy_fallback";
      }
    }
    const manifestPath = await existingFile([
      pass1Dir && path.join(pass1Dir, "scene-manifest.json"),
      manualPack && path.join(manualPack, "scene-manifest.json"),
      project.analysis?.artifacts?.sceneManifestPath,
      project.artifacts?.sceneManifestPath,
      path.join(analysisDir, "scene-manifest.json"),
      path.join(analysisDir, "auto-story", "scene-manifest.json")
    ]);
    const transcriptPath = await existingFile([
      pass1Dir && path.join(pass1Dir, "source-transcript.srt"),
      manualPack && path.join(manualPack, "source-transcript.srt"),
      project.analysis?.artifacts?.sourceTranscriptPath,
      project.artifacts?.sourceTranscriptPath,
      path.join(analysisDir, "source-transcript.srt"),
      path.join(analysisDir, "auto-story", "source-transcript.srt")
    ]);
    const voiceReportPath = await existingFile([
      variant.artifacts?.fastDraftVoiceWarningReportPath,
      project.artifacts?.fastDraftVoiceWarningReportPath,
      project.analysis?.artifacts?.fastDraftVoiceWarningReportPath
    ]);
    const resolvedTimelinePath = await existingFile([
      variant.artifacts?.fastDraftResolvedTimelinePath,
      project.artifacts?.fastDraftResolvedTimelinePath,
      project.analysis?.artifacts?.fastDraftResolvedTimelinePath
    ]);

    const scriptPath = path.join(reviewDir, `script-v${revision}.json`);
    const timelinePath = path.join(reviewDir, "draft-timeline.json");
    const promptPath = path.join(uploadDir, "gemini-draft-review-prompt.txt");
    const packageInfoPath = path.join(reviewDir, "review-package-info.json");
    const dialogueCandidatesPath = path.join(reviewDir, "dialogue-candidates.json");
    const draftTarget = path.join(uploadDir, `draft-v${revision}.mp4`);
    const contextPath = path.join(uploadDir, "review-context.json");
    const draftTimeline = buildDraftTimeline(variant);
    const reviewTarget = buildReviewBinding({ projectId, variant, revision, draftTimeline });
    const hookSegments = (Array.isArray(variant.segments) ? variant.segments : [])
      .filter((segment, index, all) => {
        if (index === 0) return safeText(segment.storyFunction || segment.sceneType).toLowerCase() === "hook";
        return safeText(segment.storyFunction || segment.sceneType).toLowerCase() === "hook"
          && all.slice(0, index).every((item) => safeText(item.storyFunction || item.sceneType).toLowerCase() === "hook");
      });
    const hookSourceStartSec = hookSegments.length
      ? Math.min(...hookSegments.map((segment) => safeNumber(segment.sourceStartSec, Infinity)))
      : NaN;
    const hookSourceEndSec = hookSegments.length
      ? Math.max(...hookSegments.map((segment) => safeNumber(segment.sourceEndSec, -Infinity)))
      : NaN;
    let hookAuditMedia = null;
    if (Number.isFinite(hookSourceStartSec) && Number.isFinite(hookSourceEndSec) && hookSourceEndSec > hookSourceStartSec) {
      const durationSec = Math.min(35, hookSourceEndSec - hookSourceStartSec);
      const file = `hook-audition-source-${hookSourceStartSec.toFixed(3)}.mp4`;
      const outputPath = path.join(uploadDir, file);
      try {
        const ffmpeg = new FfmpegService(settings);
        await ffmpeg.extractFastPreviewClipWithAudio({
          sourcePath: project.sourceVideoPath,
          outputPath,
          startSec: hookSourceStartSec,
          durationSec,
          width: 720
        });
        hookAuditMedia = {
          file,
          role: "hook_audition",
          sourceStartSec: Number(hookSourceStartSec.toFixed(3)),
          sourceEndSec: Number((hookSourceStartSec + durationSec).toFixed(3)),
          durationSec: Number(durationSec.toFixed(3)),
          localTimeFormula: "triggerSourceSec = sourceStartSec + localTriggerSec"
        };
      } catch (_error) {
        hookAuditMedia = null;
      }
    }
    const scriptJson = buildScriptJson({
      ...variant,
      sharedTopBannerText: project.analysis?.sharedTopBannerText || ""
    });
    await Promise.all([
      linkOrCopy(draftPath, draftTarget),
      fs.writeFile(scriptPath, JSON.stringify(scriptJson, null, 2), "utf8"),
      fs.writeFile(timelinePath, JSON.stringify(draftTimeline, null, 2), "utf8")
    ]);
    const sourceProxyFiles = [];
    if (evidenceReel) {
      sourceProxyFiles.push(path.basename(evidenceReel.reelPath));
    } else if (sourceProxy) {
      await linkOrCopy(sourceProxy, path.join(uploadDir, "analysis-proxy.mp4"));
      sourceProxyFiles.push("analysis-proxy.mp4");
    } else if (selectedProxyChunks.length) {
      for (const chunk of selectedProxyChunks) {
        const chunkSource = await existingFile([
          chunk.uploadRelativePath && pass1Dir && path.join(pass1Dir, chunk.uploadRelativePath),
          pass1Dir && path.join(pass1Dir, chunk.file)
        ]);
        if (!chunkSource) continue;
        await linkOrCopy(chunkSource, path.join(uploadDir, chunk.file));
        sourceProxyFiles.push(chunk.file);
      }
    }
    const transcriptText = transcriptPath ? await fs.readFile(transcriptPath, "utf8") : "";
    const transcriptCues = parseSrtCues(transcriptText);
    const semanticDialogueCandidates = buildSemanticDialogueCandidates(transcriptCues);
    const embedTranscriptInContext = Boolean(hookAuditMedia && transcriptPath && selectedProxyChunks.length >= 6);
    const sourceTranscriptSrt = embedTranscriptInContext ? transcriptText : "";
    const transcriptInput = buildTranscriptInput({ transcriptText, embedded: embedTranscriptInContext });
    await fs.writeFile(dialogueCandidatesPath, JSON.stringify(semanticDialogueCandidates, null, 2), "utf8");
    if (transcriptPath && !embedTranscriptInContext) {
      await linkOrCopy(transcriptPath, path.join(uploadDir, "source-transcript.srt"));
    }
    const sourceCoverageComplete = !evidenceReel && (Boolean(sourceProxy)
      || (allProxyChunks.length > 0 && selectedProxyChunks.length === allProxyChunks.length));
    const selectedProxyManifest = evidenceReel ? evidenceReel.manifest : selectedProxyChunks.length ? {
      ...proxyChunksManifest,
      reviewSelectionOnly: !sourceCoverageComplete,
      sourceCoverageComplete,
      chunks: selectedProxyChunks.map((chunk) => ({
        ...chunk,
        uploadBatch: undefined,
        uploadRelativePath: chunk.file
      }))
    } : null;
    await fs.writeFile(contextPath, JSON.stringify(buildReviewContext({
      variant: {
        ...variant,
        sharedTopBannerText: project.analysis?.sharedTopBannerText || ""
      },
      draftTimeline,
      sceneManifest: await readJsonIfAvailable(manifestPath),
      voiceTimingReport: await readJsonIfAvailable(voiceReportPath),
      resolvedTimeline: await readJsonIfAvailable(resolvedTimelinePath),
      proxyChunksManifest: selectedProxyManifest,
      hookAuditMedia,
      sourceTranscriptSrt,
      transcriptInput,
      semanticDialogueCandidates,
      reviewTarget
    }), null, 2), "utf8");
    const reviewPromptText = buildReviewPrompt({
      variant: {
        ...variant,
        reviewTarget,
        hookAuditMedia,
        transcriptInputName: embedTranscriptInContext
          ? "review-context.json.sourceTranscriptSrt"
          : "source-transcript.srt",
        sharedTopBannerText: project.analysis?.sharedTopBannerText || ""
      },
      draftTimeline,
      sourceProxyFiles,
      hasTranscript: Boolean(transcriptPath),
      sourceCoverageComplete
    });
    await fs.writeFile(
      promptPath,
      evidenceReel ? `${reviewPromptText}\n\n${buildEvidenceReelPromptBlock(evidenceReel.manifest)}` : reviewPromptText,
      "utf8"
    );
    const ffprobe = new FfmpegService(settings);
    const draftDurationSec = safeNumber((await ffprobe.probeVideo(draftTarget).catch(() => null))?.duration, safeNumber(draftTimeline.totalOutputDurationSec, 0));
    const sourceEvidenceSec = evidenceReel
      ? safeNumber(evidenceReel.manifest.reelDurationSec, 0)
      : sourceProxy
        ? safeNumber((await ffprobe.probeVideo(sourceProxy).catch(() => null))?.duration, sourceDurationSec)
        : selectedProxyChunks.reduce((sum, chunk) => sum + safeNumber(chunk.durationSec, safeNumber(chunk.sourceEndSec) - safeNumber(chunk.sourceStartSec)), 0);
    const reviewInputVideoDurationSec = Number((draftDurationSec + sourceEvidenceSec + safeNumber(hookAuditMedia?.durationSec, 0)).toFixed(3));
    const uploadFiles = (await fs.readdir(uploadDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    if (uploadFiles.length > 10) {
      throw new Error(`Gói review có ${uploadFiles.length} file, vượt giới hạn 10 file của Gemini.`);
    }
    await fs.writeFile(packageInfoPath, JSON.stringify({
      artifactType: "gemini_draft_review_package",
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      projectId,
      variantId: variant.id,
      revision,
      reviewTarget,
      packageRoot: reviewDir,
      uploadDir,
      uploadFileCount: uploadFiles.length,
      uploadFiles,
      draftPath: draftTarget,
      promptPath,
      scriptPath,
      timelinePath,
      contextPath,
      sourceProxyIncluded: sourceProxyFiles.length > 0,
      sourceProxyFiles,
      proxyChunkCount: sourceProxyFiles.length,
      sourceCoverageComplete,
      evidenceMode,
      evidenceReelPath: evidenceReel?.reelPath || "",
      evidenceReelManifestPath: evidenceReel?.manifestPath || "",
      evidenceReelWarning,
      inputVideo: {
        draftDurationSec: Number(draftDurationSec.toFixed(3)),
        sourceEvidenceSec: Number(sourceEvidenceSec.toFixed(3)),
        hookAuditionSec: safeNumber(hookAuditMedia?.durationSec, 0),
        totalSec: reviewInputVideoDurationSec
      },
      packageMs: Date.now() - packageStartedAt,
      hookAuditMedia,
      transcriptIncluded: Boolean(transcriptPath),
      transcriptEmbeddedInContext: embedTranscriptInContext,
      transcriptInput,
      dialogueCandidatesPath,
      dialogueCandidatesEmbeddedInContext: true,
      voiceTimingIncluded: Boolean(voiceReportPath)
    }, null, 2), "utf8");

    const variants = (project.analysis?.highlightVariants || []).map((item) => item.id === variant.id ? {
      ...item,
      artifacts: {
        ...(item.artifacts || {}),
        draftReviewPackagePath: uploadDir,
          draftReviewPromptPath: promptPath,
          draftReviewCreatedAt: new Date().toISOString(),
          draftReviewBindingId: reviewTarget.reviewBindingId,
          draftReviewRevision: revision,
          draftReviewAiResultPath: "",
          draftReviewAiResultDir: "",
          draftReviewAiProvider: "",
          draftReviewAiModel: "",
          draftReviewAiCompletedAt: ""
      }
    } : item);
    await this.projectStore.updateProject(workspaceRoot, projectId, {
      analysis: {
        ...(project.analysis || {}),
        highlightVariants: variants,
        artifacts: {
          ...(project.analysis?.artifacts || {}),
          draftReviewPackagePath: uploadDir,
          draftReviewPromptPath: promptPath
        }
      },
      artifacts: {
        ...(project.artifacts || {}),
        draftReviewPackagePath: uploadDir,
        draftReviewPromptPath: promptPath
      }
    });

    return {
      reviewDir: uploadDir,
      packageRoot: reviewDir,
      promptPath,
      draftPath: draftTarget,
      scriptPath,
      timelinePath,
      contextPath,
      uploadFileCount: uploadFiles.length,
      uploadFiles,
      variantId: variant.id,
      revision,
      reviewTarget,
      segmentCount: draftTimeline.segments.length,
      evidenceMode,
      evidenceReelWarning,
      reviewInputVideoDurationSec,
      packageMs: Date.now() - packageStartedAt
    };
  }
}

module.exports = GeminiDraftReviewService;
module.exports.buildScriptJson = buildScriptJson;
module.exports.buildDraftTimeline = buildDraftTimeline;
module.exports.buildReviewContext = buildReviewContext;
module.exports.buildReviewPrompt = buildReviewPrompt;
module.exports.buildReviewBinding = buildReviewBinding;
module.exports.selectReviewProxyChunks = selectReviewProxyChunks;
module.exports.selectRelevantProxyChunks = selectReviewProxyChunks;
module.exports.parseSrtCues = parseSrtCues;
module.exports.detectExplicitSpeaker = detectExplicitSpeaker;
module.exports.buildSemanticDialogueCandidates = buildSemanticDialogueCandidates;
module.exports.buildTranscriptInput = buildTranscriptInput;
