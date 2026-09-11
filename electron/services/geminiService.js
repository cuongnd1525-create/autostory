const fs = require("fs");
const path = require("path");
const { DEFAULT_WORDS_PER_SECOND } = require("./voiceTimingPolicy");

function inferMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const map = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".webm": "video/webm",
    ".json": "application/json",
    ".txt": "text/plain",
    ".srt": "text/plain",
    ".vtt": "text/vtt",
    ".csv": "text/csv"
  };
  return map[extension] || "application/octet-stream";
}

function extractTextFromResponse(responseJson) {
  const parts = responseJson?.candidates?.flatMap((candidate) => candidate?.content?.parts || []) || [];
  return parts
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractJsonBlock(text) {
  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fencedMatch ? fencedMatch[1] : text;
  const parsed = parseFirstJsonValue(raw);
  if (parsed === null) {
    throw new Error("Gemini response did not contain valid JSON.");
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

function countWordsForPrompt(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

const RETRY_DELAYS_MS = [2000, 5000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

function isTransientError(error) {
  if (error?.name === "AbortError") return false;
  return !error.status || isTransientStatus(error.status);
}

function genreInstruction(genreMode) {
  const lookup = {
    thriller: [
      "Genre: Thriller / Horror.",
      "Prioritize silence before sound explosions. Focus on close-ups of eyes, breathing, shadows.",
      "Hook must be the single most terrifying or shocking moment in the entire film.",
      "Setup should feel uneasy — something is off. Conflict reveals the danger. Escalation is pure survival horror.",
      "Cliffhanger should leave the viewer wondering if the character survived or made the right choice.",
      "Source audio is critical: use silence, then sudden loud sounds for maximum jump-scare effect."
    ].join(" "),
    action: [
      "Genre: Action.",
      "Prioritize continuous motion, explosions, chases, fights. Cut all unnecessary dialogue.",
      "Hook must be the biggest explosion, crash, or fight moment.",
      "Setup should be rapid-fire context (who, what, where) — keep it under 20% of runtime.",
      "Conflict and Escalation should be non-stop action with quick cuts. Keep only impact sounds and driving music.",
      "Cliffhanger can be a moment right before the final showdown or an unresolved rivalry."
    ].join(" "),
    healing: [
      "Genre: Healing / Romance.",
      "Prioritize beautiful scenery, warm colors, and emotional close-ups.",
      "Hook should be the most visually stunning or emotionally touching moment.",
      "Setup paints the world and introduces the characters with warm, inviting shots.",
      "Conflict is the emotional turning point — heartbreak, misunderstanding, or sacrifice.",
      "Escalation shows the emotional peak — reunion, confession, or realization.",
      "Cliffhanger is a philosophical question or an open ending about love and life.",
      "Pacing should be slow and contemplative. Use wide landscape shots."
    ].join(" "),
    drama: [
      "Genre: Drama.",
      "Prioritize heavy emotional moments, arguments, revelations, and tears.",
      "Hook should be the peak emotional breakdown or the most shocking truth revealed.",
      "Setup introduces the relationship or the problem. Conflict builds the interpersonal tension.",
      "Escalation is the climax of the argument or emotional release.",
      "Cliffhanger should end on a lingering look, an unanswered question, or a painful decision.",
      "Pacing should be deliberate, allowing the emotional weight to sink in."
    ].join(" "),
    mystery: [
      "Genre: Mystery / Suspense.",
      "Prioritize clues, shifting eyes, tense pauses, and shocking discoveries.",
      "Hook should be the moment the mystery deepens or the killer is almost revealed.",
      "Setup gives the basic crime/puzzle. Conflict introduces the false lead or danger.",
      "Escalation is the tense investigation or chase.",
      "Cliffhanger ends right before the final reveal or when a new twist drops.",
      "Pacing should be calculating and methodical, making the viewer guess."
    ].join(" "),
    comedy: [
      "Genre: Comedy.",
      "Prioritize physical comedy, hilarious reactions, and fast-paced dialogue.",
      "Hook should be the funniest punchline or the most absurd situation.",
      "Setup explains the ridiculous premise. Conflict is the misunderstanding or mistake.",
      "Escalation is the chaos ensuing from the mistake.",
      "Cliffhanger should be a comedic beat or a ridiculous reaction shot.",
      "Pacing must be very fast. Cut dead air. High energy."
    ].join(" "),
    "sci-fi": [
      "Genre: Sci-Fi / Fantasy.",
      "Prioritize futuristic tech, magic, grand vistas, and mind-bending concepts.",
      "Hook should be the most visually mind-blowing sequence or the biggest conceptual shock.",
      "Setup explains the world rules quickly. Conflict is the system breaking or the alien threat.",
      "Escalation is the massive battle or the mind-bending climax.",
      "Cliffhanger ends on a philosophical question about humanity or a vast unknown.",
      "Pacing should balance fast action with moments of awe."
    ].join(" ")
  };
  return lookup[genreMode] || lookup.thriller;
}

function perspectiveInstruction(perspective) {
  if (perspective === "first_person") {
    return "Default to objective THIRD PERSON narration. Use FIRST PERSON only if the film memory clearly identifies one continuous protagonist and the scene is unmistakably from that character's point of view. If unsure, use names/roles like 'he', 'she', 'the hunter', 'the girl', 'the two of them' instead of 'I'.";
  }
  return "Write narration in objective THIRD PERSON with sharp, punchy pacing. Do not use 'I', 'me', or 'my' unless the film memory proves a single continuous protagonist POV. Prefer names/roles like 'the hunter', 'the girl', 'the creature', 'he', 'she', or 'they'.";
}

function languageInstruction(narrationLanguage) {
  const lookup = {
    vi: "Write the narration and subtitles in natural spoken Vietnamese for TikTok. Avoid stiff translated phrasing.",
    en: "Write the narration and subtitles in natural spoken English for TikTok. Avoid stiff or overly formal phrasing.",
    auto: "Choose the most natural language for the recap based on the user's likely audience and the footage."
  };
  return lookup[narrationLanguage] || lookup.en;
}

function viralAngleInstruction(viralAngle) {
  if (!viralAngle) {
    return "Viral angle: choose the sharpest TikTok-native angle from the footage, not a neutral plot summary.";
  }
  return [
    `Viral angle: ${viralAngle.label || viralAngle.id}.`,
    viralAngle.instruction || "",
    "Use this as the emotional lens for scene selection and narration. Do not drift into a generic plot recap."
  ].filter(Boolean).join(" ");
}

function buildEvidenceStoreBrief(evidenceStore) {
  if (!evidenceStore || !Array.isArray(evidenceStore.scenes)) {
    return "";
  }
  const maxScenes = 220;
  const scenes = evidenceStore.scenes.slice(0, maxScenes).map((scene) => ({
    sceneId: scene.sceneId,
    timestamp: scene.timestamp,
    confidence: scene.confidence,
    transcript: scene.transcript?.text || "",
    visualCaptions: (scene.visualCaptions || []).map((caption) => ({
      evidenceId: caption.evidenceId,
      text: caption.text,
      confidence: caption.confidence,
      evidenceLevel: caption.evidenceLevel
    })),
    objects: (scene.objects || []).slice(0, 8).map((object) => ({
      label: object.label,
      confidence: object.confidence
    })),
    characterCandidates: (scene.characterCandidates || []).slice(0, 4).map((candidate) => ({
      label: candidate.label,
      confidence: candidate.confidence,
      evidenceIds: candidate.evidenceIds || []
    })),
    evidenceIds: (scene.evidence || []).map((entry) => entry.evidenceId),
    weak: Number(scene.confidence || 0) < 0.45
  }));
  return [
    "Evidence Store brief:",
    JSON.stringify({
      schemaVersion: evidenceStore.schemaVersion || "unknown",
      priority: evidenceStore.policy?.priority || ["Accuracy", "Grounding", "Story Coherence", "Retention", "Virality"],
      report: evidenceStore.report || {},
      scenes,
      truncated: evidenceStore.scenes.length > maxScenes
    }, null, 2),
    "",
    "Evidence-first rules:",
    "- Treat Evidence Store entries as the only reliable truth source.",
    "- Every important claim about plot, character, threat, object, action, motive, or emotion must be grounded in sceneId + evidenceId.",
    "- If a scene is weak or only has local_visual_tags, mark the conclusion as uncertain instead of inventing story facts.",
    "- Do not introduce characters, relationships, locations, or plot twists that are not supported by the Evidence Store.",
    "- Prefer accuracy and grounding over retention or viral phrasing."
  ].join("\n");
}

function buildEvidenceGraphBrief(evidenceGraph) {
  if (!evidenceGraph || !Array.isArray(evidenceGraph.nodes)) {
    return "";
  }
  const maxNodes = 260;
  const maxEdges = 420;
  const nodes = evidenceGraph.nodes.slice(0, maxNodes).map((node) => ({
    id: node.id,
    type: node.type,
    label: node.label,
    sceneId: node.sceneId || node.data?.sceneId || "",
    confidence: node.confidence,
    evidenceLevel: node.evidenceLevel,
    evidenceIds: node.data?.evidenceIds || []
  }));
  const edges = (Array.isArray(evidenceGraph.edges) ? evidenceGraph.edges : []).slice(0, maxEdges).map((edge) => ({
    from: edge.from,
    to: edge.to,
    type: edge.type,
    confidence: edge.confidence
  }));
  return [
    "Evidence Graph brief:",
    JSON.stringify({
      schemaVersion: evidenceGraph.schemaVersion || "unknown",
      report: evidenceGraph.report || {},
      nodes,
      edges,
      truncated: evidenceGraph.nodes.length > maxNodes || (evidenceGraph.edges || []).length > maxEdges
    }, null, 2),
    "",
    "Evidence Graph rules:",
    "- Scene/action/dialogue/object nodes are evidence-derived.",
    "- Plot event nodes are hypotheses unless they have supported_by edges to evidence nodes.",
    "- Narrative Intelligence may connect events causally, but must lower confidence when graph support is weak.",
    "- Do not invent a character, motivation, relationship, or twist that has no path to evidence."
  ].join("\n");
}

function buildCharacterTrackerBrief(characterTracker) {
  if (!characterTracker || !Array.isArray(characterTracker.characters)) {
    return "";
  }
  return [
    "Character Tracker brief:",
    JSON.stringify({
      schemaVersion: characterTracker.schemaVersion || "unknown",
      report: characterTracker.report || {},
      characters: characterTracker.characters.slice(0, 40).map((character) => ({
        characterId: character.characterId,
        stableLabel: character.stableLabel,
        role: character.role,
        status: character.status,
        confidence: character.confidence,
        firstAppearanceSceneId: character.firstAppearanceSceneId,
        appearanceSceneIds: (character.appearanceHistory || []).map((entry) => entry.sceneId).slice(0, 20),
        evidenceIds: character.evidenceIds || []
      }))
    }, null, 2),
    "",
    "Character Tracker rules:",
    "- Use only tracked characterIds/stableLabels when naming characters.",
    "- If a character status is weak_candidate, do not state identity, relationships, goals, or emotions as certain.",
    "- Do not create new character relationships unless the tracker/report supports both characters."
  ].join("\n");
}

function buildVisualEventAnchors(segments) {
  return (segments || []).map((segment) => {
    const text = [
      segment.description,
      segment.reason,
      segment.screenText,
      segment.scenePurpose,
      segment.currentNarrationLine
    ].join(" ").toLowerCase();
    const anchors = [];

    if (/android|robot|machine|mechanic|synthetic|legless|no legs|wires|face.*split|face.*tear|not human/.test(text)) {
      anchors.push({
        eventType: "android_reveal",
        syncStrictness: "hard",
        mustMention: "the visual proof that she is not fully human",
        forbiddenBeforeTerms: ["android", "robot", "machine", "legless", "no legs", "not human", "wires", "mechanical"]
      });
    }
    if (/twist|reveal|turns out|actually|secret/.test(text)) {
      anchors.push({
        eventType: "twist_reveal",
        syncStrictness: "hard",
        mustMention: "the twist only when the visual evidence is on screen",
        forbiddenBeforeTerms: ["turns out", "actually", "secret", "reveal"]
      });
    }
    if (/explode|explosion|blast|crash|fall|falling|charge|attack|kill|blood|monster|beast|creature/.test(text)) {
      anchors.push({
        eventType: "impact_moment",
        syncStrictness: "medium",
        mustMention: "the immediate physical action visible in this block",
        forbiddenBeforeTerms: []
      });
    }

    return {
      index: segment.index,
      role: segment.role,
      timelineStart: segment.timelineStart,
      timelineEnd: segment.timelineEnd,
      description: segment.description,
      anchors
    };
  }).filter((entry) => entry.anchors.length);
}

function getNarrationWordTargets(targetDuration, voiceSpeed = 1) {
  const speed = Math.max(0.7, Math.min(1.5, Number(voiceSpeed || 1)));
  const targetWords = Math.max(18, Math.round(Number(targetDuration || 30) * DEFAULT_WORDS_PER_SECOND * speed));
  const minWords = Math.max(14, Math.round(targetWords * 0.90));
  const maxWords = Math.max(minWords + 6, Math.round(targetWords * 1.10));
  return { targetWords, minWords, maxWords, voiceSpeed: speed };
}

class GeminiService {
  constructor(apiKey, model) {
    if (!apiKey) {
      throw new Error("Gemini API key is missing. Add it in Settings first.");
    }
    this.apiKey = apiKey;
    this.model = model || "gemini-2.5-pro";
    this.baseUrl = "https://generativelanguage.googleapis.com";
  }

  async fetchWithRetry(makeRequest, label) {
    let lastError = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await makeRequest();
        if (response.ok) {
          return response;
        }

        const message = await response.text();
        const error = new Error(`${label} failed: ${message}`);
        error.status = response.status;
        if (!isTransientStatus(response.status) || attempt === RETRY_DELAYS_MS.length) {
          throw error;
        }
        lastError = error;
      } catch (error) {
        if (!isTransientError(error) || attempt === RETRY_DELAYS_MS.length) {
          throw error;
        }
        lastError = error;
      }

      await sleep(RETRY_DELAYS_MS[attempt]);
    }

    throw lastError;
  }

  async uploadFile(videoPath, signal) {
    const displayName = path.basename(videoPath);
    const mimeType = inferMimeType(videoPath);
    const stat = fs.statSync(videoPath);

    const startResponse = await this.fetchWithRetry(() => fetch(`${this.baseUrl}/upload/v1beta/files?key=${this.apiKey}`, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(stat.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json"
      },
      signal,
      body: JSON.stringify({
        file: {
          display_name: displayName
        }
      })
    }), "Gemini upload start");

    const uploadUrl = startResponse.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      throw new Error("Gemini upload URL was missing from the response.");
    }

    const uploadResponse = await this.fetchWithRetry(() => fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": String(stat.size),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"
      },
      signal,
      body: fs.createReadStream(videoPath),
      duplex: "half"
    }), "Gemini upload finalize");

    const uploadPayload = await readResponseJson(uploadResponse, "Gemini upload finalize response");
    return uploadPayload.file;
  }

  async waitForFileActive(file, signal) {
    const timeoutAt = Date.now() + 5 * 60 * 1000;

    while (Date.now() < timeoutAt) {
      const response = await this.fetchWithRetry(
        () => fetch(`${this.baseUrl}/v1beta/${file.name}?key=${this.apiKey}`, { signal }),
        "Gemini file polling"
      );
      const payload = await readResponseJson(response, "Gemini file polling response");
      const state = payload?.state || payload?.file?.state;

      if (!state || state === "ACTIVE") {
        return payload;
      }
      if (state === "FAILED") {
        throw new Error("Gemini failed to process the uploaded video.");
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    throw new Error("Gemini file processing timed out.");
  }

  async generateJsonFromFiles({ filePaths = [], prompt, temperature = 0.2, onProgress, signal } = {}) {
    const paths = [...new Set(filePaths.filter(Boolean))];
    const uploadedFiles = [];
    try {
      for (let index = 0; index < paths.length; index += 1) {
        if (signal?.aborted) throw new Error("Đã dừng tác vụ AI.");
        onProgress?.({
          percent: 10 + Math.round((index / Math.max(1, paths.length)) * 35),
          message: `Đang tải input ${index + 1}/${paths.length} lên Gemini`
        });
        const uploaded = await this.uploadFile(paths[index], signal);
        await this.waitForFileActive(uploaded, signal);
        uploadedFiles.push(uploaded);
      }
      if (signal?.aborted) throw new Error("Đã dừng tác vụ AI.");
      onProgress?.({ percent: 52, message: `Gemini ${this.model} đang phân tích toàn bộ input` });
      const parts = uploadedFiles.map((file) => ({
        file_data: {
          mime_type: file.mimeType,
          file_uri: file.uri
        }
      }));
      parts.push({ text: String(prompt || "") });
      const response = await this.fetchWithRetry(() => fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          generationConfig: {
            temperature,
            responseMimeType: "application/json"
          },
          contents: [{ role: "user", parts }]
        })
      }), "Gemini package analysis");
      const payload = await readResponseJson(response, "Gemini package analysis response");
      return extractJsonBlock(extractTextFromResponse(payload));
    } finally {
      await Promise.all(uploadedFiles.map((file) => (
        fetch(`${this.baseUrl}/v1beta/${file.name}?key=${this.apiKey}`, { method: "DELETE" }).catch(() => {})
      )));
    }
  }

  buildPrompt({ targetDuration, genreMode, perspective, spoilerMode, narrationEnabled, rewriteVoiceover, narrationLanguage, voiceSpeed }) {
    const { targetWords, minWords, maxWords } = getNarrationWordTargets(targetDuration, voiceSpeed);
    return [
      "You are an expert TikTok / short-form movie recap editor and Vietnamese movie-review script doctor.",
      "Analyze the uploaded movie video and create a high-retention recap body plan. The creator will write the external hook manually, so optimize the story body, voiceover quality, scene selection, pacing, and subtitle readability.",
      "The result must feel like ONE continuous mini-story, not five unrelated scene captions.",
      "Before choosing narrationLine values, decide the single narrative thread: protagonist, goal, obstacle, escalation, unresolved question.",
      "Write narration as spoken voiceover, not literary prose. Use short clauses, intentional pauses, and natural TikTok rhythm.",
      "",
      "=== THE 1-3-1 GOLDEN FORMULA ===",
      "",
      "Your output MUST contain EXACTLY 5 segments with these roles IN ORDER:",
      "",
      "1. HOOK (0-2 seconds max): The single most shocking/beautiful/dramatic moment from the CLIMAX of the film.",
      "   Goal: Stop the viewer's thumb immediately. This is the Inverted Hook.",
      "   CRITICAL: Do NOT start with 'My friends dared me...' or a backstory. Drop the viewer right into the climax. The visual must have the highest visual_energy.",
      "",
      "2. SETUP (short, ~15-20% of runtime): Who? Where? What is happening?",
      "   Goal: Give just enough context so the viewer understands the stakes. Move FAST.",
      "",
      "3. CONFLICT (medium, ~25-30% of runtime): What problem emerges? Why should the viewer care?",
      "   Goal: Create emotional investment. Show the turning point.",
      "",
      "4. ESCALATION (longest, ~30-35% of runtime): How bad/intense/emotional does it get?",
      "   Goal: Maximum tension/emotion/action. This is the meat of the recap.",
      "",
      "5. CLIFFHANGER (3-5 seconds): End with an open question or unresolved moment.",
      "   Goal: Drive the viewer to comments. Never fully resolve the story.",
      "",
      "=== GENRE & STYLE ===",
      "",
      genreInstruction(genreMode),
      perspectiveInstruction(perspective),
      languageInstruction(narrationLanguage),
      "",
      `Target final duration: about ${targetDuration} seconds.`,
      `Voice speed multiplier: ${Number(voiceSpeed || 1).toFixed(2)}x. Use this to size the word count and pacing.`,
      narrationEnabled ? `Voiceover length target: fullNarration MUST be ${minWords}-${maxWords} spoken words total. This is the main timing constraint for the final render.` : "",
      `Narration enabled: ${narrationEnabled ? "yes" : "no"}.`,
      rewriteVoiceover ? "IMPORTANT: The video ALREADY HAS A VOICEOVER. You must listen to the source audio, transcribe the current voiceover, and REWRITE it to be punchier, more viral, and intense according to the 1-3-1 formula. Your generated narrationLine should be a dramatically improved version of the original audio at that timestamp." : "",
      `Spoiler mode: ${spoilerMode}.`,
      "",
      "=== OUTPUT FORMAT ===",
      "",
      "Return JSON only with this EXACT structure:",
      "{",
      '  "title": "short working title",',
      '  "summary": "2-3 sentence synopsis of the recap angle",',
      '  "fullNarration": "the five narrationLine beats joined into one coherent script",',
      '  "editNotes": ["short production notes"],',
      '  "segments": [',
      "    {",
      '      "role": "hook",',
      '      "startSec": 85.2,',
      '      "endSec": 88.5,',
      '      "targetDurationSec": 3.0,',
      '      "narrationLine": "provocative one-liner that stops the scroll",',
      '      "subtitleText": "shorter subtitle version",',
      '      "screenText": "very short on-screen text like WARNING or POV",',
      '      "emotionalAnchor": "shock",',
      '      "visual_energy": 9,',
      '      "audio_vibe": "Shock",',
      '      "font_style": "shake_intense",',
      '      "keywords": ["REAL", "SKIN", "KILL"],',
      '      "viralScore": 9,',
      '      "scenePurpose": "opens the threat / explains stakes / turns the story / intensifies / leaves unresolved",',
      '      "narrationTone": "whisper / tense / urgent / emotional / dry",',
      '      "viewerQuestion": "the question this beat creates in the viewer",',
      '      "continuityNote": "how this beat connects to the previous beat",',
      '      "avoidSpoiler": true,',
      '      "visualClarityScore": 8,',
      '      "emotionScore": 8,',
      '      "motionScore": 7,',
      '      "contextScore": 8,',
      '      "dialogueDependency": 3,',
      '      "spoilerRisk": 4,',
      '      "reason": "why this scene was chosen for this role"',
      "    },",
      '    { "role": "setup", ... },',
      '    { "role": "conflict", ... },',
      '    { "role": "escalation", ... },',
      '    { "role": "cliffhanger", ... }',
      "  ]",
      "}",
      "",
      "=== RULES ===",
      "",
      "Structure rules:",
      "- Return EXACTLY 5 segments with roles: hook, setup, conflict, escalation, cliffhanger — in that order.",
      "- The hook segment MUST come from the film's climax or most intense moment, NOT the beginning.",
      "- The setup/conflict/escalation segments should be in chronological order from the film.",
      "- The cliffhanger can be from any point but should feel like an unresolved ending.",
      "",
      "Duration rules:",
      `- Total duration across all segments should land near ${targetDuration} seconds.`,
      `- Hook: ${Math.round(targetDuration * 0.05)}-${Math.round(targetDuration * 0.08)} seconds. The Inverted Hook.`,
      `- Setup: ${Math.round(targetDuration * 0.15)}-${Math.round(targetDuration * 0.20)} seconds. Fast pace.`,
      `- Conflict: ${Math.round(targetDuration * 0.22)}-${Math.round(targetDuration * 0.28)} seconds. Build tension.`,
      `- Escalation: ${Math.round(targetDuration * 0.30)}-${Math.round(targetDuration * 0.38)} seconds. Maximum action/emotion.`,
      `- Cliffhanger: ${Math.round(targetDuration * 0.08)}-${Math.round(targetDuration * 0.12)} seconds. The Loop Hole.`,
      "",
      "Narration rules:",
      "- The five narrationLine values must read smoothly when concatenated in order.",
      narrationEnabled ? `- fullNarration word count must be ${minWords}-${maxWords} words. Do not return a short 5-10 second script when target duration is ${targetDuration} seconds.` : "",
      "- Do not write long textbook sentences. Use spoken, emotionally direct sentences with enough detail to match the target duration.",
      "- Prefer 2-4 short spoken sentences per segment. Put pauses into the text with commas, ellipses, or sentence breaks only when they help the voice actor.",
      "- Avoid generic lines like 'this moment changes everything' unless the footage truly supports it.",
      "- Every segment after the hook must explicitly connect to the previous beat with cause/effect words, pronouns, repeated object names, or a clear consequence.",
      "- Do NOT reset context in every segment. Avoid disconnected lines that could belong to different movies.",
      "- Keep one protagonist and one core conflict throughout the whole script.",
      "- fullNarration must exactly match the intended joined narration flow, then split that script into the five narrationLine fields.",
      "- Each narrationLine must feel like a beat from ONE connected story arc.",
      "- Hook narrationLine: provocative, controversial, or shocking one-liner.",
      "- Setup narrationLine: rapid context-setting.",
      "- Conflict narrationLine: emotional hook — make the viewer CARE.",
      "- Escalation narrationLine: intense, breathless, urgent.",
      "- Cliffhanger narrationLine: open question or unresolved statement that drives comments.",
      "- Vary sentence rhythm. Never repeat the same sentence structure.",
      "- subtitleText should be cleaner and shorter than narrationLine.",
      "- subtitleText must be split-friendly: short phrases, high contrast words, no paragraph-length text.",
      "- Use keywords for the 1-3 words that should be visually emphasized in subtitles.",
      "",
      "Scene quality rules:",
      "- visualClarityScore: 1-10. High means the scene is readable on a phone without context.",
      "- emotionScore: 1-10. High means face, body language, reaction, fear, tears, shock, or comedy is obvious.",
      "- motionScore: 1-10. High means there is visible movement, danger, reveal, chase, or dramatic camera motion.",
      "- contextScore: 1-10. High means the viewer understands why this beat matters even without watching the whole film.",
      "- dialogueDependency: 1-10. High means the scene only works if the original movie dialogue is understood; avoid high values.",
      "- spoilerRisk: 1-10. High means the beat reveals ending-level information; obey spoilerMode.",
      "",
      "Emotional anchors (pick ONE per segment):",
      "- emotionalAnchor must be one of: fear, shock, curiosity, laugh, cry, awe, dread, tension",
      "- viralScore: 1-10, how likely this scene is to make someone stop scrolling.",
      "",
      "Metadata fields:",
      "- visual_energy: Integer 1-10. 10 is chaotic action, 1 is still. Determines zoom and motion blur.",
      "- audio_vibe: Choose one: 'Suspense', 'Shock', 'Sadness', 'Action', 'Calm'. Determines SFX layering.",
      "- font_style: Choose one: 'standard', 'horror_red', 'shake_intense', 'calm_white'. Determines subtitle styling.",
      "- keywords: Array of 1 to 3 words from the subtitleText that should be highlighted (e.g. ['KILL', 'BLOOD']).",
      "",
      "Spoiler rules:",
      "- If spoiler mode is low, do not reveal the ending. The cliffhanger must tease, not spoil.",
      "- If spoiler mode is full, you may reveal the ending but still end on an emotional question.",
      "",
      "- Return valid JSON only."
    ].join("\n");
  }

  async polishNarrationForDuration({
    title,
    summary,
    segments,
    targetDuration,
    voiceSpeed,
    genreMode,
    perspective,
    narrationLanguage,
    filmMemory,
    evidenceStore,
    evidenceGraph,
    characterTracker,
    filmUnderstanding,
    narrativeIntelligence,
    viralAngle,
    viralAnalysis,
    retentionPlan,
    viralTimeline
  }) {
    const { minWords, maxWords, targetWords } = getNarrationWordTargets(targetDuration, voiceSpeed);
    const compactSegments = (segments || []).map((segment, index) => ({
      index,
      role: segment.role,
      narrativeBeat: segment.narrativeBeat || segment.role,
      beatPurpose: segment.beatPurpose || "",
      timelineStart: Number(segment.timelineStart || 0).toFixed(2),
      timelineEnd: Number(segment.timelineEnd || 0).toFixed(2),
      sourceStartSec: Number(segment.startSec || 0).toFixed(2),
      sourceEndSec: Number(segment.endSec || 0).toFixed(2),
      scenePurpose: segment.scenePurpose || "",
      description: segment.description || "",
      reason: segment.reason || "",
      currentNarrationLine: segment.narrationLine || "",
      subtitleText: segment.subtitleText || "",
      viewerQuestion: segment.viewerQuestion || "",
      blockId: segment.blockId || "",
      purpose: segment.purpose || "",
      retentionReason: segment.retentionReason || "",
      continuityNote: segment.continuityNote || "",
      evidenceIds: Array.isArray(segment.evidenceIds) ? segment.evidenceIds : [],
      metadataSummary: segment.metadataSummary || null
    }));
    const visualEventAnchors = buildVisualEventAnchors(compactSegments);
    const hardAnchors = visualEventAnchors
      .filter((entry) => entry.anchors.some((anchor) => anchor.syncStrictness === "hard"))
      .map((entry) => ({
        index: entry.index,
        timelineStart: entry.timelineStart,
        timelineEnd: entry.timelineEnd,
        description: entry.description,
        anchors: entry.anchors.filter((anchor) => anchor.syncStrictness === "hard")
      }));
    const hookSegment = compactSegments.find((segment) => segment.role === "hook") || compactSegments[0] || {};
    const hookPrompt = [
      "You are a ruthless TikTok hook editor for movie-review videos.",
      "Write exactly 3 hook options for the first 3 seconds only.",
      languageInstruction(narrationLanguage),
      perspectiveInstruction(perspective),
      genreInstruction(genreMode),
      viralAngleInstruction(viralAngle),
      "",
      "Hard hook rules:",
      "- No greetings.",
      "- Do not mention the film title.",
      "- Do not introduce backstory.",
      "- Start with a shocking question, bizarre fact, or contrarian claim that matches the first visual.",
      "- Do not reveal a later hard-anchor twist unless that visual proof appears in the first visual block.",
      "- Keep each hook punchy, spoken, and under 18 words.",
      "- Prefer concrete danger over generic hype.",
      "",
      "Return JSON only:",
      "{",
      '  "selectedIndex": 0,',
      '  "options": [',
      '    {"hookLine":"...","whyItStopsScroll":"...","shockScore":9},',
      '    {"hookLine":"...","whyItStopsScroll":"...","shockScore":8},',
      '    {"hookLine":"...","whyItStopsScroll":"...","shockScore":8}',
      "  ]",
      "}",
      "",
      "Context:",
      JSON.stringify({ title, summary, filmMemory: filmMemory || {}, hookSegment, laterHardAnchors: hardAnchors.filter((anchor) => Number(anchor.index) !== Number(hookSegment.index)) }, null, 2)
    ].join("\n");

    const hookResponse = await this.fetchWithRetry(() => fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.50,
          responseMimeType: "application/json"
        },
        contents: [{ role: "user", parts: [{ text: hookPrompt }] }]
      })
    }), "Gemini TikTok hook options");

    const hookPayload = await hookResponse.json();
    const hookResult = extractJsonBlock(extractTextFromResponse(hookPayload));
    const hookOptions = Array.isArray(hookResult?.options) ? hookResult.options : [];
    const selectedHookOption = hookOptions[Number(hookResult?.selectedIndex || 0)] || hookOptions[0] || {};
    const selectedHook = String(selectedHookOption.hookLine || hookSegment.currentNarrationLine || "").trim();

    const prompt = [
      "You are a senior TikTok movie-review voiceover editor.",
      "Write the body and cliffhanger around the selected hook. The final output will be synthesized in ONE TTS call, so it must sound like one continuous human narration track.",
      languageInstruction(narrationLanguage),
      perspectiveInstruction(perspective),
      genreInstruction(genreMode),
      viralAngleInstruction(viralAngle),
      "",
      `Selected hook for segment 0: ${selectedHook}`,
      `Target duration: ${targetDuration} seconds.`,
      `Voice speed multiplier: ${Number(voiceSpeed || 1).toFixed(2)}x.`,
      `Required fullNarration length: ${minWords}-${maxWords} words. Aim for ${targetWords} words.`,
      "This word count is mandatory. Do not return a short script.",
      "",
      "Hard sync rule:",
      "- The visual timeline below is already locked. Write narration that matches what is visible in each time block.",
      "- Do not explain a scene before or after its time block.",
      "- Each segment narrationLine must be speakable during that segment's timelineStart-timelineEnd window.",
      "- Hard-anchor terms are forbidden before their visual block. Example: do not say android/robot/legless before the android visual proof is on screen.",
      "- If a segment has a hard anchor, the narrationLine for that exact segment must mention that reveal/action clearly.",
      "- Earlier segments may tease with vague language like 'something is wrong', but must not name the twist.",
      "",
      "Rules:",
      `- Return exactly ${compactSegments.length} segment entries, one for every visual block, preserving indexes 0-${Math.max(0, compactSegments.length - 1)}.`,
      "- Segment 0 narrationLine must use the selected hook exactly or with only tiny grammar changes.",
      "- Segment 0 must be a real hook. Never open with 'Bo phim nay ke ve...', 'This movie is about...', or a generic premise.",
      "- Follow retentionPlan: introduce a curiosity gap early, give partial answers, and do not reveal a payoff before the plan allows it.",
      "- Every 10-15 seconds needs a clear curiosity, escalation, reveal, bridge, or consequence.",
      "- End with a loop ending or comment trigger when retentionPlan.loopEnding exists.",
      "- Write natural connected speech with transitions between beats.",
      "- Avoid list-like sentence fragments. Avoid making each beat sound like a separate caption.",
      "- Follow narrativeBeat order: hook -> context -> incident -> conflict -> escalation -> twist_payoff -> cliffhanger.",
      "- Each narrationLine must answer why the previous beat causes the next beat.",
      "- Use one stable protagonist label from filmMemory.storyGraph.protagonistLabel. Do not rename the same character across segments.",
      "- Narration must be driven by character goal, knowledge, emotion, relationship, world-state change, and story beat, not by scene captioning.",
      "- Do not assert motive or emotion when evidenceLevel is weak; use softer language like 'seems', 'appears', or 'starts to realize'.",
      "- Prefer cause-effect narration: what changed, why it matters, and why the viewer should continue.",
      "- Every sentence must be 15 words or fewer.",
      "- Use strong verbs. Cut weak filler.",
      "- Remove side-character names unless absolutely necessary for clarity.",
      "- Use theBizarreElement, theInjustice, and curiosityGap from filmMemory as the main material.",
      "- Each segment narrationLine should be 1-4 spoken sentences and connect to the next beat.",
      "- fullNarration must equal all narrationLine fields joined in index order.",
      "- subtitleText should be shorter display text for each beat.",
      "",
      buildEvidenceStoreBrief(evidenceStore),
      "",
      buildEvidenceGraphBrief(evidenceGraph),
      "",
      buildCharacterTrackerBrief(characterTracker),
      "",
      "Return JSON only:",
      "{",
      '  "fullNarration": "continuous voiceover",',
      '  "segments": [',
      '    {"index":0,"blockId":"vblock_001","role":"hook","purpose":"hook","viewerQuestion":"...","curiosityGapId":"gap_01","beatId":"beat_001","plotEventId":"event_001","characterIds":["char_hero"],"evidenceIds":["ev_scene_0001_visual_01"],"currentCharacterGoal":"...","currentCharacterKnowledge":"...","emotionBefore":"...","emotionAfter":"...","whatChanged":"...","visualEvidence":"...","transcriptEvidence":"...","retentionReason":"...","spoilerRisk":0.2,"evidenceLevel":"visual_confirmed","visualEvent":"what is visible","groundingNote":"why this line belongs here and which evidenceId supports it","narrationLine":"...","subtitleText":"..."},',
      '    {"index":1,"blockId":"vblock_002","role":"setup","purpose":"context","viewerQuestion":"...","curiosityGapId":"gap_01","beatId":"beat_002","plotEventId":"event_002","characterIds":["char_hero"],"evidenceIds":["ev_scene_0002_dialogue_02"],"currentCharacterGoal":"...","currentCharacterKnowledge":"...","emotionBefore":"...","emotionAfter":"...","whatChanged":"...","visualEvidence":"...","transcriptEvidence":"...","retentionReason":"...","spoilerRisk":0.2,"evidenceLevel":"inferred","visualEvent":"what is visible","groundingNote":"why this line belongs here and which evidenceId supports it","narrationLine":"...","subtitleText":"..."}',
      "  ]",
      "}",
      "",
      "Film understanding constraints:",
      "- Use characterBible and plotTimeline as the source of truth.",
      "- Use Narrative Intelligence as the source of truth for character mental model, relationship graph, world-state timeline, emotional timeline, and story beat graph.",
      "- Every segment must include plotEventId and characterIds from Film Understanding Engine when a match exists.",
      "- Every segment must include beatId when a story beat graph match exists.",
      "- Every segment must include at least one evidence source: visualEvidence, transcriptEvidence, plotEventId, or character state.",
      "- Every segment should include evidenceIds from the Evidence Store when available. Do not cite evidenceIds from another scene.",
      "- Prefer plotEventId/beatId that has a supported_by path in Evidence Graph. If no supported path exists, mark evidenceLevel as inferred or weak.",
      "- Do not invent new character labels. Use stable labels from characterBible.",
      "- If a selected visual block does not fit the planned narration, rewrite the line to match the visible event instead of forcing unrelated plot.",
      "",
      "Context:",
      JSON.stringify({ title, summary, filmMemory: filmMemory || {}, filmUnderstanding: filmUnderstanding || {}, narrativeIntelligence: narrativeIntelligence || {}, viralAnalysis: viralAnalysis || {}, retentionPlan: retentionPlan || {}, viralTimeline: viralTimeline || {}, selectedHook, hookOptions, visualEventAnchors, segments: compactSegments }, null, 2)
    ].join("\n");

    const response = await this.fetchWithRetry(() => fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.35,
          responseMimeType: "application/json"
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ]
      })
    }), "Gemini narration polish");

    const payload = await readResponseJson(response, "Gemini hook response");
    const parsed = extractJsonBlock(extractTextFromResponse(payload));
    return {
      ...parsed,
      selectedHook,
      hookOptions
    };
  }

  async refineNarrativeContinuity({
    title,
    summary,
    segments,
    polishResult,
    targetDuration,
    voiceSpeed,
    genreMode,
    perspective,
    narrationLanguage,
    filmMemory,
    evidenceStore,
    evidenceGraph,
    characterTracker,
    filmUnderstanding,
    narrativeIntelligence,
    viralAngle,
    viralAnalysis,
    retentionPlan,
    viralTimeline
  }) {
    const { minWords, maxWords, targetWords } = getNarrationWordTargets(targetDuration, voiceSpeed);
    const compactSegments = (segments || []).map((segment, index) => ({
      index,
      role: segment.role,
      narrativeBeat: segment.narrativeBeat || segment.role,
      beatPurpose: segment.beatPurpose || "",
      timelineStart: Number(segment.timelineStart || 0).toFixed(2),
      timelineEnd: Number(segment.timelineEnd || 0).toFixed(2),
      description: segment.description || "",
      reason: segment.reason || "",
      blockId: segment.blockId || "",
      purpose: segment.purpose || "",
      viewerQuestion: segment.viewerQuestion || "",
      retentionReason: segment.retentionReason || "",
      metadataSummary: segment.metadataSummary || null
    }));
    const currentSegments = Array.isArray(polishResult?.segments) ? polishResult.segments : [];
    const prompt = [
      "You are the final continuity editor for a viral movie recap.",
      "Your job is not to add new plot. Your job is to make the narration sound like ONE coherent mini-story.",
      languageInstruction(narrationLanguage),
      perspectiveInstruction(perspective),
      genreInstruction(genreMode),
      viralAngleInstruction(viralAngle),
      "",
      `Target duration: ${targetDuration} seconds.`,
      `Voice speed multiplier: ${Number(voiceSpeed || 1).toFixed(2)}x.`,
      `Required final fullNarration length: ${minWords}-${maxWords} words. Aim for ${targetWords}.`,
      "",
      "Hard continuity rules:",
      "- Preserve exactly the same segment indexes and visual sync.",
      "- Follow narrativeBeat order: hook -> context -> incident -> conflict -> escalation -> twist_payoff -> cliffhanger.",
      "- Every segment after index 0 must connect causally to the previous one using clear transitions.",
      "- Use filmMemory.storyGraph.causeEffectChain as the spine.",
      "- Preserve and improve beatId, plotEventId, characterIds, currentCharacterGoal, currentCharacterKnowledge, emotionBefore, emotionAfter, whatChanged, visualEvidence, transcriptEvidence, evidenceLevel, visualEvent, and groundingNote for every segment.",
      "- The narration must be grounded in Film Understanding Engine: characterBible + plotTimeline + sceneRoleMap.",
      "- The narration must also be grounded in Evidence Store evidenceIds. Preserve or improve evidenceIds per segment.",
      "- The narration must also obey Narrative Intelligence: character mental model + relationship graph + world-state timeline + emotional timeline + story beat graph.",
      "- Use filmMemory.storyGraph.protagonistLabel consistently. Do not switch labels for the same person.",
      "- Default to objective third person. Do not use first person.",
      "- Do not mention information before the matching visual segment.",
      "- Keep the first 3 seconds as a hook, preserve curiosity gaps, and keep the loop ending if one exists.",
      "- If retentionPlan forbids an early reveal, tease the consequence instead of naming the twist.",
      "- Remove recap fragments that feel like independent captions.",
      "- Keep each sentence 15 words or fewer.",
      "- fullNarration must equal all narrationLine fields joined in index order.",
      "",
      buildEvidenceStoreBrief(evidenceStore),
      "",
      buildEvidenceGraphBrief(evidenceGraph),
      "",
      buildCharacterTrackerBrief(characterTracker),
      "",
      "Return JSON only:",
      "{",
      '  "fullNarration": "continuous voiceover",',
      '  "continuityNotes": ["what was fixed"],',
      '  "segments": [',
      '    {"index":0,"blockId":"vblock_001","role":"hook","purpose":"hook","viewerQuestion":"...","curiosityGapId":"gap_01","narrativeBeat":"hook","beatId":"beat_001","plotEventId":"event_001","characterIds":["char_hero"],"evidenceIds":["ev_scene_0001_visual_01"],"currentCharacterGoal":"...","currentCharacterKnowledge":"...","emotionBefore":"...","emotionAfter":"...","whatChanged":"...","visualEvidence":"...","transcriptEvidence":"...","retentionReason":"...","spoilerRisk":0.2,"evidenceLevel":"visual_confirmed","visualEvent":"...","groundingNote":"...","narrationLine":"...","subtitleText":"..."},',
      '    {"index":1,"blockId":"vblock_002","role":"setup","purpose":"context","viewerQuestion":"...","curiosityGapId":"gap_01","narrativeBeat":"context","beatId":"beat_002","plotEventId":"event_002","characterIds":["char_hero"],"evidenceIds":["ev_scene_0002_dialogue_02"],"currentCharacterGoal":"...","currentCharacterKnowledge":"...","emotionBefore":"...","emotionAfter":"...","whatChanged":"...","visualEvidence":"...","transcriptEvidence":"...","retentionReason":"...","spoilerRisk":0.2,"evidenceLevel":"inferred","visualEvent":"...","groundingNote":"...","narrationLine":"...","subtitleText":"..."}',
      "  ]",
      "}",
      "",
      "Context:",
      JSON.stringify({
        title,
        summary,
        filmMemory: filmMemory || {},
        filmUnderstanding: filmUnderstanding || {},
        narrativeIntelligence: narrativeIntelligence || {},
        viralAnalysis: viralAnalysis || {},
        retentionPlan: retentionPlan || {},
        viralTimeline: viralTimeline || {},
        visualSegments: compactSegments,
        currentNarration: {
          fullNarration: polishResult?.fullNarration || "",
          segments: currentSegments
        }
      }, null, 2)
    ].join("\n");

    return this.generateTextJson({
      prompt,
      temperature: 0.25,
      label: "Gemini narrative continuity polish"
    });
  }

  async rewriteNarrationToFitDuration({
    fullNarration,
    segments,
    targetDuration,
    voiceSpeed,
    actualDuration,
    narrationLanguage,
    genreMode,
    perspective,
    filmMemory,
    viralAngle
  }) {
    const ratio = Number(targetDuration) / Math.max(0.1, Number(actualDuration));
    const direction = ratio < 1 ? "shorten" : "expand";
    const targetWordCount = Math.max(12, Math.round(countWordsForPrompt(fullNarration) * ratio * Math.max(0.7, Math.min(1.5, Number(voiceSpeed || 1)))));
    const minWords = Math.max(10, Math.round(targetWordCount * 0.92));
    const maxWords = Math.max(minWords + 4, Math.round(targetWordCount * 1.08));
    const compactSegments = (segments || []).map((segment, index) => ({
      index,
      role: segment.role,
      timelineStart: Number(segment.timelineStart || 0).toFixed(2),
      timelineEnd: Number(segment.timelineEnd || 0).toFixed(2),
      description: segment.description || "",
      reason: segment.reason || "",
      narrationLine: segment.narrationLine || "",
      subtitleText: segment.subtitleText || ""
    }));
    const visualEventAnchors = buildVisualEventAnchors(compactSegments.map((segment) => ({
      ...segment,
      currentNarrationLine: segment.narrationLine
    })));
    const prompt = [
      "You are fixing a movie-review voiceover after measuring real TTS duration.",
      languageInstruction(narrationLanguage),
      perspectiveInstruction(perspective),
      genreInstruction(genreMode),
      viralAngleInstruction(viralAngle),
      "",
      `Target output duration: ${targetDuration}s.`,
      `Voice speed multiplier: ${Number(voiceSpeed || 1).toFixed(2)}x.`,
      `Measured voice duration: ${actualDuration.toFixed(1)}s.`,
      `Task: ${direction} the narration so the next TTS pass lands close to ${targetDuration}s.`,
      `Required word count: ${minWords}-${maxWords} words. This is mandatory.`,
      "",
      `Keep exactly ${compactSegments.length} segment entries, one for every visual block, preserving indexes 0-${Math.max(0, compactSegments.length - 1)}.`,
      "Preserve visual sync: each segment narrationLine must still match that segment's timelineStart-timelineEnd visual block.",
      "Hard-anchor terms are forbidden before their visual block. Do not move twist words earlier while shortening.",
      "If a segment has a hard anchor, keep that reveal/action inside that exact segment.",
      "Make it sound like one continuous human narration, not separate captions.",
      "Keep the TikTok angle, bizarre detail, injustice, and curiosity gap alive.",
      "Every sentence must be 15 words or fewer.",
      "Use strong verbs and remove weak filler.",
      "Do not add side-character names unless absolutely necessary.",
      "Do not add unrelated plot details.",
      "Return JSON only:",
      "{",
      '  "fullNarration": "continuous voiceover",',
      '  "segments": [',
      '    {"index":0,"role":"hook","narrationLine":"...","subtitleText":"..."},',
      '    {"index":1,"role":"setup","narrationLine":"...","subtitleText":"..."}',
      "  ]",
      "}",
      "",
      "Current narration and beats:",
      JSON.stringify({ fullNarration, filmMemory: filmMemory || {}, visualEventAnchors, segments: compactSegments }, null, 2)
    ].join("\n");

    const response = await this.fetchWithRetry(() => fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.25,
          responseMimeType: "application/json"
        },
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      })
    }), "Gemini narration duration rewrite");

    const payload = await readResponseJson(response, "Gemini narration response");
    return extractJsonBlock(extractTextFromResponse(payload));
  }

  buildFilmMemoryPrompt({ targetDuration, genreMode, spoilerMode, narrationLanguage, lockedScenes, viralAngle }) {
    const maxPromptScenes = 900;
    const promptScenes = Array.isArray(lockedScenes) && lockedScenes.length > maxPromptScenes
      ? Array.from({ length: maxPromptScenes }, (_value, index) => {
          const sourceIndex = Math.floor((index / Math.max(1, maxPromptScenes - 1)) * (lockedScenes.length - 1));
          return lockedScenes[sourceIndex];
        })
      : lockedScenes;
    return [
      "You are the story brain for an automated TikTok movie-review editor.",
      "Analyze the uploaded video as a complete film/clip, then build a compact film memory that later steps can use to choose viral moments.",
      languageInstruction(narrationLanguage),
      genreInstruction(genreMode),
      viralAngleInstruction(viralAngle),
      "",
      `Target output duration later: ${targetDuration}s.`,
      `Spoiler mode: ${spoilerMode}.`,
      "",
      "Locked physical scenes are provided. Reference sceneId only; do not invent timestamps.",
      JSON.stringify(promptScenes || [], null, 2),
      "",
      "Return JSON only:",
      "{",
      '  "title": "working title",',
      '  "logline": "one-sentence story spine",',
      '  "protagonist": "who the audience follows",',
      '  "goal": "what they want or need",',
      '  "centralConflict": "main obstacle/threat",',
      '  "stakes": "what is lost if they fail",',
      '  "theBizarreElement": "the weird detail/rule that violates normal life and makes TikTok viewers stop",',
      '  "theInjustice": "the unfair/helpless/infuriating situation that makes viewers angry or protective",',
      '  "curiosityGap": "the unresolved question that keeps viewers watching past the midpoint",',
      '  "tiktokThesis": "one sharp sentence that frames this as a TikTok-worthy story, not a plot summary",',
      '  "selectedViralAngle": {"id":"survival","label":"Angle Sinh ton","reason":"why this angle fits the footage"},',
      '  "emotionalArc": ["curiosity","fear","loss","reversal","question"],',
      '  "spoilerBoundary": "what must not be revealed under the selected spoiler mode",',
      '  "mustUseMoments": [',
      '    {"sceneId":"scene_0007","roleHint":"hook|setup|conflict|escalation|cliffhanger|cutaway","why":"why this matters to the story","plotImportanceScore":9,"retentionScore":9,"standaloneScore":8,"emotion":"shock","momentFocus":"early|middle|late|full","momentDurationSec":3.0}',
      "  ],",
      '  "avoidMoments": [',
      '    {"sceneId":"scene_0012","reason":"credits / unclear / spoiler / dead air"}',
      "  ],",
      '  "continuityRules": ["rule for connecting scenes coherently"],',
      '  "narrationAngle": "the best review angle for a viral short"',
      '  "storyGraph": {',
      '    "protagonist": "who the recap should follow",',
      '    "protagonistLabel": "stable label to use in narration, e.g. the hunter / the girl / the two of them",',
      '    "objective": "what the protagonist wants or needs",',
      '    "mainThreat": "the force blocking them",',
      '    "causeEffectChain": ["because X happens, Y becomes dangerous", "because Y happens, Z escalates"],',
      '    "characterMap": [{"id":"char_01","label":"the hunter","role":"protagonist","description":"stable visual/person clue"}],',
      '    "storyBeats": [',
      '      {"beatId":"beat_01","beatType":"hook","sceneId":"scene_0007","cause":"what caused this image","effect":"why it matters","audienceQuestion":"what viewers ask","narrationPurpose":"why this beat exists"},',
      '      {"beatId":"beat_02","beatType":"context","sceneId":"scene_0002","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."},',
      '      {"beatId":"beat_03","beatType":"incident","sceneId":"scene_0005","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."},',
      '      {"beatId":"beat_04","beatType":"conflict","sceneId":"scene_0010","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."},',
      '      {"beatId":"beat_05","beatType":"escalation","sceneId":"scene_0014","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."},',
      '      {"beatId":"beat_06","beatType":"twist_payoff","sceneId":"scene_0018","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."},',
      '      {"beatId":"beat_07","beatType":"cliffhanger","sceneId":"scene_0020","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."}',
      "    ]",
      "  }",
      "}",
      "",
      "Selection guidance:",
      "- mustUseMoments should contain 12-24 sceneIds if available.",
      "- theBizarreElement, theInjustice, and curiosityGap are mandatory. If one is weak, say the strongest available version anyway.",
      "- Think like a TikTok editor: search for unfairness, strange rules, humiliating reversals, impossible choices, and details people would comment about.",
      "- Build storyGraph as a cause-and-effect spine, not a list of cool shots.",
      "- storyBeats must cover hook, context, incident, conflict, escalation, twist_payoff, and cliffhanger when the metadata supports them.",
      "- protagonistLabel must be stable and suitable for third-person narration.",
      "- Choose scenes that are visually readable, emotionally loaded, and important to the story.",
      "- momentFocus must describe where the strongest micro-moment is inside that locked scene.",
      "- If spoiler mode is low, describe high-spoiler moments but put them in avoidMoments unless they can be teased safely."
    ].join("\n");
  }

  buildFilmMemoryMetadataPrompt({ sceneMetadata, evidenceStore, targetDuration, genreMode, spoilerMode, narrationLanguage, viralAngle }) {
    const maxPromptScenes = 700;
    const sourceScenes = Array.isArray(sceneMetadata?.scenes) ? sceneMetadata.scenes : [];
    const promptScenes = sourceScenes.length > maxPromptScenes
      ? Array.from({ length: maxPromptScenes }, (_value, index) => {
          const sourceIndex = Math.floor((index / Math.max(1, maxPromptScenes - 1)) * (sourceScenes.length - 1));
          return sourceScenes[sourceIndex];
        })
      : sourceScenes;
    return [
      "You are the story brain for an automated TikTok movie-review editor.",
      "Do NOT ask for or assume access to the raw video. Reconstruct the story from this chained scene metadata only.",
      "Each scene includes timeline, transcript, motion intensity, audio energy, light changes, local visual tags, and auto-reframe hints.",
      languageInstruction(narrationLanguage),
      genreInstruction(genreMode),
      viralAngleInstruction(viralAngle),
      "",
      `Target output duration later: ${targetDuration}s.`,
      `Spoiler mode: ${spoilerMode}.`,
      `Metadata provider: ${sceneMetadata?.provider || "unknown"}. Transcript provider: ${sceneMetadata?.transcriptProvider || sceneMetadata?.transcript?.provider || "unknown"}.`,
      "",
      buildEvidenceStoreBrief(evidenceStore),
      "",
      "Scene metadata chain:",
      JSON.stringify(promptScenes, null, 2),
      sourceScenes.length > maxPromptScenes ? `The full chain has ${sourceScenes.length} scenes; this prompt includes ${maxPromptScenes} evenly sampled scenes.` : "",
      "",
      "Return JSON only:",
      "{",
      '  "title": "working title",',
      '  "logline": "one-sentence story spine",',
      '  "protagonist": "who the audience follows, or uncertain",',
      '  "goal": "what they want or need",',
      '  "centralConflict": "main obstacle/threat",',
      '  "stakes": "what is lost if they fail",',
      '  "theBizarreElement": "the weird detail/rule that violates normal life and makes viewers stop",',
      '  "theInjustice": "the unfair/helpless/infuriating situation that makes viewers angry or protective",',
      '  "curiosityGap": "the unresolved question that keeps viewers watching past the midpoint",',
      '  "tiktokThesis": "one sharp sentence that frames this as a TikTok-worthy story, not a plot summary",',
      '  "selectedViralAngle": {"id":"survival","label":"Angle Sinh ton","reason":"why this angle fits the metadata"},',
      '  "emotionalArc": ["curiosity","fear","loss","reversal","question"],',
      '  "spoilerBoundary": "what must not be revealed under the selected spoiler mode",',
      '  "mustUseMoments": [',
      '    {"sceneId":"scene_0007","roleHint":"hook|setup|conflict|escalation|cliffhanger|cutaway","why":"why this matters","plotImportanceScore":9,"retentionScore":9,"standaloneScore":8,"emotion":"shock","momentFocus":"early|middle|late|full","momentDurationSec":3.0}',
      "  ],",
      '  "avoidMoments": [{"sceneId":"scene_0012","reason":"credits / unclear / spoiler / dead air"}],',
      '  "continuityRules": ["rule for connecting scenes coherently"],',
      '  "narrationAngle": "the best review angle for a viral short"',
      '  "storyGraph": {',
      '    "protagonist": "who the recap should follow",',
      '    "protagonistLabel": "stable label to use in narration, e.g. the hunter / the girl / the two of them",',
      '    "objective": "what the protagonist wants or needs",',
      '    "mainThreat": "the force blocking them",',
      '    "causeEffectChain": ["because X happens, Y becomes dangerous", "because Y happens, Z escalates"],',
      '    "characterMap": [{"id":"char_01","label":"the hunter","role":"protagonist","description":"stable visual/person clue"}],',
      '    "storyBeats": [',
      '      {"beatId":"beat_01","beatType":"hook","sceneId":"scene_0007","cause":"what caused this image","effect":"why it matters","audienceQuestion":"what viewers ask","narrationPurpose":"why this beat exists"},',
      '      {"beatId":"beat_02","beatType":"context","sceneId":"scene_0002","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."},',
      '      {"beatId":"beat_03","beatType":"incident","sceneId":"scene_0005","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."},',
      '      {"beatId":"beat_04","beatType":"conflict","sceneId":"scene_0010","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."},',
      '      {"beatId":"beat_05","beatType":"escalation","sceneId":"scene_0014","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."},',
      '      {"beatId":"beat_06","beatType":"twist_payoff","sceneId":"scene_0018","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."},',
      '      {"beatId":"beat_07","beatType":"cliffhanger","sceneId":"scene_0020","cause":"...","effect":"...","audienceQuestion":"...","narrationPurpose":"..."}',
      "    ]",
      "  }",
      "}",
      "",
      "Selection guidance:",
      "- Treat HIGH motion + LOUD audio + FLASH light as strong action or climax evidence.",
      "- Treat transcript continuity as the story spine. Use scene order to infer cause and effect.",
      "- Ground key claims in sceneId/evidenceId from the Evidence Store. If evidence is weak, label it uncertain.",
      "- Build storyGraph as a cause-and-effect spine, not a list of cool shots.",
      "- storyBeats must cover hook, context, incident, conflict, escalation, twist_payoff, and cliffhanger when the metadata supports them.",
      "- protagonistLabel must be stable and suitable for third-person narration.",
      "- local_visual_tags are cheap local model hints; use them, but do not overfit if transcript contradicts them.",
      "- mustUseMoments should contain 12-24 sceneIds if available.",
      "- If spoiler mode is low, put high-spoiler scenes in avoidMoments unless they can be teased safely."
    ].join("\n");
  }

  async generateTextJson({ prompt, temperature = 0.35, promptLogPath, rawResponsePath, parsedResponsePath, label = "Gemini text JSON" }) {
    if (promptLogPath) {
      await fs.promises.writeFile(promptLogPath, prompt, "utf8");
    }
    const response = await this.fetchWithRetry(() => fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`, {
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
    }), label);

    const payload = await readResponseJson(response, "Gemini text JSON response");
    const text = extractTextFromResponse(payload);
    if (rawResponsePath) {
      await fs.promises.writeFile(rawResponsePath, text || JSON.stringify(payload, null, 2), "utf8");
    }
    const parsed = extractJsonBlock(text);
    if (parsedResponsePath) {
      await fs.promises.writeFile(parsedResponsePath, JSON.stringify(parsed, null, 2), "utf8");
    }
    return parsed;
  }

  async understandFilmFromMetadata({
    sceneMetadata,
    evidenceStore,
    targetDuration,
    genreMode,
    spoilerMode,
    narrationLanguage,
    viralAngle,
    promptLogPath,
    rawResponsePath,
    parsedResponsePath
  }) {
    const prompt = this.buildFilmMemoryMetadataPrompt({
      sceneMetadata,
      evidenceStore,
      targetDuration,
      genreMode,
      spoilerMode,
      narrationLanguage,
      viralAngle
    });
    return this.generateTextJson({
      prompt,
      temperature: 0.25,
      promptLogPath,
      rawResponsePath,
      parsedResponsePath,
      label: "Gemini metadata film understanding"
    });
  }

  buildFilmUnderstandingEnginePrompt({
    sceneMetadata,
    evidenceStore,
    filmMemory,
    targetDuration,
    genreMode,
    spoilerMode,
    narrationLanguage,
    viralAngle
  }) {
    const maxPromptScenes = 700;
    const sourceScenes = Array.isArray(sceneMetadata?.scenes) ? sceneMetadata.scenes : [];
    const promptScenes = sourceScenes.length > maxPromptScenes
      ? Array.from({ length: maxPromptScenes }, (_value, index) => {
          const sourceIndex = Math.floor((index / Math.max(1, maxPromptScenes - 1)) * (sourceScenes.length - 1));
          return sourceScenes[sourceIndex];
        })
      : sourceScenes;
    return [
      "You are the Film Understanding Engine for a short-form movie recap editor.",
      "Analyze the metadata chain as a continuous film, not as isolated clips.",
      languageInstruction(narrationLanguage),
      genreInstruction(genreMode),
      viralAngleInstruction(viralAngle),
      "",
      `Target recap duration: ${targetDuration} seconds.`,
      `Spoiler mode: ${spoilerMode}.`,
      "",
      "Your job:",
      "1. Build a character bible with stable character IDs and labels.",
      "2. Build a plot timeline of cause/effect events in source order.",
      "3. Map each useful scene to its role in the story and the matching plot event.",
      "",
      "Hard rules:",
      "- Use objective third-person labels unless the metadata clearly identifies a first-person narrator.",
      "- Do not invent names. If names are unknown, use stable labels like 'the girl', 'the hunter', 'the creature'.",
      "- Keep event IDs stable: event_001, event_002, ... in story order.",
      "- Keep character IDs stable: char_hero, char_companion, char_threat, etc.",
      "- sceneRoleMap.sceneId must use scene IDs from the metadata chain only.",
      "- sceneRoleMap entries should include only roles supported by Evidence Store scene evidence.",
      "- Mark uncertain conclusions as confidence below 0.55 instead of pretending certainty.",
      "",
      "Return JSON only:",
      "{",
      '  "characterBible": {',
      '    "protagonistId": "char_hero",',
      '    "characters": [',
      '      {"characterId":"char_hero","stableLabel":"the girl","role":"protagonist","traits":["curious"],"visualCues":["young woman"],"firstSeenSceneId":"scene_0001","confidence":0.76}',
      "    ]",
      "  },",
      '  "plotTimeline": {',
      '    "events": [',
      '      {"eventId":"event_001","sceneIds":["scene_0001"],"summary":"...", "cause":"...", "effect":"...", "stakes":"...", "characterIds":["char_hero"],"confidence":0.72}',
      "    ]",
      "  },",
      '  "sceneRoleMap": [',
      '    {"sceneId":"scene_0001","role":"hook|setup|incident|conflict|escalation|twist_payoff|cliffhanger|cutaway","plotEventId":"event_001","characterIds":["char_hero"],"visualEvidence":"...", "dialogueEvidence":"...", "importanceScore":8, "confidence":0.72}',
      "  ]",
      "}",
      "",
      "Existing film memory:",
      JSON.stringify(filmMemory || {}, null, 2),
      "",
      buildEvidenceStoreBrief(evidenceStore),
      "",
      "Scene metadata chain:",
      JSON.stringify(promptScenes, null, 2),
      sourceScenes.length > maxPromptScenes ? `The full chain has ${sourceScenes.length} scenes; this prompt includes ${maxPromptScenes} evenly sampled scenes.` : ""
    ].join("\n");
  }

  async analyzeFilmUnderstandingFromMetadata({
    sceneMetadata,
    evidenceStore,
    filmMemory,
    targetDuration,
    genreMode,
    spoilerMode,
    narrationLanguage,
    viralAngle,
    promptLogPath,
    rawResponsePath,
    parsedResponsePath
  }) {
    const prompt = this.buildFilmUnderstandingEnginePrompt({
      sceneMetadata,
      evidenceStore,
      filmMemory,
      targetDuration,
      genreMode,
      spoilerMode,
      narrationLanguage,
      viralAngle
    });
    return this.generateTextJson({
      prompt,
      temperature: 0.20,
      promptLogPath,
      rawResponsePath,
      parsedResponsePath,
      label: "Gemini Film Understanding Engine"
    });
  }

  buildNarrativeIntelligencePrompt({
    sceneMetadata,
    evidenceStore,
    evidenceGraph,
    characterTracker,
    filmMemory,
    filmUnderstanding,
    targetDuration,
    genreMode,
    spoilerMode,
    narrationLanguage,
    viralAngle
  }) {
    const maxPromptScenes = 700;
    const sourceScenes = Array.isArray(sceneMetadata?.scenes) ? sceneMetadata.scenes : [];
    const promptScenes = sourceScenes.length > maxPromptScenes
      ? Array.from({ length: maxPromptScenes }, (_value, index) => {
          const sourceIndex = Math.floor((index / Math.max(1, maxPromptScenes - 1)) * (sourceScenes.length - 1));
          return sourceScenes[sourceIndex];
        })
      : sourceScenes;
    return [
      "You are the Narrative Intelligence Layer for a movie recap editor.",
      "Infer character psychology, relationships, world-state changes, emotional movement, and story beats from metadata.",
      "Do not merely describe scenes. Build the story logic behind the scenes.",
      languageInstruction(narrationLanguage),
      genreInstruction(genreMode),
      viralAngleInstruction(viralAngle),
      "",
      `Target recap duration: ${targetDuration} seconds.`,
      `Spoiler mode: ${spoilerMode}.`,
      "",
      "Return JSON only with this shape:",
      "{",
      '  "characterMentalModel": {"characters": [',
      '    {"characterId":"char_01","stableLabel":"the girl","possibleNames":[],"roleInStory":"protagonist|antagonist|ally|victim|mentor|unknown","visualDescription":"...","firstAppearanceSceneId":"scene_0001","keyScenes":["scene_0001"],"goal":"...","motivation":"...","fear":"...","internalConflict":"...","externalConflict":"...","whatTheyKnowTimeline":[{"plotEventId":"event_001","knows":["..."],"doesNotKnow":["..."],"evidenceSceneIds":["scene_0001"]}],"emotionalStateTimeline":[{"plotEventId":"event_001","state":"afraid","evidenceSceneIds":["scene_0001"],"confidenceScore":0.7}],"arcStateTimeline":[{"plotEventId":"event_001","arcState":"confused -> determined","whatChanged":"...","confidenceScore":0.7}],"relationships":[{"targetCharacterId":"char_02","relationshipType":"enemy","state":"afraid of them","confidenceScore":0.6}],"confidenceScore":0.7,"evidenceScenes":["scene_0001"]}',
      "  ]},",
      '  "relationshipGraph": {"relationships": [',
      '    {"sourceCharacterId":"char_01","targetCharacterId":"char_02","relationshipType":"family|enemy|ally|romantic|captor|victim|unknown","relationshipStateTimeline":[{"plotEventId":"event_001","state":"trusting","evidenceSceneIds":["scene_0001"]}],"trustLevelTimeline":[{"plotEventId":"event_001","trustLevel":4,"evidenceSceneIds":["scene_0001"]}],"evidenceScenes":["scene_0001"],"confidenceScore":0.6}',
      "  ]},",
      '  "worldStateTimeline": [',
      '    {"plotEventId":"event_001","sceneIds":["scene_0001"],"knownFacts":["..."],"changedFacts":["..."],"unresolvedQuestions":["..."],"dangerLevel":6,"protagonistState":"...","antagonistState":"...","stakes":"...","causeFromPreviousEvent":"...","effectOnNextEvent":"..."}',
      "  ],",
      '  "emotionalTimeline": [',
      '    {"characterId":"char_01","plotEventId":"event_001","emotionBefore":"confused","emotionAfter":"terrified","trigger":"...","visibleEvidence":"...","transcriptEvidence":"...","confidenceScore":0.7}',
      "  ],",
      '  "storyBeatGraph": {"beats": [',
      '    {"beatId":"beat_001","sceneIds":["scene_0001"],"beatRole":"hook|setup|incident|conflict|escalation|reveal|payoff|cliffhanger","mainCharacters":["char_01"],"mainGoal":"...","obstacle":"...","outcome":"...","whatChanged":"...","cause":"...","effect":"...","visualEvidence":"...","transcriptEvidence":"...","importanceScore":8,"retentionScore":8,"evidenceLevel":"visual_confirmed|transcript_confirmed|inferred|weak"}',
      "  ]}",
      "}",
      "",
      "Hard reasoning rules:",
      "- Use stable character labels from Film Understanding when possible.",
      "- A character's knowledge can only include facts supported by earlier/current events.",
      "- Relationships may change over time; record that in relationshipStateTimeline.",
      "- Every strong claim about goal, emotion, motive, betrayal, trust, or fear must include evidence scenes or lower confidence.",
      "- Evidence scenes should come from the Evidence Store; when possible cite evidenceIds inside visualEvidence/transcriptEvidence.",
      "- Evidence Graph is the story skeleton. Use supported_by edges to decide which plot events can be treated as grounded.",
      "- Plot events without supported_by evidence must stay hypothesis/inferred and cannot become certain narration facts.",
      "- If evidence is weak, set evidenceLevel to weak or inferred. Do not overstate.",
      "- Group physical scenes into story beats when they serve one storytelling unit.",
      "- Prefer beats where whatChanged is clear and cause/effect connects to the next event.",
      "",
      "Film memory:",
      JSON.stringify(filmMemory || {}, null, 2),
      "",
      "Film Understanding Engine output:",
      JSON.stringify(filmUnderstanding || {}, null, 2),
      "",
      buildEvidenceStoreBrief(evidenceStore),
      "",
      buildEvidenceGraphBrief(evidenceGraph),
      "",
      buildCharacterTrackerBrief(characterTracker),
      "",
      "Scene metadata chain:",
      JSON.stringify(promptScenes, null, 2),
      sourceScenes.length > maxPromptScenes ? `The full chain has ${sourceScenes.length} scenes; this prompt includes ${maxPromptScenes} evenly sampled scenes.` : ""
    ].join("\n");
  }

  async analyzeNarrativeIntelligence({
    sceneMetadata,
    evidenceStore,
    evidenceGraph,
    characterTracker,
    filmMemory,
    filmUnderstanding,
    targetDuration,
    genreMode,
    spoilerMode,
    narrationLanguage,
    viralAngle,
    promptLogPath,
    rawResponsePath,
    parsedResponsePath
  }) {
    const prompt = this.buildNarrativeIntelligencePrompt({
      sceneMetadata,
      evidenceStore,
      evidenceGraph,
      characterTracker,
      filmMemory,
      filmUnderstanding,
      targetDuration,
      genreMode,
      spoilerMode,
      narrationLanguage,
      viralAngle
    });
    return this.generateTextJson({
      prompt,
      temperature: 0.22,
      promptLogPath,
      rawResponsePath,
      parsedResponsePath,
      label: "Gemini Narrative Intelligence Layer"
    });
  }

  async repairGroundedNarration({
    title,
    summary,
    segments,
    groundingReport,
    filmMemory,
    evidenceStore,
    evidenceGraph,
    characterTracker,
    filmUnderstanding,
    narrativeIntelligence,
    targetDuration,
    voiceSpeed,
    genreMode,
    perspective,
    narrationLanguage,
    viralAngle
  }) {
    const weakSegments = (Array.isArray(groundingReport?.segments) ? groundingReport.segments : [])
      .filter((entry) => (entry.issues || []).some((issue) =>
        issue.code === "low_event_grounding"
        || issue.code === "low_evidence_grounding"
        || issue.code === "weak_evidence_overstated"
        || issue.code === "missing_plot_event"
      ))
      .slice(0, 12);
    if (!weakSegments.length) {
      return { segments: [], fullNarration: "" };
    }
    const { minWords, maxWords, targetWords } = getNarrationWordTargets(targetDuration, voiceSpeed);
    const prompt = [
      "You are a strict voice/visual grounding editor.",
      "Some narration lines do not match their visual scene or plot event. Rewrite only those lines so each line describes the matching event on screen.",
      languageInstruction(narrationLanguage),
      perspectiveInstruction(perspective),
      genreInstruction(genreMode),
      viralAngleInstruction(viralAngle),
      "",
      `Final total narration should remain roughly ${minWords}-${maxWords} words, aiming for ${targetWords}.`,
      "",
      "Rules:",
      "- Preserve all segment indexes.",
      "- Do not move information to another segment.",
      "- If the old line mentions an event not visible in that segment, rewrite it to match evidenceSummary/visualSummary/eventText.",
      "- Use Evidence Store evidenceIds from the same scene. Do not cite evidenceIds from another scene.",
      "- Use character IDs and stable labels from characterBible.",
      "- Use character mental model, relationship graph, world-state timeline, emotional timeline, and story beat graph.",
      "- If evidenceLevel is weak, do not state motives or emotions as certainty.",
      "- Prefer short cause-effect lines: what changed, why it matters, what danger/question remains.",
      "- Preserve beatId, plotEventId, characterIds, evidenceIds, currentCharacterGoal, currentCharacterKnowledge, emotionBefore, emotionAfter, whatChanged, visualEvidence, transcriptEvidence, evidenceLevel, and groundingNote.",
      "- Keep each rewritten sentence 15 words or fewer.",
      "- Return all segments, not only repaired ones.",
      "- fullNarration must equal all narrationLine fields joined in index order.",
      "",
      "Return JSON only:",
      "{",
      '  "fullNarration": "continuous voiceover",',
      '  "repairs": [{"index":2,"reason":"old line referenced another event"}],',
      '  "segments": [',
      '    {"index":0,"beatId":"beat_001","plotEventId":"event_001","characterIds":["char_hero"],"evidenceIds":["ev_scene_0001_visual_01"],"currentCharacterGoal":"...","currentCharacterKnowledge":"...","emotionBefore":"...","emotionAfter":"...","whatChanged":"...","visualEvidence":"...","transcriptEvidence":"...","evidenceLevel":"visual_confirmed","visualEvent":"...", "groundingNote":"...", "narrationLine":"...", "subtitleText":"..."}',
      "  ]",
      "}",
      "",
      "Context:",
      JSON.stringify({
        title,
        summary,
        filmMemory: filmMemory || {},
        evidenceStoreBrief: buildEvidenceStoreBrief(evidenceStore),
        evidenceGraphBrief: buildEvidenceGraphBrief(evidenceGraph),
        characterTrackerBrief: buildCharacterTrackerBrief(characterTracker),
        filmUnderstanding: filmUnderstanding || {},
        narrativeIntelligence: narrativeIntelligence || {},
        weakSegments,
        allSegments: segments || []
      }, null, 2)
    ].join("\n");
    return this.generateTextJson({
      prompt,
      temperature: 0.25,
      label: "Gemini narration grounding repair"
    });
  }

  async reviewSceneScript({
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
    const prompt = [
      "You are a strict AI scene/script reviewer for a short movie recap tool.",
      "Evaluate whether the narration/script for ONE selected scene matches the visual event, story beat, character state, and expected voice timing.",
      languageInstruction(narrationLanguage),
      "",
      "Review goals:",
      "- Decide if the script describes the selected scene correctly.",
      "- Decide if the voice duration is likely to fit the scene duration.",
      "- Detect if the script talks about a different scene, reveals too early, or invents unsupported character motivation/emotion.",
      "- If it does not match, propose a better narrationLine for this exact scene.",
      "",
      "Rules:",
      "- Do not rewrite if the current script is already good.",
      "- Suggested rewrite must only describe or imply what the selected scene/story beat supports.",
      "- Keep the rewrite short enough for the scene duration and voice speed.",
      "- If evidence is weak, use softer language; do not state motives/emotions as fact.",
      "- Keep stable character labels from character bible.",
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
        voiceSpeed,
        filmMemory: filmMemory || {},
        filmUnderstanding: filmUnderstanding || {},
        narrativeIntelligence: narrativeIntelligence || {},
        selectedSegment: segment || {},
        previousSegment: previousSegment || null,
        nextSegment: nextSegment || null
      }, null, 2)
    ].join("\n");
    return this.generateTextJson({
      prompt,
      temperature: 0.22,
      label: "Gemini scene script review"
    });
  }

  async understandFilm({
    videoPath,
    targetDuration,
    genreMode,
    spoilerMode,
    narrationLanguage,
    viralAngle,
    lockedScenes,
    promptLogPath,
    rawResponsePath,
    parsedResponsePath
  }) {
    const prompt = this.buildFilmMemoryPrompt({
      targetDuration,
      genreMode,
      spoilerMode,
      narrationLanguage,
      viralAngle,
      lockedScenes
    });

    if (promptLogPath) {
      await fs.promises.writeFile(promptLogPath, prompt, "utf8");
    }

    const uploadedFile = await this.uploadFile(videoPath);
    await this.waitForFileActive(uploadedFile);

    try {
      const response = await this.fetchWithRetry(() => fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          generationConfig: {
            temperature: 0.25,
            responseMimeType: "application/json"
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  file_data: {
                    mime_type: uploadedFile.mimeType,
                    file_uri: uploadedFile.uri
                  }
                },
                { text: prompt }
              ]
            }
          ]
        })
      }), "Gemini film understanding");

      const payload = await readResponseJson(response, "Gemini film understanding response");
      const text = extractTextFromResponse(payload);
      if (rawResponsePath) {
        await fs.promises.writeFile(rawResponsePath, text || JSON.stringify(payload, null, 2), "utf8");
      }
      const parsed = extractJsonBlock(text);
      if (parsedResponsePath) {
        await fs.promises.writeFile(parsedResponsePath, JSON.stringify(parsed, null, 2), "utf8");
      }
      return parsed;
    } finally {
      await fetch(`${this.baseUrl}/v1beta/${uploadedFile.name}?key=${this.apiKey}`, {
        method: "DELETE"
      }).catch(() => {});
    }
  }

  buildCandidatePrompt({ targetDuration, genreMode, spoilerMode, narrationLanguage, lockedScenes, filmMemory, viralAngle }) {
    const maxPromptScenes = 900;
    const promptScenes = Array.isArray(lockedScenes) && lockedScenes.length > maxPromptScenes
      ? Array.from({ length: maxPromptScenes }, (_value, index) => {
          const sourceIndex = Math.floor((index / Math.max(1, maxPromptScenes - 1)) * (lockedScenes.length - 1));
          return lockedScenes[sourceIndex];
        })
      : lockedScenes;
    const sceneInstruction = Array.isArray(lockedScenes) && lockedScenes.length
      ? [
          "Timestamp lock:",
          "- You MUST choose only from the provided physical scene list.",
          "- Return sceneId for every candidate. Do not invent timestamps.",
          "- startSec/endSec are optional echoes only; the app will ignore them and use the locked sceneId timestamps.",
          "- You may tag a scene as cutaway/reaction/setup/etc, but you may not split a scene into new timestamps.",
          "",
          "Locked physical scene list:",
          JSON.stringify(promptScenes, null, 2),
          lockedScenes.length > maxPromptScenes ? `The full video has ${lockedScenes.length} detected scenes; this prompt includes ${maxPromptScenes} evenly sampled locked scenes across the entire video.` : ""
        ].join("\n")
      : "";
    return [
      "You are a senior short-form movie editor.",
      "Analyze the uploaded video and mine the most valuable visual moments for a TikTok movie review.",
      "Do NOT create the final edit yet. Return a pool of candidate scenes that a separate timeline builder will select from.",
      languageInstruction(narrationLanguage),
      genreInstruction(genreMode),
      viralAngleInstruction(viralAngle),
      "",
      sceneInstruction,
      "",
      `Target output duration later will be ${targetDuration} seconds, but you must return many candidates, not only ${targetDuration} seconds.`,
      `Spoiler mode: ${spoilerMode}.`,
      "",
      "Return JSON only:",
      "{",
      '  "title": "working title",',
      '  "summary": "short recap angle",',
      '  "candidates": [',
      "    {",
      '      "sceneId": "scene_0007",',
      '      "startSec": 12.4,',
      '      "endSec": 16.8,',
      '      "role": "hook|setup|conflict|escalation|cliffhanger|cutaway",',
      '      "description": "what is visible on screen",',
      '      "reason": "why this is valuable",',
      '      "visualClarityScore": 8,',
      '      "emotionScore": 8,',
      '      "motionScore": 7,',
      '      "tensionScore": 8,',
      '      "contextScore": 6,',
      '      "continuityScore": 7,',
      '      "dialogueDependency": 2,',
      '      "spoilerRisk": 3,',
      '      "viralScore": 9,',
      '      "plotImportanceScore": 8,',
      '      "retentionScore": 9,',
      '      "standaloneScore": 8,',
      '      "noveltyScore": 7,',
      '      "suddenVisualChangeScore": 8,',
      '      "openingImpactScore": 9,',
      '      "momentFocus": "early|middle|late|full",',
      '      "momentDurationSec": 3.0,',
      '      "screenText": "optional short text",',
      '      "audio_vibe": "Suspense|Shock|Sadness|Action|Calm",',
      '      "font_style": "standard|horror_red|shake_intense|calm_white",',
      '      "keywords": ["word1","word2"]',
      "    }",
      "  ]",
      "}",
      "",
      "Rules:",
      "- Return 25 to 40 candidates if the video has enough distinct moments.",
      "- Candidate duration should usually be 1.5 to 8 seconds.",
      "- If a locked physical scene is longer than 8 seconds, still return that sceneId and explain the valuable moment in description.",
      "- Add momentFocus: early, middle, late, or full. Add momentDurationSec for the strongest micro-moment inside the locked scene.",
      "- Add plotImportanceScore, retentionScore, standaloneScore, noveltyScore, suddenVisualChangeScore, and openingImpactScore as integers 1-10.",
      "- Negative scoring rule: static talking scenes must be scored harshly. If motionScore <= 4 and dialogueDependency >= 7, reduce viralScore and retentionScore to 3 or below unless the scene has a shocking visual reveal, blood/gore, body transformation, monster reveal, explosion, fall, crash, or kill.",
      "- Visual hook boost rule: scenes with sudden light/action change, falling, crashing, fast movement, explosion, creature reveal, or violent impact in the first 3 seconds should get openingImpactScore >= 9 and should be considered hook candidates.",
      "- Do not overrate exposition. A scene that only explains the plot is not viral unless it creates injustice, bizarre rules, or a strong curiosity gap.",
      "- Include at least 3 hook candidates, 4 setup/context candidates, 6 conflict/escalation candidates, 3 cliffhanger candidates, and several cutaways/reactions.",
      "- Prioritize moments understandable without original dialogue.",
      "- Avoid black frames, credits, dead air, and visually unclear shots.",
      "- Do not overlap candidates heavily unless they capture different valuable micro-moments.",
      "- If spoiler mode is low, mark high spoiler moments with spoilerRisk >= 8 instead of hiding them.",
      "- Scores are integers 1-10.",
      "",
      "Film memory to obey:",
      JSON.stringify(filmMemory || {}, null, 2)
    ].join("\n");
  }

  buildCandidateMetadataPrompt({ sceneMetadata, evidenceStore, targetDuration, genreMode, spoilerMode, narrationLanguage, filmMemory, viralAngle }) {
    const maxPromptScenes = 700;
    const sourceScenes = Array.isArray(sceneMetadata?.scenes) ? sceneMetadata.scenes : [];
    const promptScenes = sourceScenes.length > maxPromptScenes
      ? Array.from({ length: maxPromptScenes }, (_value, index) => {
          const sourceIndex = Math.floor((index / Math.max(1, maxPromptScenes - 1)) * (sourceScenes.length - 1));
          return sourceScenes[sourceIndex];
        })
      : sourceScenes;
    return [
      "You are a senior short-form movie editor.",
      "Mine the strongest candidate scenes from the metadata chain only. Do not require raw video upload.",
      "The app will lock all timestamps to sceneId, so return sceneId for every candidate.",
      languageInstruction(narrationLanguage),
      genreInstruction(genreMode),
      viralAngleInstruction(viralAngle),
      "",
      `Target output duration later will be ${targetDuration} seconds, but return a broad candidate pool.`,
      `Spoiler mode: ${spoilerMode}.`,
      "",
      buildEvidenceStoreBrief(evidenceStore),
      "",
      "Scene metadata chain:",
      JSON.stringify(promptScenes, null, 2),
      sourceScenes.length > maxPromptScenes ? `The full chain has ${sourceScenes.length} scenes; this prompt includes ${maxPromptScenes} evenly sampled scenes.` : "",
      "",
      "Scoring hints:",
      "- HIGH motion, LOUD audio, FLASH light_change, and strong local_visual_tags should boost openingImpactScore, retentionScore, and motionScore.",
      "- Prefer scenes that advance the story spine from filmMemory and have clear audio_transcript context.",
      "- Candidate description/reason must be grounded in Evidence Store scene evidence. If evidence is weak, lower confidence scores instead of embellishing.",
      "- Static dialogue scenes need a strong reveal, injustice, bizarre rule, or continuity reason.",
      "- Use reframe hints only as evidence that a subject was found; the renderer will apply them later.",
      "",
      "Return JSON only:",
      "{",
      '  "title": "working title",',
      '  "summary": "short recap angle",',
      '  "candidates": [',
      "    {",
      '      "sceneId": "scene_0007",',
      '      "startSec": 12.4,',
      '      "endSec": 16.8,',
      '      "role": "hook|setup|conflict|escalation|cliffhanger|cutaway",',
      '      "description": "what likely happens in this scene",',
      '      "reason": "why this is valuable",',
      '      "visualClarityScore": 8,',
      '      "emotionScore": 8,',
      '      "motionScore": 7,',
      '      "tensionScore": 8,',
      '      "contextScore": 6,',
      '      "continuityScore": 7,',
      '      "dialogueDependency": 2,',
      '      "spoilerRisk": 3,',
      '      "viralScore": 9,',
      '      "plotImportanceScore": 8,',
      '      "retentionScore": 9,',
      '      "standaloneScore": 8,',
      '      "noveltyScore": 7,',
      '      "suddenVisualChangeScore": 8,',
      '      "openingImpactScore": 9,',
      '      "momentFocus": "early|middle|late|full",',
      '      "momentDurationSec": 3.0,',
      '      "screenText": "optional short text",',
      '      "audio_vibe": "Suspense|Shock|Sadness|Action|Calm",',
      '      "font_style": "standard|horror_red|shake_intense|calm_white",',
      '      "keywords": ["word1","word2"]',
      "    }",
      "  ]",
      "}",
      "",
      "Rules:",
      "- Return 25 to 40 candidates if possible.",
      "- Include at least 3 hook candidates, 4 setup/context candidates, 6 conflict/escalation candidates, 3 cliffhanger candidates, and several cutaways/reactions.",
      "- Do not invent sceneIds outside the provided metadata.",
      "- Scores are integers 1-10.",
      "",
      "Film memory to obey:",
      JSON.stringify(filmMemory || {}, null, 2)
    ].join("\n");
  }

  async mineCandidateScenesFromMetadata({
    sceneMetadata,
    evidenceStore,
    targetDuration,
    genreMode,
    spoilerMode,
    narrationLanguage,
    filmMemory,
    viralAngle,
    promptLogPath,
    rawResponsePath,
    parsedResponsePath
  }) {
    const prompt = this.buildCandidateMetadataPrompt({
      sceneMetadata,
      evidenceStore,
      targetDuration,
      genreMode,
      spoilerMode,
      narrationLanguage,
      filmMemory,
      viralAngle
    });
    return this.generateTextJson({
      prompt,
      temperature: 0.38,
      promptLogPath,
      rawResponsePath,
      parsedResponsePath,
      label: "Gemini metadata candidate mining"
    });
  }

  async mineCandidateScenes({
    videoPath,
    targetDuration,
    genreMode,
    spoilerMode,
    narrationLanguage,
    lockedScenes,
    filmMemory,
    viralAngle,
    promptLogPath,
    rawResponsePath,
    parsedResponsePath
  }) {
    const prompt = this.buildCandidatePrompt({
      targetDuration,
      genreMode,
      spoilerMode,
      narrationLanguage,
      lockedScenes,
      filmMemory,
      viralAngle
    });

    if (promptLogPath) {
      await fs.promises.writeFile(promptLogPath, prompt, "utf8");
    }

    const uploadedFile = await this.uploadFile(videoPath);
    await this.waitForFileActive(uploadedFile);

    try {
      const response = await this.fetchWithRetry(() => fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          generationConfig: {
            temperature: 0.40,
            responseMimeType: "application/json"
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  file_data: {
                    mime_type: uploadedFile.mimeType,
                    file_uri: uploadedFile.uri
                  }
                },
                { text: prompt }
              ]
            }
          ]
        })
      }), "Gemini candidate scene mining");

      const payload = await readResponseJson(response, "Gemini candidate scene mining response");
      const text = extractTextFromResponse(payload);
      if (rawResponsePath) {
        await fs.promises.writeFile(rawResponsePath, text || JSON.stringify(payload, null, 2), "utf8");
      }
      const parsed = extractJsonBlock(text);
      if (parsedResponsePath) {
        await fs.promises.writeFile(parsedResponsePath, JSON.stringify(parsed, null, 2), "utf8");
      }
      return parsed;
    } finally {
      await fetch(`${this.baseUrl}/v1beta/${uploadedFile.name}?key=${this.apiKey}`, {
        method: "DELETE"
      }).catch(() => {});
    }
  }

  async planReview({
    videoPath,
    targetDuration,
    genreMode,
    perspective,
    spoilerMode,
    narrationEnabled,
    rewriteVoiceover,
    narrationLanguage,
    voiceSpeed,
    promptLogPath,
    rawResponsePath,
    parsedResponsePath,
    promptOverride
  }) {
    const prompt = promptOverride || this.buildPrompt({
      targetDuration,
      genreMode,
      perspective,
      spoilerMode,
      narrationEnabled,
      rewriteVoiceover,
      narrationLanguage,
      voiceSpeed
    });

    if (promptLogPath) {
      await fs.promises.writeFile(promptLogPath, prompt, "utf8");
    }

    const uploadedFile = await this.uploadFile(videoPath);
    await this.waitForFileActive(uploadedFile);

    try {
      const response = await this.fetchWithRetry(() => fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          generationConfig: {
            temperature: 0.45,
            responseMimeType: "application/json"
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  file_data: {
                    mime_type: uploadedFile.mimeType,
                    file_uri: uploadedFile.uri
                  }
                },
                {
                  text: prompt
                }
              ]
            }
          ]
        })
      }), "Gemini generateContent");

      const payload = await readResponseJson(response, "Gemini review plan response");
      const text = extractTextFromResponse(payload);
      if (rawResponsePath) {
        await fs.promises.writeFile(rawResponsePath, text || JSON.stringify(payload, null, 2), "utf8");
      }

      const parsed = extractJsonBlock(text);
      if (parsedResponsePath) {
        await fs.promises.writeFile(parsedResponsePath, JSON.stringify(parsed, null, 2), "utf8");
      }
      return parsed;
    } finally {
      await fetch(`${this.baseUrl}/v1beta/${uploadedFile.name}?key=${this.apiKey}`, {
        method: "DELETE"
      }).catch(() => {});
    }
  }
}

module.exports = GeminiService;
