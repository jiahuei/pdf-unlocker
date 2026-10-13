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
  embedExif,
  outputName,
  resetOrientation,
  sourceExif,
} = require("../src/image-converter.js");
const { crc32 } = require("node:zlib");

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
const uint16BE = (value) => [value >> 8, value & 255];
const uint16LE = (value) => [value & 255, value >> 8];
// SOI, an APP0 segment, the start of scan and EOI: enough for the segment walk.
const jpegFile = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 4, 0xaa, 0xbb, 0xff, 0xda, 0, 2, 0xff, 0xd9,
]);

/** Builds a one-entry TIFF holding an Orientation tag, in the requested byte order. */
function tiff(littleEndian, orientation) {
  const uint16 = littleEndian ? uint16LE : uint16BE;
  const uint32 = littleEndian ? uint32LE : uint32BE;
  return Uint8Array.from([
    ...text(littleEndian ? "II" : "MM"),
    ...uint16(42),
    ...uint32(8), // IFD0 follows the header immediately
    ...uint16(1), // one entry
    ...uint16(0x0112), // Orientation
    ...uint16(3), // SHORT
    ...uint32(1), // count
    ...uint16(orientation),
    0,
    0,
    ...uint32(0), // no next IFD
  ]);
}

/** Reads the Orientation value back out of the fixture layout above. */
function orientationOf(bytes, littleEndian) {
  const value = bytes.subarray(18, 20);
  return littleEndian ? value[0] | (value[1] << 8) : (value[0] << 8) | value[1];
}
const readUint32BE = (bytes, offset) =>
  ((bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>>
  0;
const readUint32LE = (bytes, offset) =>
  ((bytes[offset + 3] << 24) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 1] << 8) |
    bytes[offset]) >>>
  0;
const fourcc = (bytes, offset) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));
const pngFile = png(ihdr, pngChunk("IDAT", [1, 2, 3]), pngChunk("IEND"));
const webpFile = webp(webpChunk("VP8 ", [1, 2, 3, 4]));

/**
 * Ensures retained EXIF is marked upright. The converted pixels are already rotated, so copying
 * the source value would make viewers rotate the output a second time.
 */
test("resets the orientation of retained EXIF", () => {
  for (const littleEndian of [true, false]) {
    const source = tiff(littleEndian, 6);
    const reset = resetOrientation(Uint8Array.from(source));
    assert.equal(orientationOf(reset, littleEndian), 1, `${littleEndian}`);
    // Only the two value bytes change; every other byte is copied through.
    for (const [index, byte] of source.entries())
      if (index < 18 || index > 19)
        assert.equal(reset[index], byte, `byte ${index}`);
  }
  // A block with no entries, and a truncated header, are returned untouched rather than parsed.
  for (const partial of [
    [...text("II"), 42, 0, 8, 0, 0, 0, 0, 0, 0],
    [...text("MM"), 0, 42],
  ])
    assert.deepEqual(
      resetOrientation(Uint8Array.from(partial)),
      Uint8Array.from(partial),
    );
});

/** Ensures the transplant is readable from each container and leaves the image data intact. */
test("embeds EXIF into JPEG, PNG and WebP output", () => {
  const source = tiff(true, 6);
  for (const input of [jpegFile, pngFile, webpFile])
    assert.equal(
      sourceExif(
        input,
        input === jpegFile ? "jpeg" : input === pngFile ? "png" : "webp",
      ),
      null,
      "a canvas-style output carries no EXIF before the transplant",
    );

  const jpegOut = embedExif("image/jpeg", jpegFile, source, 4, 3);
  assert.deepEqual(
    jpegOut.subarray(0, 12),
    Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe1,
      0,
      source.length + 8,
      ...text("Exif"),
      0,
      0,
    ]),
  );
  assert.deepEqual(jpegOut.subarray(12 + source.length), jpegFile.subarray(2));
  assert.deepEqual(sourceExif(jpegOut, "jpeg"), source);

  const pngOut = embedExif("image/png", pngFile, source, 4, 3);
  const at = 8 + 12 + 13; // signature plus the whole IHDR chunk
  assert.equal(readUint32BE(pngOut, at), source.length);
  assert.deepEqual(
    pngOut.subarray(at + 4, at + 8),
    Uint8Array.from(text("eXIf")),
  );
  // The CRC is checked against an independent implementation, as viewers reject a bad one.
  assert.equal(
    readUint32BE(pngOut, at + 8 + source.length),
    crc32(pngOut.subarray(at + 4, at + 8 + source.length)),
  );
  assert.deepEqual(pngOut.subarray(0, at), pngFile.subarray(0, at));
  assert.deepEqual(
    pngOut.subarray(at + 12 + source.length),
    pngFile.subarray(at),
  );
  assert.deepEqual(sourceExif(pngOut, "png"), source);

  const webpOut = embedExif("image/webp", webpFile, source, 4, 3);
  assert.deepEqual(webpOut.subarray(0, 4), Uint8Array.from(text("RIFF")));
  assert.equal(readUint32LE(webpOut, 4), webpOut.length - 8);
  assert.deepEqual(webpOut.subarray(8, 16), Uint8Array.from(text("WEBPVP8X")));
  assert.equal(webpOut[20] & 0x08, 0x08, "the EXIF feature is declared");
  assert.deepEqual([...webpOut.subarray(24, 30)], [3, 0, 0, 2, 0, 0]);
  assert.deepEqual(sourceExif(webpOut, "webp"), source);
  const exifAt = webpOut.length - 8 - source.length - (source.length % 2);
  assert.equal(
    fourcc(webpOut, exifAt),
    "EXIF",
    "the EXIF chunk follows the image data",
  );
  assert.deepEqual(webpOut.subarray(exifAt + 8), source);
  // An existing extended header keeps its other feature flags.
  const extended = webp(
    webpChunk("VP8X", [0x10, 0, 0, 0, 3, 0, 0, 2, 0, 0]),
    webpChunk("VP8 ", [1, 2, 3, 4]),
  );
  const extendedOut = embedExif("image/webp", extended, source, 4, 3);
  assert.equal(
    extendedOut[20] & 0x18,
    0x18,
    "animation and EXIF flags coexist",
  );
  assert.deepEqual(sourceExif(extendedOut, "webp"), source);
});

/** Ensures EXIF that cannot fit a JPEG segment is refused rather than written out of spec. */
test("refuses EXIF too large for a JPEG segment", () => {
  const largest = new Uint8Array(0xffff - 8);
  assert.ok(embedExif("image/jpeg", jpegFile, largest, 4, 3));
  assert.equal(
    embedExif("image/jpeg", jpegFile, new Uint8Array(largest.length + 1), 4, 3),
    null,
  );
  // PNG and WebP carry a 32-bit length, so the same block still fits.
  assert.ok(embedExif("image/png", pngFile, largest, 4, 3));
  assert.ok(embedExif("image/webp", webpFile, largest, 4, 3));
});

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
