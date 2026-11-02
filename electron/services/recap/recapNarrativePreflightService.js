const Editorial = require("./recapEditorialService");
const { RecapSyncSolver } = require("./recapSyncSolver");
const countWords = text => String(text || "").trim().split(/\s+/).filter(Boolean).length;

// Planning estimates only. Actual TTS/ASR and rendered-video review remain
// authoritative; a preflight result can never approve a final master.
class RecapNarrativePreflightService {
  estimate({ speechUnits, events, options, wordsPerSecond = 2.6, audioTracks = {}, includeGroups = false }) {
    let measuredWords = 0, measuredSeconds = 0;
    for (const unit of speechUnits) {
      const track = audioTracks[unit.id], seconds = Number(track?.durationSec ?? track?.duration);
      if (track?.text === unit.text && seconds > 0) { measuredWords += countWords(unit.text); measuredSeconds += seconds; }
    }
    const cadence = Math.max(.8, Math.min(5.2, measuredWords >= 30 ? measuredWords / measuredSeconds : Number(wordsPerSecond) || 2.6));
    const tracks = {};
    for (const unit of speechUnits) {
      const durationSec = Math.max(.3, countWords(unit.text) / cadence), groups = [];
      for (const clause of unit.clauses || []) {
        const refs = [...new Set(clause.visual_event_ids || [])], key = [...refs].sort().join("|");
        if (groups.at(-1)?.key === key) { groups.at(-1).text += ` ${clause.text}`; groups.at(-1).clauseIds.push(clause.clause_id); }
        else groups.push({ key, text: clause.text, clauseIds: [clause.clause_id], visual_event_ids: refs });
      }
      let cursor = 0;
      const words = groups.reduce((sum, group) => sum + countWords(group.text), 0) || 1;
      tracks[unit.id] = { durationSec, ...(groups.length > 1 ? { clauseSpans: groups.map(group => {
        const startSec = cursor; cursor += durationSec * countWords(group.text) / words;
        return { ...group, startSec, endSec: cursor };
      }) } : {}) };
    }
    const solved = new RecapSyncSolver({ allowShotReuse: options.allowShotReuse, logger: { log() {}, warn() {} } })
      .solve({ speechUnits, visualEvents: events, audioTracks: tracks });
    const wordCount = speechUnits.reduce((sum, unit) => sum + countWords(unit.text), 0);
    const duration = Editorial.durationGate(solved.metrics.totalTimelineDurationSec, options.targetDurationSec, { soft: true });
    return { estimated: true, cadenceSource: measuredWords >= 30 ? "cached_tts" : "voice_profile", wordsPerSecond: Number(cadence.toFixed(3)),
      wordCount, targetWordCount: Math.round(options.targetDurationSec * cadence), duration,
      sourceCoverage: Editorial.planScope({ beats: speechUnits.map(unit => ({ beat_id: unit.beat_id,
        role: unit.id === "opening_hook" ? "hook" : "body", visual_event_ids: unit.visual_event_ids })) }, events, options.targetDurationSec),
      clauseBudgets: solved.rewriteRecommendations.flatMap(item => item.clauseBudgets || []).filter(group => !group.passed),
      ...(includeGroups ? { clauseGroups: solved.clauseBudgets || [] } : {}) };
  }

  key({ speechUnits, events, recapPlan, options, voiceKey }) {
    return Editorial.fingerprint({ version: 2, speechUnits, events, recapPlan, narrative: Editorial.narrativeKey(options),
      allowShotReuse: options.allowShotReuse, voiceKey });
  }

