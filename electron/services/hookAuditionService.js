'use strict';
/**
 * MULTIMODAL HOOK AUDITION & FACTUAL TITLE VERIFIER
 *
 * 1. Audits any candidate on-screen hook title for:
 *    - Unverified factual claims (e.g. ages like "24yo", dollar amounts, or specific numbers
 *      absent from the canonical Source Story Model and transcript cues).
 *    - Near-duplicate phrasing against a reference video title (when provided).
 *    - Premature outcome/consequence spoilers against `mustWithhold`.
 * 2. Builds >= 2 distinct opening candidates from verified Story Scope hook material,
 *    renders real 9:16 MP4 opening previews (with on-screen title banner + audio),
 *    and evaluates them multimodally via Gemini video inspection (never transcript-only).
 * 3. Persists `hook-audition-report.json` with every required field.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const narrationGate = require('./narrationGate');
const { mineHookCandidateRegions } = require('./hookMiningService');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

function tokenize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

function jaccardSimilarity(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function buildSourceCorpusText(model = {}, cues = []) {
  const parts = [];
  for (const e of model?.events || []) parts.push(e.summary || '', e.visualProof || '');
  for (const q of model?.quotes || []) parts.push(q.text || '', q.speaker || '');
  for (const f of model?.facts || []) parts.push(f.text || f.summary || '');
  for (const p of model?.participants || []) parts.push(p.role || '', p.description || '', p.label || '');
  for (const c of cues || []) parts.push(c.text || '');
  return parts.join(' ').toLowerCase();
}

/**
 * Deterministically verifies a hook title against source evidence, mustWithhold rules,
 * and optional reference title similarity.
 */
function verifyHookTitle(title, { model = {}, cues = [], mustWithhold = [], referenceTitle = '' } = {}) {
  const cleanTitle = String(title || '').trim();
  const issues = [];
  if (!cleanTitle) {
    return { valid: false, title: cleanTitle, issues: [{ code: 'EMPTY_TITLE', severity: 'blocking', message: 'Hook title is empty.' }] };
  }

  const corpus = buildSourceCorpusText(model, cues);

  // 1. Check age claims (e.g. "24yo", "24-year-old", "24 year old", "aged 24")
  const ageRegex = /\b(\d{1,2})\s*(?:yo|y\/o|yr\s*old|yrs\s*old|year[- ]old|years[- ]old)\b|\baged?\s+(\d{1,2})\b/gi;
  let match;
  while ((match = ageRegex.exec(cleanTitle)) !== null) {
    const ageNum = match[1] || match[2];
    const ageInCorpus = new RegExp(`\\b${ageNum}\\s*(?:yo|y\\/o|year[- ]old|years[- ]old|years of age)\\b|\\bage\\s+${ageNum}\\b`, 'i').test(corpus);
    if (!ageInCorpus) {
      issues.push({
        code: 'UNVERIFIED_AGE_IN_TITLE',
        severity: 'blocking',
        claim: match[0],
        message: `Title claims age "${match[0]}", which is NOT verified in the source transcript or story model.`
      });
    }
  }

  // 2. Check specific numeric claims > 10 (excluding 911 emergency number & common 1-2 digit counts verified in corpus)
  const numMatches = cleanTitle.match(/\b\d+\b/g) || [];
  for (const rawNum of numMatches) {
    if (rawNum === '911') {
      if (!/\b911\b|emergency|dispatch/i.test(corpus)) {
        issues.push({ code: 'UNVERIFIED_NUMBER_IN_TITLE', severity: 'blocking', claim: rawNum, message: 'Title mentions 911 without 911/dispatch evidence in source.' });
      }
      continue;
    }
    // Skip if already flagged as an unverified age
    if (issues.some(i => i.code === 'UNVERIFIED_AGE_IN_TITLE' && String(i.claim).includes(rawNum))) continue;
    const numRegex = new RegExp(`\\b${rawNum}\\b`, 'i');
    if (!numRegex.test(corpus)) {
      issues.push({
        code: 'UNVERIFIED_NUMBER_IN_TITLE',
        severity: 'blocking',
        claim: rawNum,
        message: `Numeric claim "${rawNum}" in title is not grounded in source evidence.`
      });
    }
  }

  // 3. Check judgmental / derogatory insults
  const judgment = narrationGate.detectJudgmentalTerms(cleanTitle);
  if (judgment.hasJudgmentalTerms) {
    issues.push({
      code: 'JUDGMENTAL_TITLE_LANGUAGE',
      severity: 'blocking',
      matchedTerms: judgment.matchedTerms,
      message: `Title uses derogatory/loaded wording (${judgment.matchedTerms.join(', ')}).`
    });
  }

  // 4. Check reference-title copycat similarity
  if (referenceTitle) {
    const sim = jaccardSimilarity(cleanTitle, referenceTitle);
    if (sim >= 0.65) {
      issues.push({
        code: 'TITLE_COPIES_REFERENCE',
        severity: 'blocking',
        similarity: round2(sim),
        message: `Title is too similar to reference video title (Jaccard similarity ${round2(sim)} >= 0.65). Write an original grounded hook banner.`
      });
    }
  }

  // 5. Check spoiler against explicit mustWithhold items
  for (const item of mustWithhold || []) {
    const spoiler = narrationGate.detectPunchlineSpoiler(cleanTitle, [item]);
    if (spoiler.hasSpoiler) {
      issues.push({
        code: 'TITLE_SPOILS_WITHHELD_PAYOFF',
        severity: 'blocking',
        withheld: item,
        message: `Title prematurely spoils withheld story payoff ("${item}").`
      });
    }
  }

  // 6. Word count sanity check for 9:16 top banner readability
  const words = cleanTitle.split(/\s+/).filter(Boolean);
  if (words.length < 5 || words.length > 16) {
    issues.push({
      code: 'TITLE_LENGTH_SUBOPTIMAL',
      severity: words.length < 3 || words.length > 20 ? 'blocking' : 'minor',
      wordCount: words.length,
      message: `Title has ${words.length} words (optimal 9:16 banner range is 6-14 words).`
    });
  }

  const blocking = issues.filter(i => i.severity === 'blocking');
  return {
    valid: blocking.length === 0,
    title: cleanTitle,
    wordCount: words.length,
    issues
  };
}

