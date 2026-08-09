# Avatar / icon / aspect-ratio sizing near-misses

Generated 2026-08-09, alongside the allowlist migration that moved every
*exact* token-matching avatar/icon/aspect literal in `check-avatar-icon-sizing.mjs`'s
allowlist over to the `avatar` / `icon` / `aspect` tokens in `theme/tokens.ts`
(allowlist now empty, ceiling 0).

**Update (2026-08-09, later same day):** the 34px and 44px clusters below were
promoted to real tokens — `avatar.smMd` (34) and `avatar.lgXl` (44) — after
confirming all 23 and 19 sites respectively are the same recurring circular
icon-button/avatar shape reused across unrelated components, not accidental
drift toward an existing token. All 42 sites are migrated; see the `avatar`
doc comment in `theme/tokens.ts` for the evidence.

**Update (2026-08-09, third pass):** `check-avatar-icon-sizing.mjs` was
widened to flag ANY circular box in the 27–56px band, not just exact token
matches — the previous match-only rule is exactly the mechanism that let
this whole cluster form (nobody reused a value because there was nothing to
check against). Running the widened rule surfaced 170 sites across the full
size range; only the 27–56px band (36 sites: 30/38/42/46/52) was in scope
for this pass. All 36 were classified RECURRING/INTENTIONAL (zero one-offs)
and promoted to tokens: `avatar.xsSm` (30), `avatar.mdLg` (38),
`avatar.lgLgXl` (42), `avatar.lgXlXl` (46), `avatar.xlXxl` (52). The guard
now enforces the widened rule for 27–56px only; the <14px, 14-26px, and
>56px bands below are **unchanged** — still real near-misses, still
un-migrated, still out of scope, and still only caught by the narrow
exact-match rule.

**Update (2026-08-09, fourth pass):** The <14px cluster was addressed. A
sweep of the full codebase found 94 hardcoded circular boxes below 14px.
Each size was classified:

| Value | Sites | Classification | Outcome |
|---|---|---|---|
| 8px | 24 | RECURRING (live-status/health/check dots across 20+ unrelated files) | → `dot.md` |
| 6px | 21 | RECURRING (pagination, suggestion, map-marker, loader dots) | → `dot.xs` |
| 10px | 13 | RECURRING (radio-button fill, presence/status dots) | → `dot.lg` |
| 7px | 12 | RECURRING (unread notification badge dots on icon buttons) | → `dot.sm` |
| 5px  | 9  | RECURRING (carousel indicators, rarity markers, loader dots) | → `dot.xxs` ¹ |
| 12px | 9  | RECURRING (online-presence dots overlaid on avatar corners) | → `dot.xl` |
| 4px  | 3  | ONE-OFF (StampItBurst animation burst particles) | kept as-is (below DOT_BAND) |
| 9px  | 1  | ONE-OFF (AvailabilityCard unique badge shape) | kept as-is, allowlisted |
| 11px | 1  | ONE-OFF (TravelerMapLayer unique map-marker shape) | kept as-is, allowlisted |
| 3px  | 1  | ONE-OFF (StampItBurst animation burst particle) | kept as-is (below DOT_BAND) |

¹ StampItBurst.tsx's 5px burst particle is kept as-is (allowlisted); all
other 5px sites (8 of 9) are migrated to `dot.xxs`.

All 86 recurring sites are migrated. Six sites (StampItBurst 5px+6px,
AvailabilityCard 9px, TravelerMapLayer 11px) are in the allowlist
with `ALLOWLIST_CEILING = 4`. The guard's DOT_BAND (5–12px) catches any new
circular box in that range. The sub-5px values (3/4px) are animation
particles that fall below DOT_BAND_MIN and are not a token category.

A new `dot` export was added to `src/theme/tokens.ts`:
`{ xxs: 5, xs: 6, sm: 7, md: 8, lg: 10, xl: 12 }`

**Update (2026-08-09, fifth pass):** the 14-26px icon-adjacent band was
migrated. Two recurring values were classified and promoted:

- **24px × 14 sites** — RECURRING/INTENTIONAL. Appears as icon-button
  wrappers, action circles, remove buttons, step-badge indicators, stacked
  avatar rings, check indicators, route-member avatars, and media-overlay
  dots across 12+ unrelated components. Promoted to `icon.lgXl` (infill
  between `icon.lg` 22 and `icon.xl` 26).
- **16px × 4 sites** — RECURRING/INTENTIONAL. Appears as radio-button
  controls (booking/[id].tsx), stacked avatar rings (GroupChatScreen),
  map-pin overlay circles (TripPage), and check-status badges
  (PassportVerificationStamp) — four distinct semantic categories, all
  independently landing on the same 16px circle. Promoted to `icon.smMd`
  (infill between `icon.sm` 14 and `icon.md` 18).

