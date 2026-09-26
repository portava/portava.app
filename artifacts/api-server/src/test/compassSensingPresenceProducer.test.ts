/**
 * Decision #9's producer, and the consent scope that refuses it today.
 *
 * THE PROPERTY THIS FILE EXISTS FOR, stated once: a capability flag must not be
 * able to surface data whose contribution policy does not grant `surface`. The
 * flag is an operational switch; the scope is consent. Flipping the first must
 * never substitute for granting the second, and the order of the two gates in
 * `buildSensingPresenceContext` is what makes that true rather than intended.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SENSING_ANON_GRANTED_SCOPES,
  SENSING_ANON_POLICY_V1,
  type IntelligenceContributionPolicy,
} from "../lib/sensingContributionPolicy.js";
import { SENSING_PRESENCE_ZONE_CAP } from "../compass/CompassSensingPresence.js";
import {
  buildSensingPresenceContext,
  sensingSurfaceScopeGranted,
  SENSING_SURFACE_SCOPE,
  type SensingPresenceCohortRef,
} from "../compass/CompassSensingPresenceProducer.js";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const BUCKET = "2026-09-26T11:30:00.000Z";

function cohort(n: number): SensingPresenceCohortRef {
  return { zoneId: `zone-${n}`, timeBucket: BUCKET, cohortKey: `v1|zone-${n}|${BUCKET}`, reductionVersion: 1 };
}

/** A policy identical to the one in force except that `surface` IS granted. */
const SURFACING_POLICY = Object.freeze({
  ...SENSING_ANON_POLICY_V1,
  purposeScopes: [...SENSING_ANON_GRANTED_SCOPES, SENSING_SURFACE_SCOPE],
}) as IntelligenceContributionPolicy;

/** A client whose feature_flags answer is fixed and whose publication rows are supplied. */
function client(opts: { flagOn: boolean; rows?: any[]; readError?: string; onFrom?: (t: string) => void }) {
  return {
    from(table: string) {
      opts.onFrom?.(table);
      if (table === "feature_flags") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { enabled: opts.flagOn }, error: null }) }),
          }),
        };
      }
      // sensing_published_aggregates
      const result = opts.readError
        ? { data: null, error: { message: opts.readError } }
        : { data: opts.rows ?? [], error: null };
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        gt: () => chain,
        order: () => chain,
        limit: async () => result,
      };
      return chain;
    },
  };
}

function publishedRow(over: Record<string, unknown> = {}) {
  return {
    cohort_key: `v1|zone-1|${BUCKET}`,
    zone_id: "zone-1",
    time_bucket: BUCKET,
    reduction_version: 1,
    distinct_contributors: 22,
    distinct_groups: 6,
    max_group_share: 0.2,
    contribution_count: 22,
    median_signal_bucket: 3,
    observed_at: "2026-09-26T11:55:00.000Z",
    published_at: "2026-09-26T11:56:00.000Z",
    expires_at: "2026-09-27T11:56:00.000Z",
    ...over,
  };
}

describe("decision #9 — the surface scope is the gate, and it is not granted", () => {
  it("TRIPWIRE: `surface` is NOT in the policy in force", () => {
    // If this goes red, someone granted the scope. That is an owner act and a
    // product change: re-derive census-sensing S39 rather than editing this.
    assert.equal(SENSING_ANON_GRANTED_SCOPES.includes(SENSING_SURFACE_SCOPE), false);
    assert.deepEqual([...SENSING_ANON_GRANTED_SCOPES], ["collect", "retain", "aggregate"]);
  });

  it("the DEFAULT policy refuses — a caller that passes nothing gets no surface", () => {
    assert.equal(sensingSurfaceScopeGranted(), false);
    assert.equal(sensingSurfaceScopeGranted(SENSING_ANON_POLICY_V1), false);
    assert.equal(sensingSurfaceScopeGranted(SURFACING_POLICY), true);
  });

  it("the flag ON and a live publication present STILL render nothing while the scope is ungranted", async () => {
    const ctx = await buildSensingPresenceContext(
      client({ flagOn: true, rows: [publishedRow()] }) as never,
      [cohort(1)],
      { nowMs: NOW },
    );
    assert.deepEqual(ctx.lines, []);
    assert.deepEqual(ctx.states, []);
    assert.deepEqual(ctx.refusals, [{ zoneId: "zone-1", reason: "surface_scope_not_granted" }]);
  });

  it("an ungranted scope does not even TOUCH the database", async () => {
    const touched: string[] = [];
    await buildSensingPresenceContext(
      client({ flagOn: true, rows: [publishedRow()], onFrom: (t) => touched.push(t) }) as never,
      [cohort(1), cohort(2)],
      { nowMs: NOW },
    );
    // Not the flag, not the publication store. Consent is decided before either.
    assert.deepEqual(touched, []);
  });
});

