#!/usr/bin/env python3
"""
Portava — QA Round 2 fix bundle.

Applies every fix whose root cause was verified against the real source.
Idempotent: a patch whose replacement text is already present is skipped, so
re-running is safe. Nothing is applied unless its exact anchor text is found —
a missing anchor is reported as MISS, never silently guessed.

Usage (from your Replit shell, in the folder this bundle was unzipped into):

    python3 apply.py
    python3 apply.py --root ~/workspace/artifacts     # explicit target
    python3 apply.py --dry-run                        # report only, write nothing

Exit code is 0 when every patch applied or was already present, 1 when any
anchor was missed (hand those to Claude Code — see CLAUDE-CODE-COMMAND.md).
"""
import argparse
import os
import shutil
import sys

BUNDLE = os.path.dirname(os.path.abspath(__file__))
NEW_FILES_SRC = os.path.join(BUNDLE, "files")
DEFAULT_ROOT = os.path.join(os.path.expanduser("~"), "workspace", "artifacts")

TB = "travel-buddy"
API = "api-server"

# ─────────────────────────────────────────────────────────────────────────────
# (relative path under <root>, exact old text, new text, label)
# ─────────────────────────────────────────────────────────────────────────────
PATCHES = [

    # ══ BUG 2 — one progress number, not two ═════════════════════════════════
    # The hero ring read trips.progress (a DB column NO client call site ever
    # writes → always 0). The readiness card read GET /trips/:id/readiness
    # (Math.round(100 * readyish / 7) → 14%). Same page, two numbers.
    (
        f"{TB}/src/components/trip/TripReadinessCard.tsx",
        """interface TripReadinessCardProps {
  tripId: string;
  refresh?: boolean;
}""",
        """interface TripReadinessCardProps {
  tripId: string;
  refresh?: boolean;
  /**
   * QA round 2, bug 2. The trip header's "Trip Progress" ring used to read
   * `trips.progress` — a column no client call site ever writes, so it was
   * permanently 0 — while this card rendered the readiness score (14%). Two
   * gauges on one screen, two different numbers. Reporting the summary upward
   * lets the header render the SAME source. Called with `null` when the
   * readiness feature flag is off or the fetch fails, in which case the header
   * falls back to the legacy column.
   */
  onSummary?: (summary: ReadinessSummary | null) => void;
}""",
        "bug2a: TripReadinessCard — onSummary prop",
    ),
    (
        f"{TB}/src/components/trip/TripReadinessCard.tsx",
        "export function TripReadinessCard({ tripId, refresh = false }: TripReadinessCardProps) {",
        "export function TripReadinessCard({ tripId, refresh = false, onSummary }: TripReadinessCardProps) {",
        "bug2b: TripReadinessCard — accept onSummary",
    ),
    (
        f"{TB}/src/components/trip/TripReadinessCard.tsx",
        "  useEffect(() => { load(refresh); }, [load, refresh]);",
        """  useEffect(() => { load(refresh); }, [load, refresh]);

  // QA round 2, bug 2: hand the loaded summary to the parent so the trip header's
  // progress ring can render the same number this card renders. Keyed on
  // `summary` only on purpose — adding `onSummary` to the deps would re-fire on
  // every parent render whenever the caller passes an inline lambda.
  useEffect(() => {
    if (summary !== undefined) onSummary?.(summary);
  }, [summary]); // eslint-disable-line react-hooks/exhaustive-deps""",
        "bug2c: TripReadinessCard — report summary upward",
    ),
    (
        f"{TB}/app/trip/[id].tsx",
        "import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';",
        """import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import type { ReadinessSummary } from '../../src/services/tripIntel';""",
        "bug2d: trip detail — import ReadinessSummary",
    ),
    (
        f"{TB}/app/trip/[id].tsx",
        "  const [readinessRefresh, setReadinessRefresh] = useState(false);",
        """  const [readinessRefresh, setReadinessRefresh] = useState(false);
  // QA round 2, bug 2: single source of truth for BOTH progress gauges on this
  // page. Populated by TripReadinessCard via onSummary below.
  const [readiness, setReadiness] = useState<ReadinessSummary | null>(null);""",
        "bug2e: trip detail — readiness state",
    ),
    (
        f"{TB}/app/trip/[id].tsx",
        """    progress: realTrip.progress,
    progressSteps: [],""",
        """    // QA round 2, bug 2: prefer the readiness score — it is the only number that
    // actually counts plan items, stay, transport, budget, entry, documents and
    // reservations (api-server/src/lib/tripReadiness.ts). Falls back to the legacy
    // trips.progress column when the readiness flag is off, in which case the card
    // renders nothing and never reports a summary.
    progress: readiness ? readiness.score : (realTrip.progress ?? 0),
    // The hero's checklist was hard-coded to [] — it never rendered a single step.
    // Same order/labels as CATEGORIES in TripReadinessCard.tsx and
    // READINESS_CATEGORIES in api-server/src/lib/tripReadiness.ts.
    progressSteps: readiness
      ? ([
          ['plan', 'Plan'], ['stay', 'Stay'], ['transport', 'Transport'],
          ['budget', 'Budget'], ['entry', 'Entry'], ['documents', 'Documents'],
          ['reservations', 'Reservations'],
        ] as ReadonlyArray<readonly [string, string]>).map(([key, label]) => ({
          label,
          done: readiness.categories?.[key] === 'ready',
        }))
      : [],""",
        "bug2f: trip detail — ring + checklist read readiness",
    ),
    (
        f"{TB}/app/trip/[id].tsx",
        "          <TripReadinessCard tripId={trip.id} refresh={readinessRefresh} />",
        "          <TripReadinessCard tripId={trip.id} refresh={readinessRefresh} onSummary={setReadiness} />",
        "bug2g: trip detail — wire onSummary",
    ),

    # ══ BUG 3 — "No active trip right now" inside a trip's own page ══════════
    (
        f"{TB}/src/components/DailyBriefCard.tsx",
        "  if (access === 'access_denied' || !brief) {",
        """  // QA round 2, bug 3. The server emits a "general" brief whose headline is
  // "No active trip right now — here's some travel inspiration…"
  // (api-server/src/lib/dailyBriefEngine.ts) whenever fetchActiveTripForUser
  // finds no trip starting within 3 days — it is never told WHICH trip page the
  // card is mounted on. Inside a specific trip's own detail page that copy flatly
  // contradicts the screen around it, so stay silent instead.
  //
  // Both call sites of this component are trip-scoped (app/trip/[id].tsx and
  // app/trip/chat.tsx), so suppressing here loses nothing. The proper fix is
  // server-side (scope the brief to the viewed tripId), but that needs the L2
  // cache re-keyed first: briefCacheKey is `${userId}:${date}` and the cache
  // table is UNIQUE (user_id, brief_date), so a trip-scoped brief would serve
  // trip A's brief on trip B's page. Left for a deliberate change.
  if (access === 'access_denied' || !brief || brief.briefType === 'general') {""",
        "bug3: DailyBriefCard — suppress the general-brief fallback",
    ),

    # ══ BUG 5 — "Required" that names no field and strands the user ══════════
    (
        f"{TB}/app/events/create/index.tsx",
        """    if (dtErr) { setError(`Date & Time: ${dtErr.message}`); return; }
    setSaving(true);""",
        """    if (dtErr) { setError(`Date & Time: ${dtErr.message}`); return; }

    // QA round 2, bug 5. PublishDraftSchema (api-server/src/routes/events.ts)
    // requires title, startsAt and locationName — but buildPayload() drops empty
    // strings with `|| undefined`, so the key never reaches the server and zod
    // answers with a bare "Required" that names no field. The user was left on
    // step 9 (Preview) with no idea that step 3 (Location) was the problem.
    // Validate here, name the field, and jump the wizard to the owning step.
    if (!title.trim()) {
      setError('Title is required.');
      setStep('basics');
      return;
    }
    if (!startDate) {
      setError('Start date & time are required.');
      setStep('datetime');
      return;
    }
    if (!locationName.trim()) {
      setError('Venue or location is required — pick a place on the Location step.');
      setStep('location');
      return;
    }

    setSaving(true);""",
        "bug5a: event wizard — named pre-publish validation + step jump",
    ),
    (
        f"{TB}/app/events/create/index.tsx",
        "              <Text style={styles.label}>Venue or location</Text>",
        """              {/* QA round 2, bug 5: the server requires this field; the form never said so. */}
              <Text style={styles.label}>Venue or location *</Text>""",
        "bug5b: event wizard — required marker on Venue",
    ),
    (
        f"{API}/src/routes/events.ts",
        '  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid event data"); return; }',
        """  // QA round 2, bug 5: the zod issue's `path` was being thrown away, so the
  // client received a bare "Required" with no indication of WHICH field. Prefix
  // the field path so any future validation gap is self-describing.
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.join(".");
    sendError(
      res,
      "invalid_payload",
      issue ? `${field ? `${field}: ` : ""}${issue.message}` : "Invalid event data",
    );
    return;
  }""",
        "bug5c: server — name the failing field in publish validation",
    ),

    # ══ BUG 6 — venue picker clobbers a manually typed city ══════════════════
    (
        f"{TB}/app/events/create/index.tsx",
        """                onSelect={(place) => {
                  setLocationName(place.displayName);
                  if (place.city) setCity(place.city);
                  if (place.country) setCountry(place.country);
                  if (place.lat != null) setLocationLat(place.lat);""",
        """                onSelect={(place) => {
                  setLocationName(place.displayName);
                  // QA round 2, bug 6: only auto-fill City/Country when the user has
                  // not typed their own. Picking a venue used to silently overwrite
                  // a manually entered city with the picker's guess.
                  if (place.city && !city.trim()) setCity(place.city);
                  if (place.country && !country.trim()) setCountry(place.country);
                  if (place.lat != null) setLocationLat(place.lat);""",
        "bug6a: event wizard — don't clobber typed city/country",
    ),
    (
        f"{TB}/src/components/EventComposerSheet.tsx",
        """                    setLocationName(place.displayName);
                    if (place.city) setCity(place.city);
                    if (place.country) setCountry(place.country);
                    setLocationPickerVisible(false);""",
        """                    setLocationName(place.displayName);
                    // QA round 2, bug 6 (same defect as app/events/create/index.tsx):
                    // never overwrite a city/country the user typed themselves.
                    if (place.city && !city.trim()) setCity(place.city);
                    if (place.country && !country.trim()) setCountry(place.country);
                    setLocationPickerVisible(false);""",
        "bug6b: EventComposerSheet — don't clobber typed city/country",
    ),

    # ══ BUG 7 — "Cebu City, Philippines, Cebu City" ══════════════════════════
    # place.displayName already contains the city; six call sites appended it again.
    (
        f"{TB}/app/events/create/index.tsx",
        "import { uploadMedia, validateMedia } from '../../../src/services/media';",
        """import { uploadMedia, validateMedia } from '../../../src/services/media';
import { formatEventLocation } from '../../../src/lib/location/formatEventLocation';""",
        "bug7a: event wizard — import formatEventLocation",
    ),
    (
        f"{TB}/app/events/create/index.tsx",
        "                    <Text style={styles.reviewMeta}>{locationName}{city ? `, ${city}` : ''}</Text>",
        "                    <Text style={styles.reviewMeta}>{formatEventLocation(locationName, city)}</Text>",
        "bug7b: event wizard preview — dedupe location string",
    ),
    (
        f"{TB}/src/components/EventComposerSheet.tsx",
        "import { color, space, radius, type as t } from '../theme/tokens.ts';",
        """import { color, space, radius, type as t } from '../theme/tokens.ts';
import { formatEventLocation } from '../lib/location/formatEventLocation.ts';""",
        "bug7c: EventComposerSheet — import formatEventLocation",
    ),
    (
        f"{TB}/src/components/EventComposerSheet.tsx",
        "                      <Text style={s.reviewMeta}>{locationName}{city ? `, ${city}` : ''}</Text>",
        "                      <Text style={s.reviewMeta}>{formatEventLocation(locationName, city)}</Text>",
        "bug7d: EventComposerSheet preview — dedupe location string",
    ),
    # bug7e / bug7f / bug7g — DROPPED. app/event/[id].tsx already has its own
    # `formatEventLocationLine` (line 83) with the same dedupe intent, plus a
    # component test (app/event/__tests__/EventDetail.locationDedup.component.test.tsx).
    # openMap() passes `name: locationName` with no city concat, so the maps
    # deep-link never had the duplication either. Nothing to fix.
    (
        f"{TB}/app/events/invites.tsx",
        "import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';",
        """import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import { formatEventLocation } from '../../src/lib/location/formatEventLocation';""",
        "bug7h: event invites — import formatEventLocation",
    ),
    (
        f"{TB}/app/events/invites.tsx",
        """                        <Text style={styles.metaText} numberOfLines={1}>
                          {ev.locationName}{ev.city ? `, ${ev.city}` : ''}
                        </Text>""",
        """                        <Text style={styles.metaText} numberOfLines={1}>
                          {formatEventLocation(ev.locationName, ev.city)}
                        </Text>""",
        "bug7i: event invites — dedupe location string",
    ),
    # bug7j / bug7k — DROPPED, and 7j would have BROKEN the build. The file already
    # declares `const formatEventLocation` locally (line 36, delegating to the shared
    # formatLocationLabel util) and already calls it at line 225. Adding an import of
    # the same name is a duplicate-identifier error.

    # ══ BUG 8 — passport header keeps the old bio after saving ═══════════════
    # NOT a query-cache problem: this app has zero React Query usage
    # (@tanstack/react-query is in package.json with no non-test importer).
    # The real cause is the 5-minute focus TTL guard in app/(tabs)/passport.tsx.
    (
        f"{TB}/src/hooks/usePassport.ts",
        "export interface PassportState {",
        """/**
 * QA round 2, bug 8 — cross-screen profile staleness signal.
 *
 * Saving the identity editor DID persist the new bio (reopening the editor showed
 * it), but the passport header kept the old one because the focus refetch in
 * app/(tabs)/passport.tsx is suppressed while the data is younger than
 * FEED_FOCUS_TTL_MS (5 minutes) — a deliberate anti-scroll-jump guard.
 *
 * There is no query cache to invalidate here (@tanstack/react-query is listed in
 * package.json but has no non-test importer; all state is useState inside bespoke
 * hooks), so this follows the pub/sub convention the codebase already uses for
 * exactly this problem: src/lib/commentCountStore.ts.
 */
let profileStaleAt = 0;

/** Call after any write that changes what the passport header renders. */
export function markProfileStale(): void {
  profileStaleAt = Date.now();
}

/** True when a stale mark landed after the given load timestamp. */
export function isProfileStaleSince(loadedAt: number): boolean {
  return profileStaleAt > loadedAt;
}

export interface PassportState {""",
        "bug8a: usePassport — module-level staleness signal",
    ),
    (
        f"{TB}/app/(tabs)/passport.tsx",
        "import { usePassport } from '../../src/hooks/usePassport';",
        "import { usePassport, isProfileStaleSince } from '../../src/hooks/usePassport';",
        "bug8b: passport — import isProfileStaleSince",
    ),
    (
        f"{TB}/app/(tabs)/passport.tsx",
        "    if (Date.now() - lastLoadedAt.current >= FEED_FOCUS_TTL_MS) {",
        """    // QA round 2, bug 8: the TTL alone kept a just-saved bio invisible for up to
    // five minutes. isProfileStaleSince lets a profile write force the next
    // focus refetch without weakening the guard for ordinary tab re-entry.
    if (Date.now() - lastLoadedAt.current >= FEED_FOCUS_TTL_MS
        || isProfileStaleSince(lastLoadedAt.current)) {""",
        "bug8c: passport — honour the staleness signal in the focus guard",
    ),
    (
        f"{TB}/app/profile/edit/identity.tsx",
        "import type { OwnProfile } from '../../../src/types/models';",
        """import type { OwnProfile } from '../../../src/types/models';
import { markProfileStale } from '../../../src/hooks/usePassport';""",
        "bug8d: identity editor — import markProfileStale",
    ),
    (
        f"{TB}/app/profile/edit/identity.tsx",
        """      setProfile(res.data);
      setOriginalForm(form);
      savedThenBack();""",
        """      setProfile(res.data);
      setOriginalForm(form);
      // QA round 2, bug 8: setProfile above is this screen's OWN useState — it
      // does not touch usePassport(). Tell the passport screen to bypass its
      // 5-minute focus TTL so the header shows the bio we just saved.
      markProfileStale();
      savedThenBack();""",
        "bug8e: identity editor — mark the profile stale on save",
    ),

    # ══ BUG 9 + 10 — Pulse filters ══════════════════════════════════════════
    (
        f"{TB}/app/(tabs)/index.tsx",
        "const QUICK_FILTERS: PulseFilter[] = ['All', 'Plans', 'Posts', 'Questions', 'Hidden Gems', 'Itineraries', 'Circle'];",
        """const QUICK_FILTERS: PulseFilter[] = ['All', 'Plans', 'Posts', 'Questions', 'Hidden Gems', 'Itineraries', 'Circle'];

/**
 * QA round 2, bugs 9 and 10.
 *
 * Bug 10 first, because it explains bug 9's symptom. QUICK_FILTERS is a strict
 * subset of PULSE_FILTERS (src/types/models.ts), which also offers Food,
 * Nightlife, Beach, Culture, Fits My Time and Open Now. Both the chip row and the
 * filter sheet write the SAME state (`active`) through byte-identical toggles, so
 * they were never actually out of sync — the chip row simply had no chip to
 * highlight for a sheet-only filter, which reads as "sheet says Food, chips say
 * All". `visibleFilters` in the component appends any active sheet-only filter to
 * the chip row so it is visible and dismissible.
 *
 * Bug 9: the feed's filter step was `realItems.filter(() => false)` for every
 * filter except All and Posts — an unconditional empty list. That is the blank
 * wall. Real matching lives below.
 *
 * Note on the "just send the filter to the server" fix: it does not work.
 * api-server/src/routes/pulse.ts types `tab` as
 * z.enum(['all','city','nearby','neighborhood','trip','crew','airport']) — those
 * are VISIBILITY scopes, not content categories — so `tab=food` is rejected as
 * invalid_payload. Category filtering has to happen client-side.
 */
const FILTER_TYPES: Partial<Record<PulseFilter, ReadonlyArray<PulseFeedItem['type']>>> = {
  Posts:         ['post'],
  Questions:     ['question'],
  Plans:         ['plan'],
  'Hidden Gems': ['hidden_gem'],
  Itineraries:   ['itinerary'],
  Circle:        ['circle_activity'],
};

/**
 * Category filters have no column of their own on PulseFeedItem — they match
 * against `tags`, which is what the category stamp on each card renders from.
 */
const FILTER_TAGS: Partial<Record<PulseFilter, ReadonlyArray<string>>> = {
  Food:      ['food', 'foodie', 'eat', 'eats', 'restaurant', 'cafe', 'coffee', 'dining', 'street food'],
  Nightlife: ['nightlife', 'night', 'bar', 'bars', 'club', 'clubs', 'party', 'drinks'],
  Beach:     ['beach', 'beaches', 'island', 'islands', 'sea', 'ocean', 'swim', 'surf', 'coast', 'diving', 'snorkel'],
  Culture:   ['culture', 'cultural', 'museum', 'museums', 'temple', 'church', 'heritage', 'history', 'historic', 'art', 'gallery'],
};

function pulseItemMatchesFilter(item: PulseFeedItem, filter: PulseFilter): boolean {
  if (filter === 'All') return true;
  const types = FILTER_TYPES[filter];
  if (types) return types.includes(item.type);
  const wanted = FILTER_TAGS[filter];
  if (wanted) {
    const tags = (item.tags ?? []).map((tag) => tag.trim().toLowerCase());
    return wanted.some((w) => tags.includes(w));
  }
  // 'Fits My Time' and 'Open Now' are availability filters and PulseFeedItem
  // carries no client-side signal for either. Leave the feed untouched rather
  // than blanking the wall — an empty result the user cannot explain is the
  // exact failure this bug was about.
  return true;
}""",
        "bug9a/10a: Pulse — real filter matching helpers",
    ),
    (
        f"{TB}/app/(tabs)/index.tsx",
        """    const filteredReal = active.includes('All') || active.includes('Posts')
      ? realItems
      : realItems.filter(() => false);""",
        """    // QA round 2, bug 9: was `realItems.filter(() => false)` for every filter
    // other than All/Posts — i.e. the Food filter could only ever return nothing.
    const filteredReal = active.includes('All')
      ? realItems
      : realItems.filter((it) => active.some((f) => pulseItemMatchesFilter(it, f)));""",
        "bug9b: Pulse — apply the selected filters instead of emptying the feed",
    ),
    (
        f"{TB}/app/(tabs)/index.tsx",
        """    if (!rentBuddyEnabled || feedMode === 'following') {
      result = baseFeed;""",
        """    // QA round 2, bug 9: the synthetic rent_a_buddy card was injected even into an
    // EMPTY feed, so `feed.length` was never 0 and the "No results for these
    // filters" empty state below could never render — the user saw a blank wall
    // with one promo card and no explanation. Skip the injection when there is
    // nothing to interleave it with.
    if (!rentBuddyEnabled || feedMode === 'following' || baseFeed.length === 0) {
      result = baseFeed;""",
        "bug9c: Pulse — let the empty state render",
    ),
    (
        f"{TB}/app/(tabs)/index.tsx",
        "  const filterCount = active.filter((f) => f !== 'All').length;",
        """  const filterCount = active.filter((f) => f !== 'All').length;
  // QA round 2, bug 10: surface any active sheet-only filter (Food, Nightlife,
  // Beach, Culture, Fits My Time, Open Now) in the chip row, so the two filter
  // UIs visibly agree and the filter can be cleared from either one.
  const visibleFilters = useMemo<PulseFilter[]>(
    () => [...QUICK_FILTERS, ...active.filter((f) => !QUICK_FILTERS.includes(f))],
    [active],
  );""",
        "bug10b: Pulse — visibleFilters union",
    ),
    (
        f"{TB}/app/(tabs)/index.tsx",
        "          data={QUICK_FILTERS}",
        "          data={visibleFilters}",
        "bug10c: Pulse — chip row renders the union",
    ),

    # ══ BUG 11 — video posts fail silently ══════════════════════════════════
    (
        f"{TB}/src/components/ui/VideoThumbnail.tsx",
        "import React from 'react';",
        "import React, { useEffect, useState } from 'react';",
        "bug11a: VideoThumbnail — import useEffect/useState",
    ),
    (
        f"{TB}/src/components/ui/VideoThumbnail.tsx",
        """  const effectivePosterUri = posterUri
    ? (hydratedMap[posterUri] === null ? null : (hydratedMap[posterUri] ?? posterUri))
    : null;""",
        """  const effectivePosterUri = posterUri
    ? (hydratedMap[posterUri] === null ? null : (hydratedMap[posterUri] ?? posterUri))
    : null;

  // QA round 2, bug 11: a poster that fails to decode — most often because the
  // caller passed the .mp4 URL itself as the poster — left expo-image rendering
  // nothing over the dark container. That is the "silent black tile" QA saw.
  // Fall back to the visible placeholder (which still shows the play triangle).
  // The reset is load-bearing: these render inside recycled FlatList rows, so
  // without it one dead poster would poison every later item reusing the row.
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => { setPosterFailed(false); }, [effectivePosterUri]);""",
        "bug11b: VideoThumbnail — poster failure state + reset on source change",
    ),
    (
        f"{TB}/src/components/ui/VideoThumbnail.tsx",
        "      {effectivePosterUri ? (",
        "      {effectivePosterUri && !posterFailed ? (",
        "bug11b2: VideoThumbnail — fall back to the placeholder on poster failure",
    ),
    (
        f"{TB}/src/components/ui/VideoThumbnail.tsx",
        """        <Image
          source={{ uri: effectivePosterUri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
          pointerEvents="none"
        />""",
        """        <Image
          source={{ uri: effectivePosterUri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
          pointerEvents="none"
          onError={() => setPosterFailed(true)}
        />""",
        "bug11b3: VideoThumbnail — surface the decode failure",
    ),
    (
        f"{TB}/src/components/PulseFeedCard.tsx",
        # NOTE: the `onPress` half of the original bug11c is DELIBERATELY dropped.
        # The live tree already routes the media block (PulseFeedCard.tsx:391,
        # `onPress={handleMediaCardPress}`), and VideoThumbnail.tsx:46-53 documents
        # that a nested Pressable steals the touch responder — adding one here
        # would break tap-to-open and double-tap-to-stamp. Poster fix only.
        """            posterUri={item.media[0].thumbnail_url ?? item.media[0].url}""",
        """            posterUri={item.media[0].thumbnail_url ?? null}""",
        "bug11c: PulseFeedCard — never poster a video tile from the .mp4 URL",
    ),
    (
        f"{TB}/src/components/HighlightViewer.tsx",
        """  const [isMuted, setIsMuted] = useState(false);""",
        """  const [isMuted, setIsMuted] = useState(false);
  // QA round 2, bug 11: a highlight whose video fails to load used to sit on a
  // black frame with a progress bar that never moved and no way to tell why.
  const [videoError, setVideoError] = useState(false);""",
        "bug11d: HighlightViewer — video error state",
    ),
    (
        f"{TB}/src/components/HighlightViewer.tsx",
        """  useEffect(() => {
    if (isVideo) setProgress(0);
  }, [index, isVideo]);""",
        """  useEffect(() => {
    if (isVideo) setProgress(0);
    setVideoError(false); // QA round 2, bug 11: clear per item.
  }, [index, isVideo]);""",
        "bug11e: HighlightViewer — reset error per item",
    ),
    (
        f"{TB}/src/components/HighlightViewer.tsx",
        """  const handleVideoStatus = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;""",
        """  const handleVideoStatus = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) {
      // QA round 2, bug 11: the failure branch of AVPlaybackStatus was being
      // swallowed by this bare early return. Surface it instead.
      if ((status as { error?: string }).error) setVideoError(true);
      return;
    }""",
        "bug11f: HighlightViewer — stop swallowing playback failures",
    ),
    (
        f"{TB}/src/components/HighlightViewer.tsx",
        """            onEnded={() => goNextRef.current()}
          />""",
        """            onEnded={() => goNextRef.current()}
            onError={() => setVideoError(true)} // QA round 2, bug 11
          />""",
        "bug11g: HighlightViewer — web <video> onError",
    ),
    (
        f"{TB}/src/components/HighlightViewer.tsx",
        """        {/* Progress bars */}""",
        """        {/* QA round 2, bug 11: tell the user the video failed instead of
            showing an indefinitely black frame. */}
        {videoError && (
          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="none">
            <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '600', textAlign: 'center', paddingHorizontal: 24 }}>
              Video unavailable
            </Text>
          </View>
        )}

        {/* Progress bars */}""",
        "bug11h: HighlightViewer — 'Video unavailable' overlay",
    ),

    # ══ BUG 14 — layover accepts a fully-past time window (SERVER) ═══════════
    # Shipped in the earlier qa-round2 bundle as a standalone script. Repeated
    # here so this bundle is self-contained. The inserted text is byte-identical
    # to what that script produced (no added comment), so the `new in text`
    # idempotency check recognises an already-patched file and skips it —
    # otherwise re-running would append a SECOND copy of the guard.
    (
        f"{API}/src/routes/airport.ts",
        """  if (departureMs <= arrivalMs) {
    sendError(res, "invalid_payload", "Departure must be after arrival");
    return;
  }""",
        """  if (departureMs <= arrivalMs) {
    sendError(res, "invalid_payload", "Departure must be after arrival");
    return;
  }
  if (departureMs <= Date.now()) {
    sendError(res, "invalid_payload", "This layover has already departed — set a departure time in the future");
    return;
  }""",
        "bug14: airport sessions — reject a departure that is already in the past",
    ),

    # ══ BUG 15 — stale layover validation error / pre-selected look ══════════
    (
        f"{TB}/src/components/layover/LayoverModeSheet.tsx",
        """  const selectAirport = (ap: AirportProfile) => {
    setAirport(ap);
    setResults([]);""",
        """  const selectAirport = (ap: AirportProfile) => {
    setAirport(ap);
    // QA round 2, bug 15: "Pick your airport from the search results…" was only
    // cleared on the next submit (first line of handleCreate), so it stayed on
    // screen after the airport had been picked. Clear it the moment a selection
    // lands.
    setError(null);
    setResults([]);""",
        "bug15a: LayoverModeSheet — clear the error on selection",
    ),
    (
        f"{TB}/src/components/layover/LayoverModeSheet.tsx",
        "  iataBadge:    { backgroundColor: color.ink, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4, minWidth: 46, alignItems: 'center' },\n  iataBadgeText:{ ...t.stamp, color: color.onInk },",
        """  // QA round 2, bug 15b: a solid color.ink fill is this sheet's SELECTED state
  // (see segmentActive / chipActive below), so an unselected search result read
  // as already-picked. Outlined until it is actually chosen.
  iataBadge:    { backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4, minWidth: 46, alignItems: 'center' },
  iataBadgeText:{ ...t.stamp, color: color.ink },""",
        "bug15b: LayoverModeSheet — result badge no longer looks pre-selected",
    ),

    # ══ MINOR A — mislinked privacy settings route ═══════════════════════════
    (
        f"{TB}/app/(tabs)/passport.tsx",
        "        onPrivacySettings={() => openSettings('safety')}",
        """        onPrivacySettings={() => {
          // QA round 2, minor A: 'safety' routes to /profile/edit/safety
          // ("Safety & Verification"). This link is labelled PRIVACY SETTINGS,
          // which is 'passport' -> /profile/edit/privacy ("Privacy & Visibility").
          openSettings('passport');
        }}""",
        "minorA: passport — PRIVACY SETTINGS opens Privacy & Visibility",
    ),

    # ══ MINOR D — past-dated event still badged "Open" ══════════════════════
    # minorD itself is DROPPED — already fixed in the live tree, and fixed better
    # than my version. EventDiscoveryCard.tsx:94 already calls the shared
    # `effectiveEventState(event.state, event.startsAt, event.endsAt)` helper
    # (src/lib/eventRoleActions.ts:50) and derives stateColor/stateLabel from the
    # resulting `displayState`; STATE_COLOR and STATE_LABEL both carry a
    # 'completed' key. My patch would have inlined the same logic into the
    # component. Only the RSVP-gating half is still missing.
    (
        f"{TB}/src/components/EventDiscoveryCard.tsx",
        "  const isOpen = ['open', 'started'].includes(event.state);",
        """  // QA round 2, minor D: an ended event must not still offer RSVP. `displayState`
  // (line 94) is `effectiveEventState(...)`, which returns 'completed' once endsAt
  // has passed, so gating on it drops the CTA without touching the stored state.
  const isOpen = ['open', 'started'].includes(displayState);""",
        "minorD2: EventDiscoveryCard — no RSVP CTA on ended events",
    ),

    # ══ MINOR F — raw browser confirm() on web ══════════════════════════════
    (
        f"{TB}/app/layover/[id].tsx",
        "import { color, space, radius, type as t } from '../../src/theme/tokens';",
        """import { color, space, radius, type as t } from '../../src/theme/tokens';
import { ConfirmSheet } from '../../src/components/ui/ConfirmSheet';""",
        "minorF1: layover — import ConfirmSheet",
    ),
    (
        f"{TB}/app/layover/[id].tsx",
        "  const [endBusy, setEndBusy] = useState(false);",
        """  const [endBusy, setEndBusy] = useState(false);
  // QA round 2, minor F: drives the in-app confirm on web (see confirmEnd).
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);""",
        "minorF2: layover — confirm sheet state",
    ),
    (
        f"{TB}/app/layover/[id].tsx",
        """  const confirmEnd = useCallback(() => {
    const doEnd = async () => {
      if (!id) return;
      setEndBusy(true);
      try {
        const ok = await endLayoverSession(id);
        if (ok) {
          await cancelScheduledNotification(notifIdRef.current);
          router.back();
        } else {
          showToast('Could not end the layover');
        }
      } finally {
        setEndBusy(false);
      }
    };
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm('End this layover? Your plan stays saved.')) doEnd();
    } else {
      Alert.alert('End layover?', 'Your plan stays saved in your history.', [
        { text: 'Keep going', style: 'cancel' },
        { text: 'End layover', style: 'destructive', onPress: doEnd },
      ]);
    }
  }, [id, router, showToast]);""",
        """  const doEndLayover = useCallback(async () => {
    if (!id) return;
    setEndConfirmOpen(false);
    setEndBusy(true);
    try {
      const ok = await endLayoverSession(id);
      if (ok) {
        await cancelScheduledNotification(notifIdRef.current);
        router.back();
      } else {
        showToast('Could not end the layover');
      }
    } finally {
      setEndBusy(false);
    }
  }, [id, router, showToast]);

  const confirmEnd = useCallback(() => {
    // QA round 2, minor F: the web path used a raw window.confirm(), which drops
    // the user out of the app's visual language and blocks the JS thread while
    // it is open. ConfirmSheet is the in-app equivalent. Native keeps the OS
    // alert, which is the platform idiom.
    if (Platform.OS === 'web') {
      setEndConfirmOpen(true);
    } else {
      Alert.alert('End layover?', 'Your plan stays saved in your history.', [
        { text: 'Keep going', style: 'cancel' },
        { text: 'End layover', style: 'destructive', onPress: doEndLayover },
      ]);
    }
  }, [doEndLayover]);""",
        "minorF3: layover — replace window.confirm with ConfirmSheet",
    ),
    (
        f"{TB}/app/layover/[id].tsx",
        """      {toast && (
        <View style={[styles.toast, { bottom: insets.bottom + (canEdit ? 108 : 24) }]}>""",
        """      <ConfirmSheet
        visible={endConfirmOpen}
        title="End this layover?"
        body="Your plan stays saved in your history."
        confirmLabel="End layover"
        loadingLabel="Ending…"
        destructive
        loading={endBusy}
        onConfirm={doEndLayover}
        onCancel={() => setEndConfirmOpen(false)}
      />

      {toast && (
        <View style={[styles.toast, { bottom: insets.bottom + (canEdit ? 108 : 24) }]}>""",
        "minorF4: layover — render ConfirmSheet",
    ),
]


