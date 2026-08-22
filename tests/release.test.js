const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function repositoryFiles(directory = root, prefix = "") {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "dist", "node_modules"].includes(entry.name)) continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...repositoryFiles(path.join(directory, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

test("public repository includes the essential open-source policy files", () => {
  for (const file of [
    "LICENSE",
    "NOTICE.md",
    "PRIVACY.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SUPPORT.md",
    "CHANGELOG.md"
  ]) assert.equal(fs.existsSync(path.join(root, file)), true, file);
  assert.match(read("LICENSE"), /MIT License/);
  assert.match(read("PRIVACY.md"), /no analytics, telemetry/i);
  assert.match(read("NOTICE.md"), /not affiliated/i);
});

test("ordinary pull-request CI is immutable and read-only", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(ci, /git push|contents: write|release\/v1-open-source|\.apply-/);
  assert.match(ci, /name: Validate core on Node \$\{\{ matrix\.node-version \}\}/);
  assert.match(ci, /name: Validate marketing assets/);
  assert.match(ci, /node-version:\s*\n\s*- 20\s*\n\s*- 24/);
  assert.match(ci, /name: yolo-preview/);
});

test("release workflow validates tag identity and emits an archive checksum", () => {
  const release = read(".github/workflows/release.yml");
  assert.match(release, /test "\$GITHUB_REF_NAME" = "v\$\{version\}"/);
  assert.match(release, /source_date_epoch=\$\(git log -1 --format=%ct\)/);
  assert.match(release, /LC_ALL=C sort -z/);
  assert.match(release, /zip -X -q/);
  assert.match(release, /sha256sum/);
  assert.match(release, /if-no-files-found: error/);
  assert.match(release, /gh release create/);
});

test("temporary review and diagnostic files are absent", () => {
  const offenders = repositoryFiles().filter((file) =>
    /(^|\/)\.(apply|fix)-|\.ready$|diagnostic|\.error\.txt$/i.test(file));
  assert.deepEqual(offenders, []);
});

test("documentation promises match the local-only permission model", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.deepEqual(manifest.permissions, ["alarms", "scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "https://*.chatgpt.com/*"]);
  for (const file of ["README.md", "PRIVACY.md", "docs/PERMISSIONS.md"]) {
    const content = read(file);
    assert.match(content, /local/i, file);
    assert.doesNotMatch(content, /collects telemetry|remote code is loaded/i, file);
  }
});

test("release package carries user-facing legal and privacy documents", () => {
  const packager = read("scripts/package.mjs");
  for (const file of ["README.md", "LICENSE", "NOTICE.md", "PRIVACY.md"]) {
    assert.match(packager, new RegExp(`"${file.replace(".", "\\.")}"`), file);
  }
});

test("Continuation Supervisor documentation is truthful about persistent Goal and release status", () => {
  const readme = read("README.md");
  const releaseReadme = read("README.release.md");
  const protocol = read("docs/CONTINUATION_SUPERVISOR_TESTING.md");
  assert.match(readme, /Goal mode has no arbitrary total-turn ceiling/i);
  assert.match(readme, /rate_limited/);
  assert.match(readme, /human_required/);
  assert.doesNotMatch(readme, /Run a bounded persistent objective|Nothing runs unbounded/);
  assert.match(releaseReadme, /development candidate/i);
  assert.match(releaseReadme, /not yet a formal release/i);
  assert.match(releaseReadme, /does not require the OpenAI API/i);
  assert.match(protocol, /approximately 15 hours/i);
  assert.match(protocol, /Do not deliberately manufacture or circumvent provider usage\/rate limits/i);
});
test("Continuation Supervisor release evidence preserves the authenticated live blocker", () => {
  const evidence = read("docs/CONTINUATION_SUPERVISOR_RELEASE_EVIDENCE.md");
  assert.match(evidence, /AUTH LIVE REQUIRED/);
  assert.match(evidence, /1,000 productive Goal continuations/i);
  assert.match(evidence, /authenticated saved-conversation browser pass/i);
  assert.match(evidence, /does not claim message delivery/i);
});


test("release evidence distinguishes automated successor migration from remaining live qualification", () => {
  const evidence = read("docs/CONTINUATION_SUPERVISOR_RELEASE_EVIDENCE.md");
  assert.match(evidence, /Conversation rollover development gate/i);
  assert.match(evidence, /project\.conversation_exhausted/);
  assert.match(evidence, /R6 .*AUTOMATED PASS; AUTH LIVE REQUIRED/);
  assert.match(evidence, /R7 .*NOT YET IMPLEMENTED/);
  assert.match(evidence, /R8 .*NOT YET IMPLEMENTED/);
  assert.match(evidence, /AUTH LIVE REQUIRED/);
});
