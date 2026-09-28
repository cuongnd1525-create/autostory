// AutoStory V3 — automated post-run acceptance assertions (pure + unit-testable).
//
// These implement the 6 REQUIRED POST-RUN ASSERTION groups. They read only the
// artifacts a real product run leaves in the analysis dir, plus an injected ffprobe
// for the final MP4, and return a structured PASS/FAIL list with exact causes — so a
// run is self-validating and nobody has to eyeball logs to find a runtime bug.
//
// Every check returns { group, name, pass, detail }. `evaluate(...)` aggregates them
// into { passed, failed, checks }. Pure: fs + ffprobe are injected.

const DEFAULT_MIN_SEC = 65, DEFAULT_MAX_SEC = 90;
const CAPS = { MAX_EVENTS: 40, MAX_QUOTES: 60, MAX_QUOTES_PER_EVENT: 3 };
const { validateEdlQuality } = require('../electron/services/edlQualityValidator.js');
const check = (group, name, pass, detail = '') => ({ group, name, pass: !!pass, detail: String(detail) });

// ---- 1. Source Model -------------------------------------------------------
function checkSourceModel({ model, coverage, caps = CAPS } = {}) {
  const out = [];
  out.push(check('source-model', 'story-model.json exists with events', model && Array.isArray(model.events) && model.events.length > 0,
    model ? `events=${model.events?.length}` : 'model missing'));
  // Coverage: chunk-first/chunked runs write chunk-coverage.json; a staged whole/compact
  // success has no chunk diagnostics and is full-source by construction.
  if (coverage) {
    out.push(check('source-model', 'coverageRatio == 1.0', coverage.coverageRatio === 1, `coverageRatio=${coverage.coverageRatio}`));
    out.push(check('source-model', 'no failed source windows', Array.isArray(coverage.failedLeafWindows) && coverage.failedLeafWindows.length === 0,
      `failed=${coverage.failedLeafWindows?.length ?? 'n/a'}`));
    out.push(check('source-model', 'plan was feasible', coverage.feasible !== false, `feasible=${coverage.feasible}`));
  } else {
    out.push(check('source-model', 'coverage full (staged whole/compact, no holes)', !!model, 'no chunk-coverage.json (staged success)'));
  }
  if (model) {
    out.push(check('source-model', `events within cap (<=${caps.MAX_EVENTS})`, model.events.length <= caps.MAX_EVENTS, `events=${model.events.length}`));
    const quotes = model.quotes || [];
    out.push(check('source-model', `quotes within cap (<=${caps.MAX_QUOTES})`, quotes.length <= caps.MAX_QUOTES, `quotes=${quotes.length}`));
    const perEvent = {};
    for (const q of quotes) if (q.eventId) perEvent[q.eventId] = (perEvent[q.eventId] || 0) + 1;
    const worst = Object.values(perEvent).reduce((m, n) => Math.max(m, n), 0);
    out.push(check('source-model', `per-event quotes within cap (<=${caps.MAX_QUOTES_PER_EVENT})`, worst <= caps.MAX_QUOTES_PER_EVENT, `maxPerEvent=${worst}`));
  }
  return out;
}

// ---- 2. AI runtime ---------------------------------------------------------
// requestMetadatas: array of per-call {key, finishReason, usage, providerError?} parsed
// from *-request-metadata.json. errors: array of {key, message} from *-error.json.
function checkAiRuntime({ requestMetadatas = [], errors = [], callBudget, requestLimit } = {}) {
  const out = [];
  const maxTok = requestMetadatas.filter(m => /MAX_TOKENS/i.test(m.finishReason || ''));
  out.push(check('ai-runtime', 'no uncaught MAX_TOKENS finishReason on kept responses', maxTok.length === 0,
    maxTok.map(m => m.key).join(', ') || 'none'));
  const inputAccess = errors.filter(e => /truy cập input|INPUT_ACCESS/i.test(e.message || ''));
  out.push(check('ai-runtime', 'no INPUT_ACCESS failure on any pass', inputAccess.length === 0,
    inputAccess.map(e => e.key).join(', ') || 'none'));
  const withUsage = requestMetadatas.filter(m => m.usage && (m.usage.totalTokenCount || m.usage.candidatesTokenCount));
  out.push(check('ai-runtime', 'token usage captured for calls', requestMetadatas.length === 0 || withUsage.length > 0,
    `${withUsage.length}/${requestMetadatas.length} with usage`));
  const withFinish = requestMetadatas.filter(m => m.finishReason);
  out.push(check('ai-runtime', 'finishReason captured for calls', requestMetadatas.length === 0 || withFinish.length > 0,
    `${withFinish.length}/${requestMetadatas.length} with finishReason`));
  if (Number.isFinite(callBudget) && Number.isFinite(requestLimit)) {
    out.push(check('ai-runtime', 'request budget not exceeded', callBudget <= requestLimit, `calls=${callBudget}/${requestLimit}`));
  }
  return out;
}

