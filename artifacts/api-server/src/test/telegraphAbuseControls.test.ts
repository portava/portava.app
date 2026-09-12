/**
 * Telegraph §22 Abuse, Moderation & Travel Scam Safety — the three controls
 * this pass built, against the real detectors and the real send path.
 *
 * Spec (identical in v1 and v1.1), §22's control table:
 *   Rate limits          "Adaptive to relationship, verification, trust,
 *                         account age and reports."
 *   Links/files          "Reputation/scanning; reserved official identities."
 *   Travel scam signals  "Off-platform payment, fake taxi, visa help, ticket
 *                         resale, fake hotel, urgent money request."
 *
 * THE FALSE-POSITIVE CORPUS IS THE POINT
 * ======================================
 * A scam detector is easy to make sensitive and worthless to make sensitive.
 * The innocent corpus below is ordinary traveller talk that contains every
 * trigger WORD — taxi, visa, ticket, hotel, money, pay — and it must produce
 * zero signals. If a pattern is loosened, that block goes red before the
 * positive block does, which is the correct order to find out.
 *
 * WHAT WOULD TURN THIS RED
 * ========================
 *   - Any family's patterns removed: the six-family test names the missing one.
 *   - The recipient-only rule inverted: the sender would start seeing their own
 *     signals, and the detector becomes tunable by the person it watches.
 *   - The tier failing OPEN on an unreadable profile: `degraded → stranger`
 *     fails, and the abuse control would be switching itself off during exactly
 *     the minutes an attacker wants it off.
 *   - `UNKNOWN_HOST` being treated as suspicious: the "most links are to places
 *     nobody has heard of" test fails, and the warning trains itself away.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   node --import tsx/esm --test src/test/telegraphAbuseControls.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import {
  SCAM_FAMILIES,
  detectTravelScamSignals,
  scanLinks,
  messageSafetySignals,
  RESERVED_OFFICIAL_HOSTS,
} from "../domain/telegraph/policies/travelScamSignals.js";
import {
  SEND_LIMITS,
  tierFrom,
  resolveSendTier,
  checkSendRateLimit,
  _clearSendTierCache,
  type TierInputs,
} from "../domain/telegraph/policies/sendRateLimit.js";

/* ───────────────────────── the six families, positive ─────────────────────── */

const POSITIVE: Record<string, string> = {
  OFF_PLATFORM_PAYMENT: "Don't use the app for this, just venmo me the deposit and we're set.",
  FAKE_TAXI: "Don't worry about the queue — my cousin has a taxi waiting outside arrivals.",
  VISA_HELP: "I know a guy at the embassy, he can fast-track your visa this week.",
  TICKET_RESALE: "I'm selling my ticket for the Friday show, you just transfer the money first.",
  FAKE_HOTEL: "The booking site is down right now, book directly with me instead.",
  URGENT_MONEY_REQUEST: "This is urgent — can you wire money today, I'll pay you back Monday.",
};

const INNOCENT: string[] = [
  "We took a taxi from the airport, it was about 300k dong.",
  "My visa came through this morning, finally!",
  "I still need to buy a ticket for the night train — any idea where?",
  "The hotel was fine, breakfast was better than expected.",
  "Can you pay for the coffees and I'll get dinner?",
  "How much money did you budget for Hanoi?",
  "The driver was lovely, he waited while I got cash out.",
  "Booking.com had a cheaper room than the hostel's own site.",
  "I'm at the airport, flight's delayed two hours.",
  "Let's split the taxi tomorrow morning.",
];

describe("Telegraph §22 — travel scam signals: all six families", () => {
  it("declares exactly §22's six families", () => {
    assert.deepEqual([...SCAM_FAMILIES], [
      "OFF_PLATFORM_PAYMENT", "FAKE_TAXI", "VISA_HELP",
      "TICKET_RESALE", "FAKE_HOTEL", "URGENT_MONEY_REQUEST",
    ]);
  });

  for (const family of SCAM_FAMILIES) {
    it(`detects ${family}`, () => {
      const signals = detectTravelScamSignals(POSITIVE[family]!);
      const families = signals.map((s) => s.family);
      assert.ok(families.includes(family),
        `"${POSITIVE[family]}" produced ${JSON.stringify(families)} — ${family} missing`);
    });
  }

  it("produces NO signal for ordinary traveller talk containing every trigger word", () => {
    for (const line of INNOCENT) {
      const signals = detectTravelScamSignals(line);
      assert.deepEqual(signals, [],
        `false positive on "${line}": ${JSON.stringify(signals)}`);
    }
  });

  it("reports one signal per family, not one per match", () => {
    const signals = detectTravelScamSignals("venmo me, seriously venmo me, cashapp works too");
    const offApp = signals.filter((s) => s.family === "OFF_PLATFORM_PAYMENT");
    assert.equal(offApp.length, 1, "a repeated phrase is one signal — a count would read as a severity");
  });

  it("carries the matched phrase so the warning is checkable, and truncates it", () => {
    const signals = detectTravelScamSignals(POSITIVE["OFF_PLATFORM_PAYMENT"]!);
    assert.ok(signals[0]!.matched.length > 0);
    assert.ok(signals[0]!.matched.length <= 80);
  });

  it("an empty or absent body produces nothing", () => {
    assert.deepEqual(detectTravelScamSignals(null), []);
    assert.deepEqual(detectTravelScamSignals(""), []);
    assert.deepEqual(detectTravelScamSignals("   "), []);
  });
});

