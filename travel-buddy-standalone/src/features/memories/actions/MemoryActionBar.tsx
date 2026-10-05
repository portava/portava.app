/**
 * MemoryActionBar — §14 Executable Memories on the Memory screen
 * (census-highlights-memories H16/H107/H108/H259).
 *
 * The bar asks the server what can be done with this Memory NOW and offers it:
 *
 *   Do this again    the server compiles a plan from the place as it is today,
 *                    a live reading (or an honest "can't say"), the traveller's
 *                    trip going there and the free time the Trips Temporal
 *                    Freedom Engine finds on it — then offers Add to trip and
 *                    Directions from that plan.
 *   Add to trip      the CURRENT place (a merged place's successor) handed to
 *                    TripWishlistPicker, which writes through the trip's own path.
 *   Take me back     directions to where the place is now; for the owner of a
 *                    Memory with no catalog place, to where THEY recorded it.
 *   View place       the place screen for the current catalog row.
 *   Saved from that trip   the owner's own unvisited saves from the earlier
 *                    trip, still open today, each addable to a trip.
 *
 * HONEST STATES. A menu that could not be read is an error with Try again —
 * never an empty bar. A place the catalog says has closed, or could not be
 * checked, is SAID (testID memory-actions-note), not silently dropped.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator, Alert, Linking, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Repeat, ListPlus, Navigation, MapPin, History } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import { TripWishlistPicker } from '../../../components/discovery/TripWishlistPicker.tsx';
import {
  getMemoryActions, compileDoAgain, compileAddToTrip, compileTakeMeBack, compileBringForward,
  directionsUrl, CAUTION_TEXT,
  type ActionMenu, type ActionDescriptor, type AddToTripPayload, type DoAgainPlan,
  type BroughtForward, type LeftBehind, type MemoryActionName,
} from './memoryActionsApi.ts';

type MenuState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ok'; menu: ActionMenu };

const VENUE_ACTIONS: readonly MemoryActionName[] = ['DO_AGAIN', 'ADD_TO_TRIP', 'TAKE_ME_BACK', 'VIEW_PLACE'];
/** Refusals worth a sentence: they are facts about the place, not about the app. */
const SAID_REFUSALS = new Set(['PLACE_CLOSED', 'PLACE_UNREADABLE']);

const LABEL: Partial<Record<MemoryActionName, string>> = {
  DO_AGAIN: 'Do this again',
  ADD_TO_TRIP: 'Add to trip',
  TAKE_ME_BACK: 'Take me back',
  VIEW_PLACE: 'View place',
  BRING_FORWARD_SAVED: 'Saved from that trip',
};
const ICON: Partial<Record<MemoryActionName, React.ComponentType<{ size?: number; color?: string }>>> = {
  DO_AGAIN: Repeat, ADD_TO_TRIP: ListPlus, TAKE_ME_BACK: Navigation, VIEW_PLACE: MapPin, BRING_FORWARD_SAVED: History,
};
const SHOWN: readonly MemoryActionName[] = ['DO_AGAIN', 'ADD_TO_TRIP', 'TAKE_ME_BACK', 'VIEW_PLACE', 'BRING_FORWARD_SAVED'];

const LEFT_BEHIND_TEXT: Record<LeftBehind['reason'], string> = {
  PLACE_CLOSED: 'has closed',
  PLACE_NOT_IN_CATALOG: 'is not in Portava\'s place catalog',
  ALREADY_EXPERIENCED: 'you already have a Memory there',
};

