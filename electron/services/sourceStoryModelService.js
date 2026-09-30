// AutoStory v3 — Phase 1: the Source Story Model — the shared brain.
//
// Built ONCE per SOURCE (keyed by source hash + schema version), persisted, and
// reused across projects. Bounded output + MAX_TOKENS-aware recovery so a single
// whole-video JSON generation is never a single point of failure.
//   - build()      : cache -> whole-source (bounded) -> compact retry -> chunked+merge
//   - normalize()  : pure enrichment + DETERMINISTIC caps (testable)
//   - mergeSourceModels() : pure dedup/merge for chunked extraction (testable)
//   - load/persist : source-hash + modelVersion keyed cache.

const fs = require('fs/promises');
const path = require('path');
const { EPISTEMIC } = require('./autoStoryV3Taxonomy');

// Bump when the schema/shape materially changes so stale caches are cleanly missed.
const MODEL_VERSION = 6;
// Bump when the MAX_TOKENS recovery / classifier logic materially changes. Shown
// in the runtime fingerprint so we can PROVE which build the Electron process loaded.
const RECOVERY_VERSION = 3;

// Deterministic output caps (enforced in normalize regardless of what the model returns).
const MAX_PEOPLE = 24;
const MAX_EVENTS = 40;
const MAX_QUOTES = 60;
const MAX_QUOTES_PER_EVENT = 3;
const SUMMARY_MAX_WORDS = 14;
const QUOTE_MAX_CHARS = 240;

// Vertex output budgets (paired with the bounded schema — not a blind raise).
const WHOLE_MAX_OUTPUT_TOKENS = 32768;
const COMPACT_MAX_OUTPUT_TOKENS = 16384;
// Chunk output ceiling is sized to the SMALL chunk contract (see chunkSourceModel:
// few events/quotes per window), not the global model — so a normal window fits in
// one call without recursion.
const CHUNK_MAX_OUTPUT_TOKENS = 6144;
// Gemini 2.5 thinking tokens are drawn from maxOutputTokens. The Source Story Model
// is bounded, schema-constrained JSON extraction that does not need visible chain-of-
// thought, so we disable thinking (0, valid for gemini-2.5-flash) — otherwise reasoning
// tokens starve the JSON and cause false MAX_TOKENS truncations. This was the real
// root cause of the whole/compact overflow on long, dialogue-dense sources.
const SOURCE_MODEL_THINKING_BUDGET = 0;
const MAX_CHUNKS = 6;
const CHUNK_TARGET_SEC = 600;

// ---- long-source strategy + phase-budget knobs (explicit + testable) --------
// Sources longer than this go CHUNK-FIRST (skip whole+compact, which would likely
// blow the output limit and waste minutes) instead of the staged whole->compact->chunk.
const LONG_SOURCE_THRESHOLD_SEC = 1500;   // 25 min
// Chunk-first initial windows: small enough that a normal window extracts in ONE
// call without recursion. ~216s => ~8 windows for a ~1726s source.
const CHUNK_FIRST_TARGET_SEC = 216;
const CHUNK_FIRST_MIN_WINDOWS = 4;
const CHUNK_FIRST_MAX_WINDOWS = 12;
const CHUNK_MIN_WINDOW_SEC = 60;          // never plan an initial window smaller than this
// Phase budget: reserve calls for the pipeline steps that run AFTER the source model
// so recovery can't consume the whole run cap. Derived from the pipeline's OWN bounded
// loops, not a guess: Story Design (1) + per script [narration(1) + safeWords repairs(<=2)
// + gate repairs(<=2)] = 5.
const STORY_DESIGN_CALLS = 1;
// First-pass calls of the scope-media-director path (repairs draw on the shared remaining
// budget, like Story Design repairs did). Kept minimal so a long cache-MISS source still
// gets enough chunk-first windows under the default 16-call cap.
const SCOPE_SELECTION_CALLS = 1;
const DIRECTOR_CALLS_PER_SCRIPT = 1;
const NARRATION_CALLS_PER_SCRIPT = 5;
const SOURCE_MODEL_MIN_CALLS = 4;         // floor so a large outputCount can't starve extraction to 0
// Recursive-subdivision guards for a chunk that STILL hits MAX_TOKENS: keep
// halving the window until it fits, but stop at a deterministic floor so a
// pathological window cannot recurse forever. A leaf still failing at the floor
// FAILS the whole Source Story Model (no silent coverage holes).
const MIN_LEAF_SEC = 30;      // never subdivide below this window size
const MAX_SPLIT_DEPTH = 5;    // 600 -> 300 -> 150 -> 75 -> 37 -> (stop)
const COVERAGE_EPS = 0.5;     // seconds of float slack when asserting full coverage

// ---- pure enrichment -------------------------------------------------------

function clamp01(n) { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }
function firstWords(s, n) { return String(s || '').trim().split(/\s+/).filter(Boolean).slice(0, n).join(' '); }
function trimChars(s, n) { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n).trim() : t; }

