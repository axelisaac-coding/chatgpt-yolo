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

test("project rollover claim is CAS-protected and survives a fresh service-worker context", async () => {
  const storage = {};
  const pageId = "https://chatgpt.com/c/project-rollover-lease";
  const first = loadBackground(storage);
  const workflow = await first.invoke({
    type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: 0,
    workflow: { kind: "goal", objective: "Cross conversations", status: "rollover_required", reason: "conversation maximum length" }
  });
  assert.equal(workflow.ok, true);
  const projectId = workflow.project.id;
  const claimed = await first.invoke({
    type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId,
    expectedRevision: workflow.project.revision, ownerId: "tab-a", leaseMs: 60000
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.project.rollover.ownerId, "tab-a");
  assert.ok(claimed.leaseToken);
  const stale = await first.invoke({
    type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId,
    expectedRevision: workflow.project.revision, ownerId: "tab-b", leaseMs: 60000
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "project.conflict");

  const second = loadBackground(storage);
  const reloaded = await second.invoke({ type: "YOLO_PROJECT_GET", projectId });
  assert.equal(reloaded.project.rollover.leaseToken, claimed.leaseToken);
  const competing = await second.invoke({
    type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId,
    expectedRevision: reloaded.project.revision, ownerId: "tab-b", leaseMs: 60000
  });
  assert.equal(competing.ok, false);
  assert.equal(competing.code, "project.rollover_busy");
});

test("background persists and verifies semantic handoff under the rollover lease", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/project-handoff";
  const workflow = await invoke({
    type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: 0,
    workflow: { kind: "goal", objective: "Persist handoff", status: "rollover_required", reason: "context limit", supervisor: { lastProgressFingerprint: "checkpoint-z", lastProgressAt: 50 } }
  });
  const claimed = await invoke({
    type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: workflow.project.id,
    expectedRevision: workflow.project.revision, ownerId: "tab-a"
  });
  const generation = await invoke({
    type: "YOLO_PROJECT_HANDOFF_GENERATION_PROMPT", projectId: workflow.project.id,
    expectedRevision: claimed.project.revision
  });
  assert.equal(generation.ok, true);
  assert.match(generation.prompt, new RegExp(`Project-ID: ${workflow.project.id}`));
  const handoff = [
    `Project-ID: ${workflow.project.id}`,
    "Generation: 1",
    "Objective: Persist handoff safely.",
    "Current-State: The source conversation is exhausted.",
    "Completed: Durable project state and tombstone exist.",
    "Unresolved: Successor creation remains.",
    "Validation: Deterministic rollover tests are green.",
    "Next-Action: Create and bind the successor conversation."
  ].join("\n");
  const saved = await invoke({
    type: "YOLO_PROJECT_HANDOFF_SAVE", projectId: workflow.project.id,
    expectedRevision: claimed.project.revision, ownerId: "tab-a", leaseToken: claimed.leaseToken, text: handoff
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.project.latestHandoff.verified, false);
  assert.equal(saved.project.latestHandoff.basisCheckpointId, "checkpoint-z");
  const verificationPrompt = await invoke({
    type: "YOLO_PROJECT_HANDOFF_VERIFICATION_PROMPT", projectId: workflow.project.id,
    expectedRevision: saved.project.revision
  });
  assert.match(verificationPrompt.prompt, new RegExp(saved.fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const verificationText = `[YOLO:HANDOFF_VERIFIED:${saved.fingerprint}]`;
  const verified = await invoke({
    type: "YOLO_PROJECT_HANDOFF_VERIFY", projectId: workflow.project.id,
    expectedRevision: saved.project.revision, ownerId: "tab-a", leaseToken: claimed.leaseToken, verificationText
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.project.latestHandoff.verified, true);
  assert.equal(verified.project.rollover.stage, "handoff_ready");
  assert.equal(verified.project.rollover.handoffSource, "verified_handoff");
});

test("hard-limit rollover can persist a checkpoint fallback without another source-chat send", async () => {
  const storage = {};
  const first = loadBackground(storage);
  const pageId = "https://chatgpt.com/c/project-fallback";
  const workflow = await first.invoke({
    type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: 0,
    workflow: { kind: "goal", objective: "Use fallback", status: "rollover_required", reason: "hard context limit", supervisor: { lastProgressFingerprint: "checkpoint-hard", lastProgressAt: 100 } }
  });
  const claimed = await first.invoke({
    type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: workflow.project.id,
    expectedRevision: workflow.project.revision, ownerId: "tab-a"
  });
  const fallback = await first.invoke({
    type: "YOLO_PROJECT_ROLLOVER_FALLBACK", projectId: workflow.project.id,
    expectedRevision: claimed.project.revision, ownerId: "tab-a", leaseToken: claimed.leaseToken
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.fallback.kind, "checkpoint");
  assert.equal(fallback.project.rollover.stage, "handoff_ready");
  const second = loadBackground(storage);
  const reloaded = await second.invoke({ type: "YOLO_PROJECT_GET", projectId: workflow.project.id });
  assert.equal(reloaded.project.rollover.stage, "handoff_ready");
  assert.equal(reloaded.project.rollover.handoffSource, "checkpoint");
  assert.equal(reloaded.project.latestVerifiedCheckpoint.id, "checkpoint-hard");
});

test("project lock prevents workflow sync from overwriting a claimed rollover lease", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/project-lock-race";
  const initial = await invoke({
    type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: 0,
    workflow: { kind: "goal", objective: "Race safely", status: "rollover_required", reason: "context limit" }
  });
  const claimPromise = invoke({
    type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: initial.project.id,
    expectedRevision: initial.project.revision, ownerId: "tab-a", leaseMs: 60000
  });
  const workflowPromise = invoke({
    type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: initial.workflow.revision,
    workflow: { ...initial.workflow, reason: "context limit still visible" }
  });
  await Promise.all([claimPromise, workflowPromise]);
  const project = await invoke({ type: "YOLO_PROJECT_GET", projectId: initial.project.id });
  assert.equal(project.ok, true);
  assert.equal(project.project.rollover.ownerId, "tab-a");
  assert.ok(project.project.rollover.leaseToken);
  assert.equal(project.project.status, "rolling_over");
});

test("bootstrap transaction survives service-worker restart and binds only an observed durable successor", async () => {
  const first = loadBackground();
  const source = "https://chatgpt.com/c/bootstrap-source";
  const started = await first.invoke({
    type: "YOLO_WORKFLOW_SET", pageId: source, expectedRevision: 0,
    workflow: { kind: "goal", objective: "Migrate across chats", status: "rollover_required", reason: "context limit" }
  });
  const claimed = await first.invoke({
    type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: started.project.id,
    expectedRevision: started.project.revision, ownerId: "rollover-tab", leaseMs: 60000
  });
  const fallback = await first.invoke({
    type: "YOLO_PROJECT_ROLLOVER_FALLBACK", projectId: started.project.id,
    expectedRevision: claimed.project.revision, ownerId: "rollover-tab", leaseToken: claimed.leaseToken
  });
  const pending = await first.invoke({
    type: "YOLO_PROJECT_ROLLOVER_ADVANCE", projectId: started.project.id,
    expectedRevision: fallback.project.revision, ownerId: "rollover-tab", leaseToken: claimed.leaseToken,
    stage: "successor_pending"
  });
  const prepared = await first.invoke({
    type: "YOLO_PROJECT_BOOTSTRAP_PREPARE", projectId: started.project.id,
    expectedRevision: pending.project.revision, ownerId: "rollover-tab", leaseToken: claimed.leaseToken
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.project.rollover.bootstrapState, "prepared");

  const second = loadBackground(first.storage);
  const reloaded = await second.invoke({ type: "YOLO_PROJECT_GET", projectId: started.project.id });
  assert.equal(reloaded.project.rollover.bootstrapFingerprint, prepared.project.rollover.bootstrapFingerprint);
  const submitting = await second.invoke({
    type: "YOLO_PROJECT_BOOTSTRAP_MARK_SUBMITTING", projectId: started.project.id,
    expectedRevision: reloaded.project.revision, ownerId: "rollover-tab", leaseToken: claimed.leaseToken
  });
  const successor = "https://chatgpt.com/c/bootstrap-successor";
  const observed = await second.invoke({
    type: "YOLO_PROJECT_BOOTSTRAP_OBSERVE", projectId: started.project.id,
    expectedRevision: submitting.project.revision, ownerId: "rollover-tab", leaseToken: claimed.leaseToken,
    successorPageId: successor, observedUserText: submitting.project.rollover.bootstrapText
  });
  assert.equal(observed.ok, true);
  assert.equal(observed.project.currentConversationId, source);
  const marker = `[YOLO:BOOTSTRAP_READY:${observed.project.rollover.bootstrapToken}]`;
  const verified = await second.invoke({
    type: "YOLO_PROJECT_BOOTSTRAP_VERIFY", projectId: started.project.id,
    expectedRevision: observed.project.revision, ownerId: "rollover-tab", leaseToken: claimed.leaseToken,
    responseText: `Recovered persisted state.\n${marker}`
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.project.currentConversationId, successor);
  assert.equal(verified.project.currentGeneration, 2);
  assert.equal(verified.project.rollover.stage, "successor_bound");

  const third = loadBackground(first.storage);
  const durable = await third.invoke({ type: "YOLO_PROJECT_GET", projectId: started.project.id });
  assert.equal(durable.project.currentConversationId, successor);
  assert.equal(durable.project.conversationChain[0].successorPageId, successor);
  assert.equal(durable.project.conversationChain[0].doNotContinue, true);
});

test("rollover lease ownership follows the real browser tab across content-script navigation", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/tab-bound-rollover";
  const started = await invoke({
    type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: 0,
    workflow: { kind: "goal", objective: "Keep tab ownership", status: "rollover_required", reason: "context limit" }
  });
  const senderA = { tab: { id: 41, url: pageId } };
  const senderB = { tab: { id: 42, url: pageId } };
  const first = await invoke({ type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: started.project.id, expectedRevision: started.project.revision, ownerId: "content-a", leaseMs: 60000 }, senderA);
  assert.equal(first.ok, true);
  assert.equal(first.project.rollover.ownerId, "tab:41");
  const sameTabReload = await invoke({ type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: started.project.id, expectedRevision: first.project.revision, ownerId: "content-after-navigation", leaseMs: 60000 }, senderA);
  assert.equal(sameTabReload.ok, true);
  assert.equal(sameTabReload.leaseToken, first.leaseToken);
  const duplicateTab = await invoke({ type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: started.project.id, expectedRevision: first.project.revision, ownerId: "copied-session", leaseMs: 60000 }, senderB);
  assert.equal(duplicateTab.ok, false);
  assert.equal(duplicateTab.code, "project.rollover_busy");
});

test("background persists one New Chat opening marker under the tab-bound rollover lease", async () => {
  const { invoke } = loadBackground();
  const source = "https://chatgpt.com/c/new-chat-opening-source";
  const sender = { tab: { id: 71, url: source } };
  const started = await invoke({ type: "YOLO_WORKFLOW_SET", pageId: source, expectedRevision: 0,
    workflow: { kind: "goal", objective: "Open successor once", status: "rollover_required", reason: "context limit" } }, sender);
  const claimed = await invoke({ type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: started.project.id,
    expectedRevision: started.project.revision, ownerId: "content-a", leaseMs: 60000 }, sender);
  const fallback = await invoke({ type: "YOLO_PROJECT_ROLLOVER_FALLBACK", projectId: started.project.id,
    expectedRevision: claimed.project.revision, ownerId: "content-a", leaseToken: claimed.leaseToken }, sender);
  const pending = await invoke({ type: "YOLO_PROJECT_ROLLOVER_ADVANCE", projectId: started.project.id,
    expectedRevision: fallback.project.revision, ownerId: "content-a", leaseToken: claimed.leaseToken, stage: "successor_pending" }, sender);
  const prepared = await invoke({ type: "YOLO_PROJECT_BOOTSTRAP_PREPARE", projectId: started.project.id,
    expectedRevision: pending.project.revision, ownerId: "content-a", leaseToken: claimed.leaseToken }, sender);
  const marked = await invoke({ type: "YOLO_PROJECT_NEW_CHAT_MARK_OPENING", projectId: started.project.id,
    expectedRevision: prepared.project.revision, ownerId: "content-a", leaseToken: claimed.leaseToken }, sender);
  assert.equal(marked.ok, true);
  assert.ok(marked.project.rollover.newChatOpeningAt > 0);
  const duplicateTab = { tab: { id: 72, url: source } };
  const blocked = await invoke({ type: "YOLO_PROJECT_NEW_CHAT_MARK_OPENING", projectId: started.project.id,
    expectedRevision: marked.project.revision, ownerId: "copied", leaseToken: claimed.leaseToken }, duplicateTab);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "project.rollover_lease_lost");
});
test("tab-bound rollover lease survives source to transient New Chat to durable successor navigation", async () => {
  const { invoke } = loadBackground();
  const source = "https://chatgpt.com/c/navigation-source";
  const senderSource = { tab: { id: 81, url: source } };
  const started = await invoke({ type: "YOLO_WORKFLOW_SET", pageId: source, expectedRevision: 0,
    workflow: { kind: "goal", objective: "Navigate same tab", status: "rollover_required", reason: "context limit" } }, senderSource);
  const claimed = await invoke({ type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: started.project.id,
    expectedRevision: started.project.revision, ownerId: "source-runtime", leaseMs: 60000 }, senderSource);
  const fallback = await invoke({ type: "YOLO_PROJECT_ROLLOVER_FALLBACK", projectId: started.project.id,
    expectedRevision: claimed.project.revision, ownerId: "source-runtime", leaseToken: claimed.leaseToken }, senderSource);
  const pending = await invoke({ type: "YOLO_PROJECT_ROLLOVER_ADVANCE", projectId: started.project.id,
    expectedRevision: fallback.project.revision, ownerId: "source-runtime", leaseToken: claimed.leaseToken, stage: "successor_pending" }, senderSource);
  const prepared = await invoke({ type: "YOLO_PROJECT_BOOTSTRAP_PREPARE", projectId: started.project.id,
    expectedRevision: pending.project.revision, ownerId: "source-runtime", leaseToken: claimed.leaseToken }, senderSource);
  const opening = await invoke({ type: "YOLO_PROJECT_NEW_CHAT_MARK_OPENING", projectId: started.project.id,
    expectedRevision: prepared.project.revision, ownerId: "source-runtime", leaseToken: claimed.leaseToken }, senderSource);
  assert.equal(opening.project.rollover.ownerId, "tab:81");
  const transient = { tab: { id: 81, url: "https://chatgpt.com/" } };
  const duplicateTransient = { tab: { id: 82, url: "https://chatgpt.com/" } };
  const blockedDuplicate = await invoke({ type: "YOLO_PROJECT_BOOTSTRAP_MARK_SUBMITTING", projectId: started.project.id,
    expectedRevision: opening.project.revision, ownerId: "copied-session", leaseToken: claimed.leaseToken }, duplicateTransient);
  assert.equal(blockedDuplicate.ok, false);
  assert.equal(blockedDuplicate.code, "project.rollover_lease_lost");
  const submitting = await invoke({ type: "YOLO_PROJECT_BOOTSTRAP_MARK_SUBMITTING", projectId: started.project.id,
    expectedRevision: opening.project.revision, ownerId: "new-runtime-id", leaseToken: claimed.leaseToken }, transient);
  assert.equal(submitting.ok, true);
  assert.equal(submitting.project.rollover.ownerId, "tab:81");
  const successor = "https://chatgpt.com/c/navigation-successor";
  const senderSuccessor = { tab: { id: 81, url: successor } };
  const observed = await invoke({ type: "YOLO_PROJECT_BOOTSTRAP_OBSERVE", projectId: started.project.id,
    expectedRevision: submitting.project.revision, ownerId: "third-runtime-id", leaseToken: claimed.leaseToken,
    successorPageId: successor, observedUserText: submitting.project.rollover.bootstrapText }, senderSuccessor);
  assert.equal(observed.ok, true);
  const verified = await invoke({ type: "YOLO_PROJECT_BOOTSTRAP_VERIFY", projectId: started.project.id,
    expectedRevision: observed.project.revision, ownerId: "fourth-runtime-id", leaseToken: claimed.leaseToken,
    responseText: `[YOLO:BOOTSTRAP_READY:${observed.project.rollover.bootstrapToken}]` }, senderSuccessor);
  assert.equal(verified.ok, true);
  assert.equal(verified.project.currentConversationId, successor);
});
test("proactive rollover atomically pauses the Goal and persists one project plan", async () => {
  const first = loadBackground();
  const pageId = "https://chatgpt.com/c/proactive-atomic";
  const started = await first.invoke({ type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: 0, workflow: { kind: "goal", objective: "Move early", status: "running" } });
  const observed = { ...started.workflow, status: "running", iteration: 90, awaitingResponse: false, supervisor: { ...started.workflow.supervisor, lastProgressFingerprint: "checkpoint-proactive", lastProgressAt: 900 } };
  const planned = await first.invoke({ type: "YOLO_WORKFLOW_PROACTIVE_ROLLOVER", pageId, expectedRevision: started.workflow.revision, workflow: observed, growth: { totalMessages: 120, visibleTextChars: 210000 } });
  assert.equal(planned.ok, true);
  assert.equal(planned.workflow.status, "rollover_pending");
  assert.equal(planned.project.rollover.mode, "proactive");
  assert.equal(planned.project.rollover.stage, "required");
  const second = loadBackground(first.storage);
  const workflow = await second.invoke({ type: "YOLO_WORKFLOW_GET", pageId });
  const project = await second.invoke({ type: "YOLO_PROJECT_GET", projectId: planned.project.id });
  assert.equal(workflow.workflow.status, "rollover_pending");
  assert.equal(project.project.rollover.proactiveEvidenceMessages, 120);
});
test("proactive handoff preparation remains tab-bound and source retirement blocks further automation", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/proactive-handoff";
  const started = await invoke({ type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: 0, workflow: { kind: "goal", objective: "Prepare verified handoff", status: "running" } });
  const observed = { ...started.workflow, iteration: 100, awaitingResponse: false };
  const planned = await invoke({ type: "YOLO_WORKFLOW_PROACTIVE_ROLLOVER", pageId, expectedRevision: started.workflow.revision, workflow: observed, growth: { totalMessages: 130, visibleTextChars: 220000 } });
  const sender = { tab: { id: 91, url: pageId } };
  const claimed = await invoke({ type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: planned.project.id, expectedRevision: planned.project.revision, ownerId: "runtime-a", leaseMs: 60000 }, sender);
  const prepared = await invoke({ type: "YOLO_PROJECT_PROACTIVE_HANDOFF_GENERATION_PREPARE", projectId: planned.project.id, expectedRevision: claimed.project.revision, ownerId: "runtime-a", leaseToken: claimed.leaseToken, baselineAssistantFingerprint: "assistant-before" }, sender);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.project.rollover.ownerId, "tab:91");
  assert.equal(prepared.project.rollover.handoffAction, "generate");
  const duplicate = await invoke({ type: "YOLO_PROJECT_PROACTIVE_HANDOFF_VERIFICATION_PREPARE", projectId: planned.project.id, expectedRevision: prepared.project.revision, ownerId: "runtime-b", leaseToken: claimed.leaseToken, baselineAssistantFingerprint: "other" }, { tab: { id: 92, url: pageId } });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "project.rollover_lease_lost");
});
test("proactive source becomes permanently inert before New Chat navigation side effect", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/proactive-retire";
  const started = await invoke({ type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: 0, workflow: { kind: "goal", objective: "Retire before navigation", status: "running" } });
  const planned = await invoke({ type: "YOLO_WORKFLOW_PROACTIVE_ROLLOVER", pageId, expectedRevision: started.workflow.revision, workflow: { ...started.workflow, iteration: 100, awaitingResponse: false }, growth: { totalMessages: 130, visibleTextChars: 220000 } });
  const sender = { tab: { id: 93, url: pageId } };
  const claim = await invoke({ type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: planned.project.id, expectedRevision: planned.project.revision, ownerId: "runtime", leaseMs: 60000 }, sender);
  const fallback = await invoke({ type: "YOLO_PROJECT_ROLLOVER_FALLBACK", projectId: planned.project.id, expectedRevision: claim.project.revision, ownerId: "runtime", leaseToken: claim.leaseToken }, sender);
  const pending = await invoke({ type: "YOLO_PROJECT_ROLLOVER_ADVANCE", projectId: planned.project.id, expectedRevision: fallback.project.revision, ownerId: "runtime", leaseToken: claim.leaseToken, stage: "successor_pending" }, sender);
  const bootstrap = await invoke({ type: "YOLO_PROJECT_BOOTSTRAP_PREPARE", projectId: planned.project.id, expectedRevision: pending.project.revision, ownerId: "runtime", leaseToken: claim.leaseToken }, sender);
  const opening = await invoke({ type: "YOLO_PROJECT_NEW_CHAT_MARK_OPENING", projectId: planned.project.id, expectedRevision: bootstrap.project.revision, ownerId: "runtime", leaseToken: claim.leaseToken, finalPromptFingerprint: "handoff-final", finalAssistantFingerprint: "verified-final" }, sender);
  assert.equal(opening.ok, true);
  const blocked = await invoke({ type: "YOLO_WORKFLOW_CLAIM", pageId, ownerId: "other" }, { tab: { id: 94, url: pageId } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "project.conversation_exhausted");
});

test("project endures A to B to C to D across proactive and hard rollovers with restarts", async () => {
  let env = loadBackground();
  const pages = ["https://chatgpt.com/c/endurance-a", "https://chatgpt.com/c/endurance-b", "https://chatgpt.com/c/endurance-c", "https://chatgpt.com/c/endurance-d"];
  const objective = "Endure four conversations";
  const started = await env.invoke({ type: "YOLO_WORKFLOW_SET", pageId: pages[0], expectedRevision: 0,
    workflow: { kind: "goal", objective, status: "running", supervisor: { lastProgressFingerprint: "checkpoint-a", lastProgressAt: 10 } } });
  const projectId = started.project.id;

  async function rollover(index, mode) {
    const source = pages[index], successor = pages[index + 1], tabId = 201 + index;
    const senderSource = { tab: { id: tabId, url: source } };
    const currentWorkflow = await env.invoke({ type: "YOLO_WORKFLOW_GET", pageId: source }, senderSource);
    let planned;
    if (mode === "proactive") {
      planned = await env.invoke({ type: "YOLO_WORKFLOW_PROACTIVE_ROLLOVER", pageId: source,
        expectedRevision: currentWorkflow.workflow.revision,
        workflow: { ...currentWorkflow.workflow, iteration: 145, awaitingResponse: false },
        growth: { totalMessages: 18, visibleTextChars: 24000 } }, senderSource);
      assert.equal(planned.workflow.status, "rollover_pending");
    } else {
      planned = await env.invoke({ type: "YOLO_WORKFLOW_SET", pageId: source,
        expectedRevision: currentWorkflow.workflow.revision,
        workflow: { ...currentWorkflow.workflow, status: "rollover_required", reason: "hard context limit" } }, senderSource);
      assert.equal(planned.workflow.status, "rollover_required");
    }

    env = loadBackground(env.storage);
    let project = (await env.invoke({ type: "YOLO_PROJECT_GET", projectId })).project;
    const claimed = await env.invoke({ type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId,
      expectedRevision: project.revision, ownerId: `runtime-${index}`, leaseMs: 120000 }, senderSource);
    assert.equal(claimed.ok, true);
    project = claimed.project;
    const leaseToken = claimed.leaseToken;

    if (mode === "proactive") {
      const generated = await env.invoke({ type: "YOLO_PROJECT_PROACTIVE_HANDOFF_GENERATION_PREPARE", projectId,
        expectedRevision: project.revision, ownerId: `runtime-${index}`, leaseToken,
        baselineAssistantFingerprint: `assistant-${index}`, baselineUserFingerprint: `user-${index}` }, senderSource);
      const candidate = [`Project-ID: ${projectId}`, `Generation: ${generated.project.currentGeneration}`,
        "Objective: continue the same project", "Current-State: durable state recovered",
        `Completed: generation ${generated.project.currentGeneration} work`, "Unresolved: continue remaining objective",
        "Validation: deterministic endurance test", "Next-Action: continue in successor"].join("\n");
      const saved = await env.invoke({ type: "YOLO_PROJECT_HANDOFF_SAVE", projectId,
        expectedRevision: generated.project.revision, ownerId: `runtime-${index}`, leaseToken, text: candidate }, senderSource);
      const verificationPrep = await env.invoke({ type: "YOLO_PROJECT_PROACTIVE_HANDOFF_VERIFICATION_PREPARE", projectId,
        expectedRevision: saved.project.revision, ownerId: `runtime-${index}`, leaseToken,
        baselineAssistantFingerprint: `assistant-verify-${index}`, baselineUserFingerprint: `user-verify-${index}` }, senderSource);
      const marker = `[YOLO:HANDOFF_VERIFIED:${verificationPrep.project.latestHandoff.fingerprint}]`;
      const verified = await env.invoke({ type: "YOLO_PROJECT_HANDOFF_VERIFY", projectId,
        expectedRevision: verificationPrep.project.revision, ownerId: `runtime-${index}`, leaseToken,
        verificationText: `Verified against durable state.\n${marker}` }, senderSource);
      assert.equal(verified.ok, true);
      project = verified.project;
    } else {
      const fallback = await env.invoke({ type: "YOLO_PROJECT_ROLLOVER_FALLBACK", projectId,
        expectedRevision: project.revision, ownerId: `runtime-${index}`, leaseToken }, senderSource);
      assert.equal(fallback.ok, true);
      project = fallback.project;
    }

    const pending = await env.invoke({ type: "YOLO_PROJECT_ROLLOVER_ADVANCE", projectId,
      expectedRevision: project.revision, ownerId: `runtime-${index}`, leaseToken, stage: "successor_pending" }, senderSource);
    const bootstrap = await env.invoke({ type: "YOLO_PROJECT_BOOTSTRAP_PREPARE", projectId,
      expectedRevision: pending.project.revision, ownerId: `runtime-${index}`, leaseToken }, senderSource);
    const opening = await env.invoke({ type: "YOLO_PROJECT_NEW_CHAT_MARK_OPENING", projectId,
      expectedRevision: bootstrap.project.revision, ownerId: `runtime-${index}`, leaseToken }, senderSource);
    assert.equal(opening.ok, true);

    env = loadBackground(env.storage);
    project = (await env.invoke({ type: "YOLO_PROJECT_GET", projectId })).project;
    const transient = { tab: { id: tabId, url: "https://chatgpt.com/" } };
    const submitting = await env.invoke({ type: "YOLO_PROJECT_BOOTSTRAP_MARK_SUBMITTING", projectId,
      expectedRevision: project.revision, ownerId: `runtime-${index}-transient`, leaseToken }, transient);
    assert.equal(submitting.ok, true);
    const senderSuccessor = { tab: { id: tabId, url: successor } };
    const observed = await env.invoke({ type: "YOLO_PROJECT_BOOTSTRAP_OBSERVE", projectId,
      expectedRevision: submitting.project.revision, ownerId: `runtime-${index}-successor`, leaseToken,
      successorPageId: successor, observedUserText: submitting.project.rollover.bootstrapText }, senderSuccessor);
    assert.equal(observed.ok, true);
    const bootstrapMarker = `[YOLO:BOOTSTRAP_READY:${observed.project.rollover.bootstrapToken}]`;
    const verified = await env.invoke({ type: "YOLO_PROJECT_BOOTSTRAP_VERIFY", projectId,
      expectedRevision: observed.project.revision, ownerId: `runtime-${index}-verify`, leaseToken,
      responseText: `Recovered generation ${index + 2}.\n${bootstrapMarker}` }, senderSuccessor);
    assert.equal(verified.ok, true);

    env = loadBackground(env.storage);
    project = (await env.invoke({ type: "YOLO_PROJECT_GET", projectId })).project;
    const resuming = await env.invoke({ type: "YOLO_PROJECT_ROLLOVER_ADVANCE", projectId,
      expectedRevision: project.revision, ownerId: `runtime-${index}-resume`, leaseToken, stage: "resuming" }, senderSuccessor);
    assert.equal(resuming.ok, true);
    const successorWorkflow = await env.invoke({ type: "YOLO_WORKFLOW_GET", pageId: successor }, senderSuccessor);

    const resumedWorkflow = await env.invoke({ type: "YOLO_WORKFLOW_SET", pageId: successor,
      expectedRevision: successorWorkflow.workflow.revision,
      workflow: { kind: "goal", objective, projectId, status: "running",
        supervisor: resuming.project.supervisor } }, senderSuccessor);
    assert.equal(resumedWorkflow.ok, true);
    project = (await env.invoke({ type: "YOLO_PROJECT_GET", projectId })).project;
    const completed = await env.invoke({ type: "YOLO_PROJECT_ROLLOVER_ADVANCE", projectId,
      expectedRevision: project.revision, ownerId: `runtime-${index}-complete`, leaseToken, stage: "complete" }, senderSuccessor);
    assert.equal(completed.ok, true);
    assert.equal(completed.project.currentConversationId, successor);
    assert.equal(completed.project.currentGeneration, index + 2);
    return completed.project;
  }

  await rollover(0, "proactive");
  await rollover(1, "hard");
  const final = await rollover(2, "proactive");
  assert.equal(final.currentConversationId, pages[3]);
  assert.equal(final.currentGeneration, 4);
  assert.equal(final.conversationChain.length, 4);
  assert.deepEqual(Array.from(final.conversationChain, (entry) => entry.pageId), pages);
  assert.deepEqual(Array.from(final.conversationChain, (entry) => entry.generation), [1, 2, 3, 4]);
  assert.equal(final.conversationChain[0].doNotContinue, true);
  assert.equal(final.conversationChain[1].doNotContinue, true);
  assert.equal(final.conversationChain[2].doNotContinue, true);
  assert.equal(final.conversationChain[3].doNotContinue, false);
  assert.equal(final.conversationChain[0].successorPageId, pages[1]);
  assert.equal(final.conversationChain[1].successorPageId, pages[2]);
  assert.equal(final.conversationChain[2].successorPageId, pages[3]);
  assert.equal(final.status, "active");
});

test("proactive ownership loss aborts project and pauses Goal atomically across restart", async () => {
  const first = loadBackground();
  const pageId = "https://chatgpt.com/c/proactive-abort";
  const sender = { tab: { id: 101, url: pageId } };
  const started = await first.invoke({ type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: 0, workflow: { kind: "goal", objective: "Recover aborted rollover", status: "running" } }, sender);
  const observed = { ...started.workflow, iteration: 150, awaitingResponse: false };
  const planned = await first.invoke({ type: "YOLO_WORKFLOW_PROACTIVE_ROLLOVER", pageId, expectedRevision: started.workflow.revision, workflow: observed, growth: { totalMessages: 1, visibleTextChars: 1 } }, sender);
  const claim = await first.invoke({ type: "YOLO_PROJECT_ROLLOVER_CLAIM", projectId: planned.project.id, expectedRevision: planned.project.revision, ownerId: "runtime", leaseMs: 60000 }, sender);
  const prepared = await first.invoke({ type: "YOLO_PROJECT_PROACTIVE_HANDOFF_GENERATION_PREPARE", projectId: planned.project.id, expectedRevision: claim.project.revision, ownerId: "runtime", leaseToken: claim.leaseToken, baselineAssistantFingerprint: "before", baselineUserFingerprint: "owned" }, sender);
  const aborted = await first.invoke({ type: "YOLO_WORKFLOW_PROACTIVE_ABORT", pageId, projectId: planned.project.id, expectedRevision: planned.workflow.revision, expectedProjectRevision: prepared.project.revision, ownerId: "runtime", leaseToken: claim.leaseToken, reason: "conversation ownership changed" }, sender);
  assert.equal(aborted.ok, true);
  assert.equal(aborted.workflow.status, "paused");
  assert.equal(aborted.project.status, "active");
  assert.equal(aborted.project.rollover.stage, "failed");
  assert.equal(aborted.project.rollover.leaseToken, "");
  assert.equal(aborted.project.conversationChain[0].doNotContinue, false);
  const second = loadBackground(first.storage);
  const workflow = await second.invoke({ type: "YOLO_WORKFLOW_GET", pageId }, sender);
  const project = await second.invoke({ type: "YOLO_PROJECT_GET", projectId: planned.project.id }, sender);
  assert.equal(workflow.workflow.status, "paused");
  assert.equal(project.project.status, "active");
  assert.equal(project.project.rollover.proactiveAttempts, 1);
  const resumed = await second.invoke({ type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: workflow.workflow.revision, workflow: { ...workflow.workflow, status: "running", reason: "user resumed" } }, sender);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.workflow.status, "running");
});