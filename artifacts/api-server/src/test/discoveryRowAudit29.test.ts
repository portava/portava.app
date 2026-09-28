/**
 * census-discovery §69 (lane P29) — probes for row statements restated because
 * their stated evidence is no longer true at this tree.
 *
 * No verdict moves on any case here. Each case pins a FACT a restated row now
 * rests on, so that a later change to that fact turns the case red and the
 * restatement can be re-read. Each case carries an in-memory control: the same
 * reading applied to a mutated copy of the source text must reject it. That is
 * how each case was seen red without editing application source (§69.8).
 *
 *  Q1  DV-53 / DV-55  `allocateFeedSlots` HAS a Discovery caller: Compass's
 *                     `rankItemsForDiscovery`, which the route value-imports,
 *                     calls it with surface "discovery" behind
 *                     DISCOVERY_DIVERSITY_ENABLED.
 *  Q2  DC-24 / DC-13  DiscoveryRankingService is a STAGE inside the PDE
 *                     pipeline (`rankForViewer` calls it), not a ranker with no
 *                     Discovery caller; its negative-feedback inputs are
 *                     constant false on this surface.
 *  Q3  DV-12          Discovery candidates carry no `authorTrustScore`, so the
 *                     trust factor is the constant 0.6 on every Discovery row.
 *  Q4  DC-01          Trails exist and are LISTED newest-first; no Discovery
 *                     ranker has a Trail candidate kind.
 *  Q5  DV-70          FINDING, pinned: `check:production-drift` prints that
 *                     `schema_migration_ledger` is missing whenever anything is
 *                     unapplied, while the production snapshot it compares
 *                     against lists that table.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { socialProofScore } from "../lib/portavaRank.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dir, "..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

/** The body of one top-level function, from its `export … function name(` line to the next top-level `export`. */
function fnBody(src: string, name: string): string {
  const re = new RegExp(`\\nexport (?:async )?function ${name}\\b`);
  const m = re.exec(src);
  if (!m) return "";
  const rest = src.slice(m.index + 1);
  const end = rest.slice(1).search(/\nexport /);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe("§69 Q1 (DV-53, DV-55): allocateFeedSlots has a Discovery caller", () => {
  const reads = (compass: string, route: string) => {
    const body = fnBody(compass, "rankItemsForDiscovery");
    return {
      called: /allocateFeedSlots\(\s*finalPool,\s*shares,\s*\{\s*surface:\s*"discovery"/.test(body),
      gated: /isFlagEnabled\(db,\s*"DISCOVERY_DIVERSITY_ENABLED"\)/.test(body),
      routeImports: /^import \{ rankItemsForDiscovery \} from "\.\.\/compass\/CompassFeedBuilder";/m.test(route),
    };
  };
  const compass = read("compass/CompassFeedBuilder.ts");
  const route = read("routes/discovery.ts");

  it("rankItemsForDiscovery calls allocateFeedSlots(surface 'discovery') behind DISCOVERY_DIVERSITY_ENABLED, and the route value-imports it", () => {
    assert.deepEqual(reads(compass, route), { called: true, gated: true, routeImports: true });
  });

  it("control: the reading sees the call removed", () => {
    const mutated = compass.replace(/allocateFeedSlots\(finalPool, shares, \{ surface: "discovery"/, "void (finalPool, shares, { surface: \"discovery\"");
    assert.notEqual(mutated, compass, "the mutation must apply");
    assert.equal(reads(mutated, route).called, false);
  });
});

describe("§69 Q2 (DC-24, DC-13): DiscoveryRankingService is a stage inside rankForViewer", () => {
  const pde = read("lib/discoveryPde.ts");
  const reads = (src: string) => {
    const body = fnBody(src, "rankForViewer");
    return {
      valueImport: /^import \{ rankItems as drsRankItems \} from "\.\.\/services\/ranking\/DiscoveryRankingService\.js";/m.test(src),
      calledInPipeline: /await drsRankItems\(\s*drsInputs,\s*"discovery"/.test(body),
      negativeFeedbackInputsConstant: /viewerHasReportedItem: false, viewerHasHiddenItem: false/.test(body),
    };
  };

  it("rankForViewer value-imports and calls DRS for surface 'discovery', with the negative-feedback inputs constant false", () => {
    assert.deepEqual(reads(pde), { valueImport: true, calledInPipeline: true, negativeFeedbackInputsConstant: true });
  });

  it("control: the reading sees the call removed", () => {
    const mutated = pde.replace(/await drsRankItems\(/, "await Promise.resolve([] as any) && (");
    assert.notEqual(mutated, pde, "the mutation must apply");
    assert.equal(reads(mutated).calledInPipeline, false);
  });
});

describe("§69 Q3 (DV-12): the trust factor is a constant on Discovery rows", () => {
  const pde = read("lib/discoveryPde.ts");
  /** The candidate map inside rankForViewer: `places.map((p) => ({ … }))`. */
  const candidateMap = (src: string) => {
    const body = fnBody(src, "rankForViewer");
    const i = body.indexOf("const candidates: PlaceCandidate<T>[] = places.map((p) => ({");
    return i < 0 ? "" : body.slice(i, body.indexOf("}));", i));
  };

  it("no Discovery candidate carries authorTrustScore, so socialProofScore applies ×0.6 to every row", () => {
    const map = candidateMap(pde);
    assert.ok(map.length > 0, "the candidate map must be found");
    assert.equal(/authorTrustScore/.test(map), false);
    const base = Math.min(1, Math.log10(1 + 999) / 3);
    assert.equal(socialProofScore({ id: "p", kind: "place", likeCount: 999 } as any), base * 0.6);
    // A KNOWN zero-trust author scores lower than an unknown one: the factor defends nothing on a surface that never sets it.
    assert.ok(socialProofScore({ id: "p", kind: "place", likeCount: 999, authorTrustScore: 0 } as any) < base * 0.6);
  });

  it("control: the reading sees a trust score added to the candidate map", () => {
    const mutated = pde.replace("likeCount:  p.savedCount ?? null,", "likeCount:  p.savedCount ?? null, authorTrustScore: 50,");
    assert.notEqual(mutated, pde, "the mutation must apply");
    assert.equal(/authorTrustScore/.test(candidateMap(mutated)), true);
  });
});

describe("§69 Q4 (DC-01): Trails are listed by recency, and no Discovery ranker has a Trail kind", () => {
  const trails = read("services/trails/TrailService.ts");
  const rank = read("lib/portavaRank.ts");
  const reads = (t: string, r: string) => {
    const list = fnBody(t, "listTrails");
    const kind = /export type CandidateKind =\s*\n([^;]*);/.exec(r)?.[1] ?? "";
    return {
      newestFirst: /\.order\("created_at", \{ ascending: false \}\)/.test(list),
      trailKind: /'trail'/.test(kind),
    };
  };

  it("listTrails orders by created_at descending, and CandidateKind names no trail", () => {
    assert.deepEqual(reads(trails, rank), { newestFirst: true, trailKind: false });
  });

  it("control: the reading sees a Trail kind added", () => {
    const mutated = rank.replace("| 'traveler' | 'place';", "| 'traveler' | 'place' | 'trail';");
    assert.notEqual(mutated, rank, "the mutation must apply");
    assert.equal(reads(trails, mutated).trailKind, true);
  });
});

describe("§69 Q5 (DV-70): FINDING, pinned — the drift footer contradicts the snapshot", () => {
  const script = read("scripts/checkProductionDrift.ts");
  const snapshot = readFileSync(resolve(SRC, "../baseline/20260922_production_tables.txt"), "utf8");
  const reads = (s: string, snap: string) => ({
    snapshotHasLedger: /^schema_migration_ledger$/m.test(snap),
    footerSaysMissing: /schema_migration_ledger is the one to fix first: without it/.test(s),
  });

  it("LIMIT, pinned: the snapshot lists schema_migration_ledger while the footer says production lacks it", () => {
    // Goes red when the footer is corrected (or the snapshot loses the table): then re-read DV-70's §69 statement.
    assert.deepEqual(reads(script, snapshot), { snapshotHasLedger: true, footerSaysMissing: true });
  });

  it("control: the reading sees the table dropped from the snapshot", () => {
    const mutated = snapshot.replace(/^schema_migration_ledger$/m, "");
    assert.notEqual(mutated, snapshot, "the mutation must apply");
    assert.equal(reads(script, mutated).snapshotHasLedger, false);
  });
});
