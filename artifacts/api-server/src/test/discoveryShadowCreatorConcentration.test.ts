/**
 * DV-79 — Phase 9's FIFTH dimension: creator concentration.
 *
 * WHY THIS IS A SEPARATE FILE FROM discoveryShadow.test.ts
 * =======================================================
 * That file pins the PURE page comparison, and one of its assertions is that
 * `compareShadowPages` reports `creatorConcentration: null`. That assertion is
 * correct and is not touched here: a served `DiscoveryPlace` really does carry
 * no author, so a function handed nothing but served rows cannot name one.
 *
 * What this file grades is the OTHER option the census row left open — "or a
 * join the shadow writer does not do". The served response shape is untouched;
 * the SHADOW WRITER resolves authors for itself out of
 * `discovery_places.submitted_by`, a column that has existed since
 * `0029_discovery_places.sql`.
 *
 * THE THREE STATES, AND WHY THEY MAY NEVER COLLAPSE INTO EACH OTHER
 * =================================================================
 *   1. THE READ FAILED (or there was no client). Nothing is known. This must
 *      not read as "no concentration" (hhi 0) and must not read as "one
 *      author owns the page" (hhi 1). Both are measurements nobody made, and
 *      both are quotable.
 *   2. THE READ SUCCEEDED AND RESOLVED NOBODY — every place on the page is an
 *      OSM row, or a canonical `places` row, neither of which has an author in
 *      `discovery_places`. That is COVERAGE 0, not concentration 0.
 *   3. THE READ SUCCEEDED AND RESOLVED AUTHORS. Now, and only now, there is a
 *      concentration figure, and it travels with its own coverage.
 *
 * Run: node --import tsx/esm --test src/test/discoveryShadowCreatorConcentration.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pageCreators,
  resolvePageAuthors,
  compareShadowPagesWithCreators,
  logDiscoveryShadowServe,
  type ShadowPageItem,
} from "../lib/discoveryShadow.js";
import {
  aggregatePhase9,
  formatPhase9,
  type ShadowServeRow,
  type ShadowPhase9Blob,
} from "../lib/discoveryDivergenceReport.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const P2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const P3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

const item = (id: string): ShadowPageItem => ({ id, category: "food" });

/**
 * A client whose `discovery_places` read answers with `rows`, or fails.
 * Modelled on the PostgREST shape the rest of this lane uses: `{ data, error }`
 * from `.in()`, never a throw.
 */
function authorClient(opts: { rows?: any[]; error?: unknown; throws?: boolean } = {}) {
  const calls: any[] = [];
  const inserted: any[] = [];
  const client: any = {
    from(table: string) {
      if (table === "discovery_places") {
        return {
          select(cols: string) {
            return {
              in: async (col: string, ids: string[]) => {
                calls.push({ table, cols, col, ids });
                if (opts.throws) throw new Error("connection reset");
                return { data: opts.rows ?? null, error: opts.error ?? null };
              },
            };
          },
        };
      }
      return { insert: async (row: any) => { inserted.push(row); return { error: null }; } };
    },
  };
  return { client, calls, inserted };
}

const BASE = {
  userId: "u-1",
  destination: "Paris, France",
  category: "food",
  radiusKm: 10,
  page: 1,
  pageSize: 20,
  sortBy: null,
  servePoint: 1,
  cacheLevel: "L1",
  legacyIds: [`db/${P1}`],
  legacyTotal: 1,
  legacyMs: 12,
  pdeIds: [`db/${P1}`],
  pdeTotal: 1,
  pdeMs: 40,
  pdeStages: { portavaRank: true },
  pdeSuppressedWrites: 0,
  engineMode: "shadow",
  modeReason: "resolved",
  cohortReason: "percent_in",
};

