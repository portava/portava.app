import React, { useState, useRef } from 'react';
import {
  View, Text, ScrollView, TextInput, StyleSheet, Pressable, Alert, ActivityIndicator,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Send, Plus, X } from 'lucide-react-native';
import { TravelButton, TravelCard, TravelChip } from '../../../src/components/primitives';
import { KeyboardSafeView } from '../../../src/components/ui/KeyboardSafeView';
import { DatePickerField } from '../../../src/components/DatePickerField';
import { DatePickerField as TimePickerField } from '../../../src/components/DateTimePickerField';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import * as rentABuddy from '../../../src/services/rentABuddy';
import type { BuddyCategory } from '../../../src/services/rentABuddy';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

const CATEGORIES: { value: BuddyCategory; label: string }[] = [
  { value: 'arrival', label: 'Arrival Support' },
  { value: 'city', label: 'City Tour' },
  { value: 'nightlife', label: 'Nightlife' },
  { value: 'food', label: 'Food & Markets' },
  { value: 'content', label: 'Content & Photo' },
  { value: 'nature', label: 'Nature & Adventure' },
  { value: 'culture', label: 'Culture & Arts' },
  { value: 'shopping', label: 'Shopping' },
];

const INCLUDED_PRESETS = [
  'Airport pickup', 'City orientation', 'SIM card help', 'Local food stops',
  'Temple visit', 'Night market', 'Street art walk', 'Translation support',
  'Photo spots', 'Local transport navigation',
];

function FieldLabel({ label, optional }: { label: string; optional?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.xs }}>
      <Text style={fl.label}>{label}</Text>
      {optional && <Text style={fl.opt}>(optional)</Text>}
    </View>
  );
}

