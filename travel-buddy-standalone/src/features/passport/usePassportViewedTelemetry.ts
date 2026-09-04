/**
 * usePassportViewedTelemetry — emits §32 `passport_viewed` exactly once per
 * viewed Passport (per mount), the moment the view is real.
 *
 * "Real" is the caller's call (`enabled`): the owner tab passes `true` as soon
 * as its profile is on screen; the viewer screen waits for the server
 * projection so the event carries the TABLE 5 `viewerContext` the server
 * decided ('follower', 'trip_crew', …) rather than a client guess. A subject
 * change (navigating between passports on the same screen) re-arms the emit.
 *
 * Payload is ids + the closed viewerContext enum only (§32 privacy rules) —
 * the seam's scrubber enforces that; this hook just decides WHEN.
 */
import { useEffect, useRef } from 'react';
import type { PassportViewerContext } from '../../services/passportProjection.ts';
import { trackPassportViewed } from './passportTelemetry.ts';

export function usePassportViewedTelemetry(
  subjectId: string | null | undefined,
  viewerContext: PassportViewerContext | null | undefined,
  enabled: boolean,
): void {
  const emittedFor = useRef<string | null>(null);
  useEffect(() => {
    const id = (subjectId ?? '').trim();
    if (!enabled || !id) return;
    if (emittedFor.current === id) return;
    emittedFor.current = id;
    trackPassportViewed(id, viewerContext ?? undefined);
  }, [subjectId, viewerContext, enabled]);
}
