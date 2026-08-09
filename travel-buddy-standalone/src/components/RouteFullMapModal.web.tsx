/**
 * RouteFullMapModal.web.tsx — web-safe stub.
 * react-native-maps uses codegenNativeComponent (TurboModules) which is not
 * available in react-native-web. Metro picks this file over RouteFullMapModal.tsx
 * when bundling for web.
 */
import React from 'react';
import { View, Text, Modal, Pressable, StyleSheet, ScrollView } from 'react-native';
import { MapPin, X } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../theme/tokens.ts';
import type { RouteStop, RouteLeg } from '../services/routePlan.ts';

export interface RouteFullMapModalProps {
  visible: boolean;
  onClose: () => void;
  stops: RouteStop[];
  legs: RouteLeg[];
  userLat?: number | null;
  userLng?: number | null;
}

export function RouteFullMapModal({ visible, onClose, stops }: RouteFullMapModalProps) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={s.root}>
        <View style={s.header}>
          <MapPin size={18} color={color.deep} />
          <Text style={s.title}>Route Map</Text>
          <Pressable onPress={onClose} hitSlop={12} style={s.closeBtn}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        <View style={s.banner}>
          <Text style={s.bannerText}>Full map view is available in the mobile app.</Text>
        </View>

        <ScrollView contentContainerStyle={s.list}>
          {stops.map((stop, idx) => (
            <View key={stop.id} style={s.row}>
              <View style={[
                s.dot,
                stop.checkpointStatus === 'arrived'  && s.dotDone,
                stop.checkpointStatus === 'skipped'  && s.dotSkipped,
                stop.checkpointStatus === 'pending'  && idx === stops.findIndex((s) => s.checkpointStatus === 'pending') && s.dotNext,
              ]}>
                <Text style={s.dotLabel}>{idx + 1}</Text>
              </View>
              <View style={s.rowText}>
                <Text style={s.stopTitle} numberOfLines={1}>{stop.title}</Text>
                {stop.structuredLocation?.address && (
                  <Text style={s.stopCity} numberOfLines={1}>{stop.structuredLocation.address}</Text>
                )}
              </View>
              <Text style={s.status}>
                {stop.checkpointStatus === 'arrived'  ? '✓' :
                 stop.checkpointStatus === 'skipped'  ? '—' : ''}
              </Text>
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root:      { flex: 1, backgroundColor: '#fff' },
  header:    { flexDirection: 'row', alignItems: 'center', gap: 8, padding: space.md, paddingTop: 54, borderBottomWidth: 1, borderBottomColor: color.haze },
  title:     { ...t.title, fontSize: 17, color: color.ink, flex: 1 },
  closeBtn:  { padding: 4 },
  banner:    { backgroundColor: color.haze, margin: space.md, borderRadius: radius.md, padding: space.md },
  bannerText:{ ...t.small, color: color.mute, textAlign: 'center' },
  list:      { padding: space.md, gap: 10 },
  row:       { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, padding: 10, borderWidth: 1, borderColor: color.haze },
  dot:       { width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2, backgroundColor: '#E76F51', alignItems: 'center', justifyContent: 'center' },
  dotDone:   { backgroundColor: '#999' },
  dotSkipped:{ backgroundColor: '#ccc' },
  dotNext:   { backgroundColor: color.deep },
  dotLabel:  { color: '#fff', fontSize: 11, fontWeight: '700' },
  rowText:   { flex: 1, gap: 2 },
  stopTitle: { ...t.body, color: color.ink, fontWeight: '600' },
  stopCity:  { ...t.small, color: color.mute },
  status:    { ...t.small, color: color.mute, width: 16, textAlign: 'center' },
});
