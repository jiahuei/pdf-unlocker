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
/** Converts one fixture in the real browser and returns the downloaded file path. */
async function convertAndDownload(page, fixture, options = {}) {
  const format = options.format || "jpeg";
  const extension = { jpeg: "jpg", png: "png", webp: "webp" }[format];
  const expected = `${fixture.replace(/\.[^.]+$/, "")}.${extension}`;
  await page.locator("#imageFile").setInputFiles(path.join(fixtures, fixture));
  await page.locator("#outputFormat").selectOption(format);
  if (options.keepExif !== undefined)
    await page.locator("#keepExif").setChecked(options.keepExif);
  if (options.quality !== undefined)
    await page.locator("#quality").fill(String(options.quality));
  await page.locator("#convertBtn").click();
  await page
    .locator("#imageActions")
    .waitFor({ state: "visible", timeout: 120000 });
  check(
    (await page.locator("#resultName").textContent()) === expected,
    `${fixture} to ${format}: result named ${expected}`,
  );
  check(
    /^\d+ × \d+ px · /.test(await page.locator("#resultMeta").textContent()),
    `${fixture} to ${format}: result reports its geometry`,
  );
  check(
    await page.locator("#resultPreview").isVisible(),
    `${fixture} to ${format}: preview shown`,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#downloadBtn").click();
  const download = await downloadPromise;
  check(
    download.suggestedFilename() === expected,
    `${fixture} to ${format}: download offers ${expected}`,
  );
  const file = path.join(downloads, `${++downloaded}-${expected}`);
  await download.saveAs(file);
  return file;
}
/** Asserts an actionable error is announced and that another attempt stays possible. */
async function expectFailure(page, fixture, fragment) {
  await page.locator("#imageFile").setInputFiles(path.join(fixtures, fixture));
  await page.locator("#convertBtn").click();
  await page
    .locator("#message.error")
    .waitFor({ state: "visible", timeout: 120000 });
  const message = await page.locator("#message").textContent();
  check(
    message.includes(fragment),
    `${fixture}: "${message}" explains "${fragment}"`,
  );
  check(
    await page.locator("#imageActions").isHidden(),
    `${fixture}: no result offered after failure`,
  );
  check(
    !(await page.locator("#convertBtn").isDisabled()),
    `${fixture}: another attempt stays possible`,
  );
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
    await page
      .locator("#imageActions")
      .waitFor({ state: "visible", timeout: 60000 });
    check(
      (await page.locator("#resultName").textContent()) === "photo.jpg",
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
      (await page.locator("h1").textContent()) === "Convert your image",
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
      (await page.locator("#resultMeta").textContent()).includes("EXIF kept"),
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
      (await page.locator("#resultMeta").textContent()).includes(
        "no EXIF in the source",
      ),
      "a source without EXIF is reported rather than implied",
    );
    check(
      await page.locator("#imageActions").isVisible(),
      "a result is shown before the setting changes",
    );
    await page.locator("#keepExif").setChecked(false);
    check(
      await page.locator("#imageActions").isHidden(),
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
      .setInputFiles(path.join(fixtures, "photo.png"));
    await page.locator("#convertBtn").focus();
    await page.keyboard.press("Enter");
    await page
      .locator("#imageActions")
      .waitFor({ state: "visible", timeout: 60000 });
    check(true, "Enter on the focused button converts the image");

    // An unsupported encoder must fail clearly rather than relabel PNG bytes.
    await page.evaluate(() => {
      HTMLCanvasElement.prototype.toBlob = function (callback) {
        callback(new Blob(["stub"], { type: "image/png" }));
      };
    });
    await page.locator("#outputFormat").selectOption("webp");
    await page.locator("#convertBtn").click();
    await page
      .locator("#message.error")
      .waitFor({ state: "visible", timeout: 30000 });
    check(
      (await page.locator("#message").textContent()).includes(
        "cannot create WebP",
      ),
      "a missing WebP encoder is reported instead of returning PNG bytes",
    );
    await page.close();

    // Object URLs are released on reset and on replacement.
    const trackedPage = await open();
    await trackObjectURLs(trackedPage);
    await trackedPage.goto(converterURL);
    // A retained-metadata choice must not survive reset, or the next photo leaks its position.
    await trackedPage.locator("#keepExif").setChecked(true);
    await trackedPage
      .locator("#imageFile")
      .setInputFiles(path.join(fixtures, "photo.png"));
    await trackedPage.locator("#quality").fill("75");
    await trackedPage.locator("#convertBtn").click();
    await trackedPage
      .locator("#imageActions")
      .waitFor({ state: "visible", timeout: 60000 });
    check(
      (await trackedPage.evaluate(() => window.urls)).created === 1,
      "one image object URL is created per conversion",
    );
    await trackedPage.locator("#resetBtn").click();
    check(
      (await trackedPage.evaluate(() => window.urls)).revoked === 1,
      "reset revokes the result URL",
    );
    check(
      (await trackedPage.locator("#fileName").textContent()) ===
        "Choose an image",
      "reset clears the chosen file",
    );
    check(
      (await trackedPage.locator("#outputFormat").inputValue()) === "jpeg" &&
        (await trackedPage.locator("#quality").inputValue()) === "80" &&
        (await trackedPage.locator("#qualityValue").textContent()) === "80" &&
        !(await trackedPage.locator("#keepExif").isChecked()),
      "reset restores the documented defaults",
    );
    check(
      (await trackedPage.locator("#imageActions").isHidden()) &&
        (await trackedPage.locator("#resultPreview").getAttribute("src")) ===
          null,
      "reset clears the stale result and its preview source",
    );
    for (const fixture of ["photo.jpg", "photo.png"]) {
      await trackedPage
        .locator("#imageFile")
        .setInputFiles(path.join(fixtures, fixture));
      await trackedPage.locator("#convertBtn").click();
      await trackedPage
        .locator("#imageActions")
        .waitFor({ state: "visible", timeout: 60000 });
    }
    const urls = await trackedPage.evaluate(() => window.urls);
    check(
      urls.created === 3 && urls.revoked === 2,
      `each replaced result releases its URL, keeping only the current one: ${JSON.stringify(urls)}`,
    );
    await trackedPage.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide")),
    );
    check(
      (await trackedPage.evaluate(() => window.urls)).revoked === urls.created,
      "leaving the page releases the remaining result URL",
    );
    await trackedPage.close();

    if (heicFixtures) {
      // A pending conversion must not resurface after the file is replaced.
      const racedPage = await open();
      let releaseDecoder;
      await racedPage.route(decoderURL, async (route) => {
        await new Promise((resolve) => (releaseDecoder = resolve));
        await route.continue();
      });
      await racedPage.goto(converterURL);
      await racedPage
        .locator("#imageFile")
        .setInputFiles(path.join(fixtures, "photo.heic"));
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
      const pending = racedPage.waitForResponse(decoderURL, { timeout: 60000 });
      releaseDecoder();
      await pending;
      await racedPage.locator("#convertBtn").click();
      await racedPage
        .locator("#imageActions")
        .waitFor({ state: "visible", timeout: 60000 });
      check(
        (await racedPage.locator("#resultName").textContent()) === "photo.png",
        "the replaced file's conversion is the one shown",
      );
      // Give the discarded HEIC conversion time to finish after the replacement.
      await racedPage.waitForTimeout(4000);
      check(
        (await racedPage.locator("#resultName").textContent()) === "photo.png",
        "a conversion started before the replacement stays discarded",
      );
      await racedPage.close();

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
    await mobilePage
      .locator("#imageFile")
      .setInputFiles(path.join(fixtures, "photo.png"));
    await noOverflow(mobilePage, 375);
    await mobilePage.locator("#convertBtn").tap();
    await mobilePage
      .locator("#imageActions")
      .waitFor({ state: "visible", timeout: 60000 });
    await noOverflow(mobilePage, 375);
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
