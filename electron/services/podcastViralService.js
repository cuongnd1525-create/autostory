const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const FfmpegService = require("./ffmpegService");
const SubtitleService = require("./subtitleService");
const { parseGeminiJsonObject } = require("./geminiJsonArtifactService");

const WORKFLOW = "manual_gemini_podcast_cut";
const ARTIFACT_TYPE = "podcast_edit_decision_list";
const FAILURE_ARTIFACT_TYPE = "podcast_input_access_failure";
const CANDIDATE_ARTIFACT_TYPE = "podcast_candidate_map";
const MIN_OUTPUT_COUNT = 1;
const MAX_OUTPUT_COUNT = 5;
const MAX_GEMINI_UPLOAD_FILES = 9;
const MAX_DIALOGUE_UPLOAD_PARTS = MAX_GEMINI_UPLOAD_FILES - 2;

function runExternal(command, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, { windowsHide: true });
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`${command} timed out while reading YouTube subtitles.`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        const error = new Error(`${command} exited with code ${code}: ${safeText(stderrText).slice(0, 800)}`);
        error.exitCode = code;
        error.stdout = stdoutText;
        error.stderr = stderrText;
        reject(error);
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    }));
  });
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function safeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function slugify(input) {
  return safeText(input || "podcast")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56) || "podcast";
}

function hashValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

const YOUTUBE_ENGLISH_SUBTITLE_TIERS = [
  { languageCode: "en", automatic: false, provider: "youtube_author_subtitles" },
  { languageCode: "en-orig", automatic: true, provider: "youtube_auto_captions_original" },
  { languageCode: "en", automatic: true, provider: "youtube_auto_captions_english" }
];

