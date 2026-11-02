const fs = require("fs/promises");
const path = require("path");
const Editorial = require("./recapEditorialService");
const Preflight = require("./recapNarrativePreflightService");
const Index = require("./recapSceneIndexService");
const words = units => units.reduce((n, unit) => n + String(unit.text || "").trim().split(/\s+/).filter(Boolean).length, 0);
const invalid = message => Object.assign(new Error(message), { kind: "invalid_json" });

// Recovery never treats the whole source as available evidence. Only already
// selected contiguous scene IDs are candidates, and an independent source-video
// observation must approve their omitted context before the solver can use it.
class RecapScopeRecoveryService {
  balance(solution, duration) {
    const groups = solution.clauseBudgets || [], overflow = groups.filter(group => !group.passed);
    if (!overflow.length || overflow.some(group => group.missingEventIds?.length || group.targetWordCount <= 3)) return null;
    // Models naturally choose complete concise sentences below the ceiling.
    // Plan for that normal 15% margin rather than assuming every repair uses
    // the maximum word count and discovering the aggregate loss after TTS.
    const loss = overflow.reduce((n, group) => n + group.currentDuration
      * Math.max(0, 1 - group.targetWordCount * .85 / Math.max(1, words([{ text: group.text }]))), 0);
    const fitted = duration.actual - loss, floor = duration.target * .65 + 12;
    if (fitted >= floor) return null;
    const occurrence = new Map();
    for (const group of groups) for (const id of group.visual_event_ids) occurrence.set(id, (occurrence.get(id) || 0) + 1);
    // Exclude the 1.5s solver hold allowance and leave a moving-footage margin.
    // No repetitions, slower voice, unselected shots or mandatory expansion of
    // every sentence. Redistribute detail only to genuinely supporting footage.
    const candidates = groups.filter(group => group.passed && group.speechUnitId !== "opening_hook"
      && group.visual_event_ids.every(id => occurrence.get(id) === 1)).map(group => ({ group,
        room: Math.max(0, Math.min(6, group.currentDuration * .6, group.maxGroundedDuration - group.currentDuration - 1.85))
      })).filter(item => item.room >= 1).sort((a, b) => b.room - a.room).slice(0, 24);
    const available = candidates.reduce((n, item) => n + item.room, 0);
    const needed = Math.max(0, Math.min(duration.actual, duration.target * .8) + 10 - fitted);
    if (available < floor - fitted + 1) return null;
    let remaining = Math.min(needed, available);
    const expanded = [];
    for (const { group, room } of candidates) {
      if (remaining < .3) break;
      const add = Math.min(room, remaining), count = words([{ text: group.text }]);
      const minimumWordCount = count + Math.ceil(add * count / Math.max(.3, group.currentDuration));
      expanded.push({ ...group, minimumWordCount, softMinimum: true, targetWordCount: minimumWordCount + 2,
        targetDuration: group.currentDuration + add });
      remaining -= add;
    }
    return [...overflow, ...expanded];
  }
  assess(request) {
    const estimate = new Preflight().estimate({ ...request, includeGroups: true });
    const lossSec = estimate.clauseBudgets.reduce((n, group) => n + Math.max(0, group.currentDuration - group.targetDuration), 0);
    const fittedDurationSec = Math.max(0, estimate.duration.actual - lossSec);
    const fittingGate = Editorial.durationGate(fittedDurationSec, request.options.targetDurationSec, { soft: true });
    const repairLossSec = estimate.clauseBudgets.reduce((n, group) => n + group.currentDuration
      * Math.max(0, 1 - group.targetWordCount * .85 / Math.max(1, words([{ text: group.text }]))), 0);
    const projectedRepairDurationSec = Math.max(0, estimate.duration.actual - repairLossSec);
    const repairGate = Editorial.durationGate(projectedRepairDurationSec, request.options.targetDurationSec, { soft: true });
    return { ...estimate, fittedDurationSec, fittingGate,
      balancePlan: this.balance({ clauseBudgets: estimate.clauseGroups }, estimate.duration),
      atRisk: estimate.duration.largeDeviation || fittingGate.largeDeviation,
      shortfallRisk: (estimate.duration.largeDeviation && estimate.duration.actual < request.options.targetDurationSec)
        || (fittingGate.largeDeviation && fittedDurationSec < request.options.targetDurationSec)
        || (repairGate.largeDeviation && projectedRepairDurationSec < request.options.targetDurationSec),
      projectedRepairDurationSec,
      estimatedFittingLossSec: lossSec };
  }

  evidenceKey(events) {
    return Editorial.fingerprint(events.map(event => ({ id: event.id, description: event.description, anchorAudit: event.anchorAudit })));
  }

