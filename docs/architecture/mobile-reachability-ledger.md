# Mobile reachability ledger

Every backend route the API server mounts, and the mobile path that reaches it:

```
backend route -> client function -> hook/service -> component -> screen
```

**Scope.** The shipped Expo client is `travel-buddy-standalone/`. The repository-root
`app/`, `src/` and `lib/` trees are a dead prototype and are deliberately NOT counted
here: root `package.json` is `travel-buddy-workspace` with zero dependencies and no
react/expo, `pnpm-workspace.yaml` lists only `artifacts/*`, `lib/*`, `packages/*` and
`scripts`, and `scripts/build-production.sh` builds `artifacts/api-server` followed by
`travel-buddy-standalone/scripts/build.js`. Root `app/live-map.tsx` is a 78-line
"coming soon" placeholder; `travel-buddy-standalone/app/map/index.tsx` is 3,464 lines.

The machine-readable companion is `mobile-reachability-ledger.json` in this directory:
same data, one row per route, including the resolved call chain for every wired route.

## Provenance

Derived from commit `22ab17151b98adcaf81b5bc976cf1502043f535f`, read via `git archive` at that commit rather than from
the working tree: several lanes edit `artifacts/api-server/**` concurrently, and the server
route count moved underneath this analysis twice mid-run. Regenerate against a named
commit, never a dirty tree.

## Counts

| Classification | Count |
| --- | ---: |
| WIRED | 849 |
| DEAD ENDPOINT | 196 |
| BACKEND WITH NO MOBILE CONSUMER | 147 |
| LEGACY ROUTE | 0 |
| **Total route shapes** | **1192** |

`DEAD ENDPOINT` and `BACKEND WITH NO MOBILE CONSUMER` are the same measurement split by
audience: both are routes with no client caller, but the second are `/api/admin/*` and
`/api/internal/*` surfaces. The mobile app does carry an admin console (24 screens under
`travel-buddy-standalone/app/admin/`), so these are not excused by category - they are
backend that the admin console never grew a screen for.

`LEGACY ROUTE` is zero: after resolving the indirections below, every URL the client
constructs is served by a route the server mounts. The four candidates a scan reports
are the URL builders' own base templates, not call sites.

## By area

| Area | Routes | Wired | Dead | Admin-only |
| --- | ---: | ---: | ---: | ---: |
| Map | 7 | 5 | 2 | 0 |
| Discovery | 12 | 11 | 1 | 0 |
| Telegraph | 19 | 15 | 4 | 0 |
| Passport | 40 | 18 | 21 | 1 |
| Trips | 98 | 74 | 24 | 0 |
| Rent-A-Buddy | 200 | 144 | 26 | 30 |
| Events | 72 | 44 | 28 | 0 |
| Safety | 42 | 30 | 5 | 7 |

Areas overlap (an `/api/events/:id/safety-summary` counts under both Events and Safety),
so the columns do not sum to the totals above.

## How this was derived, and the four indirections a text scan gets wrong

A naive `grep` for `/api/` is wrong in both directions. Each of these was resolved by
reading the call site, not by matching a name.

### 1. Multi-line route declarations (server side, cost: 45 routes)

Route paths are not always on the same line as `router.get(`:

```ts
router.post(                                   // artifacts/api-server/src/routes/wall.ts:1180
  "/wall/action",
```

A same-line pattern misses every such declaration and reports whole routers - `wall.ts`,
`visuals.ts`, `locateFriends.ts`, `mapProjection.ts`, `mediaActions.ts` - as absent,
which then makes their live client callers look like LEGACY ROUTE. Counting the path on
the following lines takes the routers from 1,145 to 1,190 route shapes (+45), and the two
webhook routes declared directly in `app.ts` (`app.ts:123`, `app.ts:127`) bring the total
to 1,192. It also drops the legacy list from 39 to 4.

### 2. `specAliasRewrite` (11 URL families)

`artifacts/api-server/src/lib/specAliasRewrite.ts`, mounted at `app.ts:159` BEFORE the
`/api` router, rewrites the URL the client sends before routing sees it - e.g.
`/api/buddy-bookings/*` -> `/api/rent-a-buddy/bookings/*`. Rent-A-Buddy routes therefore
look uncalled while being called constantly. The rewrite is an if/else-if chain, so the
first matching family wins; the ledger applies it in source order.

### 3. URL builders the scan cannot see (51 URLs)

| Builder | File | Resolves |
| --- | --- | --- |
| `airportUrl(...parts)` | `src/services/layover.ts:27` | all 17 `/api/airport/sessions/*` routes |
| `planUrl(tripId, ...parts)` | `src/services/tripPlan.ts:23` | 7 `/api/trips/:id/plan*` routes |
| `trustUrl(...parts)` | `src/services/trustAdmin.ts:28` | 11 `/api/admin/trust/*` routes |
| `api(path)` | `src/services/appeals.ts:42` | `/api/appeals*` |
| `api(path)` | `src/services/reviews.ts:67` | `/api/reviews*`, `/api/places/:id/reviews`, ... |
| `${t.baseUrl}/api/locate-friends${opts.path}` | `src/services/locateFriends.ts:202` | 4 `/api/locate-friends/*` routes |
| `INTEL_BASE` constant | `src/services/intelCapture.ts:39`, `intelConsent.ts:14` | 7 `/api/v1/intel/*` routes |

The `reviews.ts` and `INTEL_BASE` families are not in the brief's list - they were found
by searching for the shape (a function or constant whose body holds an `/api/` template)
rather than by name.

Two further subtleties: the builders' own **definition** lines must be excluded from the
literal scan, because a base template like `` `${apiBase}/api/${path}` `` normalises to
`/api/<any>` and matches every single-segment route on the server - left in, it invents
callers for hundreds of routes. And `intelCapture.ts` calls `.../claims:propose`, which is
served by `router.post("/v1/intel/observations/:id/claims:action")`
(`artifacts/api-server/src/routes/intel.ts:302`) - an Express parameter sitting
*mid-segment*, which a "segment starts with `:`" rule does not match.

### 4. A doc comment naming a route is not a caller (76 mentions)

76 `/api/...` mentions in the client sit in comments. Excluding them cuts the legacy list
from 114 to 39. The canonical case, verified at the call site:

- `app/map/index.tsx:1046` and `app/map/__tests__/projectedPlaces.component.test.tsx:7`
  both name `GET /api/discovery/places`. **No such route exists on the server.**
- The real call is `getDiscoveryPlaces()` at `src/services/discovery.ts:474`, which fetches
  `` `${base}/api/discovery?${params}` `` at **`src/services/discovery.ts:521`**.

Stale comment, working code. Counting the comment would have produced a phantom
LEGACY ROUTE and hidden the real `/api/discovery` wiring.

Seven comment-only mentions name no route that exists:

| Mentioned | Where |
| --- | --- |
| `/api/v1/media/contributors/:id` | `src/features/media/components/ContributorTrustChips.tsx:7` |
| `/api/circle` | `src/services/circle.ts:4` |
| `/api/rent-a-buddy/admin` | `src/services/rentABuddyAdmin.ts:5` |
| `/api/threads/:threadId/telegraph` | `src/services/telegraphChat.ts:3` |
| `/api/admin/trust` | `src/services/trustAdmin.ts:4` |
| `/api/visuals` | `src/services/visuals.ts:2` |
| `/api/discovery/places` | `app/map/index.tsx:1046` |

