/**
 * Telegraph §16.2 — the data-saver control a person can actually reach.
 *
 * §16.2: "Data-saver mode prioritizes text/status/coordinates over media/AI."
 * census-telegraph T227: "No data-saver setting exists in the client."
 *
 * A SETTING NOBODY CAN SEE IS THE SAME AS NO SETTING
 * ==================================================
 * The hook (`useDataSaver`) is the policy and the ladder; this is the row that
 * makes it a feature. It is deliberately a small, self-contained component
 * rather than a screen, so it can sit in the thread's own settings sheet — the
 * place a person is when they notice their data disappearing — instead of six
 * taps away under a menu they would have to already know about.
 *
 * THE COPY NAMES WHAT IS KEPT, NOT ONLY WHAT IS LOST
 * =================================================
 * §17.4's whole point is the ORDER: text and safety coordination survive. A
 * toggle that said only "saves data" would leave a traveller wondering whether
 * turning it on means they stop receiving a safety message — which is exactly
 * the doubt that makes people leave it off in the place it matters most.
 */
import React from 'react';
import { View, Text, Switch, StyleSheet } from 'react-native';

import { color, space, typography } from '../../../theme/tokens.ts';
import { useDataSaver } from '../hooks/useDataSaver.ts';

export interface DataSaverRowProps {
  /** Injected in tests; omitted in app code so the row owns its own state. */
  state?: ReturnType<typeof useDataSaver>;
}

export function DataSaverRow({ state }: DataSaverRowProps) {
  // A hook cannot be called conditionally, so the internal one always runs and
  // the injected one wins when present. That costs one AsyncStorage read in a
  // test and keeps the rule of hooks intact.
  const own = useDataSaver();
  const ds = state ?? own;

  return (
    <View testID="data-saver-row" style={s.row}>
      <View style={s.meta}>
        <Text style={s.label}>Data saver</Text>
        <Text style={s.hint}>
          Holds back photos, videos and AI suggestions until you ask for them.
          Messages, status and safety alerts always come through.
        </Text>
      </View>
      <Switch
        testID="data-saver-switch"
        accessibilityLabel="Data saver"
        value={ds.level === 'on'}
        disabled={ds.loading}
        onValueChange={(next) => { void ds.setLevel(next ? 'on' : 'off'); }}
        trackColor={{ false: color.haze, true: color.signal }}
        thumbColor={color.paperRaised}
        ios_backgroundColor={color.haze}
      />
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingVertical: space.md,
  },
  meta: { flex: 1, gap: 2 },
  label: { ...(typography.cardTitle as object), color: color.ink },
  hint: { ...(typography.caption as object), color: color.mute },
});

export default DataSaverRow;
