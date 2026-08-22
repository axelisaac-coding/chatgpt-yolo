const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakePng(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(17);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 0;
  return Buffer.concat([sig, ihdr]);
}

function fakeMp4WithMoovBeforeMdat() {
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 0x14]),
    Buffer.from("ftyp"),
    Buffer.from("isom"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("isom"),
  ]);
  ftyp.writeUInt32BE(ftyp.length, 0);
  const moov = Buffer.concat([Buffer.alloc(4), Buffer.from("moov"), Buffer.from([0, 0, 0, 0])]);
  moov.writeUInt32BE(moov.length, 0);
  const mdat = Buffer.concat([Buffer.alloc(4), Buffer.from("mdat"), Buffer.from([0, 0, 0, 0])]);
  mdat.writeUInt32BE(mdat.length, 0);
  return Buffer.concat([ftyp, moov, mdat]);
}

function fakeMp4WithMdatBeforeMoov() {
  const ftyp = fakeMp4WithMoovBeforeMdat().subarray(0, 20);
  const mdat = Buffer.concat([Buffer.alloc(4), Buffer.from("mdat"), Buffer.from([0, 0, 0, 0])]);
  mdat.writeUInt32BE(mdat.length, 0);
  const moov = Buffer.concat([Buffer.alloc(4), Buffer.from("moov"), Buffer.from([0, 0, 0, 0])]);
  moov.writeUInt32BE(moov.length, 0);
  return Buffer.concat([ftyp, mdat, moov]);
}

test("parseDimensions parses WxH strings", async () => {
  const { parseDimensions } = await import("../scripts/validate-asset-manifest.mjs");
  assert.deepEqual(parseDimensions("1920x1080"), { width: 1920, height: 1080 });
  assert.deepEqual(parseDimensions("1536 x 864"), { width: 1536, height: 864 });
  assert.equal(parseDimensions("not dimensions"), null);
});

test("parseFrameRate parses fraction and number and rejects NaN", async () => {
  const { parseFrameRate } = await import("../scripts/validate-asset-manifest.mjs");
  assert.equal(parseFrameRate("30/1"), 30);
  assert.equal(parseFrameRate(24), 24);
  assert.equal(parseFrameRate("60/2"), 30);
  assert.equal(Number.isFinite(parseFrameRate("not-a-number")), false);
  assert.equal(Number.isFinite(parseFrameRate(NaN)), false);
});

test("parsePngDimensions reads a simple PNG", async () => {
  const { parsePngDimensions } = await import("../scripts/validate-asset-manifest.mjs");
  const buf = fakePng(1920, 1080);
  assert.deepEqual(parsePngDimensions(buf), { width: 1920, height: 1080 });
  assert.equal(parsePngDimensions(Buffer.from("not a png")), null);
});

test("parseWebpDimensions handles VP8X little-endian canvas", async () => {
  const { parseWebpDimensions } = await import("../scripts/validate-asset-manifest.mjs");
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0);
  buf.write("WEBP", 8);
  buf.write("VP8X", 12);
  buf.writeUInt32LE(10, 16);
  buf.writeUInt8(0, 20);
  buf.writeUInt8(0, 21);
  buf.writeUInt8(0, 22);
  buf.writeUInt8(0, 23);
  buf.writeUIntLE(1919, 24, 3);
  buf.writeUIntLE(1079, 27, 3);
  assert.deepEqual(parseWebpDimensions(buf), { width: 1920, height: 1080 });
});

test("parseWebpDimensions reads a real VP8 WebP", async () => {
  const { parseWebpDimensions } = await import("../scripts/validate-asset-manifest.mjs");
  const buf = fs.readFileSync("docs/assets/hero.webp");
  assert.deepEqual(parseWebpDimensions(buf), { width: 1536, height: 864 });
});

test("parseSvgDimensions reads width/height or viewBox", async () => {
  const { parseSvgDimensions } = await import("../scripts/validate-asset-manifest.mjs");
  assert.deepEqual(
    parseSvgDimensions('<svg width="128" height="128" viewBox="0 0 128 128"></svg>'),
    { width: 128, height: 128 },
  );
  assert.deepEqual(parseSvgDimensions('<svg viewBox="0 0 64 48"></svg>'), { width: 64, height: 48 });
  assert.equal(parseSvgDimensions("<svg></svg>"), null);
});

test("isFastStart detects moov before mdat", async () => {
  const { isFastStart } = await import("../scripts/validate-asset-manifest.mjs");
  const dir = tmpDir("fast-");
  const good = path.join(dir, "good.mp4");
  const bad = path.join(dir, "bad.mp4");
  fs.writeFileSync(good, fakeMp4WithMoovBeforeMdat());
  fs.writeFileSync(bad, fakeMp4WithMdatBeforeMoov());
  assert.equal(isFastStart(good), true);
  assert.equal(isFastStart(bad), false);
});

test("validateEntry rejects unsafe path", async () => {
  const { validateEntry } = await import("../scripts/validate-asset-manifest.mjs");
  const seen = new Set();
  const item = { path: "../test.txt", sha256: "abc", format: "png", dimensions: "100x100", size_budget_kb: 1 };
  const errors = validateEntry(item, { rootDir: "/tmp", seen });
  assert.ok(errors.some((e) => e.includes("unsafe path")), errors.join("; "));
});

