# Run lint checks on branch pushes

## Summary

- Preserved the requested removal of the lint workflow's `pull_request` trigger. Lint checks run on pushes to all branches.
- Updated README and AGENTS.md to match the trigger. Deployment preview triggers and application behavior are unchanged.

## Verification

- `npm exec -- prettier --check .github/workflows/lint.yml README.md AGENTS.md tasks/2026-10-10-use-push-only-lint-trigger.md`: passed.
- `npm run format:check`: passed repository-wide.
- `git diff --check`: passed.
- Reviewed the diff to confirm only the lint trigger, its documentation and this record changed. Application tests were not repeated for this trigger/documentation change.
