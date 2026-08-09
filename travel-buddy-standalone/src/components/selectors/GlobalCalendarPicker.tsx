/**
 * GlobalCalendarPicker — app-wide date / date-range picker.
 *
 * Renders as a bottom-sheet modal with a full month grid.
 * Replaces native DateTimePicker for date fields across the app.
 *
 * Modes:
 *   "single"  — pick one date
 *   "range"   — pick start + end date
 *
 * Props:
 *   visible        — control sheet visibility
 *   mode           — "single" | "range"
 *   value          — ISO string (single) or { start, end } (range)
 *   minDate        — ISO string; earlier dates are disabled
 *   maxDate        — ISO string; later dates are disabled
 *   allowPast      — if false (default for future events), past dates greyed
 *   onConfirm      — called with ISO value on confirm
 *   onCancel       — called on cancel/backdrop press
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet,
  Platform,
} from 'react-native';
import { ChevronLeft, ChevronRight, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import {
  toMidnight, isSameDay, isBeforeDay, isAfterDay, isBetweenDays,
  toISODate, fromISODate, formatDisplayDate, formatDisplayDateRange,
  monthName,
} from '../../lib/dateTime/formatters.ts';

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

type SingleValue = string | null;
type RangeValue = { start: string | null; end: string | null };

export type CalendarValue = SingleValue | RangeValue;

interface SingleProps {
  mode: 'single';
  value?: SingleValue;
  onConfirm: (value: SingleValue) => void;
}
interface RangeProps {
  mode: 'range';
  value?: RangeValue;
  onConfirm: (value: RangeValue) => void;
}

type Props = (SingleProps | RangeProps) & {
  visible: boolean;
  minDate?: string;
  maxDate?: string;
  allowPast?: boolean;
  /** ISO dates ("YYYY-MM-DD") that cannot be selected (e.g. buddy blocked/vacation days). */
  disabledDates?: string[];
  /** Optional note shown under the grid when disabledDates is non-empty. */
  disabledDatesNote?: string;
  onCancel: () => void;
  title?: string;
};

