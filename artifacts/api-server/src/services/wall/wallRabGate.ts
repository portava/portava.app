/**
 * wallRabGate — the one place that decides whether Rent-a-Buddy content may
 * appear on the Wall.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * The Wall surfaces RAB from THREE independent producers:
 *
 *   • loadContextualOpportunityCandidates  (WallCandidateLoaders.ts) — For You
 *     "opportunity" cards
 *   • readBuddyCandidate                   (ContextThreadService.ts)  — the
 *     "Buddy available in this area" context thread
 *   • buildBuddyLiveCandidates             (LiveForYouService.ts)     — the
 *     "Buddy around" live-strip item
 *
 * Only the first consulted the RAB MASTER switch `rent_buddy_enabled`. The other
 * two gated on `wall_rab_integration_enabled` alone — and the second and third
 * took that as a boolean handed down by the route, so the master was never read
 * on their paths at all. Pressing the Wall flag would therefore have advertised
 * a globally disabled product on two of three surfaces: a "book a Buddy" offer
 * no viewer could act on, since every booking path refuses while the master is
 * off. The flag's ON state did not mean what its one honest call site meant.
 *
 * So the pair is named once, here, and every producer requires BOTH.
 *
 * NOT IN lib/featureFlags.ts DELIBERATELY. scripts/check-flag-polarity.mjs
 * excludes that file from its read scan (it is where the shared READERS are
 * defined), so a flag whose only literal read moved there would be reported as
 * "seeded but never read" — the population check would go blind to it. A gate
 * that names specific flags belongs in the subsystem that owns them, where the
 * guard can see it.
 *
 * FAIL-CLOSED throughout: both reads go through isFlagEnabled, which returns
 * false on any error, and the wrapper catches anything the pair can throw.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";

/**
 * May the Wall show Rent-a-Buddy content right now?
 *
 * BOTH flags. `wall_rab_integration_enabled` says "the Wall MAY show RAB";
 * `rent_buddy_enabled` says "RAB EXISTS". The first is necessary, never
 * sufficient.
 */
export async function isWallRabEnabled(sc: any): Promise<boolean> {
  try {
    const [wallRab, rabMaster] = await Promise.all([
      isFlagEnabled(sc, "wall_rab_integration_enabled"),
      isFlagEnabled(sc, "rent_buddy_enabled"),
    ]);
    return wallRab && rabMaster;
  } catch {
    return false;
  }
}

/**
 * The RAB master switch alone, for a producer that has ALREADY been handed the
 * Wall flag by its caller and must not trust that boolean to also carry the
 * master. Re-reading here is what makes the producer's guarantee independent of
 * how any caller wires it up.
 */
export async function isRentBuddyMasterEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, "rent_buddy_enabled");
}
