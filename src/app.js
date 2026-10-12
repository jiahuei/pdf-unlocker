"use strict";
const el = (id) => document.getElementById(id);
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/";
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
let engine = null;
let enginePromise = null;
let engineReady = false;
let previewLibraryPromise = null;
let workerSourcePromise = null;
let workerUrl = null;
let selectedFile = null;
let operation = 0;
let downloadUrl = null;
let loadingTask = null;
let pdfDocument = null;
let renderTask = null;
let renderVersion = 0;
let currentPage = 1;
let rendering = false;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = setTimeout(
      () => finish(new Error("Library loading timed out")),
      30000,
    );
    function finish(error) {
      clearTimeout(timeout);
      script.onload = script.onerror = null;
      if (error) {
        script.remove();
        reject(error);
      } else resolve();
    }
    script.src = url;
    script.onload = () => finish();
    script.onerror = () => finish(new Error("Library unavailable"));
    document.head.append(script);
  });
}
function runtimeStatus(text, state) {
  el("runtimeText").textContent = text;
  el("runtimeStatus").dataset.state = state;
  el("retryBtn").hidden = state !== "error";
}
function ensureEngine() {
  if (engineReady) return Promise.resolve(engine);
  if (enginePromise) return enginePromise;
  runtimeStatus("Getting ready…", "loading");
  enginePromise = (async () => {
    if (!window.loadPyodide) await loadScript(`${PYODIDE_URL}pyodide.js`);
    if (!engine) engine = await window.loadPyodide({ indexURL: PYODIDE_URL });
    runtimeStatus("Preparing PDF tools…", "loading");
    await engine.loadPackage(["micropip", "cryptography"]);
    await engine.runPythonAsync(
      "import micropip\nawait micropip.install('pypdf==4.3.1')",
    );
    const response = await fetch("pdf-engine.py");
    if (!response.ok) throw new Error("PDF tools unavailable");
    engine.runPython(await response.text());
    engineReady = true;
    runtimeStatus("Ready · processed on your device", "ready");
    return engine;
  })().catch((error) => {
    enginePromise = null;
    runtimeStatus("Couldn’t load PDF tools. Check your connection.", "error");
    throw error;
  });
  return enginePromise;
}
function ensurePreviewLibrary() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!previewLibraryPromise) {
    previewLibraryPromise = loadScript(`${PDFJS_URL}pdf.min.js`)
      .then(() => window.pdfjsLib)
      .catch((error) => {
        previewLibraryPromise = null;
        throw error;
      });
  }
  return previewLibraryPromise;
}
function ensureWorkerSource() {
  if (!workerSourcePromise) {
    workerSourcePromise = fetch(`${PDFJS_URL}pdf.worker.min.js`)
      .then((response) => {
        if (!response.ok) throw new Error("Preview worker unavailable");
        return response.text();
      })
      .catch((error) => {
        workerSourcePromise = null;
        throw error;
      });
  }
  return workerSourcePromise;
}
function setBusy(busy) {
  el("unlockBtn").disabled = busy;
  el("unlockBtn").textContent = busy ? "Unlocking…" : "Unlock PDF →";
  el("unlockForm").setAttribute("aria-busy", String(busy));
}
function showMessage(message, type = "info") {
  el("message").textContent = message;
  el("message").className = `message ${type}`;
  el("message").hidden = false;
}
function clearResult() {
  operation++;
  renderVersion++;
  renderTask?.cancel();
  renderTask = null;
  // Destroying the loading task also releases its document and worker.
  if (loadingTask) loadingTask.destroy().catch(() => {});
  else if (pdfDocument) pdfDocument.destroy().catch(() => {});
  loadingTask = pdfDocument = null;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = null;
  downloadUrl = null;
  el("downloadBtn").removeAttribute("href");
  el("downloadBtn").removeAttribute("download");
  el("pdfActions").hidden = true;
  el("resultName").textContent = "";
  el("previewControls").hidden = true;
  el("pdfCanvas").hidden = true;
  el("pdfCanvas").width = el("pdfCanvas").height = 0;
  el("previewEmpty").hidden = false;
  el("previewHint").textContent =
    "Unlock your document to preview its pages here.";
  el("previewBadge").textContent = "No preview yet";
  el("pdfPreview").setAttribute("aria-busy", "false");
  el("message").hidden = true;
  currentPage = 1;
  rendering = false;
  setBusy(false);
}
function chooseFile(file) {
  clearResult();
  selectedFile = null;
  el("fileName").textContent = "Choose a PDF file";
  el("fileHelp").textContent = "or drop it here";
  el("pdfFile").removeAttribute("aria-invalid");
  if (!file) return;
  if (
    !file.size ||
    (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf")
  ) {
    el("pdfFile").value = "";
    el("pdfFile").setAttribute("aria-invalid", "true");
    showMessage("Choose a non-empty PDF file.", "error");
    return;
  }
  selectedFile = file;
  el("fileName").textContent = file.name;
  el("fileHelp").textContent =
    `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(file.size / 1024)} KB · choose another file to replace it`;
}
function decrypt(runtime, bytes, password) {
  // Call with local arguments rather than leaving document/password globals in Python.
  const unlock = runtime.globals.get("unlock_pdf");
  let result;
  try {
    result = unlock(bytes, password);
    const [status, output, encrypted, pages] = result.toJs({
      create_pyproxies: false,
    });
    return { status, bytes: output?.slice(), encrypted, pages };
  } finally {
    result?.destroy();
    unlock.destroy();
  }
}
function updatePageControls() {
  el("pageNum").textContent = String(currentPage);
  el("pageCount").textContent = String(pdfDocument.numPages);
  el("prevPage").disabled = rendering || currentPage <= 1;
  el("nextPage").disabled = rendering || currentPage >= pdfDocument.numPages;
}
async function renderPage() {
  const token = operation,
    version = ++renderVersion,
    document = pdfDocument;
  if (!document) return;
  renderTask?.cancel();
  rendering = true;
  updatePageControls();
  el("pdfPreview").setAttribute("aria-busy", "true");
  try {
    const page = await document.getPage(currentPage);
    if (token !== operation || version !== renderVersion) return;
    const base = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(100, el("pdfPreview").clientWidth - 38);
    const viewport = page.getViewport({ scale: availableWidth / base.width });
    const canvas = el("pdfCanvas"),
      density = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(viewport.width * density);
    canvas.height = Math.ceil(viewport.height * density);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    renderTask = page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: density === 1 ? null : [density, 0, 0, density, 0, 0],
    });
    await renderTask.promise;
    if (token !== operation || version !== renderVersion) return;
    el("previewEmpty").hidden = true;
    canvas.hidden = false;
    canvas.setAttribute(
      "aria-label",
      `Preview of page ${currentPage} of ${document.numPages}. Download the PDF to read its content.`,
    );
    el("previewControls").hidden = false;
    el("previewBadge").textContent = "Unlocked copy";
  } catch (error) {
    if (token !== operation || version !== renderVersion) return;
    previewUnavailable();
  } finally {
    if (token === operation && version === renderVersion) {
      rendering = false;
      renderTask = null;
      el("pdfPreview").setAttribute("aria-busy", "false");
      updatePageControls();
    }
  }
}
function previewUnavailable() {
  el("pdfCanvas").hidden = true;
  el("previewEmpty").hidden = false;
  el("previewControls").hidden = true;
  el("previewHint").textContent =
    "Preview is unavailable. Your unlocked copy is still ready to download.";
  el("previewBadge").textContent = "Download ready";
  el("pdfPreview").setAttribute("aria-busy", "false");
  showMessage(
    "Your PDF is ready. Preview is unavailable, but you can download the file.",
  );
}
async function preview(bytes, token) {
  el("previewHint").textContent = "Loading your preview…";
  el("pdfPreview").setAttribute("aria-busy", "true");
  try {
    const [library, workerSource] = await Promise.all([
      ensurePreviewLibrary(),
      ensureWorkerSource(),
    ]);
    if (token !== operation) return;
    // Own the worker URL so reset can release it; the complete source also supports PDF.js's main-thread fallback.
    workerUrl = URL.createObjectURL(
      new Blob([workerSource], { type: "application/javascript" }),
    );
    library.GlobalWorkerOptions.workerSrc = workerUrl;
    const task = library.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
    });
    loadingTask = task;
    const document = await task.promise;
    if (token !== operation) {
      await document.destroy();
      return;
    }
    pdfDocument = document;
    currentPage = 1;
    await renderPage();
  } catch (error) {
    if (token === operation) previewUnavailable();
  }
}
el("unlockForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) {
    el("pdfFile").setAttribute("aria-invalid", "true");
    showMessage("Choose a PDF file first.", "error");
    return;
  }
  clearResult();
  const token = operation,
    file = selectedFile;
  let password;
  try {
    password = StatementPasswords.derivePassword(
      el("passwordScheme").value,
      Object.fromEntries(passwordInputs.map((id) => [id, el(id).value])),
    );
  } catch (error) {
    el(error.field).setAttribute("aria-invalid", "true");
    el(error.field).focus();
    showMessage(error.message, "error");
    return;
  }
  setBusy(true);
  showMessage(
    engineReady
      ? "Unlocking your PDF…"
      : "Preparing PDF tools. Your file will stay on this device.",
  );
  try {
    const runtime = await ensureEngine();
    if (token !== operation) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (token !== operation) return;
    const result = decrypt(runtime, bytes, password);
    if (token !== operation) return;
    if (result.status !== "ok") {
      showMessage(
        result.status === "password"
          ? "That password didn’t open the PDF. Try again."
          : "This PDF could not be read. Choose a valid PDF file and try again.",
        "error",
      );
      return;
    }
    downloadUrl = URL.createObjectURL(
      new Blob([result.bytes], { type: "application/pdf" }),
    );
    el("downloadBtn").href = downloadUrl;
    el("downloadBtn").download = `unlocked_${file.name}`;
    el("resultName").textContent = `unlocked_${file.name}`;
    el("pdfActions").hidden = false;
    showMessage(
      result.encrypted
        ? "Password removed. Your unlocked copy is ready."
        : "This PDF has no password. Your original copy is ready to download.",
      result.encrypted ? "success" : "info",
    );
    setBusy(false);
    await preview(result.bytes, token);
  } catch (error) {
    if (token === operation)
      showMessage(
        engineReady
          ? "We couldn’t process this PDF. Check the file and try again."
          : "PDF tools couldn’t load. Check your connection and select Retry.",
        "error",
      );
  } finally {
    if (token === operation) setBusy(false);
  }
});
el("pdfFile").addEventListener("change", () =>
  chooseFile(el("pdfFile").files[0]),
);
const passwordInputs = [
  "password",
  "rhbSuffix",
  "rhbDate",
  "tngMobile",
  "maybankDate",
];
for (const id of passwordInputs)
  el(id).addEventListener("input", () => {
    el(id).removeAttribute("aria-invalid");
    clearResult();
  });
