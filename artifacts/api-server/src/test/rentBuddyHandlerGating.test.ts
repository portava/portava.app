/**
 * rentBuddyHandlerGating — the Rent-a-Buddy master switch must actually stop
 * WRITES, in every router, not just in rentABuddy.ts.
 *
 * ── THE DEFECT THIS LOCKS DOWN ──────────────────────────────────────────────
 * `rent_buddy_enabled` is FALSE in production, and the lane was believed to be
 * dormant because of it. It was not. The guard that reads the flag,
 * requireRentBuddyEnabled, lived module-private in rentABuddy.ts and was called
 * 70 times THERE and zero times in the lane's three other routers:
 *
 *   rentABuddyMarketplace.ts   18 non-admin write handlers, none gated
 *   rentABuddySpec.ts          17 non-admin write handlers, none gated
 *   rentABuddy.ts               4 non-admin write handlers missed (tag-consents
 *                                 x3, training-checklist)
 *
 * So with the master switch OFF a signed-in user could still create requests
 * and offers, publish packages and add-ons, flip `available_now`, tip, save a
 * buddy, join the waitlist, submit/pause/resume a buddy profile and rewrite
 * availability. The flag said the product did not exist; the database
 * disagreed.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 * Part 1 (behavioural, one representative handler per router and per gate
 *   shape): with the flag OFF the request is refused 403 `feature_disabled`
 *   AND **no write of any kind reaches the client**. The write recorder is the
 *   real assertion — a handler that 403s after already having written would
 *   pass a status-only check.
 *
 * Part 2 (positive control, the same handlers with the flag ON): the write DOES
 *   land. Without this half, deleting the handler bodies entirely would still
 *   make Part 1 pass — the classic vacuous fail-closed test.
 *
 * Part 3 (structural coverage): every handler in the four RAB routers that
 *   writes a `rent_buddy_*` / `buddy_*` table must carry the master gate
 *   (requireRentBuddyEnabled or checkRentBuddyAccess, whose step 1 IS the
 *   flag) or an admin role check. This is what catches handler #42.
 *
 * NOT VACUOUS BY CONSTRUCTION: the flag NAME is read out of rentABuddy.ts's own
 * `checkRentBuddyEnabled` at test time rather than typed in here, so renaming
 * the flag cannot leave this suite asserting against a literal nothing seeds
 * (the phantom-flag failure mode). The fake feature_flags table answers only
 * for that derived name.
 *
 * ADMIN IS DELIBERATELY EXEMT FROM THE FLAG, NOT FROM GATING: an admin queue
 * that hides its rows cannot moderate them, and the flag is itself administered
 * through admin endpoints. Part 3 therefore accepts a `profiles.role` check in
 * place of the flag for admin paths — and REQUIRES one, so "not flag-gated"
 * can never quietly become "not gated".
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyHandlerGating.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express from "express";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter from "../routes/rentABuddy.js";
import rentABuddyMarketplaceRouter from "../routes/rentABuddyMarketplace.js";
import rentABuddySpecRouter from "../routes/rentABuddySpec.js";

const ROUTES = resolve(dirname(fileURLToPath(import.meta.url)), "../routes");

// ── The flag literal, derived from the gate itself ────────────────────────────
// Read from checkRentBuddyEnabled's own query so the fixture can never drift
// from the name the gate actually looks up.

const MASTER_FLAG: string = (() => {
  const src = readFileSync(resolve(ROUTES, "rentABuddy.ts"), "utf8");
  // [A-Za-z0-9_]+ deliberately, not [A-Za-z_]+: a digit in the flag name (a
  // `_v2` suffix, say) must still be READ here and then rejected by the
  // seeded-flag assertion below, not silently crash this derivation and turn an
  // inert-gate regression into an unreadable module-load failure.
  const m = src.match(/function\s+checkRentBuddyEnabled[\s\S]{0,400}?\.eq\(\s*["']flag["']\s*,\s*["']([A-Za-z0-9_]+)["']\s*\)/);
  assert.ok(m, "could not locate the master-flag literal in checkRentBuddyEnabled — this suite would be testing nothing");
  return m[1];
})();

// ── Test state ────────────────────────────────────────────────────────────────

const TOKEN = "rab-gate-token";
const USER_ID = "rab-gate-user-1";
const BUDDY_PROFILE_ID = "rab-gate-buddy-profile-1";
const CONSENT_ID = "rab-gate-consent-1";
const OTHER_BUDDY_ID = "rab-gate-other-buddy-1";

interface WriteRecord { table: string; verb: string }

interface State {
  masterEnabled: boolean;
  flagsRead: string[];
  writes: WriteRecord[];
}

let state: State;

function freshState(enabled: boolean): State {
  return { masterEnabled: enabled, flagsRead: [], writes: [] };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────
// Records EVERY mutating call. Reads are permissive so that, with the flag ON,
// each handler under test reaches its write instead of bailing out early for an
// unrelated reason (which would make the positive control meaningless).

function makeClient() {
  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, string, any]>,
      _verb: null as string | null,
      _maybeSingle: false,

      select() { return this; },
      insert() { this._verb = "insert"; return this; },
      update() { this._verb = "update"; return this; },
      upsert() { this._verb = "upsert"; return this; },
      delete() { this._verb = "delete"; return this; },
      eq(c: string, v: any) { this._filters.push(["eq", c, v]); return this; },
      neq(c: string, v: any) { this._filters.push(["neq", c, v]); return this; },
      is(c: string, v: any) { this._filters.push(["is", c, v]); return this; },
      in(c: string, v: any) { this._filters.push(["in", c, v]); return this; },
      ilike(c: string, v: any) { this._filters.push(["ilike", c, v]); return this; },
      gte(c: string, v: any) { this._filters.push(["gte", c, v]); return this; },
      lte(c: string, v: any) { this._filters.push(["lte", c, v]); return this; },
      gt(c: string, v: any) { this._filters.push(["gt", c, v]); return this; },
      lt(c: string, v: any) { this._filters.push(["lt", c, v]); return this; },
      or() { return this; },
      not() { return this; },
      contains() { return this; },
      order() { return this; },
      limit() { return this; },
      range() { return this; },
      maybeSingle() { this._maybeSingle = true; return this; },
      single() { this._maybeSingle = true; return this; },

      async then(resolve_: (v: any) => void) {
        const r = await this._resolve();
        resolve_(r);
        return r;
      },

      _eq(col: string): any {
        const f = this._filters.find(([op, c]) => op === "eq" && c === col);
        return f ? f[2] : undefined;
      },

      async _resolve(): Promise<any> {
        if (this._verb) {
          state.writes.push({ table: this._table, verb: this._verb });
          return { data: this._maybeSingle ? { id: "written" } : [], error: null };
        }

        if (this._table === "feature_flags") {
          const flag = this._eq("flag");
          if (typeof flag === "string") state.flagsRead.push(flag);
          if (this._maybeSingle) {
            if (flag === MASTER_FLAG) return { data: { flag, enabled: state.masterEnabled }, error: null };
            // Any other flag: absent row (the honest default for an unseeded flag).
            return { data: null, error: null };
          }
          return { data: [], error: null };
        }

        if (this._table === "profiles") {
          return { data: this._maybeSingle ? { id: USER_ID, role: "user" } : [], error: null };
        }

        if (this._table === "rent_buddy_profiles") {
          const row = {
            id: BUDDY_PROFILE_ID, user_id: USER_ID, city: "Miami", country: "US",
            status: "active", admin_status: "active",
          };
          return { data: this._maybeSingle ? row : [row], count: 1, error: null };
        }

        if (this._table === "rent_buddy_tag_consents") {
          const row = { id: CONSENT_ID, target_id: USER_ID, requester_id: "someone-else", consent_status: "pending" };
          return { data: this._maybeSingle ? row : [row], count: 1, error: null };
        }

        if (this._maybeSingle) return { data: null, error: null };
        return { data: [], count: 0, error: null };
      },
    };
  }

  return {
    from: (t: string) => fakeTable(t),
    rpc: async () => ({ data: null, error: { message: "no rpc in fake" } }),
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

// ── HTTP harness ──────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve_, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve_({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  state = freshState(true);
  const client = makeClient();
  // The second argument is `ready`; without it requireUser answers 503
  // server_not_configured and every case below would "pass" for the wrong reason.
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);

  const app = express();
  app.use(express.json());
  app.use("/api", rentABuddyRouter);
  app.use("/api", rentABuddyMarketplaceRouter);
  app.use("/api", rentABuddySpecRouter);

  await new Promise<void>((r) => {
    server = app.listen(0, "127.0.0.1", () => r());
  });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  await new Promise<void>((r) => server.close(() => r()));
});

// ── The handlers under behavioural test ───────────────────────────────────────
// One per router, chosen so the write is reachable with a minimal fixture.
// Each names the table it must NOT touch while the switch is off.

const CASES: Array<{ name: string; method: string; path: string; body?: unknown; table: string }> = [
  {
    name: "rentABuddyMarketplace POST /rent-a-buddy/buddies/:buddyId/save",
    method: "POST", path: `/api/rent-a-buddy/buddies/${OTHER_BUDDY_ID}/save`,
    body: { notes: "hi" }, table: "rent_buddy_saved",
  },
  {
    name: "rentABuddyMarketplace POST /rent-a-buddy/me/available-now",
    method: "POST", path: "/api/rent-a-buddy/me/available-now",
    body: { durationMinutes: 60 }, table: "rent_buddy_profiles",
  },
  {
    name: "rentABuddySpec PATCH /me/buddy-availability",
    method: "PATCH", path: "/api/me/buddy-availability",
    body: { slots: [{ date: "2026-10-01", isAvailable: true }] }, table: "rent_buddy_availability",
  },
  {
    name: "rentABuddy POST /rent-a-buddy/tag-consents/:consentId/approve",
    method: "POST", path: `/api/rent-a-buddy/tag-consents/${CONSENT_ID}/approve`,
    table: "rent_buddy_tag_consents",
  },
];

describe("the flag this suite gates on is a real, seeded flag", () => {
  // Deriving MASTER_FLAG from the gate protects against a rename desynchronising
  // the fixture — but it would happily follow the gate into a PHANTOM literal
  // that no migration seeds, which makes the gate inert in a real database while
  // this suite stays green. So cross-check the derived name against the seeds.
  it(`${MASTER_FLAG} is seeded by a migration (not a phantom literal)`, () => {
    const migDir = resolve(ROUTES, "../migrations");
    const seeded = readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .some((f) => {
        const sql = readFileSync(resolve(migDir, f), "utf8");
        return /insert\s+into\s+(public\.)?feature_flags/i.test(sql)
          && new RegExp(`['"\`]${MASTER_FLAG}['"\`]`).test(sql);
      });
    assert.ok(seeded, `${MASTER_FLAG} is read by the gate but no migration seeds it into feature_flags — the gate is inert`);
  });

  it("the rollout access gate reads the SAME flag as requireRentBuddyEnabled", () => {
    // checkRentBuddyAccess (rentABuddyRollout.ts) is the other half of the lane's
    // gating and its step 1 is meant to be this same switch. If the two drift, a
    // handler could satisfy one and bypass the other.
    const rollout = readFileSync(resolve(ROUTES, "rentABuddyRollout.ts"), "utf8");
    assert.match(
      rollout,
      new RegExp(`getFlag\\([^)]*,\\s*["']${MASTER_FLAG}["']\\)`),
      `checkRentBuddyAccess must gate on ${MASTER_FLAG}, the same flag requireRentBuddyEnabled reads`,
    );
  });
});

describe("Rent-a-Buddy master switch OFF blocks every write handler", () => {
  beforeEach(() => { state = freshState(false); });

  for (const c of CASES) {
    it(`${c.name} → 403 feature_disabled, zero writes`, async () => {
      const res = await req(c.method, c.path, c.body);

      assert.equal(res.status, 403, `${c.name}: expected 403 with the master switch off, got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body?.error, "feature_disabled", `${c.name}: expected error=feature_disabled, got ${JSON.stringify(res.body)}`);

      assert.deepEqual(
        state.writes, [],
        `${c.name}: the handler wrote ${JSON.stringify(state.writes)} despite the master switch being off — a 403 after the write is not a gate`,
      );

      assert.ok(
        state.flagsRead.includes(MASTER_FLAG),
        `${c.name}: the handler never read ${MASTER_FLAG}; it was refused for some other reason and the gate is not what stopped it`,
      );
    });
  }
});

describe("positive control — with the switch ON the same handlers do write", () => {
  beforeEach(() => { state = freshState(true); });

  for (const c of CASES) {
    it(`${c.name} → writes ${c.table}`, async () => {
      const res = await req(c.method, c.path, c.body);

      assert.notEqual(
        res.body?.error, "feature_disabled",
        `${c.name}: refused as feature_disabled with the switch ON — the gate reads the wrong thing`,
      );
      assert.ok(
        state.writes.some((w) => w.table === c.table),
        `${c.name}: expected a write to ${c.table} with the switch ON, recorded ${JSON.stringify(state.writes)} (status ${res.status}, body ${JSON.stringify(res.body)}). ` +
        "A test whose 'blocked' half passes only because the handler never writes at all proves nothing.",
      );
    });
  }
});

// ── Part 3: structural coverage ───────────────────────────────────────────────

interface Handler {
  file: string;
  line: number;
  method: string;
  path: string;
  body: string;
  writes: string[];
}

/**
 * Handlers deliberately left ungated by THIS change because an open PR owns
 * their bodies. Shrink-only: see the assertion below.
 */
