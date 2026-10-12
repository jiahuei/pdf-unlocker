"use strict";
const el = (id) => document.getElementById(id);
let selectedFile = null;
let operation = 0;
let resultUrl = null;

function selectedOutput() {
  return ImageConverter.OUTPUTS.find(
    (output) => output.id === el("outputFormat").value,
  );
}
function sizeLabel(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function showMessage(message, type = "info") {
  el("message").textContent = message;
  el("message").className = `message ${type}`;
  el("message").hidden = false;
}
function setBusy(busy) {
  el("convertBtn").disabled = busy;
  el("convertBtn").textContent = busy ? "Converting…" : "Convert image →";
  el("convertForm").setAttribute("aria-busy", String(busy));
}
function clearResult() {
  operation++;
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  el("downloadBtn").removeAttribute("href");
  el("downloadBtn").removeAttribute("download");
  el("imageActions").hidden = true;
  el("resultName").textContent = "";
  el("resultMeta").textContent = "";
  el("resultPreview").removeAttribute("src");
  el("resultPreview").hidden = true;
  el("previewEmpty").hidden = false;
  el("previewBadge").textContent = "No conversion yet";
  el("message").hidden = true;
  setBusy(false);
}
function chooseFile(file) {
  clearResult();
  selectedFile = null;
  el("fileName").textContent = "Choose an image";
  el("fileHelp").textContent = "or drop it here";
  el("imageFile").removeAttribute("aria-invalid");
  if (!file) return;
  if (!file.size) {
    el("imageFile").value = "";
    el("imageFile").setAttribute("aria-invalid", "true");
    showMessage("Choose a non-empty image file.", "error");
    return;
  }
  selectedFile = file;
  el("fileName").textContent = file.name;
  el("fileHelp").textContent =
    `${sizeLabel(file.size)} · choose another file to replace it`;
}
function updateOutputFields() {
  el("qualityField").hidden = !selectedOutput().lossy;
  el("qualityValue").textContent = el("quality").value;
  clearResult();
}
el("convertForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) {
    el("imageFile").setAttribute("aria-invalid", "true");
    showMessage("Choose an image file first.", "error");
    return;
  }
  clearResult();
  const token = operation,
    file = selectedFile,
    output = selectedOutput(),
    quality = Number(el("quality").value) / 100;
  setBusy(true);
  showMessage("Converting your image on this device…");
  try {
    const result = await ImageConverter.convert(
      file,
      output,
      quality,
      (stage) => {
        if (token === operation && stage === "codec")
          showMessage(
            "Loading the HEIC decoder. This one-off download happens in your browser.",
          );
      },
    );
    if (token !== operation) return;
    resultUrl = URL.createObjectURL(result.blob);
    const name = ImageConverter.outputName(file.name, output.extension);
    el("downloadBtn").href = resultUrl;
    el("downloadBtn").download = name;
    el("resultName").textContent = name;
    el("resultMeta").textContent =
      `${result.width} × ${result.height} px · ${output.label} · ${sizeLabel(result.blob.size)}`;
    el("resultPreview").alt =
      `Preview of ${name}, ${result.width} by ${result.height} pixels`;
    el("resultPreview").src = resultUrl;
    el("resultPreview").hidden = false;
    el("previewEmpty").hidden = true;
    el("previewBadge").textContent = output.label;
    el("imageActions").hidden = false;
    showMessage("Your converted image is ready to download.", "success");
  } catch (error) {
    if (token === operation)
      showMessage(
        error.code
          ? error.message
          : "We couldn’t convert this image. Choose another file and try again.",
        "error",
      );
  } finally {
    if (token === operation) setBusy(false);
  }
});
el("imageFile").addEventListener("change", () =>
  chooseFile(el("imageFile").files[0]),
);
el("outputFormat").addEventListener("change", updateOutputFields);
el("quality").addEventListener("input", updateOutputFields);
el("resetBtn").addEventListener("click", () => {
  el("convertForm").reset();
  chooseFile(null);
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
  chooseFile(event.dataTransfer.files[0]);
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
window.addEventListener("pagehide", clearResult);
