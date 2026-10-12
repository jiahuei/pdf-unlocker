"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8001";
// The site root is now the tools directory; PDF Unlocker keeps its own page.
const pdfURL = `${baseURL}/pdf-unlocker.html`;
const fixtures = fs.mkdtempSync(
  path.join(os.tmpdir(), "pdf-unlocker-fixtures-"),
);
const downloads = fs.mkdtempSync(
  path.join(os.tmpdir(), "pdf-unlocker-downloads-"),
);
const screenshotDir = process.env.TEST_SCREENSHOTS;
const defaultStatementDate = "1993-11-01";
let realChecks = 0,
  mockedChecks = 0;
const real = (condition, message) => {
  assert.ok(condition, message);
  realChecks++;
};
const mocked = (condition, message) => {
  assert.ok(condition, message);
  mockedChecks++;
};
function python(args) {
  const process = spawnSync(global.process.env.PYTHON || "python3", args, {
    encoding: "utf8",
  });
  assert.equal(process.status, 0, process.stderr || process.stdout);
}
python([path.join(__dirname, "pdf_fixtures.py"), fixtures]);

/** Ensures responsive pages have no horizontal overflow, including selected/result states. */
async function noOverflow(page, check) {
  const dimensions = await page.evaluate(() => [
    innerWidth,
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  ]);
  check(
    Math.max(...dimensions.slice(1)) <= dimensions[0] + 1,
    `No overflow: ${dimensions}`,
  );
}
/** Ensures the password method select draws its caret on the 14px field inset and matches the other controls' height. */
async function selectCaretOnFieldInset(page, check) {
  const caret = await page.locator("#passwordScheme").evaluate((select) => {
    const style = getComputedStyle(select);
    return {
      appearance: style.appearance,
      image: style.backgroundImage.slice(0, 20),
      paddingRight: style.paddingRight,
      position: style.backgroundPosition,
      size: style.backgroundSize,
    };
  });
  check(
    caret.appearance === "none" &&
      caret.image.startsWith("url(") &&
      caret.paddingRight === "42px" &&
      caret.position.includes("14px") &&
      caret.size === "12px 8px",
    `password method caret is drawn on the field inset: ${JSON.stringify(caret)}`,
  );
  const heights = await page.evaluate(() => {
    const box = (id) =>
      +document.getElementById(id).getBoundingClientRect().height.toFixed(1);
    return { select: box("passwordScheme"), text: box("password") };
  });
  check(
    Math.abs(heights.select - heights.text) < 0.5,
    `select keeps the text field height: ${JSON.stringify(heights)}`,
  );
}
/** Ensures a statement date field keeps its declared width inside its card, the WebKit intrinsic-sizing regression. */
async function dateFieldInsideCard(page, check, id) {
  const box = await page.locator(`#${id}`).evaluate((field) => {
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    const card = field.closest(".panel").getBoundingClientRect();
    return {
      appearance: style.appearance,
      boxSizing: style.boxSizing,
      leftInset: +(rect.left - card.left).toFixed(1),
      rightInset: +(card.right - rect.right).toFixed(1),
    };
  });
  check(
    box.appearance === "none",
    `${id}: native appearance is opted out so the declared width applies in WebKit`,
  );
  check(
    box.boxSizing === "border-box",
    `${id}: padding and border stay inside the declared width`,
  );
  check(
    box.leftInset >= 0 && box.rightInset >= 0,
    `${id}: stays inside its card: ${JSON.stringify(box)}`,
  );
}
/** Ensures success downloads decrypt in the real browser and preserve their document contents. */
async function unlockAndDownload(page, name, password, outputName = name) {
  await page.locator("#pdfFile").setInputFiles(path.join(fixtures, name));
  if (typeof password === "string") {
    await page.locator("#passwordScheme").selectOption("manual");
    await page.locator("#password").fill(password);
  } else {
    await page.locator("#passwordScheme").selectOption(password.scheme);
    for (const [id, value] of Object.entries(password.fields))
      await page.locator(`#${id}`).fill(value);
  }
  await page.locator("#unlockBtn").click();
  await page
    .locator("#pdfActions")
    .waitFor({ state: "visible", timeout: 30000 });
  await page
    .locator("#pdfCanvas")
    .waitFor({ state: "visible", timeout: 30000 });
  real(
    (await page.locator("#pageCount").textContent()) === "2",
    `${name}: two pages previewed`,
  );
  real(
    await page
      .locator("#pdfCanvas")
      .evaluate((canvas) => canvas.width > 0 && canvas.height > 0),
    `${name}: preview rendered`,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#downloadBtn").click();
  const download = await downloadPromise;
  real(
    download.suggestedFilename() === `unlocked_${name}`,
    `${name}: download uses its snapshot filename`,
  );
  const file = path.join(downloads, outputName);
  await download.saveAs(file);
  python([path.join(__dirname, "verify_download.py"), file]);
  real(
    true,
    `${name}: real download verified unencrypted with content/metadata/outline/attachment`,
  );
  return file;
}
/** Creates controllable substitutes only for precise loading/cancellation/failure timing tests. */
async function controlledPage(browser, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 900 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.addInitScript((options) => {
    const mock = (window.mock = {
      decryptCalls: 0,
      proxyDestroyed: 0,
      loadWaiting: false,
      renderWaiting: false,
      readWaiting: false,
      ...options,
    });
    window.loadPyodide = async () => ({
      loadPackage: async () => {
        if (mock.delayLoad) {
          mock.loadWaiting = true;
          await new Promise((resolve) => {
            mock.releaseLoad = resolve;
          });
        }
      },
      runPythonAsync: async () => {},
      runPython: () => {},
      globals: {
        get: () => {
          const unlock = (bytes, password) => {
            mock.decryptCalls++;
            mock.password = password;
            return {
              toJs: () => ["ok", bytes.slice(), true, 2],
              destroy: () => {
                mock.proxyDestroyed++;
              },
            };
          };
          unlock.destroy = () => {
            mock.proxyDestroyed++;
          };
          return unlock;
        },
      },
    });
    if (!mock.noPreviewLibrary)
      window.pdfjsLib = {
        GlobalWorkerOptions: {},
        getDocument: () => ({
          destroy: async () => {},
          promise: Promise.resolve({
            numPages: 2,
            destroy: async () => {},
            getPage: async () => ({
              getViewport: ({ scale }) => ({
                width: 300 * scale,
                height: 420 * scale,
              }),
              render: ({ canvasContext }) => {
                if (mock.failRender)
                  return {
                    promise: Promise.reject(
                      new Error("Synthetic render failure"),
                    ),
                    cancel: () => {},
                  };
                if (mock.delayRender) {
                  mock.renderWaiting = true;
                  let cancel;
                  const promise = new Promise((resolve, reject) => {
                    mock.releaseRender = resolve;
                    cancel = () => reject(new Error("Canceled"));
                  });
                  return { promise, cancel };
                }
                canvasContext.fillRect(0, 0, 30, 30);
                return { promise: Promise.resolve(), cancel: () => {} };
              },
            }),
          }),
        }),
      };
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      if (mock.delayRead) {
        mock.readWaiting = true;
        await new Promise((resolve) => {
          mock.releaseRead = resolve;
        });
      }
      return original.call(this);
    };
  }, options);
  await page.route("**/pdf.worker.min.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "// Controlled preview worker fixture",
    }),
  );
  await page.goto(pdfURL);
  return { page, context };
}
/** Verifies real decryption separately from controlled UI races, errors and layout checks. */
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      hasTouch: true,
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const pageErrors = [],
      uploads = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      if (!["GET", "HEAD"].includes(request.method()))
        uploads.push(request.url());
    });
    await page.addInitScript(() => {
      window.urls = {
        created: 0,
        revoked: 0,
        workerBlobs: 0,
        workerRevoked: 0,
      };
      const owned = new Set();
      const workers = new Set();
      const create = URL.createObjectURL,
        revoke = URL.revokeObjectURL;
      URL.createObjectURL = (value) => {
        const url = create.call(URL, value);
        if (value.type === "application/pdf") {
          window.urls.created++;
          owned.add(url);
        } else if (value.type === "application/javascript") {
          window.urls.workerBlobs++;
          workers.add(url);
        }
        return url;
      };
      URL.revokeObjectURL = (value) => {
        if (owned.delete(value)) window.urls.revoked++;
        if (workers.delete(value)) window.urls.workerRevoked++;
        return revoke.call(URL, value);
      };
    });
    await page.goto(pdfURL);
    await page.waitForFunction(
      () => document.getElementById("runtimeStatus").dataset.state === "ready",
      null,
      { timeout: 120000 },
    );
    real(true, "Real Pyodide, cryptography and pinned pypdf initialized");
    await page.locator("#unlockBtn").click();
    real(
      (await page.locator("#message").textContent()).includes("Choose a PDF"),
      "missing file validation",
    );
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await noOverflow(page, real);
      await selectCaretOnFieldInset(page, real);
      real((await page.locator("h1").count()) === 1, "one main heading");
      if (screenshotDir && [375, 1440].includes(width)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
        await page.screenshot({
          path: path.join(screenshotDir, `${width}-empty.png`),
          fullPage: true,
        });
      }
    }
    await unlockAndDownload(page, "locked.pdf", "secret");
    real(
      await page.locator("#prevPage").isDisabled(),
      "first page disables previous",
    );
    await page.locator("#nextPage").click();
    await page.waitForFunction(
      () =>
        document.getElementById("pageNum").textContent === "2" &&
        !document.getElementById("prevPage").disabled,
    );
    real(
      await page.locator("#nextPage").isDisabled(),
      "last page disables next",
    );
    await page.locator("#prevPage").click();
    await page.waitForFunction(
      () =>
        document.getElementById("pageNum").textContent === "1" &&
        !document.getElementById("nextPage").disabled,
    );
    real(true, "preview pagination works both directions");
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForFunction(() => {
        const canvas = document.getElementById("pdfCanvas"),
          frame = document.getElementById("pdfPreview");
        return (
          frame.getAttribute("aria-busy") === "false" &&
          Math.abs(parseFloat(canvas.style.width) - (frame.clientWidth - 38)) <
            1
        );
      });
      await noOverflow(page, real);
      real(
        await page.locator("#pdfCanvas").isVisible(),
        "preview remains usable after resizing",
      );
      if (screenshotDir && [375, 1440].includes(width))
        await page.screenshot({
          path: path.join(screenshotDir, `${width}-unlocked.png`),
          fullPage: true,
        });
    }
    await page.locator("#password").fill("wrong");
    real(
      !(await page.locator("#pdfActions").isVisible()),
      "editing password invalidates download",
    );
    await page.locator("#unlockBtn").click();
    await page.waitForFunction(() =>
      document.getElementById("message").textContent.includes("didn’t open"),
    );
    real(
      !(await page.locator("#pdfActions").isVisible()),
      "wrong password exposes no previous download",
    );
    await unlockAndDownload(page, "default.pdf", "");
    real(
      (await page.locator("#password").inputValue()) === "",
      "blank input preserves default password behavior",
    );
    await unlockAndDownload(page, "whitespace.pdf", "  secret  ");
    await unlockAndDownload(page, "aes128.pdf", "secret");
    await unlockAndDownload(page, "aes256.pdf", "secret");
    const plainDownload = await unlockAndDownload(page, "plain.pdf", "");
    real(
      fs
        .readFileSync(plainDownload)
        .equals(fs.readFileSync(path.join(fixtures, "plain.pdf"))),
      "unencrypted download preserves original bytes",
    );
    real(
      (await page.locator("#message").textContent()).includes("no password"),
      "unencrypted PDF is explained",
    );
    await page.evaluate(() => {
      window.originalWorker = window.Worker;
      window.Worker = undefined;
    });
    await unlockAndDownload(page, "locked.pdf", "secret");
    real(
      await page.locator("#pdfPreview canvas").isVisible(),
      "real preview uses PDF.js fallback when native Worker is unavailable",
    );
    await page.evaluate(() => {
      window.Worker = window.originalWorker;
    });
    // Supplied bank/eWallet rules decrypt independently generated AES fixtures in the real runtime.
    for (const [name, details] of [
      [
        "rhb.pdf",
        { scheme: "rhb", fields: { rhbSuffix: "789A", rhbDate: "1981-07-29" } },
      ],
      ["tng.pdf", { scheme: "tng", fields: { tngMobile: "+6011-23456789" } }],
      [
        "maybank.pdf",
        { scheme: "maybank", fields: { maybankDate: "1980-01-01" } },
      ],
    ]) {
      await unlockAndDownload(page, name, details);
      real(
        !(await page.locator("#password").isVisible()),
        `${details.scheme}: derived password is not exposed in manual input`,
      );
      for (const width of [320, 375, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForFunction(() => {
          const canvas = document.getElementById("pdfCanvas");
          const frame = document.getElementById("pdfPreview");
          return (
            frame.getAttribute("aria-busy") === "false" &&
            Math.abs(
              parseFloat(canvas.style.width) - (frame.clientWidth - 38),
            ) < 1
          );
        });
        await noOverflow(page, real);
        for (const id of Object.keys(details.fields))
          if (id.endsWith("Date")) await dateFieldInsideCard(page, real, id);
        if (screenshotDir && [375, 1440].includes(width))
          await page.screenshot({
            path: path.join(screenshotDir, `${width}-${details.scheme}.png`),
            fullPage: true,
          });
      }
      const field = Object.keys(details.fields)[0];
      await page.setViewportSize({ width: 375, height: 1000 });
      await page
        .locator(`#${field}`)
        .fill(details.fields[field] + (field.endsWith("Date") ? "" : "0"));
      if (field.endsWith("Date"))
        await page.locator(`#${field}`).fill("1980-01-02");
      real(
        !(await page.locator("#pdfActions").isVisible()),
        `${details.scheme}: editing details discards download`,
      );
      await page.locator(`#${field}`).tap();
      real(
        await page.evaluate((id) => document.activeElement.id === id, field),
        `${details.scheme}: mobile field can receive focus`,
      );
    }
    await page.locator("#passwordScheme").selectOption("tng");
    await page.locator("#tngMobile").fill("01123456789abc");
    await page.locator("#unlockBtn").click();
    real(
      (await page.locator("#tngMobile").getAttribute("aria-invalid")) ===
        "true",
      "invalid mobile number is associated with its field",
    );
    real(
      await page.evaluate(() => document.activeElement.id === "tngMobile"),
      "invalid scheme input receives focus",
    );
    real(
      !(await page.locator("#pdfActions").isVisible()),
      "invalid scheme details produce no download",
    );
    await page.locator("#passwordScheme").selectOption("manual");
    await page
      .locator("#pdfFile")
      .setInputFiles(path.join(fixtures, "malformed.pdf"));
    real(
      !(await page.locator("#pdfActions").isVisible()),
      "changing file invalidates previous download",
    );
    await page.locator("#unlockBtn").click();
    await page.waitForFunction(() =>
      document
        .getElementById("message")
        .textContent.includes("could not be read"),
    );
    real(
      !(await page.locator("#pdfActions").isVisible()),
      "malformed PDF has no result",
    );
    await page.locator("#pdfFile").setInputFiles({
      name: "not-a-pdf.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("invalid"),
    });
    real(
      (await page.locator("#message").textContent()).includes("non-empty PDF"),
      "wrong file type rejected",
    );
    await page.locator("#pdfFile").setInputFiles({
      name: "empty.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.alloc(0),
    });
    real(
      (await page.locator("#message").textContent()).includes("non-empty PDF"),
      "empty file rejected",
    );
    const longName = "a-very-long-document-name-".repeat(6) + ".pdf";
    await page.locator("#pdfFile").setInputFiles({
      name: longName,
      mimeType: "application/pdf",
      buffer: fs.readFileSync(path.join(fixtures, "locked.pdf")),
    });
    await page.setViewportSize({ width: 320, height: 900 });
    await noOverflow(page, real);
    real(
      (await page.locator("#fileName").textContent()) === longName,
      "full filename stays accessible",
    );
    await page.locator("#password").fill("secret");
    await page.locator("#togglePassword").tap();
    real(
      (await page.locator("#password").getAttribute("type")) === "text",
      "touch password visibility",
    );
    real(
      (await page.locator("#togglePassword").getAttribute("aria-pressed")) ===
        "true",
      "password visibility announced",
    );
    await page.locator("#password").tap();
    real(
      await page.evaluate(() => document.activeElement.id === "password"),
      "mobile password receives focus",
    );
    await page.locator("#resetBtn").tap();
    real(
      (await page.locator("#password").inputValue()) === "",
      "reset clears password",
    );
    real(
      (await page.locator("#password").getAttribute("type")) === "password",
      "reset hides password",
    );
    real(
      !(await page.locator("#pdfActions").isVisible()),
      "reset clears results",
    );
    real(
      (await page.locator("#passwordScheme").inputValue()) === "manual",
      "reset restores manual method",
    );
    // Reset restores each control's HTML default value, which pins the prefilled statement dates.
    for (const [id, value] of [
      ["rhbSuffix", ""],
      ["rhbDate", defaultStatementDate],
      ["tngMobile", ""],
      ["maybankDate", defaultStatementDate],
    ])
      real(
        (await page.locator(`#${id}`).inputValue()) === value,
        `reset restores ${id} to its default`,
      );
    real(
      await page.evaluate(() => window.urls.created === window.urls.revoked),
      "reset releases all owned result URLs",
    );
    real(
      await page.evaluate(
        () => window.urls.workerBlobs === window.urls.workerRevoked,
      ),
      "reset releases all owned preview worker URLs",
    );
    real(
      uploads.length === 0,
      "PDF/password never sent by POST or upload request",
    );
    real(pageErrors.length === 0, `No unhandled runtime errors: ${pageErrors}`);
    await context.close();

    // These controlled tests exercise UI timing only; real decryption is covered above.
    for (const change of ["scheme", "details"]) {
      const { page, context } = await controlledPage(browser, {
        delayLoad: true,
      });
      await page
        .locator("#pdfFile")
        .setInputFiles(path.join(fixtures, "rhb.pdf"));
      await page.locator("#passwordScheme").selectOption("rhb");
      await page.locator("#rhbSuffix").fill("789A");
      await page.locator("#rhbDate").fill("1981-07-29");
      await page.locator("#unlockBtn").tap();
      await page.waitForFunction(() => window.mock.loadWaiting);
      if (change === "scheme")
        await page.locator("#passwordScheme").selectOption("maybank");
      else await page.locator("#rhbSuffix").fill("789B");
      await page.evaluate(() => window.mock.releaseLoad());
      await page.waitForFunction(
        () =>
          document.getElementById("runtimeStatus").dataset.state === "ready",
      );
      mocked(
        await page.evaluate(() => window.mock.decryptCalls === 0),
        `${change}: change cancels queued derived password`,
      );
      mocked(
        !(await page.locator("#pdfActions").isVisible()),
        `${change}: old work cannot restore result`,
      );
      mocked(
        !(await page.locator("#unlockBtn").isDisabled()),
        `${change}: next unlock stays available`,
      );
      await context.close();
    }
    for (const type of ["delayLoad", "delayRead", "delayRender"]) {
      const { page, context } = await controlledPage(browser, { [type]: true });
      if (type !== "delayLoad")
        await page.waitForFunction(
          () =>
            document.getElementById("runtimeStatus").dataset.state === "ready",
        );
      await page
        .locator("#pdfFile")
        .setInputFiles(path.join(fixtures, "locked.pdf"));
      await page.locator("#password").fill("secret");
      await page.locator("#unlockBtn").tap();
      const waiting = {
        delayLoad: "loadWaiting",
        delayRead: "readWaiting",
        delayRender: "renderWaiting",
      }[type];
      await page.waitForFunction((key) => window.mock[key], waiting);
      await page.locator("#resetBtn").tap();
      await page.evaluate(
        (type) =>
          window.mock[
            {
              delayLoad: "releaseLoad",
              delayRead: "releaseRead",
              delayRender: "releaseRender",
            }[type]
          ](),
        type,
      );
      if (type === "delayLoad")
        await page.waitForFunction(
          () =>
            document.getElementById("runtimeStatus").dataset.state === "ready",
        );
      await page.waitForTimeout(80);
      mocked(
        !(await page.locator("#pdfActions").isVisible()),
        `${type}: stale completion cannot restore result`,
      );
      mocked(
        !(await page.locator("#pdfCanvas").isVisible()),
        `${type}: stale completion cannot restore preview`,
      );
      mocked(
        !(await page.locator("#unlockBtn").isDisabled()),
        `${type}: reset enables submit`,
      );
      if (type !== "delayRender")
        mocked(
          await page.evaluate(() => window.mock.decryptCalls === 0),
          `${type}: reset prevents queued decryption`,
        );
      else
        mocked(
          await page.evaluate(() => window.mock.proxyDestroyed === 2),
          "function and result proxies released",
        );
      await context.close();
    }
    {
      const { page, context } = await controlledPage(browser, {
        delayLoad: true,
      });
      await page
        .locator("#pdfFile")
        .setInputFiles(path.join(fixtures, "locked.pdf"));
      await page.locator("#unlockBtn").tap();
      await page.waitForFunction(() => window.mock.loadWaiting);
      await page
        .locator("#pdfFile")
        .setInputFiles(path.join(fixtures, "plain.pdf"));
      await page.evaluate(() => window.mock.releaseLoad());
      await page.waitForFunction(
        () =>
          document.getElementById("runtimeStatus").dataset.state === "ready",
      );
      mocked(
        await page.evaluate(() => window.mock.decryptCalls === 0),
        "replacement file cancels queued old-document unlock",
      );
      mocked(
        (await page.locator("#fileName").textContent()) === "plain.pdf",
        "replacement selection survives old runtime completion",
      );
      await page.locator("#unlockBtn").tap();
      await page.locator("#pdfActions").waitFor({ state: "visible" });
      mocked(
        (await page.locator("#downloadBtn").getAttribute("download")) ===
          "unlocked_plain.pdf",
        "next unlock uses the replacement snapshot filename",
      );
      await context.close();
    }
    {
      const { page, context } = await controlledPage(browser, {
        failRender: true,
      });
      await page
        .locator("#pdfFile")
        .setInputFiles(path.join(fixtures, "locked.pdf"));
      await page.locator("#unlockBtn").tap();
      await page.waitForFunction(() =>
        document
          .getElementById("previewHint")
          .textContent.includes("unavailable"),
      );
      mocked(
        await page.locator("#pdfActions").isVisible(),
        "render failure retains download",
      );
      mocked(
        (await page.locator("#downloadBtn").getAttribute("href")).startsWith(
          "blob:",
        ),
        "render failure retains actual blob link",
      );
      mocked(
        !(await page.locator("#previewControls").isVisible()),
        "failed render has no misleading page controls",
      );
      await context.close();
    }
    {
      const { page, context } = await controlledPage(browser, {
        noPreviewLibrary: true,
      });
      await page.route("**/pdf.min.js", (route) => route.abort());
      await page
        .locator("#pdfFile")
        .setInputFiles(path.join(fixtures, "locked.pdf"));
      await page.locator("#unlockBtn").tap();
      await page.waitForFunction(() =>
        document
          .getElementById("previewHint")
          .textContent.includes("unavailable"),
      );
      mocked(
        await page.locator("#pdfActions").isVisible(),
        "preview CDN failure does not lose download",
      );
      await context.close();
    }
    {
      const context = await browser.newContext({
        viewport: { width: 375, height: 900 },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      await page.route("**/pyodide.js", (route) => route.abort());
      await page.goto(pdfURL);
      await page.waitForFunction(
        () =>
          document.getElementById("runtimeStatus").dataset.state === "error",
      );
      real(
        await page.locator("#retryBtn").isVisible(),
        "runtime CDN failure offers retry",
      );
      await page.unroute("**/pyodide.js");
      await page.locator("#retryBtn").tap();
      await page.waitForFunction(
        () =>
          document.getElementById("runtimeStatus").dataset.state === "ready",
        null,
        { timeout: 120000 },
      );
      real(
        !(await page.locator("#retryBtn").isVisible()),
        "real runtime retry recovers",
      );
      await unlockAndDownload(page, "default.pdf", "", "retry-default.pdf");
      await noOverflow(page, real);
      await context.close();
    }
    console.log(
      `Passed ${realChecks} real browser/runtime/download assertions and ${mockedChecks} controlled UI race/failure assertions. Downloads independently verified by pypdf; viewport widths320/375/768/1440.`,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
