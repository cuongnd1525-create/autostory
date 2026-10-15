const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const Audit = require("../electron/services/recap/recapAnchorAuditService");
test("source audit uses indexed real-frame times, keeps other events and rejects unverified anchors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-anchor-audit-"));
  try {
    const source = path.join(root, "source.mp4"); await fs.writeFile(source, "fixture");
    const transcript = path.join(root, "words.json"); await fs.writeFile(transcript, JSON.stringify({ segments: [{ start: 80, end: 82, text: "Talking tattoos." }] }));
    const commands = [], service = new Audit({}, { media: { ffmpegPath: "fixture", runCommand: async (_bin, args) => commands.push(args) },
      subtitleFactory: () => ({ transcribeToSrt: async () => ({ wordTimestampsPath: transcript }) }) });
    const events = [{ id: "tattoo", source_start: 50, source_end: 55, description: "A talking skull tattoo" },
      { id: "other", source_start: 10, source_end: 20, description: "Another source action" }];
    let response = { matches: [{ event_id: "tattoo", frame_index: 42, confidence: .95, verified_description: "A visible skull tattoo on an arm." }] };
    const request = { sourceVideoPath: source, sourceDuration: 120, events, eventIds: ["tattoo"], issues: [],
      scenes: [{ startSec: 88, endSec: 94 }], directory: root,
      ai: { getAnalysisModel: () => "fixture-model", runVertexCall: async args => { assert.ok(args.filePaths.length > 0);
        assert.match(args.prompt, /"start":85,"end":87,"text":"Talking tattoos/); return response; } } };
    const repaired = await service.repair(request);
    assert.equal(repaired[0].source_start, 88); assert.equal(repaired[0].source_end, 94);
    assert.equal(repaired[0].anchorAudit.sourceTime, 89);
    assert.equal(repaired[0].description, "A visible skull tattoo on an arm.");
    assert.deepEqual(repaired[1], events[1]); assert.equal(events[0].source_start, 50);
    assert.ok(commands.some(args => args.includes("89")), "index 42 must refer to an extracted source frame at 89s");
    for (const match of [{ event_id: "tattoo", frame_index: 999, confidence: .99 },
      { event_id: "tattoo", frame_index: 42, confidence: .5 }, { event_id: "invented", frame_index: 42, confidence: .99 }]) {
      response = { matches: [match] }; await assert.rejects(service.repair(request));
    }
    response = { matches: [] }; await assert.rejects(service.repair(request), /thiếu sự kiện/);
    const controller = new AbortController(); controller.abort(); await assert.rejects(service.repair({ ...request, signal: controller.signal }), { name: "AbortError" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
