/**
 * census-discovery DV-37 / DV-40 / DV-46 / DSV2-12 — the SERVE half of ranking
 * provenance.
 *
 * WHAT WAS MISSING, MEASURED RATHER THAN ASSUMED
 * ==============================================
 * `2891_rank_events_recommendation_id.sql` added `rank_events.recommendation_id`
 * and the UNIQUE index `(recommendation_id, outcome)`, and it was applied to
 * portava-ci AND to production on 2026-09-14
 * (`docs/architecture/production-deployment-2026-09-14.md`, row 4). That
 * deployment record also measured the thing this file exists to change:
 *
 *   | rows carrying a `recommendation_id` | — | **0** (the migration writes none) |
 *
 * The column had NO WRITER. `lib/discoveryServeLog.ts` computed exactly the
 * right token and wrote it into `features.recommendationId` — a jsonb key, which
 * no index arbitrates and no join key can be built on — and then issued a bare
 * `.insert(rows)`. census-discovery §32.5 names this as open in its own words:
 * *"DV-37's serve path is still bare … until both do, 2891's unique index has
 * one caller rather than two."*
 *
 * So the serve row could not be joined to its outcome (DV-46, DSV2-12), and a
 * retried batch had nothing to conflict ON (DV-37).
 *
 * WHAT IS ASSERTED HERE
 * =====================
 *   SP1  the token reaches the COLUMN, not only `features`
 *   SP3  a replayed identical batch mints identical tokens, and two placements
 *        of one item in one serve mint DIFFERENT ones — the two properties an
 *        ON CONFLICT arbiter over this column depends on
 *   SP4  column absent (42703 / PGRST204 / 42P10) ⇒ retried WITHOUT the column,
 *        warned once naming 2891, the rows still land
 *   SP6  a CHECK refusal is COUNTED and names the constraint (the hazard)
 *   SP7  a timeout is NOT read as a missing column
 *   SP8  the column and `features.recommendationId` are the SAME token
 *
 * WHAT IS NOT ASSERTED HERE, AND WHY
 * ==================================
 * This writer still issues a plain `.insert(rows)`. 2891's UNIQUE index is now
 * WRITABLE from here but is not yet the ARBITER, because `ON CONFLICT` needs
 * `.upsert(rows, { onConflict })` and `docs/architecture/census-discovery.md`
 * anchors a citation to the literal text of line 444 — a file this lane may not
 * edit. `routes/rankEvents.ts` HAS the arbiter on all three of its write paths
 * (`rankEventsDirectExposureProvenance.test.ts` proves it), so 2891's index has
 * one caller rather than two, and DV-37 does not move on this.
 *
 * There is deliberately NO test asserting that this writer does not upsert. A
 * test that pinned the gap in place would make removing it a test failure.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/discoveryServeLogProvenance.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  logDiscoveryServe,
  invalidateServeLogFlagCache,
  DiscoveryServePoint,
} from "../lib/discoveryServeLog.js";
import { recommendationIdFor } from "../lib/discoveryRecommendationId.js";
import { logger } from "../lib/logger.js";
import {
  RECOMMENDATION_ID_SHAPE,
  _resetRecommendationIdSchemaLatch,
  _resetRankEventsRejections,
  rankEventsRejectionSnapshot,
  rankEventsRejectedRows,
  RANK_EVENTS_REJECTED_MSG,
} from "../lib/rankEventsProvenance.js";

const USER_ID    = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";
const SESSION_ID = "5e550000-0000-0000-0000-000000000001";
const SERVED_AT  = "2026-09-01T10:00:00.000Z";

const ITEMS = [
  { id: "node/1001" },
  { id: "db/22222222-2222-2222-2222-222222222222" },
  { id: "way/3003" },
];

const NO_ARBITER = {
  code: "42P10",
  message: "there is no unique or exclusion constraint matching the ON CONFLICT specification",
};
const COLUMN_MISSING = {
  code: "42703",
  message: 'column rank_events.recommendation_id does not exist',
};
const SCHEMA_CACHE_MISS = {
  code: "PGRST204",
  message: "Could not find the 'recommendation_id' column of 'rank_events' in the schema cache",
};
/** What a surface/outcome CHECK refusal actually looks like coming back. */
const SURFACE_REFUSED = {
  code: "23514",
  message:
    'new row for relation "rank_events" violates check constraint "rank_events_surface_check"',
};
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };

interface Write { op: "insert" | "upsert"; rows: any[]; opts?: any }
interface LogLine { ctx: any; msg: string }

/**
 * Supabase stub: answers the `feature_flags` lookup `isFlagEnabled` makes and
 * captures every `rank_events` write.
 *
 * `withUpsert: false` reproduces a narrower client object — the shape several
 * existing suites hand this module — so the writer's capability probe is
 * exercised rather than assumed.
 */
function makeClient(o: {
  error?:       unknown;
  errorOnce?:   unknown;
  withUpsert?:  boolean;
  writes?:      Write[];
}) {
  const writes = o.writes ?? [];
  let served   = 0;
  const settle = () => {
    served += 1;
    if (o.errorOnce !== undefined && served === 1) return { error: o.errorOnce };
    return { error: o.error ?? null };
  };

  const rel: any = {
    insert(rows: any[]) { writes.push({ op: "insert", rows }); return Promise.resolve(settle()); },
  };
  if (o.withUpsert !== false) {
    rel.upsert = (rows: any[], opts?: any) => {
      writes.push({ op: "upsert", rows, opts });
      return Promise.resolve(settle());
    };
  }

  const client = {
    from(table: string) {
      if (table === "feature_flags") {
        return {
          select() { return this; },
          eq()     { return this; },
          maybeSingle() { return Promise.resolve({ data: { enabled: true }, error: null }); },
        };
      }
      if (table === "content_distribution_stats") {
        return { select() { return this; }, eq() { return this; },
                 maybeSingle() { return Promise.resolve({ data: null, error: null }); },
                 upsert() { return Promise.resolve({ error: null }); },
                 insert() { return Promise.resolve({ error: null }); } };
      }
      return rel;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { client, writes };
}

/**
 * Capture what the module actually warns.
 *
 * `lib/discoveryServeLog.ts` logs through the shared pino logger, so patching
 * `console.warn` alone would watch a channel nothing writes to and every
 * assertion below would pass vacuously. Both are patched, and the pino handle is
 * restored by deleting the own property so the prototype method comes back
 * rather than a copy of it.
 */
function captureWarnings(): { logs: LogLine[]; restore: () => void } {
  const logs: LogLine[] = [];
  const realConsole = console.warn;
  const push = (ctx: any, msg?: string) => { logs.push({ ctx, msg: msg ?? String(ctx) }); };
  console.warn = push;
  const hadOwn = Object.prototype.hasOwnProperty.call(logger, "warn");
  const prev   = (logger as any).warn;
  (logger as any).warn = push;
  return {
    logs,
    restore: () => {
      console.warn = realConsole;
      if (hadOwn) (logger as any).warn = prev;
      else delete (logger as any).warn;
    },
  };
}

async function serve(client: any, extra: Record<string, unknown> = {}) {
  await logDiscoveryServe(client, {
    userId:     USER_ID,
    servePoint: DiscoveryServePoint.COMPASS_FRESH_RANK,
    items:      ITEMS,
    sessionId:  SESSION_ID,
    servedAt:   SERVED_AT,
    ...extra,
  });
}

/** Every rank_events row written across all captured statements. */
function rowsOf(writes: Write[]): any[] {
  return writes.flatMap((w) => w.rows);
}

beforeEach(() => {
  invalidateServeLogFlagCache();
  _resetRecommendationIdSchemaLatch();
  _resetRankEventsRejections();
});

// ── SP1–SP3 · the column, the arbiter, the replay ────────────────────────────

describe("DV-40 / DV-37 — the serve writer fills 2891's column and uses its index", () => {
  it("SP1. the exposure token is written to the recommendation_id COLUMN", async () => {
    const { client, writes } = makeClient({});
    await serve(client);

    const rows = rowsOf(writes);
    assert.equal(rows.length, ITEMS.length, "one row per served item");
    for (const [i, r] of rows.entries()) {
      assert.ok(
        typeof r.recommendation_id === "string",
        `row ${i} carries no recommendation_id column — a token that lives only in the ` +
        "features jsonb is not a join key and no index arbitrates it (DV-46 / DSV2-12)",
      );
      assert.match(
        r.recommendation_id, RECOMMENDATION_ID_SHAPE,
        "2891's shape CHECK is ^[A-Za-z0-9_-]{22}$; anything else is a 23514 on a live insert",
      );
    }
  });

  it("SP8. the column and features.recommendationId are the SAME token", async () => {
    const { client, writes } = makeClient({});
    await serve(client);

    for (const r of rowsOf(writes)) {
      assert.equal(
        r.recommendation_id, r.features.recommendationId,
        "the outcome route resolves column → features → derived; two DIFFERENT values for one " +
        "exposure would make that ladder pick a rival identity depending on which rung answered",
      );
    }
  });

  it("SP1b. the token is the one recommendationIdFor mints for that exposure", async () => {
    const { client, writes } = makeClient({});
    await serve(client);

    const rows = rowsOf(writes);
    for (const [idx, item] of ITEMS.entries()) {
      assert.equal(
        rows[idx]!.recommendation_id,
        recommendationIdFor({
          userId: USER_ID, sessionId: SESSION_ID, servedAt: SERVED_AT,
          surface: "discovery", position: idx, itemId: item.id,
        }),
        "the id must be REPRODUCIBLE from the row's own columns — that is what lets " +
        "routes/rankEvents.ts derive it for a pre-2891 row instead of inventing one",
      );
    }
  });

  it("SP3. a replayed identical batch mints identical tokens", async () => {
    const a = makeClient({});
    await serve(a.client);
    invalidateServeLogFlagCache();
    const b = makeClient({});
    await serve(b.client);

    assert.deepEqual(
      rowsOf(a.writes).map((r) => r.recommendation_id),
      rowsOf(b.writes).map((r) => r.recommendation_id),
      "if a retry minted fresh ids the unique index would collapse nothing and the retry " +
      "would DOUBLE the exposure denominator — the exact failure 04 §5 warns about",
    );
  });

  it("SP3b. two positions of one item in one serve are DIFFERENT exposures", async () => {
    const { client, writes } = makeClient({});
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COMPASS_FRESH_RANK,
      items: [{ id: "node/1001" }, { id: "node/1001" }],
      sessionId: SESSION_ID, servedAt: SERVED_AT,
    });
    const ids = rowsOf(writes).map((r) => r.recommendation_id);
    assert.notEqual(
      ids[0], ids[1],
      "a denominator counts EXPOSURES; collapsing two placements of one item would under-count " +
      "them, and would also make the upsert affect one row twice in a single statement (21000)",
    );
  });
});

