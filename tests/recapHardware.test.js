const assert = require("assert");
const RecapHardwareService = require("../electron/services/recap/recapHardwareService");

async function run() {
  const service = new RecapHardwareService();
  const encoder = await service.detectBestEncoder();

  assert.ok(encoder, "Encoder must be detected");
  assert.ok(encoder.name, "Encoder must have a name");
  assert.ok(typeof encoder.isHardware === "boolean", "isHardware must be boolean");
  assert.ok(Array.isArray(encoder.args) && encoder.args.length > 0, "args must be non-empty array");

  // Verify draft args
  const draftArgs = service.getFastDraftEncoderArgs(encoder);
  assert.ok(Array.isArray(draftArgs) && draftArgs.includes("-c:v"), "Draft args must include -c:v");

  // Verify caching
  const second = await service.detectBestEncoder();
  assert.strictEqual(second.name, encoder.name, "Second detection should use cached encoder");

  console.log(`recapHardware.test.js PASSED (Detected: ${encoder.label})`);
}

run().catch((err) => {
  console.error("recapHardware.test.js FAILED:", err);
  process.exit(1);
});
