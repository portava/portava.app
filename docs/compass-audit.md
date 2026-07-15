# Compass Foundation Audit

**Audited:** 2026-07-05  
**Scope:** `artifacts/api-server/src/compass/`, `artifacts/api-server/src/routes/compass.ts`, `travel-buddy-standalone/src/components/compass/`, `travel-buddy-standalone/src/hooks/compass/`

---

## 1. Pipeline Architecture — What Exists

### CompassPipeline.ts ✅ SOLID
Single-entry-point orchestrator that runs Safety → Eligibility → Privacy → Scoring gates in strict order. Loads feature flags once per batch. Returns `PipelineSummary` with sorted results. Injectable test overrides for all four gates.

### CompassSafetyFilter.ts ✅ SOLID (patched in this task)
Hard-block gate (FAIL-CLOSED). 16 original checks + 3 new checks added in this task:
- Blocked users (both directions), viewer-reported items, suspended accounts ✅
- Adult-service flag, off-app payment, unsafe-intent signals ✅  
- Delayed posts, hidden content, expired, cancelled ✅
- Buddy verification, age gate, launch control, type-level flag, report count threshold ✅
- **NEW:** Moderation-rejected content (`isModerationRejected`) ✅
- **NEW:** Deleted accounts (`isDeleted`) ✅
- **NEW:** Muted/hidden users (`mutedUserIds`) ✅

### CompassEligibilityEngine.ts ✅ SOLID
Soft-reject gate (FAIL-OPEN). 11 checks covering per-type feature flags, trust floor, age, country/city launch gates, verification, capacity, circle/trip scope, buddy status, private items.

### CompassPrivacyGuard.ts ✅ SOLID
Strips GPS coords, hotel/accommodation addresses, admin notes, emergency contacts, identity documents, private booking notes, safe-return route data. Rewrites location text for sanitized items.

### CompassScoringEngine.ts ✅ SOLID
8 content-type weight profiles (event/post/user/buddy/trip/stamp/notification/suggestion). 11 positive components + 5 penalties. Fire-and-forget log to `compass_recommendation_scores`. Never throws.

### CompassIntentModeEngine.ts ✅ SOLID
Maps context state → primary intent mode + secondary modes. Night-mode and safety-mode secondary injection. Pure function, no DB calls.

### CompassDiscoveryAdapter.ts ✅ SOLID
Bidirectional mapper between `DiscoveryPlaceLike` and `CompassItem`. Handles rating normalization, coordinate privacy, isHidden for closed venues.

### CompassDiversityEngine.ts ✅ SOLID
No consecutive-type runs (≤2 in a row), same-author run cap (≤3), nightlife/paid cap at 25%, exploration card insertion (1 per 10 items, max 3). Pure function.

### CompassFairExposureEngine.ts ✅ SOLID
Inserts up to 2 new-author items near feed top. Respects appearance cap (10), cooldown (7 days), verification requirement. Writes to `compass_visibility_boosts` and `compass_visibility_cooldowns` fire-and-forget.

### CompassActiveUserRewardEngine.ts ✅ SOLID
Windowed activity scoring (24h/7d/30d/90d/lifetime), trust multiplier, tier computation, badge eligibility. Writes to `compass_active_user_scores`, `compass_active_user_badges`, `compass_city_reputation`, `compass_category_reputation`.

### CompassExplanationEngine.ts ✅ SOLID
HMAC-signed recommendation tokens, sensitive-key privacy guard, template-based explanations with DB override lookup. `encodeRecommendationToken`/`decodeRecommendationToken` are cryptographically sound.

### CompassFeedbackEngine.ts ✅ SOLID
17 feedback actions mapped to preference weight adjustments. Writes to `compass_feedback_events`, upserts `compass_user_preferences`, invalidates cache. Uses ordered write protocol (event first, then prefs, then cache).

### CompassProfileService.ts ✅ SOLID
Loads profile from 10+ table joins with 2-min in-memory cache. Loads `blockedUserIds`, `blockerUserIds`, `categoryWeights`, `ignoredItemIds`, `mutedHashtags`. **Patched in this task** to load `mutedUserIds` from user_interactions.

### flags.ts ✅ SOLID
In-memory 30s TTL cache for all `COMPASS_*` flags. `isCompassEnabled()` helper. Fail-open on error (returns empty dict → flag treated as false for explicit checks).

