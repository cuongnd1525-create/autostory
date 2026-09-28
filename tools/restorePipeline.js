const fs = require('fs');
let code = fs.readFileSync('electron/services/autoStoryV3Pipeline.js', 'utf8');

const regex = /async function buildStoryDesign\(engine, model, root, emit\) \{[\s\S]*?return JSON.parse\(await fsp.readFile\("scratch\/repaired-story-spine-real\.json", "utf8"\)\)\.spines;\n\}/;

const original = `async function buildStoryDesign(engine, model, root, emit) {
  assertStoryModelInput(model);
  const metaOf = () => {
    const m = engine.service?.vertex?.lastResponseMetadata || {}; const u = m.usage || {};
    return { finishReason: m.finishReason || '', requestedMaxOutputTokens: m.requestedMaxOutputTokens ?? null,
      requestedThinkingBudget: m.requestedThinkingBudget ?? null, promptTokenCount: u.promptTokenCount ?? null,
      candidatesTokenCount: u.candidatesTokenCount ?? null, thoughtsTokenCount: u.thoughtsTokenCount ?? null,
      totalTokenCount: u.totalTokenCount ?? null };
  };
  const runOnce = async (customRepairInstruction) => {
    const instruction = customRepairInstruction
      ? \`\${V3.instructions.storyDesign}\\n\\n\${customRepairInstruction}\`
      : V3.instructions.storyDesign;
    let value = null, raw = null, error = null;
    const inputData = {
      model,
      targetDurationMinSec: engine.config.targetDurationMinSec || 70,
      targetDurationMaxSec: engine.config.targetDurationMaxSec || 90,
      storyMode: 'serialized_part'
    };
    try {
      value = await engine.ask(\`v3-story-design\${customRepairInstruction ? '_repair' : ''}\`, inputData, V3.schemas.storyDesign, instruction, [], validateStoryDesign, 'auto_story_edit');
      raw = value;
    } catch (e) { error = e; raw = (e && e.invalidArtifact) || null; }
    return { value, raw, error, metadata: metaOf() };
  };
  const persist = async (attempt, r, usableCount, qualityReport) => {
    const suffix = attempt === 0 ? '' : '-repair';
    await write(path.join(root, \`v3-story-design\${suffix}-raw.json\`), r.raw ?? { error: r.error?.message || 'no response captured' });
    await write(path.join(root, \`v3-story-design\${suffix}-request-metadata.json\`), r.metadata);
    await write(path.join(root, \`v3-story-design\${suffix}-normalized.json\`), {
      topLevelKeys: r.raw && typeof r.raw === 'object' ? Object.keys(r.raw) : [],
      spineCount: Array.isArray(r.raw?.spines) ? r.raw.spines.length : null,
      completeSpineCount: completeSpines(r.raw).length, usableSpineCount: usableCount,
      error: r.error?.message || null, repaired: attempt > 0,
      qualityValid: qualityReport?.valid ?? null,
      violations: qualityReport?.violations || []
    });
    if (qualityReport) {
      await write(path.join(root, 'edl-quality-report.json'), qualityReport);
    }
  };

  const targetMin = engine.config.targetDurationMinSec || 65;
  const targetMax = engine.config.targetDurationMaxSec || 90;
  
  emit('design', '[V3] Drafting Serialized Story Structure...', 30);
  let attempt = 0, usable = [];
  let r = await runOnce();
  let quality = null;
  
  const evaluate = (rVal) => {
    if (!rVal) return [];
    const cs = completeSpines(rVal);
    if (!cs.length) return [];
    quality = assessStructuralQuality(cs[0], { targetDurationMinSec: targetMin, targetDurationMaxSec: targetMax });
    if (!quality.valid) return [];
    return cs;
  };
  usable = evaluate(r.value);
  await persist(0, r, usable.length, quality);

  if (usable.length === 0) {
    emit('design', '[V3] Draft rejected. Attempting localized structural repair...', 35);
    const issue = quality?.violations?.length > 0 ? quality.violations.join('; ') : (r.error?.message || 'No complete spines found');
    attempt = 1;
    r = await runOnce(\`Previous attempt failed validation:\\n\${issue}\\n\\nReview the failed output and repair structural rules, timing gaps, or logic.\\nFAILED OUTPUT:\\n\${JSON.stringify(r.raw, null, 2)}\`);
    usable = evaluate(r.value);
    await persist(1, r, usable.length, quality);
  }
  if (usable.length === 0) throw new Error(\`[V3] Permanent Story Design failure.\`);
  
  return usable;
}`;

code = code.replace(regex, original);
fs.writeFileSync('electron/services/autoStoryV3Pipeline.js', code);