function formatWindow(beginsAt: string, endsAt: string): string {
  const b = new Date(beginsAt); const e = new Date(endsAt);
  const day = b.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const hm = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${hm(b)}–${hm(e)}`;
}

export function MemoryActionBar({ memoryId }: { memoryId: string }) {
  const [menu, setMenu] = useState<MenuState>({ state: 'loading' });
  const [busy, setBusy] = useState<MemoryActionName | null>(null);
  const [plan, setPlan] = useState<DoAgainPlan | null>(null);
  const [forward, setForward] = useState<{ items: BroughtForward[]; leftBehind: LeftBehind[] } | null>(null);
  const [pickerPlace, setPickerPlace] = useState<AddToTripPayload | null>(null);

  const load = useCallback(async () => {
    setMenu({ state: 'loading' });
    const res = await getMemoryActions(memoryId);
    setMenu(res.ok ? { state: 'ok', menu: res.menu } : { state: 'error', message: res.message });
  }, [memoryId]);

  useEffect(() => { void load(); }, [load]);

  const fail = (message: string) => Alert.alert('Could not do that', message);

  const runDoAgain = useCallback(async (tripId?: string) => {
    setBusy('DO_AGAIN');
    const res = await compileDoAgain(memoryId, tripId ?? null);
    setBusy(null);
    if (!res.ok) { fail(res.message); return; }
    setPlan(res.plan);
  }, [memoryId]);

  const onPress = useCallback(async (d: ActionDescriptor, m: ActionMenu) => {
    if (d.action === 'DO_AGAIN') { await runDoAgain(); return; }
    if (d.action === 'VIEW_PLACE') { if (m.place) router.push(`/place/${m.place.id}` as never); return; }
    setBusy(d.action);
    if (d.action === 'ADD_TO_TRIP') {
      const res = await compileAddToTrip(memoryId);
      setBusy(null);
      if (!res.ok) { fail(res.message); return; }
      setPickerPlace(res.addToTrip);
      return;
    }
    if (d.action === 'TAKE_ME_BACK') {
      const res = await compileTakeMeBack(memoryId);
      setBusy(null);
      if (!res.ok) { fail(res.message); return; }
      Linking.openURL(directionsUrl(res.navigation)).catch(() => fail('Your maps app could not be opened.'));
      return;
    }
    if (d.action === 'BRING_FORWARD_SAVED') {
      const res = await compileBringForward(memoryId);
      setBusy(null);
      if (!res.ok) { fail(res.message); return; }
      setForward({ items: res.items, leftBehind: res.leftBehind });
      return;
    }
    setBusy(null);
  }, [memoryId, runDoAgain]);

  if (menu.state === 'loading') {
    return <View style={s.wrap} testID="memory-actions-loading"><ActivityIndicator size="small" color={color.signal} /></View>;
  }
  if (menu.state === 'error') {
    return (
      <View style={s.wrap} testID="memory-actions-error">
        <Text style={s.note}>Could not check what you can do with this Memory. {menu.message}</Text>
        <Pressable onPress={load} testID="memory-actions-retry" accessibilityRole="button" accessibilityLabel="Try again">
          <Text style={s.link}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const m = menu.menu;
  const by = new Map(m.actions.map((a) => [a.action, a] as const));
  const offeredActions = SHOWN.map((a) => by.get(a)).filter((a): a is ActionDescriptor => Boolean(a?.available));
  const saidRefusal = VENUE_ACTIONS.map((a) => by.get(a)).find((a) => a && !a.available && a.reason && SAID_REFUSALS.has(a.reason));
  const caution = by.get('DO_AGAIN')?.caution ?? null;

  return (
    <View style={s.wrap} testID="memory-actions">
      {offeredActions.length > 0 ? (
        <View style={s.row}>
          {offeredActions.map((d) => {
            const Icon = ICON[d.action];
            return (
              <Pressable
                key={d.action}
                style={[s.chip, busy === d.action && s.chipBusy]}
                onPress={() => { void onPress(d, m); }}
                disabled={busy !== null}
                testID={`memory-action-${d.action}`}
                accessibilityRole="button"
                accessibilityLabel={LABEL[d.action]}
              >
                {busy === d.action ? <ActivityIndicator size="small" color={color.deep} /> : Icon ? <Icon size={15} color={color.deep} /> : null}
                <Text style={s.chipText}>{LABEL[d.action]}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {caution ? <Text style={s.note} testID="memory-actions-caution">{CAUTION_TEXT[caution]}</Text> : null}
      {saidRefusal ? (
        <View testID="memory-actions-note">
          <Text style={s.note}>{saidRefusal.message}</Text>
          {saidRefusal.reason === 'PLACE_UNREADABLE' ? (
            <Pressable onPress={load} testID="memory-actions-retry" accessibilityRole="button" accessibilityLabel="Try again">
              <Text style={s.link}>Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <Modal visible={plan !== null} transparent animationType="slide" onRequestClose={() => setPlan(null)}>
        <Pressable style={s.backdrop} onPress={() => setPlan(null)} />
        {plan ? (
          <View style={s.sheet} testID="do-again-sheet">
            <ScrollView>
              <Text style={s.title}>Do this again: {plan.place.name}</Text>
              {plan.caution ? <Text style={s.note}>{CAUTION_TEXT[plan.caution]}</Text> : null}
              <Text style={s.body} testID="do-again-historical">{plan.fusion.historical.claim}</Text>
              <Text style={s.body} testID="do-again-current">
                {plan.fusion.current.available ? plan.fusion.current.statement : 'Portava can\'t say whether it is open right now.'}
              </Text>
              <TripSection plan={plan} onPickTrip={(id) => { void runDoAgain(id); }} />
            </ScrollView>
            <View style={s.row}>
              <Pressable
                style={s.chip}
                testID="do-again-add-to-trip"
                accessibilityRole="button"
                onPress={() => { const p = plan.addToTrip; setPlan(null); setPickerPlace(p); }}
              >
                <ListPlus size={15} color={color.deep} /><Text style={s.chipText}>Add to a trip</Text>
              </Pressable>
              <Pressable
                style={s.chip}
                testID="do-again-directions"
                accessibilityRole="button"
                onPress={() => { Linking.openURL(directionsUrl(plan.navigation)).catch(() => fail('Your maps app could not be opened.')); }}
              >
                <Navigation size={15} color={color.deep} /><Text style={s.chipText}>Directions</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </Modal>

      <Modal visible={forward !== null} transparent animationType="slide" onRequestClose={() => setForward(null)}>
        <Pressable style={s.backdrop} onPress={() => setForward(null)} />
        {forward ? (
          <View style={s.sheet} testID="bring-forward-sheet">
            <ScrollView>
              <Text style={s.title}>Saved on that trip</Text>
              {forward.items.length === 0 ? <Text style={s.note}>Nothing you saved on that trip is still waiting for you.</Text> : null}
              {forward.items.map((it) => (
                <View key={it.addToTrip.id} style={s.itemRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.body}>{it.addToTrip.name}</Text>
                    {it.caution ? <Text style={s.note}>{CAUTION_TEXT[it.caution]}</Text> : null}
                  </View>
                  <Pressable
                    style={s.chip}
                    testID={`bring-forward-add-${it.addToTrip.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Add ${it.addToTrip.name} to a trip`}
                    onPress={() => { const p = it.addToTrip; setForward(null); setPickerPlace(p); }}
                  >
                    <ListPlus size={15} color={color.deep} /><Text style={s.chipText}>Add</Text>
                  </Pressable>
                </View>
              ))}
              {forward.leftBehind.map((l, i) => (
                <Text key={`${l.placeName}-${i}`} style={s.note} testID="bring-forward-left-behind">
                  {l.placeName} — {LEFT_BEHIND_TEXT[l.reason]}.
                </Text>
              ))}
            </ScrollView>
          </View>
        ) : null}
      </Modal>

      <TripWishlistPicker
        place={pickerPlace}
        visible={pickerPlace !== null}
        onClose={() => setPickerPlace(null)}
        onSaved={() => setPickerPlace(null)}
      />
    </View>
  );
}

function TripSection({ plan, onPickTrip }: { plan: DoAgainPlan; onPickTrip: (tripId: string) => void }) {
  const c = plan.tripChoice;
  if (c.state === 'unreadable') return <Text style={s.note} testID="do-again-trips-unreadable">Your trips could not be read, so free time was not checked.</Text>;
  if (c.state === 'no_trips') return <Text style={s.note} testID="do-again-no-trips">You have no upcoming trips. Add it to a new one.</Text>;
  if (c.state === 'none_matching') {
    return (
      <View testID="do-again-pick-trip">
        <Text style={s.note}>None of your upcoming trips goes to {plan.place.city ?? 'this place'}. Check free time on one:</Text>
        {c.candidates.map((tr) => (
          <Pressable key={tr.id} onPress={() => onPickTrip(tr.id)} testID={`do-again-trip-${tr.id}`} accessibilityRole="button">
            <Text style={s.link}>{tr.title}</Text>
          </Pressable>
        ))}
      </View>
    );
  }
  const f = plan.freedom;
  return (
    <View testID="do-again-trip">
      <Text style={s.bodyStrong}>On {c.trip.title}</Text>
      {f.consulted ? (
        f.windows.length > 0 ? (
          f.windows.map((w) => <Text key={w.id} style={s.body} testID="do-again-window">Free {formatWindow(w.beginsAt, w.endsAt)}</Text>)
        ) : <Text style={s.note} testID="do-again-no-window">No free time of an hour or more was found on this trip.</Text>
      ) : <Text style={s.note} testID="do-again-freedom-not-consulted">Free time was not checked: {f.info}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: space.sm, gap: space.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    paddingVertical: space.xs + 2, paddingHorizontal: space.md,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  chipBusy: { opacity: 0.6 },
  chipText: { ...(t.small as object), color: color.deep, fontWeight: '600' },
  note: { ...(t.small as object), color: color.mute },
  link: { ...(t.small as object), color: color.signalStrong, fontWeight: '600', marginTop: space.xs },
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.35)' },
  sheet: {
    backgroundColor: color.paper, padding: space.lg, gap: space.sm,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, maxHeight: '75%',
  },
  title: { ...(t.heading as object), color: color.ink, marginBottom: space.sm },
  body: { ...(t.body as object), color: color.ink, marginTop: space.xs },
  bodyStrong: { ...(t.bodyStrong as object), color: color.ink, marginTop: space.sm },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
});
