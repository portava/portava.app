/**
 * sensingZoneHint — the one coarse zone a Compass turn may name (census-sensing
 * §21.4 blocker #3), kept in a module with NO React Native imports so
 * `services/compass` can read it under the node test runner and on every
 * platform without pulling the capture installer in.
 *
 * The source is registered by `installSensingCapture` while a capture loop is
 * running and cleared when it stops, so the hint is null exactly when capture
 * is: no consent, no API base, disposed, or no window closed yet. The value is
 * the capture handle's `currentZone()` — the spatial-bucket label already
 * stamped on this device's contributions, never a coordinate.
 */
let source: (() => string | null) | null = null;

export function registerSensingZoneSource(fn: (() => string | null) | null): void {
  source = fn;
}

export function sensingZoneHint(): string | null {
  if (!source) return null;
  try {
    const z = source();
    return typeof z === 'string' && z.trim() !== '' ? z : null;
  } catch {
    return null;
  }
}

/** Only an area explicitly chosen for this turn may travel with an identified ask.
 * A device-local capture grant grants no permission to send its location to Compass.
 */
export function withSensingZone<T extends { sensingZoneIds?: string[] }>(opts: T): T {
  if (opts.sensingZoneIds === undefined || opts.sensingZoneIds.length > 0) return opts;
  const { sensingZoneIds: unused, ...rest } = opts;
  void unused;
  return rest as T;
}
