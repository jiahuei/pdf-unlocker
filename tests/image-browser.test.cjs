"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8001";
const homeURL = `${baseURL}/`;
const converterURL = `${baseURL}/image-converter.html`;
const pdfURL = `${baseURL}/pdf-unlocker.html`;
const decoderURL = /libheif-bundle\.js/;
const pdfRuntimeURL = /pyodide|pdf(\.min|\.worker)/;
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "image-fixture-"));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "image-download-"));
const screenshotDir = process.env.TEST_SCREENSHOTS;
const pageErrors = [];
const uploads = [];
let checks = 0;
let verified = 0;
let downloaded = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
function python(args) {
  const process = spawnSync(global.process.env.PYTHON || "python3", args, {
    encoding: "utf8",
  });
  assert.equal(process.status, 0, process.stderr || process.stdout);
}
python([path.join(__dirname, "image_fixtures.py"), fixtures]);
// A real camera photo exercises what synthetic fixtures cannot: grid-derived HEVC tiles, a wide
// gamut profile, container rotation and auxiliary items. It is copied in from TEST_HEIC so no
// personal photograph, or the GPS metadata inside it, is committed to the repository.
const realHeic = process.env.TEST_HEIC;
if (realHeic && !fs.existsSync(realHeic))
  throw new Error(`TEST_HEIC does not exist: ${realHeic}`);
if (realHeic) fs.copyFileSync(realHeic, path.join(fixtures, "real.heic"));
const heicFixtures = fs.existsSync(path.join(fixtures, "photo.heic"));

/** Checks a real download independently with Pillow instead of trusting the success message. */
function verify(file, ...expectations) {
  python([path.join(__dirname, "verify_image.py"), file, ...expectations]);
  verified++;
}
/** Opens a page whose uncaught errors and uploads are reported at the end of the suite. */
function watch(context) {
  context.on("request", (request) => {
    if (!["GET", "HEAD"].includes(request.method()))
      uploads.push(request.url());
  });
  return async () => {
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    return page;
  };
}
/** Waits until every thumbnail of a gallery has decoded, scrolling it into view for lazy images. */
function waitThumbnails(page, list) {
  return (
    page
      .locator(`${list} .tile`)
      .last()
      .scrollIntoViewIfNeeded()
      .then(() =>
        page.waitForFunction(
          (selector) =>
            [...document.querySelectorAll(`${selector} .tile-frame img`)].every(
              (image) => image.complete,
            ),
          list,
          { timeout: 30000 },
        ),
      )
      // An empty gallery has no tiles to scroll to, and nothing to wait for either.
      .catch(() => {})
  );
}
/** Waits for the running batch to settle: every tile reached a final status and the form is idle. */
async function waitBatch(page, timeout = 120000) {
  await page.waitForFunction(
    () => {
      const tiles = [...document.querySelectorAll("#resultList .tile")];
      return (
        tiles.length > 0 &&
        !document.getElementById("convertBtn").disabled &&
        tiles.every((tile) => ["done", "failed"].includes(tile.dataset.status))
      );
    },
    null,
    { timeout },
  );
  await waitThumbnails(page, "#resultList");
}
/** Reads every result tile's name, status, detail line, thumbnail state and download name. */
function tileStates(page) {
  return page.locator("#resultList .tile").evaluateAll((tiles) =>
    tiles.map((tile) => ({
      name: tile.querySelector(".tile-name").textContent,
      status: tile.dataset.status,
      meta: tile.querySelector(".tile-meta").textContent,
      thumbnail: tile
        .querySelector(".tile-frame img")
        .hasAttribute("data-loaded"),
      download: tile.querySelector(".tile-download").getAttribute("download"),
    })),
  );
}
/** Reads every input tile's name, detail line and whether the browser could thumbnail it. */
function sourceStates(page) {
  return page.locator("#sourceList .tile").evaluateAll((tiles) =>
    tiles.map((tile) => ({
      name: tile.querySelector(".tile-name").textContent,
      meta: tile.querySelector(".tile-meta").textContent,
      thumbnail: tile
        .querySelector(".tile-frame img")
        .hasAttribute("data-loaded"),
    })),
  );
}
/** Chooses a batch of fixtures, applies the shared settings and waits for the conversion. */
async function convertBatch(page, fixtureNames, options = {}) {
  await page
    .locator("#imageFile")
    .setInputFiles(fixtureNames.map((name) => path.join(fixtures, name)));
  await waitThumbnails(page, "#sourceList");
  if (options.format)
    await page.locator("#outputFormat").selectOption(options.format);
  if (options.keepExif !== undefined)
    await page.locator("#keepExif").setChecked(options.keepExif);
  if (options.quality !== undefined)
    await page.locator("#quality").fill(String(options.quality));
  await page.locator("#convertBtn").click();
  await waitBatch(page);
  return tileStates(page);
}
/** Downloads one tile's result, checking the offered name, and returns the saved path. */
async function downloadTile(page, index, expected) {
  const downloadPromise = page.waitForEvent("download");
  await page
    .locator("#resultList .tile")
    .nth(index)
    .locator(".tile-download")
    .click();
  const download = await downloadPromise;
  check(
    download.suggestedFilename() === expected,
    `tile ${index + 1} offers the download ${expected}`,
  );
  const file = path.join(downloads, `${++downloaded}-${expected}`);
  await download.saveAs(file);
  return file;
}
/** Converts one fixture as a single-file batch and returns the downloaded file path. */
async function convertAndDownload(page, fixture, options = {}) {
  const format = options.format || "jpeg";
  const extension = { jpeg: "jpg", png: "png", webp: "webp" }[format];
  const expected = `${fixture.replace(/\.[^.]+$/, "")}.${extension}`;
  // The resolved format is always applied: a previous case may have left another one selected.
  const [tile] = await convertBatch(page, [fixture], { ...options, format });
  check(tile.status === "done", `${fixture} to ${format}: converted`);
  check(
    tile.name === expected &&
      tile.download === expected &&
      /^\d+ × \d+ px · /.test(tile.meta) &&
      tile.thumbnail,
    `${fixture} to ${format}: tile named ${expected} reporting its geometry with a thumbnail: ${tile.meta}`,
  );
  check(
    await page.locator("#resultPreview").isVisible(),
    `${fixture} to ${format}: preview shown`,
  );
  return downloadTile(page, 0, expected);
}
/** Asserts an actionable error is announced and that another attempt stays possible. */
async function expectFailure(page, fixture, fragment) {
  const [tile] = await convertBatch(page, [fixture], {});
  check(tile.status === "failed", `${fixture}: reported as failed`);
  check(
    tile.meta.includes(fragment),
    `${fixture}: "${tile.meta}" explains "${fragment}"`,
  );
  check(tile.download === null, `${fixture}: no result offered after failure`);
  check(
    await page.locator("#message.error").isVisible(),
    `${fixture}: the failure is announced`,
  );
  check(
    await page.locator("#resultPreview").isHidden(),
    `${fixture}: nothing is previewed after failure`,
  );
  check(
    !(await page.locator("#convertBtn").isDisabled()),
    `${fixture}: another attempt stays possible`,
  );
}
/**
 * Drops fixtures onto the drop zone. Playwright cannot dispatch a synthetic DragEvent carrying
 * files, so the DataTransfer and its File objects are built inside the page from the fixture bytes.
 */