async function downloadYoutubeSubtitleTier({ command, youtubeUrl, outputDir, tier }) {
  await fs.mkdir(outputDir, { recursive: true });
  const outputTemplate = path.join(outputDir, "youtube-source.%(ext)s");
  let result;
  let commandError = null;
  try {
    result = await runExternal(command, [
      "--no-playlist",
      "--skip-download",
      "--no-simulate",
      tier.automatic ? "--write-auto-subs" : "--write-subs",
      "--sub-langs", tier.languageCode,
      "--sub-format", "vtt/best",
      "--convert-subs", "srt",
      "--print", "%(duration)s",
      "-o", outputTemplate,
      youtubeUrl
    ]);
  } catch (error) {
    commandError = error;
    result = { stdout: error.stdout || "", stderr: error.stderr || "" };
  }
  const files = await fs.readdir(outputDir);
  const subtitleNames = files.filter((name) => /^youtube-source(?:\.[^.]+)*\.(?:srt|vtt)$/i.test(name));
  if (!subtitleNames.length) {
    return { found: false, commandError };
  }
  const durationLines = `${result.stdout || ""}\n${result.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    found: true,
    subtitlePath: path.join(outputDir, subtitleNames[0]),
    remoteDurationSec: durationLines.at(-1) || 0,
    provider: tier.provider,
    languageCode: tier.languageCode
  };
}

async function fetchYoutubeSubtitle({ command = "yt-dlp", youtubeUrl, outputDir }) {
  let lastError = null;
  for (const [tierIndex, tier] of YOUTUBE_ENGLISH_SUBTITLE_TIERS.entries()) {
    const tierDir = path.join(outputDir, `tier-${tierIndex + 1}-${tier.provider}`);
    const result = await downloadYoutubeSubtitleTier({ command, youtubeUrl, outputDir: tierDir, tier });
    if (result.found) return result;
    lastError = result.commandError || lastError;
  }
  if (lastError) throw lastError;
  throw new Error("Video YouTube không có subtitle hoặc auto-caption tiếng Anh.");
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rm(filePath, { force: true }).catch(() => {});
  await fs.rename(temporaryPath, filePath);
}

async function exists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

function parseSrtTimestamp(value) {
  const match = String(value || "").trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, "0").slice(0, 3)) / 1000;
}

function parseSrt(raw = "") {
  return String(raw || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n\s*\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) return null;
      const [startRaw, endRaw] = lines[timingIndex].split("-->");
      const startSec = parseSrtTimestamp(startRaw);
      const endSec = parseSrtTimestamp(endRaw);
      const text = safeText(lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, ""));
      if (!text || endSec <= startSec) return null;
      return { startSec: round(startSec), endSec: round(endSec), text };
    })
    .filter(Boolean)
    .sort((left, right) => left.startSec - right.startSec);
}

function inferSpeaker(text = "") {
  const match = safeText(text).match(/^\[?([A-Za-z][A-Za-z0-9 _-]{1,30})\]?:\s+(.+)$/);
  if (!match) return { speaker: "unknown", text: safeText(text) };
  return { speaker: safeText(match[1]).toLowerCase().replace(/\s+/g, "_"), text: safeText(match[2]) };
}

function tokenizeText(text, startSec, endSec, prefix) {
  const tokens = safeText(text).match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s]/gu) || [];
  if (!tokens.length) return [];
  const duration = Math.max(0.12, endSec - startSec);
  return tokens.map((token, index) => ({
    wordId: `${prefix}_w${String(index + 1).padStart(3, "0")}`,
    text: token,
    startSec: round(startSec + (duration * index) / tokens.length),
    endSec: round(startSec + (duration * (index + 1)) / tokens.length),
    timingSource: "srt_interpolated"
  }));
}

function normalizeWordSidecar(payload = {}) {
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  return segments.flatMap((segment, segmentIndex) => (
    Array.isArray(segment.words) ? segment.words.map((word, wordIndex) => ({
      wordId: `asr_s${String(segmentIndex + 1).padStart(5, "0")}_w${String(wordIndex + 1).padStart(3, "0")}`,
      text: safeText(word.word || word.text),
      startSec: round(word.start),
      endSec: round(word.end),
      probability: Number.isFinite(Number(word.probability)) ? Number(word.probability) : null,
      timingSource: "faster_whisper_word"
    })).filter((word) => word.text && word.endSec > word.startSec) : []
  ));
}

function wordsForCue(cue, allWords, prefix) {
  const overlapping = allWords.filter((word) => word.startSec < cue.endSec + 0.04 && word.endSec > cue.startSec - 0.04);
  return overlapping.length ? overlapping : tokenizeText(cue.text, cue.startSec, cue.endSec, prefix);
}

const FILLER_WORDS = new Set(["um", "uh", "erm", "hmm", "like", "basically", "literally"]);

function buildCutOptions(unit, cleanupMode = "balanced") {
  const words = unit.words;
  const options = [{
    cutOptionId: `${unit.dialogueUnitId}_full`,
    label: "Giữ nguyên câu nguồn",
    sourceSpans: [{ startSec: unit.sourceStartSec, endSec: unit.sourceEndSec }],
    retainedWordIds: words.map((word) => word.wordId),
    resultText: unit.transcriptText,
    durationSec: round(unit.sourceEndSec - unit.sourceStartSec),
    editRisk: "lowest"
  }];
  if (cleanupMode === "safe" || words.length < 3) return options;

  let first = 0;
  let last = words.length - 1;
  while (first < last && FILLER_WORDS.has(words[first].text.toLowerCase().replace(/[^a-z]/g, ""))) first += 1;
  while (last > first && FILLER_WORDS.has(words[last].text.toLowerCase().replace(/[^a-z]/g, ""))) last -= 1;
  while (first + 1 < last && words[first].text.toLowerCase() === words[first + 1].text.toLowerCase()) first += 1;
  for (const phraseLength of [3, 2]) {
    if (first + phraseLength * 2 > last + 1) continue;
    const left = words.slice(first, first + phraseLength).map((word) => word.text.toLowerCase()).join(" ");
    const right = words.slice(first + phraseLength, first + phraseLength * 2).map((word) => word.text.toLowerCase()).join(" ");
    if (left === right) {
      first += phraseLength;
      break;
    }
  }
  const retained = words.slice(first, last + 1);
  if (retained.length && (first > 0 || last < words.length - 1)) {
    options.push({
      cutOptionId: `${unit.dialogueUnitId}_tight`,
      label: "Bỏ từ đệm/lặp ở đầu hoặc cuối",
      sourceSpans: [{ startSec: retained[0].startSec, endSec: retained.at(-1).endSec }],
      retainedWordIds: retained.map((word) => word.wordId),
      resultText: retained.map((word) => word.text).join(" ").replace(/\s+([,.!?;:])/g, "$1"),
      durationSec: round(retained.at(-1).endSec - retained[0].startSec),
      editRisk: retained.every((word) => word.timingSource === "faster_whisper_word") ? "low" : "medium"
    });
  }

  if (cleanupMode === "aggressive") {
    const spans = [];
    let current = [];
    words.forEach((word) => {
      const normalized = word.text.toLowerCase().replace(/[^a-z]/g, "");
      const duplicate = current.length && current.at(-1).text.toLowerCase() === word.text.toLowerCase();
      if (FILLER_WORDS.has(normalized) || duplicate) {
        if (current.length) spans.push(current.splice(0));
      } else {
        current.push(word);
      }
    });
    if (current.length) spans.push(current);
    const kept = spans.flat();
    if (spans.length > 1 && kept.length >= 3 && spans.length <= 4) {
      options.push({
        cutOptionId: `${unit.dialogueUnitId}_aggressive`,
        label: "Cắt mạnh từ đệm và từ lặp",
        sourceSpans: spans.map((span) => ({ startSec: span[0].startSec, endSec: span.at(-1).endSec })),
        retainedWordIds: kept.map((word) => word.wordId),
        resultText: kept.map((word) => word.text).join(" ").replace(/\s+([,.!?;:])/g, "$1"),
        durationSec: round(spans.reduce((sum, span) => sum + span.at(-1).endSec - span[0].startSec, 0)),
        editRisk: kept.every((word) => word.timingSource === "faster_whisper_word") ? "medium" : "high"
      });
    }
  }
  return options;
}

function buildDialogueUnits(cues = [], { cleanupMode = "balanced", wordSidecar = null } = {}) {
  const sidecarWords = normalizeWordSidecar(wordSidecar || {});
  return cues.map((cue, index) => {
    const dialogueUnitId = `dialogue_${String(index + 1).padStart(5, "0")}`;
    const speakerInfo = inferSpeaker(cue.text);
    const words = wordsForCue({ ...cue, text: speakerInfo.text }, sidecarWords, dialogueUnitId);
    const unit = {
      dialogueUnitId,
      speaker: speakerInfo.speaker,
      sourceStartSec: cue.startSec,
      sourceEndSec: cue.endSec,
      durationSec: round(cue.endSec - cue.startSec),
      transcriptText: speakerInfo.text,
      contextBefore: safeText(cues[index - 1]?.text || ""),
      contextAfter: safeText(cues[index + 1]?.text || ""),
      words
    };
    unit.cutOptions = buildCutOptions(unit, cleanupMode);
    return unit;
  });
}

function compactDialogueUnit(unit) {
  return [
    safeText(unit.dialogueUnitId),
    unit.sourceStartSec,
    unit.sourceEndSec,
    unit.speaker,
    unit.transcriptText,
    (unit.cutOptions || []).map((option, optionIndex) => [
      safeText(option.cutOptionId),
      option.durationSec,
      ...(optionIndex > 0 ? [option.resultText] : [])
    ])
  ];
}

function buildCompactDialogueParts(dialogueUnits = [], {
  sourceMatchId = "",
  targetBytes = 80000,
  maxParts = MAX_DIALOGUE_UPLOAD_PARTS
} = {}) {
  const compactUnits = dialogueUnits.map(compactDialogueUnit);
  const totalBytes = compactUnits.reduce((sum, unit) => sum + Buffer.byteLength(JSON.stringify(unit), "utf8") + 2, 0);
  const partLimit = Math.max(1, Math.min(MAX_DIALOGUE_UPLOAD_PARTS, Math.round(Number(maxParts) || MAX_DIALOGUE_UPLOAD_PARTS)));
  const partCount = Math.max(1, Math.min(partLimit, Math.ceil(totalBytes / targetBytes)));
  const targetPartBytes = Math.max(targetBytes, Math.ceil(totalBytes / partCount));
  const buckets = [];
  let current = [];
  let currentBytes = 0;
  compactUnits.forEach((unit) => {
    const unitBytes = Buffer.byteLength(JSON.stringify(unit), "utf8") + 2;
    const remainingUnits = compactUnits.length - buckets.reduce((sum, bucket) => sum + bucket.length, 0) - current.length;
    const remainingBuckets = partCount - buckets.length - 1;
    if (
      current.length
      && buckets.length < partCount - 1
      && currentBytes + unitBytes > targetPartBytes
      && remainingUnits > remainingBuckets
    ) {
      buckets.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(unit);
    currentBytes += unitBytes;
  });
  if (current.length) buckets.push(current);
  return buckets.map((units, index) => ({
    artifactType: "podcast_dialogue_units_part",
    schemaVersion: 1,
    sourceMatchId,
    partIndex: index + 1,
    partCount: buckets.length,
    rowSchema: ["dialogueUnitId", "sourceStartSec", "sourceEndSec", "speaker", "transcriptText", "cutOptions"],
    cutOptionSchema: ["cutOptionId", "durationSec", "resultText_if_changed"],
    cutOptionIdRule: "Use the exact cutOptionId string from each option row. Never construct or invent a suffix.",
    dialogueUnitStartId: units[0]?.[0] || "",
    dialogueUnitEndId: units.at(-1)?.[0] || "",
    dialogueUnitCount: units.length,
    units
  }));
}

function buildPrompt({ youtubeUrl, outputCount, targetMinSec, targetMaxSec, cleanupMode, sourceMap }) {
  const codeFence = "```";
  return `USER TASK INSTRUCTION - PODCAST VIRAL CUT / ORIGINAL SPEAKERS ONLY

You are a Viral TikTok/Reels Content Curator with sharp instincts for crowd psychology, body language, raw emotion, and scroll-stopping dialogue. Select ${outputCount} DISTINCT, genuinely high-value short-form scenes from the COMPLETE source. Use the public YouTube source for visual and body-language analysis whenever it is genuinely accessible. The local tool performs every physical cut and 9:16 layout operation. You may only select locked dialogueUnitId and cutOptionId values from the complete set of podcast-dialogue-units-part-*.json files.

SOURCE URL:
${youtubeUrl}

REQUESTED OUTPUTS:
- Exactly ${outputCount} separate EDL JSON object${outputCount === 1 ? "" : "s"}.
- Target duration per output: ${targetMinSec}-${targetMaxSec} seconds.
- Dialogue cleanup profile already compiled by the tool: ${cleanupMode}.
- Each output must center on a different high-value moment, viewer question, or payoff. Avoid duplicate edits. Shared context is allowed only when essential and should remain below 20% of an output.

HIGHEST EDITORIAL OBJECTIVE - FIND THE MOMENT BEFORE BUILDING THE JSON:
- Do not default to generic inspirational quotes, polished advice, or merely informative speech.
- Search the entire source for moments that make a viewer stop, feel tension, anticipate a visible action, take a side, or open the comments.
- A winning scene must satisfy at least one primary viral trigger:
  1. Visual & Action Trigger: a challenge, reveal, transformation, prop interaction, makeup removal, changing clothes, slamming a table, crying, laughing, or another concrete action on camera.
  2. High-Tension / Raw Emotion: hesitation, suspense, a heated exchange, live-comment interaction, vulnerability, an awkward pause, or repeated/stammered words such as "can you... can you..." and "oh my god" that signal a real action or emotional beat.
  3. Controversial Hot Take: a specific contrarian claim, taboo opinion, accusation, or socially divisive statement that creates an argument within the first three seconds.
- Visual behavior and emotional rhythm outrank a sentence that merely sounds wise in isolation.
- Select a complete scene arc around the winning moment: immediate setup -> trigger/action/claim -> reaction or payoff. Remove delay and filler without removing the reason the moment matters.

================================================================================
STEP 0 - VERIFIED INPUT ACCESS GATE (SUPREME, MUST RUN FIRST)
================================================================================
Before editorial work, you MUST parse ALL podcast-dialogue-units-part-*.json files completely and verify:
1. The part sequence is exactly 1-${sourceMap.dialogueUnitPartCount} with all ${sourceMap.dialogueUnitCount} dialogue units present.
2. Every selected dialogueUnitId, cutOptionId, timestamp, and transcriptText exists verbatim in those files.
3. podcast-source-map.json has sourceMatchId="${sourceMap.sourceMatchId}" and source duration ${sourceMap.localDurationSec}s.
4. You verified transcript anchors from the beginning, middle, and end of the complete dataset.
5. You can distinguish verified spoken words from your own interpretation.

Choose exactly one truthful accessMode:
- full_multimodal: You actually opened and inspected the complete YouTube video. Set youtubeUrlOpened=true and completeVideoReviewed=true.
- transcript_locked: The YouTube player is unavailable, but every dialogue-unit part and all ${sourceMap.dialogueUnitCount} units were parsed and verified. Set youtubeUrlOpened=false, completeVideoReviewed=false, and transcriptCoverageVerified=true. Continue editorial work from the complete locked transcript. This fallback is valid for Podcast Viral Cut.

COMPACT DIALOGUE CATALOG FORMAT:
- Every part contains a units array. Each row follows rowSchema:
  [dialogueUnitId, sourceStartSec, sourceEndSec, speaker, transcriptText, cutOptions]
- Each cut option follows cutOptionSchema:
  [cutOptionId, durationSec, optionalResultText]
- Copy cutOptionId EXACTLY from the option row. Never construct, infer, or invent suffixes such as _tight or _aggressive; many units only provide _full.
- This compact row format is complete data, not a summary. Read every row in every numbered part.

FAIL CLOSED - NEVER GUESS:
- An inaccessible YouTube player ALONE is not a failure when transcript_locked mode is available and the complete locked dataset passes every check above.
- If podcast-source-map.json or ANY required dialogue-unit part is missing, truncated, unreadable, inconsistent, or does not contain exactly ${sourceMap.dialogueUnitCount} units, STOP.
- On failure return exactly ONE JSON object with artifactType="${FAILURE_ARTIFACT_TYPE}", accessGranted=false, missingInputs, mismatchDetails, and recommendedAction. Do not produce an EDL and do not invent content.
- Never claim completeVideoReviewed=true unless you actually watched the complete source.
- In transcript_locked mode, never claim a facial expression, gesture, prop, camera action, or visual reaction that is not explicitly represented by verified dialogue metadata. Select dialogue semantically and set visualTreatment="none".
- Do not request crop, aspect-ratio, or auto-cropping parameters. The local tool owns 9:16 framing after import.

VIRAL SCENE-MINING METHOD:
1. Scan the COMPLETE accessible source and silently shortlist at least ${Math.max(10, outputCount * 3)} candidates distributed across the beginning, middle, and end. Do not stop after finding the first acceptable quote.
2. Score every candidate from 1-10 for: scrollStopStrength, visualAction, rawEmotion, controversyCommentPotential, and completePayoff. A quiet but psychologically charged quote may outrank a loud generic exchange.
3. Reject any candidate whose overall sceneScore is below 8. Choose the best ${outputCount} DISTINCT winners, not ${outputCount} variations of the same topic.
4. Treat repetition, hesitation, audience comments, laughter, silence, and abrupt reactions as possible evidence of tension rather than automatically deleting them. Remove only repetition that has no emotional or comedic function.
5. For each winner, state one centralViewerQuestion and one hookPromise, then build the shortest coherent scene that fulfills both: strongest opening line/action -> minimum context -> escalation/reveal -> payoff/reaction.
6. Prefer the speaker's exact provocative opening line as the Hook. Do not replace it with a summary or begin with polite lead-in chatter.
7. Non-linear order is OPTIONAL, never mandatory. Reorder only when a later reaction or payoff creates a stronger ending and all referents, physical state, and conversational logic remain clear.
8. Remove dead air and filler by choosing supplied cut options. NEVER rewrite, paraphrase, censor, extend, or fabricate spoken dialogue.
9. Preserve reaction tails when they add emotion. Do not cut in the middle of a decisive word or destroy the setup/payoff relationship.
10. No narrator, no TTS, no generated script, no voiceover_text, and no invented captions.
11. In transcript_locked mode, score only dialogue, timing, hesitation, repetition, and explicitly spoken action. Do not invent body language or visual triggers that were not verified.

TIMELINE OWNERSHIP - TOOL ONLY:
- Do NOT write sourceStartSec/sourceEndSec/startSec/endSec/playbackSpeed.
- Do NOT write clean_dialogue.
- Select only exact dialogueUnitId and cutOptionId values supplied by the tool.
- assemblyOrder defines output order. The tool resolves exact timestamps and validates every ID.

CONTINUITY AUDIT FOR EVERY NON-CHRONOLOGICAL TRANSITION:
- stateCompatible must be true.
- referentClear must be true.
- transitionScore must be >= 7.5.
- Explain transitionReason using verified context only.

SUCCESS OUTPUT CONTRACT:
- Return exactly ${outputCount} independent Markdown JSON code block${outputCount === 1 ? "" : "s"} and nothing else.
- Each block must begin with ${codeFence}json and end with ${codeFence}.
- Each block is one downloadable file named podcast-cut-01.json through podcast-cut-${String(outputCount).padStart(2, "0")}.json.
- Never wrap multiple outputs in an array or shared object.
- Validate each object with JSON.parse before responding.

REQUIRED ROOT SCHEMA FOR EACH SUCCESS FILE:
{
  "artifactType": "${ARTIFACT_TYPE}",
  "schemaVersion": 1,
  "workflow": "podcast_viral_cut",
  "sourceMatchId": "${sourceMap.sourceMatchId}",
  "outputIndex": 1,
  "outputCount": ${outputCount},
  "title": "short curiosity title",
  "targetDurationSec": ${targetMinSec},
  "centralViewerQuestion": "one concrete question",
  "hookPromise": "what the opening promises",
  "editingPattern": "chronological_compression | selective_semantic_reorder",
  "viralSelectionAudit": {
    "primaryTrigger": "visual_action | raw_emotion | controversial_hot_take",
    "sceneScore": 9,
    "scrollStopReason": "specific verified reason",
    "verifiedHookQuote": "exact source words",
    "visualEvidence": "verified visible action, or empty in transcript_locked mode",
    "payoff": "specific reaction, reveal, or conclusion retained in this edit"
  },
  "accessAudit": {
    "accessGranted": true,
    "accessMode": "transcript_locked",
    "youtubeUrlOpened": false,
    "completeVideoReviewed": false,
    "transcriptCoverageVerified": true,
    "dialogueUnitsParsed": true,
    "dialogueUnitPartsParsed": true,
    "dialogueUnitCountVerified": true,
    "sourceMapParsed": true,
    "sourceMatchVerified": true,
    "beginningAnchor": "verified dialogue/time",
    "middleAnchor": "verified dialogue/time",
    "endingAnchor": "verified dialogue/time"
  },
  "selections": [
    {
      "selectionId": "selection_001",
      "assemblyOrder": 1,
      "narrativeBlock": "hook | context | escalation | reveal | payoff | reaction",
      "dialogueUnitId": "dialogue_00001",
      "cutOptionId": "dialogue_00001_full",
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

FINAL SELF-CHECK BEFORE RESPONSE:
- access gate passed truthfully;
- exactly ${outputCount} files;
- outputIndex values are unique from 1 to ${outputCount};
- every ID exists in the complete set of podcast-dialogue-units-part-*.json files;
- no invented words or timestamps;
- every viralSelectionAudit has sceneScore >= 8 and cites a concrete hook and payoff;
- each output has a distinct central viewer question and payoff;
- duration estimate is within ${targetMinSec}-${targetMaxSec}s using selected cutOption durations;
- every reordered transition passes all three continuity gates.`;
}