/** Build a 6-row × 7-col grid of Date | null for the given year/month */
function buildGrid(year: number, month: number): (Date | null)[][] {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

export function GlobalCalendarPicker(props: Props) {
  const { visible, mode, minDate, maxDate, allowPast = false, disabledDates, disabledDatesNote, onCancel, title } = props;
  const disabledSet = React.useMemo(() => new Set(disabledDates ?? []), [disabledDates]);
  const insets = useSafeAreaInsets();
  const today = toMidnight(new Date());

  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  // Local selection state
  const [singleSel, setSingleSel] = useState<Date | null>(null);
  const [rangeStart, setRangeStart] = useState<Date | null>(null);
  const [rangeEnd, setRangeEnd] = useState<Date | null>(null);
  const [selectingEnd, setSelectingEnd] = useState(false);

  // Sync from props.value when sheet opens
  useEffect(() => {
    if (!visible) return;
    if (mode === 'single') {
      const v = (props as SingleProps).value;
      const parsed = v ? fromISODate(v) : null;
      setSingleSel(parsed);
      if (parsed) { setViewYear(parsed.getFullYear()); setViewMonth(parsed.getMonth()); }
      else { setViewYear(today.getFullYear()); setViewMonth(today.getMonth()); }
    } else {
      const v = (props as RangeProps).value;
      const s = v?.start ? fromISODate(v.start) : null;
      const e = v?.end ? fromISODate(v.end) : null;
      setRangeStart(s);
      setRangeEnd(e);
      setSelectingEnd(false);
      if (s) { setViewYear(s.getFullYear()); setViewMonth(s.getMonth()); }
      else { setViewYear(today.getFullYear()); setViewMonth(today.getMonth()); }
    }
  }, [visible]);

  const minD = minDate ? fromISODate(minDate) : null;
  const maxD = maxDate ? fromISODate(maxDate) : null;

  function isDisabled(d: Date): boolean {
    if (!allowPast && isBeforeDay(d, today)) return true;
    if (minD && isBeforeDay(d, minD)) return true;
    if (maxD && isAfterDay(d, maxD)) return true;
    if (disabledSet.size > 0 && disabledSet.has(toISODate(d))) return true;
    return false;
  }

  function isBlockedDate(d: Date): boolean {
    return disabledSet.size > 0 && disabledSet.has(toISODate(d));
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewYear((y) => y - 1); setViewMonth(11); }
    else setViewMonth((m) => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear((y) => y + 1); setViewMonth(0); }
    else setViewMonth((m) => m + 1);
  }

  function handleDayPress(d: Date) {
    if (isDisabled(d)) return;
    if (mode === 'single') {
      setSingleSel(d);
    } else {
      if (!selectingEnd || !rangeStart) {
        setRangeStart(d);
        setRangeEnd(null);
        setSelectingEnd(true);
      } else {
        if (isBeforeDay(d, rangeStart)) {
          setRangeStart(d);
          setRangeEnd(rangeStart);
        } else {
          setRangeEnd(d);
        }
        setSelectingEnd(false);
      }
    }
  }

  function handleToday() {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    if (mode === 'single') setSingleSel(today);
    else {
      setRangeStart(today);
      setRangeEnd(null);
      setSelectingEnd(true);
    }
  }

  function handleConfirm() {
    if (mode === 'single') {
      (props as SingleProps).onConfirm(singleSel ? toISODate(singleSel) : null);
    } else {
      (props as RangeProps).onConfirm({
        start: rangeStart ? toISODate(rangeStart) : null,
        end: rangeEnd ? toISODate(rangeEnd) : null,
      });
    }
  }

  function handleClear() {
    if (mode === 'single') {
      setSingleSel(null);
      (props as SingleProps).onConfirm(null);
    } else {
      setRangeStart(null);
      setRangeEnd(null);
      setSelectingEnd(false);
      (props as RangeProps).onConfirm({ start: null, end: null });
    }
  }

  // Calendar grid
  const rows = buildGrid(viewYear, viewMonth);

  function dayStyle(d: Date | null) {
    if (!d) return null;
    const disabled = isDisabled(d);
    const blocked = isBlockedDate(d);
    const todayDay = isSameDay(d, today);

    if (mode === 'single') {
      const selected = singleSel && isSameDay(d, singleSel);
      return { disabled, blocked, today: todayDay, selected: !!selected, inRange: false, rangeStart: false, rangeEnd: false };
    } else {
      const isStart = rangeStart && isSameDay(d, rangeStart);
      const isEnd = rangeEnd && isSameDay(d, rangeEnd);
      const inRange = !!(rangeStart && rangeEnd && isBetweenDays(d, rangeStart, rangeEnd));
      return { disabled, blocked, today: todayDay, selected: !!(isStart || isEnd), inRange, rangeStart: !!isStart, rangeEnd: !!isEnd };
    }
  }

  // Selection summary label
  let summaryLabel = '';
  if (mode === 'single' && singleSel) summaryLabel = formatDisplayDate(singleSel);
  else if (mode === 'range') {
    if (rangeStart && rangeEnd) summaryLabel = formatDisplayDateRange(rangeStart, rangeEnd);
    else if (rangeStart) summaryLabel = selectingEnd ? `${formatDisplayDate(rangeStart)} → pick end` : formatDisplayDate(rangeStart);
  }

  const canConfirm = mode === 'single' ? !!singleSel : !!rangeStart;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <View style={s.overlay}>
        <Pressable style={s.backdrop} onPress={onCancel} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          {/* Header */}
          <View style={s.header}>
            <Text style={s.title}>{title ?? (mode === 'range' ? 'Select Dates' : 'Select Date')}</Text>
            <Pressable style={s.closeBtn} onPress={onCancel} hitSlop={12}>
              <X size={18} color={color.mute} />
            </Pressable>
          </View>

          {/* Month nav */}
          <View style={s.monthNav}>
            <Pressable onPress={prevMonth} hitSlop={12} style={s.navBtn}>
              <ChevronLeft size={20} color={color.ink} />
            </Pressable>
            <Text style={s.monthLabel}>{monthName(viewMonth)} {viewYear}</Text>
            <Pressable onPress={nextMonth} hitSlop={12} style={s.navBtn}>
              <ChevronRight size={20} color={color.ink} />
            </Pressable>
          </View>

          {/* Day-of-week labels */}
          <View style={s.dayLabels}>
            {DAY_LABELS.map((l) => (
              <Text key={l} style={s.dayLabel}>{l}</Text>
            ))}
          </View>

          {/* Calendar grid */}
          {rows.map((row, ri) => (
            <View key={ri} style={s.row}>
              {row.map((d, ci) => {
                if (!d) return <View key={ci} style={s.cell} />;
                const ds = dayStyle(d);
                if (!ds) return <View key={ci} style={s.cell} />;
                return (
                  <Pressable
                    key={ci}
                    style={[
                      s.cell,
                      ds.inRange && s.cellInRange,
                      ds.rangeStart && s.cellRangeEdge,
                      ds.rangeEnd && s.cellRangeEdge,
                    ]}
                    onPress={() => handleDayPress(d)}
                    disabled={ds.disabled}
                  >
                    <View style={[
                      s.dayCircle,
                      ds.selected && s.daySelected,
                      !ds.selected && ds.today && s.dayToday,
                      ds.blocked && s.dayBlocked,
                    ]}>
                      <Text style={[
                        s.dayText,
                        ds.disabled && s.dayDisabled,
                        ds.blocked && s.dayBlockedText,
                        ds.selected && s.daySelectedText,
                        !ds.selected && ds.today && s.dayTodayText,
                      ]}>
                        {d.getDate()}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}

          {/* Blocked-dates note */}
          {disabledSet.size > 0 && (
            <Text style={s.blockedNote}>
              {disabledDatesNote ?? 'Crossed-out dates are unavailable.'}
            </Text>
          )}

          {/* Summary + quick actions */}
          <View style={s.footer}>
            <Pressable onPress={handleToday} style={s.todayBtn}>
              <Text style={s.todayText}>Today</Text>
            </Pressable>
            {summaryLabel ? (
              <Text style={s.summary} numberOfLines={1}>{summaryLabel}</Text>
            ) : (
              <Text style={s.summaryPlaceholder}>
                {mode === 'range' ? 'Pick a start date' : 'No date selected'}
              </Text>
            )}
            <Pressable onPress={handleClear} hitSlop={8}>
              <Text style={s.clearText}>Clear</Text>
            </Pressable>
          </View>

          {/* Confirm */}
          <Pressable
            style={[s.confirmBtn, !canConfirm && s.confirmDisabled]}
            onPress={handleConfirm}
            disabled={!canConfirm}
          >
            <Text style={s.confirmText}>
              {mode === 'range' && selectingEnd && rangeStart && !rangeEnd
                ? 'Skip end date'
                : 'Confirm'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const CELL_SIZE = 44;

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,17,15,0.5)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingTop: space.md,
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.sm, paddingBottom: space.md,
  },
  title: { ...t.heading, color: color.ink, flex: 1 },
  closeBtn: { padding: 4 },
  monthNav: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.sm, marginBottom: space.sm,
  },
  navBtn: { padding: 4 },
  monthLabel: { ...t.bodyStrong, color: color.ink, fontSize: 16 },
  dayLabels: { flexDirection: 'row', marginBottom: 4 },
  dayLabel: {
    width: CELL_SIZE, textAlign: 'center', fontSize: 11,
    fontWeight: '600', color: color.mute, fontFamily: 'Courier',
  },
  row: { flexDirection: 'row' },
  cell: {
    width: CELL_SIZE, height: CELL_SIZE,
    alignItems: 'center', justifyContent: 'center',
  },
  cellInRange: { backgroundColor: `${color.signal}18` },
  cellRangeEdge: { backgroundColor: `${color.signal}28` },
  dayCircle: {
    width: avatar.md, height: avatar.md, borderRadius: avatar.md / 2,
    alignItems: 'center', justifyContent: 'center',
  },
  daySelected: { backgroundColor: color.signal },
  dayToday: { borderWidth: 1.5, borderColor: color.signal },
  dayText: { ...t.body, color: color.ink, fontSize: 14 },
  dayDisabled: { color: color.faint },
  dayBlocked: { backgroundColor: `${color.faint}22` },
  dayBlockedText: { color: color.faint, textDecorationLine: 'line-through' },
  blockedNote: {
    ...t.small, color: color.mute, textAlign: 'center',
    paddingHorizontal: space.sm, paddingTop: space.sm,
  },
  daySelectedText: { color: color.onInk, fontWeight: '700' },
  dayTodayText: { color: color.signal, fontWeight: '600' },
  footer: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.sm, paddingVertical: space.md,
    gap: space.md,
  },
  todayBtn: {
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
  },
  todayText: { ...t.small, color: color.ink, fontWeight: '600' },
  summary: { flex: 1, ...t.body, color: color.ink, textAlign: 'center' },
  summaryPlaceholder: { flex: 1, ...t.body, color: color.faint, textAlign: 'center' },
  clearText: { ...t.small, color: color.mute },
  confirmBtn: {
    backgroundColor: color.ink, borderRadius: radius.pill,
    paddingVertical: 14, alignItems: 'center', marginHorizontal: space.sm, marginTop: space.xs,
  },
  confirmDisabled: { opacity: 0.35 },
  confirmText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
});
