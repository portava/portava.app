/**
 * CompassLive — Phase 12 live-session surface.
 *
 * A persistent live travel session the user EXPLICITLY starts and stops:
 *   - inactive → a compact "Go Live" row (explicit start; nothing runs before).
 *   - active   → session state (city, current stop, next stop, timing), the
 *                nudges delivered this session, and a prominent End button.
 *   - stopped  → an end-of-session summary card.
 *
 * While active AND this surface is mounted+focused, it polls
 * /api/compass/live/check on an interval — the interval is cleared on stop,
 * blur, and unmount, so there is zero background activity after the session
 * ends. Companion, not surveillance.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { Radio, Square, MapPin, Clock, Sparkles } from 'lucide-react-native';
import { useFocusEffect } from 'expo-router';
import {
  fetchCompassLiveSession, startCompassLive, stopCompassLive, checkCompassLive,
} from '../../services/compass.ts';
import type { CompassLiveSession, CompassLiveNudge, CompassLiveSummary } from '../../services/compass.ts';
import { subscribeNotificationEvents } from '../../services/notificationEvents.ts';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';

const CHECK_INTERVAL_MS = 60_000;
const LIVE_EVENT_PREFIX = 'compass.live.';

/** Append nudges, deduping on type+title so an SSE-driven insert and the same
 *  nudge arriving in a later poll response never render twice. */
function appendNudges(prev: CompassLiveNudge[], incoming: CompassLiveNudge[]): CompassLiveNudge[] {
  const seen = new Set(prev.map((n) => `${n.type}:${n.title}`));
  const fresh = incoming.filter((n) => !seen.has(`${n.type}:${n.title}`));
  return fresh.length === 0 ? prev : [...prev, ...fresh].slice(-6);
}

