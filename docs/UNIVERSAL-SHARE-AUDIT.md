# Universal Share — Phase 1 Audit

**Date:** 2026-08-07
**Branch:** `bughunt-20260805`
**Scope:** `travel-buddy-standalone/` (canonical mobile tree) + `artifacts/api-server/`.
`artifacts/travel-buddy/` is legacy-frozen and was inspected only where explicitly noted (§3).
**Status:** read-only inventory. No share code was changed.

---

## 0. Headline numbers

| Metric | Value |
|---|---|
| User-facing share/send trigger points | **28** |
| Distinct share implementations behind them | **7** |
| Raw `Share.share()` call sites | **17**, across 13 files |
| Entity types in the target set with **no** canonical route | **2** (postcard, compass_recommendation) — plus `plan`, which has no standalone route |
| Entity types with **multiple** competing routes | **1** (profile — 3 routes) |
| Distinct domain literals used to build share URLs | **2** in code (`travelbuddy.app`, env-derived origin) vs **3** allowed CORS origins — none of which is `travelbuddy.app` |
| Server-side share endpoints | 9 route families |
| Share tests | 12 files |

---

## 1a. Share trigger inventory

### Native OS share sheet — `Share.share()`

| # | file:line | Surface | Entity | Component | What it does today | Proposed replacement |
|---|---|---|---|---|---|---|
| 1 | `src/components/ShareSheet.tsx:228` | Post share sheet → "Share Post" | post | ShareSheet | `Share.share` with `https://travelbuddy.app/posts/{id}`; iOS also sets `url` | UniversalShareSheet external action |
| 2 | `app/post/[id].tsx:300` | Post detail header | post | inline `handleShare` | `Linking.createURL('post/{id}')` — **expo deep link, not a web URL**; no ShareSheet | route through UniversalShareSheet |
| 3 | `src/components/PulseFeedCard.tsx:96` | Pulse feed card | post | inline `sharePost` | hardcoded `travelbuddy.app/posts/{id}`; bypasses ShareSheet **and** `recordShare` | UniversalShareSheet |
| 4 | `app/trip/[id].tsx:232` | Trip detail | trip | inline | `createInviteLink()` → `travelbuddy://invite/{token}`, else `https://travelbuddy.app/trips/{id}` | UniversalShareSheet (invite-link variant) |
| 5 | `app/event/[id].tsx:518` | Event detail | event | inline | `shareEvent()` → server `shareUrl`, else `travelbuddy.app/event/{id}` | UniversalShareSheet |
| 6 | `app/media-viewer/[id].tsx:680` | Media viewer | media | inline | `Share.share({message:'Check this out on Portava!'})` — **no URL at all**; then `recordMediaShare(id,'native')` | UniversalShareSheet |
| 7 | `src/components/media/WatchItemOverlay.tsx:198` | Watch overlay | media | inline | platform-split; iOS `url: posterUrl`, Android appends URL to message; `recordMediaShare` | UniversalShareSheet |
| 8 | `src/components/media/WatchFeedList.tsx:194` | Watch feed row | media | inline `handleShareTelegraph` | despite the name, calls native `Share.share` with caption only — **no URL, no Telegraph** | UniversalShareSheet |
| 9 | `src/components/map/MapEntityActionRow.tsx:225` | Map entity action row | place / person / event | inline | `travelbuddy.app` + `entity.detailRoute` (untyped `as any`) | UniversalShareSheet |
| 10 | `app/messages/[id].tsx:799` | AI recommendation card in chat | compass_recommendation | TelegraphRecommendationCard | title + reason text only, **no link, no entity id** | UniversalShareSheet |
| 11 | `src/hooks/usePassportShare.ts:74` | Passport share (image) | profile/passport | usePassportShare | captured JPEG via RN Share `url` | UniversalShareSheet image branch |
| 12 | `src/hooks/usePassportShare.ts:84` | Passport share (Android fallback) | profile/passport | usePassportShare | message + title | ″ |
| 13 | `src/hooks/usePassportShare.ts:96` | Passport share (text fallback) | profile/passport | usePassportShare | message + title | ″ |
| 14 | `src/hooks/useStampShare.ts:104` | Stamp share (image) | stamp | useStampShare | captured JPEG via RN Share `url` | ″ |
| 15 | `src/hooks/useStampShare.ts:114` | Stamp share (Android fallback) | stamp | useStampShare | message + title | ″ |
| 16 | `src/hooks/useStampShare.ts:126` | Stamp share (text fallback) | stamp | useStampShare | message + title | ″ |
| 17 | `src/screens/SafetyNumberScreen.tsx:85` | E2EE safety number | safety_number | inline | shares the safety-number digits | **leave as-is** — not content sharing |

### `expo-sharing` (file-level share)

| # | file:line | Surface | Entity | What it does | Proposed |
|---|---|---|---|---|---|
| 18 | `src/components/HighlightViewer.tsx:520` | Highlight viewer | highlight | `Sharing.shareAsync(mediaUrl, {mimeType})`; alerts if unavailable | UniversalShareSheet file branch |
| — | `usePassportShare.ts:76`, `useStampShare.ts:106` | Android image branch of #11/#14 | — | `ExpoSharing` | folded into #11/#14 |

### Clipboard copy-a-URL

