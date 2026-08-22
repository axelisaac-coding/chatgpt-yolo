const test = require("node:test");
const assert = require("node:assert/strict");
const Commands = require("../commands.js");

function awaitResponse(raw, promptFingerprint = "owned") {
  return Commands.normalizeWorkflow({
    ...raw,
    status: "running",
    awaitingResponse: true,
    pendingItemId: "",
    promptFingerprint
  });
}

function restart(raw, at = Date.now()) {
  return Commands.normalizeWorkflow(JSON.parse(JSON.stringify(raw)), at);
}

test("persistent Goal survives 1000 productive continuations and periodic restarts", () => {
  let workflow = Commands.startWorkflow("goal", "complete a very long project").workflow;
  for (let index = 1; index <= 1000; index += 1) {
    workflow = awaitResponse(workflow);
    const response = `productive cycle ${index}\n[YOLO:PROGRESS:checkpoint-${index}]\n[YOLO:CONTINUE]`;
    const decision = Commands.decideWorkflowResponse(workflow, response, { userFingerprint: "owned", at: 1000 + index });
    assert.equal(decision.action, "continue", `cycle ${index}`);
    workflow = decision.workflow;
    if (index % 25 === 0) workflow = restart(workflow, 2000 + index);
  }
  assert.equal(workflow.iteration, 1000);
  assert.equal(workflow.maxIterations, Commands.GOAL_MAX_ITERATIONS);
  assert.equal(workflow.supervisor.noProgressCount, 0);
  assert.equal(workflow.supervisor.repeatedResponseCount, 0);
  assert.equal(Commands.workflowPhase(workflow), "work");
  assert.equal(Commands.workflowIterationLabel(workflow), "continuation 1000");
  assert.ok(JSON.stringify(workflow).length < 10000, "workflow state must remain bounded");
});

test("missing-marker recovery survives restarts and stalls at its safety limit", () => {
  let workflow = Commands.startWorkflow("goal", "recover interrupted work").workflow;
  for (let attempt = 1; attempt <= Commands.SUPERVISOR_LIMITS.recoveryAttempts; attempt += 1) {
    workflow = awaitResponse(restart(workflow, 3000 + attempt));
    const decision = Commands.decideWorkflowResponse(workflow, `interrupted output ${attempt}`, {
      userFingerprint: "owned",
      at: 4000 + attempt
    });
    if (attempt < Commands.SUPERVISOR_LIMITS.recoveryAttempts) {
      assert.equal(decision.action, "recover");
      assert.equal(decision.workflow.supervisor.recoveryAttempts, attempt);
      assert.equal(Commands.workflowPhase(decision.workflow), "recovery");
    } else {
      assert.equal(decision.action, "stalled");
      assert.equal(decision.code, "supervisor.stalled.recovery_limit");
    }
    workflow = decision.workflow;
  }
});
test("changed prose cannot hide repeated durable progress evidence", () => {
  let workflow = Commands.startWorkflow("goal", "make measurable progress").workflow;
  workflow = awaitResponse(workflow);
  let decision = Commands.decideWorkflowResponse(
    workflow,
    "first advance\n[YOLO:PROGRESS:checkpoint-a]\n[YOLO:CONTINUE]",
    { userFingerprint: "owned", at: 5000 }
  );
  assert.equal(decision.action, "continue");
  workflow = decision.workflow;

  for (let repeat = 1; repeat <= Commands.SUPERVISOR_LIMITS.noProgressResponses; repeat += 1) {
    workflow = awaitResponse(restart(workflow, 5100 + repeat));
    decision = Commands.decideWorkflowResponse(
      workflow,
      `different wording ${repeat}\n[YOLO:PROGRESS:checkpoint-a]\n[YOLO:CONTINUE]`,
      { userFingerprint: "owned", at: 5200 + repeat }
    );
    if (repeat < Commands.SUPERVISOR_LIMITS.noProgressResponses) assert.equal(decision.action, "continue");
    else assert.equal(decision.code, "supervisor.stalled.no_progress");
    workflow = decision.workflow;
  }
  assert.equal(workflow.supervisor.noProgressCount, Commands.SUPERVISOR_LIMITS.noProgressResponses);
  assert.equal(workflow.supervisor.repeatedResponseCount, 0);
});
test("completion verification survives restart and only verified DONE completes", () => {
  let workflow = awaitResponse(Commands.startWorkflow("goal", "finish and verify").workflow);
  let decision = Commands.decideWorkflowResponse(
    workflow,
    "candidate completion\n[YOLO:DONE]",
    { userFingerprint: "owned", at: 6000 }
  );
  assert.equal(decision.action, "verify");
  assert.equal(decision.workflow.supervisor.verificationPending, true);

  workflow = awaitResponse(restart(decision.workflow, 6100));
  decision = Commands.decideWorkflowResponse(
    workflow,
    "independent evidence confirms completion\n[YOLO:DONE]",
    { userFingerprint: "owned", at: 6200 }
  );
  assert.equal(decision.action, "completed");
  assert.equal(decision.code, "supervisor.completed.verified");
  assert.equal(decision.workflow.supervisor.verificationPending, false);
});
test("verification protocol failure is bounded across restarts", () => {
  let workflow = awaitResponse(Commands.startWorkflow("goal", "verify robustly").workflow);
  let decision = Commands.decideWorkflowResponse(
    workflow,
    "claim\n[YOLO:DONE]",
    { userFingerprint: "owned", at: 7000 }
  );
  assert.equal(decision.action, "verify");
  workflow = decision.workflow;

  workflow = awaitResponse(restart(workflow, 7100));
  decision = Commands.decideWorkflowResponse(workflow, "verification missing marker", {
    userFingerprint: "owned",
    at: 7200
  });
  assert.equal(decision.action, "verify");
  assert.equal(decision.workflow.supervisor.verificationAttempts, 2);

  workflow = awaitResponse(restart(decision.workflow, 7300));
  decision = Commands.decideWorkflowResponse(workflow, "verification still missing", {
    userFingerprint: "owned",
    at: 7400
  });
  assert.equal(decision.action, "stalled");
  assert.equal(decision.code, "supervisor.stalled.verification_limit");
});
test("provider and human stop states survive serialization without becoming completed", () => {
  const base = Commands.startWorkflow("goal", "wait safely").workflow;
  for (const status of ["rate_limited", "human_required", "stalled", "blocked", "paused"]) {
    const stopped = Commands.setWorkflowStatus(base, status, `${status} reason`, 8000);
    const restored = restart(stopped, 8100);
    assert.equal(restored.status, status);
    assert.equal(restored.reason, `${status} reason`);
    assert.equal(restored.awaitingResponse, false);
    assert.notEqual(restored.status, "completed");
  }
});

test("bounded Loop still pauses exactly at its configured safety cap", () => {
  let workflow = Commands.startWorkflow("loop", "50 bounded iterations").workflow;
  workflow.maxIterations = 50;
  for (let index = 1; index <= 50; index += 1) {
    workflow = awaitResponse(workflow);
    const decision = Commands.decideWorkflowResponse(
      workflow,
      `loop cycle ${index}\n[YOLO:CONTINUE]`,
      { userFingerprint: "owned", at: 9000 + index }
    );
    if (index < 50) assert.equal(decision.action, "continue", `loop cycle ${index}`);
    else {
      assert.equal(decision.action, "paused");
      assert.equal(decision.code, "command.workflow.cap_reached");
    }
    workflow = decision.workflow;
  }
  assert.equal(workflow.iteration, 50);
});
