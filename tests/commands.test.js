const test = require("node:test");
const assert = require("node:assert/strict");
const Commands = require("../commands.js");

test("filters and parses the truthful slash-action catalog", () => {
  assert.equal(Commands.filterCommands("rev")[0].name, "review");
  assert.equal(Commands.parseInvocation("/goal ship the extension").command.name, "goal");
  assert.equal(Commands.parseInvocation("/goal ship the extension").args, "ship the extension");
  assert.equal(Commands.parseInvocation("hello"), null);
  assert.equal(Commands.parseInvocation("/unknown"), null);
  assert.equal(Commands.parseInvocation("/compact"), null);
  assert.equal(Commands.parseInvocation("/queue"), null);
  assert.equal(Commands.parseInvocation("/clear"), null);

  assert.deepEqual(Commands.COMMANDS.map(({ name, kind }) => [name, kind]), [
    ["goal", "workflow"], ["loop", "workflow"],
    ["plan", "prompt"], ["review", "prompt"], ["fix", "prompt"], ["handoff", "prompt"], ["continue", "prompt"],
    ["status", "control"], ["pause", "control"], ["resume", "control"], ["stop", "control"], ["settings", "control"], ["help", "control"]
  ]);
});

test("parses bounded loop iteration counts", () => {
  assert.deepEqual(Commands.parseLoopArgs("7 review and fix"), {
    objective: "review and fix",
    maxIterations: 7
  });
  assert.equal(Commands.parseLoopArgs("99 finish it").maxIterations, Commands.MAX_ITERATIONS);
  assert.equal(Commands.parseLoopArgs("0 finish it").maxIterations, 1);
  assert.equal(Commands.parseLoopArgs("finish it").maxIterations, Commands.DEFAULT_MAX_ITERATIONS);
});

test("creates normalized persistent goal and loop workflows", () => {
  const goal = Commands.startWorkflow("goal", "Ship production", { at: 1000, baselineFingerprint: "old" });
  assert.equal(goal.ok, true);
  assert.equal(goal.workflow.kind, "goal");
  assert.equal(goal.workflow.status, "running");
  assert.equal(goal.workflow.lastAssistantFingerprint, "old");
  assert.equal(goal.workflow.maxIterations, Commands.GOAL_MAX_ITERATIONS);
  assert.equal(goal.workflow.revision, 0);
  assert.match(Commands.workflowPrompt(goal.workflow, "initial"), /\[YOLO:CONTINUE\]/);

  const loop = Commands.startWorkflow("loop", "4 review again", { at: 1000 });
  assert.equal(loop.workflow.maxIterations, 4);
  assert.equal(loop.workflow.objective, "review again");
  assert.match(Commands.workflowPrompt(loop.workflow, "continue"), /Iteration 1 of 4/);
});

test("workflow response markers are unique, terminal, and case-insensitive", () => {
  assert.equal(Commands.evaluateResponse("done\n[YOLO:DONE]"), "done");
  assert.equal(Commands.evaluateResponse("  [yolo:blocked]  "), "blocked");
  assert.equal(Commands.evaluateResponse("[YOLO:DONE]\nbut actually keep going"), "malformed");
  assert.equal(Commands.evaluateResponse("inline [YOLO:DONE]"), "missing");
  assert.equal(Commands.evaluateResponse("prefix\n[YOLO:DONE]"), "done");
  assert.equal(Commands.evaluateResponse("work\n[YOLO:BLOCKED]\nmore\n[YOLO:DONE]"), "malformed");
  assert.equal(Commands.evaluateResponse("no marker"), "missing");
});

test("one-shot commands build concrete prompts", () => {
  assert.match(Commands.oneShotPrompt("plan", "ship it"), /Plan this objective/);
  assert.match(Commands.oneShotPrompt("review", "security"), /adversarial/i);
  assert.match(Commands.oneShotPrompt("fix"), /repair/i);
  assert.match(Commands.oneShotPrompt("handoff", "release state"), /Handoff focus: release state/);
  assert.match(Commands.oneShotPrompt("handoff"), /do not claim that ChatGPT context was compacted/i);
  assert.match(Commands.oneShotPrompt("continue", "fix the tests"), /Continue with this direction: fix the tests/);
  assert.equal(Commands.oneShotPrompt("compact"), "");
  assert.equal(Commands.oneShotPrompt("plan", ""), "");
});

