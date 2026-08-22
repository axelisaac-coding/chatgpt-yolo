const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "tab-supervisor.js"), "utf8");
const sharedSource = fs.readFileSync(path.join(root, "shared.js"), "utf8");

function makeHarness({ fail = "query", unhealthy = false } = {}) {
  const errors = [];
  const injections = [];
  let alarmCallback = null;
  const listeners = {
    alarm: null,
    startup: null,
    installed: null,
    updated: null,
    activated: null,
    removed: null
  };

  const chrome = {
    runtime: {
      get lastError() { return null; },
      onStartup: { addListener(handler) { listeners.startup = handler; } },
      onInstalled: { addListener(handler) { listeners.installed = handler; } }
    },
    alarms: {
      create(name, options) {
        if (name === "yolo-tab-supervisor" && options?.periodInMinutes === 1) alarmCallback = options;
      },
      get(name, callback) { callback?.(null); },
      onAlarm: {
        addListener(handler) { listeners.alarm = handler; }
      }
    },
    tabs: {
      query(queryInfo, callback) {
        if (fail === "query") throw new Error("tabs.query rejected");
        callback?.(unhealthy ? [{ id: 1, url: "https://chatgpt.com/c/test", status: "complete", autoDiscardable: true }] : []);
      },
      get(tabId, callback) {
        if (fail === "get") throw new Error(`tabs.get(${tabId}) rejected`);
        callback?.({ id: tabId, url: "https://chatgpt.com/c/test" });
      },
      update(tabId, updateProperties, callback) {
        callback?.({ id: tabId });
      },
      sendMessage(tabId, message, callback) {
        callback?.(unhealthy ? null : { ok: true });
      },
      onUpdated: { addListener(handler) { listeners.updated = handler; } },
      onActivated: { addListener(handler) { listeners.activated = handler; } },
      onRemoved: { addListener(handler) { listeners.removed = handler; } }
    },
    scripting: {
      executeScript(injection, callback) {
        injections.push([...(injection?.files || [])]);
        callback?.();
      }
    }
  };

  const context = {
    console: {
      error: (message) => errors.push(message)
    },
    Date,
    Promise,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
    chrome,
    globalThis: undefined,
    YOLOConfig: {
      VERSION: "test",
      STORAGE_KEYS: { global: "globalSettings", pages: "pages", pageWorkflows: "pageWorkflows" },
      DEFAULT_SETTINGS: { protectActiveWorkflowTabs: false },
      isSupportedUrl(url) { return /^https:\/\/[^/]*chatgpt\.com/.test(String(url)); },
      pageId(url) { return String(url); },
      isDurablePageId(pageId) { return /\/c\/[^/]+$/.test(String(pageId)); },
      mergeSettings(...sources) { return Object.assign({}, ...sources); },
      pageSettingsKey(pageId) { return `pageSettings:${pageId}`; },
      workflowKey(pageId) { return `workflow:${pageId}`; }
    },
    YOLOLifecycle: {
      shouldProtectTab({ enabled }) { return Boolean(enabled); }
    }
  };

  vm.runInNewContext(sharedSource, context, { filename: "shared.js" });
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "tab-supervisor.js" });

  return { listeners, errors, injections };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("fresh unhealthy tab injects the complete dependency-ordered content stack", async () => {
  const { listeners, injections } = makeHarness({ fail: "none", unhealthy: true });
  listeners.installed?.();
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.deepEqual(injections[0], ["config.js", "lifecycle.js", "platforms.js", "shared.js", "commands.js", "command-ui.js", "content-state.js", "content.js", "command-runtime.js"]);
});

test("listener catches and logs alarm sweep rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "query" });
  listeners.alarm?.({ name: "yolo-tab-supervisor" });
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor sweep failed:/);
});

test("listener catches and logs startup sweep rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "query" });
  listeners.startup?.();
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor startup sweep failed:/);
});

test("listener catches and logs install sweep rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "query" });
  listeners.installed?.();
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor install sweep failed:/);
});

test("listener catches and logs onUpdated tab inspection rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "get" });
  listeners.updated?.(42, { status: "complete" });
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor updated-tab inspection failed:/);
});

test("listener catches and logs onActivated tab inspection rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "get" });
  listeners.activated?.({ tabId: 7 });
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor activated-tab inspection failed:/);
});
