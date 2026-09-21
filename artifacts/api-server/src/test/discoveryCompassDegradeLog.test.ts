/**
 * DV-07 — the Compass serve path's degrade must leave a trace.
 *
 * WHAT WAS WRONG
 * ==============
 * `GET /discovery`'s Compass block — the cache-B replay, the cache-B store and
 * the fresh `rankItemsForDiscovery` rank that is serve point 5 — was wrapped in
 *
 *     } catch { /* fall through to normal rule-based path *\/ }
 *
 * A bare `catch` with no binding and no log line. The fall-through itself is
 * DELIBERATE and is not the defect: a ranker failure must degrade to the
 * rule-based order, never become a 500, and this file pins that too. The defect
 * is that a degraded serve and a healthy one were INDISTINGUISHABLE from
 * outside the process. Every signal a Compass failure could have produced —
 * the exception, the fact that serve point 5 stopped happening, the silent
 * disappearance of Compass ordering — was consumed by that one line, so the
 * only way to learn Compass was down was to notice the ranking looked wrong.
 *
 * THE HOUSE IDIOM, and where it already is
 * ========================================
 * `lib/discoveryServeLog.ts`'s own error branch is the PASS example the census
 * row cites: it logs `{ err, ... }` with a sentence naming what was lost before
 * degrading, on the argument that "a refusal nobody can see is how a defect
 * survives". This route already speaks the same idiom at its other two degrade
 * points — the PDE ranking failure and the shadow-observation failure both
 * `req.log.warn({ err }, "discovery: ... failed — ...")`. The Compass block was
 * the one degrade of the three that said nothing.
 *
 * WHAT IS PINNED
 * ==============
 *   D1. A throw out of the Compass path still SERVES — 200, with places — so
 *       the degrade is preserved and the fix cannot be "turn it into a 500".
 *   D2. That same request emits exactly one warn line carrying the error, so an
 *       operator reading logs can tell a degraded serve from a normal one.
 *   D3. A HEALTHY Compass serve emits no such line — the trace names a real
 *       failure rather than being printed on every request, which would be the
 *       same blindness with more output.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/discoveryCompassDegradeLog.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import discoveryRouter, {
  _setTestDbPlacesOverride,
  _clearTestCompassCache,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateFlagsCache } from "../compass/flags.js";

// ── Block external network calls ──────────────────────────────────────────────
const _originalFetch = globalThis.fetch;
globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (urlStr.includes("overpass-api.de") || urlStr.includes("nominatim.openstreetmap.org")) {
    throw new Error("Network blocked in test environment");
  }
  return _originalFetch(url as string, init);
};

/** Distinct per run so CompassProfileService's own profile cache cannot mask the throw. */
const VIEWER = "eeee5555-0000-0000-0000-0000000000d7";
const TOKEN  = "dv07-tok";

function place(id: string, savedCount: number): DiscoveryPlace {
  return {
    id: `db/${id}`, name: id, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1.0, lat: 25.77, lng: -80.19, tags: [],
    address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount,
  } as DiscoveryPlace;
}

// ── Captured log lines ────────────────────────────────────────────────────────

interface LogLine { level: string; obj: Record<string, unknown>; msg: string }

function capturingLogger(sink: LogLine[]): any {
  const rec = (level: string) => (a: unknown, b?: unknown) => {
    if (typeof a === "string") sink.push({ level, obj: {}, msg: a });
    else sink.push({ level, obj: (a ?? {}) as Record<string, unknown>, msg: String(b ?? "") });
  };
  const l: any = {
    warn: rec("warn"), info: rec("info"), error: rec("error"),
    debug: rec("debug"), trace: rec("trace"), fatal: rec("fatal"),
  };
  l.child = () => l;
  return l;
}

/**
 * Fake service client.
 *
 * `compassThrows` makes the FIRST read `CompassProfileService.buildProfile`
 * issues that no other Discovery reader touches — `compass_user_preferences` —
 * throw. That puts the failure squarely inside the Compass block and nowhere
 * else, so a degrade observed here is the Compass degrade and not some other
 * path's.
 */
