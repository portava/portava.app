/**
 * wellKnownShare.test.ts — deep-link association files + share landing pages.
 *
 * Under test: src/routes/wellKnownShare.ts (mounted at the app root).
 *
 * Covers:
 *   A. /.well-known/apple-app-site-association — 503 when APPLE_APP_ID_PREFIX
 *      is unset; 200 with the correct appID/paths JSON when set.
 *   B. /.well-known/assetlinks.json — 503 when ANDROID_CERT_SHA256 unset;
 *      200 with package/fingerprints when set (comma-separated multi-cert).
 *   C. /u/:username — 200 with og:title/og:description/og:image for a public
 *      profile, HTML-escaping of attacker-controlled fields, deep-link button.
 *   D. /u/:username — 404 for unknown handles; generic (no-leak) card for
 *      private profiles; /passport/:username serves the same page.
 *   E. Entity catch-all (/posts /trips /event /place /memory /stamp /:id) —
 *      public entity renders its title; private, deleted and unknown-id all
 *      render the identical generic card at 200; never 404, never 500.
 *
 * Run: node --import tsx/esm --test src/test/wellKnownShare.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestServiceClient } from "../lib/supabase.js";
import wellKnownShareRouter from "../routes/wellKnownShare.js";

const USER_ID = "11111111-2222-3333-4444-555555555555";

// ── Fake service client ──────────────────────────────────────────────────────
//
// Answers the two lookups the share page makes:
//   profiles by handle (maybeSingle)
//   profile_privacy_settings (nameVisibilitySet / resolveProfileVisibility)

function makeFakeSc(opts: {
  profile?: any | null;
  privacyRows?: any[];
  accountStates?: any[];
} = {}) {
  const profile = opts.profile === undefined ? null : opts.profile;
  const privacyRows = opts.privacyRows ?? [];
  const accountStates = opts.accountStates ?? [];

  function makeBuilder(rows: any[]): any {
    let current = [...rows];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { current = current.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { current = current.filter((r) => r[col] !== val); return b; },
      in: (col: string, vals: any[]) => { current = current.filter((r) => vals.includes(r[col])); return b; },
      or: () => b,
      is: () => b,
      order: () => b,
      limit: (n: number) => { current = current.slice(0, n); return b; },
      maybeSingle: async () => ({ data: current[0] ?? null, error: null }),
      single: async () => ({ data: current[0] ?? null, error: null }),
      then: (onF: (v: any) => any, onR?: (e: any) => any) =>
        Promise.resolve({ data: current, error: null }).then(onF, onR),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles") return makeBuilder(profile ? [profile] : []);
      if (table === "profile_privacy_settings") return makeBuilder(privacyRows);
      if (table === "user_account_states") return makeBuilder(accountStates);
      return makeBuilder([]);
    },
    auth: { getUser: async () => ({ data: { user: null }, error: { message: "no auth" } }) },
  };
}

/**
 * Fake service client for the entity pages: `tables` maps table name → rows,
 * filtered by the same eq()/maybeSingle() chain the real client offers.
 * `throwOn` makes one table's builder blow up, to prove the handler fails
 * closed to the generic card instead of 500ing.
 */
function makeEntitySc(tables: Record<string, any[]>, throwOn?: string) {
  function makeBuilder(rows: any[]): any {
    let current = [...rows];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { current = current.filter((r) => r[col] === val); return b; },
      maybeSingle: async () => ({ data: current[0] ?? null, error: null }),
      single: async () => ({ data: current[0] ?? null, error: null }),
      then: (onF: (v: any) => any, onR?: (e: any) => any) =>
        Promise.resolve({ data: current, error: null }).then(onF, onR),
    };
    return b;
  }
  return {
    from: (table: string) => {
      if (table === throwOn) throw new Error("simulated lookup failure");
      return makeBuilder(tables[table] ?? []);
    },
    auth: { getUser: async () => ({ data: { user: null }, error: { message: "no auth" } }) },
  };
}