## Findings

### MOCK-DATA SEED - fixed

`src/context/AvailabilityStore.tsx` seeded `useState` from `mockAvailability`
(`src/__fixtures__/events.ts`, re-exported through `src/data/events.ts`, whose header
reads "not live user data. Do not use as primary data source in authenticated flows").
`AvailabilityProvider` is mounted app-wide at `app/_layout.tsx:249`, so that seed was the
live value for:

- **signed-out viewers**, permanently - the mount fetch is gated on `isAuthed`
  (`AvailabilityStore.tsx:52`), so it never runs for them at all; and
- **signed-in viewers**, for the whole window before the fetch resolved.

Both saw a fabricated week (Fri/Sat/Sun evening+late) and `openToMeet: true`, which
`app/availability.tsx:90` renders as "Open to meet - shown on your Passport." It was also
writable: `save()` PATCHes whatever is in state, so a toggle landing before the fetch
persisted the fixture's blocks onto the user's real account, and the rollback ref
(`confirmedOpenToMeet`) carried the same seed, so a failed save rolled back to a
fabricated `true`.

All three seed sites now use `EMPTY`, which was already defined in the file.
Guard: `src/context/__tests__/availabilityStore.noMockSeed.component.test.tsx`.

### MOCK-DATA SEED - reported, deliberately not changed

| Site | Gate | Why it stays |
| --- | --- | --- |
| `src/hooks/useCityPulse.ts:83,99,113` | `__DEV__` | Stripped from production bundles; documented at `useCityPulse.ts:4`. |
| `src/hooks/usePassport.ts:197` | `!isSupabaseConfigured` | Only reachable with no backend configured, where there is no real user to misrepresent. |

### NEVER-MOUNTED COMPONENT with a live backend

`src/components/safeReturn/LiveShareRecipientView.tsx` is complete and calls
`GET /api/safe-return/live-share/:shareId` at line 50. That route is served
(`artifacts/api-server/src/routes/safeReturn.ts:879`). The component is imported by
nothing - production or test.

The **sender** half of the feature is fully wired:
`startLiveShare`/`stopLiveShare` (`src/services/safeReturn.ts:143,162`) are driven from
`app/(rent-a-buddy)/active.tsx:187`. Only the **recipient** half is unreachable, because a
trusted contact would arrive by deep link and no such screen or route exists under `app/`.

Not wired here: mounting it means inventing a screen and a deep-link route, which is a new
product surface rather than an engineering gap.

### UI ACTION WITH NO BACKEND

`app/(auth)/sign-in.tsx:184` - the "Remember me" checkbox renders and toggles
(`sign-in.tsx:622-625`) but `rememberMe` is never read: no persistence, no effect on the
session. The file says so itself at line 183. Left alone deliberately - session lifetime is
auth behaviour, and there is no route to wire it to.

### The two map leads

`GET /api/map/search` (`artifacts/api-server/src/routes/mapSearch.ts:132`) and
`POST /api/map/compass-command` (`mapSearch.ts:230`) genuinely have no client caller.

**`/api/map/search` was NOT wired, on purpose.** `MapSearchSheet` is not unmounted - it is
mounted at `app/map/index.tsx:3181` - and it already searches, via `searchUnified()`
(`src/services/discovery.ts:793`) against `GET /api/discovery/search`
(`discovery.ts:825`). Re-pointing it would be a regression on two counts:

1. The sheet's own spec (`MapSearchSheet.tsx:3-6`) lists nine searchable types.
   `/api/map/search` normalises three - traveler, gem, event (`mapSearch.ts:172-189`).
2. It is gated on the `map_search_enabled` flag and returns `{enabled: false, results: []}`
   when off (`mapSearch.ts:143`). Wiring it would mean flipping a feature flag.

The honest classification is BACKEND WITH NO MOBILE CONSUMER: a newer, narrower search
backend that the client has not migrated to, not a gap to close by swapping the call.

### Client wrappers that reach a live route but nothing calls

192 exported client functions build a URL that a mounted server route serves, and
are imported by no production file. The route works and the wrapper works; nothing calls it.
The full list is in the JSON under `orphanClientFunctions`. The concentrations:

| Service | Orphaned wrappers |
| --- | ---: |
| `src/services/rentABuddy.ts` | 61 |
| `src/services/rentABuddyAdmin.ts` | 10 |
| `src/services/events.ts` | 9 |
| `src/services/sharedMoments.ts` | 7 |
| `src/services/friends.ts` | 6 |
| `src/services/memories.ts` | 6 |
| `src/services/messaging.ts` | 6 |
| `src/services/stories.ts` | 5 |
| `src/services/layover.ts` | 5 |
| `src/services/hiddenGems.ts` | 3 |
| `src/services/meetups.ts` | 3 |
| `src/services/trips.ts` | 3 |

Counting these needs care in one specific way. `import * as rentABuddy from ...` followed
by `rentABuddy.acceptBooking(id)` (`app/(rent-a-buddy)/buddy-dashboard/requests.tsx:400`)
is a real consumer, and a named-import-only test reports all 86 of that module's wrappers
as orphans. Resolving namespace imports drops the count from 217 to 192.

Spot-checked at the call site, these are genuine but mostly are NOT gaps to wire:

- `getMyQuickStatus()` (`src/services/availability.ts:118`) is redundant, not missing:
  `getMyAvailability()` already returns `quickStatus`, which `AvailabilityStore.tsx:62`
  consumes. Calling it would add a duplicate round-trip.
- `getAvailabilityNudges()` (`availability.ts:172`) has no orphan reader because there is
  no nudges surface - showing them means designing a screen, not wiring a call.
- `leaveLocateFriendsSession()` / `publishLocateFriendsPosition()`
  (`src/services/locateFriends.ts:881,618`) are referenced only by
  `src/features/map/presence/__tests__/locateFriendsService.test.ts`: tested, never shipped.

### Guard reachability: `useMapEntities.gatewayAsymmetry.test.ts`

Reported as failing to load in isolation with `ERR_REQUIRE_CYCLE_MODULE` while absent
from the runner's `KNOWN_BROKEN` list - which would make it a guard that cannot load.
It is not. The file is discovered by `scripts/run-node-tests.mjs`, is not excluded, and
executes 12 assertions across 4 suites, all passing.

The `ERR_REQUIRE_CYCLE_MODULE` is real but belongs to the **runner**, not the file. The
runner spawns `node --import tsx/esm --test` (`scripts/run-node-tests.mjs:170`), and under
Node 22 every one of the 260 discovered files fails to load that way - 257 fail, 3 pass.
Swapping only the loader to `--import tsx` runs the same 260 files to 6,028 passing tests,
exit 0. CI pins Node 24 (`.github/workflows/ci.yml:61`), where `require(esm)` cycle rules
differ, so this is a local-Node artifact rather than a broken suite - but it does mean
`pnpm test` proves nothing on Node 22, and a real failure there is indistinguishable from
the loader error.

## Route-by-route

Full per-route detail, including the resolved chain for each wired route, is in
`mobile-reachability-ledger.json`. The routes with no client caller are listed here.

### DEAD ENDPOINT

