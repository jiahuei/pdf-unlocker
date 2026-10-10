# Add repository-specific PDF Unlocker agent guidance

## Summary

- Added AGENTS.md with the shared engineering principles and repository-specific source layout, runtime dependencies, browser verification and GitHub Pages deployment guidance.
- Corrected README local setup to serve src/ and documented the internet requirement for runtime libraries while PDF processing stays in the browser.
- Left application source and deployment configuration unchanged.

## Verification

- Reviewed src/index.html, LICENSE and .github/workflows/deploy.yml against the documented layout, dependencies, license and deployment behavior.
- `npx prettier --write --no-config AGENTS.md README.md tasks/2026-10-10-add-agent-guidance.md`: formatted changed Markdown without inheriting the enclosing repository's configuration.
- `npx prettier --check --no-config AGENTS.md README.md tasks/2026-10-10-add-agent-guidance.md`: passed.
- `npx prettier --check --no-config .`: reported existing formatting differences in `.vscode/python.json.code-snippets`, `src/assets/site.webmanifest` and `src/index.html`; unrelated files were left unchanged.
- `git diff --check`: passed.
- Application tests were not run for this documentation-only change; this repository has no automated test suite.
