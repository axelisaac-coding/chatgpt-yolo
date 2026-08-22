const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadInstallLifecycle() {
  let installedListener = null;
  const createdTabs = [];
  const storage = {};
  const context = {
    console,
    Date,
    Promise,
    Math,
    JSON,
    URL,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "install-test-id" },
    chrome: {
      runtime: {
        lastError: null,
        getURL(relative) { return `chrome-extension://test/${relative}`; },
        onInstalled: { addListener(listener) { installedListener = listener; } },
        onMessage: { addListener() {} }
      },
      tabs: {
        create(properties) { createdTabs.push({ ...properties }); }
      },
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
  for (const file of ["config.js", "shared.js", "coordinator.js", "portable-store.js", "queue.js", "commands.js", "projects.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });
  }
  assert.equal(typeof installedListener, "function");
  return { installedListener, createdTabs, storage };
}

test("onboarding opens once for a fresh install and never for updates", async () => {
  const { installedListener, createdTabs, storage } = loadInstallLifecycle();

  installedListener({ reason: "update" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(createdTabs, []);

  installedListener({ reason: "install" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(createdTabs, [{ url: "chrome-extension://test/onboarding.html" }]);
  assert.ok(Array.isArray(storage.yoloTemplatesV1));
  assert.ok(storage.yoloTemplatesV1.length > 0);
});
