/**
 * LocationPermissionPrompt — bottom-sheet shown when location is needed
 * but not yet granted. Non-blocking: the user can dismiss or choose a city.
 */
import React from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet,
} from 'react-native';
import { MapPin, Navigation, X } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../theme/tokens.ts';
import { useLocationContext } from '../context/LocationContext.tsx';

export function LocationPermissionPrompt() {
  const {
    showPermissionPrompt,
    locationState,
    requestLocation,
    dismissPermissionPrompt,
    openCityPicker,
    isLoading,
  } = useLocationContext();

  if (!showPermissionPrompt) return null;

  const isDenied = locationState.permissionStatus === 'denied';

  return (
    <Modal
      visible={showPermissionPrompt}
      transparent
      animationType="slide"
      onRequestClose={dismissPermissionPrompt}
    >
      <Pressable style={s.overlay} onPress={dismissPermissionPrompt}>
        <Pressable style={s.sheet} onPress={(e) => e.stopPropagation()}>
          {/* Close */}
          <Pressable style={s.closeBtn} onPress={dismissPermissionPrompt} hitSlop={12}>
            <X size={18} color={color.mute} />
          </Pressable>

          {/* Icon */}
          <View style={s.iconWrap}>
            <MapPin size={28} color={color.signal} />
          </View>

          {/* Heading */}
          <Text style={s.heading}>
            {isDenied ? 'Location is off' : 'Turn on location'}
          </Text>
          <Text style={s.body}>
            {isDenied
              ? 'You can still use Portava by choosing a city manually.'
              : 'Unlock nearby travelers, stamps, postcards, and local discovery.'}
          </Text>

          {/* Buttons */}
          <View style={s.actions}>
            {!isDenied && (
              <Pressable
                style={[s.btn, s.btnPrimary, isLoading && s.btnDisabled]}
                onPress={requestLocation}
                disabled={isLoading}
              >
                <Navigation size={16} color="#fff" />
                <Text style={s.btnPrimaryText}>
                  {isLoading ? 'Detecting…' : 'Enable Location'}
                </Text>
              </Pressable>
            )}

            <Pressable style={[s.btn, s.btnOutline]} onPress={openCityPicker}>
              <MapPin size={16} color={color.ink} />
              <Text style={s.btnOutlineText}>Choose City Manually</Text>
            </Pressable>

            <Pressable style={s.notNow} onPress={dismissPermissionPrompt}>
              <Text style={s.notNowText}>Not Now</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(17,17,15,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.xl,
    paddingBottom: space.xl + 16,
    alignItems: 'center',
    gap: space.sm,
  },
  closeBtn: {
    position: 'absolute',
    top: space.md,
    right: space.md,
    padding: space.sm,
  },
  iconWrap: {
    width: avatar.s56, height: avatar.s56,
    borderRadius: avatar.s56 / 2,
    backgroundColor: '#FFF0EC',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  heading: {
    ...t.title,
    color: color.ink,
    textAlign: 'center',
  },
  body: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
    marginBottom: space.sm,
  },
  actions: {
    width: '100%',
    gap: space.sm,
    marginTop: space.xs,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: 48,
    borderRadius: radius.md,
  },
  btnPrimary: {
    backgroundColor: color.signal,
  },
  btnPrimaryText: {
    ...t.body,
    color: '#fff',
    fontWeight: '600',
  },
  btnOutline: {
    borderWidth: 1.5,
    borderColor: color.haze,
  },
  btnOutlineText: {
    ...t.body,
    color: color.ink,
    fontWeight: '500',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  notNow: {
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  notNowText: {
    ...t.small,
    color: color.faint,
  },
});
