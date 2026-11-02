const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const Audit = require("../electron/services/recap/recapAnchorAuditService");
test("source observations survive narration changes and invalidate for new media, bounds or audit model", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-observation-cache-"));
  try {
    const source = path.join(root, "source.mp4"); await fs.writeFile(source, "fixture");
    let calls = 0, commands = 0, model = "quality";
    const service = new Audit({}, { media: { ffmpegPath: "fixture", runCommand: async () => { commands++; } } });
    const event = { id: "e1", source_start: 1, source_end: 3, anchorMethod: "scene_frames", description: "A guessed attack",
      narrativeContext: [{ note: "An earlier unverified attack claim." }] };
    const request = { sourceVideoPath: source, sourceDuration: 10, events: [event], eventIds: ["e1"], issues: [], directory: root,
      ai: { getQualityModel: () => model, runVertexCall: async () => { calls++; return { observations: [
        { event_id: "e1", observation_confidence: .95, claim_supported: false, verified_description: "A man raises a shield." }
      ] }; } } };
    const first = await service.repair(request); assert.equal(calls, 1); assert.equal(commands, 1);
    const resumed = await service.repair({ ...request, events: first, narration: [{ text: "A corrected description" }],
      issues: [{ type: "factual_error", severity: "high" }] });
    assert.equal(calls, 1); assert.equal(commands, 1, "cache hit skips both AI and FFmpeg extraction");
    assert.equal(resumed[0].anchorAudit.originalDescription, event.description);
    assert.deepEqual(resumed[0].anchorAudit.invalidatedNarrativeContext, event.narrativeContext, "cache resume retains the invalidated note history");
    await service.repair({ ...request, events: [{ ...event, source_end: 4 }] }); assert.equal(calls, 2);
    model = "new-model"; await service.repair(request); assert.equal(calls, 3);
    await fs.writeFile(source, "changed source data"); await service.repair(request); assert.equal(calls, 4);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("indexed source audit watches the exact action and corrects a false target without relocating footage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-fixed-audit-"));
  try {
    const source = path.join(root, "source.mp4"); await fs.writeFile(source, "fixture");
    const event = { id: "hair_attack", anchorMethod: "scene_frames", source_start: 243.512, source_end: 245.625,
      description: "Jiraiya attacks Kabuto", subjects: ["Jiraiya", "Kabuto"], actions: ["attack"],
      narrativeContext: [{ note: "Jiraiya strikes Kabuto, from an earlier unverified writing pass." }] };
    const commands = [], service = new Audit({}, { media: { ffmpegPath: "fixture", runCommand: async (_bin, args) => commands.push(args) } });
    let response = { observations: [{ event_id: event.id, observation_confidence: .95, claim_supported: false,
      verified_description: "The long-haired man falls forward onto the ground." }] };
    const request = { sourceVideoPath: source, sourceDuration: 829, events: [event], eventIds: [event.id], issues: [], directory: root,
      ai: { getQualityModel: () => "quality", runVertexCall: async args => {
        assert.equal(args.modelOverride, "quality"); assert.equal(args.filePaths.length, 1); assert.equal(args.videoFps, 4);
        assert.equal(args.responseSchema.properties.observations.items.properties.frame_index, undefined);
        assert.match(args.prompt, /confidence in your NEW observation/); return response;
      } } };
    const corrected = (await service.repair(request))[0];
    assert.equal(corrected.source_start, event.source_start); assert.equal(corrected.source_end, event.source_end);
    assert.equal(corrected.anchorAudit.claimSupported, false); assert.equal(corrected.anchorAudit.method, "fixed_source_range");
    assert.deepEqual(corrected.subjects, []); assert.deepEqual(corrected.actions, []);
    assert.equal(corrected.narrativeContext, undefined, "a disproved writing note must not revive the old factual claim");
    assert.deepEqual(corrected.anchorAudit.invalidatedNarrativeContext, event.narrativeContext, "keep the original note for audit history");
    assert.equal(event.description, "Jiraiya attacks Kabuto", "original checkpoint remains untouched");
    assert.ok(commands.some(args => args.includes("243.512") && Math.abs(Number(args[args.indexOf("-t") + 1]) - 2.113) < .0001));
    response.observations[0].observation_confidence = .6;
    await assert.rejects(service.repair({ ...request, directory: path.join(root, "uncertain") }), /Chưa xác minh/);
    response = { observations: [] };
    await assert.rejects(service.repair({ ...request, directory: path.join(root, "missing") }), /chưa trả đúng đoạn/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("source audit uses indexed real-frame times, keeps other events and rejects unverified anchors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-anchor-audit-"));
  try {
    const source = path.join(root, "source.mp4"); await fs.writeFile(source, "fixture");
    const transcript = path.join(root, "words.json"); await fs.writeFile(transcript, JSON.stringify({ segments: [{ start: 80, end: 82, text: "Talking tattoos." }] }));
    const commands = [], service = new Audit({}, { media: { ffmpegPath: "fixture", runCommand: async (_bin, args) => commands.push(args) },
      subtitleFactory: () => ({ transcribeToSrt: async () => ({ wordTimestampsPath: transcript }) }) });
    const events = [{ id: "tattoo", source_start: 50, source_end: 55, description: "A talking skull tattoo", subjects: ["talking skull"], actions: ["talks"] },
      { id: "other", source_start: 10, source_end: 20, description: "Another source action" }];
    let response = { matches: [{ event_id: "tattoo", frame_index: 42, confidence: .95, claim_supported: true, verified_description: "A visible skull tattoo on an arm." }] };
    const request = { sourceVideoPath: source, sourceDuration: 120, events, eventIds: ["tattoo"], issues: [],
      scenes: [{ startSec: 88, endSec: 94 }], directory: root,
      ai: { getAnalysisModel: () => "fixture-model", runVertexCall: async args => { assert.ok(args.filePaths.length > 0);
        assert.equal(args.responseSchema.properties.matches.items.properties.frame_index.minimum, -1);
        assert.ok(args.responseSchema.properties.matches.items.properties.frame_index.maximum < 89);
        assert.match(args.prompt, /"start":85,"end":87,"text":"Talking tattoos/);
        assert.match(args.prompt, /"source_start":50,"source_end":55/); return response; } } };
    const repaired = await service.repair(request);
    assert.equal(repaired[0].source_start, 88.75); assert.equal(repaired[0].source_end, 93);
    assert.equal(repaired[0].anchorAudit.sourceTime, 89);
    assert.equal(repaired[0].description, "A visible skull tattoo on an arm.");
    assert.deepEqual(repaired[1], events[1]); assert.equal(events[0].source_start, 50);
    assert.ok(commands.some(args => args.includes("89")), "index 42 must refer to an extracted source frame at 89s");
    for (const match of [{ event_id: "tattoo", frame_index: 999, confidence: .99 },
      { event_id: "tattoo", frame_index: 42, confidence: .5 }, { event_id: "invented", frame_index: 42, confidence: .99 }]) {
      response = { matches: [match] }; await assert.rejects(service.repair(request));
    }
    response = { matches: [] }; await assert.rejects(service.repair(request), /thiếu sự kiện/);
    response = { matches: [{ event_id: "tattoo", frame_index: 23, confidence: .95, claim_supported: false,
      verified_description: "The person wears a shirt; no tattoo is visible." }] };
    const corrected = await service.repair(request);
    assert.equal(corrected[0].anchorAudit.claimSupported, false);
    assert.equal(corrected[0].anchorAudit.originalDescription, events[0].description);
    assert.match(corrected[0].description, /no tattoo/);
    assert.deepEqual(corrected[0].subjects, []); assert.deepEqual(corrected[0].actions, []);
    response = { matches: [{ ...response.matches[0], frame_index: 42 }] };
    await assert.rejects(service.repair(request), /chính khoảng nguồn/);
    response = { matches: [{ event_id: "tattoo", frame_index: 23, confidence: .95 }] };
    await assert.rejects(service.repair(request), /chưa xác nhận/);
    const controller = new AbortController(); controller.abort(); await assert.rejects(service.repair({ ...request, signal: controller.signal }), { name: "AbortError" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
