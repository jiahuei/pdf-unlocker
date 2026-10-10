# Add reproducible formatting and Python lint checks

## Summary

- Added `.github/workflows/lint.yml` for all branch pushes and pull requests, using the reference repository's pinned action revisions, read-only permissions, cancellation concurrency and two-minute job timeouts. The independent jobs check Prettier on Node 24 and Ruff on Python 3.12; the deployment workflow is unchanged.
- Pinned development-only Prettier 3.8.3 with a private package manifest, lockfile, `format`/`format:check` scripts and repository-local defaults. Added generated-file/reference exclusions and corrected the existing VS Code snippet formatting baseline.
- Pinned Ruff 0.15.9 in workflow commands, enabled default lint rules plus import sorting, and targeted Python 3.11 for Pyodide compatibility. Sorted/formatted Python tests without changing behavior and corrected the editor's Ruff configuration path.
- Updated README and AGENTS.md with the actual setup and workflow commands. No application UI, document-processing behavior or deployed dependencies changed.

## Verification

- `npm install --package-lock-only --ignore-scripts`: generated the pinned lockfile; no vulnerabilities reported.
- `npm ci`: passed; installed one development dependency and reported no vulnerabilities.
- `npm run format`: established the clean formatting baseline; the deployment workflow and application files were unchanged.
- `npm run format:check`: passed repository-wide.
- `uv tool run ruff@0.15.9 check --fix .` and `uv tool run ruff@0.15.9 format .`: normalized imports and Python formatting.
- `uv tool run ruff@0.15.9 check --output-format github .`: passed.
- `uv tool run ruff@0.15.9 format --check .`: passed; four Python files already formatted.
- `PYTHONPATH=/tmp/pdf-unlocker-test-python python3 -m unittest discover -s tests -p 'test_*.py' -v`: passed all nine document tests after Python formatting. Expected malformed-input parser warnings were emitted.
- `node --check src/app.js` and `node --check tests/browser.test.cjs`: passed.
- `python3 -m py_compile src/pdf-engine.py tests/pdf_fixtures.py tests/test_pdf_engine.py tests/verify_download.py`: passed.
- `python3 -c 'import yaml; from pathlib import Path; w=yaml.load(Path(".github/workflows/lint.yml").read_text(), Loader=yaml.BaseLoader); assert set(w["on"]) == {"push", "pull_request"}; assert w["permissions"] == {"contents": "read"}; assert set(w["jobs"]) == {"python_lint", "prettier_lint"}; assert all(j["timeout-minutes"] == "2" for j in w["jobs"].values()); print("Lint workflow YAML structure passed")'`: passed YAML parsing and structural assertions.
- `git diff --check`: passed.
- `actionlint .github/workflows/lint.yml` was not run because actionlint is unavailable. Hosted GitHub Actions remain to be verified after push. Local checks used Node 26.0.0 and Python 3.12.7; CI explicitly selects Node 24 and Python 3.12. Browser tests were not repeated because only tooling, documentation and behavior-preserving test formatting changed.
