const RecapProviderService = require("./recapProviderService");
const Editorial = require("./recapEditorialService");
const {
  validateVisualEvent,
  validateChunkTimeline,
  validateStoryModel,
  validateRecapPlan,
  validateSpeechUnit,
  validateQualityIssue,
  safeNumber,
  safeText,
  safeArray
} = require("./recapTypes");

class RecapAiService {
  constructor(settings = {}, dependencies = {}) {
    this.settings = settings;
    this.providerService = dependencies.providerService || new RecapProviderService(settings, dependencies);
    this.preferredModels = new Map();
    this.reviewDependencies = dependencies;
  }

  getAnalysisModel() {
    return this.providerService.getModel(false);
  }

  getQualityModel() {
    return this.providerService.getModel(true);
  }

  async proposeAngles({ storyModel, events, options, cancelToken, onProgress }) {
    const prompt = ["You are editing a TikTok film recap/review. Propose exactly 3 distinct, source-grounded narrative angles.",
      "Each angle must have one central question and a payoff supported by actual supplied events. No invented motivations or plot.",
      "Scores 0..10 rank clarity, curiosity, emotional stakes and evidence strength; they are editorial estimates, not predictions of views.",
      `Preferences: ${JSON.stringify(options)}`, `Story: ${JSON.stringify(storyModel)}`,
      `Events: ${JSON.stringify(events.map((e) => ({ id: e.id, description: e.description, importance: e.importance })))}`].join("\n");
    const schema = { type: "object", required: ["angles"], properties: { angles: { type: "array", items: {
      type: "object", required: ["id", "title", "central_question", "payoff", "event_ids", "score"], properties: {
        id: { type: "string" }, title: { type: "string" }, central_question: { type: "string" }, payoff: { type: "string" },
        event_ids: { type: "array", items: { type: "string", enum: events.map(event => event.id) } }, score: { type: "number" }
      } } } } };
    const raw = await this.runVertexCall({ prompt, responseSchema: schema, modelOverride: this.getQualityModel(), signal: cancelToken?.signal, onProgress });
    return Editorial.validateAngles(raw, events);
  }

  async proposeHooks({ angle, events, options, cancelToken, onProgress }) {
    const prompt = ["Write exactly 5 alternative spoken hooks for the selected TikTok story angle.",
      `Use ${options.language === "vi" ? "natural spoken Vietnamese" : "natural spoken US English"}. Aim for a complete 3–7 second opening (roughly 8–18 words).`,
      "Open immediately with a concrete contradiction, danger, surprise or question. No greetings, scene-setting essay or unsupported clickbait.",
      "Provide the opening visual event IDs and a later payoff_event_id that answers the promise. Never imply an outcome absent from the source.",
      "Score each 0..10 for spoken clarity, visual support and curiosity. Vary the framing, not just synonyms.",
      `Angle: ${JSON.stringify(angle)}`, `Events: ${JSON.stringify(events.map((e) => ({ id: e.id, description: e.description })))}`].join("\n");
    const schema = { type: "object", required: ["hooks"], properties: { hooks: { type: "array", items: {
      type: "object", required: ["id", "text", "event_ids", "payoff_event_id", "score"], properties: {
        id: { type: "string" }, text: { type: "string" }, event_ids: { type: "array", items: { type: "string", enum: events.map(event => event.id) } },
        payoff_event_id: { type: "string", enum: events.map(event => event.id) }, score: { type: "number" }
      } } } } };
    const raw = await this.runVertexCall({ prompt, responseSchema: schema, modelOverride: this.getQualityModel(), signal: cancelToken?.signal, onProgress });
    return Editorial.validateHooks(raw, events);
  }

