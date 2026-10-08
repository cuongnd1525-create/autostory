const { spawn, spawnSync } = require("child_process");
const { buildCliEnv } = require("./cliEnv");

function extractTextFromResponse(responseJson) {
  const parts = responseJson?.candidates?.flatMap((candidate) => candidate?.content?.parts || []) || [];
  return parts
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function splitArgs(value) {
  const text = String(value || "").trim();
  if (!text) {
    return [];
  }
  const matches = text.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((part) => part.replace(/^"|"$/g, ""));
}

function terminateProcess(child) {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      return;
    } catch (_error) {
      // Fallback
    }
  }
  child.kill("SIGKILL");
}

function runCliJson({ command, args, prompt, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: buildCliEnv() });
    const timer = setTimeout(() => {
      terminateProcess(child);
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout || stderr);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function canSpawnCommand(command) {
  const result = spawnSync(command, ["--version"], {
    windowsHide: true,
    env: buildCliEnv(),
    timeout: 5000,
    stdio: "ignore"
  });
  return !result.error || result.error.code !== "ENOENT";
}

function candidateOllamaCommands(settings = {}) {
  return [
    settings.ollamaCommand,
    process.env.OLLAMA_COMMAND,
    process.env.CINEVIRAL_OLLAMA_COMMAND,
    "ollama",
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe` : "",
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Ollama\\ollama.exe` : "",
    process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Ollama\\ollama.exe` : ""
  ].filter(Boolean);
}

function resolveOllamaCommand(settings = {}) {
  for (const command of candidateOllamaCommands(settings)) {
    if (canSpawnCommand(command)) return command;
  }
  return candidateOllamaCommands(settings)[0] || "ollama";
}

function compactSceneContext(sceneCards = [], scenes = []) {
  const cards = Array.isArray(sceneCards) ? sceneCards.slice(0, 80) : [];
  const physicalScenes = Array.isArray(scenes) ? scenes.slice(0, 80) : [];
  return {
    scenes: physicalScenes.map((scene) => ({
      sceneId: scene.sceneId,
      startSec: Number(scene.startSec || 0),
      endSec: Number(scene.endSec || 0),
      duration: Number(scene.duration || 0),
      transcript: scene.transcript || scene.audioTranscript || "",
      visualTags: scene.visualTags || scene.local_visual_tags || [],
      motionIntensity: scene.motionIntensity || scene.motion_intensity || "",
      audioEnergy: scene.audioEnergy || scene.audio_energy || ""
    })),
    sceneCards: cards.map((card) => ({
      sceneId: card.sceneId || card.id,
      startSec: Number(card.startSec || 0),
      endSec: Number(card.endSec || 0),
      title: card.title || card.beat || "",
      summary: card.summary || card.description || "",
      transcript: card.transcript || card.audioTranscript || card.text || "",
      visualTags: card.visualTags || card.local_visual_tags || []
    }))
  };
}

function buildTranslatePrompt({ segments, targetLanguage, sourceLanguage, sceneCards, scenes, media }) {
  return [
    "You are a professional subtitle translator for a movie dubbing/translation editor.",
    "Task: translate the original dialogue/subtitle segments faithfully and naturally into the target language.",
    "",
    "Critical rules:",
    "- This is DUBBING/PH? ?? TRANSLATION, not movie recap and not voiceover rewriting.",
    "- Translate what the speaker says. Do not invent new plot, relationships, names, motivations, emotions, or exposition.",
    "- Use nearby lines and scene context only to choose the correct pronoun, tense, term, name, and tone.",
    "- If visual context conflicts with ASR text, keep the spoken meaning from ASR/SRT and add no visual-only facts.",
    "- Preserve speaker intent: question stays question, command stays command, threat stays threat.",
    "- Preserve names and creature/character terms. Do not localize a name into a random Vietnamese personal name.",
    "- Do not mistake discourse markers for character names. Examples: Spanish 'Bien/Bueno/Vale' means 'Well/Okay/Alright', not a person named 'Binh'.",
    "- Keep each translated segment close to the source duration. Use maxWords as a hard ceiling whenever possible.",
    "- If a source line is unclear/noisy, translate conservatively and mark uncertainty with natural wording, not invented content.",
    `Target language: ${targetLanguage || "vi"}.`,
    `Source language: ${sourceLanguage || "auto"}.`,
    "Return JSON only:",
    "{",
    '  "segments": [',
    '    {"id":"seg_0001","text":"faithful contextual translation"}',
    "  ]",
    "}",
    "",
    "Movie/scene context for disambiguation only:",
    JSON.stringify({
      media: media ? { duration: media.duration, width: media.width, height: media.height } : {},
      ...compactSceneContext(sceneCards, scenes)
    }, null, 2),
    "",
    "Segments:",
    JSON.stringify(compactSegments(segments, 1000), null, 2)
  ].join("\n");
}

function buildPreviewSubtitlePrompt({ segments, sourceLanguage = "auto" }) {
  return [
    "You are translating preview subtitles for a video editing app.",
    "Task: translate each English storytime narration line into natural Vietnamese with full diacritics.",
    "",
    "Critical rules:",
    "- Output Vietnamese only. Do not return English.",
    "- Keep the meaning of each line, but make it concise enough to read as preview subtitles.",
    "- Preserve names such as Jay. Do not translate names.",
    "- Use Vietnamese with diacritics. Avoid không dấu text.",
    "- Return JSON only.",
    "",
    "Return schema:",
    "{",
    '  "segments": [',
    '    {"id":"draft_preview_0001","previewSubtitleVi":"..."}',
    "  ]",
    "}",
    "",
    `Source language: ${sourceLanguage || "auto"}.`,
    "Segments:",
    JSON.stringify(compactSegments(segments, 80), null, 2)
  ].join("\n");
}

function applyTranslatedSegments(segments, parsed) {
  const translatedById = new Map((parsed.segments || []).map((segment) => [segment.id, segment.text]));
  return segments.map((segment) => ({
    ...segment,
    translatedText: translatedById.get(segment.id) || segment.translatedText || segment.text || ""
  }));
}

function applyPreviewSubtitleSegments(segments, parsed) {
  const translatedById = new Map((parsed.segments || []).map((segment) => [
    segment.id,
    segment.previewSubtitleVi || segment.translatedText || segment.text || ""
  ]));
  return segments.map((segment) => ({
    ...segment,
    previewSubtitleVi: translatedById.get(segment.id) || segment.previewSubtitleVi || ""
  }));
}

function buildDiarizePrompt({ segments }) {
  return [
    "You are assigning speaker labels to subtitle segments for a movie dubbing editor.",
    "Infer likely speaker continuity from adjacent lines. Use compact labels SPEAKER_00, SPEAKER_01, etc.",
    "Also infer a simple voice design for each speaker.",
    "Return JSON only:",
    "{",
    '  "speakers": [{"id":"SPEAKER_00","voice":"female, moderate pitch"}],',
    '  "segments": [{"id":"seg_0001","speaker":"SPEAKER_00","gender":"female"}]',
    "}",
    "",
    "Segments:",
    JSON.stringify(compactSegments(segments, 180), null, 2)
  ].join("\n");
}

function buildTimingAdaptationPrompt({ segments, targetLanguage, sceneCards, scenes }) {
  return [
    "You are adapting translated movie dialogue for dubbing timing.",
    "Input already contains faithful translations. Your job is to make each line speakable within its original subtitle duration.",
    "",
    "Rules:",
    "- Do not add new plot information.",
    "- Keep the same meaning and speaker intent.",
    "- Prefer natural spoken target language.",
    "- Create a short timing-fitted dubbingLine for TTS/subtitles.",
    "- Respect maxWords. If impossible, keep the most important meaning and shorten aggressively.",
    "- Keep character names and terms consistent.",
    "",
    `Target language: ${targetLanguage || "vi"}.`,
    "Return JSON only:",
    "{",
    '  "segments": [',
    '    {"id":"seg_0001","literalTranslation":"...","naturalTranslation":"...","dubbingLine":"...", "emotion":"neutral|fear|anger|sadness|joy|urgency", "pace":"slow|normal|fast", "timingNote":"..."}',
    "  ]",
    "}",
    "",
    "Scene context:",
    JSON.stringify(compactSceneContext(sceneCards, scenes), null, 2),
    "",
    "Segments:",
    JSON.stringify(compactSegments(segments, 1000).map((segment) => ({
      ...segment,
      translatedText: segments.find((item) => item.id === segment.id)?.translatedText || "",
      previousText: segments[Math.max(0, Number(segment.index || 0) - 1)]?.translatedText || "",
      nextText: segments[Math.min(segments.length - 1, Number(segment.index || 0) + 1)]?.translatedText || ""
    })), null, 2)
  ].join("\n");
}

function buildScriptRewritePrompt({ segments, targetLanguage, sourceLanguage, sceneCards, scenes, media }) {
  const rewriteLanguage = !targetLanguage || targetLanguage === "auto"
    ? "the same language used in the source transcript"
    : targetLanguage;
  return [
    "You are a senior film script doctor rewriting a script from a source video transcript.",
    "Task: write a stronger, more engaging narration/dialogue script while preserving the original story.",
    "",
    "Non-negotiable factual rules:",
    "- Do not invent new plot events, locations, relationships, character names, motives, causes, outcomes, twists, or ending.",
    "- Do not add information that is not supported by the transcript or scene timing/context.",
    "- Preserve the original chronology and causal chain.",
    "- Preserve who does what to whom. Do not swap agents, victims, relationships, or intent.",
    "- If a source line is unclear, rewrite conservatively or keep the original meaning vague. Never fill gaps with guesses.",
    "- You may improve pacing, clarity, hook, emotion, transitions, and spoken style.",
    "- Do not simply copy the source line. Rewrite each meaningful line with fresher wording while keeping the same facts.",
    "- Very short utterances may stay close, but the full script must clearly read as a rewritten version.",
    "- Keep each rewritten segment speakable within its original duration and respect maxWords when possible.",
    "- The output should be ready for voiceover/subtitles.",
    `Language for rewritten script: ${rewriteLanguage}. Do not translate to another language.`,
    `Source language: ${sourceLanguage || "auto"}.`,
    "",
    "Return JSON only:",
    "{",
    '  "storyGuardrails": ["fact kept from source"],',
    '  "segments": [',
    '    {"id":"seg_0001","rewrittenText":"better line, same meaning and story","sourceFacts":["fact from source"],"rewriteNote":"what improved"}',
    "  ]",
    "}",
    "",
    "Scene context for grounding only:",
    JSON.stringify({
      media: media ? { duration: media.duration, width: media.width, height: media.height } : {},
      ...compactSceneContext(sceneCards, scenes)
    }, null, 2),
    "",
    "Source transcript segments:",
    JSON.stringify(compactSegments(segments, 1000).map((segment) => ({
      ...segment,
      previousText: segments[Math.max(0, Number(segment.index || 0) - 1)]?.text || "",
      nextText: segments[Math.min(segments.length - 1, Number(segment.index || 0) + 1)]?.text || ""
    })), null, 2)
  ].join("\n");
}

function languageInstruction(narrationLanguage) {
  const lookup = {
    vi: "Write the narration and subtitles in natural spoken Vietnamese for TikTok. Avoid stiff translated phrasing.",
    en: "Write the narration and subtitles in natural spoken English for TikTok. Avoid stiff or overly formal phrasing.",
    auto: "Choose the most natural language for the recap based on the user's likely audience and the footage."
  };
  return lookup[narrationLanguage] || lookup.en;
}

function buildSceneScriptReviewPrompt({
  projectMode,
  title,
  summary,
  segment,
  previousSegment,
  nextSegment,
  filmMemory,
  filmUnderstanding,
  narrativeIntelligence,
  voiceSpeed,
  narrationLanguage
}) {
  const isStorytime = projectMode === "satisfying_storytime";
  const isHighlightCut = projectMode === "highlight_cut";
  const taskContext = isStorytime
    ? [
      "Project mode: Oddly Satisfying Storytime.",
      "Important: In this mode, the narration is allowed to be a NEW fictional/alternate engagement story placed over the input video.",
      "Do not compare the storytime narration against the original video's plot, transcript, filmMemory, or backstory as factual canon.",
      "Original transcript/backstory is only optional inspiration and timing context, not a truth source for this review."
    ]
    : isHighlightCut
      ? [
        "Project mode: Highlight Cut JSON.",
        "Important: The selected segment is a short highlight clipped from the original video by sourceStartSec/sourceEndSec.",
        "Review whether the caption, voiceover_text/dubbingLine, audio mode, and timing are suitable for this exact highlight segment.",
        "Do not require a full movie recap structure. Focus on timestamp accuracy, hook strength, audio choice, and whether voice/caption fit the selected clip."
      ]
    : [
      "Project mode: Movie Recap.",
      "Important: In this mode, the narration must stay faithful to the original video's plot, transcript, filmMemory, and character continuity."
    ];
  const reviewGoals = isStorytime
    ? [
      "- Decide if the storytime line is engaging, clear, visually aligned, and internally consistent with the current alternate story.",
      "- Treat provided fastDraftVoiceSec/fastDraftTimelineSec/fastDraftFitRatio or voiceTiming as measured machine data from the app; do not re-measure or invent timing.",
      "- Focus on semantic/visual fit: whether the narration talks about the action visible in this scene and connects naturally to nearby storytime beats.",
      "- You may mention measured timing as context, but the app's quality gate owns duration pass/fail.",
      "- Detect weak hooks, confusing wording, timeline jumps, repeated ideas, or mismatch with nearby storytime beats.",
      "- If it does not work, propose a better narrationLine for this exact storytime beat.",
      "- Do not flag differences from the original video plot as errors."
    ]
    : isHighlightCut
      ? [
        "- Decide if this highlight segment is useful and understandable as a standalone short-form clip.",
        "- Decide if caption and voiceover match the source timestamp and do not create language/audio confusion.",
        "- Detect if voiceover is misleading, should use original_audio instead, or contradicts the clipped moment.",
        "- Treat measured timing data as app-owned machine data. Do not invent timing; only use it as context for rewrite wording.",
        "- If it does not work, propose a tighter or better-timed caption/narrationLine for this exact highlight segment.",
        "- Respect audioMode/requestedAudioMode: original_audio segments may have no voiceover."
      ]
    : [
      "- Decide if the script describes the selected scene correctly.",
      "- Treat provided timing metrics as measured machine data; focus your judgment on visual/story semantics.",
      "- Detect if the script talks about a different scene, reveals too early, or invents unsupported character motivation/emotion.",
      "- If it does not match, propose a better narrationLine for this exact scene."
    ];
  const rules = isStorytime
    ? [
      "- Do not rewrite if the current storytime line is already good.",
      "- Suggested rewrite must preserve the alternate story direction already established by the current segment and nearby segments.",
      "- Keep the rewrite naturally paced for the scene duration, but do not claim exact timing unless measured data is provided.",
      "- Do not accuse the script of contradicting the original movie/video unless the user explicitly marks this project as faithful recap.",
      "- Keep names, stakes, and setup consistent across nearby storytime beats."
    ]
    : isHighlightCut
      ? [
      "- Do not rewrite if caption/voiceover/audio mode already work for the selected timestamp.",
      "- Suggested rewrite must stay short, punchy, and faithful to what the clipped moment supports.",
      "- If the app-provided measured timing says the voice is sparse, make the rewrite meaningfully longer while staying faithful to the clipped moment.",
      "- If the segment uses original_audio and no voiceover, judge caption clarity and audio choice instead of demanding narration.",
      "- Flag mixed-language captions/voiceover only when it hurts clarity for the intended output.",
      "- Keep the rewrite naturally paced for the segment duration."
      ]
    : [
      "- Do not rewrite if the current script is already good.",
      "- Suggested rewrite must only describe or imply what the selected scene/story beat supports.",
      "- Keep the rewrite short enough for the scene duration and voice speed.",
      "- If evidence is weak, use softer language; do not state motives/emotions as fact.",
      "- Keep stable character labels from character bible."
    ];
  return [
    "You are a strict AI scene/script reviewer for a short movie recap tool.",
    isStorytime
      ? "Evaluate ONE selected storytime narration beat for engagement, continuity, clarity, and expected voice timing."
      : isHighlightCut
        ? "Evaluate ONE selected Highlight Cut segment for timestamp fit, caption/voice clarity, audio choice, and short-form impact."
      : "Evaluate whether the narration/script for ONE selected scene matches the visual event, story beat, character state, and expected voice timing.",
    languageInstruction(narrationLanguage),
    "",
    ...taskContext,
    "",
    "Review goals:",
    ...reviewGoals,
    "",
    "Rules:",
    ...rules,
    "",
    "Return JSON only:",
    "{",
    '  "verdict": "pass|needs_rewrite|warning",',
    '  "summary": "short human-readable review",',
    '  "scores": {"sceneMatch": 0, "storyCoherence": 0, "voiceFit": 0, "evidenceSupport": 0},',
    '  "issues": [{"code":"scene_mismatch|voice_too_long|voice_too_short|weak_evidence|wrong_character|reveals_too_early|caption_only","severity":"warning|error","message":"..."}],',
    '  "rewriteSuggestion": {"shouldApply": true, "narrationLine": "...", "subtitleText": "...", "reason": "..."},',
    '  "voiceTiming": {"estimatedSpeechSec": 0, "sceneDurationSec": 0, "fitRatio": 0}',
    "}",
    "",
    "Context:",
    JSON.stringify({
      title,
      summary,
      projectMode,
      voiceSpeed,
      filmMemory: filmMemory || {},
      filmUnderstanding: filmUnderstanding || {},
      narrativeIntelligence: narrativeIntelligence || {},
      selectedSegment: segment || {},
      previousSegment: previousSegment || null,
      nextSegment: nextSegment || null
    }, null, 2)
  ].join("\n");
}

function buildFailedSceneRewritePrompt({
  projectMode,
  title,
  summary,
  segments,
  failedSegments,
  narrationLanguage,
  voiceSpeed
}) {
  const isStorytime = projectMode === "satisfying_storytime";
  const isHighlightCut = projectMode === "highlight_cut";
  return [
    "You are rewriting only the failed narration/caption beats for a short-form video editor.",
    languageInstruction(narrationLanguage),
    "",
    isStorytime
      ? "Mode: Oddly Satisfying Storytime. The story may be fictional/alternate, but each rewritten beat must match the visual moment/timeline and preserve continuity with nearby beats."
      : isHighlightCut
        ? "Mode: Highlight Cut. Rewrites must match the clipped source timestamp and must not invent facts beyond what the clip supports."
        : "Mode: Movie Recap. Rewrites must stay faithful to the scene/story beat.",
    "",
    "Critical rules:",
    "- Rewrite ONLY the failed segments listed in failedSegments.",
    "- Do NOT change startSec, endSec, sourceStartSec, sourceEndSec, audioMode, or segment order.",
    "- Keep each narrationLine aligned to that exact segment, not a later or earlier scene.",
    "- Write enough narration to fit the segment duration, but do not make it so long that TTS must be cut.",
    "- Use measured fastDraftVoiceSec/fastDraftTimelineSec/fastDraftFitRatio when present. Target fitRatio 0.85-1.00; never exceed 1.08.",
    "- If a segment failed because voice is too short/sparse, make the line meaningfully longer and more continuous.",
    "- If a segment failed because voice is too long, tighten it while preserving the point.",
    "- Keep continuity with previous and next segments.",
    "- Return JSON only.",
    "",
    "Return schema:",
    "{",
    '  "rewrites": [',
    '    {"index": 0, "narrationLine": "...", "subtitleText": "...", "reason": "..."}',
    "  ]",
    "}",
    "",
    "Context:",
    JSON.stringify({
      title,
      summary,
      projectMode,
      voiceSpeed,
      allSegments: segments,
      failedSegments
    }, null, 2)
  ].join("\n");
}

function applyAdaptedSegments(segments, parsed) {
  const adaptedById = new Map((parsed.segments || []).map((segment) => [segment.id, segment]));
  return segments.map((segment) => {
    const adapted = adaptedById.get(segment.id) || {};
    const fallback = segment.translatedText || segment.text || "";
    return {
      ...segment,
      literalTranslation: adapted.literalTranslation || segment.literalTranslation || fallback,
      naturalTranslation: adapted.naturalTranslation || segment.naturalTranslation || fallback,
      dubbingLine: adapted.dubbingLine || segment.dubbingLine || fallback,
      translatedText: adapted.dubbingLine || segment.translatedText || fallback,
      prosody: {
        emotion: adapted.emotion || segment.prosody?.emotion || "neutral",
        pace: adapted.pace || segment.prosody?.pace || "normal"
      },
      timingNote: adapted.timingNote || segment.timingNote || ""
    };
  });
}

function applyRewrittenScriptSegments(segments, parsed) {
  const rewrittenById = new Map((parsed.segments || []).map((segment) => [segment.id, segment]));
  return {
    storyGuardrails: parsed.storyGuardrails || [],
    segments: segments.map((segment) => {
      const rewritten = rewrittenById.get(segment.id) || {};
      const original = segment.text || segment.originalText || "";
      const rewrittenText = rewritten.rewrittenText || rewritten.text || segment.rewrittenScript || original;
      return {
        ...segment,
        originalText: original,
        rewrittenScript: rewrittenText,
        translatedText: rewrittenText,
        dubbingLine: rewrittenText,
        rewriteNote: rewritten.rewriteNote || segment.rewriteNote || "",
        sourceFacts: Array.isArray(rewritten.sourceFacts) ? rewritten.sourceFacts : segment.sourceFacts || []
      };
    })
  };
}

function applyDiarizedSegments(segments, parsed) {
  const speakerById = new Map((parsed.segments || []).map((segment) => [segment.id, segment]));
  return {
    speakers: parsed.speakers || [],
    segments: segments.map((segment, index) => {
      const assigned = speakerById.get(segment.id);
      return {
        ...segment,
        speaker: assigned?.speaker || segment.speaker || `SPEAKER_${String(index % 2).padStart(2, "0")}`,
        gender: assigned?.gender || segment.gender || "unknown"
      };
    })
  };
}

function extractJsonBlock(text) {
  const fencedMatch = String(text || "").match(/```json\s*([\s\S]*?)```/i);
  const raw = fencedMatch ? fencedMatch[1] : String(text || "");
  const parsed = parseFirstJsonValue(raw);
  if (parsed === null) {
    throw new Error("AI response did not contain valid JSON.");
  }
  return parsed;
}

function parseFirstJsonValue(rawText) {
  const raw = String(rawText || "");
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{" && raw[start] !== "[") continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
      } else if (char === "}" || char === "]") {
        if (stack[stack.length - 1] !== char) {
          break;
        }
        stack.pop();
        if (stack.length === 0) {
          try {
            return JSON.parse(raw.slice(start, index + 1));
          } catch (_error) {
            break;
          }
        }
      }
    }
  }
  return null;
}

async function readResponseJson(response, label = "response") {
  const text = await response.text();
  const parsed = parseFirstJsonValue(text);
  if (parsed === null) {
    throw new Error(`${label} did not contain valid JSON.`);
  }
  return parsed;
}

function compactSegments(segments, maxSegments = 120) {
  const list = Array.isArray(segments) ? segments : [];
  const sampled = list.length > maxSegments
    ? Array.from({ length: maxSegments }, (_value, index) => {
        const sourceIndex = Math.floor((index / Math.max(1, maxSegments - 1)) * (list.length - 1));
        return list[sourceIndex];
      })
    : list;

  return sampled.map((segment) => ({
    id: segment.id,
    index: segment.index,
    startSec: Number(segment.startSec || 0),
    endSec: Number(segment.endSec || 0),
    durationSec: Number((Number(segment.endSec || 0) - Number(segment.startSec || 0)).toFixed(3)),
    maxWords: Math.max(3, Math.floor((Number(segment.endSec || 0) - Number(segment.startSec || 0)) * 2.4)),
    text: segment.text || segment.originalText || "",
    speaker: segment.speaker || ""
  }));
}

const VertexAiService = require("./vertexAiService");

class GeminiTextProvider {
  constructor(settings = {}) {
    if (!settings.geminiApiKey) {
      throw new Error("Gemini API key is missing. Add it in Settings first.");
    }
    this.apiKey = settings.geminiApiKey;
    this.model = settings.geminiModel || "gemini-2.5-pro";
    this.baseUrl = "https://generativelanguage.googleapis.com";
  }

  async generateJson(prompt, temperature = 0.25) {
    const response = await fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        generationConfig: {
          temperature,
          responseMimeType: "application/json"
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed: ${await response.text()}`);
    }

    const payload = await readResponseJson(response, "Gemini provider response");
    return extractJsonBlock(extractTextFromResponse(payload));
  }

  async translateSegments({ segments, targetLanguage, sourceLanguage, sceneCards, scenes, media }) {
    const parsed = await this.generateJson(buildTranslatePrompt({
      segments,
      targetLanguage,
      sourceLanguage,
      sceneCards,
      scenes,
      media
    }), 0.12);
    return applyTranslatedSegments(segments, parsed);
  }

  async translatePreviewSubtitles({ segments, sourceLanguage }) {
    const parsed = await this.generateJson(buildPreviewSubtitlePrompt({ segments, sourceLanguage }), 0.1);
    return applyPreviewSubtitleSegments(segments, parsed);
  }

  async adaptDubbingSegments({ segments, targetLanguage, sceneCards, scenes }) {
    const parsed = await this.generateJson(buildTimingAdaptationPrompt({
      segments,
      targetLanguage,
      sceneCards,
      scenes
    }), 0.16);
    return applyAdaptedSegments(segments, parsed);
  }

  async rewriteScriptSegments({ segments, targetLanguage, sourceLanguage, sceneCards, scenes, media }) {
    const parsed = await this.generateJson(buildScriptRewritePrompt({
      segments,
      targetLanguage,
      sourceLanguage,
      sceneCards,
      scenes,
      media
    }), 0.22);
    return applyRewrittenScriptSegments(segments, parsed);
  }

  async diarizeSegments({ segments }) {
    const parsed = await this.generateJson(buildDiarizePrompt({ segments }), 0.15);
    return applyDiarizedSegments(segments, parsed);
  }

  async reviewSceneScript(payload) {
    return this.generateJson(buildSceneScriptReviewPrompt(payload), 0.22);
  }

  async rewriteFailedSceneScripts(payload) {
    return this.generateJson(buildFailedSceneRewritePrompt(payload), 0.2);
  }
}

