/**
 * entryRequirements backend tests
 *
 * Covers:
 * - Passport CRUD: create (country-name resolution), invalid country,
 *   is_primary exclusivity, cross-user PATCH refusal, delete.
 * - Trip passport selection: membership gate, passport-ownership gate, clear.
 * - Entry matrix: flag gate, caller full detail vs others status-only,
 *   unknown-corridor honesty, unrecognized-destination honesty.
 * - Admin corridor CRUD: role gate, official_source_url required,
 *   upsert stamps last_verified_at + verified_by.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ---------------------------------------------------------------------------
// IDs & tokens
// ---------------------------------------------------------------------------
const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID  = "33333333-3333-3333-3333-333333333333";
const ADMIN_ID  = "44444444-4444-4444-4444-444444444444";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const P_OWNER   = "55555555-5555-5555-5555-555555555555";
const P_MEMBER  = "66666666-6666-6666-6666-666666666666";

const TOKENS: Record<string, string> = {
  "owner-token":  OWNER_ID,
  "member-token": MEMBER_ID,
  "other-token":  OTHER_ID,
  "admin-token":  ADMIN_ID,
};

// ---------------------------------------------------------------------------
// Generic fake Supabase client (thenable builder)
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
interface FakeTable { rows: Row[] }

let idCtr = 0;
function newId() {
  const n = String(++idCtr).padStart(12, "0");
  return `00000000-0000-4000-8000-${n}`;
}

function makeFakeClient(tables: Record<string, FakeTable>) {
  function from(table: string) {
    const t = tables[table];
    const state: any = {
      op: "select", filters: [] as Array<{ kind: string; col: string; val: any }>,
      payload: null, single: false, maybe: false, wantRows: true,
    };

    function match(row: Row): boolean {
      return state.filters.every((f: any) =>
        f.kind === "eq" ? row[f.col] === f.val :
        f.kind === "in" ? (f.val as any[]).includes(row[f.col]) : true,
      );
    }

    async function exec(): Promise<{ data: any; error: any }> {
      if (!t) return { data: null, error: { message: `table ${table} missing` } };
      if (state.op === "select") {
        const rows = t.rows.filter(match);
        if (state.single || state.maybe) {
          if (rows.length === 0) {
            return state.maybe
              ? { data: null, error: null }
              : { data: null, error: { message: "no rows" } };
          }
          return { data: rows[0], error: null };
        }
        return { data: rows, error: null };
      }
      if (state.op === "insert") {
        const list = Array.isArray(state.payload) ? state.payload : [state.payload];
        const inserted = list.map((p: Row) => {
          const row = { id: newId(), created_at: new Date().toISOString(), ...p };
          t.rows.push(row);
          return row;
        });
        return { data: state.single ? inserted[0] : inserted, error: null };
      }
      if (state.op === "update") {
        const updated: Row[] = [];
        for (const row of t.rows) {
          if (match(row)) { Object.assign(row, state.payload); updated.push(row); }
        }
        if (state.single || state.maybe) {
          return updated.length > 0
            ? { data: updated[0], error: null }
            : { data: null, error: state.maybe ? null : { message: "no rows" } };
        }
        return { data: updated, error: null };
      }
      if (state.op === "upsert") {
        const conflictCols: string[] = (state.onConflict ?? "").split(",").filter(Boolean);
        const p = state.payload as Row;
        const existing = t.rows.find((r) => conflictCols.every((c) => r[c] === p[c]));
        let result: Row;
        if (existing) { Object.assign(existing, p); result = existing; }
        else { result = { id: newId(), created_at: new Date().toISOString(), ...p }; t.rows.push(result); }
        return { data: state.single ? result : [result], error: null };
      }
      if (state.op === "delete") {
        const keep = t.rows.filter((r) => !match(r));
        const removed = t.rows.length - keep.length;
        t.rows = keep;
        return { data: removed, error: null };
      }
      return { data: null, error: { message: "unsupported op" } };
    }

    const builder: any = {
      select(_cols?: string) { if (state.op === "select") state.op = "select"; state.wantRows = true; return builder; },
      eq(col: string, val: any) { state.filters.push({ kind: "eq", col, val }); return builder; },
      in(col: string, val: any[]) { state.filters.push({ kind: "in", col, val }); return builder; },
      order() { return builder; },
      limit() { return builder; },
      insert(payload: any) { state.op = "insert"; state.payload = payload; return builder; },
      update(payload: any) { state.op = "update"; state.payload = payload; return builder; },
      upsert(payload: any, opts?: any) { state.op = "upsert"; state.payload = payload; state.onConflict = opts?.onConflict; return builder; },
      delete() { state.op = "delete"; return builder; },
      maybeSingle() { state.maybe = true; return exec(); },
      single() { state.single = true; return exec(); },
      then(resolve: any, reject: any) { return exec().then(resolve, reject); },
    };
    return builder;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const uid = TOKENS[token];
        return uid
          ? { data: { user: { id: uid } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let db: Record<string, FakeTable>;

function baseTables(overrides: Partial<Record<string, Row[]>> = {}): Record<string, FakeTable> {
  const t: Record<string, Row[]> = {
    trips: [{ id: TRIP_ID, owner_id: OWNER_ID, destination_country: "Japan" }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
    ],
    traveler_passports: [],
    trip_traveler_passports: [],
    entry_requirements: [],
    feature_flags: [
      { flag: "passport_entry_intelligence_enabled", enabled: true },
      { flag: "stamp_system_v2_enabled", enabled: true },
    ],
    profiles: [
      { id: ADMIN_ID, role: "admin" },
      { id: OWNER_ID, role: "user" },
    ],
    ...overrides,
  };
  const out: Record<string, FakeTable> = {};
  for (const [k, rows] of Object.entries(t)) out[k] = { rows: rows as Row[] };
  return out;
}

function inject(tables: Record<string, FakeTable>) {
  db = tables;
  _setTestClient(makeFakeClient(tables), true);
}

async function call(method: string, path: string, token: string | null, body?: any) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await resp.json().catch(() => null);
    return { status: resp.status, json };
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("passport CRUD", () => {
  beforeEach(() => inject(baseTables()));

  it("creates a passport from a country name and normalizes to ISO2", async () => {
    const r = await call("POST", "/me/passports", "owner-token", {
      issuingCountry: "United States", label: "Main", isPrimary: true,
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.passport.issuingCountry, "US");
    assert.equal(r.json.passport.isPrimary, true);
  });

  it("rejects an unrecognized country", async () => {
    const r = await call("POST", "/me/passports", "owner-token", { issuingCountry: "Atlantis" });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "invalid_payload");
  });

  it("enforces is_primary exclusivity", async () => {
    const r1 = await call("POST", "/me/passports", "owner-token", { issuingCountry: "US", isPrimary: true });
    const r2 = await call("POST", "/me/passports", "owner-token", { issuingCountry: "PH", label: "Second", isPrimary: true });
    assert.equal(r2.status, 201);
    const rows = db.traveler_passports.rows.filter((r) => r.user_id === OWNER_ID);
    assert.equal(rows.length, 2);
    const primaries = rows.filter((r) => r.is_primary);
    assert.equal(primaries.length, 1);
    assert.equal(primaries[0].issuing_country, "PH");
    assert.equal(r1.json.passport.issuingCountry, "US");
  });

  it("refuses PATCH on another user's passport", async () => {
    db.traveler_passports.rows.push({ id: P_OWNER, user_id: OWNER_ID, issuing_country: "US", label: "", is_primary: false });
    const r = await call("PATCH", `/me/passports/${P_OWNER}`, "member-token", { label: "hijack" });
    assert.equal(r.status, 404);
  });

  it("deletes own passport", async () => {
    db.traveler_passports.rows.push({ id: P_OWNER, user_id: OWNER_ID, issuing_country: "US", label: "", is_primary: false });
    const r = await call("DELETE", `/me/passports/${P_OWNER}`, "owner-token");
    assert.equal(r.status, 200);
    assert.equal(db.traveler_passports.rows.length, 0);
  });
});

describe("trip passport selection", () => {
  beforeEach(() => {
    const t = baseTables();
    t.traveler_passports.rows.push(
      { id: P_OWNER,  user_id: OWNER_ID,  issuing_country: "US", label: "", is_primary: true },
      { id: P_MEMBER, user_id: MEMBER_ID, issuing_country: "PH", label: "", is_primary: true },
    );
    inject(t);
  });

  it("rejects non-members", async () => {
    const r = await call("PUT", `/trips/${TRIP_ID}/travelers/me/passport`, "other-token", { passportId: P_OWNER });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "not_member");
  });

  it("rejects selecting someone else's passport", async () => {
    const r = await call("PUT", `/trips/${TRIP_ID}/travelers/me/passport`, "member-token", { passportId: P_OWNER });
    assert.equal(r.status, 404);
  });

  it("selects own passport and can clear it", async () => {
    const r1 = await call("PUT", `/trips/${TRIP_ID}/travelers/me/passport`, "member-token", { passportId: P_MEMBER });
    assert.equal(r1.status, 200);
    assert.equal(db.trip_traveler_passports.rows.length, 1);
    const r2 = await call("PUT", `/trips/${TRIP_ID}/travelers/me/passport`, "member-token", { passportId: null });
    assert.equal(r2.status, 200);
    assert.equal(db.trip_traveler_passports.rows.length, 0);
  });
});

describe("entry matrix", () => {
  beforeEach(() => {
    const t = baseTables();
    t.traveler_passports.rows.push(
      { id: P_OWNER,  user_id: OWNER_ID,  issuing_country: "US", label: "", is_primary: true },
      { id: P_MEMBER, user_id: MEMBER_ID, issuing_country: "PH", label: "", is_primary: true },
    );
    t.trip_traveler_passports.rows.push(
      { trip_id: TRIP_ID, user_id: OWNER_ID,  passport_id: P_OWNER },
      { trip_id: TRIP_ID, user_id: MEMBER_ID, passport_id: P_MEMBER },
    );
    t.entry_requirements.rows.push({
      id: newId(),
      passport_country: "US", destination_country: "JP", status: "visa_free",
      allowed_stay_days: 90, official_source_url: "https://www.mofa.go.jp/",
      confidence: "curated", last_verified_at: "2026-07-01T00:00:00Z",
    });
    inject(t);
  });

  it("is flag-gated", async () => {
    db.feature_flags.rows[0].enabled = false;
    const r = await call("GET", `/trips/${TRIP_ID}/entry-requirements`, "owner-token");
    assert.equal(r.status, 404);
    assert.equal(r.json.error, "feature_disabled");
  });

  it("gives the caller full detail and others status-only", async () => {
    const r = await call("GET", `/trips/${TRIP_ID}/entry-requirements`, "owner-token");
    assert.equal(r.status, 200);
    assert.equal(r.json.destinationCountry, "JP");
    assert.ok(r.json.disclaimer.length > 0);

    const self = r.json.travelers.find((t: any) => t.userId === OWNER_ID);
    assert.equal(self.self, true);
    assert.equal(self.passportCountry, "US");
    assert.equal(self.status, "visa_free");
    assert.equal(self.requirement.official_source_url, "https://www.mofa.go.jp/");
    assert.equal(self.lastVerifiedAt, "2026-07-01T00:00:00Z");

    const other = r.json.travelers.find((t: any) => t.userId === MEMBER_ID);
    assert.equal(other.self, false);
    assert.equal(other.passportSelected, true);
    assert.equal("passportCountry" in other, false, "other travelers' passport country must be hidden");
    assert.equal("requirement" in other, false);
  });

  it("reports unknown corridors honestly", async () => {
    // Member's PH→JP corridor has no curated row.
    const r = await call("GET", `/trips/${TRIP_ID}/entry-requirements`, "member-token");
    assert.equal(r.status, 200);
    const self = r.json.travelers.find((t: any) => t.userId === MEMBER_ID);
    assert.equal(self.status, "unknown");
    assert.equal(self.unknownReason, "no_data_for_corridor");
    assert.equal(self.requirement, null);
  });

  it("reports unrecognized destinations honestly", async () => {
    db.trips.rows[0].destination_country = "The Moon";
    const r = await call("GET", `/trips/${TRIP_ID}/entry-requirements`, "owner-token");
    assert.equal(r.status, 200);
    assert.equal(r.json.destinationCountry, null);
    const self = r.json.travelers.find((t: any) => t.userId === OWNER_ID);
    assert.equal(self.status, "unknown");
    assert.equal(self.unknownReason, "destination_not_recognized");
  });
});

describe("admin corridor CRUD", () => {
  beforeEach(() => inject(baseTables()));

  it("rejects non-admins", async () => {
    const r = await call("POST", "/admin/entry-requirements", "owner-token", {
      passportCountry: "US", destinationCountry: "JP", status: "visa_free",
      officialSourceUrl: "https://example.gov/",
    });
    assert.equal(r.status, 403);
  });

  it("requires an official source URL", async () => {
    const r = await call("POST", "/admin/entry-requirements", "admin-token", {
      passportCountry: "US", destinationCountry: "JP", status: "visa_free",
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "invalid_payload");
  });

  it("upserts and stamps verification metadata", async () => {
    const r1 = await call("POST", "/admin/entry-requirements", "admin-token", {
      passportCountry: "United States", destinationCountry: "Japan",
      status: "visa_free", allowedStayDays: 90,
      officialSourceUrl: "https://www.mofa.go.jp/",
    });
    assert.equal(r1.status, 201);
    assert.equal(r1.json.corridor.passport_country, "US");
    assert.equal(r1.json.corridor.destination_country, "JP");
    assert.equal(r1.json.corridor.verified_by, ADMIN_ID);
    assert.ok(r1.json.corridor.last_verified_at);

    // Upsert same pair updates in place.
    const r2 = await call("POST", "/admin/entry-requirements", "admin-token", {
      passportCountry: "US", destinationCountry: "JP",
      status: "evisa", officialSourceUrl: "https://www.mofa.go.jp/",
    });
    assert.equal(r2.status, 201);
    assert.equal(db.entry_requirements.rows.length, 1);
    assert.equal(db.entry_requirements.rows[0].status, "evisa");
  });

  it("lists with filters", async () => {
    db.entry_requirements.rows.push(
      { id: newId(), passport_country: "US", destination_country: "JP", status: "visa_free", official_source_url: "https://x.gov/" },
      { id: newId(), passport_country: "PH", destination_country: "JP", status: "visa_required", official_source_url: "https://y.gov/" },
    );
    const r = await call("GET", "/admin/entry-requirements?passport=US", "admin-token");
    assert.equal(r.status, 200);
    assert.equal(r.json.corridors.length, 1);
    assert.equal(r.json.corridors[0].passport_country, "US");
  });
});
