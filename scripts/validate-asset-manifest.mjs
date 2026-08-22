import {
  readFileSync,
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function parsePngDimensions(buffer) {
  if (buffer.length < 24) return null;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(sig)) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function isAscii(str, bytes) {
  return bytes.toString("binary", 0, str.length) === str;
}

export function parseWebpDimensions(buffer) {
  if (buffer.length < 30) return null;
  if (!isAscii("RIFF", buffer) || !isAscii("WEBP", buffer.subarray(8, 12))) return null;

  const chunk = buffer.toString("binary", 12, 16);
  if (chunk === "VP8 ") {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (buffer.length < 25) return null;
    if (buffer[20] !== 0x2f) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const bits = view.getUint32(21, true);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    const chunkSize = buffer.readUInt32LE(16);
    if (chunkSize < 10 || buffer.length < 30) return null;
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
    };
  }
  return null;
}

export function parseSvgDimensions(text) {
  const widthMatch = text.match(/width=["']([0-9.]+)(?:px)?["']/i);
  const heightMatch = text.match(/height=["']([0-9.]+)(?:px)?["']/i);
  const viewBoxMatch = text.match(/viewBox=["']\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*["']/i);
  if (widthMatch && heightMatch) {
    return { width: Number(widthMatch[1]), height: Number(heightMatch[1]) };
  }
  if (viewBoxMatch) {
    return { width: Number(viewBoxMatch[3]), height: Number(viewBoxMatch[4]) };
  }
  return null;
}

export function getInferredFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "png";
  if (ext === ".webp") return "webp";
  if (ext === ".svg") return "svg";
  if (ext === ".mp4") return "mp4";
  return null;
}

export function parseImageDimensions(file, format) {
  const buffer = readFileSync(file);
  if (format === "png") return parsePngDimensions(buffer);
  if (format === "webp") return parseWebpDimensions(buffer);
  if (format === "svg") return parseSvgDimensions(buffer.toString("utf-8"));
  return null;
}

export function parseDimensions(declared) {
  const match = String(declared).match(/(\d+)\s*x\s*(\d+)/);
  if (match) return { width: Number(match[1]), height: Number(match[2]) };
  return null;
}

export function parseFrameRate(fpsString) {
  if (typeof fpsString === "number") return Number.isFinite(fpsString) ? fpsString : NaN;
  const [num, den] = String(fpsString).split("/").map(Number);
  if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
  const parsed = Number(fpsString);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function isFastStart(file) {
  try {
    const buffer = readFileSync(file);
    let offset = 0;
    while (offset < buffer.length - 8) {
      const size = buffer.readUInt32BE(offset);
      const type = buffer.toString("binary", offset + 4, offset + 8);
      if (size === 0) break;
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (size === 1) {
        if (offset + 16 > buffer.length) break;
        offset += Number(buffer.readBigUInt64BE(offset + 8));
      } else {
        offset += size;
      }
      if (offset <= 0) break;
    }
    return false;
  } catch {
    return null;
  }
}

export function ffprobe(file) {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file],
      { encoding: "utf-8" },
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

export function getCanonicalPath(rootDir, itemPath) {
  return path.resolve(rootDir, itemPath || "");
}

export function validateEntry(item, { rootDir, seen, requireDimensions = true, ffprobeFn = ffprobe }) {
  const errors = [];

  if (!item || typeof item !== "object") {
    errors.push("invalid manifest entry");
    return errors;
  }

  const required = ["path", "sha256", "format", "dimensions"];
  for (const field of required) {
    if (item[field] === undefined || item[field] === null || item[field] === "") {
      errors.push(`missing required field: ${field}`);
    }
  }
  if (!item.size_budget_kb && !item.size_budget_mb) {
    errors.push("missing size budget");
  }

  if (!item.path) return errors;

  if (seen.has(item.path)) {
    errors.push("duplicate path");
  }
  seen.add(item.path);

  const file = getCanonicalPath(rootDir, item.path);
  const relative = path.relative(rootDir, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    errors.push("unsafe path");
    return errors;
  }

  if (!existsSync(file)) {
    errors.push("file missing");
    return errors;
  }

  let lstat;
  try {
    lstat = lstatSync(file);
  } catch {
    errors.push("cannot stat file");
    return errors;
  }
  if (lstat.isSymbolicLink()) {
    errors.push("symlink not allowed");
    return errors;
  }

  try {
    const real = realpathSync(file);
    const realRelative = path.relative(rootDir, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      errors.push("unsafe path after realpath");
      return errors;
    }
  } catch {
    errors.push("cannot resolve realpath");
    return errors;
  }

  const inferred = getInferredFormat(file);
  if (inferred === null) {
    errors.push("unrecognized file extension");
  } else if (inferred !== item.format) {
    errors.push(`format mismatch: declared ${item.format}, inferred ${inferred}`);
  }

  const stat = statSync(file);
  const actualKb = Math.round(stat.size / 1024);
  const actualMb = +(stat.size / 1024 / 1024).toFixed(1);

  if (item.size_budget_kb && stat.size > item.size_budget_kb * 1024) {
    errors.push(`size ${actualKb} KB exceeds budget ${item.size_budget_kb} KB`);
  }
  if (item.size_budget_mb && stat.size > item.size_budget_mb * 1024 * 1024) {
    errors.push(`size ${actualMb} MB exceeds budget ${item.size_budget_mb} MB`);
  }

  if (item.sha256) {
    const actual = sha256(file);
    if (actual !== item.sha256) {
      errors.push(`sha256 mismatch: expected ${item.sha256}, got ${actual}`);
    }
  }

  if (requireDimensions && item.dimensions) {
    const declared = parseDimensions(item.dimensions);
    if (!declared) {
      errors.push(`cannot parse declared dimensions: ${item.dimensions}`);
    } else {
      if (inferred === "png" || inferred === "webp" || inferred === "svg") {
        const dims = parseImageDimensions(file, inferred);
        if (!dims) {
          errors.push(`cannot parse ${inferred} dimensions`);
        } else if (
          Math.abs(dims.width - declared.width) > 1 ||
          Math.abs(dims.height - declared.height) > 1
        ) {
          errors.push(`dimensions mismatch: declared ${item.dimensions}, actual ${dims.width}x${dims.height}`);
        }
      }
    }
  }

  if (inferred === "mp4") {
    const videoRequired = ["duration_s", "fps", "codec", "pix_fmt", "audio"];
    for (const field of videoRequired) {
      if (item[field] === undefined || item[field] === null) {
        errors.push(`missing required video field: ${field}`);
      }
    }
    const meta = ffprobeFn(file);
    if (!meta) {
      errors.push("ffprobe failed");
    } else {
      const video = meta.streams.find((s) => s.codec_type === "video");
      if (!video) {
        errors.push("no video stream");
      } else {
        if (item.codec && !video.codec_name?.toLowerCase().startsWith(item.codec.toLowerCase())) {
          errors.push(`codec mismatch: ${video.codec_name}`);
        }
        if (item.pix_fmt && video.pix_fmt !== item.pix_fmt) {
          errors.push(`pix_fmt mismatch: ${video.pix_fmt}`);
        }
        if (item.fps) {
          const fps = parseFrameRate(video.r_frame_rate);
          if (!Number.isFinite(fps)) {
            errors.push(`invalid frame rate: ${video.r_frame_rate}`);
          } else if (Math.abs(fps - item.fps) > 0.1) {
            errors.push(`fps mismatch: ${video.r_frame_rate}`);
          }
        }
        if (item.dimensions) {
          const declared = parseDimensions(item.dimensions);
          if (
            declared &&
            (Math.abs(video.width - declared.width) > 1 || Math.abs(video.height - declared.height) > 1)
          ) {
            errors.push(`video dimensions mismatch: ${video.width}x${video.height}`);
          }
        }
        if (item.audio === false && meta.streams.some((s) => s.codec_type === "audio")) {
          errors.push("unexpected audio stream");
        }
      }
      if (item.duration_s && meta.format?.duration) {
        const duration = Number(meta.format.duration);
        if (Number.isFinite(duration) && Math.abs(duration - Number(item.duration_s)) > 0.5) {
          errors.push(`duration mismatch: ${duration}s`);
        }
      }
    }
    if (item.faststart === true) {
      const fast = isFastStart(file);
      if (fast === false) errors.push("faststart missing (moov not before mdat)");
      if (fast === null) errors.push("could not verify faststart");
    }
  }

  return errors;
}

export function listExpectedAssets(rootDir, dirs = DEFAULT_ASSET_DIRS) {
  const found = [];
  for (const { dir, include } of dirs) {
    const abs = path.join(rootDir, dir);
    if (!existsSync(abs)) continue;
    const patterns = include.map((g) => new RegExp("^" + g.replace(/\*/g, ".*") + "$"));
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && patterns.some((p) => p.test(entry.name))) {
        found.push(path.join(dir, entry.name));
      }
    }
  }
  return found;
}

export function validateManifest(
  manifest,
  { rootDir = root, expectedAssets = null, assetDirs = DEFAULT_ASSET_DIRS } = {},
) {
  const errors = [];
  const all = [...(manifest.images || []), ...(manifest.videos || [])];

  if (!Array.isArray(manifest.images) && !Array.isArray(manifest.videos)) {
    errors.push("manifest has no images or videos arrays");
    return errors;
  }
  if (all.length === 0) {
    errors.push("manifest is empty");
  }

  const seen = new Set();
  const manifestPaths = new Set();
  for (const item of all) {
    manifestPaths.add(item.path);
    const entryErrors = validateEntry(item, { rootDir, seen });
    if (entryErrors.length) {
      for (const e of entryErrors) errors.push(`${item.path || "<unnamed>"}: ${e}`);
    }
  }

  const expected = expectedAssets || listExpectedAssets(rootDir, assetDirs);
  for (const p of expected) {
    if (!manifestPaths.has(p)) {
      errors.push(`missing manifest entry for tracked asset: ${p}`);
    }
  }

  return errors;
}

const DEFAULT_ASSET_DIRS = [
  { dir: "docs/assets", include: ["*.webp", "*.png", "*.svg"] },
  { dir: "marketing/renders", include: ["*.png"] },
  { dir: "marketing/video/hyperframes", include: ["*.mp4"] },
];

function main() {
  const manifestPath = path.join(root, "marketing", "asset-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const errors = validateManifest(manifest, { rootDir: root });

  if (errors.length) {
    for (const e of errors) console.error(`ERROR: ${e}`);
    console.error("Asset manifest validation failed.");
    process.exit(1);
  }
  for (const item of [...(manifest.images || []), ...(manifest.videos || [])]) {
    console.log(`OK: ${item.path}`);
  }
  console.log("Asset manifest validated.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
