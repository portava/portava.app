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

/**
 * The ask-body rule (census-sensing S39, §21.4 blocker #3): a Compass turn
 * names the zone its own device is in, so the server can read that zone's
 * k-gated presence aggregate — behind the `surface` scope and the
 * presence-context flag, both off today. An explicit `sensingZoneIds` wins;
 * an explicit empty array sends nothing; otherwise the live hint, if any.
 * PURE, so it is testable under node where `services/compass` is not.
 */
export function withSensingZone<T extends { sensingZoneIds?: string[] }>(opts: T): T {
  if (opts.sensingZoneIds !== undefined) {
    if (opts.sensingZoneIds.length > 0) return opts;
    const { sensingZoneIds: _drop, ...rest } = opts;
    void _drop;
    return rest as T;
  }
  const zone = sensingZoneHint();
  return zone ? { ...opts, sensingZoneIds: [zone] } : opts;
}