// ---- 3. Story structure ----------------------------------------------------
// beats: parsed beat-casting-N.json.beats; model: source model; design: story-spine.json
function checkStoryStructure({ design, beats = [], model = {} } = {}) {
  const out = [];
  const spines = design?.spines || [];
  out.push(check('story', 'non-empty Story Design', spines.length > 0, `spines=${spines.length}`));
  const eventIds = new Set((model.events || []).map(e => e.id));
  const referenced = beats.filter(b => b.sourceEventId);
  const invalid = referenced.filter(b => !eventIds.has(b.sourceEventId));
  out.push(check('story', 'beat casting references valid source events', invalid.length === 0,
    invalid.map(b => `${b.beatId}->${b.sourceEventId}`).join(', ') || `${referenced.length} refs ok`));
  // Coverage-added beats must also reference real events.
  const added = beats.filter(b => b.addedByCoverage || b.addedByDurationFit);
  const addedInvalid = added.filter(b => b.sourceEventId && !eventIds.has(b.sourceEventId));
  out.push(check('story', 'coverage/fit-added beats reference valid events', addedInvalid.length === 0,
    addedInvalid.map(b => b.beatId).join(', ') || `${added.length} added ok`));
  return out;
}

// ---- 4. Narration ----------------------------------------------------------
// script: highlight/compiled script with segments; wps: measured words/sec
function checkNarration({ segments = [], wordsPerSecond } = {}) {
  const out = [];
  const speaking = segments.filter(s => s.audio_mode === 'voiceover_only' || s.audio_mode === 'mixed_ducking' || s.audioMode === 'voiceover_only' || s.audioMode === 'mixed_ducking');
  const emptyText = speaking.filter(s => !String(s.voiceover_text || s.voiceoverText || '').trim());
  out.push(check('narration', 'no speaking beat has empty narration', emptyText.length === 0, `${emptyText.length} empty of ${speaking.length}`));
  if (Number.isFinite(wordsPerSecond) && wordsPerSecond > 0) {
    const over = [];
    for (const s of speaking) {
      const start = Number(s.sourceStartSec ?? s.start), end = Number(s.sourceEndSec ?? s.end);
      const seconds = Math.max(0, end - start);
      const words = String(s.voiceover_text || s.voiceoverText || '').trim().split(/\s+/).filter(Boolean).length;
      const budget = Math.floor(seconds * wordsPerSecond);
      if (words > budget + 0.5) over.push(`${s.id}:${words}>${budget}`);
    }
    out.push(check('narration', 'narration fits VOICE_BUDGET per beat', over.length === 0, over.join(', ') || 'all fit'));
  }
  return out;
}

// ---- 5. Duration -----------------------------------------------------------
function checkDuration({ segments = [], editorial, minSec = DEFAULT_MIN_SEC, maxSec = DEFAULT_MAX_SEC, extensionRatioMax = 1.0 } = {}) {
  const out = [];
  const total = segments.reduce((n, s) => n + Math.max(0, Number(s.sourceEndSec ?? s.end) - Number(s.sourceStartSec ?? s.start)), 0);
  out.push(check('duration', `final timeline in [${minSec},${maxSec}]s`, total >= minSec - 0.5 && total <= maxSec + 0.5, `total=${total.toFixed(1)}s`));
  if (editorial?.durationFit && Number.isFinite(editorial.durationFit.extensionRatio)) {
    out.push(check('duration', `extensionRatio within bound (<=${extensionRatioMax})`, editorial.durationFit.extensionRatio <= extensionRatioMax + 1e-9,
      `extensionRatio=${editorial.durationFit.extensionRatio}`));
    out.push(check('duration', 'not structurally undercast (Duration Fit did not paper over a deficit)', editorial.durationFit.structuralDeficit !== true,
      `structuralDeficit=${editorial.durationFit.structuralDeficit}`));
  }
  return out;
}

// ---- 6. Rendering ----------------------------------------------------------
// probe: result of ffprobe(mp4Path) -> { bytes, durationSec, streams:[{type,width,height}], ... }
function checkRendering({ mp4Path, probe, expectedDurationSec, toleranceSec = 2.0, expectWidth = 1080, expectHeight = 1920 } = {}) {
  const out = [];
  out.push(check('render', 'final MP4 exists and is non-empty', !!probe && Number(probe.bytes) > 1024, mp4Path ? `${probe?.bytes ?? 0} bytes @ ${mp4Path}` : 'no path'));
  out.push(check('render', 'ffprobe opened the file', !!probe && probe.ok !== false && Number(probe.durationSec) > 0, `durationSec=${probe?.durationSec}`));
  const streams = probe?.streams || [];
  const v = streams.find(s => s.type === 'video');
  const a = streams.find(s => s.type === 'audio');
  out.push(check('render', 'has a video stream', !!v, v ? `${v.width}x${v.height}` : 'none'));
  out.push(check('render', 'has an audio stream', !!a, a ? (a.codec || 'audio') : 'none'));
  if (v && expectWidth && expectHeight) {
    out.push(check('render', `resolution is ${expectWidth}x${expectHeight}`, Number(v.width) === expectWidth && Number(v.height) === expectHeight, `${v.width}x${v.height}`));
  }
  if (probe && Number.isFinite(expectedDurationSec) && Number(probe.durationSec) > 0) {
    const diff = Math.abs(Number(probe.durationSec) - expectedDurationSec);
    out.push(check('render', `MP4 duration matches compiled timeline (±${toleranceSec}s)`, diff <= toleranceSec, `mp4=${probe.durationSec}s vs compiled=${expectedDurationSec}s (Δ${diff.toFixed(2)})`));
  }
  return out;
}

