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

Choose the method specified by your statement's password instructions:

- **RHB**: enter the last four ID/business registration characters and birth/establishment date.
- **TNG eWallet**: enter the registered Malaysian mobile number.
- **Maybank**: enter the birth date, or use manual entry for a password chosen during registration.

The RHB and Maybank date fields start at 1 November 1993; change them to the date on your statement. Start over clears your document and details and restores the defaults. Passwords are derived locally when you select Unlock PDF and are never displayed, stored or logged. See the [exact password formats and examples](SPEC.md#statement-passwords).

### Image Converter

Convert images one at a time or in a batch, with HEIC-to-JPG as the main use case. Choose one or more files, pick a single output format and quality for the whole batch, then preview each result and download the ones you want. JPEG and WebP quality starts at 80; Start over restores that default.

A batch is converted in the order you selected, one file at a time, and every file shares the output format, quality and EXIF setting. A file that cannot be converted reports its own reason and does not stop the rest; the panel keeps a success and failure count. Each result is downloaded separately, and files whose names would collide gain a numeric suffix (`photo.jpg`, `photo-2.jpg`). Converted images are held in browser memory until you replace the files, change a setting, choose Start over or leave the page, so very large batches can use a lot of memory on a phone. Choosing new files replaces the current batch and discards its results.

| Input       | To JPG | To PNG | To WebP |
| ----------- | :----: | :----: | :-----: |
| HEIC / HEIF |   ✓    |   ✓    |    ✓    |
| JPEG        |   ✓    |   ✓    |    ✓    |
| PNG         |   ✓    |   ✓    |    ✓    |
| WebP        |   ✓    |   ✓    |    ✓    |

WebP output needs browser support; the option is disabled where your browser cannot write WebP. See [implementation details](SPEC.md#image-conversion) for input detection, decoding and encoding rules.

What to expect from a conversion:

- **Orientation follows the original file's metadata.** If present, it tells the converter how to rotate or mirror the image. HEIC rotation must be stored in the container; HEIC files with rotation only in EXIF are not rotated.
- **Colours are converted to sRGB.** Unsupported HEIC profiles, including grayscale ICC profiles and HDR, produce an explanatory error. See [supported colour profiles](SPEC.md#colour-conversion).
- **EXIF is dropped unless you ask to keep it**, so a converted photo cannot quietly carry its GPS position. Tick **Keep location and shooting details (EXIF)** to transplant the source EXIF into JPEG, PNG or WebP output. If the original image contains orientation metadata, the converter uses it to rotate or mirror the image. Retained EXIF is updated to describe the converted image, and XMP is never copied. Leave it unticked before sharing a photo publicly.
- **Transparency** is placed on white for JPEG, which has no alpha channel, and preserved for PNG and WebP.
- **Still images only.** Animated GIF, APNG and animated WebP files are rejected instead of quietly keeping their first frame, as are HEIF files holding several images and multi-picture JPEG/MPO files. That single-image rule is about the contents of one file; selecting several files is an ordinary batch. AVIF and HDR gain maps are not supported.
- **Limits** are 40 MB per file and 50 megapixels decoded. Your browser's own canvas limit can be lower, which is reported as a failed conversion rather than a broken file.

The first HEIC conversion downloads its decoder; later conversions reuse it. Internet access is required for that download. See [browser requirements](#browser-support) and the [conversion specification](SPEC.md#image-conversion) for limitations.

## Privacy

Documents, images and passwords are read, processed and written inside your browser. The site never sends file contents or passwords to a server, and no analytics run. The only network requests are the [library downloads](SPEC.md#runtime-dependencies), which cannot see your files.

## Running Locally

1. Clone this repository
2. From the repository root, serve the application directory:

   ```sh
   python3 -m http.server 8000 --bind 127.0.0.1 --directory src
   ```

3. Open <http://127.0.0.1:8000> for the tools directory, or the tool page directly.

Internet access is required to load the browser libraries and Python packages. PDF contents, images and passwords are processed locally in your browser.

## Implementation specification

[SPEC.md](SPEC.md) describes the repository structure, architecture, PDF and image behavior contracts, runtime dependencies and Pages deployment. [AGENTS.md](AGENTS.md) contains contributor workflow and verification requirements.

## Development and verification

Tests use synthetic documents and images, and keep their dependencies outside the project:

```sh
python3 -m pip install --target /tmp/pdf-unlocker-test-python pypdf==4.3.1 cryptography==43.0.3 pillow==12.3.0 pillow-heif==1.8.1
PYTHONPATH=/tmp/pdf-unlocker-test-python python3 -m unittest discover -s tests -p 'test_*.py' -v
```

The [specification](SPEC.md#verification-coverage) describes what each suite covers. HEIC fixtures require the optional `pillow-heif` dependency; when it is absent the browser suite reports those cases as skipped.

Node tests cover the pure logic and run without a browser or network:

```sh
node --test tests/pages-preview.test.cjs tests/password-schemes.test.cjs tests/image-converter.test.cjs
```

These suites require no browser or network. See [coverage and expected contracts](SPEC.md#document-and-pure-logic-tests).

For browser tests, start the local server on port 8001, then install the optional tooling:

```sh
python3 -m http.server 8001 --bind 127.0.0.1 --directory src
npm install --prefix /tmp/pdf-unlocker-browser-tests playwright@1.58.2
/tmp/pdf-unlocker-browser-tests/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/pdf-unlocker-browser-tests/node_modules/playwright PYTHONPATH=/tmp/pdf-unlocker-test-python node tests/browser.test.cjs
PLAYWRIGHT_MODULE=/tmp/pdf-unlocker-browser-tests/node_modules/playwright PYTHONPATH=/tmp/pdf-unlocker-test-python node tests/image-browser.test.cjs
# Optional: also convert a real camera photo kept outside the repository
TEST_HEIC=/path/to/photo.heic PLAYWRIGHT_MODULE=/tmp/pdf-unlocker-browser-tests/node_modules/playwright PYTHONPATH=/tmp/pdf-unlocker-test-python node tests/image-browser.test.cjs
```

Run the server in a separate terminal. Browser suites independently verify downloads with pypdf or Pillow. See [browser coverage](SPEC.md#browser-tests).

Internet access is required for browser-runtime tests. `TEST_BASE_URL` overrides the server URL; `TEST_SCREENSHOTS` saves screenshots. `TEST_HEIC` adds a real camera photo kept outside the repository; never commit the photo or its derivatives because they can carry personal metadata. OS browser libraries may need the platform setup described by Playwright. Mobile emulation is distinct from physical iOS Safari verification.

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

The site root serves current `main`. Open same-repository pull requests receive a preview at `pr-preview/<number>/`, linked from a PR comment after successful deployment. Closing a PR removes its preview on the next successful deployment. Fork PRs do not receive previews.

Repository Pages settings must use **GitHub Actions**. The `github-pages` environment must allow `main` and pull-request merge refs (`refs/pull/*/merge`). See [deployment behavior and constraints](SPEC.md#production-and-pull-request-previews) before changing the workflow or packaging scripts.

Run packaging/comment regressions with:

```sh
node --test tests/pages-preview.test.cjs
```

## Browser Support

Both tools require browser support for WebAssembly, canvas encoding and `createImageBitmap`. HEIC ICC colour conversion also requires Compression Streams; Display P3 NCLX requires Display P3 `ImageData` support. The converter reports a missing output encoder instead of writing a mislabelled file, and the PDF tool reports a library that cannot load with a retry.

## License

MIT License - feel free to use and modify for your own projects. The bundled third-party libraries keep their own licences: Pyodide (MPL-2.0), PDF.js (Apache-2.0), pypdf (BSD-3-Clause) and libheif-js with libheif and libde265 (LGPL-3.0). They are loaded from public CDNs at runtime and are not redistributed by this repository.
