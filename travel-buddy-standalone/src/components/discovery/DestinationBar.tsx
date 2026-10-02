import React, { useState } from 'react';
import { Text, Pressable, StyleSheet } from 'react-native';
import { MapPin, ChevronDown } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { GlobalPlacePicker } from '../selectors/GlobalPlacePicker.tsx';
import { GEO_FIELD_IDS } from '../../platform/input-assistance/geographic/geoFields.ts';
import type { Place } from '../../lib/location/placeTypes.ts';

interface DestinationBarProps {
  destination: string | null;
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

      {/* §14/§35 (G85) — THIS IS THE CITY PICKER. It is titled "Search
          destination" and prompts for "City, island or region", it is the
          Discovery surface a traveller uses to choose where they are looking,
          and until now it declared NO assist context at all: `GlobalPlacePicker`
          fell back to the `__geo_no_assist__` fieldId, so the platform was off
          for it entirely and `city_picker` was a registered context that no
          screen in the app ever mounted.

          Declaring it wires three things that already existed and had no host:
          the `city_picker` policy (`allowPersonalization: true`,
          `zeroStateAssistance: true`, `minChars: 1`), the selection recorder
          `GlobalPlacePicker` already calls on select, and the zero-character
          recents that read back per (user, context). Nothing new is built here —
          the surface simply stops being anonymous to the platform. */}
      <GlobalPlacePicker
        visible={pickerVisible}
        title="Search destination"
        placeholder="City, island or region…"
        allowGPS={false}
        usedFor="discovery_destination"
        assistContext="city_picker"
        assistFieldId={GEO_FIELD_IDS.cityPicker}
        sessionContext={{ surface: 'discovery_destination' }}
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
