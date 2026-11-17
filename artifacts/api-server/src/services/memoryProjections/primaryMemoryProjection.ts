import { asHistoricalMemoryPayload } from "../memory/historicalTruth.js";
import { canonicalPayloadOf } from "../memory/memoryCanonicalFields.js";
import { normalizeMemoryPrecision } from "../../lib/memoryLocationPrecision.js";
import type { MemorySourceRow } from "./projectionRegistry.js";

/**
 * H1: the primary API reads facts before producing a viewer response, like the
 * other Memory projections. This is an in-memory read model over the existing
 * canonical row, not another persisted Memory or an evidence replay snapshot.
 *
 * The caller must first authorize the Memory and apply location/correction
 * policy. Only those authorized facts enter this boundary. Neither a layout
 * nor an AI narrative is an input. Schema additions are not automatically
 * published, and rendering cannot mutate the row or its audience arrays.
 */
type Source = Readonly<MemorySourceRow & { location_precision?: unknown }>;

export function readPrimaryMemoryFacts(row: Source) {
  const facts = Object.freeze(asHistoricalMemoryPayload({
    id: row.id,
    ownerId: row.owner_id,
    title: row.title ?? null,
    caption: row.caption ?? null,
    tripId: row.trip_id ?? null,
    eventId: row.event_id ?? null,
    placeId: row.place_id ?? null,
    locationCity: row.location_city ?? null,
    locationCountry: row.location_country ?? null,
    locationLat: row.location_lat != null ? Number(row.location_lat) : null,
    locationLng: row.location_lng != null ? Number(row.location_lng) : null,
    canonicalLocationId: row.canonical_location_id ?? null,
    // Only the existing gate's attached payload is served, never raw columns.
    ...canonicalPayloadOf(row),
    startsAt: row.starts_at ?? null,
    endsAt: row.ends_at ?? null,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  }));
  const audience = Object.freeze({
    visibility: row.visibility,
    allowedUserIds: Object.freeze([...(row.allowed_user_ids ?? [])]),
    hiddenUserIds: Object.freeze([...(row.hidden_user_ids ?? [])]),
    ...(row.location_precision !== undefined
      ? { locationPrecision: normalizeMemoryPrecision(row.location_precision) }
      : {}),
  });
  return Object.freeze({ facts, audience });
}

export type PrimaryMemoryReadModel = ReturnType<typeof readPrimaryMemoryFacts>;

/** A disposable viewer response; changes to it cannot change historical facts. */
export function projectPrimaryMemory(model: PrimaryMemoryReadModel, viewerId?: string) {
  const { facts, audience } = model;
  const isOwner = viewerId != null && viewerId === facts.ownerId;
  return {
    ...facts,
    visibility: audience.visibility,
    ...(isOwner ? {
      allowedUserIds: [...audience.allowedUserIds],
      hiddenUserIds: [...audience.hiddenUserIds],
      ...(audience.locationPrecision !== undefined ? { locationPrecision: audience.locationPrecision } : {}),
    } : {}),
  };
}