function buildCandidateScoutPrompt({ youtubeUrl, outputCount, targetMinSec, targetMaxSec, sourceMap }) {
  const candidateCount = Math.min(15, Math.max(outputCount * 3, 8));
  return `USER TASK INSTRUCTION - PODCAST VIRAL SCENE SCOUT

ROLE:
You are a Viral TikTok/Reels Content Curator with sharp instincts for crowd psychology, body language, raw emotion, and scroll-stopping dialogue.

TASK:
Inspect the COMPLETE source and return ONE candidate map containing up to ${candidateCount} strong DISTINCT source scenes, with at least ${outputCount}. Never pad the list with weak material merely to reach ${candidateCount}. This is discovery only. Do not build the final edit, do not calculate an output timeline, and do not choose cutOptionId yet.

OUTPUT READINESS:
- The user requested ${outputCount} independent final output(s), each lasting ${targetMinSec}-${targetMaxSec}s.
- EVERY returned candidate must independently contain at least ${targetMinSec}s of useful selected sourceSpans from one coherent story thread. The local tool sums span durations and rejects shorter candidates.
- Temporal gaps between spans do not count. Never add waiting, counting, silence, or unrelated discussion merely to reach ${targetMinSec}s.
- If a story has only a short viral quote and cannot support ${targetMinSec}s of coherent setup, escalation, and payoff, do not return it as a standalone candidate.

SOURCE URL:
${youtubeUrl}

LOCKED INPUT:
- Parse every podcast-dialogue-units-part-*.json file and verify all ${sourceMap.dialogueUnitCount} units across parts 1-${sourceMap.dialogueUnitPartCount}.
- Parse podcast-source-map.json and verify sourceMatchId="${sourceMap.sourceMatchId}" and duration ${sourceMap.localDurationSec}s.
- If the YouTube player is accessible, inspect the complete video and use body language and visible action.
- If the player is unavailable but the complete locked transcript is readable, use accessMode="transcript_locked" and never invent visual evidence.
- Fail closed only when the locked transcript parts are missing, truncated, inconsistent, or do not contain all ${sourceMap.dialogueUnitCount} units.

VIRAL CRITERIA - A CANDIDATE MUST SCORE AT LEAST 8/10:
1. Visual & Action Trigger: challenge, reveal, transformation, prop interaction, makeup removal, changing clothes, crying, laughing, or another concrete on-camera action.
2. High-Tension / Raw Emotion: hesitation, suspense, heated exchange, live-comment interaction, vulnerability, awkward pause, laughter, or emotionally meaningful repetition.
3. Controversial Hot Take: specific contrarian claim, taboo opinion, accusation, or divisive statement that creates immediate comment conflict.

SCOUTING METHOD:
- Scan beginning, middle, and end. Do not stop after the first acceptable moment.
- Prefer specific action, tension, absurdity, vulnerability, contradiction, surprise, or payoff over generic inspiration and polished advice.
- STORY CANDIDATE, NOT ONE CONTINUOUS WINDOW: A candidate is one complete viewer question and may use 1-8 non-contiguous sourceSpans from anywhere in the source. Use separate spans for Hook/setup, commitment, physical action/reveal, and reaction/payoff. Never include minutes of waiting merely to connect distant beats.
- sourceSpans MUST be listed in original source-time order. Each span is a useful source excerpt, lasts 0.3-180s, and has an editorialRole. The combined useful duration of all spans in every candidate must be ${targetMinSec}-180s.
- PROMISE-PAYOFF COVERAGE GATE: Before returning a candidate, write its centralViewerQuestion and Hook promise, then prove the supplied sourceSpans contain the exact action, answer, reveal, conclusion, or reaction that resolves that promise. A candidate that ends on an instruction, question, tease, or commitment without the promised result is invalid.
- REQUIRED MOMENT LOCK: Every candidate, regardless of primaryTrigger, MUST contain one or more mustIncludeMoments. At least one moment must have a payoff role such as visual_payoff, dialogue_payoff, reveal, reaction, result, conclusion, or outro. Every moment must be fully contained inside one sourceSpan and last 0.3-45s.
- If the story involves a transformation or visible challenge, include distinct spans for the verbal setup, the actual physical action, the visible result, and the strongest useful reaction. Do not stop at words such as "do it", "wipe it off", or "I'm going to".
- If primaryTrigger="visual_action", at least one moment must be a physical_action or visual_payoff.
- In transcript_locked mode, use exact transcript anchors to locate later commitment/action/reaction beats. Set verificationBasis="transcript_anchor_needs_reel_verification" instead of pretending the action was visually verified. Pass 2 will watch the reel and make the final visual decision.
- Candidate windows may overlap slightly when they represent different possible stories, but do not return duplicates.
- Every sourceSpan and mustIncludeMoment must be within 0-${sourceMap.localDurationSec}s.
- Never fabricate quotes. hookQuote must be exact spoken English from the locked transcript.

OUTPUT CONTRACT:
- Return exactly ONE valid JSON object inside one Markdown json code block and no prose outside it.
- artifactType must be "${CANDIDATE_ARTIFACT_TYPE}".

{
  "artifactType": "${CANDIDATE_ARTIFACT_TYPE}",
  "schemaVersion": 2,
  "workflow": "podcast_viral_cut_two_pass",
  "sourceMatchId": "${sourceMap.sourceMatchId}",
  "requestedOutputCount": ${outputCount},
  "accessAudit": {
    "accessGranted": true,
    "accessMode": "full_multimodal | transcript_locked",
    "youtubeUrlOpened": false,
    "completeVideoReviewed": false,
    "transcriptCoverageVerified": true,
    "dialogueUnitsParsed": true,
    "dialogueUnitPartsParsed": true,
    "dialogueUnitCountVerified": true,
    "sourceMapParsed": true,
    "sourceMatchVerified": true,
    "beginningAnchor": "verified dialogue/time",
    "middleAnchor": "verified dialogue/time",
    "endingAnchor": "verified dialogue/time"
  },
  "candidates": [
    {
      "candidateId": "candidate_001",
      "primaryTrigger": "visual_action | raw_emotion | controversial_hot_take",
      "sceneScore": 9,
      "hookQuote": "exact source words",
      "centralViewerQuestion": "one concrete question",
      "payoff": "specific reaction, reveal, or conclusion available in this scene",
      "visualEvidence": "verified visible action, or empty in transcript_locked mode",
      "selectionReason": "why this can stop scrolling",
      "sourceSpans": [
        {
          "spanId": "candidate_001_span_01",
          "editorialRole": "hook | context | commitment | physical_action | reveal | reaction | payoff | outro",
          "sourceStartSec": 0,
          "sourceEndSec": 8,
          "transcriptAnchor": "exact spoken anchor",
          "visualAnchor": "verified visual evidence, or empty"
        },
        {
          "spanId": "candidate_001_span_02",
          "editorialRole": "payoff",
          "sourceStartSec": 120,
          "sourceEndSec": 128,
          "transcriptAnchor": "exact payoff/reaction words",
          "visualAnchor": "verified visual evidence, or empty"
        }
      ],
      "mustIncludeMoments": [
        {
          "momentId": "candidate_001_moment_01",
          "role": "physical_action | visual_payoff | dialogue_payoff | reveal | reaction | result | conclusion | outro",
          "momentType": "visual | dialogue | reaction",
          "sourceStartSec": 120,
          "sourceEndSec": 125,
          "description": "exact action/answer/payoff that must survive the final edit",
          "verificationBasis": "visual_verified | transcript_anchor_needs_reel_verification"
        }
      ]
    }
  ]
}

FINAL CHECK:
- ${outputCount}-${candidateCount} distinct candidates, each with at least ${targetMinSec}s useful footage and no weak padding;
- every sceneScore >= 8;
- every timestamp is inside the locked source duration;
- every hookQuote is exact source dialogue;
- every candidate has multi-span story coverage when its setup and payoff are distant;
- every candidate contains at least one locked payoff moment that answers its centralViewerQuestion;
- every visual_action candidate has a physical/visual payoff moment;
- no final EDL, selections, assemblyOrder, or invented clean_dialogue.`;
}

