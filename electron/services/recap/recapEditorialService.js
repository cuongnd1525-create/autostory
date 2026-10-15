const crypto = require("crypto");
const { validateRecapPlan, validateSpeechUnit } = require("./recapTypes");

const VERSION = 1;
const pick = (value, choices, fallback) => choices.includes(value) ? value : fallback;
function optionsFor(project = {}, settings = {}) {
  const get = (key, fallback) => settings[key] ?? project[key] ?? fallback;
  return {
    version: VERSION,
    targetDurationSec: Math.max(15, Math.min(600, Number(get("targetDurationSec", project.targetDuration || 60)) || 60)),
    preset: pick(get("recapPreset", "recap"), ["recap", "review", "explain"], "recap"),
    language: pick(get("recapNarrationLanguage", "en"), ["en", "vi"], "en"),
    style: pick(get("recapNarrationStyle", "natural"), ["natural", "suspense", "humorous", "cinematic"], "natural"),
    angle: get("viralAngleSetting", "auto"),
    viral: get("viralOptimization", true) !== false,
    retention: pick(get("retentionAggressiveness", "balanced"), ["safe", "balanced", "aggressive"], "balanced"),
    spoiler: get("spoilerControl", "balanced"),
    loop: get("loopEnding", true) !== false,
    selection: pick(get("recapEditorialSelection", "auto"), ["auto", "manual"], "auto"),
    selectedAngleId: get("recapSelectedAngleId", ""),
    selectedHookId: get("recapSelectedHookId", ""),
    aspect: pick(get("recapAspectRatio", "original"), ["original", "9:16"], "original"),
    framing: pick(get("recapFraming", "fit_blur"), ["fit_blur", "smart_crop"], "fit_blur"),
    captions: pick(get("recapCaptionStyle", "off"), ["off", "phrase", "karaoke"], "off")
  };
}
function fingerprint(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function narrativeKey(options) {
  const { aspect, framing, captions, selection, selectedHookId, selectedAngleId, ...content } = options;
  return fingerprint(content);
}
function requireRefs(refs, events, label) {
  const known = new Set(events.map((event) => event.id));
  if (!Array.isArray(refs) || !refs.length || refs.some((id) => !known.has(id))) throw new Error(`${label}: thiếu hoặc sai ID sự kiện nguồn.`);
  return [...new Set(refs)];
}
function validateAngles(raw, events) {
  if (!Array.isArray(raw?.angles) || raw.angles.length < 3 || raw.angles.length > 5) throw new Error("AI phải đề xuất 3–5 góc kể có bằng chứng nguồn.");
  const seen = new Set();
  return raw.angles.map((angle) => {
    if (!angle.id || seen.has(angle.id) || !angle.title || !angle.central_question || !angle.payoff) throw new Error("Góc kể thiếu nội dung hoặc trùng ID.");
    seen.add(angle.id);
    const score = Number(angle.score);
    if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error("Điểm góc kể phải từ 0 đến 10.");
    return { ...angle, score, event_ids: requireRefs(angle.event_ids, events, "Góc kể") };
  }).sort((a, b) => b.score - a.score);
}
function validateHooks(raw, events) {
  if (!Array.isArray(raw?.hooks) || raw.hooks.length !== 5) throw new Error("AI phải tạo đúng 5 hook để so sánh.");
  const seen = new Set();
  return raw.hooks.map((hook) => {
    if (!hook.id || seen.has(hook.id) || !String(hook.text || "").trim()) throw new Error("Hook thiếu lời kể hoặc trùng ID.");
    seen.add(hook.id);
    const score = Number(hook.score);
    if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error("Điểm hook phải từ 0 đến 10.");
    requireRefs([hook.payoff_event_id], events, "Payoff hook");
    return { ...hook, text: hook.text.trim(), score, event_ids: requireRefs(hook.event_ids, events, "Hook") };
  }).sort((a, b) => b.score - a.score);
}
function groundPlan(raw, events, hook) {
  const plan = validateRecapPlan(raw);
  requireRefs(plan.selected_event_ids, events, "Kế hoạch dựng");
  if (!plan.beats.length) throw new Error("Kế hoạch dựng không có nhịp kể.");
  const seen = new Set();
  plan.beats.forEach((beat) => {
    if (seen.has(beat.beat_id)) throw new Error("Kế hoạch có ID nhịp kể trùng nhau.");
    seen.add(beat.beat_id);
    requireRefs(beat.visual_event_ids, events, "Nhịp kể");
  });
  if (hook) {
    const body = plan.beats.filter((beat) => beat.role !== "hook" && beat.beat_id !== "opening_hook");
    plan.beats = [{ beat_id: "opening_hook", role: "hook", purpose: hook.text, visual_event_ids: hook.event_ids,
      must_preserve: hook.text, can_omit: "" }, ...body];
    plan.hook_event_ids = hook.event_ids;
    plan.selected_event_ids = [...new Set([...hook.event_ids, ...plan.selected_event_ids])];
    if (!body.some((beat) => beat.visual_event_ids.includes(hook.payoff_event_id))) throw new Error("Kế hoạch chưa giải đáp lời hứa của hook.");
  }
  return plan;
}
function fillPlanCoverage(plan, events, targetDurationSec) {
  const revised = structuredClone(plan), byId = new Map(events.map(event => [event.id, event]));
  const body = revised.beats.filter(beat => beat.role !== "hook");
  if (!body.length) return revised;
  const selected = new Set(body.flatMap(beat => beat.visual_event_ids));
  const coverage = ids => {
    const ranges = [...ids].map(id => byId.get(id)).filter(Boolean).sort((a, b) => a.source_start - b.source_start);
    let end = -Infinity, sum = 0;
    for (const event of ranges) { sum += Math.max(0, event.source_end - Math.max(end, event.source_start)); end = Math.max(end, event.source_end); }
    return sum;
  };
  const desired = Math.min(targetDurationSec * 1.12, coverage(new Set(byId.keys())));
  const added = [];
  for (const event of [...events].filter(event => !selected.has(event.id)).sort((a, b) => b.importance - a.importance || a.source_start - b.source_start)) {
    if (coverage(selected) >= desired) break;
    const before = coverage(selected); selected.add(event.id);
    if (coverage(selected) <= before) { selected.delete(event.id); continue; }
    const center = (event.source_start + event.source_end) / 2;
    const closest = [...body].sort((a, b) => {
      const distance = beat => Math.min(...beat.visual_event_ids.map(id => Math.abs(center - (byId.get(id).source_start + byId.get(id).source_end) / 2)));
      return distance(a) - distance(b);
    })[0];
    closest.visual_event_ids.push(event.id); added.push(event.id);
  }
  for (const beat of body) beat.visual_event_ids.sort((a, b) => byId.get(a).source_start - byId.get(b).source_start);
  body.sort((a, b) => byId.get(a.visual_event_ids[0]).source_start - byId.get(b.visual_event_ids[0]).source_start);
  revised.beats = [...revised.beats.filter(beat => beat.role === "hook"), ...body];
  revised.selected_event_ids = [...new Set(revised.beats.flatMap(beat => beat.visual_event_ids))];
  revised.coverageAdjustment = { addedEventIds: added, availableSec: coverage(selected), desiredSec: desired };
  return revised;
}
function beatBudgets(plan, events, wordsPerSecond = 2.5, hookDuration = 4) {
  const count = plan.beats.length;
  const spoken = Math.max(5, plan.target_duration_sec - count * 0.6);
  const byId = new Map(events.map((event) => [event.id, event]));
  const weights = plan.beats.map((beat) => Math.max(1, beat.visual_event_ids.reduce((sum, id) => {
    const event = byId.get(id); return sum + (event?.duration || Math.max(0, (event?.source_end || 0) - (event?.source_start || 0)) || 4);
  }, 0)));
  const hookIndex = plan.beats.findIndex((beat) => beat.role === "hook");
  const hookBudget = hookIndex >= 0 ? Math.min(hookDuration, spoken * 0.2) : 0;
  const bodyWeight = weights.reduce((sum, weight, index) => sum + (index === hookIndex ? 0 : weight), 0) || 1;
  return plan.beats.map((beat, index) => {
    const duration = index === hookIndex ? hookBudget : (spoken - hookBudget) * weights[index] / bodyWeight;
    return { ...beat, target_duration_budget: duration, target_word_count: Math.max(3, Math.floor(duration * wordsPerSecond * 0.94)),
      max_word_count: Math.max(4, Math.floor(duration * wordsPerSecond)) };
  });
}
function groundNarration(raw, events, plan, hook) {
  const units = (Array.isArray(raw) ? raw : raw?.speech_units || []).map(validateSpeechUnit);
  if (!units.length) throw new Error("AI không tạo lời kể.");
  const seen = new Set();
  units.forEach((unit) => {
    if (seen.has(unit.id)) throw new Error("ID lời kể bị trùng."); seen.add(unit.id);
    requireRefs(unit.visual_event_ids, events, "Lời kể");
    unit.clauses.forEach((clause) => requireRefs(clause.visual_event_ids, events, "Mệnh đề"));
    if (!plan.beats.some((beat) => beat.beat_id === unit.beat_id)) throw new Error("Lời kể tham chiếu nhịp dựng không tồn tại.");
  });
  if (hook) {
    const body = units.filter((unit) => unit.beat_id !== "opening_hook");
    return [validateSpeechUnit({ id: "opening_hook", beat_id: "opening_hook", text: hook.text,
      visual_event_ids: hook.event_ids, target_duration_budget: hook.durationSec || 4 }), ...body];
  }
  return units;
}
function durationGate(actual, target) {
  const min = target * 0.85, max = target * 1.05;
  const toleranceSec = 1 / 30; // Master timestamps are quantized to 30 fps.
  return { passed: Number.isFinite(actual) && actual >= min - toleranceSec && actual <= max + toleranceSec, actual, target, min, max, toleranceSec };
}
function qualityGate(review, localIssues = []) {
  const score = typeof review?.overall_score === "number" ? review.overall_score : NaN;
  const issues = [...(review?.issues || []), ...localIssues];
  const blockers = issues.filter((issue) => ["critical", "high"].includes(issue.severity));
  if (review && (!Array.isArray(review.issues) || review.issues.some((issue) => !["low", "medium", "high", "critical"].includes(issue.severity)))) blockers.push({ severity: "critical", type: "review_invalid", description: "Review thiếu danh sách lỗi hoặc mức độ lỗi hợp lệ." });
  if (!review || !Number.isFinite(score) || score < 0 || score > 1) blockers.push({ severity: "critical", type: "review_unverified", description: "Chưa xác minh được chất lượng draft." });
  else if (score < 0.7) blockers.push({ severity: "high", type: "quality_score", description: `Điểm review ${score.toFixed(2)} thấp hơn 0.70.` });
  return { passed: blockers.length === 0, score: Number.isFinite(score) ? score : null, issues, blockers };
}
module.exports = { VERSION, optionsFor, fingerprint, narrativeKey, validateAngles, validateHooks, groundPlan, groundNarration, fillPlanCoverage, beatBudgets, durationGate, qualityGate };
