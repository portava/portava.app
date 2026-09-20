/**
 * Trips spec §15.2 — a RE-import is a new VERSION of a booking, not a second
 * booking (census-trips TR290).
 *
 * §15.2 asks for cancellation / refund policies "imported as VERSIONED facts,
 * treated with provenance and confidence". Provenance and confidence were
 * already kept per row (0172's `raw_text`, `extraction`,
 * `extraction_confidence`); 2784 added `trip_reservations.version`, bumped by
 * trigger on every UPDATE, with an append-only `trip_reservation_events` row
 * naming the keys that changed.
 *
 * What was missing was the writer. `POST /reservations/import` INSERTED
 * unconditionally, so pasting the airline's "your booking has changed" email
 * produced a SECOND reservation beside the first: two rows, two cancellation
 * deadlines, nothing relating them and nothing saying which is current. The
 * policy had no history because it had no identity.
 *
 * These pin the identity rule and, as importantly, its LIMITS:
 *
 *  - the match is `confirmation_ref` + `type`, and only when it resolves to
 *    exactly ONE live row. One PNR routinely covers an outbound and a return;
 *    collapsing two flights into one is worse than a duplicate a member can
 *    delete, so an ambiguous reference INSERTS and says it did.
 *  - `status` is never patched. Re-reading the email does not un-confirm a
 *    booking the member confirmed, nor resurrect one they dismissed.
 *  - an unreadable lookup REFUSES. supabase-js resolves on a database error,
 *    so an unbound error reads exactly like "no booking has this reference"
 *    and would duplicate every booking on the trip.
 *
 * Runtime: node:test + node:assert/strict. No network / no real DB.
 * Run: node --import tsx/esm --test src/test/tripReservationReimport.test.ts
 */
import { describe, it, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const TRIP_ID  = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RES_ID   = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const RES2_ID  = "dddddddd-dddd-dddd-dddd-dddddddddddd";

type Row = Record<string, any>;

function makeFakeClient(tables: Record<string, Row[]>, errorOn: string[] = []) {
  let idCtr = 0;
  const newId = () => `${String(++idCtr).padStart(8, "0")}-0000-0000-0000-000000000000`;

  function from(table: string) {
    if (errorOn.includes(table)) {
      const f: any = {
        select: () => f, insert: () => f, update: () => f, delete: () => f,
        eq: () => f, in: () => f, is: () => f, order: () => f, limit: () => f,
        maybeSingle: async () => ({ data: null, error: { message: `${table} unavailable` } }),
        single: async () => ({ data: null, error: { message: `${table} unavailable` } }),
        then: (onF: any, onR: any) => Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(onF, onR),
      };
      return f;
    }
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    const rows = () => (tables[table] ??= []);
    const matched = () => rows().filter((r) => filters.every((f) => f(r)));

    async function resolve(one: boolean) {
      if (op === "insert") {
        const list = Array.isArray(payload) ? payload : [payload];
        // 2784: `version` starts at 0 and the TRIGGER bumps it on every
        // UPDATE. The fake carries the same rule so a "did this write produce
        // a new version" assertion means what it says.
        const made = list.map((r) => ({ id: newId(), version: 0, created_at: "2026-01-01T00:00:00.000Z", ...r }));
        rows().push(...made);
        return { data: one ? made[0] ?? null : made, error: null };
      }
      if (op === "update") {
        let last: Row | null = null;
        for (const r of rows()) {
          if (filters.every((f) => f(r))) {
            Object.assign(r, payload);
            r.version = Number(r.version ?? 0) + 1;
            last = r;
          }
        }
        return { data: one ? last : null, error: null };
      }
      if (op === "delete") { tables[table] = rows().filter((r) => !filters.every((f) => f(r))); return { data: null, error: null }; }
      const m = matched();
      return { data: one ? m[0] ?? null : m, error: null };
    }

    const b: any = {
      select: () => b,
      insert(p: any) { op = "insert"; payload = p; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      delete() { op = "delete"; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      order: () => b, limit: () => b,
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(onF: any, onR: any) { return resolve(false).then(onF, onR); },
    };
    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) =>
        token === "owner-token"
          ? { data: { user: { id: OWNER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

function baseTables(reservations: Row[] = []): Record<string, Row[]> {
  return {
    feature_flags: [{ flag: "reservation_import_enabled", enabled: true }],
    trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
    trip_members: [{ trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" }],
    trip_reservations: reservations,
    trip_plan_items: [],
  };
}

const flight = (over: Row = {}): Row => ({
  id: RES_ID, trip_id: TRIP_ID, user_id: OWNER_ID, type: "flight",
  title: "TP1234 LIS→OPO", starts_at: "2026-08-14T09:00:00.000Z", ends_at: "2026-08-14T10:00:00.000Z",
  location_name: "Lisbon", confirmation_ref: "PNR777",
  cancellation_deadline_at: "2026-08-10T00:00:00.000Z",
  raw_text: "the first email", extraction: null, extraction_confidence: 0.8,
  status: "confirmed", created_from: "paste", version: 4, ...over,
});

/** The model's answer for a re-read of the SAME booking with a moved policy. */
function extractionOf(reservations: Row[]): string {
  return JSON.stringify({ reservations });
}
const RESCHEDULED = {
  type: "flight", title: "TP1234 LIS→OPO",
  startsAt: "2026-08-14T13:00:00Z", endsAt: "2026-08-14T14:00:00Z",
  locationName: "Lisbon", confirmationRef: "PNR777",
  cancellationDeadlineAt: "2026-08-12T00:00:00Z", confidence: 0.95,
};

function openAI(content: string): any {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { role: "assistant", content } }] }) } } };
}

let app: Express; let server: Server; let port: number;

async function startServer() {
  const { default: reservationsRouter } = await import("../routes/tripReservations.js");
  app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }; next(); });
  app.use("/api", reservationsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;
}

