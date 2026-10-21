/**
 * TripItineraryPaste — census G160, §24's itinerary block: paste a plan with
 * times, review it, and add each line you confirm to the trip as a TIMED
 * commitment through the structure composer's own builder.
 *
 *   paste → "Read times" → POST /api/input-assistance/extract (trip_stop_place,
 *   writes nothing) → THIS REVIEW: each line that matched a place, with the
 *   instant it was read as, or what is missing → the person fixes, ticks,
 *   chooses what the stops are → "Add N stops" → one ADD_COMMITMENT per ticked
 *   stop (tripStructureEntries.ts#addCommitment → commitmentCommand), in order.
 *
 * NOTHING IS WRITTEN WITHOUT THE CONFIRM TAP (§24 / census G162). Reading the
 * paste and the trip's dates writes nothing; closing writes nothing.
 *
 * NOTHING IS GUESSED (itineraryProposal.ts, itineraryTimes.ts). "Dinner at 7"
 * is held until the person says morning or evening; "Friday" in a trip with two
 * Fridays is held until they pick one; a place with no known time zone in a
 * trip with none is held until they take the phone's — offered, labelled, and
 * used only on a tap, as the composer's stage form does.
 *
 * NOTHING FAILS SILENTLY. Each stop's write is shown on its own row: "Added"
 * only on the kernel's word, a refusal with its reason, an unreachable kernel
 * as "nothing was added" with a retry of THE SAME command (same key, same
 * payload) so a retry can never add the stop twice. The outcome line counts
 * them: "2 of 3 added".
 *
 * THE GATE. The paste field is `trip.stop.place` (context `trip_stop_place`).
 * Until the policy authority says that field may be assisted, the control is
 * not rendered — the same rule `SmartInput` applies (`no_assistance` → plain).
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AlertTriangle, CalendarClock, CheckCircle2 } from 'lucide-react-native';

import { color, radius, space, type as t } from '../../../theme/tokens.ts';
import { GEO_FIELD_IDS } from '../../../platform/input-assistance/geographic/geoFields.ts';
import { resolveFieldPolicy } from '../../../platform/input-assistance/contexts/fieldRegistry.ts';
import { policyEpoch } from '../../../platform/input-assistance/services/policyStore.ts';
import { extractPastedEntities } from '../../../platform/input-assistance/paste/pasteExtraction.ts';
import type { PasteReviewItem } from '../../../platform/input-assistance/paste/pasteReview.ts';
import { usePrefersReducedMotion } from '../../../platform/input-assistance/components/reducedMotion.ts';
import { clockWords, dayWords, meridiemWords, offsetWords, type TripWindow } from '../../../platform/input-assistance/paste/itineraryTimes.ts';
import {
  proposeStops, initiallyTicked, commitmentInputFor, blockWords, dayChoiceWords,
  type BatchChoice, type ProposedStop, type StopFix,
} from './itineraryProposal.ts';
import {
  addCommitment, structureEntryKey, COMMITMENT_TYPES, COMMITMENT_FLEXIBILITIES,
  type CommitmentType, type CommitmentFlexibility, type StructureEntryResult,
} from './tripStructureEntries.ts';
import type { CommitmentInput } from './tripStructurePayloads.ts';
import { getTrip } from '../../../services/trips.ts';

/** The trip's dates, as `services/trips.ts#getTrip` returns them. */
export interface TripDates { startDate: string | null; endDate: string | null }

interface Props {
  tripId: string;
  /** The trip's own zone; used only when the matched place carries none (the composer's rule). */
  tripTimezone?: string | null;
  /** The trip's stages, for attaching the stops to one (optional, as in the composer). */
  stages?: ReadonlyArray<{ id: string; stageType: string; sequence: number }>;
  onAdded?: () => void;
  /** Test seams. */
  extract?: typeof extractPastedEntities;
  loadTrip?: (tripId: string) => Promise<TripDates | null>;
  addCommitmentEntry?: typeof addCommitment;
  deviceTimezone?: () => string | null;
  now?: () => Date;
}