function fakeClient(opts: { compassThrows: boolean }) {
  function benign(): any {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, is: () => q, or: () => q,
      neq: () => q, not: () => q, ilike: () => q, like: () => q,
      gte: () => q, lte: () => q, gt: () => q, lt: () => q, order: () => q,
      limit: () => q, range: () => q, contains: () => q, overlaps: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      insert: () => Promise.resolve({ data: null, error: null }),
      upsert: () => Promise.resolve({ data: null, error: null }),
      update: () => q, delete: () => q,
      then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
    };
    return q;
  }

  return {
    auth: {
      getUser: async (t: string) =>
        t === TOKEN ? { data: { user: { id: VIEWER } }, error: null }
                    : { data: { user: null }, error: null },
    },
    from(table: string) {
      if (table === "compass_user_preferences" && opts.compassThrows) {
        throw new Error("compass_user_preferences unreachable (test)");
      }
      if (table === "feature_flags") {
        let flag = "";
        const COMPASS_ROWS = [{ flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true }];
        const q: any = {
          select: () => q,
          eq: (col: string, val: any) => { if (col === "flag") flag = val; return q; },
          like: () => ({ then: (r: any) => Promise.resolve({ data: COMPASS_ROWS, error: null }).then(r) }),
          maybeSingle: async () => {
            if (flag === "COMPASS_V1_RULE_BASED_ENABLED") return { data: { enabled: true }, error: null };
            if (flag === "DISCOVERY_ENGINE_MODE") {
              return { data: { enabled: false, metadata: { mode: "legacy" } }, error: null };
            }
            return { data: null, error: null };
          },
          then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
        };
        return q;
      }
      return benign();
    },
    rpc: async () => ({ data: null, error: null }),
  } as any;
}

function makeApp(sink: LogLine[]) {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = capturingLogger(sink); next(); });
  app.use(discoveryRouter);
  return app;
}

function startServer(sink: LogLine[]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(makeApp(sink));
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as any).port}` });
    });
  });
}

/** Lines that carry an `err` AND read as the Compass path degrading. */
function compassDegradeLines(sink: LogLine[]): LogLine[] {
  return sink.filter((l) =>
    l.level === "warn" &&
    l.obj.err !== undefined &&
    /compass/i.test(l.msg) &&
    /(degrad|fall|fallback|rule-based)/i.test(l.msg),
  );
}

describe("DV-07 — a Compass failure degrades LOUDLY, not silently", () => {
  let server: Server;
  let url: string;
  let sink: LogLine[];

  beforeEach(async () => {
    sink = [];
    ({ server, url } = await startServer(sink));
    _setTestDbPlacesOverride(async () => [place("p1", 10), place("p2", 500), place("p3", 100)]);
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
    invalidateFlagsCache();
  });

  afterEach(async () => {
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
    invalidateFlagsCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function serve(): Promise<{
    status: number; places: Array<{ id: string }>; meta?: { cacheLevel?: string };
  }> {
    const res = await fetch(
      `${url}/discovery?destination=Miami&category=for_you&lat=25.77&lng=-80.19&radiusKm=10`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const body = res.status === 200
      ? ((await res.json()) as { places?: Array<{ id: string }>; meta?: { cacheLevel?: string } })
      : {};
    return { status: res.status, places: body.places ?? [], meta: body.meta };
  }

  it("D1. the degrade is KEPT — a Compass throw still serves the rule-based page, not a 500", async () => {
    _setTestServiceClient(fakeClient({ compassThrows: true }));
    const { status, places, meta } = await serve();
    assert.equal(status, 200, "the fall-through to the rule-based path is deliberate and must not become a 500");
    assert.ok(
      places.length > 0,
      "a degraded serve still serves: the rule-based order is the point of the fall-through",
    );
    // Only the cold/rule-based tail carries `meta.cacheLevel`; the Compass
    // fresh-rank envelope has no `meta` at all. So this is the assertion that
    // the request really did LEAVE the Compass block rather than succeed in it.
    assert.equal(
      meta?.cacheLevel, "miss",
      "precondition: the throw really was caught and the rule-based path served this page",
    );
  });

  it("D2. the degrade is VISIBLE — one warn line carrying the error names what was lost", async () => {
    _setTestServiceClient(fakeClient({ compassThrows: true }));
    const { status } = await serve();
    assert.equal(status, 200, "precondition: this request degraded rather than failing");

    const lines = compassDegradeLines(sink);
    assert.equal(
      lines.length, 1,
      "an operator cannot tell a degraded serve from a normal one without a log line; " +
      `saw ${lines.length} matching warn line(s) in ${JSON.stringify(sink.map((l) => `${l.level}:${l.msg}`))}`,
    );
    const err = lines[0]!.obj.err as any;
    assert.ok(err, "the line must carry the error object — a message with no `err` cannot be diagnosed");
    assert.match(
      String(err?.message ?? err),
      /compass_user_preferences unreachable/,
      "the logged error must be the ACTUAL throw, not a re-worded stand-in",
    );
  });

  it("D3. a healthy Compass serve emits no degrade line", async () => {
    _setTestServiceClient(fakeClient({ compassThrows: false }));
    const { status, meta } = await serve();
    assert.equal(status, 200, "precondition: the healthy serve returned");
    // No `meta` ⇒ this was the Compass fresh-rank envelope (serve point 5), so
    // D3 is a statement about a Compass serve that really happened rather than
    // about a request that never entered the block.
    assert.equal(
      meta, undefined,
      "precondition: the Compass path SERVED this page — otherwise this test asserts nothing",
    );
    assert.deepEqual(
      compassDegradeLines(sink).map((l) => l.msg), [],
      "a trace printed on every request is the same blindness with more output",
    );
  });
});
