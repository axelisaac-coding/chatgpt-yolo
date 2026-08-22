const test = require("node:test");
const assert = require("node:assert/strict");
const Commands = require("../commands.js");
const Projects = require("../projects.js");

const pageA = "https://chatgpt.com/c/project-a";

test("legacy project state normalizes into the versioned project schema", () => {
  const project = Projects.normalizeProject({
    id: "legacy-project",
    objective: "Continue the long project",
    currentConversationId: pageA,
    conversationChain: [{ generation: 1, pageId: pageA, status: "active" }]
  }, "legacy-project", 1000);

  assert.equal(project.version, Projects.PROJECT_SCHEMA_VERSION);
  assert.equal(project.id, "legacy-project");
  assert.equal(project.originalRequirements, "Continue the long project");
  assert.equal(project.currentGeneration, 1);
  assert.equal(project.conversationChain.length, 1);
  assert.equal(project.conversationChain[0].doNotContinue, false);
});

test("exhausted conversation normalization is permanently do-not-continue", () => {
  const project = Projects.normalizeProject({
    id: "exhausted-project",
    objective: "Keep going",
    currentConversationId: pageA,
    conversationChain: [{ generation: 1, pageId: pageA, status: "exhausted", doNotContinue: false }]
  }, "exhausted-project", 1000);
  assert.equal(project.conversationChain[0].status, "exhausted");
  assert.equal(project.conversationChain[0].doNotContinue, true);
  assert.equal(Projects.tombstoneForConversation({ [project.id]: project }, pageA).projectId, project.id);
});

test("goal workflow creates one stable project and carries supervisor checkpoint state", () => {
  const workflow = Commands.normalizeWorkflow({
    kind: "goal",
    objective: "Ship rollover",
    status: "running",
    supervisor: { lastProgressFingerprint: "checkpoint-1", lastProgressAt: 900 }
  }, 1000);
  const first = Projects.ensureProjectForWorkflow({}, pageA, workflow, 1000);
  assert.ok(first.project.id.startsWith("project_"));
  assert.equal(first.workflow.projectId, first.project.id);
  assert.equal(first.project.latestVerifiedCheckpoint.id, "checkpoint-1");

  const second = Projects.ensureProjectForWorkflow(first.map, pageA, {
    ...first.workflow,
    supervisor: { ...first.workflow.supervisor, lastProgressFingerprint: "checkpoint-2", lastProgressAt: 1200 }
  }, 1200);
  assert.equal(second.project.id, first.project.id);
  assert.equal(second.workflow.projectId, first.project.id);
  assert.equal(second.project.latestVerifiedCheckpoint.id, "checkpoint-2");
  assert.equal(second.project.conversationChain.length, 1);
});

test("rollover-required workflow tombstones its conversation with final fingerprints", () => {
  const started = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Survive thread limits", status: "running",
    promptFingerprint: "prompt-a", lastAssistantFingerprint: "assistant-a",
    supervisor: { lastProgressFingerprint: "checkpoint-a" }
  }, 1000);
  const rolled = Projects.ensureProjectForWorkflow(started.map, pageA, {
    ...started.workflow,
    status: "rollover_required",
    reason: "maximum conversation length reached",
    promptFingerprint: "prompt-final",
    lastAssistantFingerprint: "assistant-final"
  }, 1500);
  const entry = rolled.project.conversationChain[0];
  assert.equal(rolled.project.status, "rollover_required");
  assert.equal(entry.status, "exhausted");
  assert.equal(entry.doNotContinue, true);
  assert.equal(entry.finalPromptFingerprint, "prompt-final");
  assert.equal(entry.finalAssistantFingerprint, "assistant-final");
  assert.match(entry.rolloverReason, /maximum conversation length/i);
});

test("conversation lineage normalization stays bounded", () => {
  const chain = Array.from({ length: 80 }, (_, index) => ({
    generation: index + 1,
    pageId: `https://chatgpt.com/c/generation-${index + 1}`,
    status: index === 79 ? "active" : "completed"
  }));
  const project = Projects.normalizeProject({ id: "bounded", objective: "Long project", conversationChain: chain }, "bounded", 1000);
  assert.equal(project.conversationChain.length, Projects.MAX_CONVERSATIONS);
  assert.equal(project.conversationChain.at(-1).generation, 80);
});


