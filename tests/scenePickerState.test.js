const assert = require("assert");
const fs = require("fs");
const path = require("path");

const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");

assert.ok(
  renderer.includes("expandedScenePickerIndex: -1"),
  "Scene picker must start closed."
);
assert.ok(
  !renderer.includes("expandedScenePickerIndex = 0"),
  "Project, draft and variant resets must not open scene 1 automatically."
);
assert.ok(
  renderer.includes("state.expandedScenePickerIndex === index ? -1 : index"),
  "Only the explicit scene-picker toggle should open the requested segment."
);

console.log("scene picker state tests passed");
