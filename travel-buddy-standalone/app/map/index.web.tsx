/**
 * app/map/index.web.tsx — web-platform stub for the full-screen map route.
 *
 * Metro selects this file when bundling for web, which keeps every byte of
 * @maplibre/maplibre-react-native out of the web bundle entirely.
 * The native implementation lives in app/map/index.tsx.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { MapPin } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens.ts';

export default function FullScreenMapScreenWeb() {
  return (
    <View style={s.root}>
      <View style={s.iconCircle}>
        <MapPin size={28} color={color.faint} />
      </View>
      <Text style={s.title}>Full-screen map is not available in the browser</Text>
      <Text style={s.body}>
        Open the Travel Buddy app on your phone to explore the interactive map.
      </Text>
      <Pressable style={s.backBtn} onPress={() => router.back()}>
        <Text style={s.backBtnText}>Go back</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xxl,
    backgroundColor: color.paper,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  title: {
    ...t.title,
    fontSize: 17,
    color: color.ink,
    textAlign: 'center',
  },
  body: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
    maxWidth: 300,
  },
  backBtn: {
    marginTop: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    backgroundColor: color.signal,
    borderRadius: radius.md,
  },
  backBtnText: {
    ...t.bodyStrong,
    color: '#fff',
  },
});