def copy_new_files(root, dry_run):
    if not os.path.isdir(NEW_FILES_SRC):
        return 0
    copied = 0
    for dirpath, _, names in os.walk(NEW_FILES_SRC):
        for name in names:
            src = os.path.join(dirpath, name)
            rel = os.path.relpath(src, NEW_FILES_SRC)
            dst = os.path.join(root, rel)
            existed = os.path.exists(dst)
            if not dry_run:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
            print(f"  {'~ overwrite' if existed else '+ new      '}  {rel}")
            copied += 1
    return copied


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT,
                    help="the artifacts dir containing travel-buddy/ and api-server/")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    root = os.path.abspath(os.path.expanduser(args.root))

    if not os.path.isdir(os.path.join(root, TB)):
        print(f"! {root} does not contain {TB}/ — pass the right --root")
        sys.exit(1)

    print(f"Portava QA round 2 — applying to {root}\n")
    print("New files")
    copy_new_files(root, args.dry_run)

    print("\nPatches")
    applied = skipped = missed = 0
    cache = {}
    misses = []
    for rel, old, new, label in PATCHES:
        path = os.path.join(root, rel)
        if not os.path.exists(path):
            print(f"  MISS  {label}\n        file not found: {rel}")
            missed += 1
            misses.append(label)
            continue
        text = cache.get(path)
        if text is None:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
        if new in text:
            print(f"  ==    {label}  (already applied)")
            skipped += 1
            cache[path] = text
            continue
        count = text.count(old)
        if count == 0:
            print(f"  MISS  {label}\n        anchor not found in {rel}")
            missed += 1
            misses.append(label)
            cache[path] = text
            continue
        if count > 1:
            print(f"  MISS  {label}\n        anchor is ambiguous ({count} matches) in {rel}")
            missed += 1
            misses.append(label)
            cache[path] = text
            continue
        cache[path] = text.replace(old, new, 1)
        print(f"  OK    {label}")
        applied += 1

    if not args.dry_run:
        for path, text in cache.items():
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)

    print(f"\n{applied} applied · {skipped} already present · {missed} missed")
    if misses:
        print("\nMissed (hand these to Claude Code — see CLAUDE-CODE-COMMAND.md):")
        for m in misses:
            print(f"  - {m}")
    print("\nVerify:")
    print("  cd ~/workspace/artifacts/travel-buddy && npx tsc -p tsconfig.json --noEmit")
    print("  cd ~/workspace/artifacts/api-server   && npx tsc -p tsconfig.json --noEmit")
    print("  # NEVER run tsc from ~/workspace itself — the root tsconfig extends")
    print("  # expo/tsconfig.base and sweeps client .tsx files into the server")
    print("  # program, producing ~1185 bogus TS1382/TS17008 errors.")
    sys.exit(1 if misses else 0)


if __name__ == "__main__":
    main()
