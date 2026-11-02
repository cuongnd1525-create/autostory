const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { fingerprint } = require("./recapEditorialService");
const { throwIfCancelled } = require("../cancelToken");

// Raw visual segments only: subtitles and narration are applied after concat.
// Absolute output offsets are deliberately absent; source/crop/speed/duration,
// original-audio handling and encoder arguments are all part of the identity.
class RecapRenderCacheService {
  constructor() { this.jobs = new Map(); }
  async render({ directory, inputIdentity, args, ffmpegPath, cancelToken, render }) {
    throwIfCancelled(cancelToken);
    const key = fingerprint({ version: 1, inputIdentity, ffmpegPath, args });
    const file = path.join(path.resolve(directory), `${key}.mp4`), manifest = `${file}.json`;
    if (this.jobs.has(file)) {
      const result = await this.jobs.get(file); throwIfCancelled(cancelToken); return { ...result, hit: true };
    }
    const job = (async () => {
      try {
        const metadata = JSON.parse(await fs.readFile(manifest, "utf8")), stat = await fs.stat(file);
        if (metadata.key === key && stat.size > 32 && stat.size === metadata.size) return { file, hit: true };
      } catch (_) {}
      throwIfCancelled(cancelToken);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp.mp4`, tempManifest = `${temp}.json`;
      try {
        await render(temp); throwIfCancelled(cancelToken);
        const stat = await fs.stat(temp);
        if (stat.size <= 32) throw new Error("Đoạn render chưa hoàn chỉnh; không lưu vào cache.");
        await fs.rename(temp, file);
        await fs.writeFile(tempManifest, JSON.stringify({ key, size: stat.size }));
        await fs.rename(tempManifest, manifest);
        return { file, hit: false };
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
        await fs.rm(tempManifest, { force: true }).catch(() => {});
      }
    })();
    this.jobs.set(file, job);
    try { return await job; } finally { this.jobs.delete(file); }
  }
}
module.exports = RecapRenderCacheService;
