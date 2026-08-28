/**
 * backfillPlacePhotos — OPERATOR-RUN bulk pre-population of the discovery place-photo store.
 *
 * ⚠ OWNER RULING REQUIRED — SEE docs/discovery/place-photo-backfill-ruling.md.
 * Bulk pre-population / pre-populating cities is an EXPLICIT non-goal of
 * lib/discoveryPlacePhotoStore.ts ("does nothing on its own initiative"). This
 * script exists ONLY under the owner's 2026-08-28 ruling that authorised bulk
 * city pre-population for the pilot. It is never wired into a scheduler or the
 * app; it runs only when an operator invokes it with --confirm-bulk-prepopulation.
 *
 * WHAT IT DOES. For each active canonical place in a city, resolve a Google
 * Places (New) photo and warm public.discovery_place_photos, so the FIRST viewer
 * of a card already gets a stored photo instead of a two-provider cold resolve.
 *
 * WHAT IT DOES NOT DO — deliberately, to not degrade live behaviour:
 *   • Never OVERWRITES an existing fresh row. The live path warms the store
 *     FSQ-first; this only fills the cold long tail, so a place a viewer already
 *     resolved via Foursquare keeps its Foursquare photo.
 *   • Google-only (v1). The live client still resolves Foursquare-first on cards
 *     whose store row has expired; adding an FSQ leg to the backfill (its live
 *     resolver has in-flight dedup + dead-CDN HEAD checks worth reusing, not
 *     re-implementing) is a documented follow-up.
 *   • Reuses the store's OWN write (writeStoredPlacePhoto): Google rows persist
 *     the photo RESOURCE NAME, never a key-bearing URL — the security invariant
 *     stays in one place.
 *
 * Idempotent + resumable: re-running skips places already warmed. Rate-limited.
 *
 * Usage (set --limit to cover the whole city — Da Nang has ~2,900 active places,
 * and the default of 200 only warms the alphabetical head):
 *   GOOGLE_MAPS_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     node --import tsx/esm src/scripts/backfillPlacePhotos.ts \
 *       --city "Da Nang" --limit 3000 --confirm-bulk-prepopulation [--dry-run] [--delay-ms 250]
 */
import { pathToFileURL } from "node:url";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import {
  normalisePlaceKey, readStoredPlacePhoto, writeStoredPlacePhotoIfAbsent,
  type StoredPlacePhoto,
} from "../lib/discoveryPlacePhotoStore.js";

export interface BackfillArgs {
  city: string;
  limit: number;
  delayMs: number;
  dryRun: boolean;
  confirmed: boolean;
}

export function parseArgs(argv: readonly string[]): BackfillArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? String(argv[i + 1]) : null;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  const limitRaw = get("--limit");
  const delayRaw = get("--delay-ms");
  return {
    city: (get("--city") ?? "").trim(),
    limit: limitRaw != null && Number.isFinite(Number(limitRaw)) ? Math.max(1, Math.floor(Number(limitRaw))) : 200,
    delayMs: delayRaw != null && Number.isFinite(Number(delayRaw)) ? Math.max(0, Math.floor(Number(delayRaw))) : 250,
    dryRun: has("--dry-run"),
    confirmed: has("--confirm-bulk-prepopulation"),
  };
}

/** Google Places (New) text search → the first photo's RESOURCE NAME, or null.
 *  Mirrors routes/places.ts GET /places/photo (kept in sync deliberately). */
export async function resolveGooglePhotoName(
  name: string,
  lat: number | null,
  lng: number | null,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const body: Record<string, unknown> = { textQuery: name };
  if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 5000 } };
  }
  try {
    const gRes = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.photos",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!gRes.ok) return null;
    const gBody = (await gRes.json()) as any;
    const photoName = gBody?.places?.[0]?.photos?.[0]?.name;
    return typeof photoName === "string" && photoName.length > 0 ? photoName : null;
  } catch {
    return null;
  }
}