// ── SP4–SP5 · degradation ────────────────────────────────────────────────────

describe("DV-37 — the serve writer degrades observably where 2891 is absent", () => {
  for (const [name, err] of [
    ["42P10 (no arbiter)", NO_ARBITER],
    ["42703 (no column)", COLUMN_MISSING],
    ["PGRST204 (schema cache)", SCHEMA_CACHE_MISS],
  ] as const) {
    it(`SP4. ${name} ⇒ retried WITHOUT the column, and said once`, async () => {
      const cap = captureWarnings();
      try {
        const { client, writes } = makeClient({ errorOnce: err });
        await serve(client);

        assert.equal(writes.length, 2, "one attempt with the column, one legacy retry");
        assert.ok(
          writes[0]!.rows.every((r: any) => RECOMMENDATION_ID_SHAPE.test(r.recommendation_id)),
          "the first attempt is the one that carries the join key",
        );
        for (const r of writes[1]!.rows) {
          assert.equal(
            Object.prototype.hasOwnProperty.call(r, "recommendation_id"), false,
            "the retry must OMIT the column, not send null: sending it again is the same " +
            "failure a second time, and a null would defeat the CHECK-less historical shape",
          );
          assert.ok(r.features.recommendationId, "the token still reaches features");
        }
        const said = cap.logs.filter((l) =>
          /2891|recommendation_id/i.test(JSON.stringify(l.ctx ?? {}) + l.msg));
        assert.ok(
          said.length >= 1,
          `a database without 2891 must be distinguishable from one that has it. logs: ` +
          JSON.stringify(cap.logs.map((l) => l.msg)),
        );
      } finally { cap.restore(); }
    });
  }

  it("SP4b. the degradation is announced ONCE per writer, not once per serve", async () => {
    const cap = captureWarnings();
    try {
      const first = makeClient({ errorOnce: NO_ARBITER });
      await serve(first.client);
      const before = cap.logs.length;
      invalidateServeLogFlagCache();
      const second = makeClient({});
      await serve(second.client);
      assert.equal(
        cap.logs.length, before,
        "one line per process per writer; a line per serve is how a real signal gets " +
        "trained out of a reader",
      );
      assert.equal(
        second.writes.length, 1,
        "the latch must persist — re-attempting the 2891 shape every serve would pay the " +
        "failed round-trip forever",
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(second.writes[0]!.rows[0], "recommendation_id"), false,
        "and the latch must reach the PAYLOAD, not only the retry: a serve after the latch " +
        "must not send the column at all",
      );
    } finally { cap.restore(); }
  });

  it("SP7. a statement timeout is NOT read as a missing column", async () => {
    const { client, writes } = makeClient({ errorOnce: TIMEOUT });
    await serve(client);
    assert.equal(
      writes.length, 1,
      "retrying a timeout in the legacy shape would hide an outage as a schema gap and " +
      "would silently drop the join key on a database that has the column",
    );
  });
});

