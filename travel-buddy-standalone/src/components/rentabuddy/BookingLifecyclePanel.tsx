/**
 * BookingLifecyclePanel — the controls that move a booking through its life.
 *
 * Testing mode (lane tm-rab, WP-01; PLAT-F43, PLAT-F45). The server routes all
 * existed, but nothing in the app called them, so a booking could never be
 * started, completed or confirmed from the app, check-ins had no button, and a
 * buddy's "suggest another time" could be sent but never seen or answered.
 *
 * Which controls appear is `lifecycleActions` (services/rentABuddyLifecycle.ts),
 * mirroring the server's guards. Every control posts to a route that re-checks
 * party and status; the panel never changes local status optimistically — it
 * asks the screen to reload (`onChanged`) after the server says yes.
 *
 * A gate refusal (the master switch, for these routes) renders as its own
 * state (RabGateRefusalState), not an error Alert. A failed read of the
 * suggestions is an error with a retry, never "no suggestions".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, Modal, ActivityIndicator } from 'react-native';
import { Play, CheckCircle, MapPin, ThumbsUp, Clock, Calendar } from 'lucide-react-native';
import { color, space, radius, type as t, layout } from '../../theme/tokens.ts';
import {
  startBooking,
  completeBooking,
  travelerConfirmComplete,
  submitCheckIn,
  suggestChanges,
  getBookingChangeRequests,
  respondToChangeRequest,
  bookingErrorCopy,
  type BuddyBooking,
  type BookingChangeRequest,
  type CheckInStatus,
} from '../../services/rentABuddy.ts';
import { describeGateRefusal, type GateRefusal } from '../../services/rentABuddyGates.ts';
import { lifecycleActions, describeChangeRequest, type BookingParty } from '../../services/rentABuddyLifecycle.ts';
import { RabGateRefusalState } from './RabGateRefusalState.tsx';
import { GlobalCalendarPicker } from '../selectors/GlobalCalendarPicker.tsx';
import { GlobalTimePicker } from '../selectors/GlobalTimePicker.tsx';

type Failure = { ok: false; error: string; gate?: string };

function SuggestTimeModal({ visible, onClose, onSend }: {
  visible: boolean;
  onClose: () => void;
  onSend: (p: { proposedDate?: string; proposedTime?: string }) => void;
}) {
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [showDate, setShowDate] = useState(false);
  const [showTime, setShowTime] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const ready = date.length > 0 || time.length > 0;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={m.overlay}>
        <View style={m.sheet}>
          <Text style={m.title}>Suggest another time</Text>
          <Text style={m.sub}>The other side sees your suggestion on this booking and can accept or decline it. Nothing changes until they accept.</Text>
          <Pressable style={m.field} onPress={() => setShowDate(true)} testID="suggest-date">
            <Calendar size={14} color={date ? color.ink : color.mute} />
            <Text style={{ color: date ? color.ink : color.mute }}>{date || 'New date (optional)'}</Text>
          </Pressable>
          <Pressable style={m.field} onPress={() => setShowTime(true)} testID="suggest-time">
            <Clock size={14} color={time ? color.ink : color.mute} />
            <Text style={{ color: time ? color.ink : color.mute }}>{time || 'New start time (optional)'}</Text>
          </Pressable>
          <GlobalCalendarPicker
            visible={showDate}
            mode="single"
            value={date || null}
            minDate={today}
            title="Suggested date"
            onConfirm={(v) => { setDate(v ?? ''); setShowDate(false); }}
            onCancel={() => setShowDate(false)}
          />
          <GlobalTimePicker
            visible={showTime}
            value={time || null}
            title="Suggested start time"
            onChange={(v) => setTime(v ?? '')}
            onClose={() => setShowTime(false)}
          />
          <View style={m.actions}>
            <Pressable style={m.cancel} onPress={onClose}><Text style={m.cancelText}>Never mind</Text></Pressable>
            <Pressable
              style={[m.send, !ready && { opacity: 0.4 }]}
              disabled={!ready}
              onPress={() => onSend({ ...(date ? { proposedDate: date } : {}), ...(time ? { proposedTime: time } : {}) })}
              testID="suggest-send"
            >
              <Text style={m.sendText}>Send suggestion</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function BookingLifecyclePanel({
  booking,
  party,
  onChanged,
  onOpenDispute,
}: {
  booking: BuddyBooking;
  party: BookingParty | null;
  /** Reload the booking — called only after the server accepted a transition. */
  onChanged: () => void;
  /** Open the screen's dispute sheet (traveller, awaiting confirmation). */
  onOpenDispute?: () => void;
}) {
  const actions = lifecycleActions(booking.status, party);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [gate, setGate] = useState<GateRefusal | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);

  const [changes, setChanges] = useState<BookingChangeRequest[] | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  const showChanges = actions.suggestChange || actions.respondToChange;

  const loadChanges = useCallback(async () => {
    if (!showChanges) return;
    setChangesLoading(true);
    setChangesError(null);
    const res = await getBookingChangeRequests(booking.id);
    setChangesLoading(false);
    if (res.ok) { setChanges(res.data.changeRequests); return; }
    const g = describeGateRefusal(res.error, res.gate);
    if (g) { setGate(g); setChanges(null); return; }
    setChangesError(bookingErrorCopy(res.error, "Couldn't load suggestions for this booking."));
  }, [booking.id, showChanges]);

  useEffect(() => { void loadChanges(); }, [loadChanges]);

  /** One control at a time; a refusal by a gate becomes the gate state, anything else an Alert. */
  const run = useCallback(async (
    key: string,
    call: () => Promise<{ ok: true } | Failure | { ok: boolean }>,
    success: { title: string; body: string },
    fallback: string,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    try {
      const res = await call() as { ok: true } | Failure;
      if (res.ok) {
        setGate(null);
        Alert.alert(success.title, success.body);
        onChanged();
        void loadChanges();
        return;
      }
      const g = describeGateRefusal(res.error, res.gate);
      if (g) { setGate(g); return; }
      Alert.alert("That didn't go through", bookingErrorCopy(res.error, fallback));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }, [onChanged, loadChanges]);

  const checkIn = (type: CheckInStatus, label: string) => run(
    `checkin-${type}`,
    () => submitCheckIn(booking.id, type, booking.city),
    { title: 'Check-in recorded', body: `${label} — saved to this booking's safety log.` },
    'Could not record your check-in.',
  );

  const pending = (changes ?? []).filter((c) => c.status === 'pending');

  const awaitingTraveler = booking.status === 'completed_pending_traveler_confirmation' && party === 'buddy';
  const anything = actions.start || actions.complete || actions.confirmCompletion || actions.checkIn || showChanges || awaitingTraveler;
  if (!anything && !gate) return null;

  return (
    <View style={p.wrap} testID="booking-lifecycle-panel">
      <Text style={p.heading}>Session</Text>

      {gate ? <RabGateRefusalState refusal={gate} compact onRetry={() => { setGate(null); onChanged(); void loadChanges(); }} testID="lifecycle-gate" /> : null}

      {actions.start ? (
        <Pressable
          style={({ pressed }) => [p.btn, p.primary, pressed && { opacity: layout.pressedOpacity }]}
          disabled={busy !== null}
          testID="lifecycle-start"
          onPress={() => Alert.alert(
            'Start the session?',
            'Start only once you and the traveller have met at the public meetup point.',
            [
              { text: 'Not yet', style: 'cancel' },
              {
                text: 'Start session',
                onPress: () => run('start', () => startBooking(booking.id),
                  { title: 'Session started', body: 'The traveller can see the session is live.' },
                  'Could not start the session.'),
              },
            ],
          )}
        >
          {busy === 'start' ? <ActivityIndicator color={color.onInk} /> : <Play size={16} color={color.onInk} />}
          <Text style={p.primaryText}>Start session</Text>
        </Pressable>
      ) : null}

      {actions.complete ? (
        <Pressable
          style={({ pressed }) => [p.btn, p.primary, pressed && { opacity: layout.pressedOpacity }]}
          disabled={busy !== null}
          testID="lifecycle-complete"
          onPress={() => Alert.alert(
            'Mark the session complete?',
            party === 'buddy'
              ? 'The traveller then confirms it went ahead (they have 24 hours to confirm or raise a problem).'
              : 'This ends the session and marks it complete. Settle any cash balance with your Buddy first.',
            [
              { text: 'Keep going', style: 'cancel' },
              {
                text: 'Complete',
                onPress: () => run('complete', () => completeBooking(booking.id),
                  party === 'buddy'
                    ? { title: 'Marked complete', body: 'Waiting for the traveller to confirm.' }
                    : { title: 'Session complete', body: 'Thanks — you can leave a review now.' },
                  'Could not complete the session.'),
              },
            ],
          )}
        >
          {busy === 'complete' ? <ActivityIndicator color={color.onInk} /> : <CheckCircle size={16} color={color.onInk} />}
          <Text style={p.primaryText}>Complete session</Text>
        </Pressable>
      ) : null}

      {awaitingTraveler ? (
        <Text style={p.note} testID="lifecycle-awaiting-traveler">You marked this session complete. Waiting for the traveller to confirm.</Text>
      ) : null}

      {actions.confirmCompletion ? (
        <View style={p.confirmBox} testID="lifecycle-confirm-box">
          <Text style={p.note}>Your Buddy marked this session complete. Confirm it went ahead — or, if something was wrong, open a dispute instead.</Text>
          <View style={p.row}>
            <Pressable
              style={({ pressed }) => [p.btn, p.primary, { flex: 1 }, pressed && { opacity: layout.pressedOpacity }]}
              disabled={busy !== null}
              testID="lifecycle-confirm"
              onPress={() => run('confirm', () => travelerConfirmComplete(booking.id),
                { title: 'Confirmed', body: 'The booking is complete. You can leave a review now.' },
                'Could not confirm the booking.')}
            >
              {busy === 'confirm' ? <ActivityIndicator color={color.onInk} /> : <ThumbsUp size={16} color={color.onInk} />}
              <Text style={p.primaryText}>Confirm completion</Text>
            </Pressable>
            {onOpenDispute ? (
              <Pressable style={({ pressed }) => [p.btn, { flex: 1 }, pressed && { opacity: layout.pressedOpacity }]} onPress={onOpenDispute}>
                <Text style={p.btnText}>Open a dispute</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {actions.checkIn ? (
        <View style={p.row}>
          <Pressable
            style={({ pressed }) => [p.btn, { flex: 1 }, pressed && { opacity: layout.pressedOpacity }]}
            disabled={busy !== null}
            testID="lifecycle-checkin-arrival"
            onPress={() => checkIn('arrival', "You've arrived")}
          >
            <MapPin size={15} color={color.deep} />
            <Text style={p.btnText}>I've arrived</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [p.btn, { flex: 1 }, pressed && { opacity: layout.pressedOpacity }]}
            disabled={busy !== null}
            testID="lifecycle-checkin-ok"
            onPress={() => checkIn('check_ok', 'All good')}
          >
            <ThumbsUp size={15} color={color.deep} />
            <Text style={p.btnText}>All good</Text>
          </Pressable>
        </View>
      ) : null}

      {showChanges ? (
        <View style={p.changes} testID="lifecycle-changes">
          <View style={p.changesHead}>
            <Text style={p.subheading}>Suggested changes</Text>
            {actions.suggestChange ? (
              <Pressable onPress={() => setSuggestOpen(true)} testID="lifecycle-suggest" hitSlop={8}>
                <Text style={p.link}>Suggest another time</Text>
              </Pressable>
            ) : null}
          </View>
          {changesLoading ? <ActivityIndicator color={color.deep} /> : null}
          {changesError ? (
            <View style={p.row} testID="lifecycle-changes-error">
              <Text style={[p.note, { flex: 1 }]}>{changesError}</Text>
              <Pressable onPress={() => void loadChanges()} hitSlop={8}><Text style={p.link}>Try again</Text></Pressable>
            </View>
          ) : null}
          {!changesLoading && !changesError && changes !== null && pending.length === 0 ? (
            <Text style={p.note} testID="lifecycle-changes-empty">No pending suggestions on this booking.</Text>
          ) : null}
          {pending.map((cr) => (
            <View key={cr.id} style={p.changeRow} testID={`change-${cr.id}`}>
              <Text style={p.changeText}>{describeChangeRequest(cr)}</Text>
              {cr.reason ? <Text style={p.note}>“{cr.reason}”</Text> : null}
              {cr.requestedByMe ? (
                <Text style={p.note}>You suggested this — waiting for the other side.</Text>
              ) : actions.respondToChange ? (
                <View style={p.row}>
                  <Pressable
                    style={({ pressed }) => [p.btn, p.primary, { flex: 1 }, pressed && { opacity: layout.pressedOpacity }]}
                    disabled={busy !== null}
                    testID={`change-accept-${cr.id}`}
                    onPress={() => run(`accept-${cr.id}`, () => respondToChangeRequest(booking.id, cr.id, 'accept'),
                      { title: 'Change accepted', body: 'The booking has been updated.' },
                      'Could not accept the change.')}
                  >
                    <Text style={p.primaryText}>Accept</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [p.btn, { flex: 1 }, pressed && { opacity: layout.pressedOpacity }]}
                    disabled={busy !== null}
                    testID={`change-decline-${cr.id}`}
                    onPress={() => run(`decline-${cr.id}`, () => respondToChangeRequest(booking.id, cr.id, 'decline'),
                      { title: 'Change declined', body: 'The booking stays as it was.' },
                      'Could not decline the change.')}
                  >
                    <Text style={p.btnText}>Decline</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      <SuggestTimeModal
        visible={suggestOpen}
        onClose={() => setSuggestOpen(false)}
        onSend={(payload) => {
          setSuggestOpen(false);
          void run('suggest', () => suggestChanges(booking.id, payload),
            { title: 'Suggestion sent', body: 'The other side has been notified and can accept or decline it here.' },
            'Could not send your suggestion.');
        }}
      />
    </View>
  );
}

const p = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, marginTop: space.lg, gap: space.sm },
  heading: { ...t.bodyStrong, color: color.ink, fontSize: 16 },
  subheading: { ...t.bodyStrong, color: color.ink },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    paddingVertical: space.sm, paddingHorizontal: space.md, backgroundColor: color.paperRaised,
  },
  primary: { backgroundColor: color.ink, borderColor: color.ink },
  primaryText: { ...t.bodyStrong, color: color.onInk },
  btnText: { ...t.bodyStrong, color: color.ink },
  note: { ...t.small, color: color.mute, lineHeight: 18 },
  link: { ...t.small, color: color.signal, fontWeight: '700' },
  confirmBox: { gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  changes: { gap: space.sm, marginTop: space.sm },
  changesHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  changeRow: { gap: space.xs, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  changeText: { ...t.body, color: color.ink },
});

const m = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: color.paper, padding: space.lg, gap: space.md, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  title: { ...t.title, color: color.ink },
  sub: { ...t.small, color: color.mute },
  field: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  cancel: { flex: 1, alignItems: 'center', padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze },
  cancelText: { ...t.bodyStrong, color: color.ink },
  send: { flex: 1, alignItems: 'center', padding: space.md, borderRadius: radius.md, backgroundColor: color.ink },
  sendText: { ...t.bodyStrong, color: color.onInk },
});
