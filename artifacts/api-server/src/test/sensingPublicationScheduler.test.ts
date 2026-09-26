/**
 * S39 / S24 — the PUBLISHER, and the whole path from a cohort of contributions
 * to a line in a conversation, proven with the scope INJECTED through the seam
 * (census-sensing §26). The frozen policy is never edited: every case that
 * needs `surface` granted passes a granting policy to the functions that take
 * one, and the first case pins that the policy in force still refuses.
 *
 * RED WHEN: the scheduler reads the flag or the store before the scope; a
 * k-withheld cohort reaches the differencing gate or the store; a change
 * below the independent-group floor is recorded; an unreadable listing
 * publishes; the producer stops reading what the publisher recorded; or the
 * two modules stop agreeing on which scope a publication needs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runSensingPublicationPass,
  SENSING_PUBLICATION_FLAG,
  SENSING_PUBLICATION_SCOPE,
  SENSING_PUBLICATION_LOOKBACK_BUCKETS,
} from "../lib/sensingPublicationScheduler.js";
import {
  buildSensingPresenceContext,
  sensingCohortRefsForZones,
  SENSING_SURFACE_SCOPE,
} from "../compass/CompassSensingPresenceProducer.js";
import { SENSING_PRESENCE_HEADER, SENSING_PRESENCE_ZONE_CAP } from "../compass/CompassSensingPresence.js";
import {
  SENSING_ANON_GRANTED_SCOPES,
  SENSING_ANON_POLICY_V1,
  type IntelligenceContributionPolicy,
} from "../lib/sensingContributionPolicy.js";
import { sensingCohortKey, sensingTimeBucket, SENSING_TABLE } from "../lib/sensingAnonStore.js";
import { SENSING_PUBLISHED_TABLE } from "../lib/sensingDifferencingGate.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import { _resetSensingStorePresence } from "../lib/sensingAnonService.js";

type Row = Record<string, any>;

const NOW = new Date("2026-09-26T12:20:00.000Z");
const NOW_MS = NOW.getTime();
const BUCKET_MS = PRIVACY_THRESHOLD_V1.timeBucketMinutes * 60_000;
/** The previous bucket: old enough to be past the publication delay at NOW. */
const BUCKET = sensingTimeBucket(NOW_MS - BUCKET_MS);
const ZONE = "u4pruy";
const KEY = sensingCohortKey(ZONE, BUCKET, 1);

const GRANTING: IntelligenceContributionPolicy = Object.freeze({
  ...SENSING_ANON_POLICY_V1,
  purposeScopes: [...SENSING_ANON_GRANTED_SCOPES, SENSING_PUBLICATION_SCOPE],
}) as IntelligenceContributionPolicy;

/** `n` contributors in the cohort, each in their own attested group, observed a minute apart. */
const token = (prefix: string, i: number) => `${prefix}${String(i).padStart(4, "0")}`.padEnd(64, "0");
function contributions(n: number, over: Row = {}): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    contributor_token: token("t", i),
    rotation_epoch: 497000,
    group_token: token("g", i),
    zone_id: ZONE,
    time_bucket: BUCKET,
    cohort_key: KEY,
    signal_bucket: 2,
    reduction_version: 1,
    // Ten seconds apart, all inside the bucket's first few minutes: every row
    // is well past the publication delay at NOW, however many there are.
    created_at: new Date(Date.parse(BUCKET) + i * 10_000).toISOString(),
    expires_at: new Date(NOW_MS + 3_600_000).toISOString(),
    ...over,
  }));
}

/**
 * An in-memory PostgREST over the two sensing stores plus feature_flags.
 * Records every table touched, in order, so a case can assert what was NOT read.
 */
