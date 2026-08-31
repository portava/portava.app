/**
 * CompassHome — Phase 10 context-aware home surface for the Compass tab.
 *
 * Replaces the blank-chat empty state with a real-data card stack:
 *   • Best next move   — top pipeline pick; taps navigate to the real entity
 *   • Circle activity  — who's around (privacy-guarded, approximate only)
 *   • Starting soon    — public events beginning within hours → event screens
 *   • Tonight's vibe   — evening/night only, real events tonight
 *   • Weather window   — tomorrow's forecast for the current city
 * plus the six core actions, each prefilling a grounded intent into chat.
 *
 * Honesty rules: every section is backed by server data; sections with no
 * real data (null/empty) render nothing. No template cards, no placeholders.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, AppState } from 'react-native';
import {
  Compass, Sparkles, Users, CalendarClock, Moon, CloudSun, Sun,
  Zap, Martini, UserPlus, Map as MapIcon, Shuffle, Plane,
} from 'lucide-react-native';
import { router } from 'expo-router';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  fetchCompassHome,
  type CompassHomeResponse,
  type CompassHomeEvent,
} from '../../services/compass.ts';
import { CompassRediscover } from './CompassRediscover.tsx';

// ── Six core actions — each prefills a grounded intent into the chat flow ─────

export const CORE_ACTIONS: Array<{ key: string; label: string; prompt: string }> = [
  { key: 'right_now',  label: 'What should I do right now', prompt: 'What should I do right now?' },
  { key: 'tonight',    label: 'Tonight',                    prompt: 'What should I do tonight?' },
  { key: 'meet',       label: 'Meet People',                prompt: 'Help me meet people nearby — who\'s around and what\'s social right now?' },
  { key: 'build_day',  label: 'Build My Day',               prompt: 'Build my day — plan out the rest of today for me.' },
  { key: 'surprise',   label: 'Surprise Me',                prompt: 'Surprise me with something I wouldn\'t have thought of.' },
  { key: 'my_trip',    label: 'My Trip',                    prompt: 'What\'s the status of my trip and what should I do next on it?' },
];

const ACTION_ICONS: Record<string, React.ReactNode> = {
  right_now: <Zap size={14} color={color.signal} />,
  tonight:   <Martini size={14} color={color.signal} />,
  meet:      <UserPlus size={14} color={color.signal} />,
  build_day: <MapIcon size={14} color={color.signal} />,
  surprise:  <Shuffle size={14} color={color.signal} />,
  my_trip:   <Plane size={14} color={color.signal} />,
};

function timeGreeting(timeOfDay?: string): string {
  switch (timeOfDay) {
    case 'morning':   return 'Good morning';
    case 'afternoon': return 'Good afternoon';
    case 'evening':   return 'Good evening';
    case 'night':     return 'Late night';
    default:          return 'Welcome back';
  }
}

function eventTimeLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ── Section shells ────────────────────────────────────────────────────────────

function SectionTitle({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <View style={s.sectionTitleRow}>
      {icon}
      <Text style={s.sectionTitle}>{label}</Text>
    </View>
  );
}

function EventRow({ ev }: { ev: CompassHomeEvent }) {
  const time = eventTimeLabel(ev.startsAt);
  return (
    <Pressable
      style={({ pressed }) => [s.eventRow, pressed && { opacity: 0.8 }]}
      onPress={() => router.push(`/event/${ev.id}` as any)}
      accessibilityLabel={`Event ${ev.title}`}
    >
      <View style={{ flex: 1 }}>
        <Text style={s.eventTitle} numberOfLines={1}>{ev.title}</Text>
        <Text style={s.eventMeta} numberOfLines={1}>
          {[time, ev.city, ev.category].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Text style={s.eventGo}>View</Text>
    </Pressable>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

/** Content older than this refetches automatically when the app foregrounds. */
export const HOME_STALE_MS = 5 * 60 * 1000;