// ---- 7. EDL Retention & Quality Guardrails ---------------------------------
function checkEdlQuality({ design } = {}) {
  const out = [];
  const spine = design?.spines?.[0] || design;
  if (!spine || !Array.isArray(spine.beats) || spine.beats.length === 0) {
    out.push(check('edl-quality', 'EDL has beats to evaluate', false, 'no beats found in story design'));
    return out;
  }
  const report = validateEdlQuality(spine);
  const m = report.metrics || {};

  out.push(check('edl-quality', 'teaser duration within bound (<= 14s)', m.teaserDuration <= 14.0, `teaserDuration=${m.teaserDuration}s`));
  out.push(check('edl-quality', 'teaser-to-main source overlap within budget (<= 3.0s, <= 25%)',
    m.teaserToMainSourceOverlapSeconds <= 3.0 && m.teaserToMainSourceOverlapRatio <= 0.25,
    `overlap=${m.teaserToMainSourceOverlapSeconds}s (${(m.teaserToMainSourceOverlapRatio * 100).toFixed(0)}%)`));
  out.push(check('edl-quality', 'no macro beats exceeding 10s (micro-beat structure)', m.maxMacroBeatDuration <= 10.0, `maxMacroBeat=${m.maxMacroBeatDuration}s`));
  out.push(check('edl-quality', 'zero unanchored backward timeline jumps', m.unanchoredBackwardJumpCount === 0, `unanchoredJumps=${m.unanchoredBackwardJumpCount}`));
  out.push(check('edl-quality', 'no visual state collapse (max consecutive run <= 12s)', m.sameVisualStateRunSec <= 12.0, `sameVisualRun=${m.sameVisualStateRunSec}s`));
  out.push(check('edl-quality', 'no semantic defense repetition run (> 2)', m.semanticRepetitionRun <= 2, `semanticRun=${m.semanticRepetitionRun}`));
  out.push(check('edl-quality', 'zero static speaker plateaus', m.staticSpeakerPlateauCount === 0, `plateaus=${m.staticSpeakerPlateauCount}`));
  out.push(check('edl-quality', 'strong information gain count (>= 5 beats)', m.strongInformationGainCount >= 5, `strongGainBeats=${m.strongInformationGainCount}`));
  out.push(check('edl-quality', 'cliffhanger is strong (Part 2 setup, concrete fact, no arrest spoiler)', m.cliffhangerStrengthSignals?.isStrong === true,
    m.cliffhangerStrengthSignals?.isStrong ? 'strong' : report.violations.find(v => v.code === 'WEAK_CLIFFHANGER')?.message || 'weak'));
  const svScore = m.structuralViralScore;
  out.push(check('edl-quality', 'Structural Viral Score >= 8.0/10', svScore && svScore.score >= 8.0,
    svScore ? `score=${svScore.score}/10 (raw=${svScore.rawScore})` : 'score missing'));
  out.push(check('edl-quality', 'zero structural hard-cap violations', svScore && (svScore.hardCaps || []).length === 0,
    svScore ? `hardCaps=${(svScore.hardCaps || []).join(', ') || 'none'}` : 'score missing'));

  return out;
}

function evaluate(input = {}) {
  const checks = [
    ...checkSourceModel(input.sourceModel || {}),
    ...checkAiRuntime(input.aiRuntime || {}),
    ...checkStoryStructure(input.story || {}),
    ...checkEdlQuality(input.edlQuality || { design: input.story?.design }),
    ...checkNarration(input.narration || {}),
    ...checkDuration(input.duration || {}),
    ...checkRendering(input.render || {})
  ];
  const failed = checks.filter(c => !c.pass);
  return { passed: failed.length === 0, failedCount: failed.length, total: checks.length, checks, failed };
}

module.exports = { evaluate, checkSourceModel, checkAiRuntime, checkStoryStructure, checkEdlQuality, checkNarration, checkDuration, checkRendering, DEFAULT_MIN_SEC, DEFAULT_MAX_SEC, CAPS };
