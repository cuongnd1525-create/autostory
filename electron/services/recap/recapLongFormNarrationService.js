const Editorial = require("./recapEditorialService");

const VERSION = 1;
const words = text => String(text || "").trim().split(/\s+/).filter(Boolean).length;
const checkAbort = signal => signal?.throwIfAborted();
const invalidResponse = message => Object.assign(new Error(message), { kind: "invalid_json" });

// Long scripts need source dialogue and enough output structure to develop the
// story. A few representative frame captions are not a substitute for either.
class RecapLongFormNarrationService {
  sections({ chunks, events, targetDurationSec, wordsPerSecond, hook }) {
    if (!(Number.isFinite(targetDurationSec) && targetDurationSec > 0)) throw new Error("Thời lượng recap dài không hợp lệ.");
    const ordered = [...chunks].sort((a, b) => a.sourceStartSec - b.sourceStartSec);
    if (!ordered.length) throw new Error("Thiếu các phần nguồn để viết recap dài.");
    if (ordered.some(chunk => !Number.isFinite(chunk.sourceStartSec) || !(chunk.sourceEndSec > chunk.sourceStartSec)))
      throw new Error("Phân đoạn video nguồn thiếu thời gian bắt đầu/kết thúc hợp lệ.");
    const sections = ordered.map((chunk, i) => ({ ...chunk, index: i,
      events: events.filter(event => {
        const center = (event.source_start + event.source_end) / 2;
        // Assign overlaps once. A source interval must not fund two chapters.
        return center >= chunk.sourceStartSec && center < (ordered[i + 1]?.sourceStartSec ?? chunk.sourceEndSec);
      }) })).filter(section => section.events.length);
    const weight = section => Editorial.planScope({ beats: [{ role: "body", visual_event_ids: section.events.map(e => e.id) }] }, section.events, 0).selectedSec;
    const total = sections.reduce((n, section) => n + weight(section), 0);
    const cadence = Math.max(.8, Math.min(5.2, Number(wordsPerSecond) || 2.6));
    // Leave space for the opening and the solver's small inter-unit pauses.
    const targetWords = Math.max(20, Math.round((targetDurationSec - (hook?.durationSec || 0)) * cadence * .94));
    return sections.map(section => {
      const targetWordCount = Math.max(15, Math.round(targetWords * weight(section) / Math.max(1, total)));
      return { ...section, targetWordCount, passageCount: Math.max(1, Math.ceil(targetWordCount / 48)) };
    });
  }

  schema(section) {
    const passage = { type: "object", required: ["text", "event_ids", "source_note"], properties: {
      text: { type: "string" }, event_ids: { type: "array", items: { type: "string" } },
      source_note: { type: "string" }, omission_reason: { type: "string" }
    } };
    const properties = Object.fromEntries(Array.from({ length: section.passageCount }, (_, i) => [`passage_${i + 1}`, passage]));
    return { type: "object", required: Object.keys(properties), properties };
  }

  compile(raw, section) {
    const known = new Map(section.events.map(event => [event.id, event]));
    const passages = Object.keys(this.schema(section).properties).map(key => {
      const item = raw?.[key], text = String(item?.text || "").trim();
      if (!text && String(item?.omission_reason || "").trim()) return { key, text: "", omission_reason: item.omission_reason };
      if (!Array.isArray(item?.event_ids)) throw invalidResponse(`Phần kể ${section.index + 1}/${key} thiếu tham chiếu nguồn hợp lệ.`);
      const ids = [...new Set(item.event_ids)];
      if (!text || !ids.length || ids.some(id => !known.has(id)) || !String(item.source_note || "").trim())
        throw invalidResponse(`Phần kể ${section.index + 1}/${key} thiếu lời kể, bằng chứng hoặc tham chiếu nguồn hợp lệ.`);
      ids.sort((a, b) => known.get(a).source_start - known.get(b).source_start);
      return { key, text, event_ids: ids, source_note: item.source_note };
    });
    const wordCount = passages.reduce((n, item) => n + words(item.text), 0);
    return { passages, wordCount, targetWordCount: section.targetWordCount };
  }

