# Implementation specification

This document defines the architecture, behavior contracts and implementation constraints for File tools. Read the relevant sections before changing application or deployment code, and keep them aligned with the implementation. [README.md](README.md) covers usage, setup and verification commands; [AGENTS.md](AGENTS.md) covers contributor workflow.

## Repository structure

```text
.
├── src/
│   ├── index.html            # Tools directory linking both tools
│   ├── pdf-unlocker.html     # Accessible PDF interface
│   ├── image-converter.html  # Image interface and published format matrix
│   ├── app.js                # PDF UI state, runtime loading and preview
│   ├── password-schemes.js   # Pure local statement password derivation
│   ├── pdf-engine.py         # Browser-local document decryption
│   ├── image-app.js          # Image UI state, batch queue, preview, downloads and reset
│   ├── image-converter.js    # Format table, input detection and conversion pipeline
│   ├── debug.js              # Opt-in Eruda console shared by both tool pages
│   ├── style.css             # Local responsive styling shared by all pages
│   ├── assets/               # Favicons, touch icons and web manifest
│   └── vendor/               # Pinned HEIC decoder and third-party notices
├── .github/workflows/
│   ├── deploy.yml            # Publishes main and same-repository PR snapshots
│   └── lint.yml              # Prettier, Ruff and Node logic checks
├── .prettierrc               # Repository-local formatting defaults
├── .prettierignore           # Generated files and local reference exclusions
├── ruff.toml                 # Python lint/format settings targeting Python 3.11
├── package.json              # Pinned development-only Prettier and scripts
├── package-lock.json         # Reproducible npm installation
├── scripts/                  # Pages packaging, preview comments and optional decoder rebuild
├── tests/                    # Python document, Node logic and Playwright browser tests
├── tasks/                    # Local, untracked completion records and plans
├── AGENTS.md                 # Repository guidance
├── README.md                 # Usage, format matrix and local setup
├── SPEC.md                   # Architecture and implementation contracts
└── LICENSE                   # MIT license
```

## Architecture

The deployed site is the `src/` directory. `index.html` is the tools directory; `pdf-unlocker.html` with `app.js`, `password-schemes.js` and `pdf-engine.py` is the PDF tool; `image-converter.html` with `image-app.js` and `image-converter.js` is the image tool. Each page loads only its own scripts, so the home page and the converter never initialise Pyodide or PDF.js. `style.css` is shared, `debug.js` provides the opt-in console, and `assets/` holds the icons and web manifest.

`password-schemes.js` validates and derives statement passwords without network or storage access. `pdf-engine.py` runs inside Pyodide and is also importable by Python document tests. The matching PDF.js worker source is cached and loaded through an owned blob URL, which is released with the result and also supports PDF.js's main-thread fallback.

`image-converter.js` holds the format table, the byte-level input detection and the decode/encode pipeline; `image-app.js` holds only DOM state. JPEG, PNG and WebP use native decoding; HEIF uses libheif. The pinned libheif WASM API supplies ICC/NCLX profiles, and the browser converts the decoded colours into the sRGB output canvas. The converter accepts several files and converts them as one ordered batch; replacing the files or changing any setting discards the previous results and invalidates pending UI work through an operation token. Download URLs, bitmaps, canvases and the PDF worker are released when results are replaced. Native bitmap dimensions are checked after decoding and rejected bitmaps are closed immediately. Reset returns every field to its HTML default.

The application has no build step or runtime server. Styling is local. `package.json` provides development-only formatting tools. Internet access supplies browser libraries and Python packages; document contents, images and passwords stay on the device. Do not introduce file or password uploads, analytics, or storage of generated passwords.

## Runtime dependencies

- HTML5 and local CSS (no styling CDN required)
- JavaScript, with no build step and no runtime server
- PDF Unlocker: Pyodide 0.23.4 (Python in the browser) with its cryptography package for AES PDFs, pypdf 4.3.1 installed through micropip, and PDF.js 3.11.174 for page previews
- Image Converter: the browser's own `createImageBitmap` and canvas encoders for JPEG, PNG and WebP, plus a local WebAssembly build of libheif 1.23.6 with libde265 1.1.3 (LGPL-3.0), loaded only when a HEIC file is converted. `src/vendor/libheif-1.23.6/` contains the generated bundle, source links and licence notices; `scripts/build-heif.sh` rebuilds it with pinned sources and tools. Normal development and Pages deployment still require no build. Same-site serving avoids third-party requests during normal HEIC conversion, but Pages currently serves the bundle with `max-age=600` rather than the previous CDN's year-long immutable cache policy; later visits may need revalidation or a fresh download. Each preview artifact also includes its own approximately 2.2 MB vendor directory
- Eruda 3.4.3 loads only when debugging is enabled