  candidates(state) {
    let chunks;
    try { chunks = JSON.parse(state.chunkAnalysisKey).chunks; } catch (_) { return []; }
    if (!Array.isArray(chunks)) return [];
    return chunks.map((chunk, index) => {
      const entries = Index.entriesFor(chunk, state.scenes || []), byId = new Map(entries.map((entry, position) => [entry.scene_id, { ...entry, position }]));
      const candidates = state.visualEvents.filter(event => event.id.startsWith(`chunk_${chunk.chunkIndex}_scene_event_`)).flatMap(event => {
        if (event.anchorMethod !== "scene_frames" || event.anchorAudit || !event.anchorSceneIds?.length) return [];
        const refs = event.anchorSceneIds.map(id => byId.get(id));
        if (refs.some(ref => !ref) || new Set(event.anchorSceneIds).size !== refs.length) return [];
        refs.sort((a, b) => a.position - b.position);
        if (refs.some((ref, i) => i > 0 && ref.position !== refs[i - 1].position + 1)) return [];
        const start = refs[0].source_start, end = refs.at(-1).source_end;
        const original = event.supportAudit?.originalRange || { start: event.source_start, end: event.source_end };
        if (end - start > 24.001 || original.start < start - .001 || original.end > end + .001 || original.start - start < .05) return [];
        return [{ id: event.id, start, end, original, scene_ids: refs.map(ref => ref.scene_id), description: event.description }];
      });
      return { chunk, index, candidates };
    }).filter(part => part.candidates.length);
  }

