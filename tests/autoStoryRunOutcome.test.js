// Bug-2/Bug-4 pure tests: success/failure keys off ACTUAL rendered drafts,
// so the UI stops before rendering/finalizing on any failure.
// Run: node tests/autoStoryRunOutcome.test.js
const assert = require('node:assert');
const path = require('path');
const O = require(path.join(__dirname, '..', 'electron', 'services', 'autoStoryRunOutcome.js'));

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

const renderedVariant = (id = 1) => ({ scriptId: id, id: 'variant_0' + id, artifacts: { fastDraftVideoPath: `/o/${id}.mp4` } });
const compiledOnlyVariant = (id = 1) => ({ scriptId: id, id: 'variant_0' + id, artifacts: {} });

console.log('autoStoryRunOutcome');

ok('zero scripts + failures => failed generation, must not render', () => {
  const result = { project: { autoStoryState: { phase: 'review_failed', failures: [{ scriptId: 1, error: 'safeWords' }] } },
    analysis: { scriptPaths: [], failures: [{ scriptId: 1, error: 'safeWords' }] } };
  assert.equal(O.isFailedGeneration(result), true);
  assert.equal(O.shouldRenderDrafts(result), false);
  assert.match(O.firstGenerationError(result), /safeWords/);
});

ok('Bug-4: compiled script but render FAILED (no rendered draft) => failed', () => {
  const result = {
    project: { analysis: { highlightVariants: [compiledOnlyVariant(1)] },
      autoStoryState: { phase: 'review_failed', failures: [{ scriptId: 1, error: 'ENOENT plan.json' }] } },
    analysis: { scriptPaths: ['/x/script-1.json'], failures: [{ scriptId: 1, error: 'ENOENT plan.json' }] }
  };
  assert.equal(O.renderedDraftCount(result), 0, 'no rendered draft');
  assert.equal(O.isFailedGeneration(result), true, 'render failure => failed even though a script compiled');
  assert.match(O.firstGenerationError(result), /ENOENT/);
});

ok('at least one RENDERED draft => success, render allowed', () => {
  const result = { project: { analysis: { highlightVariants: [renderedVariant(1)] }, autoStoryState: { phase: 'complete' } },
    analysis: { scriptPaths: ['/x/script-1.json'], failures: [] } };
  assert.equal(O.isFailedGeneration(result), false);
  assert.equal(O.shouldRenderDrafts(result), true);
});

ok('partial success: at least one rendered draft among several => not failed', () => {
  const result = { project: { analysis: { highlightVariants: [renderedVariant(1), compiledOnlyVariant(2)] },
    autoStoryState: { phase: 'review_failed', failures: [{ scriptId: 2, error: 'x' }] } }, analysis: {} };
  assert.equal(O.isFailedGeneration(result), false, 'one good draft is still usable');
});

ok('zero scripts + failed phase (no failures array) still failed', () => {
  const result = { project: { autoStoryState: { phase: 'failed', error: 'boom' } }, analysis: { scriptPaths: [] } };
  assert.equal(O.isFailedGeneration(result), true);
  assert.equal(O.firstGenerationError(result), 'boom');
});

ok('null/undefined result is treated as failed', () => {
  assert.equal(O.isFailedGeneration(null), true);
  assert.equal(O.isFailedGeneration(undefined), true);
});

console.log(`\nAll ${passed} outcome assertions passed.`);