test("validateEntry rejects missing file and duplicate path", async () => {
  const { validateEntry } = await import("../scripts/validate-asset-manifest.mjs");
  const seen = new Set();
  const item = { path: "missing.txt", sha256: "abc", format: "png", dimensions: "100x100", size_budget_kb: 1 };
  const errors = validateEntry(item, { rootDir: "/tmp", seen });
  assert.ok(errors.some((e) => e.includes("file missing")), errors.join("; "));

  const seen2 = new Set();
  validateEntry({ path: "x/y.txt", sha256: "abc", format: "png", dimensions: "1x1", size_budget_kb: 1 }, { rootDir: "/nonexistent", seen: seen2 });
  const dupErrors = validateEntry({ path: "x/y.txt", sha256: "def", format: "png", dimensions: "1x1", size_budget_kb: 1 }, { rootDir: "/nonexistent", seen: seen2 });
  assert.ok(dupErrors.some((e) => e.includes("duplicate path")), dupErrors.join("; "));
});

test("validateEntry rejects declared image with unparsable dimensions", async () => {
  const { validateEntry } = await import("../scripts/validate-asset-manifest.mjs");
  const dir = tmpDir("img-");
  const file = path.join(dir, "test.png");
  fs.writeFileSync(file, Buffer.from("not a png"));
  const seen = new Set();
  const errors = validateEntry(
    { path: path.relative(dir, file), sha256: "abc", format: "png", dimensions: "100x100", size_budget_kb: 1 },
    { rootDir: dir, seen },
  );
  assert.ok(errors.some((e) => e.includes("sha256 mismatch")), errors.join("; "));
  assert.ok(errors.some((e) => e.includes("cannot parse png dimensions")), errors.join("; "));
});

test("validateEntry validates a real PNG and rejects dimension mismatch", async () => {
  const { validateEntry } = await import("../scripts/validate-asset-manifest.mjs");
  const dir = tmpDir("png-");
  const file = path.join(dir, "test.png");
  fs.writeFileSync(file, fakePng(100, 50));
  const crypto = require("node:crypto");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const seen = new Set();
  const good = { path: "test.png", sha256: sha, format: "png", dimensions: "100x50", size_budget_kb: 1 };
  assert.deepEqual(validateEntry(good, { rootDir: dir, seen }), []);

  const bad = { path: "test.png", sha256: sha, format: "png", dimensions: "1x1", size_budget_kb: 1 };
  const seen2 = new Set();
  const errors = validateEntry(bad, { rootDir: dir, seen: seen2 });
  assert.ok(errors.some((e) => e.includes("dimensions mismatch")), errors.join("; "));
});

test("validateEntry validates MP4 metadata via ffprobe", async () => {
  const { validateEntry } = await import("../scripts/validate-asset-manifest.mjs");
  const dir = tmpDir("mp4-");
  const ffprobeOut = {
    streams: [{
      codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p",
      width: 1920, height: 1080, r_frame_rate: "30/1",
    }],
    format: { duration: "44.5" },
  };
  const file = path.join(dir, "test.mp4");
  fs.writeFileSync(file, fakeMp4WithMoovBeforeMdat());
  const sha = require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const item = {
    path: "test.mp4", sha256: sha, format: "mp4", dimensions: "1920x1080",
    duration_s: "44.5", fps: 30, codec: "h264", pix_fmt: "yuv420p",
    audio: false, faststart: true, size_budget_mb: 35,
  };
  const result = validateEntry(item, { rootDir: dir, seen: new Set(), ffprobeFn: () => ffprobeOut });
  assert.deepEqual(result, []);
});

test("validateEntry rejects MP4 with audio, missing video stream, or bad fps", async () => {
  const { validateEntry } = await import("../scripts/validate-asset-manifest.mjs");
  const dir = tmpDir("mp4-");
  const file = path.join(dir, "test.mp4");
  fs.writeFileSync(file, fakeMp4WithMoovBeforeMdat());
  const sha = require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const base = {
    path: "test.mp4", sha256: sha, format: "mp4", dimensions: "1920x1080",
    duration_s: "44.5", fps: 30, codec: "h264", pix_fmt: "yuv420p",
    audio: false, faststart: true, size_budget_mb: 35,
  };
  const noVideo = validateEntry(base, {
    rootDir: dir, seen: new Set(),
    ffprobeFn: () => ({ streams: [{ codec_type: "audio" }], format: { duration: "44.5" } }),
  });
  assert.ok(noVideo.some((e) => e.includes("no video stream") || e.includes("unexpected audio stream")), noVideo.join("; "));
  const badFps = validateEntry(base, {
    rootDir: dir, seen: new Set(),
    ffprobeFn: () => ({ streams: [{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1920, height: 1080, r_frame_rate: "bad" }], format: { duration: "44.5" } }),
  });
  assert.ok(badFps.some((e) => e.includes("invalid frame rate")), badFps.join("; "));
});

test("validateManifest rejects empty manifest and omitted assets", async () => {
  const { validateManifest } = await import("../scripts/validate-asset-manifest.mjs");
  const dir = tmpDir("manifest-");
  fs.writeFileSync(path.join(dir, "existing.png"), fakePng(1, 1));

  const emptyErrors = validateManifest({ images: [] }, { rootDir: dir });
  assert.ok(emptyErrors.some((e) => e.includes("manifest is empty")), emptyErrors.join("; "));

  const missingErrors = validateManifest(
    { images: [{ path: "other.png", sha256: "abc", format: "png", dimensions: "1x1", size_budget_kb: 1 }] },
    { rootDir: dir, expectedAssets: ["existing.png"] },
  );
  assert.ok(missingErrors.some((e) => e.includes("missing manifest entry")), missingErrors.join("; "));
});
