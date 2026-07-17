# Portava updates — 11 commits since main

Everything from the login-logo replacement through the passport page redesign.
57 changed files, in their exact repo paths. Two ways to apply:

## Option A — copy files (Replit drag-and-drop)
Drag the folders in this zip into the repo root, replacing existing files.
All paths mirror the repository layout:
- travel-buddy-standalone/ ......... ACTIVE app (the one you develop/run)
- artifacts/travel-buddy/ .......... Replit preview tree (kept in sync)
- artifacts/api-server/ ............ backend (display-name max 30 validation)
- app/, src/, assets/ .............. legacy root tree (login screen parity)

## Option B — git (preserves the 11 commits + messages)
    git checkout -b feat/portava-logo-login
    git am portava-updates.patch

## What's included (newest first)
 1. Stamps tab: featured newest stamp + 3-column grid
 2. Reference-image match pass (chips, filters, timeline dates, map summary,
    Recently Visited, About details/trust/availability)
 3. Passport tabs redesign: Postcard Wall default + Trips/Stamps/Map/About
 4. Full passport page: highlights rail, 5-tab sections, reorderable
    section-order hook (usePassportSectionOrder)
 5. Header cleanup to social-profile hierarchy (avatar/name/trust pill/
    Edit Profile; Saved/Countries relocated)
 6. Pale stamps; stats counter as standalone card
 7. Document-style header fields + BIO section
 8. Passport-card header redesign + Portava rebrand of passport surfaces
 9. Forgot password / forgot username on root sign-in (parity port)
10. Password show/hide toggle on sign-in
11. New Portava logo + name + tagline on the login screen (all trees)

Display names are now capped at 30 chars (UI + API zod).
After applying, restart Metro with cache clear: npx expo start --clear
