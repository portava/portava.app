/**
 * census-compass CP-02 — "Compass consumes its Passport projection variant;
 * §35 does not rebuild identity independently."
 *
 * THE ROW, AS THE CENSUS LEFT IT (verbatim):
 *   "Half-closed since census-passport: `GET /compass/people/:userId/passport`
 *    (routes/compass.ts) serves `discovery_card` through
 *    `buildConsumerProjection` behind the fail-closed `allowDiscoveryPersonCard`
 *    gate … But **no client calls it** … and the traveler list still reads
 *    `profiles` directly — routes/compass.ts selects `username, display_name,
 *    name, avatar_url, …` — one of the two real direct person-identity readers
 *    in the tree (census-discovery C33)."
 *
 * Two halves, and this suite is about both:
 *
 *   SERVER  `GET /compass/recommendations?surface=traveler` must not assemble
 *           a person out of raw `profiles` columns. Every person it returns is
 *           admitted by `allowDiscoveryPersonCard` — the SAME fail-closed gate
 *           the person-card endpoint uses — and named by the `discovery_card`
 *           consumer projection. A viewer who may not see someone's card gets
 *           NOTHING for that person: not a redacted row, not a stub, not an id.
 *
 *   CLIENT  something actually calls `GET /compass/people/:userId/passport`.
 *           §4 reads the client file and fails if the call is gone again.
 *
 * TEST-FIRST. Written and run BEFORE a line of the implementation existed.
 * That first run was RED 11 of 18, for exactly the state the census describes:
 *   1a/1b/1c  the opted-out and the age-restricted travelers were RETURNED —
 *             the list never consulted the gate at all;
 *   1e/1f     an unreadable opt-out table returned a FULL page of seven people
 *             instead of none;
 *   2a        `data.username` was `raw_t1`, the raw `profiles.username` column,
 *             where the Passport projection says the handle is `passport_t1`;
 *   2b/2d     the name came from the row, so an un-opted-in name and a
 *             whitespace-only one resolved through a second, local rule;
 *   4a/4b     the traveler branch still selected the four identity columns and
 *             never mentioned `allowDiscoveryPersonCard`;
 *   4c        no client named the endpoint (the census's own grep, as a test).
 *
 * HONEST about what was ALREADY green before the change, and why: 2c, 2e, 2f,
 * 2g, 3a and 3b. `buildListIdentityProjections` — the batch identity path this
 * change replaces — already applied the name-visibility and picture opt-out
 * rules correctly. The census's finding was never that those two rules were
 * WRONG here; it was that Compass answered "who is this person" from a source
 * of its own. Those cases are kept because they must not regress in the swap.
 *
 * MUTATION LOG — each mutation applied ALONE to the restored source, the WHOLE
 * suite re-run, the source restored before the next:
 *   M1  the gate removed: the `allowDiscoveryPersonCard` filter deleted, so
 *       every ranked candidate is projected and returned         → red (1a,1b,1c)
 *   M2  the projection swapped back for the raw `profiles` read: the identity
 *       columns restored to the candidate select and read straight off
 *       `s.row` (username / display_name / avatar_url / verified)
 *                                                          → red (2a,2b,2d,2e,4a)
 *   M3  the gate consulted but made fail-OPEN — a `check_failed` decision
 *       treated as admissible                                        → GREEN first.
 *       Reported as run: 1e/1f are OVER-DETERMINED — when those tables are
 *       unreadable the per-person projection ALSO refuses, so behaviour cannot
 *       see the difference. The suite was then given 4b2, which pins that the
 *       list admits on `.allowed` and never reads a denial's REASON, and the
 *       same mutation is red (4b2).
 *   M4  the blank-name guard removed, so the assembler's un-blank-checked
 *       `identity.name` renders a whitespace-only title                → red (2d)
 *   M5  a person whose projection is only `restricted` (blocked /
 *       account-unavailable) kept in the page instead of dropped   → GREEN first.
 *       Reported as run: the list already excludes blocked candidates before
 *       ranking, so no fixture then in the suite could produce that card. §3b
 *       was then added, which forces the shape the one way this tree can (see
 *       its own header), and the same mutation is red (3b1).
 *   M6  the private-profile suppression dropped, so a locked preview shows its
 *       handle, city and avatar                                     → red (3a,3b)
 *   M7  the CLIENT half withdrawn — the traveler card points at another
 *       endpoint instead of the person card                            → red (4c)
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassPersonIdentity.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";

import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import compassRouter from "../routes/compass.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ALICE      = "00000000-0000-0000-0000-0000000000a1";
const T_OPEN     = "00000000-0000-0000-0000-0000000000t1"; // plain, discoverable
const T_NAMED    = "00000000-0000-0000-0000-0000000000t2"; // opted into show_real_name
const T_BLANK    = "00000000-0000-0000-0000-0000000000t3"; // opted in, blank display_name
const T_NOPIC    = "00000000-0000-0000-0000-0000000000t4"; // picture opt-out
const T_NODISC   = "00000000-0000-0000-0000-0000000000t5"; // allow_profile_discovery = false
const T_AGE      = "00000000-0000-0000-0000-0000000000t6"; // age_restriction_enabled = true
const T_PRIVATE  = "00000000-0000-0000-0000-0000000000t7"; // is_private, not followed

// ─────────────────────────────────────────────────────────────────────────────
// A total fake: every unknown table resolves EMPTY and no builder method ever
// throws, so a read this route grows tomorrow degrades instead of 500ing. Reads
// of a table named in `failReads` resolve as a PostgREST error — resolved, never
// thrown, which is what supabase-js actually does.
// ─────────────────────────────────────────────────────────────────────────────
function makeClient(tables: Record<string, any[]>, failReads: string[] = []) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;

    const src  = (): any[] => tables[table] ?? [];
    const rows = ()        => {
      const out = src().filter((r) => filters.every((f) => f(r)));
      return limitN === null ? out : out.slice(0, limitN);
    };
    const fail = () => (failReads.includes(table)
      ? { data: null, error: { code: "42501", message: `unreadable: ${table}` }, count: null }
      : null);

    const base: any = {
      select() { return proxy; },
      eq(c: string, v: any)  { filters.push((r) => r[c] === v); return proxy; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return proxy; },
      in(c: string, v: any[]) { filters.push((r) => Array.isArray(v) && v.includes(r[c])); return proxy; },
      is(c: string, v: any)  { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return proxy; },
      limit(n: number)       { limitN = n; return proxy; },
      insert(d: any)         { return Promise.resolve({ data: d, error: null }); },
      maybeSingle: async () => fail() ?? { data: rows()[0] ?? null, error: null, count: null },
      single:      async () => fail() ?? { data: rows()[0] ?? null, error: null, count: null },
      then(onF: any, onR: any) {
        return Promise.resolve(fail() ?? { data: rows(), error: null, count: rows().length }).then(onF, onR);
      },
    };
    // Anything else (.like/.ilike/.or/.not/.order/.gte/.contains/…) chains.
    const proxy: any = new Proxy(base, {
      get(t, p) { return p in t ? (t as any)[p] : () => proxy; },
    });
    return proxy;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) =>
        token === "alice-tok"
          ? { data: { user: { id: ALICE } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

/** A profile row as the database holds it — raw columns, not a projection. */
function profileRow(id: string, over: Record<string, any> = {}) {
  return {
    id,
    // handle and username DIFFER on purpose: the Passport projection reads
    // `handle ?? username`, the old inline path read `username`. Which value
    // comes back on the wire says which path produced the card.
    handle:   `passport_${id.slice(-2)}`,
    username: `raw_${id.slice(-2)}`,
    display_name: "Raw Display Name",
    name: "Raw Name",
    avatar_url: "https://cdn.test/avatar.png",
    cover_photo_url: null,
    verified: true,
    verified_at: null,
    verification_level: "id_verified",
    home_city: "Cebu",
    home_country: "Philippines",
    current_city: "Cebu",
    is_official: false,
    is_private: false,
    passport_visibility: "public",
    show_profile_picture_publicly: true,
    account_status: "active",
    interests: ["hiking", "beach"],
    availability_tags: [],
    spoken_languages: ["en"],
    travel_pace: null,
    planning_style: null,
    budget_style: null,
    travel_group_style: null,
    travel_styles: ["hiking", "beach"],
    open_to_meet: true,
    buddy_verified_at: null,
    created_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    ...over,
  };
}