test("workflow normalization fails closed for malformed state", () => {
  assert.equal(Commands.normalizeWorkflow({ kind: "goal", objective: "", status: "running" }).status, "idle");
  const paused = Commands.setWorkflowStatus(Commands.startWorkflow("goal", "test").workflow, "paused", "manual");
  assert.equal(paused.status, "paused");
  assert.equal(paused.pendingItemId, "");
  assert.equal(paused.reason, "manual");
});

test("fingerprints are stable and content-sensitive", () => {
  assert.equal(Commands.fingerprint("hello   world"), Commands.fingerprint("hello world"));
  assert.notEqual(Commands.fingerprint("hello"), Commands.fingerprint("world"));
});

test("workflow revisions and runner leases normalize safely", () => {
  const workflow = Commands.normalizeWorkflow({
    revision: 7,
    kind: "goal",
    objective: "ship",
    status: "running",
    runnerId: "tab-a",
    runnerExpiresAt: 5000,
    promptFingerprint: "prompt"
  }, 1000);
  assert.equal(workflow.revision, 7);
  assert.equal(workflow.runnerId, "tab-a");
  assert.equal(workflow.promptFingerprint, "prompt");

  const paused = Commands.setWorkflowStatus(workflow, "paused", "manual", 2000);
  assert.equal(paused.runnerId, "");
  assert.equal(paused.runnerExpiresAt, 0);
});

test("workflow response decisions enforce ownership, markers, and caps", () => {
  const base = Commands.normalizeWorkflow({
    kind: "loop",
    objective: "ship",
    status: "running",
    maxIterations: 2,
    iteration: 0,
    awaitingResponse: true,
    promptFingerprint: "owned"
  }, 1000);

  assert.equal(Commands.decideWorkflowResponse(base, "work\n[YOLO:CONTINUE]", {
    userFingerprint: "manual",
    at: 1100
  }).action, "paused");

  const continued = Commands.decideWorkflowResponse(base, "work\n[YOLO:CONTINUE]", {
    userFingerprint: "owned",
    at: 1100
  });
  assert.equal(continued.action, "continue");
  assert.equal(continued.workflow.iteration, 1);

  const capped = Commands.decideWorkflowResponse({ ...continued.workflow, awaitingResponse: true }, "more\n[YOLO:CONTINUE]", {
    userFingerprint: "owned",
    at: 1200
  });
  assert.equal(capped.action, "paused");
  assert.match(capped.reason, /safety cap/);

  const done = Commands.decideWorkflowResponse(base, "complete\n[YOLO:DONE]", {
    userFingerprint: "owned",
    at: 1300
  });
  assert.equal(done.action, "completed");
});

test("awaiting workflows retain and clear response stability candidates safely", () => {
  const waiting = Commands.normalizeWorkflow({
    kind: "loop",
    objective: "iterate",
    status: "running",
    awaitingResponse: true,
    responseCandidateFingerprint: "candidate",
    responseCandidateSince: 1234
  }, 2000);
  assert.equal(waiting.responseCandidateFingerprint, "candidate");
  assert.equal(waiting.responseCandidateSince, 1234);

  const paused = Commands.setWorkflowStatus(waiting, "paused", "manual", 3000);
  assert.equal(paused.responseCandidateFingerprint, "");
  assert.equal(paused.responseCandidateSince, 0);
});

test("missing terminal markers recover persistent goals but still pause bounded loops", () => {
  const goal = Commands.normalizeWorkflow({
    kind: "goal",
    objective: "ship",
    status: "running",
    awaitingResponse: true,
    promptFingerprint: "owned"
  }, 1000);
  const goalDecision = Commands.decideWorkflowResponse(goal, "work without a terminal marker", {
    userFingerprint: "owned",
    at: 1100
  });
  assert.equal(goalDecision.action, "recover");
  assert.equal(goalDecision.code, "supervisor.recover.marker_missing");
  assert.equal(goalDecision.workflow.supervisor.recoveryAttempts, 1);

  const loop = Commands.normalizeWorkflow({
    kind: "loop",
    objective: "ship",
    status: "running",
    awaitingResponse: true,
    promptFingerprint: "owned"
  }, 1000);
  const loopDecision = Commands.decideWorkflowResponse(loop, "work without a terminal marker", {
    userFingerprint: "owned",
    at: 1100
  });
  assert.equal(loopDecision.action, "paused");
  assert.equal(loopDecision.code, "command.workflow.marker_missing");
});

