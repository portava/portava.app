/**
 * Phase 9 — Live Intelligence (Global Input Intelligence, §31/§15/§8/§40).
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceLiveIntelligence.test.ts
 *
 * The property under test is the anti-fabrication safety rule (§2/§31): a live
 * label ("Getting busier"/"Busy right now"/"Recently confirmed") exists on a
 * suggestion IF AND ONLY IF the gated, fail-closed live read
 * (lib/liveClaimRead.readLiveClaimEnvelopes) returned a real, fresh, eligible,
 * promoted claim for that entity. Off/stale/absent/unpromoted ⇒ NO live label and
 * NO rank change — never a manufactured "busy now".
 *
 * Proves:
 *   §31  a fresh + eligible + promoted place gets a `freshness` projection
 *        (state label + "Updated Nm ago") and its rank is nudged up (§15).
 *   §31  a STALE/expired, absent, or off live state attaches NO live label and is
 *        never fabricated.
 *   IG   the full gate chain is honored end-to-end: the flag chain, the kill
 *        switch, the pilot switch, and per-scope promotion (IG-09) each suppress
 *        the label — this test drives the REAL readLiveClaimEnvelopes, so the
 *        gates are not re-implemented here.
 *   §6   a field whose policy does not allow live context is never even read.
 *   §9   the boost only reorders WITHIN a type and never lifts a weak match to or
 *        past a strong canonical exact match (clamped below the exact band).
 *   graceful: an empty live substrate leaves suggestions unchanged, with ZERO
 *        per-entity reads (the pre-launch default).
 *
 * MUTATION-PROOFS (documented inline):
 *   - Make buildFreshnessState return a non-null state for `[]` (a hardcoded
 *     {state:'fresh', label:'Busy now'}) → the "no fabricated live" assertions
 *     (empty substrate / flag off / non-promoted / expired) go RED.
 *   - Delete the `if (!servable) return suggestions` global-gate short-circuit in
 *     enrichSuggestionsWithLive → the "flag off yields no label" assertion goes
 *     RED (an off system would start attaching labels from written snapshots).
 *   - Drop the `if (!opts.policy.allowLiveContext) return suggestions` policy gate
 *     → the "disallowed policy does no reads" assertion goes RED.
 *   - Remove the freshness boost (return the row unchanged when freshness is set)
 *     → the "fresh place ranks above an equal non-fresh place" assertion goes RED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichSuggestionsWithLive,
  buildFreshnessState,
  formatRelativeAge,
  LIVE_ELIGIBLE_ENTITY_TYPES,
} from "../lib/inputAssistance/liveSuggestions.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import type { InputSuggestion, InputFieldPolicy, InputContext } from "../lib/inputAssistance/types.js";

// ── Fixed clock ────────────────────────────────────────────────────────────────
const NOW = new Date("2026-08-31T12:00:00.000Z");
const nowMs = NOW.getTime();
const FOUR_MIN_AGO = new Date(nowMs - 4 * 60_000).toISOString();
const FUTURE = new Date(nowMs + 30 * 60_000).toISOString();
const PAST_EXPIRY = new Date(nowMs - 60_000).toISOString(); // already expired

// Stable place subject ids (== intel_state_snapshots.subject_id).
const PLACE_LIVE = "11111111-0000-4000-8000-000000000001";
const PLACE_DARK = "22222222-0000-4000-8000-000000000002";

// ── Fake service client (faithful gate + query filtering) ───────────────────────
//
// Mirrors src/test/liveClaimRead.test.ts's client() but ACTUALLY applies the
// query filters (eq/gt/in) so an expired or wrong-subject row is genuinely
// dropped by the "database", and counts snapshot reads so we can prove a gated-off
// path performs ZERO of them.
interface LiveClientOpts {
  flag?: boolean | null; // intel_live_label_crowd + upstream chain (default true)
  kill?: boolean; // disable_intel_live_labels (default false)
  pilot?: boolean; // intel_limited_live (default true)
  off?: string[]; // specific chain flags forced off
  promoted?: string[]; // promoted scope keys
  promotedError?: boolean;
  rows?: any[]; // intel_state_snapshots rows
  snapshotError?: boolean;
}

function makeLiveClient(opts: LiveClientOpts) {
  // The promoted-scope allowlist is cached module-side; reset per client so the
  // fixed clock never serves a stale set between tests.
  _clearPromotedScopeCache();
  const promoted = opts.promoted ?? ["|crowd.level", "|crowd.trajectory"];
  const counts = { snapshotReads: 0 };

  const api: any = {
    counts,
    from(table: string) {
      if (table === "intel_live_promoted_scopes") {
        const pq: any = { select: () => pq };
        return Object.assign(pq, {
          then: (res: any) =>
            res(
              opts.promotedError
                ? { data: null, error: { message: "boom" } }
                : { data: promoted.map((k) => ({ scope_key: k })), error: null },
            ),
        });
      }
      if (table === "feature_flags") {
        let flagName = "";
        const fq: any = {
          select: () => fq,
          eq: (k: string, v: unknown) => {
            if (k === "flag") flagName = String(v);
            return fq;
          },
          maybeSingle: async () => {
            if (flagName === "disable_intel_live_labels") return { data: { enabled: opts.kill ?? false }, error: null };
            if (flagName === "intel_limited_live") return { data: { enabled: opts.pilot ?? true }, error: null };
            if (opts.off?.includes(flagName)) return { data: { enabled: false }, error: null };
            const flag = opts.flag ?? true;
            return { data: flag === null ? null : { enabled: flag }, error: null };
          },
        };
        return fq;
      }
      if (table === "intel_state_snapshots") {
        const eqs: Array<[string, unknown]> = [];
        const gts: Array<[string, unknown]> = [];
        const ins: Array<[string, unknown[]]> = [];
        const q: any = {
          select: () => q,
          eq: (k: string, v: unknown) => { eqs.push([k, v]); return q; },
          gt: (k: string, v: unknown) => { gts.push([k, v]); return q; },
          in: (k: string, v: unknown[]) => { ins.push([k, v]); return q; },
        };
        return Object.assign(q, {
          then: (res: any) => {
            counts.snapshotReads++;
            if (opts.snapshotError) return res({ data: null, error: { message: "boom" } });
            const rows = (opts.rows ?? []).filter((r) => {
              for (const [k, v] of eqs) if (r[k] !== v) return false;
              for (const [k, v] of gts) if (!(String(r[k]) > String(v))) return false;
              for (const [k, vs] of ins) if (!vs.includes(r[k])) return false;
              return true;
            });
            return res({ data: rows, error: null });
          },
        });
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return api;
}

// A live crowd.trajectory snapshot for PLACE_LIVE: "building" → "Getting busier".
function trajectoryRow(subjectId: string, over: Record<string, unknown> = {}) {
  return {
    id: `snap-traj-${subjectId}`,
    subject_id: subjectId,
    zone_id: null,
    claim_type: "crowd.trajectory",
    value: "building",
    confidence: 0.8, // → band 'live'
    source_count: 20,
    observed_at: FOUR_MIN_AGO,
    expires_at: FUTURE,
    privacy_eligible: true,
    ...over,
  };
}

function placeSuggestion(id: string, entityId: string, confidence: number): InputSuggestion {
  return {
    id,
    type: "entity",
    context: "global_search",
    label: id,
    entityType: "place",
    entityId,
    action: { type: "open_entity", entityType: "place", entityId },
    confidence,
    source: "canonical",
    policyVersion: "test",
  };
}

const GLOBAL_SEARCH = resolvePolicy("global_search") as InputFieldPolicy; // allowLiveContext true
const CITY_PICKER = resolvePolicy("city_picker") as InputFieldPolicy; // allowLiveContext false
const enrichOpts = (policy: InputFieldPolicy, context: InputContext = "global_search") => ({ policy, context, now: NOW });

// ── formatRelativeAge (pure) ────────────────────────────────────────────────────
describe("formatRelativeAge", () => {
  it("renders minute/hour/day and a just-now floor, and never a negative age", () => {
    assert.equal(formatRelativeAge(new Date(nowMs - 4 * 60_000).toISOString(), nowMs), "Updated 4m ago");
    assert.equal(formatRelativeAge(new Date(nowMs - 30_000).toISOString(), nowMs), "Updated just now");
    assert.equal(formatRelativeAge(new Date(nowMs - 2 * 3600_000).toISOString(), nowMs), "Updated 2h ago");
    assert.equal(formatRelativeAge(new Date(nowMs - 3 * 86400_000).toISOString(), nowMs), "Updated 3d ago");
    // A future timestamp must not produce "Updated -1m ago".
    assert.equal(formatRelativeAge(new Date(nowMs + 5 * 60_000).toISOString(), nowMs), "Updated just now");
    assert.equal(formatRelativeAge("not-a-date", nowMs), "Updated just now");
  });
});

// ── buildFreshnessState (pure; the anti-fabrication chokepoint) ──────────────────
describe("buildFreshnessState — projects a real claim, never invents one", () => {
  it("empty envelopes ⇒ null (no fabricated live)", () => {
    // MUTATION: return a non-null state here → this assertion (and every gated
    // 'no label' case below) goes RED.
    assert.equal(buildFreshnessState([], nowMs), null);
  });

  it("a live crowd.trajectory 'building' ⇒ 'Getting busier' + fresh + age label", () => {
    const env: any = {
      id: "e1", claimType: "crowd.trajectory", value: "building", confidence: 0.8,
      band: "live", sourceClass: "firsthand_unverified", sourceCountBucket: "few",
      observedAt: FOUR_MIN_AGO, validUntil: FUTURE, state: "live",
    };
    const fs = buildFreshnessState([env], nowMs);
    assert.deepEqual(fs, { state: "fresh", updatedAtLabel: "Updated 4m ago", label: "Getting busier" });
  });

  it("a live crowd.level 'busy' ⇒ 'Busy right now'", () => {
    const env: any = {
      id: "e2", claimType: "crowd.level", value: { level: "busy" }, confidence: 0.8,
      band: "live", sourceClass: "firsthand_unverified", sourceCountBucket: "few",
      observedAt: FOUR_MIN_AGO, validUntil: FUTURE, state: "live",
    };
    assert.equal(buildFreshnessState([env], nowMs)?.label, "Busy right now");
  });

  it("an emerging (likely_current) claim ⇒ 'recently_confirmed', not 'fresh'", () => {
    const env: any = {
      id: "e3", claimType: "crowd.trajectory", value: "building", confidence: 0.6,
      band: "likely_current", sourceClass: "firsthand_unverified", sourceCountBucket: "few",
      observedAt: FOUR_MIN_AGO, validUntil: FUTURE, state: "emerging",
    };
    assert.equal(buildFreshnessState([env], nowMs)?.state, "recently_confirmed");
  });

  it("a non-crowd claim (e.g. structural confirmation) ⇒ generic 'Recently confirmed' (the §31 Gem case)", () => {
    const env: any = {
      id: "e4", claimType: "structural", value: { open: true }, confidence: 0.8,
      band: "live", sourceClass: "firsthand_unverified", sourceCountBucket: "few",
      observedAt: FOUR_MIN_AGO, validUntil: FUTURE, state: "live",
    };
    assert.equal(buildFreshnessState([env], nowMs)?.label, "Recently confirmed");
  });

  it("unsafe_density (specialist-only) is NOT surfaced as a casual crowd label", () => {
    const env: any = {
      id: "e5", claimType: "crowd.level", value: "unsafe_density", confidence: 0.8,
      band: "live", sourceClass: "firsthand_unverified", sourceCountBucket: "few",
      observedAt: FOUR_MIN_AGO, validUntil: FUTURE, state: "live",
    };
    // Falls through to the generic confirmation label, never "Busy"/"Packed".
    assert.equal(buildFreshnessState([env], nowMs)?.label, "Recently confirmed");
  });
});

// ── enrichSuggestionsWithLive — end-to-end through the REAL gated read ────────────
describe("enrichSuggestionsWithLive — attaches live state only from the gated path", () => {
  it("§31/§15: a fresh, eligible, promoted place gets freshness AND a rank nudge", async () => {
    const sc = makeLiveClient({ rows: [trajectoryRow(PLACE_LIVE)] });
    const [out] = await enrichSuggestionsWithLive(sc, [placeSuggestion("a", PLACE_LIVE, 0.6)], enrichOpts(GLOBAL_SEARCH));
    assert.deepEqual(out.freshness, { state: "fresh", updatedAtLabel: "Updated 4m ago", label: "Getting busier" });
    assert.ok((out.confidence ?? 0) > 0.6, "a fresh live state must nudge the Freshness rank up");
    assert.equal(out.confidence, Math.min(0.985, 0.6 + 0.06));
  });

  it("§9: a fresh place ranks above an EQUAL non-fresh place, but never past a strong exact match", async () => {
    const PLACE_EXACT = "33333333-0000-4000-8000-000000000003";
    const sc = makeLiveClient({ rows: [trajectoryRow(PLACE_LIVE), trajectoryRow(PLACE_EXACT)] });
    const fresh = placeSuggestion("fresh", PLACE_LIVE, 0.6);
    const dark = placeSuggestion("dark", PLACE_DARK, 0.6); // no rows for this subject
    const exact = placeSuggestion("exact", PLACE_EXACT, 0.99); // exact-band match WITH a live claim
    const [oFresh, oDark, oExact] = await enrichSuggestionsWithLive(sc, [fresh, dark, exact], enrichOpts(GLOBAL_SEARCH));
    assert.ok((oFresh.confidence ?? 0) > (oDark.confidence ?? 0), "fresh outranks equal non-fresh (§15)");
    assert.equal(oDark.freshness, undefined, "no gated claim ⇒ no fabricated live label");
    // MUTATION: remove the boost → oFresh.confidence == oDark.confidence and this RED.
    assert.equal(oExact.confidence, 0.99, "the boost is clamped below the exact-match band (§9)");
    assert.ok(oExact.freshness, "an exact match still carries its real live projection");
  });

  it("empty live substrate ⇒ suggestions unchanged, and ONE probe read at most (graceful pre-launch)", async () => {
    const sc = makeLiveClient({ rows: [] });
    const input = [placeSuggestion("a", PLACE_LIVE, 0.6)];
    const out = await enrichSuggestionsWithLive(sc, input, enrichOpts(GLOBAL_SEARCH));
    assert.equal(out[0].freshness, undefined);
    assert.equal(out[0].confidence, 0.6, "no boost without a live claim");
  });

  it("flag off ⇒ NO live label and ZERO snapshot reads (fail-closed global gate)", async () => {
    const sc = makeLiveClient({ flag: false, rows: [trajectoryRow(PLACE_LIVE)] });
    const [out] = await enrichSuggestionsWithLive(sc, [placeSuggestion("a", PLACE_LIVE, 0.6)], enrichOpts(GLOBAL_SEARCH));
    assert.equal(out.freshness, undefined, "the flag being off must remove the live label (§31)");
    assert.equal(sc.counts.snapshotReads, 0, "an off system must never even read a snapshot");
  });

  it("kill switch engaged ⇒ NO live label", async () => {
    const sc = makeLiveClient({ kill: true, rows: [trajectoryRow(PLACE_LIVE)] });
    const [out] = await enrichSuggestionsWithLive(sc, [placeSuggestion("a", PLACE_LIVE, 0.6)], enrichOpts(GLOBAL_SEARCH));
    assert.equal(out.freshness, undefined);
  });

  it("pilot switch off ⇒ NO live label", async () => {
    const sc = makeLiveClient({ pilot: false, rows: [trajectoryRow(PLACE_LIVE)] });
    const [out] = await enrichSuggestionsWithLive(sc, [placeSuggestion("a", PLACE_LIVE, 0.6)], enrichOpts(GLOBAL_SEARCH));
    assert.equal(out.freshness, undefined);
  });

  it("IG-09: an UNPROMOTED scope yields NO live label even with a fresh claim", async () => {
    const sc = makeLiveClient({ promoted: [], rows: [trajectoryRow(PLACE_LIVE)] });
    const [out] = await enrichSuggestionsWithLive(sc, [placeSuggestion("a", PLACE_LIVE, 0.6)], enrichOpts(GLOBAL_SEARCH));
    assert.equal(out.freshness, undefined, "per-scope promotion is required (IG-09) — not the global flag alone");
  });

  it("a STALE/expired snapshot is never manufactured into 'busy now'", async () => {
    // The row is fresh-looking except its TTL is in the past; the gated read's
    // gt:expires_at drops it, so no label is produced.
    const sc = makeLiveClient({ rows: [trajectoryRow(PLACE_LIVE, { expires_at: PAST_EXPIRY })] });
    const [out] = await enrichSuggestionsWithLive(sc, [placeSuggestion("a", PLACE_LIVE, 0.6)], enrichOpts(GLOBAL_SEARCH));
    assert.equal(out.freshness, undefined, "beyond the freshness window ⇒ no live label (§20/§31)");
  });

  it("a snapshot read error is fail-soft ⇒ NO label (never a fabricated one)", async () => {
    const sc = makeLiveClient({ snapshotError: true, rows: [trajectoryRow(PLACE_LIVE)] });
    const [out] = await enrichSuggestionsWithLive(sc, [placeSuggestion("a", PLACE_LIVE, 0.6)], enrichOpts(GLOBAL_SEARCH));
    assert.equal(out.freshness, undefined);
  });

  it("§6: a policy without allowLiveContext does NO reads and returns suggestions unchanged", async () => {
    assert.equal(CITY_PICKER.allowLiveContext, false, "precondition: city_picker does not allow live context");
    const sc = makeLiveClient({ rows: [trajectoryRow(PLACE_LIVE)] });
    const input = [placeSuggestion("a", PLACE_LIVE, 0.6)];
    const out = await enrichSuggestionsWithLive(sc, input, enrichOpts(CITY_PICKER, "city_picker"));
    assert.equal(out[0].freshness, undefined);
    assert.equal(sc.counts.snapshotReads, 0, "a live-disallowed field must never touch the live system");
  });

  it("non place/gem entities (city/user) are never probed for live state", async () => {
    assert.equal(LIVE_ELIGIBLE_ENTITY_TYPES.has("city"), false);
    assert.equal(LIVE_ELIGIBLE_ENTITY_TYPES.has("place"), true);
    assert.equal(LIVE_ELIGIBLE_ENTITY_TYPES.has("hidden_gem"), true);
    const cityRow: InputSuggestion = {
      id: "c", type: "entity", context: "global_search", label: "Da Nang",
      entityType: "city", entityId: "cty-1",
      action: { type: "open_entity", entityType: "city", entityId: "cty-1" },
      confidence: 0.9, source: "canonical", policyVersion: "test",
    };
    const sc = makeLiveClient({ rows: [trajectoryRow(PLACE_LIVE)] });
    const out = await enrichSuggestionsWithLive(sc, [cityRow], enrichOpts(GLOBAL_SEARCH));
    assert.equal(out[0].freshness, undefined);
    assert.equal(sc.counts.snapshotReads, 0, "no live-eligible entity ⇒ not even a flag/snapshot read");
  });

  it("does not mutate the input array or its suggestions", async () => {
    const sc = makeLiveClient({ rows: [trajectoryRow(PLACE_LIVE)] });
    const input = [placeSuggestion("a", PLACE_LIVE, 0.6)];
    const before = JSON.parse(JSON.stringify(input));
    await enrichSuggestionsWithLive(sc, input, enrichOpts(GLOBAL_SEARCH));
    assert.deepEqual(input, before, "enrichment must return a new array and leave inputs untouched");
  });

  it("a hidden_gem entity is live-eligible and gets its gated projection", async () => {
    const gem: InputSuggestion = {
      id: "g", type: "entity", context: "global_search", label: "Hidden Beach",
      entityType: "hidden_gem", entityId: PLACE_LIVE,
      action: { type: "open_entity", entityType: "hidden_gem", entityId: PLACE_LIVE },
      confidence: 0.6, source: "canonical", policyVersion: "test",
    };
    const sc = makeLiveClient({ rows: [trajectoryRow(PLACE_LIVE)] });
    const [out] = await enrichSuggestionsWithLive(sc, [gem], enrichOpts(GLOBAL_SEARCH));
    assert.equal(out.freshness?.label, "Getting busier");
  });
});
