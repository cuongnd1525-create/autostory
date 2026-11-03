"use strict";
// Progress of one Auto Story run (generation + every script's draft render and review) as a
// single 0-100 value that tracks elapsed WORK, not the ad-hoc percents of nested steps.
//
// The run is planned up front as weighted phases. A phase's weight is its expected duration:
//   generation  preprocess -> understand (source media prep + Source Story Model) -> design
//               (V4: Story Scope + Editorial Director; V3: Story Design; V2: discovery) -> scripts
//   production  per script: render (draft) -> review (AI review, repairs, final check)
// Expected durations come from the measured durations of previous runs on this machine
// (EWMA per engine, stored in <workspace>/.cineviral/auto-story-progress.json); the defaults are
// the measurements of a real V4 run (549.7 s source, 1 script, 22.4 min).
// Inside a phase the fraction is REAL when the step reports it (ffmpeg time of the source media
// prep, draft render percent), otherwise elapsed / expected, held below 95% until the phase ends.
// A phase that is skipped (cache hit, resume) completes when a later phase starts.
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  v2: { preprocess: 15, discovery: 120, design: 0, understandAi: 0, mediaPerSourceSec: 0, script: 120, render: 90, review: 100 },
  v3: { preprocess: 15, discovery: 0, design: 60, understandAi: 50, mediaPerSourceSec: 1.0, script: 90, render: 90, review: 100 },
  v4: { preprocess: 15, discovery: 0, design: 190, understandAi: 50, mediaPerSourceSec: 1.0, script: 350, render: 90, review: 100 }
};
const TIME_CAP = 0.95;
const EWMA = 0.4;
const GENERATION_ORDER = { v2: ["preprocess", "discovery", "scripts"], v3: ["preprocess", "understand", "design", "scripts"] };
GENERATION_ORDER.v4 = GENERATION_ORDER.v3;
const STAGE_TO_PHASE = { preprocess: "preprocess", understand: "understand", discovery: "discovery", design: "design", editing: "scripts" };

/** "v2" | "v3" | "v4" for a project (same rules as src/autoStoryEngine.js). */
function engineOf(project = {}) {
  try {
    return `v${require("../../src/autoStoryEngine").engineOfProject(project).value}`;
  } catch (_) {
    const contract = Number(project.autoStoryContractVersion);
    return contract === 3 || contract === 4 || project.autoStoryPipelineVersion === "source-story-v3" ? "v3" : "v2";
  }
}

function historyPath(workspaceRoot) {
  return workspaceRoot ? path.join(workspaceRoot, ".cineviral", "auto-story-progress.json") : "";
}

function loadHistory(workspaceRoot) {
  try { return JSON.parse(fs.readFileSync(historyPath(workspaceRoot), "utf8")) || {}; } catch (_) { return {}; }
}

class AutoStoryRunProgress {
  /**
   * engine: "v2" | "v3" | "v4"; outputs: scripts expected; generate: false when the scripts already
   * exist (resume); sourceSec: source duration; history: loadHistory() result.
   */
  constructor({ engine = "v3", outputs = 1, scripts = null, generate = true, sourceSec = 0, history = {}, now = () => Date.now() } = {}) {
    this.engine = DEFAULTS[engine] ? engine : "v3";
    this.now = now;
    this.sourceSec = Math.max(0, Number(sourceSec) || 0);
    this.est = { ...DEFAULTS[this.engine], ...(history?.[this.engine] || {}) };
    this.outputs = Math.max(1, Number(outputs) || 1);
    // Scripts the generation writes (a resume may only write the missing ones).
    this.scriptsCount = Math.max(1, Math.min(this.outputs, Number(scripts ?? this.outputs) || this.outputs));
    this.order = generate ? GENERATION_ORDER[this.engine] : [];
    this.phases = new Map();
    for (const id of this.order) this.phases.set(id, { id, start: 0, end: 0, real: null });
    this.slots = Array.from({ length: this.outputs }, () => ({ scriptId: null, render: { start: 0, end: 0, real: null }, review: { start: 0, end: 0, real: null } }));
    this.scriptsReady = 0;
    this.lastScriptReadyAt = 0;
    this.media = { done: 0, total: 0, start: 0, end: 0 };
  }

