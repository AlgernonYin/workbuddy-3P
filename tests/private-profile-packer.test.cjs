"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "make-private-profile.py");
const ENV_KEY = "WB3P_PRIVATE_PROFILE_TEST_API_KEY";
const FAKE_KEYS = {
  json: "fake-json-private-profile-key",
  plain: "fake-plain-private-profile-key",
  env: "fake-env-private-profile-key",
  existing: "fake-existing-private-profile-key",
};

const ZIP_READER = String.raw`
import json
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    skill = archive.read("SKILL.md").decode("utf-8")
    profile = json.loads(archive.read("workbuddy-3p.profile.json").decode("utf-8"))
print(json.dumps({"names": names, "skill": skill, "profile": profile}, ensure_ascii=True))
`;

function detectPython() {
  for (const candidate of [
    { command: "python", prefix: [] },
    { command: "python3", prefix: [] },
    { command: "py", prefix: [] },
  ]) {
    const probe = spawnSync(candidate.command, ["--version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  throw new Error("No working python, python3, or py executable was found");
}

const PYTHON = detectPython();

function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb3p-private-profile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    config: path.join(dir, "config.json"),
    output: path.join(dir, "private-profile.zip"),
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env[ENV_KEY];
  for (const [name, value] of Object.entries(extra)) {
    env[name] = String(value);
  }
  return env;
}

function runPacker(fixture, { env = cleanEnv(), embedKeys = true } = {}) {
  const args = [SCRIPT, "--config", fixture.config, "--output", fixture.output];
  if (embedKeys) {
    args.push("--embed-keys");
  }
  return spawnSync(PYTHON.command, [...PYTHON.prefix, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function assertProcessStarted(result) {
  assert.ifError(result.error);
  return result;
}

function assertSuccess(result) {
  assertProcessStarted(result);
  assert.equal(
    result.status,
    0,
    `packer failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function readZipWithPython(file) {
  const result = assertProcessStarted(
    spawnSync(PYTHON.command, [...PYTHON.prefix, "-c", ZIP_READER, file], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
  assert.equal(
    result.status,
    0,
    `ZIP reader failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

function assertPrivatePackage(fixture, expectedKey) {
  const pkg = readZipWithPython(fixture.output);

  assert.deepEqual(pkg.names, ["SKILL.md", "workbuddy-3p.profile.json"]);
  assert.deepEqual(Object.keys(pkg.profile).sort(), ["config", "kind", "version"]);
  assert.equal(pkg.profile.kind, "workbuddy-3p-private-profile");
  assert.equal(pkg.profile.version, 1);
  assert.deepEqual(pkg.profile.config, {
    providers: {
      primary: {
        baseUrl: "https://test.invalid/v1",
        apiKey: expectedKey,
      },
    },
  });
  assert.match(pkg.skill, /^version: 1\.0\.0$/m);
  assert.ok(!pkg.skill.includes(expectedKey), "SKILL.md must not contain the resolved key");

  return pkg;
}

test("JSON apiKeyFile is resolved and packaged without putting the key in SKILL.md", (t) => {
  const fixture = makeFixture(t);
  const keyFile = path.join(fixture.dir, "key.json");
  writeJson(keyFile, { apiKey: FAKE_KEYS.json });
  writeJson(fixture.config, {
    providers: {
      primary: {
        baseUrl: "https://test.invalid/v1",
        apiKeyFile: path.basename(keyFile),
      },
    },
  });

  assertSuccess(runPacker(fixture));
  assertPrivatePackage(fixture, FAKE_KEYS.json);
});

test("plain apiKeyFile is trimmed before packaging", (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(path.join(fixture.dir, "key.txt"), `  ${FAKE_KEYS.plain}\n`, "utf8");
  writeJson(fixture.config, {
    providers: {
      primary: {
        baseUrl: "https://test.invalid/v1",
        apiKeyFile: "key.txt",
      },
    },
  });

  assertSuccess(runPacker(fixture));
  assertPrivatePackage(fixture, FAKE_KEYS.plain);
});

test("apiKeyEnv wins over apiKeyFile for the same provider", (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(path.join(fixture.dir, "key.txt"), FAKE_KEYS.plain, "utf8");
  writeJson(fixture.config, {
    providers: {
      primary: {
        baseUrl: "https://test.invalid/v1",
        apiKeyEnv: ENV_KEY,
        apiKeyFile: "key.txt",
      },
    },
  });

  assertSuccess(runPacker(fixture, { env: cleanEnv({ [ENV_KEY]: FAKE_KEYS.env }) }));
  const pkg = assertPrivatePackage(fixture, FAKE_KEYS.env);
  assert.equal(pkg.profile.config.providers.primary.apiKeyFile, undefined);
  assert.equal(pkg.profile.config.providers.primary.apiKeyEnv, undefined);
});

test("an existing output ZIP is not overwritten", (t) => {
  const fixture = makeFixture(t);
  const sentinel = "existing-zip-must-survive";
  writeJson(fixture.config, {
    providers: {
      primary: {
        baseUrl: "https://test.invalid/v1",
        apiKey: FAKE_KEYS.existing,
      },
    },
  });
  fs.writeFileSync(fixture.output, sentinel, "utf8");

  const result = runPacker(fixture);

  assertProcessStarted(result);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(fixture.output, "utf8"), sentinel);
});

test("a missing key fails without leaving a ZIP", (t) => {
  const fixture = makeFixture(t);
  writeJson(fixture.config, {
    providers: {
      primary: {
        baseUrl: "https://test.invalid/v1",
        apiKeyEnv: ENV_KEY,
      },
    },
  });

  const result = runPacker(fixture, { env: cleanEnv() });

  assertProcessStarted(result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /A provider key could not be resolved; no package written/);
  assert.equal(fs.existsSync(fixture.output), false);
});