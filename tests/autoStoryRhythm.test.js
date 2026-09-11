const assert = require('assert/strict');
const { analyze, policy } = require('../electron/services/autoStoryRhythm');
const make = list => ({ segments: list.map(([mode, duration], i) => ({ id: `s${i}`, start: 0, end: duration,
  audioMode: mode === 'vo' ? 'voiceover_only' : 'original_audio', storyRole: i ? 'context' : 'hook' })) });
const one = analyze(make([['oa', 2], ['vo', 7.95], ['vo', 7.475], ['oa', 3], ['vo', 6.575],
  ['vo', 7.925], ['vo', 9.925], ['vo', 6.05], ['oa', 13.8], ['vo', 11.7]]));
assert(Math.abs(one.narrationRatio - 0.7539) < 0.001);
assert(Math.abs(Math.max(...one.runs.map(r => r.duration)) - 30.475) < 0.001);
assert(one.severe);
const three = analyze(make([['oa', 31.12], ['vo', 8.375], ['oa', 45.67], ['vo', 6.075], ['vo', 18.675], ['vo', 15.25]]));
assert(three.narrationRatio < 0.4);
assert.equal(three.longRuns[0].duration, 40);
assert(three.severe, 'overall target ratio does not excuse a 40-second ending');
const good = analyze(make([['oa', 25], ['vo', 10], ['oa', 20], ['vo', 10], ['oa', 20], ['vo', 10]]));
assert.equal(good.needsReview, false);
assert.equal(analyze(make([['oa', 70]])).needsReview, false, 'never pad voice to a quota');
assert.equal(analyze({ segments: [] }).narrationRatio, 0);
assert(policy.includes('Never restore external host audio'));
console.log('Auto Story rhythm regression tests passed');
