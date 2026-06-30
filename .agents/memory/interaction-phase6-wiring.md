---
name: Interaction Phase 6 — cross-screen wiring
description: Which surfaces have UserOverflowMenu wired; Safe Return block guard pattern; which backend routes still need building
---

## What was built

All Phase 5 interaction components now exist in `travel-buddy-standalone/src/components/interaction/`:
- Barrel: `index.ts` re-exports all 13 components
- Key components: `UserOverflowMenu`, `UserMiniProfileCard`, `UserAvatarButton`, `UserNameButton`, `ProfileActionBar`
- Sheet components: `BlockUserConfirmSheet`, `ReportUserSheet`, `MuteUserSheet`, `RestrictUserSheet`
- Other: `RelationshipBadge`, `KnownFromRow`, `MessageRequestCard`, `SocialSafetyControlsScreen`

Services: `interactionContext.ts`, `mutes.ts`, `restrict.ts`, `saves.ts`, `reports.ts`
Hooks: `useUserInteractionContext`, `useBlockUser`, `useMuteUser`, `useRestrictUser`, `useReportUser`, `useSavedProfileActions`, `useRelationshipLabel`, `useCanMessageUser`

New screens: `app/settings/safety.tsx`, `app/muted-users.tsx`, `app/restricted-users.tsx`

## Surfaces wired with UserOverflowMenu

| Surface | File | Notes |
|---------|------|-------|
| Traveler list rows | `src/components/TravelerRow.tsx` | `onBlockSuccess` prop added |
| Circle member rows | `app/circle.tsx` — `CircleUserRow` | row becomes `View` (not Pressable); inner Pressable for nav |
| Trip crew cards | `src/components/tripCrew/CrewMemberCard.tsx` | `isBlockedByViewer` prop suppresses Safe Return |
| Rent-a-buddy profile | `app/(rent-a-buddy)/buddy/[id].tsx` | In hero nav overlay |
| Settings | `app/settings/index.tsx` | "Safety & Privacy" row → `/settings/safety` |

## Safe Return block guard

`CrewMemberCard` accepts `isBlockedByViewer?: boolean`. When true:
- `statusLabel` forced to `'location_hidden'`
- `safeReturnActive`, `liveShareActive`, `areaLabel`, `planCheckInStatus` all zeroed
- Overflow menu hidden (nothing to interact with)

**Why:** Server may include Safe Return status in the crew list response; this client-side guard ensures a blocked viewer never sees the blocker's location regardless of server response.

**How to apply:** The crew list hook/fetch must pass `isBlockedByViewer` per member. This requires either server-side filtering or a per-member block check from the interaction context. The density map (DensityMap component in CrewMapSection) does NOT yet filter blocked members from dot counts — that's follow-up #789.

## Backend routes NOT yet implemented

These mobile services are wired but the backend 404s:
- `GET /api/users/:id/interaction-context` — critical; without it, all permission checks resolve to null
- `POST/DELETE /api/users/:id/mute` + `GET /api/me/mutes`
- `POST/DELETE /api/users/:id/restrict` + `GET /api/me/restrictions`
- `POST/DELETE /api/users/:id/save`
- `POST /api/reports`

See follow-up tasks #790 and #791.
