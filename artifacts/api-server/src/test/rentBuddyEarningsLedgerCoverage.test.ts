/**
 * rent_buddy_earnings_ledger — every booking-creation path must write one.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * Five routes INSERT into rent_buddy_bookings. The ledger writer was a
 * module-private helper inside rentABuddyMarketplace.ts and so was reachable
 * from only two of them (offer-accept and package-book). The other three —
 * the CANONICAL POST /rent-a-buddy/bookings, rebook, and the spec request —
 * created a booking and no ledger row.
 *
 * GET /rent-a-buddy/me/earnings/ledger reads that table and nothing else. A
 * buddy whose bookings arrived the ordinary way therefore saw
 * `{ ledger: [], total: 0 }` forever, no matter how much work they had done.
 *
 * ── THREE HALVES ────────────────────────────────────────────────────────────
 * 1. CO-LOCATION — that no booking insert exists without a ledger write beside
 *    it — is pinned by reading the routers as text. It is what stops a sixth
 *    creation path from being added later with the same hole; a runtime test
 *    can only cover paths someone remembered to write a test for.
 *
 * 2. THE RESULT IS NOT DISCARDED (PAY-050). Being called is not enough: all five
 *    sites used to end `.catch(() => {})`, so a booking whose ledger failed was
 *    handed back as made. Each site now SETTLES its booking through
 *    `settleBookingLedger`: post; an answer that did not arrive is confirmed by
 *    posting again (the function is idempotent); only a booking that is still
 *    unledgered is withdrawn; and only a booking whose row is really gone is
 *    answered with the named refusal. No route withdraws a booking itself —
 *    that was the duplicate-booking defect (a posting that had committed, a
 *    DELETE that 3510 refused, a 503 "not created", and a retry). Pinned as
 *    text for the same reason as (1), and executed here for the helpers.
 *
 * 3. THE PRICE. This file used to pin the arithmetic against a recording
 *    client: the level's fee rule, gross and net. The arithmetic is SQL since
 *    migration 3824 (PAY-055) and is executed against PostgreSQL by
 *    `src/test/db/rentBuddyLedgerPosting.db.test.ts`; what is asserted here is
 *    that each of those figures still has a database test holding it. Three of
 *    the old assertions changed MEANING, on the owner's rulings of 2026-10-04,
 *    and are recorded at the foot of this file rather than silently replaced.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyEarningsLedgerCoverage.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginIdempotentCreation,
  readCreationKey,
  sendBookingLedgerRefusal,
  settleBookingLedger,
  withdrawUnledgeredBooking,
  type LedgerWriteResult,
} from "../lib/rentBuddyEarningsLedger.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(HERE, "../routes");

/**
 * The routers that create bookings. Kept explicit rather than globbed so that a
 * NEW router creating bookings is a deliberate edit to this list, reviewed
 * alongside the ledger write it must carry.
 */
const BOOKING_CREATION_ROUTERS = [
  "rentABuddy.ts",
  "rentABuddySpec.ts",
  "rentABuddyMarketplace.ts",
] as const;

/**
 * `.from("rent_buddy_bookings")` followed by `.insert(` with only whitespace,
 * comments and chained builder calls between them. Deliberately narrow: an
 * `.update(` or a `.select(` on the same table is not a creation site.
 */
