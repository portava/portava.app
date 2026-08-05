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
