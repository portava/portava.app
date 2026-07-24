# APPLY — Mobile premium rendering (backend enablement)

Small backend enablement so the app can render the premium art efficiently.
No migration, no flag. The bulk of the work (the mobile components) goes to
your Replit agent via replit-command-stamp-mobile-rendering.md.

## What this patch does
- `routes/stamps.ts` — every stamp response now also returns `thumbnailUrl`
  (256px) alongside `activeArtworkUrl` (full). The artwork batch-resolver reads
  thumbnail_url from the active version, with a 42703 fallback for pre-0177 DBs.
- `services/stamps.ts` + `services/passportStamps.ts` — mobile Stamp types +
  mappers carry `thumbnailUrl` so the components have a clean typed contract.

Rarity was already exposed (`definition.rarity`) — no change needed there.

## Steps (workspace root)
1. Unzip, `git apply -p1 portava-stamp-mobile-enable.patch`
   (fallback: copy files/* over the workspace root).
2. `cd artifacts/api-server && pnpm test 2>&1 | tail -6` → green.
3. Hand `replit-command-stamp-mobile-rendering.md` to your Replit agent — it
   makes UniversalStampArtwork thumbnail-aware + expo-image-cached, adds the
   missing accessibilityLabel, and consolidates the ~9 duplicated rarity color
   maps into one module. Backend is done; the doc forbids touching it.

## After the agent finishes
Send me a fresh export and I'll audit the mobile work against this contract
(thumbnail-for-small / full-for-detail, fallback chain, single rarity source),
same as the previous UI reviews.