class VertexTextProvider extends GeminiTextProvider {
  constructor(settings = {}) {
    super({ geminiApiKey: "vertex-provider", geminiModel: settings.vertexEconomyModel || "gemini-2.5-flash-lite" });
    this.vertex = new VertexAiService(settings);
    this.model = this.vertex.getModel("text_utility");
  }

  async generateJson(prompt, temperature = 0.25) {
    return this.vertex.generateJson(prompt, temperature, "text_utility");
  }
}

class AntigravityCliProvider {
  constructor(settings = {}) {
    const commandParts = splitArgs(settings.antigravityCommand || process.env.ANTIGRAVITY_COMMAND || "agy");
    this.command = commandParts[0] || "agy";
    this.commandArgs = commandParts.slice(1);
    this.argsTemplate = settings.antigravityArgs || process.env.ANTIGRAVITY_ARGS || "";
    const { normalizeAntigravityModel } = require("./manualAntigravityStage1Service");
    this.model = normalizeAntigravityModel(settings.antigravityModel || process.env.ANTIGRAVITY_MODEL || "", settings.antigravityReasoning);
    const rawTimeout = Number(settings.antigravityTimeoutMs || process.env.ANTIGRAVITY_TIMEOUT_MS || 900000);
    this.timeoutMs = Math.max(15000, rawTimeout === 300000 ? 900000 : rawTimeout);
  }

