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
 *
 * The `path` argument accepts the same union that `router.push` accepts:
 *   - a plain string:                  closeThenNavigate(onClose, '/foo')
 *   - an Expo Router Href object:      closeThenNavigate(onClose, { pathname: '/foo', params: { id } })
 */
import { router, type Href } from 'expo-router';

const SHEET_CLOSE_MS = 320;

export function closeThenNavigate(close: () => void, path: string | Href): void {
  close();
  setTimeout(() => router.push(path as any), SHEET_CLOSE_MS);
}

/**
 * closeThenRun — same deferred-close fix as closeThenNavigate, for a
 * caller-owned action instead of a fixed route (e.g. a parent callback that
 * decides its own destination). Use this instead of relying on a native
 * <Modal>'s onDismiss: that event is iOS-only in React Native and never
 * fires on Android, so anything gated on it is a dead tap there.
 */
export function closeThenRun(close: () => void, action: () => void): void {
  close();
  setTimeout(action, SHEET_CLOSE_MS);
}