/* ──────────────────── links, reputation, reserved identity ────────────────── */

describe("Telegraph §22 — links: structural findings and reserved official identities", () => {
  it("flags a link shortener", () => {
    const [link] = scanLinks("have a look https://bit.ly/3xyzabc");
    assert.equal(link!.host, "bit.ly");
    assert.ok(link!.findings.includes("SHORTENER"));
    assert.equal(link!.suspicious, true);
  });

  it("flags a punycode host and a mixed-script host", () => {
    const [puny] = scanLinks("https://xn--portva-9wa.app/login");
    assert.ok(puny!.findings.includes("PUNYCODE_HOST"));
    const [mixed] = scanLinks("https://pоrtava.app/login"); // Cyrillic о
    assert.ok(mixed!.findings.includes("MIXED_SCRIPT_HOST") || mixed!.findings.includes("PUNYCODE_HOST"));
  });

  it("flags an IP-literal host and credentials embedded in the URL", () => {
    const [ip] = scanLinks("http://203.0.113.10/pay");
    assert.ok(ip!.findings.includes("IP_LITERAL_HOST"));
    const [creds] = scanLinks("https://user:pass@example.com/x");
    assert.ok(creds!.findings.includes("CREDENTIALS_IN_URL"));
  });

  it("flags a LOOKALIKE of a reserved official identity", () => {
    const [one] = scanLinks("https://portava.ap/login");           // one edit away
    assert.ok(one!.findings.includes("LOOKALIKE_OFFICIAL_HOST"), JSON.stringify(one));
    const [embedded] = scanLinks("https://portava.secure-login.example/verify");
    assert.ok(embedded!.findings.includes("LOOKALIKE_OFFICIAL_HOST"), JSON.stringify(embedded));
  });

  it("does NOT flag the real official identity", () => {
    for (const host of RESERVED_OFFICIAL_HOSTS) {
      const [link] = scanLinks(`https://${host}/trips/123`);
      assert.equal(link!.suspicious, false, `${host} flagged as suspicious`);
      assert.ok(!link!.findings.includes("LOOKALIKE_OFFICIAL_HOST"));
    }
  });

  it("an ordinary unknown https host is UNKNOWN_HOST and NOT suspicious", () => {
    const [link] = scanLinks("the hostel site is https://someplacehostel.vn/rooms");
    assert.deepEqual(link!.findings, ["UNKNOWN_HOST"]);
    assert.equal(link!.suspicious, false,
      "warning on every unfamiliar link trains the warning away");
  });

  it("does not double-report the same URL", () => {
    const links = scanLinks("https://bit.ly/a and again https://bit.ly/a");
    assert.equal(links.length, 1);
  });
});

/* ────────────────── the per-message annotation for the recipient ──────────── */

describe("Telegraph §22 — messageSafetySignals", () => {
  it("returns null when there is nothing to say", () => {
    assert.equal(messageSafetySignals("see you at the station at 8"), null);
    assert.equal(messageSafetySignals(null), null);
  });

  it("raises severity to warning for the two dangerous families", () => {
    const sig = messageSafetySignals(POSITIVE["URGENT_MONEY_REQUEST"]!);
    assert.ok(sig);
    assert.equal(sig!.severity, "warning");
  });

  it("a suspicious link alone is caution, and an ordinary link is nothing", () => {
    const bad = messageSafetySignals("click https://bit.ly/xyz");
    assert.ok(bad);
    assert.equal(bad!.severity, "caution");
    assert.equal(messageSafetySignals("see https://someplacehostel.vn"), null);
  });
});

/* ─────────────────────── adaptive send rate limit: the tier ───────────────── */

function inputs(over: Partial<TierInputs> = {}): TierInputs {
  return {
    accountAgeDays: 400, verificationLevel: "basic_verified", trustScore: 80,
    openReportsAgainst: 0, hasRelationship: true, degraded: false, ...over,
  };
}