  restoreCachedNarration(state, options, hook) {
    if (state.visualEvents.some(event => event.anchorAudit)) return null;
    let chunks;
    try { chunks = JSON.parse(state.chunkAnalysisKey).chunks; } catch (_) { return null; }
    if (!chunks?.length) return null;
    const units = [], beats = [], byId = new Map(state.visualEvents.map(event => [event.id, event]));
    const raw = Object.values(state.longFormSections || {}).filter(value => value?.__aligned === 2);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index], eventIds = new Set(state.visualEvents.filter(event => {
        const center = (event.source_start + event.source_end) / 2;
        return center >= chunk.sourceStartSec && center < (chunks[index + 1]?.sourceStartSec ?? chunk.sourceEndSec);
      }).map(event => event.id));
      if (!eventIds.size) continue;
      const matches = raw.map(value => Object.entries(value).filter(([key, item]) => /^passage_\d+$/.test(key) && item?.text))
        .filter(items => items.length && items.every(([, item]) => item.event_ids?.length && item.source_note
          && item.event_ids.every(id => eventIds.has(id))));
      // Never guess which of multiple old scripts belongs to a chapter.
      if (matches.length !== 1) return null;
      const beat = { beat_id: `source_chapter_${index + 1}`, role: index === chunks.length - 1 ? "payoff" : "development", visual_event_ids: [] };
      for (const [key, item] of matches[0].sort((a, b) => Number(a[0].slice(8)) - Number(b[0].slice(8)))) {
        const refs = [...new Set(item.event_ids)].sort((a, b) => byId.get(a).source_start - byId.get(b).source_start);
        const id = `chapter_${index + 1}_${key}`;
        units.push({ id, beat_id: beat.beat_id, text: item.text, visual_event_ids: refs,
          clauses: [{ clause_id: `${id}_c1`, text: item.text, visual_event_ids: refs }] });
        beat.visual_event_ids.push(...refs);
      }
      beat.visual_event_ids = [...new Set(beat.visual_event_ids)]; beats.push(beat);
    }
    if (!units.length) return null;
    try {
      const plan = Editorial.groundPlan({ target_duration_sec: options.targetDurationSec, beats,
        selected_event_ids: [...new Set(beats.flatMap(beat => beat.visual_event_ids))] }, state.visualEvents, hook);
      return { plan, speechUnits: Editorial.groundNarration(units, state.visualEvents, plan, hook) };
    } catch (_) { return null; }
  }

  async recover({ state, options, prefsKey, hook, ai, media, directory, sourceVideoPath, signal, onProgress = () => {}, persist }) {
    signal?.throwIfAborted();
    const parts = this.candidates(state);
    if (!parts.length || typeof ai.runVertexCall !== "function") return { changed: false, available: false };
    const stat = await fs.stat(sourceVideoPath);
    const key = Editorial.fingerprint({ version: 1, sourceVideoPath, size: stat.size, modified: stat.mtimeMs, prefsKey, parts });
    const cache = state.sourceCoverageRecovery?.key === key ? state.sourceCoverageRecovery : { key, parts: {}, status: "pending" };
    if (cache.status === "completed") return { changed: false, available: true, reused: true };
    state.sourceCoverageRecovery = cache; await persist();
    // Legacy failed projects can recover the source-backed chapter drafts instead
    // of developing yet another script from the already shortened 598s result.
    const baseline = state.scopeBaseline?.prefsKey === prefsKey && state.scopeBaseline.evidenceKey === this.evidenceKey(state.visualEvents)
      ? state.scopeBaseline : this.restoreCachedNarration(state, options, hook);
    for (const part of parts) {
      signal?.throwIfAborted();
      if (cache.parts[part.index]) continue;
      const savedPath = state.longFormNarration?.sourceFiles?.[part.index];
      let filePath;
      if (savedPath) try { await fs.access(savedPath); filePath = savedPath; } catch (_) {}
      filePath ||= part.chunk.isSingleChunk ? state.proxyPath : await media.extractProxyChunk({ proxyPath: state.proxyPath,
        chunk: part.chunk, outputDir: path.join(directory, "chunks") });
      const observation = { type: "object", required: ["event_id", "claim_supported", "context_supported", "reason"], properties: {
        event_id: { type: "string", enum: part.candidates.map(candidate => candidate.id) },
        claim_supported: { type: "boolean" }, context_supported: { type: "boolean" }, reason: { type: "string" }
      } };
      const schema = { type: "object", required: ["observations"], properties: { observations: { type: "array", items: observation } } };
      const validate = raw => {
        if (!Array.isArray(raw?.observations) || raw.observations.length !== part.candidates.length
          || new Set(raw.observations.map(item => item.event_id)).size !== part.candidates.length
          || raw.observations.some(item => !part.candidates.some(candidate => candidate.id === item.event_id)
            || typeof item.claim_supported !== "boolean" || typeof item.context_supported !== "boolean" || !String(item.reason || "").trim()))
          throw invalid("Đối chiếu độ phủ cảnh thiếu quan sát nguồn hợp lệ.");
      };
      onProgress({ message: `Xác minh phần hình hỗ trợ bị cắt, chương ${part.index + 1}: ${part.candidates.length} sự kiện; chưa tạo lại TTS...` });
      const raw = await ai.runVertexCall({ filePaths: [filePath], responseSchema: schema, validateResult: validate,
        modelOverride: ai.getAnalysisModel(), signal, onProgress, videoFps: 4, requestTimeoutMs: { flash: 120000, pro: 240000 },
        prompt: ["Independently WATCH AND LISTEN to this SOURCE video to verify existing event ranges. Do not write narration or choose a target output length.",
          `The clip's local zero is absolute source ${part.chunk.sourceStartSec}s. Its burned clock shows source time.`,
          "The application already selected consecutive scene IDs for each event, but cropped away setup/context before its anchor image. Candidate start/end are CODE-CONTROLLED full bounds of ONLY those selected scenes, at most 24s. Never approve unrelated footage to fill a duration target.",
          "For EVERY ID: claim_supported confirms the supplied description actually occurs in that event range. context_supported confirms the ENTIRE candidate range depicts the SAME action/dialogue sequence, including genuinely supporting setup/development/reactions. Return false when an earlier scene depicts a different action/actor, creates false causality, includes an outro, or spoils a reveal that the narration needs to name only when visible. A nearby shot is not evidence just because it has spare duration.",
          "Judge each candidate by its actual source timestamps, not by list position. Give a concise reason identifying what you observed. Do not invent or move timestamps, force approvals, write a new story or use franchise canon.",
          `Candidates: ${JSON.stringify(part.candidates)}`].join("\n") });
      validate(raw); cache.parts[part.index] = Object.fromEntries(raw.observations.map(item => [item.event_id, item])); await persist();
    }
    const before = Editorial.planScope({ beats: [{ role: "body", visual_event_ids: state.visualEvents.map(event => event.id) }] }, state.visualEvents, options.targetDurationSec);
    const updates = new Map();
    for (const part of parts) for (const candidate of part.candidates) {
      const observed = cache.parts[part.index][candidate.id];
      if (!observed.claim_supported || !observed.context_supported) continue;
      const event = state.visualEvents.find(event => event.id === candidate.id);
      updates.set(event.id, { ...event, source_start: candidate.start, source_end: candidate.end, duration: candidate.end - candidate.start,
        supportAudit: { version: 1, originalRange: candidate.original, checkedRange: { start: candidate.start, end: candidate.end },
          sceneIds: candidate.scene_ids, reason: observed.reason } });
    }
    state.visualEvents = state.visualEvents.map(event => updates.get(event.id) || event);
    for (const analysis of Object.values(state.chunkAnalyses || {})) analysis.events = analysis.events.map(event => updates.get(event.id) || event);
    let restored = false;
    if (baseline && words(baseline.speechUnits) > words(state.speechUnits) * 1.05) {
      state.speechUnits = structuredClone(baseline.speechUnits); state.recapPlan = structuredClone(baseline.plan || baseline.recapPlan);
      restored = true;
    }
    cache.status = "completed"; cache.restored = restored; cache.approvedEvents = updates.size;
    cache.beforeSec = before.availableSec;
    cache.afterSec = Editorial.planScope({ beats: [{ role: "body", visual_event_ids: state.visualEvents.map(event => event.id) }] }, state.visualEvents, options.targetDurationSec).availableSec;
    await persist();
    onProgress({ message: `Độ phủ nguồn đã xác minh: ${before.availableSec.toFixed(1)} → ${cache.afterSec.toFixed(1)}s; ${updates.size} sự kiện có thêm hình hỗ trợ${restored ? "; khôi phục kịch bản trước khi rút gọn" : ""}.` });
    return { changed: updates.size > 0 || restored, available: true };
  }
}
module.exports = RecapScopeRecoveryService;
