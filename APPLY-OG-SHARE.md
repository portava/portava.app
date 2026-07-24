# APPLY — OG share-image rebuild

Backend-only, single file (`routes/passport.ts`). No migration. Rebuilds the
stamp link-preview image (`GET /users/:username/og-image.png?stamp=<id>`) so a
shared stamp shows the PREMIUM COMPOSITED artwork instead of the old flat
navy/gold card. See og-proof.png for the result.

## What changed
- The share card now features the full composited stamp (its own frame,
  typography, rarity treatment) presented whole, on a background themed by the
  destination's identity palette — matching the in-app stamp.
- Rebranded Travel Buddy → PORTAVA; Poppins typography.
- Artwork source now prefers the catalog's active composited version
  (stamp_artwork_versions.public_url) and falls back to the legacy
  universal_artwork_url, then to a palette monogram.
- Palette resolved via the composition identity for the stamp's city/country.

## Unchanged (verified)
- Visibility gating is untouched: private / friends-only / revoked / wrong-owner
  stamps still fall back to the generic passport card and never leak. All 81
  og-image + stamp-preview visibility tests pass.
- The Supabase storage host already passes the existing SSRF allowlist, so
  composited URLs fetch as data URIs the same way avatars do.

## Steps (workspace root)
1. Unzip, then `git apply -p1 portava-stamp-og-share.patch`
   (fallback: copy files/artifacts/api-server/src/routes/passport.ts over yours).
2. `cd artifacts/api-server && pnpm test 2>&1 | tail -6` → green.

No flag, no migration — this is a straight visual upgrade to the share image.
Works best for stamps that have a composited version (Wave 1 premium art); any
stamp without one still renders, just with legacy/monogram art.

## Verify a real share
    curl -s "$API/users/<username>/og-image.png?stamp=<publicStampId>" -o og.png
(open og.png — should be the palette-themed premium card)
