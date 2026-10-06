/**
 * EmergencyHelpSheet
 *
 * A calm bottom sheet with emergency options.
 * IMPORTANT: No action is automatic. Every action requires an explicit tap.
 * The app never auto-dials or auto-contacts anyone.
 *
 * ── THE NUMBER ───────────────────────────────────────────────────────────────
 * It used to dial `tel:112` everywhere. 112 is not the number in Japan, the
 * US, the UK or China. The numbers now come from the country essentials:
 * an explicit `countryCode` (a layover's airport country) wins; otherwise the
 * trip's destination countries (`/api/trips/:tripId/essentials`, which also
 * checks the viewer is on the trip). Each number says what it reaches, and
 * the essentials' confirm-on-arrival disclaimer is shown beside them.
 * UNKNOWN — feature off, country not covered, no trip, read failed, or a
 * number that is not plain digits — shows NO dial button: a wrong emergency
 * number is worse than none, so the sheet says it does not know instead.
 *
 * ── THE OPTIONS ──────────────────────────────────────────────────────────────
 * An option renders only when it has a handler that does what it says. The
 * Trusted Circle, location, host and crew options used to render and do
 * nothing when no callback was passed (every mount); "Share your location"
 * opened bare Maps and shared nothing.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet, Linking, ScrollView, ActivityIndicator,
} from 'react-native';
import { X, Phone, MessageCircle, MapPin, Map as MapIcon, Users, Shield } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import { getCountryEssentials, getTripEssentials, type CountryEssentials } from '../../services/countryEssentials.ts';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** The trip whose destination countries supply the emergency numbers. */
  tripId?: string | null;
  /** ISO2 country that wins over the trip's (e.g. a layover's airport country). */
  countryCode?: string | null;
  onMessageTrustedCircle?: () => void;
  onShareLocation?: () => void;
  onContactHost?: () => void;
  onContactTripCrew?: () => void;
}

type ServiceKey = keyof CountryEssentials['emergency'];
const SERVICE_ORDER: ServiceKey[] = ['all', 'police', 'ambulance', 'fire'];
const SERVICE_LABEL: Record<ServiceKey, string> = { all: 'emergency', police: 'police', ambulance: 'ambulance', fire: 'fire' };
/** Only plain short digit strings are dialled — anything else from the data is treated as unknown. */
const DIALLABLE = /^[0-9]{2,6}$/;

export interface DialNumber { number: string; reaches: string[] }
export interface CountryNumbers { country: string; numbers: DialNumber[]; disclaimer: string }

/** One country's numbers, grouped by the number dialled ("119 — ambulance, fire"). */
export function dialNumbersFor(e: CountryEssentials): DialNumber[] {
  const byNumber = new Map<string, string[]>();
  for (const k of SERVICE_ORDER) {
    const n = e.emergency?.[k];
    if (typeof n !== 'string' || !DIALLABLE.test(n)) continue;
    byNumber.set(n, [...(byNumber.get(n) ?? []), SERVICE_LABEL[k]]);
  }
  return [...byNumber.entries()].map(([number, reaches]) => ({ number, reaches }));
}

type NumbersState = { state: 'loading' } | { state: 'known'; countries: CountryNumbers[] } | { state: 'unknown' };

async function loadNumbers(countryCode: string | null | undefined, tripId: string | null | undefined): Promise<NumbersState> {
  let list: CountryEssentials[] = [];
  if (countryCode) {
    const one = await getCountryEssentials(countryCode);
    list = one ? [one] : [];
  } else if (tripId) {
    const items = await getTripEssentials(tripId);
    list = (items ?? []).map((i) => i.essentials).filter((e): e is CountryEssentials => e !== null);
  }
  const countries = list
    .map((e) => ({ country: e.code, numbers: dialNumbersFor(e), disclaimer: e.disclaimer }))
    .filter((c) => c.numbers.length > 0);
  return countries.length > 0 ? { state: 'known', countries } : { state: 'unknown' };
}

interface HandlerOption {
  id: string;
  icon: typeof Phone;
  label: string;
  sub: string;
  color: string;
  bg: string;
  onPress: (() => void) | undefined;
}

