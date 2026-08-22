const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "command-runtime.js"), "utf8");

test("workflow sends refresh the background-owned atomic transition", () => {
  assert.match(source, /if \(workflow && sent && state\.pageId === pageId\) await refreshWorkflow\(pageId\)/);
  assert.doesNotMatch(source, /if \(workflow && sent[\s\S]{0,500}next\.pendingItemId = ""/);
});

test("failed workflow prompts are removed before the workflow blocks", () => {
  const failedBranch = source.slice(
    source.indexOf('if (item?.state === "failed")'),
    source.indexOf("if (item) {", source.indexOf('if (item?.state === "failed")'))
  );
  assert.match(failedBranch, /await removeQueueItem\(item\.id\)/);
  assert.match(failedBranch, /await markWorkflow\("blocked"/);
});

test("pending workflow recovery reads authoritative state before history fallback", () => {
  const pendingHandler = source.slice(
    source.indexOf("async function handlePendingWorkflowItem"),
    source.indexOf("async function handleWorkflow", source.indexOf("async function handlePendingWorkflowItem"))
  );
  assert.match(pendingHandler, /const refreshed = await refreshWorkflow\(\)/);
  assert.match(pendingHandler, /if \(refreshed\.awaitingResponse \|\| !refreshed\.pendingItemId\) return false/);
  assert.match(pendingHandler, /completedExactly/);
});

test("resuming a verification-pending workflow preserves verification phase", () => {
  const resume = source.slice(source.indexOf("async function resumeWorkflow"), source.indexOf("async function showStatus"));
  assert.match(resume, /verificationPending \? "verification"/);
  assert.match(resume, /next\.iteration === 0 \? "initial" : "continue"/);
  for (const status of ["paused", "stalled", "rate_limited", "human_required", "blocked"]) {
    assert.match(resume, new RegExp(`"${status}"`));
  }
});

test("provider and human stop surfaces preempt generation and response recovery", () => {
  const handler = source.slice(source.indexOf("async function handleWorkflow"), source.indexOf("async function tick"));
  const stop = handler.indexOf("Platforms.workflowStopState");
  const generation = handler.indexOf("if (apiState.generating)");
  const settle = handler.indexOf("Lifecycle.responseStableMs(outcome)");
  const process = handler.indexOf("return processResponse()");
  assert.ok(stop >= 0 && generation > stop && settle > generation && process > settle);
  assert.match(handler, /await markWorkflow\(stopState\.status, stopState\.reason, stopState\.code\)/);
});

test("recovery and verification transitions are durably recorded after queue commit", () => {
  const response = source.slice(source.indexOf("async function processResponse"), source.indexOf("async function handlePendingWorkflowItem"));
  const records = response.match(/else await record\(decision\.reason, "info", decision\.code\)/g) || [];
  assert.equal(records.length, 2);
  assert.ok(response.indexOf('decision.action === "verify"') < response.indexOf('else await record(decision.reason, "info", decision.code)'));
  assert.ok(response.indexOf('decision.action === "recover"') < response.lastIndexOf('else await record(decision.reason, "info", decision.code)'));
  assert.match(response, /supervisor\.verify\.queue_failed/);
  assert.match(response, /supervisor\.recover\.queue_failed/);
});
test("context-limit stop immediately drives durable rollover fallback", () => {
  const handler = source.slice(source.indexOf("async function handleWorkflow"), source.indexOf("async function tick"));
  assert.match(handler, /const marked = await markWorkflow\(stopState\.status, stopState\.reason, stopState\.code\)/);
  assert.match(handler, /marked && stopState\.status === "rollover_required"/);
  assert.match(handler, /await handleRollover\(\)/);
});

test("restart tick resumes an incomplete rollover before ordinary workflow handling", () => {
  const tick = source.slice(source.indexOf("async function tick"), source.indexOf("function scheduleTick"));
  const rollover = tick.indexOf("await handleRollover()");
  const workflow = tick.indexOf("await handleWorkflow()");
  assert.ok(rollover >= 0 && workflow > rollover);
});
