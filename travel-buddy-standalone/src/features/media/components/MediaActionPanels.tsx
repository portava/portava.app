/**
 * MediaActionPanels — the in-rail steps behind three census-media §21 actions
 * that need one choice from the user before anything is written:
 *
 *   • TripChoicePanel — Do This Experience (§15.2). The compiled plan is shown
 *     stop by stop with its times, and the user picks ONE of the trips the
 *     server named as eligible. Nothing is written until they do, and the items
 *     land TENTATIVE (applyCompiledPlan) — a proposal the crew can move.
 *   • InvitePanel — Invite people (§15). Search a traveller, invite them to the
 *     Shared Moment this media belongs to. The server is the only witness that
 *     the invite landed, so the §44 `invite_sent` signal is recorded there, not
 *     here.
 *   • ContributePanel — Update this gem (§16.3). The gem's own contribution
 *     section, carrying the media id so the server can attribute §45 Media →
 *     Contribution when — and only when — the contribution is accepted.
 *
 * Plus the rail's executors for Go There and Save Route (device + network
 * wiring around the pure helpers in services/mediaActions.ts), the Telegraph
 * object-reference share sheet, and the icons for the §21 action ids.
 *
 * Pure presentational + one service call each; every failure is shown as a
 * plain sentence, never swallowed into a fake success.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, TextInput, Linking, Platform } from 'react-native';
import {
  ChevronLeft,
  Check,
  CornerUpRight,
  CalendarDays,
  BookOpen,
  Volume1, Volume2,
  Wallet,
  Gem,
  UserPlus,
  Moon,
  Route,
  CalendarCheck,
  type LucideIcon,
} from 'lucide-react-native';

import { color, space, radius, type as t, icon as iconToken } from '../../../theme/tokens.ts';
import { fetchPlanEditableTrips, createPlanItem, type EditableTripRow } from '../../trips/planning/tripPlan.ts';
import { searchUsers, type TravelerSearchResult } from '../../../services/follows.ts';
import { inviteToSharedMoment } from '../../../services/sharedMoments.ts';
import {
  applyCompiledPlan,
  openDirectionsForPlace,
  saveMediaRoute,
  linkMediaToEvent,
  type DirectionsOutcome,
  type SaveMediaRouteResult,
} from '../services/mediaActions.ts';
import type { CompiledExperiencePlan, LinkableEventRef, MediaActionId, RouteStopRef } from '../types/mediaActions.ts';
import { getPlaceLiving, getCanonicalPlace } from '../../../services/places.ts';
import { createRoutePlan } from '../../../services/routePlan.ts';
import { recordMediaShare } from '../../../services/mediaInteractions.ts';
import { ShareSheet } from '../../../components/ShareSheet.tsx';
import { GemContributeSection } from '../../../components/gems/GemContributeSection.tsx';

/** Icons for the census-media §21 action ids (the rail spreads these into its map). */
export const SECTION21_ACTION_ICONS = {
  directions: CornerUpRight,
  view_event: CalendarDays,
  view_passport: BookOpen,
  find_quieter: Volume1,
  find_cheaper: Wallet, find_busier: Volume2,
  contribute_gem: Gem,
  invite_people: UserPlus,
  follow_this_night: Moon,
  save_route: Route,
  link_event: CalendarCheck,
} satisfies Partial<Record<MediaActionId, LucideIcon>>;

/** Go There on this device: the Places page's directions, opened in the maps app. */
export function openRailDirections(placeId: string, onOpened: () => void): Promise<DirectionsOutcome> {
  return openDirectionsForPlace(placeId, {
    platform: Platform.OS,
    loadDirections: async (id) => (await getPlaceLiving(id))?.directionsUrl ?? null,
    openUrl: (url) => Linking.openURL(url),
    onOpened,
  });
}

/** Save Route on this device: stops completed through the canonical place record. */
export function saveRailRoute(input: {
  title: string;
  stops: RouteStopRef[];
  mediaId: string | null;
}): Promise<SaveMediaRouteResult> {
  return saveMediaRoute(input, {
    resolveCoords: async (placeId) => (await getCanonicalPlace(placeId))?.coordinates ?? null,
    createRoute: (payload) => createRoutePlan(payload),
  });
}