  buildArgs(prompt) {
    const base = [...this.commandArgs, ...splitArgs(this.argsTemplate)];
    const withModel = this.model && !base.includes("--model")
      ? [...base, "--model", this.model]
      : base;
    if (withModel.some((arg) => arg.includes("{prompt}"))) {
      return withModel.map((arg) => arg.replace("{prompt}", prompt));
    }
    return withModel;
  }

  async generateJson(prompt) {
    const output = await runCliJson({
      command: this.command,
      args: this.buildArgs(prompt),
      prompt,
      timeoutMs: this.timeoutMs
    });
    return extractJsonBlock(output);
  }

  async translateSegments({ segments, targetLanguage, sourceLanguage, sceneCards, scenes, media }) {
    const parsed = await this.generateJson(buildTranslatePrompt({
      segments,
      targetLanguage,
      sourceLanguage,
      sceneCards,
      scenes,
      media
    }));
    return applyTranslatedSegments(segments, parsed);
  }

  async translatePreviewSubtitles({ segments, sourceLanguage }) {
    const parsed = await this.generateJson(buildPreviewSubtitlePrompt({ segments, sourceLanguage }));
    return applyPreviewSubtitleSegments(segments, parsed);
  }

  async adaptDubbingSegments({ segments, targetLanguage, sceneCards, scenes }) {
    const parsed = await this.generateJson(buildTimingAdaptationPrompt({
      segments,
      targetLanguage,
      sceneCards,
      scenes
    }));
    return applyAdaptedSegments(segments, parsed);
  }

