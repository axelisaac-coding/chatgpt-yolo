const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBackground() {
  const storage = {};
  const setCalls = [];
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
          set(items, callback) {
            setCalls.push(Object.keys(items).sort());
            Object.assign(storage, items);
            callback?.();
          },
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
  const invoke = (message) => new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true);
  });
  return { invoke, storage, setCalls };
}

test("workflow queue completion advances queue and workflow in one storage write", async () => {
  const { invoke, storage, setCalls } = loadBackground();
  const pageId = "https://chatgpt.com/c/atomic-delivery";
  const queued = await invoke({
    type: "YOLO_WORKFLOW_QUEUE_ADD",
    pageId,
    expectedRevision: 0,
    ownerId: "tab-a",
    workflow: {
      kind: "goal",
      objective: "ship",
      status: "running",
      id: "workflow-a",
      promptFingerprint: "prompt-fingerprint"
    },
    item: {
      text: "workflow prompt",
      source: "workflow:goal",
      sourceId: "workflow-a"
    }
  });
  assert.equal(queued.ok, true);

  const claimed = await invoke({ type: "YOLO_QUEUE_CLAIM", pageId, ownerId: "content-a" });
  await invoke({
    type: "YOLO_QUEUE_MARK_SUBMITTING",
    pageId,
    itemId: claimed.item.id,
    claimToken: claimed.item.claimToken
  });
  const beforeComplete = setCalls.length;
  const completed = await invoke({
    type: "YOLO_QUEUE_COMPLETE",
    pageId,
    itemId: claimed.item.id,
    claimToken: claimed.item.claimToken
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.workflow.awaitingResponse, true);
  assert.equal(completed.workflow.pendingItemId, "");
  assert.equal(setCalls.length, beforeComplete + 1);
  const workflowKey = Object.keys(storage).find((key) => key.startsWith("yoloWorkflow:"));
  assert.deepEqual(setCalls.at(-1), ["yoloQueuesV1", workflowKey].sort());
  assert.equal(storage[workflowKey].awaitingResponse, true);
  assert.equal(storage[workflowKey].pendingItemId, "");
  assert.equal(storage.yoloQueuesV1[pageId].items.length, 0);
});

test("retrying an acknowledged workflow completion is idempotent", async () => {
  const { invoke, storage } = loadBackground();
  const pageId = "https://chatgpt.com/c/atomic-retry";
  await invoke({
    type: "YOLO_WORKFLOW_QUEUE_ADD",
    pageId,
    expectedRevision: 0,
    ownerId: "tab-a",
    workflow: { kind: "loop", objective: "iterate", status: "running", id: "workflow-b" },
    item: { text: "loop prompt", source: "workflow:loop", sourceId: "workflow-b" }
  });
  const claimed = await invoke({ type: "YOLO_QUEUE_CLAIM", pageId, ownerId: "content-a" });
  await invoke({ type: "YOLO_QUEUE_MARK_SUBMITTING", pageId, itemId: claimed.item.id, claimToken: claimed.item.claimToken });
  const first = await invoke({ type: "YOLO_QUEUE_COMPLETE", pageId, itemId: claimed.item.id, claimToken: claimed.item.claimToken });
  const second = await invoke({ type: "YOLO_QUEUE_COMPLETE", pageId, itemId: claimed.item.id, claimToken: claimed.item.claimToken });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyCompleted, true);
  const workflowKey = Object.keys(storage).find((key) => key.startsWith("yoloWorkflow:"));
  assert.equal(storage[workflowKey].awaitingResponse, true);
});

test("normal queue completion does not invent workflow state", async () => {
  const { invoke, storage } = loadBackground();
  const pageId = "https://chatgpt.com/c/normal-delivery";
  await invoke({ type: "YOLO_QUEUE_ADD", pageId, item: { text: "normal prompt", source: "popup" } });
  const claimed = await invoke({ type: "YOLO_QUEUE_CLAIM", pageId, ownerId: "content-a" });
  await invoke({ type: "YOLO_QUEUE_MARK_SUBMITTING", pageId, itemId: claimed.item.id, claimToken: claimed.item.claimToken });
  const completed = await invoke({ type: "YOLO_QUEUE_COMPLETE", pageId, itemId: claimed.item.id, claimToken: claimed.item.claimToken });
  assert.equal(completed.ok, true);
  assert.equal(Object.keys(storage).some((key) => key.startsWith("yoloWorkflow:")), false);
});