Keep PDF.js and its worker on matching versions. Inspect source declarations before changing dependencies, and preserve the [third-party licence attribution](README.md#license).

## PDF processing

`pdf-engine.py` removes PDF password protection inside Pyodide. Successful output preserves text, metadata, outlines, attachments and form fields. Preview pagination uses PDF.js; a preview error must not prevent downloading an already processed document. Runtime loading failures remain retryable.

The UI invalidates pending operations when files or password settings change. Manual passwords remain verbatim when nonblank; a blank or whitespace-only value uses `password`. Start over clears the document and password details and restores the HTML defaults.

### Statement passwords

Choose the method specified by your statement's password instructions. These methods apply the following rules; use manual entry for other passwords, including a Maybank password chosen during registration.

| Method      | Details and format                                                                                                                                                                                                            | Example                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| RHB         | Last four ID/business registration characters, preserving case, followed by birth/establishment date in `YYMMDD`. Only the suffix is requested.                                                                               | `789A` and 29 July 1981 → `789A810729` |
| TNG eWallet | Registered Malaysian mobile number with phone separators, country code and the local leading zero removed. Local, bare, `+60` and `0060` forms are accepted; letters, foreign country codes and invalid lengths are rejected. | `+6011-23456789` → `1123456789`        |
| Maybank     | Birth date as `ddMmmYYYY`, using English month abbreviations.                                                                                                                                                                 | 1 January 1980 → `01Jan1980`           |

Passwords are derived locally only when you select Unlock PDF. The generated value is not displayed, stored or logged. The RHB and Maybank date fields start at 1 November 1993, so change them to the date on your statement before unlocking. Changing a password method or its details discards earlier results and cancels queued work. Start over clears the document and your entered details, restores that date default and returns to manual entry.

`password-schemes.js` is a pure validation and derivation module with no network or storage access. Scheme/detail edits cancel stale operations. Preserve calendar, phone and suffix validation alongside the formats above.

## Image conversion

### Inputs, encoders and limits

- The supported matrix is HEIC/HEIF, JPEG, PNG and WebP input to JPEG, PNG or WebP output; keep it aligned with the [published matrix](README.md#image-converter), page copy and Node tests.
- Recognize files from their bytes, not their MIME type or extension. Camera files frequently declare neither reliably.
- Decode JPEG/PNG/WebP with `createImageBitmap`; always use libheif for HEIC so image selection and counting do not depend on native HEIC support. Fetch its approximately 2 MB WebAssembly decoder from the same site on the first HEIC conversion in each page session and reuse it for that session. JPEG/PNG/WebP conversion does not load it.
- Load the HEIC decoder with a script element and clear failed load state so a retry can succeed. Avoid a cached dynamic import: a failed module resolution can persist for the document lifetime.
- Reject unsupported containers and animated GIF/APNG/WebP before decoding. For HEIF, the `ftyp` major brand alone decides both detection and policy: a HEIF-family major is required to enter the HEIF path at all, `hevc`, `hevx`, `hevm`, `hevs` and `msf1` are sequences and receive the `animated` error, and `heim` and `heis` receive a distinct `layered` error explaining that layered L-HEVC encoding is unsupported. Multi-layer items are not exercised by this converter. A supported still major (`heic`, `heix`, `mif1`, `heif`) stays on the still path even when compatible brands include a sequence profile. See the [IANA still-image registration](https://www.iana.org/assignments/media-types/image/heic), [sequence registration](https://www.iana.org/assignments/media-types/image/heic-sequence) and [LOC mixed-brand examples](https://www.loc.gov/preservation/digital/formats/fdd/fdd000526.shtml).
- Compatible brands declare extra conformance and never identify a file, in either direction: a still photo listing a sequence profile is still a still photo, and a general ISO-BMFF container listing a HEIF profile is not a HEIF file. Refuse the latter as an unsupported type rather than fetching the decoder for it. AVIF brands remain unsupported anywhere in the brand list, including alongside `mif1`. Parse ordinary, to-end-of-file and 64-bit `ftyp` box sizes, reading only complete brand fields within available box bytes. Preserve a readable major on truncated input so recognized corrupt HEIF reaches the decoder's unreadable-image error rather than being called an unsupported format.
- Convert only the first image of supported HEIF collections and JPEG/MPO files with multiple MPF entries, and report the source image count and that only the first was kept in a persistent result-tile notice. Release unused HEIF image handles without rendering them. Selecting several files is an ordinary batch, in which each file is validated on its own. AVIF and HDR gain maps are unsupported.
- Reject inputs above 40 MB or 50 megapixels decoded. Browser canvas limits can be lower and must produce an actionable conversion error. Native dimensions are known only after bitmap allocation; close the bitmap when size validation fails.
- Quality defaults to 80 on load and reset and applies only to lossy JPEG/WebP output. Disable encoders unavailable in the current browser. Verify the encoded blob's MIME type before offering it, because `canvas.toBlob` silently returns PNG for an unsupported encoder.
- Composite transparency over white only for JPEG; preserve it for PNG and WebP.

### Orientation

Orientation is applied to the exported pixels, using the source file's metadata rather than image-content inference.

- Native decoding applies JPEG and PNG EXIF orientation.
- For WebP, read the main-image EXIF orientation regardless of the retention checkbox. Neutralize that tag in the private input bytes before native decoding, then apply its rotation or reflection exactly once during export. Browsers differ in native WebP EXIF support; do not depend on it or apply an additional transform to already rotated pixels. Orientations 5-8 exchange output dimensions. The original file remains unchanged.
- HEIC rotation comes from its container, as used by iPhone photos. A HEIC storing rotation only in EXIF is not rotated.

### Colour conversion

Apply source ICC/NCLX profiles before exporting sRGB pixels. Do not copy the source colour profile to the output.

- The pinned libheif WASM API supplies source profiles. ICC-tagged RGB samples pass through a temporary lossless PNG tagged with the source ICC so native browser colour management performs the conversion. That intermediate remains in memory and requires Compression Streams support.
- Reject non-RGB ICC profiles, including grayscale, with an explicit unsupported-profile error. An RGB PNG cannot carry a Gray ICC profile correctly; do not silently reinterpret those samples as sRGB.
- SDR NCLX supports sRGB and Display P3 primaries with sRGB or BT.709 transfer. Use the corresponding `ImageData` colour space and convert BT.709 transfer to sRGB. Display P3 requires browser support for Display P3 `ImageData`.
- Reject unsupported NCLX spaces, including HDR. Untagged or unspecified colours follow the sRGB assumption.
- Use a decoder containing the libde265 fix for 32-by-32 chroma scaling (included in 1.1.3). The synthetic 10-bit 4:4:4 default-scaling-list fixture must match an independent decode; do not replace the bundle with libheif-js 1.23.5, which embeds the affected libde265 1.0.15.
- Keep the independently verified colour fixtures and their [provenance and licence](tests/fixtures/README.md).

### Metadata retention

Canvas encoders write pixels only. Source metadata is dropped unless the user opts in to keeping EXIF; the checkbox starts unchecked and reset clears it. The result line reports whether EXIF was kept, absent, or too large for the selected format.

- Transplant the source TIFF block into the encoded output: JPEG APP1, PNG `eXIf`, or WebP `EXIF` with the extended `VP8X` feature flag.
- Reset orientation to 1 and update existing IFD0/Exif IFD dimension tags to describe the converted image. Preserve thumbnail geometry and other retained tags, including GPS. Handle both TIFF byte orders and SHORT/LONG dimension fields.
- Refuse EXIF exceeding JPEG's APP1 segment capacity rather than writing an invalid segment; offer the encoded image without EXIF and report the omission.
- Accept JPEG marker-fill bytes before APP1. Read HEIC Exif through libheif's C API: its WASM32 ABI prepends a 12-byte `heif_error` return buffer to the documented arguments. The returned item starts with a four-byte big-endian offset relative to the end of that field; follow it rather than searching a fixed prefix for a TIFF signature.
- XMP must not be copied. The extraction paths skip standalone XMP segments/chunks/items and copy the TIFF block as a whole.

### UI state and cleanup

`image-app.js` owns DOM state while `image-converter.js` owns decoding and encoding. The picker and the drop zone both accept several files; a new selection replaces the current batch. Each selected file is one ordered entry holding its status, error, result and the object URLs it owns. Entries are rendered in two galleries of tiles, an input gallery of the chosen sources and an output gallery of their conversions, and both tiles of an entry are updated in place so activating a tile control cannot move the focus. Duplicate source names stay separate entries, and `outputNames()` allocates their download names across the batch with deterministic numeric suffixes.

Each tile captions its image with the file name plus geometry and size, and the output tile adds the EXIF outcome. Thumbnails are `<img>` elements over the owned blob URLs with lazy, asynchronous decoding, so a large batch does not hold every full-size image at once; a tile the browser cannot render keeps its placeholder. Source geometry comes from the thumbnail's intrinsic dimensions, and a finished conversion overwrites them with its own, because Chromium ignores WebP EXIF orientation there and cannot render HEIC at all. A converted tile's thumbnail is also its preview button, and it drives the one large preview panel the batch shares.

Both galleries use text download buttons labelled **Download input** and **Download result**, with at least 40-pixel target height, filename-specific tooltips and accessible labels. Preview buttons draw their keyboard focus outlines inside the thumbnail so the tile cannot clip them. Invalidated output download controls lose their URL, filename, tooltip and accessible label. Each input tile offers a download of the selected `File` through its existing source URL, with the received filename and byte content unchanged, including metadata. It is available before conversion, after conversion failures and across setting changes. It represents the file delivered by the picker or drop, which may already be a JPEG transcoded by iOS, rather than guaranteeing the camera original.

One output format, quality and EXIF setting is shared by the whole batch and is snapshotted on submission. Files are converted in order, one at a time, and a failure marks only its own tile. Conversions are chained through a single queue rather than run concurrently: the shared HEIF decoder releases its previous context on a subsequent decode, so an invalidated batch keeps the decoder until its active file settles and its stale token then stops it from starting the next one. The token is checked before each queued file, after each await and in the stage callback, and a stale completion returns before creating a result URL.

Replacing the files, changing any conversion setting, resetting and hiding the page clear the results, return every tile to its pending state and increment the operation token so stale work cannot reappear. Reset also restores HTML defaults, including quality 80 and EXIF retention off. Release every owned result URL, bitmap, canvas and HEIF handle when its work completes or its results are replaced; close rejected native bitmaps too. Source thumbnail/download URLs belong to the selection rather than to a conversion, so they are released only when the selection is replaced or cleared, and hiding the page keeps them: a back/forward-cache restore would otherwise show empty tiles for files that are still chosen.

Converted blobs and rendered thumbnails stay in memory for as long as the batch is on screen. No aggregate batch limit is enforced; sequential conversion bounds the active pixel buffers, and the memory cost of accumulated results is documented rather than silently capped.

The tools directory and converter must not initialize Pyodide or PDF.js. Keep navigation and all runtime assets working both at the project root and beneath `pr-preview/<number>/`.

## Verification coverage

Use [README verification commands](README.md#development-and-verification) and the workflow checks in `.github/workflows/lint.yml`. Verify downloaded file contents, not just success messages. Prefer synthetic fixtures. The owner-approved `tests/fixtures/IMG_0308.heic` is the documented real-photo exception; additional personal photos or derivatives require explicit permission before committing.

### Document and pure-logic tests

The document tests verify RC4, AES-128 and AES-256 password removal, incorrect and whitespace passwords, malformed/plain documents, and preserved text, metadata, outlines, attachments and form fields. `tests/image_fixtures.py` writes the synthetic image fixtures used by the browser suite: still JPEG/PNG/WebP inputs, a transparent PNG, an EXIF-rotated JPEG, all eight WebP EXIF orientations, a multi-picture JPEG/MPO, GPS-tagged JPEG and HEIC inputs whose position is synthetic (including JPEG marker padding and a longer HEIF EXIF offset), animated GIF/APNG/WebP inputs (including a valid unknown WebP chunk), multi-image/corrupt/untagged HEIC files, a decodable still with sequence compatibility, sequence/layered headers, a truncated `ftyp` and a non-HEIF container that only declares HEIF compatibility, oversized input, and ICC/NCLX colour fixtures, including a 10-bit 4:4:4 scaling-list regression. Colour references use independent Pillow/LittleCMS conversion and the [CC0 Display P3 test profile](tests/fixtures/README.md); transparent, unsupported grayscale ICC and unsupported HDR cases are included. HEIC fixtures need the optional `pillow-heif`; when it is absent they are skipped and the suite reports that.

The Node suites assert statement formats, calendar and phone validation, Pages snapshots and comments, and the converter's format detection from file signatures, animation detection, output filenames, the batch allocation of colliding output names, published output table and documented limits, HEIF major-brand detection and precedence, non-HEIF containers refused without loading the decoder, separate sequence/layered rejection before decoder loading, alternate `ftyp` sizes and truncated-header recognition, plus the EXIF byte surgery: the orientation and dimension rewrites in both TIFF byte orders, declared HEIF offsets, JPEG marker padding and the JPEG, PNG and WebP transplants, whose PNG CRC is checked against Node's own `zlib.crc32`.

### Browser tests

The PDF suite downloads actual decrypted PDFs and independently checks their contents with pypdf. Separate controlled substitutes test asynchronous loading/read/render cancellation and preview failures. It also checks runtime loading failure/retry, validation, password visibility, pagination, responsive layouts and download cleanup.

The image suite converts the synthetic fixtures in a real browser, downloads the results and independently checks them with Pillow: actual file format, geometry, transparency and pixel values, including HEIC-to-JPG, ICC/NCLX conversion to sRGB, orientation from EXIF (including WebP rotations and reflections), white behind transparent pixels for JPEG, quality 80 on load/reset, retained EXIF with its GPS position, upright orientation and matching dimensions in JPEG/PNG/WebP output, no metadata by default, animation rejection, layered and non-HEIF containers refused without a decoder request, and first-image conversion of multi-image HEIF/JPEG files with persistent notices, the size and pixel limits with rejected-bitmap cleanup, a missing WebP encoder, decoder download failure and retry, replacement during a pending conversion, object-URL release on reset, keyboard operation with a fully visible preview focus ring, cleared download labels after invalidation, distinct input/result text buttons, mobile layouts, the tools home navigation, the absence of the PDF runtime on the other pages, and both the project root and a nested `pr-preview/<number>/` prefix.

It also covers batches: multiple files through the picker and through a synthetic drop in selection order, both galleries' tiles with their thumbnails and captions, a HEIC input tile that keeps its placeholder and gains its geometry from the conversion, one shared format/quality/EXIF setting applied to every file, invalid files between valid ones and batches in which every file fails, colliding output names including a suffix another source already uses, previewing a result through its thumbnail, singular wording for a single file, and rerunning a batch after a failure. A held converter substitute asserts that an invalidated batch stops after its active file, creates no result URL and never overlaps the batch that replaced it; a blocked HEIC decoder download asserts the same for real decoder ownership, and a batch of HEIC photos asserts that repeated conversions stay serialized. Input downloads are compared byte for byte with selected JPEG (including EXIF), PNG, WebP, HEIC and rejected files before conversion, after conversion and across settings changes. Object-URL accounting covers source thumbnails/downloads and results across reset, batch replacement and page hide.

When `pillow-heif` is installed, `tests/fixtures/IMG_0308.heic` is tested by default with metadata retention off and on using an independent libheif decode, LittleCMS transform and geometry comparison. The approved photograph contains no EXIF: both runs require metadata-free output, and retention-on must report `no EXIF in the source`. Synthetic `gps.heic` and `gps-offset.heic` fixtures verify EXIF/GPS retention and dimension rewriting; a `TEST_HEIC` override carrying EXIF also exercises retention against that source. This approved real-photo fixture exercises tiled 10-bit 4:4:4 Display P3 decoding. `TEST_HEIC` can override it with another camera photo to cover further container rotation or auxiliary-image cases; keep those additional photos outside the repository unless explicitly approved. See [fixture provenance](tests/fixtures/README.md). Chromium mobile emulation does not establish physical iOS/Safari support.

### Deployment tests

The Pages regression suite checks current-main production, exact PR head snapshots, runtime source boundaries, fork/closed-PR handling and comment idempotence. Local tests do not establish hosted deployment success; preview URLs and comments require a successful Actions deployment.

## Production and pull-request previews

`.github/workflows/deploy.yml` publishes a combined GitHub Pages artifact: the site's root always contains `src/` from the current remote `main`, and each open pull request from this repository appears at `pr-preview/<number>/`. Preview assets, PDF processing and the HEIC decoder retain relative or absolute-CDN paths, so every page operates beneath that directory.

Main pushes, pull-request opening/reopening/updates/closure, and manual dispatch rebuild the artifact. Each run snapshots the current main commit and the exact head commits of all open same-repository pull requests. Fork pull requests are excluded. The packaging helper reads regular Git blobs under `src/`; it does not run pull-request build scripts or include repository documentation, tests or tooling. Closing a pull request removes its preview in the next successful deployment.

After deployment succeeds, the workflow creates or updates one marked comment per open pull request with its preview URL and source commit. Closing a pull request updates its existing comment to say the preview was removed. Failed deployments do not post a ready link. Runs share the `pages` concurrency group without canceling an active deployment; a queued run can take time to publish.

Repository Pages settings must use **GitHub Actions**. The `github-pages` environment must allow `main` and pull-request merge refs (`refs/pull/*/merge`) for these deployments. Deployment permissions and pull-request comment permissions are scoped to their respective jobs. The workflow uses the regular `pull_request` event rather than `pull_request_target`.

`scripts/pages-preview.json` selects `src/`, so new runtime files there are packaged without a workflow change; `scripts/pages-preview.cjs` packages snapshots and maintains comments.