test("a new Goal does not inherit a completed project merely because it uses the same conversation", () => {
  const first = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "First objective", status: "completed"
  }, 1000);
  const second = Projects.ensureProjectForWorkflow(first.map, pageA, {
    kind: "goal", objective: "Second objective", status: "running"
  }, 2000);
  assert.notEqual(second.project.id, first.project.id);
  assert.equal(Object.keys(second.map).length, 2);
  assert.equal(second.project.objective, "Second objective");
  assert.equal(Projects.findProjectByConversation(second.map, pageA, 2000).project.id, second.project.id);
});

test("an exhausted tombstone cannot be hidden by a newer project on the same conversation", () => {
  const exhausted = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Old exhausted project", status: "rollover_required",
    reason: "conversation reached maximum length"
  }, 1000);
  const newer = Projects.createProject({ objective: "Unrelated later project", pageId: pageA, at: 3000 });
  const map = { ...exhausted.map, [newer.id]: newer };
  assert.equal(Projects.findProjectByConversation(map, pageA, 3000).project.id, newer.id);
  const tombstone = Projects.tombstoneForConversation(map, pageA, 3000);
  assert.equal(tombstone.projectId, exhausted.project.id);
  assert.equal(tombstone.conversation.doNotContinue, true);
});

test("project schema migrations add durable rollover, handoff, and bootstrap state safely", () => {
  const project = Projects.normalizeProject({ id: "migrate-v1", version: 1, objective: "Migrate me", currentConversationId: pageA }, "migrate-v1", 1000);
  assert.equal(project.version, Projects.PROJECT_SCHEMA_VERSION);
  assert.deepEqual(project.rollover, Projects.freshRollover());
  assert.deepEqual(project.latestHandoff, Projects.freshHandoff());
});

test("context exhaustion initializes a required rollover transaction", () => {
  const rolled = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Cross chat", status: "rollover_required", reason: "conversation too long"
  }, 1000);
  assert.equal(rolled.project.rollover.stage, "required");
  assert.equal(rolled.project.rollover.sourcePageId, pageA);
  assert.match(rolled.project.rollover.reason, /too long/i);
  assert.equal(rolled.project.rollover.startedAt, 1000);
});

test("rollover lease prevents duplicate tabs and permits takeover after expiry", () => {
  const rolled = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Lease rollover", status: "rollover_required", reason: "context limit"
  }, 1000).project;
  const first = Projects.claimRollover(rolled, "tab-a", { at: 1100, leaseMs: 5000 });
  assert.equal(first.ok, true);
  assert.equal(first.project.status, "rolling_over");
  assert.equal(first.project.rollover.ownerId, "tab-a");
  const competing = Projects.claimRollover(first.project, "tab-b", { at: 1200, leaseMs: 5000 });
  assert.equal(competing.ok, false);
  assert.equal(competing.code, "project.rollover_busy");
  const takeover = Projects.claimRollover(first.project, "tab-b", { at: 7000, leaseMs: 5000 });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.project.rollover.ownerId, "tab-b");
  assert.notEqual(takeover.leaseToken, first.leaseToken);
});

test("rollover stages require the persisted lease and valid transition order", () => {
  const rolled = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Stage rollover", status: "rollover_required", reason: "context limit"
  }, 1000).project;
  const claim = Projects.claimRollover(rolled, "tab-a", { at: 1100 });
  const wrongLease = Projects.advanceRollover(claim.project, "handoff_pending", { ownerId: "tab-b", leaseToken: claim.leaseToken, at: 1200 });
  assert.equal(wrongLease.code, "project.rollover_lease_lost");
  const skipped = Projects.advanceRollover(claim.project, "successor_pending", { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1200 });
  assert.equal(skipped.code, "project.rollover_transition_invalid");
  const valid = Projects.advanceRollover(claim.project, "handoff_pending", { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1200 });
  assert.equal(valid.ok, true);
  assert.equal(valid.project.rollover.stage, "handoff_pending");
});