describe("decision #9 — the producer's behaviour once the scope IS granted", () => {
  const granted = { nowMs: NOW, policy: SURFACING_POLICY };

  it("the capability flag still refuses on its own", async () => {
    const ctx = await buildSensingPresenceContext(
      client({ flagOn: false, rows: [publishedRow()] }) as never,
      [cohort(1)],
      granted,
    );
    assert.deepEqual(ctx.lines, []);
    assert.deepEqual(ctx.refusals, [{ zoneId: "zone-1", reason: "capability_off" }]);
  });

  it("a missing client refuses rather than throwing", async () => {
    const ctx = await buildSensingPresenceContext(null, [cohort(1)], granted);
    assert.deepEqual(ctx.lines, []);
    assert.deepEqual(ctx.refusals, [{ zoneId: "zone-1", reason: "capability_off" }]);
  });

  it("a live publication renders OBSERVED, with no person and no count", async () => {
    const ctx = await buildSensingPresenceContext(
      client({ flagOn: true, rows: [publishedRow()] }) as never,
      [cohort(1)],
      granted,
    );
    assert.equal(ctx.states.length, 1);
    assert.equal(ctx.states[0]!.presence, "observed");
    assert.equal(ctx.states[0]!.activityOrdinal, 3);
    assert.ok(ctx.lines.length >= 2, "a header and one zone line");

    const body = ctx.lines.join("\n");
    assert.match(body, /activity OBSERVED/);
    assert.match(body, /bucket 3 of 4/);
    assert.match(body, /names nobody/);
    // THE COUNT MUST NOT APPEAR. 22 contributors were published; the surface
    // gets an ordinal, never a headcount.
    assert.doesNotMatch(body, /22/);
    assert.doesNotMatch(body, /contributor/i);
  });

  it("a cohort with no live publication says NOT KNOWN — never quiet, never zero", async () => {
    const ctx = await buildSensingPresenceContext(
      client({ flagOn: true, rows: [] }) as never,
      [cohort(1)],
      granted,
    );
    assert.deepEqual(ctx.refusals, [{ zoneId: "zone-1", reason: "no_live_publication" }]);
    assert.equal(ctx.states[0]!.presence, "unknown");
    assert.equal(ctx.states[0]!.activityOrdinal, null);

    const body = ctx.lines.join("\n");
    assert.match(body, /NOT KNOWN/);
    assert.match(body, /Do not say it is quiet, empty or dead/);
    assert.doesNotMatch(body, /\b0\b/);
  });

  it("a FAILED read is kept apart from an empty one in the diagnostic, and identical on the surface", async () => {
    const failed = await buildSensingPresenceContext(
      client({ flagOn: true, readError: "connection reset" }) as never,
      [cohort(1)],
      granted,
    );
    const empty = await buildSensingPresenceContext(
      client({ flagOn: true, rows: [] }) as never,
      [cohort(1)],
      granted,
    );
    // Different operator facts …
    assert.deepEqual(failed.refusals, [{ zoneId: "zone-1", reason: "publication_unreadable" }]);
    assert.deepEqual(empty.refusals, [{ zoneId: "zone-1", reason: "no_live_publication" }]);
    // … and the surface cannot tell them apart, which is the point.
    assert.deepEqual(failed.lines, empty.lines);
  });

  it("the zone cap bounds the READS, not just the rendering", async () => {
    const touched: string[] = [];
    const many = Array.from({ length: SENSING_PRESENCE_ZONE_CAP + 4 }, (_, i) => cohort(i + 1));
    await buildSensingPresenceContext(
      client({ flagOn: true, rows: [], onFrom: (t) => touched.push(t) }) as never,
      many,
      granted,
    );
    const publicationReads = touched.filter((t) => t === "sensing_published_aggregates").length;
    assert.equal(publicationReads, SENSING_PRESENCE_ZONE_CAP);
  });

  it("no cohorts means no work and no lines", async () => {
    const touched: string[] = [];
    const ctx = await buildSensingPresenceContext(
      client({ flagOn: true, onFrom: (t) => touched.push(t) }) as never,
      [],
      granted,
    );
    assert.deepEqual(ctx.lines, []);
    assert.deepEqual(touched, []);
  });

  it("a malformed cohort ref is dropped before it can become a read", async () => {
    const touched: string[] = [];
    const ctx = await buildSensingPresenceContext(
      client({ flagOn: true, rows: [], onFrom: (t) => touched.push(t) }) as never,
      [{ zoneId: "", timeBucket: BUCKET, cohortKey: "k" }, { zoneId: "z", timeBucket: BUCKET, cohortKey: "" }] as never,
      granted,
    );
    assert.deepEqual(ctx.lines, []);
    assert.deepEqual(touched, []);
  });
});