| # | file:line | Surface | Entity | What it does | Proposed |
|---|---|---|---|---|---|
| 19 | `src/components/ShareSheet.tsx:243` | Post share sheet → "Copy Link" | post | copies `travelbuddy.app/posts/{id}`; Android toast / iOS alert; `recordShare('copy_link')` | UniversalShareSheet copy action |
| 20 | `app/stamp/[stampId].tsx:83` | Stamp detail | stamp | copies `makeStampShareLinks().webUrl` | ″ |
| 21 | `src/components/stamps/StampDetailModal.tsx:74` | Stamp modal | stamp | copies `makeStampShareLinks().webUrl` | ″ |

> `app/messages/[id].tsx:175` and `src/components/GroupChatScreen.tsx:208` also call `Clipboard.setStringAsync`, but they copy **message text**, not a URL. Not share triggers — excluded.

### In-app send (Telegraph)

| # | file:line | Surface | Entity | What it does | Proposed |
|---|---|---|---|---|---|
| 22 | `src/components/ShareSheet.tsx` (`handleSend`, `handleUserResultPress`) | Post → "Send in a chat" | post | thread picker + user search → `sendMessage(threadId, JSON.stringify(payload), {msgType:'system', subtype:'post_card'})` | **becomes the UniversalShareSheet core** |
| 23 | `src/components/DiscoveryShareSheet.tsx` | Discovery card → send | hidden_gem / traveler_pick / for_you / place | near-identical picker → `subtype:'discovery_card'` | **delete, fold into #22** |
| 24 | `app/gems/[id].tsx:292` | Gem detail → share | hidden_gem | `ReasonPromptModal` collects a **raw thread ID typed by the user**, then `shareGemToTelegraph(gemId, threadId)` | replace with the real picker |

### Invite flows

| # | file:line | Surface | Entity | What it does | Proposed |
|---|---|---|---|---|---|
| 25 | `src/components/TripInviteSheet.tsx` (487 ln) | Trip detail → invite | trip | circle list in 3 sections → `POST /api/trips/:id/invite`; server write, no share | keep separate — membership, not sharing |
| 26 | `src/components/TripInviteLinksSheet.tsx` (450 ln) | Trip detail → manage links | trip | lists/revokes invite links | keep separate |
| 27 | `src/components/tripCrew/LiveShareSheet.tsx` | Crew map | live_location | starts temporary location share | keep separate — safety, not content |
| 28 | `src/components/safeReturn/ActiveSafeReturnCard.tsx:261,341` | Safe Return card | live_location | lucide `Share2`, **deliberately not** PortavaShareIcon (documented in-file) | leave alone |

### Icon-only entry points that route into the above

`PortavaShareIcon` renders at 15 production share sites: `app/post/[id].tsx:68`, `app/(tabs)/passport.tsx:678,700`, `app/media-viewer/[id].tsx:329`, `app/trip/[id].tsx:436`, `app/event/[id].tsx:754`, `app/stamp/[stampId].tsx:226`, `src/components/ActionBar.tsx:64`, `src/components/PostEngagementBar.tsx:255`, `src/components/ShareSheet.tsx:319`, `src/components/TelegraphRecommendationCard.tsx:123`, `src/components/stamps/StampDetailModal.tsx:238`, `src/components/HighlightViewer.tsx:530`, `src/components/map/MapEntityActionRow.tsx:314`, `src/components/media/WatchItemOverlay.tsx:446,452`.

Two non-share uses: `PostOwnerMenu.tsx:255` (a *sharing-permission toggle*, not a share action) and `app/gems/share-icon-preview.tsx` (dev-only preview route).

`TelegraphSendIcon` marks the in-app send affordance at `DiscoveryWall.tsx:434` and `discovery/ForYouTab.tsx:361`.

### The 7 distinct implementations

1. Inline bare `Share.share()` — 13 files, each with its own message format and URL logic
2. `ShareSheet.tsx` — post-only; menu + recipient picker + Telegraph `post_card`
3. `DiscoveryShareSheet.tsx` — discovery-only; a near-clone of #2 with a different payload
4. `shareGemToTelegraph()` + `ReasonPromptModal` — gem-only; user types a thread ID
5. `usePassportShare` / `useStampShare` — image-capture share (RN Share + expo-sharing)
6. Invite-link flows — `createInviteLink` / `TripInviteSheet` / `TripInviteLinksSheet`
7. Clipboard copy-link — 3 sites, two different URL builders

---

## 1b. The existing sheets

### `ShareSheet.tsx` — 860 lines

```ts
export type ShareTarget = 'external' | 'copy_link' | 'dm' | 'group_chat' | 'trip_crew' | 'circle';

interface Props {
  visible: boolean;
  postId: string;                                  // ← hard-coupled to posts
  onClose: () => void;
  onShareSuccess?: (target: ShareTarget) => void;
}
```

- **Entity types handled:** exactly one — `post`. `postId` is a required scalar prop and `getPostById` is called unconditionally on open.
- **Call sites:** 2 — `PostEngagementBar.tsx:294`, `media/WatchItemOverlay.tsx:465`.
- **On send:** three real paths.
  - *Share Post* → native `Share.share`, then `onShareSuccess('external')`.
  - *Copy Link* → `Clipboard.setStringAsync`, then `onShareSuccess('copy_link')`.
  - *Send in a chat* → `getMyThreads()` (top 15) or debounced `searchUsers()` → `openDirectThread()` if a user was picked → `sendMessage(threadId, JSON.stringify(payload), {msgType:'system', subtype:'post_card'})`.
  - The **server write** is not done by the sheet: the parent calls `recordShare(postId, target)` → `POST /api/posts/:postId/share`.

