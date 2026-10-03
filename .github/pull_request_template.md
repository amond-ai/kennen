## Summary

<!-- What changed, and why? -->

> Use a Conventional Commit PR title, for example `fix: handle missing project scope`. The squash-merge commit takes the PR title, and release-please reads it to pick the version bump and write the changelog entry.

## Test Plan

<!-- Paste the commands, output snippets, screenshots, or manual evidence reviewers need. -->

- [ ] I ran the relevant automated tests and included the commands/results above.
- [ ] I manually validated the affected workflow, or this change is docs-only.
- [ ] This PR introduces a breaking change, and the migration path is described above; or this PR is not breaking.

## Changelog

- [ ] The PR title uses `feat` or `fix` for observable behavior changes, appends `!` to the type for breaking changes (for example, `feat!:`), and uses a non-releasing type such as `refactor`, `docs`, or `chore` otherwise.
- [ ] If this PR touches `.github/workflows/`, I have read [`docs/ci.md`](../docs/ci.md) and the workflow satisfies all seven rules in "Rules for new CI steps"; otherwise this PR does not touch CI.