| Method(s) | Route | Handler |
| --- | --- | --- |
| GET | `/api/airport/pulse` | `artifacts/api-server/src/routes/airport.ts:1643` |
| POST | `/api/airport/sessions/:id/plan` | `artifacts/api-server/src/routes/airport.ts:808` |
| GET | `/api/appeals/restorations/pending` | `artifacts/api-server/src/routes/appeals.ts:157` |
| POST | `/api/auth/signup` | `artifacts/api-server/src/routes/auth.ts:170` |
| GET | `/api/buddies` | `artifacts/api-server/src/routes/rentABuddy.ts:1059` |
| POST | `/api/circle/contexts/:type/:id/need-help` | `artifacts/api-server/src/routes/circle.ts:1519` |
| POST | `/api/circle/contexts/:type/:id/presence` | `artifacts/api-server/src/routes/circle.ts:949` |
| POST | `/api/circle/internal/cleanup-presence` | `artifacts/api-server/src/routes/circle.ts:2000` |
| DELETE | `/api/circles/:circleOwnerId/members/:memberId` | `artifacts/api-server/src/routes/friends.ts:805` |
| GET | `/api/compass/debug/recommendations` | `artifacts/api-server/src/routes/compass.ts:4029` |
| POST | `/api/compass/graph/cleanup` | `artifacts/api-server/src/routes/compassGraph.ts:50` |
| POST | `/api/compass/graph/rebuild` | `artifacts/api-server/src/routes/compassGraph.ts:32` |
| GET | `/api/compass/graph/status` | `artifacts/api-server/src/routes/compassGraph.ts:65` |
| GET | `/api/compass/me/context` | `artifacts/api-server/src/routes/compass.ts:337` |
| GET | `/api/compass/me/on-this-day` | `artifacts/api-server/src/routes/compass.ts:2612` |
| GET | `/api/compass/me/passport/remembers` | `artifacts/api-server/src/routes/compass.ts:2411` |
| POST | `/api/compass/me/passport/remembers/correct` | `artifacts/api-server/src/routes/compass.ts:2523` |
| POST | `/api/compass/me/passport/remembers/forget` | `artifacts/api-server/src/routes/compass.ts:2464` |
| GET | `/api/compass/me/recaps` | `artifacts/api-server/src/routes/compass.ts:2585` |
| GET | `/api/compass/people/:userId/passport` | `artifacts/api-server/src/routes/compass.ts:4291` |
| GET | `/api/compass/preload-manifest` | `artifacts/api-server/src/routes/compass.ts:786` |
| POST | `/api/compass/report` | `artifacts/api-server/src/routes/compass.ts:3125` |
| POST | `/api/compass/sense/check` | `artifacts/api-server/src/routes/compassSense.ts:101` |
| GET | `/api/compass/sense/nudges` | `artifacts/api-server/src/routes/compassSense.ts:122` |
| GET | `/api/compass/value-delivered` | `artifacts/api-server/src/routes/compassOutcomes.ts:67` |
| GET | `/api/discovery/people/:userId/passport` | `artifacts/api-server/src/routes/discoverySearch.ts:2247` |
| GET | `/api/events/:id/activity` | `artifacts/api-server/src/routes/events.ts:5956` |
| GET | `/api/events/:id/attendees` | `artifacts/api-server/src/routes/events.ts:3710` |
| DELETE | `/api/events/:id/attendees/:userId` | `artifacts/api-server/src/routes/events.ts:4930` |
| PATCH | `/api/events/:id/attendees/:userId/status` | `artifacts/api-server/src/routes/events.ts:4896` |
| POST | `/api/events/:id/block-user/:userId` | `artifacts/api-server/src/routes/events.ts:5919` |
| POST | `/api/events/:id/cancel` | `artifacts/api-server/src/routes/events.ts:4574` |
| POST | `/api/events/:id/chat` | `artifacts/api-server/src/routes/events.ts:3824` |
| GET, POST | `/api/events/:id/cohosts` | `artifacts/api-server/src/routes/events.ts:5296` |
| DELETE | `/api/events/:id/cohosts/:userId` | `artifacts/api-server/src/routes/events.ts:5371` |
| PATCH | `/api/events/:id/cohosts/:userId/permissions` | `artifacts/api-server/src/routes/events.ts:5395` |
| GET, POST | `/api/events/:id/comments` | `artifacts/api-server/src/routes/events.ts:5738` |
| POST | `/api/events/:id/complete` | `artifacts/api-server/src/routes/events.ts:4678` |
| POST | `/api/events/:id/join` | `artifacts/api-server/src/routes/events.ts:2837` |
| POST | `/api/events/:id/join-request` | `artifacts/api-server/src/routes/events.ts:4970` |
| POST | `/api/events/:id/join-requests/:requestId/approve` | `artifacts/api-server/src/routes/events.ts:5015` |
| POST | `/api/events/:id/join-requests/:requestId/cancel` | `artifacts/api-server/src/routes/events.ts:5117` |
| POST | `/api/events/:id/join-requests/:requestId/decline` | `artifacts/api-server/src/routes/events.ts:5090` |
| POST | `/api/events/:id/leave` | `artifacts/api-server/src/routes/events.ts:2925` |
| POST | `/api/events/:id/link-circle` | `artifacts/api-server/src/routes/events.ts:6313` |
| GET, POST | `/api/events/:id/media` | `artifacts/api-server/src/routes/events.ts:5639` |
| GET, POST | `/api/events/:id/posts` | `artifacts/api-server/src/routes/events.ts:5530` |
| POST | `/api/events/:id/publish` | `artifacts/api-server/src/routes/events.ts:4445` |
| POST | `/api/events/:id/report-user/:userId` | `artifacts/api-server/src/routes/events.ts:5876` |
| GET | `/api/events/:id/safety-summary` | `artifacts/api-server/src/routes/events.ts:5987` |
| DELETE | `/api/events/:id/share-link/:linkId` | `artifacts/api-server/src/routes/events.ts:5509` |
| POST | `/api/events/:id/telegraph-thread` | `artifacts/api-server/src/routes/events.ts:6359` |
| GET | `/api/events/city/:city` | `artifacts/api-server/src/routes/events.ts:1177` |
| GET | `/api/events/share-link/:token/preview` | `artifacts/api-server/src/routes/events.ts:2048` |
| GET | `/api/healthz` | `artifacts/api-server/src/routes/health.ts:13` |
| GET | `/api/healthz/cleanup` | `artifacts/api-server/src/routes/health.ts:18` |
| GET | `/api/healthz/delayed-publish` | `artifacts/api-server/src/routes/health.ts:50` |
| POST | `/api/input-assistance/select` | `artifacts/api-server/src/routes/inputAssistance.ts:216` |
| POST | `/api/input-assistance/suggest` | `artifacts/api-server/src/routes/inputAssistance.ts:97` |
| POST | `/api/location/reverse-geocode` | `artifacts/api-server/src/routes/location.ts:187` |
| POST | `/api/map/compass-command` | `artifacts/api-server/src/routes/mapSearch.ts:230` |
| GET | `/api/map/search` | `artifacts/api-server/src/routes/mapSearch.ts:132` |
| PATCH | `/api/me/buddy-availability` | `artifacts/api-server/src/routes/rentABuddySpec.ts:2082` |
| GET, PATCH, POST | `/api/me/buddy-availability-exceptions` | `artifacts/api-server/src/routes/rentABuddySpec.ts:253` |
| DELETE, PATCH | `/api/me/buddy-availability-exceptions/:exceptionId` | `artifacts/api-server/src/routes/rentABuddySpec.ts:318` |
| GET | `/api/me/buddy-bookings` | `artifacts/api-server/src/routes/rentABuddySpec.ts:962` |
| GET | `/api/me/buddy-requests` | `artifacts/api-server/src/routes/rentABuddySpec.ts:2043` |
| GET, POST | `/api/me/buddy-services` | `artifacts/api-server/src/routes/rentABuddySpec.ts:79` |
| DELETE, PATCH | `/api/me/buddy-services/:serviceId` | `artifacts/api-server/src/routes/rentABuddySpec.ts:145` |
| GET, POST | `/api/me/crypto-devices` | `artifacts/api-server/src/routes/devices.ts:29` |
| DELETE | `/api/me/crypto-devices/:id` | `artifacts/api-server/src/routes/devices.ts:128` |
| GET | `/api/me/devices/:deviceId/key-packages/inventory` | `artifacts/api-server/src/routes/keyPackages.ts:91` |
| GET | `/api/me/hashtag-follows` | `artifacts/api-server/src/routes/hashtags.ts:715` |
| GET, POST | `/api/me/passport-stamps/gps` | `artifacts/api-server/src/routes/location.ts:210` |
| GET | `/api/me/passport/map` | `artifacts/api-server/src/routes/passportStamps.ts:471` |
| GET, POST | `/api/me/passport/memories` | `artifacts/api-server/src/routes/passportStamps.ts:238` |
| PATCH | `/api/me/passport/memories/:id` | `artifacts/api-server/src/routes/passportStamps.ts:327` |
| GET | `/api/me/passport/stamps` | `artifacts/api-server/src/routes/passportStamps.ts:130` |
| PATCH | `/api/me/passport/stamps/:id` | `artifacts/api-server/src/routes/passportStamps.ts:207` |
| GET | `/api/me/passport/stats` | `artifacts/api-server/src/routes/passportStamps.ts:505` |
| GET | `/api/me/passport/suggestions` | `artifacts/api-server/src/routes/passportStamps.ts:372` |
| POST | `/api/me/passport/suggestions/:id/accept` | `artifacts/api-server/src/routes/passportStamps.ts:412` |
| POST | `/api/me/passport/suggestions/:id/dismiss` | `artifacts/api-server/src/routes/passportStamps.ts:445` |
| GET | `/api/me/phone/status` | `artifacts/api-server/src/routes/phoneVerification.ts:142` |
| POST | `/api/me/phone/verify/confirm` | `artifacts/api-server/src/routes/phoneVerification.ts:86` |
| POST | `/api/me/phone/verify/start` | `artifacts/api-server/src/routes/phoneVerification.ts:33` |
| POST | `/api/me/preferences/events` | `artifacts/api-server/src/routes/preferences.ts:136` |
| POST | `/api/me/preferences/mute-category` | `artifacts/api-server/src/routes/preferences.ts:228` |
| GET | `/api/me/preferences/summary` | `artifacts/api-server/src/routes/preferences.ts:199` |
| PUT | `/api/me/push-token` | `artifacts/api-server/src/routes/profile.ts:1197` |
| GET | `/api/me/reports` | `artifacts/api-server/src/routes/reports.ts:239` |
| GET | `/api/me/safe-return/contacts/:userId/passport` | `artifacts/api-server/src/routes/safeReturn.ts:1124` |
| POST | `/api/me/safe-return/sessions/:id/trigger-missed` | `artifacts/api-server/src/routes/safeReturn.ts:638` |
| GET | `/api/me/saved-messages` | `artifacts/api-server/src/routes/messaging.ts:2786` |
| GET | `/api/me/saves` | `artifacts/api-server/src/routes/saves.ts:124` |
| GET | `/api/me/stamps` | `artifacts/api-server/src/routes/passport.ts:1393` |
| GET | `/api/media/:id/comments` | `artifacts/api-server/src/routes/mediaFeed.ts:2305` |
| POST | `/api/media/:id/view` | `artifacts/api-server/src/routes/mediaFeed.ts:1849` |
| GET | `/api/media/file/:bucket/*path` | `artifacts/api-server/src/routes/mediaFile.ts:139` |
| DELETE, POST | `/api/memories/:id/save` | `artifacts/api-server/src/routes/memories.ts:1185` |
| POST | `/api/memories/:id/share` | `artifacts/api-server/src/routes/memories.ts:1244` |
| GET | `/api/memories/:id/tags` | `artifacts/api-server/src/routes/memories.ts:1025` |
| PATCH | `/api/memories/:id/tags/:userId` | `artifacts/api-server/src/routes/memories.ts:1071` |
| GET | `/api/og/:type/:id` | `artifacts/api-server/src/routes/og.ts:373` |
| GET | `/api/og/:type/:id/image.png` | `artifacts/api-server/src/routes/og.ts:462` |
| GET | `/api/passport/:userId/journeys` | `artifacts/api-server/src/routes/passport.ts:1554` |
| GET | `/api/passport/:userId/yearbook` | `artifacts/api-server/src/routes/passport.ts:1638` |
| POST | `/api/place-recaps` | `artifacts/api-server/src/routes/placeRecaps.ts:73` |
| GET | `/api/place-recaps/:id` | `artifacts/api-server/src/routes/placeRecaps.ts:155` |
| POST | `/api/place-recaps/:id/archive` | `artifacts/api-server/src/routes/placeRecaps.ts:144` |
| POST | `/api/place-recaps/:id/publish` | `artifacts/api-server/src/routes/placeRecaps.ts:112` |
| POST | `/api/place-recaps/:id/regenerate` | `artifacts/api-server/src/routes/placeRecaps.ts:119` |
| POST | `/api/place-recaps/:id/remove` | `artifacts/api-server/src/routes/placeRecaps.ts:146` |
| POST | `/api/place-recaps/:id/restore` | `artifacts/api-server/src/routes/placeRecaps.ts:145` |
| POST | `/api/place-recaps/:id/review` | `artifacts/api-server/src/routes/placeRecaps.ts:105` |
| GET | `/api/places/:id/dedup-groups` | `artifacts/api-server/src/routes/places.ts:1576` |
| GET | `/api/places/:id/thin-buckets` | `artifacts/api-server/src/routes/placesCanonical.ts:160` |
| GET | `/api/places/:placeId/recaps` | `artifacts/api-server/src/routes/placeRecaps.ts:148` |
| GET | `/api/places/photo/media` | `artifacts/api-server/src/routes/places.ts:739` |
| PUT | `/api/postcards/:id/event-link` | `artifacts/api-server/src/routes/postcards.ts:1225` |
| POST | `/api/postcards/sweep-orphans` | `artifacts/api-server/src/routes/postcards.ts:1337` |
| POST | `/api/posts/:postId/location-event` | `artifacts/api-server/src/routes/posts.ts:2191` |
| POST | `/api/rent-a-buddy/bookings/:bookingId/change-request` | `artifacts/api-server/src/routes/rentABuddy.ts:7338` |
| POST | `/api/rent-a-buddy/bookings/:bookingId/pay-deposit` | `artifacts/api-server/src/routes/rentABuddy.ts:2151` |
| POST | `/api/rent-a-buddy/bookings/:bookingId/pay-full` | `artifacts/api-server/src/routes/rentABuddy.ts:2161` |
| GET | `/api/rent-a-buddy/bookings/:bookingId/refund-eligibility` | `artifacts/api-server/src/routes/rentABuddy.ts:3793` |
| POST | `/api/rent-a-buddy/bookings/:bookingId/report-no-show` | `artifacts/api-server/src/routes/rentABuddySpec.ts:802` |
| POST | `/api/rent-a-buddy/bookings/:bookingId/reschedule` | `artifacts/api-server/src/routes/rentABuddy.ts:3652` |
| POST | `/api/rent-a-buddy/bookings/:bookingId/respond-change-request` | `artifacts/api-server/src/routes/rentABuddy.ts:7458` |
| POST | `/api/rent-a-buddy/bookings/:bookingId/route-change/:changeId/approve` | `artifacts/api-server/src/routes/rentABuddy.ts:3307` |
| POST | `/api/rent-a-buddy/bookings/:bookingId/route-change/:changeId/decline` | `artifacts/api-server/src/routes/rentABuddy.ts:3355` |
| GET | `/api/rent-a-buddy/bookings/:bookingId/safety-checkins` | `artifacts/api-server/src/routes/rentABuddySpec.ts:728` |
| GET | `/api/rent-a-buddy/bookings/:bookingId/safety-events` | `artifacts/api-server/src/routes/rentABuddySpec.ts:765` |
| POST | `/api/rent-a-buddy/buddies/:buddyId/favorite` | `artifacts/api-server/src/routes/rentABuddySpec.ts:1194` |
| POST | `/api/rent-a-buddy/buddies/:buddyId/request` | `artifacts/api-server/src/routes/rentABuddySpec.ts:397` |
| GET | `/api/rent-a-buddy/buddies/:buddyId/services` | `artifacts/api-server/src/routes/rentABuddySpec.ts:38` |
| DELETE, POST | `/api/rent-a-buddy/buddies/:buddyId/unfavorite` | `artifacts/api-server/src/routes/rentABuddySpec.ts:1212` |
| PATCH | `/api/rent-a-buddy/me/availability` | `artifacts/api-server/src/routes/rentABuddy.ts:4376` |
| POST | `/api/rent-a-buddy/me/profile/pause` | `artifacts/api-server/src/routes/rentABuddySpec.ts:1558` |
| POST | `/api/rent-a-buddy/me/profile/resume` | `artifacts/api-server/src/routes/rentABuddySpec.ts:1590` |
| POST | `/api/rent-buddy/waitlist` | `artifacts/api-server/src/routes/rentABuddyRollout.ts:1433` |
| GET | `/api/reports/:id` | `artifacts/api-server/src/routes/reports.ts:211` |
| GET | `/api/shared-moments/suggestions/mine` | `artifacts/api-server/src/routes/sharedMoments.ts:91` |
| POST | `/api/tags` | `artifacts/api-server/src/routes/tags.ts:46` |
| GET | `/api/telegraph/commands/:commandId` | `artifacts/api-server/src/routes/telegraphCommands.ts:371` |
| GET | `/api/telegraph/threads/:threadId/header/:userId` | `artifacts/api-server/src/routes/telegraph.ts:354` |
| PATCH | `/api/threads/:threadId/messages/:messageId` | `artifacts/api-server/src/routes/messaging.ts:2442` |
| GET | `/api/trips/:tripId/activity` | `artifacts/api-server/src/routes/trips-expansion.ts:2766` |
| POST | `/api/trips/:tripId/archive` | `artifacts/api-server/src/routes/trips-expansion.ts:614` |
| POST | `/api/trips/:tripId/cancel` | `artifacts/api-server/src/routes/trips-expansion.ts:491` |
| GET, POST | `/api/trips/:tripId/checklists` | `artifacts/api-server/src/routes/trips-expansion.ts:2426` |
| DELETE, PATCH | `/api/trips/:tripId/checklists/:checklistId` | `artifacts/api-server/src/routes/trips-expansion.ts:2504` |
| POST | `/api/trips/:tripId/checklists/:checklistId/items` | `artifacts/api-server/src/routes/trips-expansion.ts:2561` |
| DELETE, PATCH | `/api/trips/:tripId/checklists/:checklistId/items/:itemId` | `artifacts/api-server/src/routes/trips-expansion.ts:2600` |
| POST | `/api/trips/:tripId/complete` | `artifacts/api-server/src/routes/trips-expansion.ts:565` |
| GET, POST | `/api/trips/:tripId/documents` | `artifacts/api-server/src/routes/trips-expansion.ts:2016` |
| DELETE, PATCH | `/api/trips/:tripId/documents/:docId` | `artifacts/api-server/src/routes/trips-expansion.ts:2088` |
| POST | `/api/trips/:tripId/items/reorder` | `artifacts/api-server/src/routes/trips-expansion.ts:1807` |
| POST | `/api/trips/:tripId/join-requests/:requestId/approve` | `artifacts/api-server/src/routes/trips-expansion.ts:843` |
| POST | `/api/trips/:tripId/join-requests/:requestId/cancel` | `artifacts/api-server/src/routes/trips-expansion.ts:1043` |
| POST | `/api/trips/:tripId/join-requests/:requestId/decline` | `artifacts/api-server/src/routes/trips-expansion.ts:964` |
| GET | `/api/trips/:tripId/members/:userId/passport` | `artifacts/api-server/src/routes/trips.ts:522` |
| GET | `/api/trips/:tripId/nearby-places` | `artifacts/api-server/src/routes/trips-expansion.ts:1611` |
| GET, POST | `/api/trips/:tripId/notes` | `artifacts/api-server/src/routes/trips-expansion.ts:2166` |
| DELETE, PATCH | `/api/trips/:tripId/notes/:noteId` | `artifacts/api-server/src/routes/trips-expansion.ts:2234` |
| GET, POST | `/api/trips/:tripId/reminders` | `artifacts/api-server/src/routes/trips-expansion.ts:2678` |
| DELETE | `/api/trips/:tripId/reminders/:reminderId` | `artifacts/api-server/src/routes/trips-expansion.ts:2737` |
| GET, POST | `/api/trips/:tripId/saved-places` | `artifacts/api-server/src/routes/trips-expansion.ts:2309` |
| DELETE | `/api/trips/:tripId/saved-places/:placeEntryId` | `artifacts/api-server/src/routes/trips-expansion.ts:2397` |
| PATCH | `/api/trips/:tripId/settings` | `artifacts/api-server/src/routes/trips-expansion.ts:371` |
| GET | `/api/trips/:tripId/telegraph/commands/history` | `artifacts/api-server/src/routes/telegraphCommands.ts:463` |
| GET | `/api/users/:userId/devices` | `artifacts/api-server/src/routes/devices.ts:216` |
| GET | `/api/users/:userId/restrict-status` | `artifacts/api-server/src/routes/restrict.ts:170` |
| GET | `/api/users/:username/circles` | `artifacts/api-server/src/routes/profileTabs.ts:461` |
| GET | `/api/users/:username/og-image.png` | `artifacts/api-server/src/routes/passport.ts:1272` |
| GET | `/api/users/:username/passport/memories` | `artifacts/api-server/src/routes/passportStamps.ts:659` |
| GET | `/api/users/:username/passport/stamps` | `artifacts/api-server/src/routes/passportStamps.ts:733` |
| GET | `/api/users/:username/posts` | `artifacts/api-server/src/routes/profileTabs.ts:130` |
| GET | `/api/users/:username/stamps` | `artifacts/api-server/src/routes/profileTabs.ts:197` |
| GET | `/api/users/:username/stamps/:stampId/preview` | `artifacts/api-server/src/routes/passport.ts:1225` |
| GET | `/api/users/:username/trips` | `artifacts/api-server/src/routes/profileTabs.ts:261` |
| GET | `/api/v1/experiences/:id/live-state` | `artifacts/api-server/src/routes/intelReadModels.ts:140` |
| GET | `/api/v1/experiences/:id/typical-patterns` | `artifacts/api-server/src/routes/intelReadModels.ts:198` |
| POST | `/api/v1/intel/observations/:id/claims/approve` | `artifacts/api-server/src/routes/intel.ts:300` |
| POST | `/api/v1/intel/observations/:id/claims/propose` | `artifacts/api-server/src/routes/intel.ts:299` |
| POST | `/api/v1/intel/outcomes` | `artifacts/api-server/src/routes/intelOutcomes.ts:80` |
| GET, POST | `/api/v1/internal/intel/coverage` | `artifacts/api-server/src/routes/intelCoverage.ts:60` |
| GET, POST | `/api/v1/internal/intel/missions` | `artifacts/api-server/src/routes/intelCoverage.ts:100` |
| POST | `/api/v1/internal/intel/missions/:id/accept` | `artifacts/api-server/src/routes/intelCoverage.ts:136` |
| POST | `/api/v1/internal/intel/missions/:id/complete` | `artifacts/api-server/src/routes/intelCoverage.ts:157` |
| POST | `/api/v1/internal/intel/missions/:id/decline` | `artifacts/api-server/src/routes/intelCoverage.ts:175` |
| POST | `/api/v1/internal/intel/missions/:id/dispatch` | `artifacts/api-server/src/routes/intelCoverage.ts:122` |
| GET | `/api/v1/internal/intel/redistributable/:subjectId` | `artifacts/api-server/src/routes/intelApi.ts:27` |
| GET | `/api/v1/internal/intel/trail/movement` | `artifacts/api-server/src/routes/intel.ts:358` |
| GET | `/api/v1/neighborhoods/:id/pulse` | `artifacts/api-server/src/routes/intelReadModels.ts:274` |
| GET | `/api/v1/trails/:id/live-intel` | `artifacts/api-server/src/routes/trails.ts:37` |

