/**
 * Telegraph §22 — "Requests carry contextual origin: Event, Trip, Nearby, Bump,
 * Buddy, profile."
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * census T278: "`message_requests` has no origin column at all — only
 * `preview_text`. A recipient cannot be told why a stranger is reaching out."
 *
 * ── THE THING THESE TESTS ACTUALLY GUARD ─────────────────────────────────────
 * Not that an origin is stored — that part is easy and would be worth little on
 * its own. What matters is that a CLAIM never becomes a FACT. The sender
 * asserts the origin, and a sender who wants to look safe asserts "Trip". If
 * the product rendered that the same way it renders a verified one, it would be
 * telling a recipient something it does not know, in the one place where being
 * believed is the attacker's whole objective.
 *
 * So: `verified` is never copied from the request, only `trip` can be
 * established, both ends of a trip must check out, and a failed membership read
 * resolves to unverified rather than to verified.
 *
 * Two modes: the migration's decidable properties from its TEXT always, and —
 * with `TELEGRAPH_DB_URL` — the CHECK constraints exercised against a real
 * PostgreSQL, because "a free-text origin is refused" is a claim about the
 * database, not about the file.
 *
 * Run: node --import tsx/esm --test src/test/telegraphRequestOrigin.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REQUEST_ORIGINS,
  REQUEST_ORIGIN_FLAG,
  VERIFIABLE_ORIGINS,
  isRequestOrigin,
  parseOriginClaim,
  resolveRequestOrigin,
  requestOriginEnabled,
  originInsertColumns,
  originSelect,
  originForWire,
} from "../domain/telegraph/policies/requestOrigin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(here, "../migrations/2813_telegraph_request_origin.sql");
const ROLLBACK = path.join(here, "../../../../db/rollback/2026-09-12-2813-telegraph-request-origin-rollback.sql");
const sql = readFileSync(MIGRATION, "utf8");

const DB_URL = (process.env["TELEGRAPH_DB_URL"] ?? "").trim();
const HAVE_DB = DB_URL !== "";

function psql(script: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", DB_URL], {
    input: script, encoding: "utf8", timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function exec(script: string): string[] {
  const r = psql(script);
  if (r.status !== 0) throw new Error(`psql exited ${r.status}:\n${r.stderr.trim()}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

/* ───────────────────────── the six, and only the six ──────────────────────── */

describe("§22 request origin — the vocabulary", () => {
  it("is §22's six, in §22's order", () => {
    assert.deepEqual(REQUEST_ORIGINS, ["event", "trip", "nearby", "bump", "buddy", "profile"]);
  });

  it("the migration's CHECK is the same six", () => {
    for (const o of REQUEST_ORIGINS) {
      assert.ok(sql.includes(`'${o}'`), `${o} is missing from the migration's CHECK`);
    }
    assert.match(sql, /origin_type IN \('event','trip','nearby','bump','buddy','profile'\)/);
  });

  it("only trip is claimed as verifiable, and the module says so out loud", () => {
    // The value of this assertion is that adding a second verifiable origin
    // has to be a deliberate edit here, not a quiet one in a branch.
    assert.deepEqual([...VERIFIABLE_ORIGINS], ["trip"]);
  });

  it("rejects anything outside the six", () => {
    assert.equal(isRequestOrigin("telegram"), false);
    assert.equal(isRequestOrigin("Trip"), false, "the CHECK is case-sensitive, so this must be too");
    assert.equal(isRequestOrigin(""), false);
    assert.equal(isRequestOrigin(null), false);
  });
});

describe("§22 request origin — parsing a claim off a request body", () => {
  it("takes a valid origin and its id", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.deepEqual(parseOriginClaim({ origin: { type: "trip", id } }), { type: "trip", id });
  });

  it("DROPS an unrecognised origin rather than storing it", () => {
    // Storing free text would fail the CHECK and lose the whole message
    // request — and an origin a stranger can write anything into is a second
    // preview_text, not an origin.
    assert.equal(parseOriginClaim({ origin: { type: "telegram", id: null } }), null);
    assert.equal(parseOriginClaim({ origin: "trip" }), null);
    assert.equal(parseOriginClaim({}), null);
    assert.equal(parseOriginClaim(null), null);
  });

  it("drops a malformed id but keeps the origin", () => {
    assert.deepEqual(parseOriginClaim({ origin: { type: "nearby", id: "not-a-uuid" } }),
      { type: "nearby", id: null });
  });

  it("never reads a 'verified' field from the body", () => {
    const claim = parseOriginClaim({ origin: { type: "trip", id: null, verified: true } }) as any;
    assert.equal(claim.verified, undefined, "verification must not be something a sender can assert");
  });
});

/* ────────────────── the one thing the server can establish ─────────────────── */

const SENDER = "aaaaaaaa-0000-4000-8000-00000000e001";
const RECIPIENT = "bbbbbbbb-0000-4000-8000-00000000e002";
const TRIP = "cccccccc-0000-4000-8000-00000000e003";

