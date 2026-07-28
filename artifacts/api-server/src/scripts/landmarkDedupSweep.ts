/**
 * landmarkDedupSweep — one-time dedup sweep for natural-landmark places.
 *
 * The original isSamePlace guard used 75 m / Jaccard ≥ 0.8, which fails for
 * landmark name variants ("Kawasan Falls" vs "Kawasan Waterfalls"). The
 * relaxed heuristics (300 m / Jaccard ≥ 0.6 on normalised token sets) now
 * correctly identify these as duplicates, but rows created before the fix
 * were never collapsed. This script finds those pairs and optionally merges
 * them via the existing admin endpoint.
 *
 * Usage (dry-run — default, no writes):
 *   node --import tsx/esm src/scripts/landmarkDedupSweep.ts
 *
 * Usage (apply merges):
 *   node --import tsx/esm src/scripts/landmarkDedupSweep.ts --apply
 *
 * Output is newline-delimited JSON so it can be piped to jq for inspection.
 * Each proposed merge line looks like:
 *   {"action":"merge","loserId":"<uuid>","survivorId":"<uuid>","loserName":"...","survivorName":"...","distanceM":123}
 *
 * Safety guarantees:
 *   • Dry-run is the default — pass --apply explicitly to commit.
 *   • Each pair is logged before any POST.
 *   • Merges are de-duplicated within a tile to avoid A→B and B→A both being proposed.
 *   • Already-merged rows (merged_into_place_id IS NOT NULL) are skipped.
 */

import { getServiceClient } from "../lib/supabase.js";
import {
  LANDMARK_CATEGORY_FAMILIES,
  isLandmark,
  isSamePlace,
  haversineKm,
  type PlaceLike,
} from "../lib/places/placeResolve.js";

// ── Config ────────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes("--apply");
const TILE_DEG = 0.003;   // ~300 m tile — matches LANDMARK_MERGE_DISTANCE_KM

// Internal API base for admin merge calls (server talks to itself).
const API_BASE = process.env.INTERNAL_API_BASE ?? "http://localhost:3000";
const ADMIN_TOKEN = process.env.INTERNAL_ADMIN_TOKEN ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlaceRow extends PlaceLike {
  id: string;
}

interface ProposedMerge {
  action: "merge";
  loserId: string;
  survivorId: string;
  loserName: string;
  survivorName: string;
  distanceM: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tileCoords(lat: number, lng: number): [number, number] {
  return [Math.floor(lat / TILE_DEG), Math.floor(lng / TILE_DEG)];
}

function tileKey(lat: number, lng: number): string {
  const [tx, ty] = tileCoords(lat, lng);
  return `${tx},${ty}`;
}

function tileKeyXY(tx: number, ty: number): string {
  return `${tx},${ty}`;
}

/**
 * Collect all places from a 3×3 block of tiles centred on (lat, lng).
 * Returned list may contain duplicates across neighbours; callers dedup by id.
 */
export function neighborCandidates(
  tiles: Map<string, PlaceRow[]>,
  lat: number,
  lng: number,
): PlaceRow[] {
  const [tx, ty] = tileCoords(lat, lng);
  const result: PlaceRow[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = tiles.get(tileKeyXY(tx + dx, ty + dy));
      if (bucket) result.push(...bucket);
    }
  }
  return result;
}