function db(opts: { flagOn?: boolean; contributions?: Row[]; publications?: Row[]; storeAbsent?: boolean; listingFails?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    feature_flags: [{ flag: SENSING_PUBLICATION_FLAG, enabled: opts.flagOn === true }, { flag: "sensing_presence_context_enabled", enabled: opts.flagOn === true }],
    [SENSING_TABLE]: opts.contributions ?? [],
    [SENSING_PUBLISHED_TABLE]: opts.publications ?? [],
  };
  const touched: string[] = [];
  function from(table: string) {
    touched.push(table);
    const rows = tables[table] ?? (tables[table] = []);
    let op: "select" | "insert" = "select";
    let payload: Row | null = null;
    let single = false;
    let head = false;
    let orderBy: [string, boolean] | null = null;
    let lim: number | null = null;
    let selectCount = false;
    const filters: Array<[string, string, any]> = [];
    const match = (r: Row) => filters.every(([k, c, v]) => {
      if (k === "eq") return r[c] === v;
      if (k === "gt") return r[c] > v;
      if (k === "gte") return r[c] >= v;
      return true;
    });
    const run = async () => {
      if (table === SENSING_TABLE && opts.storeAbsent) return { data: null, error: { code: "42P01", message: "relation does not exist" }, count: null };
      if (table === SENSING_TABLE && opts.listingFails && !selectCount && !head) return { data: null, error: { message: "listing failed" }, count: null };
      if (op === "insert") { rows.push({ id: `pub-${rows.length + 1}`, ...payload }); return { data: null, error: null, count: null }; }
      if (head) return { data: null, error: null, count: rows.length };
      let data = rows.filter(match).map((r) => ({ ...r }));
      if (orderBy) { const [c, asc] = orderBy; data.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)); }
      if (lim !== null) data = data.slice(0, lim);
      const out: any = { data: single ? data[0] ?? null : data, error: null };
      if (selectCount) out.count = rows.filter(match).length;
      return out;
    };
    const b: any = {
      select(_c?: string, o?: { head?: boolean; count?: string }) { op = "select"; head = o?.head === true; selectCount = o?.count === "exact"; return b; },
      insert(row: Row) { op = "insert"; payload = row; return b; },
      eq(c: string, v: any) { filters.push(["eq", c, v]); return b; },
      gt(c: string, v: any) { filters.push(["gt", c, v]); return b; },
      gte(c: string, v: any) { filters.push(["gte", c, v]); return b; },
      order(c: string, o?: { ascending?: boolean }) { orderBy = [c, o?.ascending !== false]; return b; },
      limit(n: number) { lim = n; return head ? run() : b; },
      maybeSingle() { single = true; return run(); },
      then(res: any, rej: any) { return run().then(res, rej); },
    };
    return b;
  }
  return { from, _tables: tables, _touched: touched };
}

function fresh() { _resetSensingStorePresence(); }

describe("the publisher's gates, in order", () => {
  it("TRIPWIRE: the policy in force still does not grant the scope; the scheduler and the producer gate on the SAME scope", () => {
    assert.equal(SENSING_ANON_GRANTED_SCOPES.includes(SENSING_PUBLICATION_SCOPE), false);
    assert.equal(SENSING_PUBLICATION_SCOPE, SENSING_SURFACE_SCOPE);
  });

  it("the DEFAULT policy refuses BEFORE any client exists: nothing is touched, not even the flag", async () => {
    fresh();
    const d = db({ flagOn: true, contributions: contributions(20) });
    const r = await runSensingPublicationPass({ client: d, now: NOW });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "surface_scope_not_granted");
    assert.deepEqual(d._touched, []);
    assert.equal(d._tables[SENSING_PUBLISHED_TABLE].length, 0);
  });

  it("an explicit null client is 'no client', never the service client", async () => {
    const r = await runSensingPublicationPass({ client: null, now: NOW, policy: GRANTING });
    assert.equal(r.reason, "no_client");
  });

  it("the scope granted and the flag OFF: refused at the flag, and the store is not read", async () => {
    fresh();
    const d = db({ flagOn: false, contributions: contributions(20) });
    const r = await runSensingPublicationPass({ client: d, now: NOW, policy: GRANTING });
    assert.equal(r.reason, "capability_off");
    assert.deepEqual(d._touched, ["feature_flags"]);
  });

  it("the store absent (production today): an inert pass, no publication attempted", async () => {
    fresh();
    const d = db({ flagOn: true, storeAbsent: true });
    const r = await runSensingPublicationPass({ client: d, now: NOW, policy: GRANTING });
    assert.equal(r.reason, "store_absent");
    assert.equal(d._touched.includes(SENSING_PUBLISHED_TABLE), false);
  });

  it("an unreadable cohort listing is a SKIP, not an empty pass — nothing is published on 'we could not look'", async () => {
    fresh();
    const d = db({ flagOn: true, contributions: contributions(20), listingFails: true });
    const r = await runSensingPublicationPass({ client: d, now: NOW, policy: GRANTING });
    assert.equal(r.reason, "cohorts_unreadable");
    assert.equal(d._tables[SENSING_PUBLISHED_TABLE].length, 0);
  });
});

