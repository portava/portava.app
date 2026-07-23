# APPLY — Stamp Wave 2 (showcase + admire + recompose + event stamps)

Built against your tree WITH Wave 1 + the cityfix applied (i.e. exactly where
you are now). Everything user-facing is flag-gated OFF by default.

## What's in it

1. **Showcase** — curate up to 8 stamps, explicitly ordered, shown on your
   passport AND your public passport page. `GET/PUT /api/stamps/showcase`,
   `GET /api/users/:username/stamp-showcase`. Public view only ever exposes
   public + non-revoked stamps, order preserved. Flag: `stamp_showcase_enabled`.
2. **Admire** — appreciation on visible stamps. `POST/DELETE
   /api/stamps/:id/admire`, `GET /api/stamps/:id/admirers`. Self-admire
   blocked, duplicates collapse, owner gets an in-app notification
   (`passport.stamp_admired` template added). Flag: `stamp_admire_enabled`.
3. **Admin recompose** — `POST /admin/stamps/catalog/:id/recompose`
   `{ versionId?, rarity?, family? }`: re-runs COMPOSITION ONLY from stored
   hero art (no AI call, no queue) → new candidate version + audit log. This
   is how you try gold/legendary treatments or shape swaps for free.
4. **Event stamps wired (closes the old Task #1041 TODO)** — `first_event_joined`
   awards on RSVP-going, `first_event_hosted` on publish. Idempotent, with
   stamp-earned notifications. Live immediately (definitions were seeded by
   0145 long ago; awards are still gated by the stamp system's own flag).
5. **Mobile services** (fail-soft): `stampShowcase.ts`, `stampAdmire.ts`.
6. 12 new tests (`stampShowcaseAdmire.test.ts`); affected suites re-verified.

## Steps (workspace root)

1. Unzip `portava-stamp-wave2.zip`, then:

       git apply -p1 portava-stamp-wave2.patch

   (Fallback: copy `portava-stamp-wave2-files/*` over the workspace root.)

2. Run **0178_stamp_showcase_admire.sql** in the Supabase SQL editor (top
   level of the zip).

3. Verify: `cd artifacts/api-server && pnpm test 2>&1 | tail -6` → all green.

4. Hand `replit-command-stamp-showcase-ui.md` to your Replit agent for the UI
   (showcase row + curation sheet, public passport section, admire button).
   Backend + services are done; the doc forbids it from touching them.

## Flags (flip when the UI lands)

    UPDATE feature_flags SET enabled = TRUE WHERE flag IN ('stamp_showcase_enabled', 'stamp_admire_enabled');

## Try recompose right away (optional, no flag needed)

Recompose your Cebu City entry's active version at legendary, as a pennant:
admin auth required — use your admin session, catalog id from the admin
catalog screen. New candidate appears in the normal review queue.

## Still open for later waves

Criteria engine (event-category stamp variants wait on this), OG share
rebuild on composition layers, mobile thumbnail-aware rendering + expo-image,
v1→v2 legacy unification, STYLE_VERSION bump for catalog-wide premium regen.