function validHandoff(project) {
  return [
    `Project-ID: ${project.id}`,
    `Generation: ${project.currentGeneration}`,
    "Objective: Continue the exact long-running project safely.",
    "Current-State: Project state is durable and source chat is exhausted.",
    "Completed: Phase A rollover foundation is complete and tested.",
    "Unresolved: Successor chat creation and binding remain.",
    "Validation: Targeted and broad deterministic gates passed.",
    "Next-Action: Continue with the first incomplete rollover transaction step."
  ].join("\n");
}

test("handoff candidate is structurally validated, fingerprinted, and independently verified", () => {
  const rolled = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Verify handoff", status: "rollover_required", reason: "context limit",
    supervisor: { lastProgressFingerprint: "checkpoint-a", lastProgressAt: 900 }
  }, 1000).project;
  const claim = Projects.claimRollover(rolled, "tab-a", { at: 1100 });
  const text = validHandoff(claim.project);
  const saved = Projects.saveHandoffCandidate(claim.project, text, { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1200 });
  assert.equal(saved.ok, true);
  assert.equal(saved.project.rollover.stage, "handoff_pending");
  assert.equal(saved.project.latestHandoff.verified, false);
  assert.equal(saved.project.latestHandoff.basisCheckpointId, "checkpoint-a");
  const stale = Projects.verifyHandoff(saved.project, "[YOLO:HANDOFF_VERIFIED:wrong]", { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1300 });
  assert.equal(stale.code, "project.handoff_stale");
  const marker = Projects.handoffVerificationMarker(saved.fingerprint, true);
  const verified = Projects.verifyHandoff(saved.project, `Evidence checked.\n${marker}`, { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1400 });
  assert.equal(verified.ok, true);
  assert.equal(verified.project.latestHandoff.verified, true);
  assert.equal(verified.project.rollover.stage, "handoff_ready");
  assert.equal(verified.project.rollover.handoffSource, "verified_handoff");
});

test("handoff prompts bind project identity and stale verification cannot pass", () => {
  const project = Projects.createProject({ objective: "Prompt handoff", pageId: pageA, at: 1000 });
  const generationPrompt = Projects.handoffGenerationPrompt(project);
  assert.match(generationPrompt, new RegExp(`Project-ID: ${project.id}`));
  assert.match(generationPrompt, /Current-State:/);
  assert.match(generationPrompt, /first unfinished operation/i);
  const claimBase = Projects.markConversationExhausted(project, pageA, { reason: "planned rollover", at: 1100 });
  const claim = Projects.claimRollover(claimBase, "tab-a", { at: 1200 });
  const saved = Projects.saveHandoffCandidate(claim.project, validHandoff(claim.project), { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1300 });
  const verifyPrompt = Projects.handoffVerificationPrompt(saved.project);
  assert.match(verifyPrompt, new RegExp(saved.fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(verifyPrompt, /HANDOFF_VERIFIED/);
  assert.match(verifyPrompt, /HANDOFF_REJECTED/);
});

test("hard exhaustion can fall back to persisted checkpoint or machine state", () => {
  let checkpointProject = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Checkpoint fallback", status: "rollover_required", reason: "hard limit",
    supervisor: { lastProgressFingerprint: "checkpoint-b", lastProgressAt: 800 }
  }, 1000).project;
  const checkpointClaim = Projects.claimRollover(checkpointProject, "tab-a", { at: 1100 });
  const checkpointFallback = Projects.applyRolloverFallback(checkpointClaim.project, { ownerId: "tab-a", leaseToken: checkpointClaim.leaseToken, at: 1200 });
  assert.equal(checkpointFallback.ok, true);
  assert.equal(checkpointFallback.fallback.kind, "checkpoint");
  assert.equal(checkpointFallback.project.rollover.stage, "handoff_ready");
  assert.equal(checkpointFallback.project.rollover.handoffSource, "checkpoint");

  const machineProject = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Machine fallback", status: "rollover_required", reason: "hard limit"
  }, 2000).project;
  const machineClaim = Projects.claimRollover(machineProject, "tab-m", { at: 2100 });
  const machineFallback = Projects.applyRolloverFallback(machineClaim.project, { ownerId: "tab-m", leaseToken: machineClaim.leaseToken, at: 2200 });
  assert.equal(machineFallback.fallback.kind, "machine_state");
  assert.equal(machineFallback.fallback.objective, "Machine fallback");
});

