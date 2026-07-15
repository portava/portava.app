/**
 * useStampShare — captures the off-screen StampShareCard and opens the native
 * share sheet with a stamp image + message.
 *
 * Share payload:
 *   - title:   "Passport Stamp: <stamp name>"
 *   - message: stamp-specific share text (from makeStampShareMessage)
 *   - url:     captured JPEG file URI
 *
 * Fallback: if image capture or image-share fails, opens a text-only share so
 * the message always reaches the recipient.
 *
 * Only public, non-revoked stamps can be shared — the hook is a no-op otherwise.
 *
 * Mirrors the pattern established by usePassportShare.ts.
 */
import { useRef, useState, useCallback } from 'react';
import { View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import NativeShare from 'react-native-share';
import type { PassportStampNew } from '../services/passportStamps';
import { makeStampShareMessage, toFileUri } from '../services/stampShareUtils';

export interface StampShareState {
  sharing: boolean;
  error: string | null;
}

export function useStampShare(stamp: PassportStampNew | null, username: string | null) {
  const cardRef = useRef<View>(null);
  const [state, setState] = useState<StampShareState>({ sharing: false, error: null });

  const share = useCallback(async () => {
    if (!stamp || stamp.visibility !== 'public' || stamp.isRevoked) return;

    setState({ sharing: true, error: null });

    const name =
      stamp.titleOverride ?? stamp.definition?.name ?? stamp.city ?? stamp.country ?? 'Stamp';
    const title = `Passport Stamp: ${name}`;
    const message = makeStampShareMessage(stamp, username);

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

      /* Text-only fallback: message always reaches the recipient */
      await NativeShare.open({ title, message, failOnCancel: false });
    } catch (e: any) {
      const msg = e?.message ?? '';
      if (!msg.includes('User did not share') && !msg.includes('cancelled')) {
        setState((s) => ({ ...s, error: 'Could not open share sheet' }));
      }
    } finally {
      setState((s) => ({ ...s, sharing: false }));
    }
  }, [stamp, username]);

  return { cardRef, share, sharing: state.sharing, error: state.error };
}