  reuseVerifiedCoverage({ cached, speechUnits, recapPlan, beforeEvents, events, options, voiceKey, coverage, audioTracks, wordsPerSecond }) {
    if (!cached?.completed || coverage?.status !== "completed") return null;
    const beforeKey = this.key({ speechUnits, recapPlan, events: beforeEvents, options, voiceKey });
    if (cached.key !== beforeKey && cached.downstreamKey !== beforeKey) return null;
    const semantic = list => list.map(({ source_start, source_end, duration, supportAudit, ...event }) => event);
    if (Editorial.fingerprint(semantic(beforeEvents)) !== Editorial.fingerprint(semantic(events))) return null;
    const observed = Object.assign({}, ...Object.values(coverage.parts || {}));
    const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < .001;
    for (let i = 0; i < events.length; i++) {
      const old = beforeEvents[i], event = events[i];
      if (same(old.source_start, event.source_start) && same(old.source_end, event.source_end)) continue;
      const audit = event.supportAudit, observation = observed[event.id];
      if (!observation?.claim_supported || !observation.context_supported || audit?.version !== 1
        || !same(audit.originalRange?.start, old.source_start) || !same(audit.originalRange?.end, old.source_end)
        || !same(audit.checkedRange?.start, event.source_start) || !same(audit.checkedRange?.end, event.source_end)
        || event.source_start > old.source_start + .001 || event.source_end + .001 < old.source_end) return null;
    }
    // The exact script and actual source video were already reviewed. Only
    // independently approved supporting ranges grew; timing is estimated anew,
    // and the changed rendered video still requires a fresh audiovisual review.
    return { ...cached, downstreamKey: this.key({ speechUnits, recapPlan, events, options, voiceKey }),
      coverageRecoveryKey: coverage.key,
      after: this.estimate({ speechUnits, events, options, audioTracks, wordsPerSecond }) };
  }

