const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("background composition preserves the existing engine before adding data portability", () => {
  assert.equal(read("background-wrapper.js").replace(/\r\n/g, "\n").trim(), '"use strict";\n\nimportScripts("shared.js", "lifecycle.js", "background.js", "portability.js", "data-background.js", "tab-supervisor.js");');
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.background.service_worker, "background-wrapper.js");
});

test("data portability adds no browser or host permissions", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.deepEqual(manifest.permissions, ["alarms", "scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "https://*.chatgpt.com/*"]);
});

test("the release allowlist includes every portability runtime file", () => {
  const packager = read("scripts/package.mjs");
  for (const file of ["background-wrapper.js", "tab-supervisor.js", "lifecycle.js", "portable-store.js", "data-background.js", "portability.js", "options-portability.js"]) {
    assert.match(packager, new RegExp(`"${file.replace(".", "\\.")}"`), file);
  }
});

test("the data listener cannot claim existing YOLO messages", () => {
  const source = read("data-background.js");
  assert.match(source, /startsWith\("YOLODATA_"\)/);
  assert.doesNotMatch(source, /startsWith\("YOLO_"\)/);
});

test("all portable mutations share the background transaction service", () => {
  const background = read("background.js");
  const dataBackground = read("data-background.js");
  const content = read("content.js");
  assert.match(background, /PortableStore\.mutate/);
  assert.match(dataBackground, /Store\.mutate/);
  assert.match(dataBackground, /YOLODATA_SETTINGS_SET/);
  assert.match(content, /type: "YOLODATA_SETTINGS_SET"/);
  const persistStart = content.indexOf("async function persistSettings");
  const persistEnd = content.indexOf("function actionLimit", persistStart);
  assert.doesNotMatch(content.slice(persistStart, persistEnd), /storageSet\(/);
});

test("template creation carries a stable client id for idempotency", () => {
  const options = read("options.js");
  assert.match(options, /pendingTemplateId = crypto\.randomUUID\(\)/);
  assert.match(options, /YOLO_TEMPLATE_ADD[\s\S]*id: pendingTemplateId/);
});

test("asynchronous settings reloads are bound to the route that initiated them", () => {
  const content = read("content.js");
  assert.match(content, /const settingsPageId = state\.pageId/);
  assert.match(content, /state\.pageId !== settingsPageId \|\| currentPageId\(\) !== settingsPageId/);
  assert.match(content, /legacyPageSettings = stored\[Config\.STORAGE_KEYS\.pages\]\?\.\[settingsPageId\]/);
});

test("template add retries preserve one mutation id and reconcile edited retries", () => {
  const options = read("options.js");
  assert.match(options, /let pendingTemplateId = ""/);
  assert.match(options, /if \(adding && !pendingTemplateId\) pendingTemplateId = crypto\.randomUUID\(\)/);
  assert.match(options, /YOLO_TEMPLATE_ADD[\s\S]*id: pendingTemplateId/);
  assert.match(options, /response\.deduplicated[\s\S]*YOLO_TEMPLATE_UPDATE[\s\S]*id: pendingTemplateId/);
});
