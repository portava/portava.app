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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { captureMessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import { currentDiscoveryScope } from '../../../services/discoveryViewerScope.ts';
import { type OwnedApiContext } from '../../../services/ownedApiRequest.ts';
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
  CalendarCheck, Shuffle,
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
  link_event: CalendarCheck, remix: Shuffle,
} satisfies Partial<Record<MediaActionId, LucideIcon>>;

/** Go There on this device: the Places page's directions, opened in the maps app. */
export function openRailDirections(placeId: string, onOpened: () => void, isCurrent: () => boolean = () => true, context?: OwnedApiContext): Promise<DirectionsOutcome> {
  const owner = captureMessagingOwnerRequest();
  return openDirectionsForPlace(placeId, {
    platform: Platform.OS,
    loadDirections: async (id) => { const place = await getPlaceLiving(id, { ...context, owner: owner ?? undefined, isCurrent }); if (!place) throw new Error('Place unavailable'); return place.directionsUrl ?? null; },
    openUrl: (url) => owner?.isCurrent() && isCurrent() ? Linking.openURL(url) : Promise.reject(new Error('Directions cancelled')),
    onOpened: () => { if (owner?.isCurrent() && isCurrent()) onOpened(); },
  });
}

/** Save Route on this device: stops completed through the canonical place record. */
export async function saveRailRoute(input: {
  title: string;
  stops: RouteStopRef[];
  mediaId: string | null;
}, context?: OwnedApiContext): Promise<SaveMediaRouteResult> {
  const owner = context?.owner ?? captureMessagingOwnerRequest();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  context?.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 10_000);
  const current = () => !!owner?.isCurrent() && !controller.signal.aborted && !context?.signal?.aborted && context?.isCurrent?.() !== false;
  const request = { ...context, owner: owner ?? undefined, signal: controller.signal, isCurrent: current };
  try { return await saveMediaRoute(input, {
    resolveCoords: async (placeId) => current() ? (await getCanonicalPlace(placeId, request))?.coordinates ?? null : null,
    createRoute: (payload) => createRoutePlan(payload, request),
    isCurrent: current,
  }); } finally { clearTimeout(timeout); context?.signal?.removeEventListener('abort', cancel); }

}

function usePanelRequest(key: unknown) {
  const lifetime = useMemo(() => ({ owner: captureMessagingOwnerRequest(), controller: new AbortController(), active: true }), [key]);
  const latest = useRef(lifetime);
  latest.current = lifetime;
  const current = useCallback(() => latest.current === lifetime && lifetime.active && !lifetime.controller.signal.aborted && !!lifetime.owner?.isCurrent(), [lifetime]);
  const stop = useCallback(() => { lifetime.active = false; lifetime.controller.abort(); }, [lifetime]);
  useEffect(() => {
    lifetime.active = true;
    if (lifetime.controller.signal.aborted) lifetime.controller = new AbortController();
    return stop;
  }, [lifetime, stop]);
  const context = useMemo<OwnedApiContext>(() => ({ owner: lifetime.owner ?? undefined, isCurrent: current, get signal() { return lifetime.controller.signal; } }), [current, lifetime]);
  return { current, stop, context };
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

export function TripChoicePanel(props: React.ComponentProps<typeof TripChoiceForPlan>) {
  return <TripChoiceForPlan key={JSON.stringify(props.plan)} {...props} />;
}
function TripChoiceForPlan({
  plan,
  onBack,
  onApplied,
}: {
  plan: CompiledExperiencePlan;
  onBack: () => void;
  onApplied: (tripId: string) => void;
}) {
  const request = usePanelRequest(plan);
  const locked = useRef(false);
  const attemptedTrips = useRef(new Set<string>());
  const [reviewTrip, setReviewTrip] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [trips, setTrips] = useState<EditableTripRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyTrip, setBusyTrip] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoadError(false);
    fetchPlanEditableTrips(request.context)
      .then((rows) => {
        if (!live || !request.current()) return;
        // Only the trips the SERVER named — its gate is the plan endpoint's own.
        setTrips(rows.filter((r) => plan.eligibleTripIds.includes(r.id)));
      })
      .catch(() => {
        if (live && request.current()) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [plan, request.context, request.current, attempt]);

  const choose = useCallback(
    async (tripId: string) => {
      if (!request.current() || locked.current || attemptedTrips.current.has(tripId)) return;
      locked.current = true;
      attemptedTrips.current.add(tripId);
      setBusyTrip(tripId);
      const { created, failed } = await applyCompiledPlan(plan, tripId, (id, item) => createPlanItem(id, item, request.context), request.current);
      if (!request.current()) return;
      locked.current = false;
      setBusyTrip(null);
      if (created === 0) {
        setReviewTrip(tripId);
        setResult('Couldn’t confirm these stops. Open the trip to check before adding them again.');
        return;
      }
      if (failed > 0) { setReviewTrip(tripId); setResult(`Added ${created} of ${created + failed} stops. Open the trip to review them before adding more.`); return; }
      setResult(null);
      onApplied(tripId);
    },
    [plan, onApplied, request.context, request.current],
  );

  return (
    <View>
      <BackRow label={plan.source.title ?? 'Do this experience'} onBack={() => { request.stop(); onBack(); }} />
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
        <View><Text style={s.caption}>Couldn’t read your trips.</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry trips" onPress={() => setAttempt(value => value + 1)}><Text style={s.caption}>Try again</Text></Pressable></View>
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
            disabled={busyTrip !== null || attemptedTrips.current.has(trip.id)}
            accessibilityRole="button"
            accessibilityLabel={`Add to ${trip.title}`}
          >
            <Text style={s.rowLabel} numberOfLines={1}>{trip.title}</Text>
            {busyTrip === trip.id ? <ActivityIndicator size="small" color={color.mute} /> : null}
          </Pressable>
        ))
      )}
      {result ? <Text style={s.caption}>{result}</Text> : null}
      {reviewTrip ? <Pressable accessibilityRole="button" accessibilityLabel="Open trip to review stops" onPress={() => { if (request.current()) onApplied(reviewTrip); }}><Text style={s.rowLabel}>Open trip</Text></Pressable> : null}
    </View>
  );
}

