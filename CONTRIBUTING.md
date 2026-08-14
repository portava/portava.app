# Contributing

## CI — GitHub Actions workflows

### Workflow self-reference convention

Every workflow that uses a `paths:` filter **must include its own file path** in every `paths` block.

```yaml
paths:
  - ".github/workflows/my-workflow.yml"   # ← always add this
  - "src/**"
```

**Why:** Without the self-reference, editing the workflow file itself (adding a step,
fixing a command, or changing an env var) does not re-trigger the workflow. New logic
runs only on the next unrelated commit that touches a watched path, silently skipping
the commit that introduced it.

**Reference:** none — and that is the current state, not an omission. This rule
linked `.github/workflows/sync-standalone-check.yml`, which has never existed on
this line of history. (It exists on `origin/main`, but `main` and this branch have
no merge base at all — `git merge-base origin/main HEAD` is empty — so nothing
there is a reference for anything here.)

The three workflows that do exist — `ci.yml`, `live-db.yml`, `unwired-checks.yml` —
use no `paths:` filter at all, so none of them is subject to this rule today. It
applies to the next workflow that adds one. Verified 2026-08-14 while archiving
`artifacts/travel-buddy`; `scripts/src/workflow-paths.test.ts` records the same
finding from the other direction, having retired 24 assertions that threw ENOENT
against those two non-existent workflow files.