  expected(id) {
    const e = this.est;
    if (id === "understand") return e.understandAi + this.mediaExpected();
    if (id === "scripts") return e.script * this.scriptsCount;
    return Number(e[id]) || 0;
  }

  mediaExpected() {
    return this.est.mediaPerSourceSec * this.sourceSec;
  }

  // ------------------------------------------------------------------ transitions
  startGeneration(id) {
    const index = this.order.indexOf(id);
    if (index < 0) return;
    const now = this.now();
    // Earlier phases are over (done or skipped); a later phase already running wins.
    if (this.order.slice(index + 1).some((later) => this.phases.get(later).start)) return;
    for (const earlier of this.order.slice(0, index)) {
      const phase = this.phases.get(earlier);
      if (!phase.end) Object.assign(phase, { start: phase.start || now, end: now });
    }
    const phase = this.phases.get(id);
    if (!phase.start) phase.start = now;
    if (id === "scripts" && !this.lastScriptReadyAt) this.lastScriptReadyAt = now;
  }

  scriptReady() {
    this.startGeneration("scripts");
    this.scriptsReady = Math.min(this.scriptsCount, this.scriptsReady + 1);
    this.lastScriptReadyAt = this.now();
  }

  generationDone() {
    const now = this.now();
    for (const phase of this.phases.values()) if (!phase.end) Object.assign(phase, { start: phase.start || now, end: now });
    if (this.media.start && !this.media.end) this.media.end = now;
  }

  /** Fewer scripts than planned will be produced (generation failures): drop their slots. */
  setProductionCount(count) {
    const keep = Math.max(1, Math.min(this.outputs, Number(count) || 0));
    const used = this.slots.filter((slot) => slot.scriptId !== null);
    this.slots = [...used, ...this.slots.filter((slot) => slot.scriptId === null)].slice(0, Math.max(keep, used.length));
  }

  slot(scriptId) {
    const id = Number(scriptId);
    if (!Number.isFinite(id)) return null;
    return this.slots.find((slot) => slot.scriptId === id) || (() => {
      const free = this.slots.find((slot) => slot.scriptId === null);
      if (free) free.scriptId = id;
      return free || null;
    })();
  }

  renderStart(scriptId) {
    const slot = this.slot(scriptId);
    if (slot && !slot.render.start) slot.render.start = this.now();
  }

  reviewStart(scriptId) {
    const slot = this.slot(scriptId);
    if (!slot) return;
    const now = this.now();
    if (!slot.render.start) slot.render.start = now;
    if (!slot.render.end) slot.render.end = now;
    if (!slot.review.start) slot.review.start = now;
  }

  scriptDone(scriptId) {
    const slot = this.slot(scriptId);
    if (!slot) return;
    const now = this.now();
    for (const part of [slot.render, slot.review]) if (!part.end) Object.assign(part, { start: part.start || now, end: now });
  }

  /** Feed one progress event; returns the run percent (0-99; 100 only via the final event). */
  event(event = {}) {
    const phaseId = STAGE_TO_PHASE[event.stage];
    if (phaseId) this.startGeneration(phaseId);
    if (event.stage === "source_media" && Number(event.mediaTotalSec) > 0 && this.current() === "understand") {
      const now = this.now();
      if (!this.media.start) this.media.start = now;
      this.media.total = Number(event.mediaTotalSec);
      this.media.done = Math.max(this.media.done, Math.min(this.media.total, Number(event.mediaDoneSec) || 0));
      if (this.media.done >= this.media.total) this.media.end = this.media.end || now;
    }
    const slot = event.scriptId !== undefined ? this.slot(event.scriptId) : null;
    if (slot && event.step === "draft" && slot.render.start && !slot.render.end && Number.isFinite(Number(event.percent))) {
      slot.render.real = Math.max(slot.render.real || 0, Math.min(1, Number(event.percent) / 100));
    }
    if (slot && event.autoStoryDraftReady) this.reviewStart(event.scriptId);
    return this.percent();
  }

  current() {
    return [...this.order].reverse().find((id) => this.phases.get(id).start && !this.phases.get(id).end) || "";
  }