  async rewriteScriptSegments({ segments, targetLanguage, sourceLanguage, sceneCards, scenes, media }) {
    const parsed = await this.generateJson(buildScriptRewritePrompt({
      segments,
      targetLanguage,
      sourceLanguage,
      sceneCards,
      scenes,
      media
    }));
    return applyRewrittenScriptSegments(segments, parsed);
  }

  async diarizeSegments({ segments }) {
    const parsed = await this.generateJson(buildDiarizePrompt({ segments }));
    return applyDiarizedSegments(segments, parsed);
  }

  async reviewSceneScript(payload) {
    return this.generateJson(buildSceneScriptReviewPrompt(payload));
  }

  async rewriteFailedSceneScripts(payload) {
    return this.generateJson(buildFailedSceneRewritePrompt(payload));
  }
}

class OllamaLocalProvider {
  constructor(settings = {}) {
    this.command = resolveOllamaCommand(settings);
    this.model = settings.ollamaReviewModel || settings.ollamaVisionModel || process.env.CINEVIRAL_OLLAMA_REVIEW_MODEL || "gemma4";
    this.timeoutMs = Math.max(15000, Number(settings.ollamaTimeoutMs || process.env.OLLAMA_TIMEOUT_MS || 240000));
  }

  async generateJson(prompt) {
    const output = await runCliJson({
      command: this.command,
      args: ["run", this.model],
      prompt: [
        "Return valid JSON only. No markdown fences. No explanation.",
        prompt
      ].join("\n\n"),
      timeoutMs: this.timeoutMs
    });
    return extractJsonBlock(output);
  }