export interface BackfillDeps {
  sc: any;
  resolvePhotoName: (name: string, lat: number | null, lng: number | null) => Promise<string | null>;
  readStored: (placeKey: string) => Promise<StoredPlacePhoto | null>;
  writeStored: (placeKey: string, photo: StoredPlacePhoto) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export interface BackfillResult {
  scanned: number; skippedExisting: number; resolved: number; noPhoto: number; unkeyable: number;
}

/**
 * The pass. Pure of process/argv/network concerns — every side-effecting
 * dependency is injected, so the whole thing is unit-testable with fakes.
 */
export async function runBackfill(args: BackfillArgs, deps: BackfillDeps): Promise<BackfillResult> {
  const res: BackfillResult = { scanned: 0, skippedExisting: 0, resolved: 0, noPhoto: 0, unkeyable: 0 };

  // Strip PostgREST .or() metacharacters — matches discovery.ts sanitizeCityFilter.
  // The city is operator-supplied, but an unescaped ',' or ')' would still break
  // or mis-scope the filter, so sanitise it the same way the serve path does.
  const city = args.city.replace(/[(),*]/g, "").trim();
  if (!city) { deps.log("empty city after sanitisation; nothing to do"); return res; }

  const { data, error } = await deps.sc
    .from("places")
    .select("id, name, latitude, longitude")
    .or(`city.ilike.${city},city.ilike.${city}%`)
    .eq("status", "active")
    .is("merged_into_place_id", null)
    .order("normalized_name", { ascending: true })
    .limit(args.limit);
  if (error) { deps.log(`place enumeration failed: ${String((error as any).message ?? error)}`); return res; }

  const places = (data ?? []) as any[];
  deps.log(`scanning ${places.length} active canonical places in "${args.city}" (dryRun=${args.dryRun})`);

  for (const p of places) {
    res.scanned++;
    const placeKey = normalisePlaceKey(`db/${p.id}`);
    if (!placeKey) { res.unkeyable++; continue; }

    // Never overwrite an existing fresh row (keeps the live FSQ-first winner).
    const existing = await deps.readStored(placeKey);
    if (existing) { res.skippedExisting++; continue; }

    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) { res.noPhoto++; continue; }
    const lat = p.latitude != null ? Number(p.latitude) : null;
    const lng = p.longitude != null ? Number(p.longitude) : null;

    const photoName = await deps.resolvePhotoName(name, lat, lng);
    if (!photoName) { res.noPhoto++; }
    else if (args.dryRun) { res.resolved++; }
    else {
      await deps.writeStored(placeKey, { source: "google", photoUrl: null, photoRef: photoName });
      res.resolved++;
    }
    if (args.delayMs > 0) await deps.sleep(args.delayMs);

    if (res.scanned % 50 === 0) {
      deps.log(`… ${res.scanned}/${places.length} (resolved ${res.resolved}, skipped ${res.skippedExisting}, none ${res.noPhoto})`);
    }
  }

  deps.log(`done: scanned ${res.scanned}, resolved ${res.resolved}, skippedExisting ${res.skippedExisting}, noPhoto ${res.noPhoto}, unkeyable ${res.unkeyable}`);
  return res;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.confirmed) {
    logger.error("Refusing to run: bulk pre-population requires --confirm-bulk-prepopulation (see docs/discovery/place-photo-backfill-ruling.md).");
    process.exitCode = 2; return;
  }
  if (!args.city) {
    logger.error("Refusing to run: --city \"<name>\" is required (the backfill is city-scoped, never global).");
    process.exitCode = 2; return;
  }
  const key = process.env["GOOGLE_MAPS_API_KEY"];
  if (!key) {
    logger.error("Refusing to run: GOOGLE_MAPS_API_KEY is not set — the backfill resolves photos through Google Places (New).");
    process.exitCode = 2; return;
  }
  const sc = getServiceClient();
  if (!sc) {
    logger.error("Refusing to run: no Supabase service client (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
    process.exitCode = 2; return;
  }

  const result = await runBackfill(args, {
    sc,
    resolvePhotoName: (name, lat, lng) => resolveGooglePhotoName(name, lat, lng, key),
    readStored: readStoredPlacePhoto,
    // Insert-if-absent: warming a cold place must never clobber a row a live
    // viewer resolved FSQ-first between our read and our write.
    writeStored: writeStoredPlacePhotoIfAbsent,
    sleep,
    log: (msg) => logger.info(msg),
  });
  logger.info({ result }, "backfillPlacePhotos complete");
}

// Only auto-run as a script, never on import (keeps it unit-testable).
// pathToFileURL canonicalises + percent-encodes argv[1] so a path with spaces or
// a symlink still matches import.meta.url (a raw `file://`+argv1 would not).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
