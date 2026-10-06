/**
 * Telegraph §2.1 — the inbox is not a generic notification feed.
 *
 *   TELEGRAPH
 *   YOUR STATUS        Available tonight · until 1:00 AM
 *   AVAILABLE NEARBY   Marcus · 8 min · Food …
 *   NOW                Dinner with Marcus · 42 min
 *   UPCOMING           Hoi An tomorrow · Beach Friday
 *   MESSAGES           …
 *
 * "It contains communication PLUS shared real-world context that materially
 *  affects communication." census-telegraph T8: "There is no status band, no
 * available-nearby band, no NOW and no UPCOMING band — the 'shared real-world
 * context' half of the assertion has no implementation."
 *
 * Each band is a projection somebody else already serves; nothing here derives
 * a fact of its own:
 *   YOUR STATUS        GET /api/me/quick-availability (the person's own, opt-in)
 *   AVAILABLE NEARBY   GET /api/nearby/reachable (§30A.2 — bucketed, flag-gated)
 *   NOW                GET /api/me/coordination-sessions (open §8 sessions)
 *   UPCOMING           GET /api/me/meetups?filter=upcoming
 *
 * WHAT A BAND MAY SAY WHEN ITS READ FAILS: NOTHING. A failed read draws no band
 * and no "nothing here" line — the one thing a band must not do is turn an
 * outage into a statement that you have no plans or that nobody is around. An
 * EMPTY answer draws no band either, so no band ever asserts an absence.
 *
 * YOUR STATUS is the person's own state, so its failure is SAID rather than
 * left blank: `GET /me/quick-availability` now answers a failed read with a 503
 * (it used to answer `status: null`, the same bytes as "no status set"), and
 * this band says "Couldn't load your status" — while an unset status, a real
 * answer, draws nothing.
 *
 * AVAILABLE NEARBY speaks only when the server says the surface is ENABLED.
 * `enabled: false` is the flag answering, not an empty neighbourhood, and the
 * band is absent rather than claiming "nobody nearby". It shows counts and
 * buckets only — the projection carries no name and no distance, by design.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { fetchInboxBands, type InboxBandsData } from './inboxBandsApi.ts';

export interface InboxContextBandsProps {
  /** Opens a conversation (NOW, UPCOMING). */
  onOpenThread?: (threadId: string) => void;
  /** Test seam: render this instead of fetching. */
  initialData?: InboxBandsData | null;
  /** Injected clock for time words. */
  nowMs?: number;
}

const STATUS_WORDS: Record<string, string> = {
  free_now: 'Free now',
  free_tonight: 'Free tonight',
  open_to_plans: 'Open to plans',
  busy: 'Busy',
};

function timeWord(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const t0 = Date.parse(iso);
  if (!Number.isFinite(t0)) return null;
  const mins = Math.round((t0 - nowMs) / 60_000);
  if (mins <= 0) return null;
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

export function statusLine(status: InboxBandsData['status'], nowMs: number): string | null {
  if (!status) return null;
  if (!status.status) return null;
  const word = STATUS_WORDS[status.status] ?? null;
  if (!word) return null;
  const until = status.expiresAt ? Date.parse(status.expiresAt) : NaN;
  if (Number.isFinite(until) && until <= nowMs) return null; // expired is not a status
  if (!Number.isFinite(until)) return word;
  const d = new Date(until);
  const hh = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${word} · until ${hh}:${mm}`;
}

export function InboxContextBands({ onOpenThread, initialData = null, nowMs }: InboxContextBandsProps) {
  const palette = useTelegraphPalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [data, setData] = useState<InboxBandsData | null>(initialData);
  // The inbox is a tab and stays mounted: re-read the clock on every render and
  // tick once a minute, so an expired "Free now · until …" does not stay on
  // screen (verifier F5). The data refresh is the screen's; the clock is ours.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (nowMs !== undefined) return;
    const h = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(h);
  }, [nowMs]);

  useEffect(() => {
    if (initialData !== null) return;
    let cancelled = false;
    void (async () => {
      const d = await fetchInboxBands();
      if (!cancelled) setData(d);
    })();
    return () => { cancelled = true; };
  }, [initialData]);

  if (!data) return null;
  const now = nowMs ?? Date.now();
  const status = statusLine(data.status, now);
  const nearby = data.nearby && data.nearby.enabled && data.nearby.count > 0 ? data.nearby : null;
  const sessions = data.now ?? [];
  const upcoming = data.upcoming ?? [];

  const statusFailed = data.status === null; // the read failed — distinct from a status that is not set
  const anything = status !== null || statusFailed || nearby || sessions.length > 0 || upcoming.length > 0;
  if (!anything) return null;

  return (
    <View style={styles.wrap} testID="telegraph-inbox-bands">
      {status !== null || statusFailed ? (
        <View testID="telegraph-band-status">
          <Text style={styles.label}>YOUR STATUS</Text>
          {statusFailed ? (
            <Text style={styles.failed} testID="telegraph-band-status-failed">
              Couldn't load your status
            </Text>
          ) : (
            <Text style={styles.line}>{status}</Text>
          )}
        </View>
      ) : null}

      {nearby ? (
        <View testID="telegraph-band-nearby">
          <Text style={styles.label}>AVAILABLE NEARBY</Text>
          <Text style={styles.line}>
            {nearby.count === 1 ? '1 person' : `${nearby.count} people`} from your circles and trips
            {nearby.availableNow > 0 ? ` · ${nearby.availableNow} free now` : ''}
          </Text>
        </View>
      ) : null}

      {sessions.length > 0 ? (
        <View testID="telegraph-band-now">
          <Text style={styles.label}>NOW</Text>
          {sessions.slice(0, 3).map((s) => (
            <Pressable
              key={s.sessionId}
              testID={`telegraph-band-now-${s.sessionId}`}
              accessibilityRole="button"
              accessibilityLabel={`Open ${s.title}`}
              disabled={!onOpenThread}
              onPress={() => onOpenThread?.(s.threadId)}
            >
              <Text style={styles.line} numberOfLines={1}>
                {s.title}
                {s.state ? ` · ${s.state.toLowerCase()}` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {upcoming.length > 0 ? (
        <View testID="telegraph-band-upcoming">
          <Text style={styles.label}>UPCOMING</Text>
          {upcoming.slice(0, 3).map((m) => {
            const when = timeWord(m.startsAt, now);
            return (
              <Pressable
                key={m.id}
                testID={`telegraph-band-upcoming-${m.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Open ${m.title}`}
                disabled={!onOpenThread || !m.chatThreadId}
                onPress={() => (m.chatThreadId ? onOpenThread?.(m.chatThreadId) : undefined)}
              >
                <Text style={styles.line} numberOfLines={1}>
                  {m.title}
                  {when ? ` · ${when}` : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    wrap: {
      marginHorizontal: space.lg,
      marginBottom: space.sm,
      padding: space.md,
      borderRadius: radius.md,
      backgroundColor: p.surfaceRaised,
      gap: space.sm,
    },
    label: { ...t.small, color: p.mute, letterSpacing: 0.6, fontWeight: '700' },
    line: { ...t.body, color: p.recvText },
    failed: { ...t.body, color: p.mute },
  });
}

export default InboxContextBands;
