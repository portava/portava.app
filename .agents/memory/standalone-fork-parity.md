---
name: Standalone tree parity
description: How to port travel-buddy changes into travel-buddy-standalone safely
---

# travel-buddy-standalone is a divergent fork, not a mirror

The rule: **diff each file against the main tree before copying anything.**

**Why:** Some standalone files are byte-identical to `artifacts/travel-buddy` (safe to `cp`), but key screens have diverged in BOTH directions — e.g. the standalone search screen carries Compass intent parsing, follow-up filter chips, and a no-results Compass fallback that main lacks, while main has tabs/features standalone lacks. Bulk-copying a main-tree screen over the standalone one silently destroys standalone-only features. Also verified for its theme tokens: same shape today, but don't assume.

**How to apply:**
1. `diff artifacts/travel-buddy/<path> travel-buddy-standalone/<path>` first.
2. Identical → `cp` the edited main file.
3. Divergent → port edits manually, anchored on the standalone file's own text; then run standalone `tsc` separately (its type surface can differ).
4. New shared files (new components/hooks) can be copied verbatim, but check the imports they pull in exist in standalone (e.g. hooks like `useNavBarCollapse`).
5. Known fork difference: standalone enables `experiments.typedRoutes` (main does not), so dynamic `router.push(`/x/${id}`)` template literals fail its tsc. Cast per the fork's own convention (`as any` at the call site, matching its existing screens).
6. Delegating a port to a subagent works well when the task spells out: diff-first rule, which files replace wholesale vs append, and "run standalone tsc; fix only ported files."
