const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBackground(existingStorage = {}) {
  const storage = existingStorage;
  let listener = null;
  let failNextSet = false;
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
            if (keys === null) {
              callback({ ...storage });
              return;
            }
            const list = Array.isArray(keys) ? keys : [keys];
            callback(Object.fromEntries(list.filter((key) => key in storage).map((key) => [key, storage[key]])));
          },
          set(items, callback) {
            if (failNextSet) {
              failNextSet = false;
              context.chrome.runtime.lastError = { message: "quota exceeded" };
              callback?.();
              context.chrome.runtime.lastError = null;
              return;
            }
            Object.assign(storage, items);
            callback?.();
          },
          remove(keys, callback) {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const key of list) delete storage[key];
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
  const invoke = (message, sender = {}) => new Promise((resolve) => {
    const async = listener(message, sender, resolve);
    assert.equal(async, true);
  });
  return { invoke, storage, failStorageWrite() { failNextSet = true; } };
}

test("background serializes queue mutations and claim lifecycle", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/test";
  let response = await invoke({ type: "YOLO_QUEUE_ADD", pageId, item: { text: "one" } });
  assert.equal(response.ok, true);
  response = await invoke({ type: "YOLO_QUEUE_ADD", pageId, item: { text: "two" } });
  assert.equal(response.state.items.length, 2);
  const claim = await invoke({ type: "YOLO_QUEUE_CLAIM", pageId, ownerId: "tab" });
  assert.equal(claim.ok, true);
  const submitting = await invoke({
    type: "YOLO_QUEUE_MARK_SUBMITTING",
    pageId,
    itemId: claim.item.id,
    claimToken: claim.item.claimToken
  });
  assert.equal(submitting.ok, true);
  assert.equal(submitting.item.claimPhase, "submitting");
  const completed = await invoke({
    type: "YOLO_QUEUE_COMPLETE",
    pageId,
    itemId: claim.item.id,
    claimToken: claim.item.claimToken
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.state.items.length, 1);
});


test("background reports storage write failures instead of acknowledging lost queue data", async () => {
  const { invoke, failStorageWrite } = loadBackground();
  failStorageWrite();
  const response = await invoke({
    type: "YOLO_QUEUE_ADD",
    pageId: "https://chatgpt.com/c/storage-failure",
    item: { text: "must not be acknowledged" }
  });
  assert.equal(response.ok, false);
  assert.match(response.reason, /quota exceeded/i);
});

test("background bounds active conversation queues and does not persist read-only visits", async () => {
  const { invoke, storage } = loadBackground();
  for (let index = 0; index < 40; index += 1) {
    const response = await invoke({ type: "YOLO_QUEUE_GET", pageId: `https://chatgpt.com/c/read-${index}` });
    assert.equal(response.ok, true);
  }
  assert.equal(storage.yoloQueuesV1, undefined);

  for (let index = 0; index < 25; index += 1) {
    const response = await invoke({
      type: "YOLO_QUEUE_ADD",
      pageId: `https://chatgpt.com/c/active-${index}`,
      item: { text: `message ${index}` }
    });
    assert.equal(response.ok, true);
  }
  const rejected = await invoke({
    type: "YOLO_QUEUE_ADD",
    pageId: "https://chatgpt.com/c/active-overflow",
    item: { text: "overflow" }
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "queue.conversation_limit");
});


test("background persists ambiguous delivery as terminal manual recovery", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/ambiguous-delivery";
  await invoke({ type: "YOLO_QUEUE_ADD", pageId, item: { text: "send once" } });
  const claim = await invoke({ type: "YOLO_QUEUE_CLAIM", pageId, ownerId: "tab" });
  await invoke({
    type: "YOLO_QUEUE_MARK_SUBMITTING",
    pageId,
    itemId: claim.item.id,
    claimToken: claim.item.claimToken
  });
  const failed = await invoke({
    type: "YOLO_QUEUE_FAIL",
    pageId,
    itemId: claim.item.id,
    claimToken: claim.item.claimToken,
    error: "submission could not be observed",
    errorCode: "composer.unconfirmed",
    maxRetries: 5,
    backoffSec: 1,
    pauseOnFailure: false,
    deliveryAmbiguous: true
  });

  assert.equal(failed.ok, true);
  assert.equal(failed.state.items[0].state, "failed");
  assert.equal(failed.state.items[0].errorCode, "queue.delivery_unknown");
  assert.equal(failed.state.paused, true);
  const nextClaim = await invoke({ type: "YOLO_QUEUE_CLAIM", pageId, ownerId: "other-tab" });
  assert.equal(nextClaim.ok, false);
  assert.equal(nextClaim.code, "queue.paused");
});