export function CompassLive({
  refreshNonce = 0,
  onRefreshed,
}: {
  /** Increment to force a re-fetch of live-session state (pull-to-refresh). */
  refreshNonce?: number;
  /** Called when a nonce-triggered refresh settles (success or failure). */
  onRefreshed?: () => void;
} = {}) {
  const [session, setSession] = useState<CompassLiveSession | null>(null);
  const [nudges, setNudges]   = useState<CompassLiveNudge[]>([]);
  const [summary, setSummary] = useState<CompassLiveSummary | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy]       = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
  }, []);

  const runCheck = useCallback(async () => {
    if (!activeRef.current) return;
    const r = await checkCompassLive();
    if (!r.ok || r.compassEnabled === false) return;
    if (!r.active) { activeRef.current = false; clearTimer(); setSession(null); return; }
    if (r.session) setSession(r.session);
    if (r.delivered && r.delivered.length > 0) {
      setNudges((prev) => appendNudges(prev, r.delivered!));
    }
  }, [clearTimer]);

  const armTimer = useCallback(() => {
    clearTimer();
    timer.current = setInterval(() => { runCheck().catch(() => {}); }, CHECK_INTERVAL_MS);
  }, [clearTimer, runCheck]);

  // Resume state on focus; stop all polling on blur/unmount.
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    // Event-driven refresh: when a live-nudge notification arrives over the
    // realtime stream, show it immediately and refresh session context —
    // no wait for the next 60 s poll tick. Ignored entirely (no network,
    // no state) unless a session is active; unsubscribed on blur/unmount.
    const unsubscribe = subscribeNotificationEvents((evt) => {
      if (!activeRef.current) return;
      if (!evt.eventType || !evt.eventType.startsWith(LIVE_EVENT_PREFIX)) return;
      if (evt.title && evt.body) {
        const nudge: CompassLiveNudge = {
          type: evt.eventType.slice(LIVE_EVENT_PREFIX.length),
          title: evt.title,
          body: evt.body,
          actionUrl: evt.actionUrl ?? '',
        };
        setNudges((prev) => appendNudges(prev, [nudge]));
      }
      runCheck().catch(() => {});
    });
    (async () => {
      const r = await fetchCompassLiveSession();
      if (cancelled) return;
      if (!r.ok) return;
      if (r.compassEnabled === false) { setEnabled(false); return; }
      setEnabled(true);
      if (r.active && r.session) {
        setSession(r.session);
        activeRef.current = true;
        armTimer();
        runCheck().catch(() => {});
      }
    })();
    return () => { cancelled = true; activeRef.current = false; clearTimer(); unsubscribe(); };
  }, [armTimer, clearTimer, runCheck]));

  useEffect(() => () => clearTimer(), [clearTimer]);

  // Pull-to-refresh: re-sync live-session state on demand. If a session is
  // active this is a poll-now (same as the interval tick); otherwise it
  // re-fetches session state so a session started elsewhere shows up.
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;
  useEffect(() => {
    if (refreshNonce <= 0) return;
    let cancelled = false;
    (async () => {
      try {
        if (activeRef.current) {
          await runCheck();
          return;
        }
        const r = await fetchCompassLiveSession();
        if (cancelled || !r.ok) return;
        if (r.compassEnabled === false) { setEnabled(false); return; }
        setEnabled(true);
        if (r.active && r.session) {
          setSession(r.session);
          activeRef.current = true;
          armTimer();
        }
      } catch {
        // best-effort refresh — never crash the surface
      } finally {
        if (!cancelled) onRefreshedRef.current?.();
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  async function onStart() {
    if (busy) return;
    setBusy(true);
    setSummary(null);
    const r = await startCompassLive();
    setBusy(false);
    if (!r.ok || r.compassEnabled === false || !r.session) return;
    setSession(r.session);
    setNudges([]);
    activeRef.current = true;
    armTimer();
  }

  async function onStop() {
    if (busy) return;
    setBusy(true);
    activeRef.current = false;
    clearTimer();
    const r = await stopCompassLive();
    setBusy(false);
    setSession(null);
    setNudges([]);
    if (r.ok && r.summary) setSummary(r.summary);
  }

  if (!enabled) return null;

  // ── End-of-session summary ─────────────────────────────────────────────────
  if (!session && summary) {
    return (
      <View style={styles.card} testID="live-summary">
        <View style={styles.head}>
          <Sparkles size={15} color={color.signal} />
          <Text style={styles.headText}>LIVE SESSION ENDED</Text>
        </View>
        <Text style={styles.summaryLine}>
          {summary.durationMinutes} min{summary.city ? ` in ${summary.city}` : ''} · {summary.stopsReached} stop{summary.stopsReached === 1 ? '' : 's'} reached · {summary.nudgesDelivered} nudge{summary.nudgesDelivered === 1 ? '' : 's'}
        </Text>
        <Pressable style={styles.dismissBtn} onPress={() => setSummary(null)}>
          <Text style={styles.dismissText}>Dismiss</Text>
        </Pressable>
      </View>
    );
  }

  // ── Inactive → explicit start control ──────────────────────────────────────
  if (!session) {
    return (
      <Pressable style={styles.goLiveRow} onPress={onStart} disabled={busy} testID="live-start">
        <Radio size={16} color={color.signal} />
        <View style={{ flex: 1 }}>
          <Text style={styles.goLiveTitle}>Go Live with Compass</Text>
          <Text style={styles.goLiveSub}>Timely nudges while you're out — only while a session is on.</Text>
        </View>
        {busy ? <ActivityIndicator size="small" color={color.signal} /> : null}
      </Pressable>
    );
  }

  // ── Active session ─────────────────────────────────────────────────────────
  const ctx = session.context;
  return (
    <View style={styles.card} testID="live-active">
      <View style={styles.head}>
        <View style={styles.liveDot} />
        <Text style={styles.headText}>LIVE{ctx.city ? ` · ${ctx.city.toUpperCase()}` : ''}</Text>
      </View>

      {ctx.currentStop ? (
        <View style={styles.row}>
          <MapPin size={13} color={color.mute} />
          <Text style={styles.rowText}>Now: {ctx.currentStop.title}</Text>
        </View>
      ) : null}
      {ctx.nextItem ? (
        <View style={styles.row}>
          <Clock size={13} color={color.mute} />
          <Text style={styles.rowText}>
            Next: {ctx.nextItem.title}
            {ctx.minutesToNext != null ? ` · in ~${ctx.minutesToNext} min` : ''}
          </Text>
        </View>
      ) : null}
      {!ctx.currentStop && !ctx.nextItem ? (
        <Text style={styles.rowText}>No timed plan items right now — ask Compass for ideas below.</Text>
      ) : null}

      {nudges.map((n, i) => (
        <View key={`${n.type}-${i}`} style={styles.nudge}>
          <Text style={styles.nudgeTitle}>{n.title}</Text>
          <Text style={styles.nudgeBody}>{n.body}</Text>
        </View>
      ))}

      <Pressable style={styles.stopBtn} onPress={onStop} disabled={busy} testID="live-stop">
        <Square size={13} color="#fff" fill="#fff" />
        <Text style={styles.stopText}>End live session</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card:        { backgroundColor: color.paperRaised, padding: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, ...shadow.card, gap: space.sm },
  head:        { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headText:    { ...t.stamp, fontFamily: 'Courier', color: color.signal },
  liveDot:     { width: 8, height: 8, borderRadius: 4, backgroundColor: '#E53935' },
  row:         { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowText:     { ...t.small, color: color.ink, flex: 1 },
  nudge:       { backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: 2 },
  nudgeTitle:  { ...t.small, fontWeight: '700', color: color.ink },
  nudgeBody:   { ...t.small, color: color.mute },
  stopBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#C62828', borderRadius: radius.pill, paddingVertical: space.md, marginTop: space.xs },
  stopText:    { ...t.small, fontWeight: '700', color: '#fff' },
  goLiveRow:   { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.lg, padding: space.md },
  goLiveTitle: { ...t.small, fontWeight: '700', color: color.ink },
  goLiveSub:   { ...t.small, color: color.mute },
  summaryLine: { ...t.small, color: color.ink },
  dismissBtn:  { alignSelf: 'flex-start', paddingVertical: space.xs },
  dismissText: { ...t.small, fontWeight: '700', color: color.mute },
});