---

## 2. Route Layer — What Exists

### compass.ts (existing endpoints) ✅
| Endpoint | Status |
|----------|--------|
| `GET /api/compass/me/context` | ✅ Gated by `COMPASS_ENABLED` |
| `GET /api/compass/feed` | ✅ Gated by `COMPASS_ENABLED` + `COMPASS_FEED_ENABLED`, cursor pagination, fallback mode |
| `GET /api/compass/feed/section/:section` | ✅ Gated, fallback mode |
| `GET /api/compass/frontload` | ✅ |
| `GET /api/compass/preload-manifest` | ✅ |
| `POST /api/compass/frontload/event` | ✅ |
| `PUT /api/compass/me/boost-visibility` | ✅ |
| `GET /api/compass/why/:recommendationId` | ✅ HMAC-verified, DB-authoritative |
| `POST /api/compass/ask` | ✅ Conversational AI fallback |
| `POST /api/compass/feedback` | ✅ Full feedback engine |
| `GET /api/compass/me/preferences` | ✅ |
| `PATCH /api/compass/me/preferences` | ✅ |
| `GET /api/compass/me/active-reward` | ✅ |

### compass.ts (new endpoints added in this task) ✅
| Endpoint | Status |
|----------|--------|
| `GET /api/compass/context` | ✅ Returns compass_recent_context row |
| `POST /api/compass/context` | ✅ Upserts context session |
| `DELETE /api/compass/context` | ✅ Deletes context session |
| `GET /api/compass/settings` | ✅ Returns compass_settings row |
| `PATCH /api/compass/settings` | ✅ Upserts compass_settings |
| `POST /api/compass/report` | ✅ Dedicated abuse report endpoint |
| `GET /api/compass/debug/recommendations` | ✅ Admin-only debug view |

### adminCompass.ts ✅ SOLID
Full admin cockpit: dashboard, weight sets, algorithm versioning, cache controls, boost eligibility, abuse flags, safety filters, active rewards, testing sandbox.

---

## 3. Mobile Layer — What Exists

### CompassStatusCard.tsx ✅ SOLID
Displays tier, badges, visibility message. Hides when boost is disabled. Navigates to `/compass-preferences`.

### CompassWhySheet.tsx ✅ SOLID
Bottom sheet that shows "Why am I seeing this?" explanation. Calls `/api/compass/why/:recommendationId`.

### CompassFeedbackMenu.tsx ✅ SOLID
Overflow menu for feedback actions. Calls `/api/compass/feedback`.

### useCompassFeed.ts ✅ SOLID
Paginates compass feed with cursor. Handles fallback state.

### useCompassPreferences.ts ✅ SOLID
Loads and patches `compass_user_preferences`. Also handles `boost-visibility` toggle.

---

## 4. DB Tables — Status

### Existing Compass DB Tables ✅
| Table | Migration | Status |
|-------|-----------|--------|
| `compass_user_preferences` | 0045 | ✅ Exists |
| `compass_served_recommendations` | 0055 | ✅ Exists |
| `compass_recommendation_scores` | 0052 | ✅ Exists |
| `compass_safety_filter_logs` | ~0049 | ✅ Exists |
| `compass_eligibility_logs` | ~0049 | ✅ Exists |
| `compass_feedback_events` | ~0054 | ✅ Exists |
| `compass_active_user_events` | ~0053 | ✅ Exists |
| `compass_active_user_scores` | 0053 | ✅ Exists |
| `compass_active_user_badges` | ~0053 | ✅ Exists |
| `compass_visibility_boosts` | ~0056 | ✅ Exists |
| `compass_visibility_cooldowns` | ~0056 | ✅ Exists |
| `compass_city_reputation` | ~0057 | ✅ Exists |
| `compass_category_reputation` | ~0057 | ✅ Exists |
| `compass_explanation_reasons` | ~0058 | ✅ Exists |
| `compass_navigation_events` | ~0059 | ✅ Exists |
| `compass_feed_cache` | ~0060 | ✅ Exists |
| `feature_flags` | ~0040 | ✅ Exists (COMPASS_* flags stored here) |

