"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const URI = "ui://workbuddy-3p/settings", MIME = "text/html;profile=mcp-app";
function render(state = null) {
  const html = fs.readFileSync(path.join(ROOT, "ui", "settings.html"), "utf8");
  const safe = JSON.stringify(state).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return html.replace("__WB3P_STATE__", () => safe).replace("__WB3P_BRIDGE__", () => fs.readFileSync(path.join(__dirname, "mcp-app-bridge.js"), "utf8"));
}
function artifact(state, dir = process.cwd()) {
  const dest = path.join(dir, "workbuddy-3p-settings.html");
  if (fs.existsSync(dest) && (!fs.lstatSync(dest).isFile() || fs.lstatSync(dest).isSymbolicLink())) throw Error("settings artifact target must be a regular file");
  fs.writeFileSync(dest, render(state), { mode: 0o600 });
  return dest;
}
module.exports = { URI, MIME, render, artifact };
