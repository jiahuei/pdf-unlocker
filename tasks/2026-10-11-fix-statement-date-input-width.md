# Fix RHB and Maybank date field overflow in WebKit

## Summary

- The RHB and Maybank statement date fields spilled past the card border in WebKit. WebKit keeps temporal inputs at their intrinsic size and forces `content-box` while they use the native appearance, so the shared `width: 100%` applied to the content box and the field's 14px side padding plus 1px border added about 30px to its border box. `input[type="date"] { appearance: none }` makes the declared width and the site-wide `border-box` apply.
- The existing `min-width: 0; max-width: 100%` rule could not prevent this, because both constrain the content box, which is what WebKit sized to 100% of the container before padding and border were added. The text, tel and password statement fields were unaffected; this WebKit sizing applies to temporal inputs.
- The native picker stays usable. Opting out of the appearance changes how the control is painted and sized, not its functionality, and the calendar indicator is a separate shadow element. Chromium shadow-box measurements through CDP were identical before and after at 320px: input border box 41 to 279, datetime edit 56 to 244, picker indicator 244 to 264.
- Added a browser regression that pins the computed `appearance` and `box-sizing` of each visible statement date field and asserts its border box stays inside its card at 320, 375, 768 and 1440 pixels for the RHB and Maybank methods. It runs inside the existing per-method layout loop, so it covers the derived-password paths that already unlock real AES fixtures.

## Verification

- `LD_LIBRARY_PATH=/tmp/finance-browser-libs/extracted/usr/lib/x86_64-linux-gnu PLAYWRIGHT_MODULE=/tmp/ringgit-browser-tests/node_modules/playwright PYTHONPATH=/tmp/pdf-unlocker-test-python TEST_BASE_URL=http://127.0.0.1:8001 TEST_SCREENSHOTS=/tmp/pdfu-shots2 node tests/browser.test.cjs`: passed 143 real browser/runtime/download assertions and 25 controlled UI race/failure assertions against `python3 -m http.server 8001 --bind 127.0.0.1 --directory src`, up from 119 real assertions before this change. The real Pyodide, cryptography and pypdf runtime initialized; RHB, TNG and Maybank fixtures unlocked with their derived passwords and downloads were verified unencrypted by pypdf.
- Temporary CDP measurement scripts compared the date field's computed styles and UA shadow boxes with and without `appearance: none` in Chromium at 320px: no layout difference and the picker indicator intact. Saved screenshots were not visually reviewed in this session; the numeric box measurements were used instead.
- `npm exec -- prettier --check src/style.css tests/browser.test.cjs` and `npm run format:check`: passed with the pinned Prettier 3.8.3 on local Node v25.8.2 rather than the lint workflow's Node 24; `npm ci` was not rerun because the locked version was already installed.
- `uv tool run ruff@0.15.9 check --output-format github .`: passed with no findings. `uv tool run ruff@0.15.9 format --check .`: passed, four Python files already formatted. No Python changed.
- `node --check tests/browser.test.cjs`: passed.
- `git diff --check`: passed. The diff touches only the CSS rule with its explanatory comment and the new browser regression.
- WebKit could not be run here: Playwright's Linux WebKit needs GTK 4, GStreamer and related libraries that cannot be installed without root, and iOS Safari uses its own temporal-input UI. The fix therefore rests on documented WebKit temporal-input sizing, on the unchanged Chromium measurements above, and still needs confirmation on a physical iPhone through the pull request's hosted preview.
- The Pages preview deployment and lint workflow results for this branch are not verified locally and need checking in Actions.
