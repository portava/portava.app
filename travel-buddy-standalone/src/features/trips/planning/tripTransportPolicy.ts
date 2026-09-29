/**
 * TRIP-F16 — §7.4's transport-mode policy, set by the owner (WP-10).
 *
 * PUT /trips/:tripId/transport-policy writes 2793's `trip_transport_policies`
 * row: the modes this trip does NOT use. It is deliberately NOT a kernel
 * command (2793's header and the route's own comment: a policy is a setting
 * the feasibility check reads, not a change to the trip aggregate, so
 * `trips.version` does not move). §6.1 canEditTrip decides who — the owner —
 * and the route refuses by name when the operational gate that owns the table
 * is off. This client only sends the setting and draws those refusals.
 *
 * The CURRENT policy is read from the feasibility response it governs
 * (`transportPolicy`): null there means the gate is off and nothing can be
 * read — which is not "every mode allowed".
 */
import { sendTripWrite, type ApiWrite } from '../shared/tripApi.ts';

/** Mirrors POLICY_MODES in api-server domain/trips/policies/TripTransportPolicy.ts. */
export const POLICY_MODES = ['walk', 'drive', 'transit'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const MODE_LABEL: Record<PolicyMode, string> = { walk: 'Walking', drive: 'Driving', transit: 'Public transit' };

export interface TransportPolicy { disallowedModes: PolicyMode[]; note: string | null; updatedAt: string | null }

function isMode(v: unknown): v is PolicyMode {
  return typeof v === 'string' && (POLICY_MODES as readonly string[]).includes(v);
}

/** The policy a feasibility report carries, or null when it carries none (gate off). */
export function policyFromReport(report: { transportPolicy?: unknown }): TransportPolicy | null {
  const p = report.transportPolicy as { disallowedModes?: unknown; note?: unknown; updatedAt?: unknown } | null | undefined;
  if (!p || typeof p !== 'object') return null;
  return {
    disallowedModes: (Array.isArray(p.disallowedModes) ? p.disallowedModes : []).filter(isMode),
    note: typeof p.note === 'string' ? p.note : null,
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
  };
}

/** Flip one mode. Refuses to disallow the last allowed mode — a trip nobody can travel is not a policy. */
export function toggleMode(disallowed: readonly PolicyMode[], mode: PolicyMode): PolicyMode[] {
  if (disallowed.includes(mode)) return disallowed.filter((m) => m !== mode);
  const next = [...disallowed, mode];
  return next.length >= POLICY_MODES.length ? [...disallowed] : next;
}

export async function setTransportPolicy(tripId: string, disallowedModes: readonly PolicyMode[], note: string | null): Promise<ApiWrite<TransportPolicy>> {
  const w = await sendTripWrite<{ transportPolicy?: unknown }>(
    'PUT', `/api/trips/${tripId}/transport-policy`, { disallowedModes: [...new Set(disallowedModes)], note },
  );
  if (w.state !== 'done') return w;
  const policy = policyFromReport(w.data ?? {});
  if (!policy) return { state: 'unavailable', detail: 'unreadable response' };
  return { state: 'done', data: policy, status: w.status };
}
