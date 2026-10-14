const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Director = require('../electron/services/editorialDirectorService');
const Pipeline = require('../electron/services/autoStoryV3Pipeline');
const Gate = require('../electron/services/autoStoryV4HookGate');
const { StoryError } = require('../electron/services/autoStoryRepairRouter');

const makeStory = start => ({
  editorialContract: Director.DIRECTOR_CONTRACT, scriptId: 1,
  storyScope: { storyScopeId: 'case', hookCandidates: [
    { windowId: 'a', sourceStartSec: 330, sourceEndSec: 340 },
    { windowId: 'b', sourceStartSec: 365, sourceEndSec: 375 }
  ] },
  beats: [
    { beatId: 'hook', sourceStartSec: start, sourceEndSec: start + 4, scopeMembership: 'hook', chronologyMode: 'teaser' },
    { beatId: 'payoff', sourceStartSec: 500, sourceEndSec: 505, scopeMembership: 'ending', chronologyMode: 'chronological' }
  ], deliveryBlocks: []
});
const reject = start => new StoryError('DIRECTOR_REPAIR_REQUIRED', 'The first source seconds do not establish curiosity.', {
  violations: [{ code: 'HOOK_SOURCE_AUDITION', message: 'No concrete viewer question in first 3 seconds.' }],
  rejectedHookRange: { sourceStartSec: start, sourceEndSec: start + 4 },
  firstSecondsObserved: 'An officer silently inspects the vehicle.'
});
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v4-hook-recovery-'));
  try {
    const ctx = { root, scriptId: 1, model: {}, opts: {}, service: {}, emit: () => {},
      engine: { project: { autoStoryContractVersion: 4 },
        config: { narration: { enabled: false } } } };
    const tried = [], repairs = [];
    const result = await Pipeline.buildDirectorScript(ctx, makeStory(422.4), {
      build: async (_engine, _service, _opts, story) => {
        tried.push(story.beats[0].sourceStartSec);
        if (tried.length < 3) throw reject(story.beats[0].sourceStartSec);
        return { script: 'valid' };
      },
      repair: async (_engine, args) => {
        repairs.push(args.hookRepair);
        const nextStart = repairs.length === 1 ? 334.6 : 365.8;
        return { spine: makeStory(nextStart) };
      }
    });
    assert.equal(result.built.script, 'valid');
    assert.deepEqual(tried, [422.4, 334.6, 365.8]);
    assert.equal(repairs.length, 2);
    assert.equal(repairs[1].rejectedOpenings.length, 2);
    assert.equal(repairs[1].rejectedOpenings[0].sourceStartSec, 422.4);
    assert.equal(repairs[1].rejectedOpenings[1].sourceStartSec, 334.6);
    assert.equal(result.repairedSpine.beats[0].sourceStartSec, 365.8);
    const journal = JSON.parse(await fs.readFile(path.join(root, 'hook-repair-history-1.json')));
    assert.equal(journal.rejected.length, 2);

    let built = 0, fixed = 0;
    await assert.rejects(() => Pipeline.buildDirectorScript(ctx, makeStory(422.4), {
      build: async (_engine, _service, _opts, story) => {
        built++; throw reject(story.beats[0].sourceStartSec);
      },
      repair: async () => { fixed++; return { spine: makeStory(fixed === 1 ? 334.6 : 365.8) }; }
    }), err => err.kind === 'HOOK_AUDITION_EXHAUSTED' &&
      err.details.rejectedOpenings.length === 3 &&
      /withheld/.test(err.message));
    assert.equal(built, 3, 'each of three distinct clips was audited');
    assert.equal(fixed, 2, 'bounded focused repair count');

    built = 0; fixed = 0;
    const noRepeatedRequest = await Pipeline.buildDirectorScript(ctx, makeStory(422.4), {
      build: async (_e,_s,_o,story) => { built++; if (story.beats[0].sourceStartSec === 422.4) throw reject(422.4); return { script: 'ok' }; },
      repair: async () => ({ spine: makeStory(++fixed === 1 ? 422.4 : 365.8) })
    });
    assert.equal(built, 2, 'reusing rejected footage must not call Hook Audition twice');
    assert.equal(noRepeatedRequest.built.script, 'ok');

    // Gate uses the verified outcome only to check factual promise.
    // It still rejects empty/uninteresting opening footage.
    const gateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'v4-payoff-hook-'));
    try {
      await fs.writeFile(path.join(gateRoot, 'payoff-verification-1.json'), JSON.stringify({
        scopeId: 'case', verdict: { accepted: true, observedEnding: 'Suspect admits to several hundred pills.' },
        response: { outcomeType: 'confirmed_payoff', promiseSupportedByEnding: true }
      }));
      const seen = [];
      const engine = {
        service: { vertex: {} }, root: gateRoot, duration: 900,
        prepare: async () => [{ file: 'clip.mp4' }],
        ask: async (_key, input, _schema, instruction, _files, validator) => {
          seen.push({ input, instruction });
          assert.match(instruction, /TEASER, NOT the ending/);
          await validator({ accessGranted: true, sourceVerified: true,
            firstSecondsObserved: 'The officer asks what he has hidden.', immediateCuriosity: true,
            misleadingOrSpoiled: false, startsMidSentenceWithoutContext: false,
            specificUnansweredQuestion: 'What is in the suspect\'s pocket?',
            promiseSupportedBySource: true, reason: 'Visible confrontation.' });
          return { accessGranted: true };
        }
      };
      await Gate.verify(engine, makeStory(330));
      assert.match(seen[0].input.verifiedPayoff.observedEnding, /several hundred pills/);
      assert.equal(seen[0].input.otherHookCandidates.length, 2);
    } finally { await fs.rm(gateRoot, { recursive: true, force: true }); }
    console.log('Auto Story V4 Hook Gate and bounded hook-repair regression tests passed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
