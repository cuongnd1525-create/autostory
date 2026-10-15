'use strict';
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const VERSION = 1;
const SPOILER = ['anime', 'manga', 'light_novel'];
const STATES = ['created','researching','needs_fact_review','scripting','voice_ready','indexing_media','needs_assets','timeline_ready','rendering','reviewing','repairing','ready_to_export','needs_human_review','failed','complete'];
const STAGES = ['00-project','01-canon','02-topics','03-angle','04-claims','05-hooks','06-script','07-verify','08-voice','09-media','10-match','11-timeline','12-draft','13-review','14-export'];
const safe = (v) => String(v == null ? '' : v).trim();
const hash = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
function normalize(input = {}) {
  const series = safe(input.series);
  const topic = safe(input.topic);
  const medium = SPOILER.includes(input.medium) ? input.medium : 'anime';
  const workMode = input.workMode === 'script_first' ? 'script_first' : 'guided';
  if (!series || !topic) throw new Error('Anime Lore requires a series and one central topic.');
  const durationSec = Math.max(65, Math.min(180, Number(input.durationSec) || 75));
  return { version: VERSION, series, character: safe(input.character), topic, medium,
    spoilerThrough: safe(input.spoilerThrough), workMode,
    scriptText: safe(input.scriptText), canonText: safe(input.canonText),
    mediaFolder: safe(input.mediaFolder), mediaRightsConfirmed: input.mediaRightsConfirmed === true,
    voiceProvider: input.voiceProvider === 'edge' ? 'edge' : 'elevenlabs',
    voiceId: safe(input.voiceId), durationSec, fps: 30, width: 1080, height: 1920,
    aiModel: safe(input.aiModel), bgmFile: safe(input.bgmFile) };
}
async function atomicJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (_e) { return null; } }
function blocked(status, reason, details = {}) {
  const error = new Error(reason);
  error.animeStatus = status;
  error.details = details;
  return error;
}
module.exports = { VERSION, SPOILER, STATES, STAGES, safe, hash, normalize, atomicJson, readJson, blocked };