  async alignSource({ ai, section, result, filePath, wordsPerSecond, signal, onProgress }) {
    const passageIds = result.passages.map(p => p.key);
    const eventIds = new Set(section.events.map(event => event.id));
    const validatePlacements = raw => {
      // A flat object with one required property per event exceeds Vertex's
      // constrained-decoder complexity for dense chapters (132 in the report).
      // Keep the schema constant in shape and enforce full coverage locally.
      if (!Array.isArray(raw?.placements) || raw.placements.length !== eventIds.size
        || new Set(raw.placements.map(item => item?.event_id)).size !== eventIds.size
        || raw.placements.some(item => !eventIds.has(item?.event_id) || ![...passageIds, "omit"].includes(item?.passage_id)))
        throw invalidResponse(`Căn hình phần ${section.index + 1} thiếu phân bổ sự kiện nguồn hợp lệ.`);
    };
    const raw = await ai.runVertexCall({ filePaths: [filePath], modelOverride: ai.getAnalysisModel(), signal, onProgress, validateResult: validatePlacements,
      responseSchema: { type: "object", required: ["placements"], properties: { placements: {
        type: "array", items: { type: "object", required: ["event_id", "passage_id"], properties: {
          event_id: { type: "string", enum: [...eventIds] }, passage_id: { type: "string", enum: [...passageIds, "omit"] }
        } }
      } } }, prompt: [
        "Independently align this spoken chapter to the attached SOURCE video, including dialogue. Do NOT rewrite the narration.",
        `Local video time zero equals absolute source ${section.sourceStartSec}s. Source ends at ${section.sourceEndSec}s.`,
        `Assign EACH supplied source event ID to the ONE passage whose subject/action/dialogue it genuinely supports, or 'omit' for unrelated/redundant footage. passage_id MUST be one of ${JSON.stringify([...passageIds, "omit"])}. Return placements as a list of {event_id, passage_id} records, exactly ONE for EVERY supplied event ID, with no duplicates or unknown IDs. Do not select just a single representative frame: allocate the complete relevant action/discussion sequence, including its setup, development and supported reaction shots where appropriate.`,
        "The source is being condensed, not frozen or repeated. Each passage needs enough distinct relevant footage for its measured-cadence speech estimate below. Preserve chronology across passages and within their sequences. If there is insufficient relevant footage, omit rather than misrepresent the actor, target or action; later editorial repair will address the shortfall. Never assign a random nearby shot merely to fill the budget. Events with verified corrections override old summaries or franchise canon.",
        `Passages: ${JSON.stringify(result.passages.map(p => ({ id: p.key, text: p.text,
          speechEstimateSec: Number((words(p.text) / wordsPerSecond + .3).toFixed(2)), source_note: p.source_note })))}`,
        `Source events: ${JSON.stringify(section.events.map(e => ({ id: e.id, start: e.source_start,
          end: e.source_end, description: e.description, verified: Boolean(e.anchorAudit) })))}`
      ].join("\n") });
    validatePlacements(raw);
    const placements = new Map(raw.placements.map(item => [item.event_id, item.passage_id]));
    const refs = result.passages.map(() => []);
    for (const event of section.events) {
      const placement = placements.get(event.id), index = passageIds.indexOf(placement);
      if (index >= 0 && result.passages[index].text) refs[index].push(event.id);
    }
    return Object.fromEntries(result.passages.map((p, i) => {
      // The independent source pass can reject an unsupported/redundant
      // paragraph. Do not manufacture a clip assignment to retain its words.
      if (p.text && !refs[i].length) return [p.key, { text: "", event_ids: [], source_note: "",
        omission_reason: "Kiểm tra video nguồn không phân bổ được bằng chứng riêng cho đoạn kể này.", rejected_text: p.text }];
      return [p.key, { ...p, event_ids: refs[i] }];
    }));
  }