### BACKEND WITH NO MOBILE CONSUMER

| Method(s) | Route | Handler |
| --- | --- | --- |
| GET, POST | `/api/admin/airport/caution-zones` | `artifacts/api-server/src/routes/airport.ts:1888` |
| DELETE | `/api/admin/airport/caution-zones/:id` | `artifacts/api-server/src/routes/airport.ts:1955` |
| GET, POST | `/api/admin/airport/profiles` | `artifacts/api-server/src/routes/airport.ts:1755` |
| DELETE, PATCH | `/api/admin/airport/profiles/:id` | `artifacts/api-server/src/routes/airport.ts:1800` |
| GET | `/api/admin/airport/reports` | `artifacts/api-server/src/routes/airport.ts:2040` |
| POST | `/api/admin/airport/reports/:id/resolve` | `artifacts/api-server/src/routes/airport.ts:2065` |
| GET | `/api/admin/airport/sessions` | `artifacts/api-server/src/routes/airport.ts:1863` |
| GET | `/api/admin/airport/verified-places` | `artifacts/api-server/src/routes/airport.ts:1973` |
| PATCH | `/api/admin/airport/verified-places/:id` | `artifacts/api-server/src/routes/airport.ts:2005` |
| POST | `/api/admin/circle/disable-context` | `artifacts/api-server/src/routes/circle.ts:1913` |
| POST | `/api/admin/circle/kill-switch` | `artifacts/api-server/src/routes/circle.ts:1963` |
| GET | `/api/admin/circle/reports` | `artifacts/api-server/src/routes/circle.ts:1887` |
| POST | `/api/admin/cleanup/weather-cache` | `artifacts/api-server/src/routes/health.ts:75` |
| GET | `/api/admin/compass/abuse-flags` | `artifacts/api-server/src/routes/adminCompass.ts:918` |
| GET | `/api/admin/compass/active-rewards` | `artifacts/api-server/src/routes/adminCompass.ts:983` |
| GET | `/api/admin/compass/dashboard` | `artifacts/api-server/src/routes/adminCompass.ts:107` |
| PATCH | `/api/admin/compass/frontload-rules` | `artifacts/api-server/src/routes/adminCompass.ts:824` |
| POST | `/api/admin/compass/rebuild-cache` | `artifacts/api-server/src/routes/adminCompass.ts:796` |
| POST | `/api/admin/compass/rollback` | `artifacts/api-server/src/routes/adminCompass.ts:676` |
| GET | `/api/admin/compass/safety-filters` | `artifacts/api-server/src/routes/adminCompass.ts:948` |
| GET | `/api/admin/compass/testing-sandbox` | `artifacts/api-server/src/routes/adminCompass.ts:1007` |
| POST | `/api/admin/compass/testing-sandbox/preview` | `artifacts/api-server/src/routes/adminCompass.ts:1038` |
| POST | `/api/admin/compass/users/:userId/remove-boost-eligibility` | `artifacts/api-server/src/routes/adminCompass.ts:864` |
| POST | `/api/admin/compass/users/:userId/restore-boost-eligibility` | `artifacts/api-server/src/routes/adminCompass.ts:891` |
| POST | `/api/admin/compass/version` | `artifacts/api-server/src/routes/adminCompass.ts:592` |
| POST | `/api/admin/compass/weights` | `artifacts/api-server/src/routes/adminCompass.ts:509` |
| PATCH | `/api/admin/compass/weights/:id` | `artifacts/api-server/src/routes/adminCompass.ts:546` |
| GET | `/api/admin/deletion-requests` | `artifacts/api-server/src/routes/admin.ts:2447` |
| POST | `/api/admin/deletion-requests/:id/execute` | `artifacts/api-server/src/routes/admin.ts:2470` |
| GET | `/api/admin/dev/interaction-test` | `artifacts/api-server/src/routes/admin.ts:2527` |
| GET, POST | `/api/admin/entry-requirements` | `artifacts/api-server/src/routes/entryRequirements.ts:322` |
| DELETE | `/api/admin/entry-requirements/:id` | `artifacts/api-server/src/routes/entryRequirements.ts:377` |
| GET | `/api/admin/events` | `artifacts/api-server/src/routes/admin.ts:2800` |
| PATCH | `/api/admin/events/:eventId/moderate` | `artifacts/api-server/src/routes/admin.ts:2868` |
| PATCH | `/api/admin/feature-flags/:flag/metadata` | `artifacts/api-server/src/routes/admin.ts:873` |
| POST | `/api/admin/featured/accept-permission/:postId` | `artifacts/api-server/src/routes/adminFeatured.ts:505` |
| POST | `/api/admin/featured/approve/:postId` | `artifacts/api-server/src/routes/adminFeatured.ts:360` |
| POST | `/api/admin/featured/decline-permission/:postId` | `artifacts/api-server/src/routes/adminFeatured.ts:574` |
| POST | `/api/admin/featured/revoke/:postId` | `artifacts/api-server/src/routes/adminFeatured.ts:627` |
| POST | `/api/admin/featured/shortlist` | `artifacts/api-server/src/routes/adminFeatured.ts:201` |
| GET, POST | `/api/admin/geo-zones` | `artifacts/api-server/src/routes/admin.ts:94` |
| DELETE, GET, PATCH | `/api/admin/geo-zones/:id` | `artifacts/api-server/src/routes/admin.ts:236` |
| POST | `/api/admin/geo-zones/import` | `artifacts/api-server/src/routes/admin.ts:176` |
| GET, PATCH | `/api/admin/geofence-settings` | `artifacts/api-server/src/routes/admin.ts:532` |
| POST | `/api/admin/geofence/:tripId/override-reveal` | `artifacts/api-server/src/routes/admin.ts:585` |
| GET | `/api/admin/geofence/:tripId/suspicious-checkins` | `artifacts/api-server/src/routes/admin.ts:608` |
| POST | `/api/admin/hidden-gems/:id/merge` | `artifacts/api-server/src/routes/hiddenGems.ts:1578` |
| POST | `/api/admin/hidden-gems/:id/resolve-report` | `artifacts/api-server/src/routes/hiddenGems.ts:1609` |
| POST | `/api/admin/hidden-gems/:id/sensitive` | `artifacts/api-server/src/routes/hiddenGems.ts:1552` |
| POST | `/api/admin/hidden-gems/:id/verify` | `artifacts/api-server/src/routes/hiddenGems.ts:1486` |
| GET | `/api/admin/hidden-gems/duplicate-candidates` | `artifacts/api-server/src/routes/hiddenGems.ts:1473` |
| GET | `/api/admin/hidden-gems/guide-applications` | `artifacts/api-server/src/routes/hiddenGems.ts:1435` |
| GET | `/api/admin/hidden-gems/pending` | `artifacts/api-server/src/routes/hiddenGems.ts:1395` |
| GET | `/api/admin/hidden-gems/reported` | `artifacts/api-server/src/routes/hiddenGems.ts:1415` |
| GET | `/api/admin/hidden-gems/sensitive-gems` | `artifacts/api-server/src/routes/hiddenGems.ts:1460` |
| GET | `/api/admin/intel/live-scopes` | `artifacts/api-server/src/routes/admin.ts:3360` |
| GET | `/api/admin/intel/live-scopes/:scopeKey` | `artifacts/api-server/src/routes/admin.ts:3384` |
| POST | `/api/admin/intel/live-scopes/promote` | `artifacts/api-server/src/routes/admin.ts:3414` |
| POST | `/api/admin/intel/live-scopes/withdraw` | `artifacts/api-server/src/routes/admin.ts:3459` |
| POST | `/api/admin/local-guides/:userId/status` | `artifacts/api-server/src/routes/hiddenGems.ts:1636` |
| POST | `/api/admin/media/backfill-dimensions` | `artifacts/api-server/src/routes/adminMedia.ts:405` |
| GET | `/api/admin/moderation/reports` | `artifacts/api-server/src/routes/admin.ts:2039` |
| PUT | `/api/admin/notification-defaults` | `artifacts/api-server/src/routes/notifications.ts:675` |
| GET | `/api/admin/notification-delivery-attempts` | `artifacts/api-server/src/routes/notifications.ts:623` |
| GET | `/api/admin/notification-templates` | `artifacts/api-server/src/routes/notifications.ts:526` |
| POST | `/api/admin/notifications/account-notice` | `artifacts/api-server/src/routes/notifications.ts:540` |
| GET | `/api/admin/passport/stamps/preview` | `artifacts/api-server/src/routes/passportStamps.ts:816` |
| POST | `/api/admin/places/:id/merge` | `artifacts/api-server/src/routes/placesCanonical.ts:94` |
| POST | `/api/admin/places/:id/unmerge` | `artifacts/api-server/src/routes/placesCanonical.ts:125` |
| POST | `/api/admin/places/ingest` | `artifacts/api-server/src/routes/placesCanonical.ts:74` |
| GET, POST | `/api/admin/price-baselines` | `artifacts/api-server/src/routes/tripBudgetIntel.ts:207` |
| DELETE | `/api/admin/price-baselines/:id` | `artifacts/api-server/src/routes/tripBudgetIntel.ts:318` |
| GET | `/api/admin/push-retry-health` | `artifacts/api-server/src/routes/notifications.ts:590` |
| GET, PUT | `/api/admin/ranking/config` | `artifacts/api-server/src/routes/adminRankingConfig.ts:113` |
| GET | `/api/admin/ranking/debug-samples` | `artifacts/api-server/src/routes/adminRankingConfig.ts:555` |
| GET | `/api/admin/ranking/fatigue-summary` | `artifacts/api-server/src/routes/adminRankingConfig.ts:408` |
| GET | `/api/admin/ranking/flags` | `artifacts/api-server/src/routes/adminRankingConfig.ts:237` |
| PUT | `/api/admin/ranking/flags/:key` | `artifacts/api-server/src/routes/adminRankingConfig.ts:258` |
| GET | `/api/admin/ranking/metrics` | `artifacts/api-server/src/routes/adminRankingMetrics.ts:159` |
| GET | `/api/admin/ranking/suspicious` | `artifacts/api-server/src/routes/adminRankingConfig.ts:333` |
| POST | `/api/admin/rent-a-buddy/services/:serviceId/approve` | `artifacts/api-server/src/routes/rentABuddySpec.ts:217` |
| POST | `/api/admin/rent-a-buddy/services/:serviceId/disable` | `artifacts/api-server/src/routes/rentABuddySpec.ts:234` |
| PATCH | `/api/admin/rent-buddy/beta-access/:id` | `artifacts/api-server/src/routes/rentABuddyRollout.ts:1003` |
| PATCH | `/api/admin/rent-buddy/qa/checklists/:id` | `artifacts/api-server/src/routes/rentABuddyRollout.ts:1089` |
| GET, PATCH | `/api/admin/rent-buddy/rollout/cities/:id` | `artifacts/api-server/src/routes/rentABuddyRollout.ts:628` |
| PUT | `/api/admin/repair_catalog` | `artifacts/api-server/src/routes/adminGeocode.ts:230` |
| POST | `/api/admin/reports/:id/hide-content` | `artifacts/api-server/src/routes/admin.ts:2291` |
| GET, PATCH | `/api/admin/safe-return/config` | `artifacts/api-server/src/routes/admin.ts:1047` |
| GET | `/api/admin/safe-return/logs` | `artifacts/api-server/src/routes/admin.ts:1020` |
| POST | `/api/admin/stamps/:userStampId/restore` | `artifacts/api-server/src/routes/adminStamps.ts:271` |
| POST | `/api/admin/stamps/:userStampId/revoke` | `artifacts/api-server/src/routes/adminStamps.ts:247` |
| POST | `/api/admin/stamps/artwork/approve-candidates` | `artifacts/api-server/src/routes/adminStamps.ts:475` |
| GET | `/api/admin/stamps/audit` | `artifacts/api-server/src/routes/adminStamps.ts:295` |
| POST | `/api/admin/stamps/award` | `artifacts/api-server/src/routes/adminStamps.ts:195` |
| GET, POST | `/api/admin/stamps/campaigns` | `artifacts/api-server/src/routes/adminStamps.ts:351` |
| PATCH | `/api/admin/stamps/campaigns/:campaignId` | `artifacts/api-server/src/routes/adminStamps.ts:412` |
| POST | `/api/admin/stamps/catalog/:id/recompose` | `artifacts/api-server/src/routes/stampCatalog.ts:1101` |
| POST | `/api/admin/stamps/criteria/backfill-globe-trotters` | `artifacts/api-server/src/routes/stampCatalog.ts:1490` |
| POST | `/api/admin/stamps/criteria/evaluate` | `artifacts/api-server/src/routes/stampCatalog.ts:1428` |
| GET | `/api/admin/stamps/criteria/metrics` | `artifacts/api-server/src/routes/stampCatalog.ts:1413` |
| GET, POST | `/api/admin/stamps/definitions` | `artifacts/api-server/src/routes/adminStamps.ts:39` |
| PATCH | `/api/admin/stamps/definitions/:id` | `artifacts/api-server/src/routes/adminStamps.ts:130` |
| GET | `/api/admin/suspicious-gps` | `artifacts/api-server/src/routes/admin.ts:316` |
| POST | `/api/admin/suspicious-gps/:id/resolve` | `artifacts/api-server/src/routes/admin.ts:337` |
| DELETE | `/api/admin/tags/:id` | `artifacts/api-server/src/routes/tags.ts:538` |
| GET | `/api/admin/trips` | `artifacts/api-server/src/routes/admin.ts:2567` |
| POST | `/api/admin/trips/:tripId/hide` | `artifacts/api-server/src/routes/admin.ts:2623` |
| POST | `/api/admin/trips/:tripId/report-resolve` | `artifacts/api-server/src/routes/admin.ts:2680` |
| POST | `/api/admin/trips/:tripId/reset-reminder` | `artifacts/api-server/src/routes/admin.ts:2724` |
| POST | `/api/admin/trips/reconcile-invite-slots` | `artifacts/api-server/src/routes/admin.ts:2998` |
| GET | `/api/admin/trust/events/pending` | `artifacts/api-server/src/routes/trust-admin.ts:138` |
| POST | `/api/admin/venues/:id/moderate` | `artifacts/api-server/src/routes/admin.ts:396` |
| PATCH | `/api/admin/venues/:id/status` | `artifacts/api-server/src/routes/admin.ts:488` |
| GET | `/api/admin/venues/pending` | `artifacts/api-server/src/routes/admin.ts:376` |
| GET | `/api/admin/venues/reported` | `artifacts/api-server/src/routes/admin.ts:438` |
| PATCH | `/api/admin/visuals/feature-flags/:flag` | `artifacts/api-server/src/routes/adminVisuals.ts:525` |
| POST | `/api/internal/activity-events` | `artifacts/api-server/src/routes/notifications.ts:473` |
| POST | `/api/internal/buddy-requests/expire` | `artifacts/api-server/src/routes/rentABuddy.ts:7183` |
| POST | `/api/internal/deletion-requests/execute-due` | `artifacts/api-server/src/routes/profile.ts:1627` |
| POST | `/api/internal/notifications` | `artifacts/api-server/src/routes/notifications.ts:400` |
| POST | `/api/internal/notifications/digest` | `artifacts/api-server/src/routes/notifications.ts:454` |
| POST | `/api/internal/notifications/expire` | `artifacts/api-server/src/routes/notifications.ts:510` |
| POST | `/api/internal/notifications/send` | `artifacts/api-server/src/routes/notifications.ts:424` |
| POST | `/api/rent-a-buddy/admin/bookings/:bookingId/resolve-dispute` | `artifacts/api-server/src/routes/rentABuddySpec.ts:1800` |
| GET | `/api/rent-a-buddy/admin/bookings/:bookingId/sensitive` | `artifacts/api-server/src/routes/rentABuddy.ts:6769` |
| GET | `/api/rent-a-buddy/admin/buddies/pending` | `artifacts/api-server/src/routes/rentABuddySpec.ts:991` |
| GET | `/api/rent-a-buddy/admin/buddy-reports` | `artifacts/api-server/src/routes/rentABuddySpec.ts:2162` |
| GET, POST | `/api/rent-a-buddy/admin/category-status` | `artifacts/api-server/src/routes/rentABuddySpec.ts:1739` |
| PATCH, POST | `/api/rent-a-buddy/admin/category-status/:category` | `artifacts/api-server/src/routes/rentABuddySpec.ts:1760` |
| GET, POST | `/api/rent-a-buddy/admin/city-status` | `artifacts/api-server/src/routes/rentABuddySpec.ts:1676` |
| PATCH, POST | `/api/rent-a-buddy/admin/city-status/:city` | `artifacts/api-server/src/routes/rentABuddySpec.ts:1695` |
| POST | `/api/rent-a-buddy/admin/kill-switch` | `artifacts/api-server/src/routes/rentABuddySpec.ts:1628` |
| GET | `/api/rent-a-buddy/admin/marketplace/cities` | `artifacts/api-server/src/routes/rentABuddyMarketplace.ts:2466` |
| POST | `/api/rent-a-buddy/admin/payouts/:payoutId/hold` | `artifacts/api-server/src/routes/rentABuddySpec.ts:2406` |
| POST | `/api/rent-a-buddy/admin/payouts/:payoutId/release` | `artifacts/api-server/src/routes/rentABuddySpec.ts:2455` |
| GET | `/api/rent-a-buddy/admin/pricing/outliers` | `artifacts/api-server/src/routes/rentABuddyMarketplace.ts:2621` |
| POST | `/api/rent-a-buddy/admin/profiles/:id/city-ambassador` | `artifacts/api-server/src/routes/rentABuddyMarketplace.ts:2529` |
| DELETE, POST | `/api/rent-a-buddy/admin/profiles/:id/feature` | `artifacts/api-server/src/routes/rentABuddyMarketplace.ts:2487` |
| POST | `/api/rent-a-buddy/admin/restrictions/city-category` | `artifacts/api-server/src/routes/rentABuddyMarketplace.ts:2712` |
| GET | `/api/rent-a-buddy/admin/reviews` | `artifacts/api-server/src/routes/rentABuddy.ts:5342` |
| POST | `/api/rent-a-buddy/admin/reviews/:reviewId/approve` | `artifacts/api-server/src/routes/rentABuddy.ts:5224` |
| POST | `/api/rent-a-buddy/admin/reviews/:reviewId/reject` | `artifacts/api-server/src/routes/rentABuddy.ts:5284` |
| POST | `/api/rent-a-buddy/admin/run-risk-scan` | `artifacts/api-server/src/routes/rentABuddy.ts:6552` |
| GET | `/api/rent-a-buddy/admin/safety/events` | `artifacts/api-server/src/routes/rentABuddy.ts:5643` |
| POST | `/api/rent-a-buddy/admin/users/:userId/force-full-in-app` | `artifacts/api-server/src/routes/rentABuddyMarketplace.ts:2689` |
| POST | `/api/rent-a-buddy/admin/users/:userId/force-public-meetup` | `artifacts/api-server/src/routes/rentABuddyMarketplace.ts:2667` |
| PATCH, POST | `/api/rent-a-buddy/admin/users/:userId/limits` | `artifacts/api-server/src/routes/rentABuddy.ts:5666` |