function tables(over: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    profiles: [
      profileRow(ALICE, { handle: "alice", username: "alice" }),
      profileRow(T_OPEN),
      profileRow(T_NAMED),
      profileRow(T_BLANK, { display_name: "   ", name: null }),
      profileRow(T_NOPIC, { show_profile_picture_publicly: false }),
      profileRow(T_NODISC),
      profileRow(T_AGE),
      profileRow(T_PRIVATE, { is_private: true }),
    ],
    // show_real_name is opt-IN and fail-closed: only these two rows say yes.
    profile_privacy_settings: [
      { user_id: T_NAMED, show_real_name: true, allow_profile_discovery: true },
      { user_id: T_BLANK, show_real_name: true, allow_profile_discovery: true },
      { user_id: T_NODISC, show_real_name: false, allow_profile_discovery: false },
    ],
    user_privacy_settings: [{ user_id: T_AGE, age_restriction_enabled: true }],
    blocks: [],
    compass_settings: [],
    user_follows: [],
    user_friendships: [],
    friend_requests: [],
    trips: [],
    ...over,
  };
}

function makeApp(client: any): Express {
  _setTestClient(client as any, true);
  invalidateFlagsCache();
  clearCompassProfileCache();
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", compassRouter);
  return app;
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function travelers(client: any): Promise<any[]> {
  const srv = await listen(makeApp(client));
  try {
    const port = (srv.address() as any).port;
    const r = await fetch(
      `http://127.0.0.1:${port}/api/compass/recommendations?surface=traveler&limit=20`,
      { headers: { Authorization: "Bearer alice-tok" } },
    );
    assert.equal(r.status, 200);
    const body: any = await r.json();
    return (body.recommendations ?? []) as any[];
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

const byId = (recs: any[], id: string) => recs.find((x) => x.id === id);

// ─────────────────────────────────────────────────────────────────────────────
// §1 — the gate. The same fail-closed gate the person-card endpoint uses, per
//      person, and a denial removes the person entirely.
// ─────────────────────────────────────────────────────────────────────────────

describe("CP-02 §1 — allowDiscoveryPersonCard gates the traveler list, per person", () => {
  let recs: any[];
  before(async () => { recs = await travelers(makeClient(tables())); });

  it("1a — a traveler who opted out of profile discovery is not in the list at all", () => {
    assert.equal(byId(recs, T_NODISC), undefined);
  });

  it("1b — an age-restricted traveler is not in the list at all", () => {
    assert.equal(byId(recs, T_AGE), undefined);
  });

  it("1c — a denied person leaves NO stub: no redacted row, no bare id", () => {
    const denied = new Set([T_NODISC, T_AGE]);
    for (const rec of recs) {
      assert.ok(!denied.has(rec.id), `denied person ${rec.id} surfaced`);
      assert.ok(!denied.has(rec.data?.userId), `denied person ${rec.data?.userId} surfaced in data`);
    }
    const wire = JSON.stringify(recs);
    assert.ok(!wire.includes(T_NODISC), "the opted-out id appears on the wire");
    assert.ok(!wire.includes(T_AGE), "the age-restricted id appears on the wire");
  });

  it("1d — the travelers the gate admits ARE returned (the gate is not a blanket refusal)", () => {
    assert.ok(byId(recs, T_OPEN), "a discoverable traveler must still be recommended");
  });

  it("1e — FAIL-CLOSED: an unreadable discovery opt-out yields NO people", async () => {
    const out = await travelers(makeClient(tables(), ["profile_privacy_settings"]));
    assert.deepEqual(out, [], `expected no people, got ${JSON.stringify(out.map((r) => r.id))}`);
  });

  it("1f — FAIL-CLOSED: an unreadable age-restriction table yields NO people", async () => {
    const out = await travelers(makeClient(tables(), ["user_privacy_settings"]));
    assert.deepEqual(out, [], `expected no people, got ${JSON.stringify(out.map((r) => r.id))}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — identity comes from the discovery_card projection, not from `profiles`.
// ─────────────────────────────────────────────────────────────────────────────

describe("CP-02 §2 — the person is named by the Passport consumer projection", () => {
  let recs: any[];
  before(async () => { recs = await travelers(makeClient(tables())); });

  it("2a — the handle is the projection's, not the raw profiles.username column", () => {
    const rec = byId(recs, T_OPEN);
    assert.ok(rec, "T_OPEN must be recommended");
    assert.equal(rec.data.username, "passport_t1");
    assert.notEqual(rec.data.username, "raw_t1");
  });

  it("2b — no show_real_name opt-in ⇒ no real name, and the title falls back to the handle", () => {
    const rec = byId(recs, T_OPEN);
    assert.equal(rec.data.displayName, null, "a name nobody opted into must not be projected");
    assert.equal(rec.title, "passport_t1");
  });

  it("2c — an opted-in subject is named, through the projection", () => {
    const rec = byId(recs, T_NAMED);
    assert.ok(rec, "T_NAMED must be recommended");
    assert.equal(rec.data.displayName, "Raw Display Name");
    assert.equal(rec.title, "Raw Display Name");
  });

  it("2d — a whitespace-only display_name never renders as a blank title", () => {
    const rec = byId(recs, T_BLANK);
    assert.ok(rec, "T_BLANK must be recommended");
    assert.equal(rec.title, "passport_t3", `blank title leaked: ${JSON.stringify(rec.title)}`);
    assert.equal(rec.data.displayName, null);
  });

  it("2e — the picture opt-out is the projection's answer, not a row read", () => {
    const rec = byId(recs, T_NOPIC);
    assert.ok(rec, "T_NOPIC must be recommended");
    assert.equal(rec.data.avatarUrl, null, "an opted-out avatar was served");
  });

  it("2f — an avatar that IS permitted still arrives", () => {
    assert.equal(byId(recs, T_OPEN).data.avatarUrl, "https://cdn.test/avatar.png");
  });

  it("2g — `verified` is the projection's", () => {
    assert.equal(byId(recs, T_OPEN).data.verified, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Compass's OWN product rule still narrows on top of the projection.
// ─────────────────────────────────────────────────────────────────────────────

describe("CP-02 §3 — the private-profile suppression survives the swap", () => {
  let rec: any;
  before(async () => { rec = byId(await travelers(makeClient(tables())), T_PRIVATE); });

  it("3a — a private, unfollowed traveler exposes no handle, city or interests", () => {
    assert.ok(rec, "a private traveler is still recommendable");
    assert.equal(rec.data.username, null);
    assert.equal(rec.data.homeCity, null);
    assert.deepEqual(rec.data.sharedInterests, []);
    assert.equal(rec.city, null);
    assert.equal(rec.data.isPrivate, true);
  });

  it("3b — and no avatar: a locked preview is locked whatever the projection says", () => {
    assert.equal(rec.data.avatarUrl, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3b — a RESTRICTED projection is dropped, never rendered as a half-person.
//
// HOW THE STATE IS FORCED, stated rather than hidden: `isBlockedBetween`
// (lib/blockGuard.ts) narrows entirely inside `.or(and(…),and(…))`, and no
// in-memory double in this tree models PostgREST's `.or` — fakePassportDb says
// so in its own header ("`.or()` is intentionally a no-op"). So ANY row in
// `blocks` makes the permissions engine read every pair as blocked, and the
// assembler answers with the variant's minimal `restricted` card. That is a
// double's limitation, not production behaviour — but the card it produces is
// exactly the shape this route must refuse to render, so it is the honest way
// to reach that shape from here. (In production the same shape is reached by
// `account_unavailable`: `profiles.account_status` and the account-state table
// can disagree, and that traveler must vanish rather than appear as a name.)
// ─────────────────────────────────────────────────────────────────────────────

describe("CP-02 §3b — a restricted card is no card", () => {
  it("3b1 — nobody the assembler can only project as restricted is returned", async () => {
    const out = await travelers(makeClient(tables({
      // Alice blocks somebody who is not even a candidate here.
      blocks: [{ blocker_id: ALICE, blocked_id: "00000000-0000-0000-0000-0000000000zz" }],
    })));
    assert.deepEqual(
      out,
      [],
      `a restricted projection was rendered: ${JSON.stringify(out.map((r) => [r.id, r.title]))}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — source tripwires. A behaviour test cannot see a SECOND identity path
//      appearing beside the first; these can.
// ─────────────────────────────────────────────────────────────────────────────

describe("CP-02 §4 — both halves stay wired", () => {
  const routeSrc = readFileSync(join(PKG_ROOT, "src", "routes", "compass.ts"), "utf8");
  /** Comments are PROSE: the WHY of this row names the columns it removed, and
   *  naming a column is not reading one. 4a asks about code, so it reads code. */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const travelerBlock = (() => {
    const start = routeSrc.indexOf('if (surface === "traveler")');
    const end = routeSrc.indexOf("// Allow caller to override the context city.", start);
    assert.ok(start > 0 && end > start, "the traveler branch moved — this guard must be re-aimed");
    return routeSrc.slice(start, end);
  })();

  it("4a — the traveler candidate read no longer selects person-identity columns", () => {
    const code = strip(travelerBlock);
    for (const col of ["display_name", "avatar_url", "show_profile_picture_publicly"]) {
      assert.ok(
        !new RegExp(`\\b${col}\\b`).test(code),
        `the traveler branch still reads ${col} off profiles (census-discovery C33)`,
      );
    }
    assert.ok(!/id, username/.test(code), "the candidate select still starts `id, username`");
    assert.ok(!/row\.username/.test(code), "the list still reads a raw username column");
  });

  it("4b — the traveler branch asks the gate and the consumer projection by name", () => {
    assert.match(travelerBlock, /allowDiscoveryPersonCard\(/);
    assert.match(travelerBlock, /buildConsumerProjection\(/);
    assert.match(travelerBlock, /"discovery_card"/);
    assert.match(travelerBlock, /CP-02/, "the WHY must cite the row it closes");
  });

  it("4b2 — the list admits on `allowed` alone and never reads a denial's REASON", () => {
    // A gate that is consulted and then argued with is not a gate. The route
    // must branch on `.allowed`, so `check_failed` denies exactly like
    // `not_discoverable`; naming a reason here is how a fail-closed gate
    // becomes fail-open one sympathetic-looking case at a time. This is a
    // source guard on purpose: behaviourally the two refusals are
    // over-determined (the per-person projection ALSO refuses when those tables
    // are unreadable), so 1e/1f cannot see the difference and this can.
    const code = strip(travelerBlock);
    assert.match(code, /travGates\[i\]\.allowed/);
    // `block_check_failed` is this branch's OWN unrelated error code, hence the
    // lookbehind: what is forbidden is the gate's reason vocabulary.
    assert.ok(
      !/(?<!\w)check_failed\b|(?<!\w)not_discoverable\b/.test(code),
      "the traveler list special-cases a gate reason",
    );
  });

  it("4c — a client actually calls GET /compass/people/:userId/passport", () => {
    const clientFile = join(
      PKG_ROOT, "..", "..", "travel-buddy-standalone",
      "src", "components", "compass", "CompassTravelerRow.tsx",
    );
    const src = readFileSync(clientFile, "utf8");
    assert.match(
      src,
      /compass\/people\/\$\{[^}]+\}\/passport/,
      "no client calls the Compass person-card endpoint (the census's own grep)",
    );
  });
});