function publicProfile(overrides: Record<string, any> = {}): any {
  return {
    id: USER_ID,
    handle: "wanderer",
    username: "wanderer",
    display_name: "Wan Derer",
    name: null,
    bio: "Chasing sunsets.",
    avatar_url: null,
    passport_visibility: "public",
    is_private: false,
    account_status: "active",
    ...overrides,
  };
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function getReq(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET" },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: raw }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ── Server setup ─────────────────────────────────────────────────────────────

before(async () => {
  await new Promise<void>((resolve) => {
    const app = express();
    app.use((req: any, _res: any, next: any) => {
      req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      next();
    });
    app.use(wellKnownShareRouter); // mounted at root, same as app.ts
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  _setTestServiceClient(null as any);
  for (const k of ["APPLE_APP_ID_PREFIX", "ANDROID_CERT_SHA256"]) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── A. apple-app-site-association ────────────────────────────────────────────

describe("A: /.well-known/apple-app-site-association", () => {
  it("returns 503 with a clear message when APPLE_APP_ID_PREFIX is unset", async () => {
    const { status, headers, text } = await getReq("/.well-known/apple-app-site-association");
    assert.equal(status, 503);
    assert.match(headers["content-type"] ?? "", /application\/json/);
    const body = JSON.parse(text);
    assert.equal(body.error, "not_configured");
    assert.match(body.message, /APPLE_APP_ID_PREFIX/);
  });

  it("returns the AASA document with appID = <team>.<bundle> when configured", async () => {
    process.env.APPLE_APP_ID_PREFIX = "A1B2C3D4E5";
    const { status, headers, text } = await getReq("/.well-known/apple-app-site-association");
    assert.equal(status, 200);
    assert.match(headers["content-type"] ?? "", /application\/json/);
    assert.match(headers["cache-control"] ?? "", /max-age/);
    const body = JSON.parse(text);
    assert.deepEqual(body.applinks.apps, [], "legacy apps key must stay empty");
    assert.equal(body.applinks.details.length, 1);
    assert.equal(body.applinks.details[0].appID, "A1B2C3D4E5.com.passporttravelbuddy.app");
    assert.deepEqual(body.applinks.details[0].paths, ["/passport", "/passport/*", "/u", "/u/*"]);
  });
});

// ── B. assetlinks.json ───────────────────────────────────────────────────────

describe("B: /.well-known/assetlinks.json", () => {
  it("returns 503 with a clear message when ANDROID_CERT_SHA256 is unset", async () => {
    const { status, text } = await getReq("/.well-known/assetlinks.json");
    assert.equal(status, 503);
    const body = JSON.parse(text);
    assert.equal(body.error, "not_configured");
    assert.match(body.message, /ANDROID_CERT_SHA256/);
  });

  it("returns the statement list with all comma-separated fingerprints when configured", async () => {
    process.env.ANDROID_CERT_SHA256 = "AA:BB:CC, DD:EE:FF";
    const { status, headers, text } = await getReq("/.well-known/assetlinks.json");
    assert.equal(status, 200);
    assert.match(headers["content-type"] ?? "", /application\/json/);
    const body = JSON.parse(text);
    assert.equal(body.length, 1);
    assert.deepEqual(body[0].relation, ["delegate_permission/common.handle_all_urls"]);
    assert.equal(body[0].target.package_name, "com.passporttravelbuddy.app");
    assert.deepEqual(body[0].target.sha256_cert_fingerprints, ["AA:BB:CC", "DD:EE:FF"]);
  });
});

// ── C. public share page ─────────────────────────────────────────────────────

describe("C: GET /u/:username for a public profile", () => {
  it("renders og tags, the deep-link button, and the passport og-image URL", async () => {
    _setTestServiceClient(makeFakeSc({
      profile: publicProfile(),
      // Owner opted in to showing their real name.
      privacyRows: [{ user_id: USER_ID, show_real_name: true, profile_visibility: "public" }],
    }) as any);

    const { status, headers, text } = await getReq("/u/wanderer");
    assert.equal(status, 200);
    assert.match(headers["content-type"] ?? "", /text\/html/);
    assert.match(headers["cache-control"] ?? "", /max-age=300/);

    assert.match(text, /<meta property="og:title" content="Wan Derer · Portava Passport"\/>/);
    assert.match(text, /<meta property="og:description" content="Chasing sunsets\."\/>/);
    assert.match(text, /og:image" content="[^"]*\/api\/users\/wanderer\/og-image\.png"/);
    assert.match(text, /href="travelbuddy:\/\/passport\/@wanderer"/, "deep-link button present");
    assert.match(text, /App Store or Google Play/, "store-fallback copy present");
  });

  it("shows @handle (not the real name) when the owner has not opted in", async () => {
    _setTestServiceClient(makeFakeSc({
      profile: publicProfile(),
      privacyRows: [], // no privacy row → show_real_name defaults to false
    }) as any);

    const { status, text } = await getReq("/u/wanderer");
    assert.equal(status, 200);
    assert.match(text, /og:title" content="@wanderer · Portava Passport"/);
    assert.ok(!text.includes("Wan Derer"), "real name must not leak without opt-in");
  });

  it("HTML-escapes attacker-controlled profile fields", async () => {
    _setTestServiceClient(makeFakeSc({
      profile: publicProfile({
        display_name: `<script>alert(1)</script>`,
        bio: `"><img src=x onerror=alert(2)>`,
      }),
      privacyRows: [{ user_id: USER_ID, show_real_name: true, profile_visibility: "public" }],
    }) as any);

    const { status, text } = await getReq("/u/wanderer");
    assert.equal(status, 200);
    assert.ok(!text.includes("<script>alert(1)</script>"), "script tag must be escaped");
    assert.ok(!text.includes(`"><img src=x onerror=alert(2)>`), "attribute breakout must be escaped");
    assert.match(text, /&lt;script&gt;/, "escaped entities present");
  });

  it("/passport/:username serves the same share page", async () => {
    _setTestServiceClient(makeFakeSc({
      profile: publicProfile(),
      privacyRows: [],
    }) as any);

    const { status, text } = await getReq("/passport/wanderer");
    assert.equal(status, 200);
    assert.match(text, /og:title" content="@wanderer · Portava Passport"/);
  });
});

// ── D. unknown + private profiles ────────────────────────────────────────────

describe("D: unknown and non-public profiles", () => {
  it("returns a 404 page for an unknown handle", async () => {
    _setTestServiceClient(makeFakeSc({ profile: null }) as any);

    const { status, headers, text } = await getReq("/u/ghost_handle");
    assert.equal(status, 404);
    assert.match(headers["content-type"] ?? "", /text\/html/);
    assert.match(text, /Traveler not found/);
  });

  it("returns 404 for an unusable (fully sanitised-away) handle", async () => {
    _setTestServiceClient(makeFakeSc({ profile: null }) as any);
    const { status } = await getReq("/u/%2e%2e%2f");
    assert.equal(status, 404);
  });

  it("serves the generic card (no name/bio leak) for a private profile", async () => {
    _setTestServiceClient(makeFakeSc({
      profile: publicProfile({ is_private: true, passport_visibility: "private" }),
      privacyRows: [{ user_id: USER_ID, show_real_name: true, profile_visibility: "private" }],
    }) as any);

    const { status, text } = await getReq("/u/wanderer");
    assert.equal(status, 200, "private profiles must not 404 (that would leak account state)");
    assert.match(text, /og:title" content="Portava Passport"/, "generic title");
    assert.ok(!text.includes("Wan Derer"), "name must not leak");
    assert.ok(!text.includes("Chasing sunsets"), "bio must not leak");
    assert.match(text, /noindex/, "generic pages are noindex'd");
    assert.match(text, /\/api\/users\/_\/og-image\.png/, "username-less generic og-image");
  });
});

// ── E. entity catch-all ──────────────────────────────────────────────────────

const EID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** The generic card, asserted the same way everywhere it must appear. */
function assertGenericCard(status: number, text: string, secret?: string) {
  assert.equal(status, 200, "entity pages never 404 — that would leak existence");
  assert.match(text, /<meta property="og:title" content="Portava"\/>/, "generic og:title");
  assert.match(text, /noindex/, "generic cards are noindex'd");
  assert.match(text, /\/api\/users\/_\/og-image\.png/, "generic brand og:image");
  if (secret) assert.ok(!text.includes(secret), `must not leak: ${secret}`);
}

describe("E: entity share landing pages", () => {
  // ── public entities render their own title ────────────────────────────────

  it("renders a public post's content as the title and description", async () => {
    _setTestServiceClient(makeEntitySc({
      posts: [{
        id: EID, content: "Sunrise over Batad rice terraces.",
        visibility: "public", status: "active", post_status: "published", deleted_at: null,
      }],
    }) as any);

    const { status, headers, text } = await getReq(`/posts/${EID}`);
    assert.equal(status, 200);
    assert.match(headers["content-type"] ?? "", /text\/html/);
    assert.match(headers["cache-control"] ?? "", /max-age=300/);
    assert.match(text, /og:title" content="Sunrise over Batad rice terraces\. · Portava"/);
    assert.match(text, /og:description" content="Sunrise over Batad rice terraces\."/);
    assert.match(text, /<meta property="og:type" content="website"\/>/);
    assert.ok(!text.includes("noindex"), "a public entity page is indexable");
  });

  it("renders a public trip and points the button at the singular app route", async () => {
    _setTestServiceClient(makeEntitySc({
      trips: [{
        id: EID, title: "Luzon loop", visibility: "public", status: "planning",
        destination_city: "Manila", destination_country: "Philippines", show_destination_city: true,
      }],
    }) as any);

    const { status, text } = await getReq(`/trips/${EID}`);
    assert.equal(status, 200);
    assert.match(text, /og:title" content="Luzon loop · Portava"/);
    assert.match(text, /og:description" content="A trip to Manila, Philippines on Portava\."/);
    // Web path is plural (/trips/:id), the expo-router screen is app/trip/[id].
    assert.match(text, new RegExp(`href="travelbuddy://trip/${EID}"`), "deep link uses the app segment");
    assert.match(text, new RegExp(`og:url" content="http[^"]*/trips/${EID}"`), "og:url keeps the web segment");
  });

  it("renders a public event, place, memory and stamp", async () => {
    _setTestServiceClient(makeEntitySc({
      events: [{ id: EID, title: "Jazz Night", description: "Live sets until 2am.", visibility: "public", state: "open", city: "Lisbon", country: "PT" }],
    }) as any);
    let r = await getReq(`/event/${EID}`);
    assert.match(r.text, /og:title" content="Jazz Night · Portava"/);
    assert.match(r.text, /og:description" content="Live sets until 2am\."/);

    _setTestServiceClient(makeEntitySc({
      places: [{ id: EID, name: "Time Out Market", city: "Lisbon", country_code: "PT", status: "active", merged_into_place_id: null }],
    }) as any);
    r = await getReq(`/place/${EID}`);
    assert.match(r.text, /og:title" content="Time Out Market · Portava"/);
    assert.match(r.text, /og:description" content="Lisbon, PT — on Portava\."/);

    _setTestServiceClient(makeEntitySc({
      memories: [{ id: EID, title: "First night out", caption: "We got lost twice.", visibility: "public", state: "published", location_city: "Lisbon", location_country: "PT" }],
    }) as any);
    r = await getReq(`/memory/${EID}`);
    assert.match(r.text, /og:title" content="First night out · Portava"/);

    _setTestServiceClient(makeEntitySc({
      user_stamps: [{ id: EID, title_override: null, visibility: "public", is_revoked: false, city: "Lisbon", country: "PT", stamp_definition_id: "def-1" }],
      stamp_definitions: [{ id: "def-1", name: "Lisbon Explorer" }],
    }) as any);
    r = await getReq(`/stamp/${EID}`);
    assert.match(r.text, /og:title" content="Lisbon Explorer · Portava Passport"/, "falls back to the catalog name");
  });

  // ── private entities ──────────────────────────────────────────────────────

  it("serves the generic card for a private post, trip, event, memory and stamp", async () => {
    _setTestServiceClient(makeEntitySc({
      posts: [{ id: EID, content: "SECRET-POST", visibility: "private", status: "active", post_status: "published", deleted_at: null }],
    }) as any);
    let r = await getReq(`/posts/${EID}`);
    assertGenericCard(r.status, r.text, "SECRET-POST");

    _setTestServiceClient(makeEntitySc({
      trips: [{ id: EID, title: "SECRET-TRIP", visibility: "buddies", status: "planning", destination_city: "Manila", destination_country: "PH", show_destination_city: true }],
    }) as any);
    r = await getReq(`/trips/${EID}`);
    assertGenericCard(r.status, r.text, "SECRET-TRIP");

    _setTestServiceClient(makeEntitySc({
      events: [{ id: EID, title: "SECRET-EVENT", description: null, visibility: "invite_only", state: "open", city: null, country: null }],
    }) as any);
    r = await getReq(`/event/${EID}`);
    assertGenericCard(r.status, r.text, "SECRET-EVENT");

    _setTestServiceClient(makeEntitySc({
      memories: [{ id: EID, title: "SECRET-MEMORY", caption: null, visibility: "only_me", state: "published", location_city: null, location_country: null }],
    }) as any);
    r = await getReq(`/memory/${EID}`);
    assertGenericCard(r.status, r.text, "SECRET-MEMORY");

    _setTestServiceClient(makeEntitySc({
      user_stamps: [{ id: EID, title_override: "SECRET-STAMP", visibility: "friends_only", is_revoked: false, city: null, country: null, stamp_definition_id: null }],
    }) as any);
    r = await getReq(`/stamp/${EID}`);
    assertGenericCard(r.status, r.text, "SECRET-STAMP");
  });

  it("does not reveal a trip's destination when the owner hid it", async () => {
    _setTestServiceClient(makeEntitySc({
      trips: [{ id: EID, title: "Luzon loop", visibility: "public", status: "planning", destination_city: "Manila", destination_country: "Philippines", show_destination_city: false }],
    }) as any);
    const { status, text } = await getReq(`/trips/${EID}`);
    assert.equal(status, 200);
    assert.match(text, /og:title" content="Luzon loop · Portava"/, "the title is still public");
    assert.ok(!text.includes("Manila"), "show_destination_city=false must be honoured");
  });

  // ── deleted / withdrawn entities ──────────────────────────────────────────

  it("serves the generic card for deleted, cancelled, revoked and merged entities", async () => {
    _setTestServiceClient(makeEntitySc({
      posts: [{ id: EID, content: "DELETED-POST", visibility: "public", status: "active", post_status: "published", deleted_at: "2026-01-01T00:00:00Z" }],
    }) as any);
    let r = await getReq(`/posts/${EID}`);
    assertGenericCard(r.status, r.text, "DELETED-POST");

    _setTestServiceClient(makeEntitySc({
      posts: [{ id: EID, content: "REMOVED-POST", visibility: "public", status: "deleted", post_status: "published", deleted_at: null }],
    }) as any);
    r = await getReq(`/posts/${EID}`);
    assertGenericCard(r.status, r.text, "REMOVED-POST");

    _setTestServiceClient(makeEntitySc({
      posts: [{ id: EID, content: "UNPUBLISHED-POST", visibility: "public", status: "active", post_status: "pending_delay", deleted_at: null }],
    }) as any);
    r = await getReq(`/posts/${EID}`);
    assertGenericCard(r.status, r.text, "UNPUBLISHED-POST");

    _setTestServiceClient(makeEntitySc({
      events: [{ id: EID, title: "CANCELLED-EVENT", description: null, visibility: "public", state: "cancelled", city: null, country: null }],
    }) as any);
    r = await getReq(`/event/${EID}`);
    assertGenericCard(r.status, r.text, "CANCELLED-EVENT");

    _setTestServiceClient(makeEntitySc({
      trips: [{ id: EID, title: "ARCHIVED-TRIP", visibility: "public", status: "archived", destination_city: null, destination_country: null, show_destination_city: true }],
    }) as any);
    r = await getReq(`/trips/${EID}`);
    assertGenericCard(r.status, r.text, "ARCHIVED-TRIP");

    _setTestServiceClient(makeEntitySc({
      memories: [{ id: EID, title: "DRAFT-MEMORY", caption: null, visibility: "public", state: "draft", location_city: null, location_country: null }],
    }) as any);
    r = await getReq(`/memory/${EID}`);
    assertGenericCard(r.status, r.text, "DRAFT-MEMORY");

    _setTestServiceClient(makeEntitySc({
      user_stamps: [{ id: EID, title_override: "REVOKED-STAMP", visibility: "public", is_revoked: true, city: null, country: null, stamp_definition_id: null }],
    }) as any);
    r = await getReq(`/stamp/${EID}`);
    assertGenericCard(r.status, r.text, "REVOKED-STAMP");

    _setTestServiceClient(makeEntitySc({
      places: [{ id: EID, name: "MERGED-PLACE", city: null, country_code: null, status: "duplicate", merged_into_place_id: "other" }],
    }) as any);
    r = await getReq(`/place/${EID}`);
    assertGenericCard(r.status, r.text, "MERGED-PLACE");
  });

  // ── unknown / malformed ids, and failure modes ────────────────────────────

  it("serves the generic card for an unknown id on every segment", async () => {
    _setTestServiceClient(makeEntitySc({}) as any);
    for (const seg of ["posts", "trips", "event", "place", "memory", "stamp"]) {
      const { status, text } = await getReq(`/${seg}/${EID}`);
      assertGenericCard(status, text);
    }
  });

  it("byte-identical output for unknown vs private, so existence cannot be probed", async () => {
    _setTestServiceClient(makeEntitySc({}) as any);
    const unknown = await getReq(`/posts/${EID}`);

    _setTestServiceClient(makeEntitySc({
      posts: [{ id: EID, content: "SECRET", visibility: "private", status: "active", post_status: "published", deleted_at: null }],
    }) as any);
    const priv = await getReq(`/posts/${EID}`);

    assert.equal(unknown.status, priv.status);
    assert.equal(unknown.text, priv.text, "the two responses must be indistinguishable");
  });

  it("serves the generic card for a malformed id without touching the database", async () => {
    // throwOn: any from() call is a failure — a non-UUID must short-circuit first.
    _setTestServiceClient(makeEntitySc({}, "posts") as any);
    const { status, text } = await getReq("/posts/not-a-uuid");
    assertGenericCard(status, text);
  });

  it("serves the generic card, not a 500, when the lookup throws", async () => {
    _setTestServiceClient(makeEntitySc({}, "events") as any);
    const { status, text } = await getReq(`/event/${EID}`);
    assertGenericCard(status, text);
  });

  it("serves the generic card when the service client is unavailable", async () => {
    _setTestServiceClient(null as any);
    const { status, text } = await getReq(`/place/${EID}`);
    assertGenericCard(status, text);
  });

  it("HTML-escapes entity text pulled from user content", async () => {
    _setTestServiceClient(makeEntitySc({
      events: [{
        id: EID, title: `<script>alert(1)</script>`, description: `"><img src=x onerror=alert(2)>`,
        visibility: "public", state: "open", city: null, country: null,
      }],
    }) as any);
    const { status, text } = await getReq(`/event/${EID}`);
    assert.equal(status, 200);
    assert.ok(!text.includes("<script>alert(1)</script>"), "script tag must be escaped");
    assert.ok(!text.includes(`"><img src=x onerror=alert(2)>`), "attribute breakout must be escaped");
    assert.match(text, /&lt;script&gt;/);
  });

  it("leaves the profile pages' 404 behaviour alone", async () => {
    _setTestServiceClient(makeFakeSc({ profile: null }) as any);
    const { status } = await getReq("/u/ghost_handle");
    assert.equal(status, 404, "handles are an enumerable namespace — unchanged");
  });
});
