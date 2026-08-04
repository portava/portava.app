---
name: Portava share icon conventions
description: Which icons count as "genuine content-share" vs excluded lookalikes, and how the custom SVG geometry was built without a rasterizer.
---

## Scope rule: what counts as a genuine share action
- Native/system share, "Share Post"/"Share Trip"/"Share Event"/etc. triggers, and the ShareSheet's "Share Post" (native) row → use `PortavaShareIcon`/`PortavaShareButton`.
- NOT genuine shares, leave their existing icon alone:
  - `TelegraphSendIcon` usages (ForYouTab, DiscoveryWall, PostEngagementBar) — this is Telegraph's branded message-send glyph; task explicitly excludes replacing it even where it triggers a share-like "send to chat" flow.
  - ShareSheet's "Copy Link" (Link icon) and "Send in a chat" (MessageCircle icon) rows — distinct destination icons inside the sheet, not the generic share trigger.
  - Live-location/Safe Return "Share Location" buttons (`ActiveSafeReturnCard.tsx`) — location-sharing, explicitly out of scope.
  - Settings toggles like PostOwnerMenu's "Disable Sharing" row — controls a permission, not a share trigger.
- A screen can have two adjacent genuine share triggers (e.g. WatchItemOverlay's "Share" native button and "Send" button that opens ShareSheet) — both get the Portava icon with distinct accessibility labels; redesigning the redundancy is out of scope.

## No SVG rasterizer available
No cairosvg/rsvg-convert/playwright rasterizer works in this sandbox. Verify hand-authored SVG path geometry by mounting a dev-only preview route (pattern: `app/gems/*-preview.tsx`, redirects away when `!__DEV__`) and using the Screenshot tool against the live Expo app — iterate the path via CodeExecution trig/Bezier math, not visually.

## New preview routes need a portavaRoutes.ts entry
Any new file under `app/` (even a dev-only preview) fails `check-route-registry` in `mobile-typecheck` unless added to `src/navigation/portavaRoutes.ts`.