function validateAccessAudit(payload) {
  const audit = payload?.accessAudit || {};
  const required = [
    "accessGranted",
    "dialogueUnitsParsed",
    "dialogueUnitPartsParsed",
    "dialogueUnitCountVerified",
    "sourceMapParsed",
    "sourceMatchVerified"
  ];
  const missing = required.filter((key) => audit[key] !== true);
  if (missing.length) {
    throw new Error(`Gemini chưa vượt qua cổng xác minh input: ${missing.join(", ")}.`);
  }
  const accessMode = safeText(audit.accessMode);
  if (accessMode === "full_multimodal") {
    if (audit.youtubeUrlOpened !== true || audit.completeVideoReviewed !== true) {
      throw new Error("Gemini khai báo full_multimodal nhưng chưa xác nhận đã mở và xem toàn bộ video.");
    }
    return;
  }
  if (accessMode === "transcript_locked") {
    if (audit.transcriptCoverageVerified !== true) {
      throw new Error("Gemini khai báo transcript_locked nhưng chưa xác nhận transcriptCoverageVerified.");
    }
    return;
  }
  if (accessMode === "candidate_reel") {
    if (audit.candidateReelReviewed !== true) {
      throw new Error("Gemini khai báo candidate_reel nhưng chưa xác nhận candidateReelReviewed.");
    }
    return;
  }
  throw new Error("Gemini chưa khai báo accessMode hợp lệ: full_multimodal, transcript_locked hoặc candidate_reel.");
}

