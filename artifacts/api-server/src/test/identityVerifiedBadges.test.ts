/**
 * The PUBLIC identity-verified badge (census-trust TV-0e / TV-2c; OD-TRUST-3).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/identityVerifiedBadges.test.ts
 *
 * A badge is a CLAIM about a person, so every doubt resolves to no badge: the
 * flag off (the seed), a read error, a test-key approval, a later failed check,
 * a withdrawn level. Each case names the mutation that turns it red.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, noopLog } from "./helpers/failClosedSupabase.js";
import reviewsRouter from "../routes/reviews.js";
import {
  readVerifiedBadges as readVerifiedBadgesRaw,
  _resetVerifiedBadgeFlagCache,
  IDENTITY_VERIFIED_BADGE_FLAG,
  VERIFIED_BADGE_PUBLIC_CRITERIA,
  VERIFIED_BADGE_PUBLIC_STATEMENT,
} from "../services/identityVerification/verifiedBadges.js";

const A = "aaaaaaaa-0000-4000-a000-000000000001"; // ID verified, live
const B = "bbbbbbbb-0000-4000-a000-000000000002"; // ID + selfie, live
const C = "cccccccc-0000-4000-a000-000000000003"; // approved on a TEST key
const D = "dddddddd-0000-4000-a000-000000000004"; // approved, then a later FAILED check
const E = "eeeeeeee-0000-4000-a000-000000000005"; // approved, level withdrawn by an admin
const F = "ffffffff-0000-4000-a000-000000000006"; // never checked
const G = "abababab-0000-4000-a000-000000000007"; // approved live, but the level is a PLATFORM label (basic_verified)

/** Every call reads the flag afresh (the 30 s cache is reset), so cases with different flags cannot leak. */
async function readVerifiedBadges(...a: Parameters<typeof readVerifiedBadgesRaw>) { _resetVerifiedBadgeFlagCache(); return readVerifiedBadgesRaw(...a); }
const VIEWER = "99999999-0000-4000-a000-000000000009";
const TRIP = "12121212-0000-4000-a000-000000000012";

const attempt = (user_id: string, status: string, provider_mode: string | null, created_at: string) =>
  ({ id: `${user_id}-${created_at}`, user_id, status, provider_mode, provider: "stripe_identity", created_at });

const ROWS = () => ({
  feature_flags: [{ flag: IDENTITY_VERIFIED_BADGE_FLAG, enabled: true }],
  identity_verifications: [
    attempt(A, "verified", "live", "2026-09-01T00:00:00Z"),
    attempt(B, "verified", "live", "2026-09-02T00:00:00Z"),
    attempt(C, "verified", "test", "2026-09-03T00:00:00Z"),
    attempt(D, "verified", "live", "2026-08-01T00:00:00Z"),
    attempt(D, "failed", "live", "2026-09-04T00:00:00Z"),
    attempt(E, "verified", "live", "2026-09-05T00:00:00Z"),
    attempt(G, "verified", "live", "2026-09-06T00:00:00Z"),
  ],
  profiles: [
    { id: A, handle: "a", verification_level: "id_verified" },
    { id: B, handle: "b", verification_level: "id_selfie_verified" },
    { id: C, handle: "c", verification_level: "id_verified" },
    { id: D, handle: "d", verification_level: "id_verified" },
    { id: E, handle: "e", verification_level: "none" },
    { id: F, handle: "f", verification_level: null },
    { id: G, handle: "g", verification_level: "basic_verified" },
    { id: VIEWER, handle: "viewer", verification_level: null },
  ],
});

const db = (rows: Record<string, any[]>, failTable?: string) =>
  makeFailClosedClient({
    rows,
    users: { "tok-viewer": VIEWER },
    failOn: (ctx) => (failTable && ctx.table === failTable ? { message: "unreadable", code: "08006" } : null),
  }) as any;

const ENV = {} as NodeJS.ProcessEnv;

