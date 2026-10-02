"use strict";
const fs = require("fs");
function read(p) {
  let value;
  try { value = JSON.parse(fs.readFileSync(p.parameters, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw Error("invalid local parameter preferences"); }
  if (value !== undefined && (!value || value.version !== 1 || !["3p", "native"].includes(value.priority) ||
      Object.keys(value).some(k => !["version", "priority"].includes(k)))) throw Error("invalid local parameter preferences");
  const priority = value?.priority ?? process.env.WB3P_PARAMETER_PRIORITY ?? "3p";
  if (!["3p", "native"].includes(priority)) throw Error("parameter priority must be 3p or native");
  return { version: 1, priority };
}
module.exports = { read };
