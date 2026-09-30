// AutoStory v3 — deterministic compile: cast beats + narration -> renderer
// segment contract. Reuses the real v2 compiler primitives (range/hash/words/
// budget/validateDuration) so output stays byte-compatible with the existing
// Highlight renderer, while carrying v3 semantics (audio strategy, duck, emotion,
// prosody, open loops, narrator function).

const compiler = require('./autoStoryTimelineCompiler');
const { StoryError } = require('./autoStoryRepairRouter');
const { toV2Role, strategyToAudioMode } = require('./autoStoryV3Taxonomy');
const { resolveTtsIntent } = require('./ttsIntent');
const Delivery = require('./deliveryBlockService');

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
        sourceEventId: beat.sourceEventId || null,
        deliveryBlockId: beat.deliveryBlockId || null
      }
    };
  });
}

// Build renderer-compatible segments. Mirrors autoStoryTimelineCompiler.compile
// but honors v3 audio semantics (does not force requireOriginal at .85, because
// the audio-role state machine + source-model classification already gate this).
function compileV3(beats, { story, evidence, config, sourceDuration = Infinity, deliveryBlocks = null }) {
  const decisions = mapBeatsToDecisions(beats);
  if (!decisions.length) throw new StoryError('STRUCTURAL_STORY', 'No v3 beats to compile.');
  // Delivery blocks: the audio of a narrated_story block is ONE passage owned by
  // the block (canonical text lives once, on the block), never per beat.
  const blocks = Array.isArray(deliveryBlocks) && deliveryBlocks.length ? deliveryBlocks : null;
  if (blocks) {
    const problems = Delivery.validateDeliveryBlocks(beats, blocks, { narrationEnabled: config.narration?.enabled !== false });
    if (problems.length) throw new StoryError('LOCAL_EDITORIAL', `Delivery blocks do not cover the EDL: ${problems.map(v => v.code).join(', ')}`, { violations: problems });
  }
  const blockOf = new Map();
  (blocks || []).forEach((b, order) => b.beatIds.forEach((id, position) => blockOf.set(id, { block: b, order, position })));

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

    const member = blockOf.get(d._v3.beatId) || null;
    const key = compiler.hash([start, end, d.audioIntent, d.voiceoverText, member ? `${member.block.blockId}:${member.block.narrationText || ''}` : '']);
    if (seen.has(key)) throw new StoryError('LOCAL_EDITORIAL', 'Exact duplicate footage and meaning.', { index });
    seen.add(key);

    if (member && member.block.mode === 'narrated_story') {
      if (d.voiceoverText.trim()) throw new StoryError('LOCAL_EDITORIAL', 'A beat inside a narrated block must not carry its own narration line.', { index });
    } else if (member && d.audioIntent === 'narration') {
      throw new StoryError('LOCAL_EDITORIAL', 'A raw_evidence block beat cannot be narrated.', { index });
    } else if (d.audioIntent === 'narration') {
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
      sourceEventId: v3.sourceEventId,
      beatId: v3.beatId
    };
    if (member) {
      Object.assign(segment, { deliveryBlockId: member.block.blockId, deliveryMode: member.block.mode,
        deliveryBlockOrder: member.order, deliveryBlockPosition: member.position, deliveryBlockSize: member.block.beatIds.length });
    }
    cursor = segment.outputEndSec;
    return segment;
  });

  const compiledBlocks = blocks ? compileDeliveryBlocks(blocks, segments, config) : null;

  if (segments[0].storyRole !== 'hook') throw new StoryError('STRUCTURAL_STORY', 'Opening must map to a hook.');

  const script = {
    contractVersion: 3, scriptId: story.scriptId, title: story.title,
    narrationArc: story.centralViewerQuestion,
    spine: story.spine || null,
    openLoops: story.openLoops || [],
    segments, measuredDuration: cursor, sourceDecisions: decisions.map(d => ({ ...d, _v3: undefined })),
    ...(compiledBlocks ? { deliveryContract: Delivery.DELIVERY_CONTRACT, deliveryBlocks: compiledBlocks } : {})
  };
  compiler.validateDuration(script, config);
  return script;
}