const TITLE_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          title: { type: 'string' },
          sourceStartSec: { type: 'number' },
          sourceEndSec: { type: 'number' },
          expectedNextBeat: { type: 'string' },
          editorialRationale: { type: 'string' }
        },
        required: ['candidateId', 'title', 'sourceStartSec', 'sourceEndSec', 'expectedNextBeat', 'editorialRationale']
      }
    }
  },
  required: ['candidates']
};

const MULTIMODAL_AUDITION_SCHEMA = {
  type: 'object',
  properties: {
    evaluations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          visualDescription: { type: 'string' },
          audibleSpeechOrSound: { type: 'string' },
          createsImmediateCuriosity: { type: 'boolean' },
          titleImageAudioSynergy: { type: 'boolean' },
          avoidsOutcomeSpoiler: { type: 'boolean' },
          strengths: { type: 'string' },
          weaknesses: { type: 'string' },
          editorialRank: { type: 'number' }
        },
        required: [
          'candidateId', 'visualDescription', 'audibleSpeechOrSound',
          'createsImmediateCuriosity', 'titleImageAudioSynergy', 'avoidsOutcomeSpoiler',
          'strengths', 'weaknesses', 'editorialRank'
        ]
      }
    },
    selectedCandidateId: { type: 'string' },
    selectionRationale: { type: 'string' }
  },
  required: ['evaluations', 'selectedCandidateId', 'selectionRationale']
};

