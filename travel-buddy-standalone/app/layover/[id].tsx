/**
 * Layover dashboard — the live command center for an active layover.
 *
 * Hero (countdown, tier, airport-local time) → Can-I-Leave guidance →
 * mini-plan with hard return marker → Compass → the exploration block
 * (time-aware recommendations → map → people) → sticky footer actions.
 *
 * ── THE LAYOUT IS THE CERTIFIED POSTURE, NOT A LOCAL GUESS ───────────────────
 * Two fields of `overview.safeReturn` decide the shape of this screen, and both
 * are derived server-side from the certified record by `safeReturnPosture`
 * (`artifacts/api-server/src/services/airport/LayoverSafeReturnService.ts:102#export function safeReturnPosture`).
 * Nothing here re-derives a return state from a clock:
 *
 *   returnRoutePrimary     → the abort card is hoisted above the hero (§15)
 *   explorationCollapsed   → the exploration block collapses to a notice (§13)
 *
 * Collapsed is not hidden. "Show them anyway" is one press and the traveller
 * keeps the whole city; what the posture buys is that the default answer at
 * RETURN_NOW is the airport, not a restaurant.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Bell, BellRing, Plane, Power, Send } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../../src/theme/tokens';
import { ConfirmSheet } from '../../src/components/ui/ConfirmSheet';
import {
  addStopFromRecommendation,
  endLayoverSession,
  getLayoverBuddies,
  getLayoverOverview,
  getLayoverPresence,
  getRecommendations,
  sendLayoverTelegraph,
  setReturnDeadline,
  setShareCityStatus,
  type LayoverBuddy,
  type LayoverOverview,
  type LayoverRecommendation,
  type LayoverOverviewFailure,
  type LayoverPresenceAnswer,
  type StopsResponse,
} from '../../src/services/layover';
import {
  cancelScheduledNotification,
  notificationPromptWouldAppear,
  scheduleLocalNotificationAt,
} from '../../src/lib/safeNotifications';
import { AirportEssentialsCard } from '../../src/components/layover/AirportEssentialsCard';
import { AirportConditionsCard } from '../../src/components/layover/AirportConditionsCard';
import { LayoverHero } from '../../src/components/layover/LayoverHero';
import { CanILeaveCard } from '../../src/components/layover/CanILeaveCard';
import { LayoverPlanSection } from '../../src/components/layover/LayoverPlanSection';
import { LayoverRecsSection } from '../../src/components/layover/LayoverRecsSection';
import { LayoverMapCard } from '../../src/components/layover/LayoverMapCard';
import { LayoverPeopleSection } from '../../src/components/layover/LayoverPeopleSection';
import { LayoverCrewSection } from '../../src/components/layover/LayoverCrewSection';
import { LayoverDiscoveryCard } from '../../src/components/layover/LayoverDiscoveryCard';
import { LayoverSafeReturnCard } from '../../src/components/layover/LayoverSafeReturnCard';
import { LayoverEndSheet } from '../../src/components/layover/LayoverEndSheet';
import { useSafeReturnAbort } from '../../src/components/layover/useSafeReturnAbort';
import { LayoverCompassCard } from '../../src/components/layover/LayoverCompassCard';
import { LayoverFlightChangeCard } from '../../src/components/layover/LayoverFlightChangeCard';
import { fmtClock } from '../../src/components/layover/layoverFormat';
import {
  cacheCertifiedDeadline,
  cachedDeadlineAsBundle,
  readCachedDeadline,
  type CachedCertifiedDeadline,
} from '../../src/components/layover/layoverDeadlineCache';
import { describeDeadline } from '../../src/components/layover/layoverReturnFacts';
import { LayoverOfflinePlanCard } from '../../src/components/layover/LayoverOfflinePlanCard';
import { layoverSensingCadence } from '../../src/lib/layoverSensingCadence';
import {
  cacheCertifiedPlan,
  readCachedPlan,
  type CachedLayoverPlan,
} from '../../src/lib/layoverPlanCache';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';

/**
 * The ONE sentence on this screen that is not the server's, and the one case
 * where there cannot be a server sentence: the device never reached a server.
 * It matches `getLayoverOverview`'s own copy of it verbatim, so the two routes
 * into this state — the service reporting `unreachable`, and this screen's own
 * catch — read identically to a traveller.
 */
const UNREACHABLE_COPY = "We couldn't reach Portava. Check your connection and try again.";

