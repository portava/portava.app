/**
 * TripCrewPresenceCard — §10 on screen, and the first thing that ever read it.
 *
 * WHY THE STALE ROWS ARE SHOWN RATHER THAN HIDDEN
 * ===============================================
 * §10.2: the map must never draw a stale location as if it were current. The
 * tempting reading of that is "hide anything stale", and it is wrong — §10.4
 * says last-known data may remain useful but is not live truth, and a hidden
 * row cannot be useful. So a stale row is shown, in the muted style, with its
 * age and its label. What is never done is drawing it like a live one.
 *
 * The freshness label and the `isCurrent` decision both come from the server,
 * which computed them from the same clock the expiry uses. This component does
 * NOT recompute either from `observedAt`: a device clock a few minutes fast
 * would make a stale row look live, which is exactly the failure §10.2 names.
 *
 * THREE ABSENCES THAT ARE NOT THE SAME
 * ====================================
 *   `noPresence`      crew who have never been observed. Rendered as "Not
 *                     sharing", because that is what it is.
 *   state 'offline'   they reported being offline. That is a report.
 *   an unavailable    the read failed. Rendered as a refusal to say anything,
 *   read              never as an empty crew list — "nobody is sharing" is a
 *                     claim about people, and a failed query has not made it.
 *
 * THE WRITER IS HERE TOO, AND THAT IS THE POINT
 * =============================================
 * SET_PRESENCE and CLEAR_PRESENCE reached the kernel in migration 2768 and
 * were issuable over §11's command endpoint, and no screen could send either.
 * A command family nothing can issue is a stored procedure, so the control
 * lives on the card that reads the result — the shortest loop between the two
 * halves, and the only arrangement in which one can be seen to affect the other.
 *
 * TWO THINGS THE CONTROL DOES THAT A NAIVE ONE WOULD NOT
 * =====================================================
 * 1. The idempotency key is derived from the OBSERVATION (trip, state, minute),
 *    not minted per tap. A double tap is the same observation and must not
 *    become two commands; the kernel's receipt returns the first result with
 *    `duplicate: true`, which is the correct outcome and is treated as success.
 * 2. `applied: false` is reported, not swallowed. A SET_PRESENCE the kernel
 *    judges STALE succeeds and changes NOTHING — a well-behaved retry causes
 *    it — and a control that showed a tick would be claiming a write that did
 *    not happen.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { Radio, CloudOff, EyeOff } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import {
  fetchTripPresence, freshnessLabel, setMyPresence, clearMyPresence, commandWasApplied,
  type PresenceRead, type PresenceEntry, type PresenceState,
} from '../../services/tripPresence.ts';

interface Props {
  tripId: string;
  /** userId -> display name, when the caller has them. Ids otherwise. */
  names?: Record<string, string>;
  /** Test seam. */
  load?: typeof fetchTripPresence;
  /** Test seams for the write path. */
  set?: typeof setMyPresence;
  clear?: typeof clearMyPresence;
}

/** How long a reported presence stays live. §10.1 requires a TTL; twenty
 *  minutes is this surface's choice and it is stated rather than defaulted
 *  somewhere invisible. */
export const PRESENCE_TTL_SECONDS = 20 * 60;

/** The states this control offers. A subset of §10.1's eight, chosen because
 *  they are the ones a person can answer about themselves in one tap. */
const OFFERED: Array<{ state: PresenceState; label: string }> = [
  { state: 'available', label: 'Available' },
  { state: 'transiting', label: 'On the move' },
  { state: 'at_plan', label: 'At the plan' },
  { state: 'resting', label: 'Resting' },
];

/**
 * The idempotency key for one observation.
 *
 * Derived from what is being SAID, not from when the button was pressed: the
 * trip, the state and the minute. Two taps inside a minute are the same
 * observation and produce the same key, so the kernel's receipt returns the
 * first result rather than applying twice. A `randomUUID()` here would make
 * every retry a new command and defeat the receipt entirely.
 */
export function presenceIdempotencyKey(tripId: string, state: string, at: Date): string {
  return `presence:${tripId}:${state}:${at.toISOString().slice(0, 16)}`;
}

/** §10.1 states, in words. Unrecognised values pass through rather than
 *  becoming a wrong-but-tidy label. */
const STATE_LABEL: Record<string, string> = {
  available: 'Available',
  free: 'Free',
  getting_ready: 'Getting ready',
  transiting: 'On the move',
  at_plan: 'At the plan',
  resting: 'Resting',
  returning: 'Heading back',
  offline: 'Offline',
};

function PresenceRow({ entry, name }: { entry: PresenceEntry; name: string }) {
  const stale = !entry.isCurrent;
  return (
    <View style={s.row} testID={`presence-${entry.userId}`}>
      <Radio size={14} color={stale ? color.faint : color.success} />
      <View style={{ flex: 1 }}>
        <Text style={[s.name, stale && { color: color.mute }]}>{name}</Text>
        <Text style={s.detail}>
          {STATE_LABEL[entry.state] ?? entry.state}
          {' · '}
          {/* The label is the server's, and it is never dropped for a stale
              row — that would leave the state reading as current. */}
          {freshnessLabel(entry)}
          {stale ? ` · ${describeAge(entry.observedSecondsAgo)}` : ''}
        </Text>
      </View>
    </View>
  );
}

/** An age in words. Coarse on purpose: a precise number invites arithmetic
 *  against the reader's own clock, which is the thing §10.2 warns about. */
