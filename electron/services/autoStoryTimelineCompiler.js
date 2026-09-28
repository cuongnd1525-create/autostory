const path = require('path');
const crypto = require('crypto');
const { StoryError } = require('./autoStoryRepairRouter');
const { requireOriginal } = require('./autoStoryAudioClassifier');
const VERSION = 2;
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 12);
const words = text => String(text || '').trim().split(/\s+/).filter(Boolean).length;
function budget(seconds, rate) { return Math.max(0, Math.floor(seconds * Math.max(0, Number(rate) || 0) * .92)); }
function range(value, evidence = [], duration = Infinity) {
  if (value && Number.isFinite(value.sourceStartSec) && Number.isFinite(value.sourceEndSec)) {
    const { sourceStartSec: start, sourceEndSec: end } = value;
    if (start < 0 || end <= start || end > duration) {
      throw new StoryError('LOCAL_EDITORIAL', `Invalid SOURCE time range: ${start}-${end}s; source 0-${duration}s.`, { start, end, duration });
    }
    return { start, end };
  }

  const { evidenceId, editIntent } = value || {};
  if (!evidenceId) throw new StoryError('LOCAL_EDITORIAL', 'Missing evidenceId or sourceStartSec.');

  if (typeof evidenceId === 'string') {
    const m = evidenceId.match(/^(\d+(?:\.\d+)?)[-_](\d+(?:\.\d+)?)$/);
    if (m) {
      const start = Number(m[1]), end = Number(m[2]);
      if (start >= 0 && end > start && end <= duration) {
        return { start, end };
      }
    }
  }

  const idWithoutExt = typeof evidenceId === 'string' ? evidenceId.replace(/\.[^/.]+$/, '') : evidenceId;
  const e = evidence.find(x => x.id === evidenceId || x.id === idWithoutExt || x.file === evidenceId || (x.file && (path.basename(x.file) === evidenceId || path.basename(x.file) === idWithoutExt)));
  if (!e) throw new StoryError('EVIDENCE_REQUIRED', `Missing evidence for id ${evidenceId}`);
  const sourceStart = e.sourceStart ?? e.sourceStartSec;
  const clipDuration = e.duration ?? (e.sourceEndSec - e.sourceStartSec);
  if (!Number.isFinite(sourceStart) || !Number.isFinite(clipDuration) || clipDuration <= 0) {
    throw new StoryError('TECHNICAL_NORMALIZATION', `Invalid evidence bounds for ${evidenceId}`);
  }

  let start = sourceStart;
  let end = sourceStart + clipDuration;

  if (editIntent === 'trim_start') {
    start += clipDuration * 0.2;
  } else if (editIntent === 'trim_end') {
    end -= clipDuration * 0.2;
  } else if (editIntent === 'trim_both') {
    start += clipDuration * 0.15;
    end -= clipDuration * 0.15;
  } else if (editIntent === 'extract_moment') {
    start += clipDuration * 0.3;
    end -= clipDuration * 0.3;
  }
  
  if (start < 0 || end <= start || end > duration) {
    throw new StoryError('LOCAL_EDITORIAL', `Resolved time range invalid: ${start}-${end}s; source 0-${duration}s.`, { start, end, duration });
  }

  return { start, end };
}
function compile(decisions, { story, evidence, config, sourceDuration = Infinity, enforceBudget = true }) {
  if (!Array.isArray(decisions) || !decisions.length) throw new StoryError('STRUCTURAL_STORY', 'No editorial decisions.');
  const seen = new Set();
  let cursor = 0;
  const segments = decisions.map((d, index) => {
    const { start, end } = range(d, evidence, sourceDuration);
    const clip = evidence.find(e => {
      const sStart = e.sourceStart ?? e.sourceStartSec;
      const sDur = e.duration ?? (e.sourceEndSec - e.sourceStartSec);
      return Number.isFinite(sStart) && Number.isFinite(sDur) && sDur > 0 && e.id && start >= sStart - 1e-4 && end <= sStart + sDur + 1e-4;
    });
    if (!clip) throw new StoryError('EVIDENCE_REQUIRED', 'Requested source range is not covered by one verified evidence clip.', { start, end });
    const key = hash([start, end, d.audioIntent, d.voiceoverText]);
    if (seen.has(key)) throw new StoryError('LOCAL_EDITORIAL', 'Exact duplicate footage and meaning.', { index });
    seen.add(key);
    if (!['original', 'narration'].includes(d.audioIntent)) throw new StoryError('LOCAL_EDITORIAL', 'Unknown audio intent.');
    if (d.audioIntent === 'original') {
      if (d.voiceoverText?.trim()) throw new StoryError('LOCAL_EDITORIAL', 'Original audio unexpectedly has voiceoverText.', { index });
      requireOriginal(d.audio);
    } else {
      if (!config.narration?.enabled || !d.voiceoverText?.trim()) throw new StoryError('LOCAL_EDITORIAL', 'Narration is disabled or empty.', { index });
      const safeWords = budget(end - start, config.narration.measuredWordsPerSecond);
      if (enforceBudget && words(d.voiceoverText) > safeWords) throw new StoryError('VOICE_BUDGET', 'Narration exceeds safe word budget.', { index, safeWords });
    }
    const clipStart = clip.sourceStart ?? clip.sourceStartSec;
    const id = `s${story.scriptId}_${hash([index, start, end, d.storyRole])}`;
    const segment = { id, evidenceId: clip.id, start: start - clipStart, end: end - clipStart,
      sourceStartSec: start, sourceEndSec: end, outputStartSec: cursor, outputEndSec: cursor + end - start,
      storyRole: d.storyRole, narrativePurpose: d.reason || '', audioMode: d.audioIntent === 'original' ? 'original_audio' : 'voiceover_only',
      sourceNarratorPresent: d.audioIntent === 'original' ? false : ['mixed', 'external_narrator'].includes(d.audio?.audioType),
      audioClassification: d.audio, voiceoverText: d.voiceoverText || '', previewVi: d.previewVi || '' };
    cursor = segment.outputEndSec; return segment;
  });
  if (segments[0].storyRole !== 'hook') throw new StoryError('STRUCTURAL_STORY', 'Opening must be a hook.');
  const firstBody = segments.findIndex(s => s.storyRole !== 'hook');
  const hooks = segments.slice(0, firstBody < 0 ? segments.length : firstBody);
  const getSourceStart = d => d.sourceStartSec ?? range(d, evidence, sourceDuration).start;
  const getSourceEnd = d => d.sourceEndSec ?? range(d, evidence, sourceDuration).end;
  return { contractVersion: VERSION, scriptId: story.scriptId, title: story.title, narrationArc: story.centralViewerQuestion,
    segments, measuredDuration: cursor, sourceDecisions: decisions,
    hookAudit: { selectedCandidateId: story.candidateId, sourceRanges: hooks.map(s => [s.sourceStartSec, s.sourceEndSec]) },
    openingAudit: { hookSegmentIds: hooks.map(s => s.id), contextSegmentIds: segments.filter(s => s.storyRole === 'context').map(s => s.id) },
    overlapReport: decisions.flatMap((d,i) => decisions.slice(0,i).filter(p => getSourceStart(d) < getSourceEnd(p) && getSourceEnd(d) > getSourceStart(p))
      .map(p => ({ sourceStartSec: Math.max(getSourceStart(p),getSourceStart(d)), sourceEndSec: Math.min(getSourceEnd(p),getSourceEnd(d)), reason: d.reason }))) };
}
function validateDuration(script, config) {
  const duration = script.segments.reduce((n, s) => n + s.end - s.start, 0);
  const min = (config.targetDurationMinSec || 65) - 2.0;
  const max = (config.targetDurationMaxSec || 90) + 2.0;
  if (duration < min) {
    throw new StoryError('EDITORIAL_UNDERCAST', 'Meaningful material cannot support the minimum duration.', { duration, min: config.targetDurationMinSec });
  } else if (duration > max) {
    throw new StoryError('REGIONAL_EDITORIAL', 'Timeline duration outside requested range.', { duration, max: config.targetDurationMaxSec });
  }
  return duration;
}
function sourceView(script, evidence) {
  return script.segments.map(s => {
    const e = evidence.find(e => e.id === s.evidenceId);
    if (!e) throw new StoryError('TECHNICAL_NORMALIZATION', 'Missing evidence for saved segment.');
    return { sourceStartSec: e.sourceStart + s.start, sourceEndSec: e.sourceStart + s.end,
      storyRole: s.storyRole, audioIntent: s.audioMode === 'original_audio' ? 'original' : 'narration',
      reason: s.narrativePurpose, voiceoverText: s.voiceoverText, previewVi: s.previewVi, audio: s.audioClassification || { audioType: 'uncertain', confidence: 0 } };
  });
}
module.exports = { VERSION, range, compile, sourceView, validateDuration, budget, words, hash };
