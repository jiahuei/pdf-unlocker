# File tools

Everyday file tools that run entirely in your browser: remove a PDF password, and convert HEIC photos into widely usable JPG files. Nothing is uploaded and there is no sign-up.

[Open File tools](https://jiahuei.github.io/pdf-unlocker/) · [PDF Unlocker](https://jiahuei.github.io/pdf-unlocker/pdf-unlocker.html) · [Image Converter](https://jiahuei.github.io/pdf-unlocker/image-converter.html)

## Tools

### PDF Unlocker

Remove a PDF password, preview the pages and download the unlocked copy.

- **Secure**: Files are processed locally in your browser - no uploads to external servers
- **Fast**: Quick processing without waiting for server responses
- **Free**: No hidden costs or premium features
- **Easy to use**: Simple interface with preview functionality
- **No installation**: Works directly in your browser

1. Upload a password-protected PDF file
2. Select a password method. Enter the PDF password manually or provide the statement details for RHB, TNG eWallet or Maybank. Manual entry uses the default `password` when empty; nonblank manual passwords are used exactly as entered, including surrounding spaces.
3. Click "Unlock PDF". The first operation may wait for the processing libraries to finish loading.
4. Preview the pages and download the unlocked file. A preview failure does not prevent downloading a successfully processed PDF. Use "Start over" to clear the document and password.

#### Statement password methods

Choose the method specified by your statement's password instructions. These methods apply the following rules; use manual entry for other passwords, including a Maybank password chosen during registration.

| Method      | Details and format                                                                                                                                                                                                            | Example                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| RHB         | Last four ID/business registration characters, preserving case, followed by birth/establishment date in `YYMMDD`. Only the suffix is requested.                                                                               | `789A` and 29 July 1981 → `789A810729` |
| TNG eWallet | Registered Malaysian mobile number with phone separators, country code and the local leading zero removed. Local, bare, `+60` and `0060` forms are accepted; letters, foreign country codes and invalid lengths are rejected. | `+6011-23456789` → `1123456789`        |
| Maybank     | Birth date as `ddMmmYYYY`, using English month abbreviations.                                                                                                                                                                 | 1 January 1980 → `01Jan1980`           |

Passwords are derived locally only when you select Unlock PDF. The generated value is not displayed, stored or logged. The RHB and Maybank date fields start at 1 November 1993, so change them to the date on your statement before unlocking. Changing a password method or its details discards earlier results and cancels queued work. Start over clears the document and your entered details, restores that date default and returns to manual entry.

### Image Converter

Convert one image at a time, with HEIC-to-JPG as the main use case. Choose a file, pick an output format and a quality for lossy output, preview the result and download it.

| Input       | To JPG | To PNG | To WebP |
| ----------- | :----: | :----: | :-----: |
| HEIC / HEIF |   ✓    |   ✓    |    ✓    |
| JPEG        |   ✓    |   ✓    |    ✓    |
| PNG         |   ✓    |   ✓    |    ✓    |
| WebP        |   ✓    |   ✓    |    ✓    |

Input files are recognised from their own bytes rather than their extension or MIME type, so camera files with no declared type still convert. WebP output needs browser support; the option is disabled where your browser cannot write WebP, and an unsupported encoder is never relabelled as a successful conversion.

What to expect from a conversion:

- **Orientation is applied to the output pixels**, so the result matches what your photos app shows. iPhone HEIC photos carry their rotation in the file, and JPEG orientation is taken from EXIF.
- **Metadata is not copied.** EXIF, GPS and colour profiles are dropped, and the output is written in sRGB. Convert from the original if you need that information.
- **Transparency** is placed on white for JPEG, which has no alpha channel, and preserved for PNG and WebP.
- **Still images only.** Animated GIF, APNG and animated WebP files are rejected instead of quietly keeping their first frame, as are HEIF files holding several images, such as bursts. AVIF and HDR gain maps are not supported.
- **Limits** are 40 MB per file and 50 megapixels decoded. Your browser's own canvas limit can be lower, which is reported as a failed conversion rather than a broken file.

The first HEIC conversion downloads a 2 MB WebAssembly decoder; later conversions reuse it. Browsers that decode HEIC themselves, such as Safari on Apple platforms, use their own decoder instead and download nothing. JPEG, PNG and WebP conversions never download a decoder.

## Privacy

Documents, images and passwords are read, processed and written inside your browser. The site never sends file contents or passwords to a server, and no analytics run. The only network requests are the library downloads listed below, which cannot see your files.

## Running Locally

1. Clone this repository
2. From the repository root, serve the application directory:

   ```sh
   python3 -m http.server 8000 --bind 127.0.0.1 --directory src
   ```

3. Open <http://127.0.0.1:8000> for the tools directory, or the tool page directly.

Internet access is required to load the browser libraries and Python packages. PDF contents, images and passwords are processed locally in your browser.

## Technology Stack

- HTML5 and local CSS (no styling CDN required)
- JavaScript, with no build step and no runtime server
- PDF Unlocker: Pyodide 0.23.4 (Python in the browser) with its cryptography package for AES PDFs, pypdf 4.3.1 installed through micropip, and PDF.js 3.11.174 for page previews
- Image Converter: the browser's own `createImageBitmap` and canvas encoders for JPEG, PNG and WebP, plus libheif-js 1.23.5 (LGPL-3.0, bundling libheif with the libde265 HEVC decoder) loaded from jsDelivr only when a HEIC file is converted
- Eruda 3.4.3 loads only when debugging is enabled

## Development and verification

The deployed site is the `src/` directory. `index.html` is the tools directory; `pdf-unlocker.html` with `app.js`, `password-schemes.js` and `pdf-engine.py` is the PDF tool; `image-converter.html` with `image-app.js` and `image-converter.js` is the image tool. Each page loads only its own scripts, so the home page and the converter never initialise Pyodide or PDF.js. `style.css` is shared, `debug.js` provides the opt-in console, and `assets/` holds the icons and web manifest.

`password-schemes.js` validates and derives statement passwords without network or storage access. `pdf-engine.py` runs inside Pyodide and is also importable by Python document tests. The matching PDF.js worker source is cached and loaded through an owned blob URL, which is released with the result and also supports PDF.js's main-thread fallback.

`image-converter.js` holds the format table, the byte-level input detection and the decode/encode pipeline; `image-app.js` holds only DOM state. Decoding prefers the browser's own image support and falls back to the HEIC decoder for HEIF input. Changing the selected file or any setting discards the previous result and cancels queued work through an operation token; download URLs, bitmaps, canvases and the PDF worker are released when results are replaced. Reset returns every field to its HTML default.

Tests use synthetic documents and images, and keep their dependencies outside the project:

```sh
python3 -m pip install --target /tmp/pdf-unlocker-test-python pypdf==4.3.1 cryptography==43.0.3 pillow==12.3.0 pillow-heif==1.8.1
PYTHONPATH=/tmp/pdf-unlocker-test-python python3 -m unittest discover -s tests -p 'test_*.py' -v
```

The document tests verify RC4, AES-128 and AES-256 password removal, incorrect and whitespace passwords, malformed/plain documents, and preserved text, metadata, outlines, attachments and form fields. `tests/image_fixtures.py` writes the synthetic image fixtures used by the browser suite: still JPEG/PNG/WebP inputs, a transparent PNG, an EXIF-rotated JPEG, animated GIF/APNG/WebP inputs, a multi-image HEIC, a corrupt HEIC, an oversized file and a file above the pixel limit. HEIC fixtures need the optional `pillow-heif`; when it is absent they are skipped and the suite reports that.

Node tests cover the pure logic and run without a browser or network:

```sh
node --test tests/pages-preview.test.cjs tests/password-schemes.test.cjs tests/image-converter.test.cjs
```

They assert statement formats, calendar and phone validation, Pages snapshots and comments, and the converter's format detection from file signatures, animation detection, output filenames, published output table and documented limits.

For browser tests, start the local server on port 8001, then install the optional tooling:

```sh
python3 -m http.server 8001 --bind 127.0.0.1 --directory src
npm install --prefix /tmp/pdf-unlocker-browser-tests playwright@1.58.2
/tmp/pdf-unlocker-browser-tests/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/pdf-unlocker-browser-tests/node_modules/playwright PYTHONPATH=/tmp/pdf-unlocker-test-python node tests/browser.test.cjs
PLAYWRIGHT_MODULE=/tmp/pdf-unlocker-browser-tests/node_modules/playwright PYTHONPATH=/tmp/pdf-unlocker-test-python node tests/image-browser.test.cjs
```

Run the server in a separate terminal. The PDF suite downloads actual decrypted PDFs and independently checks their contents with pypdf. Separate controlled substitutes test asynchronous loading/read/render cancellation and preview failures. It also checks runtime loading failure/retry, validation, password visibility, pagination, responsive layouts and download cleanup.

The image suite converts the synthetic fixtures in a real browser, downloads the results and independently checks them with Pillow: actual file format, geometry, transparency and pixel values, including HEIC-to-JPG, orientation from EXIF, white behind transparent pixels for JPEG, the quality setting, animation and multi-image rejection, the size and pixel limits, a missing WebP encoder, decoder download failure and retry, replacement during a pending conversion, object-URL release on reset, keyboard operation, mobile layouts, the tools home navigation, the absence of the PDF runtime on the other pages, and both the project root and a nested `pr-preview/<number>/` prefix. Internet access is required for the real browser-runtime tests. `TEST_BASE_URL` overrides the server URL; `TEST_SCREENSHOTS` saves screenshots. OS browser libraries may need the platform setup described by Playwright. Mobile emulation is distinct from a physical iOS Safari check, and HEIC decoding on a physical iPhone has not been verified here.

The push workflow `.github/workflows/lint.yml` runs Prettier 3.8.3 on Node 24 and Ruff 0.15.9 on Python 3.12 for all branches, plus the Node tests above. These are development tools only; the site still deploys without a build step. Install Node/npm and uv, then run the same checks locally:

```sh
npm ci
npm run format:check
node --test tests/pages-preview.test.cjs tests/password-schemes.test.cjs tests/image-converter.test.cjs
uv tool run ruff@0.15.9 check --output-format github .
uv tool run ruff@0.15.9 format --check .
```

Use `npm run format` to format supported files, `uv tool run ruff@0.15.9 check --fix .` to sort Python imports/fix lint errors, and `uv tool run ruff@0.15.9 format .` to format Python. `.prettierrc` prevents inherited checkout settings; `.prettierignore` excludes generated files and local references. `ruff.toml` enables default lint rules plus import sorting and targets Python 3.11 for the browser's Pyodide runtime. Use `node --check` on the JavaScript files you change: `src/app.js`, `src/password-schemes.js`, `src/image-app.js`, `src/image-converter.js` and `src/debug.js`. Document tests use standard-library `unittest`; no pytest framework is required. The deployment workflow remains separate.

## Production and pull-request previews

`.github/workflows/deploy.yml` publishes a combined GitHub Pages artifact: the site's root always contains `src/` from the current remote `main`, and each open pull request from this repository appears at `pr-preview/<number>/`. Preview assets, PDF processing and the HEIC decoder retain relative or absolute-CDN paths, so every page operates beneath that directory.

Main pushes, pull-request opening/reopening/updates/closure, and manual dispatch rebuild the artifact. Each run snapshots the current main commit and the exact head commits of all open same-repository pull requests. Fork pull requests are excluded. The packaging helper reads regular Git blobs under `src/`; it does not run pull-request build scripts or include repository documentation, tests or tooling. Closing a pull request removes its preview in the next successful deployment.

After deployment succeeds, the workflow creates or updates one marked comment per open pull request with its preview URL and source commit. Closing a pull request updates its existing comment to say the preview was removed. Failed deployments do not post a ready link. Runs share the `pages` concurrency group without canceling an active deployment; a queued run can take time to publish.

Repository Pages settings must use **GitHub Actions**. The `github-pages` environment must allow `main` and pull-request merge refs (`refs/pull/*/merge`) for these deployments. Deployment permissions and pull-request comment permissions are scoped to their respective jobs. The workflow uses the regular `pull_request` event rather than `pull_request_target`.

`scripts/pages-preview.json` selects `src/`, so new runtime files there are packaged without a workflow change; `scripts/pages-preview.cjs` packages snapshots and maintains comments. Run the packaging and comment regressions without extra dependencies:

```sh
node --test tests/pages-preview.test.cjs
```

## Browser Support

Both tools work in current desktop and mobile browsers that support WebAssembly, canvas encoding and `createImageBitmap`. The converter reports a missing output encoder instead of writing a mislabelled file, and the PDF tool reports a library that cannot load with a retry.

## License

MIT License - feel free to use and modify for your own projects. The bundled third-party libraries keep their own licences: Pyodide (MPL-2.0), PDF.js (Apache-2.0), pypdf (BSD-3-Clause) and libheif-js with libheif and libde265 (LGPL-3.0). They are loaded from public CDNs at runtime and are not redistributed by this repository.
