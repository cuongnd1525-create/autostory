// AutoStory v3 — deterministic compile: cast beats + narration -> renderer
// segment contract. Reuses the real v2 compiler primitives (range/hash/words/
// budget/validateDuration) so output stays byte-compatible with the existing
// Highlight renderer, while carrying v3 semantics (audio strategy, duck, emotion,
// prosody, open loops, narrator function).

const compiler = require('./autoStoryTimelineCompiler');
const { StoryError } = require('./autoStoryRepairRouter');
const { toV2Role, strategyToAudioMode } = require('./autoStoryV3Taxonomy');
const { resolveTtsIntent } = require('./ttsIntent');

// A beat is "unclean" when the chosen source audio is an external narrator.
// "mixed" in bodycam audio is diegetic shouting/struggle, which should be ducked, not muted.
function isUncleanAudio(beat) {
  const t = beat.audioType;
  return t === 'external_narrator';
}

// Map v3 cast+narrated beats to v2-style editorial decisions.
function mapBeatsToDecisions(beats = []) {
  return beats.map(beat => {
    const unclean = isUncleanAudio(beat);
    const am = strategyToAudioMode(beat.audioStrategy || 'original', { unclean });
    const audioIntent = am.audioIntent;
    return {
      // v2 decision fields (consumed by compile below):
      sourceStartSec: beat.sourceStartSec,
      sourceEndSec: beat.sourceEndSec,
      storyRole: toV2Role(beat.narrativeRole),
      audioIntent,
      reason: beat.viewerQuestion || beat.castReason || beat.narrativeRole || '',
      voiceoverText: audioIntent === 'narration' ? String(beat.narratorText || '') : '',
      previewVi: audioIntent === 'narration' ? String(beat.previewVi || '') : '',
      audio: { audioType: beat.audioType || 'uncertain', confidence: Number(beat.audioConfidence) || 0 },
      // v3 metadata carried through for highlightV3:
      _v3: {
        beatId: beat.beatId,
        narrativeRole: beat.narrativeRole,
        narratorFunction: beat.narratorFunction || null,
        audioStrategy: beat.audioStrategy || 'original',
        audioMode: am.audioMode,
        duck: am.duck,
        mute: am.mute,
        unclean,
        emotionTag: beat.emotionTag || 'NEUTRAL',
        prosody: beat.prosody || {},
        informationClass: beat.informationClass || null,
        opensLoopId: beat.opensLoopId || null,
        closesLoopId: beat.closesLoopId || null,
        newInformation: beat.newInformation || [],
        newInformationRefs: beat.newInformationRefs || [],
        sourceEventId: beat.sourceEventId || null
      }
    };
  });
}

