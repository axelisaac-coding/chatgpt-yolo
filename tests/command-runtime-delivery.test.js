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

test("rollover project identity survives same-tab New Chat navigation", () => {
  assert.match(source, /ROLLOVER_SESSION_KEY = "yoloRolloverProjectV1"/);
  assert.match(source, /rolloverProjectId: loadRolloverProjectId\(\)/);
  const handler = source.slice(source.indexOf("async function handleRollover"), source.indexOf("async function handleWorkflow"));
  assert.match(handler, /state\.rolloverProjectId \|\| \(workflow\.kind === "goal" \? workflow\.projectId : ""\)/);
  assert.match(handler, /state\.rolloverProjectId = saveRolloverProjectId\(project\.id\)/);
});

test("New Chat navigation intent is persisted before the UI click", () => {
  const handler = source.slice(source.indexOf("async function handleRollover"), source.indexOf("async function handleWorkflow"));
  const mark = handler.indexOf("await markNewChatOpening(project, leaseToken)");
  const click = handler.indexOf("control.click()");
  assert.ok(mark >= 0 && click > mark);
  assert.match(handler, /newChatOpeningAt > NEW_CHAT_CONFIRM_TIMEOUT_MS|now\(\) - project\.rollover\.newChatOpeningAt > NEW_CHAT_CONFIRM_TIMEOUT_MS/);
});

test("bootstrap submission intent is durable before composer mutation and send", () => {
  const submit = source.slice(source.indexOf("async function submitBootstrap"), source.indexOf("async function resumeSuccessorGoal"));
  const mark = submit.indexOf("await markBootstrapSubmitting(project, leaseToken)");
  const write = submit.indexOf("Platforms.setComposerValue(target, text)");
  const send = submit.indexOf("Platforms.submitComposer(adapter(), target, document)");
  assert.ok(mark >= 0 && write > mark && send > write);
  assert.match(submit, /cancelBootstrapSubmitting/);
  assert.match(submit, /persistBootstrapUnknown/);
});
test("successor receipt and bootstrap marker are verified before normal Goal resumption", () => {
  const handler = source.slice(source.indexOf("async function handleRollover"), source.indexOf("async function handleWorkflow"));
  const observed = handler.indexOf("await observeBootstrap(project, leaseToken, state.pageId, observedText)");
  const verified = handler.indexOf("await verifyBootstrap(project, leaseToken, responseText)");
  const resumed = handler.indexOf("return resumeSuccessorGoal(project, leaseToken)");
  assert.ok(observed >= 0 && verified > observed && resumed > verified);
  assert.match(handler, /currentIsDurableSuccessor\(project\)/);
  assert.match(handler, /bootstrap_receipt_mismatch/);
});

test("successor Goal queue commits before rollover completion releases the lease", () => {
  const resume = source.slice(source.indexOf("async function resumeSuccessorGoal"), source.indexOf("async function handleRollover"));
  const resuming = resume.indexOf('advanceProjectRollover(project, leaseToken, "resuming")');
  const queued = resume.indexOf("await queuePrompt(prompt, { workflow: next, source: \"workflow:goal\" })");
  const reread = resume.indexOf("project = await readProject(project.id)");
  const completed = resume.indexOf('advanceProjectRollover(project, leaseToken, "complete")');
  assert.ok(resuming >= 0 && queued > resuming && reread > queued && completed > reread);
  assert.match(resume, /projectId: project\.id/);
  assert.match(resume, /supervisor: project\.supervisor/);
  assert.match(resume, /Commands\.workflowPrompt\(next, "continue"\)/);
});

test("ambiguous bootstrap delivery never triggers an automatic resend", () => {
  const handler = source.slice(source.indexOf("async function handleRollover"), source.indexOf("async function handleWorkflow"));
  const unknown = handler.indexOf("persistBootstrapUnknown");
  assert.ok(unknown >= 0);
  const afterUnknown = handler.slice(unknown, handler.indexOf("bootstrapState === \"observed\""));
  assert.doesNotMatch(afterUnknown, /submitBootstrap\(/);
  const helper = source.slice(source.indexOf("async function persistBootstrapUnknown"), source.indexOf("async function observeBootstrap"));
  assert.ok(helper.indexOf("await markBootstrapUnknown") < helper.indexOf("clearRolloverSession()"));
  assert.match(helper, /if \(!unknown\?\.ok\) return false/);
});
test("bootstrap refuses stale or non-empty destinations before persistence or submission", () => {
  const submit = source.slice(source.indexOf("async function submitBootstrap"), source.indexOf("async function resumeSuccessorGoal"));
  const history = submit.indexOf("Platforms.latestUserText(adapter()) || Platforms.latestAssistantText(adapter())");
  const mark = submit.indexOf("await markBootstrapSubmitting(project, leaseToken)");
  assert.ok(history >= 0 && mark > history);
  assert.match(submit, /destination_not_fresh/);
  const handler = source.slice(source.indexOf("async function handleRollover"), source.indexOf("async function handleWorkflow"));
  assert.match(handler, /newChatOpeningAt > BOOTSTRAP_CONFIRM_TIMEOUT_MS|now\(\) - project\.rollover\.newChatOpeningAt > BOOTSTRAP_CONFIRM_TIMEOUT_MS/);
  assert.match(handler, /new_chat_stale/);
});