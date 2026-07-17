/**
 * ManualCityPicker — DEPRECATED thin wrapper around GlobalPlacePicker.
 *
 * Kept for backward compatibility with existing call sites (discovery, home
 * tab, profile identity, onboarding, LocationStatusPill). It now delegates
 * to the universal location picker in city mode, so these surfaces get live
 * search, Popular-on-Portava, recents, and canonical location resolution
 * for free — and no longer save raw text-only cities.
 *
 * New code should use GlobalPlacePicker directly.
 */
import React from 'react';
import { useLocationContext } from '../context/LocationContext.tsx';
import { GlobalPlacePicker } from './selectors/GlobalPlacePicker.tsx';
import type { Place } from '../lib/location/placeTypes.ts';

interface Props {
  /** When provided, replaces the context's showCityPicker flag (standalone use). */
  visible?: boolean;
  onClose?: () => void;
  /** Called with a canonical Place on selection. */
  onSelect?: (place: Place) => void;
}

export function ManualCityPicker({ visible, onClose, onSelect }: Props) {
  const ctx = useLocationContext();
  const isVisible = visible ?? ctx.showCityPicker;
  const handleClose = onClose ?? ctx.closeCityPicker;

  const handleSelect = (place: Place) => {
    if (onSelect) {
      onSelect(place);
    } else {
      void ctx.setManualCity(place);
    }
  };

  return (
    <GlobalPlacePicker
      visible={isVisible}
      onClose={handleClose}
      onSelect={handleSelect}
      mode="city"
      title="Choose a City"
      usedFor="city_select"
    />
  );
}