/**
 * The shape POST /trips/:id/reservations/import actually emits. Named rather
 * than inferred because `Response.json()` is typed `Promise<unknown>`: reading
 * a field straight off it is a type error, and the two ways to silence that —
 * `any`, or a cast with no runtime check — both let a fixture describe a
 * response the route never sends. Every field here is one this file asserts on.
 */
interface ImportResponseBody {
  updatedCount?: number;
  createdCount?: number;
  needsConfirmation?: boolean;
  ambiguousReferences?: unknown;
  error?: string;
}

async function importText(text = "the reschedule email"): Promise<{ status: number; body: ImportResponseBody }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/reservations/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer owner-token", connection: "close" },
    body: JSON.stringify({ text }),
  });
  const parsed: unknown = await r.json().catch(() => null);
  // Checked, not asserted-by-cast: a route that answers with a non-object (or
  // with nothing parseable) fails HERE, naming the status, rather than surfacing
  // as `undefined !== 1` in whichever assertion happened to read a field first.
  assert.ok(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    `import must answer with a JSON object; status ${r.status} gave ${JSON.stringify(parsed)}`,
  );
  return { status: r.status, body: parsed as ImportResponseBody };
}

describe("§15.2 a re-import is a new VERSION of a booking (TR290)", () => {
  beforeEach(async () => { if (server) server.close(); await startServer(); });
  afterEach(() => { _setTestOpenAI(null); });
  after(() => { if (server) server.close(); _setTestClient(null as any, false); _setTestOpenAI(null); });

  it("re-importing a booking the trip already holds UPDATES it — one row, a new version, the new policy", async () => {
    const tables = baseTables([flight()]);
    _setTestClient(makeFakeClient(tables) as any, true);
    _setTestOpenAI(openAI(extractionOf([RESCHEDULED])));

    const r = await importText();
    assert.equal(r.status, 201);
    assert.equal(tables.trip_reservations.length, 1, "no second booking beside the first");
    const row = tables.trip_reservations[0];
    assert.equal(row.id, RES_ID, "the SAME row — the booking keeps its identity");
    assert.equal(row.version, 5, "2784's version moved: this is a new version of a fact");
    assert.equal(row.cancellation_deadline_at, "2026-08-12T00:00:00.000Z", "the policy is the newly imported one");
    assert.equal(row.starts_at, "2026-08-14T13:00:00.000Z");
    assert.equal(row.extraction_confidence, 0.95, "confidence travels with the version it belongs to");
    assert.equal(row.raw_text, "the reschedule email", "provenance is the text this version came from");
    assert.equal(r.body.updatedCount, 1);
    assert.equal(r.body.createdCount, 0);
  });

  it("a re-import does NOT un-confirm a confirmed booking, and does not resurrect a dismissed one", async () => {
    for (const status of ["confirmed", "dismissed"]) {
      const tables = baseTables([flight({ status })]);
      _setTestClient(makeFakeClient(tables) as any, true);
      _setTestOpenAI(openAI(extractionOf([RESCHEDULED])));
      const r = await importText();
      assert.equal(r.status, 201);
      assert.equal(tables.trip_reservations[0].status, status,
        "only the FACTS take a new version; the member's decision is theirs");
      assert.equal(tables.trip_reservations[0].created_from, "paste");
    }
  });

  it("a booking with a reference this trip does not hold is still a NEW booking", async () => {
    const tables = baseTables([flight({ confirmation_ref: "PNR000" })]);
    _setTestClient(makeFakeClient(tables) as any, true);
    _setTestOpenAI(openAI(extractionOf([RESCHEDULED])));
    const r = await importText();
    assert.equal(r.status, 201);
    assert.equal(tables.trip_reservations.length, 2);
    assert.equal(r.body.createdCount, 1);
    assert.equal(r.body.updatedCount, 0);
  });

  it("an extraction with NO reference cannot be matched, so it is a new booking", async () => {
    const tables = baseTables([flight()]);
    _setTestClient(makeFakeClient(tables) as any, true);
    const { confirmationRef: _none, ...noRef } = RESCHEDULED;
    _setTestOpenAI(openAI(extractionOf([noRef])));
    const r = await importText();
    assert.equal(r.status, 201);
    assert.equal(tables.trip_reservations.length, 2, "a reference is the only identity a booking has");
    assert.equal(r.body.createdCount, 1);
  });

  it("an AMBIGUOUS reference — one PNR, two flights — is never merged into one of them, and says so", async () => {
    const tables = baseTables([
      flight(),
      flight({ id: RES2_ID, title: "TP4321 OPO→LIS", starts_at: "2026-08-20T09:00:00.000Z" }),
    ]);
    _setTestClient(makeFakeClient(tables) as any, true);
    _setTestOpenAI(openAI(extractionOf([RESCHEDULED])));
    const r = await importText();
    assert.equal(r.status, 201);
    assert.equal(tables.trip_reservations.length, 3, "collapsing two legs into one is worse than a duplicate");
    assert.equal(r.body.ambiguousReferences, 1);
    assert.equal(r.body.updatedCount, 0);
    assert.equal(tables.trip_reservations[0].version, 4, "neither original was touched");
    assert.equal(tables.trip_reservations[1].version, 4);
  });

  it("a CANCELLED booking with the same reference does not capture the re-import", async () => {
    const tables = baseTables([flight({ status: "cancelled" })]);
    _setTestClient(makeFakeClient(tables) as any, true);
    _setTestOpenAI(openAI(extractionOf([RESCHEDULED])));
    const r = await importText();
    assert.equal(r.status, 201);
    assert.equal(tables.trip_reservations.length, 2, "rebooking under the same reference is a new booking");
    assert.equal(tables.trip_reservations[0].status, "cancelled", "the cancelled row is left alone");
    assert.equal(r.body.createdCount, 1);
  });

  it("a different TYPE under the same reference is a different booking", async () => {
    const tables = baseTables([flight({ type: "stay", title: "Hotel Azul" })]);
    _setTestClient(makeFakeClient(tables) as any, true);
    _setTestOpenAI(openAI(extractionOf([RESCHEDULED])));
    const r = await importText();
    assert.equal(r.status, 201);
    assert.equal(tables.trip_reservations.length, 2);
  });

  it("an UNREADABLE existing-booking lookup REFUSES — it never duplicates the itinerary", async () => {
    const tables = baseTables([flight()]);
    _setTestClient(makeFakeClient(tables, ["trip_reservations"]) as any, true);
    _setTestOpenAI(openAI(extractionOf([RESCHEDULED])));
    const r = await importText();
    assert.equal(r.status, 503, "the import is safe to retry; a duplicated itinerary is not");
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("an import into an EMPTY trip is unchanged: one insert, no lookup needed beyond the reference scan", async () => {
    const tables = baseTables([]);
    _setTestClient(makeFakeClient(tables) as any, true);
    _setTestOpenAI(openAI(extractionOf([RESCHEDULED])));
    const r = await importText();
    assert.equal(r.status, 201);
    assert.equal(tables.trip_reservations.length, 1);
    assert.equal(tables.trip_reservations[0].status, "pending_confirm", "extraction never auto-commits");
    assert.equal(r.body.createdCount, 1);
    assert.equal(r.body.updatedCount, 0);
    assert.equal(r.body.ambiguousReferences, 0);
    assert.equal(r.body.needsConfirmation, true);
  });
});