  async generate({ ai, media, chunks, events, storyModel, options, angle, hook, wordsPerSecond,
    proxyPath, directory, cache = {}, onSection = async () => {}, signal, onProgress = () => {} }) {
    wordsPerSecond = Math.max(.8, Math.min(5.2, Number(wordsPerSecond) || 2.6));
    // Previous writing notes are derived output, not a change to source identity.
    const sourceEvents = events.map(({ narrativeContext, ...event }) => event);
    const sections = this.sections({ chunks, events: sourceEvents, targetDurationSec: options.targetDurationSec, wordsPerSecond, hook });
    const results = [], filePaths = [];
    const summaries = chunks.map(chunk => ({ start: chunk.sourceStartSec, end: chunk.sourceEndSec, summary: chunk.summary || "" }));
    for (const section of sections) {
      checkAbort(signal);
      const key = Editorial.fingerprint({ version: VERSION, proxyPath, section, narrative: Editorial.narrativeKey(options),
        cadence: wordsPerSecond, angle, hook: hook?.text });
      let raw = cache[key], result;
      if (raw) {
        try { result = this.compile(raw, section); }
        catch (error) {
          if (error.kind !== "invalid_json") throw error;
          onProgress({ level: "WARNING", message: `Bỏ checkpoint lời kể phần ${section.index + 1} sai cấu trúc; giữ các phần còn hợp lệ.` });
          raw = undefined;
        }
      }
      const filePath = section.isSingleChunk ? proxyPath : await media.extractProxyChunk({ proxyPath, chunk: section, outputDir: directory });
      filePaths.push(filePath);
      if (result) {
        onProgress({ message: `Khôi phục lời kể phần ${section.index + 1}/${sections.length}: ${result.wordCount} từ.` });
      } else {
        const perPassage = Math.round(section.targetWordCount / section.passageCount);
        const prompt = [
          `Write chapter ${section.index + 1} of ${sections.length} of a LONG-FORM ${options.language === "vi" ? "Vietnamese" : "US English"} film ${options.preset || "recap"}. Style: ${options.style || "natural"}.`,
          "Watch AND listen to the attached source chapter. Dialogue, decisions and consequences matter; frame captions alone omit them. Write the story, not a list of shots or a short-form synopsis.",
          `The whole output preference is ${options.targetDurationSec}s at the measured ${wordsPerSecond.toFixed(2)} spoken words/sec. This chapter's share is approximately ${section.targetWordCount} words, in ${section.passageCount} consecutive passages of roughly ${perPassage} words each. Develop distinct source-backed moments rather than repeating a theme.`,
          `The attached video's timestamps are LOCAL. Add ${section.sourceStartSec}s to compare them with the ABSOLUTE source intervals below. Stay within this chapter [${section.sourceStartSec}, ${section.sourceEndSec}]s.`,
          "Each named passage is one coherent action/explanation sequence, normally 2–4 natural spoken sentences. Use enough relevant supporting event intervals for that passage's speech at the supplied cadence. Prefer unused chronological intervals. Do not attach unrelated shots for spare time or reuse an interval already narrated in another passage.",
          "Paraphrase audible dialogue accurately; explain the source-backed choices, obstacles, reversals and consequences. No invented lore, private thoughts, motivations or outcomes. No decorative filler, repetitive philosophical commentary, greetings, chapter labels, word-count annotations or repeated hooks. Preserve causal transitions between chapters, without repeating the prior chapter or anticipating the next one's outcome.",
          "For each passage return text, event_ids and a short source_note describing the visible action/audible dialogue that supports it. The note is evidence metadata and will NOT be spoken. Existing frame-audit corrections override contradictory old summaries.",
          "The requested length specifies depth, not permission to pad. If a passage cannot add useful supported content, set text to empty and explain omission_reason. Otherwise develop the missing details; do not silently turn the requested detailed chapter into a two-sentence summary.",
          `Selected angle: ${JSON.stringify(angle)}. Selected opening hook (already recorded; DO NOT repeat): ${JSON.stringify(hook?.text || "")}. Spoilers: ${options.spoiler || "balanced"}.`,
          `Retention preference: ${options.retention || "balanced"}. Build source-supported tension, not artificial cliffhangers. In the final chapter deliver the promised payoff${options.loop ? " and, when natural, connect that resolution to the opening question without repeating the hook" : ""}.`,
          ...(section.events.some(e => e.id === hook?.payoff_event_id)
            ? [`This chapter contains the opening hook's promised payoff at event ${hook.payoff_event_id}. Develop that supported resolution and include this event among its actual supporting references.`] : []),
          `Story outline (source evidence overrides mistakes here): ${JSON.stringify(storyModel)}.`,
          `Chapter boundaries and summaries: ${JSON.stringify(summaries)}.`,
          `Previous chapter ending: ${results.at(-1)?.passages.filter(p => p.text).at(-1)?.text || "Opening hook only; establish the story now."}`,
          `Source events: ${JSON.stringify(section.events.map(e => ({ id: e.id, start: e.source_start, end: e.source_end,
            description: e.description, verified: Boolean(e.anchorAudit) })))}`
        ].join("\n");
        // One bounded, targeted correction of an actually measured chapter
        // deficit. Never regenerate every good chapter or retry indefinitely.
        for (let attempt = 0; attempt < 2; attempt++) {
          checkAbort(signal);
          onProgress({ message: `Viết theo video nguồn phần ${section.index + 1}/${sections.length}: khoảng ${section.targetWordCount} từ${attempt ? " · bổ sung chi tiết còn thiếu" : ""}...` });
          raw = await ai.runVertexCall({ filePaths: [filePath], responseSchema: this.schema(section), modelOverride: ai.getQualityModel(),
            signal, onProgress, validateResult: response => this.compile(response, section),
            prompt: prompt + (attempt ? `\nThe previous chapter response had only ${result.wordCount} actual words versus the ${section.targetWordCount}-word intended scope. Develop meaningful omitted dialogue, obstacles and consequences from THIS video. Preserve accurate existing details, avoid filler. Previous response: ${JSON.stringify(raw)}` : "") });
          result = this.compile(raw, section);
          if (result.wordCount >= section.targetWordCount * .75 || result.passages.some(p => p.omission_reason)) break;
        }
        delete raw.__aligned;
        await onSection(key, raw);
      }
      if (raw.__aligned !== 2 && result.passages.some(p => p.text)) {
        checkAbort(signal);
        onProgress({ message: `Căn toàn bộ hình nguồn cho phần ${section.index + 1}/${sections.length}...` });
        raw = { ...await this.alignSource({ ai, section, result, filePath, wordsPerSecond, signal, onProgress }), __aligned: 2 };
        result = this.compile(raw, section);
        await onSection(key, raw);
      }
      onProgress({ message: `Xong lời kể phần ${section.index + 1}/${sections.length}: ${result.wordCount}/${section.targetWordCount} từ dự kiến.` });
      results.push({ ...result, section, filePath });
    }
    const speechUnits = [], beats = [], enriched = structuredClone(sourceEvents), byId = new Map(enriched.map(e => [e.id, e]));
    for (const { passages, section, filePath } of results) {
      const beatId = `source_chapter_${section.index + 1}`, refs = new Set();
      for (const item of passages.filter(p => p.text)) {
        const id = `chapter_${section.index + 1}_${item.key}`;
        speechUnits.push({ id, beat_id: beatId, text: item.text, visual_event_ids: item.event_ids,
          clauses: [{ clause_id: `${id}_c1`, text: item.text, visual_event_ids: item.event_ids }] });
        for (const eventId of item.event_ids) {
          refs.add(eventId);
          const event = byId.get(eventId);
          event.narrativeContext ||= [];
          event.narrativeContext.push({ provenance: "source_video_narration", sourcePath: filePath,
            sourceStartSec: section.sourceStartSec, sourceEndSec: section.sourceEndSec, note: item.source_note });
        }
      }
      if (refs.size) beats.push({ beat_id: beatId, role: section.index === sections.length - 1 ? "payoff" : section.index === 0 ? "setup" : "development",
        purpose: section.summary || `Source chapter ${section.index + 1}`, visual_event_ids: [...refs] });
    }
    const rawPlan = { target_duration_sec: options.targetDurationSec, hook_event_ids: hook?.event_ids || [], beats,
      selected_event_ids: [...new Set(beats.flatMap(b => b.visual_event_ids))] };
    if (!speechUnits.length) throw new Error("Nguồn không có đủ nội dung có bằng chứng để tạo lời kể; các phần bỏ qua đã được lưu để kiểm tra.");
    const plan = Editorial.groundPlan(rawPlan, enriched, hook);
    return { plan, speechUnits: Editorial.groundNarration(speechUnits, enriched, plan, hook), events: enriched, filePaths,
      metrics: results.map(r => ({ index: r.section.index, wordCount: r.wordCount, targetWordCount: r.targetWordCount,
        omissions: r.passages.filter(p => p.omission_reason).map(p => p.omission_reason) })) };
  }
}
module.exports = RecapLongFormNarrationService;
