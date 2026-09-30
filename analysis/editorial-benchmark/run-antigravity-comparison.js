#!/usr/bin/env node
'use strict';
// Development-only helper: delegate the post-benchmark three-video comparison to
// Antigravity CLI. The flags mirror the ones this repo already uses in production for
// agy (electron/services/manualAntigravityStage1Service.js: --mode accept-edits,
// --dangerously-skip-permissions, --output-format stream-json, --add-dir, --print-timeout,
// --model, --print=<prompt>). Check them against `agy --help` on your install first.
//
// Usage:
//   node analysis/editorial-benchmark/run-antigravity-comparison.js <newFinal.mp4> <benchmark-summary.json>
// Env: ANTIGRAVITY_COMMAND (default "agy"), AGY_MODEL (optional), VIRAL_MP4, OLD_MP4.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [newMp4, summaryJson] = process.argv.slice(2);
if (!newMp4 || !summaryJson) { console.error('usage: run-antigravity-comparison.js <newFinal.mp4> <benchmark-summary.json>'); process.exit(2); }
const VIRAL = process.env.VIRAL_MP4 || 'D:\\Video\\template_viral_tiktok.mp4';
const OLD = process.env.OLD_MP4 || 'D:\\OutputVideo\\v4-production-live-e2e\\.variant-workers\\1\\v4-production-live-e2e\\output\\abusive-mom-s-worst-nightmare-came-true-highlight-draft-variant-01-score-na-a-chaotic-domestic-d-20260929070813.mp4';

// Stage the inputs into one folder so the agent sees them under stable names.
const work = path.join(__dirname, 'post-benchmark-input');
fs.mkdirSync(work, { recursive: true });
for (const [src, name] of [[VIRAL, 'A-VIRAL.mp4'], [OLD, 'B-OLD.mp4'], [newMp4, 'C-NEW.mp4'], [summaryJson, 'C-NEW-benchmark-summary.json']]) fs.copyFileSync(src, path.join(work, name));
const prompt = fs.readFileSync(path.join(__dirname, '04-antigravity-post-benchmark-prompt.md'), 'utf8')
  + `\nFiles: A-VIRAL.mp4, B-OLD.mp4, C-NEW.mp4, C-NEW-benchmark-summary.json in ${work}. Write the JSON to ${path.join(__dirname, '05-post-benchmark-comparison.json')} and also print it.`;

const parts = (process.env.ANTIGRAVITY_COMMAND || 'agy').split(' ').filter(Boolean);
const args = [...parts.slice(1), '--mode', 'accept-edits', '--dangerously-skip-permissions', '--output-format', 'stream-json',
  '--add-dir', work, '--add-dir', __dirname, '--print-timeout', '1800s',
  ...(process.env.AGY_MODEL ? ['--model', process.env.AGY_MODEL] : []), `--print=${prompt}`];
const out = fs.createWriteStream(path.join(__dirname, '05-post-benchmark-antigravity.log'));
const child = spawn(parts[0], args, { windowsHide: true, shell: false });
child.stdout.pipe(out); child.stderr.pipe(out);
child.on('close', code => { console.log(`agy exited ${code}; see 05-post-benchmark-comparison.json and 05-post-benchmark-antigravity.log`); process.exit(code || 0); });