test("tab-backed queue messages must match the sender conversation", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/sender-bound";
  await invoke({ type: "YOLO_QUEUE_ADD", pageId, item: { text: "bound" } });

  const matching = await invoke(
    { type: "YOLO_QUEUE_GET", pageId },
    { tab: { url: "https://chatgpt.com/c/sender-bound?temporary-chat=true" } }
  );
  assert.equal(matching.ok, true);

  const mismatched = await invoke(
    { type: "YOLO_QUEUE_GET", pageId },
    { tab: { url: "https://chatgpt.com/c/other" } }
  );
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, "queue.page_mismatch");
});

test("install-time template initialization uses the shared portable transaction", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  assert.match(source, /onInstalled[\s\S]*PortableStore\.mutate/);
  assert.doesNotMatch(source, /templateLock/);
});

test("background persists sender-bound command workflow state", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/workflow";
  const sender = { tab: { url: `${pageId}?temporary-chat=true` } };
  const started = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "Ship it", status: "running", maxIterations: 5, supervisor: { noProgressCount: 2, lastProgressFingerprint: "checkpoint-a" } }
  }, sender);
  assert.equal(started.ok, true);
  assert.equal(started.workflow.kind, "goal");

  const loaded = await invoke({ type: "YOLO_WORKFLOW_GET", pageId }, sender);
  assert.equal(loaded.workflow.objective, "Ship it");
  assert.equal(loaded.workflow.maxIterations, 0);
  assert.equal(loaded.workflow.supervisor.noProgressCount, 2);
  assert.equal(loaded.workflow.supervisor.lastProgressFingerprint, "checkpoint-a");

  const mismatch = await invoke(
    { type: "YOLO_WORKFLOW_GET", pageId },
    { tab: { url: "https://chatgpt.com/c/other" } }
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "workflow.page_mismatch");

  const stale = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "stale overwrite", status: "running" }
  }, sender);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "workflow.conflict");

  const claimed = await invoke({ type: "YOLO_WORKFLOW_CLAIM", pageId, ownerId: "tab-a" }, sender);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.workflow.runnerId, "tab-a");
  const competing = await invoke({ type: "YOLO_WORKFLOW_CLAIM", pageId, ownerId: "tab-b" }, sender);
  assert.equal(competing.ok, false);
  assert.equal(competing.code, "workflow.busy");

  const cleared = await invoke({
    type: "YOLO_WORKFLOW_CLEAR",
    pageId,
    expectedRevision: claimed.workflow.revision
  }, sender);
  assert.equal(cleared.workflow.status, "idle");
  assert.equal(cleared.workflow.revision, 0);
  const afterClear = await invoke({ type: "YOLO_WORKFLOW_GET", pageId }, sender);
  assert.equal(afterClear.workflow.status, "idle");
  assert.equal(afterClear.workflow.revision, 0);
});

test("expired workflow runner lease allows safe takeover after tab loss", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/expired-runner";
  const started = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "recover after tab loss", status: "running", runnerId: "old-tab", runnerExpiresAt: 1 }
  });
  assert.equal(started.ok, true);
  assert.equal(started.workflow.runnerId, "old-tab");
  const takeover = await invoke({ type: "YOLO_WORKFLOW_CLAIM", pageId, ownerId: "new-tab" });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.renewed, true);
  assert.equal(takeover.workflow.runnerId, "new-tab");
  assert.ok(takeover.workflow.runnerExpiresAt > Date.now());
});
test("background bounds active command workflows", async () => {
  const { invoke } = loadBackground();
  for (let index = 0; index < 25; index += 1) {
    const pageId = `https://chatgpt.com/c/workflow-${index}`;
    const response = await invoke({
      type: "YOLO_WORKFLOW_SET",
      pageId,
      expectedRevision: 0,
      workflow: { kind: "loop", objective: `work ${index}`, status: "running" }
    });
    assert.equal(response.ok, true);
  }
  const rejected = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId: "https://chatgpt.com/c/workflow-overflow",
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "overflow", status: "running" }
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "workflow.conversation_limit");
});