test("both automated workflows pause on multiple or misplaced markers", () => {
  for (const kind of ["goal", "loop"]) {
    const workflow = Commands.normalizeWorkflow({
      kind,
      objective: "ship",
      status: "running",
      awaitingResponse: true,
      promptFingerprint: "owned"
    }, 1000);
    const decision = Commands.decideWorkflowResponse(workflow, "first\n[YOLO:CONTINUE]\nthen\n[YOLO:DONE]", {
      userFingerprint: "owned",
      at: 1100
    });
    assert.equal(decision.action, "paused");
    assert.equal(decision.code, "command.workflow.marker_malformed");
    assert.match(decision.reason, /multiple or misplaced/i);
  }
});


test("goal workflows remain productive beyond the legacy 50-turn cap while loops stay bounded", () => {
  const goal = Commands.startWorkflow("goal", "finish the long project", { baselineFingerprint: "base" }).workflow;
  goal.awaitingResponse = true;
  goal.promptFingerprint = "user";
  goal.iteration = 50;
  const goalDecision = Commands.decideWorkflowResponse(goal, "More useful work remains.\n[YOLO:CONTINUE]", { userFingerprint: "user" });
  assert.equal(goalDecision.action, "continue");
  assert.equal(goalDecision.workflow.iteration, 51);
  assert.equal(goalDecision.workflow.maxIterations, Commands.GOAL_MAX_ITERATIONS);

  const loop = Commands.startWorkflow("loop", "50 finish the bounded review", { baselineFingerprint: "base" }).workflow;
  loop.awaitingResponse = true;
  loop.promptFingerprint = "user";
  loop.iteration = 49;
  const loopDecision = Commands.decideWorkflowResponse(loop, "One more pass would help.\n[YOLO:CONTINUE]", { userFingerprint: "user" });
  assert.equal(loopDecision.action, "paused");
  assert.equal(loopDecision.code, "command.workflow.cap_reached");
});

test("workflow schema v3 migrates legacy state with safe supervisor defaults", () => {
  const workflow = Commands.normalizeWorkflow({
    version: 1,
    kind: "goal",
    objective: "continue the project",
    status: "running",
    iteration: 73,
    supervisor: null
  }, 5000);
  assert.equal(workflow.version, Commands.WORKFLOW_SCHEMA_VERSION);
  assert.equal(workflow.iteration, 73);
  assert.deepEqual(workflow.supervisor, Commands.freshSupervisorState());

  const normalized = Commands.normalizeSupervisorState({
    repeatedResponseCount: -4,
    noProgressCount: 2.4,
    recoveryAttempts: "2",
    lastProgressAt: -10,
    recoveryReason: " retry later "
  });
  assert.equal(normalized.repeatedResponseCount, 0);
  assert.equal(normalized.noProgressCount, 2);
  assert.equal(normalized.recoveryAttempts, 2);
  assert.equal(normalized.lastProgressAt, 0);
  assert.equal(normalized.recoveryReason, "retry later");
});

test("supervisor observations track repeats, progress, and recovery attempts", () => {
  let state = Commands.freshSupervisorState();
  state = Commands.observeSupervisorState(state, { responseFingerprint: "a" }, 1000);
  assert.equal(state.repeatedResponseCount, 0);
  state = Commands.observeSupervisorState(state, { responseFingerprint: "a", progressed: false }, 1100);
  assert.equal(state.repeatedResponseCount, 1);
  assert.equal(state.noProgressCount, 1);
  state = Commands.observeSupervisorState(state, {
    responseFingerprint: "b",
    progressed: false,
    recoveryAttempted: true,
    recoveryReason: "missing marker"
  }, 1200);
  assert.equal(state.repeatedResponseCount, 0);
  assert.equal(state.noProgressCount, 2);
  assert.equal(state.recoveryAttempts, 1);
  assert.equal(state.lastRecoveryAt, 1200);
  assert.equal(state.recoveryReason, "missing marker");
  state = Commands.observeSupervisorState(state, { responseFingerprint: "c", progressed: true }, 1300);
  assert.equal(state.noProgressCount, 0);
  assert.equal(state.recoveryAttempts, 0);
  assert.equal(state.lastProgressAt, 1300);
  assert.equal(state.lastProgressFingerprint, "c");
});

