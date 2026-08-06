/**
 * Layover dashboard — the live command center for an active layover.
 *
 * Hero (countdown, tier, airport-local time) → Can-I-Leave guidance →
 * mini-plan with hard return marker → time-aware recommendations → map →
 * people (presence opt-in + Rent-a-Buddy) → sticky footer actions.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator,
  RefreshControl, Alert, Platform,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Bell, BellRing, Power, Send } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
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
  type PresenceTraveler,
  type StopsResponse,
} from '../../src/services/layover';
import {
  cancelScheduledNotification,
  scheduleLocalNotificationAt,
} from '../../src/lib/safeNotifications';
import { AirportEssentialsCard } from '../../src/components/layover/AirportEssentialsCard';
import { LayoverHero } from '../../src/components/layover/LayoverHero';
import { CanILeaveCard } from '../../src/components/layover/CanILeaveCard';
import { LayoverPlanSection } from '../../src/components/layover/LayoverPlanSection';
import { LayoverRecsSection } from '../../src/components/layover/LayoverRecsSection';
import { LayoverMapCard } from '../../src/components/layover/LayoverMapCard';
import { LayoverPeopleSection } from '../../src/components/layover/LayoverPeopleSection';
import { fmtClock } from '../../src/components/layover/layoverFormat';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';

export default function LayoverDashboardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [overview, setOverview] = useState<LayoverOverview | null>(null);
  const [recs, setRecs] = useState<LayoverRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [recsLoading, setRecsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const [presence, setPresence] = useState<{ count: number; travelers: PresenceTraveler[] }>({ count: 0, travelers: [] });
  const [buddies, setBuddies] = useState<LayoverBuddy[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [addingRecId, setAddingRecId] = useState<string | null>(null);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
  // QA round 2, minor F: drives the in-app confirm on web (see confirmEnd).
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const notifIdRef = useRef<string | null>(null);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The countdown ticks locally, but usable-window/plan-fit math must stay
  // canonical: silently re-pull the overview every 60s while active so the
  // safety numbers never overstate remaining margin.
  const sessionStatus = overview?.session.status;
  useEffect(() => {
    if (!id || sessionStatus !== 'active') return;
    const timer = setInterval(async () => {
      const ov = await getLayoverOverview(id);
      if (ov) setOverview(ov);
    }, 60_000);
    return () => clearInterval(timer);
  }, [id, sessionStatus]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3200);
  }, []);

  const loadPresence = useCallback(async (sessionId: string) => {
    const res = await getLayoverPresence(sessionId);
    if (res?.sharing) setPresence({ count: res.count, travelers: res.travelers });
    else setPresence({ count: 0, travelers: [] });
  }, []);

  const load = useCallback(async (isRefresh = false) => {
    if (!id) return;
    if (!isRefresh) setLoading(true);
    setLoadError(false);
    const [ov, recList, buddyRes] = await Promise.all([
      getLayoverOverview(id),
      getRecommendations(id).finally(() => setRecsLoading(false)),
      getLayoverBuddies(id),
    ]);
    if (ov) {
      setOverview(ov);
      if (ov.share.enabled) loadPresence(id);
      setBuddies(buddyRes?.buddies ?? []);
    } else {
      setLoadError(true);
    }
    setRecs(recList);
    setLoading(false);
    setRefreshing(false);
  }, [id, loadPresence]);

  useEffect(() => { load(); }, [load]);

  const canEdit = overview?.session.status === 'active';
  const city = overview
    ? (overview.airport.city !== 'Unknown' ? overview.airport.city : overview.session.manualCity)
    : null;

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
        else setPresence({ count: 0, travelers: [] });
      } else {
        showToast('Could not update sharing');
      }
    } finally {
      setShareBusy(false);
    }
  }, [id, overview, loadPresence, showToast]);

  const handleReminder = useCallback(async () => {
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

  const handleTelegraph = useCallback(async () => {
    if (!id || !overview) return;
    const msg = `On a layover in ${city ?? 'town'} with about ${Math.round(overview.window.usableMinutes / 60)}h to spare — any quick tips?`;
    const res = await sendLayoverTelegraph(id, msg);
    if (overview.session.tripId) {
      router.push(`/trip/chat?id=${overview.session.tripId}` as any);
    } else if (res) {
      router.push({ pathname: '/ai', params: { prefillMessage: msg } } as any);
    } else {
      showToast('Telegraph is unavailable right now');
    }
  }, [id, overview, city, router, showToast]);

  const doEndLayover = useCallback(async () => {
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
  }, [doEndLayover]);

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

  if (loadError || !overview) {
    return (
      <View style={styles.centerFill}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.centerTitle}>Couldn't load this layover</Text>
        <Text style={styles.centerText}>It may have been removed, or you're offline.</Text>
        <Pressable style={styles.retryBtn} onPress={() => load()}>
          <Text style={styles.retryBtnText}>Try again</Text>
        </Pressable>
        <Pressable style={styles.backLink} onPress={() => router.back()}>
          <Text style={styles.backLinkText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const { session, airport, window: win, advice, stops, planFit, localTimes } = overview;

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

        <LayoverHero airport={airport} session={session} window={win} localTimes={localTimes} nowMs={nowMs} />
        <CanILeaveCard advice={advice} window={win} airport={airport} />
        <AirportEssentialsCard countryCode={airport.countryCode} countryName={airport.country !== 'Unknown' ? airport.country : undefined} />
        <LayoverPlanSection
          sessionId={session.id}
          stops={stops}
          planFit={planFit}
          timezone={airport.timezone}
          canEdit={!!canEdit}
          onChanged={onStopsChanged}
          onError={showToast}
        />
        <LayoverRecsSection
          recs={recs}
          loading={recsLoading}
          canPlan={!!canEdit}
          addedRecIds={addedRecIds}
          addingRecId={addingRecId}
          onAddToPlan={handleAddRec}
        />
        <LayoverMapCard airport={airport} stops={stops} />
        <LayoverPeopleSection
          city={city ?? null}
          shareEnabled={overview.share.enabled}
          shareBusy={shareBusy}
          presenceCount={presence.count || overview.share.othersInCity}
          travelers={presence.travelers}
          buddies={buddies}
          canEdit={!!canEdit}
          onToggleShare={handleToggleShare}
          onOpenBuddy={(b) => router.push(`/(rent-a-buddy)/buddy/${b.id}` as any)}
        />
      </ScrollView>
      </KeyboardSafeScrollView>

      {/* Sticky footer */}
      {canEdit && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + space.sm }]}>
          <Pressable
            style={[styles.footerBtn, reminderBusy && styles.footerBtnDim]}
            onPress={handleReminder}
            disabled={reminderBusy}
          >
            {overview.returnReminderAt
              ? <BellRing size={17} color={color.success} />
              : <Bell size={17} color={color.ink} />}
            <Text style={styles.footerBtnText}>{overview.returnReminderAt ? 'Reminder set' : 'Remind me'}</Text>
          </Pressable>
          <Pressable style={styles.footerBtn} onPress={handleTelegraph}>
            <Send size={17} color={color.ink} />
            <Text style={styles.footerBtnText}>Ask locals</Text>
          </Pressable>
          <Pressable
            style={[styles.footerBtn, styles.footerEnd, endBusy && styles.footerBtnDim]}
            onPress={confirmEnd}
            disabled={endBusy}
          >
            <Power size={17} color={color.signalDim} />
            <Text style={[styles.footerBtnText, { color: color.signalDim }]}>End</Text>
          </Pressable>
        </View>
      )}

      <ConfirmSheet
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
  backBtn:   { width: 36, height: 36, borderRadius: 18, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  topTitle:  { ...t.heading, color: color.ink },
  body:      { padding: space.lg, gap: space.md },

  centerFill:{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paper, padding: space.xl, gap: space.sm },
  centerTitle:{ ...t.heading, color: color.ink },
  centerText:{ ...t.small, color: color.mute, textAlign: 'center' },
  retryBtn:  { backgroundColor: color.ink, borderRadius: radius.md, paddingHorizontal: space.xl, paddingVertical: space.md, marginTop: space.md },
  retryBtnText: { ...t.bodyStrong, color: color.onInk },
  backLink:  { padding: space.sm },
  backLinkText: { ...t.small, color: color.mute, textDecorationLine: 'underline' },

  endedBanner: { backgroundColor: 'rgba(200,133,26,0.12)', borderRadius: radius.md, padding: space.md },
  endedText: { ...t.small, color: color.warn, fontWeight: '600' },

  footer:    { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md, backgroundColor: color.paper, borderTopWidth: 1, borderTopColor: color.haze },
  footerBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.md },
  footerEnd: { borderColor: 'rgba(255,77,46,0.35)' },
  footerBtnDim: { opacity: 0.55 },
  footerBtnText: { ...t.small, fontWeight: '700', color: color.ink },

  toast:     { position: 'absolute', left: space.xl, right: space.xl, backgroundColor: color.ink, borderRadius: radius.md, padding: space.md, alignItems: 'center' },
  toastText: { ...t.small, color: color.onInk, fontWeight: '600' },
});