  async rewriteRecap({ storyModel, events, recapPlan, speechUnits, options, feedback, cancelToken, onProgress }) {
    if (feedback?.clauseBudgets?.length) {
      return this.repairMeasuredClauses({ events, recapPlan, speechUnits, options, feedback, cancelToken, onProgress });
    }
    const currentWords = speechUnits.reduce((sum, unit) => sum + String(unit.text || "").trim().split(/\s+/).filter(Boolean).length, 0);
    const actualDuration = Number(feedback?.duration?.actual);
    const desiredWords = actualDuration > 0 ? Math.round(currentWords * options.targetDurationSec / actualDuration * .97) : currentWords;
    const prompt = ["Repair the supplied recap plan and spoken narration using only the source events.",
      "Return a complete revised plan and all speech units, not patches. Preserve the selected angle and hook verbatim in opening_hook.",
      "Use IDs from the provided events. Every speech unit and clause needs visual_event_ids. Each unit's beat_id must exist in plan.beats.",
      "Events marked anchorAudit are verified against actual source frames and dialogue. Their current descriptions override earlier story/plan summaries. Remove any existing claim no longer supported by the verified description, even if it appears in the old story model.",
      "Fit the measured TTS duration feedback by shortening/expanding sentences and selecting fewer/more relevant events; never speed up the voice unnaturally.",
      actualDuration > 0 ? `Measured current script: ${currentWords} words produced ${actualDuration.toFixed(1)} seconds. Aim for approximately ${desiredWords} spoken words TOTAL to reach ${options.targetDurationSec} seconds. This measured target supersedes earlier word/character limits. Keep the opening hook unchanged; distribute the remaining words across grounded body beats.`
        : `Current script: ${currentWords} spoken words. Preserve approximately this total word count while correcting the supplied quality issues.`,
      "For a quality-only repair, preserve the current total spoken word count within 90–105%; do not turn the whole recap into a shorter synopsis. Change only defective clauses and redistribute their word budget to other supported events.",
      "Measured clauseBudgets are hard visual constraints: shorten each listed group to its targetDuration/targetWordCount or select additional genuinely supporting unused source events. Do not reuse another action's clip, freeze footage to fill a long monologue, or exceed the supplied target. Keep the overall requested output duration by allocating words to supported parts of the story.",
      "Keep the causal explanation and payoff. Drop redundant exposition. Review/explain presets must keep their evidence-backed interpretation.",
      `Preferences: ${JSON.stringify(options)}`, `Story: ${JSON.stringify(storyModel)}`, `Events: ${JSON.stringify(events)}`,
      `Current plan: ${JSON.stringify(recapPlan)}`, `Current narration: ${JSON.stringify(speechUnits)}`, `Repair feedback: ${JSON.stringify(feedback)}`].join("\n");
    const refs = { type: "array", items: { type: "string", enum: events.map(event => event.id) } };
    const schema = { type: "object", required: ["plan", "speech_units"], properties: {
      plan: { type: "object", required: ["target_duration_sec", "selected_event_ids", "beats"], properties: {
        target_duration_sec: { type: "number" }, selected_event_ids: refs, hook_event_ids: refs,
        beats: { type: "array", items: { type: "object", required: ["beat_id", "role", "visual_event_ids"], properties: {
          beat_id: { type: "string" }, role: { type: "string" }, purpose: { type: "string" }, visual_event_ids: refs
        } } }
      } },
      speech_units: { type: "array", items: { type: "object", required: ["id", "beat_id", "text", "visual_event_ids", "clauses"], properties: {
        id: { type: "string" }, beat_id: { type: "string" }, text: { type: "string" }, visual_event_ids: refs,
        clauses: { type: "array", items: { type: "object", required: ["text", "visual_event_ids"], properties: {
          clause_id: { type: "string" }, text: { type: "string" }, visual_event_ids: refs
        } } }
      } } }
    } };
    return this.runVertexCall({ prompt, responseSchema: schema, modelOverride: this.getQualityModel(), signal: cancelToken?.signal, onProgress });
  }

