const assert = require("assert");
const DubbingService = require("../electron/services/dubbingService");
const { resolveVoiceVisualFit } = require("../electron/services/voiceTimingPolicy");

const PROJECT = { analysisWorkflow: "manual_gemini_draft_review", sourceVideoPath: "/src.mp4", mixer: { voiceVolume: 100 } };
const LINES = [
  "Officers found the driver slumped beside a shattered streetlight.",
  "He could not say where he was or how the crash happened.",
  "Then a paramedic noticed something strange inside the car."
];

function manualBlockMembers() {
  const segments = LINES.map((text, index) => ({
    id: `seg_${index + 1}`, sceneId: `scene_${index + 1}`,
    sourceStartSec: 100 + index * 4, sourceEndSec: 104 + index * 4, duration: 4,
    audioMode: "voiceover_only", audio_mode: "voiceover_only", voiceoverText: text, voiceover_text: text
  }));
  const planned = DubbingService.buildManualDraftContinuousNarration(segments, PROJECT, {});
  const runs = DubbingService.narratedBlockRuns(planned);
  assert.strictEqual(runs.length, 1, "three adjacent 4s voiceovers form one 12s manual draft block");
  return planned.slice(runs[0].start, runs[0].end + 1);
}

function fakeRender(voiceSec) {
  const order = [];
  const calls = { extract: [], fit: [], mix: [], normalize: [] };
  let lastNormalizeTarget = 0;
  const ffmpeg = {
    extractVoiceDrivenClipWithAudio: async (a) => { order.push("extract"); calls.extract.push(a); },
    normalizeMediaDuration: async (a) => { calls.normalize.push(a); lastNormalizeTarget = a.targetDuration; },
    concatSegmentsByFilter: async () => {},
    probeAudio: async () => { order.push("probe_voice"); return { duration: voiceSec }; },
    fitDubbingClusterAudio: async (a) => { calls.fit.push(a); return { outputDuration: a.targetDuration, fitStrategy: "speed_up" }; },
    mixVideoAudioWithVoice: async (a) => { calls.mix.push(a); },
    probeVideo: async () => ({ duration: lastNormalizeTarget })
  };
  const svc = Object.create(DubbingService.prototype);
  svc.synthesizeFastDraftVoice = async () => { order.push("tts"); return { cacheHit: false }; };
  svc.recordVoiceProfileSample = async () => null;
  return { svc, ffmpeg, calls, order };
}

const args = (ffmpeg, extra = {}) => ({
  ffmpeg, project: PROJECT, settings: {}, workspaceRoot: "/w", paths: { audioDir: "/a", clipsDir: "/c" },
  variantSuffix: "v1", draftVoiceProvider: "edge", draftVoiceExt: ".mp3", autoStorySourceStat: null,
  members: manualBlockMembers(), startIndex: 2, ...extra
});