/** A client shaped like `isAcceptedTripMember`'s reads and nothing else. */
function tripClient(members: string[], opts: { error?: boolean; throws?: boolean } = {}) {
  function from(table: string) {
    const filters: Record<string, any> = {};
    const target: any = {
      select() { return proxy; },
      eq(col: string, val: any) { filters[col] = val; return proxy; },
      is() { return proxy; },
      maybeSingle() {
        if (opts.throws) throw new Error("boom");
        if (opts.error) return Promise.resolve({ data: null, error: { message: "db down" } });
        if (table === "trips") return Promise.resolve({ data: { owner_id: null }, error: null });
        if (table === "trip_members") {
          const uid = filters["user_id"];
          return Promise.resolve({
            data: members.includes(uid) ? { user_id: uid, status: "accepted" } : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: (v: any) => void) {
        if (opts.throws) throw new Error("boom");
        if (opts.error) return Promise.resolve({ data: null, error: { message: "db down" } }).then(resolve);
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }
  return { from };
}

describe("§22 request origin — a claim only becomes a fact when the server proves it", () => {
  it("a trip both parties are accepted members of verifies", async () => {
    const r = await resolveRequestOrigin(tripClient([SENDER, RECIPIENT]) as any, {
      senderId: SENDER, recipientId: RECIPIENT, claim: { type: "trip", id: TRIP },
    });
    assert.deepEqual(r, { type: "trip", id: TRIP, verified: true });
  });

  it("a trip only the SENDER is in does not verify — that is the attack", async () => {
    // "We're on the same trip" is the sentence that gets a stranger trusted.
    const r = await resolveRequestOrigin(tripClient([SENDER]) as any, {
      senderId: SENDER, recipientId: RECIPIENT, claim: { type: "trip", id: TRIP },
    });
    assert.equal(r!.verified, false);
    assert.equal(r!.type, "trip", "the claim is still recorded — as a claim");
  });

  it("a trip only the RECIPIENT is in does not verify either", async () => {
    const r = await resolveRequestOrigin(tripClient([RECIPIENT]) as any, {
      senderId: SENDER, recipientId: RECIPIENT, claim: { type: "trip", id: TRIP },
    });
    assert.equal(r!.verified, false);
  });

  it("an unreadable membership table resolves to UNVERIFIED, never to verified", async () => {
    const r = await resolveRequestOrigin(tripClient([SENDER, RECIPIENT], { error: true }) as any, {
      senderId: SENDER, recipientId: RECIPIENT, claim: { type: "trip", id: TRIP },
    });
    assert.equal(r!.verified, false, "'we could not prove it' must render as a claim, not as a fact");
  });

  it("a membership read that THROWS resolves to unverified too", async () => {
    const r = await resolveRequestOrigin(tripClient([], { throws: true }) as any, {
      senderId: SENDER, recipientId: RECIPIENT, claim: { type: "trip", id: TRIP },
    });
    assert.equal(r!.verified, false);
  });

  it("a trip claim with no id cannot be checked and is not pretended to be", async () => {
    const r = await resolveRequestOrigin(tripClient([SENDER, RECIPIENT]) as any, {
      senderId: SENDER, recipientId: RECIPIENT, claim: { type: "trip", id: null },
    });
    assert.equal(r!.verified, false);
  });

  it("every origin the server cannot establish is recorded unverified", async () => {
    for (const type of REQUEST_ORIGINS) {
      if (type === "trip") continue;
      const r = await resolveRequestOrigin(tripClient([SENDER, RECIPIENT]) as any, {
        senderId: SENDER, recipientId: RECIPIENT, claim: { type, id: TRIP },
      });
      assert.equal(r!.verified, false, `${type} must not be verifiable — nothing here can check it`);
      assert.equal(r!.type, type);
    }
  });

  it("no claim, no origin", async () => {
    const r = await resolveRequestOrigin(tripClient([]) as any, {
      senderId: SENDER, recipientId: RECIPIENT, claim: null,
    });
    assert.equal(r, null);
  });
});

/* ───────────────── the flag gates the COLUMNS, not just the feature ────────── */

describe("§22 request origin — a database without 2813 is never asked about these columns", () => {
  it("the insert names nothing while the flag is off", () => {
    const origin = { type: "trip" as const, id: TRIP, verified: true };
    assert.deepEqual(originInsertColumns(origin, false), {});
    assert.deepEqual(originInsertColumns(origin, true), {
      origin_type: "trip", origin_id: TRIP, origin_verified: true,
    });
  });

  it("the select list is byte-identical while the flag is off", () => {
    const base = "id, sender_id, preview_text, created_at";
    assert.equal(originSelect(base, false), base,
      "PostgREST answers an unknown column with 42703 and fails the WHOLE statement");
    assert.equal(originSelect(base, true), `${base}, origin_type, origin_id, origin_verified`);
  });

  it("the wire shape carries `verified` rather than flattening it", () => {
    const row = { origin_type: "trip", origin_id: TRIP, origin_verified: true };
    assert.deepEqual(originForWire(row, true), { type: "trip", id: TRIP, verified: true });
    assert.equal(originForWire(row, false), null);
    assert.equal(originForWire({ origin_type: "telegram" }, true), null, "an out-of-vocabulary row must not reach a client");
    assert.equal(originForWire({ origin_type: "trip", origin_verified: "true" }, true)!.verified, false,
      "only a real boolean true is verified — a truthy string is not");
  });

  it("an unreadable feature_flags behaves as OFF", async () => {
    const failing = {
      from() {
        const p: any = new Proxy({
          select: () => p, eq: () => p,
          maybeSingle: () => Promise.resolve({ data: null, error: { message: "flags down" } }),
          then: (r: any) => Promise.resolve({ data: null, error: { message: "flags down" } }).then(r),
        }, { get(t: any, k) { return k in t ? t[k as string] : () => p; } });
        return p;
      },
    };
    assert.equal(await requestOriginEnabled(failing as any), false);
  });
});

/* ────────────────────── the migration, text and executed ──────────────────── */

describe("Telegraph 2813 — properties decidable from the migration text", () => {
  it("reports which mode this run is in", () => {
    console.log(`# telegraph 2813 suite mode: ${HAVE_DB ? "EXECUTED against TELEGRAPH_DB_URL" : "TEXT ONLY"}`);
    assert.ok(typeof HAVE_DB === "boolean");
  });

  it("origin_verified defaults to FALSE, and the postcondition asserts it", () => {
    assert.match(sql, /origin_verified boolean NOT NULL DEFAULT false/);
    assert.match(sql, /POSTCONDITION FAILED: message_requests\.origin_verified must default to false/);
  });

  it("backfills nothing, and refuses to complete if something is already verified", () => {
    assert.ok(!/UPDATE public\.message_requests/i.test(sql),
      "inventing an origin for a record nobody measured puts a specific claim on it");
    assert.match(sql, /POSTCONDITION FAILED: a row is already marked origin_verified/);
  });

  it("seeds its flag FALSE", () => {
    assert.match(sql, new RegExp(`'${REQUEST_ORIGIN_FLAG}',\\s*false`));
    assert.match(sql, /ON CONFLICT \(flag\) DO NOTHING/);
  });

  it("every ALTER is guarded so re-application is a no-op", () => {
    assert.match(sql, /ADD COLUMN IF NOT EXISTS origin_type/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS origin_id/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS origin_verified/);
    for (const c of ["origin_type_check", "origin_pair_check", "origin_verified_check"]) {
      assert.ok(sql.includes(`conname = 'message_requests_${c}'`),
        `${c} must be added only when absent, or a re-run fails`);
    }
  });

  it("the rollback drops the columns and not the table", () => {
    const rb = readFileSync(ROLLBACK, "utf8");
    assert.match(rb, /DROP COLUMN IF EXISTS origin_verified/);
    assert.ok(!/DROP TABLE/i.test(rb), "the rollback must not drop message_requests");
    assert.match(rb, new RegExp(REQUEST_ORIGIN_FLAG));
  });
});

describe("Telegraph 2813 — executed against a real PostgreSQL", { skip: !HAVE_DB }, () => {
  it("the three columns exist with the right default", () => {
    exec(sql);
    const rows = exec(
      "SELECT column_name || '=' || coalesce(column_default,'-') FROM information_schema.columns " +
      "WHERE table_schema='public' AND table_name='message_requests' " +
      "AND column_name IN ('origin_type','origin_id','origin_verified') ORDER BY column_name;",
    );
    assert.deepEqual(rows, ["origin_id=-", "origin_type=-", "origin_verified=false"]);
  });

  it("the database REFUSES a free-text origin", () => {
    // The claim under test is about the database, not about the file: a CHECK
    // that was written but not created would pass every text assertion above.
    const r = psql(
      "INSERT INTO public.message_requests (sender_id, recipient_id, origin_type) " +
      "SELECT id, id, 'telegram' FROM public.profiles LIMIT 1;",
    );
    assert.notEqual(r.status, 0, "a free-text origin was accepted");
    assert.match(r.stderr, /message_requests_origin_type_check/);
  });

  it("the database REFUSES verification with no claim attached to it", () => {
    const r = psql(
      "INSERT INTO public.message_requests (sender_id, recipient_id, origin_verified) " +
      "SELECT id, id, true FROM public.profiles LIMIT 1;",
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /message_requests_origin_verified_check/);
  });

  it("the flag lands FALSE", () => {
    const [enabled] = exec(`SELECT enabled FROM public.feature_flags WHERE flag='${REQUEST_ORIGIN_FLAG}';`);
    assert.equal(enabled, "f");
  });
});