function tensionForEvent(ev, audioEvents = []) {
  const base = clamp01(ev.tension);
  let peak = 0;
  for (const ae of audioEvents) {
    const s = Number(ae.startSec), e = Number.isFinite(ae.endSec) ? ae.endSec : s;
    if (!Number.isFinite(s)) continue;
    const overlaps = s <= (ev.endSec ?? ev.startSec) && e >= (ev.startSec ?? s);
    if (overlaps) peak = Math.max(peak, clamp01(ae.peak));
  }
  return clamp01(Math.max(base, 0.5 * base + 0.6 * peak));
}

function attachWordWindow(quote, words = []) {
  if (!Array.isArray(words) || !words.length) return quote;
  const within = words.filter(w => w.start >= quote.startSec - 0.25 && w.end <= quote.endSec + 0.25);
  if (!within.length) return quote;
  return { ...quote, wordStartSec: within[0].start, wordEndSec: within[within.length - 1].end, wordCount: within.length };
}

function eventImportance(e) { return (Number(e.tension) || 0) + (Number(e.dialogueImpact) || 0) * 0.5 + (Number(e.novelty) || 0) * 0.3; }

function normalize(raw = {}, ctx = {}) {
  const duration = Number(ctx.duration) || Number(raw.durationSec) || 0;
  const audioEvents = Array.isArray(ctx.audioEvents) ? ctx.audioEvents : (raw.audioEvents || []);
  const words = ctx.words || [];

  const people = (raw.people || []).slice(0, MAX_PEOPLE).map((p, i) => ({
    id: p.id || `p${i + 1}`,
    label: String(p.label || 'Unknown').trim(),
    role: p.role || 'unknown',
    firstSeenSec: Number.isFinite(p.firstSeenSec) ? p.firstSeenSec : null
  }));

  // Events: keep the most editorially important, capped, then chronological.
  let events = (raw.events || [])
    .filter(e => Number.isFinite(e.startSec) && Number.isFinite(e.endSec) && e.endSec > e.startSec)
    .map(e => ({
      id: e.id,
      startSec: e.startSec,
      endSec: Math.min(e.endSec, duration || e.endSec),
      type: (e.type || 'event').toString().trim().slice(0, 40),
      location: trimChars(e.location, 40),
      summary: firstWords(e.summary, SUMMARY_MAX_WORDS),
      peopleIds: Array.isArray(e.peopleIds) ? e.peopleIds.slice(0, 8) : [],
      tension: tensionForEvent(e, audioEvents),
      visualQuality: clamp01(e.visualQuality ?? 0.6),
      novelty: clamp01(e.novelty ?? 0.5),
      dialogueImpact: clamp01(e.dialogueImpact ?? 0),
      causalParents: Array.isArray(e.causalParents) ? e.causalParents : [],
      isReveal: e.isReveal === true,
      spoilsEventId: e.spoilsEventId || null,
      audioType: e.audioType || 'uncertain',
      audioConfidence: clamp01(e.audioConfidence)
    }));
  events.sort((a, b) => eventImportance(b) - eventImportance(a));
  events = events.slice(0, MAX_EVENTS);
  events.forEach((e, i) => { if (!e.id) e.id = `e${i + 1}`; });
  events.sort((a, b) => a.startSec - b.startSec);

  // Quotes: editorialValue-ranked, bounded per-event then global, chronological.
  let quotes = (raw.quotes || [])
    .filter(q => Number.isFinite(q.startSec) && Number.isFinite(q.endSec))
    .map((q, i) => ({
      id: q.id || `q${i + 1}`,
      eventId: q.eventId || null,
      speaker: q.speaker || null,
      text: trimChars(q.text, QUOTE_MAX_CHARS),
      startSec: q.startSec,
      endSec: q.endSec,
      epistemic: EPISTEMIC.includes(q.epistemic) ? q.epistemic : 'unknown',
      editorialValue: clamp01(q.editorialValue ?? q.impact ?? 0.5)
    }));
  // per-event cap (keep highest editorialValue)
  const perEvent = new Map();
  quotes.sort((a, b) => b.editorialValue - a.editorialValue);
  quotes = quotes.filter(q => {
    const key = q.eventId || `__free_${q.startSec}`;
    const n = perEvent.get(key) || 0;
    if (q.eventId && n >= MAX_QUOTES_PER_EVENT) return false;
    perEvent.set(key, n + 1);
    return true;
  }).slice(0, MAX_QUOTES);
  quotes.sort((a, b) => a.startSec - b.startSec);
  quotes = quotes.map(q => attachWordWindow(q, words));

  const tensionCurve = events.slice().sort((a, b) => a.startSec - b.startSec).map(e => ({ atSec: e.startSec, tension: e.tension }));

  return {
    artifactType: 'auto_story_source_model',
    modelVersion: MODEL_VERSION,
    sourceId: ctx.sourceId || raw.sourceId || null,
    durationSec: duration,
    people, events, quotes, audioEvents, tensionCurve,
    visualQuality: events.map(e => ({ atSec: e.startSec, quality: e.visualQuality }))
  };
}

// ---- merge / dedup for chunked extraction (pure) ---------------------------

