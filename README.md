# PDF Unlocker

Remove a PDF password in your browser, preview its pages and download the unlocked copy.

[Open PDF Unlocker](https://jiahuei.github.io/pdf-unlocker/)

## Features

- **Secure**: Files are processed locally in your browser - no uploads to external servers
- **Fast**: Quick processing without waiting for server responses
- **Free**: No hidden costs or premium features
- **Easy to use**: Simple interface with preview functionality
- **No installation**: Works directly in your browser

## How to Use

1. Upload a password-protected PDF file
2. Select a password method. Enter the PDF password manually or provide the statement details for RHB, TNG eWallet or Maybank. Manual entry uses the default `password` when empty; nonblank manual passwords are used exactly as entered, including surrounding spaces.
3. Click "Unlock PDF". The first operation may wait for the processing libraries to finish loading.
4. Preview the pages and download the unlocked file. A preview failure does not prevent downloading a successfully processed PDF. Use "Start over" to clear the document and password.

## Statement password methods

Choose the method specified by your statement's password instructions. These methods apply the following rules; use manual entry for other passwords, including a Maybank password chosen during registration.

| Method      | Details and format                                                                                                                                                                                                            | Example                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| RHB         | Last four ID/business registration characters, preserving case, followed by birth/establishment date in `YYMMDD`. Only the suffix is requested.                                                                               | `789A` and 29 July 1981 → `789A810729` |
| TNG eWallet | Registered Malaysian mobile number with phone separators, country code and the local leading zero removed. Local, bare, `+60` and `0060` forms are accepted; letters, foreign country codes and invalid lengths are rejected. | `+6011-23456789` → `1123456789`        |
| Maybank     | Birth date as `ddMmmYYYY`, using English month abbreviations.                                                                                                                                                                 | 1 January 1980 → `01Jan1980`           |

Passwords are derived locally only when you select Unlock PDF. The generated value is not displayed, stored or logged. Changing a password method or its details discards earlier results and cancels queued work. Start over clears every field and restores manual entry.

## Running Locally

1. Clone this repository
2. From the repository root, serve the application directory:

   ```sh
   python3 -m http.server 8000 --bind 127.0.0.1 --directory src
   ```

3. Open <http://127.0.0.1:8000>.

Internet access is required to load the browser libraries and Python packages. PDF contents and passwords are processed locally in your browser.

## Technology Stack

- HTML5
- Local CSS (no styling CDN required)
- JavaScript
- Pyodide 0.23.4 (Python in the browser), with its cryptography package for AES PDFs
- PDF.js 3.11.174 for page previews
- pypdf 4.3.1 installed through micropip

## Development and verification

The deployed site is the `src/` directory. `index.html`, `style.css` and `app.js` define the interface; `password-schemes.js` validates and derives statement passwords without network or storage access. `pdf-engine.py` runs inside Pyodide and is also importable by Python document tests. The matching PDF.js worker source is cached and loaded through an owned blob URL, which is released with the result and also supports PDF.js’s main-thread fallback. There is no application build step or runtime server.

Changing the selected file or password discards the previous result. Reset cancels queued UI work; download URLs, PDF workers and Python proxies are released when results are replaced. PDF contents and passwords are never submitted to a server. The libraries themselves load over the network. Optional Eruda debugging remains available through `?eruda=true` or the existing `active-eruda` local-storage flag.

Tests use synthetic documents and keep their dependencies outside the project:

```sh
python3 -m pip install --target /tmp/pdf-unlocker-test-python pypdf==4.3.1 cryptography==43.0.3
PYTHONPATH=/tmp/pdf-unlocker-test-python python3 -m unittest discover -s tests -p 'test_*.py' -v
```

The document tests verify RC4, AES-128 and AES-256 password removal, incorrect and whitespace passwords, malformed/plain documents, and preserved text, metadata, outlines, attachments and form fields.

For browser tests, start the local server on port 8001, then install the optional tooling:

```sh
python3 -m http.server 8001 --bind 127.0.0.1 --directory src
npm install --prefix /tmp/pdf-unlocker-browser-tests playwright@1.58.2
/tmp/pdf-unlocker-browser-tests/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/pdf-unlocker-browser-tests/node_modules/playwright PYTHONPATH=/tmp/pdf-unlocker-test-python node tests/browser.test.cjs
```

Run the server in a separate terminal. The browser suite downloads actual decrypted PDFs and independently checks their contents with pypdf. Separate controlled substitutes test asynchronous loading/read/render cancellation and preview failures. It also checks runtime loading failure/retry, validation, password visibility, pagination, responsive layouts and download cleanup. Internet access is required for the real browser-runtime tests. `TEST_BASE_URL` overrides the server URL; `TEST_SCREENSHOTS` saves screenshots. OS browser libraries may need the platform setup described by Playwright. Mobile emulation is distinct from a physical iOS Safari check.

The push workflow `.github/workflows/lint.yml` runs Prettier 3.8.3 on Node 24 and Ruff 0.15.9 on Python 3.12 for all branches. These are development tools only; the site still deploys without a build step. Install Node/npm and uv, then run the same checks locally:

```sh
npm ci
npm run format:check
node --test tests/pages-preview.test.cjs tests/password-schemes.test.cjs
uv tool run ruff@0.15.9 check --output-format github .
uv tool run ruff@0.15.9 format --check .
```

Use `npm run format` to format supported files, `uv tool run ruff@0.15.9 check --fix .` to sort Python imports/fix lint errors, and `uv tool run ruff@0.15.9 format .` to format Python. `.prettierrc` prevents inherited checkout settings; `.prettierignore` excludes generated files and local references. `ruff.toml` enables default lint rules plus import sorting and targets Python 3.11 for the browser's Pyodide runtime. Use `node --check src/app.js` and `node --check src/password-schemes.js` for JavaScript syntax. Document tests use standard-library `unittest`; no pytest framework is required. The Node suite covers statement formats, calendar/phone validation and Pages snapshots/comments; the browser suite also verifies real encrypted downloads for each statement method. The deployment workflow remains separate.

## Production and pull-request previews

`.github/workflows/deploy.yml` publishes a combined GitHub Pages artifact: the site's root always contains `src/` from the current remote `main`, and each open pull request from this repository appears at `pr-preview/<number>/`. Preview assets and PDF processing retain relative paths, so the preview operates beneath that directory.

Main pushes, pull-request opening/reopening/updates/closure, and manual dispatch rebuild the artifact. Each run snapshots the current main commit and the exact head commits of all open same-repository pull requests. Fork pull requests are excluded. The packaging helper reads regular Git blobs under `src/`; it does not run pull-request build scripts or include repository documentation, tests or tooling. Closing a pull request removes its preview in the next successful deployment.

After deployment succeeds, the workflow creates or updates one marked comment per open pull request with its preview URL and source commit. Closing a pull request updates its existing comment to say the preview was removed. Failed deployments do not post a ready link. Runs share the `pages` concurrency group without canceling an active deployment; a queued run can take time to publish.

Repository Pages settings must use **GitHub Actions**. The `github-pages` environment must allow `main` and pull-request merge refs (`refs/pull/*/merge`) for these deployments. Deployment permissions and pull-request comment permissions are scoped to their respective jobs. The workflow uses the regular `pull_request` event rather than `pull_request_target`.

`scripts/pages-preview.json` selects `src/`; `scripts/pages-preview.cjs` packages snapshots and maintains comments. Run the packaging and comment regressions without extra dependencies:

```sh
node --test tests/pages-preview.test.cjs
```

## Browser Support

This application works in all modern browsers that support WebAssembly and the necessary JavaScript APIs.

## License

MIT License - feel free to use and modify for your own projects.