// One canonical passage per narrated block; ONE source-audio treatment per block.
function compileDeliveryBlocks(blocks, segments, config) {
  return blocks.map((b, order) => {
    const members = segments.filter(s => s.deliveryBlockId === b.blockId);
    const outputStartSec = members[0].outputStartSec, outputEndSec = members[members.length - 1].outputEndSec;
    const durationSec = outputEndSec - outputStartSec;
    const base = { blockId: b.blockId, mode: b.mode, order, beatIds: [...b.beatIds], segmentIds: members.map(s => s.id),
      outputStartSec, outputEndSec, durationSec, storyFunction: b.storyFunction || '' };
    if (b.mode !== 'narrated_story') {
      members.forEach(s => { if (s.audioMode !== 'original_audio') throw new StoryError('LOCAL_EDITORIAL', `Raw block '${b.blockId}' must keep original audio.`, { blockId: b.blockId }); });
      return { ...base, evidenceFunction: b.evidenceFunction || '', sourceAudioTreatment: 'original_audio' };
    }
    const narrationText = String(b.narrationText || '').trim();
    if (!config.narration?.enabled || !narrationText) throw new StoryError('LOCAL_EDITORIAL', `Narrated block '${b.blockId}' has no narration passage or narration is disabled.`, { blockId: b.blockId });
    const safeWords = Delivery.blockSafeWords(durationSec, config.narration.measuredWordsPerSecond);
    if (safeWords > 0 && compiler.words(narrationText) > safeWords) {
      throw new StoryError('VOICE_BUDGET', `Narrated block '${b.blockId}' exceeds its whole-block safe word ceiling.`, { blockId: b.blockId, safeWords });
    }
    // Technical treatment: a member whose source carries another narrator forces voiceover_only.
    const treatment = members.some(s => s.audioMode === 'voiceover_only') || Delivery.audioModeFor(b) === 'voiceover_only' ? 'voiceover_only' : 'voiceover_with_ambient';
    members.forEach(s => Object.assign(s, { audioMode: treatment, duck: treatment === 'voiceover_with_ambient', mute: treatment === 'voiceover_only',
      blockSourceAudio: treatment, voiceoverText: '', previewVi: '' }));
    const fingerprint = compiler.hash([b.blockId, treatment, narrationText, ...members.map(s => `${s.sourceStartSec}-${s.sourceEndSec}`)]);
    Object.assign(members[0], { blockNarrationText: narrationText, blockNarrationPreviewVi: b.previewVi || '', blockNarratorFunction: b.narratorFunction || '',
      blockNarrationIntent: b.narrationIntent || '', blockStoryFunction: b.storyFunction || '', blockEmotionTag: b.emotionTag || 'NEUTRAL',
      blockHandoffTargetBeatId: b.handoffTargetBeatId || '', blockNarrationHash: fingerprint });
    return { ...base, narratorFunction: b.narratorFunction || '', narrationIntent: b.narrationIntent || '', handoffTargetBeatId: b.handoffTargetBeatId || null,
      sourceAudioTreatment: treatment, narrationText, previewVi: b.previewVi || '', newInformation: b.newInformation || [], newInformationRefs: b.newInformationRefs || [],
      safeWords, words: compiler.words(narrationText), rawBlockVoiceSec: b.rawBlockVoiceSec ?? null, fitRatio: b.fitRatio ?? null, fingerprint };
  });
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
        source_narrator_detected: s.deliveryMode === 'narrated_story' ? false : s.sourceNarratorPresent, playbackSpeed: 1,
        beat_id: s.beatId || '',
        ...(s.deliveryBlockId ? {
          delivery_block_id: s.deliveryBlockId, delivery_mode: s.deliveryMode, delivery_block_order: s.deliveryBlockOrder,
          delivery_block_position: s.deliveryBlockPosition, delivery_block_size: s.deliveryBlockSize,
          ...(s.deliveryMode === 'narrated_story' ? { block_source_audio: s.blockSourceAudio } : {}),
          ...(s.blockNarrationText ? {
            block_narration_text: s.blockNarrationText, block_narration_preview_vi: s.blockNarrationPreviewVi,
            block_narrator_function: s.blockNarratorFunction, block_narration_intent: s.blockNarrationIntent,
            block_story_function: s.blockStoryFunction, block_emotion_tag: s.blockEmotionTag,
            block_handoff_target_beat_id: s.blockHandoffTargetBeatId, block_narration_hash: s.blockNarrationHash
          } : {})
        } : {})
      };
    }),
    ...(script.deliveryBlocks ? { delivery_contract: script.deliveryContract, delivery_blocks: script.deliveryBlocks } : {})
  };
}

module.exports = { mapBeatsToDecisions, compileV3, compileDeliveryBlocks, highlightV3, isUncleanAudio };
