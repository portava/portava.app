/**
 * usePassportShare — captures the PassportShareCard and opens the native share sheet.
 *
 * Uses react-native-share which supports sharing a file + text on both iOS and
 * Android (EXTRA_STREAM + EXTRA_TEXT on Android; UIActivityViewController on iOS).
 *
 * Share payload:
 *   - title:   "@<username>'s Travel Buddy Passport"
 *   - message: human-readable text with deep-link + web fallback URL
 *   - url:     captured JPEG file URI (both platforms)
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
 */
import { useRef, useState, useCallback } from 'react';
import { View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import NativeShare from 'react-native-share';
import { makeDeepLink, makeWebFallback, toFileUri } from '../services/passportShareUtils';

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
          await NativeShare.open({
            title,
            message,
            url: imageUri,
            type: 'image/jpeg',
            failOnCancel: false,
          });
          return;
        } catch (imgErr: any) {
          const msg = imgErr?.message ?? '';
          if (msg.includes('User did not share') || msg.includes('cancelled')) return;
          /* Image share failed — fall through to text-only */
        }
      }

      /* Text-only fallback: deep-link + web URL always reach the recipient */
      await NativeShare.open({ title, message, failOnCancel: false });
    } catch (e: any) {
      const msg = e?.message ?? '';
      if (!msg.includes('User did not share') && !msg.includes('cancelled')) {
        setState((s) => ({ ...s, error: 'Could not open share sheet' }));
      }
    } finally {
      setState((s) => ({ ...s, sharing: false }));
    }
  }, [username]);

  return { cardRef, share, sharing: state.sharing, error: state.error };
}
