"use strict";

const ImageConverter = (() => {
  const MAX_FILE_MB = 40;
  const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
  const MAX_PIXELS = 50 * 1000 * 1000;
  const TIFF_LITTLE = [0x49, 0x49, 0x2a, 0x00]; // "II" with a 42 magic number
  const TIFF_BIG = [0x4d, 0x4d, 0x00, 0x2a]; // "MM" with the same magic number
  // A JPEG application segment carries a 16-bit length that includes its own two bytes.
  const MAX_JPEG_EXIF = 0xffff - 2 - 6;
  const HEIF_SCRIPT_URL = "vendor/libheif-1.23.6/libheif-bundle.js";
  const HEIF_STILL_BRANDS = new Set(["heic", "heix", "mif1", "heif"]);
  const HEIF_SEQUENCE_BRANDS = new Set([
    "hevc",
    "hevx",
    "hevm",
    "hevs",
    "msf1",
  ]);
  const HEIF_LAYERED_BRANDS = new Set(["heim", "heis"]);
  // Every brand that can identify a HEIF file. Detection trusts the major brand alone, because
  // compatible brands only declare extra conformance: a still photo may list a sequence profile,
  // and a general ISO-BMFF container may list a HEIF one.
  const HEIF_MAJOR_BRANDS = new Set([
    ...HEIF_STILL_BRANDS,
    ...HEIF_SEQUENCE_BRANDS,
    ...HEIF_LAYERED_BRANDS,
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

  function uint16(bytes, offset, littleEndian = false) {
    const first = bytes[offset] || 0,
      second = bytes[offset + 1] || 0;
    return littleEndian ? first | (second << 8) : (first << 8) | second;
  }

  function matches(bytes, offset, values) {
    return values.every((value, index) => bytes[offset + index] === value);
  }

  const ascii = (value) =>
    [...value].map((character) => character.charCodeAt(0));

  function concat(...parts) {
    const joined = new Uint8Array(
      parts.reduce((total, part) => total + part.length, 0),
    );
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return joined;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** Reads complete brands within the ftyp box, retaining a readable major on truncated input. */
  function fileTypeBrands(bytes) {
    if (text(bytes, 4, 4) !== "ftyp") return [];
    let length = uint32(bytes, 0);
    let start = 8;
    if (length === 1) {
      if (bytes.length < 16) return [];
      // The size only bounds a scan of this in-memory file, so even very large sizes are safe
      // to clamp to bytes.length without relying on exact integers above Number.MAX_SAFE_INTEGER.
      length = uint32(bytes, 8) * 2 ** 32 + uint32(bytes, 12);
      start = 16;
    } else if (length === 0) length = bytes.length;
    if (length < start + 8 || bytes.length < start + 4) return [];
    const brands = [text(bytes, start, 4)];
    // Preserve recognition of corrupt HEIFs so the decoder can report an unreadable image.
    const end = Math.min(length, bytes.length);
    for (let offset = start + 8; offset + 4 <= end; offset += 4)
      brands.push(text(bytes, offset, 4));
    return brands;
  }

  /** Returns jpeg, png, webp or heif from the file's own signature, or null when unrecognised. */
  function detectFormat(bytes) {
    if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
    if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      return "png";
    if (text(bytes, 0, 4) === "RIFF" && text(bytes, 8, 4) === "WEBP")
      return "webp";
    const brands = fileTypeBrands(bytes);
    // AVIF also carries generic HEIF brands, but its AV1 codec is not in our decoder bundle.
    if (brands.includes("avif") || brands.includes("avis")) return null;
    // Only the major brand says what a file is. Treating compatible brands as identification
    // would pull unrelated ISO-BMFF containers into the HEIF path, where they download the 2 MB
    // decoder before failing inside it instead of being refused as an unsupported type.
    return HEIF_MAJOR_BRANDS.has(brands[0]) ? "heif" : null;
  }

  /** Walks whole PNG chunks, stopping at a truncated one instead of reading past the file. */
  function* pngChunks(bytes) {
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const length = uint32(bytes, offset);
      if (length + 12 > bytes.length - offset) return;
      yield { type: text(bytes, offset + 4, 4), start: offset + 8, length };
      offset += 12 + length;
    }
  }

  /** Walks whole WebP chunks. Unknown FourCCs are allowed, including lowercase names. */
  function* webpChunks(bytes) {
    for (let offset = 12; offset + 8 <= bytes.length; ) {
      const length = uint32(bytes, offset + 4, true);
      const next = offset + 8 + length + (length % 2);
      if (next > bytes.length) return;
      yield { type: text(bytes, offset, 4), start: offset + 8, length };
      offset = next;
    }
  }

  function pngAnimated(bytes) {
    // acTL must appear before the first IDAT, so stop there rather than scanning the whole file.
    for (const chunk of pngChunks(bytes)) {
      if (chunk.type === "acTL") return true;
      if (chunk.type === "IDAT") return false;
    }
    return false;
  }

  function webpAnimated(bytes) {
    for (const chunk of webpChunks(bytes))
      if (chunk.type === "ANMF") return true;
    return false;
  }

  /** Reports the reason an otherwise recognized container cannot be decoded by this converter. */
  function rejectedContainer(bytes, format) {
    if (format === "png" && pngAnimated(bytes)) return "animated";
    if (format === "webp" && webpAnimated(bytes)) return "animated";
    if (format !== "heif") return null;
    // The major brand is already known to be HEIF-family, because that is what detectFormat
    // requires, so no compatible-brand fallback is reachable here.
    const [major] = fileTypeBrands(bytes);
    if (HEIF_SEQUENCE_BRANDS.has(major)) return "animated";
    if (HEIF_LAYERED_BRANDS.has(major)) return "layered";
    return null;
  }

  /** Returns the download name: the input's base name with the selected output extension. */
  function outputName(name, extension) {
    const dot = name.lastIndexOf(".");
    return `${dot > 0 ? name.slice(0, dot) : name || "image"}${extension}`;
  }

  /**
   * Returns one download name per source name, in order, so a batch never offers two files under
   * the same name. Different source extensions can share one output extension, so collisions get
   * deterministic numeric suffixes that also skip names a source already used.
   */
  function outputNames(names, extension) {
    const allocated = new Set();
    return names.map((name) => {
      const base = outputName(name, extension);
      const stem = base.slice(0, -extension.length);
      let unique = base;
      for (let index = 2; allocated.has(unique); index++)
        unique = `${stem}-${index}${extension}`;
      allocated.add(unique);
      return unique;
    });
  }

  /** Reads each container's EXIF framing before validating the TIFF header. */
  function exifTiff(payload, format) {
    let offset = 0;
    if (format === "heif") {
      if (payload.length < 4) return null;
      // HEIF offsets are relative to the end of this four-byte field, with no fixed prefix limit.
      offset = 4 + uint32(payload, 0);
    } else if (
      format === "jpeg" ||
      (format === "webp" && text(payload, 0, 6) === "Exif\0\0")
    ) {
      if (text(payload, 0, 6) !== "Exif\0\0") return null;
      offset = 6;
    }
    if (
      offset + 8 > payload.length ||
      !(
        matches(payload, offset, TIFF_LITTLE) ||
        matches(payload, offset, TIFF_BIG)
      )
    )
      return null;
    return payload.subarray(offset);
  }

  /** Walks JPEG metadata segments, including legal marker padding, before the scan data. */
  function* jpegSegments(bytes) {
    for (let offset = 2; offset + 4 <= bytes.length; ) {
      if (bytes[offset] !== 0xff) return;
      // JPEG permits repeated 0xff fill bytes before a marker code.
      while (bytes[offset + 1] === 0xff) offset++;
      if (offset + 4 > bytes.length) return;
      const marker = bytes[offset + 1];
      // Scan and end-of-image markers mean no application segment follows.
      if (marker === 0xda || marker === 0xd9) return;
      const length = uint16(bytes, offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return;
      yield {
        marker,
        payload: bytes.subarray(offset + 4, offset + 2 + length),
      };
      offset += 2 + length;
    }
  }

  function exifFromJpeg(bytes) {
    for (const { marker, payload } of jpegSegments(bytes))
      if (marker === 0xe1) {
        const tiff = exifTiff(payload, "jpeg");
        if (tiff) return tiff;
      }
    return null;
  }

  /** Reads MPF's image count so native JPEG decoding cannot silently discard extra pictures. */
  function jpegImageCount(bytes) {
    for (const { marker, payload } of jpegSegments(bytes)) {
      if (marker !== 0xe2 || text(payload, 0, 4) !== "MPF\0") continue;
      const tiff = payload.subarray(4);
      if (
        tiff.length < 8 ||
        !(matches(tiff, 0, TIFF_LITTLE) || matches(tiff, 0, TIFF_BIG))
      )
        continue;
      const little = tiff[0] === 0x49;
      const ifd = uint32(tiff, 4, little);
      if (ifd < 8 || ifd + 2 > tiff.length) continue;
      const entries = uint16(tiff, ifd, little);
      for (let index = 0; index < entries; index++) {
        const entry = ifd + 2 + index * 12;
        if (entry + 12 > tiff.length) break;
        if (
          uint16(tiff, entry, little) === 0xb001 &&
          uint16(tiff, entry + 2, little) === 4 &&
          uint32(tiff, entry + 4, little) === 1
        )
          return uint32(tiff, entry + 8, little);
      }
    }
    return 1;
  }

  function chunkExif(bytes, format) {
    const chunks = format === "png" ? pngChunks(bytes) : webpChunks(bytes);
    const type = format === "png" ? "eXIf" : "EXIF";
    for (const chunk of chunks)
      if (chunk.type === type) {
        const payload = bytes.subarray(chunk.start, chunk.start + chunk.length);
        return exifTiff(payload, format);
      }
    return null;
  }

  /** Returns the EXIF stored inline by JPEG, PNG and WebP; HEIF exposes it through its decoder. */
  function sourceExif(bytes, format) {
    if (format === "jpeg") return exifFromJpeg(bytes);
    if (format === "png" || format === "webp") return chunkExif(bytes, format);
    return null;
  }

  /** Reads the main image's standard EXIF orientation, ignoring malformed or unknown values. */
  function exifOrientation(tiff) {
    if (!tiff || tiff.length < 8) return 1;
    const little = tiff[0] === 0x49;
    const ifd = uint32(tiff, 4, little);
    if (ifd < 8 || ifd + 2 > tiff.length) return 1;
    const entries = uint16(tiff, ifd, little);
    for (let index = 0; index < entries; index++) {
      const entry = ifd + 2 + index * 12;
      if (entry + 12 > tiff.length) break;
      if (
        uint16(tiff, entry, little) === 0x0112 &&
        uint16(tiff, entry + 2, little) === 3 &&
        uint32(tiff, entry + 4, little) === 1
      ) {
        const value = uint16(tiff, entry + 8, little);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
    return 1;
  }

  /**
   * Copies EXIF and updates existing geometry tags to describe the already upright output.
   * Only IFD0 and its Exif IFD describe the main image; thumbnail IFDs keep their own geometry.
   */
  function normalizeExif(source, width, height) {
    if (!source) return null;
    const tiff = Uint8Array.from(source);
    if (tiff.length < 8) return tiff;
    const little = tiff[0] === 0x49;
    const view = new DataView(tiff.buffer);
    function updateIfd(ifd, values) {
      if (ifd < 8 || ifd + 2 > tiff.length) return 0;
      const entries = uint16(tiff, ifd, little);
      let exifIfd = 0;
      for (let index = 0; index < entries; index++) {
        const entry = ifd + 2 + index * 12;
        if (entry + 12 > tiff.length) break;
        const tag = uint16(tiff, entry, little);
        let type = uint16(tiff, entry + 2, little);
        if (uint32(tiff, entry + 4, little) !== 1) continue;
        if (tag === 0x8769 && type === 4)
          exifIfd = uint32(tiff, entry + 8, little);
        const value = values[tag];
        if (value === undefined || (type !== 3 && type !== 4)) continue;
        // A rotated LONG dimension can become the value of a formerly SHORT dimension.
        if (type === 3 && value > 0xffff) {
          type = 4;
          view.setUint16(entry + 2, type, little);
        }
        if (type === 3) view.setUint16(entry + 8, value, little);
        else view.setUint32(entry + 8, value, little);
      }
      return exifIfd;
    }
    const exifIfd = updateIfd(uint32(tiff, 4, little), {
      0x0100: width,
      0x0101: height,
      0x0112: 1,
    });
    updateIfd(exifIfd, { 0xa002: width, 0xa003: height });
    return tiff;
  }

  /**
   * Rejects images this conversion cannot hold. Canvas limits differ per browser, so the pixel
   * ceiling is documented rather than derived. Native decoding reveals dimensions only after
   * allocating its bitmap; the caller must close that bitmap if this validation rejects it.
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

  async function decodeNative(bytes, format, keepExif) {
    const exif =
      keepExif || format === "webp" ? sourceExif(bytes, format) : null;
    const orientation = format === "webp" ? exifOrientation(exif) : 1;
    // WebP decoders differ in EXIF support. Neutralize orientation in our private input bytes
    // and apply it exactly once at export, including when source metadata is being dropped.
    if (orientation !== 1) exif.set(normalizeExif(exif));
    let bitmap;
    try {
      // Native decoding applies JPEG/PNG orientation; WebP orientation is handled at export.
      bitmap = await createImageBitmap(new Blob([bytes]));
    } catch {
      throw failure(
        "decode",
        "This image could not be read. Choose a valid image file and try again.",
      );
    }
    try {
      checkSize(bitmap.width, bitmap.height);
    } catch (error) {
      bitmap.close();
      throw error;
    }
    const width = orientation >= 5 ? bitmap.height : bitmap.width;
    const height = orientation >= 5 ? bitmap.width : bitmap.height;
    return {
      bitmap,
      width,
      height,
      orientation,
      exif: keepExif ? normalizeExif(exif, width, height) : null,
    };
  }

  function metadataType(heif, handle, id) {
    // libheif keeps the returned string alive only until its next call, so it must not be freed.
    const pointer = heif._heif_image_handle_get_metadata_type(handle, id);
    let value = "";
    for (let index = 0; pointer && index < 16; index++) {
      const byte = heif.HEAPU8[pointer + index];
      if (!byte) break;
      value += String.fromCharCode(byte);
    }
    return value;
  }

  /** Reads the Exif item a HEIC photo carries, which no browser API exposes. */
  function heifExif(heif, image) {
    // libheif exposes this C API without an Embind wrapper. Its WASM32 ABI places a 12-byte
    // heif_error buffer before the documented arguments, as heifColorProfile already does.
    const handle = image.handle.$$.ptr;
    const count = heif._heif_image_handle_get_number_of_metadata_blocks(
      handle,
      0,
    );
    if (!count) return null;
    const ids = heif._malloc(4 * count);
    const error = heif._malloc(12);
    try {
      const written = heif._heif_image_handle_get_list_of_metadata_block_IDs(
        handle,
        0,
        ids,
        count,
      );
      for (let index = 0; index < written; index++) {
        const id = heif.HEAPU32[(ids + index * 4) >> 2];
        // XMP and other blocks stay behind: only the Exif item holds the TIFF data.
        if (metadataType(heif, handle, id) !== "Exif") continue;
        const size = heif._heif_image_handle_get_metadata_size(handle, id);
        if (!size) continue;
        const data = heif._malloc(size);
        try {
          heif._heif_image_handle_get_metadata(error, handle, id, data);
          if (heif.HEAP32[error >> 2]) return null;
          const payload = heif.HEAPU8.slice(data, data + size);
          return exifTiff(payload, "heif");
        } finally {
          heif._free(data);
        }
      }
      return null;
    } finally {
      heif._free(ids);
      heif._free(error);
    }
  }

  async function decodeHeif(bytes, onStage, keepExif) {
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
    // Only the first image is exported; release the other handles before allocating its pixels.
    for (const extra of images.slice(1)) extra.free();
    const image = images[0];
    try {
      const width = image.get_width(),
        height = image.get_height();
      checkSize(width, height);
      const profile = heifColorProfile(heif, image);
      const pixels = new ImageData(width, height, {
        colorSpace: profile.colorSpace,
      });
      if (
        profile.colorSpace === "display-p3" &&
        pixels.colorSpace !== "display-p3"
      )
        throw failure(
          "profile",
          "Your browser cannot convert Display P3 colours. Try a newer browser.",
        );
      await new Promise((resolve, reject) =>
        image.display(pixels, (displayed) =>
          displayed
            ? resolve()
            : reject(
                failure("decode", "This HEIC photo could not be decoded."),
              ),
        ),
      );
      if (profile.transfer === 1) {
        // The decoder converts YCbCr to RGB but leaves the BT.709 transfer function intact.
        // Canvas understands sRGB/Display P3's sRGB transfer, so convert the encoded channels.
        const lookup = Uint8ClampedArray.from({ length: 256 }, (_, value) => {
          const encoded = value / 255;
          const linear =
            encoded < 0.081
              ? encoded / 4.5
              : ((encoded + 0.099) / 1.099) ** (1 / 0.45);
          return (
            255 *
            (linear <= 0.0031308
              ? 12.92 * linear
              : 1.055 * linear ** (1 / 2.4) - 0.055)
          );
        });
        for (let index = 0; index < pixels.data.length; index += 4)
          for (let channel = 0; channel < 3; channel++)
            pixels.data[index + channel] = lookup[pixels.data[index + channel]];
      }
      const bitmap = profile.icc
        ? await colorManagedBitmap(pixels, profile.icc)
        : await createImageBitmap(pixels);
      return {
        bitmap,
        width,
        height,
        imageCount: images.length,
        exif: keepExif
          ? normalizeExif(heifExif(heif, image), width, height)
          : null,
      };
    } finally {
      image.free();
    }
  }

  function heifColorProfile(heif, image) {
    // libheif exposes this C API without an Embind wrapper. Its WASM32 ABI uses
    // a 12-byte heif_error return buffer before the explicit handle and destination arguments.
    const handle = image.handle.$$.ptr;
    const size = heif._heif_image_handle_get_raw_color_profile_size(handle);
    const profile = { colorSpace: "srgb", transfer: 13 };
    if (!size) {
      const buffer = heif._malloc(16);
      let nclx = 0;
      try {
        heif.HEAPU32[(buffer + 12) >> 2] = 0;
        heif._heif_image_handle_get_nclx_color_profile(
          buffer,
          handle,
          buffer + 12,
        );
        nclx = heif.HEAPU32[(buffer + 12) >> 2];
        const error = heif.HEAP32[buffer >> 2];
        // Untagged/unspecified SDR images follow the browser's usual sRGB assumption.
        if (error === heif.heif_error_Color_profile_does_not_exist.value)
          return profile;
        if (error || !nclx)
          throw failure(
            "profile",
            "This image's colour profile could not be read.",
          );
        const primaries = heif.HEAPU32[(nclx + 4) >> 2];
        const transfer = heif.HEAPU32[(nclx + 8) >> 2];
        if (![1, 2, 12].includes(primaries) || ![1, 2, 13].includes(transfer))
          throw failure(
            "profile",
            "This HEIC colour space is not supported. Export an SDR sRGB or Display P3 image and try again.",
          );
        profile.colorSpace = primaries === 12 ? "display-p3" : "srgb";
        profile.transfer = transfer;
        return profile;
      } finally {
        if (nclx) heif._heif_nclx_color_profile_free(nclx);
        heif._free(buffer);
      }
    }
    const buffer = heif._malloc(12 + size);
    try {
      heif._heif_image_handle_get_raw_color_profile(
        buffer,
        handle,
        buffer + 12,
      );
      if (heif.HEAP32[buffer >> 2])
        throw failure(
          "profile",
          "This image's colour profile could not be read.",
        );
      profile.icc = heif.HEAPU8.slice(buffer + 12, buffer + 12 + size);
      // The temporary PNG contains RGB pixels; PNG requires an RGB ICC profile for them.
      // Browsers can ignore an incompatible Gray profile and silently export wrong colours.
      if (text(profile.icc, 16, 4) !== "RGB ")
        throw failure(
          "profile",
          "This HEIC colour profile is not supported. Export an RGB sRGB or Display P3 image and try again.",
        );
      return profile;
    } finally {
      heif._free(buffer);
    }
  }

  async function colorManagedBitmap(pixels, profile) {
    // libheif returns ICC-tagged RGB without applying the profile. Let the browser's PNG
    // decoder do that transform: attach the source ICC to a temporary lossless PNG instead
    // of interpreting wide-gamut pixels as sRGB or adding a second colour-management library.
    const canvas = document.createElement("canvas");
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    let png;
    try {
      canvas.getContext("2d").putImageData(pixels, 0, 0);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob)
        throw failure(
          "encode",
          "Your browser could not prepare this image. Try a smaller image.",
        );
      png = new Uint8Array(await blob.arrayBuffer());
    } finally {
      canvas.width = canvas.height = 0;
    }
    const compressed = new Uint8Array(
      await new Response(
        new Blob([profile])
          .stream()
          .pipeThrough(new CompressionStream("deflate")),
      ).arrayBuffer(),
    );
    // PNG iCCP stores a null-terminated profile name, compression method 0, then zlib data.
    const chunk = new Uint8Array(compressed.length + 15);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, compressed.length + 3);
    chunk.set([105, 67, 67, 80, 112, 0, 0], 4); // iCCP, "p", null, method
    chunk.set(compressed, 11);
    view.setUint32(
      chunk.length - 4,
      crc32(chunk.subarray(4, chunk.length - 4)),
    );

    const parts = [png.subarray(0, 8)];
    // Only walk the PNG just produced by canvas. Replace colour declarations so the source
    // ICC is authoritative, retaining the image data and its alpha channel without loss.
    for (let offset = 8; offset < png.length; ) {
      const end = offset + uint32(png, offset) + 12;
      const type = text(png, offset + 4, 4);
      if (!["sRGB", "iCCP", "gAMA", "cHRM", "cICP"].includes(type))
        parts.push(png.subarray(offset, end));
      if (type === "IHDR") parts.push(chunk);
      offset = end;
    }
    return createImageBitmap(new Blob(parts, { type: "image/png" }));
  }

  const uint32LEBytes = (value) =>
    Uint8Array.from([
      value & 255,
      (value >> 8) & 255,
      (value >> 16) & 255,
      (value >>> 24) & 255,
    ]);

  function webpChunk(type, payload) {
    return concat(
      Uint8Array.from(ascii(type)),
      uint32LEBytes(payload.length),
      payload,
      new Uint8Array(payload.length % 2),
    );
  }

  function embedExifJpeg(bytes, tiff) {
    if (tiff.length > MAX_JPEG_EXIF) return null;
    const length = tiff.length + 8;
    const segment = new Uint8Array(length + 2);
    segment.set([
      0xff,
      0xe1,
      length >> 8,
      length & 255,
      0x45,
      0x78,
      0x69,
      0x66,
    ]);
    segment.set(tiff, 10);
    return concat(bytes.subarray(0, 2), segment, bytes.subarray(2));
  }

  function embedExifPng(bytes, tiff) {
    // Canvas always writes IHDR first, so the eXIf chunk goes straight after it.
    const end = 20 + uint32(bytes, 8);
    const chunk = new Uint8Array(tiff.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, tiff.length);
    chunk.set(ascii("eXIf"), 4);
    chunk.set(tiff, 8);
    view.setUint32(tiff.length + 8, crc32(chunk.subarray(4, tiff.length + 8)));
    return concat(bytes.subarray(0, end), chunk, bytes.subarray(end));
  }

  function embedExifWebp(bytes, tiff, width, height) {
    // Canvas writes a simple file, so add the extended header that declares the EXIF feature.
    // The container requires VP8X first and EXIF after the image data.
    let flags = 0x08;
    const body = [];
    for (const source of webpChunks(bytes)) {
      if (source.type === "EXIF") continue;
      const payload = bytes.subarray(
        source.start,
        source.start + source.length,
      );
      if (source.type === "VP8X") {
        flags |= payload[0];
        continue;
      }
      body.push(webpChunk(source.type, payload));
    }
    const uint24 = (value) =>
      Uint8Array.from([value & 255, (value >> 8) & 255, (value >> 16) & 255]);
    const content = concat(
      webpChunk(
        "VP8X",
        concat(
          Uint8Array.from([flags, 0, 0, 0]),
          uint24(width - 1),
          uint24(height - 1),
        ),
      ),
      ...body,
      webpChunk("EXIF", tiff),
    );
    return concat(
      Uint8Array.from(ascii("RIFF")),
      uint32LEBytes(content.length + 4),
      Uint8Array.from(ascii("WEBP")),
      content,
    );
  }

  /** Transplants the source EXIF into the container the canvas encoder just produced. */
  function embedExif(mime, bytes, tiff, width, height) {
    if (mime === "image/jpeg") return embedExifJpeg(bytes, tiff);
    if (mime === "image/png") return embedExifPng(bytes, tiff);
    return embedExifWebp(bytes, tiff, width, height);
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
    if (source.orientation > 1) {
      const { width, height } = source;
      // Translation uses the upright canvas dimensions; orientations 5-8 exchange the axes.
      const transforms = {
        2: [-1, 0, 0, 1, width, 0],
        3: [-1, 0, 0, -1, width, height],
        4: [1, 0, 0, -1, 0, height],
        5: [0, 1, 1, 0, 0, 0],
        6: [0, 1, -1, 0, width, 0],
        7: [0, -1, -1, 0, width, height],
        8: [0, -1, 1, 0, 0, height],
      };
      context.transform(...transforms[source.orientation]);
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
    if (!source.exif)
      return { blob, width: source.width, height: source.height, exif: "none" };
    // Canvas encoders write pixels only, so the retained EXIF goes in afterwards.
    const embedded = embedExif(
      output.mime,
      new Uint8Array(await blob.arrayBuffer()),
      source.exif,
      source.width,
      source.height,
    );
    return embedded
      ? {
          blob: new Blob([embedded], { type: output.mime }),
          width: source.width,
          height: source.height,
          exif: "kept",
        }
      : { blob, width: source.width, height: source.height, exif: "too-large" };
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

  /** Validates container policy and limits before either a thumbnail or conversion decodes it. */
  async function readInput(file) {
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
    const rejection = rejectedContainer(bytes, format);
    if (rejection === "animated")
      throw failure(
        "animated",
        "Animated images are not supported. Choose a single still image.",
      );
    if (rejection === "layered")
      throw failure(
        "layered",
        "This HEIF file uses layered (L-HEVC) encoding, which is not supported. Export a single-layer HEIC and try again.",
      );
    return { bytes, format };
  }

  /** Builds a small, metadata-free HEIC preview when the browser cannot display the source. */
  async function thumbnail(file) {
    const { bytes, format } = await readInput(file);
    if (format !== "heif") return null;
    const source = await decodeHeif(bytes);
    const canvas = document.createElement("canvas");
    try {
      const scale = Math.min(1, 512 / Math.max(source.width, source.height));
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      canvas
        .getContext("2d")
        .drawImage(source.bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      return blob ? { blob, width: source.width, height: source.height } : null;
    } finally {
      source.bitmap.close();
      canvas.width = canvas.height = 0;
    }
  }

  /** Converts one file, optionally keeping EXIF and reporting the decoder-loading stage. */
  async function convert(file, output, quality, options = {}) {
    const { keepExif = false, onStage } = options;
    const { bytes, format } = await readInput(file);
    const source =
      format === "heif"
        ? await decodeHeif(bytes, onStage, keepExif)
        : await decodeNative(bytes, format, keepExif);
    try {
      const result = await encode(source, output, quality);
      result.imageCount =
        format === "jpeg" ? jpegImageCount(bytes) : source.imageCount || 1;
      return result;
    } finally {
      source.bitmap.close();
    }
  }

  return {
    MAX_FILE_BYTES,
    MAX_PIXELS,
    OUTPUTS,
    rejectedContainer,
    convert,
    detectFormat,
    embedExif,
    encoderSupport,
    exifOrientation,
    exifTiff,
    normalizeExif,
    outputName,
    outputNames,
    sourceExif,
    thumbnail,
  };
})();

if (typeof module !== "undefined" && module.exports)
  module.exports = ImageConverter;