async function dropFiles(page, fixtureNames) {
  await page.evaluate(
    (files) => {
      const transfer = new DataTransfer();
      for (const file of files)
        transfer.items.add(
          new File(
            [Uint8Array.from(atob(file.base64), (byte) => byte.charCodeAt(0))],
            file.name,
            { type: "image/png" },
          ),
        );
      document
        .getElementById("fileDrop")
        .dispatchEvent(
          new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
        );
    },
    fixtureNames.map((name) => ({
      name,
      base64: fs.readFileSync(path.join(fixtures, name)).toString("base64"),
    })),
  );
}
/** Counts concurrent converter calls, which the shared HEIC decoder cannot survive. */
async function trackConvertCalls(page) {
  await page.evaluate(() => {
    window.calls = { active: 0, peak: 0, total: 0, files: [] };
    const convert = ImageConverter.convert;
    ImageConverter.convert = async (file, ...rest) => {
      window.calls.files.push(file.name);
      window.calls.total++;
      window.calls.peak = Math.max(window.calls.peak, ++window.calls.active);
      try {
        return await convert(file, ...rest);
      } finally {
        window.calls.active--;
      }
    };
  });
}
/**
 * Replaces the converter with a substitute that stays pending until the test releases it, so
 * invalidation of queued work can be observed deterministically.
 */