const IN_FLIGHT_EXCEPTIONS: string[] = [
  "rentABuddyMarketplace.ts DELETE /rent-a-buddy/waitlist/:waitlistId",
  // SHRUNK when #420 merged (2026-09-05T17:54Z) — exactly what the assertion
  // below asks for, and the only direction it permits.
  // `GET /rent-a-buddy/me/earnings/ledger` was recorded while an open PR owned
  // its body. On main that handler is now a pure read: requireUser, then one
  // `.select()` on rent_buddy_earnings_ledger scoped to buddy_user_id, and no
  // write of any kind (routes/rentABuddyMarketplace.ts:2270). A read is not a
  // write handler, so it cannot be an ungated write handler.
  //
  // Checked rather than assumed, because "the scanner stopped seeing it" and
  // "the handler stopped writing" look identical from the assertion: the
  // detector still reports the DELETE above, and both sibling assertions — "no
  // non-admin handler writes Rent-a-Buddy state without the master switch" and
  // "every admin-exempt handler actually proves admin" — still pass.
];

const RAB_ROUTERS = [
  "rentABuddy.ts",
  "rentABuddyMarketplace.ts",
  "rentABuddySpec.ts",
  "rentABuddyRollout.ts",
];

/** Every `router.<verb>("<path>", …)` block and the RAB tables it mutates. */
function collectHandlers(): Handler[] {
  const out: Handler[] = [];
  for (const file of RAB_ROUTERS) {
    const lines = readFileSync(resolve(ROUTES, file), "utf8").split("\n");
    const starts: Array<{ i: number; method: string; path: string }> = [];
    lines.forEach((l, i) => {
      const m = l.match(/^\s*router\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]+)["'`]/);
      if (m) starts.push({ i, method: m[1].toUpperCase(), path: m[2] });
    });
    for (let k = 0; k < starts.length; k++) {
      const from = starts[k].i;
      const to = k + 1 < starts.length ? starts[k + 1].i : lines.length;
      const writes = new Set<string>();
      for (let j = from; j < to; j++) {
        const m = lines[j].match(/\.from\(\s*["'`]((?:rent_)?buddy_[a-z_]*)["'`]\s*\)/);
        if (!m) continue;
        // The verb may sit a few lines below the .from(...) in this codebase's
        // formatting; take the FIRST method that follows it.
        const win = lines.slice(j, j + 7).join("\n");
        const after = win.slice(win.indexOf(m[0]) + m[0].length);
        const fm = after.match(/\.\s*([a-zA-Z]+)\s*\(/);
        if (fm && /^(insert|update|upsert|delete)$/.test(fm[1])) writes.add(m[1]);
      }
      if (writes.size === 0) continue;
      out.push({ file, line: from + 1, method: starts[k].method, path: starts[k].path, body: lines.slice(from, to).join("\n"), writes: [...writes] });
    }
  }
  return out;
}

/** The master switch, directly or through checkRentBuddyAccess (whose step 1 is the same flag). */
function hasMasterGate(h: Handler): boolean {
  return /requireRentBuddyEnabled\s*\(/.test(h.body) || /checkRentBuddyAccess\s*\(/.test(h.body);
}

/**
 * An admin/moderation surface: it proves `profiles.role`, either through one of
 * the named helpers or with the inline select several handlers still use.
 */
function hasAdminGate(h: Handler): boolean {
  return /requireAdmin\s*\(|requireAdminCtx\s*\(/.test(h.body)
    || /\.from\(\s*["'`]profiles["'`]\s*\)[\s\S]{0,200}?["'`]role["'`]/.test(h.body);
}

describe("every Rent-a-Buddy write handler is gated", () => {
  const handlers = collectHandlers();

  it("the scan found the lane's write handlers (guard against scanning nothing)", () => {
    assert.ok(
      handlers.length >= 100,
      `expected 100+ RAB write handlers across ${RAB_ROUTERS.join(", ")}, found ${handlers.length} — the scan is broken, not the code`,
    );
  });

  it("the two in-flight exceptions are still exactly the two we recorded", () => {
    // A SHRINK-ONLY list. These two handlers are owned by an open PR
    // (claude/rent-a-buddy-lane-20260905, #420) which rewrites both bodies;
    // gating them here would have produced a merge conflict in the exact lines
    // that PR replaces. They are listed rather than silently skipped so the
    // exemption expires loudly: once #420 lands, gate them and delete the entry.
    // Anything ELSE that appears here fails the next assertion, not this one.
    const stillUngated = handlers
      .filter((h) => !hasMasterGate(h) && !hasAdminGate(h))
      .map((h) => `${h.file} ${h.method} ${h.path}`);
    assert.deepEqual(
      stillUngated,
      IN_FLIGHT_EXCEPTIONS,
      "the recorded exception list must match reality exactly — shrink it when #420 merges, never grow it",
    );
  });

  it("no non-admin handler writes Rent-a-Buddy state without the master switch", () => {
    const ungated = handlers
      .filter((h) => !hasMasterGate(h) && !hasAdminGate(h))
      .filter((h) => !IN_FLIGHT_EXCEPTIONS.includes(`${h.file} ${h.method} ${h.path}`));
    assert.deepEqual(
      ungated.map((h) => `${h.file}:${h.line} ${h.method} ${h.path} → ${h.writes.join(",")}`),
      [],
      "these handlers mutate Rent-a-Buddy state with neither the master switch nor an admin role check. "
      + "Add `if (!await requireRentBuddyEnabled(<client>, res)) return;` (imported from routes/rentABuddy.ts) "
      + "immediately after the auth check — or, if it really is an admin surface, give it a role check.",
    );
  });

  it("every admin-exempt handler actually proves admin (the exemption is not a hole)", () => {
    const adminExempt = handlers.filter((h) => !hasMasterGate(h) && hasAdminGate(h));
    assert.ok(
      adminExempt.length > 0,
      "expected admin write handlers to exist; if none are found the admin detector is broken and the previous assertion is vacuous",
    );
    for (const h of adminExempt) {
      assert.match(
        h.body,
        /role\s*!==\s*["'`]admin["'`]|requireAdmin\s*\(|requireAdminCtx\s*\(/,
        `${h.file}:${h.line} ${h.method} ${h.path} skips the master switch as an admin surface but does not prove admin`,
      );
    }
  });
});
