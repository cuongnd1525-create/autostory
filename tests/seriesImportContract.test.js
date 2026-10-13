const assert = require("assert");
const fs = require("fs");
const path = require("path");

const Contract = require("../electron/services/seriesImportContract");

const FIXTURES = path.join(__dirname, "fixtures", "story-first-gate-2026-10-09");
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
const realParts = () => [1, 3, 4].map((id) => load(`script-${id}-audience-repaired.json`));

// 1. Regression (2026-10-09): Story-First Parts each open with their own planned
// hook and never declare shared_hook_enabled. The import used to treat the
// missing field as "shared cold open on" and rejected the series.
{
  const parts = realParts();
  assert.ok(parts.every((script) => script.shared_hook_enabled === undefined));
  assert.ok(!Contract.leadingHooksIdentical(parts.map((script) => script.segments)));
  const contract = Contract.checkSeriesImportContract(parts.map(Contract.contractVariantFromScript));
  assert.deepStrictEqual(contract.errors, []);
  assert.strictEqual(contract.inferredPerPartHook, true);
  assert.strictEqual(contract.sharedHookEnabled, false);
}

// 2. Stage 1 makes the mode explicit and deterministic.
{
  const final = Contract.finalizeSeriesHookMode(realParts());
  assert.strictEqual(final.sharedHookEnabled, false);
  assert.strictEqual(final.changed, true);
  assert.ok(final.scripts.every((script) => script.shared_hook_enabled === false));
  assert.deepStrictEqual(final.contract.errors, []);
  // Idempotent.
  const again = Contract.finalizeSeriesHookMode(final.scripts);
  assert.strictEqual(again.changed, false);
}

// 3. An explicitly declared shared cold open with different hooks is still rejected.
{
  const parts = realParts().map((script) => ({ ...script, shared_hook_enabled: true }));
  const contract = Contract.checkSeriesImportContract(parts.map(Contract.contractVariantFromScript));
  assert.strictEqual(contract.errors[0]?.code, "shared_hook_mismatch");
  assert.strictEqual(contract.errors[0].message, Contract.SHARED_HOOK_MISMATCH_MESSAGE);
}

// 4. Identical leading hook chains => shared cold open declared true.
{
  const parts = realParts();
  const hook = Contract.leadingHookSegments(parts[0].segments);
  const shared = parts.map((script, index) => index === 0 ? script : ({
    ...script,
    segments: [...hook.map((segment) => ({ ...segment })), ...script.segments.slice(Contract.leadingHookSegments(script.segments).length)]
  }));
  const final = Contract.finalizeSeriesHookMode(shared);
  assert.strictEqual(final.sharedHookEnabled, true);
  assert.ok(final.scripts.every((script) => script.shared_hook_enabled === true));
  assert.deepStrictEqual(final.contract.errors, []);
}

// 5. source_narrator_ranges are source facts: Parts that disagree are merged.
{
  const parts = realParts();
  parts[0].source_narrator_ranges = [{ startSec: 10, endSec: 14, replacementText: "A", confidence: "high" }];
  parts[1].source_narrator_ranges = [{ startSec: 400, endSec: 405, replacementText: "B", confidence: "high" }];
  const before = Contract.checkSeriesImportContract(parts.map(Contract.contractVariantFromScript));
  assert.ok(before.errors.some((item) => item.code === "narrator_ranges_mismatch"));
  const final = Contract.finalizeSeriesHookMode(parts);
  assert.strictEqual(final.narratorRangesMerged, true);
  assert.deepStrictEqual(final.contract.errors, []);
  assert.ok(final.scripts.every((script) => script.source_narrator_ranges.length === 2));
  assert.strictEqual(final.scripts[2].source_narrator_ranges[0].startSec, 10);
}

// 6. Non-series scripts are untouched.
{
  const single = { scriptId: 1, segments: [{ storyFunction: "hook", sourceStartSec: 0, sourceEndSec: 5 }] };
  const final = Contract.finalizeSeriesHookMode([single]);
  assert.strictEqual(final.changed, false);
  assert.strictEqual(final.sharedHookEnabled, null);
}

// 7. The import uses this exact contract (no divergent inline copy).
{
  const dubbing = fs.readFileSync(path.join(__dirname, "..", "electron", "services", "dubbingService.js"), "utf8");
  assert.ok(dubbing.includes("checkSeriesImportContract(serializedVariants)"));
  assert.ok(!dubbing.includes("const sharedHookVariants = serializedVariants.filter"));
  const stage1 = fs.readFileSync(path.join(__dirname, "..", "electron", "services", "manualAntigravityStage1Service.js"), "utf8");
  assert.ok(stage1.includes("finalizeSeriesHookMode("));
}

console.log("seriesImportContract tests passed");