test("workflow prompt enqueue commits queue and workflow together", async () => {
  const { invoke, storage } = loadBackground();
  const pageId = "https://chatgpt.com/c/atomic-workflow";
  const response = await invoke({
    type: "YOLO_WORKFLOW_QUEUE_ADD",
    pageId,
    expectedRevision: 0,
    ownerId: "tab-a",
    workflow: { kind: "goal", objective: "atomic", status: "running", promptFingerprint: "prompt" },
    item: { text: "workflow prompt", source: "workflow:goal", sourceId: "goal-a" }
  });
  assert.equal(response.ok, true);
  assert.equal(response.workflow.pendingItemId, response.item.id);
  assert.equal(response.workflow.runnerId, "tab-a");
  assert.equal(storage.yoloQueuesV1[pageId].items[0].id, response.item.id);
  const workflowKey = Object.keys(storage).find((key) => key.startsWith("yoloWorkflow:"));
  assert.equal(storage[workflowKey].pendingItemId, response.item.id);

  const stale = await invoke({
    type: "YOLO_WORKFLOW_QUEUE_ADD",
    pageId,
    expectedRevision: 0,
    ownerId: "tab-b",
    workflow: { kind: "goal", objective: "stale", status: "running" },
    item: { text: "must not queue" }
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "workflow.conflict");
  assert.equal(storage.yoloQueuesV1[pageId].items.length, 1);
});

test("workflow and queue survive a fresh background service-worker context", async () => {
  const storage = {};
  const pageId = "https://chatgpt.com/c/service-worker-restart";
  const first = loadBackground(storage);
  const queued = await first.invoke({
    type: "YOLO_WORKFLOW_QUEUE_ADD",
    pageId,
    expectedRevision: 0,
    ownerId: "tab-a",
    workflow: {
      kind: "goal", objective: "survive restart", status: "running", promptFingerprint: "owned",
      supervisor: { recoveryAttempts: 2, verificationPending: true, verificationAttempts: 1, lastProgressFingerprint: "checkpoint-a" }
    },
    item: { text: "durable workflow prompt", source: "workflow:goal", sourceId: "goal-restart" }
  });
  assert.equal(queued.ok, true);
  const itemId = queued.item.id;

  const second = loadBackground(storage);
  const workflow = await second.invoke({ type: "YOLO_WORKFLOW_GET", pageId });
  const queue = await second.invoke({ type: "YOLO_QUEUE_GET", pageId });
  assert.equal(workflow.ok, true);
  assert.equal(workflow.workflow.pendingItemId, itemId);
  assert.equal(workflow.workflow.promptFingerprint, "owned");
  assert.equal(workflow.workflow.supervisor.recoveryAttempts, 2);
  assert.equal(workflow.workflow.supervisor.verificationPending, true);
  assert.equal(workflow.workflow.supervisor.verificationAttempts, 1);
  assert.equal(workflow.workflow.supervisor.lastProgressFingerprint, "checkpoint-a");
  assert.equal(queue.ok, true);
  assert.equal(queue.state.items.length, 1);
  assert.equal(queue.state.items[0].id, itemId);
  assert.equal(queue.state.items[0].text, "durable workflow prompt");
});

test("clearing a workflow removes its per-conversation storage key", async () => {
  const { invoke, storage } = loadBackground();
  const pageId = "https://chatgpt.com/c/removable-workflow";
  const started = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "remove me", status: "paused" }
  });
  assert.equal(started.ok, true);
  assert.equal(Object.keys(storage).some((key) => key.startsWith("yoloWorkflow:")), true);
  const cleared = await invoke({
    type: "YOLO_WORKFLOW_CLEAR",
    pageId,
    expectedRevision: started.workflow.revision
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.workflow.status, "idle");
  assert.equal(Object.keys(storage).some((key) => key.startsWith("yoloWorkflow:")), false);
});

test("fresh installs open only the local onboarding page", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  assert.match(source, /details\?\.reason === "install"/);
  assert.match(source, /chrome\.runtime\.getURL\("onboarding\.html"\)/);
  assert.doesNotMatch(source, /reason === "update"[^\n]*tabs/);
});

test("an intentionally empty template library remains empty", async () => {
  const { invoke, storage } = loadBackground();
  storage.yoloTemplatesV1 = [];
  const response = await invoke({ type: "YOLO_TEMPLATES_GET" });
  assert.equal(response.ok, true);
  assert.equal(Array.isArray(response.templates), true);
  assert.equal(response.templates.length, 0);
});

test("template additions are idempotent and share the portable revision", async () => {
  const { invoke, storage } = loadBackground();
  const message = {
    type: "YOLO_TEMPLATE_ADD",
    template: { id: "client-template-id", name: "Stable", text: "same mutation" }
  };
  const first = await invoke(message);
  assert.equal(first.ok, true);
  assert.equal(storage.yoloPortableRevisionV1, 1);
  const second = await invoke(message);
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(second.templates.filter((template) => template.id === "client-template-id").length, 1);
  assert.equal(storage.yoloPortableRevisionV1, 1);
});