### `TripInviteSheet.tsx` — 487 lines

```ts
interface Props {
  tripId: string;
  visible: boolean;
  onDismiss: () => void;
  onInviteSent?: () => void;
}
```

- **Entity types:** one — `trip`. Operates on circle members, not shareable content.
- **Call sites:** 1 — `app/trip/[id].tsx:756`.
- **On send:** `POST /api/trips/:tripId/invite` (real server write) + toast. No native share, no clipboard, no Telegraph message. Sheet stays open for repeat invites.

### `TagPreviewSheet.tsx` — 453 lines

```ts
export type PreviewEntityType = RichTextEntityType | 'hashtag';

interface Props {
  visible: boolean;
  type: PreviewEntityType;        // user | hashtag | trip | circle | event | place
  id: string;                     // handle for users, slug for hashtags, UUID otherwise
  label?: string;
  onClose: () => void;
  onNavigate: () => void;
}
```

- **Entity types:** six. `user` and `hashtag` fetch real data; `trip`, `circle`, `event`, `place` render a `MinimalCard` with an icon + label and no fetch.
- **Call sites:** 1 — `RichText.tsx:262` (long-press on an @mention or #hashtag).
- **On send:** nothing. It is a *preview* sheet — it navigates or closes. No share capability at all.

### Recommendation: **extend `ShareSheet.tsx`, do not rewrite**

`ShareSheet` is the only component in the tree that already solves the hard part — a real recipient picker over Telegraph threads with debounced user search, DM-thread creation, an optional caption, an optimistic-safe send, and a rich preview payload. `DiscoveryShareSheet` proves the pattern generalizes: it is 614 lines that re-derive the same picker for a different payload, and the two have *identical* test files (`ShareSheet.searchReset` / `DiscoveryShareSheet.searchReset`, `.dualSection`, `.debounceCleanup`, `.debounceCleanupMulti`). That duplication is the strongest argument that one parameterized sheet is the right shape.

Three things in its shape fight the spec and must change:

1. **`postId: string` must become a `ShareableEntity` discriminated union.** Everything downstream is post-shaped: `getPostById` on open, the `PostPreview` interface, `postPermalink()`, and the `post_card` subtype literal. Replace with `{type, id}` plus a per-type resolver returning `{title, subtitle, thumbnail, permalink, cardSubtype}`.
2. **`ShareTarget` is analytics-shaped, not transport-shaped.** `'dm' | 'group_chat' | 'trip_crew' | 'circle'` describes *where it landed* for `recordShare`; the sheet needs a separate notion of *what action ran*. Keep `ShareTarget` for the callback, add an action enum internally.
3. **The server write lives in the parent.** `PostEngagementBar` calls `recordShare`; every other surface would have to remember to. Move the write inside the sheet behind an injected recorder so no caller can forget it.

Nothing about the modal chrome, the picker, the search debounce, or the send path needs rewriting. **Extend.** Then delete `DiscoveryShareSheet` and re-point its two call sites (`DiscoveryWall.tsx:447`, `discovery/ForYouTab.tsx:437`).

---

## 1c. The legacy button — **correction: it is not legacy-only**

`PortavaShareButton.tsx` exists in **both** trees and the two copies are **byte-identical** (`diff` returns nothing). Standalone also has its own test at `src/components/share/__tests__/PortavaShareButton.component.test.tsx`. There is nothing to port.

```tsx
// travel-buddy-standalone/src/components/share/PortavaShareButton.tsx
export interface PortavaShareButtonProps {
  onPress?: () => void;
  iconSize?: number;          // visual size; touch target padded to 44x44 via hitSlop
  color?: string;
  accessibilityLabel: string; // required — must describe the item, not the icon
  accessibilityHint?: string;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

function PortavaShareButtonComponent({ onPress, iconSize = 20, color = '#11110F', ... }) {
  const pad = Math.max(0, (44 - iconSize) / 2);
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={pad} testID={testID}
      accessibilityRole="button" accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={disabled ? { disabled: true } : undefined}
      style={({ pressed }) => [styles.hitArea, pressed && !disabled && styles.pressed,
                               disabled && styles.disabled, style]}>
      <PortavaShareIcon size={iconSize} color={color} />
    </Pressable>
  );
}
export const PortavaShareButton = React.memo(PortavaShareButtonComponent);
```

- **Dependencies:** `react`, `react-native` (`Pressable`, `StyleSheet`), and `../icons/PortavaShareIcon.tsx`. All three present in standalone.
- **Missing imports:** none.
- **Portability:** N/A — already there.
- **The real gap:** it is used **once** (its own definition) while `PortavaShareIcon` is hand-wrapped in a bare `Pressable` at 15 sites, each re-implementing hitSlop and pressed opacity. Adoption is the work, not porting.

---

## 1d. Telegraph capability — gates Phase 3

### Can a message carry structured/typed content?

**Yes by convention, no by schema.** There is no typed content column. The client `JSON.stringify`s a payload into the plain `body` text column and tags it with a subtype string.

```ts
// travel-buddy-standalone/src/services/messaging.ts:398
export async function sendMessage(
  threadId: string,
  body: string,
  opts?: { msgType?: string; subtype?: string; clientId?: string; replyToId?: string },
): Promise<MsgResult<Message>>
```

Server-side (`artifacts/api-server/src/routes/messaging.ts:1595-1671`):

```ts
const msgTypeRaw = typeof req.body?.msgType === 'string' ? req.body.msgType : 'text';
const msgType    = msgTypeRaw === 'system' ? 'system' : 'text';   // ← only 2 values
const subtype    = typeof req.body?.subtype === 'string' ? req.body.subtype : null;  // ← ANY string
// ...
.insert({ thread_id, sender_id, body, ciphertext, created_at, msg_type: msgType, subtype })
```

**`subtype` is unvalidated free text.** There is no whitelist, no enum, no JSON schema, and no server-side parse of `body`. Rendering is entirely client-side: `PostCardMessage.tsx` and `DiscoveryCardMessage.tsx` each `JSON.parse` the body defensively. Subtypes in use across the codebase: `post_card`, `discovery_card`, `hidden_gem`, `meetup`, `meetup_confirmed`, `meetup_cancelled`, `event_context_card`, `booking_status_*`, plus circle status cards.

**Consequence for Phase 3:** a new card type needs *no* server change — only a client renderer. That is the good news. The bad news is there is nothing stopping a malformed or hostile payload from reaching a renderer, and **E2EE threads cannot carry these cards at all** (`is_e2ee` threads reject plaintext `body` outright; only `ciphertext` is stored).

### Conversation types

| Type | Exists | Addressable conversation id |
|---|---|---|
| Direct (1:1) | **Yes** | Yes — `openDirectThread(userId)` → `{threadId}`; idempotent |
| Trip Crew chat | **Yes** | Yes — `openTripChat` / `getTripChat` / `syncTripChat`; `ThreadSummary.threadType === 'trip'`, `tripId` populated |
| Circles | **Yes** | Yes — `openCircleChat` / `getCircleChat` / `syncCircleChat`; `threadType === 'circle'`, `circleOwnerId` populated |
| Event chats | **Yes** | Yes — `POST /api/events/:id/chat` creates/returns the thread; `POST /api/events/:id/chat/join` for Going RSVPs |
| Rent-a-Buddy booking | **Yes** | Yes — `threadType === 'rent_buddy_booking'` |

`ThreadSummary.threadType` is a closed union of exactly these four values: `'direct' | 'trip' | 'circle' | 'rent_buddy_booking'`. **Event chats are real but do not have their own `threadType`** — they are created through the events route and surface under one of the existing types. Any per-type UI grouping in a share sheet must account for that.

### Recipient search endpoint

**Exists.** `searchUsers(query, limit = 20)` in `src/services/follows.ts:167`, returning `TravelerSearchResult[]`. Already wired into both `ShareSheet` and `DiscoveryShareSheet` with a 350 ms debounce.

### Recent recipients source

**Exists, but it is recent *threads*, not recent *recipients*.** `getMyThreads()` → `GET /api/me/threads`, ordered by `lastMessageAt`. Both sheets slice to the top 15. There is **no** "recently shared with" / frecency ranking, and no per-entity-type recipient memory. If the spec wants "recent recipients", that is new work.

### Multi-conversation fan-out in one call

**Does not exist.** `sendMessage` takes a single `threadId` and `POST /api/threads/:threadId/messages` is strictly per-thread. Grepping `messaging.ts` for `threadIds` finds only read-side batching (`.in('id', threadIds)` when listing threads). Sharing to N conversations means **N sequential client calls**, each subject to its own membership check, E2EE check, and off-app-solicitation scan. There is no batch endpoint and no transactional guarantee across them.

---

## 1e. Entity routes

| Entity | Canonical route today | Status |
|---|---|---|
| postcard | — | ⚠️ **ZERO ROUTE.** `passport_postcards` rows exist (`src/types/models.ts:461`) but postcards render only inside passport/post surfaces. Not addressable. |
| shared_moment | `app/shared-moments/[id].tsx` | ✅ |
| profile | `app/profile/[handle].tsx` **and** `app/u/[username].tsx` **and** `app/passport/[username].tsx` | ⚠️ **THREE ROUTES.** Plus `app/(tabs)/passport.tsx` for self. Share URLs use `/u/{username}`; the server share page also serves `/u/:username` and `/passport/:username`. Must pick one canonical form. |
| trip | `app/trip/[id].tsx` | ✅ |
| plan | — | ⚠️ **NO STANDALONE ROUTE.** Plans render inside `app/trip/[id].tsx`. Not independently addressable. |
| event | `app/event/[id].tsx` | ✅ |
| place | `app/place/[id].tsx` (+ `/day`, `/moments` sub-routes) | ✅ |
| memory | `app/memory/[id].tsx` | ✅ |
| compass_recommendation | — | ⚠️ **ZERO ROUTE.** Only `app/compass-settings`, `app/compass-memories`, `app/compass-preferences` exist. The share at `app/messages/[id].tsx:799` therefore cannot include a link — and doesn't. |
| buddy_profile | `app/(rent-a-buddy)/buddy/[id].tsx` | ✅ |
| stamp | `app/stamp/[stampId].tsx` (+ list `app/stamps.tsx`, deep link `travelbuddy://stamps/{id}`) | ✅ |

Adjacent, not in the requested set but shareable today: `hidden_gem` → `app/gems/[id].tsx` ✅, `post` → `app/post/[id].tsx` ✅, `media` → `app/media-viewer/[id].tsx` ✅.

Worth noting as precedent: `app/review/[entityType]/[entityId].tsx` already establishes a generic two-segment entity route pattern in this tree.

---

## 1f. Canonical URL — **BLOCKER, needs Draie's decision**

### The mismatch, confirmed

| Domain | Where it appears | Role |
|---|---|---|
| `travelbuddy.app` | **9 occurrences in production code** (below) | The domain actually emitted in share output |
| `app.travel-buddy.io` | `artifacts/api-server/src/app.ts:31` | Allowed CORS origin |
| `www.travel-buddy.io` | `artifacts/api-server/src/app.ts:32` | Allowed CORS origin |
| `portava.replit.app` | `artifacts/api-server/src/app.ts:33` | Allowed CORS origin; also the (stale) production deployment |
| `portava.app` | `src/routes/mediaFile.ts:37` (asset URL), `buddy-dashboard/safety.tsx:246` (support email) | Brand domain, used for assets only |
| `internal.portava.app` | `src/scripts/seed-portava-account.ts:32` | Internal seed account email |

**`travelbuddy.app` is not in the CORS allowlist. None of the three allowed origins is ever emitted in a share URL.** Every link the app produces points at a domain the API will not accept a browser request from.

### Every place a shareable URL is built

**Hardcoded, ignores env entirely — 5 sites:**

| file:line | Builds |
|---|---|
| `src/components/ShareSheet.tsx:80` | `` `https://travelbuddy.app/posts/${postId}` `` (`postPermalink`) |
| `src/components/PulseFeedCard.tsx:94` | `` `https://travelbuddy.app/posts/${item.id}` `` |
| `src/components/map/MapEntityActionRow.tsx:226` | `` `https://travelbuddy.app${detailPath}` `` |
| `app/trip/[id].tsx:230` | `` `https://travelbuddy.app/trips/${id}` `` (fallback when invite-link creation fails) |
| `app/event/[id].tsx:516` | `` `https://travelbuddy.app/event/${event.id}` `` (fallback when `shareEvent()` returns no `shareUrl`) |

**Env-derived with a `travelbuddy.app` fallback — 2 builders, duplicated by design:**

| file:line | Logic |
|---|---|
| `src/services/passportShareUtils.ts:9-27` | `makeDeepLink()` → `travelbuddy://passport/@{u}`; `makeWebFallback()` → `EXPO_PUBLIC_WEB_ORIGIN` ‖ `new URL(EXPO_PUBLIC_API_BASE_URL).origin` ‖ `https://travelbuddy.app/u/{u}` |
| `src/services/stampShareUtils.ts:41-80` | private `resolveWebOrigin()` — an **explicit copy** of the above ("Mirrors the logic in passportShareUtils.ts … without creating a circular dependency") — then `makeStampShareLinks()` → `{deepLink, webUrl}` with `base = resolveWebOrigin() || 'https://travelbuddy.app'` |

**Server-authoritative — 2 sources:**

| Source | Behaviour |
|---|---|
| `app/event/[id].tsx:513` → `shareEvent(id)` | Server returns `shareUrl`. The only trigger that gets its URL from the server; falls back to the hardcoded literal. |
| `app/trip/[id].tsx:227` → `createInviteLink(id)` | Returns a token; client builds `travelbuddy://invite/{token}` — **a custom-scheme URI with no web fallback.** Recipients without the app installed get a dead link. |

**Deep-link scheme:** `travelbuddy://` throughout (`travelbuddy://passport/@{u}`, `travelbuddy://stamps/{id}`, `travelbuddy://invite/{token}`). Declared as `APP_SCHEME = "travelbuddy"` in `wellKnownShare.ts:59`.

### `artifacts/api-server/src/routes/wellKnownShare.ts`

Serves, at the app root, before the `/api` router, unauthenticated:

- `GET /.well-known/apple-app-site-association`
- `GET /.well-known/assetlinks.json`
- `GET /u/:username`
- `GET /passport/:username`

Pinned identity constants (lines 56-60): `APP_NAME="Portava"`, `IOS_BUNDLE_ID="com.passporttravelbuddy.app"`, `ANDROID_PACKAGE="com.passporttravelbuddy.app"`, `APP_SCHEME="travelbuddy"`, `APP_LINK_PATHS=["/passport","/passport/*","/u","/u/*"]`. Team ID and cert fingerprint come from `APPLE_APP_ID_PREFIX` / `ANDROID_CERT_SHA256` env vars; **missing values return 503 rather than a placeholder file**, deliberately, because a wrong appID makes Apple/Google cache a failed verification.

Share pages are minimal server-rendered OG landing pages. Public profiles get real title/description; private, blocked, or unavailable profiles get a generic card so previews never leak account state; unknown handles 404. All interpolation is HTML-escaped. `og:image` points at `GET /api/users/:username/og-image.png`.

**Only two entity types have a share landing page: `/u/:username` and `/passport/:username`.** Posts, trips, events, stamps, places, memories — every URL the app emits for them — have **no server-rendered page at all**.

### `serveSharePage`

There is **no function named `serveSharePage`** anywhere in the tree. The name survives only as a test filename: `src/services/__tests__/serveSharePage.test.ts`, which spawns `travel-buddy-standalone/server/serve.js` as a subprocess and asserts (a) malformed percent-encoded paths don't crash the process, (b) `/u/<username>` serves HTML with OG tags, (c) unknown usernames get generic metadata with no name leakage. `wellKnownShare.ts` is the api-server port of that same `serve.js` logic (its header says so explicitly, "lines ~60-360").

### The decision Draie has to make

1. **Which domain is canonical for share links?** Nothing currently emitted is CORS-allowed.
2. **`EXPO_PUBLIC_WEB_ORIGIN` is the intended mechanism but only 2 of 7 builders consult it.** The 5 hardcoded sites must be migrated regardless of which domain wins.
3. **Landing-page coverage.** Web share pages exist for profiles only. Either every shared entity gets a landing page, or share URLs for uncovered entities are knowingly dead outside the app.
4. **`travelbuddy://invite/{token}` has no web fallback** and will stay broken for non-installed recipients until it does.

---

## 1g. Server side

### Share endpoints that exist

| Endpoint | File | Writes? |
|---|---|---|
| `POST /api/posts/:postId/share` | `routes/posts.ts:2766` | **Yes** — upserts `post_shares` |
| `POST /api/media/:id/share` | `routes/mediaFeed.ts:2023` | Yes — media analytics |
| `POST /api/memories/:id/share` | `routes/memories.ts:897` | Yes |
| `POST /api/hidden-gems/:id/share-telegraph` | `routes/hiddenGems.ts:993` | Yes — inserts a `subtype:"hidden_gem"` message |
| `POST /api/events/:id/share-link`, `DELETE .../:linkId`, `GET /api/events/share-link/:token/preview` | `routes/events.ts:5057, 5092, 1813` | Yes — event share links |
| `GET/POST /api/shared-moments…` (14 routes) | `routes/sharedMoments.ts` | Yes |
| `POST /api/trips/:tripId/crew/live-share/{start,stop}`, `GET .../live-shares` | `routes/tripCrewLocation.ts:313,361,380` | Yes — location, not content |
| `POST /api/me/safe-return/sessions/:id/live-share/{start,stop}`, `GET /api/safe-return/live-share/:shareId` | `routes/safeReturn.ts:542,616,644` | Yes — safety |
| `PATCH /api/airport/sessions/:id/share` | `routes/airport.ts:1325` | Yes |

### `POST /api/posts/:postId/share` in detail

Validates the target against `VALID_SHARE_TARGETS`, 404s on missing/inactive posts, **honours `post.sharing_disabled`** (rejects unless the caller is the author), runs `checkEngagePermission`, rate-limits at **10 shares / 60 s / user**, then:

```ts
.from("post_shares")
.upsert({ post_id: postId, user_id: user.id, target },
        { onConflict: "post_id,user_id,target", ignoreDuplicates: true });
```

### Share tables / migrations

| Table | Migration |
|---|---|
| `post_shares` | `0066_post_interaction_layer.sql`, RLS in `2070_rls_hardening.sql` |
| shared moments | `2064_shared_moments_foundation.sql` |

There is **no generic `shares` table** and **no `entity_shares`**. `post_shares` is post-specific and keyed `(post_id, user_id, target)`.

### Shared-content message types

Stored as `messages.msg_type='system'` + a free-text `messages.subtype`. Known subtypes: `post_card`, `discovery_card`, `hidden_gem`, `meetup`, `meetup_confirmed`, `meetup_cancelled`, `event_context_card`, `booking_status_*`, circle status cards. No table, enum, or constraint enumerates them.

### Does internal sharing write anything server-side?

**Yes — but inconsistently, and the coverage is the problem.**

- Sharing a **post** writes to `post_shares`, but *only because `PostEngagementBar` remembers to call `recordShare`*. `PulseFeedCard.tsx:96` shares the same entity type and writes **nothing**.
- Sharing **media** writes via `recordMediaShare` from `media-viewer` and `WatchItemOverlay` — but **not** from `WatchFeedList.tsx:194`.
- Sharing a **gem** to Telegraph writes a message row.
- Sharing a **trip, event, stamp, passport, place, map entity, or compass recommendation** writes **nothing**. There is no record that the share happened.

So: internal sharing writes server-side for 3 of ~10 entity types, and even within those, individual trigger sites silently skip the write.

---

## 1h. Supporting infrastructure

**This is construction, not assembly.** Three of the six primitives the spec needs do not exist.

| Need | What exists | Verdict |
|---|---|---|
| **Analytics function** | **No general-purpose analytics service.** The only telemetry is `src/hooks/useMediaAnalytics.ts` — media-only, batched/debounced/deduped, with a closed `MediaEventType` union (`impression`, `qualified_view`, `share`, `save`, `profile_open`, `place_open`, …). No `logEvent`/`trackEvent`/`analytics.*`; no PostHog/Amplitude/Mixpanel. Share tracking is done by *domain endpoints* (`recordShare`, `recordMediaShare`), not by an analytics layer. | ❌ **Build.** Either generalize `useMediaAnalytics` or add a share-specific recorder. |
| **Event naming convention** | Two, in conflict. `useMediaAnalytics` uses snake_case verbs (`qualified_view`, `grid_tile_open`). `ShareTarget` uses transport nouns (`external`, `copy_link`, `dm`, `trip_crew`, `circle`). | ⚠️ **Decide** before emitting share events. |
| **Feature flag mechanism** | ✅ `src/context/FeatureFlagsContext.tsx` — `useFeatureFlags().isEnabled(key)`, fetches `GET /api/feature-flags` on mount and on foreground, **fail-soft** (unknown key or failed fetch → `false`, so entry points hide rather than crash). Also `isLivePlacesEnabled` for hierarchical capabilities, and typed wrappers `useRentABuddyFlag` / `useCircleFlag`. Admin UI at `app/admin/feature-flags.tsx`. | ✅ **Assembly.** Ready to gate a rollout. Note: flags must be **seeded server-side** — see the `unseeded-feature-flag-gates` memory. |
| **Bottom sheet primitive** | **None.** `src/components/ui/` has `ConfirmSheet`, `MediaSourceSheet`, `VideoStoryTrimSheet` — three *specific* sheets, each hand-rolling `<Modal>` + insets. `ShareSheet`, `DiscoveryShareSheet`, `TripInviteSheet`, `TagPreviewSheet` each do the same again. No shared `BottomSheet`. | ❌ **Build**, or accept a 5th hand-rolled modal. |
| **Avatar** | **No shared component.** `TripInviteSheet` and `TripInviteLinksSheet` each define a *local* `Avatar`; `ShareSheet`/`DiscoveryShareSheet` inline `<Image>` with a circular style. Only `src/components/interaction/UserAvatarButton.tsx` is shared, and it is a button, not a display primitive. | ❌ **Build** (extract). |
| **Chip** | Partial — `src/components/LocationChip.tsx`, `passport/AvailabilityChip.tsx`. Both domain-specific; no generic chip. | ⚠️ **Extract.** |
| **Section header** | **None.** `TripInviteSheet`'s three labelled sections use local styles. | ❌ **Build.** |
| **Skeleton** | ✅ Good coverage — `ui/ShimmerBox.tsx` plus 8 in `src/components/loading/` (`FeedSkeleton`, `ProfileSkeleton`, `SearchResultsSkeleton`, `CommentsSkeleton`, `MediaGridSkeleton`, `TripCardSkeleton`, `EventCardSkeleton`, `PlaceCardSkeleton`) and `TravelerRowSkeleton`, `discovery/PlaceSkeleton`. | ✅ **Assembly.** |

---

## 1i. Existing share tests

| File | Covers |
|---|---|
| `src/components/__tests__/ShareSheet.searchReset.component.test.tsx` | search state resets between opens |
| `src/components/__tests__/ShareSheet.dualSection.component.test.tsx` | threads + user-results sections render together |
| `src/components/__tests__/ShareSheet.debounceCleanup.component.test.tsx` | search debounce timer cleared on unmount |
| `src/components/__tests__/ShareSheet.debounceCleanupMulti.component.test.tsx` | repeated open/close cycles don't leak timers |
| `src/components/__tests__/DiscoveryShareSheet.searchReset.component.test.tsx` | ⟵ same four assertions, duplicated |
| `src/components/__tests__/DiscoveryShareSheet.dualSection.component.test.tsx` | ″ |
| `src/components/__tests__/DiscoveryShareSheet.debounceCleanup.component.test.tsx` | ″ |
| `src/components/__tests__/DiscoveryShareSheet.debounceCleanupMulti.component.test.tsx` | ″ |
| `src/components/__tests__/GemDetailShare.reasonModal.component.test.tsx` | **see below** |
| `src/components/share/__tests__/PortavaShareButton.component.test.tsx` | button chrome, hitSlop, a11y, disabled state |
| `src/components/icons/__tests__/PortavaShareIcon.component.test.tsx` | icon render |
| `src/components/__tests__/StampShareCard.component.test.tsx` | stamp share card rendering |
| `src/services/__tests__/stampShare.test.ts` | `makeStampShareLinks` / `makeStampShareMessage`, incl. the `travelbuddy.app` fallback |
| `src/services/passportShare.test.ts` | `makeDeepLink` / `makeWebFallback` / `toFileUri`, incl. the `travelbuddy.app` fallback |
| `src/services/__tests__/serveSharePage.test.ts` | spawns `server/serve.js`; URIError guard, `/u/<username>` OG tags, no name leakage for unknown handles |
| `src/lib/__tests__/invitePreviewMapper.test.ts`, `inviteRetryGuard.test.ts`, `inviteCardGoneHandler.test.ts`, `src/services/__tests__/invitePreviewLoad.test.ts` | trip-invite preview/retry paths |

### `GemDetailShare.reasonModal.component.test.tsx`

One of the 9 files that were **unparseable by eslint** until the `<T,>` fix committed in `390ddaf6d`. It passed under Jest the whole time — the failure was eslint-only — but it received **zero lint coverage**, `rules-of-hooks` included, for as long as the parse error stood.

What it covers, per its own header: the gem Share action originally used `Alert.prompt`, **an iOS-only API that is a silent no-op on Android and web**. The test asserts the replacement — `ReasonPromptModal` — collects the thread ID and that `shareGemToTelegraph` is called with it. It also documents the React 19 act() strategy used across this suite (bare `fireEvent` + `waitFor`, never `await act(async () => {})`, to avoid overlapping-act warnings).

The test locks in a workaround, not a good design: **the user is asked to type a raw thread UUID**. Replacing that with the real recipient picker is exactly what §1a #24 proposes, and this test will need rewriting when it happens.

---

## 1j. Summary and honest read

### Numbers

- **28** user-facing share/send trigger points
- **7** distinct implementations behind them (17 raw `Share.share()` calls in 13 files; 2 near-identical picker sheets; 1 type-a-thread-ID modal; 2 image-capture hooks; 2 invite-link flows; 3 clipboard sites)
- **3** entity types in the target set with no canonical route: **postcard**, **compass_recommendation**, and **plan**
- **1** entity type with three competing routes: **profile** (`/profile/[handle]`, `/u/[username]`, `/passport/[username]`)
- **7** URL builders, **5** of which hardcode a domain that is not CORS-allowed
- **2** entity types (profile, passport) have a server-rendered share landing page; every other share URL leads nowhere on the web

### Telegraph gaps

| Capability | State |
|---|---|
| Typed message content | Convention only — `subtype` is unvalidated free text; payload is JSON in a plain `body` column |
| Direct / trip / circle / event / booking threads | All exist, all addressable |
| Recipient search | Exists (`searchUsers`) |
| Recent recipients | **Does not exist** — only recent *threads* by `lastMessageAt` |
| Multi-conversation fan-out | **Does not exist** — N sequential per-thread calls, no batch endpoint, no transaction |
| Cards in E2EE threads | **Impossible** — E2EE threads reject plaintext `body` |

### Which phases are buildable now

**Phase 1 (unify the trigger surface) — buildable today, no blockers.** `PortavaShareButton` already exists in standalone and is unused; adopting it at the 15 hand-rolled icon sites is mechanical. `ShareSheet` extends cleanly into a `ShareableEntity` union, and `DiscoveryShareSheet` can then be deleted along with its 4 duplicate test files. `FeatureFlagsContext` can gate the rollout. Everything here is inside the standalone tree and touches no server contract.

**Phase 2 (canonical URLs) — BLOCKED on a decision, not on code.** The code change is small and well-understood: route all 7 builders through one `resolveShareOrigin()`. But nothing can be written until Draie answers which domain is canonical, because `travelbuddy.app` — the only domain currently emitted — is in no allowlist, and three CORS-allowed origins are emitted nowhere. Picking `EXPO_PUBLIC_WEB_ORIGIN` as the mechanism is already half-done; picking its *value* is the blocker. A second, quieter decision rides along: whether entities without a landing page get one, or knowingly ship dead web links.

**Phase 3 (rich in-app cards) — partially buildable, with two real ceilings.** New card subtypes need no server change, which is a genuine accelerator. But *multi-select send is not buildable as specified*: there is no fan-out endpoint, so "share to 5 chats" is 5 sequential calls with no atomicity and 5 independent failure modes — that needs either a server endpoint or an explicit product decision to accept partial sends. And **share cards cannot appear in E2EE threads at all**; if the picker lists them, sends will fail. Neither limit is discoverable from the client code alone, which is why both belong in the spec before implementation starts.

**Cross-cutting risk that is not in any phase:** share recording is already broken in ways unification will *expose*. `PulseFeedCard` and `WatchFeedList` share content and write nothing; 7 of ~10 entity types have no share record at all. Moving the write inside the sheet fixes this — and will make share counts jump. That is a correction, not a regression, but it needs to be called out before anyone reads it as a metrics bug.

**Infrastructure honesty:** the spec assumes assembly; the tree offers roughly half. Feature flags and skeletons are ready. A bottom-sheet primitive, an avatar component, and a section header do not exist and will be built as part of this work whether or not they are scoped — four sheets already hand-roll all three, and a fifth is about to. There is also no general analytics layer, only a media-specific hook; share events currently ride on domain endpoints, and unifying them means either generalizing `useMediaAnalytics` or accepting two naming conventions permanently.

---

## Appendix — pre-work landed alongside this audit

| Commit | Change |
|---|---|
| `2d74dacec` | `RouteMinimapView.tsx` maplibre safe-require (conforms to `.agents/memory/maplibre-safe-require.md`) |
| `eb7e6bd18` | `.replit` — standalone dev workflow reverted off `expo start --tunnel --port 9000` back to `PORT=3000 pnpm run dev` |
| `390ddaf6d` | `<T>` → `<T,>` in 9 component test files; eslint errors 11 → 2, `rules-of-hooks` 0, `test:component` unchanged at 315/315 suites / 1634/1634 tests |

**Unrelated gap noticed while verifying the maplibre pattern, not fixed:** `travel-buddy-standalone/src/components/RouteFullMapModal.tsx:14` still uses a **static value import** from `@maplibre/maplibre-react-native`. It is not a `.web.tsx` stub and is not on the patched-files list in the memory. It is the sibling component of `RouteMinimapView` and carries the same route-registration crash risk.
