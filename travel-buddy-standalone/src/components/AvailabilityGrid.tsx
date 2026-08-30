/**
 * AvailabilityGrid — day-level grid: rows = members, columns = specific dates.
 *
 * Modes:
 *  trip   — reads member.openDays (trip-scoped) with weeklyDays fallback
 *  circle — reads member.weeklyDays mapped to upcoming calendar dates
 *
 * Layout: sticky left column (member names) + horizontally-scrollable day columns.
 * Tapping a day column header opens a summary modal with free / not-set members
 * and an optional "Plan meetup this day" CTA.
 */
import React, { useState } from 'react';
import {
  View, Text, ScrollView, Pressable, Modal, StyleSheet, Platform,
} from 'react-native';
import { AvatarImage } from './ui/DisplayMediaImage.tsx';
import { closeThenNavigate } from '../lib/deferredNavigate.ts';
import { localTodayKey } from '../utils/localDate.ts';
import { CalendarPlus, X } from 'lucide-react-native';
import { type MemberAvailability, type Weekday } from '../services/availability.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';

// ── Layout constants ──────────────────────────────────────────────────────────

const NAME_W  = 92;  // sticky left column width
const DAY_W   = 34;  // each day column width
const CELL    = 22;  // square cell size
const HEAD_H  = 46;  // header row height
const ROW_H   = 36;  // member row height

// ── Cell status helpers ───────────────────────────────────────────────────────

export type CellStatus = 'free' | 'unknown' | 'nodata';

const WEEKDAY_IDX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_ABBR    = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function hasAnyData(member: MemberAvailability, mode: 'trip' | 'circle'): boolean {
  if (mode === 'trip' && member.openDays != null) {
    return Object.keys(member.openDays).length > 0;
  }
  return Object.keys(member.weeklyDays).length > 0;
}

function getCellStatus(
  member: MemberAvailability,
  date: string,
  mode: 'trip' | 'circle',
): CellStatus {
  if (!hasAnyData(member, mode)) return 'nodata';

  if (mode === 'trip' && member.openDays != null) {
    return (member.openDays[date]?.length ?? 0) > 0 ? 'free' : 'unknown';
  }

  const wd = WEEKDAY_IDX[new Date(date + 'T12:00:00').getDay()] as Weekday;
  return ((member.weeklyDays[wd] ?? []).length > 0) ? 'free' : 'unknown';
}

function dayLabel(date: string): { abbr: string; num: string } {
  const d = new Date(date + 'T12:00:00');
  return { abbr: DAY_ABBR[d.getDay()], num: String(d.getDate()) };
}

function formatFullDate(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric',
  });
}

// ── Avatar ────────────────────────────────────────────────────────────────────

function MemberAvatar({ m, size = 22 }: { m: MemberAvailability; size?: number }) {
  return (
    <AvatarImage
      uri={m.avatarUrl}
      user={{ name: m.name ?? undefined, handle: m.handle ?? undefined }}
      size={size}
    />
  );
}

// ── Cell ─────────────────────────────────────────────────────────────────────

function Cell({ status, isOwn }: { status: CellStatus; isOwn?: boolean }) {
  return (
    <View style={[
      g.cell,
      status === 'free'    ? g.cellFree    :
      status === 'nodata'  ? g.cellNoData  : g.cellUnknown,
      isOwn && g.cellMine,
    ]}>
      {status === 'nodata' && <Text style={g.cellQ}>?</Text>}
    </View>
  );
}

// ── Day summary modal ─────────────────────────────────────────────────────────

interface SummaryProps {
  date: string | null;
  members: MemberAvailability[];
  mode: 'trip' | 'circle';
  onClose: () => void;
  onPlanMeetup?: (date: string) => void;
}

