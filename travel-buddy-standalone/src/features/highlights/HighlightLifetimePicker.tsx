/**
 * HighlightLifetimePicker — §4's five lifetimes, offered at creation.
 *
 * Highlights/Memories Development Architecture Spec v1 §4 and §12.
 * Census H94–H98.
 *
 * ── THREE THINGS IT REFUSES TO DO ──────────────────────────────────────────
 *
 * 1. IT DOES NOT TYPE THE CLASSES INTO THE CLIENT. The five, their §12
 *    examples and §12's own sentence about what each one does all arrive from
 *    the server. A retyped list drifts from the spec silently and — the part
 *    that bites — offers PERMANENT on a deployment that cannot store it.
 *
 * 2. IT DOES NOT PRESELECT ONE. "No class" is a real state: the server writes
 *    no class when none is named, because nothing in §12 assigns hour
 *    boundaries to the classes and a default would be invented product policy
 *    wearing the spec's vocabulary. Preselecting DAY here would put that
 *    invention back one layer up.
 *
 * 3. IT DOES NOT HIDE WHAT IT CANNOT PROMISE. PERMANENT needs a nullable
 *    `expires_at` (migration 2975) and nullability is not probeable, so the
 *    server marks it `mayNotBeStorable` and this renders that. Offering it
 *    silently would produce a save that fails; hiding it would remove a choice
 *    that works on deployments where the migration HAS run.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  fetchLifetimeClasses,
  type LifetimeClassesView,
  type HighlightLifetimeClass,
} from './lifetimeApi.ts';

interface Props {
  value: HighlightLifetimeClass | null;
  onChange: (cls: HighlightLifetimeClass | null) => void;
  /** Injectable for tests; defaults to the real client. */
  load?: typeof fetchLifetimeClasses;
}

export function HighlightLifetimePicker({ value, onChange, load = fetchLifetimeClasses }: Props) {
  const [view, setView] = useState<LifetimeClassesView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    let alive = true;
    void load().then((r) => {
      if (!alive) return;
      if (r.ok && r.data.deployed) { setView(r.data); setState('ready'); }
      else { setView(null); setState('unavailable'); }
    });
    return () => { alive = false; };
  }, [load]);

  // A deployment without migration 2723 cannot hold ANY class. Rendering
  // nothing is right here — this is an optional refinement on a create form,
  // not a failure worth interrupting somebody's post for.
  if (state === 'unavailable') return null;
  if (state === 'loading') {
    return <View style={s.field} testID="highlight-lifetime-loading"><ActivityIndicator size="small" color={color.signal} /></View>;
  }

  return (
    <View style={s.field} testID="highlight-lifetime-picker">
      <Text style={s.label}>Kind of highlight</Text>
      <View style={s.chipRow}>
        {(view?.classes ?? []).map((opt) => {
          const on = value === opt.cls;
          return (
            <Pressable
              key={opt.cls}
              // Pressing the selected one CLEARS it. "No class" has to be
              // reachable, or the first tap is irreversible.
              onPress={() => onChange(on ? null : opt.cls)}
              style={[s.chip, on && s.chipOn]}
              testID={`highlight-lifetime-${opt.cls}${on ? '-on' : '-off'}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={opt.example}
            >
              <Text style={[s.chipText, on && s.chipTextOn]}>{opt.example}</Text>
            </Pressable>
          );
        })}
      </View>
      {value && (
        <Text style={s.note} testID="highlight-lifetime-note">
          {view?.classes.find((c) => c.cls === value)?.defaultBehavior}
        </Text>
      )}
      {value && view?.classes.find((c) => c.cls === value)?.mayNotBeStorable && (
        <Text style={s.warn} testID="highlight-lifetime-warning">
          Permanent highlights aren’t available everywhere yet — if this version can’t keep it
          forever, we’ll tell you instead of saving it with an expiry.
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  field: { gap: space.xs, marginBottom: space.md },
  label: { ...t.small, color: color.mute },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    paddingHorizontal: space.md, paddingVertical: space.xs,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
  },
  chipOn: { backgroundColor: color.signal, borderColor: color.signal },
  chipText: { ...t.small, color: color.ink, fontSize: 12 },
  chipTextOn: { color: color.paper },
  note: { ...t.small, color: color.faint, fontSize: 11 },
  warn: { ...t.small, color: color.mute, fontSize: 11 },
});
