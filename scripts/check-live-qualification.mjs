import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist", "yolo");
const evidencePath = path.join(root, "docs", "CONTINUATION_SUPERVISOR_LIVE_QUALIFICATION.json");

export const REQUIRED_RESULTS = Object.freeze([
  "onlyCandidateLoaded",
  "savedSourceConversation",
  "proactiveTriggerObserved",
  "semanticHandoffVerified",
  "newChatControlObserved",
  "durableSuccessorObserved",
  "exactBootstrapReceiptObserved",
  "bootstrapVerificationObserved",
  "sourceRetiredBeforeResume",
  "projectLineageAdvanced",
  "successorGoalResumed",
  "noDuplicateSubmission",
  "restartRecoveryObserved"
]);

async function filesUnder(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(directory, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Unsupported packaged entry: ${child}`);
  }
  return files;
}

export async function packagedRuntimeDigest(directory = dist) {
  const files = (await filesUnder(directory)).sort();
  if (!files.length) throw new Error("Packaged runtime is empty; run npm run package first");
  const hash = createHash("sha256");
  for (const relative of files) {
    const bytes = await readFile(path.join(directory, ...relative.split("/")));
    hash.update(`${relative}\0${bytes.length}\0`, "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }
  return { digest: hash.digest("hex").toUpperCase(), files };
}
export function validateLiveEvidence(evidence, { digest, packageVersion, now = Date.now(), maxAgeMs = 14 * 24 * 60 * 60 * 1000 }) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("Live qualification evidence must be a JSON object");
  if (evidence.schemaVersion !== 1) throw new Error("Live qualification evidence schemaVersion must be 1");
  if (evidence.status !== "passed") throw new Error("Live qualification evidence status must be passed");
  if (evidence.packageVersion !== packageVersion) throw new Error(`Live qualification packageVersion ${evidence.packageVersion || "missing"} does not match ${packageVersion}`);
  if (String(evidence.runtimeDigestSha256 || "").toUpperCase() !== digest) throw new Error("Live qualification runtime digest does not match the packaged candidate");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(evidence.testedAt || ""))) throw new Error("Live qualification testedAt must be an ISO UTC timestamp");
  const testedAt = Date.parse(evidence.testedAt);
  if (!Number.isFinite(testedAt) || testedAt > now + 5 * 60 * 1000) throw new Error("Live qualification testedAt cannot be in the future");
  if (now - testedAt > maxAgeMs) throw new Error("Live qualification is stale; repeat it against the current ChatGPT UI");
  if (!String(evidence.browser?.name || "").trim() || !String(evidence.browser?.version || "").trim()) throw new Error("Live qualification browser name/version are required");
  if (!/^[0-9a-f]{40}$/i.test(String(evidence.candidateCommit || ""))) throw new Error("Live qualification candidateCommit must be a full Git commit SHA");
  for (const result of REQUIRED_RESULTS) {
    if (evidence.results?.[result] !== true) throw new Error(`Live qualification result ${result} must be true`);
  }
  return true;
}

export async function verifyLiveQualification({ evidenceFile = evidencePath, directory = dist } = {}) {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const runtime = await packagedRuntimeDigest(directory);
  const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
  validateLiveEvidence(evidence, { digest: runtime.digest, packageVersion: pkg.version });
  return { ...runtime, evidence };
}
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    if (process.argv.includes("--digest-only")) {
      const runtime = await packagedRuntimeDigest();
      console.log(`RUNTIME_SHA256=${runtime.digest}`);
      console.log(`RUNTIME_FILES=${runtime.files.length}`);
      process.exit(0);
    }
    const verified = await verifyLiveQualification();
    console.log(`Verified authenticated live qualification for ${verified.files.length} packaged files`);
    console.log(`RUNTIME_SHA256=${verified.digest}`);
    console.log(`BROWSER=${verified.evidence.browser.name} ${verified.evidence.browser.version}`);
    console.log(`TESTED_AT=${verified.evidence.testedAt}`);
  } catch (error) {
    console.error(`Live qualification gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}