function BackRow({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <Pressable onPress={onBack} style={s.back} accessibilityRole="button" accessibilityLabel="Back to actions">
      <ChevronLeft size={iconToken.s18} color={color.mute} strokeWidth={1.8} />
      <Text style={s.backLabel}>{label}</Text>
    </Pressable>
  );
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── Do This Experience: choose the trip ───────────────────────────────────────

export function TripChoicePanel({
  plan,
  onBack,
  onApplied,
}: {
  plan: CompiledExperiencePlan;
  onBack: () => void;
  onApplied: (tripId: string) => void;
}) {
  const [trips, setTrips] = useState<EditableTripRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyTrip, setBusyTrip] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchPlanEditableTrips()
      .then((rows) => {
        if (!live) return;
        // Only the trips the SERVER named — its gate is the plan endpoint's own.
        setTrips(rows.filter((r) => plan.eligibleTripIds.includes(r.id)));
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [plan]);

  const choose = useCallback(
    async (tripId: string) => {
      if (busyTrip) return;
      setBusyTrip(tripId);
      const { created, failed } = await applyCompiledPlan(plan, tripId, createPlanItem);
      setBusyTrip(null);
      if (created === 0) {
        setResult('Nothing was added — the trip refused these stops.');
        return;
      }
      setResult(failed > 0 ? `Added ${created} of ${created + failed} stops.` : null);
      onApplied(tripId);
    },
    [busyTrip, plan, onApplied],
  );

  return (
    <View>
      <BackRow label={plan.source.title ?? 'Do this experience'} onBack={onBack} />
      {plan.stops.map((st) => (
        <View key={`${st.order}-${st.sourceId}`} style={s.stop}>
          <Text style={s.stopTime}>{hhmm(st.startsAt)}</Text>
          <Text style={s.stopTitle} numberOfLines={1}>{st.title}</Text>
        </View>
      ))}
      <Text style={s.caption}>
        {plan.feasibility === 'verified'
          ? 'Added as tentative stops you can move.'
          : 'Times are a first draft — opening hours were not checked. Added as tentative stops you can move.'}
      </Text>
      <Text style={s.section}>Add to which trip?</Text>
      {loadError ? (
        <Text style={s.caption}>Couldn’t read your trips. Try again later.</Text>
      ) : trips === null ? (
        <ActivityIndicator size="small" color={color.mute} />
      ) : trips.length === 0 ? (
        <Text style={s.caption}>None of your trips can take this plan.</Text>
      ) : (
        trips.map((trip) => (
          <Pressable
            key={trip.id}
            style={({ pressed }) => [s.row, pressed && s.rowPressed]}
            onPress={() => void choose(trip.id)}
            accessibilityRole="button"
            accessibilityLabel={`Add to ${trip.title}`}
          >
            <Text style={s.rowLabel} numberOfLines={1}>{trip.title}</Text>
            {busyTrip === trip.id ? <ActivityIndicator size="small" color={color.mute} /> : null}
          </Pressable>
        ))
      )}
      {result ? <Text style={s.caption}>{result}</Text> : null}
    </View>
  );
}

// ── Invite people ─────────────────────────────────────────────────────────────

export function InvitePanel({
  momentId,
  mediaId,
  onBack,
}: {
  momentId: string;
  mediaId: string | null;
  onBack: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TravelerSearchResult[]>([]);
  const [searching, setSearching] = useState(false); const [outcome, setOutcome] = useState<'idle' | 'ok' | 'failed'>('idle'); const seqRef = useRef(0); // census-discovery §106 (tm-people): what the latest search came to; its generation
  const [state, setState] = useState<Record<string, 'sending' | 'sent' | 'failed'>>({});
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const onChange = useCallback((q: string) => {
    setQuery(q); const seq = ++seqRef.current; setOutcome('idle'); // a new query: whatever is in flight answers a question no longer asked
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) {
      setResults([]); setSearching(false);
      return;
    }
    debounce.current = setTimeout(() => {
      setSearching(true);
      searchUsers(q.trim(), 10)
        .then((r) => { if (seq !== seqRef.current) return; if (r.ok && r.data) { setResults(r.data); setOutcome('ok'); } else { setResults([]); setOutcome('failed'); } }) // only the latest request writes; a failed read is not an empty list
        .catch(() => { if (seq === seqRef.current) { setResults([]); setOutcome('failed'); } })
        .finally(() => { if (seq === seqRef.current) setSearching(false); });
    }, 300);
  }, []);

  const invite = useCallback(
    async (userId: string) => {
      if (state[userId] === 'sending' || state[userId] === 'sent') return;
      setState((m) => ({ ...m, [userId]: 'sending' }));
      const ok = await inviteToSharedMoment(momentId, userId, mediaId).catch(() => false);
      setState((m) => ({ ...m, [userId]: ok ? 'sent' : 'failed' }));
    },
    [momentId, mediaId, state],
  );

  return (
    <View>
      <BackRow label="Invite people" onBack={onBack} />
      <TextInput
        value={query}
        onChangeText={onChange}
        placeholder="Search travellers"
        placeholderTextColor={color.mute}
        style={s.input}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Search travellers to invite"
      />
      {searching ? <ActivityIndicator size="small" color={color.mute} /> : null}{!searching && outcome === 'failed' ? (<View style={s.row}><Text style={s.rowLabel}>We couldn't search travellers just now.</Text><Pressable onPress={() => onChange(query)} accessibilityRole="button" accessibilityLabel="Retry" hitSlop={8}><Text style={s.caption}>Try again</Text></Pressable></View>) : null}{!searching && outcome === 'ok' && results.length === 0 ? <Text style={s.caption}>No travellers found</Text> : null}
      {results.map((u) => {
        const st = state[u.id];
        return (
          <Pressable
            key={u.id}
            style={({ pressed }) => [s.row, pressed && s.rowPressed]}
            onPress={() => void invite(u.id)}
            accessibilityRole="button"
            accessibilityLabel={`Invite ${u.displayName ?? u.username ?? 'traveller'}`}
          >
            <Text style={s.rowLabel} numberOfLines={1}>
              {u.displayName ?? u.username ?? 'Traveller'}
            </Text>
            {st === 'sending' ? (
              <ActivityIndicator size="small" color={color.mute} />
            ) : st === 'sent' ? (
              <Check size={iconToken.s18} color={color.signal} strokeWidth={2} />
            ) : st === 'failed' ? (
              <Text style={s.caption}>Couldn’t invite</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.xs },
  backLabel: { ...t.body, color: color.mute, flex: 1 },
  stop: { flexDirection: 'row', gap: space.md, paddingVertical: 4 },
  stopTime: { ...t.body, color: color.mute, width: 48 },
  stopTitle: { ...t.body, color: color.ink, flex: 1 },
  section: { ...t.body, color: color.ink, fontWeight: '700', marginTop: space.md, marginBottom: space.xs },
  caption: { ...t.body, color: color.mute, fontSize: 13, paddingVertical: space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.xs,
    borderRadius: radius.md,
  },
  rowPressed: { opacity: 0.6 },
  rowLabel: { ...t.body, color: color.ink, flex: 1 },
  input: {
    ...t.body,
    color: color.ink,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginVertical: space.sm,
  },
});

// ── Update this gem ───────────────────────────────────────────────────────────

export function ContributePanel({
  gemId,
  mediaId,
  onBack,
}: {
  gemId: string;
  mediaId: string | null;
  onBack: () => void;
}) {
  return (
    <View>
      <BackRow label="Update this gem" onBack={onBack} />
      <GemContributeSection gemId={gemId} isAuthed originMediaId={mediaId} />
    </View>
  );
}

// ── Share through Telegraph ───────────────────────────────────────────────────

/**
 * The existing share sheet, sending a Telegraph §5 object REFERENCE rather than
 * a post_card snapshot. The media share metric records target 'telegraph' only
 * when the post went into a thread.
 */
export function TelegraphObjectShareSheet({
  mediaId,
  object,
  onClose,
}: {
  mediaId: string;
  object: { objectType: 'POST'; objectId: string };
  onClose: () => void;
}) {
  return (
    <ShareSheet
      visible
      postId={mediaId}
      telegraphObject={object}
      onClose={onClose}
      onShareSuccess={(target) => {
        if (target !== 'external' && target !== 'copy_link') {
          recordMediaShare(mediaId, 'telegraph').catch(() => {});
        }
      }}
    />
  );
}

// ── Link to an event ──────────────────────────────────────────────────────────

/**
 * The author picks which of the events the server offered this post belongs
 * to. Nothing is linked until they tap one; a refusal is said, not hidden.
 */
export function EventLinkPanel({
  mediaId,
  candidates,
  onBack,
  onLinked,
}: {
  mediaId: string;
  candidates: LinkableEventRef[];
  onBack: () => void;
  onLinked: (eventId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const link = useCallback(
    async (eventId: string) => {
      if (busy) return;
      setBusy(eventId);
      setFailed(null);
      const r = await linkMediaToEvent(mediaId, eventId);
      setBusy(null);
      if (r.ok) onLinked(eventId);
      else setFailed(r.errorKind === 'refused' ? 'This post can’t be linked to that event.' : 'Couldn’t link it. Try again.');
    },
    [busy, mediaId, onLinked],
  );

  return (
    <View>
      <BackRow label="Which event is this from?" onBack={onBack} />
      {candidates.map((ev) => (
        <Pressable
          key={ev.eventId}
          style={({ pressed }) => [s.row, pressed && s.rowPressed]}
          onPress={() => void link(ev.eventId)}
          accessibilityRole="button"
          accessibilityLabel={`Link to ${ev.title ?? 'this event'}`}
        >
          <Text style={s.rowLabel} numberOfLines={1}>{ev.title ?? 'Untitled event'}</Text>
          {busy === ev.eventId ? <ActivityIndicator size="small" color={color.mute} /> : null}
        </Pressable>
      ))}
      {failed ? <Text style={s.caption}>{failed}</Text> : null}
    </View>
  );
}