function deriveCandidateWindows(scope = {}, spine = {}, model = {}, liveActionEndSec = Infinity) {
  const maxEnd = Math.min(Number(liveActionEndSec) || Infinity, Number(scope?.liveActionEndSec) || Infinity);
  const rawPool = [];

  // Primary: spine's current opening beat(s)
  if (Array.isArray(spine?.beats) && spine.beats.length > 0) {
    const b0 = spine.beats[0];
    const s = Math.max(0, Number(b0.sourceStartSec) || 0);
    const e = Math.min(maxEnd, Math.max(s + 3.5, Math.min(s + 7.5, Number(b0.sourceEndSec) || s + 5)));
    if (e - s >= 2.5) {
      rawPool.push({
        sourceStartSec: round2(s),
        sourceEndSec: round2(e),
        footageDescription: b0.observedInFootage || b0.newInformation || 'Director primary cold-open beat',
        expectedNextBeat: spine.beats[1]?.newInformation || spine.beats[1]?.observedInFootage || 'Narrator context setup explaining how the encounter began',
        origin: 'director_opening'
      });
    }
  }

  // Secondary: Director's explicit openingChoice.hookOptionsConsidered
  for (const opt of spine?.openingChoice?.hookOptionsConsidered || []) {
    const s = Math.max(0, Number(opt.sourceStartSec) || 0);
    const e = Math.min(maxEnd, Math.max(s + 3.5, Math.min(s + 7.5, Number(opt.sourceEndSec) || s + 5.5)));
    if (e - s < 2.5) continue;
    if (rawPool.some(p => Math.abs(p.sourceStartSec - s) < 2.0)) continue;
    rawPool.push({
      sourceStartSec: round2(s),
      sourceEndSec: round2(e),
      footageDescription: opt.whyConsidered || opt.openingType || 'Director alternate hook option',
      expectedNextBeat: 'Narrator context/rewind setup establishing how the incident escalated',
      origin: `director_option_${opt.optionId || 'alt'}`
    });
  }

  // Tertiary: Story Scope hookCandidates
  for (const hc of scope?.hookCandidates || []) {
    const s = Math.max(0, Number(hc.sourceStartSec) || 0);
    const e = Math.min(maxEnd, Math.max(s + 3.5, Math.min(s + 7.5, Number(hc.sourceEndSec) || s + 5.5)));
    if (e - s < 2.5) continue;
    if (rawPool.some(p => Math.abs(p.sourceStartSec - s) < 2.0)) continue;
    rawPool.push({
      sourceStartSec: round2(s),
      sourceEndSec: round2(e),
      footageDescription: hc.whyItHooks || 'Verified scope hook candidate',
      expectedNextBeat: 'Narrator rewind/setup establishing the roadside encounter and stakes',
      origin: `scope_${hc.hookId || 'hook'}`
    });
  }

  // Quaternary fallback from non-ending conflict beats or scopeWindows to guarantee >= 2 candidates
  if (rawPool.length < 2 && Array.isArray(spine?.beats)) {
    for (const b of spine.beats.slice(1, -1)) {
      if (b.narrativeRole === 'ending' || b.narrativeRole === 'payoff' || b.narrativeRole === 'climax') continue;
      const s = Math.max(0, Number(b.sourceStartSec) || 0);
      const e = Math.min(maxEnd, Math.max(s + 3.5, Math.min(s + 7.0, Number(b.sourceEndSec) || s + 5.0)));
      if (e - s < 2.5) continue;
      if (rawPool.some(p => Math.abs(p.sourceStartSec - s) < 2.5)) continue;
      rawPool.push({
        sourceStartSec: round2(s),
        sourceEndSec: round2(e),
        footageDescription: b.observedInFootage || b.newInformation || 'In-medias-res conflict candidate',
        expectedNextBeat: 'Narrator rewind setup explaining how the dispute reached this point',
        origin: `beat_${b.beatId}`
      });
      if (rawPool.length >= 3) break;
    }
  }

  if (rawPool.length < 2) {
    const hookWins = (scope?.scopeWindows || []).filter(w => (w.purposes || []).includes('hook_material') || (w.purposes || []).includes('core') || (w.purposes || []).includes('incident'));
    for (const w of hookWins) {
      const s = Math.max(0, Number(w.startSec) || 0);
      const e = Math.min(maxEnd, Number(w.endSec) || 0, s + 6.0);
      if (e - s < 3.0) continue;
      if (rawPool.some(p => Math.abs(p.sourceStartSec - s) < 3.0)) continue;
      rawPool.push({
        sourceStartSec: round2(s),
        sourceEndSec: round2(e),
        footageDescription: `Verified scope window ${w.windowId || w.scopeWindowId || 'w'}`,
        expectedNextBeat: 'Narrator context setup orienting the incident',
        origin: `window_${w.windowId || w.scopeWindowId || 'w'}`
      });
      if (rawPool.length >= 3) break;
    }
  }

  return rawPool.slice(0, 3);
}

