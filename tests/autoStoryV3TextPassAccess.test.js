// Regression: V3 TEXT-ONLY passes (Story Design, Narration) must NOT require
// media-access confirmation. Reproduces the live failure where v3-story-design
// returned a valid response but the pipeline threw
//   StoryError: AI chưa xác minh truy cập input của bước này.
// because a stale gates.access() gate ran on a text-only response.
//
// Run: node tests/autoStoryV3TextPassAccess.test.js
const assert = require('node:assert');
const path = require('path');
const P = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryV3Pipeline.js'));
const gates = require(path.join(__dirname, '..', 'electron', 'services', 'autoStorySourceGates.js'));
const { StoryError } = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryRepairRouter.js'));

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

// Faithful stand-in for engine.ask(): the REAL engine runs the supplied validate
// callback against the parsed response — which is exactly where the bug lived.
function fakeAsk(validate, response, calls) { calls.push({ validated: true }); return validate(response) ?? response; }

console.log('V3 text-only pass access');

// The stale gate is still there for the MULTIMODAL pass and still rejects a
// text-only-style response — proving that if it were on the text path, the live
// error would recur. This anchors the regression.
ok('baseline: gates.access() DOES throw the exact live error on accessGranted:false', () => {
  assert.throws(() => gates.access({ accessGranted: false }),
    e => e instanceof StoryError && e.kind === 'INPUT_ACCESS' && /truy cập input/.test(e.message));
  assert.throws(() => gates.access({ spines: [{}] }), /truy cập input/); // accessGranted absent
});

// ---- REAL PATH 1: Story Design ----
ok('valid story-model input -> Story Design JSON WITHOUT accessGranted -> continues', () => {
  const calls = [];
  const model = { events: [{ id: 'e1', startSec: 0, endSec: 5 }, { id: 'e2', startSec: 10, endSec: 15 }] };
  P.assertStoryModelInput(model); // pre-call input check passes
  const response = { spines: [{ centralViewerQuestion: 'q', hookPromise: 'h', beats: [{ beatId: 'b1' }, { beatId: 'b2' }] }] };
  const design = fakeAsk(P.validateStoryDesign, response, calls);
  assert.equal(calls.length, 1, 'the Vertex call was made and validated');
  assert.equal(design.spines.length, 1, 'response accepted; pipeline can read design.spines');
  // The old gate would have rejected the very same response.
  assert.throws(() => gates.access(response), /truy cập input/);
});

ok('Story Design with accessGranted:false is STILL accepted (text pass ignores it)', () => {
  const calls = [];
  const response = { accessGranted: false, spines: [{ centralViewerQuestion: 'q', beats: [] }] };
  const design = fakeAsk(P.validateStoryDesign, response, calls);
  assert.equal(design.spines.length, 1);
});

ok('Story Design with empty spines -> INVALID_RESPONSE (not INPUT_ACCESS)', () => {
  assert.throws(() => P.validateStoryDesign({ accessGranted: true, spines: [] }),
    e => e instanceof StoryError && e.kind === 'INVALID_RESPONSE');
});

// ---- INPUT MISSING before any Vertex spend ----
ok('missing/empty story-model input -> local INPUT_MISSING BEFORE the Vertex call', () => {
  const calls = [];
  const storyDesignStep = model => { P.assertStoryModelInput(model); return fakeAsk(P.validateStoryDesign, { spines: [{}] }, calls); };
  assert.throws(() => storyDesignStep({ events: [] }), e => e instanceof StoryError && e.kind === 'INPUT_MISSING');
  assert.throws(() => storyDesignStep(null), e => e.kind === 'INPUT_MISSING');
  assert.throws(() => storyDesignStep({}), e => e.kind === 'INPUT_MISSING');
  assert.equal(calls.length, 0, 'no Vertex call was made for a missing-input structural failure');
});

// ---- REAL PATH 2: Narration (same shared validator) ----
ok('Narration JSON WITHOUT accessGranted is accepted (same shared path, no relapse)', () => {
  const calls = [];
  const response = { narrations: [{ beatId: 'b1', voiceoverText: 'x' }] };
  const out = fakeAsk(P.validateNarration, response, calls);
  assert.equal(calls.length, 1);
  assert.equal(out.narrations.length, 1);
  assert.throws(() => gates.access(response), /truy cập input/); // old gate would have blocked it
});

ok('Narration missing narrations array -> INVALID_RESPONSE (not INPUT_ACCESS)', () => {
  assert.throws(() => P.validateNarration({ accessGranted: true }),
    e => e instanceof StoryError && e.kind === 'INVALID_RESPONSE');
});

console.log(`\nAll ${passed} text-pass-access assertions passed.`);
