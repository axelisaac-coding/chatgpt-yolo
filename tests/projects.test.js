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

test("project schema v2 adds durable rollover and handoff state safely", () => {
  const project = Projects.normalizeProject({ id: "migrate-v1", version: 1, objective: "Migrate me", currentConversationId: pageA }, "migrate-v1", 1000);
  assert.equal(project.version, 2);
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