  async translateSegments({ segments }) {
    return segments.map((segment) => ({
      ...segment,
      translatedText: segment.translatedText || segment.text || ""
    }));
  }

  async translatePreviewSubtitles({ segments }) {
    return segments.map((segment) => ({
      ...segment,
      previewSubtitleVi: segment.previewSubtitleVi || ""
    }));
  }

  async diarizeSegments({ segments }) {
    return {
      speakers: [],
      segments
    };
  }

  async adaptDubbingSegments({ segments }) {
    return applyAdaptedSegments(segments, { segments: [] });
  }

  async rewriteScriptSegments({ segments }) {
    return applyRewrittenScriptSegments(segments, { segments: [] });
  }

  async reviewSceneScript(payload) {
    return this.generateJson(buildSceneScriptReviewPrompt(payload));
  }

  async rewriteFailedSceneScripts(payload) {
    return this.generateJson(buildFailedSceneRewritePrompt(payload));
  }
}

class LocalFallbackProvider {
  async translateSegments({ segments }) {
    return segments.map((segment) => ({
      ...segment,
      translatedText: segment.translatedText || segment.text || ""
    }));
  }

  async translatePreviewSubtitles({ segments }) {
    return segments.map((segment) => ({
      ...segment,
      previewSubtitleVi: segment.previewSubtitleVi || ""
    }));
  }

