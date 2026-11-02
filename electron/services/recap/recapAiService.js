const RecapProviderService = require("./recapProviderService");
const Editorial = require("./recapEditorialService");
const supportedContext = event => event.anchorAudit?.claimSupported === false ? undefined : event.narrativeContext;
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
    this.modelCooldowns = new Map();
    this.now = dependencies.now || Date.now;
    this.reviewDependencies = dependencies;
  }

  getAnalysisModel() {
    return this.providerService.getModel(false);
  }

  getQualityModel() {
    return this.providerService.getModel(true);
  }

  async generateLongFormNarration(request) {
    const Writer = require("./recapLongFormNarrationService");
    return new Writer().generate({ ...request, ai: this });
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
    const raw = await this.runVertexCall({ prompt, responseSchema: schema, modelOverride: this.getAnalysisModel(), signal: cancelToken?.signal, onProgress });
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
    const raw = await this.runVertexCall({ prompt, responseSchema: schema, modelOverride: this.getAnalysisModel(), signal: cancelToken?.signal, onProgress });
    return Editorial.validateHooks(raw, events);
  }

  async rewriteRecap({ storyModel, events, recapPlan, speechUnits, options, feedback, repairCache, onRepair, cancelToken, onProgress }) {
    if (feedback?.patchOnly) return this.repairQualityUnits({ storyModel, events, recapPlan, speechUnits, options, feedback, cancelToken, onProgress });
    const hasMaterialDurationMismatch = !feedback?.qualityFirst && Number.isFinite(feedback?.duration?.actual) && feedback.duration.passed === false && !feedback.forceClauseRepair;
    if (feedback?.clauseBudgets?.length && !hasMaterialDurationMismatch && !feedback.forceStructuralRepair && !feedback.forceScopeRepair) {
      return this.repairMeasuredClauses({ events, recapPlan, speechUnits, options, feedback, repairCache, onRepair, cancelToken, onProgress });
    }
    const currentWords = speechUnits.reduce((sum, unit) => sum + String(unit.text || "").trim().split(/\s+/).filter(Boolean).length, 0);
    const actualDuration = Number(feedback?.duration?.actual ?? feedback?.durationPreference?.actual);
    const desiredWords = actualDuration > 0 ? Math.round(currentWords * options.targetDurationSec / actualDuration * .97) : currentWords;
    const excessiveShortfall = feedback?.qualityFirst && feedback?.durationPreference?.largeDeviation
      && actualDuration < options.targetDurationSec;
    const prompt = ["Repair the supplied recap plan and spoken narration using only the source events.",
      "Return a complete revised plan and all speech units, not patches. Preserve the selected angle and hook verbatim in opening_hook.",
      "Use IDs from the provided events. Every speech unit and clause needs visual_event_ids. Each unit's beat_id must exist in plan.beats.",
      "Events marked anchorAudit are verified against actual source frames and dialogue. Their current descriptions override earlier story/plan summaries. Remove any existing claim no longer supported by the verified description, even if it appears in the old story model.",
      feedback?.preflight ? "Timing below is an estimate before TTS. Repair meaningful narrative scope and source support; actual speech and audiovisual review will still be measured afterward."
        : "Fit the measured TTS duration feedback by shortening/expanding sentences and selecting fewer/more relevant events; never speed up the voice unnaturally.",
      ...(feedback?.forceScopeRepair ? ["GLOBAL SCOPE REPAIR: Local clause shortening alone cannot fix this material narrative shortfall. Rebuild the complete narration and supporting beat/event allocation using the review's specific missing developments and recommended additions. Develop the source-supported choices, reversals, context and consequences instead of adding empty sentences to unchanged clips. Preserve the approved hook, causal order and source-backed payoff. A duration/word estimate is guidance, not permission to pad or invent facts."] : []),
      ...(feedback?.forceStructuralRepair ? ["STRUCTURAL GROUNDING REPAIR: Some references are exhausted or their measured footage cannot support a complete sentence. Reassign the affected clauses to genuinely supporting unused source events, merge redundant clauses, or remove unsupported secondary claims. Never select a nearby action merely for spare duration. Preserve the already supported script; do not return fragments or lists of names."] : []),
      hasMaterialDurationMismatch
        ? `Measured current script: ${currentWords} words produced ${actualDuration.toFixed(1)} seconds. Aim for approximately ${desiredWords} spoken words TOTAL to reach ${options.targetDurationSec} seconds. This measured target supersedes earlier word/character limits. Keep the opening hook unchanged; distribute the remaining words across grounded body beats.`
        : (feedback?.durationAssessment?.verdict === "too_short" || (feedback?.issues || []).some(i => i.type === "duration_deviation" || i.type === "editorial_duration")
            ? `DURATION EXPANSION: The draft duration (${actualDuration > 0 ? actualDuration.toFixed(1) : "?"}s) is significantly shorter than target ${options.targetDurationSec}s. The reviewer noted that key story developments were omitted. EXPAND the plan and narration by adding missing beats and visual events from source footage to reach approximately ${desiredWords} spoken words TOTAL. Ensure characters mentioned in narration strictly match characters shown on screen.`
        : (excessiveShortfall
            ? `The current ${actualDuration.toFixed(1)}s story is materially below the soft preference. Look for omitted meaningful source-backed causal developments and emotional context. A useful first scope is at least ${Math.ceil(options.targetDurationSec * .65 + 1)}s, not exactly ${options.targetDurationSec}s. Add only content supported by the supplied source events, with enough distinct visual evidence. Do not keep a fixed current word count when it omits useful content; do not use filler, repeats or held frames.`
            : (actualDuration > 0 && !feedback?.qualityFirst
                ? `Measured current script: ${currentWords} words produced ${actualDuration.toFixed(1)} seconds. Aim for approximately ${desiredWords} spoken words TOTAL to reach ${options.targetDurationSec} seconds. This measured target supersedes earlier word/character limits. Keep the opening hook unchanged; distribute the remaining words across grounded body beats.`
                : `Current script: ${currentWords} spoken words. Preserve approximately this total word count while correcting the supplied quality issues.`))),
      feedback?.qualityFirst
        ? "QUALITY FIRST: duration is a soft editorial preference. Improve hook, causal continuity, evidence-backed viewpoint, pacing and payoff. Change length only when adding omitted meaningful developments or removing repetition genuinely improves the recap. Never add filler, freeze/repeat footage or slow speech to hit the requested seconds. Explain large duration deviations through the supplied editorial feedback."
        : "For a quality-only repair, preserve the current total spoken word count within 90–105%; do not turn the whole recap into a shorter synopsis. Change only defective clauses and redistribute their word budget to other supported events.",
      "Measured clauseBudgets are hard visual constraints: shorten each listed group to its targetDuration/targetWordCount or select additional genuinely supporting unused source events. Do not reuse another action's clip or freeze footage to fill a long monologue. Preserve the causal story; add words only when supported context genuinely improves it.",
      "Keep the causal explanation and payoff. Drop redundant exposition. Review/explain presets must keep their evidence-backed interpretation.",
      `Preferences: ${JSON.stringify(options)}`, `Story: ${JSON.stringify(storyModel)}`, `Events: ${JSON.stringify(events)}`,
      `Current plan: ${JSON.stringify(recapPlan)}`, `Current narration: ${JSON.stringify(speechUnits)}`, `Repair feedback: ${JSON.stringify(feedback)}`].join("\n");
    const refs = { type: "array", minItems: 1, items: { type: "string", enum: events.map(event => event.id) } };
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

  async repairQualityUnits({ storyModel, events, recapPlan, speechUnits, options, feedback, cancelToken, onProgress }) {
    const scoped = Array.isArray(feedback.focusUnitIds) && feedback.focusUnitIds.length > 0;
    const body = speechUnits.filter(unit => unit.id !== "opening_hook" && (!scoped || feedback.focusUnitIds.includes(unit.id))), ids = body.map(unit => unit.id);
    if (!ids.length) throw new Error("Không có câu kể hợp lệ trong phạm vi cần sửa.");
    const currentWords = speechUnits.reduce((sum, unit) => sum + String(unit.text || "").trim().split(/\s+/).filter(Boolean).length, 0);
    const actualDuration = Number(feedback.durationPreference?.actual ?? feedback.duration?.actual);
    const durationContext = actualDuration > 0
      ? `${feedback.preflight ? "Estimated" : "Measured"} current scope: ${currentWords} spoken words ${feedback.preflight ? "are expected to produce" : "produced"} ${actualDuration.toFixed(1)}s; preferred duration ${options.targetDurationSec}s. If the complete-story review says too_short, use its specific missing source-backed developments to plan additions rather than further compressing the existing story. Word counts are estimates, not mandatory quotas.` : "";
    const beats = recapPlan.beats.filter(beat => beat.role !== "hook").map(beat => beat.beat_id);
    const clauses = { type: "array", minItems: 1, items: { type: "object", required: ["text", "visual_event_ids"], properties: {
      text: { type: "string" }, visual_event_ids: { type: "array", minItems: 1, items: { type: "string", enum: events.map(event => event.id) } }
    } } };
    const schema = { type: "object", required: ["edits", "additions"], properties: {
      edits: { type: "array", items: { type: "object", required: ["id", "clauses"], properties: { id: { type: "string", enum: ids }, clauses } } },
      removals: { type: "array", items: { type: "string", enum: ids } },
      additions: { type: "array", items: { type: "object", required: ["id", "after_id", "beat_id", "clauses"], properties: {
        id: { type: "string" }, after_id: { type: "string", enum: scoped ? ids : speechUnits.map(unit => unit.id) }, beat_id: { type: "string", enum: beats }, clauses
      } } }
    } };
    const raw = await this.runVertexCall({ responseSchema: schema, modelOverride: this.getQualityModel(), signal: cancelToken?.signal, onProgress,
      prompt: ["Repair only the defective speech units of this recap. Return edits and optional additions, NOT a complete plan or a repeat of unchanged units.",
        ...(scoped ? [`Only these speech-unit IDs may change: ${JSON.stringify(ids)}. All other units are read-only context and MUST remain verbatim. Resolve the listed blocking defects; do not shorten or rewrite unrelated sections.`] : []),
        "Use removals for redundant or unsupported secondary units whose source interval is already exhausted. An ID in removals takes precedence over an edit to that same ID; do not send both unnecessarily. Do not keep a duplicated reaction merely because the old script included it. Never remove the opening hook or the source-backed payoff; preserve meaningful causal developments and unaffected narration.",
        ...(feedback.preflight ? ["PRE-TTS EDITORIAL PASS: Apply the recommended source-backed additions and fix causal transitions now, before any audio or video is rendered. Each added unit needs unused supporting footage and a complete causal purpose. Expand omitted meaningful developments rather than cramming extra words into short existing clips. Estimated timing is guidance; actual TTS and video review will still follow."] : []),
        ...(feedback.forceStructuralRepair ? ["STRUCTURAL GROUNDING REPAIR: The measured clause budgets show exhausted source references or truncation that would remove a substantial part of the story. Reassign affected clauses to genuinely supporting unused source events or combine redundant clauses into complete sentences. Never return fragments or reduce a clause to a list of names. Preserve all unaffected units verbatim."] : []),
        "Preserve the opening hook and unaffected narration verbatim. Each edited clause must be a complete grammatical sentence. Ground its actor, target, action and causal claim in the supplied source descriptions. Verified frame-audit descriptions override the old story. If an alleged rescue/retreat/victory is not supported, remove that claim rather than moving unrelated footage under it.",
        "For additions, use a unique new ID, an after_id from the original units and a beat_id from the allowed beats below. An addition after a removed unit occupies that unit's original position. Multiple additions at the same anchor keep their returned order.",
        "Never choose an event merely because it is nearby or has spare footage. Keep spoken clauses concise enough for the provided source intervals. Avoid reusing footage already used elsewhere when shot reuse is disabled.",
        ...(feedback.scopeGuard ? [
          `SCOPE PRESERVATION GUARD: ${JSON.stringify(feedback.scopeGuard)}. The application will reject a rewrite that turns a supported long story into a brief synopsis, or still requires so much clause shortening that the scope collapses. Preserve unaffected narration verbatim. Reassign affected clauses to genuinely supporting unused events, merge duplicate references or add omitted meaningful source-backed developments using unused footage. Do not solve missing footage solely by deleting words across the whole story. If the supplied evidence cannot support meaningful scope, do not invent events, fill with unrelated clips, repeat footage, freeze frames or slow speech.`,
          `Unused supporting-event candidates (verify relevance, not mandatory quotas): ${JSON.stringify(feedback.unusedEventIds || [])}`
        ] : []),
        ...(feedback.measuredScopeMismatch ? ["ACTUAL VOICE CADENCE CHANGED THE SCOPE: The measured duration is materially outside the requested scope even though local clause timing may fit. Re-plan source-supported narrative depth and supporting event allocation at the measured cadence. For a shortfall, develop omitted meaningful choices, obstacles, consequences and dialogue using unused relevant evidence; for excessive length, remove repetition. Do not just keep the original word count, relax source support or manufacture filler."] : []),
        "Duration is soft. If the complete-story review identifies missing meaningful context, add concise source-backed causal developments using unused supporting events. Do not arbitrarily pad, slow speech, repeat information or add empty commentary to meet a word/second quota. Avoid shrinking the whole script as a side effect of fixing one clause.",
        durationContext,
        `Preferences: ${JSON.stringify(options)}. Feedback: ${JSON.stringify(feedback)}`,
        `Current units: ${JSON.stringify(speechUnits)}`,
        `Allowed body beat IDs: ${JSON.stringify(beats)}`,
        `Source events: ${JSON.stringify(events.map(event => ({ id: event.id, start: event.source_start, end: event.source_end,
          description: event.description, narrativeContext: supportedContext(event),
          verified: Boolean(event.anchorAudit), correctedLabel: event.anchorAudit?.claimSupported === false })))}`].join("\n") });
    if (!Array.isArray(raw.edits) || !Array.isArray(raw.additions)) throw new Error("Bản sửa chất lượng thiếu danh sách thay đổi hợp lệ.");
    const revised = structuredClone(speechUnits), revisedPlan = structuredClone(recapPlan), seen = new Set();
    if (raw.removals !== undefined && !Array.isArray(raw.removals)) throw new Error("Danh sách bỏ câu kể không hợp lệ.");
    const removals = new Set(raw.removals || []);
    for (const id of removals) {
      if (id === "opening_hook") throw new Error("Không được bỏ hook đã duyệt.");
      if (!ids.includes(id)) throw new Error(`Không thể bỏ câu kể không tồn tại: ${id}.`);
    }
    const compile = (patch, unit) => {
      if (!patch.clauses?.length || patch.clauses.some(clause => !String(clause.text || "").trim()
        || !clause.visual_event_ids?.length || clause.visual_event_ids.some(id => !events.some(event => event.id === id)))) throw new Error("Bản sửa lời kể thiếu câu đầy đủ hoặc tham chiếu nguồn hợp lệ.");
      const clauses = patch.clauses.map((clause, index) => ({ ...clause, clause_id: `${unit.id}_repair_${index + 1}` }));
      return { ...unit, clauses, text: clauses.map(clause => clause.text.trim()).join(" "), visual_event_ids: [...new Set(clauses.flatMap(clause => clause.visual_event_ids))] };
    };
    for (const patch of raw.edits) {
      const index = revised.findIndex(unit => unit.id === patch.id);
      if (index < 0 || !ids.includes(patch.id) || patch.id === "opening_hook" || seen.has(patch.id)) throw new Error("Bản sửa chất lượng đổi ID ngoài phạm vi, không tồn tại, lặp lại hoặc sửa hook đã duyệt.");
      seen.add(patch.id);
      // Removal is the final operation for an ID. Some model responses both
      // simplify a sentence and remove its now-redundant unit.
      if (!removals.has(patch.id)) revised[index] = compile(patch, revised[index]);
    }
    for (const id of removals) {
      const index = revised.findIndex(unit => unit.id === id);
      revised.splice(index, 1);
    }
    // Keep the original sequence as positional anchors even when a unit is removed.
    // Applying deletions before looking up anchors loses valid replacement positions.
    const additionsByAnchor = new Map(), usedIds = new Set(speechUnits.map(unit => unit.id)), additionKeys = new Set();
    let nextAddition = 1;
    for (const patch of raw.additions) {
      if (scoped && !ids.includes(patch.after_id)) throw new Error("Đoạn bổ sung nằm ngoài phạm vi cần sửa.");
      if (!speechUnits.some(unit => unit.id === patch.after_id))
        throw new Error(`Đoạn bổ sung ${patch.id} dùng vị trí không tồn tại: ${patch.after_id}.`);
      if (!beats.includes(patch.beat_id))
        throw new Error(`Đoạn bổ sung ${patch.id} dùng nhịp kể không hợp lệ: ${patch.beat_id}.`);
      const contentKey = Editorial.fingerprint({ anchor: patch.after_id, beat: patch.beat_id, clauses: patch.clauses });
      if (additionKeys.has(contentKey)) continue;
      additionKeys.add(contentKey);
      // IDs are application metadata, not narrative decisions. A model may
      // reuse new_unit_1 from an earlier repair; allocate a fresh ID locally.
      let id = typeof patch.id === "string" ? patch.id.trim() : "";
      if (!id || usedIds.has(id)) {
        do { id = `quality_addition_${nextAddition++}`; } while (usedIds.has(id));
      }
      const additions = additionsByAnchor.get(patch.after_id) || [];
      additions.push(compile(patch, { id, beat_id: patch.beat_id }));
      additionsByAnchor.set(patch.after_id, additions); usedIds.add(id);
    }
    const remainingById = new Map(revised.map(unit => [unit.id, unit]));
    revised.splice(0, revised.length, ...speechUnits.flatMap(unit => [
      ...(remainingById.has(unit.id) ? [remainingById.get(unit.id)] : []),
      ...(additionsByAnchor.get(unit.id) || [])
    ]));
    const remainingBody = revised.filter(unit => unit.id !== "opening_hook");
    if (!remainingBody.length || (options.hook?.payoff_event_id && !remainingBody.some(unit => unit.visual_event_ids.includes(options.hook.payoff_event_id))))
      throw new Error("Bản sửa đã bỏ phần nội dung chính hoặc bằng chứng giải đáp hook.");
    revisedPlan.beats = revisedPlan.beats.filter(beat => revised.some(unit => unit.beat_id === beat.beat_id));
    for (const beat of revisedPlan.beats) {
      const references = [...new Set(revised.filter(unit => unit.beat_id === beat.beat_id).flatMap(unit => unit.visual_event_ids))];
      if (references.length) beat.visual_event_ids = references;
    }
    revisedPlan.selected_event_ids = [...new Set(revised.flatMap(unit => unit.visual_event_ids))];
    return { plan: revisedPlan, speech_units: revised };
  }

  async repairMeasuredClauses({ events, recapPlan, speechUnits, options, feedback, repairCache = {}, onRepair, cancelToken, onProgress }) {
    cancelToken?.signal?.throwIfAborted();
    if (feedback.clauseBudgets.length > 12) {
      let revised = { plan: recapPlan, speech_units: speechUnits };
      for (let offset = 0; offset < feedback.clauseBudgets.length; offset += 12) {
        revised = await this.repairMeasuredClauses({ events, recapPlan: revised.plan, speechUnits: revised.speech_units, options, repairCache, onRepair, cancelToken, onProgress,
          feedback: { ...feedback, clauseBudgets: feedback.clauseBudgets.slice(offset, offset + 12) } });
      }
      return revised;
    }
    const groups = feedback.clauseBudgets.map((group, index) => ({ index, text: group.text,
      maxWords: group.targetWordCount, minWords: group.minimumWordCount ?? Math.max(1, group.targetWordCount - 2),
      ...(group.minimumWordCount !== undefined ? { minimumWordCount: group.minimumWordCount } : {}),
      ...(group.softMinimum ? { softMinimum: true } : {}),
      speechUnitId: group.speechUnitId, clauseIds: group.clauseIds, visual_event_ids: [...group.visual_event_ids] }));
    const accepted = new Map();
    const normalize = text => typeof text === "string"
      ? text.trim().replace(/\s+([,.;:!?…])/g, "$1").replace(/\s+/g, " ") : "";
    const countWords = text => text.split(/\s+/).filter(Boolean).length;
    // A redistribution target estimates useful detail, not a word quota. Its
    // total duration is admitted by the pipeline before any new TTS is started.
    const hardMinimum = group => group.softMinimum ? 1 : (group.minimumWordCount || 1);
    const evidenceFor = group => events.filter(event => group.visual_event_ids.includes(event.id)).map(event => ({
      id: event.id, source_start: event.source_start, source_end: event.source_end,
      description: event.description, narrativeContext: supportedContext(event), anchorAudit: event.anchorAudit
    }));
    const keys = new Map(groups.map(({ index, ...group }) => [index, Editorial.fingerprint({ version: 1,
      group, language: options.language || "en", evidence: evidenceFor(group) })]));
    for (const group of groups) {
      if (!(Number.isInteger(group.maxWords) && group.maxWords >= 1)) throw new Error("Ngân sách từ của mệnh đề không hợp lệ.");
      if (group.minimumWordCount !== undefined && !(Number.isInteger(group.minimumWordCount) && group.minimumWordCount >= 1 && group.minimumWordCount <= group.maxWords))
        throw new Error("Mục tiêu từ của mệnh đề không hợp lệ.");
      const text = normalize(repairCache[keys.get(group.index)]?.text);
      if (text && countWords(text) <= group.maxWords && countWords(text) >= hardMinimum(group)) accepted.set(group.index, { index: group.index, text });
    }
    if (accepted.size) onProgress?.({ message: `Dùng lại ${accepted.size}/${groups.length} câu đã sửa đúng ngân sách; chỉ xử lý phần còn lại.` });
    let previous = "";
    let violations = [];
    for (let attempt = 0; attempt < 3 && accepted.size < groups.length; attempt++) {
      cancelToken?.signal?.throwIfAborted();
      const pending = groups.filter(group => !accepted.has(group.index));
      const alternatives = attempt === 2;
      // Array-length validation used to reject one extra word before the
      // correction loop could report its measured count. Keep the hard spoken
      // word limit below, where only the failed groups need another response.
      const wordArray = description => ({ type: "array", description, items: { type: "string" } });
      const alternativeLimits = group => ({ full: Math.max(group.minimumWordCount || 1, Math.floor(group.maxWords * .9)),
        short: Math.max(group.minimumWordCount || 1, Math.floor(group.maxWords * .75)),
        brief: Math.max(group.minimumWordCount || 1, Math.floor(group.maxWords * .6)) });
      const repairProperties = Object.fromEntries(pending.map(group => [`group_${group.index}`, alternatives ? {
        type: "object", required: ["full", "short", "brief"], properties: {
          full: { type: "string", description: `One complete rendering, about ${alternativeLimits(group).full} words; at most ${group.maxWords}.` },
          short: { type: "string", description: `One complete rendering, about ${alternativeLimits(group).short} words.` },
          brief: { type: "string", description: `One complete rendering, about ${alternativeLimits(group).brief} words.` }
        }
      } : wordArray(`At most ${group.maxWords} spoken words; checked locally.`)]));
      const schema = { type: "object", required: ["repairs"], properties: { repairs: {
        type: "object", required: Object.keys(repairProperties), properties: repairProperties
      } } };
      const prompt = ["Rewrite only the supplied spoken clause groups to fit their measured visual footage and word budgets. Shorten overflowing groups; expand groups whose requested word budget is larger, using only supported detail.",
        `Language: ${options.language === "vi" ? "natural spoken Vietnamese" : "natural spoken US English"}.`,
        alternatives
          ? "Return three alternative repairs for each index. Each must preserve the supported core meaning as a complete sentence. maxWords is a hard upper limit; choose different wording and remove secondary detail to give useful shorter alternatives."
          : "Return exactly one repair for each index. Aim for minWords..maxWords whitespace-separated words. maxWords is a hard upper limit checked by code. Keep natural speech and the total recap budget; avoid compressing far below the requested range.",
        alternatives
          ? "Return repairs as an object keyed by the supplied group indexes. Each value contains full, short and brief STRING values. Each string is ONE complete alternative sentence, not a list of alternatives. Do not use arrays for these values."
          : "Return repairs as an object keyed by the supplied group indexes. Each value is an array of individual spoken words, including punctuation attached to its word. The total whitespace-separated spoken word count is checked by code. Do not put multiple words inside one item.",
        "Preserve the concrete action, causal link and meaning only when supported by the grounded evidence below. Remove unsupported claims from earlier scripts as well as redundancy and flourishes. Do not invent facts or change the source references. Do not add narration outside these groups.",
        "Every repaired group must be a complete grammatical sentence with a subject and predicate, even when short. Prefer 'Tsunade joins them.' to an unfinished list of names. Never return fragments such as 'The toad and'. Remove secondary detail instead of cutting a sentence in half.",
        "When a group has minimumWordCount, redistribute useful source-supported detail into its unused supporting footage. For softMinimum groups this is an approximate planning target, not a per-sentence lower quota. Develop meaningful supported detail toward it; prefer a naturally shorter complete sentence to filler when evidence cannot justify more. The application separately checks the overall scope and fitted duration before any new TTS. Otherwise an explicit minimum is a hard lower bound. Develop actual action/dialogue/causal context from the supplied evidence, not filler, repeated themes or invented motivations. maxWords remains a hard upper bound for every group.",
        ...(alternatives ? [
          "The previous two edits still exceeded the hard budget. Return THREE ALTERNATIVE complete renderings for each remaining group, as sentence strings named full, short and brief. Develop the SAME supported core action and causal meaning at progressively shorter lengths. The application will choose the most detailed alternative that actually fits. Do not continue the previous long response, cut words off a sentence, or change unaffected groups.",
          `Explicit alternative word limits: ${JSON.stringify(pending.map(group => ({ group: `group_${group.index}`,
            ...alternativeLimits(group) })))}`,
          "Count every word, including names and articles. For a very short budget, state just the supported core action as a simple subject-verb sentence; omit secondary explanations. The evidence is context, not text to repeat."
        ] : []),
        `Groups: ${JSON.stringify(pending)}`,
        `Grounded evidence: ${JSON.stringify(events.filter(event => pending.some(group => group.visual_event_ids.includes(event.id))).map(event => ({ id: event.id, description: event.description, narrativeContext: supportedContext(event) })))}`,
        previous].join("\n");
      if (alternatives) onProgress?.({ message: `Còn ${pending.length} câu vượt giới hạn sau 2 lượt; dùng ${this.getQualityModel()} để chọn phương án ngắn hơn, giữ các câu đã đạt.` });
      let result;
      try {
        result = await this.runVertexCall({ prompt, responseSchema: schema,
          modelOverride: alternatives ? this.getQualityModel() : this.getAnalysisModel(), signal: cancelToken?.signal, onProgress });
      } catch (error) {
        if (error.kind !== "invalid_json" && !/^AI JSON:/.test(error.message)) throw error;
        throw Object.assign(new Error(`Bản sửa mệnh đề chưa trả đủ cấu trúc hợp lệ. Các câu đã đạt được giữ lại để chạy tiếp. ${error.message}`),
          { kind: "timing_repair_failed", cause: error });
      }
      const fromWords = value => Array.isArray(value) && value.every(word => typeof word === "string") ? value.join(" ") : "";
      const returned = Array.isArray(result.repairs) ? result.repairs : Object.entries(result.repairs || {}).map(([key, value]) => ({
        index: /^group_\d+$/.test(key) ? Number(key.slice(6)) : NaN,
        candidates: alternatives ? ["full", "short", "brief"].map(name => typeof value?.[name] === "string" ? value[name] : "") : [fromWords(value)]
      }));
      const indexes = new Set(); violations = [];
      for (const repair of returned) {
        cancelToken?.signal?.throwIfAborted();
        const group = groups[repair.index];
        if (!Number.isInteger(repair.index) || !pending.some(item => item.index === repair.index) || indexes.has(repair.index)) {
          throw Object.assign(new Error("Bản sửa mệnh đề trả ID không được yêu cầu hoặc trùng ID. Các câu đã đạt được giữ lại để chạy tiếp."), { kind: "timing_repair_failed" });
        }
        indexes.add(repair.index);
        const candidates = (repair.candidates || [repair.text]).map(normalize).filter(Boolean);
        const text = candidates.filter(text => countWords(text) <= group.maxWords && countWords(text) >= hardMinimum(group)).sort((a, b) => countWords(b) - countWords(a))[0];
        if (!text) violations.push(`Invalid repair ${repair.index}: ${candidates.map(countWords).join("/") || 0} words; limit ${group.maxWords}${group.minimumWordCount ? `; minimum ${group.minimumWordCount}` : ""}.`);
        else {
          accepted.set(repair.index, { index: repair.index, text });
          const key = keys.get(repair.index); repairCache[key] = { text };
          await onRepair?.(key, { text });
        }
      }
      for (const group of pending) if (!indexes.has(group.index)) violations.push(`Missing group_${group.index}.`);
      if (accepted.size !== groups.length) {
        previous = `Your previous response exceeded or missed the hard limits: ${violations.join(" ")}\nPrevious response: ${JSON.stringify(result)}. Return corrected shorter repairs ONLY for the still-requested groups. Accepted groups are preserved verbatim.`;
        if (attempt === 0) onProgress?.({ message: "Bản sửa mệnh đề chưa đúng giới hạn từ; đang yêu cầu sửa lại một lần..." });
        continue;
      }
    }
    if (accepted.size !== groups.length) throw Object.assign(new Error(
      `Chưa có câu đầy đủ đúng ngân sách sau kiểm tra các phương án: ${violations.join(" ")} Các câu đã đạt được giữ lại để chạy tiếp.`
    ), { kind: "timing_repair_failed" });
    cancelToken?.signal?.throwIfAborted();
    const repairs = [...accepted.values()].sort((a, b) => a.index - b.index);
    const revised = structuredClone(speechUnits);
    const revisedPlan = recapPlan ? structuredClone(recapPlan) : recapPlan;
    for (const repair of repairs) {
      const group = groups[repair.index], ids = new Set(group.clauseIds);
      let owners = revised.filter(unit => (!group.speechUnitId || unit.id === group.speechUnitId)
        && group.clauseIds.every(id => unit.clauses?.some(clause => clause.clause_id === id)));
      if (!owners.length && group.speechUnitId) {
        owners = revised.filter(unit => unit.id === group.speechUnitId && unit.clauses?.length === 1);
      }
      const owner = owners.length === 1 ? owners[0] : null;
      if (!owner) throw Object.assign(new Error("Mệnh đề cần sửa không còn trong kịch bản; hãy phân tích lại thời điểm lời đọc."), { kind: "timing_repair_failed" });
      const first = Math.max(0, owner.clauses.findIndex(clause => ids.has(clause.clause_id)));
      if (owner.clauses.some(clause => ids.has(clause.clause_id))) {
        owner.clauses = owner.clauses.flatMap((clause, index) => !ids.has(clause.clause_id) ? [clause]
          : index === first ? [{ ...clause, text: repair.text.trim(), visual_event_ids: group.visual_event_ids }] : []);
      } else {
        owner.clauses = [{ ...owner.clauses[0], text: repair.text.trim(), visual_event_ids: group.visual_event_ids }];
      }
      owner.visual_event_ids = [...new Set([...(owner.visual_event_ids || []), ...group.visual_event_ids])];
      owner.text = owner.clauses.map(clause => clause.text).join(" ");
      if (revisedPlan?.beats) {
        const beat = revisedPlan.beats.find(b => b.beat_id === owner.beat_id);
        if (beat) beat.visual_event_ids = [...new Set([...(beat.visual_event_ids || []), ...group.visual_event_ids])];
        revisedPlan.selected_event_ids = [...new Set([...(revisedPlan.selected_event_ids || []), ...group.visual_event_ids])];
      }
    }
    return { plan: revisedPlan, speech_units: revised };
  }

  async runVertexCall({ filePaths = [], prompt, responseSchema = null, temperature = 0.2, taskType = "video_analysis", modelOverride = "", signal, onProgress, validateResult, requestTimeoutMs, videoFps = null }) {
    let lastError = null;
    const maxAttempts = 3;
    const preferred = this.preferredModels.get(modelOverride) || modelOverride;
    let models = this.providerService.prepareModels ? await this.providerService.prepareModels(preferred, { filePaths, signal, onProgress })
      : this.providerService.getFallbackModels?.(preferred) || [modelOverride];
    const configuredFallback = models.length > 1;
    if (this.providerService.provider === "vertex_ai") {
      const available = models.filter(model => (this.modelCooldowns.get(model) || 0) <= this.now());
      if (available.length && available[0] !== models[0]) onProgress?.({ level: "WARNING",
        message: `Tạm dùng ${available[0]}: ${models[0]} vừa báo hết công suất; tránh gọi lặp trong 2 phút.` });
      if (available.length) models = available;
    }
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
          ...(Number(videoFps) > 0 ? { videoFps: Number(videoFps) } : {}),
          responseSchema,
          strictRootJson: true,
          skipCapacityRetry: this.providerService.provider === "vertex_ai" && configuredFallback,
          modelOverride: models[modelIndex],
          requestTimeoutMs: requestedTimeout ? Math.min(Math.max(15000, Number(this.settings.antigravityTimeoutMs) || 900000), requestedTimeout)
            : (modelIndex > 0 ? Math.min(Number(this.settings.antigravityTimeoutMs) || 900000, /-pro(?:-|$)/i.test(models[modelIndex]) ? 360000 : 240000) : undefined),
          signal,
          onProgress
        });

        if (result && typeof result === "object") {
          validateResult?.(result);
          if (models[modelIndex] !== modelOverride && this.providerService.provider !== "vertex_ai") this.preferredModels.set(modelOverride, models[modelIndex]);
          return result;
        }
        throw new Error("AI returned an empty or non-object response.");
      } catch (err) {
        lastError = err;
        const terminal = signal?.aborted || err.name === "AbortError" || err instanceof TypeError
          || ["cancelled", "auth", "forbidden_tool", "spawn_error", "prompt_blocked", "budget"].includes(err.kind)
          || /đạt giới hạn|daily.*budget|budget.*exceed/i.test(err.message)
          || (!/^AI JSON:/.test(err.message) && /permission|unauthenticated|authentication|\b403\b|\b401\b|missing|chưa hỗ trợ|prohibited use|prompt.*blocked/i.test(err.message));
        if (terminal) throw err;
        if (this.providerService.provider === "vertex_ai" && (err.kind === "capacity" || /\b429\b|\b503\b|RESOURCE_EXHAUSTED|Resource exhausted/i.test(err.message)))
          this.modelCooldowns.set(models[modelIndex], this.now() + 120000);
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
        if (this.providerService.provider === "antigravity_cli" && (err.kind === "capacity" || /timeout/.test(err.kind || "")) && this.providerService.getModelFamily) {
          const family = this.providerService.getModelFamily(models[modelIndex]);
          nextIndex = models.findIndex((model, index) => index > modelIndex && this.providerService.getModelFamily(model) !== family);
          if (nextIndex < 0 && err.kind === "capacity") throw Object.assign(new Error("Antigravity đang hết công suất (503). Các lựa chọn Low/Medium/High hiện cùng một dòng model; dừng retry để tránh chờ lặp. Checkpoint đã giữ lại; cần thử lại sau hoặc dùng provider khác."), { kind: "provider_unavailable", cause: err });
        }
        const capacityFailure = err.kind === "capacity" || /\b429\b|\b503\b|RESOURCE_EXHAUSTED|Resource exhausted/i.test(err.message);
        if (this.providerService.provider === "vertex_ai" && !capacityFailure && canChangeModel && nextIndex >= models.length && attempt < maxAttempts) {
          nextIndex = 0;
          if (/MAX_TOKENS|output token limit/i.test(err.message) && !prompt.includes("COMPACT_JSON_RECOVERY")) {
            prompt = `${prompt}\nCOMPACT_JSON_RECOVERY: Keep speech_units and descriptions concise (group 2-3 sentences per SpeechUnit) so the JSON response completes well within the output token limit.`;
          }
        }
        if (canChangeModel && modelFailure && nextIndex >= 0 && nextIndex < models.length && attempt < maxAttempts) {
          const from = models[modelIndex]; modelIndex = nextIndex;
          onProgress?.({ level: "WARNING", modelAttempt: modelIndex + 1, modelAttemptCount: models.length,
            fallbackFrom: from, fallbackTo: models[modelIndex],
            message: `Model ${from || "mặc định CLI"} lỗi (${err.message.slice(0, 180)}). Chuyển sang ${models[modelIndex]} · lượt ${attempt + 1}/${maxAttempts}.` });
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
        scene_ids: { type: "array", minItems: 1, items: { type: "string", enum: sceneIndex.entries.map(entry => entry.scene_id) } },
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
      modelOverride: this.getAnalysisModel(),
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
      targetDurationSec >= 300
        ? `2. LONG-FORM RECAP PLANNING (${targetDurationSec}s): Plan approximately ${Math.min(24, Math.max(8, Math.round(targetDurationSec / 35)))} meaningful beats. Cover the causal developments actually present in THIS source: stakes, setbacks, choices, turning points and supported consequences. Select enough distinct, relevant source intervals to support roughly ${targetDurationSec}s at natural playback when useful evidence exists. Sum the actual supplied interval durations instead of assuming each event lasts 7–10 seconds; scene-indexed events can be much shorter. Duration is soft: do not add unrelated footage, a mandatory training arc, a genre-specific climax or an ending absent from this source merely to fill a quota.`
        : `2. Select a subset of VisualEvents whose sum of usable durations aligns with the target duration. Duration preference: ${targetDurationSec}s, normally around ${Math.round(targetDurationSec * .8)}–${Math.round(targetDurationSec * 1.2)}s. Choose enough relevant, distinct evidence for that scope. Duration is soft: prioritize a compelling, complete, accurate story. Do not pad with unrelated scenes, repetition or empty commentary. If this scope cannot be supported, select a coherent shorter story rather than inventing content.`,
      "3. Prioritize narrative clarity: setup -> escalating obstacle/conflict -> revelation/turning point -> climax -> payoff.",
      "4. Ensure chronological continuity unless a deliberate flash-forward hook is used.",
      "5. Use one central conflict, remove repeated information, and include the source-grounded payoff promised by the hook. Do not recap every scene.",
      "6. Reserve the opening_hook beat for the selected hook verbatim, and allocate the remaining time to setup, escalation, discovery and payoff.",
      "7. review preset: build an evidence-backed opinion; explain preset: answer one question; recap preset: tell one causal story.",
      "8. Reserve a distinct event interval for each concrete action. A parallel storyline needs an explicit, source-supported transition. Current source descriptions override any contradictory story summary; do not preserve a false character/target claim just because it appears in the summary.",
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
          type: "array", minItems: targetDurationSec >= 300 ? Math.min(eventList.length, 12, Math.max(4, Math.round(targetDurationSec / 40))) : Math.min(eventList.length, 4),
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
      modelOverride: this.getAnalysisModel(),
      signal: activeSignal,
      onProgress
    });

    return validateRecapPlan(raw);
  }

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
          source_start: e.source_start,
          source_end: e.source_end,
          verified: Boolean(e.anchorAudit),
          // Keep a writing margin for prosody and the first visual lead.
          suggestedMaxWords: Math.max(2, Math.floor(Math.max(.2, e.source_end - e.source_start - .4) * wps * .9)),
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
      "3. CLAUSE-LEVEL VISUAL GROUNDING & MULTI-UNIT BEAT STRUCTURING:",
      "   - Break narration into clear SpeechUnits, each divided into distinct clauses.",
      "   - MULTIPLE UNITS PER BEAT: For beats with a large word budget (targetWordCount > 60) or multiple visual events, generate multiple sequential SpeechUnits sharing the same beat_id (e.g. 2–5 SpeechUnits per beat). Do NOT condense an entire long beat into just one SpeechUnit.",
      "   - CRITICAL CHARACTER & ACTION GROUNDING: In each clause, ONLY describe characters and actions supported by that event's description and subjects/actions. Descriptions verified by a frame audit override the earlier story and stale entity labels. Never attribute speech or thoughts to a character not present in that clip (e.g. if Orochimaru is on screen, do not talk about Tsunade as if she is on screen).",
      "   - Every clause MUST explicitly anchor to the specific 'visual_event_id' where that action, subject, or atmosphere appears.",
      "   - Each event's suggestedMaxWords is a conservative speech budget. If a complete sentence needs more time, assign additional events that actually support THAT sentence, or simplify it. Do not attach nearby unrelated actions for spare duration. Avoid reusing the same source interval across units when shot reuse is disabled.",
      "   - Use source_start/source_end to preserve causal order. A deliberate switch to a parallel storyline needs a brief, source-backed transition. Do not imply that a defensive technique attacks somebody else, or that one battle causes an unrelated action.",
      "   - Visual Lead: The visual event must appear on screen 200-400ms before or as the narrator mentions it. Never name a visual reveal before the viewer can see it.",
      "",
      "4. PRECISE DURATION BUDGETING:",
      "   - targetWordCount and maxWordCount estimate the intended scope, not mandatory quotas. Prefer complete meaningful causal developments, a clear viewpoint and payoff. Never pad, repeat or over-explain only to fill the requested seconds.",
      `   - Target scope: aim for approximately ${measuredBudgets.reduce((sum, beat) => sum + beat.target_word_count, 0)} spoken words TOTAL across ${Math.max(recapPlan.beats.length, Math.round(measuredBudgets.reduce((sum, beat) => sum + beat.target_word_count, 0) / 45))} SpeechUnits (averaging 35–55 words per unit).`,
      "   - Spoken word cadence: Write natural, flowing sentences. Use punctuation (commas, em-dashes, periods) to create natural breath pauses.",
      "",
      `Speaking Rate: ~${wps.toFixed(2)} words per second.`,
      `Output target: ${recapPlan.target_duration_sec}s is a SOFT preference, normally within 80–120%. Estimated scope: ${measuredBudgets.reduce((sum, beat) => sum + beat.target_word_count, 0)} spoken words TOTAL. Do not turn a long-form request into a brief synopsis, but shorten when it improves engagement and preserves the core story. No mandatory minimum word count; do not stretch speech or invent facts to meet a quota. Use compact SpeechUnits of 2–3 related sentences for long recaps.`,
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
          type: "array", minItems: recapPlan.target_duration_sec >= 300 ? Math.min(Object.keys(resolvedEventsMap).length, 12) : 1,
          items: {
            type: "object",
            required: ["id", "beat_id", "text", "visual_event_ids", "clauses"],
            properties: {
              id: { type: "string" },
              beat_id: beatsWithBudgets.length ? { type: "string", enum: [...new Set(beatsWithBudgets.map((b) => b.beat_id).filter(Boolean))] } : { type: "string" },
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
    return this.draftReviewer.review(request, item => this.reviewDraftSingle(item), item => this.reviewEditorial(item));
  }

  async reviewNarration({ speechUnits, events, recapPlan, options, estimates, sourceFiles = [], cancelToken, onProgress }) {
    const refs = { type: "array", items: { type: "string", enum: events.map(event => event.id) } };
    const schema = { type: "object", required: ["overall_score", "summary", "issues", "duration_assessment", "recommended_additions"], properties: {
      overall_score: { type: "number", minimum: 0, maximum: 1 }, summary: { type: "string" },
      issues: { type: "array", items: { type: "object", required: ["severity", "type", "description", "recommended_action", "speech_unit_ids"], properties: {
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] }, type: { type: "string" }, description: { type: "string" },
        recommended_action: { type: "string" }, speech_unit_ids: { type: "array", items: { type: "string", enum: speechUnits.map(unit => unit.id) } }
      } } },
      duration_assessment: { type: "object", required: ["verdict", "reason", "missing_event_ids"], properties: {
        verdict: { type: "string", enum: ["appropriate", "too_short", "too_long"] }, reason: { type: "string" }, missing_event_ids: refs
      } },
      recommended_additions: { type: "array", items: { type: "object", required: ["after_id", "beat_id", "event_ids", "purpose"], properties: {
        after_id: { type: "string", enum: speechUnits.map(unit => unit.id) }, beat_id: { type: "string", enum: recapPlan.beats.map(beat => beat.beat_id) },
        event_ids: refs, purpose: { type: "string" }
      } } }
    } };
    return this.runVertexCall({ ...(sourceFiles.length ? { filePaths: sourceFiles } : {}),
      responseSchema: schema, modelOverride: this.getAnalysisModel(), signal: cancelToken?.signal, onProgress,
      prompt: [sourceFiles.length
        ? "Perform a PRE-TTS EDITORIAL CHECK of the complete recap script against the attached SOURCE chapters, including dialogue. This is not approval of a rendered recap. Chapters are attached in chronological order. Their local time starts at zero; narrativeContext.sourceStartSec supplies their absolute offset."
        : "Perform a PRE-TTS EDITORIAL CHECK of the complete recap script. This is text/source-caption inspection, not approval of actual video.",
        "Check a compelling honest opening, causal continuity, distinct stakes/escalation, and a supported payoff. Preserve a clear viewpoint for review/explain presets. Find repeated exposition, filler and unsupported claims. Do not use franchise canon or an obsolete story outline.",
        "Plan purposes and the existing script are proposed claims, not evidence. Current source descriptions and source-video dialogue/context notes supply evidence; a verified corrected label replaces an earlier contradictory claim. Context notes are automatic observations, not unquestionable truth. When source chapters are attached, verify the notes and spoken claims against the actual source. Do not reject audible dialogue solely because a sparse single-frame caption omitted it.",
        "For each clause, its referenced source description must support the actor, target and action. Do not infer an attack's victim from a shot of the attacker alone, a rescue from a defensive move, a finger from a fist, or a victory/retreat from a reaction shot. Flag uncertain identity rather than inventing names. Verified descriptions override the old label. High/critical factual defects must identify the affected speech units.",
        "Parallel battles need a concise spoken bridge explaining a source-supported shift of focus; do not silently invent a causal link between different fights. Separate inference/commentary from observable fact.",
        "The requested duration is soft. Use the supplied voice-cadence estimate to judge scope BEFORE costly TTS/render. If materially short, identify specific omitted meaningful source events and propose where to add causal/emotional context. Never recommend padding, arbitrary nearby events, repeating footage or slowing speech. An appropriate concise story may stay shorter with a concrete rationale.",
        "Respect per-clause footage budgets. Suggest additional genuinely supporting unused footage or simpler complete sentences for overflow, never fragments. The final rendered video will be reviewed independently; do not inflate this score to pass export.",
        `Preferences: ${JSON.stringify(options)}. Estimated timing: ${JSON.stringify(estimates)}`,
        `Plan: ${JSON.stringify(recapPlan)}. Complete script: ${JSON.stringify(speechUnits)}`,
        `Source evidence: ${JSON.stringify(events.map(event => ({ id: event.id, start: event.source_start, end: event.source_end,
          description: event.description, narrativeContext: supportedContext(event),
          verified: Boolean(event.anchorAudit), correctedLabel: event.anchorAudit?.claimSupported === false,
          subjects: event.subjects, actions: event.actions })))}`
      ].join("\n") });
  }

  async reviewEditorial({ decisions = [], sourceEvents = [], editorialContext, signal, cancelToken, onProgress }) {
    const schema = { type: "object", required: ["overall_score", "summary", "issues", "duration_assessment"], properties: {
      overall_score: { type: "number", minimum: 0, maximum: 1 }, summary: { type: "string" },
      duration_assessment: { type: "object", required: ["verdict", "reason"], properties: {
        verdict: { type: "string", enum: ["appropriate", "too_short", "too_long"] }, reason: { type: "string" }
      } },
      issues: { type: "array", items: { type: "object", required: ["severity", "type", "description", "recommended_action", "speech_unit_ids"], properties: {
        severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
        type: { type: "string", enum: ["story_scope", "narration_facts"] }, description: { type: "string" }, recommended_action: { type: "string" },
        speech_unit_ids: { type: "array", items: { type: "string", enum: decisions.map(item => item.speech_unit_id) } }
      } } }
    } };
    return this.runVertexCall({ responseSchema: schema, modelOverride: this.getQualityModel(), signal: signal || cancelToken?.signal, onProgress,
      prompt: ["Evaluate the COMPLETE recap narrative once, after all actual video excerpts have been reviewed separately.",
        "Assess hook, causal coherence, factual support, payoff and editorial length from the COMPLETE spoken script and supplied source evidence. Do not claim to watch video in this text-only task; audiovisual defects are handled by the actual video reviews.",
        "Never infer the whole video's omissions from one excerpt. Do not require franchise canon, off-screen training, backstory or an ending absent from the supplied source. Verified frame-audit descriptions override unverified captions. A source that ends mid-conflict must not acquire an invented victory/retreat.",
        "Judge meaning against ALL supplied evidence, including source-video dialogue/context notes. A sparse visual caption omitting a name or dialogue is not by itself contradictory evidence. Identify a concrete unsupported factual claim or causal contradiction, not a wording difference: 'unleashes clones' vs 'creates clones', or 'lands' vs 'crashes onto the floor', is natural paraphrase. Source-backed causal interpretation is allowed; do not demand literal caption recitation or list every detail omitted from a recap.",
        "For each local issue name its affected speech_unit_ids. Use an empty array only for a truly whole-story defect. Do not invent an issue just to populate the array. Base the score on the editorial impact of actual defects, hook, coherence and payoff; cosmetic synonym preferences are not factual defects.",
        "Duration is soft. A concise complete story is preferable to padding. Mark too_short only for a specific essential causal step missing from the complete script that is supported by the supplied source events; name that missing source event in your reason. Do not mark missing events already present elsewhere in the complete script.",
        "Before alleging an omission, search every supplied speech unit for that development, including paraphrases. In the reason cite the missing source event ID and the adjacent script unit IDs where the causal gap occurs. If the development is already narrated, it is not missing merely because the narration references another supporting event ID. Wording differences such as rods/spikes are not a duration defect. Do not bundle cosmetic details into a too_short verdict.",
        "Score independently; do not raise scores to pass the export gate. Return only editorial issues, without invented audiovisual timestamps.",
        `Preferences and actual duration: ${JSON.stringify(editorialContext)}`,
        `Complete script: ${JSON.stringify(decisions.map(item => ({ id: item.speech_unit_id, text: item.text })))}`,
        `Available source events: ${JSON.stringify(sourceEvents.map(event => ({ id: event.id, description: event.description,
          narrativeContext: supportedContext(event), verified: Boolean(event.anchorAudit) })))}`].join("\n") });
  }

  async reviewDraftSingle({ draftVideoPath, timeline, decisions, storyModel, sourceEvents = [], signal, cancelToken, onProgress, reviewWindow, editorialContext }) {
    const activeSignal = signal || cancelToken?.abortController?.signal;
    const decisionList = Array.isArray(decisions) ? decisions : safeArray(timeline?.decisions);
    const contextDecisions = reviewWindow && decisionList.length > 0
      ? decisionList.filter((d) => (d.clips || []).some((c) => c.output_end > reviewWindow.start && c.output_start < reviewWindow.end))
      : decisionList;
    const visibleClips = contextDecisions.flatMap(decision => decision.clips || [])
      .filter(clip => !reviewWindow || clip.output_end > reviewWindow.start && clip.output_start < reviewWindow.end);
    const observed = safeArray(sourceEvents).filter(event => {
      const audit = event.anchorAudit;
      return audit?.version === 7 && audit.method === "fixed_source_range" && audit.confidence >= .8
        && Number.isFinite(audit.sourceStart) && Number.isFinite(audit.sourceEnd)
        && visibleClips.some(clip => clip.event_id === event.id && Number.isFinite(clip.source_start) && Number.isFinite(clip.source_end)
          && clip.source_start >= audit.sourceStart - .001 && clip.source_end <= audit.sourceEnd + .001);
    });

    const excerptOnly = Boolean(reviewWindow && editorialContext?.qualityFirst);
    const prompt = [
      "You are a strict Executive Video Producer and Editor reviewing a newly rendered draft of an AI Video Recap.",
      "Watch the attached draft video and evaluate its storytelling and audio-visual synchronization.",
      ...(observed.length ? [
        "Independent observations of the exact original source clips are supplied below. Use their verified appearances/actions to resolve ambiguous small faces in the low-resolution draft; do not guess identities from franchise expectations. They do not certify narration timing or excuse a contradiction actually visible in the rendered video. Still report concrete unsupported claims and defects independently; do not inflate the score.",
        `Verified source-clip observations: ${JSON.stringify(observed.map(event => ({ id: event.id, description: event.description,
          source_range: [event.anchorAudit.sourceStart, event.anchorAudit.sourceEnd] })))}`
      ] : []),
      ...(excerptOnly ? [
        "EXCERPT-ONLY REVIEW: judge observable audiovisual alignment and pacing in this excerpt. Whole-story completeness and duration are evaluated in a separate pass using the complete script. Do not return duration_assessment, complain that this excerpt lacks the opening/ending or require events from other excerpts. Do not let assumed omissions outside this excerpt lower its score.",
        "Only identify a factual or character mismatch when the visible evidence supports it. Do not fill gaps using franchise canon or invent an action that should have happened."
      ] : []),
      ...(editorialContext?.qualityFirst && !excerptOnly ? [
        `QUALITY-FIRST EDITORIAL CONTEXT: ${JSON.stringify(editorialContext)}`,
        "Duration is a soft preference. Assess whether the recap is engaging, coherent, accurate, complete and well-paced. A shorter complete story can be better than a padded longer one. Do not reward meeting a word/second quota or inflate scores to allow export. An export requires at least 0.80 and no high/critical defects.",
        "Return duration_assessment with verdict appropriate, too_short or too_long and a specific reason: does the chosen scope omit essential context/payoff, or contain redundant sections? Never request arbitrary padding. For excerpts, use the complete outline below to assess scope, and report timed audiovisual defects only from the attached excerpt.",
        `Source story context: ${JSON.stringify(storyModel)}`,
        `Complete spoken outline: ${JSON.stringify(decisionList.map(decision => decision.text))}`
      ] : []),
      ...(reviewWindow ? [
        `This excerpt covers absolute output time ${reviewWindow.start}..${reviewWindow.end} seconds of the ${reviewWindow.duration}s complete draft, part ${reviewWindow.index + 1}/${reviewWindow.count}.`,
        "Review only defects actually visible or audible in this excerpt. The timeline below supplies context for this excerpt; do not flag sections outside this excerpt. Judge the hook only in the first excerpt and final payoff only in the last excerpt.",
        `Return timestamp_mode='relative' with issue times in 0..${Number((reviewWindow.end - reviewWindow.start).toFixed(2))}s (matching excerpt_range), OR timestamp_mode='absolute' with issue times in ${reviewWindow.start}..${reviewWindow.end}s (matching out_range). Never use minute.second notation.`,
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
      "Wrong character identity, invented causal claims, factual reversals and a missing promised payoff are high/critical defects even if the narration sounds fluent. Do not excuse them as pacing or downgrade them because other sections are strong.",
      "Score overall_score strictly from 0 to 1. Severity must be critical, high, medium or low. List only actionable observed defects.",
      "",
      "Edit Timeline Context:",
      JSON.stringify(contextDecisions.map((d) => ({
        speech_unit_id: d.speech_unit_id,
        text: d.text,
        audio_duration: d.audio_duration,
        clips: (d.clips || [])
          .filter((c) => !reviewWindow || (c.output_end > reviewWindow.start && c.output_start < reviewWindow.end))
          .map((c) => ({
            out_range: reviewWindow
              ? [
                  Number(Math.max(0, c.output_start - reviewWindow.start).toFixed(2)),
                  Number(Math.min(reviewWindow.end - reviewWindow.start, c.output_end - reviewWindow.start).toFixed(2))
                ]
              : [c.output_start, c.output_end],
            speed: c.video_speed,
            event: c.event_id
          }))
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

    if (editorialContext?.qualityFirst && !excerptOnly) {
      schema.required.push("duration_assessment");
      schema.properties.duration_assessment = { type: "object", required: ["verdict", "reason"], properties: {
        verdict: { type: "string", enum: ["appropriate", "too_short", "too_long"] }, reason: { type: "string" }
      } };
    }

    const raw = await this.runVertexCall({
      filePaths: [draftVideoPath],
      prompt,
      responseSchema: schema,
      modelOverride: reviewWindow && reviewWindow.count > 3 ? this.getAnalysisModel() : this.getQualityModel(),
      requestTimeoutMs: { flash: 120000, pro: 240000 },
      signal: activeSignal,
      onProgress
    });

    if (typeof raw.overall_score !== "number" || !Number.isFinite(raw.overall_score) || raw.overall_score < 0 || raw.overall_score > 1
      || !Array.isArray(raw.issues) || raw.issues.some((issue) => !["critical", "high", "medium", "low"].includes(issue.severity))) {
      throw new Error(`AI trả về review không hợp lệ (score=${JSON.stringify(raw.overall_score)}, severity=${JSON.stringify(raw.issues?.map?.((issue) => issue.severity))}); chưa thể xác minh chất lượng draft.`);
    }
    if (editorialContext?.qualityFirst && !excerptOnly && (!["appropriate", "too_short", "too_long"].includes(raw.duration_assessment?.verdict)
      || !String(raw.duration_assessment?.reason || "").trim())) throw new Error("Review không hợp lệ: thiếu nhận xét độ đầy đủ và lý do thời lượng.");
    let issues = safeArray(raw.issues).map((issue, idx) => validateQualityIssue(issue, idx));
    if (reviewWindow) {
      const hasTimelineContext = decisionList.length > 0;
      const mode = ["relative", "absolute"].includes(raw.timestamp_mode) ? raw.timestamp_mode : (hasTimelineContext ? "relative" : "");
      if (!mode) throw new Error("Review đoạn thiếu chế độ thời gian; chưa thể xác minh vị trí lỗi.");
      const winLen = Math.max(0.1, reviewWindow.end - reviewWindow.start);
      const normalizedIssues = [];
      for (const issue of issues) {
        if (hasTimelineContext && issue.output_end < issue.output_start) {
          const tmp = issue.output_start;
          issue.output_start = issue.output_end;
          issue.output_end = tmp;
        }
        if (mode === "relative") {
          const matchesAbsoluteClip = hasTimelineContext && reviewWindow.start > 0 && decisionList.some((d) =>
            (d.clips || []).some((c) => c.output_start >= reviewWindow.start - 1 && Math.abs(c.output_start - issue.output_start) < 0.25)
          );
          const looksAlreadyAbsolute = hasTimelineContext
            && reviewWindow.start > 0
            && (matchesAbsoluteClip || issue.output_start > winLen + 0.5)
            && issue.output_start >= reviewWindow.start - 2
            && issue.output_end <= reviewWindow.end + 5;
          if (!looksAlreadyAbsolute) {
            issue.output_start += reviewWindow.start;
            issue.output_end += reviewWindow.start;
          }
        } else if (hasTimelineContext && reviewWindow.start > 0 && issue.output_start >= 0 && issue.output_end <= winLen + 0.5 && issue.output_end < reviewWindow.start) {
          issue.output_start += reviewWindow.start;
          issue.output_end += reviewWindow.start;
        }
        if (!hasTimelineContext) {
          if (issue.output_start < reviewWindow.start - .25 || issue.output_end > reviewWindow.end + .25 || issue.output_end < issue.output_start)
            throw new Error("Review đoạn trả vị trí lỗi ngoài đoạn đã xem.");
          normalizedIssues.push(issue);
        } else {
          if (issue.output_end < reviewWindow.start - 5 || issue.output_start > reviewWindow.end + 5) continue;
          issue.output_start = Number(Math.max(reviewWindow.start, Math.min(reviewWindow.end, issue.output_start)).toFixed(3));
          issue.output_end = Number(Math.max(issue.output_start, Math.min(reviewWindow.end, issue.output_end)).toFixed(3));
          normalizedIssues.push(issue);
        }
      }
      issues = normalizedIssues;
    }
    return {
      overall_score: raw.overall_score,
      summary: safeText(raw.summary, "Draft review completed."),
      ...(!excerptOnly && raw.duration_assessment ? { duration_assessment: raw.duration_assessment } : {}),
      issues
    };
  }
}

module.exports = RecapAiService;
