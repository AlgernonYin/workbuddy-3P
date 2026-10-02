"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
test("CodeBuddy and compatible manifests expose the same release", () => {
  const root = path.resolve(__dirname, "..");
  const read = p => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
  const expected = read("plugins/custom-api-models/.codebuddy-plugin/plugin.json").version;
  for (const kind of ["codebuddy", "claude"]) {
    assert.equal(read(`plugins/custom-api-models/.${kind}-plugin/plugin.json`).version, expected);
    assert.equal(read(`.${kind}-plugin/marketplace.json`).plugins.find(p => p.name === "custom-api-models").version, expected);
  }
});
