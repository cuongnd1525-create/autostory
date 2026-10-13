const assert = require('node:assert/strict');
const Gate = require('../electron/services/autoStoryV4HookGate');
const example = { accessGranted: true, sourceVerified: true, firstSecondsObserved: 'Officer confronts the driver.',
  immediateCuriosity: true, misleadingOrSpoiled: false, startsMidSentenceWithoutContext: false,
  specificUnansweredQuestion: 'Why is the officer confronting the driver?',
  promiseSupportedBySource: true, reason: 'Visible conflict.' };
assert.equal(Gate.judge(example).accepted, true);
assert.equal(Gate.judge({ ...example, immediateCuriosity: false }).accepted, false);
assert.equal(Gate.judge({ ...example, sourceVerified: false }).accepted, false);
assert.equal(Gate.judge({ ...example, misleadingOrSpoiled: true }).accepted, false);
assert.equal(Gate.judge({ ...example, startsMidSentenceWithoutContext: true }).accepted, false);
assert.equal(Gate.judge({ ...example, promiseSupportedBySource: false }).accepted, false);
assert.equal(Gate.judge({ ...example, specificUnansweredQuestion: '' }).accepted, false);
assert.throws(() => Gate.judge({ ...example, firstSecondsObserved: '' }), /actual watched source/);
console.log('autoStoryV4HookGate tests passed');
