/**
 * §22 Table 30 — commercial disclosure, end to end.
 *
 * "Venue brigading → Affiliation disclosure … official/community separation."
 * A contributor who has DISCLOSED a commercial relationship to the subject is
 * not an independent community reporter about it, so a disclosed-commercial
 * observation must never count toward independent community consensus.
 *
 * This file pins the seam in the order it would hurt:
 *   1. the disclosure → source-class mapping (the "separation");
 *   2. writeObservation stores the disclosure AND records it under the
 *      NON_INDEPENDENT source class, fail-closed to 'none' for junk;
 *   3. the consensus consequence — a claim derived from a disclosed-commercial
 *      observation gets NO community-consensus / cohort badge (the exact rule
 *      the read model already enforces via mayCountAsConsensus).
 *
 * Runs in memory against a fake client (mirrors intelCapture.test.ts). Nothing
 * on the path under test is mocked: writeObservation, the real disclosure
 * mapping, and the real toLiveClaimEnvelope are the shipping implementations.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeObservation } from "../services/intel/IntelCaptureService.js";
import {
  COMMERCIAL_DISCLOSURES,
  NON_INDEPENDENT_SOURCE_CLASSES,
  disclosureSourceClass,
  isCommercialDisclosure,
  mayCountAsConsensus,
  type CommercialDisclosure,
  type SourceClass,
} from "../lib/intelContracts.js";
import { toLiveClaimEnvelope, type LiveClaim } from "../lib/liveClaimRead.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const PLACE = "22222222-2222-4222-8222-222222222222";
const NOW = new Date();
const OBSERVED = new Date(Date.now() - 5 * 60_000).toISOString();

function makeDb(flags: Record<string, boolean>, opts: { places?: string[]; consent?: boolean } = {}) {
  const tables: Record<string, any[]> = { intel_observations: [] };
  const places = new Set(opts.places ?? []);
  const consent = opts.consent ?? true;
  let seq = 0;
  function from(table: string) {
    let op: "select" | "insert" | "insert_select" = "select";
    let payload: any = null;
    const filters: [string, any, string?][] = [];
    const match = (row: any) => filters.every(([c, v, kind]) => (kind === "in" ? (v as any[]).includes(row[c]) : row[c] === v));
    function run() {
      if (table === "feature_flags") {
        const flag = filters.find(([c]) => c === "flag")?.[1];
        return { data: { enabled: Boolean(flags[flag]) }, error: null };
      }
      if (table === "places") {
        const id = filters.find(([c]) => c === "id")?.[1];
        return { data: places.has(id) ? { id } : null, error: null };
      }
      if (table === "intel_contribution_consent") {
        return consent ? { data: { enabled: true, withdrawn_at: null }, error: null } : { data: null, error: null };
      }
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert" || op === "insert_select") {
        const row = { id: `row-${++seq}`, schema_version: 1, ...payload };
        if (table === "intel_observations" && store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key))
          return { data: null, error: { code: "23505", message: "dup" } };
        store.push(row);
        return { data: op === "insert_select" ? row : null, error: null };
      }
      return { data: store.filter(match)[0] ?? null, error: null };
    }
    const b: any = {
      select() { op = op === "insert" ? "insert_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(c: string, v: any) { filters.push([c, v]); return b; },
      in(c: string, v: any[]) { filters.push([c, v, "in"]); return b; },
      is(c: string, v: any) { filters.push([c, v]); return b; },
      maybeSingle() { return Promise.resolve(run()); },
      single() { return Promise.resolve(run()); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }
  return { from, _tables: tables };
}

const baseInput = (over: Record<string, unknown> = {}) => ({
  subjectId: PLACE,
  claimType: "crowd.level",
  value: { level: "busy" as const },
  observedAt: OBSERVED,
  idempotencyKey: `obs-${Math.random().toString(36).slice(2)}`,
  ...over,
});

describe("§22 disclosure → epistemic standing (the official/community separation)", () => {
  it("'none' keeps the honest firsthand default; every commercial disclosure → sponsored", () => {
    assert.equal(isCommercialDisclosure("none"), false);
    assert.equal(disclosureSourceClass("none"), "firsthand_unverified");
    for (const d of COMMERCIAL_DISCLOSURES) {
      if (d === "none") continue;
      assert.equal(isCommercialDisclosure(d), true, `${d} is a commercial disclosure`);
      assert.equal(disclosureSourceClass(d), "sponsored", `${d} → sponsored`);
    }
  });

  it("every disclosed-commercial source class is NON_INDEPENDENT (never independent consensus)", () => {
    for (const d of COMMERCIAL_DISCLOSURES) {
      const cls = disclosureSourceClass(d);
      const shouldCount = d === "none";
      assert.equal(mayCountAsConsensus(cls), shouldCount, `${d}: mayCountAsConsensus`);
    }
    assert.ok((NON_INDEPENDENT_SOURCE_CLASSES as readonly SourceClass[]).includes("sponsored"));
  });
});

describe("§22 writeObservation stores the disclosure and its source class", () => {
  it("records a disclosed 'owner' observation under sponsored, with commercial_disclosure='owner'", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    const r = await writeObservation(db as any, ACTOR, baseInput({ commercialDisclosure: "owner" }) as any);
    assert.equal(r.ok, true);
    const obs = (r as any).observation;
    assert.equal(obs.commercial_disclosure, "owner");
    assert.equal(obs.source_class, "sponsored");
  });

  it("an omitted disclosure stays 'none' + firsthand (unchanged default)", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    const r = await writeObservation(db as any, ACTOR, baseInput() as any);
    assert.equal(r.ok, true);
    const obs = (r as any).observation;
    assert.equal(obs.commercial_disclosure, "none");
    assert.equal(obs.source_class, "firsthand_unverified");
  });

  it("a junk disclosure fails closed to 'none' (never trusted)", async () => {
    const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
    const r = await writeObservation(db as any, ACTOR, baseInput({ commercialDisclosure: "totally_legit" }) as any);
    assert.equal(r.ok, true);
    const obs = (r as any).observation;
    assert.equal(obs.commercial_disclosure, "none");
    assert.equal(obs.source_class, "firsthand_unverified");
  });

  it("each commercial disclosure round-trips to a sponsored, non-consensus observation", async () => {
    for (const d of COMMERCIAL_DISCLOSURES) {
      const db = makeDb({ intel_capture_quick_signal: true }, { places: [PLACE] });
      const r = await writeObservation(db as any, ACTOR, baseInput({ commercialDisclosure: d }) as any);
      assert.equal(r.ok, true, `${d} should write`);
      const obs = (r as any).observation;
      assert.equal(obs.commercial_disclosure, d);
      assert.equal(mayCountAsConsensus(obs.source_class as SourceClass), d === "none");
    }
  });
});

describe("§22 consensus consequence — the read model withholds a cohort badge", () => {
  const claim = (sourceClass: SourceClass): LiveClaim => ({
    id: "snap-1",
    claimType: "crowd.level",
    value: { level: "busy" },
    confidence: 0.8,
    band: "live",
    sourceClass,
    sourceCount: 40, // well above the k-anon floor — a bucket WOULD show if allowed
    observedAt: NOW.toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  it("a disclosed-commercial claim (sponsored) shows NO source-count bucket", () => {
    for (const d of COMMERCIAL_DISCLOSURES) {
      const env = toLiveClaimEnvelope(claim(disclosureSourceClass(d as CommercialDisclosure)));
      if (d === "none") {
        assert.notEqual(env.sourceCountBucket, null, "an undisclosed firsthand claim keeps its cohort bucket");
      } else {
        assert.equal(env.sourceCountBucket, null, `${d}: a disclosed-commercial claim must not imply a crowd`);
      }
    }
  });
});
