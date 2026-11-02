const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const Cache = require("../electron/services/recap/recapRenderCacheService");
test("segment caching preserves pixels/audio settings and invalidates source, framing and timing changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-render-cache-"));
  try {
    const cache = new Cache(); let renders = 0;
    const request = { directory: root, ffmpegPath: "ffmpeg", inputIdentity: { path: "source.mp4", size: 100, mtimeMs: 1 },
      args: ["-ss", "1", "-t", "3", "-vf", "crop=100:100", "-an"], render: async file => { renders++; await fs.writeFile(file, Buffer.alloc(512, renders)); } };
    const cold = await cache.render(request), warm = await cache.render(request);
    assert.equal(cold.hit, false); assert.equal(warm.hit, true); assert.equal(renders, 1); assert.equal(cold.file, warm.file);
    await cache.render({ ...request, inputIdentity: { ...request.inputIdentity, mtimeMs: 2 } });
    await cache.render({ ...request, args: [...request.args, "-af", "volume=0.2"] });
    await cache.render({ ...request, args: [...request.args, "-t", "4"] });
    await cache.render({ ...request, args: [...request.args, "-vf", "crop=90:100"] });
    assert.equal(renders, 5);
    await fs.writeFile(cold.file, "broken"); assert.equal((await cache.render(request)).hit, false); assert.equal(renders, 6);
    await fs.writeFile(`${cold.file}.json`, "partial-json"); await cache.render(request); assert.equal(renders, 7);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("cancelled/failed render never publishes a usable cached segment and identical concurrent work renders once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recap-render-cache-fail-"));
  try {
    const cache = new Cache(), request = { directory: root, inputIdentity: { size: 100 }, args: [], ffmpegPath: "ffmpeg" };
    await assert.rejects(cache.render({ ...request, render: async file => { await fs.writeFile(file, Buffer.alloc(512)); throw new Error("cancelled"); } }), /cancelled/);
    assert.deepEqual(await fs.readdir(root), []);
    let renders = 0;
    const render = async file => { renders++; await fs.writeFile(file, Buffer.alloc(512)); };
    const results = await Promise.all([cache.render({ ...request, render }), cache.render({ ...request, render })]);
    assert.equal(renders, 1); assert.equal(results[1].hit, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
