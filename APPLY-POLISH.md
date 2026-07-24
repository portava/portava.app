# APPLY — Polish sweep (accessibility + env docs)

Two small, self-contained fixes from the audit's loose-ends list. No migration,
no flag, no behavior change beyond the accessibility improvement.

## What's in it
1. **StampEarnedToast reduced-motion gate** — the stamp-earned toast animated
   its slide-in/out unconditionally. Now it checks the OS "Reduce Motion"
   setting (via AccessibilityInfo, same pattern as StampCard's shimmer) and
   snaps in/out instead of sliding when the user has reduced motion on.
2. **.env.example** — documents the FX refresh vars (FX_REFRESH_ENABLED etc.)
   and lists every feature flag with a pointer to the activation guide.

## Steps (workspace root)
1. Unzip, `git apply -p1 portava-polish.patch`
   (fallback: copy files/* over the workspace root).
2. `pnpm --filter travel-buddy exec tsc --noEmit` → clean (verified).

No SQL, no flags. Ship whenever.
