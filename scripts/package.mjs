import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_FILES = Object.freeze([
  "manifest.json",
  "background-wrapper.js",
  "tab-supervisor.js",
  "background.js",
  "data-background.js",
  "portability.js",
  "config.js",
  "shared.js",
  "lifecycle.js",
  "coordinator.js",
  "portable-store.js",
  "queue.js",
  "commands.js",
  "projects.js",
  "platforms.js",
  "command-ui.js",
  "content-state.js",
  "content.js",
  "command-runtime.js",
  "popup.html",
  "popup.js",
  "styles.css",
  "theme.css",
  "options.html",
  "options.js",
  "options-ui.js",
  "options-portability.js",
  "options.css",
  "onboarding.html",
  "onboarding.js",
  "onboarding.css",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "README.md",
  "LICENSE",
  "NOTICE.md",
  "PRIVACY.md"
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "yolo");

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

export async function verifyRuntimeFiles() {
  const unique = new Set(RUNTIME_FILES);
  if (unique.size !== RUNTIME_FILES.length) throw new Error("Runtime package contains duplicate paths");
  for (const relative of RUNTIME_FILES) {
    if (path.isAbsolute(relative) || relative.includes("..")) throw new Error(`Unsafe runtime path: ${relative}`);
    await access(path.join(root, relative));
  }
  // The release README must exist and be the source for the packaged README.
  const releaseReadme = path.join(root, "README.release.md");
  await access(releaseReadme);

  const manifest = await readJson("manifest.json");
  const pkg = await readJson("package.json");
  if (manifest.version !== pkg.version) {
    throw new Error(`Manifest ${manifest.version} does not match package ${pkg.version}`);
  }
  return true;
}

export async function packageExtension() {
  await verifyRuntimeFiles();
  await rm(output, { recursive: true, force: true });
  for (const relative of RUNTIME_FILES) {
    const destination = path.join(output, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, relative), destination);
  }
  // Ship the release README unconditionally so release archives never contain
  // the repository README with broken relative image/docs links.
  const releaseReadme = path.join(root, "README.release.md");
  await access(releaseReadme);
  await copyFile(releaseReadme, path.join(output, "README.md"));

  const releaseText = await readFile(releaseReadme, "utf8");
  const packagedText = await readFile(path.join(output, "README.md"), "utf8");
  if (releaseText !== packagedText) {
    throw new Error("Packaged README.md does not match README.release.md");
  }
  return output;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const checkOnly = process.argv.includes("--check");
  const result = checkOnly ? await verifyRuntimeFiles() : await packageExtension();
  console.log(checkOnly ? `Verified ${RUNTIME_FILES.length} packaged files` : `Packaged YOLO at ${result}`);
}
