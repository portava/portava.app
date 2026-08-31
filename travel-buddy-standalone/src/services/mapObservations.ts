/**
 * mapObservations service — submitting a §22 map contribution.
 *
 * Spec §22: "The map is also a low-friction capture surface. Contributions are
 * observations, not immediate truth."
 *
 * The endpoint is a façade over the existing intel capture pipeline, so
 * everything that makes a contribution safe — D4 consent, the observed-at
 * clamp, canonical claim validation, idempotency, the independent-group signal
 * for k-anonymity — happens server-side. This module only shapes and posts.
 *
 * WHAT IT DELIBERATELY DOES NOT SEND
 * ==================================
 * No actor, no reward, no sponsorship. The server schema is `.strict()` and
 * REFUSES a body carrying any of them rather than stripping them, because a
 * capture attributes a factual claim to a person. §22's closing rule is that
 * rewards "must never increase factual confidence merely because the
 * contribution was paid", and the cleanest way to honour it is for the reward
 * channel not to exist on this path at all.
 *
 * NOT ALL EIGHT PROMPTS ARE ACCEPTED YET. Only crowd_level, queue and
 * entry_access have canonical claim types today; the others are refused with a
 * reason. `submitMapObservation` surfaces that refusal rather than silently
 * swallowing it, so the UI can say "not yet supported here" instead of
 * pretending the observation landed.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken } from './apiToken.ts';
import type { MapContribution } from '../features/map/truth/liveTruth.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export interface MapObservationAccepted {
  ok: true;
  /** False when the flag is off — the tap was not an error, but nothing stored. */
  enabled: boolean;
  accepted: number;
  /** Set when the server understood the prompt but has no claim type for it. */
  unsupportedReason?: string | null;
}

export interface MapObservationRejected {
  ok: false;
  error: string;
}

export type MapObservationResult = MapObservationAccepted | MapObservationRejected;

/**
 * Post one contribution.
 *
 * `objectId` must be the SUBJECT's own id, not the prefixed MapObject id — the
 * server validates it as a uuid and resolves it against `places`. The map's
 * ids are namespaced (`gem:abc`, `place:abc`), so the prefix is stripped here
 * rather than at every call site.
 */
export async function submitMapObservation(
  objectId: string,
  objectKind: string,
  contribution: MapContribution,
): Promise<MapObservationResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  const subjectId = objectId.includes(':')
    ? objectId.slice(objectId.indexOf(':') + 1)
    : objectId;

  const body: Record<string, unknown> = {
    objectId: subjectId,
    objectKind,
    observedAt: new Date(contribution.observedAt ?? Date.now()).toISOString(),
    kind: contribution.kind,
    value: (contribution as { value?: unknown }).value,
  };
  // `media` is the one prompt with an extra required field.
  const mediaUri = (contribution as { mediaUri?: string }).mediaUri;
  if (mediaUri) body.mediaUri = mediaUri;

  try {
    const res = await fetch(`${apiBase()}/api/map/observations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed.message ?? `Request failed (${res.status})`) };
    }
    return {
      ok: true,
      enabled: parsed.enabled !== false,
      accepted: typeof parsed.accepted === 'number' ? parsed.accepted : 0,
      unsupportedReason:
        typeof parsed.unsupportedReason === 'string' ? parsed.unsupportedReason : null,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Network error' };
  }
}