test("verified persisted handoff outranks checkpoint fallback", () => {
  let project = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Prefer handoff", status: "rollover_required", reason: "planned",
    supervisor: { lastProgressFingerprint: "checkpoint-c", lastProgressAt: 900 }
  }, 1000).project;
  const claim = Projects.claimRollover(project, "tab-a", { at: 1100 });
  const saved = Projects.saveHandoffCandidate(claim.project, validHandoff(claim.project), { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1200 });
  const verified = Projects.verifyHandoff(saved.project, Projects.handoffVerificationMarker(saved.fingerprint, true), { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1300 });
  const fallback = Projects.selectRolloverFallback(verified.project);
  assert.equal(fallback.kind, "verified_handoff");
  assert.equal(fallback.handoff.fingerprint, saved.fingerprint);
});

test("repeated source exhaustion observation preserves an in-progress rollover lease", () => {
  const started = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Preserve transaction", status: "rollover_required", reason: "first limit"
  }, 1000);
  const claim = Projects.claimRollover(started.project, "tab-a", { at: 1100 });
  const map = { ...started.map, [claim.project.id]: claim.project };
  const repeated = Projects.ensureProjectForWorkflow(map, pageA, {
    ...started.workflow, projectId: claim.project.id, status: "rollover_required", reason: "limit still visible"
  }, 1200);
  assert.equal(repeated.project.status, "rolling_over");
  assert.equal(repeated.project.rollover.ownerId, "tab-a");
  assert.equal(repeated.project.rollover.leaseToken, claim.leaseToken);
  assert.equal(repeated.project.rollover.stage, "required");
});

function bootstrapReadyProject(at = 3000) {
  const rolled = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Cross conversation bootstrap", status: "rollover_required", reason: "hard context limit",
    supervisor: { lastProgressFingerprint: "checkpoint-bootstrap", lastProgressAt: at - 200 }
  }, at).project;
  const claim = Projects.claimRollover(rolled, "tab-rollover", { at: at + 10, leaseMs: 60000 });
  const fallback = Projects.applyRolloverFallback(claim.project, { ownerId: "tab-rollover", leaseToken: claim.leaseToken, at: at + 20 });
  const successorPending = Projects.advanceRollover(fallback.project, "successor_pending", { ownerId: "tab-rollover", leaseToken: claim.leaseToken, at: at + 30 });
  return { project: successorPending.project, leaseToken: claim.leaseToken, at };
}

test("bootstrap is durably prepared before a transient new-chat submission", () => {
  const ready = bootstrapReadyProject();
  const prepared = Projects.prepareBootstrap(ready.project, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 3040 });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.project.rollover.stage, "bootstrap_pending");
  assert.equal(prepared.project.rollover.bootstrapState, "prepared");
  assert.match(prepared.project.rollover.bootstrapText, /Project-ID:/);
  assert.match(prepared.project.rollover.bootstrapText, /Generation: 2/);
  assert.match(prepared.project.rollover.bootstrapText, /BOOTSTRAP_READY/);
  assert.ok(prepared.project.rollover.bootstrapFingerprint);
  assert.ok(prepared.project.rollover.bootstrapToken);
});