async function readTripDates(tripId: string): Promise<TripDates | null> {
  const trip = await getTrip(tripId);
  return trip ? { startDate: trip.startDate, endDate: trip.endDate } : null;
}

function systemZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.trim() ? tz.trim() : null;
  } catch {
    return null;
  }
}

const TYPE_LABEL: Record<CommitmentType, string> = { lodging: 'Lodging', transport: 'Transport', event: 'Event', booking: 'Booking', meeting: 'Meeting', other: 'Other' };
const FLEX_LABEL: Record<CommitmentFlexibility, string> = { fixed: 'Fixed', shiftable: 'Can shift', flexible: 'Flexible' };

type Phase = 'compose' | 'reading' | 'error' | 'review';
type Send = { key: string; input: CommitmentInput; result: StructureEntryResult | 'pending' };
type TripRead = { window: TripWindow | null; unreadable: boolean };

const settled = (s: Send | undefined) => !!s && s.result !== 'pending' && (s.result.state === 'recorded' || s.result.state === 'refused');

function Chip({ label, on, onPress, testID, a11y, disabled }: { label: string; on: boolean; onPress: () => void; testID: string; a11y?: string; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress} disabled={disabled} style={[s.chip, on && s.chipOn, disabled && !on && { opacity: 0.5 }]} testID={testID}
      accessibilityRole="button" accessibilityLabel={a11y ?? label} accessibilityState={{ selected: on, disabled: !!disabled }}
    >
      <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function TripItineraryPaste({
  tripId, tripTimezone = null, stages = [], onAdded,
  extract = extractPastedEntities, loadTrip = readTripDates, addCommitmentEntry = addCommitment,
  deviceTimezone = systemZone, now = () => new Date(),
}: Props) {
  const epoch = policyEpoch();
  const policy = useMemo(() => resolveFieldPolicy(GEO_FIELD_IDS.tripStopPlace, 'trip_stop_place'), [epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const reduceMotion = usePrefersReducedMotion();

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('compose');
  const [text, setText] = useState('');
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [items, setItems] = useState<PasteReviewItem[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [trip, setTrip] = useState<TripRead>({ window: null, unreadable: false });
  const [fixes, setFixes] = useState<Record<number, StopFix>>({});
  const [ticked, setTicked] = useState<Record<number, boolean>>({});
  const [batch, setBatch] = useState<BatchChoice>({ type: null, flexibility: 'flexible', stageId: null });
  const [sends, setSends] = useState<Record<number, Send>>({});
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Read once per paste, so "today" cannot move under a proposal on screen.
  const [readAt, setReadAt] = useState<Date>(() => new Date(0));

  const contextAt = useCallback((tr: TripRead, at: Date) => ({
    tripTimezone, trip: tr.window, tripUnreadable: tr.unreadable, now: at, deviceZone: deviceTimezone(),
  }), [tripTimezone, deviceTimezone]);
  const context = useCallback((tr: TripRead) => contextAt(tr, readAt), [contextAt, readAt]);

  const stops: ProposedStop[] = useMemo(
    () => (items ? proposeStops(items, context(trip), fixes) : []),
    [items, trip, fixes, context],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setPhase('compose'); setError(null); setItems(null); setTruncated(false);
    setTrip({ window: null, unreadable: false }); setFixes({}); setTicked({});
    setBatch({ type: null, flexibility: 'flexible', stageId: null }); setSends({}); setBusy(false);
  }, []);

  const close = useCallback(() => { reset(); setText(''); setOpen(false); }, [reset]);

  const read = useCallback(async () => {
    const pasted = text.trim();
    if (!pasted) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase('reading'); setError(null);
    const [res, tr] = await Promise.all([
      extract({ context: 'trip_stop_place', fieldId: GEO_FIELD_IDS.tripStopPlace, text: pasted }, ctrl.signal),
      loadTrip(tripId).then(
        (d): TripRead => ({ window: { start: d?.startDate ?? null, end: d?.endDate ?? null }, unreadable: false }),
        (): TripRead => ({ window: null, unreadable: true }),
      ),
    ]);
    if (ctrl.signal.aborted) return;
    if (!res.ok) { setError({ message: res.error, retryable: res.retryable }); setPhase('error'); return; }
    const at = now();
    setReadAt(at);
    setItems(res.data.items); setTruncated(res.data.truncated); setTrip(tr);
    setFixes({}); setSends({});
    setTicked(initiallyTicked(proposeStops(res.data.items, contextAt(tr, at), {})));
    setPhase('review');
  }, [text, extract, loadTrip, tripId, now, contextAt]);

  const fix = useCallback((index: number, more: StopFix) => {
    const next = { ...fixes, [index]: { ...fixes[index], ...more } };
    setFixes(next);
    // A stop the person just completed is one they mean to add: tick it.
    const item = items?.find((i) => i.index === index);
    if (item && proposeStops([item], context(trip), next)[0]!.state.kind === 'ready') setTicked((tk) => ({ ...tk, [index]: true }));
  }, [fixes, items, trip, context]);

  const queue = stops.filter((st) => ticked[st.index] && st.state.kind === 'ready' && !settled(sends[st.index]));
  const retrying = queue.length > 0 && queue.every((st) => sends[st.index]);
  const anySent = Object.keys(sends).length > 0;
  const anyReady = stops.some((st) => st.state.kind === 'ready');

  const confirm = useCallback(async () => {
    if (!batch.type || queue.length === 0 || busy) return;
    setBusy(true);
    let added = false;
    for (const st of queue) {
      const prior = sends[st.index];
      // An unreachable kernel is retried with THE SAME key and payload, so it can never land twice.
      const sent = prior ? { key: prior.key, input: prior.input } : { key: structureEntryKey('commitment'), input: commitmentInputFor(st, batch)! };
      setSends((m) => ({ ...m, [st.index]: { ...sent, result: 'pending' } }));
      const result = await addCommitmentEntry(tripId, sent.input, sent.key);
      setSends((m) => ({ ...m, [st.index]: { ...sent, result } }));
      if (result.state === 'recorded') added = true;
    }
    setBusy(false);
    if (added) onAdded?.();
  }, [batch, queue, busy, sends, addCommitmentEntry, tripId, onAdded]);

  if (!policy || policy.mode === 'no_assistance') return null;

  const results = Object.values(sends).filter((x) => x.result !== 'pending');
  const addedCount = results.filter((x) => x.result !== 'pending' && x.result.state === 'recorded').length;

  return (
    <View testID="itinerary-paste">
      <Pressable onPress={() => setOpen(true)} style={s.entry} testID="itinerary-paste-open" accessibilityRole="button" accessibilityLabel="Paste an itinerary with times">
        <CalendarClock size={14} color={color.deep} />
        <Text style={s.entryText}>Paste an itinerary with times</Text>
      </Pressable>

      <Modal visible={open} animationType={reduceMotion ? 'none' : 'slide'} onRequestClose={close} statusBarTranslucent testID="itinerary-paste-modal">
        <View style={s.screen} accessibilityViewIsModal testID="itinerary-paste-sheet">
          <View style={s.header}>
            <Text style={s.title} accessibilityRole="header">{phase === 'review' ? 'Review before adding' : 'Paste an itinerary'}</Text>
            <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} testID="itinerary-paste-close">
              <Text style={s.link}>Close</Text>
            </Pressable>
          </View>

          {phase === 'compose' || phase === 'error' ? (
            <View style={{ gap: space.md }}>
              <Text style={s.help}>
                A plan with times, e.g. “Friday: Sky36 at 9pm”. Each line is matched to a known place; a line that matches none is not shown or kept. Nothing is added until you review it and confirm.
              </Text>
              <TextInput
                value={text} onChangeText={setText} multiline autoCorrect={false}
                placeholder={'Friday:\nMadame Lan at 7pm\nSky36 at 9pm'} placeholderTextColor={color.mute}
                style={s.input} accessibilityLabel="Pasted itinerary" testID="itinerary-paste-input"
              />
              {phase === 'error' && error ? (
                <View style={s.inline} accessibilityRole="alert" testID="itinerary-paste-error">
                  <AlertTriangle size={14} color={color.signal} />
                  <Text style={s.body}>{error.message}</Text>
                </View>
              ) : null}
              <Pressable
                onPress={() => void read()} disabled={!text.trim()}
                style={[s.primary, !text.trim() && s.disabled]} testID="itinerary-paste-read"
                accessibilityRole="button" accessibilityState={{ disabled: !text.trim() }}
              >
                <Text style={s.primaryText}>{phase === 'error' && error?.retryable ? 'Try again' : 'Read times'}</Text>
              </Pressable>
            </View>
          ) : null}

          {phase === 'reading' ? (
            <View style={s.center} testID="itinerary-paste-reading">
              <ActivityIndicator color={color.signal} />
              <Text style={s.help}>Reading your itinerary…</Text>
            </View>
          ) : null}

          {phase === 'review' ? (
            <>
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: space.sm, paddingBottom: space.lg }}>
                <Text style={s.help} testID="itinerary-unmatched-note">Lines that matched no place aren’t shown and aren’t kept.</Text>
                {truncated ? <Text style={s.help} testID="itinerary-truncated">Only the first {stops.length} lines were read.</Text> : null}
                {stops.length === 0 ? (
                  <Text style={s.body} testID="itinerary-empty">No line matched a known place, so there is nothing to add.</Text>
                ) : null}
                {anySent ? (
                  <Text style={[s.bodyStrong, addedCount < results.length && { color: color.signalStrong }]} accessibilityRole="alert" testID="itinerary-outcome">
                    {addedCount} of {results.length} added.{addedCount < results.length ? ` ${results.length - addedCount} not added — see below.` : ''}
                  </Text>
                ) : null}

                {stops.map((st) => (
                  <StopRow
                    key={st.index} stop={st} send={sends[st.index]} ticked={!!ticked[st.index]} busy={busy}
                    onTick={() => setTicked((tk) => ({ ...tk, [st.index]: !tk[st.index] }))}
                    onFix={(f) => fix(st.index, f)}
                  />
                ))}

                {anyReady ? (
                  <View style={s.item} testID="itinerary-batch">
                    <Text style={s.help} testID="itinerary-what-is-saved">
                      Each ticked stop becomes a commitment on this trip at its time. The place and the words of the line are not saved with it.
                    </Text>
                    <Text style={s.label}>What are these?</Text>
                    <View style={s.chips}>
                      {COMMITMENT_TYPES.map((v) => (
                        <Chip key={v} label={TYPE_LABEL[v]} on={batch.type === v} disabled={anySent} onPress={() => setBatch((b) => ({ ...b, type: v }))} testID={`itinerary-type-${v}`} />
                      ))}
                    </View>
                    <Text style={s.label}>How fixed are they?</Text>
                    <View style={s.chips}>
                      {COMMITMENT_FLEXIBILITIES.map((v) => (
                        <Chip key={v} label={FLEX_LABEL[v]} on={batch.flexibility === v} disabled={anySent} onPress={() => setBatch((b) => ({ ...b, flexibility: v }))} testID={`itinerary-flex-${v}`} />
                      ))}
                    </View>
                    <Text style={s.label}>Stage</Text>
                    <View style={s.chips}>
                      <Chip label="No stage" on={batch.stageId === null} disabled={anySent} onPress={() => setBatch((b) => ({ ...b, stageId: null }))} testID="itinerary-stage-none" />
                      {[...stages].sort((a, b) => a.sequence - b.sequence).map((sg) => (
                        <Chip key={sg.id} label={`${sg.sequence}. ${sg.stageType}`} on={batch.stageId === sg.id} disabled={anySent} onPress={() => setBatch((b) => ({ ...b, stageId: sg.id }))} testID={`itinerary-stage-${sg.id}`} />
                      ))}
                    </View>
                  </View>
                ) : null}
              </ScrollView>

              <View style={s.footer}>
                <Pressable onPress={() => { reset(); }} disabled={busy} accessibilityRole="button" style={s.secondary} testID="itinerary-paste-edit">
                  <Text style={s.link}>Edit paste</Text>
                </Pressable>
                <Pressable
                  onPress={() => void confirm()} disabled={!batch.type || queue.length === 0 || busy}
                  style={[s.primary, { flex: 1 }, (!batch.type || queue.length === 0 || busy) && s.disabled]}
                  testID="itinerary-paste-confirm" accessibilityRole="button"
                  accessibilityState={{ disabled: !batch.type || queue.length === 0 || busy }}
                >
                  {busy ? <ActivityIndicator color={color.onInk} /> : (
                    <Text style={s.primaryText}>
                      {queue.length === 0 ? (anySent ? 'Nothing left to add' : 'Tick what to add')
                        : !batch.type ? 'Choose what these are'
                        : retrying ? `Try again (${queue.length})`
                        : `Add ${queue.length} stop${queue.length === 1 ? '' : 's'}`}
                    </Text>
                  )}
                </Pressable>
              </View>
            </>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

function zoneSuffix(from: 'place' | 'trip' | 'device'): string {
  return from === 'trip' ? " (the trip's)" : from === 'device' ? " (this phone's)" : '';
}

function StopRow({ stop, send, ticked, busy, onTick, onFix }: {
  stop: ProposedStop; send: Send | undefined; ticked: boolean; busy: boolean;
  onTick: () => void; onFix: (f: StopFix) => void;
}) {
  const i = stop.index;
  const st = stop.state;
  const locked = busy || settled(send) || (!!send && send.result === 'pending');
  const pasted = [stop.pastedDay, stop.pastedTime].filter(Boolean).join(' · ');
  return (
    <View style={s.item} testID={`itinerary-stop-${i}`}>
      <View style={s.itemHead}>
        <Text style={[s.bodyStrong, { flexShrink: 1 }]} numberOfLines={2}>{stop.title}{stop.subtitle ? `, ${stop.subtitle}` : ''}</Text>
        {pasted ? <Text style={s.help} testID={`itinerary-stop-pasted-${i}`}>{pasted}</Text> : null}
      </View>

      {st.kind === 'ready' ? (
        <Pressable
          onPress={onTick} disabled={locked} style={s.inline} testID={`itinerary-stop-tick-${i}`}
          accessibilityRole="checkbox" accessibilityState={{ checked: ticked, disabled: locked }}
          accessibilityLabel={`${stop.title}, ${dayWords(st.date)} at ${clockWords(st.time)}`}
        >
          <View style={[s.box, ticked && s.boxOn]} />
          <Text style={s.body} testID={`itinerary-stop-when-${i}`}>
            {dayWords(st.date)} · {clockWords(st.time)} · {st.zone}{zoneSuffix(st.zoneFrom)}
          </Text>
        </Pressable>
      ) : null}
      {st.kind === 'ready' && stop.partial ? (
        <Text style={s.help}>Some sources couldn’t be checked — confirm this is the right place.</Text>
      ) : null}

      {st.kind === 'hold' && st.need === 'meridiem' ? (
        <View testID={`itinerary-hold-${i}`}>
          <Text style={s.body}>Is “{stop.pastedTime}” in the morning or the evening?</Text>
          <View style={s.chips}>
            <Chip label={meridiemWords(st.am)} on={false} onPress={() => onFix({ meridiem: 'am' })} testID={`itinerary-fix-am-${i}`} />
            <Chip label={meridiemWords(st.pm)} on={false} onPress={() => onFix({ meridiem: 'pm' })} testID={`itinerary-fix-pm-${i}`} />
          </View>
        </View>
      ) : null}
      {st.kind === 'hold' && st.need === 'zone' ? (
        <View testID={`itinerary-hold-${i}`}>
          <Text style={s.body}>No time zone is known for this place or this trip.</Text>
          {st.deviceZone ? (
            <Chip label={`Use this phone's: ${st.deviceZone}`} on={false} onPress={() => onFix({ deviceZone: st.deviceZone! })} testID={`itinerary-fix-zone-${i}`} a11y={`Use this phone's time zone, ${st.deviceZone}`} />
          ) : null}
        </View>
      ) : null}
      {st.kind === 'hold' && st.need === 'date' ? (
        <View testID={`itinerary-hold-${i}`}>
          <Text style={s.body}>{dayChoiceWords(st.why, stop.pastedDay)}</Text>
          <View style={s.chips}>
            {st.options.map((d) => (
              <Chip key={d} label={dayWords(d)} on={false} onPress={() => onFix({ date: d })} testID={`itinerary-fix-date-${i}-${d}`} />
            ))}
          </View>
        </View>
      ) : null}
      {st.kind === 'hold' && st.need === 'occurrence' ? (
        <View testID={`itinerary-hold-${i}`}>
          <Text style={s.body}>That time happens twice on {dayWords(st.date)} in {st.zone} (the clocks go back). Which one?</Text>
          <View style={s.chips}>
            <Chip label={`The first (${offsetWords(st.earlier)})`} on={false} onPress={() => onFix({ occurrence: 'earlier' })} testID={`itinerary-fix-earlier-${i}`} />
            <Chip label={`The second (${offsetWords(st.later)})`} on={false} onPress={() => onFix({ occurrence: 'later' })} testID={`itinerary-fix-later-${i}`} />
          </View>
        </View>
      ) : null}
      {st.kind === 'blocked' ? (
        <Text style={[s.body, { color: color.signalStrong }]} testID={`itinerary-stop-blocked-${i}`}>{blockWords(st)}</Text>
      ) : null}

      {send?.result === 'pending' ? (
        <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start' }} testID={`itinerary-stop-sending-${i}`} accessibilityLabel="Adding" />
      ) : send?.result.state === 'recorded' ? (
        <View style={s.inline} testID={`itinerary-stop-added-${i}`}>
          <CheckCircle2 size={12} color={color.success} />
          <Text style={[s.help, { color: color.success, marginTop: 0 }]}>Added{send.result.duplicate ? ' (already was)' : ''}</Text>
        </View>
      ) : send?.result.state === 'refused' ? (
        <Text style={[s.body, { color: color.signalStrong }]} testID={`itinerary-stop-refused-${i}`}>Not added — {send.result.detail}</Text>
      ) : send?.result.state === 'unavailable' ? (
        <Text style={[s.body, { color: color.signalStrong }]} testID={`itinerary-stop-unavailable-${i}`}>
          Couldn’t reach the trip — {send.result.detail}. Nothing was added for this one; “Try again” sends the same stop once more.
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  entry: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', marginTop: space.sm, paddingVertical: space.xs },
  entryText: { ...t.small, color: color.deep, fontWeight: '600' },
  screen: { flex: 1, backgroundColor: color.paper, paddingTop: space.xxl, paddingHorizontal: space.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: space.md },
  title: { ...t.heading, color: color.ink, flex: 1 },
  link: { ...t.bodyStrong, color: color.deep },
  help: { ...t.small, color: color.mute },
  body: { ...t.small, color: color.ink, flexShrink: 1 },
  bodyStrong: { ...t.bodyStrong, color: color.ink },
  label: { ...t.small, color: color.ink, fontWeight: '600', marginTop: space.xs },
  input: { minHeight: 140, ...t.body, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, textAlignVertical: 'top' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
  primary: { backgroundColor: color.signalStrong, borderRadius: radius.md, paddingVertical: space.md, paddingHorizontal: space.lg, alignItems: 'center' },
  primaryText: { ...t.bodyStrong, color: color.onInk },
  disabled: { opacity: 0.45 },
  secondary: { paddingVertical: space.md, paddingHorizontal: space.md },
  center: { alignItems: 'center', gap: space.sm, paddingTop: space.xl },
  item: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.xs },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between', gap: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  chip: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  chipOn: { backgroundColor: color.deep, borderColor: color.deep },
  chipText: { ...t.small, color: color.ink },
  chipTextOn: { color: '#fff' },
  box: { width: 18, height: 18, borderRadius: radius.sm, borderWidth: 1.5, borderColor: color.mute },
  boxOn: { backgroundColor: color.signalStrong, borderColor: color.signalStrong },
  footer: { flexDirection: 'row', gap: space.sm, paddingVertical: space.md, alignItems: 'center' },
});