test("supervisor circuit breakers stall only at configured evidence thresholds", () => {
  assert.equal(Commands.supervisorDisposition(Commands.freshSupervisorState()).action, "continue");
  assert.equal(Commands.supervisorDisposition({ repeatedResponseCount: 2 }).code, "supervisor.stalled.repeated_response");
  assert.equal(Commands.supervisorDisposition({ noProgressCount: 3 }).code, "supervisor.stalled.no_progress");
  assert.equal(Commands.supervisorDisposition({ recoveryAttempts: 3 }).code, "supervisor.stalled.recovery_limit");
});

test("workflow response decisions persist assistant repetition bookkeeping", () => {
  const text = "Still working.\n[YOLO:CONTINUE]";
  const responseFingerprint = Commands.fingerprint(text);
  const workflow = Commands.normalizeWorkflow({
    kind: "goal",
    objective: "finish",
    status: "running",
    awaitingResponse: true,
    promptFingerprint: "owned",
    supervisor: { lastResponseFingerprint: responseFingerprint, repeatedResponseCount: 0 }
  });
  const decision = Commands.decideWorkflowResponse(workflow, text, { userFingerprint: "owned", at: 2000 });
  assert.equal(decision.action, "continue");
  assert.equal(decision.workflow.supervisor.lastResponseFingerprint, responseFingerprint);
  assert.equal(decision.workflow.supervisor.repeatedResponseCount, 1);
});

test("goal workflows enter a recoverable stalled state after repeated identical responses", () => {
  const text = "No new progress.\n[YOLO:CONTINUE]";
  const responseFingerprint = Commands.fingerprint(text);
  const workflow = Commands.normalizeWorkflow({
    kind: "goal",
    objective: "finish",
    status: "running",
    awaitingResponse: true,
    promptFingerprint: "owned",
    supervisor: { lastResponseFingerprint: responseFingerprint, repeatedResponseCount: 1 }
  });
  const decision = Commands.decideWorkflowResponse(workflow, text, { userFingerprint: "owned", at: 3000 });
  assert.equal(decision.action, "stalled");
  assert.equal(decision.code, "supervisor.stalled.repeated_response");
  assert.equal(decision.workflow.supervisor.repeatedResponseCount, 2);
  const stalled = Commands.setWorkflowStatus(decision.workflow, "stalled", decision.reason, 3100);
  assert.equal(stalled.status, "stalled");
  assert.equal(stalled.awaitingResponse, false);
  assert.equal(stalled.runnerId, "");
});

test("goal recovery prompt requires durable-state verification before continuation", () => {
  const workflow = Commands.startWorkflow("goal", "finish the long project").workflow;
  workflow.supervisor.recoveryAttempts = 2;
  const prompt = Commands.workflowPrompt(workflow, "recovery");
  assert.match(prompt, /Recovery attempt 2 of 3/);
  assert.match(prompt, /Do not assume the interrupted operation completed/);
  assert.match(prompt, /last verified completed operation/);
  assert.match(prompt, /first incomplete or uncertain operation/);
  assert.match(prompt, /\[YOLO:CONTINUE\]/);
});

test("goal recovery attempts are bounded and reset after a valid control marker", () => {
  let workflow = Commands.normalizeWorkflow({
    kind: "goal", objective: "finish", status: "running", awaitingResponse: true, promptFingerprint: "owned"
  });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const decision = Commands.decideWorkflowResponse(workflow, `unfinished response ${attempt}`, { userFingerprint: "owned", at: 1000 + attempt });
    assert.equal(decision.action, "recover");
    assert.equal(decision.workflow.supervisor.recoveryAttempts, attempt);
    workflow = { ...decision.workflow, status: "running", awaitingResponse: true, promptFingerprint: "owned" };
  }
  const third = Commands.decideWorkflowResponse(workflow, "unfinished response 3", { userFingerprint: "owned", at: 1003 });
  assert.equal(third.action, "stalled");
  assert.equal(third.code, "supervisor.stalled.recovery_limit");
  assert.equal(third.workflow.supervisor.recoveryAttempts, 3);

  const recovered = Commands.decideWorkflowResponse({ ...workflow, supervisor: { ...workflow.supervisor, recoveryAttempts: 2 }, awaitingResponse: true }, "recovered\n[YOLO:CONTINUE]", { userFingerprint: "owned", at: 2000 });
  assert.equal(recovered.action, "continue");
  assert.equal(recovered.workflow.supervisor.recoveryAttempts, 0);
});

