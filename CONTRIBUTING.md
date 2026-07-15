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

**Reference:** [`.github/workflows/sync-standalone-check.yml`](.github/workflows/sync-standalone-check.yml)
