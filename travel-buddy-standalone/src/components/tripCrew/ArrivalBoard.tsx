/**
 * ArrivalBoard
 *
 * Displays per-member arrival data fetched from the Trip Brain arrival-board
 * endpoint. Degrades by content — no feature flag needed:
 *
 *  - null response  → renders nothing (API unconfigured or feature disabled)
 *  - rows present with arrival data → compact per-member list
 *  - rows present but no arrival data, or empty → shows service's honest `note`
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Clock, CheckCircle2, CalendarClock } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { fetchArrivalBoard } from '../../services/tripIntel.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

type ArrivalRow = {
  userId: string;
  arrival: { time: string; label: string } | null;
};

type BoardResponse = {
  arrivals: ArrivalRow[];
  note?: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Humanise an ISO arrival time string relative to now.
 * Returns "Today at H:mm am/pm", "In N day(s)", or "Arrived" for past times.
 */
function humaniseArrival(isoTime: string): string {
  const arrival = new Date(isoTime);
  const now = new Date();

  // Truncate both to midnight for day comparison
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const arrivalMidnight = new Date(arrival.getFullYear(), arrival.getMonth(), arrival.getDate());
  const dayDiff = Math.round((arrivalMidnight.getTime() - todayMidnight.getTime()) / 86_400_000);

  if (arrival < now) {
    return 'Arrived';
  }

  const hours = arrival.getHours();
  const minutes = arrival.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  const h12 = hours % 12 || 12;
  const timeStr = minutes === 0 ? `${h12}${ampm}` : `${h12}:${String(minutes).padStart(2, '0')}${ampm}`;

  if (dayDiff === 0) return `Today at ${timeStr}`;
  if (dayDiff === 1) return `Tomorrow at ${timeStr}`;
  if (dayDiff > 1) return `In ${dayDiff} days`;
  return 'Arrived';
}

function isArrived(isoTime: string): boolean {
  return new Date(isoTime) < new Date();
}

// ── Status dot ────────────────────────────────────────────────────────────────

function StatusDot({ arrived }: { arrived: boolean }) {
  return (
    <View
      style={[
        s.statusDot,
        { backgroundColor: arrived ? color.success : color.faint },
      ]}
    />
  );
}

// ── Single arrival row ────────────────────────────────────────────────────────

function ArrivalRow({ row }: { row: ArrivalRow }) {
  if (!row.arrival) return null;

  const arrived = isArrived(row.arrival.time);
  const timeLabel = humaniseArrival(row.arrival.time);
  const memberLabel = row.arrival.label || `Member`;

  return (
    <View style={s.row}>
      <View style={s.rowLeft}>
        <StatusDot arrived={arrived} />
        <View style={s.rowBody}>
          <Text style={s.memberName} numberOfLines={1}>{memberLabel}</Text>
          <View style={s.timeRow}>
            {arrived ? (
              <CheckCircle2 size={11} color={color.success} />
            ) : (
              <Clock size={11} color={color.mute} />
            )}
            <Text style={[s.timeText, arrived && s.timeTextArrived]}>{timeLabel}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  tripId: string;
}

export function ArrivalBoard({ tripId }: Props) {
  const [board, setBoard] = useState<BoardResponse | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    let cancelled = false;
    fetchArrivalBoard(tripId).then((res) => {
      if (!cancelled) setBoard(res);
    });
    return () => { cancelled = true; };
  }, [tripId]);

  // Still loading or explicitly null (API unavailable / feature off) → hide
  if (board === undefined) {
    return (
      <View style={s.loadingWrap}>
        <ActivityIndicator size="small" color={color.faint} />
      </View>
    );
  }
  if (board === null) return null;

  const rowsWithArrival = board.arrivals.filter((r) => r.arrival !== null);

  // No arrival data — show service's honest note (or nothing if note absent)
  if (rowsWithArrival.length === 0) {
    if (!board.note) return null;
    return (
      <View style={s.noteWrap} testID="arrival-board-note">
        <CalendarClock size={14} color={color.mute} />
        <Text style={s.noteText}>{board.note}</Text>
      </View>
    );
  }

  return (
    <View style={s.card} testID="arrival-board">
      <View style={s.header}>
        <CalendarClock size={14} color={color.ink} />
        <Text style={s.headerText}>Arrivals</Text>
      </View>
      {rowsWithArrival.map((row) => (
        <ArrivalRow key={row.userId} row={row} />
      ))}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  loadingWrap: {
    paddingVertical: space.sm,
    alignItems: 'center',
  },
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: space.md,
  },
  headerText: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  row: {
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  memberName: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 13,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  timeText: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
  },
  timeTextArrived: {
    color: color.success,
    fontWeight: '700',
  },
  noteWrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  noteText: {
    ...t.small,
    color: color.mute,
    flex: 1,
    lineHeight: 18,
  },
});
