/**
 * GemLocationPreview — web fallback for the gem review step.
 *
 * MapLibre native modules are unavailable on web, so this stub renders a
 * simple placeholder instead of the interactive map thumbnail.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export interface GemLocationPreviewProps {
  lat: number;
  lng: number;
}

export function GemLocationPreview({ lat, lng }: GemLocationPreviewProps) {
  return (
    <View style={styles.container}>
      <Ionicons name="map-outline" size={32} color="#2A3D5E" />
      <Text style={styles.coords}>
        {lat.toFixed(5)}, {lng.toFixed(5)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 160,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1E2D45',
    backgroundColor: '#13213A',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  coords: {
    color: '#8A9BB5',
    fontSize: 12,
    fontFamily: 'monospace',
  },
});