  async diarizeSegments({ segments }) {
    return {
      speakers: [
        { id: "SPEAKER_00", voice: "female, moderate pitch" },
        { id: "SPEAKER_01", voice: "male, moderate pitch" }
      ],
      segments: segments.map((segment, index) => ({
        ...segment,
        speaker: segment.speaker || `SPEAKER_${String(index % 2).padStart(2, "0")}`,
        gender: segment.gender || (index % 2 === 0 ? "female" : "male")
      }))
    };
  }

  async adaptDubbingSegments({ segments }) {
    return applyAdaptedSegments(segments, { segments: [] });
  }

  async rewriteScriptSegments({ segments }) {
    return applyRewrittenScriptSegments(segments, { segments: [] });
  }

  async reviewSceneScript() {
    throw new Error("AI scene/script review needs Gemini or Antigravity CLI. Local fallback cannot evaluate scene quality.");
  }

  async rewriteFailedSceneScripts() {
    throw new Error("AI failed-scene rewrite needs Gemini or Antigravity CLI. Local fallback cannot rewrite failed scenes.");
  }
}

function createAiProvider(settings = {}) {
  const provider = settings.aiProvider || settings.defaultAiProvider || "gemini";
  if (provider === "gemini") {
    return new GeminiTextProvider(settings);
  }
  if (provider === "vertex_ai") {
    return new VertexTextProvider(settings);
  }
  if (provider === "antigravity_cli") {
    const commandParts = splitArgs(settings.antigravityCommand || process.env.ANTIGRAVITY_COMMAND || "agy");
    const command = commandParts[0] || "agy";
    if (settings.geminiApiKey && !canSpawnCommand(command)) {
      return new GeminiTextProvider({
        ...settings,
        aiProvider: "gemini"
      });
    }
    return new AntigravityCliProvider(settings);
  }
  if (provider === "ollama_local") {
    return new OllamaLocalProvider(settings);
  }
  return new LocalFallbackProvider(settings);
}

module.exports = {
  createAiProvider,
  GeminiTextProvider,
  VertexTextProvider,
  AntigravityCliProvider,
  OllamaLocalProvider,
  LocalFallbackProvider
};