All 18 sites migrated; imports added where absent. The guard's widened
detection band was extended from 27–110px down to **14–110px** — any new
hardcoded circle in the entire icon/avatar range is now caught immediately.

**Update (2026-08-09, sixth pass):** the >56px band (22 sites:
60/64/68/70/72/78/80/88/90/96/110) was classified and migrated. Of the 22
circular boxes:

- **64px × 9** (StampGrid skeleton, TagPreviewSheet type icon, ErrorState icon
  wrap, SavedPlacesMapView icon, destination/[slug] empty icon, map/index
  icon circles ×2, map/index.web icon circle, become/apply success circle):
  RECURRING — same large-placeholder circle shape across unrelated files →
  new token `avatar.xxxl` (64). All 9 migrated.

- **72px × 3** (buddy/[id] trust ring, PrivateProfileWall avatar placeholder,
  EmptyState icon wrap): RECURRING → new token `avatar.xxxxl` (72).
  All 3 migrated.

- **96px × 2** (profile/edit/photos avatar + avatarEmpty): RECURRING →
  new token `avatar.xxxxxl` (96). Both migrated.

- **60px × 1** (CallControls end button): ACCIDENTAL ONE-OFF → snapped to
  `avatar.xxxl` (64).

- **68px × 1** (IncomingCallScreen action buttons): ACCIDENTAL ONE-OFF →
  snapped to `avatar.xxxl` (64).

- **80px × 1** (gems/guide avatar circle): ACCIDENTAL ONE-OFF → snapped to
  `avatar.xxxxl` (72).

- **88px × 1** (PassportShareCard avatar): ACCIDENTAL ONE-OFF → snapped to
  `avatar.xxxxxl` (96).

- **90px × 1** (stamps.tsx empty stamp container): ACCIDENTAL ONE-OFF →
  snapped to `avatar.xxxxxl` (96).

- **70px × 1** and **110px × 1** (CrewMapSection ringInner / ringOuter):
  INTENTIONAL — a concentric-ring map visualization where the specific
  70/110 ratio is deliberate. Not an avatar/icon circle. Kept as hardcoded
  values, recorded in the shrink-only allowlist.

- **78px × 1** (PassportMarks ink ring): INTENTIONAL — a passport-aesthetic
  stamp ring with specific border/opacity styling. Not a generic avatar
  circle. Kept, recorded in allowlist.

The guard's widened-detection band now covers 14–110px (full audited range).
The allowlist ceiling is 3 (the three intentional decorative rings).
The 64/72/96 tokens are added to `AVATAR_VALUES` for exact-match detection.

The rows for 34/44/30/38/42/46/52 are left in the tables below for
historical record of the original sweep, but they are no longer
"near-misses" — they are now exact token matches like everything else the
guard tracks.

This document is the other half of that check's stated scope: it does **not**
detect near-misses (see "WHAT THIS CHECK DOES NOT DO" in
`scripts/check-avatar-icon-sizing.mjs`) — a hardcoded circular box or
`aspectRatio` whose value does *not* exactly match a token. This is a
one-time manual sweep of those, run the same way the guard scans (circular
`width: N, height: N` with a matching `borderRadius`, and `aspectRatio: N`
or `N / D` literals), across `app/` and `src/`. **No code was changed by
this sweep** — it is documentation only.

The sub-14px cluster this sweep originally flagged as "small status dots, not
avatar/icon material" was addressed in the fourth pass above.


## Aspect ratio near-misses

None found. Every `aspectRatio:` literal in the codebase either already
matched an `aspect` token (now migrated) or was expressed as a computed/
dynamic value (not a plain literal this scan can evaluate).

## Circular box near-misses

Values below are literal `width`/`height`/`borderRadius` circles that do
**not** match any `avatar` (28/32/36/40/48/56) or `icon` (14/18/20/22/26)
token value. Grouped by pixel value, largest clusters first within two
bands:

### Avatar/icon-plausible band (12–64px) — worth a look

These sit in the same general size range as the avatar/icon scales and are
plausible candidates for a future token (or for snapping to the nearest
existing token) in a **separate, deliberate pass** — not automatically,
since near-misses are by definition not provably identical to any token and
snapping them would be a real (if likely small) visual change.