describe("Telegraph §22 — send rate limit is adaptive to the five named inputs", () => {
  it("a verified, trusted, unreported account gets the top tier", () => {
    const r = tierFrom(inputs());
    assert.equal(r.tier, "trusted");
    assert.equal(r.limit, SEND_LIMITS.trusted);
  });

  it("ACCOUNT AGE: under two days is the strictest tier", () => {
    assert.equal(tierFrom(inputs({ accountAgeDays: 0.5 })).tier, "stranger");
  });

  it("REPORTS: two open reports outrank verification", () => {
    const r = tierFrom(inputs({ openReportsAgainst: 2 }));
    assert.equal(r.tier, "stranger");
    assert.ok(r.reasons.includes("open_reports_against_sender"));
  });

  it("REPORTS: one open report caps the top tier rather than collapsing it", () => {
    const r = tierFrom(inputs({ openReportsAgainst: 1 }));
    assert.equal(r.tier, "established");
    assert.ok(r.reasons.includes("one_open_report_caps_tier"));
  });

  it("VERIFICATION and TRUST: unverified with relationships is 'established'", () => {
    assert.equal(tierFrom(inputs({ verificationLevel: "none" })).tier, "established");
  });

  it("RELATIONSHIP: a lone, unverified, month-old account is 'new'", () => {
    assert.equal(tierFrom(inputs({ verificationLevel: "none", hasRelationship: false })).tier, "new");
  });

  it("DEGRADED: an unreadable input falls to the strictest tier, never the loosest", () => {
    const r = tierFrom(inputs({ degraded: true }));
    assert.equal(r.tier, "stranger");
    assert.ok(r.reasons.includes("inputs_unreadable"));
  });

  it("every tier's limit is above the busiest plausible conversation", () => {
    for (const [tier, limit] of Object.entries(SEND_LIMITS)) {
      assert.ok(limit >= 20, `${tier} limit ${limit} would shape ordinary conversation`);
    }
  });
});

