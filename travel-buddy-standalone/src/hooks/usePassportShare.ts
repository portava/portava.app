/**
 * usePassportShare — captures the PassportShareCard and opens the native share sheet.
 *
 * Share payload:
 *   - title:   "@<username>'s Portava Passport"
 *   - message: human-readable text with deep-link + web fallback URL
 *   - image:   captured JPEG (iOS: via RN Share url field; Android: expo-sharing)
 *
 * Fallback: if image capture or image-share fails, opens text-only share so
 * the deep-link + web fallback URL always reaches the recipient.
 *
 * Deep link:    travelbuddy://passport/@<username>
 * Web fallback: <EXPO_PUBLIC_WEB_ORIGIN>/u/<username>
 *   EXPO_PUBLIC_WEB_ORIGIN is the Expo web-app root (same Replit dev domain),
 *   distinct from EXPO_PUBLIC_API_BASE_URL so intent is unambiguous.
 *   Falls back to EXPO_PUBLIC_API_BASE_URL origin if WEB_ORIGIN is not set.
 *
 * Pure helper functions (makeDeepLink, makeWebFallback, toFileUri) live in
 * src/services/passportShareUtils.ts so they can be tested in Node.js.
 *
 * Uses the built-in RN Share API + expo-sharing (no extra native linking needed).
 */
import { useRef, useState, useCallback } from 'react';
import { View, Share, Platform } from 'react-native';
import * as ExpoSharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';
import { makeDeepLink, makeWebFallback, toFileUri } from '../services/passportShareUtils.ts';

export interface PassportShareState {
  sharing: boolean;
  error: string | null;
}

export function usePassportShare(username: string | null) {
  const cardRef = useRef<View>(null);
  const [state, setState] = useState<PassportShareState>({ sharing: false, error: null });

  const share = useCallback(async () => {
    if (!username) return;

    setState({ sharing: true, error: null });

    const deepLink = makeDeepLink(username);
    const webFallback = makeWebFallback(username);
    const message = [
      `Check out @${username}'s Portava Passport! ✈️`,
      '',
      `Open in app: ${deepLink}`,
      `View online: ${webFallback}`,
    ].join('\n');

    const title = `@${username}'s Portava Passport`;

    try {
      let imageUri: string | null = null;

      if (cardRef.current) {
        try {
          const raw = await captureRef(cardRef, {
            format: 'jpg',
            quality: 0.9,
            result: 'tmpfile',
          });
          imageUri = toFileUri(raw);
        } catch {
          imageUri = null;
        }
      }

      if (imageUri) {
        try {
          if (Platform.OS === 'ios') {
            // iOS: built-in Share supports file:// url + message text together
            await Share.share({ message, url: imageUri });
          } else {
            // Android: expo-sharing handles file URIs
            const available = await ExpoSharing.isAvailableAsync();
            if (available) {
              await ExpoSharing.shareAsync(imageUri, {
                mimeType: 'image/jpeg',
                dialogTitle: title,
              });
            } else {
              await Share.share({ message, title });
            }
          }
          return;
        } catch (imgErr: any) {
          const msg = imgErr?.message ?? '';
          if (msg.includes('cancelled') || msg.includes('User did not share')) return;
          /* Image share failed — fall through to text-only */
        }
      }

      /* Text-only fallback: deep-link + web URL always reach the recipient */
      await Share.share({ message, title });
    } catch (e: any) {
      const msg = e?.message ?? '';
      if (!msg.includes('cancelled') && !msg.includes('User did not share')) {
        setState((s) => ({ ...s, error: 'Could not open share sheet' }));
      }
    } finally {
      setState((s) => ({ ...s, sharing: false }));
    }
  }, [username]);

  return { cardRef, share, sharing: state.sharing, error: state.error };
}