describe("DV-79 — pageCreators: coverage is not concentration", () => {
  it("a page whose authors are all unresolved reports COVERAGE 0, and NO concentration", () => {
    const c = pageCreators([item("node/1"), item("node/2"), item("node/3")], new Map());
    assert.equal(c.n, 3);
    assert.equal(c.resolved, 0);
    assert.equal(c.coverage, 0);
    assert.equal(c.hhi, null, "nobody was resolved, so there is no distribution to concentrate");
    assert.equal(c.distinctCreators, null, "zero distinct creators would assert that the page has no creators");
    assert.equal(c.topCreatorShare, null);
  });

  it("one author over every resolved place is concentration 1 — and is NOT the same fact as an unreadable page", () => {
    const authors = new Map([[`db/${P1}`, U1], [`db/${P2}`, U1]]);
    const c = pageCreators([item(`db/${P1}`), item(`db/${P2}`)], authors);
    assert.equal(c.coverage, 1);
    assert.equal(c.distinctCreators, 1);
    assert.equal(c.hhi, 1, "one author holding both slots is maximal concentration");
    assert.equal(c.topCreatorShare, 1);
  });

  it("two authors evenly split is the Herfindahl minimum for two, and carries its own coverage", () => {
    const authors = new Map([[`db/${P1}`, U1], [`db/${P2}`, U2]]);
    const c = pageCreators([item(`db/${P1}`), item(`db/${P2}`), item("node/9")], authors);
    assert.equal(c.resolved, 2);
    assert.equal(c.coverage, 2 / 3, "the third place had no resolvable author — coverage, not a third creator");
    assert.equal(c.distinctCreators, 2);
    assert.equal(c.hhi, 0.5);
    assert.equal(c.topCreatorShare, 0.5);
  });
});

describe("DV-79 — resolvePageAuthors: the join the shadow writer does itself", () => {
  it("joins discovery_places.submitted_by for the db/<uuid> ids only, and asks for no other column", async () => {
    const { client, calls } = authorClient({
      rows: [{ id: P1, submitted_by: U1 }, { id: P2, submitted_by: null }],
    });
    const out = await resolvePageAuthors(client, [`db/${P1}`, `db/${P2}`, "node/12345", `db/${P1}`]);
    assert.equal(out.reason, "measured");
    assert.equal(calls.length, 1, "one join, not one read per place");
    assert.deepEqual(calls[0].ids.slice().sort(), [P1, P2], "OSM ids are not uuids and must never be sent");
    assert.match(calls[0].cols, /submitted_by/);
    assert.equal(out.authors.get(`db/${P1}`), U1);
    assert.equal(out.authors.has(`db/${P2}`), false, "a NULL submitted_by is an unresolved author, not an author named null");
  });

  it("FAIL CLOSED: a rejected read is `unreadable` with NO authors — never an empty page of authors", async () => {
    const { client } = authorClient({ error: { message: "permission denied" } });
    const out = await resolvePageAuthors(client, [`db/${P1}`]);
    assert.equal(out.reason, "unreadable", "a rejected read must not be reported as a successful read of nobody");
    assert.equal(out.authors.size, 0);
  });

  it("FAIL CLOSED: a throwing read is `unreadable`, and never escapes", async () => {
    const { client } = authorClient({ throws: true });
    const out = await resolvePageAuthors(client, [`db/${P1}`]);
    assert.equal(out.reason, "unreadable");
  });

  it("no client is `no_client`, which is a different fact from a failed read", async () => {
    const out = await resolvePageAuthors(null, [`db/${P1}`]);
    assert.equal(out.reason, "no_client");
  });

  it("a page with no joinable id is `not_joinable` — NOT a measured page that happened to find nobody", async () => {
    const { client, calls } = authorClient({ rows: [] });
    const out = await resolvePageAuthors(client, ["node/1", "way/2"]);
    assert.equal(
      out.reason, "not_joinable",
      "no read was issued. `db/<uuid>` is minted from discovery_places AND the canonical places table, so " +
      "'found nobody' could not be told apart from 'the author is in a table this join does not read'",
    );
    assert.equal(calls.length, 0, "and no query is issued for an empty id set");
    assert.equal(out.authors.size, 0);
  });
});