### New Tables Added in This Task ✅
| Table | Migration | Status |
|-------|-----------|--------|
| `compass_feedback` | 0104 | ✅ Added |
| `compass_recent_context` | 0104 | ✅ Added |
| `compass_settings` | 0104 | ✅ Added |

---

## 5. Hard-Filter Gap Analysis (Pre-Patch)

| Gap | Impact | Fix Applied |
|-----|--------|------------|
| Muted users not excluded | Muted authors could appear in feed | Added `mutedUserIds` to profile + safety filter check |
| Moderation-rejected content not blocked | Flagged/rejected items could surface | Added `isModerationRejected` to item + safety filter check |
| Deleted accounts not explicitly excluded | Deleted users (soft-deleted) could surface | Added `isDeleted` to item + safety filter check |

---

## 6. Freshness + Seen-Already Controls

- **Past/cancelled events:** `isExpired` and `isCancelled` flags handled in safety filter gates 10 + 11. The item hydrator must set these flags from the DB `status` and date fields.
- **Seen-already suppression:** `compass_served_recommendations` table is populated by the feed route on every serve. The item hydrator loads this to set `repeatCount` which feeds into `repetitionPenalty` in scoring (up to 10 points off). Items are not hard-filtered on repeat; they are downranked via the scoring penalty.
- **Pagination:** `cursor` param supported on `/api/compass/feed` and `/api/compass/feed/section/:section`.

---

## 7. Feature-Flag Kill Switches

All required flags are wired via the `isEnabled()` helper from `flags.ts`. The `COMPASS_ENABLED` master flag is the primary gate. Disabled surfaces return `{ fallback: true, sections: [], disabled: true }` or equivalent shapes. Flags fail-open when the `feature_flags` table has no row (unset = false, but the pipeline falls back gracefully).

Required flags registered for documentation:
- `COMPASS_ENABLED` — master kill switch
- `COMPASS_FEED_ENABLED` — feed surface
- `COMPASS_DISCOVERY` — discovery surface (checked by downstream tasks)
- `COMPASS_SEARCH` — search surface (downstream)
- `COMPASS_TELEGRAPH` — telegraph surface (downstream)
- `COMPASS_AI_INTENT` — AI intent processing (downstream)
- `COMPASS_BUDDY_RECOMMENDATIONS` — buddy recommendations (downstream)
- `COMPASS_PEOPLE_RECOMMENDATIONS` — people recommendations (downstream)
- `COMPASS_ITINERARY` — itinerary builder (downstream)
- `COMPASS_CREATE_SUGGESTIONS` — create-flow suggestions (downstream)
- `COMPASS_FALLBACK_MODE_ENABLED` — force fallback feed globally

---

## 8. Performance Indexes

Added in migration 0105:
- `events(city, starts_at, status, visibility, category)`
- `trips(destination, starts_at, visibility, status)`
- `places(city, category, moderation_status)`
- `profiles(city, languages, verification_status)` (partial via available columns)

---

## 9. What Downstream Surface Tasks Need

### Compass in Discovery + Search
- Call `rankItemsForDiscovery()` from `CompassFeedBuilder` ✅ exists
- Gate on `COMPASS_DISCOVERY` and `COMPASS_SEARCH` flags
- Map discovery items via `CompassDiscoveryAdapter` ✅ exists

### Compass in Trips, Events + Passport
- Item hydrator already loads trip/event items
- Gate on trip context state from `CompassContextEngine`
- Use `during_your_trip` section from FeedBuilder

### Compass Buddy + Traveler Matching
- Buddy items scored via `CompassScoringEngine` with buddy weight profile ✅
- `COMPASS_BUDDY_RECOMMENDATIONS` and `COMPASS_PEOPLE_RECOMMENDATIONS` flags needed
- Fair-exposure engine handles new buddy boosting ✅

### Compass in Telegraph + Pulse Ranking
- Post items scored via `CompassScoringEngine` post weight profile ✅
- Gate on `COMPASS_TELEGRAPH` flag
- SSE/polling pattern stays unchanged; Compass re-ranks already-fetched set

### Compass Feedback Loop, Settings + Onboarding
- `compass_settings` table ✅ added in this task
- `GET/PATCH /api/compass/settings` endpoints ✅ added in this task
- `compass_recent_context` table ✅ added in this task for session persistence
- Onboarding writes initial `compass_settings` row on first login
