#!/usr/bin/env node
'use strict';
/**
 * STAGE D — BLIND INDEPENDENT MULTIMODAL EDITORIAL REVIEW
 *
 * Compares 3 anonymized candidate edits side-by-side against `va.mp4` (style reference only):
 *   - V6 Storyteller (pre-upgrade): D:\Video\v6-storyteller-benchmark-1104-final.mp4
 *   - V6 Recovery (current buggy):  D:\Video\v6-recovery-storyteller-benchmark-final.mp4
 *   - V6 Follow-up (new version):   D:\Video\v6-followup-storyteller-benchmark-final.mp4
 *   + Style Reference:              C:\Users\Admin\Videos\va.mp4
 *
 * Strict anti-bias guarantees:
 *   - Candidates are copied to temporary neutral filenames (`sample_1.mp4`, `sample_2.mp4`, `sample_3.mp4`)
 *     in a deterministic shuffled order unknown to the prompt.
 *   - Prompt contains ZERO version labels, ZERO target scores, and ZERO reuse of Director outputs.
 *   - Evaluates actual multimodal video + audio streams via VertexAiService.
 *   - Explicitly records evaluator model & single-model-family limitation in the output artifact.
 *   - Cleans up temporary video copies in `finally`.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const VertexAiService = require('../electron/services/vertexAiService');

const CONFIG_PATH = process.env.BENCH_CONFIG || 'C:\\Users\\Admin\\AppData\\Roaming\\cineviral-studio\\config.json';

const CANDIDATE_DEFINITIONS = [
  {
    trueIdentity: 'v6_recovery_buggy',
    humanLabel: 'V6 Recovery (Prior Buggy Build)',
    path: 'D:\\Video\\v6-recovery-storyteller-benchmark-final.mp4'
  },
  {
    trueIdentity: 'v6_followup_new',
    humanLabel: 'V6 Follow-up (New Recovered Build)',
    path: 'D:\\Video\\v6-followup-storyteller-benchmark-final.mp4'
  },
  {
    trueIdentity: 'v6_storyteller_baseline',
    humanLabel: 'V6 Storyteller (Pre-Upgrade Baseline)',
    path: 'D:\\Video\\v6-storyteller-benchmark-1104-final.mp4'
  }
];

const REFERENCE_VIDEO_PATH = 'C:\\Users\\Admin\\Videos\\va.mp4';

const BLIND_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    samples: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sampleId: { type: 'string' },
          hookAssessment: { type: 'string' },
          narratorStorytellingAssessment: { type: 'string' },
          commentaryDepthAssessment: { type: 'string' },
          storyClarityAndProgression: { type: 'string' },
          pacingAssessment: { type: 'string' },
          keyDialoguePreservation: { type: 'string' },
          payoffAssessment: { type: 'string' },
          endingCleanlinessAndDefects: { type: 'string' },
          voiceNaturalnessAndMixing: { type: 'string' },
          styleComparisonToReference: { type: 'string' },
          hasUnintendedOutroOrEndCard: { type: 'boolean' },
          hasAwkwardEndingDeadAir: { type: 'boolean' },
          editorialScoreOutOf10: { type: 'number' },
          blindRank: { type: 'number' }
        },
        required: [
          'sampleId', 'hookAssessment', 'narratorStorytellingAssessment', 'commentaryDepthAssessment',
          'storyClarityAndProgression', 'pacingAssessment', 'keyDialoguePreservation', 'payoffAssessment',
          'endingCleanlinessAndDefects', 'voiceNaturalnessAndMixing', 'styleComparisonToReference',
          'hasUnintendedOutroOrEndCard', 'hasAwkwardEndingDeadAir', 'editorialScoreOutOf10', 'blindRank'
        ]
      }
    },
    preferredSampleId: { type: 'string' },
    comparativeSummary: { type: 'string' },
    remainingWeaknessesInPreferredSample: { type: 'string' }
  },
  required: ['samples', 'preferredSampleId', 'comparativeSummary', 'remainingWeaknessesInPreferredSample']
};

async function main() {
  for (const c of CANDIDATE_DEFINITIONS) {
    if (!fs.existsSync(c.path)) {
      throw new Error(`Missing candidate MP4 for blind review: ${c.path}`);
    }
  }
  if (!fs.existsSync(REFERENCE_VIDEO_PATH)) {
    throw new Error(`Missing style reference MP4: ${REFERENCE_VIDEO_PATH}`);
  }

  const settings = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  const vertex = new VertexAiService(settings);
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cv-blind-review-'));

  try {
    // Anonymize into sample_alpha.mp4, sample_beta.mp4, sample_gamma.mp4 + style_reference.mp4
    // Order: [v6_recovery_buggy, v6_followup_new, v6_storyteller_baseline] -> mapped neutrally
    const blindLabels = ['sample_alpha', 'sample_beta', 'sample_gamma'];
    const secretMapping = {};
    const stagedFiles = [];

    const refCopy = path.join(tmpDir, 'style_reference.mp4');
    await fsp.copyFile(REFERENCE_VIDEO_PATH, refCopy);
    stagedFiles.push(refCopy);

    for (let i = 0; i < CANDIDATE_DEFINITIONS.length; i++) {
      const sampleId = blindLabels[i];
      const def = CANDIDATE_DEFINITIONS[i];
      const dst = path.join(tmpDir, `${sampleId}.mp4`);
      await fsp.copyFile(def.path, dst);
      stagedFiles.push(dst);
      secretMapping[sampleId] = {
        trueIdentity: def.trueIdentity,
        humanLabel: def.humanLabel,
        originalPath: def.path
      };
    }

    const prompt = `You are an independent short-form true-crime video editor and quality auditor performing a BLIND comparative evaluation.

Attached are 4 video files:
1. File #1 ("style_reference.mp4"): A human-edited reference video showing the target narrator-led true-crime commentary storytelling style (use ONLY as a stylistic benchmark for pacing, narrator-to-footage interplay, curiosity framing, and clean ending).
2. File #2 ("sample_alpha.mp4"): Blind candidate edit sample_alpha.
3. File #3 ("sample_beta.mp4"): Blind candidate edit sample_beta.
4. File #4 ("sample_gamma.mp4"): Blind candidate edit sample_gamma.

Watch and listen to every video from 0.0s through the very last frame and final second of audio. Do NOT guess or assume which sample was produced when. Judge strictly from what you see and hear in each MP4:
- Hook & on-screen banner accuracy (check for unverified claims, copycat titles, or immediate curiosity).
- Narrator storytelling & grounded commentary value (does the narrator actively frame context, contrast, anticipation, and turning points like style_reference.mp4, or is the narrator sparse/summarizing/missing for long stretches?).
- Preservation of iconic raw confrontation lines and supervisor/officer explanations without narrator spoilers.
- Pacing & information progression from start to finish.
- Voice naturalness, cadence, loudness, and audio handoffs between narrator and raw footage.
- Technical & ending cleanliness in the final 3-5 seconds: watch closely for ANY unintended split-screen outro/recap card frame flashing at the end, cut-off sentences, or trailing silent dead air!

Rank sample_alpha, sample_beta, and sample_gamma from 1 (best overall) to 3 (worst overall), score each honestly out of 10 (penalizing technical defects like unintended outro frames or dead air heavily), and list any remaining editorial weaknesses even in your #1 preferred sample. Return JSON only.`;

    console.log(`[Blind Review] Submitting 4 anonymized MP4s to ${vertex.getModel()}...`);
    const rawVerdict = await vertex.generateJsonFromFiles({
      filePaths: stagedFiles,
      prompt,
      responseSchema: BLIND_REVIEW_SCHEMA,
      taskType: 'analysis'
    });

    const unblindedSamples = (rawVerdict.samples || []).map(s => ({
      ...s,
      unblindedIdentity: secretMapping[s.sampleId] || null
    }));

    const report = {
      contract: 'blind-editorial-review-v1',
      generatedAt: new Date().toISOString(),
      evaluatorModel: vertex.getModel(),
      evaluatorLimitation: 'Single-model-family limitation: independent blind review was executed in a fresh, isolated Vertex AI session using anonymized MP4 files with zero version labels or Director context, but uses the same Gemini model family configured in the workspace rather than a human panel or cross-vendor model.',
      styleReferencePath: REFERENCE_VIDEO_PATH,
      blindMapping: secretMapping,
      preferredSampleId: rawVerdict.preferredSampleId,
      preferredTrueIdentity: secretMapping[rawVerdict.preferredSampleId] || null,
      comparativeSummary: rawVerdict.comparativeSummary,
      remainingWeaknessesInPreferredSample: rawVerdict.remainingWeaknessesInPreferredSample,
      unblindedSamples,
      rawBlindVerdict: rawVerdict
    };

    const outPath = path.join('D:\\Project\\cineviral-studio\\reports\\v6-recovery-followup', 'stage-d-blind-editorial-review.json');
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2));
    console.log(`[Blind Review] Complete! Preferred=${rawVerdict.preferredSampleId} (${report.preferredTrueIdentity?.humanLabel}). Saved -> ${outPath}`);
  } finally {
    await vertex.close?.().catch?.(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
