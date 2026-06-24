import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, space, type as t } from '../../../src/theme/tokens';

export default function BuddyPackages() {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>BUDDY DASHBOARD</Text>
      <Text style={styles.title}>My Packages</Text>
      <Text style={styles.sub}>Manage your packages — coming soon.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  label: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 2 },
  title: { ...t.title, fontSize: 26, color: color.ink, textAlign: 'center' },
  sub: { ...t.body, color: color.mute, textAlign: 'center' },
});
