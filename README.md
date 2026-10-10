# PDF Unlocker

Unlock password-protected PDF files right in your browser!

[Try the live demo !!!](https://jiahuei.github.io/pdf-unlocker/)

## Features

- **Secure**: Files are processed locally in your browser - no uploads to external servers
- **Fast**: Quick processing without waiting for server responses
- **Free**: No hidden costs or premium features
- **Easy to use**: Simple interface with preview functionality
- **No installation**: Works directly in your browser

## How to Use

1. Upload a password-protected PDF file
2. Enter the PDF password. Leave it empty to use the default `password`; nonblank passwords are used exactly as entered, including surrounding spaces.
3. Click "Unlock PDF". The first operation may wait for the processing libraries to finish loading.
4. Preview the pages and download the unlocked file. A preview failure does not prevent downloading a successfully processed PDF. Use "Start over" to clear the document and password.

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

The deployed site is the `src/` directory. `index.html`, `style.css` and `app.js` define the interface; `pdf-engine.py` runs inside Pyodide and is also importable by Python document tests. The matching PDF.js worker source is cached and loaded through an owned blob URL, which is released with the result and also supports PDF.js’s main-thread fallback. `.github/workflows/deploy.yml` publishes `src/` to GitHub Pages on pushes to `main` or manual dispatch. There is no build step or runtime server.

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

The push and pull-request workflow `.github/workflows/lint.yml` runs Prettier 3.8.3 on Node 24 and Ruff 0.15.9 on Python 3.12. These are development tools only; the site still deploys without a build step. Install Node/npm and uv, then run the same checks locally:

```sh
npm ci
npm run format:check
uv tool run ruff@0.15.9 check --output-format github .
uv tool run ruff@0.15.9 format --check .
```

Use `npm run format` to format supported files, `uv tool run ruff@0.15.9 check --fix .` to sort Python imports/fix lint errors, and `uv tool run ruff@0.15.9 format .` to format Python. `.prettierrc` prevents inherited checkout settings; `.prettierignore` excludes generated files and local references. `ruff.toml` enables default lint rules plus import sorting and targets Python 3.11 for the browser's Pyodide runtime. Use `node --check src/app.js` for JavaScript syntax. Document tests use standard-library `unittest`; no pytest framework is required. The deployment workflow remains separate.

## Browser Support

This application works in all modern browsers that support WebAssembly and the necessary JavaScript APIs.

## License

MIT License - feel free to use and modify for your own projects.