export default function LayoverDashboardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [overview, setOverview] = useState<LayoverOverview | null>(null);
  const [recs, setRecs] = useState<LayoverRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [recsLoading, setRecsLoading] = useState(true);
  // census L294 (C2) — the SERVER's refusal sentence, or null when it served a
  // list. Never an empty list standing in for a failure.
  const [recsError, setRecsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * census L156 — WHICH failure, not just THAT one happened.
   *
   * `loadError: boolean` could only produce one sentence, and the sentence it
   * produced was a guess between two facts the server had already told this
   * screen apart: "It may have been removed, or you're offline."
   */
  const [loadFailure, setLoadFailure] = useState<{
    reason: LayoverOverviewFailure;
    message: string;
    retryable: boolean;
  } | null>(null);
  // Bumped once per completed load so cards that own their own fetch
  // (AirportConditionsCard) re-read on the same pull-to-refresh as the
  // rest of the screen, rather than holding a reading the traveller has
  // just asked to refresh.
  const [dataEpoch, setDataEpoch] = useState(0);
  /**
   * census L150 — the LAST CERTIFIED deadline this device wrote down.
   *
   * §16: "Return deadline — persist latest certified value + snapshot
   * timestamp." The server has carried `certifiedAt` / `staleAfter` on every
   * bundle for several passes; this client made NO AsyncStorage write at all,
   * so a traveller who lost signal in the city got "We couldn't reach Portava"
   * and nothing else — on the one screen whose job is getting them back to a
   * plane.
   *
   * Read only when the overview could not be read, and rendered through the
   * SAME `describeDeadline` a live bundle goes through, so a cached deadline is
   * captioned LAST CERTIFIED with its age and can never be presented as
   * current. `null` means nothing is cached and renders as nothing — never a
   * placeholder time.
   */
  const [cachedDeadline, setCachedDeadline] = useState<CachedCertifiedDeadline | null>(null);

  /**
   * census L151 / L233 — WHAT ELSE THE TRAVELLER KEEPS.
   *
   * The deadline above is the one number that must survive; it is not the only
   * thing that should. `layoverPlanCache` stores the plan the server certified,
   * the airport it is anchored to and the certified envelope's radii, all with
   * the server's own `staleAfter` verbatim. Read on the SAME failures as the
   * deadline (never `gone`), and rendered through the same staleness rule.
   */
  const [cachedPlan, setCachedPlan] = useState<CachedLayoverPlan | null>(null);

  // census L127/L128/L294 — the presence ANSWER, carried whole. `degraded` and
  // `withheld` are the server's; `count` alone cannot tell a measured empty
  // city from a read that fell closed, and this screen used to store only that.
  // The initial value is DEGRADED, not empty: before the first read returns,
  // nothing has been measured, and "0 travellers" would be a claim.
  const [presence, setPresence] = useState<LayoverPresenceAnswer>({
    sharing: false, count: 0, travelers: [],
    degraded: true, degradedReasons: ['not_yet_read'], withheld: [],
  });
  const [buddies, setBuddies] = useState<LayoverBuddy[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [addingRecId, setAddingRecId] = useState<string | null>(null);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
  // QA round 2, minor F: drives the in-app confirm on web (see confirmEnd).
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // §13 L120/L141 — the traveller's override of the certified collapse. False
  // is the server's posture; true is "I know, show me anyway".
  const [showExploration, setShowExploration] = useState(false);
  // §17.1 L165 — the rationale that precedes the OS notification prompt.
  const [notifRationaleOpen, setNotifRationaleOpen] = useState(false);
  const notifIdRef = useRef<string | null>(null);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * The countdown ticks locally, but usable-window/plan-fit math must stay
   * canonical: silently re-pull the overview while active so the safety numbers
   * never overstate remaining margin.
   *
   * census L157 — THE CADENCE IS THE CERTIFIED RUNG'S, not a constant. This ran
   * every 60 seconds whether the traveller had four hours or four minutes, so
   * the numbers somebody acts on while walking back to an airport aged exactly
   * as fast as the ones they read over lunch. `layoverSensingCadence` maps the
   * SERVER's `returnState` onto the interval and nothing here re-derives a rung
   * from a clock — a second escalation rule on the client is the defect L115
   * forbids of the map, in a different place.
   *
   * NORMAL is unchanged at 60 s: only the sharp end tightens.
   */
  const sessionStatus = overview?.session.status;
  const certifiedReturnState = overview?.safeReturn?.returnState ?? overview?.window.returnState ?? null;
  const cadence = layoverSensingCadence({
    sessionStatus,
    returnState: certifiedReturnState,
  });
  const refreshIntervalMs = cadence.intervalMs;
  useEffect(() => {
    if (!id || sessionStatus !== 'active' || refreshIntervalMs == null) return;
    const timer = setInterval(async () => {
      // A silent refresh KEEPS the last certified overview when the read fails
      // — it must never blank the screen a traveller is acting on. What it must
      // equally never do is let a rejection escape this callback: an interval
      // handler's rejection is unhandled, and the last one took the whole
      // screen's load down with it (census L156).
      const read = await getLayoverOverview(id).catch(() => null);
      if (read?.ok) setOverview(read.overview);
    }, refreshIntervalMs);
    return () => clearInterval(timer);
  }, [id, sessionStatus, refreshIntervalMs]);

  // §15.1's abort, lifted out of `LayoverSafeReturnCard` so that more than one
  // control can fire it (census L42, L123). Declared here, above every early
  // return, because a hook may not be called conditionally. `reloadAfterAbort`
  // is defined after `load` and read through a ref-free callback below.
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3200);
  }, []);

  /**
   * census L127/L128/L294 — FORWARD THE ANSWER, DO NOT FLATTEN IT.
   *
   * This used to read `if (res?.sharing) {count, travelers} else {0, []}`, which
   * mapped three different server answers onto one:
   *   a `null`      — the read failed (503, or `fetch` rejected offline)
   *   `degraded`    — the route answered and said its count is not a measurement
   *   `withheld`    — the gate refused on the traveller's own stored settings
   * and the card printed "you're the first" for all three. The server publishes
   * the discriminator on every response; this now carries it across.
   */
  const loadPresence = useCallback(async (sessionId: string) => {
    const res = await getLayoverPresence(sessionId);
    if (!res) {
      // A CLIENT-side reason, and named as one: the server said nothing at all,
      // so attributing one of ITS reason codes here would be a fabrication.
      setPresence({
        sharing: false, count: 0, travelers: [],
        degraded: true, degradedReasons: ['client_request_failed'], withheld: [],
      });
      return;
    }
    setPresence({
      ...res,
      // A refused answer carries no roster: `sharing: false` means the route
      // served nobody, so any count on it is not about this city right now.
      count: res.sharing ? res.count : 0,
      travelers: res.sharing ? res.travelers : [],
      withheld: res.withheld ?? [],
    });
  }, []);

  /**
   * census L156 — EVERY PATH OUT OF HERE CLEARS `loading`.
   *
   * There was no `try` around this. `authedFetch` REJECTS when the device has
   * no network, so `Promise.all` rejected, `setLoading(false)` never ran, and
   * an offline traveller sat on "Loading your layover…" for as long as they
   * were willing to — with an unhandled promise rejection behind it. The
   * census row for L156 describes the COPY on the failure screen; on this tree
   * the failure screen was not reached at all.
   *
   * The service no longer throws on a rejected fetch, so the `catch` here is
   * the belt to that braces: a future read added to this `Promise.all` cannot
   * silently reintroduce the hang.
   */
  const load = useCallback(async (isRefresh = false) => {
    if (!id) return;
    if (!isRefresh) setLoading(true);
    setLoadFailure(null);
    try {
      const [ovRead, recRes, buddyRes] = await Promise.all([
        getLayoverOverview(id),
        getRecommendations(id).finally(() => setRecsLoading(false)),
        getLayoverBuddies(id),
      ]);
      if (ovRead.ok) {
        setOverview(ovRead.overview);
        // census L150 — persist the certified deadline on every successful
        // read. Floated deliberately: the write is a convenience for a future
        // offline load and must never delay or fail this one. An overview that
        // arrived without a bundle writes NOTHING and leaves any existing
        // record standing (`cacheCertifiedDeadline` returns false) — a response
        // that said nothing about the deadline is not a reason to take the
        // traveller's last one away.
        void cacheCertifiedDeadline(id, ovRead.overview.offlineBundle);
        // census L151/L233 — the same floated write, for the plan, the airport
        // and the certified area. Two caches rather than one because §16 makes
        // each of those a separate decision about what may be shown from a
        // cache; see `lib/layoverPlanCache.ts`.
        void cacheCertifiedPlan(
          id,
          ovRead.overview.offlineBundle,
          ovRead.overview.safeEnvelope ?? null,
        );
        if (ovRead.overview.share.enabled) loadPresence(id);
        setBuddies(buddyRes?.buddies ?? []);
      } else {
        // The server's own sentence and its own retryability. This screen does
        // not decide whether a layover is gone or a read failed — it forwards
        // the answer, which is the whole of L156's client half.
        setLoadFailure({
          reason: ovRead.reason,
          message: ovRead.message,
          retryable: ovRead.retryable || ovRead.reason === 'unreachable',
        });
        /**
         * census L150 — the read failed, so fall back to what was persisted.
         *
         * `gone` is EXCLUDED, and the exclusion is the safety argument: a 404
         * means this session is not this traveller's or no longer exists, so
         * its return deadline is not a fact any more. A cache is not a reason
         * to send somebody to an airport for a flight that is not theirs.
         * `unreachable`, `unavailable` and `refused` all mean the SESSION is
         * fine and the READ failed, which is exactly what §16 is for.
         */
        if (ovRead.reason !== 'gone') {
          setCachedDeadline(await readCachedDeadline(id));
          setCachedPlan(await readCachedPlan(id));
        }
      }
      // census L294 (C2) — keep the two apart all the way to the card. An empty
      // `recs` with `recsError` null is a measured "nothing fits"; a non-null
      // `recsError` is the server's refusal and carries its sentence.
      setRecs(recRes.ok ? recRes.recommendations : []);
      setRecsError(recRes.ok ? null : recRes.message);
    } catch {
      setRecsLoading(false);
      setRecs([]);
      setRecsError(UNREACHABLE_COPY);
      setLoadFailure({ reason: 'unreachable', message: UNREACHABLE_COPY, retryable: true });
      // census L150 — the same fallback on the belt-and-braces path. The two
      // routes into "unreachable" must not differ in what the traveller keeps.
      setCachedDeadline(await readCachedDeadline(id));
      setCachedPlan(await readCachedPlan(id));
    } finally {
      setLoading(false);
      setRefreshing(false);
      setDataEpoch((n) => n + 1);
    }
  }, [id, loadPresence]);

  useEffect(() => { load(); }, [load]);

  // The abort cancels landside stops and may flip the session status, so the
  // screen must re-read rather than keep rendering the plan it just cleared.
  const reloadAfterAbort = useCallback(() => { void load(true); }, [load]);
  const returnAbort = useSafeReturnAbort(id, reloadAfterAbort);

  const canEdit = overview?.session.status === 'active';

  /**
   * §24 L265 / §11.1 L99 — is the reminder this screen claims is set still
   * pointing at the deadline it was set against?
   *
   * The server decides (`services/airport/LayoverReturnEscalation.ts`,
   * `reminderDisposition`) and publishes it on the overview; this screen only
   * forwards the answer. It is read with a local narrowing rather than through
   * `LayoverOverview`, because that type lives in `services/layover.ts`, which
   * this lane does not own — an older server that does not publish the member
   * renders exactly what it rendered before.
   *
   * WHY THIS IS A BANNER AND NOT A SILENT RESCHEDULE. The local notification
   * was scheduled by whichever app session pressed the button, and its
   * identifier lives in a `useRef` that does not survive a remount, so this
   * screen cannot cancel a notification it did not schedule. What it CAN stop
   * doing is asserting "Reminder set" for a warning that has drifted — which is
   * the half of the defect a traveller actually acts on.
   */
  const reminderDrift = (overview as { reminder?: {
    action: string; reason: string; driftMinutes: number; materialChange: boolean;
    firesAt: string | null; staleFiresAt: string | null;
  } } | null)?.reminder ?? null;
  const reminderStale = reminderDrift?.action === 'reschedule' || reminderDrift?.action === 'cancel';
  const city = overview
    ? (overview.airport.city !== 'Unknown' ? overview.airport.city : overview.session.manualCity)
    : null;

  // §13 L122 — recommendation id → the band its PIN renders. Built here rather
  // than inside the card so the card stays a consumer: L115 forbids the map
  // recalculating feasibility, and a lookup table is not a calculation.
  const candidateFeasibility = useMemo(() => {
    const out: Record<string, NonNullable<LayoverRecommendation['feasibility']>> = {};
    for (const r of recs) if (r.id && r.feasibility) out[r.id] = r.feasibility;
    return out;
  }, [recs]);
  const addedRecIds = useMemo(
    () => new Set(overview?.stops.map((s) => s.recommendationId).filter((x): x is string => !!x) ?? []),
    [overview?.stops],
  );

  const onStopsChanged = useCallback((res: StopsResponse) => {
    setOverview((prev) => prev ? { ...prev, stops: res.stops, planFit: res.planFit } : prev);
  }, []);

  const handleAddRec = useCallback(async (recId: string) => {
    if (!id) return;
    setAddingRecId(recId);
    try {
      const res = await addStopFromRecommendation(id, recId);
      if (res) { onStopsChanged(res); showToast('Added to your plan'); }
      else showToast('Could not add — plans may be full');
    } finally {
      setAddingRecId(null);
    }
  }, [id, onStopsChanged, showToast]);

  const handleToggleShare = useCallback(async (enabled: boolean) => {
    if (!id || !overview) return;
    setShareBusy(true);
    try {
      const session = await setShareCityStatus(id, enabled);
      if (session) {
        setOverview((prev) => prev ? { ...prev, session, share: { ...prev.share, enabled } } : prev);
        if (enabled) loadPresence(id);
        // Turning sharing OFF is the one zero this screen may state without a
        // read: the traveller just chose it. `degraded: false` is therefore
        // correct here and nowhere else — and the box is unmounted anyway.
        else setPresence({
          sharing: false, count: 0, travelers: [],
          degraded: false, degradedReasons: [], withheld: [],
        });
      } else {
        showToast('Could not update sharing');
      }
    } finally {
      setShareBusy(false);
    }
  }, [id, overview, loadPresence, showToast]);

  /**
   * §17.1 L165 — EXPLAIN THE PERMISSION BEFORE THE OS ASKS FOR IT.
   *
   * The request was already contextual (it only happens inside this tap), but
   * nothing told the traveller WHY, and the OS dialog cannot: it says
   * "Portava would like to send you notifications", which is a request without
   * a reason and is the one people decline by reflex. The reason is specific
   * and worth a sentence — this notification is how a safe return window that
   * moves reaches someone who has walked away from their phone.
   *
   * The sheet is shown ONLY when a dialog is actually about to appear
   * (`notificationPromptWouldAppear`), so a traveller who has already granted
   * permission gets their reminder on one tap, as before.
   */
  const scheduleReminder = useCallback(async () => {
    if (!id || !overview) return;
    setReminderBusy(true);
    try {
      // Replace any previously scheduled local notification — never stack them.
      await cancelScheduledNotification(notifIdRef.current);
      notifIdRef.current = null;
      const res = await setReturnDeadline(id, 30);
      if (!res) { showToast('Could not set the reminder'); return; }
      setOverview((prev) => prev ? { ...prev, returnReminderAt: res.reminderAt ?? prev.returnReminderAt } : prev);
      let scheduled = false;
      if (res.reminderAt) {
        const notifId = await scheduleLocalNotificationAt(new Date(res.reminderAt), {
          title: `Time to head back to ${overview.airport.iataCode}`,
          body: `Be back at the airport by ${fmtClock(res.hardReturnTime, overview.airport.timezone)} for your flight.`,
          data: { url: `/layover/${id}` },
        });
        if (notifId) { notifIdRef.current = notifId; scheduled = true; }
      }
      showToast(scheduled
        ? '30-minute heads-up scheduled'
        : 'Reminder saved — keep an eye on the countdown');
    } finally {
      setReminderBusy(false);
    }
  }, [id, overview, showToast]);

  const handleReminder = useCallback(async () => {
    if (!id || !overview) return;
    if (await notificationPromptWouldAppear()) { setNotifRationaleOpen(true); return; }
    await scheduleReminder();
  }, [id, overview, scheduleReminder]);

  /**
   * census-layover L271 — NAVIGATE TO THE CHAT ONLY IF THE MESSAGE IS IN IT.
   *
   * This used to push to the trip chat whenever the session had a `tripId`,
   * without looking at the response at all — so a failed send, and even a send
   * the server never attempted, still landed the traveller in a conversation
   * where their own text was missing and nothing said why. The server now
   * writes the message and reports `posted`; this switches on that.
   *
   * The Compass fallback keeps its old job for a layover with no trip: there is
   * no thread to post to, so the text is carried into /ai as a prefill instead
   * of being lost.
   */
  const handleTelegraph = useCallback(async () => {
    if (!id || !overview) return;
    const msg = `On a layover in ${city ?? 'town'} with about ${Math.round(overview.window.usableMinutes / 60)}h to spare — any quick tips?`;
    const res = await sendLayoverTelegraph(id, msg);
    if (!res) {
      showToast('Telegraph is unavailable right now');
    } else if (res.posted && overview.session.tripId) {
      router.push(`/trip/chat?id=${overview.session.tripId}` as any);
    } else if (res.threadId && !res.posted) {
      // There IS a chat and the message did not reach it. Sending the traveller
      // there would show them an absence they cannot explain.
      showToast(
        res.postFailure === 'e2ee'
          ? 'That chat is end-to-end encrypted — send this from the chat itself'
          : 'Could not post to your trip chat. Please try again.',
      );
    } else {
      router.push({ pathname: '/ai', params: { prefillMessage: msg } } as any);
    }
  }, [id, overview, city, router, showToast]);

  /**
   * §3 L19 / §17 L162 — the close carries the OUTCOME and the ELECTION.
   *
   * It used to send neither: every close was `cancelled`, so a traveller who
   * came back and boarded was recorded as having abandoned the layover, and the
   * Passport stamp had already been written at session CREATION for a city they
   * had not been to. Both answers now come from the sheet, and the server's own
   * `passportStamp.reason` is what the toast says — this screen does not
   * re-derive whether a stamp was written.
   */
  const doEndLayover = useCallback(async (choice: { outcome: 'completed' | 'cancelled'; passportStamp: boolean }) => {
    if (!id) return;
    setEndConfirmOpen(false);
    setEndBusy(true);
    try {
      const result = await endLayoverSession(id, choice);
      if (result.ok) {
        await cancelScheduledNotification(notifIdRef.current);
        if (choice.passportStamp && result.passportStamp && !result.passportStamp.written) {
          showToast('Layover ended — the Passport stamp could not be saved');
        }
        router.back();
      } else {
        showToast('Could not end the layover');
      }
    } finally {
      setEndBusy(false);
    }
  }, [id, router, showToast]);

  const confirmEnd = useCallback(() => {
    // ONE SHEET ON BOTH PLATFORMS, which is a departure from this screen's own
    // rule that native keeps the OS alert. The rule is about CONFIRMATIONS;
    // ending a layover is now a form with two independent answers, and
    // `Alert.alert` can only carry it as two chained dialogs — which would make
    // "I made my flight" and "keep the stamp" look like one decision.
    setEndConfirmOpen(true);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centerFill}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color={color.signal} />
        <Text style={styles.centerText}>Loading your layover…</Text>
      </View>
    );
  }

  if (loadFailure || !overview) {
    /**
     * census L156 — THE SERVER'S ANSWER, NOT A DISJUNCTION OF TWO GUESSES.
     *
     * The old copy was "It may have been removed, or you're offline." — one
     * sentence naming two mutually exclusive facts, at a moment when the server
     * had already told this screen which one it was. A traveller standing at a
     * gate reading that cannot tell whether to walk back to a plan that still
     * exists or to give up on one that does not.
     *
     * `gone` is the only branch that offers no retry, because the answer will
     * not change. Everything else is retryable, so the control is real.
     */
    const gone = loadFailure?.reason === 'gone';
    const retryable = loadFailure ? loadFailure.retryable && !gone : true;
    /**
     * census L150 — WHAT THE TRAVELLER KEEPS WHEN THE READ FAILS.
     *
     * The deadline is the one number §16 says must survive everything else
     * going dark, and until this block the failure screen had none: an offline
     * traveller in the city was shown a connection error and nothing they could
     * act on.
     *
     * It goes through `describeDeadline` — the SAME rule a live bundle goes
     * through, including the server's own `staleAfter` bound — so it is
     * captioned LAST CERTIFIED with its age and cannot be rendered as current.
     * A cache read while the network has been gone a while is essentially
     * always past that bound, which is the honest state and is what is shown.
     *
     * Never rendered for `gone`: `cachedDeadline` is only loaded for the
     * failures that mean the SESSION is fine and the READ failed.
     */
    const cached = !gone && cachedDeadline ? cachedDeadline : null;
    // Same exclusion, same argument: a session the server says is GONE has no
    // plan worth showing either. A cache is not a reason to send somebody
    // across a city for a layover that is not theirs.
    const plan = !gone ? cachedPlan : null;
    const cachedTruth = cached
      ? describeDeadline(cachedDeadlineAsBundle(cached), cached.hardReturnTime, nowMs)
      : null;
    return (
      <View style={styles.centerFill} testID="layover-load-error">
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.centerTitle}>
          {gone ? 'This layover is no longer here' : "Couldn't load this layover"}
        </Text>
        <Text style={styles.centerText}>
          {gone
            ? 'It may have been removed, or it belongs to another account.'
            : (loadFailure?.message ?? UNREACHABLE_COPY)}
        </Text>
        {cached && cachedTruth && (
          <View style={styles.cachedDeadline} testID="layover-cached-deadline">
            <Text style={styles.cachedDeadlineLabel}>
              {cachedTruth.standing === 'live' ? 'Be back by' : 'Last certified return time'}
            </Text>
            <Text style={styles.cachedDeadlineTime} testID="layover-cached-deadline-time">
              {cachedTruth.hardReturnLocal ?? cachedTruth.hardReturnTime}
            </Text>
            {cachedTruth.stalenessNotice ? (
              <Text style={styles.cachedDeadlineStale} testID="layover-cached-deadline-staleness">
                {cachedTruth.stalenessNotice}
              </Text>
            ) : null}
          </View>
        )}
        {/* census L151/L233 — where they were going, which airport they have to
            be back at, and how far the certified envelope reached. Captioned
            last-certified by the card itself, through the one staleness rule. */}
        <LayoverOfflinePlanCard plan={plan} nowMs={nowMs} />
        {retryable && (
          <Pressable style={styles.retryBtn} onPress={() => load()} testID="layover-load-retry">
            <Text style={styles.retryBtnText}>Try again</Text>
          </Pressable>
        )}
        <Pressable style={styles.backLink} onPress={() => router.back()}>
          <Text style={styles.backLinkText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const { session, airport, window: win, advice, stops, planFit, localTimes } = overview;

  const returnCard = (
    <LayoverSafeReturnCard
      overview={overview}
      nowMs={nowMs}
      canAbort={!!canEdit}
      abort={returnAbort}
    />
  );
  // §13 L123 — what the map's airport element needs in order to be the return
  // CTA's anchor. Every field is the server's certified posture; the action is
  // the SAME controller the card holds, so a second entry point cannot produce
  // a second contract.
  const airportReturn = {
    hardReturnTime: win.hardReturnTime,
    minutesToHardReturn: overview.safeReturn?.minutesToHardReturn ?? null,
    returnState: overview.safeReturn?.returnState ?? win.returnState ?? null,
    canReturn: !!canEdit,
    busy: returnAbort.busy,
    onReturnNow: returnAbort.run,
  };
  // `?.` against a required field on purpose: the type says the server always
  // sends `safeReturn`, and getLayoverOverview warns loudly when it does not —
  // but a missing field must degrade the LAYOUT, not blank the whole dashboard.
  const returnCardFirst = overview.safeReturn?.returnRoutePrimary === true;
  // §13 L120 / L141 — the OTHER half of the same certified posture. The server
  // derives `explorationCollapsed` from the certified return state
  // (`safeReturnPosture`, RETURN_NOW or CONNECTION_AT_RISK) and has published
  // it since the safe-return pass; until now the client read `returnRoutePrimary`
  // beside it and dropped this one on the floor, so the card was HOISTED and
  // exploration was never COLLAPSED.
  //
  // COLLAPSED, NOT HIDDEN, and the distinction is the requirement. §13 asks for
  // exploration-first affordances to be SUPPRESSED when the traveller is due
  // back; it does not ask for the app to decide on their behalf that a city no
  // longer exists. `showExploration` is the traveller's own override and it
  // survives until they leave the screen — one press, and everything is back.
  const explorationCollapsed =
    overview.safeReturn?.explorationCollapsed === true && !showExploration;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + space.sm }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={styles.topTitle}>Layover</Text>
        <View style={{ width: 36 }} />
      </View>

      <KeyboardSafeScrollView>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: canEdit ? 130 + insets.bottom : 40 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} tintColor={color.signal} />
        }
      >
        {!canEdit && (
          <View style={styles.endedBanner}>
            <Text style={styles.endedText}>
              This layover is {session.status}. You're viewing a snapshot.
            </Text>
          </View>
        )}

        {/* §15 "the fastest return route is primary": when the certified posture
            says so (RETURN_NOW / CONNECTION_AT_RISK), the abort card is hoisted
            above the hero instead of sitting with the plan. Nothing is hidden —
            position is the only thing that changes. */}
        {returnCardFirst && returnCard}

        <LayoverHero airport={airport} session={session} window={win} localTimes={localTimes} nowMs={nowMs} />
        {/* §24 L265 — a reminder that no longer matches the certified deadline,
            said out loud. Below the material threshold the server answers
            `keep` and nothing renders, which is the suppression half of the
            same requirement: a two-minute drift must not produce a banner any
            more than it should produce a notification. */}
        {reminderDrift && reminderStale ? (
          <Pressable
            style={styles.driftCard}
            testID="reminder-drift"
            accessibilityRole="button"
            onPress={reminderDrift.action === 'reschedule' ? handleReminder : undefined}
            disabled={reminderDrift.action !== 'reschedule' || reminderBusy}
          >
            <Text style={styles.driftTitle} testID="reminder-drift-title">
              {reminderDrift.action === 'cancel'
                ? 'Your reminder can no longer warn you'
                : 'Your reminder is out of date'}
            </Text>
            <Text style={styles.driftBody} testID="reminder-drift-body">
              {reminderDrift.action === 'cancel'
                ? 'Your flight moved and the moment it was set for has passed. Watch the countdown above.'
                : `Your flight moved by ${Math.abs(reminderDrift.driftMinutes)} min. Tap to set it for ${fmtClock(reminderDrift.firesAt, airport.timezone)} instead.`}
            </Text>
          </Pressable>
        ) : null}
        {/* §2.1/§22 (census L9, L250): the card says which rung of the fallback
            ladder these minutes came off. The server derives it from the
            certified record; this screen only forwards it. */}
        <CanILeaveCard
          advice={advice}
          window={win}
          airport={airport}
          airportIntelligence={overview.airportIntelligence ?? null}
        />
        {/* The one §11 event producer this tree has: the traveller. A flight
            time the gate agent just announced is a fact no feed here carries,
            and the server runs the whole §11.1 pipeline over it. */}
        <LayoverFlightChangeCard
          session={session}
          canEdit={!!canEdit}
          onChanged={() => load(true)}
          onError={showToast}
        />
        <AirportEssentialsCard countryCode={airport.countryCode} countryName={airport.country !== 'Unknown' ? airport.country : undefined} />

        {/* §10 L82 — the traveller observation channel's submission surface.
            Placed directly under the essentials because it answers the same
            question ("what is this airport like right now") with the one kind
            of evidence no feed in this tree carries: somebody standing in it. */}
        <AirportConditionsCard sessionId={session.id} refreshKey={dataEpoch} />

        {/* §15.1 "every active landside plan must expose RETURN TO AIRPORT" —
            directly above the plan it cancels. */}
        {!returnCardFirst && returnCard}

        <LayoverPlanSection
          sessionId={session.id}
          stops={stops}
          planFit={planFit}
          timezone={airport.timezone}
          canEdit={!!canEdit}
          onChanged={onStopsChanged}
          onError={showToast}
        />
        {/* Compass is the EXPLAINER, not an exploration affordance, so it sits
            outside the block below and stays mounted in every posture. It moved
            here from between the recommendations and the map only so that the
            three exploration surfaces are contiguous and can be collapsed as
            one; nothing about the panel itself changed. */}
        <LayoverCompassCard sessionId={session.id} timezone={airport.timezone} />

        {explorationCollapsed ? (
          <View style={styles.collapsedNotice} testID="layover-exploration-collapsed">
            <Text style={styles.collapsedTitle} testID="layover-exploration-collapsed-title">
              {overview.safeReturn?.returnState === 'CONNECTION_AT_RISK'
                ? 'Your connection is at risk'
                : "It's time to head back"}
            </Text>
            <Text style={styles.collapsedBody}>
              Ideas, the map and people nearby are collapsed while you return. The
              return card above has your deadline.
            </Text>
            <Pressable
              style={styles.collapsedBtn}
              onPress={() => setShowExploration(true)}
              testID="layover-exploration-show-anyway"
            >
              <Text style={styles.collapsedBtnText}>Show them anyway</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.exploration} testID="layover-exploration">
            <LayoverRecsSection
              recs={recs}
              loading={recsLoading}
              error={recsError}
              onRetry={() => { setRecsLoading(true); void load(true); }}
              canPlan={!!canEdit}
              addedRecIds={addedRecIds}
              addingRecId={addingRecId}
              onAddToPlan={handleAddRec}
            />
            {/* §13 L116/L117/L119/L121/L122/L125/L126 — the map's three server
                inputs, all of which the server was ALREADY publishing and this
                screen was dropping on the floor:

                  `overview.safeEnvelope`   the certified §8 geometry (L63)
                  `rec.feasibility`         the per-candidate band (L122)
                  `overview.offlineBundle`  certifiedAt / staleAfter (L126)

                `candidateFeasibility` is keyed by RECOMMENDATION id because
                that is what a plan stop carries (`stop.recommendationId`), and
                because L122 names the recommendation contract as the source. A
                stop a traveller typed in themselves has no key here and the
                card renders it as unmeasured — which is the truth, and is not
                the same as unblocked. */}
            <LayoverMapCard
              airport={airport}
              stops={stops}
              airportReturn={airportReturn}
              envelope={overview.safeEnvelope ?? null}
              candidateFeasibility={candidateFeasibility}
              offline={overview.offlineBundle ?? null}
              nowMs={nowMs}
            />
            {/* The overview's `othersInCity` is a SECOND count, from the
                overview route's own `disclosePresence` call. It stays as the
                fallback it always was, and it is passed in UNGUARDED on
                purpose: `degraded` and `withheld` travel with it, and the card
                is the one place that decides whether a count may be claimed
                (`LayoverPeopleSection`, `unmeasured` / `withheldByChoice`). A
                second copy of that decision here was behaviourally identical
                and untestable — a surviving mutation, which is the signal that
                a branch is not load-bearing. One decision, in one place. */}
            <LayoverPeopleSection
              city={city ?? null}
              shareEnabled={overview.share.enabled}
              shareBusy={shareBusy}
              presence={{ ...presence, count: presence.count || overview.share.othersInCity }}
              buddies={buddies}
              canEdit={!!canEdit}
              onToggleShare={handleToggleShare}
              onOpenBuddy={(b) => router.push(`/(rent-a-buddy)/buddy/${b.id}` as any)}
            />

            {/* §25.2 L269 — Layover Discovery. `getLayoverGems` and
                `GET /hidden-gems/layover-safe` had NO caller under `app/layover/`
                for several census passes, so `layover_discovery_mode_enabled`
                (migration 2971) had nothing to turn on. This is the consumer.

                `availableMinutes` is the SERVER's certified
                `window.usableMinutes` — the same figure every other surface
                shows — and not a span this screen subtracts from a clock. The
                card states each gem's own `minimum_layover_minutes` and
                compares it with nothing; the route already filtered on it, and
                a second feasibility answer about the same layover is the defect
                `LayoverReturnPanel.tsx` was deleted at `a718beb5` for.

                It sits INSIDE the exploration block, so the certified posture
                collapses it at RETURN_NOW along with the recommendations, the
                map and the people. An invitation to leave the airport is the
                last thing that should outlive that posture. */}
            <LayoverDiscoveryCard
              availableMinutes={overview.window.usableMinutes}
              city={city ?? null}
              refreshKey={dataEpoch}
            />

            {/* §14 L28/L29/L131 — the crew. Placed with the other people, and
                therefore inside the exploration block, which means it collapses
                with it at RETURN_NOW. That is the certified posture doing its
                job: at RETURN_NOW the default answer is the airport, and
                "collapsed" is one press from open, not hidden. */}
            <LayoverCrewSection
              sessionId={session.id}
              timezone={airport.timezone}
              refreshKey={dataEpoch}
            />
          </View>
        )}
      </ScrollView>
      </KeyboardSafeScrollView>

      {/* Sticky footer.

          §5 L42: *"RETURN_SOON → RETURN_NOW … side effect = switch primary CTA
          to Return to Airport."* The primary slot held "Remind me" in every
          posture, which is the wrong offer at the one moment it matters: a
          reminder is a promise about the future, and the future has arrived.
          The switch is keyed on the SERVER's `returnRoutePrimary` — the same
          certified boolean that hoists the abort card — so the footer and the
          layout cannot disagree, and nothing here re-derives a state from a
          clock. It fires the screen's one abort controller, so the RETURN
          CONTRACT still appears in exactly one place: the card above, which is
          hoisted to the top in this very posture. */}
      {canEdit && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + space.sm }]}>
          {returnCardFirst ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Return to airport now"
              accessibilityState={{ disabled: returnAbort.busy }}
              style={[styles.footerBtn, styles.footerReturn, returnAbort.busy && styles.footerBtnDim]}
              onPress={returnAbort.run}
              disabled={returnAbort.busy}
              testID="layover-footer-return-now"
            >
              {returnAbort.busy
                ? <ActivityIndicator size="small" color={color.signal} />
                : <Plane size={17} color={color.signal} />}
              <Text style={[styles.footerBtnText, { color: color.signal }]}>Return to airport</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.footerBtn, reminderBusy && styles.footerBtnDim]}
              onPress={handleReminder}
              disabled={reminderBusy}
              testID="layover-remind-me"
            >
              {/* A stale reminder is NOT a set reminder. The green bell and the
                  words "Reminder set" were the screen's assertion that a
                  warning was in place, and it kept making it after the flight
                  moved out from under it (census L265). */}
              {overview.returnReminderAt && !reminderStale
                ? <BellRing size={17} color={color.success} />
                : <Bell size={17} color={reminderStale ? color.signal : color.ink} />}
              <Text style={[styles.footerBtnText, reminderStale && { color: color.signal }]}>
                {reminderStale
                  ? 'Reminder out of date'
                  : overview.returnReminderAt ? 'Reminder set' : 'Remind me'}
              </Text>
            </Pressable>
          )}
          <Pressable style={styles.footerBtn} onPress={handleTelegraph}>
            <Send size={17} color={color.ink} />
            <Text style={styles.footerBtnText}>Ask locals</Text>
          </Pressable>
          <Pressable
            style={[styles.footerBtn, styles.footerEnd, endBusy && styles.footerBtnDim]}
            onPress={confirmEnd}
            disabled={endBusy}
            testID="layover-end-open"
          >
            <Power size={17} color={color.signalDim} />
            <Text style={[styles.footerBtnText, { color: color.signalDim }]}>End</Text>
          </Pressable>
        </View>
      )}

      {/* §17.1 L165 — the explanation, in front of the OS dialog rather than
          after it. "Not now" leaves the permission untouched: declining the
          EXPLANATION must not be turned into declining the permission, because
          the OS remembers the second answer and not the first. */}
      <ConfirmSheet
        visible={notifRationaleOpen}
        title="Let us warn you when to head back"
        body={
          `Your safe return time can move while you're out — a longer security queue, ` +
          `traffic, or a flight change. A notification is the only way we can tell you ` +
          `once you've put your phone away. Your phone will ask next; we only use it for ` +
          `this layover's return warnings.`
        }
        confirmLabel="Continue"
        cancelLabel="Not now"
        onConfirm={() => { setNotifRationaleOpen(false); void scheduleReminder(); }}
        onCancel={() => setNotifRationaleOpen(false)}
      />

      {/* §3 L19 / §17 L162 — outcome and election, asked once, on both platforms. */}
      <LayoverEndSheet
        visible={endConfirmOpen}
        stampCity={city}
        busy={endBusy}
        onEnd={doEndLayover}
        onCancel={() => setEndConfirmOpen(false)}
      />

      {toast && (
        <View style={[styles.toast, { bottom: insets.bottom + (canEdit ? 108 : 24) }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.paper },
  topBar:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingBottom: space.sm, backgroundColor: color.paper },
  backBtn:   { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  topTitle:  { ...t.heading, color: color.ink },
  body:      { padding: space.lg, gap: space.md },

  centerFill:{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paper, padding: space.xl, gap: space.sm },
  centerTitle:{ ...t.heading, color: color.ink },
  centerText:{ ...t.small, color: color.mute, textAlign: 'center' },
  retryBtn:  { backgroundColor: color.ink, borderRadius: radius.md, paddingHorizontal: space.xl, paddingVertical: space.md, marginTop: space.md },
  retryBtnText: { ...t.bodyStrong, color: color.onInk },
  // census L150 — the persisted deadline on the failure screen. Bordered in the
  // warning tone because a last-certified time IS a caveat, not because
  // anything went wrong that the traveller caused.
  cachedDeadline:      { marginTop: space.md, alignSelf: 'stretch', backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: 2 },
  cachedDeadlineLabel: { ...t.stamp, color: color.mute, textTransform: 'uppercase' },
  cachedDeadlineTime:  { ...t.title, color: color.ink },
  cachedDeadlineStale: { ...t.small, color: color.warn, fontWeight: '700', marginTop: 4 },
  backLink:  { padding: space.sm },
  backLinkText: { ...t.small, color: color.mute, textDecorationLine: 'underline' },

  footerReturn: { backgroundColor: 'rgba(255,77,46,0.10)', borderRadius: radius.md },
  endedBanner: { backgroundColor: 'rgba(200,133,26,0.12)', borderRadius: radius.md, padding: space.md },
  endedText: { ...t.small, color: color.warn, fontWeight: '600' },

  // §13 L120/L141 — the exploration block and the notice that stands in its
  // place. The wrapper repeats the ScrollView's own `gap` so that collapsing
  // three siblings into one child does not change the spacing between them.
  exploration:     { gap: space.md },
  collapsedNotice: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.xs },
  collapsedTitle:  { ...t.body, color: color.ink, fontWeight: '700' },
  collapsedBody:   { ...t.small, color: color.mute },
  collapsedBtn:    { alignSelf: 'flex-start', paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.sm, backgroundColor: color.haze },
  collapsedBtnText:{ ...t.small, color: color.ink, fontWeight: '600' },

  footer:    { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md, backgroundColor: color.paper, borderTopWidth: 1, borderTopColor: color.haze },
  footerBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.md },
  footerEnd: { borderColor: 'rgba(255,77,46,0.35)' },
  footerBtnDim: { opacity: 0.55 },
  footerBtnText: { ...t.small, fontWeight: '700', color: color.ink },

  driftCard:  { backgroundColor: '#FFF4E5', borderRadius: radius.md, padding: space.md, marginHorizontal: space.xl, marginBottom: space.md, gap: 4 },
  driftTitle: { ...t.small, fontWeight: '700', color: color.ink },
  driftBody:  { ...t.small, color: color.mute },
  toast:     { position: 'absolute', left: space.xl, right: space.xl, backgroundColor: color.ink, borderRadius: radius.md, padding: space.md, alignItems: 'center' },
  toastText: { ...t.small, color: color.onInk, fontWeight: '600' },
});