test("goal completion claims require evidence verification before completion", () => {
  const workflow = Commands.normalizeWorkflow({
    kind: "goal", objective: "finish", status: "running", awaitingResponse: true, promptFingerprint: "owned"
  });
  const claimText = "Everything is done.\n[YOLO:DONE]";
  const claim = Commands.decideWorkflowResponse(workflow, claimText, { userFingerprint: "owned", at: 3000 });
  assert.equal(claim.action, "verify");
  assert.equal(claim.code, "supervisor.verify.requested");
  assert.equal(claim.workflow.supervisor.verificationPending, true);
  assert.equal(claim.workflow.supervisor.verificationAttempts, 1);
  assert.equal(claim.workflow.supervisor.verificationClaimFingerprint, Commands.fingerprint(claimText));

  const prompt = Commands.workflowPrompt(claim.workflow, "verification");
  assert.match(prompt, /Do not trust the completion claim by default/);
  assert.match(prompt, /durable project state/);
  assert.match(prompt, /\[YOLO:DONE\] only if the objective is verified complete/);
});

test("verified Goal completion completes, while incomplete verification returns to work", () => {
  const base = Commands.normalizeWorkflow({
    kind: "goal", objective: "finish", status: "running", awaitingResponse: true, promptFingerprint: "owned",
    supervisor: { verificationPending: true, verificationAttempts: 1, verificationClaimFingerprint: "claim" }
  });
  const verified = Commands.decideWorkflowResponse(base, "Evidence checked.\n[YOLO:DONE]", { userFingerprint: "owned", at: 4000 });
  assert.equal(verified.action, "completed");
  assert.equal(verified.code, "supervisor.completed.verified");
  assert.equal(verified.workflow.supervisor.verificationPending, false);
  assert.equal(verified.workflow.supervisor.verificationAttempts, 0);

  const incomplete = Commands.decideWorkflowResponse(base, "One validation remains.\n[YOLO:CONTINUE]", { userFingerprint: "owned", at: 4100 });
  assert.equal(incomplete.action, "continue");
  assert.equal(incomplete.code, "supervisor.verification.incomplete");
  assert.equal(incomplete.workflow.supervisor.verificationPending, false);
});

test("verification protocol retries are bounded and Loop DONE remains direct", () => {
  let verifying = Commands.normalizeWorkflow({
    kind: "goal", objective: "finish", status: "running", awaitingResponse: true, promptFingerprint: "owned",
    supervisor: { verificationPending: true, verificationAttempts: 1, verificationClaimFingerprint: "claim" }
  });
  const retry = Commands.decideWorkflowResponse(verifying, "verification without marker", { userFingerprint: "owned", at: 5000 });
  assert.equal(retry.action, "verify");
  assert.equal(retry.workflow.supervisor.verificationAttempts, 2);
  verifying = { ...retry.workflow, status: "running", awaitingResponse: true, promptFingerprint: "owned" };
  const stalled = Commands.decideWorkflowResponse(verifying, "still no marker", { userFingerprint: "owned", at: 5100 });
  assert.equal(stalled.action, "stalled");
  assert.equal(stalled.code, "supervisor.stalled.verification_limit");

  const loop = Commands.normalizeWorkflow({ kind: "loop", objective: "review", status: "running", awaitingResponse: true, promptFingerprint: "owned", maxIterations: 4 });
  const loopDone = Commands.decideWorkflowResponse(loop, "Complete.\n[YOLO:DONE]", { userFingerprint: "owned", at: 5200 });
  assert.equal(loopDone.action, "completed");
  assert.equal(loopDone.code, "command.workflow.completed");
});

test("provider-limit and human-required workflow states normalize as durable resumable stops", () => {
  for (const status of ["rate_limited", "human_required"]) {
    const workflow = Commands.normalizeWorkflow({ kind: "goal", objective: "finish", status, awaitingResponse: true, runnerId: "tab" });
    assert.equal(workflow.status, status);
    assert.equal(workflow.awaitingResponse, true);
    const stopped = Commands.setWorkflowStatus(workflow, status, "manual state", 7000);
    assert.equal(stopped.status, status);
    assert.equal(stopped.awaitingResponse, false);
    assert.equal(stopped.runnerId, "");
  }
});

