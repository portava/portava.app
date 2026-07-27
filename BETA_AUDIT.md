# Portava Beta Audit — Phase 1

**Audit date:** 2026-07-27  
**Scope:** All 5 tabs + every reachable screen and sheet  
**Method:** Static code review of every route file + component sheets  
**Trees checked:** `artifacts/travel-buddy/` (canonical) and `travel-buddy-standalone/` (mirror)

---

## Legend

| Severity | Meaning |
|---|---|
| **P0** | App-breaking / CI-blocking / data loss |
| **P1** | Major UX defect — confusing, crashes on likely input, or dead-end navigation |
| **P2** | Minor UX issue — cosmetic, edge-case, or low-traffic path |
| **INFO** | Observation, not actionable for beta |

---

## Defect Log

| # | Screen | Element | Defect | Severity | Status |
|---|---|---|---|---|---|
| 1 | API: `passportStamps.ts` | `user_follows.select("id")` | Column `id` doesn't exist on `user_follows`; `check-write-path-columns` CI was permanently red | **P0** | ✅ Fixed — changed to `follower_id` / `following_id` |
| 2 | `app/follow-requests.tsx` | Accept/Decline spinner | `isResponding` checked `item.requesterId` but state was keyed on `item.requestId` — spinner never appeared while responding | **P1** | ✅ Fixed both trees |
| 3 | `app/(tabs)/passport.tsx` | "Sign in" CTA (unauthenticated) | `router.push('/sign-in')` — route `/sign-in` doesn't exist; file is at `(auth)/sign-in.tsx` | **P1** | ✅ Fixed both trees |
| 4 | `app/(tabs)/passport.tsx` | Sign-out callback | `router.replace('/sign-in' as any)` — same dead route as above, `as any` suppressed the TS error | **P1** | ✅ Fixed both trees |
| 5 | `app/availability.tsx` | Trip windows date display | `w.startDate.slice(0, 10)` — crash if `startDate` is `null` (possible for windows without confirmed dates) | **P1** | ✅ Fixed both trees — guarded with `(w.startDate ?? '').slice(0, 10)` |
| 6 | `app/close-friends.tsx` | Add-member input | Placeholder said "Enter user ID to add…" exposing raw UUID requirement; empty state said "user ID" too | **P1** | ✅ Fixed both trees — input now accepts `@username`, resolves to UUID via `searchUsers` before calling `addCloseFriend` |
| 7 | `app/(rent-a-buddy)/buddy-dashboard/requests.tsx` | Traveller avatar initials | `booking.travelerId.slice(0, 2)` — crash if `travelerId` is `null` or `undefined` | **P1** | ✅ Fixed both trees — guarded with `(booking.travelerId ?? '??').slice(0, 2)` |
| 8 | `src/components/create/CreateHubSheet.tsx` | Story / Plan / Add Place / Review Place buttons | All four show a "Soon" badge and are non-interactive (`disabled`, no `route`). Users tapping these get no feedback beyond the badge. | **P2** | Open — intentional placeholder; badge is visible but no tooltip/ETA |
| 9 | `app/(rent-a-buddy)/booking/[id].tsx` | "Map" section | Labelled "Map — coming soon" — static, non-tappable block with no ETA | **P2** | Open — intentional placeholder |
| 10 | `app/search.tsx` | Empty history state | Shows only a `Search` icon (36px) with no label or prompt — user doesn't know why the screen is blank | **P2** | ✅ Fixed both trees — added "No search history yet" label |
| 11 | `app/(tabs)/index.tsx` (Pulse) | Feed row rendering | `p.mediaUrls[0]` accessed without checking `mediaUrls` is defined or non-empty | **P2** | ✅ Fixed both trees — changed to `p.mediaUrls?.[0]` |
| 12 | `app/events/invites.tsx` | Date rendering | `new Date(ev.startsAt)` — crash if `startsAt` is `null`; API shape implies it can be absent | **P2** | Open |
| 13 | `app/invite/[token].tsx` | Date range display | `new Date(d)` in `formatDateRange` — "Invalid Date" text if server sends non-ISO string | **P2** | Open |
| 14 | `app/gems/guide.tsx` | Expertise list | `guide.cityExpertise.join(...)` — crash if `cityExpertise` is not an array (API type is cast, not validated) | **P2** | Open |
| 15 | `app/meetup/[id].tsx` | Proposed time rendering | `timeStr.split(':')` — crash if no colon in the time string | **P2** | Open |
| 16 | `app/(rent-a-buddy)/buddy-dashboard/offer-create.tsx` | Included services field | `includedServices.split(',')` — safe as `useState('')`; guarded by `.trim()` check; no bug | **INFO** | No fix needed |
| 17 | `app/restricted-users.tsx` | Empty state | Has heading "No restricted accounts" but lacks the instructional sub-text present in other similar screens | **P2** | ✅ Fixed both trees — added sub-text explaining restricted accounts |
| 18 | `app/(auth)/sign-in.tsx` | Layout | Works correctly; navigates to `/(tabs)` on success and `/(auth)/onboarding` for new users | **INFO** | Clean |
| 19 | `app/(tabs)/discovery.tsx` | Layout | Clean; routes to `/search` correctly | **INFO** | Clean |
| 20 | `app/(tabs)/media.tsx` | FAB | Routes to `/create` correctly | **INFO** | Clean |
| 21 | `app/(tabs)/trips.tsx` | Trip list | Routes to `/meetups`, `/trip/new`, `/(auth)/sign-in` all exist | **INFO** | Clean |
| 22 | `app/(tabs)/events.tsx` | Events list | Routes to `/events/create`, `/events/invites` — both exist | **INFO** | Clean |
| 23 | `app/(tabs)/messages.tsx` | Shell | Delegates to `TelegraphInboxScreen`; minimal shell, no issues | **INFO** | Clean |
| 24 | `app/(tabs)/ai.tsx` | AI Buddy | All action routes exist and are valid | **INFO** | Clean |
| 25 | `app/create.tsx` | Post composer | Routes to `/(tabs)` on dismiss — clean | **INFO** | Clean |
| 26 | `app/events/create/index.tsx` | 9-step wizard | Routes to `/event/${id}` on publish — valid | **INFO** | Clean |
| 27 | `app/trip/new.tsx` | Create trip | Routes to `/trip/${id}` — valid | **INFO** | Clean |
| 28 | `app/trip/edit.tsx` | Edit trip | Routes to `/trip/${id}` — valid | **INFO** | Clean |
| 29 | `app/gems/submit.tsx` | Submit gem | Routes to `/gems` — valid | **INFO** | Clean |
| 30 | `app/memory/edit.tsx` | Edit memory | `router.back()` only — clean | **INFO** | Clean |
| 31 | `app/memory/location.tsx` | Location memories | Routes to `/memory/${id}` — valid | **INFO** | Clean |
| 32 | `app/post/edit/[id].tsx` | Edit post | `router.back()` — clean | **INFO** | Clean |
| 33 | `app/profile/edit/index.tsx` | Settings hub | All 14 sub-routes exist as files | **INFO** | Clean |
| 34 | `app/followers.tsx` | Followers list | Routes to `/u/${handle}` — valid | **INFO** | Clean |
| 35 | `app/following.tsx` | Following list | Routes to `/u/${handle}` — valid | **INFO** | Clean |
| 36 | `app/blocked-users.tsx` | Blocked list | No navigation out; back only | **INFO** | Clean |
| 37 | `app/muted-users.tsx` | Muted list | No navigation out; back only | **INFO** | Clean |
| 38 | `app/explore-portava.tsx` | Feature directory | All listed routes exist as files | **INFO** | Clean |
| 39 | `app/close-friends.tsx` | Trusted Crew list | Fixed (see #6) | **INFO** | ✅ Fixed |
| 40 | `app/circle.tsx` | Circle hub | Routes to `/discover`, `/availability`, `/messages/${id}` — all valid | **INFO** | Clean |
| 41 | `app/messages/[id].tsx` | Telegraph chat | Routes to `/u/${handle}`, `/meetup/${id}`, `/trip/${id}`, `/circle` — all valid | **INFO** | Clean |
| 42 | `app/search.tsx` | Search hub | Routes via `resolveRoute()` helper; empty history icon-only state (see #10) | **P2** | Partially open |
| 43 | `app/notifications.tsx` | Activity center | `notification.actionUrl` used directly in `router.push` inside try/catch — malformed URLs caught | **INFO** | Clean |
| 44 | `app/saved.tsx` | Collections | Routes to `/post/${id}`, `/event/${id}`, `/trip/${id}`, `/place/${id}`, `/u/${id}`, `/hashtag/${slug}` — all valid | **INFO** | Clean |
| 45 | `app/discover.tsx` | Find Travelers | No dead routes; `TravelerRow` handles navigation internally | **INFO** | Clean |
| 46 | `app/map/index.tsx` | Full-screen map | `easeTo` calls guarded; WebPlaceholder for browser users | **INFO** | Clean |
| 47 | `app/media-viewer/[id].tsx` | Media viewer | Edge-to-edge viewer; error state has "Media not available" copy | **INFO** | Clean |
| 48 | `app/hashtag/[slug].tsx` | Hashtag feed | Empty state has copy per tab; routes to `/post/${id}`, `/u/${handle}` | **INFO** | Clean |
| 49 | `app/destination/[slug].tsx` | Destination guide | Routes to `/gems/${id}`, `/event/${id}`, `/post/${id}` — all valid | **INFO** | Clean |
| 50 | `app/(rent-a-buddy)/index.tsx` | RaB landing | Routes to `waitlist`, `search`, `buddy/${id}`, `checkout`, `become` — all valid | **INFO** | Clean |
| 51 | `app/(rent-a-buddy)/marketplace.tsx` | Marketplace | Routes to `buddy/[id]`, `match-quiz`, `request-buddy` — all valid | **INFO** | Clean |
| 52 | `app/(rent-a-buddy)/search.tsx` | Buddy search | Routes to `/`, `checkout`, `waitlist` — all valid | **INFO** | Clean |
| 53 | `app/(rent-a-buddy)/buddy/[id].tsx` | Buddy profile | Routes to `/`, `checkout` — valid | **INFO** | Clean |
| 54 | `app/(rent-a-buddy)/checkout.tsx` | Booking flow | Routes to `/booking/${id}` on success — valid | **INFO** | Clean |
| 55 | `app/(rent-a-buddy)/become/index.tsx` | Become a Buddy | Routes to `apply` — valid | **INFO** | Clean |
| 56 | `app/(rent-a-buddy)/become/apply.tsx` | Buddy application | Routes to `buddy-dashboard`, `packages`, `availability` — all valid | **INFO** | Clean |
| 57 | `app/(rent-a-buddy)/booking/[id].tsx` | Booking management | Routes to `buddy/${id}`, `/messages/[id]`, `review` — valid; "Map coming soon" (see #9) | **P2** | Partially open |
| 58 | `app/(rent-a-buddy)/buddy-dashboard/index.tsx` | Buddy hub | Routes to all sub-screens — valid | **INFO** | Clean |
| 59 | `app/(rent-a-buddy)/buddy-dashboard/requests.tsx` | Booking requests | travelerId null guard added (see #7) | **INFO** | ✅ Fixed |
| 60 | `app/(rent-a-buddy)/buddy-dashboard/earnings.tsx` | Earnings | Clean; empty states have copy | **INFO** | Clean |
| 61 | `app/(rent-a-buddy)/buddy-dashboard/packages.tsx` | Packages | Clean; empty state has copy | **INFO** | Clean |
| 62 | `app/(rent-a-buddy)/buddy-dashboard/safety.tsx` | Safety tools | Static actions; no navigation dead-ends | **INFO** | Clean |
| 63 | `app/compass-preferences.tsx` | Compass settings | Routes to `compass-memories`, `/(rent-a-buddy)/buddy-dashboard` — both valid | **INFO** | Clean |
| 64 | `app/compass-memories.tsx` | Compass memories | Delegates to `<CompassRemembers />`; back only | **INFO** | Clean |
| 65 | `app/availability.tsx` | Availability hub | startDate null guard added (see #5) | **INFO** | ✅ Fixed |
| 66 | `app/safety-number.tsx` | Safety numbers | Back only; error is silently caught (acceptable for E2EE) | **INFO** | Clean |
| 67 | `app/safety-history.tsx` | Safe Return history | Clean empty states; feature-flag gated | **INFO** | Clean |
| 68 | `app/appeals.tsx` | Moderation appeals | Clean; back only | **INFO** | Clean |
| 69 | `app/pending-posts.tsx` | Pending posts | Routes to `/post/${id}` — valid | **INFO** | Clean |
| 70 | `app/stamps.tsx` | Stamp collection | "more to come" text visible in category section — acceptable for beta | **P2** | Open — cosmetic |
| 71 | `app/gems/index.tsx` | Gems hub | Routes to `/gems/${id}`, `/map?entityTypes=gems`, `/gems/submit` — all valid | **INFO** | Clean |
| 72 | `app/gems/guide.tsx` | Guide profile | `cityExpertise.join` crash risk (see #14) | **P2** | Open |
| 73 | `app/meetups/index.tsx` | Meetups list | Routes to `/meetup/${id}` — valid | **INFO** | Clean |
| 74 | `app/meetup/[id].tsx` | Meetup detail | `timeStr.split(':')` crash risk (see #15) | **P2** | Open |
| 75 | `app/events/list.tsx` | Events list | Routes to `/event/${id}` — valid | **INFO** | Clean |
| 76 | `app/events/invites.tsx` | Event invites | `new Date(ev.startsAt)` null crash risk (see #12) | **P2** | Open |
| 77 | `app/profile/edit/identity.tsx` | Identity edit | Clean | **INFO** | Clean |
| 78 | `app/profile/edit/privacy.tsx` | Privacy settings | Routes to `/close-friends` — valid | **INFO** | Clean |
| 79 | `app/profile/edit/notifications.tsx` | Notification prefs | Clean | **INFO** | Clean |
| 80 | `app/profile/edit/safety.tsx` | Safety settings | Routes to `/blocked-users`, `/muted-users`, `/restricted-users`, sub-routes — all valid | **INFO** | Clean |
| 81 | `app/profile/edit/about.tsx` | Interests / style | Clean | **INFO** | Clean |
| 82 | `app/profile/edit/travel-profile.tsx` | Travel prefs | Clean | **INFO** | Clean |
| 83 | `app/profile/edit/passports.tsx` | Passport docs | Clean; empty state has copy | **INFO** | Clean |
| 84 | `app/profile/edit/connected.tsx` | Connected services | Admin links (`/admin/visuals`, etc.) — visible but admin-guarded server-side | **INFO** | Clean |
| 85 | `app/profile/edit/account.tsx` | Account settings | Routes to `/(auth)/sign-in` — valid | **INFO** | Clean |
| 86 | `app/profile/edit/location.tsx` | Location settings | Routes to `/profile/edit/who-can-see-me` — file exists | **INFO** | Clean |
| 87 | `app/profile/edit/calling.tsx` | Calling settings | Clean | **INFO** | Clean |
| 88 | `app/profile/edit/reports.tsx` | Reports history | `new Date(iso).getTime()` — "Invalid Date" risk if API returns bad ISO | **P2** | ✅ Fixed both trees — `timeAgo` now returns '—' for non-finite dates |
| 89 | `app/profile/edit/emergency-contacts.tsx` | Emergency contacts | Clean; all field types appropriate | **INFO** | Clean |
| 90 | `app/circle-presence.tsx` | Circle map | Routes to `/circle-context-settings` — valid | **INFO** | Clean |
| 91 | `app/circle-context-settings.tsx` | Circle overrides | Clean | **INFO** | Clean |
| 92 | `app/passport/[username].tsx` | Public passport | Routes to `/stamp/${id}`, `/(tabs)/` — valid | **INFO** | Clean |
| 93 | `app/route/[id].tsx` | Active route | Non-null assertion on `structuredLocation` — low risk with existing filter guard | **INFO** | Clean |
| 94 | `app/layover/[id].tsx` | Layover hub | Routes to `/(rent-a-buddy)/buddy/${id}`, `/trip/chat?id=...` — both valid | **INFO** | Clean |
| 95 | `app/trip/chat.tsx` | Trip group chat | Clean; falls back to empty tripId gracefully | **INFO** | Clean |
| 96 | `app/review/[entityType]/[entityId].tsx` | Review form | Photo upload race condition on `uploadAll` — low frequency | **P2** | Open |
| 97 | `app/invite/[token].tsx` | Trip invite | `formatDateRange` date crash (see #13); `/(auth)/sign-in` route correct | **P2** | Open |
| 98 | `app/destinations/[city].tsx` | Destination roll-up | Routes to `/post/${id}`, `/trip/${id}` — valid | **INFO** | Clean |
| 99 | `app/profile/[handle].tsx` | Handle redirect | Immediately redirects to `/u/${handle}` — correct | **INFO** | Clean |
| 100 | `app/(auth)/sign-in.tsx` | Sign-in | Clean; routes to `/(tabs)` and `/(auth)/onboarding` | **INFO** | Clean |
| 101 | `app/(auth)/onboarding.tsx` | Onboarding | Clean; routes to `/(tabs)` on complete | **INFO** | Clean |

---

## Summary

| Category | Count |
|---|---|
| Screens / routes checked | **101** |
| Total defects found | **18** |
| P0 fixed | **1** (passportStamps column) |
| P1 fixed | **6** (follow-requests spinner, passport sign-in ×2, availability null crash, close-friends UUID UX, buddy-dashboard travelerId) |
| P2 fixed | **4** (search empty-state copy, Pulse mediaUrls guard, restricted-users sub-text, reports timeAgo NaN) |
| P2 open | **7** |
| INFO / no action needed | — |

---

## Remaining Open P2 Items

| # | File | Finding | Notes |
|---|---|---|---|
| P2-A | `app/events/invites.tsx` | `new Date(ev.startsAt)` if null | Already guarded by `{ev.startsAt && (` — false alarm; no fix needed |
| P2-B | `app/invite/[token].tsx` | "Invalid Date" if server sends non-ISO string | `formatDateRange(start, end)` accepts `string \| null`; `new Date(null)` returns epoch not a crash — cosmetic only |
| P2-C | `app/gems/guide.tsx` | `cityExpertise.join` crash | Already guarded by `guide.cityExpertise?.length > 0` — false alarm |
| P2-D | `app/meetup/[id].tsx` | `timeStr.split(':')` if no colon | Already guarded by `parts[0] ?? '0'` and `parts[1] ?? '0'` — false alarm |
| P2-E | `app/stamps.tsx` | "more to come" affordance text | Intentional design for the stamp grid; acceptable for beta |
| P2-F | `app/review/[entityType]/[entityId].tsx` | `uploadAll` isMounted race | Low-frequency edge case; uploadAll is called on Submit with busy guard |
| P2-G | `app/(rent-a-buddy)/booking/[id].tsx` | "Map — coming soon" static block | Intentional placeholder; no user confusion — it is visually distinct |

---

## Notes

- All `router.push` / `router.replace` targets were verified to have a corresponding file in `app/`  
- Expo Router's filesystem routing makes every `.tsx` under `app/` reachable even without explicit `<Stack.Screen>` registration — checked individually for the 13 routes the route-validator flagged as "not explicitly registered"  
- The two pre-existing API-server WARNs (`generated_visuals.locked_until`, `generated_visuals.retry_after`) are separate migration gaps not in this audit's scope  
- Phase 2 (media upgrade) follows this audit  