function compilePodcastEdl(payload, unitsPayload, sourceMap) {
  if (String(payload?.artifactType || "") === FAILURE_ARTIFACT_TYPE) {
    throw new Error(`Gemini không truy cập đủ input: ${safeText((payload.missingInputs || []).join(", ") || payload.recommendedAction)}`);
  }
  if (String(payload?.artifactType || "") !== ARTIFACT_TYPE) {
    throw new Error(`JSON Podcast phải có artifactType="${ARTIFACT_TYPE}".`);
  }
  const outputCount = Math.round(Number(payload.outputCount || 0));
  const outputIndex = Math.round(Number(payload.outputIndex || 0));
  if (outputCount < MIN_OUTPUT_COUNT || outputCount > MAX_OUTPUT_COUNT) {
    throw new Error(`Podcast EDL có outputCount không hợp lệ; chỉ nhận ${MIN_OUTPUT_COUNT}-${MAX_OUTPUT_COUNT}.`);
  }
  if (outputIndex < 1 || outputIndex > outputCount) {
    throw new Error(`Podcast EDL có outputIndex ${outputIndex} nằm ngoài khoảng 1-${outputCount}.`);
  }
  validateAccessAudit(payload);
  if (safeText(payload.sourceMatchId) !== safeText(sourceMap.sourceMatchId)) {
    throw new Error("JSON Podcast thuộc sourceMatchId khác gói phân tích hiện tại.");
  }
  const selections = Array.isArray(payload.selections) ? [...payload.selections] : [];
  if (!selections.length) throw new Error("Podcast EDL thiếu mảng selections có dữ liệu.");
  selections.sort((left, right) => Number(left.assemblyOrder || 0) - Number(right.assemblyOrder || 0));
  const units = Array.isArray(unitsPayload?.dialogueUnits) ? unitsPayload.dialogueUnits : [];
  const unitById = new Map(units.map((unit) => [unit.dialogueUnitId, unit]));
  const usedSelectionIds = new Set();
  const warnings = [];
  if (safeText(payload.accessAudit?.accessMode) === "transcript_locked") {
    warnings.push("Gemini chọn cảnh từ transcript đầy đủ nhưng không xem được video YouTube; hãy kiểm tra continuity hình ảnh trong draft.");
  }
  const viralSelectionAudit = payload.viralSelectionAudit || {};
  const sceneScore = Number(viralSelectionAudit.sceneScore || 0);
  if (!Number.isFinite(sceneScore) || sceneScore < 8) {
    warnings.push("Gemini chưa chứng minh ứng viên đạt Viral Scene Mining >= 8/10; hãy kiểm tra Hook và payoff trong preview.");
  }
  const segments = [];
  const selectedUnitIds = new Set();
  let cursor = 0;

  selections.forEach((selection, selectionIndex) => {
    const unitId = safeText(selection.dialogueUnitId);
    const optionId = safeText(selection.cutOptionId);
    const unit = unitById.get(unitId);
    if (!unit) throw new Error(`Selection ${selectionIndex + 1}: dialogueUnitId "${unitId}" không tồn tại.`);
    selectedUnitIds.add(unitId);
    const availableOptions = unit.cutOptions || [];
    let option = availableOptions.find((item) => item.cutOptionId === optionId);
    if (!option && optionId.startsWith(`${unitId}_`)) {
      const requestedSuffix = optionId.slice(unitId.length + 1);
      const fallbackSuffixes = requestedSuffix === "aggressive"
        ? ["tight", "full"]
        : requestedSuffix === "tight"
        ? ["full"]
        : [];
      option = fallbackSuffixes
        .map((suffix) => availableOptions.find((item) => item.cutOptionId === `${unitId}_${suffix}`))
        .find(Boolean);
      if (!option && availableOptions.length === 1) option = availableOptions[0];
      if (option) {
        warnings.push(
          `Selection ${selectionIndex + 1}: Gemini chọn ${optionId} không tồn tại; tool tự dùng ${option.cutOptionId}.`
        );
      }
    }
    if (!option) {
      throw new Error(
        `Selection ${selectionIndex + 1}: cutOptionId "${optionId}" không tồn tại trong ${unitId}. `
        + `Option hợp lệ: ${availableOptions.map((item) => item.cutOptionId).join(", ") || "không có"}.`
      );
    }
    const resolvedOptionId = safeText(option.cutOptionId);
    const selectionId = safeText(selection.selectionId || `selection_${String(selectionIndex + 1).padStart(3, "0")}`);
    if (usedSelectionIds.has(selectionId)) throw new Error(`selectionId "${selectionId}" bị trùng.`);
    usedSelectionIds.add(selectionId);
    if (selection.chronologyChanged === true) {
      if (selection.stateCompatible !== true || selection.referentClear !== true || Number(selection.transitionScore || 0) < 7.5) {
        throw new Error(`Selection ${selectionIndex + 1}: chuyển thứ tự nhưng continuity gate chưa đạt.`);
      }
    }
    const reactionTailSec = Math.max(0, Math.min(0.8, Number(selection.includeReactionAfterMs || 0) / 1000));
    const spans = (option.sourceSpans || []).map((span, spanIndex) => ({
      startSec: Number(span.startSec),
      endSec: Number(span.endSec) + (spanIndex === option.sourceSpans.length - 1 ? reactionTailSec : 0)
    }));
    spans.forEach((span, spanIndex) => {
      const startSec = Math.max(0, span.startSec);
      const endSec = Math.min(Number(sourceMap.localDurationSec || Infinity), span.endSec);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec - startSec < 0.08) {
        throw new Error(`Selection ${selectionIndex + 1}: source span ${spanIndex + 1} không hợp lệ.`);
      }
      const duration = endSec - startSec;
      const segmentId = `podcast_${String(selectionIndex + 1).padStart(3, "0")}_${String(spanIndex + 1).padStart(2, "0")}`;
      segments.push({
        id: segmentId,
        segmentId,
        sceneId: "scene_0001",
        sourceStartSec: round(startSec),
        sourceEndSec: round(endSec),
        startSec: round(cursor),
        endSec: round(cursor + duration),
        playbackSpeed: 1,
        scene_type: safeText(selection.narrativeBlock || "podcast_dialogue"),
        storyFunction: safeText(selection.narrativeBlock || ""),
        audio_mode: "original_audio",
        voiceover_text: "",
        caption: "",
        preview_vi: "",
        action_notes: `${option.resultText}${safeText(selection.transitionReason) ? ` | ${safeText(selection.transitionReason)}` : ""}`,
        sourceDialogueText: option.resultText,
        dialogueUnitId: unitId,
        cutOptionId: resolvedOptionId,
        chronologyChanged: selection.chronologyChanged === true,
        transitionScore: Number(selection.transitionScore || 0),
        visualTreatment: safeText(selection.visualTreatment || "none"),
        candidateId: safeText(unit.candidateId),
        podcastUnitType: safeText(unit.unitType || "dialogue"),
        visualMomentId: safeText(unit.visualMomentId)
      });
      cursor += duration;
    });
  });

  if (safeText(payload.workflow) === "podcast_viral_cut_two_pass") {
    const promisePayoffAudit = payload.promisePayoffAudit || {};
    if (
      promisePayoffAudit.hookPromiseResolved !== true
      || promisePayoffAudit.payoffObservedInReel !== true
      || !safeText(promisePayoffAudit.observedEvidence)
      || (Array.isArray(promisePayoffAudit.missingRequiredMomentIds)
        && promisePayoffAudit.missingRequiredMomentIds.length)
    ) {
      throw new Error(
        "Podcast EDL chưa vượt Promise/Payoff gate: Gemini phải xem Candidate Reel và xác nhận Hook Promise có action/reveal/reaction/payoff thật."
      );
    }
    const declaredCandidateIds = new Set(
      (Array.isArray(payload.candidateIds) ? payload.candidateIds : []).map(safeText).filter(Boolean)
    );
    if (!declaredCandidateIds.size) {
      selectedUnitIds.forEach((unitId) => {
        const candidateId = safeText(unitById.get(unitId)?.candidateId);
        if (candidateId) declaredCandidateIds.add(candidateId);
      });
    }
    const requiredUnits = units.filter((unit) => (
      unit.required === true && declaredCandidateIds.has(safeText(unit.candidateId))
    ));
    if (requiredUnits.length) {
      const declaredRequiredIds = new Set(
        (Array.isArray(payload.assemblyBlueprint?.requiredMomentUnitIds)
          ? payload.assemblyBlueprint.requiredMomentUnitIds
          : []).map(safeText).filter(Boolean)
      );
      const omittedFromBlueprint = requiredUnits
        .map((unit) => unit.dialogueUnitId)
        .filter((unitId) => !declaredRequiredIds.has(unitId));
      if (omittedFromBlueprint.length) {
        throw new Error(
          `Podcast EDL thiếu requiredMomentUnitIds đã khóa trong assemblyBlueprint: ${omittedFromBlueprint.join(", ")}.`
        );
      }
      const verifiedMomentIds = new Set(
        (Array.isArray(promisePayoffAudit.requiredMomentUnitIdsVerified)
          ? promisePayoffAudit.requiredMomentUnitIdsVerified
          : []).map(safeText).filter(Boolean)
      );
      const unverifiedMomentIds = requiredUnits
        .map((unit) => unit.dialogueUnitId)
        .filter((unitId) => !verifiedMomentIds.has(unitId));
      if (unverifiedMomentIds.length) {
        throw new Error(
          `Gemini chưa xác nhận đã xem các required moment trong Candidate Reel: ${unverifiedMomentIds.join(", ")}.`
        );
      }
      const omittedFromTimeline = requiredUnits
        .map((unit) => unit.dialogueUnitId)
        .filter((unitId) => !selectedUnitIds.has(unitId));
      if (omittedFromTimeline.length) {
        throw new Error(
          `Podcast EDL chưa chọn action/reveal/reaction/payoff bắt buộc vào selections: ${omittedFromTimeline.join(", ")}.`
        );
      }
    }
  }

  if (safeText(payload.workflow) === "podcast_viral_cut_two_pass" && safeText(viralSelectionAudit.primaryTrigger) === "visual_action") {
    const visualPayoffUnitId = safeText(payload.assemblyBlueprint?.visualPayoffUnitId);
    if (!visualPayoffUnitId) {
      throw new Error("Podcast EDL dùng visual_action nhưng thiếu assemblyBlueprint.visualPayoffUnitId.");
    }
    const visualUnit = unitById.get(visualPayoffUnitId);
    if (!visualUnit || safeText(visualUnit.unitType) !== "visual_moment") {
      throw new Error(`visualPayoffUnitId "${visualPayoffUnitId}" không phải Visual Moment ID đã khóa.`);
    }
    if (!selectedUnitIds.has(visualPayoffUnitId)) {
      throw new Error(`EDL hứa visual_action nhưng chưa chọn Visual Payoff Unit "${visualPayoffUnitId}" vào selections.`);
    }
  }

  const targetDuration = Number(payload.targetDurationSec || 0);
  if (targetDuration && Math.abs(cursor - targetDuration) > 8) {
    warnings.push(`Duration thật ${cursor.toFixed(1)}s lệch targetDurationSec ${targetDuration.toFixed(1)}s.`);
  }
  return {
    artifactType: "highlight_cut_script",
    schemaVersion: 1,
    workflow: "podcast_viral_cut",
    scriptId: outputIndex,
    title: safeText(payload.title || `Podcast Cut ${payload.outputIndex || 1}`),
    style: "podcast_viral_cut",
    language: "auto",
    sourceLanguage: "auto",
    total_target_sec: round(cursor),
    centralViewerQuestion: safeText(payload.centralViewerQuestion),
    hookPromise: safeText(payload.hookPromise),
    editingPattern: safeText(payload.editingPattern),
    viralSelectionAudit,
    accessAudit: payload.accessAudit,
    segments,
    _toolValidationWarnings: warnings
  };
}

