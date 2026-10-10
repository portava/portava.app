/**
 * census G150 (§23) — the Trip-date conflict reaches the traveller from the form
 * that is mounted, END TO END through POST /input-assistance/suggest.
 *
 * `app/trip/new.tsx` asks for creation assistance on `trip_title` and sends the
 * new Trip's window as `sessionContext.startDate` / `endDate` — the place the
 * client contract (types/inputSuggestion.ts, InputSessionContext) says it goes.
 * The route used to keep only `tripId` / `cityId` from the session context, so
 * the window never reached the check and the conflict row could not be
 * produced on that surface. These tests send exactly what that screen sends.
 *
 * MUTATION LOG (applied with scratchpad mutate.py, watched go red, restored):
 *   - routes/inputAssistance.ts: the handler uses `parseCreationDraft(body.draft)`
 *     alone again → "the window the form sends in the session context" red.
 *   - drop the `declaresCheck(policy, 'trip_date_conflict')` gate in
 *     `withDeclaredSessionDates` → "a field that does not declare the check gains
 *     nothing" red.
 *   - drop the ISO-date shape test → "a value that is not a date is dropped" red.
 *   - let the session context win over the draft → "a date the draft already
 *     carries wins" red.
 *
 * Run: node --import tsx/esm --test src/test/inputCreationSessionDates.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter, { withDeclaredSessionDates } from "../routes/inputAssistance.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const ME_TOK = "tok-me";

// ── Fake Supabase client (the inputAssistanceSavedEntities harness, verbatim) ──
interface FakeState { [key: string]: any[] | undefined; }

function makeFakeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let _limitN = Infinity;
      const builder: any = {
        select() { return builder; },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") filters.push((r) => r[col] !== val && r[col] != null);
          return builder;
        },
        is(col: string, val: any) {
          filters.push((r) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        ilike(col: string, pat: string) {
          const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
          filters.push((r) => re.test(String(r[col] ?? "")));
          return builder;
        },
        or(expr: string) {
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.([\w]+)\.(.+)$/);
            if (!m) return null;
            return { col: m[1]!, op: m[2]!.toLowerCase(), val: m[3]! };
          }).filter(Boolean) as { col: string; op: string; val: string }[];
          filters.push((r) =>
            parts.some(({ col, op, val }) => {
              const cellStr = String(r[col] ?? "");
              if (op === "ilike") {
                const re = new RegExp("^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
                return re.test(cellStr);
              }
              if (op === "eq") return cellStr === val;
              return false;
            }),
          );
          return builder;
        },
        gte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] >= val); return builder; },
        lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return builder; },
        order() { return builder; },
        limit(n: number) { _limitN = n; return builder; },
        range(start: number, end: number) { _rangeStart = start; _rangeEnd = end; return builder; },
        maybeSingle() {
          const matched = sourceRows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const matched = sourceRows
            .filter((r) => filters.every((f) => f(r)))
            .slice(_rangeStart, _rangeEnd < Infinity ? _rangeEnd + 1 : _limitN < Infinity ? _limitN : undefined);
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}


let base: string;
let server: Server;

function setup(state: FakeState) {
  _setTestClient(makeFakeClient(state) as any, true);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", inputAssistanceRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});
after(() => server.close());
beforeEach(() => { _resetRateLimit(); setup({}); });

async function suggest(body: any): Promise<any> {
  const r = await fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${ME_TOK}` },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200);
  return r.json();
}

/** The viewer already has a Trip on 10-20 March. */
function withTrip(): FakeState {
  return {
    trip_members: [{ trip_id: "t1", role: "owner", user_id: ME }],
    trips: [{ id: "t1", title: "Bangkok Week", start_date: "2026-03-10", end_date: "2026-03-20", status: "upcoming" }],
    blocks: [], hidden_gems: [], places: [], events: [], profiles: [], user_privacy_settings: [],
  };
}

/** What app/trip/new.tsx sends for its title field (useCreationAssistance → useInputAssistance). */
function tripNewBody(startDate: unknown, endDate: unknown, text = "Spring Escape") {
  return {
    context: "trip_title", fieldId: "creation.trip_title", text, limit: 8,
    sessionContext: { surface: "trip_create", startDate, endDate },
  };
}

function conflict(body: any): any {
  return (body.suggestions as any[]).find((s) => s.type === "validation" && s.structuredValue?.kind === "trip_date_conflict");
}

describe("G150: the Trip-date conflict reaches the mounted Trip form", () => {
  it("the window the form sends in the session context is checked, and the conflict comes back", async () => {
    setup(withTrip());
    const body = await suggest(tripNewBody("2026-03-15", "2026-03-25"));
    const row = conflict(body);
    assert.ok(row, "the overlapping window is explained");
    assert.equal(row.structuredValue.conflictsWithTripId, "t1");
  });

  it("a window that overlaps nothing says nothing", async () => {
    setup(withTrip());
    const body = await suggest(tripNewBody("2026-06-01", "2026-06-05"));
    assert.equal(conflict(body), undefined);
  });

  it("a value that is not a date is dropped, never guessed", async () => {
    setup(withTrip());
    const body = await suggest(tripNewBody("next week", "soon"));
    assert.equal(conflict(body), undefined);
    assert.equal(withDeclaredSessionDates(undefined, { startDate: "next week", endDate: "soon" }, resolvePolicy("trip_title")!), undefined);
  });

  it("a field that does not declare the check gains nothing from the session context", async () => {
    const session = { startDate: "2026-03-15", endDate: "2026-03-25" };
    for (const context of ["event_title", "hidden_gem_name", "global_search"] as const) {
      assert.equal(withDeclaredSessionDates(undefined, session, resolvePolicy(context)!), undefined, context);
    }
    assert.deepEqual(withDeclaredSessionDates(undefined, session, resolvePolicy("trip_title")!), session, "premise: a declaring field does");
  });

  it("a date the draft already carries wins over the session context", () => {
    const out = withDeclaredSessionDates({ startDate: "2026-04-01" }, { startDate: "2026-03-15", endDate: "2026-03-25" }, resolvePolicy("trip_title")!);
    assert.deepEqual(out, { startDate: "2026-04-01", endDate: "2026-03-25" });
  });
});
