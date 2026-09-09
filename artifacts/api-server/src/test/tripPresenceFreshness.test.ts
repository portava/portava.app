/**
 * §10 presence — freshness (§10.2) and observation ordering (§10.1/§10.2).
 *
 * The rule both halves serve: "The Trip Map must never draw a stale location as
 * if it were current." Two distinct ways that gets broken, and the two
 * migrations that close them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fresh = readFileSync(new URL("../migrations/2776_trip_presence_freshness_and_ordering.sql", import.meta.url), "utf8");
const order = readFileSync(new URL("../migrations/2777_trip_kernel_presence_ordering.sql", import.meta.url), "utf8");
const vocab = readFileSync(new URL("../migrations/2767_trip_presence_spec_vocabulary.sql", import.meta.url), "utf8");

describe("§10.2 freshness is computed ONCE", () => {
  it("carries all four states and no others", () => {
    const states = [...fresh.matchAll(/THEN '([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(states)].sort(),
      ["last_known", "live", "offline", "recent"]);
  });

  it("is IMMUTABLE, so two readers cannot get different answers for one instant", () => {
    assert.match(fresh, /RETURNS text\nLANGUAGE sql\nIMMUTABLE/);
  });

  it("derives the boundaries from the row's own TTL, not from constants", () => {
    // A presence a client declared short-lived should go stale quickly and one
    // declared long-lived should not — that is what a TTL is for.
    assert.match(fresh, /\(p_expires_at - p_observed_at\) \/ 4/);
    assert.match(fresh, /p_expires_at \+ \(p_expires_at - p_observed_at\)/);
    assert.ok(!/interval '\d+ minutes'/.test(fresh),
      "a fixed threshold has crept in, so the TTL no longer means anything");
  });

  it("says the thresholds are an interpretation", () => {
    assert.match(fresh, /§10\.2 names the four states and does not say what separates them/);
  });

  it("fails CLOSED: any null reads as offline, never live", () => {
    assert.match(fresh, /WHEN p_observed_at IS NULL OR p_expires_at IS NULL OR p_at IS NULL THEN 'offline'/);
    assert.match(fresh, /a null % does not read as offline/);
  });

  it("an expires_at at or before observed_at is offline, not a negative TTL", () => {
    assert.match(fresh, /WHEN p_expires_at <= p_observed_at THEN 'offline'/);
  });
});

describe("the read surface labels rather than filters", () => {
  it("the view has no WHERE, and a postcondition enforces that", () => {
    // A filtered-out row cannot say "we knew an hour ago" instead of "we never
    // knew", and §10.4 depends on that distinction.
    assert.match(fresh, /the view filters rows\. An expired presence must be LABELLED offline, not hidden/);
    const viewDef = fresh.slice(fresh.indexOf("CREATE VIEW public.trip_presence_current"),
                                fresh.indexOf("COMMENT ON VIEW"));
    assert.ok(!/\bWHERE\b/.test(viewDef), "the view filters");
  });

  it("exposes freshness, expired and age beside the row", () => {
    for (const col of ["freshness", "expired", "observed_seconds_ago"]) {
      assert.ok(fresh.includes(col), `${col} is not exposed`);
    }
  });

  it("is not readable by anon", () => {
    assert.match(fresh, /REVOKE ALL ON public\.trip_presence_current FROM PUBLIC, anon, authenticated;/);
    assert.match(fresh, /anon can read presence/);
  });
});

describe("§10.2 ordering — a delayed observation must not win", () => {
  it("the upsert compares observed_at", () => {
    assert.match(order, /WHERE EXCLUDED\.observed_at >= public\.trip_presence\.observed_at/);
  });

  it("uses >= so a same-instant CORRECTION is not silently dropped", () => {
    // Two observations at one instant are one observation for ordering, and the
    // later WRITE should win: a client correcting a state it reported a moment
    // ago must not be ignored.
    // Asserted POSITIVELY. A negative regex here matched the migration's own
    // postcondition, which quotes the strictly-greater form in order to refuse
    // it — the guard against the mistake looks exactly like the mistake.
    // Bounded to the REPLACEMENT text alone. An unbounded slice ran to the end
    // of the file and picked up the postcondition's own quoted copy of the
    // string, so a mutated guard still matched and the test passed on it.
    const start = order.indexOf("2777 / §10.2");
    assert.ok(start > 0, "the installed guard's comment is missing");
    const end = order.indexOf("$a$);", start);
    assert.ok(end > start, "could not find the end of the replacement block");
    const installed = order.slice(start, end);
    assert.match(installed, /WHERE EXCLUDED\.observed_at >= public\.trip_presence\.observed_at;/,
      "the guard that gets INSTALLED is not the >= form");
    assert.ok(!/observed_at > public\.trip_presence/.test(installed),
      "the installed guard is strictly-greater; a same-instant correction would be dropped");
    assert.match(order, /a same-instant correction would be ignored/,
      "nothing refuses a strictly-greater guard at apply time");
  });

  it("an ignored write SUCCEEDS with applied:false, rather than failing", () => {
    // The client did nothing wrong. Retrying is correct behaviour and is what
    // produced the duplicate; a refusal would push clients toward not retrying.
    assert.match(order, /'applied', v_presence_applied/);
    assert.match(order, /'STALE_OBSERVATION'/);
    assert.ok(!/'reason', 'TRIP_PRESENCE_STALE'/.test(order),
      "an ignored write is being returned as a refusal");
  });

  it("adds no command branch — it changes one that exists", () => {
    assert.match(order, /the transform changed the command branch count by %, expected 0/);
  });
});

describe("the vocabulary the freshness is about is the spec's", () => {
  it("2767 put §10.1's eight states in place, and 2776 reads rows written with them", () => {
    for (const s of ["available", "free", "getting_ready", "transiting",
                     "at_plan", "resting", "returning", "offline"]) {
      assert.ok(vocab.includes(`'${s}'`), `§10.1 state ${s} is missing`);
    }
  });

  it("'offline' is both a presence STATE and a freshness LABEL, and they are different things", () => {
    // A traveller can declare themselves offline while their observation is
    // fresh; an observation can go stale while the last state was 'at_plan'.
    // Conflating them would report someone as offline because their phone
    // stopped reporting, which is a claim about the network, not the person.
    assert.match(fresh, /'offline'/);
    assert.match(vocab, /'offline'/);
    assert.match(fresh, /freshness/);
  });
});