// ── Invite people ─────────────────────────────────────────────────────────────

export function InvitePanel(props: React.ComponentProps<typeof InviteForMoment>) {
  return <InviteForMoment key={`${props.momentId}:${props.mediaId}`} {...props} />;
}
function InviteForMoment({
  momentId,
  mediaId,
  onBack,
}: {
  momentId: string;
  mediaId: string | null;
  onBack: () => void;
}) {
  const request = usePanelRequest(`${momentId}:${mediaId}`);
  const invitations = useRef(new Set<string>());
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TravelerSearchResult[]>([]);
  const [searching, setSearching] = useState(false); const [outcome, setOutcome] = useState<'idle' | 'ok' | 'failed'>('idle'); const seqRef = useRef(0); // census-discovery §106 (tm-people): what the latest search came to; its generation
  const [state, setState] = useState<Record<string, 'sending' | 'sent' | 'failed'>>({});
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    seqRef.current += 1;
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const onChange = useCallback((q: string) => {
    if (!request.current()) return;
    setQuery(q); const seq = ++seqRef.current; setOutcome('idle'); // a new query: whatever is in flight answers a question no longer asked
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) {
      setResults([]); setSearching(false);
      return;
    }
    debounce.current = setTimeout(() => {
      setSearching(true);
      searchUsers(q.trim(), 10, { ...request.context, owner: request.context.owner, signal: request.context.signal!, scope: currentDiscoveryScope(), isCurrent: () => request.current() && seq === seqRef.current })
        .then((r) => { if (!request.current() || seq !== seqRef.current) return; if (r.ok && r.data) { setResults(r.data); setOutcome('ok'); } else { setResults([]); setOutcome('failed'); } })
        .catch(() => { if (request.current() && seq === seqRef.current) { setResults([]); setOutcome('failed'); } })
        .finally(() => { if (request.current() && seq === seqRef.current) setSearching(false); });
    }, 300);
  }, [request.current, request.context]);

  const invite = useCallback(
    async (userId: string) => {
      if (!request.current() || invitations.current.has(userId)) return;
      invitations.current.add(userId);
      setState((m) => ({ ...m, [userId]: 'sending' }));
      const ok = await inviteToSharedMoment(momentId, userId, mediaId, request.context).catch(() => false);
      if (!request.current()) return;
      if (!ok) invitations.current.delete(userId);
      setState((m) => ({ ...m, [userId]: ok ? 'sent' : 'failed' }));
    },
    [momentId, mediaId, request.current, request.context],
  );

  return (
    <View>
      <BackRow label="Invite people" onBack={() => { request.stop(); onBack(); }} />
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
            disabled={st === 'sending' || st === 'sent'}
            accessibilityRole="button"
            accessibilityLabel={`${st === 'sent' ? 'Invitation sent to' : st === 'sending' ? 'Sending invitation to' : 'Invite'} ${u.displayName ?? u.username ?? 'traveller'}`}
            accessibilityState={{ disabled: st === 'sending' || st === 'sent', busy: st === 'sending' }}
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
  const request = usePanelRequest(mediaId);
  const locked = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const link = useCallback(
    async (eventId: string) => {
      if (!request.current() || locked.current) return;
      locked.current = true;
      setBusy(eventId);
      setFailed(null);
      const r = await linkMediaToEvent(mediaId, eventId, { signal: request.context.signal });
      if (!request.current()) return;
      locked.current = false;
      setBusy(null);
      if (r.ok) onLinked(eventId);
      else setFailed(r.errorKind === 'refused' ? 'This post can’t be linked to that event.' : 'Couldn’t link it. Try again.');
    },
    [mediaId, onLinked, request.context, request.current],
  );

  return (
    <View>
      <BackRow label="Which event is this from?" onBack={() => { request.stop(); onBack(); }} />
      {candidates.map((ev) => (
        <Pressable
          key={ev.eventId}
          style={({ pressed }) => [s.row, pressed && s.rowPressed]}
          onPress={() => void link(ev.eventId)}
          disabled={busy !== null}
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
