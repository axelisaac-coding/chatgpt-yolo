const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function loadGate() {
  return import("../scripts/check-live-qualification.mjs");
}

async function tempRuntime() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yolo-live-gate-"));
  await fs.mkdir(path.join(dir, "nested"));
  await fs.writeFile(path.join(dir, "a.txt"), "alpha");
  await fs.writeFile(path.join(dir, "nested", "b.txt"), "beta");
  return dir;
}

function evidence(Gate, digest, version, testedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    status: "passed",
    packageVersion: version,
    runtimeDigestSha256: digest,
    testedAt,
    candidateCommit: "a".repeat(40),
    browser: { name: "Google Chrome", version: "151.0.7922.170" },
    results: Object.fromEntries(Gate.REQUIRED_RESULTS.map((key) => [key, true]))
  };
}
test("packaged runtime digest is stable and content-sensitive", async () => {
  const Gate = await loadGate();
  const dir = await tempRuntime();
  const first = await Gate.packagedRuntimeDigest(dir);
  const second = await Gate.packagedRuntimeDigest(dir);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.files, ["a.txt", "nested/b.txt"]);
  await fs.writeFile(path.join(dir, "nested", "b.txt"), "changed");
  const changed = await Gate.packagedRuntimeDigest(dir);
  assert.notEqual(changed.digest, first.digest);
});

test("live evidence rejects stale runtime and incomplete observations", async () => {
  const Gate = await loadGate();
  const now = Date.parse("2026-08-22T12:00:00Z");
  const good = evidence(Gate, "B".repeat(64), "1.2.0", "2026-08-22T12:00:00Z");
  const context = { digest: "B".repeat(64), packageVersion: "1.2.0", now };
  assert.equal(Gate.validateLiveEvidence(good, context), true);
  assert.throws(() => Gate.validateLiveEvidence({ ...good, runtimeDigestSha256: "C".repeat(64) }, context), /digest does not match/i);
  const incomplete = structuredClone(good);
  incomplete.results.noDuplicateSubmission = false;
  assert.throws(() => Gate.validateLiveEvidence(incomplete, context), /noDuplicateSubmission must be true/);
  assert.throws(() => Gate.validateLiveEvidence({ ...good, testedAt: "2026-08-01T12:00:00Z" }, context), /stale/i);
  assert.throws(() => Gate.validateLiveEvidence({ ...good, testedAt: "2026-08-22T12:06:00Z" }, context), /future/i);
});
test("matching live evidence verifies the exact packaged tree", async () => {
  const Gate = await loadGate();
  const dir = await tempRuntime();
  const runtime = await Gate.packagedRuntimeDigest(dir);
  const pkg = JSON.parse(await fs.readFile(path.join(__dirname, "..", "package.json"), "utf8"));
  const receipt = evidence(Gate, runtime.digest, pkg.version);
  const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), "yolo-live-evidence-"));
  const evidenceFile = path.join(evidenceDir, "evidence.json");
  await fs.writeFile(evidenceFile, JSON.stringify(receipt, null, 2));
  const verified = await Gate.verifyLiveQualification({ evidenceFile, directory: dir });
  assert.equal(verified.digest, runtime.digest);
  assert.equal(verified.evidence.status, "passed");
});
