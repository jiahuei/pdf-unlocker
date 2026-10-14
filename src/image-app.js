"use strict";
const el = (id) => document.getElementById(id);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const STATUS_TEXT = { ready: "Ready to convert", converting: "Converting…" };
/** Reports "1447 × 1087 px" for a source or a result, and nothing until the geometry is known. */
const geometry = (item) =>
  item.width ? `${item.width} × ${item.height} px` : "";
// One entry per chosen file, in selection order. Duplicate names stay separate entries, so an
// entry is identified by itself and its download name is allocated across the whole batch.
// Each entry owns its two gallery tiles and the object URLs behind them, and those tiles are
// updated in place so that activating a tile control cannot move the focus away from it.
let entries = [];
let previewed = null;
let busy = false;
// Incremented whenever the files or the settings change, so queued or in-flight work can be
// discarded instead of writing results the user has already replaced.
let operation = 0;
// Every conversion is chained through this promise. The shared HEIF decoder releases its previous
// context when it decodes again, so two conversions must never overlap: an invalidated batch keeps
// the decoder until its current file settles, and its stale token stops it from starting the next.
let queue = Promise.resolve();

function selectedOutput() {
  return ImageConverter.OUTPUTS.find(
    (output) => output.id === el("outputFormat").value,
  );
}
function sizeLabel(bytes) {
  if (!bytes) return "0 KB";
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function showMessage(message, type = "info") {
  el("message").textContent = message;
  el("message").className = `message ${type}`;
  el("message").hidden = false;
}
function submitLabel() {
  if (busy) return "Converting…";
  return entries.length > 1
    ? `Convert ${entries.length} images`
    : "Convert image";
}
function setBusy(value) {
  busy = value;
  el("convertBtn").disabled = value;
  el("convertForm").setAttribute("aria-busy", String(value));
  render();
}
function summaryText() {
  const total = entries.length;
  const done = entries.filter((entry) => entry.status === "done").length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  if (done + failed < total)
    return entries.some((entry) => entry.status === "converting")
      ? `Converting image ${done + failed + 1} of ${total}…`
      : `${plural(total, "image")} ready to convert`;
  if (!failed) return `Converted ${plural(done, "image")}`;
  return done
    ? `Converted ${done} of ${total}, ${plural(failed, "image")} failed`
    : `None of the ${plural(total, "image")} converted`;
}
/** Reports the outcome of a finished batch; each tile carries its own file's reason. */
function batchMessage(total, failed) {
  if (!failed)
    return total === 1
      ? ["Your converted image is ready to download.", "success"]
      : [`Your ${total} converted images are ready to download.`, "success"];
  if (failed === total)
    return total === 1
      ? ["This image could not be converted. Its tile explains why.", "error"]
      : [
          `None of the ${total} images could be converted. Each tile explains why.`,
          "error",
        ];
  return [
    `${failed} of ${total} images could not be converted. The others are ready to download.`,
    "error",
  ];
}
/** Builds the tile chrome both galleries share: a thumbnail frame and a text caption. */
function tileShell(entry, previewable, onLoad) {
  const tile = document.createElement("li");
  tile.className = "tile";
  // A converted result's thumbnail doubles as its preview control, which keeps one large touch
  // target instead of a separate button; every other tile stays a plain frame.
  const frame = document.createElement(previewable ? "button" : "div");
  frame.className = "tile-frame";
  if (previewable) {
    frame.type = "button";
    frame.addEventListener("click", () => showPreview(entry));
  }
  const symbol = document.createElement("span");
  symbol.className = "tile-symbol";
  symbol.setAttribute("aria-hidden", "true");
  symbol.textContent = "▣";
  const image = document.createElement("img");
  // The caption names the file, so the thumbnail itself is decorative. Lazy decoding keeps a
  // large batch from holding every full-size image at once.
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("load", () => {
    image.dataset.loaded = "";
    onLoad?.(image);
  });
  const name = document.createElement("p");
  name.className = "tile-name";
  name.textContent = entry.file.name;
  const meta = document.createElement("p");
  meta.className = "tile-meta";
  const caption = document.createElement("div");
  caption.className = "tile-caption";
  frame.append(symbol, image);
  caption.append(name, meta);
  tile.append(frame, caption);
  return { tile, frame, image, name, meta };
}
/** Shares the download glyph while each gallery supplies its own filename and accessible label. */
function downloadLink(className) {
  const link = document.createElement("a");
  link.className = `icon-button tile-button ${className}`;
  link.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false"><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/></svg>`;
  return link;
}
function sourceTile(entry) {
  const parts = tileShell(entry, false, (image) => {
    // Chromium reports oriented geometry for JPEG and PNG but ignores WebP EXIF orientation and
    // cannot render HEIC at all, so a finished conversion overwrites these numbers with its own.
    if (entry.result) return;
    entry.width = image.naturalWidth;
    entry.height = image.naturalHeight;
    updateEntry(entry);
  });
  const download = downloadLink("tile-source-download");
  download.href = entry.sourceUrl;
  download.download = entry.file.name;
  download.title = `Download input ${entry.file.name}`;
  download.setAttribute("aria-label", download.title);
  parts.tile.append(download);
  return parts;
}
function resultTile(entry) {
  const parts = tileShell(entry, true);
  const download = downloadLink("tile-download");
  parts.tile.append(download);
  parts.download = download;
  return parts;
}
/** Renders one entry into both galleries. Filenames and errors are written as text only. */
function updateEntry(entry) {
  entry.sourceTile.meta.textContent = [
    geometry(entry),
    sizeLabel(entry.file.size),
  ]
    .filter(Boolean)
    .join(" · ");
  const { result, error, status } = entry;
  const tile = entry.resultTile;
  tile.tile.dataset.status = status;
  tile.tile.toggleAttribute("data-preview", previewed === entry);
  tile.name.textContent = result ? result.name : entry.file.name;
  tile.meta.textContent = result
    ? [geometry(result), sizeLabel(result.size), result.exif, result.notice]
        .filter(Boolean)
        .join(" · ")
    : error || STATUS_TEXT[status];
  tile.frame.disabled = !result;
  tile.download.hidden = !result;
  if (!result) {
    tile.image.removeAttribute("src");
    delete tile.image.dataset.loaded;
    tile.frame.removeAttribute("aria-label");
    tile.download.removeAttribute("href");
    tile.download.removeAttribute("download");
    return;
  }
  // Compared first: reassigning the same blob URL would decode the thumbnail again.
  if (tile.image.getAttribute("src") !== result.url) {
    delete tile.image.dataset.loaded;
    tile.image.src = result.url;
  }
  tile.frame.setAttribute("aria-label", `Preview ${result.name}`);
  tile.download.href = result.url;
  tile.download.download = result.name;
  tile.download.title = `Download converted ${result.name}`;
  tile.download.setAttribute("aria-label", tile.download.title);
}
function createTiles(entry) {
  entry.sourceTile = sourceTile(entry);
  entry.resultTile = resultTile(entry);
  // Assigned last: the thumbnail's load handler renders the entry, which needs both tiles.
  entry.sourceTile.image.src = entry.sourceUrl;
  updateEntry(entry);
}
function render() {
  for (const entry of entries) updateEntry(entry);
  el("sourceList").hidden = !entries.length;
  el("batchPanel").hidden = !entries.length;
  el("batchSummary").textContent = summaryText();
  el("convertLabel").textContent = submitLabel();
}
/** Releases every result URL this page owns, so replaced or discarded work cannot leak. */
function releaseResults() {
  for (const entry of entries)
    if (entry.result) {
      URL.revokeObjectURL(entry.result.url);
      entry.result = null;
    }
}
/**
 * Source thumbnails and downloads belong to the selection, so only replacing or clearing it
 * releases them. Hiding the page keeps them: a back/forward-cache restore would otherwise leave
 * broken thumbnails and downloads for files that are still chosen.
 */
function releaseSources() {
  for (const entry of entries) {
    URL.revokeObjectURL(entry.sourceUrl);
    entry.sourceUrl = null;
  }
}
function clearPreview() {
  previewed = null;
  el("resultPreview").removeAttribute("src");
  el("resultPreview").hidden = true;
  el("previewEmpty").hidden = false;
  el("previewBadge").textContent = "No conversion yet";
}
// One large preview is shared by the batch; the tiles carry their own thumbnails.
function showPreview(entry) {
  previewed = entry;
  el("resultPreview").src = entry.result.url;
  el("resultPreview").alt =
    `Preview of ${entry.result.name}, ${entry.result.width} by ${entry.result.height} pixels`;
  el("resultPreview").hidden = false;
  el("previewEmpty").hidden = true;
  el("previewBadge").textContent = entry.result.label;
  render();
}
/** Discards results and pending work: a later completion must not touch the current selection. */
function invalidate() {
  operation++;
  releaseResults();
  for (const entry of entries) {
    entry.status = "ready";
    entry.error = null;
  }
  clearPreview();
  el("message").hidden = true;
  setBusy(false);
}
function chooseFiles(files) {
  // Invalidate first: the entries being replaced still own the URLs that have to be released.
  invalidate();
  releaseSources();
  entries = [...files].map((file) => ({
    file,
    status: "ready",
    error: null,
    result: null,
    sourceUrl: URL.createObjectURL(file),
  }));
  entries.forEach(createTiles);
  el("sourceList").replaceChildren(
    ...entries.map((entry) => entry.sourceTile.tile),
  );
  el("resultList").replaceChildren(
    ...entries.map((entry) => entry.resultTile.tile),
  );
  el("imageFile").removeAttribute("aria-invalid");
  const total = entries.reduce((sum, entry) => sum + entry.file.size, 0);
  el("fileName").textContent = entries.length
    ? `${plural(entries.length, "image")} chosen`
    : "Choose images";
  el("fileHelp").textContent = entries.length
    ? `${sizeLabel(total)} in total · choose again to replace them`
    : "or drop them here";
  render();
}
function updateOutputFields() {
  el("qualityField").hidden = !selectedOutput().lossy;
  el("qualityValue").textContent = el("quality").value;
  invalidate();
}
async function runBatch(token, batch, { output, quality, keepExif }) {
  // Allocated once for the whole batch, so colliding source names still download distinctly.
  const names = ImageConverter.outputNames(
    batch.map((entry) => entry.file.name),
    output.extension,
  );
  for (const [index, entry] of batch.entries()) {
    if (token !== operation) return;
    entry.status = "converting";
    render();
    try {
      const result = await ImageConverter.convert(entry.file, output, quality, {
        keepExif,
        onStage: (stage) => {
          if (token === operation && stage === "codec")
            showMessage(
              "Loading the HEIC decoder. This one-off download happens in your browser.",
            );
        },
      });
      // Checked before the URL is created: nothing would ever revoke a stale result's URL.
      if (token !== operation) return;
      entry.status = "done";
      // The output keeps the source geometry, which is also the only geometry this page can
      // report for a HEIC file: no browser can render one as a thumbnail.
      entry.width = result.width;
      entry.height = result.height;
      entry.result = {
        url: URL.createObjectURL(result.blob),
        name: names[index],
        label: output.label,
        notice:
          result.imageCount > 1
            ? `This file holds ${result.imageCount} images. Only the first image was kept.`
            : "",
        width: result.width,
        height: result.height,
        size: result.blob.size,
        // Say so when the user asked to keep EXIF and the file could not carry it.
        exif: {
          kept: "EXIF kept",
          none: keepExif ? "no EXIF in the source" : "",
          "too-large": "EXIF too large to keep",
        }[result.exif],
      };
      // The first result is shown large without a click; later ones leave that choice alone.
      if (!previewed) showPreview(entry);
    } catch (error) {
      if (token !== operation) return;
      entry.status = "failed";
      entry.error = error.code
        ? error.message
        : "We couldn’t convert this image. Choose another file and try again.";
    }
    render();
  }
  if (token !== operation) return;
  setBusy(false);
  const failed = batch.filter((entry) => entry.status === "failed").length;
  showMessage(...batchMessage(batch.length, failed));
}
el("convertForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!entries.length) {
    el("imageFile").setAttribute("aria-invalid", "true");
    showMessage("Choose at least one image file.", "error");
    return;
  }
  invalidate();
  const token = operation;
  const batch = [...entries];
  const settings = {
    output: selectedOutput(),
    quality: Number(el("quality").value) / 100,
    keepExif: el("keepExif").checked,
  };
  setBusy(true);
  showMessage(`Converting ${plural(batch.length, "image")} on this device…`);
  const run = () => runBatch(token, batch, settings);
  // Both handlers start this batch, so an earlier batch that throws cannot stall the queue.
  queue = queue.then(run, run);
});
el("imageFile").addEventListener("change", () =>
  chooseFiles(el("imageFile").files),
);
el("outputFormat").addEventListener("change", updateOutputFields);
el("quality").addEventListener("input", updateOutputFields);
el("keepExif").addEventListener("change", invalidate);
el("resetBtn").addEventListener("click", () => {
  el("convertForm").reset();
  chooseFiles([]);
  updateOutputFields();
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
  el("imageFile").value = "";
  chooseFiles(event.dataTransfer.files);
});
// The format table in the conversion module is the single source of truth for the picker, so the
// offered options cannot drift from the formats the converter actually writes.
for (const output of ImageConverter.OUTPUTS)
  el("outputFormat").append(new Option(output.label, output.id));
// Unsupported encoders are removed choices rather than failed conversions: canvas.toBlob would
// quietly return PNG bytes for a format the browser cannot write.
(async () => {
  const options = el("outputFormat").options;
  for (const [index, output] of ImageConverter.OUTPUTS.entries()) {
    if (await ImageConverter.encoderSupport(output)) continue;
    options[index].disabled = true;
    options[index].textContent = `${output.label} — unsupported here`;
  }
})();
window.addEventListener("pagehide", invalidate);
