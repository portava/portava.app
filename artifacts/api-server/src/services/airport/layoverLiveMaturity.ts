import type { LiveConditions } from "./LayoverSafetyEngine.js";

/** Server-produced evidence, retained in the certified input hash. No reporter identifiers. */
export interface AuthoritativeLiveEvidence {
  policy: "authoritative-live-v1";
  observedAt: string;
  expiresAt: string;
  sourceKinds: Array<"official" | "operator_feed">;
}

/** A feed being configured is insufficient; the certified reading must still be current. */
export function hasFreshAuthoritativeLiveEvidence(live: LiveConditions | null | undefined, nowMs: number): boolean {
  const e = live?.authoritativeEvidence;
  if (!e || e.policy !== "authoritative-live-v1" || !Number.isFinite(nowMs)) return false;
  if (live.reasonCodes.some((c) => c === "DATA_STALE" || c === "SOURCE_CONFLICT")) return false;
  if (!live.estimate || live.estimate.fallbackLevel !== 0 || !["HIGH", "MEDIUM"].includes(live.estimate.confidence)) return false;
  return Array.isArray(e.sourceKinds) && e.sourceKinds.length > 0 && e.sourceKinds.every((k) => k === "official" || k === "operator_feed")
    && Number.isFinite(Date.parse(e.observedAt)) && Date.parse(e.observedAt) <= nowMs
    && Number.isFinite(Date.parse(e.expiresAt)) && Date.parse(e.expiresAt) > nowMs
    && live.expiresAt !== null && Date.parse(live.expiresAt) > nowMs;
}

/** Project each named field, so unrelated payload keys cannot change the certified hash. */
export function namedAuthoritativeLiveEvidence(live: LiveConditions): Pick<LiveConditions, "authoritativeEvidence"> {
  const e = live.authoritativeEvidence;
  return e ? { authoritativeEvidence: { policy: e.policy, observedAt: e.observedAt, expiresAt: e.expiresAt, sourceKinds: [...e.sourceKinds].sort() } } : {};
}