test("successor binding requires an exact durable bootstrap receipt and verified marker", () => {
  const ready = bootstrapReadyProject(4000);
  const prepared = Projects.prepareBootstrap(ready.project, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 4040 });
  const submitting = Projects.markBootstrapSubmitting(prepared.project, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 4050 });
  assert.equal(submitting.project.rollover.bootstrapState, "submitting");
  const successor = "https://chatgpt.com/c/project-b";
  const mismatch = Projects.observeBootstrapSuccessor(submitting.project, successor, "wrong prompt", { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 4060 });
  assert.equal(mismatch.code, "project.bootstrap_receipt_mismatch");
  const observed = Projects.observeBootstrapSuccessor(submitting.project, successor, submitting.project.rollover.bootstrapText, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 4070 });
  assert.equal(observed.ok, true);
  assert.equal(observed.project.currentConversationId, pageA);
  assert.equal(observed.project.rollover.bootstrapState, "observed");
  const stale = Projects.verifyBootstrapSuccessor(observed.project, "[YOLO:BOOTSTRAP_READY:wrong]", { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 4080 });
  assert.equal(stale.code, "project.bootstrap_stale");
  const marker = Projects.bootstrapVerificationMarker(observed.project.rollover.bootstrapToken);
  const verified = Projects.verifyBootstrapSuccessor(observed.project, `Recovered state.\n${marker}`, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 4090 });
  assert.equal(verified.ok, true);
  assert.equal(verified.project.currentConversationId, successor);
  assert.equal(verified.project.currentGeneration, 2);
  assert.equal(verified.project.rollover.stage, "successor_bound");
  assert.equal(verified.project.conversationChain.length, 2);
  assert.equal(verified.project.conversationChain[0].successorPageId, successor);
  assert.equal(verified.project.conversationChain[0].doNotContinue, true);
});

test("ambiguous bootstrap delivery fails closed instead of becoming retryable", () => {
  const ready = bootstrapReadyProject(5000);
  const prepared = Projects.prepareBootstrap(ready.project, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 5040 });
  const submitting = Projects.markBootstrapSubmitting(prepared.project, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 5050 });
  const unknown = Projects.markBootstrapDeliveryUnknown(submitting.project, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 5060, reason: "navigation outcome unknown" });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.project.rollover.bootstrapState, "delivery_unknown");
  assert.equal(unknown.project.status, "rollover_required");
  const retry = Projects.markBootstrapSubmitting(unknown.project, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 5070 });
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "project.bootstrap_not_prepared");
});

test("completed rollover returns the project to active and releases its lease", () => {
  const ready = bootstrapReadyProject(6000);
  let result = Projects.prepareBootstrap(ready.project, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 6040 });
  result = Projects.markBootstrapSubmitting(result.project, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 6050 });
  result = Projects.observeBootstrapSuccessor(result.project, "https://chatgpt.com/c/project-c", result.project.rollover.bootstrapText, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 6060 });
  result = Projects.verifyBootstrapSuccessor(result.project, Projects.bootstrapVerificationMarker(result.project.rollover.bootstrapToken), { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 6070 });
  result = Projects.advanceRollover(result.project, "resuming", { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 6080 });
  result = Projects.advanceRollover(result.project, "complete", { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 6090 });
  assert.equal(result.ok, true);
  assert.equal(result.project.status, "active");
  assert.equal(result.project.rollover.stage, "complete");
  assert.equal(result.project.rollover.ownerId, "");
  assert.equal(result.project.rollover.leaseToken, "");
});

