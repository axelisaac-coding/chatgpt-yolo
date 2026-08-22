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
