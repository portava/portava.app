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
 * No coordinates either, on any prompt. The payload carries the SUBJECT's id,
 * not a position, and the media prompt below carries a storage reference whose
 * EXIF/GPS was stripped at upload. `intel_evidence` is not a second location
 * store and this module is not a way to make it one.
 *
 * THE TWO ARROWS
 * ==============
 * §21 orders `Observation -> Evidence`, and one endpoint serves both:
 *
 *   the seven PROPOSITION prompts   -> an observation; the response carries its
 *                                      id under `observation.id`
 *   the MEDIA prompt                -> evidence attached to an observation that
 *                                      ALREADY EXISTS, named by `observationId`
 *
 * A media contribution with no `observationId` is refused server-side with the
 * ruling as the reason ("a photo is evidence, not a claim"), so `observationId`
 * is REQUIRED on the media member of `MapContribution` and is sent below.
 * `features/map/truth/contributionFlow.ts` owns the ordering; this module is
 * one call.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken } from './apiToken.ts';
import type { MapContribution } from '../features/map/truth/liveTruth.ts';
import type {
  ContributionSubmitOk,
  ContributionSubmitRejected,
  ContributionSubmitResult,
} from '../features/map/truth/contributionFlow.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export type MapObservationAccepted = ContributionSubmitOk;
export type MapObservationRejected = ContributionSubmitRejected;
export type MapObservationResult = ContributionSubmitResult;

/** Read an id out of the server's envelope without trusting its shape. */
function idOf(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const id = (envelope as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : null;
}

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
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured', errorCode: null };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated', errorCode: null };

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
  // `media` is the one prompt with extra required fields, and both are sent:
  // the storage reference the upload produced, and the observation the artifact
  // supports. Without the second the server refuses the contribution outright,
  // which is §21's order rather than a bug to route around.
  if (contribution.kind === 'media') {
    body.mediaUri = contribution.mediaUri;
    body.observationId = contribution.observationId;
  }

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
      return {
        ok: false,
        error: String(parsed.message ?? `Request failed (${res.status})`),
        // The server ANSWERED, so this is a refusal rather than a lost request,
        // and the flow renders it as one. `error` is the stable code
        // (invalid_payload / forbidden / not_found / rate_limited).
        errorCode: typeof parsed.error === 'string' ? parsed.error : `http_${res.status}`,
      };
    }
    const observationEnvelope = parsed.observation;
    const evidenceEnvelope = parsed.evidence;
    return {
      ok: true,
      enabled: parsed.enabled !== false,
      accepted: typeof parsed.accepted === 'number' ? parsed.accepted : 0,
      deduped: parsed.deduped === true,
      // On the observation arrow the id is the observation's own; on the
      // evidence arrow the server echoes the observation it attached to, so a
      // caller always knows which observation this call concerned.
      observationId:
        idOf(observationEnvelope) ??
        (typeof (evidenceEnvelope as { observationId?: unknown } | undefined)?.observationId === 'string'
          ? ((evidenceEnvelope as { observationId: string }).observationId)
          : null),
      evidenceId: idOf(evidenceEnvelope),
    };
  } catch (e: any) {
    // No answer at all — not a refusal. `errorCode: null` is what tells the
    // flow to say "could not be sent" rather than "was not recorded".
    return { ok: false, error: e?.message ?? 'Network error', errorCode: null };
  }
}
