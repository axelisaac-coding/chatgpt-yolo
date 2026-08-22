const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadIntegratedBackground() {
  const storage = {};
  const listeners = [];
  let id = 0;
  const context = {
    console, Date, Promise, Math, JSON, URL, TextEncoder, setTimeout, clearTimeout,
    crypto: { randomUUID: () => `id-${++id}` },
    chrome: {
      runtime: {
        lastError: null,
        getURL: (value) => value,
        onInstalled: { addListener() {} },
        onMessage: { addListener(value) { listeners.push(value); } }
      },
      tabs: { create() {} },
      storage: {
        local: {
          get(keys, callback) {
            if (keys === null) return callback({ ...storage });
            const list = Array.isArray(keys) ? keys : [keys];
            callback(Object.fromEntries(list.filter((key) => key in storage).map((key) => [key, storage[key]])));
          },
          set(items, callback) { Object.assign(storage, items); callback?.(); },
          remove(keys, callback) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
            callback?.();
          }
        }
      }
    },
    importScripts() {}
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    "config.js", "shared.js", "coordinator.js", "portable-store.js", "queue.js", "commands.js", "projects.js", "background.js", "portability.js", "data-background.js"
  ]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });

  const invoke = (message, sender = {}) => new Promise((resolve, reject) => {
    let handled = false;
    for (const listener of listeners) {
      const async = listener(message, sender, resolve);
      if (async) {
        if (handled) return reject(new Error(`Multiple listeners claimed ${message.type}`));
        handled = true;
      }
    }
    if (!handled) reject(new Error(`No listener claimed ${message.type}`));
  });
  return { invoke, storage };
}

const pageId = "https://chatgpt.com/c/portable-integration";
const backup = () => ({
  format: "chatgpt-yolo-backup",
  schemaVersion: 1,
  appVersion: "1.0.0",
  exportedAt: "2026-07-16T00:00:00.000Z",
  globalSettings: { queueLimitPerHour: 30 },
  pageSettings: { [pageId]: { enabled: true, profile: "safe" } },
  templates: []
});

test("template mutation and import preview share one revision boundary", async () => {
  const { invoke, storage } = loadIntegratedBackground();
  const value = backup();
  const preview = await invoke({ type: "YOLODATA_IMPORT_PREVIEW", backup: JSON.stringify(value) });
  assert.equal(preview.ok, true);
  const added = await invoke({
    type: "YOLO_TEMPLATE_ADD",
    template: { id: "stable-template", name: "Stable", text: "Template body" }
  });
  assert.equal(added.ok, true);
  assert.equal(storage.yoloPortableRevisionV1, 1);
  const apply = await invoke({
    type: "YOLODATA_IMPORT_APPLY",
    backup: JSON.stringify(value),
    previewToken: preview.previewToken
  });
  assert.equal(apply.ok, false);
  assert.equal(apply.code, "data.storage_conflict");
});

test("settings and templates serialize through the same transaction service", async () => {
  const { invoke, storage } = loadIntegratedBackground();
  const sender = { tab: { url: pageId } };
  const [settings, template] = await Promise.all([
    invoke({ type: "YOLODATA_SETTINGS_SET", pageId, settings: { enabled: true, queueLimitPerHour: 18 } }, sender),
    invoke({ type: "YOLO_TEMPLATE_ADD", template: { id: "parallel-template", name: "Parallel", text: "Body" } })
  ]);
  assert.equal(settings.ok, true);
  assert.equal(template.ok, true);
  assert.equal(storage.yoloPortableRevisionV1, 2);
  assert.equal(storage[`yoloPage:${encodeURIComponent(pageId)}`].queueLimitPerHour, 18);
  assert.ok(storage.yoloTemplatesV1.some((entry) => entry.id === "parallel-template"));
});