async function holdConvertCalls(page) {
  await page.evaluate(() => {
    window.calls = { active: 0, peak: 0, total: 0, files: [] };
    window.pending = [];
    ImageConverter.convert = (file) => {
      window.calls.files.push(file.name);
      window.calls.total++;
      window.calls.peak = Math.max(window.calls.peak, ++window.calls.active);
      return new Promise((resolve) =>
        window.pending.push(() => {
          window.calls.active--;
          resolve({
            blob: new Blob(["stub"], { type: "image/png" }),
            width: 4,
            height: 2,
            exif: "none",
          });
        }),
      );
    };
  });
}
/** Releases held conversions one at a time until the batch has settled. */
function settleBatch(page) {
  return page.waitForFunction(
    () => {
      const tiles = [...document.querySelectorAll("#resultList .tile")];
      if (
        tiles.length > 0 &&
        !document.getElementById("convertBtn").disabled &&
        tiles.every((tile) => ["done", "failed"].includes(tile.dataset.status))
      )
        return true;
      const next = window.pending.shift();
      if (next) next();
      return false;
    },
    null,
    { polling: 50, timeout: 30000 },
  );
}
/** Releases the oldest held conversion, which a discarded batch must ignore. */
function releaseConversion(page) {
  return page.evaluate(() => {
    const next = window.pending.shift();
    if (next) next();
  });
}
/** Ensures responsive pages have no horizontal overflow, including the result state. */
async function noOverflow(page, width) {
  const dimensions = await page.evaluate(() => [
    innerWidth,
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  ]);
  check(
    Math.max(...dimensions.slice(1)) <= dimensions[0] + 1,
    `no overflow at ${width}px: ${dimensions}`,
  );
}
/** Records image object URLs so reset and replacement can be shown to release them. */
function trackObjectURLs(page) {
  return page.addInitScript(() => {
    window.urls = { created: 0, revoked: 0 };
    const owned = new Set();
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL;
    URL.createObjectURL = (value) => {
      const url = create.call(URL, value);
      if (value.type.startsWith("image/")) {
        window.urls.created++;
        owned.add(url);
      }
      return url;
    };
    URL.revokeObjectURL = (value) => {
      if (owned.delete(value)) window.urls.revoked++;
      return revoke.call(URL, value);
    };
  });
}
/** Ensures every asset and a conversion work beneath a nested pull-request preview prefix. */
async function verifyPreviewPrefix(browser, open) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-preview-"));
  fs.mkdirSync(path.join(root, "pr-preview"), { recursive: true });
  fs.symlinkSync(
    path.resolve(__dirname, "..", "src"),
    path.join(root, "pr-preview", "99"),
  );
  const server = spawn(
    process.env.PYTHON || "python3",
    // -u keeps the chosen port readable from a pipe instead of buffered until exit.
    [
      "-u",
      "-m",
      "http.server",
      "0",
      "--bind",
      "127.0.0.1",
      "--directory",
      root,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    const port = await new Promise((resolve, reject) => {
      let output = "";
      server.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /port (\d+)/.exec(output);
        if (match) resolve(match[1]);
      });
      server.on("exit", (code) =>
        reject(new Error(`preview server exited with ${code}`)),
      );
    });
    const prefix = `http://127.0.0.1:${port}/pr-preview/99/`;
    const page = await open();
    const missing = [];
    page.on("response", (response) => {
      if (response.status() === 404) missing.push(response.url());
    });
    await page.goto(`${prefix}image-converter.html`);
    await page
      .locator("#imageFile")
      .setInputFiles(path.join(fixtures, "photo.png"));
    await page.locator("#convertBtn").click();
    await waitBatch(page, 60000);
    check(
      (await tileStates(page))[0].download === "photo.jpg",
      "conversion works beneath the preview prefix",
    );
    await page.locator(".brand").click();
    await page.waitForURL(/pr-preview\/99\/index\.html$/);
    check(
      (await page.locator(".tool-card").count()) === 2,
      "the preview home page lists both tools",
    );
    check(missing.length === 0, `no missing preview assets: ${missing}`);
    await page.close();
  } finally {
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
/** Verifies the converter, the tools home page and their navigation in a real browser. */
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    const open = watch(context);

    // Tools home page, direct tool URLs and the way back.
    const requests = [];
    const page = await open();
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(homeURL);
    check(
      (await page.locator("h1").textContent()).includes("File tools"),
      "home page introduces the tools suite",
    );
    check(
      (
        await page
          .locator(".tool-card")
          .evaluateAll((cards) =>
            cards.map((card) => card.getAttribute("href")),
          )
      ).join() === "pdf-unlocker.html,image-converter.html",
      "home page links both tools",
    );
    await page.locator('.tool-card[href="image-converter.html"]').click();
    await page.waitForURL(/image-converter\.html$/);
    check(
      (await page.locator("h1").textContent()) === "Convert your images",
      "the converter has its own URL and heading",
    );
    check(
      (await page.locator('.tool-nav a[aria-current="page"]').textContent()) ===
        "Image Converter",
      "the converter marks its own navigation entry",
    );
    check(
      !requests.some((url) => pdfRuntimeURL.test(url)),
      "the home and converter pages never request the PDF runtime",
    );
    check(
      (await page.evaluate(() => typeof window.loadPyodide)) === "undefined",
      "no Pyodide global on the converter page",
    );
    await page.locator(".brand").click();
    await page.waitForURL(/index\.html$/);
    check(
      (await page.locator("h1").textContent()).includes("File tools"),
      "the brand returns to the tools home page",
    );
    await page.locator('.tool-card[href="pdf-unlocker.html"]').click();
    await page.waitForURL(/pdf-unlocker\.html$/);
    check(
      (await page.locator("h1").textContent()) === "Unlock your PDF",
      "PDF Unlocker keeps its own URL and heading",
    );
    check(
      (await page.locator('.tool-nav a[aria-current="page"]').textContent()) ===
        "PDF Unlocker",
      "the PDF page marks its own navigation entry",
    );
    check(
      requests.some((url) => pdfRuntimeURL.test(url)),
      "only the PDF page loads its own runtime",
    );
    await page.locator(".brand").click();
    await page.waitForURL(/index\.html$/);
    await page.goto(converterURL);
    /** Ensures a fresh converter offers the requested default quality before any interaction. */
    check(
      (await page.locator("#quality").inputValue()) === "80" &&
        (await page.locator("#qualityValue").textContent()) === "80",
      "initial quality and its label are 80",
    );
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({
        path: path.join(screenshotDir, "image-converter-1440.png"),
        fullPage: true,
      });
      await page.goto(homeURL);
      await page.screenshot({
        path: path.join(screenshotDir, "home-1440.png"),
        fullPage: true,
      });
      await page.goto(converterURL);
    }

    // Documented conversion matrix, verified from the downloaded bytes.
    verify(
      await convertAndDownload(page, "photo.jpg"),
      "--format",
      "JPEG",
      "--size",
      "640x400",
      "--pixel",
      "20,20,255,0,0",
    );
    verify(
      await convertAndDownload(page, "photo.jpg", { format: "png" }),
      "--format",
      "PNG",
      "--size",
      "640x400",
    );
    verify(
      await convertAndDownload(page, "photo.png", { format: "webp" }),
      "--format",
      "WEBP",
      "--size",
      "200x150",
    );
    verify(
      await convertAndDownload(page, "photo.webp"),
      "--format",
      "JPEG",
      "--size",
      "300x200",
      "--pixel",
      "20,20,0,128,0",
    );
    // Stored landscape with EXIF orientation 6: the output must be upright at 300x600.
    verify(
      await convertAndDownload(page, "exif6.jpg"),
      "--format",
      "JPEG",
      "--size",
      "300x600",
      "--pixel",
      "260,50,0,255,0",
    );
    // Transparency becomes white for JPEG and survives in PNG.
    verify(
      await convertAndDownload(page, "alpha.png"),
      "--format",
      "JPEG",
      "--size",
      "120x90",
      "--transparency",
      "none",
      "--pixel",
      "5,5,255,255,255",
      "--pixel",
      "30,30,255,127,127",
    );
    verify(
      await convertAndDownload(page, "alpha.png", { format: "png" }),
      "--format",
      "PNG",
      "--size",
      "120x90",
      "--transparency",
      "kept",
      "--pixel",
      "5,5,0,0,0,0",
    );
    /** Ensures WebP rotations and reflections apply once, with or without retained metadata. */
    for (let orientation = 1; orientation <= 8; orientation++)
      for (const keepExif of [true, false])
        for (const format of orientation === 6
          ? ["jpeg", "png", "webp"]
          : ["png"]) {
          const fixture = `oriented-${orientation}.webp`;
          verify(
            await convertAndDownload(page, fixture, {
              format,
              keepExif,
              quality: format === "png" ? undefined : 100,
            }),
            "--format",
            { jpeg: "JPEG", png: "PNG", webp: "WEBP" }[format],
            "--size",
            orientation >= 5 ? "32x64" : "64x32",
            "--reference",
            path.join(fixtures, `oriented-${orientation}-reference.png`),
            ...(keepExif ? ["--exif-from", path.join(fixtures, fixture)] : []),
          );
        }
    if (heicFixtures) {
      // The core HEIC-to-JPG case, decoded by the lazily downloaded WebAssembly decoder.
      verify(
        await convertAndDownload(page, "photo.heic"),
        "--format",
        "JPEG",
        "--size",
        "640x400",
        "--pixel",
        "20,20,255,0,0",
      );
      verify(
        await convertAndDownload(page, "photo.heic", { format: "png" }),
        "--format",
        "PNG",
        "--size",
        "640x400",
      );
      /** Ensures a genuinely untagged HEIC keeps the documented sRGB assumption. */
      verify(
        await convertAndDownload(page, "untagged.heic", { format: "png" }),
        "--format",
        "PNG",
        "--size",
        "640x400",
        "--pixel",
        "20,20,255,0,0",
      );
      /** Ensures HEIC source-profile colours are transformed before metadata is removed. */
      for (const format of ["jpeg", "png", "webp"])
        verify(
          await convertAndDownload(page, "p3.heic", {
            format,
            quality: format === "png" ? undefined : 100,
          }),
          "--format",
          { jpeg: "JPEG", png: "PNG", webp: "WEBP" }[format],
          "--size",
          "64x32",
          "--reference",
          path.join(fixtures, "p3-reference.png"),
        );
      /** Ensures NCLX primaries/transfer and ICC alpha survive independently verified conversion. */
      for (const fixture of ["p3-nclx", "bt709", "p3-alpha"])
        verify(
          await convertAndDownload(page, `${fixture}.heic`, { format: "png" }),
          "--format",
          "PNG",
          "--size",
          "64x32",
          "--transparency",
          fixture === "p3-alpha" ? "kept" : "none",
          "--reference",
          path.join(fixtures, `${fixture}-reference.png`),
        );
    }
    if (realHeic) {
      /** Ensures a real camera HEIC keeps its orientation, geometry and colours end to end. */
      const output = await convertAndDownload(page, "real.heic");
      python([path.join(__dirname, "verify_real_heic.py"), realHeic, output]);
      verified++;
      check(
        true,
        "a real HEIC photo converts to a valid JPG with independent colour verification",
      );
      const retained = await convertAndDownload(page, "real.heic", {
        keepExif: true,
      });
      python([
        path.join(__dirname, "verify_real_heic.py"),
        realHeic,
        retained,
        "--keep-exif",
      ]);
      verified++;
      check(
        true,
        "a real HEIC photo keeps its EXIF, including GPS, when that is requested",
      );
      await page.locator("#keepExif").setChecked(false);
    }

    // Retained metadata is opt-in: by default no source position may reach the download.
    verify(
      await convertAndDownload(page, "gps.jpg", { keepExif: false }),
      "--format",
      "JPEG",
      "--size",
      "300x600",
      "--pixel",
      "260,50,0,255,0",
    );
    /** Ensures retained EXIF keeps GPS and matches upright pixel dimensions in every output. */
    for (const format of ["jpeg", "png", "webp"])
      verify(
        await convertAndDownload(page, "gps.jpg", { format, keepExif: true }),
        "--format",
        { jpeg: "JPEG", png: "PNG", webp: "WEBP" }[format],
        "--size",
        "300x600",
        "--exif-from",
        path.join(fixtures, "gps.jpg"),
      );
    check(
      (await tileStates(page))[0].meta.includes("EXIF kept"),
      "the result reports the retained EXIF",
    );
    if (heicFixtures)
      verify(
        await convertAndDownload(page, "gps.heic", { keepExif: true }),
        "--format",
        "JPEG",
        "--size",
        "640x400",
        "--exif-from",
        path.join(fixtures, "gps.heic"),
      );
    /** Ensures valid JPEG marker fill and a declared HEIF TIFF offset preserve EXIF. */
    for (const fixture of [
      "gps-marker-fill.jpg",
      ...(heicFixtures ? ["gps-offset.heic"] : []),
    ])
      for (const format of ["jpeg", "png", "webp"])
        verify(
          await convertAndDownload(page, fixture, { format, keepExif: true }),
          "--format",
          { jpeg: "JPEG", png: "PNG", webp: "WEBP" }[format],
          "--size",
          fixture.endsWith(".heic") ? "640x400" : "300x600",
          "--exif-from",
          path.join(fixtures, fixture),
        );
    // A source without EXIF says so instead of quietly claiming to have kept it.
    await convertAndDownload(page, "photo.png", { keepExif: true });
    check(
      (await tileStates(page))[0].meta.includes("no EXIF in the source"),
      "a source without EXIF is reported rather than implied",
    );
    check(
      await page.locator("#batchPanel").isVisible(),
      "a result is shown before the setting changes",
    );
    await page.locator("#keepExif").setChecked(false);
    const cleared = await tileStates(page);
    check(
      cleared.length === 1 &&
        cleared[0].status === "ready" &&
        cleared[0].download === null &&
        (await page.locator("#resultPreview").getAttribute("src")) === null,
      "changing the EXIF setting clears the result it no longer describes",
    );

    // Quality reaches the lossy encoders and is hidden for lossless output.
    const small = await convertAndDownload(page, "photo.jpg", { quality: 50 });
    const large = await convertAndDownload(page, "photo.jpg", { quality: 100 });
    check(
      fs.statSync(large).size > fs.statSync(small).size,
      `a higher quality setting produces a larger JPEG: ${fs.statSync(small).size} < ${fs.statSync(large).size}`,
    );
    await page.locator("#outputFormat").selectOption("png");
    check(
      await page.locator("#qualityField").isHidden(),
      "quality is hidden for lossless PNG output",
    );
    await page.locator("#outputFormat").selectOption("jpeg");
    check(
      await page.locator("#qualityField").isVisible(),
      "quality returns for lossy output",
    );
    check(
      (await page.locator("#outputFormat option[disabled]").count()) === 0,
      "Chromium supports every advertised output format",
    );

    // Actionable failures for inputs that must not be silently reduced or mislabelled.
    await expectFailure(
      page,
      "notes.txt",
      "Choose a HEIC, JPEG, PNG or WebP image",
    );
    await expectFailure(page, "anim.gif", "Choose a HEIC, JPEG, PNG or WebP");
    await expectFailure(page, "anim.webp", "Animated images are not supported");
    /** Ensures a valid unknown WebP chunk cannot silently discard the animation's frames. */
    await expectFailure(
      page,
      "anim-unknown.webp",
      "Animated images are not supported",
    );
    await expectFailure(page, "anim.png", "Animated images are not supported");
    /** Ensures multi-picture JPEGs are rejected instead of losing every image after the first. */
    await expectFailure(page, "multi.mpo", "holds 2 images");
    /** Ensures a real native bitmap rejected by the pixel limit releases its decoded memory. */
    await page.evaluate(() => {
      window.bitmapCloses = 0;
      window.nativeBitmapClose = ImageBitmap.prototype.close;
      ImageBitmap.prototype.close = function () {
        window.bitmapCloses++;
        return window.nativeBitmapClose.call(this);
      };
    });
    await expectFailure(page, "huge.png", "megapixel limit");
    check(
      (await page.evaluate(() => {
        ImageBitmap.prototype.close = window.nativeBitmapClose;
        return window.bitmapCloses;
      })) === 1,
      "the oversized native bitmap is closed exactly once",
    );
    await expectFailure(page, "oversize.jpg", "MB limit");
    if (heicFixtures) {
      await expectFailure(page, "multi.heic", "holds 2 images");
      await expectFailure(page, "corrupt.heic", "could not be read");
      /** Ensures unsupported HDR colours fail explicitly instead of exporting mislabelled sRGB. */
      await expectFailure(page, "hdr.heic", "colour space is not supported");
      /** Ensures a valid Gray ICC profile is rejected and the HEIC decoder stays usable. */
      await expectFailure(page, "gray.heic", "colour profile is not supported");
      verify(
        await convertAndDownload(page, "photo.heic"),
        "--format",
        "JPEG",
        "--size",
        "640x400",
      );
    }
    // A rejected file must not block the next conversion.
    verify(
      await convertAndDownload(page, "photo.png"),
      "--format",
      "JPEG",
      "--size",
      "200x150",
    );

    // Batch behavior: shared settings, selection order, per-file failures and unique names.
    const shared = await convertBatch(
      page,
      ["photo.jpg", "photo.png", "photo.webp"],
      { format: "png" },
    );
    const sources = await sourceStates(page);
    check(
      sources.map((tile) => tile.name).join() ===
        "photo.jpg,photo.png,photo.webp",
      "the input gallery lists the selected files in order",
    );
    check(
      sources.map((tile) => tile.meta.split(" · ")[0]).join("|") ===
        "640 × 400 px|200 × 150 px|300 × 200 px" &&
        sources.every((tile) => tile.thumbnail),
      `each input tile thumbnails its own source and reports its geometry: ${sources.map((tile) => tile.meta)}`,
    );
    check(
      sources.every((tile) => / · \d+(\.\d+)? [KM]B$/.test(tile.meta)),
      "each input tile reports the size of its own source file",
    );
    check(
      shared.every((tile) => tile.status === "done" && tile.thumbnail),
      "one action converts every selected file into a thumbnailed result",
    );
    check(
      shared.map((tile) => tile.name).join() ===
        "photo.png,photo-2.png,photo-3.png",
      "each result tile is named after the file it downloads",
    );
    check(
      (await page.locator("#batchSummary").textContent()) ===
        "Converted 3 images",
      "the batch reports how many images converted",
    );
    check(
      (await page.locator("#message.success").textContent()).includes(
        "3 converted images are ready to download",
      ),
      "a finished batch is announced",
    );
    // PNG output makes all three names collide, so the batch allocates distinct suffixes while
    // each download keeps the pixels of the source it came from.
    verify(
      await downloadTile(page, 0, "photo.png"),
      "--format",
      "PNG",
      "--size",
      "640x400",
    );
    verify(
      await downloadTile(page, 1, "photo-2.png"),
      "--format",
      "PNG",
      "--size",
      "200x150",
    );
    verify(
      await downloadTile(page, 2, "photo-3.png"),
      "--format",
      "PNG",
      "--size",
      "300x200",
    );

    // A source that already carries a suffix occupies that output name, so a colliding name
    // must skip past it instead of offering two downloads with the same name.
    fs.copyFileSync(
      path.join(fixtures, "photo.png"),
      path.join(fixtures, "photo-2.png"),
    );
    const suffixed = await convertBatch(
      page,
      ["photo-2.png", "photo.png", "photo.jpg"],
      { format: "jpeg" },
    );
    check(
      suffixed.map((tile) => tile.download).join() ===
        "photo-2.jpg,photo.jpg,photo-3.jpg",
      `allocated names skip a suffix another source already used: ${suffixed.map((tile) => tile.download)}`,
    );
    verify(
      await downloadTile(page, 2, "photo-3.jpg"),
      "--format",
      "JPEG",
      "--size",
      "640x400",
    );

    // An invalid file fails on its own tile without discarding its valid siblings.
    const mixed = await convertBatch(
      page,
      ["photo.png", "notes.txt", "anim.gif", "alpha.png"],
      { format: "jpeg" },
    );
    check(
      mixed.map((tile) => tile.status).join() === "done,failed,failed,done",
      `valid files around invalid ones still convert: ${mixed.map((tile) => tile.status)}`,
    );
    check(
      mixed[1].meta.includes("Choose a HEIC, JPEG, PNG or WebP image") &&
        mixed[2].meta.includes("Choose a HEIC, JPEG, PNG or WebP image") &&
        mixed[1].download === null &&
        mixed[2].download === null,
      "each rejected file explains itself and offers no download",
    );
    const mixedSources = await sourceStates(page);
    // An animated GIF still thumbnails, because the browser renders its first frame even though
    // the converter rejects the file; only a file no decoder can read keeps the placeholder.
    check(
      mixedSources.map((tile) => tile.thumbnail).join() ===
        "true,false,true,true" && mixedSources[1].meta === "1 KB",
      `a file the browser cannot render keeps its placeholder and reports only its size: ${mixedSources.map((tile) => tile.meta)}`,
    );
    check(
      (await page.locator("#batchSummary").textContent()) ===
        "Converted 2 of 4, 2 images failed",
      "the batch reports its success and failure counts",
    );
    check(
      (await page.locator("#message.error").textContent()).includes(
        "2 of 4 images could not be converted",
      ),
      "a partially failed batch is announced as an error",
    );
    verify(
      await downloadTile(page, 0, "photo.jpg"),
      "--format",
      "JPEG",
      "--size",
      "200x150",
    );
    verify(
      await downloadTile(page, 3, "alpha.jpg"),
      "--format",
      "JPEG",
      "--size",
      "120x90",
      "--transparency",
      "none",
      "--pixel",
      "30,30,255,127,127",
    );

    // An empty file is reported on its own tile instead of blocking the rest of the batch.
    fs.writeFileSync(path.join(fixtures, "empty.png"), "");
    const [empty] = await convertBatch(page, ["empty.png"], {});
    check(
      empty.status === "failed" && empty.meta.includes("non-empty image file"),
      `an empty file explains itself: ${empty.meta}`,
    );

    // A batch in which nothing converts still explains every file.
    const none = await convertBatch(page, ["notes.txt", "anim.webp"], {});
    check(
      none.every((tile) => tile.status === "failed" && tile.download === null),
      "no download is offered when every file fails",
    );
    check(
      none[1].meta.includes("Animated images are not supported"),
      "an animated file keeps its own reason inside a batch",
    );
    check(
      (await page.locator("#batchSummary").textContent()) ===
        "None of the 2 images converted",
      "an entirely failed batch says so",
    );

    // One shared quality and one shared EXIF setting reach every file in the batch.
    const sizes = {};
    for (const quality of [50, 100]) {
      await convertBatch(page, ["photo.jpg", "photo.webp"], {
        format: "jpeg",
        quality,
        keepExif: false,
      });
      sizes[quality] = [
        fs.statSync(await downloadTile(page, 0, "photo.jpg")).size,
        fs.statSync(await downloadTile(page, 1, "photo-2.jpg")).size,
      ];
    }
    check(
      sizes[100].every((size, index) => size > sizes[50][index]),
      `the shared quality reaches every file in the batch: ${JSON.stringify(sizes)}`,
    );
    await convertBatch(page, ["gps.jpg", "gps-marker-fill.jpg"], {
      format: "jpeg",
      keepExif: true,
    });
    check(
      (await tileStates(page)).every((tile) => tile.meta.includes("EXIF kept")),
      "the shared EXIF setting is reported for every file",
    );
    verify(
      await downloadTile(page, 0, "gps.jpg"),
      "--format",
      "JPEG",
      "--size",
      "300x600",
      "--exif-from",
      path.join(fixtures, "gps.jpg"),
    );
    verify(
      await downloadTile(page, 1, "gps-marker-fill.jpg"),
      "--format",
      "JPEG",
      "--size",
      "300x600",
      "--exif-from",
      path.join(fixtures, "gps-marker-fill.jpg"),
    );

    // One preview panel is shared, so choosing another result replaces what it shows.
    await convertBatch(page, ["photo.jpg", "alpha.png"], {
      format: "png",
      keepExif: false,
    });
    const tiles = page.locator("#resultList .tile");
    check(
      (await page.locator("#resultPreview").getAttribute("alt")).includes(
        "photo.png",
      ) && (await tiles.first().getAttribute("data-preview")) === "",
      "the first result is previewed without a click and marked",
    );
    await tiles.nth(1).locator(".tile-frame").click();
    check(
      (await page.locator("#resultPreview").getAttribute("alt")).includes(
        "alpha.png",
      ) &&
        (await tiles.first().getAttribute("data-preview")) === null &&
        (await tiles.nth(1).getAttribute("data-preview")) === "",
      "previewing another result moves the single preview panel",
    );

    // Drag-and-drop accepts the same batch as the picker, in drop order.
    await dropFiles(page, ["photo.png", "alpha.png"]);
    await waitThumbnails(page, "#sourceList");
    const dropped = await tileStates(page);
    check(
      dropped.map((tile) => tile.name).join() === "photo.png,alpha.png" &&
        dropped.every((tile) => tile.status === "ready"),
      "dropping several files replaces the batch in drop order",
    );
    check(
      (await sourceStates(page))
        .map((tile) => `${tile.name}:${tile.thumbnail}`)
        .join() === "photo.png:true,alpha.png:true",
      "dropped files fill the input gallery too",
    );
    await page.locator("#convertBtn").click();
    await waitBatch(page);
    verify(
      await downloadTile(page, 1, "alpha.png"),
      "--format",
      "PNG",
      "--size",
      "120x90",
      "--transparency",
      "kept",
      "--pixel",
      "5,5,0,0,0,0",
    );

    // Choosing a single file keeps the singular wording and one tile per gallery.
    await page
      .locator("#imageFile")
      .setInputFiles(path.join(fixtures, "photo.png"));
    check(
      (await page.locator("#fileName").textContent()) === "1 image chosen" &&
        (await page.locator("#convertLabel").textContent()) ===
          "Convert image" &&
        (await page.locator("#batchSummary").textContent()) ===
          "1 image ready to convert" &&
        (await page.locator("#sourceList .tile").count()) === 1 &&
        (await page.locator("#resultList .tile").count()) === 1,
      "single-file use stays as straightforward as before",
    );

    // Keyboard operation.
    await page.goto(converterURL);
    await page.locator("#imageFile").focus();
    check(
      (await page
        .locator("#fileDrop")
        .evaluate((drop) => getComputedStyle(drop).outlineWidth)) === "3px",
      "the drop zone shows a focus ring for keyboard users",
    );
    await page
      .locator("#imageFile")
      .setInputFiles([
        path.join(fixtures, "photo.png"),
        path.join(fixtures, "alpha.png"),
      ]);
    await page.locator("#convertBtn").focus();
    check(
      (await page.locator("#convertLabel").textContent()) ===
        "Convert 2 images",
      "the submit button names the batch it will convert",
    );
    await page.keyboard.press("Enter");
    await waitBatch(page, 60000);
    check(true, "Enter on the focused button converts the batch");
    const keyboardTiles = page.locator("#resultList .tile");
    await keyboardTiles.nth(1).locator(".tile-frame").focus();
    await page.keyboard.press("Enter");
    check(
      (await page.locator("#resultPreview").getAttribute("alt")).includes(
        "alpha.jpg",
      ),
      "Enter on a tile control previews that result",
    );
    const keyboardDownload = page.waitForEvent("download");
    await keyboardTiles.first().locator(".tile-download").focus();
    await page.keyboard.press("Enter");
    check(
      (await keyboardDownload).suggestedFilename() === "photo.jpg",
      "Enter on a tile download saves that file",
    );

    // An unsupported encoder must fail clearly rather than relabel PNG bytes.
    await page.evaluate(() => {
      HTMLCanvasElement.prototype.toBlob = function (callback) {
        callback(new Blob(["stub"], { type: "image/png" }));
      };
    });
    await page.locator("#outputFormat").selectOption("webp");
    await page.locator("#convertBtn").click();
    await waitBatch(page, 30000);
    check(
      (await tileStates(page))[0].meta.includes("cannot create WebP"),
      "a missing WebP encoder is reported instead of returning PNG bytes",
    );
    await page.close();

    // Object URLs are released on reset and on replacement. A source thumbnail belongs to the
    // selection rather than to a conversion, so hiding the page releases only the results.
    const trackedPage = await open();
    await trackObjectURLs(trackedPage);
    await trackedPage.goto(converterURL);
    // A retained-metadata choice must not survive reset, or the next photo leaks its position.
    await trackedPage.locator("#keepExif").setChecked(true);
    await trackedPage
      .locator("#imageFile")
      .setInputFiles([
        path.join(fixtures, "photo.png"),
        path.join(fixtures, "photo.jpg"),
      ]);
    check(
      (await trackedPage.evaluate(() => window.urls)).created === 2,
      "one thumbnail URL is created per selected file",
    );
    await trackedPage.locator("#quality").fill("75");
    await trackedPage.locator("#convertBtn").click();
    await waitBatch(trackedPage, 60000);
    check(
      (await trackedPage.evaluate(() => window.urls)).created === 4,
      "one result URL is created per converted file",
    );
    await trackedPage.locator("#resetBtn").click();
    check(
      (await trackedPage.evaluate(() => window.urls)).revoked === 4,
      "reset revokes every thumbnail and result URL of the batch",
    );
    check(
      (await trackedPage.locator("#fileName").textContent()) ===
        "Choose images",
      "reset clears the chosen files",
    );
    check(
      (await trackedPage.locator("#outputFormat").inputValue()) === "jpeg" &&
        (await trackedPage.locator("#quality").inputValue()) === "80" &&
        (await trackedPage.locator("#qualityValue").textContent()) === "80" &&
        !(await trackedPage.locator("#keepExif").isChecked()),
      "reset restores the documented defaults",
    );
    check(
      (await trackedPage.locator("#batchPanel").isHidden()) &&
        (await trackedPage.locator("#resultList .tile").count()) === 0 &&
        (await trackedPage.locator("#sourceList").isHidden()) &&
        (await trackedPage.locator("#sourceList .tile").count()) === 0 &&
        (await trackedPage.locator("#resultPreview").getAttribute("src")) ===
          null,
      "reset clears both galleries and the preview source",
    );
    await convertBatch(trackedPage, ["photo.jpg"], { keepExif: false });
    // Replacing the selection discards a finished result and its thumbnail together.
    await trackedPage
      .locator("#imageFile")
      .setInputFiles(path.join(fixtures, "alpha.png"));
    check(
      (await trackedPage.evaluate(() => window.urls)).created === 7 &&
        (await trackedPage.evaluate(() => window.urls)).revoked === 6,
      "replacing a batch releases every URL it owned",
    );
    await trackedPage.locator("#convertBtn").click();
    await waitBatch(trackedPage, 60000);
    const urls = await trackedPage.evaluate(() => window.urls);
    check(
      urls.created === 8 && urls.revoked === 6,
      `only the current thumbnail and result stay live: ${JSON.stringify(urls)}`,
    );
    await trackedPage.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide")),
    );
    check(
      (await trackedPage.evaluate(() => window.urls)).revoked === 7 &&
        (await trackedPage.locator("#sourceList .tile").count()) === 1,
      "leaving the page releases the result but keeps the chosen file's thumbnail",
    );
    await trackedPage.close();

    // A held converter substitute shows what invalidation must do to queued work: the stale batch
    // stops after its active file, never creates a result URL, and never overlaps the next one.
    const heldPage = await open();
    await trackObjectURLs(heldPage);
    await heldPage.goto(converterURL);
    await holdConvertCalls(heldPage);
    await heldPage
      .locator("#imageFile")
      .setInputFiles([
        path.join(fixtures, "photo.png"),
        path.join(fixtures, "alpha.png"),
      ]);
    await heldPage.locator("#convertBtn").click();
    await heldPage
      .locator('.tile[data-status="converting"]')
      .waitFor({ timeout: 30000 });
    check(
      (await heldPage.locator("#batchSummary").textContent()) ===
        "Converting image 1 of 2…" &&
        (await heldPage.locator("#convertBtn").isDisabled()),
      "a running batch reports its progress and blocks a second submission",
    );
    // A setting change discards the pending batch; resubmitting queues behind the active call.
    await heldPage.locator("#quality").fill("55");
    check(
      (await tileStates(heldPage)).every((tile) => tile.status === "ready"),
      "a setting change clears the statuses of the batch it invalidates",
    );
    await heldPage.locator("#convertBtn").click();
    await settleBatch(heldPage);
    const held = await heldPage.evaluate(() => window.calls);
    check(
      held.peak === 1,
      `the resubmitted batch waits for the active conversion instead of overlapping it: ${JSON.stringify(held)}`,
    );
    check(
      held.files.join() === "photo.png,photo.png,alpha.png" && held.total === 3,
      `the stale batch stops after the file it was already converting: ${held.files}`,
    );
    check(
      (await tileStates(heldPage)).map((tile) => tile.status).join() ===
        "done,done" &&
        (await heldPage.evaluate(() => window.urls)).created === 4,
      "only the resubmitted batch produces results",
    );
    // Reset during a pending conversion discards the late result instead of showing it.
    await heldPage.locator("#resetBtn").click();
    await heldPage
      .locator("#imageFile")
      .setInputFiles(path.join(fixtures, "photo.png"));
    await heldPage.locator("#convertBtn").click();
    await heldPage
      .locator('.tile[data-status="converting"]')
      .waitFor({ timeout: 30000 });
    await heldPage.locator("#resetBtn").click();
    check(
      (await heldPage.locator("#batchPanel").isHidden()) &&
        !(await heldPage.locator("#convertBtn").isDisabled()),
      "reset clears a pending batch and allows another one",
    );
    await releaseConversion(heldPage);
    await heldPage.waitForTimeout(500);
    const heldUrls = await heldPage.evaluate(() => window.urls);
    check(
      (await heldPage.locator("#batchPanel").isHidden()) &&
        (await heldPage.evaluate(() => window.calls)).total === 4 &&
        heldUrls.created === 5 &&
        heldUrls.revoked === 5,
      `a discarded conversion creates no result and leaks no URL: ${JSON.stringify(heldUrls)}`,
    );
    await heldPage.close();

    if (heicFixtures) {
      // A pending conversion must not resurface after the file is replaced, and the replacement
      // must not decode while the discarded HEIC still owns the shared decoder.
      const racedPage = await open();
      let releaseDecoder;
      await racedPage.route(decoderURL, async (route) => {
        await new Promise((resolve) => (releaseDecoder = resolve));
        await route.continue();
      });
      await trackObjectURLs(racedPage);
      await racedPage.goto(converterURL);
      await trackConvertCalls(racedPage);
      await racedPage
        .locator("#imageFile")
        .setInputFiles([
          path.join(fixtures, "photo.heic"),
          path.join(fixtures, "photo.png"),
        ]);
      const requested = racedPage.waitForRequest(decoderURL, {
        timeout: 30000,
      });
      await racedPage.locator("#convertBtn").click();
      await requested;
      await racedPage
        .locator("#imageFile")
        .setInputFiles(path.join(fixtures, "photo.png"));
      // PNG output names the result photo.png, so a resurfacing photo.heic result is visible.
      await racedPage.locator("#outputFormat").selectOption("png");
      const thumbnailsBefore = await racedPage.evaluate(
        () => window.urls.created,
      );
      await racedPage.locator("#convertBtn").click();
      const pending = racedPage.waitForResponse(decoderURL, { timeout: 60000 });
      releaseDecoder();
      await pending;
      await waitBatch(racedPage, 60000);
      const raced = await tileStates(racedPage);
      check(
        raced.length === 1 && raced[0].download === "photo.png",
        "the replaced batch is the one shown",
      );
      const racedCalls = await racedPage.evaluate(() => window.calls);
      check(
        racedCalls.peak === 1 &&
          racedCalls.files.join() === "photo.heic,photo.png",
        `the queued batch waits for the HEIC decoder and the stale one stops: ${JSON.stringify(racedCalls)}`,
      );
      check(
        (await racedPage.evaluate(() => window.urls)).created ===
          thumbnailsBefore + 1,
        "the discarded HEIC conversion creates no result URL",
      );
      // Give the discarded HEIC conversion time to finish after the replacement.
      await racedPage.waitForTimeout(4000);
      check(
        (await tileStates(racedPage))[0].download === "photo.png",
        "a conversion started before the replacement stays discarded",
      );
      await racedPage.close();

      // A batch of HEIC photos reuses one decoder, so its conversions must stay serialized.
      const heicPage = await open();
      await heicPage.goto(converterURL);
      await trackConvertCalls(heicPage);
      await heicPage
        .locator("#imageFile")
        .setInputFiles(
          ["photo.heic", "gps.heic", "untagged.heic"].map((name) =>
            path.join(fixtures, name),
          ),
        );
      await waitThumbnails(heicPage, "#sourceList");
      check(
        (await sourceStates(heicPage)).every(
          (tile) => !tile.thumbnail && !tile.meta.includes("px"),
        ),
        "a HEIC source this browser cannot render keeps its placeholder and reports only its size",
      );
      await heicPage.locator("#keepExif").setChecked(true);
      await heicPage.locator("#convertBtn").click();
      await waitBatch(heicPage);
      const heicBatch = await tileStates(heicPage);
      check(
        heicBatch.every((tile) => tile.status === "done" && tile.thumbnail),
        "a batch of HEIC photos converts through the shared decoder",
      );
      check(
        (await sourceStates(heicPage)).every((tile) =>
          /^640 × 400 px · \d+(\.\d+)? [KM]B$/.test(tile.meta),
        ),
        "the conversion gives a HEIC input tile the geometry its browser could not report",
      );
      const heicCalls = await heicPage.evaluate(() => window.calls);
      check(
        heicCalls.peak === 1 && heicCalls.total === 3,
        `repeated HEIC conversions never overlap: ${JSON.stringify(heicCalls)}`,
      );
      verify(
        await downloadTile(heicPage, 1, "gps.jpg"),
        "--format",
        "JPEG",
        "--size",
        "640x400",
        "--exif-from",
        path.join(fixtures, "gps.heic"),
      );
      await heicPage.close();

      // A blocked decoder download must be reported and stay retryable.
      const blockedPage = await open();
      await blockedPage.route(decoderURL, (route) => route.abort());
      await blockedPage.goto(converterURL);
      await expectFailure(
        blockedPage,
        "photo.heic",
        "HEIC decoder could not load",
      );
      await blockedPage.unroute(decoderURL);
      verify(
        await convertAndDownload(blockedPage, "photo.heic"),
        "--format",
        "JPEG",
        "--size",
        "640x400",
      );
      check(true, "a retry after the decoder CDN recovers converts the photo");
      await blockedPage.close();
    }

    // Mobile layout, with and without a result.
    const mobile = await browser.newContext({
      viewport: { width: 375, height: 900 },
      isMobile: true,
      hasTouch: true,
      acceptDownloads: true,
    });
    const mobileOpen = watch(mobile);
    const mobilePage = await mobileOpen();
    await mobilePage.goto(homeURL);
    await noOverflow(mobilePage, 375);
    check(
      await mobilePage.locator(".tool-nav a").first().isVisible(),
      "tool navigation stays reachable on a narrow screen",
    );
    await mobilePage.goto(converterURL);
    await noOverflow(mobilePage, 375);
    // A long filename must wrap inside its tile instead of widening the page.
    const longName = `${"holiday-photo-".repeat(9)}1.png`;
    fs.copyFileSync(
      path.join(fixtures, "photo.png"),
      path.join(fixtures, longName),
    );
    await mobilePage
      .locator("#imageFile")
      .setInputFiles([
        path.join(fixtures, longName),
        path.join(fixtures, "alpha.png"),
        path.join(fixtures, "photo.jpg"),
      ]);
    await noOverflow(mobilePage, 375);
    await waitThumbnails(mobilePage, "#sourceList");
    check(
      (await mobilePage.locator("#convertLabel").textContent()) ===
        "Convert 3 images" &&
        (await mobilePage.locator("#sourceList .tile").count()) === 3,
      "a batch is announced as such and thumbnailed on a narrow screen",
    );
    check(
      await mobilePage
        .locator(".tile")
        .evaluateAll((tiles) =>
          tiles.every(
            (tile) =>
              tile.scrollWidth <= tile.clientWidth + 1 &&
              tile.querySelector(".tile-name").scrollWidth <=
                tile.querySelector(".tile-name").clientWidth + 1,
          ),
        ),
      "a long filename wraps inside its tile instead of widening it",
    );
    await mobilePage.locator("#convertBtn").tap();
    await waitBatch(mobilePage, 60000);
    await noOverflow(mobilePage, 375);
    check(
      (await tileStates(mobilePage)).every(
        (tile) => tile.status === "done" && tile.thumbnail,
      ) &&
        (await mobilePage
          .locator("#resultList .tile")
          .first()
          .locator(".tile-download")
          .isVisible()),
      "every result keeps its thumbnail and download control on a narrow screen",
    );
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      await mobilePage.screenshot({
        path: path.join(screenshotDir, "image-converter-375.png"),
        fullPage: true,
      });
      await mobilePage.goto(homeURL);
      await mobilePage.screenshot({
        path: path.join(screenshotDir, "home-375.png"),
        fullPage: true,
      });
    }
    await mobile.close();

    // Nested pull-request preview prefix.
    await verifyPreviewPrefix(browser, open);
    await context.close();

    check(uploads.length === 0, `no file bytes are uploaded: ${uploads}`);
    check(pageErrors.length === 0, `no page errors: ${pageErrors}`);
    console.log(
      `Passed ${checks} image converter assertions and independently verified ${verified} downloads with Pillow. HEIC fixtures: ${heicFixtures ? "generated" : "skipped, pillow-heif unavailable"}; real photo: ${realHeic ? path.basename(realHeic) : "not supplied through TEST_HEIC"}.`,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