async function compilePodcastEdlFile({ jsonPath, packageDir }) {
  const uploadDir = path.join(packageDir, "01-GUI-GEMINI");
  const assemblyUnitsPath = path.join(packageDir, "podcast-assembly-dialogue-units.full.json");
  const fullUnitsPath = path.join(packageDir, "podcast-dialogue-units.full.json");
  const unitsPath = await exists(assemblyUnitsPath)
    ? assemblyUnitsPath
    : await exists(fullUnitsPath)
    ? fullUnitsPath
    : path.join(uploadDir, "podcast-dialogue-units.json");
  const [raw, unitsRaw, sourceMapRaw] = await Promise.all([
    fs.readFile(jsonPath, "utf8"),
    fs.readFile(unitsPath, "utf8"),
    fs.readFile(path.join(uploadDir, "podcast-source-map.json"), "utf8")
  ]);
  return compilePodcastEdl(
    parseGeminiJsonObject(raw, path.basename(jsonPath)),
    JSON.parse(unitsRaw),
    JSON.parse(sourceMapRaw)
  );
}

class PodcastViralService {
  constructor(settings = {}) {
    this.settings = settings;
  }

  async create({
    sourceVideoPath,
    subtitleSourcePath = "",
    destinationRoot,
    sourceLanguage = "en",
    autoWhisper = true,
    forceRebuild = false,
    youtubeUrl = "",
    outputCount = 1,
    targetMinSec = 45,
    targetMaxSec = 60,
    cleanupMode = "balanced",
    workflowMode = "quality_two_pass",
    onProgress
  }) {
    if (!sourceVideoPath) throw new Error("Hãy chọn video Podcast nguồn.");
    if (!/^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(safeText(youtubeUrl))) {
      throw new Error("Hãy nhập URL YouTube công khai tương ứng với video local.");
    }
    const resolvedRoot = destinationRoot || this.settings.geminiAnalysisRoot;
    if (!resolvedRoot) throw new Error("Hãy cấu hình thư mục gói Gemini trong Cài đặt.");
    const requestedCount = Math.round(clamp(outputCount, MIN_OUTPUT_COUNT, MAX_OUTPUT_COUNT, 1));
    const minSec = round(clamp(targetMinSec, 15, 600, 45), 1);
    const maxSec = round(clamp(targetMaxSec, minSec, 900, Math.max(60, minSec)), 1);
    const normalizedCleanup = ["safe", "balanced", "aggressive"].includes(cleanupMode) ? cleanupMode : "balanced";
    const normalizedWorkflowMode = workflowMode === "quick_one_pass" ? "quick_one_pass" : "quality_two_pass";
    const ffmpeg = new FfmpegService(this.settings);
    const subtitleService = new SubtitleService(this.settings);
    const packageDir = path.join(resolvedRoot, `${slugify(path.parse(sourceVideoPath).name)}-gemini-podcast-viral-cut-pack`);
    const uploadDir = path.join(packageDir, "01-GUI-GEMINI");
    const tempDir = path.join(packageDir, "temp");
    await fs.rm(uploadDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(path.join(packageDir, "02-ASSEMBLY-GEMINI"), { recursive: true, force: true });
    await fs.rm(path.join(packageDir, ".candidate-work"), { recursive: true, force: true });
    await fs.rm(path.join(packageDir, "podcast-candidate-map.json"), { force: true });
    await fs.rm(path.join(packageDir, "podcast-assembly-dialogue-units.full.json"), { force: true });
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(tempDir, { recursive: true });

    onProgress?.({ step: "gemini_pack", percent: 8, message: "Đang đọc metadata Podcast" });
    const stat = await fs.stat(sourceVideoPath);
    const sourceFingerprint = hashValue({ path: path.resolve(sourceVideoPath), size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    const cacheDir = path.join(this.settings.workspaceRoot || resolvedRoot, ".cineviral", "cache", "podcast-analysis", sourceFingerprint);
    await fs.mkdir(cacheDir, { recursive: true });
    const mediaPath = path.join(cacheDir, "media.json");
    let media = null;
    if (!forceRebuild && await exists(mediaPath)) media = JSON.parse(await fs.readFile(mediaPath, "utf8"));
    if (!media?.duration) {
      media = await ffmpeg.probeVideo(sourceVideoPath);
      await writeJson(mediaPath, media);
    }
    if (!media?.duration) throw new Error("Không đọc được thời lượng video Podcast.");

    onProgress?.({ step: "gemini_pack", percent: 20, message: "Đang chuẩn bị transcript khóa timestamp" });
    let transcriptPath = "";
    let wordTimestampsPath = "";
    let transcriptProvider = "none";
    if (subtitleSourcePath) {
      transcriptPath = subtitleSourcePath;
      transcriptProvider = "user_srt";
    } else {
      const cachedSrtPath = path.join(cacheDir, "source-transcript.srt");
      const cachedWordsPath = path.join(cacheDir, "source-transcript.words.json");
      const cachedTranscriptMetaPath = path.join(cacheDir, "source-transcript.meta.json");
      if (!forceRebuild && await exists(cachedSrtPath)) {
        transcriptPath = cachedSrtPath;
        wordTimestampsPath = await exists(cachedWordsPath) ? cachedWordsPath : "";
        if (await exists(cachedTranscriptMetaPath)) {
          const transcriptMeta = JSON.parse(await fs.readFile(cachedTranscriptMetaPath, "utf8"));
          transcriptProvider = safeText(transcriptMeta.provider || "cached_transcript");
        } else {
          transcriptProvider = "cached_transcript";
        }
      } else {
        onProgress?.({ step: "gemini_pack", percent: 24, message: "Đang lấy transcript trực tiếp từ YouTube" });
        try {
          const youtubeSubtitle = await fetchYoutubeSubtitle({
            command: this.settings.ytDlpCommand || "yt-dlp",
            youtubeUrl: safeText(youtubeUrl),
            outputDir: path.join(tempDir, "youtube-subs")
          });
          const remoteDurationSec = Number(youtubeSubtitle.remoteDurationSec || 0);
          if (remoteDurationSec && Math.abs(remoteDurationSec - Number(media.duration)) > 2) {
            const mismatchError = new Error(
              `Duration YouTube ${remoteDurationSec.toFixed(2)}s không khớp file local ${Number(media.duration).toFixed(2)}s. `
              + "Hãy dùng đúng file tải từ URL này hoặc chọn SRT của file local."
            );
            mismatchError.code = "PODCAST_SOURCE_DURATION_MISMATCH";
            throw mismatchError;
          }
          await fs.copyFile(youtubeSubtitle.subtitlePath, cachedSrtPath);
          await writeJson(cachedTranscriptMetaPath, {
            provider: youtubeSubtitle.provider,
            language: "en",
            youtubeLanguageCode: youtubeSubtitle.languageCode
          });
          transcriptPath = cachedSrtPath;
          transcriptProvider = youtubeSubtitle.provider;
        } catch (youtubeError) {
          if (youtubeError?.code === "PODCAST_SOURCE_DURATION_MISMATCH") throw youtubeError;
          if (!autoWhisper || !media.hasAudio) {
            throw new Error(`Không lấy được subtitle YouTube: ${youtubeError.message}`);
          }
          onProgress?.({ step: "gemini_pack", percent: 28, message: "YouTube không có subtitle; đang fallback sang Whisper" });
        }
      }
      if (!transcriptPath && autoWhisper && media.hasAudio) {
        const audioPath = path.join(tempDir, "podcast-source-audio.wav");
        await ffmpeg.run(ffmpeg.ffmpegPath, ["-y", "-i", sourceVideoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath], { captureStdout: false });
        let transcript;
        try {
          transcript = await subtitleService.transcribeToSrt({
            audioPath,
            outputDir: tempDir,
            narrationLanguage: "en",
            cacheDir: path.join(cacheDir, "asr-chunks")
          });
        } catch (error) {
          if (/timed out/i.test(String(error?.message || ""))) {
            throw new Error(
              "YouTube không có subtitle phù hợp và Whisper chưa xử lý xong trong 5 phút. "
              + "Các chunk đã hoàn thành được giữ trong cache; hãy bấm Tạo gói lại để tiếp tục, hoặc chọn SRT để tạo gói ngay."
            );
          }
          throw error;
        }
        await fs.copyFile(transcript.subtitlePath, cachedSrtPath);
        transcriptPath = cachedSrtPath;
        const generatedWordsPath = transcript.wordTimestampsPath || transcript.subtitlePath.replace(/\.srt$/i, ".words.json");
        if (await exists(generatedWordsPath)) {
          await fs.copyFile(generatedWordsPath, cachedWordsPath);
          wordTimestampsPath = cachedWordsPath;
        }
        transcriptProvider = transcript.provider || "asr";
        await writeJson(cachedTranscriptMetaPath, {
          provider: transcriptProvider,
          language: "en",
          profile: transcript.profile || null
        });
      }
    }
    if (!transcriptPath || !(await exists(transcriptPath))) {
      throw new Error("Podcast Viral Cut cần transcript có timestamp. Hãy chọn SRT hoặc bật nhận diện tự động.");
    }

    const transcriptRaw = await fs.readFile(transcriptPath, "utf8");
    const cues = parseSrt(transcriptRaw);
    if (!cues.length) throw new Error("Transcript Podcast không có câu thoại có timestamp hợp lệ.");
    const wordSidecar = wordTimestampsPath && await exists(wordTimestampsPath)
      ? JSON.parse(await fs.readFile(wordTimestampsPath, "utf8"))
      : null;
    const dialogueUnits = buildDialogueUnits(cues, { cleanupMode: normalizedCleanup, wordSidecar });
    const sourceMatchId = hashValue({ sourceFingerprint, youtubeUrl: safeText(youtubeUrl), duration: round(media.duration) });
    const compactDialogueParts = buildCompactDialogueParts(dialogueUnits, { sourceMatchId });
    const sourceMap = {
      artifactType: "podcast_source_map",
      schemaVersion: 1,
      sourceMatchId,
      sourceLanguage: "en",
      youtubeUrl: safeText(youtubeUrl),
      localSourceFile: path.basename(sourceVideoPath),
      localDurationSec: round(media.duration),
      transcriptProvider,
      transcriptCueCount: cues.length,
      dialogueUnitCount: dialogueUnits.length,
      dialogueUnitPartCount: compactDialogueParts.length,
      dialogueUnitPartFiles: compactDialogueParts.map((_part, index) => `podcast-dialogue-units-part-${String(index + 1).padStart(2, "0")}.json`),
      wordTimingSource: wordSidecar ? "faster_whisper_word" : "srt_interpolated",
      verificationStatus: "gemini_must_verify_beginning_middle_end",
      instruction: "Gemini must fail closed if the YouTube source does not match these local timeline anchors."
    };
    const unitsPayload = {
      artifactType: "podcast_dialogue_units",
      schemaVersion: 1,
      sourceMatchId,
      cleanupMode: normalizedCleanup,
      dialogueUnitCount: dialogueUnits.length,
      dialogueUnits
    };
    const manifest = {
      artifactType: "scene_manifest",
      schemaVersion: 1,
      sourceVideo: path.basename(sourceVideoPath),
      videoDurationSec: round(media.duration),
      detector: "podcast_full_source_timeline",
      scenes: [{ sceneId: "scene_0001", startSec: 0, endSec: round(media.duration) }]
    };
    const prompt = normalizedWorkflowMode === "quality_two_pass"
      ? buildCandidateScoutPrompt({
        youtubeUrl: safeText(youtubeUrl),
        outputCount: requestedCount,
        targetMinSec: minSec,
        targetMaxSec: maxSec,
        sourceMap
      })
      : buildPrompt({
        youtubeUrl: safeText(youtubeUrl),
        outputCount: requestedCount,
        targetMinSec: minSec,
        targetMaxSec: maxSec,
        cleanupMode: normalizedCleanup,
        sourceMap
      });

    onProgress?.({ step: "gemini_pack", percent: 78, message: "Đang khóa dialogueUnitId và cutOptionId" });
    const plainTranscriptPath = path.join(packageDir, "source-transcript.txt");
    const transcriptJsonPath = path.join(packageDir, "source-transcript.json");
    await Promise.all([
      writeJson(path.join(packageDir, "podcast-dialogue-units.full.json"), unitsPayload),
      writeJson(path.join(uploadDir, "podcast-source-map.json"), sourceMap),
      writeJson(path.join(packageDir, "scene-manifest.json"), manifest),
      fs.copyFile(transcriptPath, path.join(packageDir, "source-transcript.srt")),
      fs.writeFile(path.join(uploadDir, "01-podcast-viral-prompt.txt"), prompt, "utf8"),
      fs.writeFile(plainTranscriptPath, cues.map((cue) => cue.text).join("\n"), "utf8"),
      writeJson(transcriptJsonPath, {
        artifactType: "podcast_transcript",
        schemaVersion: 1,
        language: "en",
        provider: transcriptProvider,
        sourceMatchId,
        segments: dialogueUnits.map((unit) => ({
          dialogueUnitId: unit.dialogueUnitId,
          speaker: unit.speaker,
          startSec: unit.sourceStartSec,
          endSec: unit.sourceEndSec,
          text: unit.transcriptText,
          words: unit.words
        }))
      }),
      ...compactDialogueParts.map((part, index) => fs.writeFile(
        path.join(uploadDir, `podcast-dialogue-units-part-${String(index + 1).padStart(2, "0")}.json`),
        JSON.stringify(part),
        "utf8"
      ))
    ]);
    const packageInfo = {
      artifactType: "manual_gemini_package",
      schemaVersion: 1,
      workflow: WORKFLOW,
      workflowStage: normalizedWorkflowMode === "quality_two_pass" ? "podcast_candidates_pending" : "podcast_edl_pending",
      packageDir,
      stage1UploadDir: uploadDir,
      sourceVideoPath,
      sourceMatchId,
      youtubeUrl: safeText(youtubeUrl),
      outputCount: requestedCount,
      targetMinSec: minSec,
      targetMaxSec: maxSec,
      cleanupMode: normalizedCleanup,
      workflowMode: normalizedWorkflowMode,
      dialogueUnitCount: dialogueUnits.length,
      dialogueUnitPartCount: compactDialogueParts.length,
      uploadFileCount: compactDialogueParts.length + 2,
      createdAt: new Date().toISOString()
    };
    await writeJson(path.join(packageDir, "package-info.json"), packageInfo);
    await fs.writeFile(path.join(packageDir, "HUONG-DAN.txt"), [
      normalizedWorkflowMode === "quality_two_pass" ? "PODCAST VIRAL CUT - TWO PASS QUALITY" : "PODCAST VIRAL CUT - ONE PASS QUICK",
      "",
      `1. Mo mot chat Gemini moi va gui URL: ${youtubeUrl}`,
      `2. Dinh kem toan bo ${compactDialogueParts.length + 2} file trong thu muc 01-GUI-GEMINI (prompt, source map va ${compactDialogueParts.length} dialogue-unit parts).`,
      normalizedWorkflowMode === "quality_two_pass"
        ? "3. Gemini tra ve mot file podcast-candidate-map.json. Nhap file nay vao Giai doan 2 de tool tao candidate reel."
        : `3. Gemini phai tra ve dung ${requestedCount} khoi JSON rieng. Tai tung khoi thanh mot file .json.`,
      normalizedWorkflowMode === "quality_two_pass"
        ? "4. Gui toan bo file trong 02-ASSEMBLY-GEMINI cho mot chat moi, sau do chon cac podcast-cut-XX.json."
        : "4. Chon dong thoi 1-5 file JSON trong tool. Tool se tu resolve ID thanh timestamp local.",
      "5. Neu Gemini tra podcast_input_access_failure, khong import; hay sua quyen truy cap URL/input truoc."
    ].join("\n"), "utf8");
    onProgress?.({ step: "gemini_pack", percent: 100, message: "Gói Podcast Viral Cut đã sẵn sàng" });
    return {
      packageDir,
      stage1UploadDir: uploadDir,
      pass1UploadDir: uploadDir,
      promptPath: path.join(uploadDir, "01-podcast-viral-prompt.txt"),
      transcriptPath: path.join(packageDir, "source-transcript.srt"),
      plainTranscriptPath,
      transcriptJsonPath,
      dialogueUnitsPath: path.join(packageDir, "podcast-dialogue-units.full.json"),
      dialogueUnitPartPaths: compactDialogueParts.map((_part, index) => path.join(
        uploadDir,
        `podcast-dialogue-units-part-${String(index + 1).padStart(2, "0")}.json`
      )),
      sourceMapPath: path.join(uploadDir, "podcast-source-map.json"),
      outputCount: requestedCount,
      workflowMode: normalizedWorkflowMode,
      dialogueUnitCount: dialogueUnits.length,
      dialogueUnitPartCount: compactDialogueParts.length,
      uploadFileCount: compactDialogueParts.length + 2,
      sourceMatchId,
      cache: { hits: [], misses: [], created: [] },
      warnings: []
    };
  }
}

module.exports = PodcastViralService;
module.exports.WORKFLOW = WORKFLOW;
module.exports.ARTIFACT_TYPE = ARTIFACT_TYPE;
module.exports.FAILURE_ARTIFACT_TYPE = FAILURE_ARTIFACT_TYPE;
module.exports.CANDIDATE_ARTIFACT_TYPE = CANDIDATE_ARTIFACT_TYPE;
module.exports.parseSrt = parseSrt;
module.exports.buildDialogueUnits = buildDialogueUnits;
module.exports.buildCompactDialogueParts = buildCompactDialogueParts;
module.exports.buildPrompt = buildPrompt;
module.exports.buildCandidateScoutPrompt = buildCandidateScoutPrompt;
module.exports.compilePodcastEdl = compilePodcastEdl;
module.exports.compilePodcastEdlFile = compilePodcastEdlFile;
module.exports.validateAccessAudit = validateAccessAudit;
module.exports.YOUTUBE_ENGLISH_SUBTITLE_TIERS = YOUTUBE_ENGLISH_SUBTITLE_TIERS;
module.exports.fetchYoutubeSubtitle = fetchYoutubeSubtitle;