async function renderHookPreviewMp4({
  ffmpeg,
  dubbing,
  project,
  paths,
  candidateId,
  sourceStartSec,
  sourceEndSec,
  title,
  previewDir
}) {
  await fsp.mkdir(previewDir, { recursive: true });
  const dur = Math.max(2.5, round2(sourceEndSec - sourceStartSec));
  const rawClip = path.join(previewDir, `${candidateId}-raw.mp4`);
  const normClip = path.join(previewDir, `${candidateId}-norm.mp4`);
  const outMp4 = path.join(previewDir, `${candidateId}.mp4`);

  await ffmpeg.extractVoiceDrivenClipWithAudio({
    sourcePath: project.sourceVideoPath,
    outputPath: rawClip,
    startSec: sourceStartSec,
    sourceDurationSec: dur,
    targetDurationSec: dur,
    width: 720,
    preset: 'veryfast',
    crf: 23,
    includeAudio: true
  });
  await ffmpeg.normalizeMediaDuration({
    inputPath: rawClip,
    outputPath: normClip,
    targetDuration: dur
  });

  const previewProject = {
    ...project,
    title,
    videoDecoration: {
      ...(project.videoDecoration || {}),
      canvasEnabled: true,
      canvasAspect: '9:16',
      blurBackgroundEnabled: true,
      topCaptionEnabled: true,
      topCaptionAutoFromScript: false,
      topCaptionText: title
    }
  };

  if (dubbing && typeof dubbing.applyProjectVideoDecoration === 'function') {
    await dubbing.applyProjectVideoDecoration({
      ffmpeg,
      project: previewProject,
      paths,
      inputPath: normClip,
      outputPath: outMp4,
      name: `hook-${candidateId}`,
      draft: true
    });
  } else {
    await fsp.copyFile(normClip, outMp4);
  }

  await Promise.all([
    fsp.rm(rawClip, { force: true }).catch(() => {}),
    fsp.rm(normClip, { force: true }).catch(() => {})
  ]);
  return outMp4;
}

/**
 * Runs a full Hook Audition:
 *   1. Generates grounded, non-spoiling, fact-verified titles for >= 2 distinct opening windows.
 *   2. Verifies every title deterministically (`verifyHookTitle`).
 *   3. Renders real 9:16 MP4 previews for each candidate.
 *   4. Evaluates all rendered preview MP4s multimodally via Gemini.
 *   5. Writes `hook-audition-report.json`.
 */
