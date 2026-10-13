"use strict";
const el = (id) => document.getElementById(id);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const STATUS_TEXT = { ready: "Ready to convert", converting: "Converting…" };
// One entry per chosen file, in selection order. Duplicate names stay separate entries, so an
// entry is identified by itself and its download name is allocated across the whole batch.
// Each entry also holds the row elements rendered for it, which are updated in place so that
// activating a row control cannot move the focus away from it.
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
/** Reports the outcome of a finished batch; each row carries its own file's reason. */
function batchMessage(total, failed) {
  if (!failed)
    return total === 1
      ? ["Your converted image is ready to download.", "success"]
      : [`Your ${total} converted images are ready to download.`, "success"];
  if (failed === total)
    return total === 1
      ? ["This image could not be converted. Its entry explains why.", "error"]
      : [
          `None of the ${total} images could be converted. The list explains why.`,
          "error",
        ];
  return [
    `${failed} of ${total} images could not be converted. The others are ready to download.`,
    "error",
  ];
}
function updateRow(entry) {
  const { result, error, status } = entry;
  entry.row.dataset.status = status;
  entry.row.toggleAttribute("data-preview", previewed === entry);
  // Filenames and conversion errors are written as text only, so neither can inject markup.
  entry.meta.textContent = result
    ? [
        `${result.name} · ${result.width} × ${result.height} px`,
        sizeLabel(result.size),
        result.exif,
      ]
        .filter(Boolean)
        .join(" · ")
    : error || [sizeLabel(entry.file.size), STATUS_TEXT[status]].join(" · ");
  entry.previewBtn.hidden = !result;
  entry.downloadBtn.hidden = !result;
  if (!result) {
    entry.downloadBtn.removeAttribute("href");
    entry.downloadBtn.removeAttribute("download");
    return;
  }
  entry.downloadBtn.href = result.url;
  entry.downloadBtn.download = result.name;
}
function render() {
  for (const entry of entries) updateRow(entry);
  el("batchPanel").hidden = !entries.length;
  el("batchSummary").textContent = summaryText();
  el("convertLabel").textContent = submitLabel();
}
function createRow(entry) {
  const row = document.createElement("li");
  row.className = "result-row";
  const text = document.createElement("div");
  text.className = "result-text";
  const name = document.createElement("p");
  name.className = "result-name";
  name.textContent = entry.file.name;
  const meta = document.createElement("p");
  meta.className = "result-meta";
  const controls = document.createElement("div");
  controls.className = "result-controls";
  const previewBtn = document.createElement("button");
  previewBtn.type = "button";
  previewBtn.className = "row-button row-preview";
  previewBtn.textContent = "Preview";
  previewBtn.addEventListener("click", () => showPreview(entry));
  const downloadBtn = document.createElement("a");
  downloadBtn.className = "row-button primary row-download";
  downloadBtn.textContent = "Download";
  controls.append(previewBtn, downloadBtn);
  text.append(name, meta);
  row.append(text, controls);
  Object.assign(entry, { row, meta, previewBtn, downloadBtn });
  updateRow(entry);
  return row;
}
/** Releases every result URL this page owns, so replaced or discarded work cannot leak. */
function releaseResults() {
  for (const entry of entries)
    if (entry.result) {
      URL.revokeObjectURL(entry.result.url);
      entry.result = null;
    }
}
function clearPreview() {
  previewed = null;
  el("resultPreview").removeAttribute("src");
  el("resultPreview").hidden = true;
  el("previewEmpty").hidden = false;
  el("previewBadge").textContent = "No conversion yet";
}
// One preview panel is shared by the whole batch: decoding every output into its own thumbnail
// would hold a bitmap per result for as long as the batch is on screen.
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
  entries = [...files].map((file) => ({
    file,
    status: "ready",
    error: null,
    result: null,
  }));
  el("resultList").replaceChildren(...entries.map(createRow));
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
      entry.result = {
        url: URL.createObjectURL(result.blob),
        name: names[index],
        label: output.label,
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
      // The first result is shown without a click; later ones leave the chosen preview alone.
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
