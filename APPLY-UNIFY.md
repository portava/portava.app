# APPLY — Stamp legacy unification (read-layer)

Backend-only. Resolves the last structural item from the audit: the two stamp
systems that count separately (v1 GPS passport_stamps vs v2 achievement
user_stamps). Flag-gated OFF — applying changes nothing until you enable it.

## The safe design
This is a READ-LAYER merge — deliberately NOT a destructive migration:
- No schema change, no data movement. Both write paths stay exactly as they are.
- UnifiedStampService reads both tables and deduplicates: by catalog_id (which
  reconcile already backfills on BOTH tables), falling back to
  stamp_type|country|city. When a place exists in both, the richer v2 row wins
  (keeps rarity + composited art).
- Fully defensive: a missing table or column drift makes that source
  contribute nothing rather than throwing — a passport read never crashes.

## What ships
- services/passport/UnifiedStampService.ts — buildUnifiedStamps (list + count +
  breakdown), getUnifiedStampCount, unifiedViewEnabled.
- GET /stamps/me/unified — the deduped collection (always available; returns
  the flag state so the client can choose to adopt it).
- passport-card stampCount — when stamp_unified_view_enabled is ON, reports the
  deduped v1+v2 total instead of the v1-only GPS count; any error falls back to
  the v1 count.
- migration 0181 — the flag (default FALSE).

## Steps (workspace root)
1. Unzip, `git apply -p1 portava-stamp-unify.patch`
   (fallback: copy files/* over the workspace root).
2. Run 0181_stamp_unified_view.sql in Supabase.
3. `cd artifacts/api-server && pnpm test 2>&1 | tail -6` → green
   (9 new unification tests + passport/profile/stamp suites re-verified).

## Turning it on
    UPDATE feature_flags SET enabled = TRUE WHERE flag = 'stamp_unified_view_enabled';

Then the passport count reflects achievements + GPS as one number. Before
flipping, it's worth running the reconciler once (POST /admin/stamps/reconcile)
so catalog_id is backfilled on both tables — that makes dedup maximally
accurate (a GPS Tokyo and an achievement Tokyo collapse to one).

## Note — this is unification WITHOUT a forced migration
A later, separately-decided step could migrate v1 GPS writes into v2 and retire
passport_stamps. That's irreversible and deserves its own decision; this wave
gives you the unified experience now, reversibly, by a flag.
