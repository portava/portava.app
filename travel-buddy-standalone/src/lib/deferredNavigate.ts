/**
 * closeThenNavigate — shared fix for BUG CC / BUG CD class of dead back buttons.
 *
 * Symptom: a sheet or overlay is closed and `router.push(...)` is called in
 * the same synchronous handler. The overlay's close/slide-out animation
 * (native <Modal>, or any RN Animated/gesture-driven sheet) is still
 * dismissing while the newly pushed screen mounts underneath it. On iOS the
 * modal's native window can stay on top; on web the closing overlay keeps
 * intercepting touches. Either way, the new screen — including its own back
 * button — silently stops responding to taps until a full reload.
 *
 * Fix: close the sheet first, then defer the navigation until after the
 * close animation has had time to finish.
 */
import { router } from 'expo-router';

const SHEET_CLOSE_MS = 320;

export function closeThenNavigate(close: () => void, path: string): void {
  close();
  setTimeout(() => router.push(path as any), SHEET_CLOSE_MS);
}
