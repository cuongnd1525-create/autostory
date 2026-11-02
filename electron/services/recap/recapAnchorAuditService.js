const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const Media = require("./recapMediaService");
const SubtitleService = require("../subtitleService");
const { fingerprint } = require("./recapEditorialService");

class RecapAnchorAuditService {
  constructor(settings = {}, dependencies = {}) {
    this.media = dependencies.media || new Media(settings);
    this.subtitleFactory = dependencies.subtitleFactory || (() => new SubtitleService({ ...settings, whisperEngine: "faster-whisper", whisperModel: "base.en" }));
  }
  async repair({ sourceVideoPath, sourceDuration, events, eventIds, issues, narration = [], scenes = [], directory, observationCacheDirectory, ai, signal, onProgress }) {
    const selected = events.filter(event => eventIds.includes(event.id));
    if (!selected.length) return events;
    observationCacheDirectory ||= path.join(directory, ".observations");
    signal?.throwIfAborted();
    const groups = [];
    for (const event of [...selected].sort((a, b) => a.source_start - b.source_start)) {
      const previous = groups.at(-1);
      if (previous && event.source_start - Math.max(...previous.map(item => item.source_end)) <= 60) previous.push(event);
      else groups.push([event]);
    }
    if (groups.length > 1) {
      let updated = events;
      for (let index = 0; index < groups.length; index++) {
        onProgress?.({ message: `Đối chiếu nhóm cảnh nghi lỗi ${index + 1}/${groups.length}; không quét các khoảng nguồn không liên quan...` });
        updated = await this.repair({ sourceVideoPath, sourceDuration, events: updated, eventIds: groups[index].map(event => event.id),
          issues, narration, scenes, directory: path.join(directory, `group-${index + 1}`), observationCacheDirectory, ai, signal, onProgress });
      }
      return updated;
    }
    const stat = await fs.stat(sourceVideoPath);
    const key = fingerprint({ version: 7, sourceVideoPath, size: stat.size, modified: stat.mtimeMs, selected, issues, narration });
    const root = path.join(directory, key.slice(0, 16)); await fs.mkdir(root, { recursive: true });
    if (selected.every(event => event.anchorMethod === "scene_frames")) {
      const sourceSignature = fingerprint({ path: path.resolve(sourceVideoPath), size: stat.size, modified: stat.mtimeMs });
      return this.auditIndexedRanges({ sourceVideoPath, sourceDuration, sourceSignature, events, selected, issues, narration,
        root, observationCacheDirectory, ai, signal, onProgress });
    }
    const start = Math.max(0, Math.floor(Math.min(...selected.map(event => event.source_start)) - 45));
    const end = Math.min(sourceDuration, Math.ceil(Math.max(...selected.map(event => event.source_end)) + 45));
    const audioPath = path.join(root, "source-audio.wav");
    // A still of the attacker cannot prove who was attacked. Preserve the
    // actual action around the original range as well as indexed stills.
    const clipStart = Math.max(0, Math.min(...selected.map(event => event.source_start)) - 8);
    const clipEnd = Math.min(sourceDuration, Math.max(...selected.map(event => event.source_end)) + 8);
    const actionVideo = path.join(root, "source-action.mp4");
    await this.media.runCommand(this.media.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(clipStart), "-i", sourceVideoPath,
      "-t", String(clipEnd - clipStart), "-vf", "scale=640:-2,fps=8", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-movflags", "+faststart", actionVideo]);
    await this.media.runCommand(this.media.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", sourceVideoPath,
      "-t", String(end - start), "-vn", "-ar", "16000", "-ac", "1", audioPath]);
    const transcript = await this.subtitleFactory().transcribeToSrt({ audioPath, outputDir: root, narrationLanguage: "en",
      cacheDir: path.join(os.tmpdir(), "recap-audit-asr", key.slice(0, 20)), timeoutMs: 600000, signal });
    const words = JSON.parse(await fs.readFile(transcript.wordTimestampsPath, "utf8"));
    const sourceSegments = (words.segments || []).map(segment => ({ start: Number((start + segment.start).toFixed(2)),
      end: Number((start + segment.end).toFixed(2)), text: segment.text }));
    const frames = [];
    for (let time = start; time < end; time += 2) {
      frames.push({ index: frames.length, sourceTime: time });
    }
    const extractFrame = async ({ index, sourceTime }) => {
      signal?.throwIfAborted();
      const file = path.join(root, `frame-${String(index).padStart(3, "0")}.png`);
      try { await fs.access(file); } catch (_) {
        await this.media.runCommand(this.media.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(sourceTime),
          "-i", sourceVideoPath, "-vf", `scale=480:-2,drawtext=text='FRAME ${index} SOURCE ${sourceTime}s':fontcolor=white:box=1:boxcolor=black:fontsize=20:x=4:y=4`,
          "-frames:v", "1", "-threads", "1", file]);
      }
    };
    for (let startIdx = 0; startIdx < frames.length; startIdx += 4) {
      signal?.throwIfAborted();
      await Promise.all(frames.slice(startIdx, startIdx + 4).map(extractFrame));
    }
    const sheets = [];
    for (let index = 0; index < Math.ceil(frames.length / 12); index++) {
      signal?.throwIfAborted();
      const file = path.join(root, `sheet-${index}.png`);
      await this.media.runCommand(this.media.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-start_number", String(index * 12),
        "-i", path.join(root, "frame-%03d.png"), "-vf", "tile=4x3", "-frames:v", "1", "-threads", "1", file]);
      sheets.push(file);
    }
    onProgress?.({ message: `Đang đối chiếu lại ${selected.length} mốc cảnh với ${frames.length} khung hình nguồn có thời gian chính xác...` });
    const schema = { type: "object", required: ["matches"], properties: { matches: { type: "array", items: {
      type: "object", required: ["event_id", "frame_index", "confidence", "claim_supported"], properties: {
        event_id: { type: "string", enum: selected.map(event => event.id) }, frame_index: { type: "integer", minimum: -1, maximum: frames.at(-1).index }, confidence: { type: "number" }, verified_description: { type: "string" }, claim_supported: { type: "boolean" }
      } } } } };
    const result = await ai.runVertexCall({ filePaths: [actionVideo, ...sheets], modelOverride: ai.getQualityModel?.() || ai.getAnalysisModel(), signal, onProgress,
      responseSchema: schema, prompt: ["Audit incorrect source anchors using these actual source frames. Each frame has a code-controlled FRAME index and SOURCE time.",
        `First watch source-action.mp4, covering absolute source ${clipStart.toFixed(3)}..${clipEnd.toFixed(3)}s, to establish what action actually occurs. A close-up of an attacker alone does NOT verify the victim, rescue or result. Name a target only when the actual action footage establishes that target. Describe observable appearances instead of guessing an uncertain identity. The old event labels below are suspect claims, not evidence.`,
        `Return FRAME indices only (${frames[0].index}..${frames.at(-1).index}), never SOURCE timestamps (${start}..${end}s). For example, the first extracted frame has frame_index 0 at source time ${start}s.`,
        "For each supplied event, select the single FRAME index that clearly shows its described action. Return confidence 0..1. If unseen, return frame_index -1 and confidence 0. Do not estimate timestamps or choose a merely related scene.",
        "If an event mixes a visible action with unsupported details, locate only its genuinely visible component and return verified_description containing only what these frames and transcript support. Remove invented dialogue, screens or outcomes. Do not substitute an unrelated action. An incorrect label may instead be explicitly corrected in its original source range as described below.",
        "For spoken revelations, use the time-stamped source transcript to locate the actual statement. A similar-looking office or character elsewhere is not evidence for that revelation.",
        "Check the narration's actor, target, action and causal claim against the actual frames. An event label is not proof. Explicitly remove an unsupported victim, rescue, victory or retreat from verified_description rather than relocating an unrelated action to fit that claim.",
        "If the original event names the wrong actor/target, set claim_supported=false and return a frame near the ORIGINAL event range showing what really occurs, with a concrete verified_description. This is an explicit correction of a false label, not a claimed match. Use -1 only if the original range cannot be confidently described at all. Do not move an unsupported claim elsewhere in the plot.",
        `Narration to verify: ${JSON.stringify(narration.filter(unit => unit.clauses?.some(clause => clause.visual_event_ids?.some(id => eventIds.includes(id)))))}`,
        `Actual source transcript in absolute seconds: ${JSON.stringify(sourceSegments)}`,
        `Events to locate (absolute original source ranges): ${JSON.stringify(selected.map(event => ({ id: event.id, source_start: event.source_start, source_end: event.source_end, description: event.description })))}`,
        `Rendered-video issues: ${JSON.stringify(issues)}`].join("\n") });
    const matches = result.matches || [], seen = new Set(), updated = structuredClone(events);
    await fs.writeFile(path.join(root, "audit-response.json"), JSON.stringify({ sourceSegments, frames, matches }, null, 2));
    for (const match of matches) {
      if (!selected.some(event => event.id === match.event_id) || seen.has(match.event_id)) throw new Error("Kết quả đối chiếu mốc nguồn không hợp lệ.");
      seen.add(match.event_id);
      const frame = frames[match.frame_index];
      if (!Number.isInteger(match.frame_index) || !frame || !Number.isFinite(match.confidence) || match.confidence < .8 || match.confidence > 1)
        throw new Error(`Chưa xác minh được hình nguồn cho ${match.event_id}. Không giữ lại mốc cảnh đã bị review báo sai.`);
      const event = updated.find(event => event.id === match.event_id);
      const originalDescription = event.description;
      if (typeof match.claim_supported !== "boolean") throw new Error("Đối chiếu nguồn chưa xác nhận mô tả cũ có được hình ảnh hỗ trợ hay không.");
      if (match.claim_supported === false && (!String(match.verified_description || "").trim()
        || frame.sourceTime < event.source_start - 2 || frame.sourceTime > event.source_end + 2))
        throw new Error("Mô tả sửa nhãn phải được quan sát trong chính khoảng nguồn bị gán sai, không chuyển sang cảnh khác.");
      const scene = scenes.find(scene => frame.sourceTime >= (scene.startSec ?? scene.start) && frame.sourceTime < (scene.endSec ?? scene.end));
      event.source_start = Math.max(0, scene?.startSec ?? scene?.start ?? 0, frame.sourceTime - .25);
      event.source_end = Math.min(sourceDuration, scene?.endSec ?? scene?.end ?? sourceDuration, frame.sourceTime + 4);
      event.duration = event.source_end - event.source_start;
      if (typeof match.verified_description === "string" && match.verified_description.trim()) {
        event.description = match.verified_description.trim();
      }
      if (!match.claim_supported) { event.subjects = []; event.actions = []; }
      event.anchorAudit = { version: 5, frameIndex: frame.index, sourceTime: frame.sourceTime, confidence: match.confidence,
        claimSupported: match.claim_supported !== false, originalDescription,
        ...(event.anchorAudit?.invalidatedNarrativeContext ? { invalidatedNarrativeContext: event.anchorAudit.invalidatedNarrativeContext } : {}) };
      if (!match.claim_supported && event.narrativeContext?.length) {
        event.anchorAudit.invalidatedNarrativeContext = event.narrativeContext;
        delete event.narrativeContext;
      }
    }
    if (seen.size !== selected.length) throw new Error("Đối chiếu mốc nguồn thiếu sự kiện cần sửa.");
    await fs.writeFile(path.join(root, "audit.json"), JSON.stringify({ sourceSegments, frames, matches, events: updated.filter(event => seen.has(event.id)) }, null, 2));
    return updated;
  }

  async auditIndexedRanges({ sourceVideoPath, sourceDuration, sourceSignature, events, selected, root, observationCacheDirectory, ai, signal, onProgress }) {
    const extract = async (file, start, end) => {
      signal?.throwIfAborted();
      if (!(start >= 0 && end > start && end <= sourceDuration)) throw new Error("Khoảng nguồn cần đối chiếu không hợp lệ.");
      await this.media.runCommand(this.media.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", sourceVideoPath,
        "-t", String(end - start), "-vf", "scale=640:-2,fps=8", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-movflags", "+faststart", file]);
      return file;
    };
    const clips = [];
    for (let index = 0; index < selected.length; index++) {
      const event = selected[index], file = `event-${index + 1}.mp4`;
      clips.push({ id: event.id, file, source_start: event.source_start, source_end: event.source_end,
        path: path.join(root, file), suspect_label: event.description });
    }
    const schema = { type: "object", required: ["observations"], properties: { observations: { type: "array", minItems: 1, maxItems: 1,
      items: { type: "object", required: ["event_id", "observation_confidence", "claim_supported", "verified_description"], properties: {
        event_id: { type: "string", enum: selected.map(event => event.id) }, observation_confidence: { type: "number", minimum: 0, maximum: 1 },
        claim_supported: { type: "boolean" }, verified_description: { type: "string" }
      } } } } };
    onProgress?.({ message: `Đang xem lại ${selected.length} đoạn nguồn chính xác; xác minh nhân vật và hành động, không để AI tự đổi mốc hình...` });
    const result = { observations: [] }, sourceLabels = new Map();
    const model = ai.getQualityModel?.() || ai.getAnalysisModel();
    const observationKey = (clip, label) => fingerprint({ version: 2, sourceSignature, id: clip.id, start: clip.source_start,
      end: clip.source_end, label, model, videoFps: 4 });
    const validObservation = (observation, id) => observation?.event_id === id && typeof observation.claim_supported === "boolean"
      && Number.isFinite(observation.observation_confidence) && observation.observation_confidence >= .8 && observation.observation_confidence <= 1
      && String(observation.verified_description || "").trim();
    await fs.mkdir(observationCacheDirectory, { recursive: true });
    // One request per exact interval prevents observations from neighbouring
    // action clips being attached to the wrong file/scene by the model.
    for (const clip of clips) {
      signal?.throwIfAborted();
      const cache = path.join(observationCacheDirectory, `${observationKey(clip, clip.suspect_label)}.json`);
      let cached;
      try { cached = JSON.parse(await fs.readFile(cache, "utf8")); } catch (_) {}
      if (cached?.sourceSignature === sourceSignature && cached.model === model && validObservation(cached.observation, clip.id)) {
        result.observations.push(cached.observation);
        sourceLabels.set(clip.id, cached.originalDescription || clip.suspect_label);
        onProgress?.({ message: `Dùng lại quan sát nguồn ${clip.id}; hình không đổi, không cần gọi AI hoặc cắt clip lại.`, cacheHit: true });
        continue;
      }
      await extract(clip.path, clip.source_start, clip.source_end);
      onProgress?.({ message: `Đối chiếu nguồn ${result.observations.length + 1}/${clips.length}: ${clip.id} (${clip.source_start.toFixed(2)}–${clip.source_end.toFixed(2)}s)...` });
      const responseSchema = structuredClone(schema);
      responseSchema.properties.observations.items.properties.event_id.enum = [clip.id];
      const observation = await ai.runVertexCall({ filePaths: [clip.path], modelOverride: ai.getQualityModel?.() || ai.getAnalysisModel(),
        signal, onProgress, responseSchema, videoFps: 4, prompt: [
        "Independently describe the action in this ONE attached short source clip. Its exact interval is controlled by application code. Do not select timestamps, frame indices, or move the event to another part of the story.",
        "verified_description must describe only what is actually visible in THIS clip. A close-up of an attacker alone does not prove the victim or result. Use observable physical descriptions instead of guessing uncertain character names. Do not add a rescue, victory or retreat that is not shown.",
        "The old labels and narration are SUSPECT claims. If the clip contradicts a label, set claim_supported=false and describe what REALLY occurs in that exact clip. observation_confidence measures confidence in your NEW observation, independently of whether the old claim was true. A clearly false old label can have a high observation_confidence. Return a concrete positive description, not only a denial of the old label.",
        `Exact event and suspect label: ${JSON.stringify({ id: clip.id, source_start: clip.source_start, source_end: clip.source_end, suspect_label: clip.suspect_label })}`
      ].join("\n") });
      if (!Array.isArray(observation.observations) || observation.observations.length !== 1 || observation.observations[0].event_id !== clip.id)
        throw new Error("Đối chiếu nguồn chưa trả đúng đoạn video được xem.");
      const value = observation.observations[0];
      if (!validObservation(value, clip.id)) throw new Error(`Chưa xác minh được nội dung đoạn nguồn ${clip.id}.`);
      result.observations.push(value);
      sourceLabels.set(clip.id, clip.suspect_label);
      const payload = JSON.stringify({ sourceSignature, model, observation: value, originalDescription: clip.suspect_label });
      await fs.writeFile(cache, payload);
      // A subsequent narration edit may retain the verified description. It is
      // the same observation, not a fresh approval of the new spoken claim.
      await fs.writeFile(path.join(observationCacheDirectory, `${observationKey(clip, value.verified_description.trim())}.json`), payload);
    }
    await fs.writeFile(path.join(root, "audit-response.json"), JSON.stringify(result, null, 2));
    const updated = structuredClone(events), seen = new Set();
    for (const observation of result.observations || []) {
      const original = selected.find(event => event.id === observation.event_id);
      if (!original || seen.has(original.id) || typeof observation.claim_supported !== "boolean"
        || !Number.isFinite(observation.observation_confidence) || observation.observation_confidence < .8 || observation.observation_confidence > 1
        || !String(observation.verified_description || "").trim()) throw new Error(`Chưa xác minh được nội dung đoạn nguồn ${observation.event_id || "không rõ"}; không giữ nhãn cũ hoặc tự chuyển mốc hình.`);
      seen.add(original.id);
      const event = updated.find(item => item.id === original.id);
      event.description = observation.verified_description.trim();
      // The observation does not separately verify the old entity/action
      // arrays. Do not reintroduce a wrong name from those stale fields.
      event.subjects = []; event.actions = [];
      event.anchorAudit = { version: 7, method: "fixed_source_range", sourceStart: event.source_start, sourceEnd: event.source_end,
        confidence: observation.observation_confidence, claimSupported: observation.claim_supported, originalDescription: sourceLabels.get(original.id) || original.description,
        ...(event.anchorAudit?.invalidatedNarrativeContext ? { invalidatedNarrativeContext: event.anchorAudit.invalidatedNarrativeContext } : {}) };
      if (!observation.claim_supported && event.narrativeContext?.length) {
        event.anchorAudit.invalidatedNarrativeContext = event.narrativeContext;
        delete event.narrativeContext;
      }
    }
    if (seen.size !== selected.length) throw new Error("Đối chiếu nguồn thiếu đoạn cần xác minh; không duyệt nội dung chưa được xem.");
    await fs.writeFile(path.join(root, "audit.json"), JSON.stringify({ events: updated.filter(event => seen.has(event.id)) }, null, 2));
    return updated;
  }
}
module.exports = RecapAnchorAuditService;
