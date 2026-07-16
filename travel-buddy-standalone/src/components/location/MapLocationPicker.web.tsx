/**
 * MapLocationPicker — web stub.
 * MapLibre requires a native runtime; this stub keeps Metro happy on web.
 * The map-pick flow is native-only.
 */
import React from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import type { MapLocationPickerProps } from './MapLocationPicker';

export function MapLocationPicker({ visible, onCancel }: MapLocationPickerProps) {
  return (
    <Modal visible={visible} animationType="slide">
      <View style={s.root}>
        <Text style={s.msg}>Map location picker is only available on iOS and Android.</Text>
        <TouchableOpacity style={s.btn} onPress={onCancel}>
          <Text style={s.btnText}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A1628', gap: 20, padding: 24 },
  msg:  { color: '#8A9BB5', fontSize: 15, textAlign: 'center', lineHeight: 22 },
  btn:  { backgroundColor: '#4C8BF5', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
