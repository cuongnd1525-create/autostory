const assert = require("assert");

const {
  clampProgressPercent,
  createMonotonicProgressNormalizer
} = require("../electron/services/progressPolicy");

assert.strictEqual(clampProgressPercent(-10), 0);
assert.strictEqual(clampProgressPercent(110), 100);
assert.strictEqual(clampProgressPercent("invalid"), null);

const normalize = createMonotonicProgressNormalizer();
const sequence = [8, 30, 80, 24, 88, 55, 100]
  .map((percent) => normalize({ percent, message: `reported ${percent}` }));

assert.deepStrictEqual(
  sequence.map((item) => item.percent),
  [8, 30, 80, 80, 88, 88, 100]
);
assert.strictEqual(sequence[3].reportedPercent, 24);
assert.strictEqual(sequence[3].message, "reported 24");
assert.ok(!Object.prototype.hasOwnProperty.call(sequence[1], "reportedPercent"));

const nextOperation = createMonotonicProgressNormalizer();
assert.strictEqual(nextOperation({ percent: 5 }).percent, 5);
assert.deepStrictEqual(nextOperation({ message: "message only" }), { message: "message only" });

console.log("progress policy tests passed");