  async run({ speechUnits, events, recapPlan, options, wordsPerSecond, audioTracks, voiceKey, sourceFiles = [], cached, ai, cancelToken, onProgress = () => {} }) {
    cancelToken?.signal?.throwIfAborted();
    const inputs = { speechUnits, events, recapPlan, options, voiceKey };
    const key = this.key(inputs);
    if (cached?.key === key && cached.rejectedScope) throw Object.assign(new Error(cached.reason), {
      kind: "scope_repair_rejected", preflightReport: cached, estimate: cached.rejectedEstimate
    });
    if (cached?.completed && (cached.key === key || cached.downstreamKey === key))
      return { speechUnits, recapPlan, report: cached, reused: true };
    const before = this.estimate({ ...inputs, wordsPerSecond, audioTracks });
    onProgress({ message: `Kiểm tra kịch bản trước TTS: ${before.wordCount} từ, dự kiến ${before.duration.actual.toFixed(0)}s; ưu tiên mạch kể và bằng chứng hình...` });
    const review = await ai.reviewNarration({ ...inputs, estimates: before, sourceFiles, cancelToken, onProgress });
    const valid = typeof review?.overall_score === "number" && Number.isFinite(review.overall_score)
      && review.overall_score >= 0 && review.overall_score <= 1 && Array.isArray(review.issues)
      && review.issues.every(issue => ["low", "medium", "high", "critical"].includes(issue.severity))
      && ["appropriate", "too_short", "too_long"].includes(review.duration_assessment?.verdict)
      && String(review.duration_assessment.reason || "").trim();
    const knownEvents = new Set(events.map(event => event.id)), knownUnits = new Set(speechUnits.map(unit => unit.id));
    if (!valid || !Array.isArray(review.recommended_additions)
      || !Array.isArray(review.duration_assessment.missing_event_ids)
      || review.duration_assessment.missing_event_ids.some(id => !knownEvents.has(id))
      || review.issues.some(issue => !Array.isArray(issue.speech_unit_ids) || issue.speech_unit_ids.some(id => !knownUnits.has(id)))
      || review.recommended_additions.some(item => !knownUnits.has(item.after_id) || !recapPlan.beats.some(beat => beat.beat_id === item.beat_id)
        || !item.event_ids?.length || item.event_ids.some(id => !knownEvents.has(id)) || !String(item.purpose || "").trim()))
      throw new Error("Kiểm tra kịch bản sớm thiếu bằng chứng hoặc tham chiếu nguồn hợp lệ.");
    const shouldRepair = review.overall_score < .8 || review.issues.some(issue => ["high", "critical"].includes(issue.severity))
      || review.duration_assessment.verdict !== "appropriate";
    if (shouldRepair) {
      onProgress({ message: "Đang sửa mạch kể, chi tiết chưa có bằng chứng và phần nội dung còn thiếu trước khi tạo giọng..." });
      const scopeRepair = before.duration.largeDeviation && review.duration_assessment.verdict === "too_short"
        && (review.duration_assessment.missing_event_ids.length > 0 || review.recommended_additions.length > 0);
      for (let attempt = 0; attempt < 2; attempt++) {
        cancelToken?.signal?.throwIfAborted();
        const revised = await ai.rewriteRecap({ events, recapPlan, speechUnits, options, cancelToken, onProgress,
          feedback: { patchOnly: !scopeRepair, forceScopeRepair: scopeRepair, qualityFirst: true, preflight: true, issues: review.issues, score: review.overall_score,
          summary: review.summary, estimatedTiming: before, durationPreference: before.duration, durationAssessment: review.duration_assessment,
          recommendedAdditions: review.recommended_additions, clauseBudgets: before.clauseBudgets,
          ...(options.targetDurationSec >= 300 ? { scopeGuard: { minimumDurationSec: options.targetDurationSec * .65 + 1,
            currentDurationSec: before.duration.actual, preserveSupportedStory: true, retryRejectedCompression: attempt > 0 } } : {}) } });
        const nextPlan = Editorial.groundPlan(revised.plan, events, options.hook);
        nextPlan.target_duration_sec = options.targetDurationSec;
        const nextUnits = Editorial.groundNarration(revised.speech_units, events, nextPlan, options.hook);
        const proposed = this.estimate({ speechUnits: nextUnits, events, options, wordsPerSecond: before.wordsPerSecond });
        const worsenedScope = Math.abs(proposed.duration.actual - options.targetDurationSec)
          > Math.abs(before.duration.actual - options.targetDurationSec) + 5;
        if (options.targetDurationSec >= 300 && proposed.duration.largeDeviation && (!before.duration.largeDeviation || worsenedScope)) {
          if (!attempt) { onProgress({ message: "Bản sửa làm mất quá nhiều phạm vi nội dung; giữ bản cũ và yêu cầu sửa cấu trúc một lần trước TTS..." }); continue; }
          const reason = `Chưa tạo TTS: bản sửa kịch bản dự kiến ${proposed.duration.actual.toFixed(0)}s cho mục tiêu ${options.targetDurationSec}s. Không thay bản kể ${before.duration.actual.toFixed(0)}s bằng bản rút ngắn quá mức; cần phân bổ lại nội dung có bằng chứng.`;
          throw Object.assign(new Error(reason), { kind: "scope_repair_rejected", estimate: proposed,
            preflightReport: { key, completed: false, rejectedScope: true, reason, rejectedEstimate: proposed, finalApproved: false } });
        }
        recapPlan = nextPlan; speechUnits = nextUnits; break;
      }
    }
    const after = this.estimate({ speechUnits, events, options, wordsPerSecond: before.wordsPerSecond, audioTracks });
    onProgress({ message: `Kịch bản sau kiểm tra: ${after.wordCount} từ, dự kiến ${after.duration.actual.toFixed(0)}s${after.clauseBudgets.length
      ? `; ${after.clauseBudgets.length} nhóm cần chú ý ngân sách hình` : ""}. Thời lượng và đồng bộ sẽ được đo lại bằng TTS thực tế.` });
    return { recapPlan, speechUnits, report: { key: this.key({ ...inputs, recapPlan, speechUnits }), completed: true,
      scope: "script_estimate_only", finalApproved: false, repaired: shouldRepair, review, before, after } };
  }
}
module.exports = RecapNarrativePreflightService;
