/**
 * MemoryVisibilityCard — the owner's visibility status for one Memory, and the
 * one setting it adds (census-highlights-memories H33, §12's "visibility"
 * control; server: GET/PUT /api/memories/:id/visibility-policy, migration 3810).
 *
 * Shows, read-only, who can see the Memory and how precisely its place is shown
 * (both are changed where they always were, on the edit screen), and lets the
 * owner cap how the PEOPLE on the Memory are shown to everyone else: from "No
 * limit" down to "Just a count" or "Nobody". You and the people tagged always
 * see their own tags.
 *
 * Renders NOTHING while the server has no such setting (3810 not applied) or
 * for anyone but the owner: offering a control the server refuses is not a
 * feature. A failed read says so; it is never shown as "No limit".
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type as t } from '../../../theme/tokens.ts';
import {
  AUDIENCE_LABELS, CEILING_LABELS, PERSON_CEILINGS, PRECISION_LABELS,
  fetchVisibilityStatus, setPersonCeiling, type PersonCeiling, type VisibilityStatusRead,
} from './memoryVisibilityPolicy.ts';

const OPTIONS: ReadonlyArray<PersonCeiling | null> = [null, ...PERSON_CEILINGS];

function precisionLine(chosen: string, enforcement: 'on' | 'off' | 'unreadable'): string {
  const label = PRECISION_LABELS[chosen] ?? 'Hidden';
  if (enforcement === 'on') return label;
  if (enforcement === 'off') return `${label} (not applied yet: others see the place as recorded)`;
  return `${label} (others see no place until this can be checked)`;
}

export function MemoryVisibilityCard({ memoryId }: { memoryId: string }) {
  const [read, setRead] = useState<VisibilityStatusRead | null>(null);
  const [busy, setBusy] = useState<PersonCeiling | 'NONE' | null>(null);

  const load = useCallback(async () => { setRead(await fetchVisibilityStatus(memoryId)); }, [memoryId]);
  useEffect(() => { void load(); }, [load]);

  const choose = useCallback(async (ceiling: PersonCeiling | null) => {
    if (busy || read?.state !== 'ok' || read.status.personCeiling === ceiling) return;
    setBusy(ceiling ?? 'NONE');
    const res = await setPersonCeiling(memoryId, ceiling);
    setBusy(null);
    if (!res.ok) { Alert.alert('Could not change who sees the people', res.message); return; }
    await load();
  }, [busy, load, memoryId, read]);

  if (read === null || read.state === 'unavailable' || read.state === 'not_found') return null;
  if (read.state === 'error') {
    return (
      <View style={s.wrap} testID="memory-visibility-error">
        <Text style={s.head}>Visibility</Text>
        <Text style={s.caption}>Your visibility settings could not be loaded.</Text>
        <Pressable onPress={() => void load()} accessibilityRole="button" testID="memory-visibility-retry">
          <Text style={s.link}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  const st = read.status;
  const audience = AUDIENCE_LABELS[st.audience.visibility ?? ''] ?? 'Only you';
  const lists = [st.audience.allowedCount ? `${st.audience.allowedCount} added` : '', st.audience.hiddenCount ? `${st.audience.hiddenCount} hidden from` : '']
    .filter(Boolean).join(', ');
  return (
    <View style={s.wrap} testID="memory-visibility-card">
      <Text style={s.head}>Visibility</Text>
      <View style={s.row}>
        <Text style={s.caption}>Who can see this</Text>
        <Text style={s.value} testID="memory-visibility-audience">{lists ? `${audience} (${lists})` : audience}</Text>
      </View>
      <View style={s.row}>
        <Text style={s.caption}>Place shown to others</Text>
        <Text style={s.value} testID="memory-visibility-precision">{precisionLine(st.locationPrecision.chosen, st.locationPrecision.enforcement)}</Text>
      </View>
      <Text style={s.bodyStrong}>People on this memory, as others see them</Text>
      <View style={s.chips} accessibilityRole="radiogroup">
        {OPTIONS.map((o) => {
          const key = o ?? 'NONE';
          const on = st.personCeiling === o;
          return (
            <Pressable
              key={key}
              testID={`memory-visibility-ceiling-${key}`}
              onPress={() => void choose(o)}
              disabled={busy !== null}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, disabled: busy !== null }}
              style={[s.chip, on && s.chipOn, busy !== null && s.dim]}
            >
              {busy === key ? <ActivityIndicator size="small" color={color.ink} /> : <Text style={[s.chipText, on && s.chipTextOn]}>{CEILING_LABELS[key]}</Text>}
            </Pressable>
          );
        })}
      </View>
      <Text style={s.caption}>You and the people tagged always see their own tags.</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: space.md, gap: space.sm },
  head: { ...(t.small as object), color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  caption: { ...(t.small as object), color: color.mute },
  value: { ...(t.small as object), color: color.ink, flexShrink: 1, textAlign: 'right' },
  bodyStrong: { ...(t.bodyStrong as object), color: color.ink, marginTop: space.xs },
  link: { ...(t.small as object), color: color.deep, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.xs, paddingHorizontal: space.sm },
  chipOn: { backgroundColor: color.ink, borderColor: color.ink },
  chipText: { ...(t.small as object), color: color.ink },
  chipTextOn: { color: color.onInk, fontWeight: '700' },
  dim: { opacity: 0.5 },
});