  async repairMeasuredClauses({ events, recapPlan, speechUnits, options, feedback, cancelToken, onProgress }) {
    const groups = feedback.clauseBudgets.map((group, index) => ({ index, text: group.text,
      maxWords: group.targetWordCount, minWords: group.minimumWordCount ?? Math.max(1, group.targetWordCount - 2),
      speechUnitId: group.speechUnitId, clauseIds: group.clauseIds, visual_event_ids: group.visual_event_ids }));
    const repairProperties = Object.fromEntries(groups.map(group => [`group_${group.index}`, {
      type: "array", minItems: 1, maxItems: group.maxWords, items: { type: "string" }
    }]));
    const schema = { type: "object", required: ["repairs"], properties: { repairs: {
      type: "object", required: Object.keys(repairProperties), properties: repairProperties
    } } };
    let previous = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = ["Rewrite only the supplied spoken clause groups to fit their measured visual footage and word budgets. Shorten overflowing groups; expand groups whose requested word budget is larger, using only supported detail.",
        `Language: ${options.language === "vi" ? "natural spoken Vietnamese" : "natural spoken US English"}.`,
        "Return exactly one repair for each index. Aim for minWords..maxWords whitespace-separated words. maxWords is a hard upper limit checked by code. Keep natural speech and the total recap budget; avoid compressing far below the requested range.",
        "Return repairs as an object keyed group_0, group_1, etc. Each value is an array of individual spoken words, including punctuation attached to its word. Each array has a schema-enforced maxItems budget. Do not put multiple words inside one item.",
        "Preserve the concrete action, causal link and meaning only when supported by the grounded evidence below. Remove unsupported claims from earlier scripts as well as redundancy and flourishes. Do not invent facts or change the source references. Do not add narration outside these groups.",
        `Groups: ${JSON.stringify(groups)}`,
        `Grounded evidence: ${JSON.stringify(events.filter(event => groups.some(group => group.visual_event_ids.includes(event.id))).map(event => ({ id: event.id, description: event.description })))}`,
        previous].join("\n");
      const result = await this.runVertexCall({ prompt, responseSchema: schema, modelOverride: this.getQualityModel(), signal: cancelToken?.signal, onProgress });
      const repairs = Array.isArray(result.repairs) ? result.repairs : Object.entries(result.repairs || {}).map(([key, words]) => ({
        index: /^group_\d+$/.test(key) ? Number(key.slice(6)) : NaN,
        text: Array.isArray(words) && words.every(word => typeof word === "string" && !/\s/.test(word)) ? words.join(" ") : ""
      }));
      const indexes = new Set(); let violation = "";
      for (const repair of repairs) {
        const group = groups[repair.index], text = typeof repair.text === "string" ? repair.text.trim() : "";
        const count = text.split(/\s+/).filter(Boolean).length;
        // One token of counting variance is measured with the actual TTS below;
        // it cannot bypass the hard visual-duration or final quality gates.
        if (!Number.isInteger(repair.index) || !group || indexes.has(repair.index) || !text || count > group.maxWords + 1) {
          violation = `Invalid repair ${repair.index}: ${count} words; limit ${group?.maxWords}.`; break;
        }
        indexes.add(repair.index);
      }
      if (repairs.length !== groups.length || indexes.size !== groups.length) violation ||= "Return all group indexes exactly once.";
      if (violation) {
        if (attempt === 1) throw new Error(`AI chưa sửa mệnh đề đúng ngân sách: ${violation}`);
        previous = `Your previous response exceeded or missed the hard limits: ${violation}\nPrevious response: ${JSON.stringify(result)}. Return corrected shorter repairs.`;
        onProgress?.({ message: "Bản sửa mệnh đề chưa đúng giới hạn từ; đang yêu cầu sửa lại một lần..." });
        continue;
      }
      const revised = structuredClone(speechUnits);
      for (const repair of repairs) {
        const group = groups[repair.index], ids = new Set(group.clauseIds);
        const owners = revised.filter(unit => (!group.speechUnitId || unit.id === group.speechUnitId)
          && group.clauseIds.every(id => unit.clauses?.some(clause => clause.clause_id === id)));
        const owner = owners.length === 1 ? owners[0] : null;
        if (!owner) throw new Error("Mệnh đề cần sửa không còn trong kịch bản; hãy phân tích lại thời điểm lời đọc.");
        const first = owner.clauses.findIndex(clause => ids.has(clause.clause_id));
        owner.clauses = owner.clauses.flatMap((clause, index) => !ids.has(clause.clause_id) ? [clause]
          : index === first ? [{ ...clause, text: repair.text.trim(), visual_event_ids: group.visual_event_ids }] : []);
        owner.text = owner.clauses.map(clause => clause.text).join(" ");
      }
      return { plan: recapPlan, speech_units: revised };
    }
  }

  async runVertexCall({ filePaths = [], prompt, responseSchema = null, temperature = 0.2, taskType = "video_analysis", modelOverride = "", signal, onProgress, validateResult, requestTimeoutMs }) {
    let lastError = null;
    const maxAttempts = 3;
    const preferred = this.preferredModels.get(modelOverride) || modelOverride;
    let models = this.providerService.prepareModels ? await this.providerService.prepareModels(preferred, { filePaths, signal, onProgress })
      : this.providerService.getFallbackModels?.(preferred) || [modelOverride];
    let canChangeModel = models.length > 1;
    const attemptedModels = new Set();
    let modelIndex = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        attemptedModels.add(models[modelIndex]);
        const requestedTimeout = typeof requestTimeoutMs === "object"
          ? (/-pro(?:-|$)|\bPro\b/i.test(models[modelIndex]) ? requestTimeoutMs.pro : requestTimeoutMs.flash)
          : requestTimeoutMs;
        const result = await this.providerService.generateJsonFromFiles({
          filePaths,
          prompt,
          temperature,
          taskType,
          responseSchema,
          strictRootJson: true,
          modelOverride: models[modelIndex],
          requestTimeoutMs: requestedTimeout ? Math.min(Math.max(15000, Number(this.settings.antigravityTimeoutMs) || 900000), requestedTimeout)
            : (modelIndex > 0 ? Math.min(Number(this.settings.antigravityTimeoutMs) || 900000, /-pro(?:-|$)/i.test(models[modelIndex]) ? 360000 : 240000) : undefined),
          signal,
          onProgress
        });

        if (result && typeof result === "object") {
          validateResult?.(result);
          if (models[modelIndex] !== modelOverride) this.preferredModels.set(modelOverride, models[modelIndex]);
          return result;
        }
        throw new Error("AI returned an empty or non-object response.");
      } catch (err) {
        lastError = err;
        const terminal = signal?.aborted || err.name === "AbortError" || err instanceof TypeError
          || ["cancelled", "auth", "forbidden_tool", "spawn_error", "prompt_blocked", "budget"].includes(err.kind)
          || /đạt giới hạn|daily.*budget|budget.*exceed/i.test(err.message)
          || /permission|unauthenticated|authentication|\b403\b|\b401\b|missing|chưa hỗ trợ|prohibited use|prompt.*blocked/i.test(err.message);
        if (terminal) throw err;
        if (err.kind === "provider_unavailable") throw err;
        if (this.providerService.provider === "antigravity_cli" && (err.kind === "invalid_model" || /invalid model selection|not recognized as a known model/i.test(err.message))) {
          if (attempt >= maxAttempts) throw err;
          models = await this.providerService.prepareModels(modelOverride, { filePaths, signal, onProgress, force: true, excluded: [...attemptedModels] });
          modelIndex = 0; canChangeModel = models.length > 1;
          onProgress?.({ level: "WARNING", message: `Danh sách model đã thay đổi. Bỏ model bị gỡ; thử ${models[0]}.` });
          continue;
        }
        const modelFailure = ["output_limit", "capacity", "stream_interrupted", "invalid_json"].includes(err.kind) || /timeout/.test(err.kind || "")
          || /output token limit|MAX_TOKENS|response was cut off|No capacity|RESOURCE_EXHAUSTED|UNAVAILABLE|\b50[0234]\b|\b429\b|stream was interrupted|timed? out|timeout|AI JSON|không trả JSON recap đầy đủ|AI returned an empty|ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message);
        let nextIndex = modelIndex + 1;
        if ((err.kind === "capacity" || /timeout/.test(err.kind || "")) && this.providerService.getModelFamily) {
          const family = this.providerService.getModelFamily(models[modelIndex]);
          nextIndex = models.findIndex((model, index) => index > modelIndex && this.providerService.getModelFamily(model) !== family);
          if (nextIndex < 0 && err.kind === "capacity") throw Object.assign(new Error("Antigravity đang hết công suất (503). Các lựa chọn Low/Medium/High hiện cùng một dòng model; dừng retry để tránh chờ lặp. Checkpoint đã giữ lại; cần thử lại sau hoặc dùng provider khác."), { kind: "provider_unavailable", cause: err });
        }
        if (canChangeModel && modelFailure && nextIndex >= 0 && nextIndex < models.length && attempt < maxAttempts) {
          const from = models[modelIndex]; modelIndex = nextIndex;
          onProgress?.({ level: "WARNING", modelAttempt: modelIndex + 1, modelAttemptCount: models.length,
            fallbackFrom: from, fallbackTo: models[modelIndex],
            message: `Model ${from || "mặc định CLI"} lỗi (${err.message.slice(0, 180)}). Chuyển sang ${models[modelIndex]} · lượt ${modelIndex + 1}/${models.length}.` });
          continue;
        }
        if (canChangeModel) {
          if (err.kind === "capacity" || /No capacity available|\b503\b|\bRESOURCE_EXHAUSTED\b/i.test(err.message)) {
            throw Object.assign(new Error(`${this.providerService.label || "AI provider"} hiện hết công suất ở các model khả dụng đã thử (503). Các chunk hoàn tất được giữ lại. Thử lại sau hoặc chọn provider khác. Chi tiết: ${err.message.slice(0, 200)}`), { kind: "capacity", cause: err });
          }
          throw err;
        }
        if (signal?.aborted || err.name === "AbortError" || err instanceof TypeError || /timeout|cancelled|output_limit/.test(err.kind || "") || /budget|timeout|quota|permission|403|401|missing|chưa hỗ trợ|output token limit|MAX_TOKENS|response was cut off/i.test(err.message)) {
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
    sceneIndex,
    signal,
    cancelToken,
    onProgress
  }) {
    const activeChunkPath = chunkPath || chunkVideoPath;
    const info = chunkInfo || chunkMetadata || {};
    const activeSignal = signal || cancelToken?.abortController?.signal;
    if (sceneIndex) return this.analyzeSceneIndex({ sceneIndex, info, signal: activeSignal, onProgress });
    const chunkStart = Number(info.sourceStartSec || 0);
    const chunkEnd = Number(info.sourceEndSec || 0);
    const chunkDuration = Number(info.durationSec || (chunkEnd > chunkStart ? chunkEnd - chunkStart : 0));
    const chunkIndex = info.chunkIndex ?? 1;
    const maxEvents = Math.max(4, Math.min(30, Math.ceil(chunkDuration / 8)));

    const prompt = [
      "You are an expert film analyst and video editor.",
      `Analyze the attached video chunk representing source timeline [${chunkStart.toFixed(2)}s to ${chunkEnd.toFixed(2)}s] (duration: ${chunkDuration.toFixed(2)}s).`,
      "All source_start/source_end numbers MUST be seconds, never minute.second notation. A burned timecode 00:03:46.000 means 226 seconds, NOT 3.46; 00:01:19.000 means 79 seconds, NOT 1.19. Convert the full timecode before writing JSON. Use source timestamps or explicitly mark relative timestamps.",
      `Index at most ${maxEvents} essential visual events for a film recap. Cover the beginning, middle and end, prioritizing causal actions, revelations, conflict and payoff.`,
      "Group adjacent actions in the same scene. Do not enumerate every shot, reaction or repeated dialogue separately.",
      "Aim for roughly 9000 characters of compact JSON; no indentation, prose, repeated schema or analysis text. A complete accurate response takes priority over this size target.",
      "Summary: at most 50 words. Characters: at most 8, each description at most 12 words. Event descriptions: at most 20 words each.",
      "Keep at most 3 subjects, 2 actions and 2 objects per event. Omit empty optional arrays and false flags; always include true dialogue/closeup/lip-sync flags when visible.",
      "",
      "CRITICAL RULES:",
      "1. A VisualEvent is something distinct and visible (e.g. John opens the locked door, Sarah gasps, car crashes, character examines evidence).",
      `2. Timestamps 'source_start' and 'source_end' MUST be ABSOLUTE seconds on the original source timeline within [${chunkStart}, ${chunkEnd}]. Read the burned source timecode; do not reset timestamps to zero. Set timestamp_basis to 'absolute'.`,
      "3. For each event, evaluate: importance (0.0 - 1.0), motion_level (0.0 - 1.0), dialogue_present (boolean), face_closeup (boolean), lip_sync_risk (boolean: true if speaking mouth is clearly visible).",
      "4. Identify characters, actions, and objects accurately based only on visible evidence.",
      "5. Set focus_x and focus_y to the normalized 0..1 position of the main subject/object for portrait framing. Use 0.5 when uncertain.",
      "",
      "Return JSON with summary, timestamp_basis, characters and events matching the supplied schema. Always include event importance and framing coordinates."
    ].join("\n");

    const schema = {
      type: "object",
      required: ["summary", "events"],
      properties: {
        timestamp_basis: { type: "string", enum: ["absolute", "relative"] },
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
              focus_x: { type: "number" }, focus_y: { type: "number" },
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

    const normalizeEvents = (result) => {
      const sourceEvents = safeArray(result.events), events = [], excludedEvents = [];
      const offset = result.timestamp_basis === "relative" ? chunkStart : 0;
      for (const [idx, ev] of sourceEvents.entries()) {
        const start = Number(ev.source_start) + offset, end = Number(ev.source_end) + offset;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { excludedEvents.push({ ...ev, exclusionReason: "invalid_interval" }); continue; }
        if (end <= chunkStart || start >= chunkEnd) { excludedEvents.push(ev); continue; }
        events.push(validateVisualEvent({ ...ev, id: `chunk_${chunkIndex}_${ev.id || `ev_${idx + 1}`}`,
          source_start: Math.max(chunkStart, start), source_end: Math.min(chunkEnd, end) }, idx));
      }
      // Chunk overlap can produce an occasional neighbouring event. Exclude only
      // wholly disjoint ranges before any narration references are generated.
      // A mostly invalid timeline still triggers recovery, never silent truncation.
      if (excludedEvents.length && (!events.length || excludedEvents.length / sourceEvents.length > 0.15)) {
        throw Object.assign(new Error(`VisualEvents have invalid source range: ${excludedEvents.length}/${sourceEvents.length} nằm ngoài chunk [${chunkStart}, ${chunkEnd}].`), { kind: "invalid_json" });
      }
      validateChunkTimeline(events, { sourceStartSec: chunkStart, sourceEndSec: chunkEnd, durationSec: chunkDuration });
      return { events, excludedEvents };
    };

    const raw = await this.runVertexCall({
      filePaths: [activeChunkPath],
      prompt,
      responseSchema: schema,
      modelOverride: this.getAnalysisModel(),
      validateResult: normalizeEvents,
      requestTimeoutMs: { flash: 180000, pro: 360000 },
      signal: activeSignal,
      onProgress
    });

    // Size is guidance for generation, not a reason to discard valid source data.
    const { events, excludedEvents } = normalizeEvents(raw);
    if (excludedEvents.length) onProgress?.({ message: `Loại ${excludedEvents.length} mốc không hợp lệ hoặc nằm ngoài chunk; giữ ${events.length} sự kiện hợp lệ trong phạm vi video.` });
    if (events.length > maxEvents || JSON.stringify(raw).length > 9000) onProgress?.({
      message: `Giữ kết quả JSON đầy đủ: ${events.length} sự kiện. Kích thước vượt mục tiêu gọn nhưng dữ liệu hợp lệ; không gọi lại AI.` });

    return {
      chunkIndex,
      summary: safeText(raw.summary || ""),
      characters: safeArray(raw.characters),
      events,
      excludedEvents
    };
  }

  async analyzeSceneIndex({ sceneIndex, info, signal, onProgress }) {
    const Index = require("./recapSceneIndexService");
    const schema = { type: "object", required: ["summary", "events"], properties: {
      summary: { type: "string" }, events: { type: "array", items: { type: "object", required: ["scene_ids", "description", "content_kind"], properties: {
        scene_ids: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", enum: sceneIndex.entries.map(entry => entry.scene_id) } },
        anchor_scene_id: { type: "string", enum: sceneIndex.entries.map(entry => entry.scene_id) }, description: { type: "string" },
        content_kind: { type: "string", enum: ["story", "outro"] },
        subjects: { type: "array", items: { type: "string" } }, importance: { type: "number" },
        dialogue_present: { type: "boolean" }, face_closeup: { type: "boolean" }, lip_sync_risk: { type: "boolean" }
      } } }
    } };
    const raw = await this.runVertexCall({ filePaths: sceneIndex.filePaths, responseSchema: schema, modelOverride: this.getAnalysisModel(), signal, onProgress,
      prompt: ["Index the essential causal events of this film excerpt using its actual scene images and original audio.",
        "Each image is labeled with a scene_id and exact source time controlled by the application. Choose scene_ids from the supplied index. NEVER invent timestamps or scene IDs.",
        "Use one scene_id per event whenever possible. Combine only consecutive scenes that depict the SAME action, not separate plot points. Give 15–35 concise important events, fewer for short excerpts. Cover beginning, middle and end.",
        "For a combined event, set anchor_scene_id to the selected scene whose image directly depicts the main action. The edit starts near that image so the named action is already visible.",
        "Every description must match the chosen scene images and source dialogue. Do not invent motivations or unseen actions. Ignore channel intros/outros, credits, promotional stills and repeated graphics as plot events.",
        "Descriptions at most 20 words. Summary at most 50 words. Flag visible talking closeups. Return compact JSON without prose.",
        "Every event's selected scene range must be at most 24 seconds. Split longer actions. Never combine a movie ending with later channel outro images, even when consecutive. Include the actual final movie action before the outro.",
        "Classify every event content_kind as story or outro. Channel promos, repeated dancing family graphics, end cards and subscription screens are outro and must never support narration. Do not combine them with story footage.",
        `Source excerpt: ${info.sourceStartSec}..${info.sourceEndSec} seconds. Audio begins at ${info.sourceStartSec}s.`,
        `Scene index: ${JSON.stringify(sceneIndex.entries)}`].join("\n"),
      validateResult: value => Index.compile(value, sceneIndex, info) });
    return Index.compile(raw, sceneIndex, info);
  }

  /**
   * 2. Synthesize a Global Story Model (Story Bible) from chunk summaries or visual events.
   */
  async buildStoryModel({ chunkSummaries, events, metadata, videoMetadata, signal, cancelToken, onProgress }) {
    const activeSignal = signal || cancelToken?.abortController?.signal;
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
  async planRecap({ storyModel, visualEvents, events, targetDurationSec = 90, allowShotReuse = false, editorialOptions = {}, angle = null, hook = null, signal, cancelToken, onProgress }) {
    const activeSignal = signal || cancelToken?.abortController?.signal;
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
      `Editorial preferences: ${JSON.stringify(editorialOptions)}`,
      `Selected angle: ${JSON.stringify(angle)}`,
      `Selected hook: ${JSON.stringify(hook)}`,
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
      `Select at least ${Math.ceil(targetDurationSec * 1.15)} seconds of DISTINCT source footage for the body beats, so measured speech can fit without freezes. Prefer adding supporting causal actions to padding a short event with repeated commentary.`,
      "3. Prioritize narrative clarity: setup -> escalating obstacle/conflict -> revelation/turning point -> climax -> payoff.",
      "4. Ensure chronological continuity unless a deliberate flash-forward hook is used.",
      "5. Use one central conflict, remove repeated information, and include the source-grounded payoff promised by the hook. Do not recap every scene.",
      "6. Reserve the opening_hook beat for the selected hook verbatim, and allocate the remaining time to setup, escalation, discovery and payoff.",
      "7. review preset: build an evidence-backed opinion; explain preset: answer one question; recap preset: tell one causal story.",
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
        hook_event_ids: { type: "array", items: { type: "string", enum: eventList.map(event => event.id) } },
        selected_event_ids: { type: "array", items: { type: "string", enum: eventList.map(event => event.id) } },
        beats: {
          type: "array",
          items: {
            type: "object",
            required: ["beat_id", "role", "visual_event_ids"],
            properties: {
              beat_id: { type: "string" },
              role: { type: "string" },
              purpose: { type: "string" },
              visual_event_ids: { type: "array", items: { type: "string", enum: eventList.map(event => event.id) } },
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
      signal: activeSignal,
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
    scriptStyle = "natural",
    editorialOptions = {},
    angle = null,
    hook = null,
    densityMultiplier = 1.0,
    signal,
    cancelToken,
    onProgress
  }) {
    const activeSignal = signal || cancelToken?.abortController?.signal;
    const resolvedEventsMap = visualEventsMap || (Array.isArray(events) ? Object.fromEntries(events.map((e) => [e.id, e])) : {});
    const baseWps = Number(wordsPerSecond || voiceProfile?.wordsPerSecond || 2.6);
    const density = Math.max(0.8, Math.min(1.4, Number(densityMultiplier || 1.0)));
    // This estimates word count, not playback speed. Preserve the cadence
    // actually measured by VoiceProfileService (whose supported maximum is 5.2).
    const wps = Math.max(0.8, Math.min(5.2, baseWps * density));

    // Calculate duration budget per beat
    const measuredBudgets = Editorial.beatBudgets(recapPlan, Object.values(resolvedEventsMap), wps, hook?.durationSec || 4);
    const beatsWithBudgets = measuredBudgets.map((beat) => {
      const beatEvents = (beat.visual_event_ids || []).map((id) => resolvedEventsMap[id]).filter(Boolean);
      const totalVisualSec = beatEvents.reduce((sum, e) => sum + (e.duration || ((e.source_end || 0) - (e.source_start || 0)) || 0), 0);
      const targetWordCount = beat.target_word_count;
      const maxWordCount = beat.max_word_count;
      // Character guidance must agree with the output's spoken budget. Using
      // source footage length here can halve the requested narration duration.
      const maxChars = Math.max(20, Math.ceil(maxWordCount * 8));
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
      "You are an experienced TikTok film recap and review writer.",
      `Write ONE CONTINUOUS MASTER STORY in ${editorialOptions.language === "vi" ? "spoken Vietnamese" : "spoken US English"}.`,
      `Preset: ${editorialOptions.preset || "recap"}. Style: ${scriptStyle}.`,
      "Natural style: short spoken sentences, concrete verbs, little ornament. Avoid stock phrases such as 'blissfully distracted comfort' or 'beneath the calm surface'.",
      "Suspense style builds supported uncertainty; humorous style uses source-based irony; cinematic style stays vivid but concise.",
      "Review includes a distinct evidence-backed viewpoint; explain answers the selected question; recap focuses on causal events.",
      `Angle: ${JSON.stringify(angle)}. Hook must be verbatim: ${JSON.stringify(hook?.text || "")}.`,
      `Retention: ${editorialOptions.retention || "balanced"}; spoiler policy: ${editorialOptions.spoiler || "balanced"}; loop ending: ${Boolean(editorialOptions.loop)}. A loop may connect to the opening question, but must still deliver the promised payoff.`,
      "",
      storySpineText,
      "CRITICAL NARRATIVE & SYNCHRONIZATION RULES:",
      "1. CONTINUOUS THROUGH-LINE (NO FRAGMENTATION):",
      "   - The entire script MUST read like one coherent spoken story, in the selected style, from start to finish.",
      "   - NEVER write disconnected sentence fragments that merely describe isolated clips. Every sentence must flow causally into the next.",
      "   - Connect events through clear causes and consequences. Prefer simple transitions that sound natural aloud.",
      "",
      "2. INTERPRETIVE DEPTH & ATMOSPHERE (BEYOND LITERAL DESCRIPTION):",
      "   - The viewer already sees the action on screen. Do not insult the audience by merely stating obvious visual facts.",
      "   - Explain causes, stakes and consequences supported by the supplied events. Never invent character motivations or background facts.",
      "   - Follow the selected style. Natural means short conversational sentences without ornate language or stock cinematic phrases.",
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
      `Output target: ${recapPlan.target_duration_sec}s. Aim for ${measuredBudgets.reduce((sum, beat) => sum + beat.target_word_count, 0)} spoken words TOTAL, distributed across the beat budgets. Source event durations describe footage, not a shorter narration target.`,
      "Beats and Grounded Visual Events:",
      JSON.stringify(beatsWithBudgets, null, 2),
      "",
      "Return JSON conforming to this schema:",
      "{",
      '  "speech_units": [',
      '    {',
      '      "id": "speech_0001",',
      '      "beat_id": "beat_1",',
      '      "text": "He spots the problem. Now he has to act before it gets worse.",',
      '      "visual_event_ids": ["event_0001", "event_0002"],',
      '      "clauses": [',
      '        {"clause_id": "speech_0001_c1", "text": "He spots the problem.", "visual_event_ids": ["event_0001"]},',
      '        {"clause_id": "speech_0001_c2", "text": "Now he has to act before it gets worse.", "visual_event_ids": ["event_0002"]}',
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
              visual_event_ids: { type: "array", items: { type: "string", enum: Object.keys(resolvedEventsMap) } },
              clauses: {
                type: "array",
                items: {
                  type: "object",
                  required: ["clause_id", "text", "visual_event_ids"],
                  properties: {
                    clause_id: { type: "string" },
                    text: { type: "string" },
                    visual_event_ids: { type: "array", items: { type: "string", enum: Object.keys(resolvedEventsMap) } }
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
    const activeSignal = signal || cancelToken?.abortController?.signal;
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
  async reviewDraft(request) {
    const fs = require("fs/promises");
    try { await fs.access(request.draftVideoPath); }
    catch (_) { return this.reviewDraftSingle(request); }
    const Review = require("./recapDraftReviewService");
    this.draftReviewer ||= new Review(this.settings, this.reviewDependencies);
    return this.draftReviewer.review(request, item => this.reviewDraftSingle(item));
  }

  async reviewDraftSingle({ draftVideoPath, timeline, decisions, storyModel, signal, cancelToken, onProgress, reviewWindow }) {
    const activeSignal = signal || cancelToken?.abortController?.signal;
    const decisionList = Array.isArray(decisions) ? decisions : safeArray(timeline?.decisions);

    const prompt = [
      "You are a strict Executive Video Producer and Editor reviewing a newly rendered draft of an AI Video Recap.",
      "Watch the attached draft video and evaluate its storytelling and audio-visual synchronization.",
      ...(reviewWindow ? [
        `This excerpt covers absolute output time ${reviewWindow.start}..${reviewWindow.end} seconds of the ${reviewWindow.duration}s complete draft, part ${reviewWindow.index + 1}/${reviewWindow.count}.`,
        "Review only defects actually visible or audible in this excerpt. The complete timeline below supplies context; do not flag missing sections that belong to another excerpt. Judge the hook only in the first excerpt and final payoff only in the last excerpt.",
        "Return timestamp_mode='relative' and issue times in seconds from the beginning of this attached excerpt. Never use minute.second notation. The application will add the excerpt's absolute start time.",
        "Ignore any burned-in timecode from the original source; it is not the draft/excerpt playback clock.",
        "Artificial excerpt boundaries are not draft cuts. Do not flag the start/end of an interior excerpt as chopped narration; adjoining excerpts overlap. The first and final endpoints of the whole draft must still be evaluated."
      ] : []),
      "",
      "EVALUATION CRITERIA:",
      "1. SEMANTIC ALIGNMENT: Does the image support what the narrator is saying at that exact moment?",
      "2. EVENT TIMING / VISUAL LEAD: Does an important visual reveal appear slightly before or approximately when named?",
      "3. STORY CONTINUITY: Can a viewer understand the cause-and-effect progression?",
      "4. PACING: Any boring, rushed, or lingering sections?",
      "5. FOOTAGE REPETITION: Are there redundant or repetitive clips?",
      "6. AWKWARD RETIMING: Does any footage look unnaturally fast or slow?",
      "7. HOOK QUALITY: Does the first 5 seconds grab attention without deceptive clickbait?",
      "8. CAPTIONS AND FRAMING: Are captions legible, synchronized and within safe margins? Does the crop preserve the important subject?",
      "9. PAYOFF: Does the ending resolve the opening promise, with no invented facts? Review/explain may use clearly signaled interpretation.",
      "Score overall_score strictly from 0 to 1. Severity must be critical, high, medium or low. List only actionable observed defects.",
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
        overall_score: { type: "number", minimum: 0, maximum: 1 },
        summary: { type: "string" },
        issues: {
          type: "array",
          items: {
            type: "object",
            required: ["severity", "type", "output_start", "output_end", "description", "recommended_action"],
            properties: {
              issue_id: { type: "string" },
              severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
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

    if (reviewWindow) {
      schema.required.push("timestamp_mode");
      schema.properties.timestamp_mode = { type: "string", enum: ["relative", "absolute"] };
    }

    const raw = await this.runVertexCall({
      filePaths: [draftVideoPath],
      prompt,
      responseSchema: schema,
      modelOverride: this.getQualityModel(),
      signal: activeSignal,
      onProgress
    });

    if (typeof raw.overall_score !== "number" || !Number.isFinite(raw.overall_score) || raw.overall_score < 0 || raw.overall_score > 1
      || !Array.isArray(raw.issues) || raw.issues.some((issue) => !["critical", "high", "medium", "low"].includes(issue.severity))) {
      throw new Error(`AI trả về review không hợp lệ (score=${JSON.stringify(raw.overall_score)}, severity=${JSON.stringify(raw.issues?.map?.((issue) => issue.severity))}); chưa thể xác minh chất lượng draft.`);
    }
    const issues = safeArray(raw.issues).map((issue, idx) => validateQualityIssue(issue, idx));
    if (reviewWindow) {
      if (!["relative", "absolute"].includes(raw.timestamp_mode)) throw new Error("Review đoạn thiếu chế độ thời gian; chưa thể xác minh vị trí lỗi.");
      for (const issue of issues) {
        if (raw.timestamp_mode === "relative") { issue.output_start += reviewWindow.start; issue.output_end += reviewWindow.start; }
        if (issue.output_start < reviewWindow.start - .25 || issue.output_end > reviewWindow.end + .25 || issue.output_end < issue.output_start)
          throw new Error("Review đoạn trả vị trí lỗi ngoài đoạn đã xem.");
      }
    }
    return {
      overall_score: raw.overall_score,
      summary: safeText(raw.summary, "Draft review completed."),
      issues
    };
  }
}

module.exports = RecapAiService;
