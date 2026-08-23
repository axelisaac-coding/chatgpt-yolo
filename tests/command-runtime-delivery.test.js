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

test("manual Goal interruption is durable, stop-safe, and resumes through the atomic queue", () => {
  const helper = source.slice(source.indexOf("async function handleManualGoalInterruption"), source.indexOf("async function handleWorkflow"));
  assert.match(helper, /manualInterruptionPending = true/);
  assert.match(helper, /manualInterruptionSawGeneration = true/);
  assert.match(helper, /Lifecycle\.responseStableMs\("continue"\)/);
  assert.match(helper, /Commands\.workflowPrompt\(current, "continue"\)/);
  assert.match(helper, /queuePrompt\(prompt, \{ workflow: current, source: "workflow:goal" \}\)/);
  assert.doesNotMatch(helper, /state\.workflow = (next|current)/);

  const handler = source.slice(source.indexOf("async function handleWorkflow"), source.indexOf("async function tick"));
  const stop = handler.indexOf("Platforms.workflowStopState");
  const interruption = handler.indexOf("handleManualGoalInterruption");
  const generation = handler.indexOf("if (apiState.generating)");
  assert.ok(stop >= 0 && interruption > stop && generation > interruption);

  const queue = source.slice(source.indexOf("async function queuePrompt"), source.indexOf("async function cancelPendingWorkflowPrompt"));
  assert.match(queue, /next\.manualInterruptionPending = false/);
  assert.match(queue, /next\.manualInterruptionUserFingerprint = ""/);
  assert.match(queue, /next\.manualInterruptionAt = 0/);
  assert.match(queue, /next\.manualInterruptionSawGeneration = false/);
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

test("manual Goal interruption queues a fresh workflow-owned continuation instead of pausing", () => {
  const response = source.slice(source.indexOf("async function processResponse"), source.indexOf("async function handlePendingWorkflowItem"));
  const start = response.indexOf('decision.action === "interrupted"');
  const end = response.indexOf('decision.action === "recover"', start);
  const branch = response.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(branch, /Commands\.workflowPrompt\(state\.workflow, "continue"\)/);
  assert.match(branch, /command\.workflow\.interruption_queue_failed/);
  assert.match(branch, /await record\(decision\.reason, "info", decision\.code\)/);
});
test("recovery and verification transitions are durably recorded after queue commit", () => {
  const response = source.slice(source.indexOf("async function processResponse"), source.indexOf("async function handlePendingWorkflowItem"));
  const records = response.match(/else await record\(decision\.reason, "info", decision\.code\)/g) || [];
  assert.equal(records.length, 3);
  assert.ok(response.indexOf('decision.action === "verify"') < response.indexOf('else await record(decision.reason, "info", decision.code)'));
  assert.ok(response.indexOf('decision.action === "recover"') < response.lastIndexOf('else await record(decision.reason, "info", decision.code)'));
  assert.match(response, /supervisor\.verify\.queue_failed/);
  assert.match(response, /supervisor\.recover\.queue_failed/);
});
test("hard conversation limit preempts a paused Goal before ordinary workflow handling", () => {
  const helper = source.slice(source.indexOf("async function handleConversationLimitBeforeWorkflow"), source.indexOf("async function handleWorkflow"));
  assert.match(helper, /Platforms\.conversationLimitState\(adapter\(\), document\)/);
  assert.match(helper, /markWorkflow\("rollover_required", stopState\.reason, stopState\.code\)/);
  assert.match(helper, /await handleRollover\(\)/);
  const tick = source.slice(source.indexOf("async function tick"), source.indexOf("function scheduleTick"));
  const hard = tick.indexOf("await handleConversationLimitBeforeWorkflow()");
  const rollover = tick.indexOf("await handleRollover()");
  const workflow = tick.indexOf("await handleWorkflow()");
  assert.ok(hard >= 0 && rollover > hard && workflow > rollover);
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

test("New Chat click exceptions preserve the released durable rollover for recovery", () => {
  const handler = source.slice(source.indexOf("async function handleRollover"), source.indexOf("async function handleWorkflow"));
  const released = handler.indexOf("await releaseProjectRollover(project, leaseToken)");
  const clicked = handler.indexOf("control.click()", released);
  const uncertain = handler.indexOf("supervisor.rollover.new_chat_click_uncertain", clicked);
  const sourceTimeout = handler.indexOf("if (state.pageId === project.rollover.sourcePageId)", clicked);
  assert.ok(released >= 0 && clicked > released && uncertain > clicked && sourceTimeout > uncertain);
  assert.doesNotMatch(handler.slice(clicked, sourceTimeout), /failProjectRollover\(/);
  assert.match(handler.slice(sourceTimeout), /supervisor\.rollover\.new_chat_not_observed/);
});
test("bootstrap draft waits for a real Send control before durable submission intent", () => {
  const submit = source.slice(source.indexOf("async function submitBootstrap"), source.indexOf("async function resumeSuccessorGoal"));
  const write = submit.indexOf("Platforms.setComposerValue(target, text)");
  const waitForSend = submit.indexOf("Platforms.findSendButton(adapter(), target, document)", write);
  const mark = submit.indexOf("await markBootstrapSubmitting(project, leaseToken)", waitForSend);
  const click = submit.indexOf("sendButton.click()", mark);
  assert.ok(write >= 0 && waitForSend > write && mark > waitForSend && click > mark);
  assert.match(submit, /bootstrap_staged/);
  assert.match(submit, /bootstrap_send_wait/);
  assert.match(submit, /Commands\.fingerprint\(currentText\) !== expectedFingerprint/);
  assert.doesNotMatch(submit, /Platforms\.submitComposer\(/);
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

test("proactive rollover is planned before the next Goal continuation prompt", () => {
  const process = source.slice(source.indexOf("async function processResponse"), source.indexOf("async function handlePendingWorkflowItem"));
  const growth = process.indexOf("Platforms.conversationGrowthSnapshot(adapter(), document)");
  const plan = process.indexOf("await planProactiveWorkflow(state.workflow, growth)");
  const rollover = process.indexOf("await handleRollover()");
  const continuation = process.indexOf('Commands.workflowPrompt(state.workflow, "continue")', rollover);
  assert.ok(growth >= 0 && plan > growth && rollover > plan && continuation > rollover);
});

test("proactive handoff delivery is ownership-checked and deduplicated", () => {
  const handler = source.slice(source.indexOf("async function proactiveProjectPromptResult"), source.indexOf("async function submitBootstrap"));
  const user = handler.indexOf("const userFingerprint = latestUserFingerprint()");
  const ownership = handler.indexOf("handoffBaselineUserFingerprint");
  const dedupe = handler.indexOf('const dedupeKey = ["project-handoff"');
  const queue = handler.indexOf('await queuePrompt(prompt, { source: "project:handoff", dedupeKey })');
  assert.ok(user >= 0 && ownership > user && dedupe > ownership && queue > dedupe);
});


test("hard exhaustion preempts proactive source-chat handoff prompts", () => {
  const handler = source.slice(source.indexOf("async function handleRollover"), source.indexOf("async function handleWorkflow"));
  const stop = handler.indexOf("Platforms.workflowStopState(adapter(), apiState.settings || {}, document)");
  const hard = handler.indexOf('stopState?.status === "rollover_required"');
  const convert = handler.indexOf("await markWorkflow(stopState.status, stopState.reason, stopState.code)");
  const proactive = handler.indexOf("await progressProactiveHandoff(project, leaseToken)");
  assert.ok(stop >= 0 && hard > stop && convert > hard && proactive > convert);
});

test("rollover-pending runtime stays active for hidden polling and refresh protection", () => {
  const health = source.slice(source.indexOf("function getHealth"), source.indexOf("function schedulePoll"));
  assert.match(health, /\["running", "rollover_pending"\]\.includes\(workflow\.status\)/);
});

test("proactive ownership loss uses atomic abort instead of stranding rollover_pending", () => {
  const helper = source.slice(source.indexOf("async function abortProactiveWorkflow"), source.indexOf("async function mutateProject"));
  assert.match(helper, /YOLO_WORKFLOW_PROACTIVE_ABORT/);
  assert.match(helper, /expectedRevision: state\.workflow\.revision/);
  assert.match(helper, /expectedProjectRevision: project\.revision/);
  assert.ok(helper.indexOf("applyWorkflowResponse") < helper.indexOf("clearRolloverSession()"));
  const progress = source.slice(source.indexOf("async function progressProactiveHandoff"), source.indexOf("async function handleRollover"));
  const lost = progress.indexOf('result.kind === "ownership_lost"');
  const abort = progress.indexOf("await abortProactiveWorkflow(project, leaseToken", lost);
  assert.ok(lost >= 0 && abort > lost);
  assert.doesNotMatch(progress.slice(lost, abort + 200), /failProjectRollover/);
});
test("proactive handoff queue failure falls back to durable evidence", () => {
  const progress = source.slice(source.indexOf("async function progressProactiveHandoff"), source.indexOf("async function handleRollover"));
  const failed = progress.indexOf('result.kind === "queue_failed"');
  const fallback = progress.indexOf("await fallbackProjectRollover(project, leaseToken)", failed);
  const abort = progress.indexOf("await abortProactiveWorkflow", failed);
  assert.ok(failed >= 0 && fallback > failed);
  assert.ok(abort === -1 || fallback < abort);
  assert.match(progress, /continuing from verified durable fallback/);
});

test("New Chat rollover survives SPA history lag and a tab boundary", () => {
  const submit = source.slice(source.indexOf("async function submitBootstrap"), source.indexOf("async function resumeSuccessorGoal"));
  assert.match(submit, /!Config\.isDurablePageId\(state\.pageId\)/);
  assert.match(submit, /supervisor\.rollover\.destination_transition/);
  assert.match(submit, /supervisor\.rollover\.destination_not_fresh/);
  const handler = source.slice(source.indexOf("async function handleRollover"), source.indexOf("async function handleWorkflow"));
  assert.match(handler, /await recoverPendingRolloverProject\(\)/);
  assert.match(handler, /await releaseProjectRollover\(project, leaseToken\)/);
  assert.match(handler, /state\.pageId === project\.rollover\?\.sourcePageId[\s\S]*bootstrap_pending[\s\S]*NEW_CHAT_CONFIRM_TIMEOUT_MS/);
  const recover = source.slice(source.indexOf("async function recoverPendingRolloverProject"), source.indexOf("async function claimProjectRollover"));
  assert.match(recover, /YOLO_PROJECT_RECOVER_PENDING/);
  assert.match(recover, /saveRolloverProjectId\(response\.project\.id\)/);
});
test("failed hard rollover safely recovers before reacquiring a lease", () => {
  const helper = source.slice(source.indexOf("async function retryFailedHardRollover"), source.indexOf("async function fallbackProjectRollover"));
  assert.match(helper, /YOLO_PROJECT_FAILED_ROLLOVER_RETRY/);
  assert.match(helper, /expectedRevision: project\.revision/);
  const handler = source.slice(source.indexOf("async function handleRollover"), source.indexOf("async function handleWorkflow"));
  const deliveryUnknown = handler.indexOf('bootstrapState === "delivery_unknown"');
  const failed = handler.indexOf('project.rollover?.stage === "failed"');
  const hard = handler.indexOf('project.rollover.mode === "hard"', failed);
  const status = handler.indexOf('workflow.status === "rollover_required"', hard);
  const sourceGuard = handler.indexOf('state.pageId === project.rollover.sourcePageId', status);
  const retry = handler.indexOf('await retryFailedHardRollover(project)', sourceGuard);
  const claim = handler.indexOf('const claimed = await claimProjectRollover(project)', retry);
  assert.ok(deliveryUnknown >= 0 && failed > deliveryUnknown && hard > failed && status > hard && sourceGuard > status && retry > sourceGuard && claim > retry);
  assert.match(handler.slice(retry, claim), /project\.rollover_recovery_cooldown/);
  assert.match(handler.slice(retry, claim), /supervisor\.rollover\.hard_recovery/);
});