(async () => {
  // 1. Real TTS longer than the block (+12.5% > +4% speed-up): the manual draft
  //    keeps every word, slows visuals evenly and does NOT fail the draft.
  {
    const { svc, ffmpeg, calls, order } = fakeRender(13.5);
    const out = await svc.renderNarratedDeliveryBlock(args(ffmpeg, { overflowPolicy: "stretch_visuals" }));
    assert.strictEqual(order[0], "tts", "voice is synthesized and measured before any video work");
    assert.strictEqual(order[1], "probe_voice");
    const expectedTimeline = 13.5 / 1.04 + 0.12;
    const extracted = calls.extract.reduce((sum, a) => sum + a.targetDurationSec, 0);
    assert.ok(Math.abs(extracted - expectedTimeline) < 0.01, `visual timeline ${extracted} ~ ${expectedTimeline}`);
    assert.ok(calls.extract.every((a) => Math.abs(a.targetDurationSec / a.sourceDurationSec - calls.extract[0].targetDurationSec / calls.extract[0].sourceDurationSec) < 0.002), "slow-down is distributed evenly");
    assert.ok(Math.abs(calls.fit[0].targetDuration - expectedTimeline) < 0.01);
    assert.ok(13.5 / calls.fit[0].targetDuration <= 1.04 + 1e-6, "voice speed-up stays within the 4% cap");
    assert.strictEqual(calls.fit[0].allowTrim, false);
    assert.strictEqual(out.report.plannedBlockTimelineSec, 12);
    assert.ok(out.report.visualStretchRatio > 1.08 && out.report.visualStretchRatio < 1.1);
    assert.strictEqual(out.report.visualFitStrategy, "block_distributed_slowdown_to_voice");
    assert.strictEqual(out.report.requiresRewrite, false, "within the 10% visual slow-down safety band");
    assert.match(out.report.voiceFitWarning, /giữ đủ câu/);
    assert.strictEqual(out.memberReports.length, 3);
    assert.ok(out.memberReports.every((r) => r.requestedTimelineSec === 4 && r.timelineSec > 4));
    const memberSum = out.memberReports.reduce((sum, r) => sum + r.timelineSec, 0);
    assert.ok(Math.abs(memberSum - out.report.blockTimelineSec) < 0.01, "member timelines add up to the rendered block");
    assert.deepStrictEqual(out.report.pieceTimelineSec, out.memberReports.map((r) => r.timelineSec));
  }

  // 2. Far too long: still renders with the full voice, flagged for rewrite.
  {
    const { svc, ffmpeg } = fakeRender(16);
    const out = await svc.renderNarratedDeliveryBlock(args(ffmpeg, { overflowPolicy: "stretch_visuals" }));
    assert.strictEqual(out.report.requiresRewrite, true);
    assert.match(out.report.voiceFitWarning, /vượt mức an toàn/);
  }

  // 3. Within the cap: unchanged EDL timing, no warning.
  {
    const { svc, ffmpeg, calls } = fakeRender(12.3);
    const out = await svc.renderNarratedDeliveryBlock(args(ffmpeg, { overflowPolicy: "stretch_visuals" }));
    assert.deepStrictEqual(calls.extract.map((a) => a.targetDurationSec), [4, 4, 4]);
    assert.strictEqual(out.report.visualStretchRatio, 1);
    assert.strictEqual(out.report.voiceFitWarning, "");
    assert.ok(out.memberReports.every((r) => r.timelineSec === 4 && r.visualFitStrategy === "as_requested"));
  }

  // 4. Default policy (AutoStory EDL contract) still fails fast, now before any video work.
  {
    const { svc, ffmpeg, calls } = fakeRender(13.5);
    await assert.rejects(svc.renderNarratedDeliveryBlock(args(ffmpeg)), (e) => e.code === "BLOCK_VOICE_OVERFLOW");
    assert.strictEqual(calls.extract.length, 0);
    assert.strictEqual(calls.mix.length, 0);
  }

  // 5. Block placement follows the rendered timeline after a stretched block.
  {
    const segments = [{ duration: 5 }, { duration: 4 }, { duration: 4 }, { duration: 6 }];
    const placed = DubbingService.placeNarratedBlocks(segments, [{ startIndex: 3, blockTimelineSec: 6 }], [5, 4.4, 4.4, 6]);
    assert.strictEqual(placed[0].outputStartSec, 13.8);
    const legacy = DubbingService.placeNarratedBlocks(segments, [{ startIndex: 3, blockTimelineSec: 6 }]);
    assert.strictEqual(legacy[0].outputStartSec, 13);
  }

  // 6. Per-segment policy: voice 18% longer than its scene with a 4% speed cap is
  //    no longer cut by the mix — the visual extends to the full voice and the
  //    excess slow-down is reported instead.
  {
    const fit = resolveVoiceVisualFit({ plannedDurationSec: 10, actualVoiceDurationSec: 11.8, audioMode: "voiceover_only", maxVoiceSpeedUp: 1.04 });
    assert.ok(fit.voiceSpeedRatio <= 1.0401, `voice speed ${fit.voiceSpeedRatio}`);
    assert.ok(fit.renderDurationSec >= 11.8 / 1.04 - 0.001);
    assert.strictEqual(fit.warningCode, "voice_too_long");
    assert.strictEqual(fit.requiresRewrite, true);
  }

  // 7. The manual draft render opts its host-built blocks into the stretch policy.
  {
    const source = require("fs").readFileSync(require("path").join(__dirname, "..", "electron", "services", "dubbingService.js"), "utf8");
    assert.ok(source.includes('overflowPolicy: renderSegments[blockRun.start]?.draftAutoNarrationBlock ? "stretch_visuals" : "fail"'));
  }

  console.log("manualDraftBlockOverflow tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
