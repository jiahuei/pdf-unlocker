# Add hosted pull-request previews and deployment comments

## Summary

- Replaced the single-source deployment with a combined Pages artifact: current remote `main` stays at the production root and every open same-repository pull request is published beneath `pr-preview/<number>/`. Each source uses an immutable commit; only regular Git blobs under `src/` are copied. Pull-request application build scripts are never executed.
- Added a shared Node standard-library packaging/comment helper and PDF-specific source configuration. Fresh artifacts omit closed/fork previews without maintaining a deployment branch. Existing marked bot comments are reconciled after deployment, including closures whose queued event was superseded.
- Added pinned checkout/Node/Pages actions, separate build/deploy/comment permissions and success dependencies. All deployments share non-canceling `pages` concurrency. Preview comments include the deployed source SHA and update rather than duplicating comments.
- Added packaging/comment regressions to both lint and deployment workflows, generated-artifact exclusions, and README/AGENTS guidance for settings, URLs, events and verification. Application code is unchanged.

## Verification

- `node --test tests/pages-preview.test.cjs`: passed eight tests covering runtime selection, source-prefix boundaries, current-main and immutable PR separation, API pagination, relative assets, close/fork behavior, unsafe paths/symlinks and idempotent comments.
- `/tmp/finance-lint-node24/node_modules/.bin/node --test tests/pages-preview.test.cjs`: the same eight tests passed with Node 24.21.0, matching CI's major version.
- Actual repository snapshot assertions passed using the script below: production `index.html` matched `origin/main`, PR #10 `app.js` matched `HEAD`, and documentation/tooling were absent from the artifact.

  ```sh
  node <<'JS'
  const fs = require('node:fs');
  const assert = require('node:assert/strict');
  const { execFileSync } = require('node:child_process');
  const { buildSite } = require('./scripts/pages-preview.cjs');
  const git = (...args) => execFileSync('git', args);
  const main = git('rev-parse', 'origin/main').toString().trim();
  const head = git('rev-parse', 'HEAD').toString().trim();
  buildSite(process.cwd(), '_site', require('./scripts/pages-preview.json'), { main, previews: [{ number: 10, sha: head }] });
  assert.deepEqual(fs.readFileSync('_site/index.html'), git('show', `${main}:src/index.html`));
  assert.deepEqual(fs.readFileSync('_site/pr-preview/10/app.js'), git('show', `${head}:src/app.js`));
  for (const file of ['AGENTS.md', 'README.md', 'tests', 'scripts', 'package.json']) assert.equal(fs.existsSync(`_site/${file}`), false);
  console.log('Actual main production and PR10 snapshots match immutable Git blobs; tooling excluded.');
  JS
  ```

- `python3 -m http.server 8001 --bind 127.0.0.1 --directory _site` plus `LD_LIBRARY_PATH=/tmp/finance-browser-libs/extracted/usr/lib/x86_64-linux-gnu PLAYWRIGHT_BROWSERS_PATH=/tmp/finance-browsers PLAYWRIGHT_MODULE=/home/akk/.npm/_npx/4d28a6818d23920b/node_modules/playwright PYTHONPATH=/tmp/pdf-unlocker-test-python TEST_BASE_URL=http://127.0.0.1:8001/pr-preview/10/ node tests/browser.test.cjs`: passed 78 real browser/runtime/download assertions and 19 controlled UI timing/failure assertions beneath the preview prefix. Real decrypted downloads were independently checked; relative Python/assets, AES passwords, worker fallback, mobile layouts and cleanup worked. The owned local server was stopped afterward.
- `npm run format:check` and `PATH=/tmp/finance-lint-node24/node_modules/.bin:$PATH npm run format:check`: passed repository-wide.
- `uv tool run ruff@0.15.9 check --output-format github .` and `uv tool run ruff@0.15.9 format --check .`: passed; four Python files already formatted.
- `node --check scripts/pages-preview.cjs`, `node --check tests/pages-preview.test.cjs`, `/tmp/finance-lint-node24/node_modules/.bin/node --check scripts/pages-preview.cjs` and `/tmp/finance-lint-node24/node_modules/.bin/node --check tests/pages-preview.test.cjs`: passed.
- `python3 -c 'import yaml; from pathlib import Path; w=yaml.load(Path(".github/workflows/deploy.yml").read_text(), Loader=yaml.BaseLoader); assert set(w["on"]) == {"push", "pull_request", "workflow_dispatch"}; assert w["concurrency"] == {"group": "pages", "cancel-in-progress": "false"}; assert w["jobs"]["comment"]["needs"] == ["build", "deploy"]; assert w["jobs"]["deploy"]["permissions"] == {"pages": "write", "id-token": "write"}; assert all(len(s["uses"].split("@")[1]) == 40 for j in w["jobs"].values() for s in j["steps"] if "uses" in s); lint=yaml.load(Path(".github/workflows/lint.yml").read_text(), Loader=yaml.BaseLoader); assert any(s.get("run") == "node --test tests/pages-preview.test.cjs" for s in lint["jobs"]["prettier_lint"]["steps"]); print("Pages and lint YAML structure passed")'`: passed.
- `git diff --check`: passed. `actionlint .github/workflows/deploy.yml .github/workflows/lint.yml` was not run because actionlint is unavailable.
- [Hosted deployment and preview-comment jobs](https://github.com/jiahuei/pdf-unlocker/actions/runs/38062832321) succeeded for commit `0289c17a8a46606247b3eb07bcb847f11298c394`. The [PR #10 preview](https://jiahuei.github.io/pdf-unlocker/pr-preview/10/) is accessible before merge.
- `LD_LIBRARY_PATH=/tmp/finance-browser-libs/extracted/usr/lib/x86_64-linux-gnu PLAYWRIGHT_BROWSERS_PATH=/tmp/finance-browsers PLAYWRIGHT_MODULE=/home/akk/.npm/_npx/4d28a6818d23920b/node_modules/playwright PYTHONPATH=/tmp/pdf-unlocker-test-python node /tmp/pdf-unlocker-hosted-smoke.cjs`: passed the hosted smoke. Production root bytes matched `origin/main:src/index.html` at `780965fc2fd3b95661cc7f5ff25784f944e726a6`; all 12 preview files matched the deployed PR commit. Actual Pyodide/crypto initialization, AES-256 decryption, two-page rendering and download succeeded at 375px. The downloaded PDF independently verified as unencrypted with text, metadata, outline and attachment preserved; no unhandled browser errors occurred.
- `npm exec -- prettier --check tasks/2026-10-10-add-hosted-pr-previews.md tasks/todo.md`: passed after recording hosted outcomes. Temporary browser/Node paths and the hosted smoke script are container-specific; README documents portable test setup. The pull request has not been merged.
