"use strict";

const ImageConverter = (() => {
  const MAX_FILE_MB = 40;
  const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
  const MAX_PIXELS = 50 * 1000 * 1000;
  const HEIF_SCRIPT_URL =
    "https://cdn.jsdelivr.net/npm/libheif-js@1.23.5/libheif-wasm/libheif-bundle.js";
  // Every brand a HEIC photo can carry, including the sequence brands: those are rejected by the
  // decoded-image count instead, so one message covers burst and animated HEIF files alike.
  // AVIF is deliberately absent: its AV1 codec is not in the decoder bundle this site loads.
  const HEIF_BRANDS = new Set([
    "heic",
    "heix",
    "heim",
    "heis",
    "hevm",
    "hevs",
    "hevc",
    "hevx",
    "mif1",
    "msf1",
    "heif",
  ]);
  const OUTPUTS = [
    {
      id: "jpeg",
      label: "JPEG (.jpg)",
      mime: "image/jpeg",
      extension: ".jpg",
      lossy: true,
      opaque: true,
    },
    {
      id: "png",
      label: "PNG (.png)",
      mime: "image/png",
      extension: ".png",
      lossy: false,
      opaque: false,
    },
    {
      id: "webp",
      label: "WebP (.webp)",
      mime: "image/webp",
      extension: ".webp",
      lossy: true,
      opaque: false,
    },
  ];
  function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function text(bytes, offset, length) {
    let value = "";
    for (let index = 0; index < length; index++)
      value += String.fromCharCode(bytes[offset + index] || 0);
    return value;
  }

  function uint32(bytes, offset, littleEndian = false) {
    let value = 0;
    for (let index = 0; index < 4; index++)
      // Accumulate most significant byte first, whichever end the container stores it at.
      value =
        value * 256 + (bytes[offset + (littleEndian ? 3 - index : index)] || 0);
    return value;
  }

  function matches(bytes, offset, values) {
    return values.every((value, index) => bytes[offset + index] === value);
  }

  /** Returns jpeg, png, webp or heif from the file's own signature, or null when unrecognised. */
  function detectFormat(bytes) {
    if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
    if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      return "png";
    if (text(bytes, 0, 4) === "RIFF" && text(bytes, 8, 4) === "WEBP")
      return "webp";
    if (text(bytes, 4, 4) === "ftyp" && HEIF_BRANDS.has(text(bytes, 8, 4)))
      return "heif";
    return null;
  }

  function pngAnimated(bytes) {
    // acTL must appear before the first IDAT, so stop there rather than scanning the whole file.
    for (let offset = 8; offset + 8 <= bytes.length; ) {
      const type = text(bytes, offset + 4, 4);
      if (type === "acTL") return true;
      if (type === "IDAT") return false;
      offset += 12 + uint32(bytes, offset);
    }
    return false;
  }

  function webpAnimated(bytes) {
    for (let offset = 12; offset + 8 <= bytes.length; ) {
      const type = text(bytes, offset, 4);
      if (type === "ANMF") return true;
      if (!/^[A-Z0-9 ]{4}$/.test(type)) return false;
      const size = uint32(bytes, offset + 4, true);
      offset += 8 + size + (size % 2);
    }
    return false;
  }

  /**
   * Reports animated inputs, which would otherwise be reduced to one frame without telling the
   * user. Multi-image HEIF files are caught after decoding, where the frame count is known.
   */
  function animatedFormat(bytes, format) {
    if (format === "png" && pngAnimated(bytes)) return "png";
    if (format === "webp" && webpAnimated(bytes)) return "webp";
    return null;
  }

  /** Returns the download name: the input's base name with the selected output extension. */
  function outputName(name, extension) {
    const dot = name.lastIndexOf(".");
    return `${dot > 0 ? name.slice(0, dot) : name || "image"}${extension}`;
  }

  /**
   * Rejects images this conversion cannot hold. Canvas limits differ per browser, so the pixel
   * ceiling is documented rather than derived, and oversized input fails before it is allocated.
   */
  function checkSize(width, height) {
    if (!(width > 0 && height > 0))
      throw failure("decode", "This image has no readable dimensions.");
    if (width * height > MAX_PIXELS)
      throw failure(
        "pixels",
        `That image is ${Math.round((width * height) / 1e6)} megapixels, above the ${Math.round(MAX_PIXELS / 1e6)} megapixel limit.`,
      );
  }

  let heifPromise = null;
  let heifDecoder = null;

  function loadHeif() {
    // The 2 MB decoder is fetched only for HEIC input. It loads through a script element rather
    // than a dynamic import because a browser caches a failed module resolution for the whole
    // document, which would turn one dropped connection into a permanent failure.
    if (!heifPromise)
      heifPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = HEIF_SCRIPT_URL;
        script.onload = () =>
          window.libheif
            ? resolve(window.libheif())
            : reject(
                failure(
                  "codec",
                  "The HEIC decoder could not start. Convert the image again.",
                ),
              );
        script.onerror = () => {
          script.remove();
          reject(
            failure(
              "codec",
              "The HEIC decoder could not load. Check your connection, then convert the image again.",
            ),
          );
        };
        document.head.append(script);
      }).catch((error) => {
        heifPromise = null;
        throw error;
      });
    return heifPromise;
  }

  async function decodeNative(bytes) {
    let bitmap;
    try {
      // createImageBitmap applies the file's own orientation by default, so the output matches
      // what the user already sees in their photo app.
      bitmap = await createImageBitmap(new Blob([bytes]));
    } catch {
      throw failure(
        "decode",
        "This image could not be read. Choose a valid image file and try again.",
      );
    }
    checkSize(bitmap.width, bitmap.height);
    return { bitmap, width: bitmap.width, height: bitmap.height };
  }

  async function decodeHeif(bytes, onStage) {
    onStage?.("codec");
    const heif = await loadHeif();
    // One decoder instance is reused: decoding again is what releases the previous HEIF context.
    heifDecoder ??= new heif.HeifDecoder();
    const images = heifDecoder.decode(bytes);
    if (!images.length)
      throw failure(
        "decode",
        "This HEIC file could not be read. Choose a HEIC photo and try again.",
      );
    if (images.length > 1) {
      for (const extra of images) extra.free();
      throw failure(
        "multiple",
        `This file holds ${images.length} images. Choose a file with a single still image.`,
      );
    }
    const image = images[0];
    try {
      const width = image.get_width(),
        height = image.get_height();
      checkSize(width, height);
      const pixels = new ImageData(width, height);
      await new Promise((resolve, reject) =>
        image.display(pixels, (displayed) =>
          displayed
            ? resolve()
            : reject(
                failure("decode", "This HEIC photo could not be decoded."),
              ),
        ),
      );
      const bitmap = await createImageBitmap(pixels);
      return { bitmap, width, height };
    } finally {
      image.free();
    }
  }

  async function encode(source, output, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d");
    // JPEG has no alpha channel: composite over white instead of turning transparency black.
    if (output.opaque) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, source.width, source.height);
    }
    context.drawImage(source.bitmap, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, output.mime, output.lossy ? quality : undefined),
    );
    canvas.width = canvas.height = 0;
    if (!blob)
      throw failure(
        "encode",
        "Your browser could not encode this image. Try another output format, or a smaller image.",
      );
    // toBlob silently returns PNG bytes for an encoder the browser lacks; never relabel them.
    if (blob.type !== output.mime)
      throw failure(
        "encoder",
        `Your browser cannot create ${output.label} files. Choose another output format.`,
      );
    return { blob, width: source.width, height: source.height };
  }

  /** Reports whether this browser can really encode one output format, before the user picks it. */
  async function encoderSupport(output) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, output.mime),
    );
    return Boolean(blob) && blob.type === output.mime;
  }

  /**
   * Converts one file to the selected output format entirely on this device.
   * onStage is optional and reports "codec" before the one-off HEIC decoder download.
   */
  async function convert(file, output, quality, onStage) {
    if (!file.size) throw failure("empty", "Choose a non-empty image file.");
    if (file.size > MAX_FILE_BYTES)
      throw failure(
        "file-size",
        `That file is larger than the ${MAX_FILE_MB} MB limit. Choose a smaller image.`,
      );
    const bytes = new Uint8Array(await file.arrayBuffer());
    const format = detectFormat(bytes);
    if (!format)
      throw failure(
        "unsupported",
        "Choose a HEIC, JPEG, PNG or WebP image. Other file types are not supported.",
      );
    if (animatedFormat(bytes, format))
      throw failure(
        "animated",
        "Animated images are not supported. Choose a single still image.",
      );
    const source =
      format === "heif"
        ? await decodeHeif(bytes, onStage)
        : await decodeNative(bytes);
    try {
      return await encode(source, output, quality);
    } finally {
      source.bitmap.close();
    }
  }

  return {
    MAX_FILE_BYTES,
    MAX_PIXELS,
    OUTPUTS,
    animatedFormat,
    convert,
    detectFormat,
    encoderSupport,
    outputName,
  };
})();

if (typeof module !== "undefined" && module.exports)
  module.exports = ImageConverter;