describe("what one pass publishes, and what it refuses", () => {
  it("a cohort above k, in independent groups, past the publication delay: ONE publication, recorded with no contributor column", async () => {
    fresh();
    const d = db({ flagOn: true, contributions: contributions(20) });
    const r = await runSensingPublicationPass({ client: d, now: NOW, policy: GRANTING });
    assert.equal(r.skipped, false);
    assert.equal(r.cohorts, 1);
    assert.equal(r.published, 1);
    assert.deepEqual(r.publishedBy, { no_previous: 1 });
    const pubs = d._tables[SENSING_PUBLISHED_TABLE];
    assert.equal(pubs.length, 1);
    assert.equal(pubs[0].cohort_key, KEY);
    assert.equal(pubs[0].zone_id, ZONE);
    assert.equal(pubs[0].distinct_contributors, 20);
    assert.equal(pubs[0].distinct_groups, 20);
    for (const col of Object.keys(pubs[0])) assert.doesNotMatch(col, /token|actor|user|device|contributor_id/);
  });

  it("a cohort BELOW k is withheld: the differencing gate is not consulted and no row exists to say it was suppressed", async () => {
    fresh();
    const d = db({ flagOn: true, contributions: contributions(PRIVACY_THRESHOLD_V1.minUniqueActors - 1) });
    const r = await runSensingPublicationPass({ client: d, now: NOW, policy: GRANTING });
    assert.equal(r.withheld, 1);
    assert.equal(r.published, 0);
    assert.equal(d._tables[SENSING_PUBLISHED_TABLE].length, 0);
    assert.equal(d._touched.filter((t) => t === SENSING_PUBLISHED_TABLE).length, 0);
  });

  it("a cohort whose contributors are all ONE group is withheld by the independence gate, not published", async () => {
    fresh();
    const d = db({ flagOn: true, contributions: contributions(20, { group_token: "g".padEnd(64, "0") }) });
    const r = await runSensingPublicationPass({ client: d, now: NOW, policy: GRANTING });
    assert.equal(r.withheld, 1);
    assert.equal(d._tables[SENSING_PUBLISHED_TABLE].length, 0);
  });

  it("S24: a second pass whose change is below the independent-group floor is NOT recorded; one at the floor is", async () => {
    fresh();
    const d = db({ flagOn: true, contributions: contributions(20) });
    await runSensingPublicationPass({ client: d, now: NOW, policy: GRANTING });
    assert.equal(d._tables[SENSING_PUBLISHED_TABLE].length, 1);

    // +2 contributors: below minIndependentGroups (5). The previous publication stands.
    d._tables[SENSING_TABLE].push(...contributions(22).slice(20));
    const r2 = await runSensingPublicationPass({ client: d, now: new Date(NOW_MS + 60_000), policy: GRANTING });
    assert.equal(r2.belowMinimum, 1);
    assert.equal(r2.published, 0);
    assert.equal(d._tables[SENSING_PUBLISHED_TABLE].length, 1);

    // +5 in total: at the floor. Recorded.
    d._tables[SENSING_TABLE].push(...contributions(25).slice(22));
    const r3 = await runSensingPublicationPass({ client: d, now: new Date(NOW_MS + 120_000), policy: GRANTING });
    assert.equal(r3.published, 1);
    assert.deepEqual(r3.publishedBy, { delta_at_least_minimum: 1 });
    assert.equal(d._tables[SENSING_PUBLISHED_TABLE].length, 2);
    assert.equal(d._tables[SENSING_PUBLISHED_TABLE][1].distinct_contributors, 25);
  });

  it("the lookback is the current and the previous bucket; an older cohort is not re-read", async () => {
    fresh();
    const older = sensingTimeBucket(NOW_MS - SENSING_PUBLICATION_LOOKBACK_BUCKETS * BUCKET_MS);
    const d = db({
      flagOn: true,
      contributions: [
        ...contributions(20),
        ...contributions(20, { time_bucket: older, cohort_key: sensingCohortKey(ZONE, older, 1) }),
      ],
    });
    const r = await runSensingPublicationPass({ client: d, now: NOW, policy: GRANTING });
    assert.equal(r.cohorts, 1);
    assert.equal(d._tables[SENSING_PUBLISHED_TABLE].length, 1);
    assert.equal(d._tables[SENSING_PUBLISHED_TABLE][0].time_bucket, BUCKET);
  });

  it("two zones in the window are two cohorts, published independently", async () => {
    fresh();
    const other = "u4pruz";
    const d = db({
      flagOn: true,
      contributions: [
        ...contributions(20),
        ...contributions(20, { zone_id: other, cohort_key: sensingCohortKey(other, BUCKET, 1) }).map((r, i) => ({ ...r, contributor_token: token("o", i) })),
      ],
    });
    const r = await runSensingPublicationPass({ client: d, now: NOW, policy: GRANTING });
    assert.equal(r.cohorts, 2);
    assert.equal(r.published, 2);
    assert.deepEqual(d._tables[SENSING_PUBLISHED_TABLE].map((p) => p.zone_id).sort(), [ZONE, other].sort());
  });
});

