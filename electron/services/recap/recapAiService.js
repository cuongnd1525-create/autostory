const VertexAiService = require("../vertexAiService");
const {
  validateVisualEvent,
  validateStoryModel,
  validateRecapPlan,
  validateSpeechUnit,
  validateQualityIssue,
  safeNumber,
  safeText,
  safeArray
} = require("./recapTypes");

class RecapAiService {
  constructor(settings = {}) {
    this.settings = settings;
    this.vertex = new VertexAiService(settings);
  }

  getAnalysisModel() {
    return this.settings.vertexAnalysisModel || "gemini-2.5-flash";
  }

  getQualityModel() {
    return this.settings.vertexQualityModel || "gemini-2.5-pro";
  }

  async runVertexCall({ filePaths = [], prompt, responseSchema = null, temperature = 0.2, taskType = "video_analysis", modelOverride = "", signal, onProgress }) {
    let lastError = null;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const result = await this.vertex.generateJsonFromFiles({
          filePaths,
          prompt,
          temperature,
          taskType,
          responseSchema,
          strictRootJson: true,
          modelOverride,
          signal,
          onProgress
        });

        if (result && typeof result === "object") {
          return result;
        }
        throw new Error("AI returned an empty or non-object response.");
      } catch (err) {
        lastError = err;
        if (signal?.aborted || /budget|timeout|quota|permission|403/i.test(err.message)) {
          throw err;
        }
        if (attempt < maxAttempts) {
          const delayMs = 1500 * (2 ** (attempt - 1));
          onProgress?.({ message: `Lỗi AI tạm thời (${err.message}). Đang thử lại ${attempt + 1}/${maxAttempts}...` });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError || new Error("Vertex AI request failed after retries.");
  }

  /**
   * 1. Analyze a video chunk to identify scenes, shots, and fine-grained VisualEvents.
   */
  async analyzeVideoChunk({
    chunkPath,
    chunkVideoPath,
    chunkInfo,
    chunkMetadata,
    signal,
    cancelToken,
    onProgress
  }) {
    const activeChunkPath = chunkPath || chunkVideoPath;
    const info = chunkInfo || chunkMetadata || {};
    const activeSignal = signal || cancelToken;
    const chunkStart = Number(info.sourceStartSec || 0);
    const chunkEnd = Number(info.sourceEndSec || 0);
    const chunkDuration = Number(info.durationSec || (chunkEnd > chunkStart ? chunkEnd - chunkStart : 0));
    const chunkIndex = info.chunkIndex ?? 1;

    const prompt = [
      "You are an expert film analyst and video editor.",
      `Analyze the attached video chunk representing source timeline [${chunkStart.toFixed(2)}s to ${chunkEnd.toFixed(2)}s] (duration: ${chunkDuration.toFixed(2)}s).`,
      "Deconstruct the video into granular VisualEvents that can serve as visual anchors for narration.",
      "",
      "CRITICAL RULES:",
      "1. A VisualEvent is something distinct and visible (e.g. John opens the locked door, Sarah gasps, car crashes, character examines evidence).",
      "2. Timestamps 'source_start' and 'source_end' MUST be absolute timestamps relative to the chunk start or burned timecode.",
      "3. For each event, evaluate: importance (0.0 - 1.0), motion_level (0.0 - 1.0), dialogue_present (boolean), face_closeup (boolean), lip_sync_risk (boolean: true if speaking mouth is clearly visible).",
      "4. Identify characters, actions, and objects accurately based only on visible evidence.",
      "",
      "Return a JSON object conforming to this schema:",
      "{",
      '  "summary": "Brief summary of what happens in this chunk",',
      '  "characters": [{"name": "string", "role": "string", "description": "string"}],',
      '  "events": [',
      '    {',
      '      "id": "event_0001",',
      '      "source_start": 0.0,',
      '      "source_end": 4.5,',
      '      "description": "What happens visibly",',
      '      "subjects": ["Character name"],',
      '      "actions": ["opens door"],',
      '      "objects": ["door", "key"],',
      '      "location": "hallway",',
      '      "importance": 0.85,',
      '      "motion_level": 0.5,',
      '      "dialogue_present": false,',
      '      "face_closeup": false,',
      '      "lip_sync_risk": false',
      '    }',
      '  ]',
      "}"
    ].join("\n");

    const schema = {
      type: "object",
      required: ["summary", "events"],
      properties: {
        summary: { type: "string" },
        characters: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "description"],
            properties: { name: { type: "string" }, role: { type: "string" }, description: { type: "string" } }
          }
        },
        events: {
          type: "array",
          items: {
            type: "object",
            required: ["source_start", "source_end", "description"],
            properties: {
              id: { type: "string" },
              source_start: { type: "number" },
              source_end: { type: "number" },
              description: { type: "string" },
              subjects: { type: "array", items: { type: "string" } },
              actions: { type: "array", items: { type: "string" } },
              objects: { type: "array", items: { type: "string" } },
              location: { type: "string" },
              importance: { type: "number" },
              motion_level: { type: "number" },
              dialogue_present: { type: "boolean" },
              face_closeup: { type: "boolean" },
              lip_sync_risk: { type: "boolean" }
            }
          }
        }
      }
    };

    const raw = await this.runVertexCall({
      filePaths: [activeChunkPath],
      prompt,
      responseSchema: schema,
      modelOverride: this.getAnalysisModel(),
      signal: activeSignal,
      onProgress
    });

    const events = safeArray(raw.events).map((ev, idx) => {
      // Map timestamps relative to the chunk start if needed
      let sStart = safeNumber(ev.source_start, 0);
      let sEnd = safeNumber(ev.source_end, sStart + 1);
      if (sStart < chunkStart && sStart <= chunkDuration) {
        sStart += chunkStart;
        sEnd += chunkStart;
      }
      return validateVisualEvent({
        ...ev,
        id: ev.id || `chunk_${chunkIndex}_ev_${idx + 1}`,
        source_start: Math.max(chunkStart, Math.min(chunkEnd, sStart)),
        source_end: Math.max(sStart + 0.3, Math.min(chunkEnd, sEnd))
      }, idx);
    });

    return {
      chunkIndex,
      summary: safeText(raw.summary || ""),
      characters: safeArray(raw.characters),
      events
    };
  }

  /**
   * 2. Synthesize a Global Story Model (Story Bible) from chunk summaries or visual events.
   */
  async buildStoryModel({ chunkSummaries, events, metadata, videoMetadata, signal, cancelToken, onProgress }) {
    const activeSignal = signal || cancelToken;
    const meta = metadata || videoMetadata || {};
    const totalDuration = Number(meta.duration || 0);

    let eventDigest = [];
    if (Array.isArray(chunkSummaries) && chunkSummaries.length) {
      eventDigest = chunkSummaries.map((c) => ({
        chunk: c.chunkIndex,
        summary: c.summary,
        keyEvents: (c.events || []).filter((e) => (e.importance ?? 0.5) >= 0.6).map((e) => ({
          id: e.id,
          desc: e.description,
          range: [e.source_start, e.source_end]
        }))
      }));
    } else if (Array.isArray(events) && events.length) {
      const step = Math.max(4, Math.ceil(events.length / 8));
      for (let i = 0; i < events.length; i += step) {
        const slice = events.slice(i, i + step);
        eventDigest.push({
          chunk: Math.floor(i / step) + 1,
          summary: slice.map((e) => e.description).slice(0, 3).join("; "),
          keyEvents: slice.filter((e) => (e.importance ?? 0.5) >= 0.5).map((e) => ({
            id: e.id,
            desc: e.description,
            range: [e.source_start, e.source_end]
          }))
        });
      }
    }

    const prompt = [
      "You are a master storyteller and dramaturg creating a cinematic documentary recap.",
      "Below are the sequential summaries and key visual events extracted from a video.",
      "Synthesize a compact, coherent, and emotionally resonant GLOBAL STORY MODEL.",
      "Identify the core dramatic question, the protagonist's dilemma, escalating stakes, turning points, climax, and emotional resonance.",
      "",
      `Total Source Duration: ${totalDuration.toFixed(2)}s`,
      "Visual Event Digest:",
      JSON.stringify(eventDigest, null, 2),
      "",
      "CRITICAL RULES:",
      "- Do NOT invent events or characters unsupported by the visual data.",
      "- Identify the central conflict, emotional stakes, character motivations, revelations, climax, and ending.",
      "- The output will serve as the master narrative spine for writing continuous, unbroken voiceover.",
      "",
      "Return JSON conforming to this schema:",
      "{",
      '  "title": "Story Title",',
      '  "logline": "1-2 sentence core premise",',
      '  "conflict": "Central conflict or mystery",',
      '  "characters": [{"id": "c1", "name": "Name", "role": "protagonist", "description": "Who they are"}],',
      '  "locations": [{"id": "l1", "name": "Location", "significance": "Why it matters"}],',
      '  "story_arcs": [{"id": "a1", "name": "Main Arc", "description": "Arc description"}],',
      '  "major_events": [{"id": "m1", "event_ref_id": "event_id", "title": "Title", "description": "Desc", "causes": [], "consequences": []}],',
      '  "turning_points": [{"event_ref_id": "event_id", "description": "Desc", "impact": "Impact"}],',
      '  "climax": "Description of the climax",',
      '  "ending": {"description": "Resolution", "outcome": "Final outcome"}',
      "}"
    ].join("\n");

    const schema = {
      type: "object",
      required: ["title", "logline", "conflict", "characters", "major_events", "climax", "ending"],
      properties: {
        title: { type: "string" },
        logline: { type: "string" },
        conflict: { type: "string" },
        characters: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name", "role", "description"],
            properties: { id: { type: "string" }, name: { type: "string" }, role: { type: "string" }, description: { type: "string" } }
          }
        },
        locations: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name"],
            properties: { id: { type: "string" }, name: { type: "string" }, significance: { type: "string" } }
          }
        },
        story_arcs: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name"],
            properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" } }
          }
        },
        major_events: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "description"],
            properties: {
              id: { type: "string" },
              event_ref_id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              causes: { type: "array", items: { type: "string" } },
              consequences: { type: "array", items: { type: "string" } }
            }
          }
        },
        turning_points: {
          type: "array",
          items: {
            type: "object",
            required: ["description"],
            properties: { event_ref_id: { type: "string" }, description: { type: "string" }, impact: { type: "string" } }
          }
        },
        climax: { type: "string" },
        ending: {
          type: "object",
          required: ["description"],
          properties: { description: { type: "string" }, outcome: { type: "string" } }
        }
      }
    };

    const raw = await this.runVertexCall({
      filePaths: [],
      prompt,
      responseSchema: schema,
      modelOverride: this.getQualityModel(),
      signal: activeSignal,
      onProgress
    });

    return validateStoryModel(raw);
  }

  /**
   * 3. Plan Recap Edit: Select visual events that fulfill target duration and narrative clarity.
   */
  async planRecap({ storyModel, visualEvents, events, targetDurationSec = 90, allowShotReuse = false, signal, cancelToken, onProgress }) {
    const activeSignal = signal || cancelToken;
    const eventList = Array.isArray(visualEvents) ? visualEvents : (Array.isArray(events) ? events : []);
    const compactEvents = eventList.map((e) => ({
      id: e.id,
      range: [e.source_start, e.source_end],
      duration: e.duration || Number(((e.source_end || 0) - (e.source_start || 0)).toFixed(2)),
      desc: e.description,
      subjects: e.subjects || [],
      actions: e.actions || [],
      importance: e.importance,
      motion: e.motion_level,
      lip_sync: e.lip_sync_risk
    }));

    const prompt = [
      "You are an editor creating a high-retention video recap.",
      `Target Output Duration: ${targetDurationSec} seconds.`,
      `Shot Reuse Policy: ${allowShotReuse ? "Permitted when essential for narrative payoff" : "AVOID REUSE - every selected clip should be unique unless impossible"}.`,
      "",
      "Story Model:",
      JSON.stringify(storyModel, null, 2),
      "",
      "Available Visual Events:",
      JSON.stringify(compactEvents, null, 2),
      "",
      "EDIT PLANNING RULES:",
      "1. The opening (Hook) MUST establish immediate tension, curiosity, or conflict in the first few seconds without fake clickbait.",
      "2. Select a subset of VisualEvents whose sum of usable durations aligns with the target duration.",
      "3. Prioritize narrative clarity: setup -> escalating obstacle/conflict -> revelation/turning point -> climax -> payoff.",
      "4. Ensure chronological continuity unless a deliberate flash-forward hook is used.",
      "",
      "Return JSON conforming to this schema:",
      "{",
      `  "target_duration_sec": ${targetDurationSec},`,
      '  "hook_strategy": "Explanation of the opening hook",',
      '  "hook_event_ids": ["event_id"],',
      '  "selected_event_ids": ["event_id1", "event_id2", "..."],',
      '  "beats": [',
      '    {',
      '      "beat_id": "beat_1",',
      '      "role": "hook",',
      '      "purpose": "Why this beat is here",',
      '      "visual_event_ids": ["event_id1"],',
      '      "must_preserve": "Core action",',
      '      "can_omit": "Context that can be cut"',
      '    }',
      '  ]',
      "}"
    ].join("\n");

    const schema = {
      type: "object",
      required: ["target_duration_sec", "hook_event_ids", "selected_event_ids", "beats"],
      properties: {
        target_duration_sec: { type: "number" },
        hook_strategy: { type: "string" },
        hook_event_ids: { type: "array", items: { type: "string" } },
        selected_event_ids: { type: "array", items: { type: "string" } },
        beats: {
          type: "array",
          items: {
            type: "object",
            required: ["beat_id", "role", "visual_event_ids"],
            properties: {
              beat_id: { type: "string" },
              role: { type: "string" },
              purpose: { type: "string" },
              visual_event_ids: { type: "array", items: { type: "string" } },
              must_preserve: { type: "string" },
              can_omit: { type: "string" }
            }
          }
        }
      }
    };

    const raw = await this.runVertexCall({
      filePaths: [],
      prompt,
      responseSchema: schema,
      modelOverride: this.getQualityModel(),
      signal,
      onProgress
    });

    return validateRecapPlan(raw);
  }

  /**
   * 4. Generate Visual-Grounded Narration broken down into SpeechUnits and Clauses.
   * Weaves an unbroken, continuous cinematic story grounded in visual events.
   */
  async generateNarration({
    recapPlan,
    visualEventsMap,
    events,
    storyModel,
    voiceProfile,
    wordsPerSecond,
    scriptStyle = "cinematic",
    densityMultiplier = 1.0,
    signal,
    cancelToken,
    onProgress
  }) {
    const activeSignal = signal || cancelToken;
    const resolvedEventsMap = visualEventsMap || (Array.isArray(events) ? Object.fromEntries(events.map((e) => [e.id, e])) : {});
    const baseWps = Number(wordsPerSecond || voiceProfile?.wordsPerSecond || 2.6);
    const density = Math.max(0.8, Math.min(1.4, Number(densityMultiplier || 1.0)));
    const wps = Math.max(1.5, Math.min(3.5, baseWps * density));

    // Calculate duration budget per beat
    const beatsWithBudgets = (recapPlan?.beats || []).map((beat) => {
      const beatEvents = (beat.visual_event_ids || []).map((id) => resolvedEventsMap[id]).filter(Boolean);
      const totalVisualSec = beatEvents.reduce((sum, e) => sum + (e.duration || ((e.source_end || 0) - (e.source_start || 0)) || 0), 0);
      const targetWordCount = Math.max(3, Math.round(totalVisualSec * wps * 0.92));
      const maxWordCount = Math.max(targetWordCount + 1, Math.round(totalVisualSec * wps * 1.08));
      const maxChars = Math.max(20, Math.round(totalVisualSec * 15 * density));
      return {
        ...beat,
        totalVisualSec: Number(totalVisualSec.toFixed(2)),
        targetWordCount,
        maxWordCount,
        maxChars,
        events: beatEvents.map((e) => ({
          id: e.id,
          desc: e.description,
          duration: e.duration || Number(((e.source_end || 0) - (e.source_start || 0)).toFixed(2)),
          subjects: e.subjects || [],
          actions: e.actions || []
        }))
      };
    });

    const storySpineText = storyModel ? [
      "GLOBAL STORY SPINE (Maintain this unbroken through-line across the entire narrative):",
      `Title: ${storyModel.title || "Recap Story"}`,
      storyModel.logline ? `Core Premise / Logline: ${storyModel.logline}` : "",
      storyModel.conflict ? `Central Conflict / Mystery: ${storyModel.conflict}` : "",
      storyModel.characters?.length ? `Key Characters: ${storyModel.characters.map((c) => `${c.name} (${c.role}): ${c.description}`).join("; ")}` : "",
      storyModel.climax ? `Dramatic Climax: ${storyModel.climax}` : "",
      storyModel.ending?.description ? `Resolution / Ending: ${storyModel.ending.description}` : "",
      ""
    ].filter(Boolean).join("\n") : "";

    const prompt = [
      "You are a master cinematic documentary storyteller and film essay narrator.",
      "Write an unbroken, emotionally gripping English voiceover script covering the selected visual beats as ONE CONTINUOUS MASTER STORY.",
      "",
      storySpineText,
      "CRITICAL NARRATIVE & SYNCHRONIZATION RULES:",
      "1. CONTINUOUS THROUGH-LINE (NO FRAGMENTATION):",
      "   - The entire script MUST read like a single, seamless cinematic film essay from start to finish.",
      "   - NEVER write disconnected sentence fragments that merely describe isolated clips. Every sentence must flow causally into the next.",
      "   - Use evocative transitions and connectors ('Yet as...', 'What he didn't realize...', 'Beneath the calm surface...', 'By the time...') to bridge beats naturally.",
      "",
      "2. INTERPRETIVE DEPTH & ATMOSPHERE (BEYOND LITERAL DESCRIPTION):",
      "   - The viewer already sees the action on screen. Do not insult the audience by merely stating obvious visual facts.",
      "   - Instead, illuminate the stakes, internal character motivations, historical/dramatic context, and visceral atmosphere.",
      "   - Tone: Authoritative, atmospheric, cinematic, and profoundly engaging.",
      "",
      "3. CLAUSE-LEVEL VISUAL GROUNDING & VISUAL LEAD:",
      "   - Break narration into clear SpeechUnits, each divided into distinct clauses.",
      "   - Every clause MUST explicitly anchor to the specific 'visual_event_id' where that action, subject, or atmosphere appears.",
      "   - Visual Lead: The visual event must appear on screen 200-400ms before or as the narrator mentions it. Never name a visual reveal before the viewer can see it.",
      "",
      "4. PRECISE DURATION BUDGETING:",
      "   - Stay strictly within targetWordCount and maxWordCount for each beat so the spoken voice fits the video duration without awkward rushes or dead pauses.",
      "   - Spoken word cadence: Write natural, flowing sentences. Use punctuation (commas, em-dashes, periods) to create natural breath pauses.",
      "",
      `Speaking Rate: ~${wps.toFixed(2)} words per second.`,
      "Beats and Grounded Visual Events:",
      JSON.stringify(beatsWithBudgets, null, 2),
      "",
      "Return JSON conforming to this schema:",
      "{",
      '  "speech_units": [',
      '    {',
      '      "id": "speech_0001",',
      '      "beat_id": "beat_1",',
      '      "text": "As the dawn mist hung over the village, a peasant took his first breath of what could be his final morning.",',
      '      "visual_event_ids": ["event_0001", "event_0002"],',
      '      "clauses": [',
      '        {"clause_id": "speech_0001_c1", "text": "As the dawn mist hung over the village,", "visual_event_ids": ["event_0001"]},',
      '        {"clause_id": "speech_0001_c2", "text": "a peasant took his first breath of what could be his final morning.", "visual_event_ids": ["event_0002"]}',
      '      ]',
      '    }',
      '  ]',
      "}"
    ].join("\n");

    const schema = {
      type: "object",
      required: ["speech_units"],
      properties: {
        speech_units: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "text", "visual_event_ids", "clauses"],
            properties: {
              id: { type: "string" },
              beat_id: { type: "string" },
              text: { type: "string" },
              visual_event_ids: { type: "array", items: { type: "string" } },
              clauses: {
                type: "array",
                items: {
                  type: "object",
                  required: ["clause_id", "text", "visual_event_ids"],
                  properties: {
                    clause_id: { type: "string" },
                    text: { type: "string" },
                    visual_event_ids: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          }
        }
      }
    };

    const raw = await this.runVertexCall({
      filePaths: [],
      prompt,
      responseSchema: schema,
      modelOverride: this.getQualityModel(),
      signal: activeSignal,
      onProgress
    });

    return safeArray(raw.speech_units).map((u, idx) => validateSpeechUnit(u, idx));
  }

  /**
   * 5. Revise Narration: Shortens or lengthens narration to fit a specific speech duration budget.
   * Preserves clause structure, visual grounding, and narrative continuity.
   */
  async reviseNarration({ speechUnit, targetDurationSec, targetWordDelta, voiceProfile, reason = "timing mismatch", signal, cancelToken, onProgress }) {
    const activeSignal = signal || cancelToken;
    const wps = Math.max(1.5, Math.min(3.5, Number(voiceProfile?.wordsPerSecond || 2.5)));
    const targetWords = Math.max(3, Math.round(targetDurationSec * wps * 0.95));

    const prompt = [
      "You are a cinematic video editor rewriting a narration sentence to fit exact video timing.",
      `Current Text: "${speechUnit.text}"`,
      `Current Word Count: ${speechUnit.text.split(/\s+/).filter(Boolean).length}`,
      `Target Word Count: ~${targetWords} words (Target Audio Duration: ${targetDurationSec.toFixed(2)}s).`,
      `Reason: ${reason}.`,
      "",
      "EDITING RULES:",
      "- PRESERVE: Main subject, dramatic consequence, and emotional tension.",
      "- REMOVE FIRST: Fluff adverbs, redundant filler, and decorative adjectives.",
      "- Maintain natural, authoritative narrative tone and flow.",
      "- Output must maintain the same clause structure and visual_event_ids mapping.",
      "",
      "Return JSON:",
      "{",
      '  "text": "Rewritten narration text",',
      '  "clauses": [',
      '    {"clause_id": "c1", "text": "Clause 1", "visual_event_ids": ["event_id"]}',
      '  ]',
      "}"
    ].join("\n");

    const schema = {
      type: "object",
      required: ["text", "clauses"],
      properties: {
        text: { type: "string" },
        clauses: {
          type: "array",
          items: {
            type: "object",
            required: ["clause_id", "text", "visual_event_ids"],
            properties: {
              clause_id: { type: "string" },
              text: { type: "string" },
              visual_event_ids: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    };

    const raw = await this.runVertexCall({
      filePaths: [],
      prompt,
      responseSchema: schema,
      modelOverride: this.getAnalysisModel(),
      signal: activeSignal,
      onProgress
    });

    return validateSpeechUnit({
      ...speechUnit,
      text: safeText(raw.text, speechUnit.text),
      clauses: safeArray(raw.clauses).length ? raw.clauses : speechUnit.clauses
    });
  }

  /**
   * 6. Multimodal Quality Review: Gemini reviews the actual rendered draft video.
   */
  async reviewDraft({ draftVideoPath, timeline, decisions, storyModel, signal, cancelToken, onProgress }) {
    const activeSignal = signal || cancelToken;
    const decisionList = Array.isArray(decisions) ? decisions : safeArray(timeline?.decisions);

    const prompt = [
      "You are a strict Executive Video Producer and Editor reviewing a newly rendered draft of an AI Video Recap.",
      "Watch the attached draft video and evaluate its storytelling and audio-visual synchronization.",
      "",
      "EVALUATION CRITERIA:",
      "1. SEMANTIC ALIGNMENT: Does the image support what the narrator is saying at that exact moment?",
      "2. EVENT TIMING / VISUAL LEAD: Does an important visual reveal appear slightly before or approximately when named?",
      "3. STORY CONTINUITY: Can a viewer understand the cause-and-effect progression?",
      "4. PACING: Any boring, rushed, or lingering sections?",
      "5. FOOTAGE REPETITION: Are there redundant or repetitive clips?",
      "6. AWKWARD RETIMING: Does any footage look unnaturally fast or slow?",
      "7. HOOK QUALITY: Does the first 5 seconds grab attention without deceptive clickbait?",
      "",
      "Edit Timeline Context:",
      JSON.stringify(decisionList.map((d) => ({
        speech_unit_id: d.speech_unit_id,
        text: d.text,
        audio_duration: d.audio_duration,
        clips: (d.clips || []).map((c) => ({ out_range: [c.output_start, c.output_end], speed: c.video_speed, event: c.event_id }))
      })), null, 2),
      "",
      "Return JSON conforming to this schema:",
      "{",
      '  "overall_score": 0.85,',
      '  "summary": "Overall evaluation summary",',
      '  "issues": [',
      '    {',
      '      "issue_id": "issue_1",',
      '      "severity": "high",',
      '      "type": "semantic_alignment",',
      '      "output_start": 12.4,',
      '      "output_end": 15.8,',
      '      "description": "Narration mentions the discovery before the object is visible.",',
      '      "recommended_action": "extend prior clip or advance event reveal"',
      '    }',
      '  ]',
      "}"
    ].join("\n");

    const schema = {
      type: "object",
      required: ["overall_score", "summary", "issues"],
      properties: {
        overall_score: { type: "number" },
        summary: { type: "string" },
        issues: {
          type: "array",
          items: {
            type: "object",
            required: ["severity", "type", "output_start", "output_end", "description", "recommended_action"],
            properties: {
              issue_id: { type: "string" },
              severity: { type: "string" },
              type: { type: "string" },
              output_start: { type: "number" },
              output_end: { type: "number" },
              description: { type: "string" },
              recommended_action: { type: "string" }
            }
          }
        }
      }
    };

    const raw = await this.runVertexCall({
      filePaths: [draftVideoPath],
      prompt,
      responseSchema: schema,
      modelOverride: this.getQualityModel(),
      signal: activeSignal,
      onProgress
    });

    return {
      overall_score: safeNumber(raw.overall_score, 0.8),
      summary: safeText(raw.summary, "Draft review completed."),
      issues: safeArray(raw.issues).map((issue, idx) => validateQualityIssue(issue, idx))
    };
  }
}

module.exports = RecapAiService;
