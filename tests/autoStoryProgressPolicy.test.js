const assert = require('node:assert/strict');
const { createAutoStoryProgressTracker } = require('../electron/services/autoStoryProgressPolicy');

const p = createAutoStoryProgressTracker();
assert.equal(p({ stage: 'preprocess', percent: 1 }).percent, 1);
assert.equal(p({ stage: 'understand', percent: 8 }).percent, 8);
for (let i = 1; i <= 4; i++) {
  const result = p({ stage: `v3-source-model_chunk_${i}`, percent: 100 });
  assert.equal(result.percent, 8, 'one completed Vertex request must not finish the run');
  assert.equal(result.localPercent, 100);
  assert.equal(result.progressScope, 'auto-story-overall');
  assert.equal(p({ stage: `v3-source-model_chunk_${i}`, percent: 92 }).percent, 8);
}
assert.equal(p({ stage: 'understand', percent: 12 }).percent, 12);
assert.equal(p({ stage: 'understand', percent: 24 }).percent, 24);
assert.equal(p({ stage: 'design', percent: 30 }).percent, 30);
assert.equal(p({ stage: 'editing', percent: 45 }).percent, 45);
assert.equal(p({ stage: 'rendering', percent: 100 }).percent, 70);
assert.equal(p({ stage: 'reviewing', percent: 100 }).percent, 83);
assert.equal(p({ stage: 'final_export', percent: 100 }).percent, 90);
assert.equal(p({ stage: 'complete', message: 'Script 1 finished' }).percent, 90);
assert.equal(p({ stage: 'failed', message: 'Script 2 failed' }).percent, 90);
assert.equal(p({ stage: 'complete', overallComplete: true, percent: 100 }).percent, 100);
assert.equal(createAutoStoryProgressTracker()({ stage: 'failed', overallComplete: true, percent: 100 }).percent, 100);
console.log('autoStoryProgressPolicy tests passed');