describe("DV-79 — compareShadowPagesWithCreators", () => {
  const legacy = [item(`db/${P1}`), item(`db/${P2}`)];
  const pde    = [item(`db/${P1}`), item(`db/${P3}`)];

  it("measures concentration per PAGE, keeps legacy and PDE apart, and removes the axis from `unmeasured`", async () => {
    const { client } = authorClient({
      rows: [{ id: P1, submitted_by: U1 }, { id: P2, submitted_by: U1 }, { id: P3, submitted_by: U2 }],
    });
    const dims = await compareShadowPagesWithCreators(client, legacy, pde);
    assert.ok(dims.creatorConcentration);
    assert.equal(dims.creatorConcentration!.reason, "measured");
    assert.equal(dims.creatorConcentration!.legacy!.hhi, 1, "legacy's two places share one author");
    assert.equal(dims.creatorConcentration!.pde!.hhi, 0.5, "PDE's two places have two authors");
    assert.deepEqual(
      dims.unmeasured, ["estimated_travel_intent"],
      "creator_concentration is measured now and must NOT still be named as unmeasured",
    );
    assert.equal(dims.estimatedTravelIntent, null, "the other axis is untouched and still unmeasurable");
    assert.equal(dims.legacy.categoryDistinct, 1, "the existing dimensions come through unchanged");
  });

  it("FAIL CLOSED: an unreadable author join leaves the axis UNMEASURED and reports no concentration at all", async () => {
    const { client } = authorClient({ error: { message: "boom" } });
    const dims = await compareShadowPagesWithCreators(client, legacy, pde);
    assert.equal(dims.creatorConcentration!.reason, "unreadable");
    assert.equal(dims.creatorConcentration!.legacy, null, "an unreadable join must report NO page figure");
    assert.equal(dims.creatorConcentration!.pde, null);
    assert.deepEqual(
      dims.unmeasured, ["creator_concentration", "estimated_travel_intent"],
      "an axis whose input could not be read is still unmeasured, and must stay NAMED",
    );
  });

  it("MUTATION GUARD: an unreadable join may report NEITHER 0 nor 1 concentration anywhere", async () => {
    const { client } = authorClient({ throws: true });
    const dims = await compareShadowPagesWithCreators(client, legacy, pde);
    const cc: any = dims.creatorConcentration;
    for (const page of ["legacy", "pde"] as const) {
      const p = cc[page];
      if (p === null) continue;
      assert.notEqual(p.hhi, 0, "an unreadable read reported as hhi 0 reads as 'this page had no concentration'");
      assert.notEqual(p.hhi, 1, "an unreadable read reported as hhi 1 reads as 'one author owned this page'");
      assert.notEqual(p.topCreatorShare, 0);
      assert.notEqual(p.topCreatorShare, 1);
      assert.notEqual(p.distinctCreators, 0);
      assert.notEqual(p.distinctCreators, 1);
    }
    assert.ok(
      cc.legacy === null && cc.pde === null,
      "and the only honest answer for a read that did not happen is no page figure at all",
    );
  });

  it("a measured join that resolves NOBODY is coverage 0 — distinguishable from the unreadable case above", async () => {
    const { client } = authorClient({ rows: [] });
    const dims = await compareShadowPagesWithCreators(client, legacy, pde);
    assert.equal(dims.creatorConcentration!.reason, "measured");
    assert.equal(dims.creatorConcentration!.legacy!.coverage, 0);
    assert.equal(dims.creatorConcentration!.legacy!.hhi, null, "measured-but-nobody is still not a concentration");
    assert.deepEqual(
      dims.unmeasured, ["estimated_travel_intent"],
      "the join RAN; the axis is measured, and its answer is 'this page had no resolvable author'",
    );
  });
});

