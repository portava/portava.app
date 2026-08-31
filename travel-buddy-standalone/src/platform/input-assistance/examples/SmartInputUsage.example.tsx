/**
 * NON-PRODUCTION usage example (spec §52, §53).
 *
 * Demonstrates the intended consumption pattern for the Phase-1 SDK spine:
 *   1. register the field's policy once,
 *   2. render a SmartInput bound to that fieldId,
 *   3. handle the accepted suggestion.
 *
 * This file is intentionally NOT imported by any screen — it is documentation
 * that also typechecks against the real API, so the example can't rot. Delete or
 * relocate into a story harness once one exists. Do NOT wire this into a route.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import {
  SmartInput,
  registerField,
  type InputSuggestion,
} from '../index.ts';

// Register once at module load. In a real screen this lives near the screen's
// other module-level setup (or a central registry-bootstrap module).
registerField('example.trip.destination', 'trip_destination');

export function SmartInputUsageExample() {
  const [value, setValue] = useState('');

  const handleSelect = (s: InputSuggestion) => {
    // A canonical_picker field resolves to a canonical entity; the caller stores
    // the entityId (+ prefill fields) rather than the raw string (§11, §17).
    // Here we just echo the label into the field.
    if (s.entityId) {
      // e.g. persist s.entityType / s.entityId, prefetch dependent fields…
    }
    setValue(s.label);
  };

  return (
    <View>
      <SmartInput
        fieldId="example.trip.destination"
        context="trip_destination"
        value={value}
        onChangeText={setValue}
        label="Trip destination"
        placeholder="Where to?"
        onSelectSuggestion={handleSelect}
      />
    </View>
  );
}
