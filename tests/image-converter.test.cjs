"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const {
  MAX_FILE_BYTES,
  MAX_PIXELS,
  OUTPUTS,
  animatedFormat,
  detectFormat,
  outputName,
} = require("../src/image-converter.js");

const text = (value) => [...value].map((character) => character.charCodeAt(0));
const uint32BE = (value) =>
  [24, 16, 8, 0].map((shift) => (value >>> shift) & 255);
const uint32LE = (value) =>
  [0, 8, 16, 24].map((shift) => (value >>> shift) & 255);
const pngChunk = (type, payload = []) => [
  ...uint32BE(payload.length),
  ...text(type),
  ...payload,
  0,
  0,
  0,
  0,
];
const webpChunk = (type, payload = []) => [
  ...text(type),
  ...uint32LE(payload.length),
  ...payload,
  ...(payload.length % 2 ? [0] : []),
];
const png = (...chunks) =>
  Uint8Array.from([0x89, ...text("PNG\r\n\x1a\n"), ...chunks.flat()]);
const webp = (...chunks) =>
  Uint8Array.from([
    ...text("RIFF"),
    ...uint32LE(0),
    ...text("WEBP"),
    ...chunks.flat(),
  ]);
const heif = (brand) =>
  Uint8Array.from([...uint32BE(24), ...text("ftyp"), ...text(brand)]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const ihdr = pngChunk("IHDR", new Array(13).fill(0));
const vp8x = webpChunk("VP8X", [2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

/**
 * Ensures inputs are recognised from their own bytes, because camera files frequently arrive
 * with an empty MIME type and an extension cannot prove which codec is inside.
 */
test("detects the supported formats from file signatures", () => {
  assert.equal(detectFormat(jpeg), "jpeg");
  assert.equal(detectFormat(png(ihdr)), "png");
  assert.equal(detectFormat(webp(vp8x)), "webp");
  for (const brand of ["heic", "heix", "heim", "hevc", "mif1", "msf1", "heif"])
    assert.equal(detectFormat(heif(brand)), "heif", brand);
});

/** Ensures formats outside the published matrix, including AVIF and plain text, are refused. */
test("refuses formats outside the matrix", () => {
  for (const bytes of [
    heif("avif"),
    heif("qt  "),
    Uint8Array.from(text("GIF89a....")),
    Uint8Array.from(text("%PDF-1.7\n")),
    Uint8Array.from(text("RIFF....AVI LIST")),
    new Uint8Array(4),
    new Uint8Array(0),
  ])
    assert.equal(detectFormat(bytes), null, String(bytes));
});

/**
 * Ensures animated inputs are reported instead of quietly keeping their first frame, and that
 * the PNG and WebP chunk walks read their big- and little-endian lengths correctly.
 */
test("detects animated PNG and WebP inputs", () => {
  assert.equal(
    animatedFormat(
      png(ihdr, pngChunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0])),
      "png",
    ),
    "png",
  );
  assert.equal(
    animatedFormat(
      webp(vp8x, webpChunk("ANIM", new Array(6).fill(0)), webpChunk("ANMF")),
      "webp",
    ),
    "webp",
  );
  // A trailing acTL is not animation, and neither is a still VP8 or VP8L payload.
  assert.equal(
    animatedFormat(png(ihdr, pngChunk("IDAT"), pngChunk("acTL")), "png"),
    null,
  );
  assert.equal(animatedFormat(webp(vp8x, webpChunk("VP8 ")), "webp"), null);
  assert.equal(animatedFormat(webp(vp8x, webpChunk("VP8L")), "webp"), null);
  assert.equal(animatedFormat(jpeg, "jpeg"), null);
  assert.equal(animatedFormat(png(ihdr), "png"), null);
});

/** Ensures valid unknown FourCC chunks cannot hide animation, including odd-length padding. */
test("detects WebP animation after unknown chunks", () => {
  for (const type of ["test", "x!  "])
    assert.equal(
      animatedFormat(
        webp(vp8x, webpChunk(type, [1, 2, 3]), webpChunk("ANMF")),
        "webp",
      ),
      "webp",
      type,
    );
  assert.equal(
    animatedFormat(webp(webpChunk("test", text("ANMF"))), "webp"),
    null,
  );
});

/** Ensures a rejected native bitmap is released before conversion can transfer its ownership. */
test("closes native bitmaps whose dimensions fail validation", async () => {
  const source = readFileSync(
    require.resolve("../src/image-converter.js"),
    "utf8",
  );
  for (const [width, height, code] of [
    [8000, 7000, "pixels"],
    [0, 1, "decode"],
  ]) {
    let closes = 0;
    const context = {
      Blob,
      createImageBitmap: async () => ({
        width,
        height,
        close: () => closes++,
      }),
      module: { exports: {} },
    };
    runInNewContext(source, context);
    await assert.rejects(
      context.module.exports.convert(new Blob([jpeg]), OUTPUTS[0], 0.9),
      (error) => error.code === code,
    );
    assert.equal(closes, 1, `${width} x ${height}`);
  }
});

/** Ensures downloads keep the user's base name and gain the selected output extension. */
test("derives the output filename", () => {
  assert.equal(outputName("IMG_0276.HEIC", ".jpg"), "IMG_0276.jpg");
  assert.equal(outputName("photo.jpeg", ".png"), "photo.png");
  assert.equal(outputName("holiday.beach.png", ".webp"), "holiday.beach.webp");
  assert.equal(outputName("photo", ".jpg"), "photo.jpg");
  assert.equal(outputName("", ".jpg"), "image.jpg");
  assert.equal(outputName(".hidden", ".jpg"), ".hidden.jpg");
});

/** Keeps the conversion table and the limits in agreement with the published documentation. */
test("publishes the documented outputs and limits", () => {
  assert.deepEqual(
    OUTPUTS.map(({ id, mime, extension, lossy, opaque }) => ({
      id,
      mime,
      extension,
      lossy,
      opaque,
    })),
    [
      {
        id: "jpeg",
        mime: "image/jpeg",
        extension: ".jpg",
        lossy: true,
        opaque: true,
      },
      {
        id: "png",
        mime: "image/png",
        extension: ".png",
        lossy: false,
        opaque: false,
      },
      {
        id: "webp",
        mime: "image/webp",
        extension: ".webp",
        lossy: true,
        opaque: false,
      },
    ],
  );
  assert.equal(MAX_FILE_BYTES, 40 * 1024 * 1024);
  assert.equal(MAX_PIXELS, 50 * 1000 * 1000);
});