// Build renderer-compatible segments. Mirrors autoStoryTimelineCompiler.compile
// but honors v3 audio semantics (does not force requireOriginal at .85, because
// the audio-role state machine + source-model classification already gate this).
function compileV3(beats, { story, evidence, config, sourceDuration = Infinity }) {
  const decisions = mapBeatsToDecisions(beats);
  if (!decisions.length) throw new StoryError('STRUCTURAL_STORY', 'No v3 beats to compile.');

  const seen = new Set();
  let cursor = 0;
  const segments = decisions.map((d, index) => {
    const { start, end } = compiler.range(d, evidence, sourceDuration);
    const clip = evidence.find(e => {
      const sStart = e.sourceStart ?? e.sourceStartSec;
      const sDur = e.duration ?? (e.sourceEndSec - e.sourceStartSec);
      return Number.isFinite(sStart) && Number.isFinite(sDur) && sDur > 0 && e.id
        && start >= sStart - 1e-4 && end <= sStart + sDur + 1e-4;
    });
    if (!clip) throw new StoryError('EVIDENCE_REQUIRED', 'v3 range not covered by one evidence clip.', { start, end });

    const key = compiler.hash([start, end, d.audioIntent, d.voiceoverText]);
    if (seen.has(key)) throw new StoryError('LOCAL_EDITORIAL', 'Exact duplicate footage and meaning.', { index });
    seen.add(key);

    if (d.audioIntent === 'narration') {
      if (!config.narration?.enabled || !d.voiceoverText.trim()) {
        throw new StoryError('LOCAL_EDITORIAL', 'Narration disabled or empty on a narration beat.', { index });
      }
      const safeWords = compiler.budget(end - start, config.narration.measuredWordsPerSecond);
      if (safeWords > 0 && compiler.words(d.voiceoverText) > safeWords) {
        throw new StoryError('VOICE_BUDGET', 'Narration exceeds safe word budget.', { index, safeWords });
      }
    } else if (d.voiceoverText.trim()) {
      throw new StoryError('LOCAL_EDITORIAL', 'Original-audio beat unexpectedly carries narration.', { index });
    }

    const v3 = d._v3;
    const clipStart = clip.sourceStart ?? clip.sourceStartSec;
    const id = `s${story.scriptId}_${compiler.hash([index, start, end, v3.narrativeRole])}`;
    const segment = {
      id, evidenceId: clip.id,
      start: start - clipStart, end: end - clipStart,
      sourceStartSec: start, sourceEndSec: end,
      outputStartSec: cursor, outputEndSec: cursor + (end - start),
      storyRole: d.storyRole,                        // v2 role for renderer
      narrativeRoleV3: v3.narrativeRole,             // rich v3 role
      narrativePurpose: d.reason,
      // Audio: duck-aware. narrator over clean source -> voiceover_with_ambient.
      audioMode: v3.audioMode,
      audioStrategy: v3.audioStrategy,
      duck: v3.duck, mute: v3.mute, audioUnclean: v3.unclean,
      sourceNarratorPresent: d.audioIntent === 'original' ? false : v3.unclean,
      audioClassification: d.audio,
      voiceoverText: d.voiceoverText, previewVi: d.previewVi,
      narratorFunction: v3.narratorFunction,
      emotionTag: v3.emotionTag, prosody: v3.prosody,
      informationClass: v3.informationClass,
      opensLoopId: v3.opensLoopId, closesLoopId: v3.closesLoopId,
      newInformation: v3.newInformation, newInformationRefs: v3.newInformationRefs,
      sourceEventId: v3.sourceEventId
    };
    cursor = segment.outputEndSec;
    return segment;
  });

  if (segments[0].storyRole !== 'hook') throw new StoryError('STRUCTURAL_STORY', 'Opening must map to a hook.');

  const script = {
    contractVersion: 3, scriptId: story.scriptId, title: story.title,
    narrationArc: story.centralViewerQuestion,
    spine: story.spine || null,
    openLoops: story.openLoops || [],
    segments, measuredDuration: cursor, sourceDecisions: decisions.map(d => ({ ...d, _v3: undefined }))
  };
  compiler.validateDuration(script, config);
  return script;
}

// Final artifact consumed by the Highlight renderer (superset of v2's highlight()).
function highlightV3(script, story, evidence) {
  return {
    artifactType: 'vertex_auto_story_script', schemaVersion: 3, contractVersion: 3,
    scriptId: script.scriptId, title: script.title, top_header: script.title,
    language: 'en', sourceLanguage: 'en', prompt_profile: 'vertex_auto_story_v3',
    voiceover_enabled: script.segments.some(s => s.audioMode !== 'original_audio'),
    story_contract: story, spine: script.spine || null, open_loops: script.openLoops || [],
    segments: script.segments.map(s => {
      const e = evidence.find(x => x.id === s.evidenceId);
      const start = Number.isFinite(s.sourceStartSec) ? s.sourceStartSec
        : (e ? (e.sourceStart ?? e.sourceStartSec) + s.start : s.start);
      const end = Number.isFinite(s.sourceEndSec) ? s.sourceEndSec
        : (e ? (e.sourceStart ?? e.sourceStartSec) + s.end : s.end);
      return {
        id: s.id, sourceStartSec: start, sourceEndSec: end,
        audio_mode: s.audioMode, audio_strategy: s.audioStrategy,
        duck: s.duck, mute: s.mute, source_audio_unclean: s.audioUnclean,
        voiceover_text: s.voiceoverText, preview_vi: s.previewVi,
        storyFunction: s.storyRole, narrativeRole: s.narrativeRoleV3, narrativePurpose: s.narrativePurpose,
        narrator_function: s.narratorFunction,
        emotionTag: s.emotionTag, prosody: s.prosody,
        information_class: s.informationClass,
        opens_loop_id: s.opensLoopId, closes_loop_id: s.closesLoopId,
        source_narrator_detected: s.sourceNarratorPresent, playbackSpeed: 1
      };
    })
  };
}

module.exports = { mapBeatsToDecisions, compileV3, highlightV3, isUncleanAudio };