function log(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function logErr(msg: string, detail?: unknown): void {
  process.stderr.write(JSON.stringify({ error: msg, detail }) + "\n");
}

async function callMerge(loserId: string, survivorId: string): Promise<boolean> {
  const url = `${API_BASE}/api/admin/places/${loserId}/merge`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
      },
      body: JSON.stringify({ intoId: survivorId }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logErr("merge POST failed", { status: res.status, body, loserId, survivorId });
      return false;
    }
    return true;
  } catch (err) {
    logErr("merge POST threw", { err: String(err), loserId, survivorId });
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log({ stage: "start", apply: APPLY, tileDeg: TILE_DEG });

  const sc = getServiceClient();
  if (!sc) {
    logErr("Service client unavailable — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  // Build the IN-clause from LANDMARK_CATEGORY_FAMILIES.
  const landmarkCategories = Array.from(LANDMARK_CATEGORY_FAMILIES);

  // Fetch all active landmark places in pages of 1000.
  const places: PlaceRow[] = [];
  let offset = 0;
  const PAGE = 1000;

  while (true) {
    const { data, error } = await sc
      .from("places")
      .select("id, name, latitude, longitude, primary_category")
      .in("primary_category", landmarkCategories)
      .is("merged_into_place_id", null)
      .range(offset, offset + PAGE - 1);

    if (error) {
      logErr("fetch failed", error.message);
      process.exit(1);
    }

    const rows = (data as PlaceRow[]) ?? [];
    places.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  log({ stage: "fetched", count: places.length });

  // Filter to only rows that pass isLandmark (defensive; category query above
  // already limits to LANDMARK_CATEGORY_FAMILIES members).
  const landmarks = places.filter(
    (p) => p.latitude != null && p.longitude != null && isLandmark(p.primary_category),
  );

  log({ stage: "filtered", count: landmarks.length });

  // Group by 0.003° spatial tile.
  const tiles = new Map<string, PlaceRow[]>();
  for (const p of landmarks) {
    const key = tileKey(p.latitude!, p.longitude!);
    const bucket = tiles.get(key);
    if (bucket) bucket.push(p);
    else tiles.set(key, [p]);
  }

  // Pair each landmark against all candidates in its own tile + the 8
  // neighbouring tiles (3×3 block).  This prevents the tile-boundary blind spot
  // where two places within 300 m sit on opposite sides of a tile edge and
  // would never be compared under a same-tile-only strategy.
  //
  // Each ordered pair (a, b) with a.id < b.id is evaluated at most once:
  //   • When a is the pivot, b appears in a's neighbour list (a.id < b.id → process).
  //   • When b is the pivot, a appears in b's neighbour list (a.id < b.id → skip).
  const proposed: ProposedMerge[] = [];
  const mergedSet = new Set<string>(); // ids already designated as losers
  const evaluatedPairs = new Set<string>(); // "smallId:largeId" — prevent re-evaluation

  for (const a of landmarks) {
    if (mergedSet.has(a.id)) continue;

    const candidates = neighborCandidates(tiles, a.latitude!, a.longitude!);
    for (const b of candidates) {
      if (b.id === a.id) continue;
      if (mergedSet.has(b.id)) continue;

      // Canonical pair key (smaller id first) to skip already-evaluated pairs.
      const pairKey = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (evaluatedPairs.has(pairKey)) continue;
      evaluatedPairs.add(pairKey);

      if (isSamePlace(a, b)) {
        // Survivor: prefer the lexicographically smaller UUID (deterministic).
        const [survivor, loser] = a.id < b.id ? [a, b] : [b, a];
        const distanceM = Math.round(
          haversineKm(a.latitude!, a.longitude!, b.latitude!, b.longitude!) * 1000,
        );
        const merge: ProposedMerge = {
          action: "merge",
          loserId: loser.id,
          survivorId: survivor.id,
          loserName: loser.name,
          survivorName: survivor.name,
          distanceM,
        };
        proposed.push(merge);
        mergedSet.add(loser.id);
        log(merge);
      }
    }
  }

  log({ stage: "scan_complete", proposed: proposed.length, apply: APPLY });

  if (!APPLY) {
    log({ stage: "dry_run_done", note: "Pass --apply to commit merges" });
    return;
  }

  // Apply merges sequentially to avoid racing the merge-log constraint.
  let applied = 0, failed = 0;
  for (const m of proposed) {
    log({ stage: "applying", loserId: m.loserId, survivorId: m.survivorId });
    const ok = await callMerge(m.loserId, m.survivorId);
    if (ok) {
      log({ stage: "applied", loserId: m.loserId, survivorId: m.survivorId });
      applied++;
    } else {
      failed++;
    }
  }

  log({ stage: "done", applied, failed });
}

// Only run when invoked directly, not when imported in tests.
if (process.argv[1]?.endsWith("landmarkDedupSweep.ts") ||
    process.argv[1]?.endsWith("landmarkDedupSweep.js")) {
  main().catch((err) => {
    logErr("unhandled error", String(err));
    process.exit(1);
  });
}
