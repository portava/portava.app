/**
 * timeoutSignal — an AbortSignal that aborts after `ms`, on every runtime the
 * app ships to.
 *
 * `AbortSignal.timeout(ms)` is NOT available in React Native: RN installs
 * `AbortSignal` from the `abort-controller` package (Libraries/Core/setUpXHR.js),
 * whose class has no static `timeout`, and Hermes has no AbortSignal of its own.
 * A call to it throws `TypeError: AbortSignal.timeout is not a function` before
 * the request is made — on native only, since browsers and Node implement it.
 * That is how the sign-up status read silently never ran on a phone (its
 * fail-open catch swallowed the TypeError).
 *
 * AbortController + setTimeout exist everywhere. The timer is unref'd where the
 * runtime supports it (Node, so tests do not wait on it); on RN it simply fires
 * and aborts an already-settled request, which is a no-op.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer: any = setTimeout(() => controller.abort(), ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return controller.signal;
}