export default function BuddyOffer() {
  const insets = useSafeAreaInsets();
  const { requestId } = useLocalSearchParams<{ requestId?: string }>();
  const [category, setCategory] = useState<BuddyCategory | null>(null);
  const [price, setPrice] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [location, setLocation] = useState('');
  const [message, setMessage] = useState('');
  const [included, setIncluded] = useState<string[]>([]);
  const [customIncluded, setCustomIncluded] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const sendLockRef = useRef(false);

  function toggleIncluded(item: string) {
    setIncluded((prev) => prev.includes(item) ? prev.filter((i) => i !== item) : [...prev, item]);
  }

  function addCustom() {
    const v = customIncluded.trim();
    if (v && !included.includes(v)) {
      setIncluded((prev) => [...prev, v]);
    }
    setCustomIncluded('');
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!category) errs.category = 'Select a category';
    if (!price.trim() || isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
      errs.price = 'Enter a valid price';
    }
    if (!date.trim()) errs.date = 'Enter a proposed date';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function canSend() {
    return category != null && price.trim().length > 0 && parseFloat(price) > 0 && date.trim().length > 0;
  }

  async function handleSend() {
    if (!validate() || !category) return;
    if (!requestId) {
      Alert.alert(
        'No request selected',
        'Offers are sent in response to a traveller request. Open a request from your Requests Inbox first.',
      );
      return;
    }
    if (sendLockRef.current) return;
    sendLockRef.current = true;
    setSending(true);
    try {
      const res = await rentABuddy.createBuddyOffer(requestId, {
        priceUsd: parseFloat(price),
        proposedDate: date.trim(),
        proposedTime: time.trim() || undefined,
        meetupLocation: location.trim() || undefined,
        includedServices: included,
        message: message.trim() || undefined,
      });
      if (res.ok) {
        setSent(true);
      } else {
        Alert.alert('Could not send offer', bookingErrorCopy(res.error, 'Please try again.'));
      }
    } finally {
      sendLockRef.current = false;
      setSending(false);
    }
  }

  if (sent) {
    return (
      <View style={[done.wrap, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Text style={done.emoji}>📨</Text>
        <Text style={done.title}>Offer sent!</Text>
        <Text style={done.sub}>
          The traveller has been notified of your offer.
          You'll see their response in Booking Requests.
        </Text>
        <TravelButton label="Back to dashboard" onPress={() => router.back()} variant="primary" full />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Pressable onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <ArrowLeft size={20} color={color.onInk} />
        </Pressable>
        <Text style={s.headerTitle}>Create Offer</Text>
      </View>

      <KeyboardSafeView
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + 120 }}
      >
        <Text style={s.intro}>
          Send a custom offer in response to a traveller enquiry.
          Set your price, date, and what's included.
        </Text>

        {/* Category */}
        <FieldLabel label="Category" />
        {errors.category ? <Text style={s.err}>{errors.category}</Text> : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.lg }}>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            {CATEGORIES.map((c) => (
              <TravelChip
                key={c.value}
                label={c.label}
                active={category === c.value}
                onPress={() => {
                  setCategory(c.value);
                  setErrors((e) => ({ ...e, category: '' }));
                }}
              />
            ))}
          </View>
        </ScrollView>

        {/* Price */}
        <FieldLabel label="Proposed price (USD)" />
        {errors.price ? <Text style={s.err}>{errors.price}</Text> : null}
        <TextInput
          style={[fi.input, { marginBottom: space.lg }, errors.price ? fi.inputError : undefined]}
          value={price}
          onChangeText={(v) => { setPrice(v); setErrors((e) => ({ ...e, price: '' })); }}
          placeholder="e.g. 75"
          placeholderTextColor={color.haze}
          keyboardType="numeric"
        />

        {/* Date + time */}
        <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
          <View style={{ flex: 1 }}>
            <FieldLabel label="Proposed date" />
            {errors.date ? <Text style={s.err}>{errors.date}</Text> : null}
            <DatePickerField
              value={date}
              onChange={(v) => { setDate(v); setErrors((e) => ({ ...e, date: '' })); }}
              placeholder="Select date"
              style={errors.date ? fi.inputError : undefined}
            />
          </View>
          <View style={{ flex: 1 }}>
            <FieldLabel label="Start time" optional />
            <TimePickerField
              mode="time"
              value={time ? new Date(`1970-01-01T${time.length === 5 ? time : time.slice(0, 5)}:00`) : null}
              onChange={(d) => setTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)}
              onClear={() => setTime('')}
              placeholder="Select time"
            />
          </View>
        </View>

        {/* Meetup location */}
        <FieldLabel label="Meetup location" optional />
        <TextInput
          style={[fi.input, { marginBottom: space.lg }]}
          value={location}
          onChangeText={setLocation}
          placeholder="e.g. Suvarnabhumi Airport arrivals, Gate 3"
          placeholderTextColor={color.haze}
        />

        {/* Included services */}
        <FieldLabel label="What's included" optional />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.sm }}>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            {INCLUDED_PRESETS.map((item) => (
              <TravelChip
                key={item}
                label={item}
                active={included.includes(item)}
                onPress={() => toggleIncluded(item)}
              />
            ))}
          </View>
        </ScrollView>
        <View style={custom.row}>
          <TextInput
            style={[fi.input, { flex: 1 }]}
            value={customIncluded}
            onChangeText={setCustomIncluded}
            placeholder="Add custom item…"
            placeholderTextColor={color.haze}
            onSubmitEditing={addCustom}
          />
          <Pressable style={custom.addBtn} onPress={addCustom}>
            <Plus size={16} color={color.onInk} />
          </Pressable>
        </View>
        {included.length > 0 && (
          <View style={custom.chips}>
            {included.map((i) => (
              <View key={i} style={custom.chip}>
                <Text style={custom.chipText}>{i}</Text>
                <Pressable
                  onPress={() => setIncluded((prev) => prev.filter((x) => x !== i))}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  <X size={12} color={color.mute} />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* Message */}
        <FieldLabel label="Message to traveller" optional />
        <TextInput
          style={[fi.input, fi.multiline, { marginBottom: space.lg }]}
          value={message}
          onChangeText={setMessage}
          placeholder="Add a personal note about this offer…"
          placeholderTextColor={color.haze}
          multiline
        />

        <TravelCard style={{ padding: space.md, marginBottom: space.lg }}>
          <Text style={s.disclaimerTitle}>Estimated only</Text>
          <Text style={s.disclaimerBody}>
            All prices are estimates. Payouts are not yet connected.
            This offer is subject to traveller acceptance.
          </Text>
        </TravelCard>
      </KeyboardSafeView>

      <View style={[s.footer, { paddingBottom: insets.bottom + space.md }]}>
        <TravelButton
          label={sending ? 'Sending…' : 'Send offer'}
          onPress={handleSend}
          variant={canSend() ? 'primary' : 'ghost'}
          full
          icon={sending
            ? <ActivityIndicator size="small" color={color.onInk} />
            : <Send size={14} color={canSend() ? color.onInk : color.mute} />}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    backgroundColor: color.ink, flexDirection: 'row',
    alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.lg,
  },
  headerTitle: { ...t.heading, color: color.onInk, flex: 1 },
  intro: { ...t.body, color: color.mute, marginBottom: space.xl, lineHeight: 22 },
  footer: {
    paddingHorizontal: space.lg, paddingTop: space.md,
    borderTopWidth: 1, borderTopColor: color.haze,
    backgroundColor: color.paper,
  },
  disclaimerTitle: { ...t.bodyStrong, color: color.ink, marginBottom: 4 },
  disclaimerBody: { ...t.small, color: color.mute, lineHeight: 17 },
  err: { ...t.small, color: color.signal, marginBottom: space.xs },
});

const fi = StyleSheet.create({
  input: {
    borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.md,
    ...t.body, color: color.ink, backgroundColor: color.paperRaised,
  },
  inputError: { borderColor: color.signal },
  multiline: { height: 100, textAlignVertical: 'top' },
});

const fl = StyleSheet.create({
  label: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  opt: { ...t.small, color: color.haze },
});

const custom = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm, marginBottom: space.sm },
  addBtn: {
    width: 48, borderRadius: radius.md, backgroundColor: color.signal,
    alignItems: 'center', justifyContent: 'center',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: space.md, paddingVertical: space.xs,
    backgroundColor: color.paperRaised, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze,
  },
  chipText: { ...t.small, color: color.ink, fontWeight: '600' },
});

const done = StyleSheet.create({
  wrap: {
    flex: 1, backgroundColor: color.paper,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.lg,
  },
  emoji: { fontSize: 48 },
  title: { ...t.heading, color: color.ink, textAlign: 'center' },
  sub: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },
});