function normText(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
function overlapRatio(a, b) {
  const s = Math.max(a.startSec, b.startSec), e = Math.min(a.endSec, b.endSec);
  const ov = Math.max(0, e - s);
  const min = Math.max(0.001, Math.min(a.endSec - a.startSec, b.endSec - b.startSec));
  return ov / min;
}
function similarSummary(a, b) {
  const A = new Set(normText(a).split(' ').filter(Boolean)), B = new Set(normText(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return false;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter) >= 0.5;
}

// Merge several (chunk) raw models into one, re-id'ing and de-duplicating.
function mergeSourceModels(models = []) {
  const events = [], quotes = [], people = [];
  for (const m of models) {
    const map = new Map();
    for (const e of (m.events || [])) { const nid = `e${events.length + 1}`; if (e.id) map.set(e.id, nid); events.push({ ...e, id: nid }); }
    for (const q of (m.quotes || [])) quotes.push({ ...q, id: `q${quotes.length + 1}`, eventId: (q.eventId && map.get(q.eventId)) || null });
    for (const p of (m.people || [])) people.push(p);
  }
  // dedup events by time-overlap + similar summary (keep higher tension)
  const dedupEvents = [];
  for (const e of events.slice().sort((a, b) => a.startSec - b.startSec)) {
    if (!Number.isFinite(e.startSec) || !Number.isFinite(e.endSec) || e.endSec <= e.startSec) continue;
    const dup = dedupEvents.find(x => overlapRatio(x, e) > 0.6 && similarSummary(x.summary, e.summary));
    if (dup) { if ((Number(e.tension) || 0) > (Number(dup.tension) || 0)) Object.assign(dup, e, { id: dup.id }); continue; }
    dedupEvents.push(e);
  }
  // dedup quotes by near-time + same text
  const dedupQuotes = [];
  for (const q of quotes.slice().sort((a, b) => a.startSec - b.startSec)) {
    if (!Number.isFinite(q.startSec)) continue;
    const dup = dedupQuotes.find(x => Math.abs(x.startSec - q.startSec) < 1.5 && normText(x.text) === normText(q.text));
    if (!dup) dedupQuotes.push(q);
  }
  // dedup people by label
  const seen = new Set(); const dedupPeople = [];
  for (const p of people) { const k = String(p.label || '').toLowerCase(); if (!k || seen.has(k)) continue; seen.add(k); dedupPeople.push(p); }
  return { people: dedupPeople, events: dedupEvents, quotes: dedupQuotes };
}

// ---- persistence -----------------------------------------------------------

function modelPath(cacheDir) { return path.join(cacheDir, 'story-model.json'); }

async function loadWithReason(cacheDir) {
  let raw;
  try { raw = JSON.parse(await fs.readFile(modelPath(cacheDir), 'utf8')); }
  catch (_) { return { model: null, reason: 'no cached story-model.json' }; }
  if (raw?.modelVersion !== MODEL_VERSION) return { model: null, reason: `schema version ${raw?.modelVersion} != ${MODEL_VERSION}` };
  if (!Array.isArray(raw.events) || !raw.events.length) return { model: null, reason: 'cached model has no events' };
  return { model: raw, reason: 'hit' };
}
async function load(cacheDir) { return (await loadWithReason(cacheDir)).model; }
// Cache-first lookup keyed by the STABLE ORIGINAL source hash (engine.cache path
// already embeds sha256(original source) + modelVersion — never the prepared
// proxy). Lets the pipeline resolve a HIT and skip whole-source media preparation
// and the Vertex call entirely.
async function loadCached(engine) {
  const { model } = await loadWithReason(engine.cache);
  return model || null;
}

async function persist(cacheDir, model) {
  await fs.mkdir(cacheDir, { recursive: true });
  const file = modelPath(cacheDir);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(model, null, 2));
  await fs.rename(tmp, file);
  return file;
}

// ---- MAX_TOKENS / recovery classification ----------------------------------

// Recognize a MAX_TOKENS / truncated-generation condition in the REAL shapes the
// live Vertex + stage layer produces. The stage rethrows a localized Error whose
// message contains "(MAX_TOKENS)"; some layers also set a flag / finishReason /
// code. Message match is the reliable signal today; the property checks make this
// robust to future rethrows that drop the word from the message.
function isMaxTokensError(err) {
  if (!err) return false;
  if (err.maxTokens === true) return true;
  if (/MAX_TOKENS/i.test(String(err.finishReason || err.reason || ''))) return true;
  if (/MAX_TOKENS/i.test(String(err.storyCode || err.code || ''))) return true;
  return /MAX_TOKENS/i.test(String(err.message || ''));
}
const isMaxTokens = isMaxTokensError; // back-compat alias

function isRecoverable(err) {
  // MAX_TOKENS is ALWAYS recoverable — that is the entire purpose of the
  // compact -> chunk fallback. Check it FIRST so the real localized message
  // (which happens to contain BOTH "giới hạn" and, in a later clause, "yêu cầu")
  // is never swallowed by the non-recoverable filter below. This exact collision
  // was why the live run aborted while the mocked unit test passed.
  if (isMaxTokensError(err)) return true;
  const m = String(err?.message || '');
  // Genuinely non-recoverable: input-access, quota/budget, rate-limit, abort.
  // "giới hạn[^.]*yêu cầu" is anchored to a single clause so it cannot span
  // sentences into an unrelated "...gửi lại cùng yêu cầu." tail.
  if (/INPUT_ACCESS|truy cập|budget|ngân sách|429|quá tải|giới hạn[^.]*yêu cầu|Aborted|abort/i.test(m)) return false;
  return /không hoàn tất|không chứa JSON|không hợp lệ|bị cắt|truncat|Unexpected|Unterminated|INVALID_RESPONSE|no events|has no events/i.test(m);
}
function short(err) { return String(err?.message || err || '').slice(0, 120); }

// Runtime fingerprint — logged so we can PROVE the Electron process loaded THIS
// build (repeated "fixed but behaves like old code" reports otherwise).
function fingerprint() {
  return {
    sourceModelVersion: MODEL_VERSION, recoveryVersion: RECOVERY_VERSION,
    maxEvents: MAX_EVENTS, maxQuotes: MAX_QUOTES, maxPeople: MAX_PEOPLE,
    wholeMaxOutputTokens: WHOLE_MAX_OUTPUT_TOKENS, compactMaxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS,
    chunkMaxOutputTokens: CHUNK_MAX_OUTPUT_TOKENS, thinkingBudget: SOURCE_MODEL_THINKING_BUDGET, recoveryEnabled: true
  };
}

// ---- the whole-source understanding pass (Phase 0) -------------------------

function validateRaw(v) {
  require('./autoStorySourceGates').access(v);
  if (!Array.isArray(v.events) || !v.events.length) {
    throw new (require('./autoStoryRepairRouter').StoryError)('INVALID_RESPONSE', 'Source model has no events.');
  }
}

// Chunk extraction IS multimodal, so the media-access gate STAYS (Bug 2: a chunk
// that returns accessGranted!==true is a real INPUT_ACCESS failure and must not be
// silently accepted). Unlike the whole/compact pass, a single sub-window may
// legitimately contain no state-changing moment, so an EMPTY events array is
// allowed here — the window was still watched and counts toward coverage.
function validateChunk(v) {
  require('./autoStorySourceGates').access(v);
  if (!Array.isArray(v.events)) {
    throw new (require('./autoStoryRepairRouter').StoryError)('INVALID_RESPONSE', 'Chunk response missing events array.');
  }
}

async function askModel(engine, key, input, schema, instruction, evidence, options = {}, validate = validateRaw) {
  return engine.ask(key, input, schema, instruction, evidence, validate, 'auto_story_plan',
    { recoverValidatedArtifact: true, ...options });
}

const round1 = n => Math.round(n * 10) / 10;
async function persistDiag(cacheDir, diag) {
  try { await fs.mkdir(cacheDir, { recursive: true }); await fs.writeFile(path.join(cacheDir, 'chunk-coverage.json'), JSON.stringify(diag, null, 2)); } catch (_) {}
}

// ---- strategy selection + phase budget + chunk-first planning --------------
// The whole run shares ONE request budget (callBudget.calls capped at `limit`,
// default vertexAutoStoryMaxCalls || 16). The Source Story Model gets a PHASE
// budget carved out of it (reserving downstream calls), and — for long sources —
// goes CHUNK-FIRST with small windows so a normal window extracts in one call.
// Recursion is an emergency fallback for the odd token-dense window, NOT the plan.
function callLimit(service) {
  return Math.max(1, Math.min(100, Number(service?.settings?.vertexAutoStoryMaxCalls) || 16));
}
// Downstream calls the run still needs AFTER the source model, derived from the
// pipeline's own bounded loops (not a guess).
function downstreamReserve(config) {
  const outputCount = Math.max(1, Number(config?.outputCount) || 1);
  // Scope-media-director path: one Story Scope selection, then per script one director
  // EDL call (replacing Story Design) plus the narration calls.
  if (config?.editorialArchitecture === 'scope_media_director') {
    return SCOPE_SELECTION_CALLS + outputCount * (DIRECTOR_CALLS_PER_SCRIPT + NARRATION_CALLS_PER_SCRIPT);
  }
  return STORY_DESIGN_CALLS + outputCount * NARRATION_CALLS_PER_SCRIPT;
}
// The request budget split for this run.
function requestBudgetPlan(engine) {
  const cb = engine.service?.callBudget;
  if (!cb) return { unbounded: true, global: Infinity, downstreamReserved: 0, sourceModelLimit: Infinity };
  const global = callLimit(engine.service);
  const downstreamReserved = downstreamReserve(engine.config);
  const sourceModelLimit = Math.max(SOURCE_MODEL_MIN_CALLS, Math.min(global, global - downstreamReserved));
  return { unbounded: false, global, downstreamReserved, sourceModelLimit };
}
// Duration- and history-aware strategy. Long sources (or a source that already
// proved whole+compact overflow at this model version) go straight to chunk-first.
function selectStrategy(duration, priorDiag) {
  if (priorDiag && priorDiag.modelVersion === MODEL_VERSION && priorDiag.whole === 'MAX_TOKENS' && priorDiag.compact === 'MAX_TOKENS') {
    return { mode: 'chunk-first', reason: 'prior-max-tokens' };
  }
  if (duration > LONG_SOURCE_THRESHOLD_SEC) return { mode: 'chunk-first', reason: 'long-source' };
  return { mode: 'staged', reason: 'short-source' };
}
// Plan SMALL initial windows for chunk-first. Feasible iff the flat pass fits the
// remaining source-model budget (splits are handled live, not pre-reserved as a
// full binary tree — that adversarial gate made long sources impossible).
function planChunkWindows(duration, budgetRemaining) {
  let W = Math.round(duration / CHUNK_FIRST_TARGET_SEC);
  W = Math.max(CHUNK_FIRST_MIN_WINDOWS, Math.min(CHUNK_FIRST_MAX_WINDOWS, W));
  W = Math.min(W, Math.max(1, Math.floor(duration / CHUNK_MIN_WINDOW_SEC)));
  W = Math.max(1, W);
  const feasible = !Number.isFinite(budgetRemaining) ? true : W <= budgetRemaining;
  const splitReserve = Number.isFinite(budgetRemaining) ? Math.max(0, budgetRemaining - W) : Infinity;
  return { feasible, initialWindows: W, windowSec: round1(duration / W), splitReserve, budgetRemaining: Number.isFinite(budgetRemaining) ? budgetRemaining : null };
}
// Live phase-budget guard shared across whole/compact/chunk source-model calls.
function makePhase(engine, sourceModelLimit) {
  const cb = engine.service?.callBudget;
  const start = cb ? cb.calls : 0;
  const bounded = !!cb && Number.isFinite(sourceModelLimit);
  return {
    bounded, limit: sourceModelLimit, start,
    used: () => (cb ? cb.calls - start : 0),
    remaining: () => bounded ? Math.max(0, sourceModelLimit - (cb.calls - start)) : Infinity,
    exhausted: () => bounded ? (cb.calls - start) >= sourceModelLimit : false
  };
}
// --- lightweight extraction-STRATEGY diagnostic cache (NOT the story-model) ----
// Remembers, per source hash + model version, that whole/compact already overflowed
// so a retry resumes chunk-first instead of re-spending minutes on known failures.
function strategyDiagPath(cacheDir) { return path.join(cacheDir, 'extraction-strategy.json'); }
async function loadStrategyDiag(cacheDir) {
  try { const d = JSON.parse(await fs.readFile(strategyDiagPath(cacheDir), 'utf8')); return d && typeof d === 'object' ? d : null; } catch (_) { return null; }
}
async function recordStrategyDiag(cacheDir, patch) {
  let cur = await loadStrategyDiag(cacheDir);
  if (!cur || cur.modelVersion !== MODEL_VERSION) cur = { modelVersion: MODEL_VERSION };
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  try { await fs.mkdir(cacheDir, { recursive: true }); await fs.writeFile(strategyDiagPath(cacheDir), JSON.stringify(next, null, 2)); } catch (_) {}
  return next;
}

// Convert 0-based chunk-relative timestamps to absolute source timestamps.
function makeChunkAbsolute(raw, windowStartSec, windowEndSec) {
  if (!raw || typeof raw !== 'object') return raw;
  const start = Number(windowStartSec) || 0;
  const end = Number(windowEndSec) || 0;
  const dur = end - start;
  if (start <= 0) return raw;

  const events = (raw.events || []).map(e => {
    let s = Number(e.startSec);
    let eSec = Number(e.endSec);
    if (!Number.isFinite(s)) s = 0;
    if (!Number.isFinite(eSec)) eSec = s;
    if (s < start - 1.0 && s <= dur + 2.0) {
      s = Math.min(end, start + s);
      eSec = Math.min(end, start + eSec);
    }
    return { ...e, startSec: round1(s), endSec: round1(eSec) };
  });

  const quotes = (raw.quotes || []).map(q => {
    let s = Number(q.startSec);
    let eSec = Number(q.endSec);
    if (!Number.isFinite(s)) s = 0;
    if (!Number.isFinite(eSec)) eSec = s;
    if (s < start - 1.0 && s <= dur + 2.0) {
      s = Math.min(end, start + s);
      eSec = Math.min(end, start + eSec);
    }
    return { ...q, startSec: round1(s), endSec: round1(eSec) };
  });

  return { ...raw, events, quotes };
}

// Extract ONE window. On MAX_TOKENS, recursively subdivide into two halves and
// extract each, until the window fits OR the deterministic floor is reached.
// A leaf still hitting MAX_TOKENS at the floor, or any non-MAX_TOKENS failure
// (e.g. INPUT_ACCESS), THROWS — the caller must not proceed with a coverage hole.
// Every successfully-extracted leaf's full duration is added to diag.coverageSeconds.
async function extractWindow(engine, schema, instruction, audioEvents, emit, start, end, depth, diag, phase, chunkInput = {}) {
  const dur = end - start;
  // Live phase-budget guard: never exceed the Source Story Model's carved-out call
  // ceiling (which itself sits under the run cap). Pre-empt stage()'s generic
  // "Đã đạt giới hạn ... yêu cầu" error with a clean, specific one and record the
  // shortfall, so a run dies (if at all) with a diagnosable cause and no partial model.
  if (phase && phase.exhausted()) {
    diag.failedLeafWindows.push({ start: round1(start), end: round1(end), depth, reason: `source-model phase budget ${phase.limit} exhausted` });
    throw new (require('./autoStoryRepairRouter').StoryError)('SOURCE_MODEL_RECOVERY_BUDGET',
      `Source Story Model recovery hit its phase budget (${phase.limit} calls) before covering ${round1(start)}-${round1(end)}s; refusing to build a partial model.`);
  }
  diag.requestedWindows.push({ start: round1(start), end: round1(end), depth });
  diag.maxSplitDepth = Math.max(diag.maxSplitDepth, depth);
  const label = `${round1(start)}-${round1(end)}s${depth ? ` d${depth}` : ''}`;
  emit(`[V3] Chunked extraction window ${label}.`);
  emit(`[V3] Source Model Vertex options: maxOutputTokens=${CHUNK_MAX_OUTPUT_TOKENS} thinkingBudget=${SOURCE_MODEL_THINKING_BUDGET} strategy=chunk`);
  const evidence = await engine.prepare([{ sourceStartSec: start, sourceEndSec: end }], 0, 4);
  const cues = (engine.cues || []).filter(c => c.endSec > start && c.startSec < end);
  const ae = (audioEvents || []).filter(a => Number(a.startSec) < end && (Number.isFinite(a.endSec) ? a.endSec : Number(a.startSec)) > start);
  const key = `v3-source-model_chunk_${round1(start)}_${round1(end)}${depth ? `_d${depth}` : ''}`.replace(/\./g, '-');
  try {
    const raw = await askModel(engine, key,
      { windowStartSec: start, windowEndSec: end, transcript: cues, audioEvents: ae, epistemicValues: EPISTEMIC,
        maxEvents: chunkInput.maxEvents, maxQuotes: chunkInput.maxQuotes },
      schema, instruction, evidence, { maxOutputTokens: CHUNK_MAX_OUTPUT_TOKENS, thinkingBudget: SOURCE_MODEL_THINKING_BUDGET }, validateChunk);
    const abs = makeChunkAbsolute(raw, start, end);
    diag.successfulLeafWindows.push({ start: round1(start), end: round1(end), depth, events: (abs.events || []).length });
    diag.coverageSeconds += dur;
    return [abs];
  } catch (err) {
    if (isMaxTokensError(err)) {
      const canSplit = (dur / 2) >= MIN_LEAF_SEC && depth < MAX_SPLIT_DEPTH;
      if (canSplit) {
        const mid = start + dur / 2;
        emit(`[V3] Window ${label} hit MAX_TOKENS; subdividing into ${round1(start)}-${round1(mid)}s and ${round1(mid)}-${round1(end)}s.`, 'WARNING');
        const left = await extractWindow(engine, schema, instruction, audioEvents, emit, start, mid, depth + 1, diag, phase, chunkInput);
        const right = await extractWindow(engine, schema, instruction, audioEvents, emit, mid, end, depth + 1, diag, phase, chunkInput);
        return [...left, ...right];
      }
      diag.failedLeafWindows.push({ start: round1(start), end: round1(end), depth, reason: 'MAX_TOKENS at minimum leaf' });
      throw new (require('./autoStoryRepairRouter').StoryError)('SOURCE_MODEL',
        `Source model window ${round1(start)}-${round1(end)}s (${round1(dur)}s) still hit MAX_TOKENS at the minimum leaf size; cannot guarantee full source coverage.`);
    }
    // Non-MAX_TOKENS failure (INPUT_ACCESS, malformed, etc.): a coverage hole we
    // will NOT paper over. Record and fail the whole extraction.
    diag.failedLeafWindows.push({ start: round1(start), end: round1(end), depth, reason: short(err) });
    throw err;
  }
}

// Chunked extraction with recursive subdivision + STRICT coverage enforcement.
// Refuses to merge/persist unless coverageRatio == 1.0 (every second of source is
// represented by a successfully-extracted leaf window). Diagnostics are persisted
// even on failure so a bad run is inspectable.
async function chunkedExtract(engine, schema, instruction, ctx, audioEvents, emit, opts = {}) {
  const duration = engine.duration;
  const budget = opts.budget || requestBudgetPlan(engine);
  const phase = opts.phase || makePhase(engine, budget.sourceModelLimit);
  const windowPlan = opts.windowPlan || planChunkWindows(duration, phase.remaining());
  // Small per-window output contract derived from the global caps / window count
  // (with a modest safety surplus) — a chunk need not reproduce the full 40/60 model.
  const perWindowEvents = Math.min(MAX_EVENTS, Math.ceil(MAX_EVENTS / windowPlan.initialWindows) + 3);
  const perWindowQuotes = Math.min(MAX_QUOTES, Math.ceil(MAX_QUOTES / windowPlan.initialWindows) + 4);
  const diag = { sourceDuration: round1(duration), mode: opts.mode || 'chunk', strategyReason: opts.strategyReason || null,
    global: budget.unbounded ? null : budget.global, sourceModelLimit: phase.bounded ? phase.limit : null,
    downstreamReserved: budget.unbounded ? null : budget.downstreamReserved,
    plannedInitialWindows: windowPlan.initialWindows, windowSec: windowPlan.windowSec, splitReserve: Number.isFinite(windowPlan.splitReserve) ? windowPlan.splitReserve : null,
    perWindowEvents, perWindowQuotes, feasible: windowPlan.feasible,
    requestedWindows: [], successfulLeafWindows: [], failedLeafWindows: [], coverageSeconds: 0, coverageRatio: 0, maxSplitDepth: 0 };

  // FAIL EARLY when we cannot even attempt the (small) initial windows within the
  // source-model phase budget. Never silently reduce coverage.
  if (!windowPlan.feasible) {
    await persistDiag(engine.cache, diag);
    emit(`[V3] Source Story Model recovery INFEASIBLE: ${windowPlan.initialWindows} initial window(s) needed but only ${windowPlan.budgetRemaining} source-model call(s) remain. Raise vertexAutoStoryMaxCalls or reduce outputCount.`, 'ERROR');
    throw new (require('./autoStoryRepairRouter').StoryError)('SOURCE_MODEL_RECOVERY_BUDGET',
      `Cannot cover ${round1(duration)}s: needs ${windowPlan.initialWindows} initial windows but only ${windowPlan.budgetRemaining} source-model calls remain (limit ${phase.limit}). Raise vertexAutoStoryMaxCalls or reduce outputCount.`);
  }
  emit(`[V3] Chunk plan: ${windowPlan.initialWindows} initial window(s) x ${windowPlan.windowSec}s, splitReserve=${Number.isFinite(windowPlan.splitReserve) ? windowPlan.splitReserve : 'unbounded'}, perWindow<=${perWindowEvents}ev/${perWindowQuotes}q, phaseBudget=${phase.bounded ? phase.limit : 'unbounded'}.`);

  const topChunks = windowPlan.initialWindows;
  const size = duration / topChunks;
  const chunkInput = { maxEvents: perWindowEvents, maxQuotes: perWindowQuotes };
  const models = [];
  try {
    for (let i = 0; i < topChunks; i++) {
      const start = i * size, end = i === topChunks - 1 ? duration : (i + 1) * size;
      const part = await extractWindow(engine, schema, instruction, audioEvents, emit, start, end, 0, diag, phase, chunkInput);
      models.push(...part);
    }
  } finally {
    diag.coverageSeconds = round1(diag.coverageSeconds);
    diag.coverageRatio = duration > 0 ? Math.round((diag.coverageSeconds / duration) * 1000) / 1000 : 0;
    await persistDiag(engine.cache, diag);
    emit(`[V3] Chunk coverage: ${diag.coverageSeconds}/${round1(duration)}s (ratio=${diag.coverageRatio}), leaves ok=${diag.successfulLeafWindows.length} failed=${diag.failedLeafWindows.length}, maxSplitDepth=${diag.maxSplitDepth}`,
      diag.coverageRatio >= 1 - (COVERAGE_EPS / Math.max(1, duration)) ? undefined : 'WARNING');
  }
  // Hard gate: no partial Source Story Model. Require full coverage before merge.
  if (duration - diag.coverageSeconds > COVERAGE_EPS) {
    throw new (require('./autoStoryRepairRouter').StoryError)('SOURCE_MODEL',
      `Incomplete source coverage: ${diag.coverageSeconds}/${round1(duration)}s (ratio=${diag.coverageRatio}). Refusing to persist a Source Story Model with holes.`);
  }
  if (!models.length) {
    throw new (require('./autoStoryRepairRouter').StoryError)('SOURCE_MODEL', 'Chunked source extraction produced no usable windows.');
  }
  return normalize(mergeSourceModels(models), ctx);
}

// engine: an autoStorySourceEngine.Engine instance.
// overview: the whole-source proxy for staged whole/compact — a prepared clip array
//   OR a thunk `() => Promise<clips>` so chunk-first can SKIP whole-source prep entirely.
async function build(engine, overview, { audioEvents = [], words = [], schema, compactSchema, chunkSchema, instruction, compactInstruction, chunkInstruction } = {}) {
  const emit = (m, level) => { try { engine.onProgress?.({ stage: 'understand', message: m, ...(level ? { level } : {}) }); } catch (_) {} };
  const cacheDir = engine.cache;
  const ctx = { duration: engine.duration, audioEvents, words, sourceId: engine.sourceHash };
  const baseInput = { duration: engine.duration, transcript: engine.cues, audioEvents, epistemicValues: EPISTEMIC };
  const getOverview = typeof overview === 'function' ? overview : (() => overview);

  // Runtime fingerprint — prove which build is executing.
  const fp = fingerprint();
  emit(`[V3] Runtime build: sourceModelVersion=${fp.sourceModelVersion} recoveryVersion=${fp.recoveryVersion} MAX_EVENTS=${fp.maxEvents} MAX_QUOTES=${fp.maxQuotes} wholeMaxOutputTokens=${fp.wholeMaxOutputTokens} thinkingBudget=${fp.thinkingBudget} recoveryEnabled=${fp.recoveryEnabled}`);

  // Cache: same source hash + same schema version => reuse, no Vertex call.
  const { model: cached, reason } = await loadWithReason(cacheDir);
  if (cached) {
    emit('[V3] Source Story Model cache HIT');
    await engine.metric('v3-source-model', { cached: true }).catch(() => {});
    return cached;
  }
  emit(`[V3] Source Story Model cache MISS: reason=${reason}`);

  // Phase budget + duration/history-aware strategy.
  const budget = requestBudgetPlan(engine);
  emit(`[V3] Request budget: global=${budget.unbounded ? 'unbounded' : budget.global} sourceModelLimit=${budget.unbounded ? 'unbounded' : budget.sourceModelLimit} downstreamReserved=${budget.unbounded ? 0 : budget.downstreamReserved}`);
  const priorDiag = await loadStrategyDiag(cacheDir);
  const strat = selectStrategy(engine.duration, priorDiag);
  emit(`[V3] Source Model strategy selected: mode=${strat.mode} sourceDuration=${round1(engine.duration)} reason=${strat.reason}`);
  const phase = makePhase(engine, budget.sourceModelLimit);

  // STAGED (short sources): whole -> compact, each recorded so a later retry can skip
  // known-overflowing strategies and resume chunk-first.
  if (strat.mode === 'staged') {
    if (!phase.exhausted()) {
      try {
        emit(`[V3] Source Model Vertex options: maxOutputTokens=${WHOLE_MAX_OUTPUT_TOKENS} thinkingBudget=${SOURCE_MODEL_THINKING_BUDGET} strategy=whole`);
        const raw = await askModel(engine, 'v3-source-model', baseInput, schema, instruction, await getOverview(), { maxOutputTokens: WHOLE_MAX_OUTPUT_TOKENS, thinkingBudget: SOURCE_MODEL_THINKING_BUDGET });
        const model = normalize(raw, ctx);
        await persist(cacheDir, model);
        return model;
      } catch (err) {
        if (!isRecoverable(err)) throw err;
        if (isMaxTokensError(err)) await recordStrategyDiag(cacheDir, { whole: 'MAX_TOKENS' });
        emit(isMaxTokensError(err)
          ? `[V3] Source Story Model whole extraction hit MAX_TOKENS; switching to compact (${short(err)}).`
          : `[V3] Source Story Model incomplete output; switching to compact (${short(err)}).`, 'WARNING');
      }
    }
    if (compactSchema && compactInstruction && !phase.exhausted()) {
      try {
        emit(`[V3] Source Model Vertex options: maxOutputTokens=${COMPACT_MAX_OUTPUT_TOKENS} thinkingBudget=${SOURCE_MODEL_THINKING_BUDGET} strategy=compact`);
        const raw = await askModel(engine, 'v3-source-model_compact', baseInput, compactSchema, compactInstruction, await getOverview(), { maxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS, thinkingBudget: SOURCE_MODEL_THINKING_BUDGET });
        const model = normalize(raw, ctx);
        await persist(cacheDir, model);
        emit('[V3] Source Story Model recovered via compact extraction.');
        return model;
      } catch (err) {
        if (!isRecoverable(err)) throw err;
        if (isMaxTokensError(err)) await recordStrategyDiag(cacheDir, { compact: 'MAX_TOKENS' });
        emit(isMaxTokensError(err)
          ? `[V3] Compact extraction hit MAX_TOKENS; switching to chunk-first extraction (${short(err)}).`
          : `[V3] Compact extraction still failed (${short(err)}); switching to chunk-first extraction.`, 'WARNING');
      }
    }
  }

  // CHUNK-FIRST (long sources, or staged fell through): small windows, phase-budgeted,
  // recursion only as an emergency fallback. Never persists a partial model.
  const windowPlan = planChunkWindows(engine.duration, phase.remaining());
  const model = await chunkedExtract(engine, chunkSchema || compactSchema || schema,
    chunkInstruction || compactInstruction || instruction, ctx, audioEvents, emit,
    { phase, budget, windowPlan, mode: strat.mode, strategyReason: strat.reason });
  await persist(cacheDir, model);
  emit('[V3] Source Story Model built via chunk-first extraction.');
  return model;
}

module.exports = {
  build, normalize, mergeSourceModels, load, loadWithReason, loadCached, persist,
  tensionForEvent, attachWordWindow, isMaxTokens, isMaxTokensError, isRecoverable, chunkedExtract, extractWindow,
  validateRaw, validateChunk, fingerprint, callLimit,
  selectStrategy, requestBudgetPlan, downstreamReserve, planChunkWindows, makePhase,
  loadStrategyDiag, recordStrategyDiag,
  MODEL_VERSION, RECOVERY_VERSION, MAX_EVENTS, MAX_QUOTES, MAX_QUOTES_PER_EVENT, MAX_PEOPLE,
  MIN_LEAF_SEC, MAX_SPLIT_DEPTH, MAX_CHUNKS, CHUNK_TARGET_SEC,
  LONG_SOURCE_THRESHOLD_SEC, CHUNK_FIRST_TARGET_SEC, CHUNK_FIRST_MIN_WINDOWS, CHUNK_FIRST_MAX_WINDOWS,
  STORY_DESIGN_CALLS, NARRATION_CALLS_PER_SCRIPT, SOURCE_MODEL_MIN_CALLS,
  WHOLE_MAX_OUTPUT_TOKENS, COMPACT_MAX_OUTPUT_TOKENS, CHUNK_MAX_OUTPUT_TOKENS, SOURCE_MODEL_THINKING_BUDGET
};