export function CompassHome({
  onAsk,
  refreshNonce = 0,
  onRefreshed,
}: {
  onAsk: (prompt: string) => void;
  /** Bump to trigger a silent refetch (pull-to-refresh). Existing cards stay visible. */
  refreshNonce?: number;
  /** Called when a nonce-triggered refetch settles (success or failure). */
  onRefreshed?: () => void;
}) {
  const [home, setHome] = useState<CompassHomeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const loadedAt = useRef(0);
  const inFlight = useRef(false);
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;

  // Silent refetch: existing cards stay visible — only the initial load shows a spinner.
  const load = useCallback((done?: () => void) => {
    if (inFlight.current) { done?.(); return; }
    inFlight.current = true;
    fetchCompassHome()
      .then((r) => {
        if (r.ok && r.data) {
          setHome(r.data);
          loadedAt.current = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
        setLoading(false);
        done?.();
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  // Pull-to-refresh from the parent scroll view.
  useEffect(() => {
    if (refreshNonce > 0) load(() => onRefreshedRef.current?.());
  }, [refreshNonce, load]);

  // Foreground staleness refetch: returning to the app after a while refreshes quietly.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && loadedAt.current > 0 && Date.now() - loadedAt.current > HOME_STALE_MS) {
        load();
      }
    });
    return () => sub.remove();
  }, [load]);

  function bestMoveTap() {
    const move = home?.bestNextMove;
    if (!move) return;
    if (move.type === 'event')                          router.push(`/event/${move.id}` as any);
    else if (move.type === 'hidden_gem')                router.push(`/gems/${move.id.replace(/^gem:/, '')}` as any);
    else if (move.type === 'place')                     router.push('/(tabs)/discovery' as any);
    else if (move.type === 'traveler' || move.type === 'user') router.push('/(tabs)/discovery' as any);
    else if (move.type === 'post')                      router.push(`/post/${move.id}` as any);
    else onAsk(`Tell me more about ${move.title ?? 'your top pick for me'}.`);
  }

  const showData = !!home && home.compassEnabled && !home.fallback;

  return (
    <View style={s.wrap}>
      {/* Header */}
      <View style={s.hero}>
        <Compass size={22} color={color.signal} />
        <Text style={s.heroTitle}>
          {timeGreeting(home?.timeOfDay)}{home?.city ? ` in ${home.city}` : ''}
        </Text>
        <Text style={s.heroSub}>Ask Compass, or start from where you are.</Text>
      </View>

      {/* Six core actions */}
      <View style={s.actionsGrid}>
        {CORE_ACTIONS.map((a) => (
          <Pressable
            key={a.key}
            style={({ pressed }) => [s.actionChip, pressed && { opacity: 0.8 }]}
            onPress={() => onAsk(a.prompt)}
            accessibilityLabel={a.label}
          >
            {ACTION_ICONS[a.key]}
            <Text style={s.actionLabel}>{a.label}</Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.lg }} />
      ) : null}

      {/* Best next move */}
      {showData && home?.bestNextMove ? (
        <Pressable style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]} onPress={bestMoveTap}>
          <SectionTitle icon={<Sparkles size={13} color={color.signal} />} label="Best next move" />
          <Text style={s.cardTitle} numberOfLines={2}>
            {home.bestNextMove.title ?? 'Your top pick'}
          </Text>
          <Text style={s.cardMeta} numberOfLines={1}>
            {[home.bestNextMove.category, home.bestNextMove.city].filter(Boolean).join(' · ')}
          </Text>
        </Pressable>
      ) : null}

      {/* Rediscovery (§8) — memory resurfaced on returning to this city.
          Collapses to nothing until the memory_projection flag is on. */}
      {showData && home?.city ? (
        <CompassRediscover city={home.city} collapseWhenEmpty />
      ) : null}

      {/* Circle activity */}
      {showData && home?.circleActivity?.people?.length ? (
        <Pressable
          style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}
          onPress={() => onAsk("Who's around from my circles right now, and what could we do together?")}
        >
          <SectionTitle icon={<Users size={13} color={color.signal} />} label="Your circle" />
          {home.circleActivity.people.slice(0, 3).map((p, i) => (
            <Text key={`${p.handle ?? p.label}_${i}`} style={s.personLine} numberOfLines={1}>
              {p.label}
              {p.statusLabel ? ` — ${p.statusLabel}` : ''}
              {p.venue ? ` @ ${p.venue}` : p.approximateArea ? ` · ${p.approximateArea}` : ''}
            </Text>
          ))}
        </Pressable>
      ) : null}

      {/* Starting soon */}
      {showData && home?.startingSoon?.length ? (
        <View style={s.card}>
          <SectionTitle icon={<CalendarClock size={13} color={color.signal} />} label="Starting soon" />
          {home.startingSoon.slice(0, 3).map((ev) => <EventRow key={ev.id} ev={ev} />)}
        </View>
      ) : null}

      {/* Tonight's vibe (evening/night only, server-gated) */}
      {showData && home?.tonightVibe ? (
        <View style={s.card}>
          <SectionTitle icon={<Moon size={13} color={color.signal} />} label="Tonight's vibe" />
          <Text style={s.cardMeta}>{home.tonightVibe.headline}</Text>
          {home.tonightVibe.events.slice(0, 3).map((ev) => <EventRow key={`tv_${ev.id}`} ev={ev} />)}
        </View>
      ) : null}

      {/* Tomorrow's weather window */}
      {showData && home?.weatherWindow ? (
        <Pressable
          style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}
          onPress={() =>
            onAsk(`Tomorrow looks like ${home!.weatherWindow!.summary.toLowerCase()} in ${home!.weatherWindow!.city} — what should I plan?`)
          }
        >
          <SectionTitle
            icon={home.weatherWindow.precipMm > 2 ? <CloudSun size={13} color={color.signal} /> : <Sun size={13} color={color.signal} />}
            label="Tomorrow's window"
          />
          <Text style={s.cardTitle}>{home.weatherWindow.headline}</Text>
          <Text style={s.cardMeta}>
            {`${Math.round(home.weatherWindow.minTempC)}–${Math.round(home.weatherWindow.maxTempC)}°C · ${home.weatherWindow.city}`}
          </Text>
        </Pressable>
      ) : null}

      {/* Ask Compass — chat stays one tap away */}
      <View style={s.askHint}>
        <Sparkles size={12} color={color.mute} />
        <Text style={s.askHintText}>Or ask Compass anything below.</Text>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  wrap:            { gap: space.md },
  hero:            { alignItems: 'center', gap: 4, paddingTop: space.lg, paddingBottom: space.sm },
  heroTitle:       { ...t.heading, color: color.ink, textAlign: 'center' },
  heroSub:         { ...t.small, color: color.mute, textAlign: 'center' },
  actionsGrid:     { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, justifyContent: 'center' },
  actionChip:      { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  actionLabel:     { ...t.small, fontWeight: '700', color: color.ink },
  card:            { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: 6 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sectionTitle:    { ...t.stamp, fontFamily: 'Courier', color: color.signal },
  cardTitle:       { ...t.bodyStrong, color: color.ink },
  cardMeta:        { ...t.small, color: color.mute },
  personLine:      { ...t.small, color: color.ink },
  eventRow:        { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 4 },
  eventTitle:      { ...t.small, fontWeight: '700', color: color.ink },
  eventMeta:       { ...t.small, color: color.mute, fontSize: 10 },
  eventGo:         { ...t.small, fontWeight: '700', color: color.signal },
  askHint:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: space.sm },
  askHintText:     { ...t.small, color: color.mute },
});