| Value | Sites | Notes |
|---|---|---|
| 34px | 23 | Largest single cluster. Between `avatar.xs` (28) and `avatar.sm` (32) — closer to 32. Appears in avatar-shaped contexts (PulseHeader, AttachController, PassportHero, ConciergeCommandBar) as well as map-pin/place-picker thumbnails. |
| 44px | 19 | Between `avatar.sm` (32) and `avatar.md` (36) — not close to either; roughly its own size. Mixed avatar-like (StampPickerSheet) and icon-button (VideoThumbnail, MediaSourceSheet) usage. |
| 24px | 14 | Between `icon.md` (20) and `icon.lg` (22) — also not a close match to either despite being in icon territory. Many action-button/icon-badge sites (PulseFits, PassportSectionReorderSheet). |
| 30px | 13 | Between `avatar.xs` (28) and `avatar.sm` (32) — closer to 28. Map pins, place cards, discovery map markers dominate this bucket (not avatar contexts). |
| 10px | 13 | Below the smallest icon token (14). Small indicator dots/badges (BookingThreadHeader, TripPage), not avatar/icon boxes. |
| 8px | 24 | Below smallest icon token. Overwhelmingly small status dots (`liveDot`-style), not avatar/icon material. |
| 64px | 9 | Above `avatar.xxl` (56). Larger circular avatars/placeholders (ErrorState, StampGrid, become/apply hero). Closest plausible large-avatar candidate. |
| 12px | 9 | Below smallest icon token. Small dots/markers (CrewMemberCard, DiscoveryMapView). |
| 6px | 21 | Tiny dots, not avatar/icon material — included for completeness of the sweep, not a token candidate. |
| 7px | 12 | Same as above — tiny decorative dots. |
| 52px | 7 | Between `avatar.md` (36) and `avatar.xl` (48) — not close to either. CallControls, PassportSections, media tab avatars. |
| 38px | 6 | Between `avatar.sm` (32) and `avatar.md` (36) — closer to 36. Passport tab avatars, TravelerMapLayer pins. |
| 5px | 9 | Tiny dots. |
| 42px | 5 | Between `avatar.md` (36) and `avatar.xl` (48) — roughly its own size. MapCarousel, DiscoveryWall. |
| 46px | 5 | Between `avatar.xl` (48) and nothing smaller close — near `avatar.xl`. TravelerPreviewCard, MapEntityPreviewCard. |
| 16px | 4 | Between `icon.sm` (18) and nothing below — close to `icon.sm`. Booking detail, GroupChatScreen. |

### Outside the plausible band (<12px or >64px) — likely not avatar/icon candidates

Small values (3–11px, minus the ones already listed above at the boundary)
are overwhelmingly single-purpose decorative dots (live/status indicators,
unread badges) — not avatar or icon boxes, and not recommended for a
sizing token. Large values (>64px) are typically full-width media
thumbnails or hero circles with their own per-component sizing logic, not
part of the avatar/icon scale.

| Value | Sites |
|---|---|
| 3px | 1 — `src/components/media/StampItBurst.tsx:121` |
| 4px | 3 |
| 9px | 1 — `src/components/AvailabilityCard.tsx:37` |
| 11px | 1 — `src/components/discovery/TravelerMapLayer.tsx:198` |
| 60px | 1 — `src/components/calls/CallControls.tsx:114` |
| 68px | 1 — `src/components/calls/IncomingCallScreen.tsx:95` |
| 70px | 1 — `src/components/tripCrew/CrewMapSection.tsx:342` |
| 72px | 3 |
| 78px | 1 — `src/components/PassportMarks.tsx:86` |
| 80px | 1 — `app/gems/guide.tsx:192` |
| 88px | 1 — `src/components/PassportShareCard.tsx:122` |
| 90px | 1 — `app/stamps.tsx:254` |
| 96px | 2 — `app/profile/edit/photos.tsx:290,292` |
| 110px | 1 — `src/components/tripCrew/CrewMapSection.tsx:336` |

Full file:line lists for every value above (including the ones summarized
in the tables) were captured during this sweep; re-run
`node scripts/_scan-near-misses.mjs` from `travel-buddy-standalone/` if the
throwaway scan script still exists, or re-derive with the same regex
described at the top of this file — the script was a one-off and may have
been deleted after this doc was written.

## Recommendation

Do not snap any of these in this pass — that was an explicit constraint on
the allowlist migration this doc accompanies. If a future pass wants to
add tokens for near-miss clusters, **34px** and **44px** are the strongest
candidates by site count (23 and 19 respectively) and sit in genuinely
"between existing tokens" territory rather than being typos of an existing
token. The sub-12px and 60px+ values are not good candidates — they're
either decorative dots or one-off large media elements, not a coherent
avatar/icon size family.
