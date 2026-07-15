import React, { useState } from 'react';
import { Text, Pressable, StyleSheet } from 'react-native';
import { MapPin, ChevronDown } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens';
import { GlobalPlacePicker } from '../selectors/GlobalPlacePicker';
import type { Place } from '../../lib/location/placeTypes';

interface DestinationBarProps {
  destination: string;
  onSelectPlace: (place: Place) => void;
}

export function DestinationBar({ destination, onSelectPlace }: DestinationBarProps) {
  const [pickerVisible, setPickerVisible] = useState(false);

  return (
    <>
      <Pressable style={styles.bar} onPress={() => setPickerVisible(true)}>
        <MapPin size={14} color={color.signal} />
        <Text style={styles.dest} numberOfLines={1}>
          {destination || 'Pick a destination'}
        </Text>
        <ChevronDown size={14} color={color.mute} />
      </Pressable>

      <GlobalPlacePicker
        visible={pickerVisible}
        title="Search destination"
        placeholder="City, island or region…"
        allowGPS={false}
        usedFor="discovery_destination"
        onSelect={(place) => {
          setPickerVisible(false);
          onSelectPlace(place);
        }}
        onClose={() => setPickerVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    backgroundColor: color.haze,
    borderRadius: radius.pill,
    flexShrink: 1,
    maxWidth: 200,
  },
  dest: {
    ...t.small,
    color: color.ink,
    fontWeight: '600',
    fontSize: 13,
    flex: 1,
  },
});

export default DestinationBar;