describe("readVerifiedBadges — the defined CURRENT verification, for viewers", () => {
  it("badges exactly the people whose latest finished check is approved, live, and not withdrawn", async () => {
    const m = await readVerifiedBadges(db(ROWS()), [A, B, C, D, E, F, G], ENV);
    assert.deepEqual(Object.fromEntries(m!), { [A]: { tier: "id" }, [B]: { tier: "id_selfie" } });
  });

  it("V-IN F2: a platform-standing label (basic_verified, trusted_traveler, host_verified, buddy_verified) never badges, even with a live approval", async () => {
    // MUTATION: tierOf accepting basic_verified as 'id' → G is badged → RED.
    for (const label of ["basic_verified", "trusted_traveler", "host_verified", "buddy_verified"]) {
      const rows = ROWS();
      rows.profiles = rows.profiles.map((p) => (p.id === G ? { ...p, verification_level: label } : p));
      assert.equal((await readVerifiedBadges(db(rows), [G], ENV))!.has(G), false, label);
    }
  });

  it("a TEST-key approval never badges (OD-PAY-10: no sandbox verification key)", async () => {
    // MUTATION: drop the providerModeCounts check → C is badged → RED.
    assert.equal((await readVerifiedBadges(db(ROWS()), [C], ENV))!.has(C), false);
  });

  it("a later failed check ends an earlier approval (latest wins)", async () => {
    // MUTATION: take ANY verified attempt instead of the latest → D is badged → RED.
    assert.equal((await readVerifiedBadges(db(ROWS()), [D], ENV))!.has(D), false);
  });

  it("a withdrawn level ends the badge (admin revocation clears verification_level)", async () => {
    // MUTATION: drop the IDENTITY_VERIFIED_LEVELS check → E is badged → RED.
    assert.equal((await readVerifiedBadges(db(ROWS()), [E], ENV))!.has(E), false);
  });

  it("FLAG OFF or absent (the seed): no badge map at all (null), and only the flag is read — once per 30 s", async () => {
    // MUTATION: drop the flag gate → A is badged → RED.
    const off = { ...ROWS(), feature_flags: [{ flag: IDENTITY_VERIFIED_BADGE_FLAG, enabled: false }] };
    assert.equal(await readVerifiedBadges(db(off), [A, B], ENV), null);
    const absent = { ...ROWS(), feature_flags: [] };
    const spy = db(absent); const read: string[] = []; const from = spy.from.bind(spy); spy.from = (t: string) => { read.push(t); return from(t); };
    assert.equal(await readVerifiedBadges(spy, [A, B], ENV), null);
    assert.deepEqual(read, ["feature_flags"], "only the flag is read while it is off");
    // V-IN F6: a second request inside the TTL reads nothing at all.
    assert.equal(await readVerifiedBadgesRaw(spy, [A], ENV), null);
    assert.deepEqual(read, ["feature_flags"], "the OFF flag is cached");
  });

  it("FAIL-CLOSED for a claim: an unreadable attempts or profiles read → no badge for anyone", async () => {
    // MUTATION: ignore the read error → badges from a half-read → RED.
    assert.equal((await readVerifiedBadges(db(ROWS(), "identity_verifications"), [A, B], ENV))!.size, 0);
    assert.equal((await readVerifiedBadges(db(ROWS(), "profiles"), [A, B], ENV))!.size, 0);
  });

  it("the public criteria are third person, and the statement says it is not an endorsement", () => {
    assert.equal(VERIFIED_BADGE_PUBLIC_CRITERIA.length, 3);
    for (const c of VERIFIED_BADGE_PUBLIC_CRITERIA) assert.ok(c.startsWith("Their ") || c.startsWith("The check"));
    assert.match(VERIFIED_BADGE_PUBLIC_STATEMENT, /not an endorsement/);
    assert.match(VERIFIED_BADGE_PUBLIC_STATEMENT, /cannot be bought/);
  });

  it("PARITY: the app shows the server's criteria and statement word for word", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const client = fs.readFileSync(path.resolve(here, "../../../../travel-buddy-standalone/src/components/trust/VerifiedBadge.tsx"), "utf8");
    for (const c of VERIFIED_BADGE_PUBLIC_CRITERIA) assert.ok(client.includes(`'${c}'`), `client lacks: ${c}`);
    assert.ok(client.includes(`'${VERIFIED_BADGE_PUBLIC_STATEMENT}'`));
  });
});

// ── Through a mounted surface: trip reviews ──────────────────────────────────

let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", reviewsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function tripReviews(rows: Record<string, any[]>) {
  const c = db({ blocks: [], profile_privacy_settings: [], user_account_states: [], ...rows });
  _resetVerifiedBadgeFlagCache();
  _setTestClient(c, true);
  _setTestServiceClient(c);
  const res = await fetch(`${base}/api/trips/${TRIP}/reviews`, { headers: { authorization: "Bearer tok-viewer" } });
  return { status: res.status, body: (await res.json()) as any };
}

const review = (id: string, reviewer: string) => ({
  id, reviewer_id: reviewer, entity_type: "trip", entity_id: TRIP, rating: 5, body: "x", tags: [], visibility: "public",
  state: "published", created_at: `2026-09-1${id.length}T00:00:00Z`,
  profiles: { handle: reviewer.slice(0, 1), display_name: null, avatar_url: null, verification_level: "id_verified" },
});

describe("GET /trips/:id/reviews carries each reviewer's identityBadge (TV-2c)", () => {
  it("a verified reviewer carries their tier; a test-key one carries null", async () => {
    // MUTATION: drop `identityBadge: badges.get(...)` from routes/reviews.ts → RED.
    const { status, body } = await tripReviews({ ...ROWS(), reviews: [review("r1", A), review("r22", C)] });
    assert.equal(status, 200);
    const byId = Object.fromEntries(body.reviews.map((r: any) => [r.reviewer.id, r.reviewer.identityBadge]));
    assert.deepEqual(byId[A], { tier: "id" });
    assert.equal(byId[C], null);
  });

  it("flag OFF: the response carries NO identityBadge key — byte for byte what it was before the badge existed", async () => {
    // MUTATION (V-IN F6): append identityBadge: null when OFF → RED.
    const { body } = await tripReviews({ ...ROWS(), feature_flags: [], reviews: [review("r1", A)] });
    assert.ok(!("identityBadge" in body.reviews[0].reviewer), JSON.stringify(body.reviews[0].reviewer));
  });
});