describe("Telegraph §22 — resolveSendTier reads the database and fails to strict", () => {
  beforeEach(() => { _clearSendTierCache(); });

  function client(over: { profileError?: boolean; reportsError?: boolean; profile?: any; reports?: any[] } = {}) {
    const from = (table: string) => {
      const proxy: any = new Proxy({
        select: () => proxy, eq: () => proxy, is: () => proxy, limit: () => proxy, order: () => proxy,
        maybeSingle: () => {
          if (table === "profiles" && over.profileError) return Promise.resolve({ data: null, error: { message: "boom" } });
          if (table === "profiles") return Promise.resolve({ data: over.profile ?? null, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then: (res: any) => {
          if (table === "reports" && over.reportsError) return Promise.resolve({ data: null, error: { message: "boom" } }).then(res);
          if (table === "reports") return Promise.resolve({ data: over.reports ?? [], error: null }).then(res);
          if (table === "message_thread_members") return Promise.resolve({ data: [{ thread_id: "a" }, { thread_id: "b" }], error: null }).then(res);
          return Promise.resolve({ data: [], error: null }).then(res);
        },
      }, { get(t: any, p) { return p in t ? t[p as string] : () => proxy; } });
      return proxy;
    };
    return { from } as any;
  }

  it("an unreadable profiles row is degraded and strict — not a fresh trusted account", async () => {
    const r = await resolveSendTier(client({ profileError: true }), "u1");
    assert.equal(r.inputs.degraded, true);
    assert.equal(r.tier, "stranger");
  });

  it("an unreadable reports table is degraded and strict", async () => {
    const r = await resolveSendTier(client({
      reportsError: true,
      profile: { created_at: "2020-01-01T00:00:00Z", verification_level: "trusted_traveler", trust_score: 95 },
    }), "u2");
    assert.equal(r.inputs.degraded, true);
    assert.equal(r.tier, "stranger");
  });

  it("a healthy read produces the tier the inputs justify", async () => {
    const r = await resolveSendTier(client({
      profile: { created_at: "2020-01-01T00:00:00Z", verification_level: "trusted_traveler", trust_score: 95 },
      reports: [],
    }), "u3");
    assert.equal(r.inputs.degraded, false);
    assert.equal(r.tier, "trusted");
    assert.ok((r.inputs.accountAgeDays ?? 0) > 365);
  });

  it("a missing profile row is degraded — nothing about that sender is established", async () => {
    const r = await resolveSendTier(client({ profile: null, reports: [] }), "u4");
    assert.equal(r.inputs.degraded, true);
    assert.equal(r.tier, "stranger");
  });

  it("checkSendRateLimit refuses once the tier's limit is spent, and says the tier", async () => {
    const sc = client({ profile: { created_at: "2020-01-01T00:00:00Z", verification_level: "none", trust_score: 10 }, reports: [] });
    const userId = `u-burst-${Math.random()}`;
    let last = await checkSendRateLimit(sc, userId);
    const limit = last.limit;
    for (let i = 1; i < limit + 2 && last.allowed; i++) last = await checkSendRateLimit(sc, userId);
    assert.equal(last.allowed, false, `the limiter never refused within ${limit + 2} sends`);
    assert.ok(last.retryAfterMs > 0);
    assert.ok(["stranger", "new", "established", "trusted"].includes(last.tier));
  });
});

/* ─────────────────── the read path: recipient-only annotation ─────────────── */

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-00000000000a";

function readPathClient() {
  const db: Record<string, any[]> = {
    feature_flags: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice" },
      { id: BOB, handle: "bob", name: "Bob" },
    ],
    message_threads: [{ id: THREAD, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null }],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, role: "member", joined_at: null, left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB, role: "member", joined_at: null, left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [
      // Bob (the other party) sends a scam-shaped message: Alice must see the signal.
      { id: "m-scam", thread_id: THREAD, sender_id: BOB, body: "just venmo me the deposit", created_at: "2026-05-02T00:00:00.000Z",
        deleted_at: null, edited_at: null, original_language: null, msg_type: "text", subtype: null,
        media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null },
      // Alice's OWN scam-shaped message: she must NOT see a signal on it.
      { id: "m-mine", thread_id: THREAD, sender_id: ALICE, body: "just venmo me the deposit", created_at: "2026-05-03T00:00:00.000Z",
        deleted_at: null, edited_at: null, original_language: null, msg_type: "text", subtype: null,
        media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null },
      // A clean message from Bob: no field at all.
      { id: "m-clean", thread_id: THREAD, sender_id: BOB, body: "see you at 8", created_at: "2026-05-04T00:00:00.000Z",
        deleted_at: null, edited_at: null, original_language: null, msg_type: "text", subtype: null,
        media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null },
      // A DELETED scam message from Bob: no body to scan, so no field.
      { id: "m-gone", thread_id: THREAD, sender_id: BOB, body: "", created_at: "2026-05-05T00:00:00.000Z",
        deleted_at: "2026-05-05T01:00:00.000Z", edited_at: null, original_language: null, msg_type: "text", subtype: null,
        media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null },
    ],
    message_translations: [],
  };

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    let _order: { col: string; asc: boolean } | null = null;
    const rowsNow = () => {
      let rows = (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
      if (_order) {
        const { col, asc } = _order;
        rows = [...rows].sort((a, b) => {
          const x = Date.parse(a[col]) || 0, y = Date.parse(b[col]) || 0;
          return asc ? x - y : y - x;
        });
      }
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const target: any = {
      select: () => proxy,
      eq(col: string, val: any) { preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      in(col: string, vals: any[]) { preds.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      lt(col: string, val: any) { preds.push((r) => Date.parse(r[col]) < Date.parse(val)); return proxy; },
      gte(col: string, val: any) { preds.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
      order(col: string, opts?: any) { _order = { col, asc: opts?.ascending !== false }; return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle: () => Promise.resolve({ data: rowsNow()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rowsNow()[0] ?? null, error: null }),
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const rows = rowsNow();
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
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

  return {
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

describe("GET /threads/:threadId/messages — §22 signals reach the RECIPIENT only", () => {
  let server: any;
  let base = "";

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", messagingRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}/api`;
    _setTestClient(readPathClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("annotates the other party's scam-shaped message for the recipient", async () => {
    const res = await fetch(`${base}/threads/${THREAD}/messages`, {
      headers: { authorization: `Bearer ${ALICE}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    const byId = new Map(body.messages.map((m: any) => [m.id, m]));
    const scam: any = byId.get("m-scam");
    assert.ok(scam, "the scam message was not returned at all");
    assert.ok(scam.safetySignals, "the recipient got no §22 annotation");
    assert.equal(scam.safetySignals.scam[0].family, "OFF_PLATFORM_PAYMENT");
    assert.equal(scam.safetySignals.severity, "warning");
  });

  it("does NOT annotate the caller's OWN message — the sender must not see the detector", async () => {
    const res = await fetch(`${base}/threads/${THREAD}/messages`, {
      headers: { authorization: `Bearer ${ALICE}` },
    });
    const body = (await res.json()) as any;
    const mine = body.messages.find((m: any) => m.id === "m-mine");
    assert.ok(mine);
    assert.equal(mine.safetySignals, undefined,
      "a sender who can see their own signals tunes their wording against the detector");
  });

  it("omits the field entirely on a clean message and on a deleted one", async () => {
    const res = await fetch(`${base}/threads/${THREAD}/messages`, {
      headers: { authorization: `Bearer ${ALICE}` },
    });
    const body = (await res.json()) as any;
    assert.equal(body.messages.find((m: any) => m.id === "m-clean").safetySignals, undefined);
    assert.equal(body.messages.find((m: any) => m.id === "m-gone").safetySignals, undefined);
  });
});