export function EmergencyHelpSheet({ visible, onClose, tripId, countryCode, onMessageTrustedCircle, onShareLocation, onContactHost, onContactTripCrew }: Props) {
  const [numbers, setNumbers] = useState<NumbersState>({ state: 'loading' });

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setNumbers({ state: 'loading' });
    loadNumbers(countryCode, tripId)
      .then((r) => { if (live) setNumbers(r); })
      .catch(() => { if (live) setNumbers({ state: 'unknown' }); });
    return () => { live = false; };
  }, [visible, countryCode, tripId]);

  const options: HandlerOption[] = [
    { id: 'message_tc', icon: MessageCircle, label: 'Message Trusted Circle', sub: 'Opens your messages.', color: color.deep, bg: '#EAF2F4', onPress: onMessageTrustedCircle },
    { id: 'share_location', icon: MapPin, label: 'Share your location', sub: 'Shares your approximate area with a Safe Return contact.', color: '#7A4DBF', bg: '#F0EBF9', onPress: onShareLocation },
    { id: 'open_maps', icon: MapIcon, label: 'Open Maps', sub: 'Opens Google Maps.', color: '#2D7D46', bg: '#E6F4EA', onPress: () => { Linking.openURL('https://maps.google.com').catch(() => {}); } },
    { id: 'contact_host', icon: Users, label: 'Contact trip host', sub: 'Message your trip host.', color: '#8B6914', bg: '#FBF5E6', onPress: onContactHost },
    { id: 'contact_crew', icon: Users, label: 'Contact trip crew', sub: 'Reach out to your fellow travellers.', color: '#1A6B5C', bg: '#E4F2EF', onPress: onContactTripCrew },
  ];
  const usable = options.filter((o) => typeof o.onPress === 'function');
  const multiCountry = numbers.state === 'known' && numbers.countries.length > 1;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Shield size={20} color={color.signal} />
              <Text style={styles.title}>Emergency Help</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={12}><X size={22} color={color.mute} /></Pressable>
          </View>

          <Text style={styles.sub}>
            You're in control. Nothing happens automatically — every action below requires your tap.
          </Text>

          <ScrollView showsVerticalScrollIndicator={false}>
            {numbers.state === 'loading' && (
              <View style={[styles.option, styles.callBox]} testID="emergency-number-loading">
                <ActivityIndicator color={color.signal} />
                <Text style={styles.optionSub}>Looking up the local emergency number…</Text>
              </View>
            )}

            {numbers.state === 'unknown' && (
              <View style={[styles.option, styles.callBox]} testID="emergency-number-unknown">
                <View style={[styles.optionIcon, { backgroundColor: color.signal + '20' }]}>
                  <Phone size={20} color={color.signal} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.optionLabel, { color: color.signal }]}>We don't have the emergency number for where you are</Text>
                  <Text style={styles.optionSub}>Ask local staff, or use your phone's Emergency SOS.</Text>
                </View>
              </View>
            )}

            {numbers.state === 'known' && numbers.countries.map((c) => (
              <View key={c.country} testID={`emergency-numbers-${c.country}`}>
                {multiCountry && <Text style={styles.countryLabel}>{c.country}</Text>}
                {c.numbers.map((n) => (
                  <Pressable
                    key={n.number}
                    style={[styles.option, styles.callBox]}
                    onPress={() => { Linking.openURL(`tel:${n.number}`).catch(() => {}); }}
                    accessibilityRole="button"
                  >
                    <View style={[styles.optionIcon, { backgroundColor: color.signal + '20' }]}>
                      <Phone size={20} color={color.signal} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.optionLabel, { color: color.signal }]}>{`Call ${n.number} — ${n.reaches.join(', ')}`}</Text>
                      <Text style={styles.optionSub}>Opens your dialer — you make the call.</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ))}
            {numbers.state === 'known' && (
              <Text style={styles.disclaimer}>{numbers.countries[0]!.disclaimer}</Text>
            )}

            {usable.map((opt) => {
              const Icon = opt.icon;
              return (
                <Pressable
                  key={opt.id}
                  style={[styles.option, { backgroundColor: opt.bg, borderColor: opt.color + '40' }]}
                  onPress={opt.onPress}
                  accessibilityRole="button"
                >
                  <View style={[styles.optionIcon, { backgroundColor: opt.color + '20' }]}>
                    <Icon size={20} color={opt.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.optionLabel, { color: opt.color }]}>{opt.label}</Text>
                    <Text style={styles.optionSub}>{opt.sub}</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          <Pressable style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>I'm okay — close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: space.xl, paddingBottom: 40, maxHeight: '85%',
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: space.md,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 17 },
  sub: { ...t.small, color: color.mute, fontSize: 12, lineHeight: 18, marginBottom: space.lg },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    borderRadius: radius.md, borderWidth: 1, padding: space.md, marginBottom: space.sm,
  },
  optionIcon: { width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2, alignItems: 'center', justifyContent: 'center' },
  optionLabel: { ...t.bodyStrong, fontSize: 14 },
  optionSub: { ...t.small, color: color.mute, fontSize: 11 },
  callBox: { backgroundColor: '#FFF0EE', borderColor: color.signal + '40' },
  countryLabel: { ...t.small, color: color.ink, fontWeight: '600', marginBottom: space.xs, marginTop: space.xs },
  disclaimer: { ...t.small, color: color.mute, fontSize: 11, marginBottom: space.md },
  closeBtn: {
    backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md,
    alignItems: 'center', marginTop: space.md, borderWidth: 1, borderColor: color.haze,
  },
  closeBtnText: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
});