// ── SP6 · the fire-and-forget hazard ─────────────────────────────────────────

describe("the fire-and-forget hazard — a refused serve write is COUNTED, not only mentioned", () => {
  it("SP6. a CHECK refusal is counted and NAMES the constraint", async () => {
    const cap = captureWarnings();
    try {
      const { client } = makeClient({ error: SURFACE_REFUSED });
      await serve(client);

      const seen = rankEventsRejectionSnapshot();
      assert.equal(seen.length, 1, "a refused fire-and-forget write must leave a countable trace");
      assert.equal(
        seen[0]!.constraint, "rank_events_surface_check",
        "naming the constraint is the difference between 'telemetry stopped' and 'the " +
        "surface CHECK is refusing this surface' — 0202 exists because nobody could tell",
      );
      assert.equal(seen[0]!.code, "23514");
      assert.equal(seen[0]!.writer, "lib/discoveryServeLog.ts");
      assert.equal(
        seen[0]!.rows, ITEMS.length,
        "the count that matters is ROWS LOST, not statements attempted",
      );
      assert.equal(rankEventsRejectedRows(), ITEMS.length);
      assert.ok(
        cap.logs.some((l) => l.msg === RANK_EVENTS_REJECTED_MSG),
        `the one findable warn shape must be emitted. logs: ${JSON.stringify(cap.logs.map((l) => l.msg))}`,
      );
    } finally { cap.restore(); }
  });

  it("SP6b. a refused write is still fire-and-forget — it never throws", async () => {
    const cap = captureWarnings();
    try {
      const { client } = makeClient({ error: SURFACE_REFUSED });
      await assert.doesNotReject(() => serve(client),
        "making rejection observable must not make it blocking; that would change request behaviour");
    } finally { cap.restore(); }
  });

  it("SP6c. repeated refusals accumulate into ONE class rather than N lines", async () => {
    const cap = captureWarnings();
    try {
      for (let i = 0; i < 3; i += 1) {
        invalidateServeLogFlagCache();
        const { client } = makeClient({ error: SURFACE_REFUSED });
        await serve(client);
      }
      const seen = rankEventsRejectionSnapshot();
      assert.equal(seen.length, 1, "same writer, same constraint, same code — one class");
      assert.equal(seen[0]!.count, 3, "three refused statements");
      assert.equal(seen[0]!.rows, 3 * ITEMS.length, "nine rows lost");
    } finally { cap.restore(); }
  });
});