function DaySummaryModal({ date, members, mode, onClose, onPlanMeetup }: SummaryProps) {
  if (!date) return null;

  const freeMembers    = members.filter((m) => getCellStatus(m, date, mode) === 'free');
  const notFreeMembers = members.filter((m) => getCellStatus(m, date, mode) !== 'free');

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={ds.overlay} onPress={onClose}>
        <Pressable style={ds.sheet} onPress={() => {}}>
          <View style={ds.handle} />
          <Pressable style={ds.closeBtn} onPress={onClose} hitSlop={8}>
            <X size={18} color={color.mute} />
          </Pressable>

          <Text style={ds.dateTitle}>{formatFullDate(date)}</Text>

          {/* Free */}
          <Text style={ds.sectionLabel}>🟢 Free</Text>
          {freeMembers.length === 0 ? (
            <Text style={ds.empty}>No one has marked this day free yet.</Text>
          ) : (
            freeMembers.map((m) => (
              <Pressable
                key={m.userId}
                style={ds.memberRow}
                onPress={m.handle ? () => closeThenNavigate(onClose, `/u/${m.handle}`) : undefined}
              >
                <MemberAvatar m={m} size={28} />
                <Text style={ds.memberName}>{m.name ?? m.handle ?? 'Traveler'}</Text>
                {m.quickStatus?.status === 'free_now' && (
                  <View style={ds.nowChip}><Text style={ds.nowChipText}>Now</Text></View>
                )}
              </Pressable>
            ))
          )}

          {/* Not free / no data */}
          {notFreeMembers.length > 0 && (
            <>
              <Text style={[ds.sectionLabel, { marginTop: space.md }]}>⚫ Not set / Unavailable</Text>
              {notFreeMembers.map((m) => (
                <View key={m.userId} style={[ds.memberRow, { opacity: 0.4 }]}>
                  <MemberAvatar m={m} size={28} />
                  <Text style={ds.memberName}>{m.name ?? m.handle ?? 'Traveler'}</Text>
                </View>
              ))}
            </>
          )}

          {/* Plan meetup CTA */}
          {onPlanMeetup && (
            <Pressable
              style={ds.planBtn}
              onPress={() => { onClose(); onPlanMeetup(date); }}
            >
              <CalendarPlus size={15} color={color.onInk} />
              <Text style={ds.planBtnText}>Plan meetup this day</Text>
            </Pressable>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface AvailabilityGridProps {
  members: MemberAvailability[];
  days: string[];            // YYYY-MM-DD strings
  currentUserId: string;
  mode: 'trip' | 'circle';
  onEditOwn?: () => void;    // called when user taps their own name row
  onPlanMeetup?: (date: string) => void;
  /** Called when user taps a cell in their own row (trip mode only) */
  onOwnCellPress?: (date: string, status: CellStatus) => void;
  /** Controlled selected day — when provided the day-summary modal opens for this date */
  selectedDay?: string | null;
  /** Called when the grid's selected day changes (header tap or modal close) */
  onSelectedDayChange?: (day: string | null) => void;
}

export function AvailabilityGrid({
  members,
  days,
  currentUserId,
  mode,
  onEditOwn,
  onPlanMeetup,
  onOwnCellPress,
  selectedDay: externalSelectedDay,
  onSelectedDayChange,
}: AvailabilityGridProps) {
  const [internalDay, setInternalDay] = useState<string | null>(null);
  // Support controlled (selectedDay prop) and uncontrolled (internal state) modes
  const isControlled = externalSelectedDay !== undefined;
  const selectedDay = isControlled ? (externalSelectedDay ?? null) : internalDay;
  const setSelectedDay = (day: string | null) => {
    if (!isControlled) setInternalDay(day);
    onSelectedDayChange?.(day);
  };

  // Current user first, then alphabetical
  const sorted = [...members].sort((a, b) => {
    if (a.userId === currentUserId) return -1;
    if (b.userId === currentUserId) return 1;
    return (a.name ?? a.handle ?? '').localeCompare(b.name ?? b.handle ?? '');
  });

  if (days.length === 0 || sorted.length === 0) return null;

  return (
    <View>
      <View style={g.root}>
        {/* ── Sticky left column ── */}
        <View style={[g.nameCol, { width: NAME_W }]}>
          {/* spacer matching header height */}
          <View style={{ height: HEAD_H }} />

          {sorted.map((m) => {
            const isMe = m.userId === currentUserId;
            return (
              <Pressable
                key={m.userId}
                style={[g.nameRow, { height: ROW_H }]}
                onPress={isMe ? onEditOwn : undefined}
                hitSlop={4}
              >
                <MemberAvatar m={m} size={22} />
                <Text
                  style={[g.nameTxt, isMe && g.nameTxtMe]}
                  numberOfLines={1}
                >
                  {isMe ? 'You ✏️' : (m.name ?? m.handle ?? '…')}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* ── Scrollable day columns ── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            {/* Day headers */}
            <View style={[g.headerRow, { height: HEAD_H }]}>
              {days.map((d) => {
                const { abbr, num } = dayLabel(d);
                const isToday = d === localTodayKey();
                return (
                  <Pressable
                    key={d}
                    style={[g.dayHead, { width: DAY_W, height: HEAD_H }, isToday && g.dayHeadToday]}
                    onPress={() => setSelectedDay(d)}
                  >
                    <Text style={[g.dayAbbr, isToday && g.dayAbbrToday]}>{abbr}</Text>
                    <Text style={[g.dayNum, isToday && g.dayNumToday]}>{num}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Member rows */}
            {sorted.map((m) => {
              const isMe = m.userId === currentUserId;
              return (
                <View key={m.userId} style={[g.memberRow, { height: ROW_H }]}>
                  {days.map((d) => {
                    const status = getCellStatus(m, d, mode);
                    if (isMe && onOwnCellPress) {
                      return (
                        <Pressable
                          key={d}
                          style={[g.cellWrap, { width: DAY_W, height: ROW_H }]}
                          onPress={() => onOwnCellPress(d, status)}
                          hitSlop={2}
                        >
                          <Cell status={status} isOwn />
                        </Pressable>
                      );
                    }
                    return (
                      <View key={d} style={[g.cellWrap, { width: DAY_W, height: ROW_H }]}>
                        <Cell status={status} />
                      </View>
                    );
                  })}
                </View>
              );
            })}
          </View>
        </ScrollView>
      </View>

      {/* Legend */}
      <View style={g.legend}>
        <View style={[g.legendDot, { backgroundColor: '#22C55E' }]} />
        <Text style={g.legendTxt}>Free</Text>
        <View style={[g.legendDot, { backgroundColor: color.haze }]} />
        <Text style={g.legendTxt}>Not set</Text>
        <View style={[g.legendDot, { backgroundColor: '#F0EDE8' }]} />
        <Text style={g.legendTxt}>No data</Text>
      </View>

      {/* Day summary modal */}
      <DaySummaryModal
        date={selectedDay}
        members={sorted}
        mode={mode}
        onClose={() => setSelectedDay(null)}
        onPlanMeetup={onPlanMeetup}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const g = StyleSheet.create({
  root: { flexDirection: 'row', overflow: 'hidden' },

  nameCol: { flexShrink: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 2, paddingRight: 4 },
  nameTxt: { ...t.small, color: color.ink, flex: 1, fontSize: 11, lineHeight: 14 },
  nameTxtMe: { color: color.signal, fontWeight: '700' },

  avatarFb: { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },

  headerRow: { flexDirection: 'row' },
  dayHead: { alignItems: 'center', justifyContent: 'center', gap: 1 },
  dayHeadToday: { backgroundColor: color.haze, borderRadius: 6 },
  dayAbbr: { fontSize: 9, fontWeight: '700', color: color.mute, textTransform: 'uppercase', letterSpacing: 0.3 },
  dayAbbrToday: { color: color.signal },
  dayNum: { fontSize: 13, fontWeight: '800', color: color.ink, lineHeight: 15 },
  dayNumToday: { color: color.signal },

  memberRow: { flexDirection: 'row' },
  cellWrap: { alignItems: 'center', justifyContent: 'center' },
  cell: { width: CELL, height: CELL, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  cellFree:    { backgroundColor: '#22C55E' },
  cellUnknown: { backgroundColor: color.haze },
  cellNoData:  { backgroundColor: '#F0EDE8' },
  cellMine:    { borderWidth: 1.5, borderColor: color.signal + '80' },
  cellQ: { fontSize: 9, fontWeight: '700', color: color.faint },

  legend: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.sm, flexWrap: 'wrap' },
  legendDot: { width: 10, height: 10, borderRadius: 3 },
  legendTxt: { ...t.small, color: color.mute, fontSize: 10, marginRight: 6 },
});

const ds = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(17,17,15,0.48)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: space.lg,
    paddingTop: space.md,
    paddingBottom: Platform.OS === 'ios' ? 40 : space.xl,
    maxHeight: '78%',
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center', marginBottom: space.md,
  },
  closeBtn: { position: 'absolute', top: space.md + 4, right: space.lg, padding: 4 },
  dateTitle: { ...t.heading, color: color.ink, marginBottom: space.md, paddingRight: 28 },
  sectionLabel: { ...t.small, fontWeight: '700', color: color.ink, marginBottom: 6, fontSize: 12 },
  empty: { ...t.small, color: color.mute, marginBottom: space.sm },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 5 },
  memberName: { ...t.small, color: color.ink, flex: 1, fontWeight: '600' },
  nowChip: {
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: radius.pill,
  },
  nowChipText: { fontSize: 10, fontWeight: '700', color: '#16A34A' },
  planBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.signal, borderRadius: radius.pill,
    paddingHorizontal: space.lg, paddingVertical: space.sm + 2,
    marginTop: space.lg, alignSelf: 'flex-start',
  },
  planBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },
});