describe("DV-79 — the WRITER stores it, inside pde_stages, with no new column", () => {
  it("stores creatorConcentration under the existing pde_stages.phase9 key", async () => {
    const { client, inserted } = authorClient({ rows: [{ id: P1, submitted_by: U1 }] });
    await logDiscoveryShadowServe(client, {
      ...BASE,
      legacyItems: [item(`db/${P1}`)],
      pdeItems: [item(`db/${P1}`)],
    });
    const stages = inserted[0].pde_stages;
    assert.equal(stages.portavaRank, true, "the existing pde_stages content must survive");
    assert.ok(stages.phase9.creatorConcentration, "a dimension nobody stores is one the report can never read");
    assert.equal(stages.phase9.creatorConcentration.reason, "measured");
    assert.equal(stages.phase9.creatorConcentration.legacy.hhi, 1);
    assert.deepEqual(stages.phase9.unmeasured, ["estimated_travel_intent"]);
    assert.deepEqual(
      Object.keys(inserted[0]).filter((k) => /creator/.test(k)), [],
      "no new COLUMN is added — the whole point of riding inside the existing jsonb",
    );
  });

  it("an unreadable author join still writes the row, degraded, and still names the axis unmeasured", async () => {
    const { client, inserted } = authorClient({ error: { message: "nope" } });
    await logDiscoveryShadowServe(client, {
      ...BASE,
      legacyItems: [item(`db/${P1}`)],
      pdeItems: [item(`db/${P1}`)],
    });
    const p9 = inserted[0].pde_stages.phase9;
    assert.equal(p9.creatorConcentration.reason, "unreadable");
    assert.deepEqual(p9.unmeasured, ["creator_concentration", "estimated_travel_intent"]);
  });
});

// ── Reader half ───────────────────────────────────────────────────────────────

function dims(over: Partial<ShadowPhase9Blob["legacy"]> = {}): ShadowPhase9Blob["legacy"] {
  return {
    n: 20, categoryDistinct: 4, categoryEntropy: 0.8, placeDistinct: 20,
    neighborhoodDistinct: 3, geoCellDistinct: 6, meanSavedCount: 10, savedCountCoverage: 1,
    ...over,
  };
}

function row(phase9: ShadowPhase9Blob | null): ShadowServeRow {
  return {
    serve_point: 1, sort_by: null, cohort_reason: "percent_in",
    page_size: 20, legacy_total: 40, pde_total: 40,
    overlap_count: 20, displaced_count: 0, top_changed: false,
    legacy_ms: 10, pde_ms: 30, pde_suppressed_writes: 0,
    pde_stages: phase9 ? { phase9 } : null,
  };
}

function blob(creator: ShadowPhase9Blob["creatorConcentration"]): ShadowPhase9Blob {
  return {
    legacy: dims(), pde: dims(),
    creatorConcentration: creator,
    estimatedTravelIntent: null,
    unmeasured: creator && creator.reason === "measured"
      ? ["estimated_travel_intent"]
      : ["creator_concentration", "estimated_travel_intent"],
  };
}

const measured = (hhiL: number | null, hhiP: number | null, covL = 1, covP = 1) => blob({
  reason: "measured" as const,
  legacy: { n: 20, resolved: covL * 20, coverage: covL, distinctCreators: hhiL === null ? null : 2, hhi: hhiL, topCreatorShare: hhiL },
  pde:    { n: 20, resolved: covP * 20, coverage: covP, distinctCreators: hhiP === null ? null : 2, hhi: hhiP, topCreatorShare: hhiP },
});