test("new-chat opening is persisted once before the navigation side effect", () => {
  let project = Projects.ensureProjectForWorkflow({}, pageA, {
    kind: "goal", objective: "Open one successor", status: "rollover_required", reason: "context limit"
  }, 1000).project;
  const claim = Projects.claimRollover(project, "tab-a", { at: 1100 });
  const fallback = Projects.applyRolloverFallback(claim.project, { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1200 });
  const pending = Projects.advanceRollover(fallback.project, "successor_pending", { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1300 });
  const prepared = Projects.prepareBootstrap(pending.project, { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1400 });
  const marked = Projects.markNewChatOpening(prepared.project, { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1500 });
  assert.equal(marked.ok, true);
  assert.equal(marked.alreadyMarked, false);
  assert.equal(marked.project.rollover.newChatOpeningAt, 1500);
  const repeated = Projects.markNewChatOpening(marked.project, { ownerId: "tab-a", leaseToken: claim.leaseToken, at: 1600 });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.alreadyMarked, true);
  assert.equal(repeated.project.revision, marked.project.revision);
  assert.equal(repeated.project.rollover.newChatOpeningAt, 1500);
});
test("a later successor exhaustion starts a fresh rollover transaction and ignores stale handoff text", () => {
  const ready = bootstrapReadyProject(7000);
  let result = Projects.prepareBootstrap(ready.project, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 7040 });
  result = Projects.markBootstrapSubmitting(result.project, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 7050 });
  const successor = "https://chatgpt.com/c/generation-two";
  result = Projects.observeBootstrapSuccessor(result.project, successor, result.project.rollover.bootstrapText, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 7060 });
  result = Projects.verifyBootstrapSuccessor(result.project, Projects.bootstrapVerificationMarker(result.project.rollover.bootstrapToken), { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 7070 });
  result = Projects.advanceRollover(result.project, "resuming", { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 7080 });
  result = Projects.advanceRollover(result.project, "complete", { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 7090 });
  result.project.latestHandoff = { text: validHandoff(ready.project), verified: true, fingerprint: "stale-handoff", sourcePageId: pageA, generation: 1, basisCheckpointId: "old", at: 6500, verifiedAt: 6600 };
  const exhausted = Projects.markConversationExhausted(result.project, successor, {
    reason: "generation two context limit",
    workflow: { supervisor: { lastProgressFingerprint: "generation-two-checkpoint", lastProgressAt: 7190 } },
    at: 7200
  });
  assert.equal(exhausted.currentGeneration, 2);
  assert.equal(exhausted.rollover.stage, "required");
  assert.equal(exhausted.rollover.sourcePageId, successor);
  assert.equal(exhausted.rollover.newChatOpeningAt, 0);
  assert.equal(exhausted.rollover.bootstrapState, "idle");
  assert.equal(Projects.selectRolloverFallback(exhausted).kind, "checkpoint");
  assert.equal(Projects.selectRolloverFallback(exhausted).checkpoint.id, "generation-two-checkpoint");
});
test("long bootstrap text keeps one canonical persisted fingerprint and terminal verification marker", () => {
  const ready = bootstrapReadyProject(8000);
  ready.project.originalRequirements = "R".repeat(12000);
  const normalized = Projects.normalizeProject(ready.project, ready.project.id, 8035);
  const prepared = Projects.prepareBootstrap(normalized, { ownerId: "tab-rollover", leaseToken: ready.leaseToken, at: 8040 });
  assert.equal(prepared.ok, true);
  assert.ok(prepared.project.rollover.bootstrapText.length <= Projects.MAX_BOOTSTRAP_LENGTH);
  assert.equal(prepared.project.rollover.bootstrapFingerprint, Commands.fingerprint(prepared.project.rollover.bootstrapText));
  assert.match(prepared.project.rollover.bootstrapText, new RegExp(`\\[YOLO:BOOTSTRAP_READY:${prepared.project.rollover.bootstrapToken}\\]$`));
});
test("proactive rollover planning is threshold-backed, generation-scoped, and restart-safe", () => {
  const workflow = Commands.normalizeWorkflow({ kind: "goal", objective: "Move before exhaustion", status: "running", iteration: 90, supervisor: { lastProgressFingerprint: "checkpoint-proactive", lastProgressAt: 900 } }, 1000);
  const started = Projects.ensureProjectForWorkflow({}, pageA, workflow, 1000).project;
  const planned = Projects.planProactiveRollover(started, pageA, { workflow, growth: { totalMessages: 120, visibleTextChars: 210000 }, at: 1100 });
  assert.equal(planned.ok, true);
  assert.equal(planned.project.status, "rollover_required");
  assert.equal(planned.project.rollover.mode, "proactive");
  assert.equal(planned.project.rollover.stage, "required");
  assert.equal(planned.project.rollover.proactiveAttempts, 1);
  assert.equal(planned.project.rollover.proactiveEvidenceMessages, 120);
  assert.equal(planned.project.latestVerifiedCheckpoint.id, "checkpoint-proactive");
  assert.equal(Projects.normalizeProject(planned.project, planned.project.id, 1200).rollover.mode, "proactive");
});
test("proactive handoff prompts are durably prepared and verified before successor creation", () => {
  const workflow = Commands.normalizeWorkflow({ kind: "goal", objective: "Verified proactive move", status: "running", iteration: 100 }, 2000);
  let project = Projects.ensureProjectForWorkflow({}, pageA, workflow, 2000).project;
  project = Projects.planProactiveRollover(project, pageA, { workflow, growth: { totalMessages: 130, visibleTextChars: 220000 }, at: 2100 }).project;
  const claim = Projects.claimRollover(project, "tab-proactive", { at: 2200, leaseMs: 60000 });
  const generation = Projects.prepareProactiveHandoffGeneration(claim.project, { ownerId: "tab-proactive", leaseToken: claim.leaseToken, baselineAssistantFingerprint: "assistant-before", at: 2300 });
  assert.equal(generation.ok, true);
  assert.equal(generation.project.rollover.handoffAction, "generate");
  assert.ok(generation.project.rollover.handoffPromptFingerprint);
  const saved = Projects.saveHandoffCandidate(generation.project, validHandoff(generation.project), { ownerId: "tab-proactive", leaseToken: claim.leaseToken, at: 2400 });
  assert.equal(saved.project.rollover.handoffAction, "idle");
  const verification = Projects.prepareProactiveHandoffVerification(saved.project, { ownerId: "tab-proactive", leaseToken: claim.leaseToken, baselineAssistantFingerprint: "assistant-candidate", at: 2500 });
  assert.equal(verification.ok, true);
  assert.equal(verification.project.rollover.handoffAction, "verify");
  assert.match(verification.project.rollover.handoffPromptText, /HANDOFF_VERIFIED/);
  const verified = Projects.verifyHandoff(verification.project, Projects.handoffVerificationMarker(saved.fingerprint, true), { ownerId: "tab-proactive", leaseToken: claim.leaseToken, at: 2600 });
  assert.equal(verified.project.rollover.stage, "handoff_ready");
  assert.equal(verified.project.rollover.handoffAction, "idle");
});
test("hard exhaustion takes over an unfinished proactive handoff without another source prompt", () => {
  const workflow = Commands.normalizeWorkflow({ kind: "goal", objective: "Escalate safely", status: "running", iteration: 100, supervisor: { lastProgressFingerprint: "checkpoint-hard-takeover" } }, 3000);
  let project = Projects.ensureProjectForWorkflow({}, pageA, workflow, 3000).project;
  project = Projects.planProactiveRollover(project, pageA, { workflow, growth: { totalMessages: 140, visibleTextChars: 230000 }, at: 3100 }).project;
  const claim = Projects.claimRollover(project, "tab-proactive", { at: 3200, leaseMs: 60000 });
  const prepared = Projects.prepareProactiveHandoffGeneration(claim.project, { ownerId: "tab-proactive", leaseToken: claim.leaseToken, baselineAssistantFingerprint: "before", at: 3300 });
  const exhausted = Projects.markConversationExhausted(prepared.project, pageA, { workflow: { ...workflow, status: "rollover_required", reason: "maximum conversation length reached" }, at: 3400 });
  assert.equal(exhausted.rollover.mode, "hard");
  assert.equal(exhausted.rollover.stage, "required");
  assert.equal(exhausted.rollover.handoffAction, "idle");
  assert.equal(exhausted.conversationChain[0].doNotContinue, true);
});