export function describeAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'age unknown';
  if (seconds < 90) return 'seen a moment ago';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `seen ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `seen ${hours}h ago`;
  return `seen ${Math.round(hours / 24)}d ago`;
}

export function TripCrewPresenceCard({
  tripId, names = {}, load = fetchTripPresence,
  set = setMyPresence, clear = clearMyPresence,
}: Props) {
  const [read, setRead] = useState<PresenceRead | undefined>(undefined);
  const [writing, setWriting] = useState(false);
  /** What the last write actually did. Never a bare tick: see the header on
   *  why `applied: false` has to reach the user. */
  const [writeNote, setWriteNote] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRead(undefined);
    try {
      setRead(await load(tripId));
    } catch (e: any) {
      setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') });
    }
  }, [tripId, load]);

  const report = useCallback(async (state: PresenceState | null) => {
    setWriting(true);
    setWriteNote(null);
    try {
      const now = new Date();
      const r = state === null
        ? await clear(tripId, presenceIdempotencyKey(tripId, 'clear', now))
        : await set(tripId, {
            state,
            idempotencyKey: presenceIdempotencyKey(tripId, state, now),
            ttlSeconds: PRESENCE_TTL_SECONDS,
            source: 'explicit',
          });

      if (!r.ok) {
        // 'refused' and 'unavailable' stay apart: one means the kernel said no,
        // the other that it may never have been asked.
        setWriteNote(r.kind === 'refused'
          ? `Not recorded: ${r.reason}`
          : `We couldn't tell whether that was recorded (${r.detail}).`);
      } else if (!commandWasApplied(r)) {
        // The STALE_OBSERVATION case. A success that changed nothing.
        setWriteNote('A newer update already covers this, so nothing changed.');
      } else {
        setWriteNote(null);
      }
      await run();
    } finally {
      setWriting(false);
    }
  }, [tripId, set, clear, run]);

  useEffect(() => { void run(); }, [run]);

  if (read === undefined) {
    return (
      <View style={s.wrap} testID="trip-presence-loading">
        <ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} />
      </View>
    );
  }

  if (read.state === 'off') return null;

  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-presence-unavailable">
        <View style={s.row}>
          <CloudOff size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.name}>Crew presence unavailable</Text>
            <Text style={s.detail}>
              We couldn&apos;t read where your crew are. This doesn&apos;t mean nobody is sharing.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  const { presence, noPresence } = read.board;
  const nameOf = (id: string) => names[id] ?? 'Crew member';

  // Current first, then stale, each group in observation order. A stale row
  // must never sort above a live one and be read as the freshest thing here.
  const sorted = [...presence].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return a.observedSecondsAgo - b.observedSecondsAgo;
  });

  return (
    <View style={s.wrap} testID="trip-presence-card">
      <Text style={s.heading}>Where your crew are</Text>

      {sorted.length === 0 && noPresence.length === 0 && (
        <Text style={s.detail}>This trip has no crew to show yet.</Text>
      )}

      {sorted.map((e) => <PresenceRow key={e.userId} entry={e} name={nameOf(e.userId)} />)}

      <View style={s.controls} testID="trip-presence-controls">
        {OFFERED.map((o) => (
          <Pressable
            key={o.state}
            disabled={writing}
            onPress={() => { void report(o.state); }}
            style={({ pressed }) => [s.chip, pressed && { opacity: 0.6 }, writing && { opacity: 0.4 }]}
            accessibilityRole="button"
            accessibilityLabel={`Tell your crew you are ${o.label}`}
            testID={`presence-set-${o.state}`}
          >
            <Text style={s.chipText}>{o.label}</Text>
          </Pressable>
        ))}
        <Pressable
          disabled={writing}
          onPress={() => { void report(null); }}
          style={({ pressed }) => [s.chip, pressed && { opacity: 0.6 }, writing && { opacity: 0.4 }]}
          accessibilityRole="button"
          accessibilityLabel="Stop sharing where you are"
          testID="presence-clear"
        >
          <Text style={s.chipText}>Stop sharing</Text>
        </Pressable>
      </View>

      {writeNote && (
        <Text style={[s.detail, { paddingHorizontal: space.lg, paddingBottom: space.sm }]}
              testID="trip-presence-write-note">
          {writeNote}
        </Text>
      )}

      {noPresence.length > 0 && (
        <View style={s.row} testID="trip-presence-not-sharing">
          <EyeOff size={14} color={color.faint} />
          <View style={{ flex: 1 }}>
            <Text style={[s.name, { color: color.mute }]}>
              {noPresence.length} not sharing
            </Text>
            {/* Never observed is not the same as having reported 'offline',
                and the wording keeps them apart. */}
            <Text style={s.detail}>
              {noPresence.length === 1 ? 'This person has' : 'These people have'} not shared where they are.
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    ...shadow.card,
    overflow: 'hidden',
    paddingVertical: space.sm,
  },
  heading: {
    ...t.small, fontWeight: '700', color: color.ink,
    paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: 2,
  },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.sm,
  },
  name: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2, paddingHorizontal: 0 },
  controls: {
    flexDirection: 'row', flexWrap: 'wrap', gap: space.sm,
    paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs,
  },
  chip: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm,
    paddingHorizontal: space.sm, paddingVertical: 6,
  },
  chipText: { ...t.stamp, color: color.ink, fontWeight: '600' },
});