test("template additions require a stable client mutation id", async () => {
  const { invoke, storage } = loadBackground();
  const response = await invoke({
    type: "YOLO_TEMPLATE_ADD",
    template: { name: "Missing id", text: "must not mutate" }
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, "template.id_required");
  assert.equal(storage.yoloPortableRevisionV1, undefined);
  assert.equal(storage.yoloTemplatesV1, undefined);
});


test("persistent goals are linked to a stable project and context exhaustion creates a tombstone", async () => {
  const { invoke, storage } = loadBackground();
  const pageId = "https://chatgpt.com/c/rollover-foundation";
  const started = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "Survive thread exhaustion", status: "running" }
  });
  assert.equal(started.ok, true);
  assert.ok(started.workflow.projectId);
  const projectId = started.workflow.projectId;
  assert.equal(storage.yoloProjectsV1[projectId].currentConversationId, pageId);
  assert.equal(storage.yoloProjectsV1[projectId].conversationChain[0].generation, 1);

  const exhausted = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: started.workflow.revision,
    workflow: { ...started.workflow, status: "rollover_required", reason: "maximum length for this conversation" }
  });
  assert.equal(exhausted.ok, true);
  assert.equal(exhausted.workflow.status, "rollover_required");
  const project = (await invoke({ type: "YOLO_PROJECT_GET", pageId })).project;
  assert.equal(project.id, projectId);
  assert.equal(project.status, "rollover_required");
  assert.equal(project.conversationChain[0].status, "exhausted");
  assert.equal(project.conversationChain[0].doNotContinue, true);
});

test("exhausted conversation stays inert across refresh even with stale queued or claimed work", async () => {
  const storage = {};
  const pageId = "https://chatgpt.com/c/exhausted-refresh-loop";
  const first = loadBackground(storage);
  const queued = await first.invoke({
    type: "YOLO_WORKFLOW_QUEUE_ADD",
    pageId,
    expectedRevision: 0,
    ownerId: "old-tab",
    workflow: { kind: "goal", objective: "Never resend in exhausted chat", status: "running", id: "goal-refresh" },
    item: { text: "last prompt", source: "workflow:goal", sourceId: "goal-refresh" }
  });
  assert.equal(queued.ok, true);
  const claimedBeforeLimit = await first.invoke({ type: "YOLO_QUEUE_CLAIM", pageId, ownerId: "old-content" });
  assert.equal(claimedBeforeLimit.ok, true);
  const exhausted = await first.invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: queued.workflow.revision,
    workflow: { ...queued.workflow, status: "rollover_required", reason: "conversation reached maximum length" }
  });
  assert.equal(exhausted.ok, true);

  const submittingAfterLimit = await first.invoke({
    type: "YOLO_QUEUE_MARK_SUBMITTING",
    pageId,
    itemId: claimedBeforeLimit.item.id,
    claimToken: claimedBeforeLimit.item.claimToken
  });
  assert.equal(submittingAfterLimit.ok, false);
  assert.equal(submittingAfterLimit.code, "project.conversation_exhausted");

  const refreshed = loadBackground(storage);
  const workflowClaim = await refreshed.invoke({ type: "YOLO_WORKFLOW_CLAIM", pageId, ownerId: "refreshed-tab" });
  assert.equal(workflowClaim.ok, false);
  assert.equal(workflowClaim.code, "project.conversation_exhausted");
  const queueClaim = await refreshed.invoke({ type: "YOLO_QUEUE_CLAIM", pageId, ownerId: "refreshed-content" });
  assert.equal(queueClaim.ok, false);
  assert.equal(queueClaim.code, "project.conversation_exhausted");
  const actionClaim = await refreshed.invoke({
    type: "YOLO_ACTION_CLAIM",
    pageId,
    actionKey: "refresh",
    ownerId: "refreshed-content",
    leaseMs: 1000,
    cooldownMs: 0
  });
  assert.equal(actionClaim.ok, false);
  assert.equal(actionClaim.code, "project.conversation_exhausted");
  const queueAdd = await refreshed.invoke({ type: "YOLO_QUEUE_ADD", pageId, item: { text: "restored last prompt" } });
  assert.equal(queueAdd.ok, false);
  assert.equal(queueAdd.code, "project.conversation_exhausted");
  const restart = await refreshed.invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: exhausted.workflow.revision,
    workflow: { ...exhausted.workflow, status: "running" }
  });
  assert.equal(restart.ok, false);
  assert.equal(restart.code, "project.conversation_exhausted");
  assert.equal(storage.yoloQueuesV1[pageId].items.length, 1, "stale queue item remains inspectable but inert");
});