test("progress evidence markers parse independently from terminal control markers", () => {
  const progress = Commands.evaluateProgress("work\n[YOLO:PROGRESS:tests-256-pass]\n[YOLO:CONTINUE]");
  assert.equal(progress.kind, "progress");
  assert.equal(progress.evidence, "tests-256-pass");
  assert.equal(progress.fingerprint, Commands.fingerprint("tests-256-pass"));
  assert.equal(Commands.evaluateProgress("work\n[YOLO:NO_PROGRESS]\n[YOLO:CONTINUE]").kind, "no_progress");
  assert.equal(Commands.evaluateProgress("work\n[YOLO:CONTINUE]").kind, "missing");
  assert.equal(Commands.evaluateProgress("[YOLO:NO_PROGRESS]\n[YOLO:PROGRESS:x]\n[YOLO:CONTINUE]").kind, "malformed");
});

test("explicit no-progress evidence stalls a Goal after the configured threshold", () => {
  let workflow = Commands.normalizeWorkflow({ kind: "goal", objective: "finish", status: "running", awaitingResponse: true, promptFingerprint: "owned" });
  for (let index = 1; index <= 3; index += 1) {
    const decision = Commands.decideWorkflowResponse(workflow, `different wording ${index}\n[YOLO:NO_PROGRESS]\n[YOLO:CONTINUE]`, { userFingerprint: "owned", at: 8000 + index });
    assert.equal(decision.workflow.supervisor.noProgressCount, index);
    if (index < 3) assert.equal(decision.action, "continue");
    else {
      assert.equal(decision.action, "stalled");
      assert.equal(decision.code, "supervisor.stalled.no_progress");
    }
    workflow = { ...decision.workflow, status: "running", awaitingResponse: true, promptFingerprint: "owned" };
  }
});

test("reused progress evidence counts as no progress and new evidence resets the sequence", () => {
  let workflow = Commands.normalizeWorkflow({ kind: "goal", objective: "finish", status: "running", awaitingResponse: true, promptFingerprint: "owned" });
  let decision = Commands.decideWorkflowResponse(workflow, "saved checkpoint\n[YOLO:PROGRESS:checkpoint-a]\n[YOLO:CONTINUE]", { userFingerprint: "owned", at: 9000 });
  assert.equal(decision.action, "continue");
  assert.equal(decision.workflow.supervisor.noProgressCount, 0);
  const checkpointA = decision.workflow.supervisor.lastProgressFingerprint;

  workflow = { ...decision.workflow, status: "running", awaitingResponse: true, promptFingerprint: "owned" };
  decision = Commands.decideWorkflowResponse(workflow, "different prose same checkpoint\n[YOLO:PROGRESS:checkpoint-a]\n[YOLO:CONTINUE]", { userFingerprint: "owned", at: 9100 });
  assert.equal(decision.workflow.supervisor.noProgressCount, 1);
  assert.equal(decision.workflow.supervisor.lastProgressFingerprint, checkpointA);

  workflow = { ...decision.workflow, status: "running", awaitingResponse: true, promptFingerprint: "owned" };
  decision = Commands.decideWorkflowResponse(workflow, "new durable checkpoint\n[YOLO:PROGRESS:checkpoint-b]\n[YOLO:CONTINUE]", { userFingerprint: "owned", at: 9200 });
  assert.equal(decision.action, "continue");
  assert.equal(decision.workflow.supervisor.noProgressCount, 0);
  assert.notEqual(decision.workflow.supervisor.lastProgressFingerprint, checkpointA);
});

test("Goal prompts teach the explicit progress evidence protocol", () => {
  const workflow = Commands.startWorkflow("goal", "finish the project").workflow;
  assert.match(Commands.workflowPrompt(workflow, "initial"), /YOLO:PROGRESS/);
  assert.match(Commands.workflowPrompt(workflow, "continue"), /YOLO:NO_PROGRESS/);
  assert.match(Commands.workflowPrompt(workflow, "recovery"), /persisted\/verified progress/);
});
