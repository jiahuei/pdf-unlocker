# Modernize PDF Unlocker and verify browser-local decryption

## Summary

- Replaced the single inline application with accessible HTML, responsive local CSS, explicit runtime/error/result states and separate JavaScript/Python modules. Corrected manifest icons and retained source attribution, MIT licensing and optional Eruda debugging.
- Preserved the empty-password default `password`; meaningful passwords are used verbatim. Document cloning retains contents, metadata, outlines, attachments and forms, and unencrypted PDFs remain byte-for-byte unchanged. Added the crypto provider needed for AES PDFs and pinned pypdf to 4.3.1.
- File/password changes and reset invalidate queued work and stale downloads. Result replacement releases Python proxies, preview tasks and owned download/worker URLs. Preview failures preserve successful downloads; PDF.js supports native workers and its main-thread fallback.
- Added synthetic-document tests, real browser/runtime/download checks and separately controlled timing/failure regressions. Updated README and AGENTS.md with the actual architecture, runtime requirements and isolated test setup. The existing GitHub Pages deployment workflow is unchanged.

- Committed the changes on `modernize-pdf-unlocker` and opened [PR #10](https://github.com/jiahuei/pdf-unlocker/pull/10).

## Verification

- `PYTHONPATH=/tmp/pdf-unlocker-test-python python3 -m unittest discover -s tests -p 'test_*.py' -v`: passed 9 tests covering RC4/AES-128/AES-256 decryption, wrong/whitespace passwords, plaintext/malformed/zero-page inputs and document preservation. Expected malformed-PDF parser warnings were emitted.
- `LD_LIBRARY_PATH=/tmp/finance-browser-libs/extracted/usr/lib/x86_64-linux-gnu PLAYWRIGHT_BROWSERS_PATH=/tmp/finance-browsers PLAYWRIGHT_MODULE=/home/akk/.npm/_npx/4d28a6818d23920b/node_modules/playwright PYTHONPATH=/tmp/pdf-unlocker-test-python TEST_SCREENSHOTS=/tmp/pdf-unlocker-screenshots node tests/browser.test.cjs`: passed 78 real browser/runtime/download assertions and 19 controlled UI race/failure assertions against the local server on port 8001. Real downloaded PDFs were independently read and checked for removed encryption and preserved text, metadata, outlines and attachments. Native-worker and disabled-Worker previews passed. Controlled substitutes cover reset during runtime loading/file reading/page rendering, queued file replacement, proxy cleanup and preview failures.
- Reviewed empty and unlocked desktop/mobile screenshots at 1440px and 375px. Automated layouts at 320/375/768/1440px had no horizontal overflow, including long filenames. Password touch focus, visibility, preview resize/pagination, wrong-input handling, library-load failure/retry and URL cleanup passed. No document/password upload requests or unhandled browser errors occurred.
- `node --check src/app.js` and `node --check tests/browser.test.cjs`: passed.
- `python3 -m py_compile src/pdf-engine.py tests/pdf_fixtures.py tests/test_pdf_engine.py tests/verify_download.py`: passed.
- `npx prettier --write --no-config AGENTS.md README.md src/index.html src/style.css src/app.js src/assets/site.webmanifest tests/browser.test.cjs tasks/*.md`: formatted changed supported files using default settings.
- `npx prettier --check --no-config AGENTS.md README.md src/index.html src/style.css src/app.js src/assets/site.webmanifest tests/browser.test.cjs tasks/*.md`: passed.
- `npx prettier --check --no-config .`: failed only for the pre-existing, untouched `.vscode/python.json.code-snippets` formatting difference.
- `git diff --check`: passed. Independent review found no remaining implementation issues.
- Runtime libraries still require internet access. Browser tests used Chromium mobile emulation, not physical iOS Safari. No production deployment or merge was performed during verification. README documents portable setup; the browser command above includes this container's temporary browser and OS-library paths.
