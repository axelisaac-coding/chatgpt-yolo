const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBackground() {
  const storage = {};
  let listener = null;
  const context = {
    console, Date, Promise, Math, JSON, URL, setTimeout, clearTimeout,
    crypto: { randomUUID: () => `id-${Math.random()}` },
    chrome: {
      runtime: {
        lastError: null,
        onInstalled: { addListener() {} },
        onMessage: { addListener(value) { listener = value; } }
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
  for (const file of ["config.js", "shared.js", "coordinator.js", "portable-store.js", "queue.js", "commands.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });
  }
  const invoke = (message) => new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true);
  });
  return { invoke, storage };
}

test("completed workflows do not consume active capacity", async () => {
  const { invoke } = loadBackground();
  for (let index = 0; index < 30; index += 1) {
    const response = await invoke({
      type: "YOLO_WORKFLOW_SET",
      pageId: `https://chatgpt.com/c/completed-${index}`,
      expectedRevision: 0,
      workflow: { kind: "goal", objective: `done ${index}`, status: "completed" }
    });
    assert.equal(response.ok, true);
  }
  const started = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId: "https://chatgpt.com/c/new-active",
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "new active", status: "running" }
  });
  assert.equal(started.ok, true);
});

test("restarting a completed workflow cannot bypass active capacity", async () => {
  const { invoke } = loadBackground();
  for (let index = 0; index < 25; index += 1) {
    const response = await invoke({
      type: "YOLO_WORKFLOW_SET",
      pageId: `https://chatgpt.com/c/full-active-${index}`,
      expectedRevision: 0,
      workflow: { kind: "goal", objective: `active ${index}`, status: "running" }
    });
    assert.equal(response.ok, true);
  }
  const completedPage = "https://chatgpt.com/c/restart-completed";
  const completed = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId: completedPage,
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "completed", status: "completed" }
  });
  assert.equal(completed.ok, true);
  const restarted = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId: completedPage,
    expectedRevision: completed.workflow.revision,
    workflow: { kind: "goal", objective: "restart", status: "running" }
  });
  assert.equal(restarted.ok, false);
  assert.equal(restarted.code, "workflow.conversation_limit");
});

test("template retries remain idempotent at the library limit", async () => {
  const { invoke, storage } = loadBackground();
  storage.yoloTemplatesV1 = Array.from({ length: 50 }, (_, index) => ({
    id: index === 49 ? "retry-at-capacity" : `template-${index}`,
    name: `Template ${index}`,
    text: `Text ${index}`
  }));
  const response = await invoke({
    type: "YOLO_TEMPLATE_ADD",
    template: { id: "retry-at-capacity", name: "Template 49", text: "Text 49" }
  });
  assert.equal(response.ok, true);
  assert.equal(response.deduplicated, true);
  assert.equal(response.templates.length, 50);
  assert.equal(storage.yoloPortableRevisionV1, undefined);
});

test("corrupt template ids are repaired and duplicate ids are removed on read", async () => {
  const { invoke, storage } = loadBackground();
  storage.yoloTemplatesV1 = [
    { id: "   ", name: "Recovered", text: "one" },
    { id: "duplicate", name: "First", text: "two" },
    { id: "duplicate", name: "Second", text: "three" }
  ];
  const response = await invoke({ type: "YOLO_TEMPLATES_GET" });
  assert.equal(response.ok, true);
  assert.equal(response.templates.length, 2);
  assert.equal(response.templates.every((template) => template.id.trim().length > 0), true);
  assert.equal(new Set(response.templates.map((template) => template.id)).size, 2);
});

test("stalled workflows remain active and count toward conversation capacity", async () => {
  const { invoke } = loadBackground();
  for (let index = 0; index < 25; index += 1) {
    const response = await invoke({
      type: "YOLO_WORKFLOW_SET",
      pageId: `https://chatgpt.com/c/stalled-${index}`,
      expectedRevision: 0,
      workflow: { kind: "goal", objective: `stalled ${index}`, status: "stalled" }
    });
    assert.equal(response.ok, true);
  }
  const overflow = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId: "https://chatgpt.com/c/stalled-overflow",
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "new work", status: "running" }
  });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, "workflow.conversation_limit");
});
