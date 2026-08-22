const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Config = require("../config.js");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("manifest and package versions match the runtime version", () => {
  assert.equal(manifest.version, Config.VERSION);
  assert.equal(pkg.version, Config.VERSION);
});

test("every manifest entry point exists", () => {
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    ...Object.values(manifest.icons)
  ];
  for (const file of files) assert.equal(fs.existsSync(path.join(root, file)), true, file);
});

test("content scripts load shared configuration before the engine", () => {
  assert.deepEqual(manifest.content_scripts[0].js, [
    "config.js",
    "lifecycle.js",
    "platforms.js",
    "shared.js",
    "commands.js",
    "command-ui.js",
    "content-state.js",
    "content.js",
    "command-runtime.js"
  ]);
});

test("manifest grants host access only to ChatGPT", () => {
  const hosts = ["https://chatgpt.com/*", "https://*.chatgpt.com/*"];
  assert.deepEqual(manifest.host_permissions, hosts);
  assert.deepEqual(manifest.content_scripts[0].matches, hosts);
  assert.doesNotMatch(manifest.description, /grok/i);
  assert.doesNotMatch(pkg.description, /grok/i);
});

test("public extension metadata and permissions stay intentionally narrow", () => {
  assert.equal(manifest.version, "1.2.0");
  assert.equal(manifest.homepage_url, "https://github.com/axelisaac-coding/chatgpt-yolo");
  assert.deepEqual(manifest.permissions, ["alarms", "scripting", "storage"]);
  assert.equal(manifest.minimum_chrome_version, "114");
});