describe("END TO END — publisher to conversation, with the scope injected through the seam", () => {
  it("what the publisher recorded is exactly what the producer renders: OBSERVED for the zone, no person, no count", async () => {
    fresh();
    const d = db({ flagOn: true, contributions: contributions(20) });
    const pass = await runSensingPublicationPass({ client: d, now: NOW, policy: GRANTING });
    assert.equal(pass.published, 1);

    // The route's half: the device's own zone → the cohort refs of the current
    // and previous bucket → the producer, which reads ONLY the publication store.
    const refs = sensingCohortRefsForZones([ZONE], NOW_MS);
    assert.equal(refs.length, 2);
    assert.ok(refs.some((r) => r.cohortKey === KEY), "the previous bucket's key is among the refs");
    const touchedBefore = d._touched.length;
    const ctx = await buildSensingPresenceContext(d as never, refs, { nowMs: NOW_MS, policy: GRANTING });
    const touchedByProducer = d._touched.slice(touchedBefore);
    assert.equal(touchedByProducer.includes(SENSING_TABLE), false, "the producer never touches the contribution store");

    assert.equal(ctx.lines[0], SENSING_PRESENCE_HEADER);
    const observed = ctx.states.find((s) => s.presence === "observed");
    assert.ok(observed, `one bucket is observed: ${JSON.stringify(ctx.states.map((s) => [s.timeBucket, s.presence]))}`);
    assert.equal(observed!.zoneId, ZONE);
    const rendered = ctx.lines.join("\n");
    assert.doesNotMatch(rendered, /t0{60}|g0{60}|20 (people|contributors)|contributor/i);
    assert.match(rendered, /no person|k-gated/i);
  });

  it("the SAME world with the policy in force: the publisher writes nothing and the producer renders nothing — both refuse on the scope", async () => {
    fresh();
    const d = db({ flagOn: true, contributions: contributions(20) });
    const pass = await runSensingPublicationPass({ client: d, now: NOW });
    assert.equal(pass.reason, "surface_scope_not_granted");
    const ctx = await buildSensingPresenceContext(d as never, sensingCohortRefsForZones([ZONE], NOW_MS), { nowMs: NOW_MS });
    assert.deepEqual(ctx.lines, []);
    assert.ok(ctx.refusals.every((r) => r.reason === "surface_scope_not_granted"));
    assert.equal(d._tables[SENSING_PUBLISHED_TABLE].length, 0);
  });

  it("a withheld cohort leaves the conversation saying NOT KNOWN, never quiet and never zero", async () => {
    fresh();
    const d = db({ flagOn: true, contributions: contributions(4) });
    await runSensingPublicationPass({ client: d, now: NOW, policy: GRANTING });
    const ctx = await buildSensingPresenceContext(d as never, sensingCohortRefsForZones([ZONE], NOW_MS), { nowMs: NOW_MS, policy: GRANTING });
    assert.ok(ctx.states.length > 0);
    assert.ok(ctx.states.every((s) => s.presence === "unknown"));
    // The formatter's unknown line FORBIDS the inverse reading in so many words
    // ("Do not say it is quiet, empty or dead"); what must never appear is an
    // affirmative quiet, a zero, or a count.
    const rendered = ctx.lines.join("\n");
    assert.match(rendered, /not known|no coverage/i);
    assert.match(rendered, /do not say it is quiet/i, "the inverse reading is forbidden in so many words");
    assert.doesNotMatch(rendered, /\b4 (people|contributors)\b|\b0 (people|contributors)\b|\bquiet\.$/im);
  });
});

describe("sensingCohortRefsForZones — the turn's zone identity, pure and bounded", () => {
  it("one zone → the current and the previous bucket, keyed exactly as the writer keys them", () => {
    const refs = sensingCohortRefsForZones([ZONE], NOW_MS);
    const cur = sensingTimeBucket(NOW_MS);
    assert.deepEqual(refs.map((r) => r.timeBucket), [cur, BUCKET]);
    assert.deepEqual(refs.map((r) => r.cohortKey), [sensingCohortKey(ZONE, cur, 1), KEY]);
    assert.ok(refs.every((r) => r.reductionVersion === 1 && r.zoneId === ZONE));
  });

  it("bounds the READS by the zone cap: never more refs than the cap, duplicates and blanks dropped", () => {
    const refs = sensingCohortRefsForZones(["a", "a", " ", "b", "c", "d", "e", "f"], NOW_MS);
    assert.ok(refs.length <= SENSING_PRESENCE_ZONE_CAP);
    assert.deepEqual([...new Set(refs.map((r) => r.zoneId))], ["a", "b"]);
  });

  it("nothing in, nothing out; a non-finite instant yields no ref rather than a bad key", () => {
    assert.deepEqual(sensingCohortRefsForZones(null, NOW_MS), []);
    assert.deepEqual(sensingCohortRefsForZones([], NOW_MS), []);
    assert.deepEqual(sensingCohortRefsForZones([ZONE], Number.NaN), []);
    assert.deepEqual(sensingCohortRefsForZones(["x".repeat(65)], NOW_MS), []);
  });
});
