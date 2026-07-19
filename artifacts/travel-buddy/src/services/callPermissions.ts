/**
 * Call device permissions — mic and camera checks used before starting or
 * accepting calls (spec §21). Mic is required for any call; a camera denial
 * must never block voice-only calling.
 */
import { Alert, Linking, Platform } from 'react-native';
import { Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';

export interface PermissionOutcome {
  granted: boolean;
  canAskAgain: boolean;
}

export async function requestMicPermission(): Promise<PermissionOutcome> {
  if (Platform.OS === 'web') return { granted: true, canAskAgain: true };
  try {
    const res = await Audio.requestPermissionsAsync();
    return { granted: res.granted, canAskAgain: res.canAskAgain ?? true };
  } catch {
    return { granted: false, canAskAgain: false };
  }
}

export async function requestCameraPermission(): Promise<PermissionOutcome> {
  if (Platform.OS === 'web') return { granted: true, canAskAgain: true };
  try {
    const res = await ImagePicker.requestCameraPermissionsAsync();
    return { granted: res.granted, canAskAgain: res.canAskAgain ?? true };
  } catch {
    return { granted: false, canAskAgain: false };
  }
}

function openSettingsSupported(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

/** Explain a mic denial. Calls cannot proceed without the microphone. */
export function showMicDeniedAlert(): void {
  const buttons: { text: string; onPress?: () => void; style?: 'cancel' }[] = [
    { text: 'OK', style: 'cancel' },
  ];
  if (openSettingsSupported()) {
    buttons.push({ text: 'Open Settings', onPress: () => { Linking.openSettings().catch(() => {}); } });
  }
  Alert.alert(
    'Microphone needed',
    'Calls need microphone access. Enable microphone permission for Portava to make and receive calls.',
    buttons,
  );
}

/**
 * Gate a call attempt on device permissions.
 * Returns null when the call cannot proceed (mic denied), otherwise the
 * call type to use — a camera denial downgrades video to voice with consent.
 */
export async function ensureCallMediaPermissions(
  requested: 'voice' | 'video',
): Promise<'voice' | 'video' | null> {
  const mic = await requestMicPermission();
  if (!mic.granted) {
    showMicDeniedAlert();
    return null;
  }
  if (requested === 'voice') return 'voice';
  const cam = await requestCameraPermission();
  if (cam.granted) return 'video';
  // Camera denied → voice-only is still allowed (spec §21).
  return await new Promise<'voice' | null>((resolve) => {
    Alert.alert(
      'Camera unavailable',
      'Camera permission is off, so video isn\u2019t available. You can still make a voice call.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
        { text: 'Call without video', onPress: () => resolve('voice') },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}
