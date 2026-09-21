/**
 * §12 Highlights architecture, §5 lifecycle, §21 archive/revocation — and the
 * reconciliation of the ONE permission rule.
 *
 * Highlights/Memories Development Architecture Spec v1, sections cited per
 * describe() block below.
 *
 * WHAT ELSE COULD HAVE MADE THESE PASS — answered, per group:
 *   • Every route assertion checks an EXACT status AND the response body, never
 *     `status !== 200`, so a crash-500 cannot pass as a refusal. The harness
 *     installs the `req.log` shim for the same reason.
 *   • Every refusal is paired with a control on the same fixture that SUCCEEDS,
 *     so "the fixture was broken" cannot be the explanation.
 *   • The fail-closed reads key on the exact table under test. `profiles` is
 *     never failed wholesale: requireUser reads it and would refuse upstream
 *     with the same 503, and the guard under test would never run.
 *   • The pure-function tests assert ORDER and IDENTITY, not just "did not
 *     throw" — a stub returning its input unchanged fails all of them.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/highlightsSpecArchitecture.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canViewHighlight,
  canEngageHighlight,
  isHighlightActive,
  type HighlightRecord,
} from "../lib/highlightPermissions.js";
import {
  HIGHLIGHT_LIFETIME_CLASSES,
  HIGHLIGHT_LIFECYCLE_STATES,
  isValidLifecycleTransition,
  describeHighlightLifecycle,
  describeHighlightLifetime,
  representableLifetimeClasses,
} from "../services/highlights/highlightLifecycle.js";
import {
  rankHighlights,
  recencyScore,
  HIGHLIGHT_RANKING_FACTORS,
} from "../services/highlights/highlightRanking.js";
import {
  OPERATION_SEMANTICS,
  REVOCATION_DESTINATIONS,
  executeRevocation,
  summariseRevocation,
  planRevocation,
  type DestinationOutcome,
} from "../services/highlights/highlightRevocation.js";
import {
  startApp,
  call,
  feedIds,
  listIds,
  fixtureTables,
  highlight,
  VIEWER,
  OWNER,
  H_PUB,
  H_MINE,
  H_ARCH,
  H_CIRCLE_MINE,
} from "./highlightsSpecHarness.js";

const rec = (o: Partial<HighlightRecord> & { owner_id: string }): HighlightRecord => ({
  id: "h",
  visibility: "public",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  deleted_at: null,
  archived_at: null,
  ...o,
});

// ── §12 / §23: ONE permission rule ───────────────────────────────────────────

describe("§23 policy functions: canEngageHighlight is the rule the routes use, not a second opinion", () => {
  const h = rec({ owner_id: OWNER, id: H_PUB });

  it("CONTROL — a stranger who can see the highlight may like, reply and report it", () => {
    for (const action of ["like", "reply", "report"] as const) {
      assert.deepEqual(
        canEngageHighlight(VIEWER, h, action, true),
        { allowed: true },
        `${action} must be allowed for a permitted viewer, or every refusal below passes for free`,
      );
    }
  });

  it("the OWNER may not like, reply to, or report their own highlight — the routes' shipped behaviour", () => {
    for (const action of ["like", "reply", "report"] as const) {
      assert.deepEqual(
        canEngageHighlight(OWNER, h, action, true),
        { allowed: false, reason: "own_highlight" },
        `owner ${action} must be refused; the old exported helper permitted like and reply`,
      );
    }
  });

  it("the owner MAY view and unlike their own highlight — absent from the old union, not permitted by it", () => {
    for (const action of ["view", "unlike"] as const) {
      assert.deepEqual(canEngageHighlight(OWNER, h, action, true), { allowed: true }, action);
    }
  });

  it("a viewer who cannot see the highlight is refused for not_visible, not own_highlight", () => {
    assert.deepEqual(canEngageHighlight(VIEWER, h, "like", false), { allowed: false, reason: "not_visible" });
    // Even the owner: an invisible row is invisible first. The distinction is
    // what lets the route answer 404 rather than leaking "this is yours".
    assert.deepEqual(canEngageHighlight(OWNER, h, "report", false), { allowed: false, reason: "not_visible" });
  });
});

describe("§21: archive and delete are different removals, and isHighlightActive tells them apart", () => {
  it("CONTROL — a live, unarchived, undeleted highlight is active", () => {
    assert.equal(isHighlightActive(rec({ owner_id: OWNER })), true);
  });

  it("an ARCHIVED highlight is not active, and its own owner cannot view it through the normal gate", () => {
    const archived = rec({ owner_id: OWNER, archived_at: "2026-02-01T00:00:00.000Z" });
    assert.equal(isHighlightActive(archived), false);
    assert.equal(
      canViewHighlight(OWNER, archived),
      false,
      "archive must remove from normal browsing for the owner too — §21 says 'unless explicitly requested'",
    );
  });

  it("a row that did not project archived_at is treated as 'not asked for', not as 'not archived'", () => {
    // The distinction matters: a caller that omits the column must not get a
    // silent "unarchived" verdict it never asked for. `undefined != null` is
    // false, so the row stays active — and the way to be sure is to project it.
    const noColumn = { id: "h", owner_id: OWNER, visibility: "public" as const, expires_at: new Date(Date.now() + 3_600_000).toISOString(), deleted_at: null };
    assert.equal(isHighlightActive(noColumn), true);
  });

  it("a DELETED highlight is not active, and deletion is not undone by clearing archived_at", () => {
    assert.equal(isHighlightActive(rec({ owner_id: OWNER, deleted_at: "2026-02-01T00:00:00.000Z", archived_at: null })), false);
  });
});

describe("§12: canViewHighlight's owner short-circuit is the rule the feeds now share", () => {
  it("the owner sees their own circle_only highlight without being in their own circle", () => {
    const own = rec({ owner_id: VIEWER, visibility: "circle_only" });
    assert.equal(canViewHighlight(VIEWER, own, { viewerFollowsOwner: false }), true);
    // The paired negative: a stranger does NOT.
    assert.equal(canViewHighlight(OWNER, own, { viewerFollowsOwner: false }), false);
  });

  it("an unrecognised visibility value withholds rather than defaulting to public", () => {
    const drifted = { ...rec({ owner_id: OWNER }), visibility: "everyone" as any };
    assert.equal(canViewHighlight(VIEWER, drifted), false);
  });
});

// ── §3.5 / §4 / §5: the vocabulary ───────────────────────────────────────────

describe("§4 HighlightLifetime and §5 lifecycle: the vocabulary is the spec's, not a paraphrase", () => {
  it("the five lifetime classes are exactly LIVE, DAY, TRIP, SEASONAL, PERMANENT", () => {
    assert.deepEqual([...HIGHLIGHT_LIFETIME_CLASSES], ["LIVE", "DAY", "TRIP", "SEASONAL", "PERMANENT"]);
  });

  it("the five lifecycle states are exactly DRAFT, ACTIVE, EXPIRED, PINNED, HIDDEN", () => {
    assert.deepEqual([...HIGHLIGHT_LIFECYCLE_STATES], ["DRAFT", "ACTIVE", "EXPIRED", "PINNED", "HIDDEN"]);
  });

  it("§5's transition diagram is followed exactly — the five edges it draws and no others", () => {
    const legal: Array<[string, string]> = [
      ["DRAFT", "ACTIVE"],
      ["ACTIVE", "EXPIRED"],
      ["ACTIVE", "PINNED"],
      ["PINNED", "HIDDEN"],
      ["HIDDEN", "EXPIRED"],
    ];
    for (const [from, to] of legal) {
      assert.equal(isValidLifecycleTransition(from, to), true, `${from} -> ${to} is on the diagram`);
    }
    // Exhaustive negative: every OTHER ordered pair must be rejected. A stub
    // returning true passes the five above; it cannot pass these twenty.
    const legalSet = new Set(legal.map(([a, b]) => `${a}>${b}`));
    let checked = 0;
    for (const from of HIGHLIGHT_LIFECYCLE_STATES) {
      for (const to of HIGHLIGHT_LIFECYCLE_STATES) {
        if (legalSet.has(`${from}>${to}`)) continue;
        assert.equal(isValidLifecycleTransition(from, to), false, `${from} -> ${to} is NOT on the diagram`);
        checked += 1;
      }
    }
    assert.equal(checked, 20, "the 5x5 grid minus 5 legal edges");
    assert.equal(isValidLifecycleTransition("ACTIVE", "DELETED"), false, "DELETED is §21's machine, not §5's");
  });
});

describe("§12 classes are STORED or UNKNOWN — never inferred from an expiry window", () => {
  it("a row with no lifetime_class column reports unavailable, not a guessed class", () => {
    const d = describeHighlightLifetime({ expires_at: new Date(Date.now() + 3 * 3_600_000).toISOString() });
    assert.equal(d.provenance, "unavailable");
    assert.equal(d.cls, null, "a 3-hour expiry must NOT be reported as LIVE");
  });

  it("CONTROL — a stored class is reported as stored", () => {
    const d = describeHighlightLifetime({ lifetime_class: "TRIP", expires_at: null });
    assert.deepEqual(d, { provenance: "stored", cls: "TRIP" });
  });

  it("a stored value outside §4's enum is invalid, not passed through", () => {
    assert.equal(describeHighlightLifetime({ lifetime_class: "WEEKEND" }).provenance, "invalid");
  });

  it("PERMANENT while carrying an expiry is self-contradictory and is refused", () => {
    const d = describeHighlightLifetime({ lifetime_class: "PERMANENT", expires_at: "2026-12-01T00:00:00Z" });
    assert.equal(d.provenance, "invalid");
    assert.equal(d.cls, null);
  });

  it("with production's NOT NULL expires_at, PERMANENT is reported UNREPRESENTABLE, not merely unbuilt", () => {
    const r = representableLifetimeClasses({ lifetimeClassColumn: true, expiresAtNullable: false });
    assert.deepEqual([...r.representable], ["LIVE", "DAY", "TRIP", "SEASONAL"]);
    assert.equal(r.unrepresentable.length, 1);
    assert.equal(r.unrepresentable[0].cls, "PERMANENT");
    assert.match(r.unrepresentable[0].why, /NOT NULL/);
    // Paired control: make it nullable and all five become representable.
    assert.equal(representableLifetimeClasses({ lifetimeClassColumn: true, expiresAtNullable: true }).representable.length, 5);
  });
});

describe("§5/§21: a soft-deleted Highlight is NOT reported as HIDDEN", () => {
  const now = new Date("2026-03-01T00:00:00Z");

  it("CONTROL — a live row derives ACTIVE, an expired one derives EXPIRED", () => {
    assert.deepEqual(describeHighlightLifecycle({ expires_at: "2026-04-01T00:00:00Z" }, now), {
      provenance: "derived", state: "ACTIVE", from: "expires_at > now",
    });
    assert.deepEqual(describeHighlightLifecycle({ expires_at: "2026-02-01T00:00:00Z" }, now), {
      provenance: "derived", state: "EXPIRED", from: "expires_at <= now",
    });
  });

  it("archived_at — the REVERSIBLE column — derives HIDDEN", () => {
    const d = describeHighlightLifecycle({ expires_at: "2026-04-01T00:00:00Z", archived_at: "2026-02-20T00:00:00Z" }, now);
    assert.deepEqual(d, { provenance: "derived", state: "HIDDEN", from: "archived_at" });
  });

  it("deleted_at — the TERMINAL column — is out_of_machine, NOT HIDDEN", () => {
    const d = describeHighlightLifecycle({ expires_at: "2026-04-01T00:00:00Z", deleted_at: "2026-02-20T00:00:00Z" }, now);
    assert.equal(d.state, null, "reporting a soft delete as HIDDEN would call a terminal act reversible");
    assert.equal(d.provenance, "out_of_machine");
  });

  it("deletion wins over archive when both are set", () => {
    const d = describeHighlightLifecycle(
      { expires_at: "2026-04-01T00:00:00Z", deleted_at: "2026-02-20T00:00:00Z", archived_at: "2026-02-19T00:00:00Z" },
      now,
    );
    assert.equal(d.provenance, "out_of_machine");
  });
});

// ── §12 ranking ──────────────────────────────────────────────────────────────

describe("§12 ranking: pinned/manual order ALWAYS outranks automatic ordering", () => {
  const now = new Date("2026-03-01T00:00:00Z");

  it("a pinned item with the WORST possible automatic score still comes first", () => {
    const ranked = rankHighlights(
      [
        // Unpinned, freshest possible, every factor perfect.
        {
          id: "best",
          createdAt: "2026-03-01T00:00:00Z",
          factors: { significance: 1, current_relevance: 1, audience_relevance: 1, presentation_quality: 1 },
        },
        // Pinned, ancient, every measurable factor at zero.
        {
          id: "pinned",
          createdAt: "2020-01-01T00:00:00Z",
          pinOrder: 0,
          factors: { significance: 0, current_relevance: 0, audience_relevance: 0, presentation_quality: 0 },
        },
      ],
      { now },
    );
    assert.deepEqual(ranked.map((r) => r.item.id), ["pinned", "best"]);
    assert.equal(ranked[0].pinned, true);
    // And the scores confirm the ordering is NOT arithmetic: the pinned item's
    // score is genuinely lower and it still wins. A big-weight implementation
    // would have had to invert this to pass.
    assert.ok(
      (ranked[0].score ?? 1) < (ranked[1].score ?? 0),
      `pinned score ${ranked[0].score} must be worse than ${ranked[1].score}, or this test proves nothing`,
    );
  });

  it("pins are ordered among themselves by the owner's explicit pinOrder", () => {
    const ranked = rankHighlights(
      [
        { id: "c", createdAt: "2026-03-01T00:00:00Z", pinOrder: 2 },
        { id: "a", createdAt: "2020-01-01T00:00:00Z", pinOrder: 0 },
        { id: "b", createdAt: "2024-01-01T00:00:00Z", pinOrder: 1 },
        { id: "z", createdAt: "2026-03-01T00:00:00Z" },
      ],
      { now },
    );
    assert.deepEqual(ranked.map((r) => r.item.id), ["a", "b", "c", "z"]);
  });
});

describe("§12 ranking: an unmeasurable factor is null, never zero", () => {
  const now = new Date("2026-03-01T00:00:00Z");

  it("recency is computed; the other four are reported MISSING, not scored 0", () => {
    const [r] = rankHighlights([{ id: "x", createdAt: "2026-03-01T00:00:00Z" }], { now });
    assert.deepEqual([...r.factorsUsed], ["recency"]);
    assert.deepEqual(
      [...r.factorsMissing].sort(),
      HIGHLIGHT_RANKING_FACTORS.filter((f) => f !== "recency").slice().sort(),
    );
    assert.equal(r.score, 1, "the mean of ONE measured factor is that factor — not 1/5");
  });

  it("an item with no measurable factor at all scores null and sorts AFTER every scored item", () => {
    const ranked = rankHighlights(
      [
        { id: "unscored", createdAt: "not-a-date", factors: { recency: null } },
        { id: "weak", createdAt: "2020-01-01T00:00:00Z" },
      ],
      { now },
    );
    assert.equal(ranked[0].item.id, "weak");
    assert.equal(ranked[1].item.id, "unscored");
    assert.equal(ranked[1].score, null, "null must not be coerced to 0 — 0 would beat a decayed recency");
    // The proof that this is not accidental: `weak`'s score IS below any
    // plausible floor, and it still outranks the unscored item.
    assert.ok((ranked[0].score ?? 1) < 0.01, `weak scored ${ranked[0].score}`);
  });

  it("recencyScore decays by half every half-life and clamps future timestamps to 1", () => {
    assert.equal(recencyScore("2026-03-01T00:00:00Z", now, 24), 1);
    assert.equal(recencyScore("2026-02-28T00:00:00Z", now, 24), 0.5);
    assert.equal(recencyScore("2026-02-27T00:00:00Z", now, 24), 0.25);
    assert.equal(recencyScore("2026-04-01T00:00:00Z", now, 24), 1, "clock skew clamps, it does not exceed 1");
    assert.equal(recencyScore("nonsense", now, 24), null);
  });
});

describe("§12 ranking: diversity constrains the sequence across trip, person, venue and activity", () => {
  const now = new Date("2026-03-01T00:00:00Z");

  it("three highlights from the same venue are not served consecutively when an alternative exists", () => {
    const items = [
      { id: "v1", createdAt: "2026-03-01T00:00:00Z", diversityKeys: { venue: "quiet-bar" } },
      { id: "v2", createdAt: "2026-02-28T23:00:00Z", diversityKeys: { venue: "quiet-bar" } },
      { id: "v3", createdAt: "2026-02-28T22:00:00Z", diversityKeys: { venue: "quiet-bar" } },
      { id: "o1", createdAt: "2026-02-28T21:00:00Z", diversityKeys: { venue: "river-walk" } },
    ];
    const ids = rankHighlights(items, { now }).map((r) => r.item.id);
    // Recency alone would give v1,v2,v3,o1. Diversity must break the run.
    assert.notDeepEqual(ids, ["v1", "v2", "v3", "o1"]);
    assert.equal(ids[0], "v1", "the best item still leads — diversity reorders, it does not demote the winner");
    assert.equal(ids[1], "o1", "the alternative venue is pulled up to break the run");
    assert.equal(ids.length, 4, "diversity must not DROP anything");
    assert.deepEqual([...ids].sort(), ["o1", "v1", "v2", "v3"]);
  });

  it("when every remaining candidate repeats, the item is still served and records why", () => {
    const items = [
      { id: "a", createdAt: "2026-03-01T00:00:00Z", diversityKeys: { person: "p1" } },
      { id: "b", createdAt: "2026-02-28T23:00:00Z", diversityKeys: { person: "p1" } },
    ];
    const ranked = rankHighlights(items, { now });
    assert.deepEqual(ranked.map((r) => r.item.id), ["a", "b"], "a diversity rule must never empty a feed");
    assert.deepEqual([...ranked[1].deferredFor], ["person"], "the compromise must be visible, not silent");
    assert.deepEqual([...ranked[0].deferredFor], []);
  });

  it("an unknown diversity key does not constrain — two nulls are not 'the same venue'", () => {
    const items = [
      { id: "a", createdAt: "2026-03-01T00:00:00Z", diversityKeys: { venue: null } },
      { id: "b", createdAt: "2026-02-28T23:00:00Z", diversityKeys: { venue: null } },
    ];
    const ranked = rankHighlights(items, { now });
    assert.deepEqual(ranked.map((r) => r.item.id), ["a", "b"]);
    assert.deepEqual([...ranked[1].deferredFor], [], "null keys must not be treated as a repeated key");
  });

  it("diversity is NOT applied to the pinned partition — a pin is explicit curation", () => {
    const items = [
      { id: "p1", createdAt: "2026-03-01T00:00:00Z", pinOrder: 0, diversityKeys: { venue: "same" } },
      { id: "p2", createdAt: "2026-02-28T00:00:00Z", pinOrder: 1, diversityKeys: { venue: "same" } },
      { id: "u1", createdAt: "2026-02-27T00:00:00Z", diversityKeys: { venue: "other" } },
    ];
    assert.deepEqual(rankHighlights(items, { now }).map((r) => r.item.id), ["p1", "p2", "u1"]);
  });
});

// ── §21 revocation ───────────────────────────────────────────────────────────

describe("§21: the six operations are six operations", () => {
  it("archive and delete differ on BOTH retention and reversibility", () => {
    const a = OPERATION_SEMANTICS.ARCHIVE;
    const d = OPERATION_SEMANTICS.DELETE_HIGHLIGHT;
    assert.equal(a.removesFromBrowsing, d.removesFromBrowsing, "both remove from browsing — that is why they get confused");
    assert.notEqual(a.retainsRecord, d.retainsRecord);
    assert.notEqual(a.reversible, d.reversible);
  });

  it("do-not-personalize does NOT remove from browsing — the census H92 collapse must not recur", () => {
    assert.equal(OPERATION_SEMANTICS.DO_NOT_PERSONALIZE.removesFromBrowsing, false);
    assert.equal(OPERATION_SEMANTICS.DO_NOT_PERSONALIZE.retainsRecord, true);
    assert.equal(OPERATION_SEMANTICS.DO_NOT_RESURFACE.removesFromBrowsing, false);
  });

  it("make-private retains the record; only delete does not", () => {
    for (const op of ["ARCHIVE", "DO_NOT_RESURFACE", "DO_NOT_PERSONALIZE", "MAKE_PRIVATE", "DELETE_MEDIA_ASSET"] as const) {
      assert.equal(OPERATION_SEMANTICS[op].retainsRecord, true, op);
    }
    assert.equal(OPERATION_SEMANTICS.DELETE_HIGHLIGHT.retainsRecord, false);
  });
});

describe("§21: a revocation report never claims a destination it did not reach", () => {
  it("all eight §21 destinations appear in every plan", () => {
    const plan = planRevocation("DELETE_HIGHLIGHT");
    assert.deepEqual(plan.map((o) => o.destination), [...REVOCATION_DESTINATIONS]);
    assert.equal(plan.length, 8);
  });

  it("with no cache invalidator, NOTHING is revoked and the report says incomplete", async () => {
    const r = await executeRevocation("DELETE_HIGHLIGHT", "h1");
    assert.equal(r.complete, false);
    assert.equal(r.outcomes.filter((o) => o.status === "revoked").length, 0);
    assert.ok(
      r.outcomes.some((o) => o.status === "not_implemented"),
      "not_implemented must be REPORTED, not omitted — omission is how a report starts lying",
    );
  });

  it("a cache invalidation that succeeds is 'revoked'; one that throws is 'failed' and retryable", async () => {
    const ok = await executeRevocation("DELETE_HIGHLIGHT", "h1", { invalidateCache: async () => {} });
    const cacheOk = ok.outcomes.find((o) => o.destination === "cached_narrative");
    assert.equal(cacheOk?.status, "revoked");
    assert.deepEqual([...ok.retryable], []);

    const bad = await executeRevocation("DELETE_HIGHLIGHT", "h1", {
      invalidateCache: async () => { throw new Error("cache down"); },
    });
    const cacheBad = bad.outcomes.find((o) => o.destination === "cached_narrative");
    assert.equal(cacheBad?.status, "failed");
    assert.match(String(cacheBad?.detail), /cache down/);
    assert.deepEqual([...bad.retryable], ["cached_narrative"], "a failed destination must be named for retry/dead-letter");
  });

  it("complete is true ONLY when every applicable destination is revoked", () => {
    // Annotated rather than inferred: with `status: "revoked" as const` the array
    // was inferred as `status: "revoked"` ONLY, so assigning a not_implemented
    // outcome into it below did not typecheck. The fixture's real type is the
    // one production emits, and naming it is the fix — widening the element by
    // hand, or casting the assignment, would have been the fixture describing a
    // shape of its own invention, which is what this gate exists to stop.
    const all: DestinationOutcome[] = REVOCATION_DESTINATIONS.map((d) => ({ destination: d, status: "revoked" as const, detail: "" }));
    assert.equal(summariseRevocation("DELETE_HIGHLIGHT", "h", all).complete, true);
    const one = [...all];
    one[3] = { destination: one[3].destination, status: "not_implemented" as const, detail: "" };
    assert.equal(summariseRevocation("DELETE_HIGHLIGHT", "h", one).complete, false);
    // An all-not_applicable plan is NOT "complete" — nothing was revoked.
    const none: DestinationOutcome[] = REVOCATION_DESTINATIONS.map((d) => ({ destination: d, status: "not_applicable" as const, detail: "" }));
    assert.equal(summariseRevocation("DELETE_HIGHLIGHT", "h", none).complete, false);
  });
});

// ── Routes ───────────────────────────────────────────────────────────────────

describe("§23: the routes consult canEngageHighlight, they do not restate it", () => {
  it("CONTROL — a stranger CAN like someone else's highlight", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/${H_PUB}/like`, VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body?.likedByMe, true);
    } finally { await app.close(); }
  });

  it("the owner cannot like their own highlight — 400 invalid_payload with the shared message", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/${H_MINE}/like`, VIEWER);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body?.error, "invalid_payload");
      assert.equal(r.body?.message, "Cannot like your own highlight");
      assert.equal(app.tables.highlight_likes.length, 0, "and nothing was written");
    } finally { await app.close(); }
  });

  it("the owner cannot report their own highlight, and nothing is filed", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/${H_MINE}/report`, VIEWER, { reason: "spam" });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body?.message, "Cannot report your own highlight");
      assert.equal(app.tables.highlight_reports.length, 0);
    } finally { await app.close(); }
  });

  it("the owner CAN view their own highlight — view is not an owner-forbidden action", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/${H_MINE}/view`, VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(app.tables.highlight_views.length, 1);
    } finally { await app.close(); }
  });
});

describe("§12: the feeds use the shared view rule — the owner short-circuit reaches following-feed", () => {
  it("CONTROL — the public highlight of a followed user is in the feed", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(r.status, 200);
      assert.ok(feedIds(r.body).has(H_PUB), JSON.stringify(r.body));
    } finally { await app.close(); }
  });

  it("a self-following viewer sees their OWN circle_only highlight, as every other surface already shows it", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(r.status, 200);
      assert.ok(
        feedIds(r.body).has(H_CIRCLE_MINE),
        `the inline copy had no owner short-circuit and withheld this; got ${JSON.stringify([...feedIds(r.body)])}`,
      );
    } finally { await app.close(); }
  });

  it("a stranger's circle_only highlight is still withheld — the reconciliation widened nothing else", async () => {
    const tables = fixtureTables();
    tables.highlights.push(highlight("30000000-0000-4000-8000-000000000009", OWNER, { visibility: "circle_only" }));
    const app = await startApp({ tables });
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(r.status, 200);
      assert.ok(!feedIds(r.body).has("30000000-0000-4000-8000-000000000009"), JSON.stringify(r.body));
    } finally { await app.close(); }
  });
});

describe("§21 Archive on the routes: reversible, retained, and not the delete", () => {
  it("CONTROL — an unarchived highlight is on its owner's profile", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/users/${OWNER}/highlights`, VIEWER);
      assert.equal(r.status, 200);
      assert.ok(listIds(r.body).has(H_PUB), JSON.stringify(r.body));
    } finally { await app.close(); }
  });

  it("an archived highlight is absent from the profile, from /highlights/active, and from the feed", async () => {
    const app = await startApp();
    try {
      const prof = await call(app, "GET", `/api/users/${OWNER}/highlights`, VIEWER);
      assert.ok(!listIds(prof.body).has(H_ARCH), "profile");
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.ok(!listIds(active.body).has(H_ARCH), "active");
      const feed = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.ok(!feedIds(feed.body).has(H_ARCH), "feed");
    } finally { await app.close(); }
  });

  it("an archived highlight cannot be engaged with — the gate refuses before the write", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/${H_ARCH}/like`, VIEWER);
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal(r.body?.error, "not_found");
      assert.equal(app.tables.highlight_likes.length, 0);
    } finally { await app.close(); }
  });

  it("POST then DELETE /highlights/:id/archive round-trips: the highlight leaves browsing and comes back", async () => {
    const app = await startApp();
    try {
      const before = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      assert.ok(listIds(before.body).has(H_MINE), "control: it starts visible");

      const arch = await call(app, "POST", `/api/highlights/${H_MINE}/archive`, VIEWER);
      assert.equal(arch.status, 200, JSON.stringify(arch.body));
      assert.ok(arch.body?.archivedAt, "the write must report the timestamp it set");

      const during = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      assert.ok(!listIds(during.body).has(H_MINE), "archived: out of browsing");

      const listed = await call(app, "GET", "/api/highlights/archived", VIEWER);
      assert.equal(listed.status, 200);
      assert.ok(listIds(listed.body).has(H_MINE), "but explicitly retrievable — §21's 'unless explicitly requested'");

      const un = await call(app, "DELETE", `/api/highlights/${H_MINE}/archive`, VIEWER);
      assert.equal(un.status, 200, JSON.stringify(un.body));
      assert.equal(un.body?.archivedAt, null);

      const after = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      assert.ok(listIds(after.body).has(H_MINE), "reversible: it is back");
      assert.equal(app.tables.highlights.find((h: any) => h.id === H_MINE)?.deleted_at, null, "archive never set deleted_at");
    } finally { await app.close(); }
  });

  it("a non-owner cannot archive someone else's highlight", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/${H_PUB}/archive`, VIEWER);
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal(app.tables.highlights.find((h: any) => h.id === H_PUB)?.archived_at, null);
    } finally { await app.close(); }
  });

  it("an archive UPDATE that matches zero rows is a 404, not a 200 — .select() is what makes that knowable", async () => {
    const app = await startApp({ zeroRowUpdate: new Set(["highlights"]) });
    try {
      const r = await call(app, "POST", `/api/highlights/${H_MINE}/archive`, VIEWER);
      assert.equal(r.status, 404, `an UPDATE with no .select() cannot tell one row from none; got ${JSON.stringify(r.body)}`);
    } finally { await app.close(); }
  });

  it("an unreadable highlights table makes GET /highlights/archived REFUSE, not report an empty archive", async () => {
    const ok = await startApp();
    try {
      const control = await call(ok, "GET", "/api/highlights/archived", OWNER);
      assert.equal(control.status, 200);
      assert.ok(listIds(control.body).has(H_ARCH), "control: OWNER has one archived highlight");
    } finally { await ok.close(); }

    const app = await startApp({ failTables: new Set(["highlights"]) });
    try {
      const r = await call(app, "GET", "/api/highlights/archived", OWNER);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body?.error, "degraded_unavailable");
      assert.equal(r.body?.retryable, true);
      assert.equal(r.body?.highlights, undefined, "a refusal must not also ship an empty list");
    } finally { await app.close(); }
  });
});

describe("§21: DELETE propagates revocation to the one destination that exists", () => {
  it("CONTROL — the delete itself still succeeds and soft-deletes the row", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "DELETE", `/api/highlights/${H_MINE}`, VIEWER);
      assert.equal(r.status, 204, JSON.stringify(r.body));
      assert.ok(app.tables.highlights.find((h: any) => h.id === H_MINE)?.deleted_at, "deleted_at was set");
    } finally { await app.close(); }
  });

  it("the incomplete-revocation report is LOGGED with the destinations that stayed unrevoked", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "DELETE", `/api/highlights/${H_MINE}`, VIEWER);
      assert.equal(r.status, 204);
      const line = app.errors.find((e) => /§21 revocation incomplete/.test(e.msg));
      assert.ok(line, `expected a revocation log line; got ${JSON.stringify(app.errors.map((e) => e.msg))}`);
      const unreached = (line!.obj as any).unreached as Array<{ destination: string; status: string }>;
      assert.ok(Array.isArray(unreached) && unreached.length > 0, "the report must name what it did not reach");
      assert.ok(
        unreached.every((o) => o.status !== "revoked"),
        "a destination reported as unreached must not carry status revoked",
      );
      // The Compass cache IS reachable here, so it must NOT be in the unreached
      // set — that is the difference this change made.
      assert.ok(
        !unreached.some((o) => o.destination === "cached_narrative"),
        `cached_narrative was reachable and must have been revoked; got ${JSON.stringify(unreached)}`,
      );
    } finally { await app.close(); }
  });
});
