export interface PlaceLiveInformation {
  whyNow: string[] | null;
  whyNowValidForMs: number | null;
  /** Client-stamped once at request start, so latency/cache reuse cannot extend a claim. */
  expiresAtMs?: number | null;
}

export function stampPlaceLiveInformation(value: PlaceLiveInformation | undefined, requestStartedAt: number): PlaceLiveInformation | undefined {
  if (!value) return undefined;
  const ttl = value.whyNowValidForMs;
  const expiresAtMs = typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 && Number.isFinite(requestStartedAt + ttl) ? requestStartedAt + ttl : null;
  return { ...value, expiresAtMs };
}

export function currentPlaceClaims(value: PlaceLiveInformation | undefined, now: number): string[] {
  if (!value || !Array.isArray(value.whyNow) || typeof value.expiresAtMs !== 'number' || !Number.isFinite(value.expiresAtMs) || now >= value.expiresAtMs) return [];
  return value.whyNow.filter((claim): claim is string => typeof claim === 'string' && claim.trim().length > 0).slice(0, 5).map(claim => claim.replace(/_/g, ' ').trim().slice(0, 160));
}