describe("DV-79 — aggregatePhase9 aggregates creator concentration", () => {
  it("means the concentration over the rows that MEASURED it, and counts the ones that could not", () => {
    const agg = aggregatePhase9([
      row(measured(1, 0.5)),
      row(measured(0.5, 0.5)),
      row(blob({ reason: "unreadable", legacy: null, pde: null })),
      row(blob(null)),   // written before the join existed — carries no axis at all
    ]);
    assert.ok(agg?.creatorConcentration);
    const cc = agg!.creatorConcentration!;
    assert.equal(cc.n, 2, "exactly two rows carried a measured concentration");
    assert.equal(
      cc.unreadable, 1,
      "one row CARRIED the axis and could not read it. The fourth carried no axis at all and is invisible " +
      "here, exactly as a missing phase9 blob is — 'the read failed' and 'this row predates the read' are " +
      "different facts and neither is a concentration",
    );
    assert.equal(cc.meanHhiLegacy, 0.75);
    assert.equal(cc.meanHhiPde, 0.5);
    assert.equal(cc.meanCoverageLegacy, 1);
  });

  it("a group where NO row could resolve an author reports null, never a concentration of zero", () => {
    const agg = aggregatePhase9([
      row(blob({ reason: "unreadable", legacy: null, pde: null })),
      row(blob({ reason: "no_client", legacy: null, pde: null })),
    ]);
    assert.equal(
      agg!.creatorConcentration, null,
      "no row measured it; a mean of zero would be a figure nobody produced",
    );
  });

  it("a measured page that resolved NOBODY contributes its coverage but no concentration", () => {
    const agg = aggregatePhase9([row(measured(null, 0.5, 0, 1))]);
    const cc = agg!.creatorConcentration!;
    assert.equal(cc.n, 1);
    assert.equal(cc.meanCoverageLegacy, 0);
    assert.equal(cc.meanHhiLegacy, null, "coverage 0 means no distribution to average, not an average of 0");
    assert.equal(cc.meanHhiPde, 0.5);
  });

  it("MUTATION GUARD: a row whose reason says UNREADABLE is excluded even if it carries figures", () => {
    // Defence in depth against a writer regression, not a hypothetical: M2 and
    // M3 of this pass are exactly the two shapes that produce such a row — a
    // failed read dressed as coverage-0 or as one-author-owns-the-page. The
    // reader must believe the REASON, not the numbers beside it, or a writer
    // bug becomes a reader-side measurement.
    const agg = aggregatePhase9([
      row(measured(0.5, 0.5)),
      row({
        ...blob({ reason: "unreadable", legacy: null, pde: null }),
        creatorConcentration: {
          reason: "unreadable",
          legacy: { n: 20, resolved: 20, coverage: 1, distinctCreators: 1, hhi: 1, topCreatorShare: 1 },
          pde:    { n: 20, resolved: 20, coverage: 1, distinctCreators: 1, hhi: 1, topCreatorShare: 1 },
        },
      }),
    ]);
    const cc = agg!.creatorConcentration!;
    assert.equal(cc.n, 1, "only the row that said it MEASURED may be in the denominator");
    assert.equal(cc.unreadable, 1);
    assert.equal(cc.meanHhiLegacy, 0.5, "0.75 would mean the failed read's fabricated 1 was averaged in");
  });

  it("the rows' own unmeasured list is still what the report prints — creator_concentration is gone from it", () => {
    const agg = aggregatePhase9([row(measured(1, 1))]);
    assert.deepEqual(agg!.unmeasured, ["estimated_travel_intent"]);
    const lines = formatPhase9(agg).join("\n");
    assert.match(lines, /creator conc/i, "the axis the writer measured must be PRINTED, or nothing reads it");
    assert.doesNotMatch(
      lines, /NOT measured\s+creator_concentration/,
      "and it must not still be listed as not measured",
    );
  });

  it("the printed report says the join did not happen, rather than printing a zero", () => {
    const agg = aggregatePhase9([row(blob({ reason: "unreadable", legacy: null, pde: null }))]);
    const lines = formatPhase9(agg).join("\n");
    assert.match(lines, /creator conc/i);
    assert.doesNotMatch(
      lines.split("\n").find((l) => /creator conc/i.test(l))!, /0\.00|1\.00/,
      "an unresolved join must not print a number a reader could quote as concentration",
    );
  });
});