test("persisted New Chat intent retires a proactive source before navigation", () => {
  const workflow = Commands.normalizeWorkflow({ kind: "goal", objective: "Retire source", status: "running", iteration: 100 }, 4000);
  let project = Projects.ensureProjectForWorkflow({}, pageA, workflow, 4000).project;
  project = Projects.planProactiveRollover(project, pageA, { workflow, growth: { totalMessages: 130, visibleTextChars: 220000 }, at: 4100 }).project;
  const claim = Projects.claimRollover(project, "tab-proactive", { at: 4200, leaseMs: 60000 });
  const ready = Projects.applyRolloverFallback(claim.project, { ownerId: "tab-proactive", leaseToken: claim.leaseToken, at: 4300 });
  const pending = Projects.advanceRollover(ready.project, "successor_pending", { ownerId: "tab-proactive", leaseToken: claim.leaseToken, at: 4400 });
  const bootstrap = Projects.prepareBootstrap(pending.project, { ownerId: "tab-proactive", leaseToken: claim.leaseToken, at: 4500 });
  const marked = Projects.markNewChatOpening(bootstrap.project, { ownerId: "tab-proactive", leaseToken: claim.leaseToken, finalPromptFingerprint: "handoff-verify", finalAssistantFingerprint: "handoff-ok", at: 4600 });
  const source = marked.project.conversationChain.find((entry) => entry.pageId === pageA);
  assert.equal(source.doNotContinue, true);
  assert.equal(source.status, "rolling_over");
  assert.equal(source.finalPromptFingerprint, "handoff-verify");
  assert.equal(Projects.tombstoneForConversation({ [marked.project.id]: marked.project }, pageA).projectId, marked.project.id);
});
test("safe proactive abort returns project active while preserving bounded retry evidence", () => {
  const baseAt = 10000;
  const workflow = Commands.normalizeWorkflow({ kind: "goal", objective: "Retry rollover safely", status: "running", iteration: 150 }, baseAt);
  let project = Projects.ensureProjectForWorkflow({}, pageA, workflow, baseAt).project;
  let planned = Projects.planProactiveRollover(project, pageA, { workflow, growth: { totalMessages: 20, visibleTextChars: 1000 }, at: baseAt + 100 });
  assert.equal(planned.ok, true);
  let claim = Projects.claimRollover(planned.project, "retry-tab", { at: baseAt + 200, leaseMs: 60000 });
  let prepared = Projects.prepareProactiveHandoffGeneration(claim.project, { ownerId: "retry-tab", leaseToken: claim.leaseToken, at: baseAt + 300 });
  let aborted = Projects.cancelProactiveRollover(prepared.project, { ownerId: "retry-tab", leaseToken: claim.leaseToken, reason: "ownership changed", at: baseAt + 400 });
  assert.equal(aborted.ok, true);
  assert.equal(aborted.project.status, "active");
  assert.equal(aborted.project.rollover.stage, "failed");
  assert.equal(aborted.project.rollover.proactiveAttempts, 1);
  assert.equal(aborted.project.rollover.leaseToken, "");
  const cooldown = Projects.planProactiveRollover(aborted.project, pageA, { workflow, growth: { totalMessages: 20, visibleTextChars: 1000 }, at: baseAt + 500 });
  assert.equal(cooldown.code, "project.proactive_cooldown");
});
test("proactive retries are capped per generation after safe aborts", () => {
  const limits = Commands.PROACTIVE_ROLLOVER_LIMITS;
  const workflow = Commands.normalizeWorkflow({ kind: "goal", objective: "Bound retries", status: "running", iteration: 150 }, 20000);
  let project = Projects.ensureProjectForWorkflow({}, pageA, workflow, 20000).project;
  for (let attempt = 0; attempt < limits.maxAttemptsPerGeneration; attempt += 1) {
    const at = 21000 + attempt * (limits.retryCooldownMs + 1000);
    const planned = Projects.planProactiveRollover(project, pageA, { workflow, growth: { totalMessages: 1, visibleTextChars: 1 }, at });
    assert.equal(planned.ok, true);
    const claim = Projects.claimRollover(planned.project, "bounded-tab", { at: at + 100, leaseMs: 60000 });
    const aborted = Projects.cancelProactiveRollover(claim.project, { ownerId: "bounded-tab", leaseToken: claim.leaseToken, at: at + 200 });
    assert.equal(aborted.ok, true);
    project = aborted.project;
  }
  const finalAt = project.rollover.proactiveLastAttemptAt + limits.retryCooldownMs + 1000;
  const blocked = Projects.planProactiveRollover(project, pageA, { workflow, growth: { totalMessages: 1, visibleTextChars: 1 }, at: finalAt });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "project.proactive_attempt_limit");
});