const BOOKING_INSERT_RE = /\.from\(\s*["']rent_buddy_bookings["']\s*\)\s*(?:\/\/[^\n]*\n|\s)*\.insert\(/g;
/** The ONE way a route ledgers a just-inserted booking. */
const LEDGER_CALL_RE = /settleBookingLedger\s*\(/g;

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// ── Co-location ──────────────────────────────────────────────────────────────

describe("every rent_buddy_bookings INSERT is accompanied by a ledger write", () => {
  const perFile = BOOKING_CREATION_ROUTERS.map((f) => {
    const src = readFileSync(join(ROUTES, f), "utf8");
    return { f, inserts: count(src, BOOKING_INSERT_RE), ledgers: count(src, LEDGER_CALL_RE) };
  });

  it("finds the five known booking-creation sites, so the scan is not vacuous", () => {
    const total = perFile.reduce((n, r) => n + r.inserts, 0);
    assert.equal(
      total, 5,
      `expected 5 booking-creation sites across ${BOOKING_CREATION_ROUTERS.join(", ")}, ` +
      `found ${total}: ${JSON.stringify(perFile)}. A changed count means a creation ` +
      "path was added or removed — check it writes a ledger row, then update this number.",
    );
  });

  for (const { f, inserts, ledgers } of perFile) {
    it(`${f}: ${inserts} booking insert(s), ${ledgers} ledger write(s)`, () => {
      assert.ok(
        ledgers >= inserts,
        `${f} creates ${inserts} booking(s) but calls settleBookingLedger ${ledgers} time(s). ` +
        "A booking created without a ledger row is invisible to GET /me/earnings/ledger forever.",
      );
    });

    it(`${f}: no route posts or withdraws on its own — only settleBookingLedger does`, () => {
      const src = readFileSync(join(ROUTES, f), "utf8");
      // `post → not written → DELETE → 503` in a route is the duplicate-booking
      // defect: the DELETE of a booking whose posting had committed is refused,
      // and the traveller is told to try again.
      assert.equal(/createEarningsLedgerEntry\s*\(/.test(src), false,
        `${f} calls createEarningsLedgerEntry directly: an unanswered posting would not be confirmed before the booking is withdrawn`);
      assert.equal(/withdrawUnledgeredBooking\s*\(/.test(src), false,
        `${f} withdraws a booking itself, without first confirming that its ledger is really absent`);
    });
  }
});

// ── The result is not discarded (PAY-050) ────────────────────────────────────

describe("no booking-creation site discards the ledger result", () => {
  for (const f of BOOKING_CREATION_ROUTERS) {
    const src = readFileSync(join(ROUTES, f), "utf8");
    const sites = [...src.matchAll(/settleBookingLedger\s*\(/g)].map((m) => m.index!).filter((at) => !/import \{[^}]*$/.test(src.slice(Math.max(0, at - 200), at)));

    it(`${f}: every call is awaited into a result, and none is swallowed`, () => {
      assert.ok(sites.length > 0);
      for (const at of sites) {
        const before = src.slice(Math.max(0, at - 40), at);
        const after = src.slice(at, at + 900);
        const line = src.slice(0, at).split("\n").length;
        assert.match(before, /const settled = await $/,
          `${f}:${line} — the ledger settlement is not awaited into \`settled\`; a fire-and-forget write is PAY-050`);
        assert.equal(/^[^;]*\)\s*\.catch\(/.test(after), false,
          `${f}:${line} — the settlement's failure is swallowed by .catch()`);
        // The ONLY outcome that refuses is `withdrawn`: `ledgered` and `kept`
        // are bookings that exist, and are returned.
        assert.match(after, /if \(settled\.outcome === "withdrawn"\)/, `${f}:${line} — the result is not checked`);
        assert.equal(/settled\.outcome\s*!==\s*"ledgered"/.test(after), false,
          `${f}:${line} — a KEPT booking (one that could not be withdrawn, so exists) must not be refused`);
        const branch = after.slice(after.indexOf('if (settled.outcome === "withdrawn")'));
        assert.match(branch, /return sendBookingLedgerRefusal\(res, settled\.ledger\);/,
          `${f}:${line} — the request is not answered with the named refusal`);
      }
    });

    it(`${f}: every creation path takes an Idempotency-Key, stores it, and replays on its conflict`, () => {
      const inserts = count(src, BOOKING_INSERT_RE);
      assert.equal(count(src, /await beginIdempotentCreation\(req, res, /g), inserts,
        `${f}: every booking-creation handler must begin with beginIdempotentCreation`);
      assert.equal(count(src, /if \(creation\.done\) return;/g), inserts, `${f}: a replayed request must stop the handler`);
      assert.equal(count(src, /creation_key: creation\.key/g), inserts, `${f}: the key must be stored on the row the handler inserts`);
      assert.equal(count(src, /await creation\.replayOnConflict\(/g), inserts,
        `${f}: a retry that loses the race on rbb_creation_key_once must answer with the winner's booking`);
    });

    it(`${f}: every booking is created with an acceptance window (expires_at)`, () => {
      for (const m of src.matchAll(BOOKING_INSERT_RE)) {
        const stmt = src.slice(m.index!, src.indexOf(".select()", m.index!));
        const line = src.slice(0, m.index!).split("\n").length;
        assert.match(stmt, /\bexpires_at:/, `${f}:${line} — a booking awaiting the buddy with no expires_at never expires`);
      }
    });
  }

  it("offer-accept releases the offer's claim ONLY for a withdrawn booking", () => {
    const src = readFileSync(join(ROUTES, "rentABuddyMarketplace.ts"), "utf8");
    const calls = [...src.matchAll(/await releaseOfferClaim\(/g)];
    assert.equal(calls.length, 1);
    const stmtStart = src.lastIndexOf("\n", calls[0]!.index!) + 1;
    const stmt = src.slice(stmtStart, src.indexOf("\n", calls[0]!.index!));
    assert.match(stmt, /if \(settled\.outcome === "withdrawn"\) \{ await releaseOfferClaim\(svc, offerId\); return sendBookingLedgerRefusal\(res, settled\.ledger\); \}/,
      "the claim is what stops a second accept making a second booking: it may be released only when the booking row is gone");
  });

  it("the ledger is the FIRST thing done after the insert — nothing references the booking yet when it is withdrawn", () => {
    // Between a booking INSERT and its ledger call there may be the insert's own
    // error handling and nothing that writes: no event, no notification, no
    // thread. Otherwise withdrawing the row would orphan (or cascade away) what
    // was written in between.
    const WRITES = /\.(insert|upsert|update|delete)\(|recordBookingEvent\(|sendPush|notify|emitAnalyticsEvent\(/;

    /**
     * Drop the insert's OWN failure branches — `if (<somethingErr…>) { … return … }`
     * — which end the request and so cannot precede a ledger call. (Offer-accept
     * releases its claim there; that is a write on the path where there is no
     * booking to ledger.) A branch that does not return is kept and scanned.
     */
    function withoutFailureBranches(code: string): string {
      let out = "";
      let i = 0;
      const head = /if \(\s*!?\w*(?:[Ee]rr(?:or)?)\w*[^)]*\)\s*\{/g;
      for (;;) {
        head.lastIndex = i;
        const m = head.exec(code);
        if (!m) return out + code.slice(i);
        let depth = 1;
        let j = m.index + m[0].length;
        while (j < code.length && depth > 0) {
          if (code[j] === "{") depth++;
          else if (code[j] === "}") depth--;
          j++;
        }
        const block = code.slice(m.index, j);
        out += code.slice(i, m.index) + (/\breturn\b/.test(block) ? "" : block);
        i = j;
      }
    }

    let checked = 0;
    for (const f of BOOKING_CREATION_ROUTERS) {
      const src = readFileSync(join(ROUTES, f), "utf8");
      for (const m of src.matchAll(BOOKING_INSERT_RE)) {
        const insertAt = m.index! + m[0].length;
        const ledgerAt = src.indexOf("settleBookingLedger(", insertAt);
        assert.notEqual(ledgerAt, -1, `${f}: a booking insert with no ledger call after it`);
        const line = src.slice(0, insertAt).split("\n").length;
        // From the end of the insert statement (its `.single();` / `.select();`)
        // to the ledger call.
        const rest = src.slice(insertAt, ledgerAt);
        const stmtEnd = rest.search(/\)\s*;\s*\n/);
        assert.notEqual(stmtEnd, -1, `${f}:${line} — could not find the end of the insert statement`);
        const between = withoutFailureBranches(rest.slice(stmtEnd).replace(/\/\/[^\n]*/g, ""));
        assert.equal(WRITES.test(between), false,
          `${f}:${line} — something is written between the booking insert and its ledger call:\n${between}`);
        assert.ok(between.length < 1500, `${f}:${line} — the ledger call is ${between.length} characters after the insert; is it still the first thing done?`);
        checked++;
      }
    }
    assert.equal(checked, 5);
  });
});

// ── The two helpers that do the refusing ─────────────────────────────────────

function deletingClient(outcome: { error?: any; throws?: boolean } = {}) {
  const ops: Array<{ table: string; op: string; args: any[] }> = [];
  const client = {
    from(table: string) {
      const b: any = {
        delete() { ops.push({ table, op: "delete", args: [] }); return b; },
        eq(c: string, v: any) { ops.push({ table, op: "eq", args: [c, v] }); return b; },
        then(res: (v: any) => void, rej: (e: any) => void) {
          if (outcome.throws) return rej(new Error("network"));
          return res({ data: null, error: outcome.error ?? null });
        },
      };
      return b;
    },
  };
  return { client, ops };
}

describe("withdrawUnledgeredBooking — the booking whose ledger was refused does not stay", () => {
  it("deletes exactly that booking, by id, and nothing else", async () => {
    const { client, ops } = deletingClient();
    assert.equal(await withdrawUnledgeredBooking(client, "bk-9"), true);
    assert.deepEqual(ops, [
      { table: "rent_buddy_bookings", op: "delete", args: [] },
      { table: "rent_buddy_bookings", op: "eq", args: ["id", "bk-9"] },
    ]);
  });

  it("reports false — not a thrown error, not a silent true — when the delete fails or throws", async () => {
    assert.equal(await withdrawUnledgeredBooking(deletingClient({ error: { message: "nope" } }).client, "bk-9"), false);
    assert.equal(await withdrawUnledgeredBooking(deletingClient({ throws: true }).client, "bk-9"), false);
  });

  it("never issues an unfiltered delete: no id, no call", async () => {
    const { client, ops } = deletingClient();
    assert.equal(await withdrawUnledgeredBooking(client, ""), false);
    assert.equal(await withdrawUnledgeredBooking(null, "bk-9"), false);
    assert.deepEqual(ops, []);
  });
});

describe("sendBookingLedgerRefusal — the cause has a NAME, and is never a booking", () => {
  function capture() {
    const out: { status?: number; body?: any } = {};
    const res = { status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
    return { res, out };
  }
  // An OUTAGE is a 503 the client may retry. A REFUSAL is the database's
  // verdict on the request as sent: retrying it changes nothing, so it is a
  // 4xx with `retryable: false` — never a 503 a client loops on.
  const CASES: Array<[Exclude<LedgerWriteResult, { status: "written" }>, number, boolean, Record<string, unknown>]> = [
    [{ status: "unavailable", error: "ledger_unavailable", detail: "x" }, 503, true, { error: "ledger_unavailable" }],
    [{ status: "failed", error: "ledger_write_failed", detail: "x" }, 503, true, { error: "ledger_write_failed" }],
    [{ status: "skipped", reason: "missing_arguments" }, 503, true, { error: "ledger_write_failed" }],
    [{ status: "refused", refusal: "invalid_total", detail: "-5" }, 422, false, { error: "ledger_refused", refusal: "invalid_total" }],
    [{ status: "refused", refusal: "buddy_not_found", detail: "x" }, 404, false, { error: "ledger_refused", refusal: "buddy_not_found" }],
    [{ status: "refused", refusal: "booking_not_ledgerable", detail: "x" }, 409, false, { error: "ledger_refused", refusal: "booking_not_ledgerable" }],
  ];
  for (const [result, status, retryable, expected] of CASES) {
    it(`${result.status}${result.status === "refused" ? ` (${result.refusal})` : ""} → ${status} ${JSON.stringify(expected)}, retryable: ${retryable}`, () => {
      const { res, out } = capture();
      sendBookingLedgerRefusal(res, result);
      assert.equal(out.status, status);
      assert.equal(out.body.retryable, retryable);
      for (const [k, v] of Object.entries(expected)) assert.equal(out.body[k], v);
      assert.equal("booking" in out.body, false, "a refusal must not carry a booking");
      assert.match(out.body.message, /not created/);
      assert.match(out.body.message, /Nothing was charged/);
      if (!retryable) assert.equal(/try again shortly/i.test(out.body.message), false, "a permanent refusal must not invite a retry");
      assert.equal(JSON.stringify(out.body).includes("detail"), false, "the database's detail text is for the log, not the traveller");
    });
  }
});

// ── settleBookingLedger — what may be said about a just-inserted booking ─────

/**
 * A client whose posting function answers from a script, one answer per call,
 * and whose DELETE succeeds or is refused. `"commit"` in the script means the
 * posting COMMITTED; a booking with a committed ledger cannot be deleted
 * (migration 3510), which is what makes the lost answer dangerous.
 */
function settlingClient(script: Array<"posted" | "lost" | "error" | "absent" | "refused">) {
  const log = { posts: 0, committed: 0, deletes: 0, deleted: false };
  const client = {
    async rpc(fn: string, _args: any) {
      assert.equal(fn, "rb_post_booking_ledger");
      const step = script[Math.min(log.posts, script.length - 1)]!;
      log.posts++;
      const posted = (replayed: boolean) => ({
        data: { ok: true, event: "booking_created", replayed, entries_appended: replayed ? 0 : 4, fee_percent: replayed ? null : 10, fee_source: replayed ? null : "owner_default", summary: { booking_id: "bk-1", platform_fee_percent: 10 } },
        error: null,
      });
      if (step === "absent") return { data: null, error: { code: "PGRST202", message: "Could not find the function public.rb_post_booking_ledger in the schema cache" } };
      if (step === "refused") return { data: { ok: false, refusal: "buddy_not_found", detail: "x" }, error: null };
      if (step === "error") return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      const replayed = log.committed > 0;
      if (!replayed) log.committed++;
      if (step === "lost") return { data: null, error: { code: "08006", message: "connection failure" } };
      return posted(replayed);
    },
    from(table: string) {
      assert.equal(table, "rent_buddy_bookings");
      const b: any = {
        delete() { log.deletes++; return b; },
        eq() { return b; },
        then(res: (v: any) => void) {
          if (log.committed > 0) return res({ data: null, error: { code: "P0001", message: "rent_buddy_earnings_entries is append-only" } });
          log.deleted = true;
          return res({ data: null, error: null });
        },
      };
      return b;
    },
  };
  return { client, log };
}

describe("settleBookingLedger — an unanswered posting is confirmed before anything is withdrawn", () => {
  const BOOKING = { id: "bk-1" };

  it("posted → ledgered; one call, no delete", async () => {
    const { client, log } = settlingClient(["posted"]);
    const r = await settleBookingLedger(client, BOOKING, "bp-1");
    assert.equal(r.outcome, "ledgered");
    assert.deepEqual(log, { posts: 1, committed: 1, deletes: 0, deleted: false });
  });

  it("the posting COMMITTED and its answer was lost → the re-post answers `replayed`: ledgered, ONE ledger, no delete", async () => {
    const { client, log } = settlingClient(["lost", "posted"]);
    const r = await settleBookingLedger(client, BOOKING, "bp-1");
    assert.equal(r.outcome, "ledgered");
    assert.equal(r.outcome === "ledgered" && r.confirmedOnRetry, true);
    assert.equal(r.outcome === "ledgered" && r.ledger.replayed, true, "the second call wrote nothing");
    assert.deepEqual(log, { posts: 2, committed: 1, deletes: 0, deleted: false });
  });

  it("the first call errored and committed nothing → the re-post makes the ledger: ledgered, ONE ledger", async () => {
    const { client, log } = settlingClient(["error", "posted"]);
    const r = await settleBookingLedger(client, BOOKING, "bp-1");
    assert.equal(r.outcome, "ledgered");
    assert.deepEqual(log, { posts: 2, committed: 1, deletes: 0, deleted: false });
  });

  it("every answer is lost → the DELETE is refused, so the booking EXISTS: kept, never withdrawn", async () => {
    const { client, log } = settlingClient(["lost"]);
    const r = await settleBookingLedger(client, BOOKING, "bp-1");
    assert.equal(r.outcome, "kept", "a booking that exists was reported as not created");
    assert.deepEqual(log, { posts: 2, committed: 1, deletes: 1, deleted: false });
  });

  it("the call errors twice and commits nothing → withdrawn (the row is gone), ledger_write_failed", async () => {
    const { client, log } = settlingClient(["error"]);
    const r = await settleBookingLedger(client, BOOKING, "bp-1");
    assert.equal(r.outcome, "withdrawn");
    assert.equal(r.ledger.status, "failed");
    assert.deepEqual(log, { posts: 2, committed: 0, deletes: 1, deleted: true });
  });

  for (const definite of ["absent", "refused"] as const) {
    it(`a DEFINITE answer (${definite}) is not re-posted: withdrawn after one call`, async () => {
      const { client, log } = settlingClient([definite]);
      const r = await settleBookingLedger(client, BOOKING, "bp-1");
      assert.equal(r.outcome, "withdrawn");
      assert.equal(r.ledger.status, definite === "absent" ? "unavailable" : "refused");
      assert.deepEqual(log, { posts: 1, committed: 0, deletes: 1, deleted: true });
    });
  }
});

// ── The Idempotency-Key ──────────────────────────────────────────────────────

describe("the creation key — client-generated per attempt, scoped by the actor and the resource", () => {
  const reqWith = (headers: Record<string, string>, body: any = {}) => ({ get: (h: string) => headers[h.toLowerCase()], body });

  it("no key → none; the handler creates as it always did", () => {
    assert.deepEqual(readCreationKey(reqWith({}), "book:b1"), { status: "none" });
  });

  it("a usable key is scoped by the path and the resource, from the header or the body", () => {
    assert.deepEqual(readCreationKey(reqWith({ "idempotency-key": "abcDEF12-34_5.6:7" }), "book:b1"), { status: "key", key: "book:b1:abcDEF12-34_5.6:7" });
    assert.deepEqual(readCreationKey(reqWith({}, { idempotencyKey: "12345678" }), "offer:o9"), { status: "key", key: "offer:o9:12345678" });
    // The same client key on two different resources is two different keys.
    assert.notEqual(
      (readCreationKey(reqWith({ "idempotency-key": "12345678" }), "offer:o1") as any).key,
      (readCreationKey(reqWith({ "idempotency-key": "12345678" }), "offer:o2") as any).key,
    );
  });

  it("a key that was sent and is unusable is INVALID — refused, never silently dropped", () => {
    for (const bad of ["short", "has space 12345", "x".repeat(121), "semi;colon;12345"]) {
      assert.deepEqual(readCreationKey(reqWith({ "idempotency-key": bad }), "book:b1"), { status: "invalid" }, bad);
    }
    assert.deepEqual(readCreationKey(reqWith({}, { idempotencyKey: 12345678 }), "book:b1"), { status: "invalid" });
  });

  /** A client holding the bookings this traveller created, by creation_key. */
  function keyedClient(rows: any[], opts: { lookupFails?: boolean } = {}) {
    const posts: string[] = [];
    return {
      posts,
      client: {
        async rpc(_fn: string, args: any) { posts.push(args.p_booking_id); return { data: { ok: true, event: "booking_created", replayed: true, entries_appended: 0, summary: { booking_id: args.p_booking_id, platform_fee_percent: 10 } }, error: null }; },
        from() {
          const f: Record<string, any> = {};
          const b: any = {
            select() { return b; }, limit() { return b; },
            eq(c: string, v: any) { f[c] = v; return b; },
            then(res: (v: any) => void) {
              if (opts.lookupFails) return res({ data: null, error: { message: "boom" } });
              return res({ data: rows.filter((r) => r.traveler_id === f.traveler_id && r.creation_key === f.creation_key), error: null });
            },
          };
          return b;
        },
      },
    };
  }
  function capture() {
    const out: { status?: number; body?: any } = {};
    const res = { status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
    return { res, out };
  }

  it("a retried create finds the original: 200, the ORIGINAL booking, its ledger confirmed, and the handler stops", async () => {
    const original = { id: "bk-original", traveler_id: "t1", buddy_id: "bp1", creation_key: "book:b1:attempt-1-xyz" };
    const { client, posts } = keyedClient([original]);
    const { res, out } = capture();
    const creation = await beginIdempotentCreation(reqWith({ "idempotency-key": "attempt-1-xyz" }), res, client, "t1", "book:b1", (b) => ({ booking: b }));
    assert.equal(creation.done, true);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { booking: original, idempotentReplay: true });
    assert.deepEqual(posts, ["bk-original"], "the original's ledger is confirmed by an idempotent re-post");
  });

  it("the key is scoped by the ACTING USER: another traveller's booking with the same key is not returned", async () => {
    const theirs = { id: "bk-theirs", traveler_id: "someone-else", buddy_id: "bp1", creation_key: "book:b1:attempt-1-xyz" };
    const { client } = keyedClient([theirs]);
    const { res, out } = capture();
    const creation = await beginIdempotentCreation(reqWith({ "idempotency-key": "attempt-1-xyz" }), res, client, "t1", "book:b1", (b) => ({ booking: b }));
    assert.equal(creation.done, false);
    assert.equal(creation.key, "book:b1:attempt-1-xyz");
    assert.equal(out.status, undefined, "nothing may be answered: the handler carries on and creates");
  });

  it("a malformed key → 400 invalid_idempotency_key and the handler stops", async () => {
    const { client } = keyedClient([]);
    const { res, out } = capture();
    const creation = await beginIdempotentCreation(reqWith({ "idempotency-key": "short" }), res, client, "t1", "book:b1", (b) => ({ booking: b }));
    assert.equal(creation.done, true);
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "invalid_idempotency_key");
  });

  it("the lookup failing is a 503, not a second booking", async () => {
    const { client } = keyedClient([], { lookupFails: true });
    const { res, out } = capture();
    const creation = await beginIdempotentCreation(reqWith({ "idempotency-key": "attempt-1-xyz" }), res, client, "t1", "book:b1", (b) => ({ booking: b }));
    assert.equal(creation.done, true, "creating without knowing whether the original exists is how a duplicate is made");
    assert.equal(out.status, 503);
    assert.equal(out.body.retryable, true);
  });

  it("two retries race: the loser's INSERT hits rbb_creation_key_once and answers with the winner's booking", async () => {
    const rows: any[] = [];
    const { client } = keyedClient(rows);
    const { res, out } = capture();
    const creation = await beginIdempotentCreation(reqWith({ "idempotency-key": "attempt-1-xyz" }), res, client, "t1", "book:b1", (b) => ({ booking: b }));
    assert.equal(creation.done, false);
    // …the other request inserts first:
    rows.push({ id: "bk-winner", traveler_id: "t1", buddy_id: "bp1", creation_key: creation.key });
    const conflict = { code: "23505", message: 'duplicate key value violates unique constraint "rbb_creation_key_once"' };
    assert.equal(await creation.replayOnConflict(conflict), true);
    assert.equal(out.status, 200);
    assert.equal(out.body.booking.id, "bk-winner");
    assert.equal(out.body.idempotentReplay, true);
  });

  it("any OTHER insert error is not a replay", async () => {
    const { client } = keyedClient([]);
    const { res, out } = capture();
    const creation = await beginIdempotentCreation(reqWith({ "idempotency-key": "attempt-1-xyz" }), res, client, "t1", "book:b1", (b) => ({ booking: b }));
    assert.equal(await creation.replayOnConflict({ code: "23505", message: 'duplicate key value violates unique constraint "some_other_index"' }), false);
    assert.equal(await creation.replayOnConflict({ code: "23514", message: "check violation" }), false);
    assert.equal(out.status, undefined);
  });
});

// ── The price ────────────────────────────────────────────────────────────────
//
// WHAT THIS HALF USED TO ASSERT, against `createEarningsLedgerEntry` and a
// recording client, and what holds each figure now. Three rows changed meaning.
//
//  (a) "uses the buddy level's fee rule and derives gross/net from it"
//      → database test C6 (schedule row for the level), C1/C7 (gross, fee, net).
//
//  (b) "writes NO row when the buddy's level has no fee rule"  — CHANGED.
//      The old writer refused (`fee_unresolved`), because the alternative then
//      was a silent literal 22 that was indistinguishable from a configured
//      rate (`08` §2.6). The owner ruled on 2026-10-04 that the commission is
//      10 % of the pre-tax service price "as a starting value", configurable by
//      product and market. So a level with no row is priced at 10 — and the
//      `08` §2.6 objection is met a different way: the answer carries
//      `fee_source = 'owner_default'`, so "nobody configured this" is never
//      indistinguishable from "somebody configured 10". C1 pins both.
//
//  (c) "writes NO row when the fee table cannot be read" — the read is inside
//      the SQL function's transaction now; if it fails the call fails and
//      nothing is written (`creatorLedgerBookingEntries.test.ts`, the `failed`
//      cases). A schedule row that is READABLE BUT UNUSABLE refuses: C8.
//
//  (d) "keeps the traveller service fee at 0 while rent_buddy_enabled is off"
//      and "reads traveler_service_fee_pct once the lane is live" — CHANGED.
//      The old writer booked the schedule's traveller-side percentage as soon
//      as the master switch was on. The owner's ruling names ONE fee (the
//      commission, deducted from the buddy); whether travellers are charged a
//      service fee on top is ruling R1 and is not made. The SQL function books
//      no traveller-side fee in either flag position — the conservative
//      reading: nobody is charged a fee nobody ruled on. C1 and C6 pin 0, C6
//      with a schedule row that carries traveler_service_fee_pct = 5. This is
//      an OPEN OWNER QUESTION (see the PAY-D handoff), not a decision.
//
//  (e) "writes nothing when the buddy profile cannot be loaded" /
//      "is a no-op on missing arguments" → `creatorLedgerBookingEntries.test.ts`.

describe("the price is asserted against the database, not against a recording client", () => {
  const DB_TEST = "db/rentBuddyLedgerPosting.db.test.ts";
  const src = readFileSync(join(HERE, DB_TEST), "utf8");
  function bodyOf(id: string): string {
    const start = src.indexOf(`test("${id}. `);
    assert.notEqual(start, -1, `${DB_TEST} no longer has a test ${id}`);
    const next = src.indexOf("\n    test(\"", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }
  const HELD: Array<{ what: string; by: string; needles: string[] }> = [
    { what: "(a) the level's schedule row prices the booking", by: "C6",
      needles: ['[r1.fee_percent, r1.fee_source], [25, "fee_schedule"]', "summaryOf(viaSchedule)!.platform_fee_amount, 20"] },
    { what: "(a) a market/product override beats the schedule, most specific first", by: "C6",
      needles: ['[r2.fee_percent, r2.fee_source], [8, "launch_control"]', "[12, 9.6]"] },
    { what: "(a) a booking already priced is not re-priced when configuration changes", by: "C6",
      needles: ["summaryOf(viaSchedule)!.platform_fee_percent, 25"] },
    { what: "(a) gross, fee and net", by: "C1",
      needles: ["s.total_booking_usd, 123.45", "s.platform_fee_amount, 12.35", "s.buddy_net_estimated_amount, 111.1"] },
    { what: "(b) no row for the level → 10, and it SAYS it is the default", by: "C1",
      needles: ["r.fee_percent, 10", 'r.fee_source, "owner_default"'] },
    { what: "(c) an unusable schedule row refuses; nothing is written", by: "C8",
      needles: ["fee_config_invalid", "summaryOf(b), null"] },
    { what: "(d) no traveller-side fee is booked at the default", by: "C1",
      needles: ["s.traveler_service_fee_amount, 0"] },
    { what: "(d) no traveller-side fee is booked even when the schedule row carries one", by: "C6",
      needles: ["summaryOf(viaSchedule)!.traveler_service_fee_amount, 0"] },
    { what: "the booking's payee and traveller are derived from the booking row", by: "C1",
      needles: ["s.buddy_user_id, w.buddyUser", "s.traveler_id, w.traveller"] },
    { what: "is_estimated stays true and the cash balance is not marked confirmed", by: "C2",
      needles: ["s.is_estimated, true", "s.cash_balance_confirmed, false"] },
  ];
  for (const h of HELD) {
    it(`${h.what} → ${h.by}`, () => {
      const body = bodyOf(h.by);
      for (const n of h.needles) {
        assert.ok(body.includes(n), `${DB_TEST} ${h.by} no longer asserts \`${n}\` — "${h.what}" would be asserted nowhere`);
      }
    });
  }

  it("no creation path and no deposit policy multiplies, sums or rounds money in JavaScript", () => {
    // Round 2 of PAY-055. The canonical route carried `totalUsd * 0.3`, the
    // marketplace routes `calculateDeposit`'s `Math.round(total * percent / 100
    // * 100) / 100`, and the add-ons handler a `reduce` over prices — all
    // floats. The price, the split and the add-on sum are rb_quote_booking's and
    // rb_post_booking_ledger's now.
    const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const offenders: string[] = [];
    const MONEY_MATH = [
      /Math\.round\([^\n]*(?:usd|total|deposit|price|rate|cash|amount)[^\n]*\*\s*100/i,
      /\b(?:totalUsd|rateUsd|depositUsd|priceUsd)\s*[*]\s*[\w.(]/,
      /\*\s*0\.3\b/,
      /reduce\([^\n]*price_usd/,
      /Number\(bk\.total_usd\)\s*\+/,
      /depositPercent\s*\/\s*100/,
    ];
    for (const f of [...BOOKING_CREATION_ROUTERS.map((r) => join(ROUTES, r)), join(HERE, "../services/rentBuddy/PricingService.ts")]) {
      const all = strip(readFileSync(f, "utf8"));
      // PricingService also SUGGESTS a price range to a buddy (never stored,
      // never charged): only its deposit policy is in scope.
      const code = f.endsWith("PricingService.ts") ? all.slice(all.indexOf("export function calculateDeposit"), all.indexOf("export function getBookingExpiresAt")) : all;
      assert.ok(code.length > 200, `${f}: nothing was scanned`);
      for (const re of MONEY_MATH) if (re.test(code)) offenders.push(`${f.split("/").pop()}: ${re}`);
    }
    assert.deepEqual(offenders, []);
    // …and each priced creation path asks the database for the price.
    assert.equal(count(readFileSync(join(ROUTES, "rentABuddy.ts"), "utf8"), /await quotePricedBooking\(/g), 2, "canonical + rebook");
    assert.equal(count(readFileSync(join(ROUTES, "rentABuddyMarketplace.ts"), "utf8"), /await quotePricedBooking\(/g), 3, "offer creation + offer-accept + package-book");
  });

  it("no route file and neither ledger module computes a commission in JavaScript", () => {
    // PAY-055. The retired writer read rent_buddy_fee_rules and multiplied. A
    // fee read from JavaScript on a WRITE path is how the arithmetic comes back.
    const offenders: string[] = [];
    for (const f of ["../lib/rentBuddyEarningsLedger.ts", "../lib/rentBuddyLedgerPosting.ts"]) {
      const code = readFileSync(join(HERE, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      if (/rent_buddy_fee_rules|platform_fee_percent\s*[*/]|Math\.round|toFixed\(|\*\s*100|\/\s*100/.test(code)) offenders.push(f);
      assert.equal(/\.(upsert|insert|update)\(/.test(code), false, `${f} writes a table itself`);
    }
    assert.deepEqual(offenders, []);
  });
});
