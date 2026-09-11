const assert = require("assert");
const EdgeTtsService = require("../electron/services/edgeTtsService");

assert.strictEqual(EdgeTtsService.formatRelativePercent(14), "+14%");
assert.strictEqual(EdgeTtsService.formatRelativePercent(-5), "-5%");
assert.strictEqual(EdgeTtsService.formatRelativePercent("+18%"), "+18%");
assert.strictEqual(EdgeTtsService.formatRelativePercent(undefined, "-4%"), "-4%");
assert.strictEqual(EdgeTtsService.formatPitch(8), "+8Hz");
assert.strictEqual(EdgeTtsService.formatPitch(-3), "-3Hz");
assert.strictEqual(EdgeTtsService.formatVolume(105), 105);
assert.strictEqual(EdgeTtsService.formatVolume(999), 150);

console.log("edgeTtsService tests passed");