  // ------------------------------------------------------------------ fractions
  timeFraction(start, end, expectedSec) {
    if (end) return 1;
    if (!start) return 0;
    if (!(expectedSec > 0)) return TIME_CAP;
    return Math.min(TIME_CAP, (this.now() - start) / 1000 / expectedSec);
  }

  generationFraction(id) {
    const phase = this.phases.get(id);
    if (phase.end) return 1;
    if (!phase.start) return 0;
    if (id === "scripts") {
      const current = this.timeFraction(this.lastScriptReadyAt || phase.start, 0, this.est.script);
      return Math.min(TIME_CAP, (this.scriptsReady + current) / this.scriptsCount);
    }
    if (id === "understand" && this.media.start) {
      const mediaSec = this.mediaExpected() || this.est.understandAi;
      const mediaFrac = this.media.total ? this.media.done / this.media.total : 0;
      const aiFrac = this.media.end ? this.timeFraction(this.media.end, 0, this.est.understandAi) : 0;
      return Math.min(TIME_CAP, (mediaSec * mediaFrac + this.est.understandAi * aiFrac) / (mediaSec + this.est.understandAi));
    }
    return this.timeFraction(phase.start, 0, this.expected(id));
  }

  percent() {
    let total = 0;
    let done = 0;
    for (const id of this.order) {
      const weight = this.expected(id);
      total += weight;
      done += weight * this.generationFraction(id);
    }
    for (const slot of this.slots) {
      const render = slot.render.end ? 1 : slot.render.real !== null ? Math.min(TIME_CAP, slot.render.real) : this.timeFraction(slot.render.start, 0, this.est.render);
      total += this.est.render + this.est.review;
      done += this.est.render * render + this.est.review * this.timeFraction(slot.review.start, slot.review.end, this.est.review);
    }
    if (!(total > 0)) return 0;
    return Math.max(0, Math.min(99, Math.round((done / total) * 1000) / 10));
  }

  // ------------------------------------------------------------------ learning
  /** Measured durations (seconds) of the phases that really ran; null for skipped ones. */
  measured() {
    const sec = (start, end) => (start && end && end > start ? (end - start) / 1000 : null);
    const out = {};
    for (const id of this.order) {
      const phase = this.phases.get(id);
      const value = sec(phase.start, phase.end);
      if (value === null || value < 3) continue; // cache hits / skipped phases teach nothing
      if (id === "scripts") out.script = value / Math.max(1, this.scriptsReady || this.scriptsCount);
      else if (id === "understand") {
        const mediaSec = this.media.start ? sec(this.media.start, this.media.end) : null;
        if (mediaSec && this.sourceSec > 0) out.mediaPerSourceSec = mediaSec / this.sourceSec;
        out.understandAi = Math.max(1, value - (mediaSec || 0));
      } else out[id] = value;
    }
    const avg = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
    const renders = this.slots.map((slot) => sec(slot.render.start, slot.render.end)).filter((v) => v !== null && v >= 3);
    const reviews = this.slots.map((slot) => sec(slot.review.start, slot.review.end)).filter((v) => v !== null && v >= 3);
    if (renders.length) out.render = avg(renders);
    if (reviews.length) out.review = avg(reviews);
    return out;
  }

  /** Blend this run's measurements into the stored history (EWMA) and write it. */
  saveHistory(workspaceRoot) {
    const file = historyPath(workspaceRoot);
    if (!file) return null;
    const history = loadHistory(workspaceRoot);
    const previous = { ...DEFAULTS[this.engine], ...(history[this.engine] || {}) };
    const next = { ...(history[this.engine] || {}) };
    for (const [key, value] of Object.entries(this.measured())) {
      next[key] = Math.round((previous[key] * (1 - EWMA) + value * EWMA) * 1000) / 1000;
    }
    const updated = { ...history, [this.engine]: next, updatedAt: new Date(this.now()).toISOString() };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(updated, null, 2), "utf8");
    } catch (_) { /* progress history is best effort */ }
    return updated;
  }
}

AutoStoryRunProgress.DEFAULTS = DEFAULTS;
AutoStoryRunProgress.engineOf = engineOf;
AutoStoryRunProgress.loadHistory = loadHistory;
AutoStoryRunProgress.historyPath = historyPath;
module.exports = AutoStoryRunProgress;