async function runHookAudition({
  aiService,
  ffmpeg,
  dubbing,
  project,
  paths,
  scope = {},
  spine = {},
  model = {},
  cues = [],
  referenceTitle = '',
  outputDir
}) {
  const previewDir = path.join(outputDir, 'hook-audition');
  await fsp.mkdir(previewDir, { recursive: true });
  const liveActionEndSec = model?.liveActionEndSec ?? scope?.liveActionEndSec ?? Infinity;
  const windows = deriveCandidateWindows(scope, spine, model, liveActionEndSec);
  if (!windows.length) {
    throw new Error('HOOK_AUDITION_NO_WINDOWS: No valid hook candidate windows found within liveActionEndSec.');
  }

  const centralQuestion = spine?.centralViewerQuestion || scope?.centralViewerQuestion || '';
  const mustWithhold = scope?.mustWithhold || spine?.storyScope?.mustWithhold || [];

  // Gather transcript snippets for each window so title planning stays 100% grounded
  const windowContexts = windows.map((w, idx) => {
    const winCues = (cues || [])
      .filter(c => Math.min(Number(c.endSec), w.sourceEndSec) - Math.max(Number(c.startSec), w.sourceStartSec) > 0.15)
      .map(c => c.text)
      .join(' ');
    return {
      candidateId: `hook_preview_${idx + 1}`,
      ...w,
      transcriptExcerpt: winCues.slice(0, 320)
    };
  });

  const knownFactsSummary = [
    ...(model?.facts || []).slice(0, 12).map(f => f.text || f.summary || ''),
    ...(model?.events || []).slice(0, 10).map(e => `${e.startSec}-${e.endSec}s: ${e.summary || ''}`)
  ].filter(Boolean).join('\n');

  let plannedCandidates = [];
  if (aiService?.generateJsonFromFiles) {
    const planPrompt = `You are an American True Crime Short-Form Editorial Producer designing opening hook previews.
Central Viewer Question: ${centralQuestion}
Must Withhold (DO NOT spoil in the title): ${mustWithhold.join(' | ') || 'Do not give away the final outcome prematurely'}
${referenceTitle ? `FORBIDDEN COPYCAT REFERENCE TITLE (do NOT copy its phrasing or unverified details): "${referenceTitle}"` : ''}

VERIFIED SOURCE FACTS & EVENTS (NEVER invent ages, names, or numbers not explicitly present here):
${knownFactsSummary}

CANDIDATE OPENING WINDOWS:
${JSON.stringify(windowContexts, null, 2)}

For EACH candidate window, write a distinct, punchy 7-12 word on-screen banner title in natural US English and refine its exact 4.0-6.5s sourceStartSec/sourceEndSec inside the window:
- NEVER include unverified ages (like "24yo"), dates, or numbers absent from VERIFIED SOURCE FACTS.
- NEVER use derogatory insults ("entitled", "idiot", "karen", "brat").
- Create a sharp curiosity gap that works WITH the opening audio/image without spoiling the final payoff.
Return JSON matching the schema.`;
    try {
      const planRes = await aiService.generateJsonFromFiles({
        filePaths: [],
        prompt: planPrompt,
        responseSchema: TITLE_PLAN_SCHEMA,
        taskType: 'analysis',
        maxOutputTokens: 4096,
        thinkingBudget: 0
      });
      if (Array.isArray(planRes?.candidates)) plannedCandidates = planRes.candidates;
    } catch (_) {}
  }

  // Merge planned titles with deterministic fallback + strict factual verification
  const verifiedCandidates = [];
  for (let i = 0; i < windowContexts.length; i++) {
    const base = windowContexts[i];
    const planned = plannedCandidates.find(c => c.candidateId === base.candidateId) || plannedCandidates[i] || {};
    let candidateTitle = String(planned.title || '').trim();
    let check = verifyHookTitle(candidateTitle, { model, cues, mustWithhold, referenceTitle });

    if (!check.valid) {
      // Sanitize unverified age tokens or fall back to grounded conflict question/statement from scope
      const cleaned = candidateTitle
        .replace(/\b\d{1,2}\s*(?:yo|y\/o|yr\s*old|yrs\s*old|year[- ]old|years[- ]old)\b/gi, 'Driver')
        .replace(/\s+/g, ' ')
        .trim();
      const recheck = verifyHookTitle(cleaned, { model, cues, mustWithhold, referenceTitle });
      if (recheck.valid) {
        candidateTitle = cleaned;
        check = recheck;
      } else {
        const dynamicSources = [
          spine?.hookPromise,
          scope?.centralConflict,
          scope?.centralViewerQuestion
        ].map(x => String(x || '').replace(/\b\d{1,2}\s*(?:yo|y\/o|yr\s*old|yrs\s*old|year[- ]old|years[- ]old)\b/gi, '').trim()).filter(Boolean);
        const rawDynamic = dynamicSources[i % Math.max(1, dynamicSources.length)] || 'Routine Encounter Escalates Into an Unexpected Consequence';
        const firstSentence = rawDynamic.split(/(?<=[?!.])\s+/)[0] || rawDynamic;
        const words = firstSentence.split(/\s+/).filter(Boolean);
        let trimmedWords = words.length <= 14 ? words.join(' ') : words.slice(0, 12).join(' ');
        trimmedWords = trimmedWords.replace(/\s+\b(?:the|a|an|to|for|with|from|into|her|his|their|my|your|towed|stalled|broken-down|after|before|when|while|and|or|of|in|on|at)$/i, '').replace(/[.;,:]+$/, '');
        candidateTitle = trimmedWords.split(/\s+/).length >= 5
          ? trimmedWords
          : 'Routine Encounter Escalates Into an Unexpected Legal Consequence';
        check = verifyHookTitle(candidateTitle, { model, cues, mustWithhold, referenceTitle });
      }
    }

    const s = Number.isFinite(Number(planned.sourceStartSec))
      ? Math.max(base.sourceStartSec, Math.min(base.sourceEndSec - 2.5, Number(planned.sourceStartSec)))
      : base.sourceStartSec;
    const e = Number.isFinite(Number(planned.sourceEndSec))
      ? Math.min(liveActionEndSec, Math.max(s + 3.0, Math.min(base.sourceEndSec + 1.5, Number(planned.sourceEndSec))))
      : base.sourceEndSec;

    const mp4Path = await renderHookPreviewMp4({
      ffmpeg,
      dubbing,
      project,
      paths,
      candidateId: base.candidateId,
      sourceStartSec: round2(s),
      sourceEndSec: round2(e),
      title: candidateTitle,
      previewDir
    });

    verifiedCandidates.push({
      candidateId: base.candidateId,
      mp4Path,
      title: candidateTitle,
      titleVerification: check,
      footage: base.footageDescription,
      audioMode: 'original_audio',
      transcriptExcerpt: base.transcriptExcerpt,
      sourceTimestamp: `${round2(s)}s - ${round2(e)}s`,
      sourceStartSec: round2(s),
      sourceEndSec: round2(e),
      centralViewerQuestion: centralQuestion,
      expectedNextBeat: planned.expectedNextBeat || base.expectedNextBeat,
      editorialRationale: planned.editorialRationale || `Tests cold-open friction in ${round2(s)}-${round2(e)}s paired with verified non-spoiling banner.`
    });
  }

  // Multimodal evaluation of all rendered hook preview MP4s
  let multimodalDecision = null;
  if (aiService?.generateJsonFromFiles && verifiedCandidates.length >= 1) {
    const evalPrompt = `You are a Senior Short-Form Video Editor evaluating ${verifiedCandidates.length} rendered 9:16 opening hook preview MP4s (attached in order: ${verifiedCandidates.map((c, idx) => `File #${idx + 1} = ${c.candidateId} ("${c.title}", source ${c.sourceTimestamp})`).join('; ')}).

Watch and listen to EVERY attached MP4 preview from start to finish.
Central Viewer Question for the full story: "${centralQuestion}"
Must Withhold until later in the video: "${mustWithhold.join(' | ')}"

Evaluate each preview on:
1. Immediate 3-5s curiosity for a cold viewer scrolling their feed.
2. Synergy between the on-screen top banner title, the visible bodycam action, and the audible spoken line.
3. Non-spoiler integrity (raises the question without giving away the ending).
4. Clean setup into expectedNextBeat.

Select the strongest opening preview as selectedCandidateId and explain why based on what you literally saw and heard in the MP4s. Return JSON only.`;
    try {
      multimodalDecision = await aiService.generateJsonFromFiles({
        filePaths: verifiedCandidates.map(c => c.mp4Path),
        prompt: evalPrompt,
        responseSchema: MULTIMODAL_AUDITION_SCHEMA,
        taskType: 'analysis',
        maxOutputTokens: 4096,
        thinkingBudget: 0
      });
    } catch (err) {
      multimodalDecision = {
        evaluations: [],
        selectedCandidateId: verifiedCandidates[0].candidateId,
        selectionRationale: `Fallback to primary verified candidate (multimodal call error: ${err.message}).`
      };
    }
  }

  const chosen = verifiedCandidates.find(c => c.candidateId === multimodalDecision?.selectedCandidateId) || verifiedCandidates[0];
  const previousTitleAudit = referenceTitle
    ? verifyHookTitle(referenceTitle, { model, cues, mustWithhold, referenceTitle: '' })
    : null;

  const report = {
    contract: 'hook-audition-v1',
    generatedAt: new Date().toISOString(),
    candidateCount: verifiedCandidates.length,
    previousBenchmarkTitleAudit: previousTitleAudit,
    selectedCandidateId: chosen.candidateId,
    selectedTitle: chosen.title,
    selectedMp4Path: chosen.mp4Path,
    selectionRationale: multimodalDecision?.selectionRationale || chosen.editorialRationale,
    candidates: verifiedCandidates.map(c => ({
      ...c,
      multimodalEvaluation: (multimodalDecision?.evaluations || []).find(e => e.candidateId === c.candidateId) || null
    }))
  };

  const reportPath = path.join(outputDir, 'hook-audition-report.json');
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2));
  return { report, reportPath, chosen };
}

const PREFERRED_ARCHETYPES = [
  'Physical Friction / Barricade Suspense',
  'The Absurd Contradiction',
  'In Medias Res',
  'Instant Karma / The Fatal Mistake',
  'Unbelievable Stakes',
  'Revelation / Shocking Discovery',
  'Accusation',
  'Emotional Shock',
  'Authority Reversal',
  'Dialogue Conflict',
  'Other'
];

function calculateOverallHookScore(scores = {}) {
  const visual = Math.max(0, Math.min(100, Number(scores.visual_immediacy) || 0));
  const conflict = Math.max(0, Math.min(100, Number(scores.conflict) || 0));
  const curiosity = Math.max(0, Math.min(100, Number(scores.curiosity_gap) || 0));
  const dialogue = Math.max(0, Math.min(100, Number(scores.dialogue_strength) || 0));
  const payoff = Math.max(0, Math.min(100, Number(scores.payoff_potential) || 75));
  const spoiler = Math.max(0, Math.min(100, Number(scores.spoiler_risk) || 0));

  const weighted = (visual * 0.25)
    + (conflict * 0.25)
    + (curiosity * 0.25)
    + (dialogue * 0.15)
    + (payoff * 0.10)
    - (spoiler * 0.20);

  return Math.max(1, Math.min(100, Math.round(weighted)));
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function generateHookTitle(candidate) {
  const dialogue = String(candidate.keyDialogue || '').replace(/\s+/g, ' ').trim();
  if (dialogue) return `Transcript: "${dialogue.length > 60 ? `${dialogue.slice(0, 57)}...` : dialogue}"`;
  return `Motion/audio spike at ${formatTime(candidate.sourceStartSec)}`;
}

function generateHookRationale(candidate, overallScore) {
  const reasons = [];
  if (candidate.scores?.visual_immediacy >= 80) reasons.push('Radar chuyển động/âm lượng cao (chưa xác minh nội dung)');
  if (candidate.scores?.dialogue_strength >= 80) reasons.push('Transcript khớp mẫu thoại xung đột');
  if (candidate.scores?.curiosity_gap >= 85) reasons.push('Tạo khoảng trống tò mò lớn khiến khán giả nán lại xem giải thích');
  if (candidate.scores?.spoiler_risk <= 20) reasons.push('Không nằm ở đoạn cuối video (rủi ro spoil thấp theo radar)');
  return reasons.join('. ') || `Điểm radar: ${overallScore}/100 (ứng viên tự động, cần xem footage)`;
}

function formatCandidateForAudit(candidate, rank = 1) {
  const scores = candidate.scores || {};
  const overall = calculateOverallHookScore(scores);
  return {
    rank,
    hookId: candidate.candidateId || `hook_${String(rank).padStart(2, '0')}`,
    title: candidate.title || generateHookTitle(candidate),
    archetype: candidate.archetype || 'Unclassified Radar Candidate',
    provenance: candidate.provenance || 'deterministic_radar',
    semanticStatus: candidate.semanticStatus || 'unverified',
    sourceStartSec: Number(candidate.sourceStartSec || 0),
    sourceEndSec: Number(candidate.sourceEndSec || 0),
    durationSec: Number((candidate.sourceEndSec - candidate.sourceStartSec).toFixed(2)),
    coreEventDescription: candidate.coreEventDescription || '',
    keyDialogue: candidate.keyDialogue || '',
    scores: {
      overall,
      visual_immediacy: Number(scores.visual_immediacy || 60),
      conflict: Number(scores.conflict || 60),
      curiosity_gap: Number(scores.curiosity_gap || 60),
      dialogue_strength: Number(scores.dialogue_strength || 50),
      spoiler_risk: Number(scores.spoiler_risk || 15),
      payoff_potential: Number(scores.payoff_potential || 80)
    },
    rationale: generateHookRationale(candidate, overall)
  };
}

class HookAuditionService {
  constructor(settings = {}) {
    this.settings = settings;
  }

  async audition({
    transcriptCues = [],
    actionCandidates = [],
    manifest = {},
    durationSec = 0,
    topCount = 5
  } = {}) {
    const minedCandidates = mineHookCandidateRegions({
      transcriptCues,
      actionCandidates,
      manifest,
      durationSec,
      maxCandidates: 25
    });

    if (!minedCandidates.length) {
      return {
        success: false,
        warning: 'Không tìm thấy ứng viên hook nào đủ điều kiện từ nguồn.',
        topCandidates: []
      };
    }

    const ranked = minedCandidates
      .map((c, idx) => formatCandidateForAudit(c, idx + 1))
      .sort((a, b) => b.scores.overall - a.scores.overall);

    const topCandidates = ranked.slice(0, Math.max(3, Math.min(topCount, 5)));

    return {
      success: true,
      totalMinedCount: minedCandidates.length,
      topCandidates,
      defaultRecommendedHook: topCandidates[0] || null
    };
  }
}

module.exports = HookAuditionService;
module.exports.PREFERRED_ARCHETYPES = PREFERRED_ARCHETYPES;
module.exports.calculateOverallHookScore = calculateOverallHookScore;
module.exports.formatCandidateForAudit = formatCandidateForAudit;
module.exports.verifyHookTitle = verifyHookTitle;
module.exports.deriveCandidateWindows = deriveCandidateWindows;
module.exports.renderHookPreviewMp4 = renderHookPreviewMp4;
module.exports.runHookAudition = runHookAudition;