function updatePasswordFields() {
  for (const scheme of ["manual", "rhb", "tng", "maybank"]) {
    const fields = el(`${scheme}Fields`);
    fields.hidden = fields.disabled = scheme !== el("passwordScheme").value;
  }
  for (const id of passwordInputs) el(id).removeAttribute("aria-invalid");
  clearResult();
}
el("passwordScheme").addEventListener("change", updatePasswordFields);
el("togglePassword").addEventListener("click", () => {
  const visible = el("password").type === "password";
  el("password").type = visible ? "text" : "password";
  el("togglePassword").textContent = visible ? "Hide" : "Show";
  el("togglePassword").setAttribute(
    "aria-label",
    visible ? "Hide password" : "Show password",
  );
  el("togglePassword").setAttribute("aria-pressed", String(visible));
});
el("resetBtn").addEventListener("click", () => {
  el("unlockForm").reset();
  updatePasswordFields();
  chooseFile(null);
  el("password").type = "password";
  el("togglePassword").textContent = "Show";
  el("togglePassword").setAttribute("aria-label", "Show password");
  el("togglePassword").setAttribute("aria-pressed", "false");
});
el("retryBtn").addEventListener("click", () => ensureEngine().catch(() => {}));
el("prevPage").addEventListener("click", () => {
  if (!rendering && currentPage > 1) {
    currentPage--;
    renderPage();
  }
});
el("nextPage").addEventListener("click", () => {
  if (!rendering && pdfDocument && currentPage < pdfDocument.numPages) {
    currentPage++;
    renderPage();
  }
});
for (const type of ["dragenter", "dragover"])
  el("fileDrop").addEventListener(type, (event) => {
    event.preventDefault();
    el("fileDrop").classList.add("dragging");
  });
for (const type of ["dragleave", "drop"])
  el("fileDrop").addEventListener(type, (event) => {
    event.preventDefault();
    el("fileDrop").classList.remove("dragging");
  });
el("fileDrop").addEventListener("drop", (event) => {
  el("pdfFile").value = "";
  chooseFile(event.dataTransfer.files[0]);
});
let resizeTimeout;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (pdfDocument) renderPage();
  }, 120);
});
window.addEventListener("pagehide", clearResult);
ensureEngine().catch(() => {});
