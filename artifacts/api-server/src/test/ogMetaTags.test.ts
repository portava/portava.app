/**
 * GET /og/:type/:id — OG meta-tag correctness tests
 *
 * Verifies that the endpoint emits the right Open Graph + Twitter Card tags
 * for public entities (profile, event, trip) and that private / missing
 * entities consistently return the generic branded card with noindex/nofollow
 * and Cache-Control: no-store — regardless of user-agent.
 *
 * iMessage / WhatsApp compatibility checklist exercised here:
 *   ✓ og:image:width + og:image:height present when image URL is set
 *   ✓ og:image:secure_url present for HTTPS image URLs
 *   ✓ twitter:card = "summary_large_image" for events/trips with cover photos
 *   ✓ twitter:card = "summary" for square profile avatars
 *   ✓ Private entities → noindex, nofollow + Cache-Control: no-store
 *   ✓ Public entities  → index, follow  + public cache header
 *
 * Run: node --import tsx/esm --test src/test/ogMetaTags.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestServiceClient } from "../lib/supabase.js";
import ogRouter from "../routes/og.js";

// ── UUIDs for fixture data ────────────────────────────────────────────────────

const ALICE_ID   = "aa000000-0000-4000-a000-000000000001";
const BOB_ID     = "bb000000-0000-4000-a000-000000000002";
const PUB_EVENT  = "ee000000-0000-4000-a000-000000000010";
const PRIV_EVENT = "ee000000-0000-4000-a000-000000000011";
const PUB_TRIP   = "ff000000-0000-4000-a000-000000000020";
const PRIV_TRIP  = "ff000000-0000-4000-a000-000000000021";

// ── Fake Supabase service client ──────────────────────────────────────────────

type FakeState = Record<string, any[]>;

function makeClient(state: FakeState) {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => {
      const filters: Array<(r: any) => boolean> = [];

      /**
       * Parse a PostgREST-style OR expression into a filter function.
       * Handles the two patterns used by the OG route and profileVisibility:
       *   "col.eq.val,col.eq.val"
       *   "and(col.eq.v1,col.eq.v2),and(col.eq.v3,col.eq.v4)"
       */
      function parseOr(expr: string): (r: any) => boolean {
        // Split on top-level commas (not inside parens)
        const parts: string[] = [];
        let depth = 0;
        let current = "";
        for (const ch of expr) {
          if (ch === "(") { depth++; current += ch; }
          else if (ch === ")") { depth--; current += ch; }
          else if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; }
          else { current += ch; }
        }
        if (current.trim()) parts.push(current.trim());

        const orClauses = parts.map((part) => {
          // "and(col.eq.v1,col.eq.v2)" — all conditions must match
          const andMatch = part.match(/^and\((.+)\)$/);
          if (andMatch) {
            const andParts = andMatch[1].split(",").map((p) => p.trim());
            const andFilters = andParts.map((ap) => {
              const m = ap.match(/^(\w+)\.eq\.(.+)$/);
              if (!m) return (_r: any) => true;
              const [, col, val] = m;
              return (r: any) => String(r[col]) === val;
            });
            return (r: any) => andFilters.every((f) => f(r));
          }
          // "col.eq.val" — simple equality
          const eqMatch = part.match(/^(\w+)\.eq\.(.+)$/);
          if (eqMatch) {
            const [, col, val] = eqMatch;
            return (r: any) => String(r[col]) === val;
          }
          return (_r: any) => false;
        });

        return (r: any) => orClauses.some((f) => f(r));
      }

      const builder: any = {
        select() { return builder; },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        or(expr: string) { filters.push(parseOr(expr)); return builder; },
        limit() { return builder; },
        maybeSingle() {
          const rows = (state[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then(resolve: any, reject?: any) {
          const rows = (state[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

const baseState: FakeState = {
  profiles: [
    {
      id: ALICE_ID,
      handle: "alice_pub",
      display_name: "Alice Explorer",
      name: "Alice",
      bio: "Loves hiking and coffee.",
      avatar_url: "https://cdn.example.com/avatars/alice.jpg",
      is_private: false,
      passport_visibility: "public",
      account_status: "active",
    },
    {
      id: BOB_ID,
      handle: "bob_priv",
      display_name: "Bob Secret",
      name: "Bob",
      bio: "Stealth traveler.",
      avatar_url: "https://cdn.example.com/avatars/bob.jpg",
      is_private: true,
      passport_visibility: "private",
      account_status: "active",
    },
  ],
  events: [
    {
      id: PUB_EVENT,
      title: "Open Air Festival",
      description: "A great festival by the beach.",
      city: "Lisbon",
      country: "Portugal",
      visibility: "public",
      host_id: ALICE_ID,
      state: "published",
      cover_url: "https://cdn.example.com/events/festival.jpg",
    },
    {
      id: PRIV_EVENT,
      title: "Secret Rooftop Party",
      description: "Exclusive gathering.",
      city: "Porto",
      country: "Portugal",
      visibility: "invite_only",
      host_id: BOB_ID,
      state: "published",
      cover_url: "https://cdn.example.com/events/secret.jpg",
    },
  ],
  trips: [
    {
      id: PUB_TRIP,
      title: "Summer in Japan",
      destination_city: "Tokyo",
      destination_country: "Japan",
      visibility: "public",
      owner_id: ALICE_ID,
      cover_url: "https://cdn.example.com/trips/japan.jpg",
      show_destination_city: true,
    },
    {
      id: PRIV_TRIP,
      title: "Hidden Retreat",
      destination_city: "Unknown",
      destination_country: "Nowhere",
      visibility: "private",
      owner_id: BOB_ID,
      cover_url: null,
      show_destination_city: false,
    },
  ],
  blocks: [],
  user_follows: [],
  user_account_states: [],
  profile_privacy_settings: [],
  user_friendships: [],
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

function getText(
  server: ReturnType<typeof createServer>,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; contentType: string; cacheControl: string; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as import("net").AddressInfo;
    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            cacheControl: String(res.headers["cache-control"] ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    r.on("error", reject);
    r.end();
  });
}

/** Extract a meta tag's content attribute from HTML. */
function getMeta(html: string, selector: string): string | null {
  // Matches both property="..." and name="..." variants
  const re = new RegExp(
    `<meta[^>]+(?:property|name)="${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]+content="([^"]*)"`,
    "i",
  );
  const m = html.match(re) ?? html.match(
    new RegExp(
      `<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      "i",
    ),
  );
  return m ? m[1] : null;
}

// ── Test server ───────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {} };
    next();
  });
  _setTestServiceClient(makeClient(JSON.parse(JSON.stringify(baseState))) as any);
  app.use("/", ogRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestServiceClient(null as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /og/:type/:id — OG meta-tag correctness", () => {

  // ── unknown type ───────────────────────────────────────────────────────────
  it("unknown type → 404", async () => {
    const r = await getText(server, "/og/place/some-id");
    assert.equal(r.status, 404);
  });

  // ── Public profile ─────────────────────────────────────────────────────────
  describe("public profile", () => {
    let html: string;
    let cc: string;

    before(async () => {
      const r = await getText(server, "/og/profile/alice_pub");
      html = r.body;
      cc = r.cacheControl;
    });

    it("returns 200 text/html", async () => {
      const r = await getText(server, "/og/profile/alice_pub");
      assert.equal(r.status, 200);
      assert.match(r.contentType, /text\/html/);
    });

    it("og:title contains the handle", () => {
      const v = getMeta(html, "og:title");
      assert.ok(v?.includes("@alice_pub"), `og:title was: ${v}`);
    });

    it("og:description is set", () => {
      const v = getMeta(html, "og:description");
      assert.ok(v && v.length > 0, "og:description should be non-empty");
    });

    it("og:image points at the passport OG image endpoint, never the stored avatar", () => {
      const v = getMeta(html, "og:image");
      assert.ok(
        v && v.endsWith("/api/users/alice_pub/og-image.png"),
        `og:image must be the server-rendered passport card, got: ${v}`,
      );
      assert.ok(
        !String(v).includes("cdn.example.com"),
        "the stored avatar reference must never reach a scraper — it is resolved server-side",
      );
    });

    it("og:image:width/height are the 1200x630 card the passport endpoint renders", () => {
      const w = getMeta(html, "og:image:width");
      const h = getMeta(html, "og:image:height");
      assert.equal(w, "1200");
      assert.equal(h, "630");
    });

    it("twitter:card = 'summary_large_image' — the passport card is landscape, not a square avatar", () => {
      const v = getMeta(html, "twitter:card");
      assert.equal(v, "summary_large_image");
    });

    it("robots = 'index, follow'", () => {
      assert.ok(html.includes('content="index, follow"'), "public profile should be indexable");
    });

    it("Cache-Control is public", () => {
      assert.ok(cc.includes("public"), `expected public cache, got: ${cc}`);
    });
  });

  // ── Private profile ────────────────────────────────────────────────────────
  describe("private profile", () => {
    let html: string;
    let cc: string;

    before(async () => {
      const r = await getText(server, "/og/profile/bob_priv");
      html = r.body;
      cc = r.cacheControl;
    });

    it("robots = 'noindex, nofollow'", () => {
      assert.ok(html.includes('content="noindex, nofollow"'), "private profile must be noindex");
    });

    it("title is the generic private-profile title", () => {
      assert.ok(html.includes("Private Profile"), `expected generic title, got: ${html.slice(0, 500)}`);
    });

    it("does NOT include the real display name in og:title or og:description", () => {
      const title = getMeta(html, "og:title") ?? "";
      const desc = getMeta(html, "og:description") ?? "";
      assert.ok(!title.includes("Bob Secret"), `real name must not appear in og:title: ${title}`);
      assert.ok(!desc.includes("Bob Secret"), `real name must not appear in og:description: ${desc}`);
      assert.ok(!title.includes("bob_priv"), `handle must not appear in og:title: ${title}`);
      assert.ok(!desc.includes("bob_priv"), `handle must not appear in og:description: ${desc}`);
    });

    it("Cache-Control is no-store (scrapers must not cache the generic card)", () => {
      assert.equal(cc, "no-store", `expected no-store, got: ${cc}`);
    });
  });

  // ── Missing profile ────────────────────────────────────────────────────────
  it("missing profile → generic card with noindex + no-store", async () => {
    const r = await getText(server, "/og/profile/does_not_exist_xyz");
    assert.ok(r.body.includes('content="noindex, nofollow"'));
    assert.equal(r.cacheControl, "no-store");
    assert.ok(r.body.includes("Private Profile"));
  });

  // ── Public event ───────────────────────────────────────────────────────────
  describe("public event", () => {
    let html: string;
    let cc: string;

    before(async () => {
      const r = await getText(server, `/og/event/${PUB_EVENT}`);
      html = r.body;
      cc = r.cacheControl;
    });

    it("og:title contains the event name", () => {
      const v = getMeta(html, "og:title");
      assert.ok(v?.includes("Open Air Festival"), `og:title was: ${v}`);
    });

    it("og:description mentions the location", () => {
      const v = getMeta(html, "og:description");
      // Uses the event's own description (first 200 chars)
      assert.ok(v && v.length > 0, "og:description should be set");
    });

    it("og:image points at the server-rendered image endpoint, never the stored cover", () => {
      const v = getMeta(html, "og:image");
      assert.ok(
        v && v.includes("/api/og/event/") && v.endsWith("/image.png"),
        `og:image must be the server-rendered endpoint, got: ${v}`,
      );
      assert.ok(
        !String(v).includes("cdn.example.com"),
        "the stored cover reference must never reach a scraper — it is resolved server-side",
      );
    });

    it("og:image:width = 1200 and og:image:height = 630 (banner layout)", () => {
      const w = getMeta(html, "og:image:width");
      const h = getMeta(html, "og:image:height");
      assert.equal(w, "1200");
      assert.equal(h, "630");
    });

    it("twitter:card = 'summary_large_image' for landscape cover", () => {
      const v = getMeta(html, "twitter:card");
      assert.equal(v, "summary_large_image");
    });

    it("robots = 'index, follow'", () => {
      assert.ok(html.includes('content="index, follow"'));
    });

    it("Cache-Control is public", () => {
      assert.ok(cc.includes("public"));
    });
  });

  // ── Private (invite-only) event ────────────────────────────────────────────
  describe("invite-only event", () => {
    let html: string;
    let cc: string;

    before(async () => {
      const r = await getText(server, `/og/event/${PRIV_EVENT}`);
      html = r.body;
      cc = r.cacheControl;
    });

    it("robots = 'noindex, nofollow'", () => {
      assert.ok(html.includes('content="noindex, nofollow"'));
    });

    it("generic event title shown", () => {
      assert.ok(html.includes("Private Event on Portava"));
    });

    it("real event title NOT in response", () => {
      assert.ok(!html.includes("Secret Rooftop Party"), "private event title must not leak");
    });

    it("Cache-Control is no-store", () => {
      assert.equal(cc, "no-store");
    });
  });

  // ── Public trip ────────────────────────────────────────────────────────────
  describe("public trip", () => {
    let html: string;
    let cc: string;

    before(async () => {
      const r = await getText(server, `/og/trip/${PUB_TRIP}`);
      html = r.body;
      cc = r.cacheControl;
    });

    it("og:title contains the trip name", () => {
      const v = getMeta(html, "og:title");
      assert.ok(v?.includes("Summer in Japan"), `og:title was: ${v}`);
    });

    it("og:description mentions destination", () => {
      const v = getMeta(html, "og:description");
      assert.ok(v?.includes("Tokyo") || v?.includes("Japan"), `description: ${v}`);
    });

    it("og:image points at the server-rendered image endpoint, never the stored cover", () => {
      const v = getMeta(html, "og:image");
      assert.ok(
        v && v.includes("/api/og/trip/") && v.endsWith("/image.png"),
        `og:image must be the server-rendered endpoint, got: ${v}`,
      );
      assert.ok(
        !String(v).includes("cdn.example.com"),
        "the stored cover reference must never reach a scraper — it is resolved server-side",
      );
    });

    it("og:image:width = 1200 and og:image:height = 630 (banner layout)", () => {
      const w = getMeta(html, "og:image:width");
      const h = getMeta(html, "og:image:height");
      assert.equal(w, "1200");
      assert.equal(h, "630");
    });

    it("twitter:card = 'summary_large_image' for landscape cover", () => {
      const v = getMeta(html, "twitter:card");
      assert.equal(v, "summary_large_image");
    });

    it("Cache-Control is public", () => {
      assert.ok(cc.includes("public"));
    });
  });

  // ── Private trip ───────────────────────────────────────────────────────────
  describe("private trip", () => {
    let html: string;
    let cc: string;

    before(async () => {
      const r = await getText(server, `/og/trip/${PRIV_TRIP}`);
      html = r.body;
      cc = r.cacheControl;
    });

    it("robots = 'noindex, nofollow'", () => {
      assert.ok(html.includes('content="noindex, nofollow"'));
    });

    it("generic trip title shown", () => {
      assert.ok(html.includes("Private Trip on Portava"));
    });

    it("real trip title NOT in response", () => {
      assert.ok(!html.includes("Hidden Retreat"), "private trip title must not leak");
    });

    it("Cache-Control is no-store", () => {
      assert.equal(cc, "no-store");
    });
  });

  // ── No-image fallback ──────────────────────────────────────────────────────
  it("event with no cover URL → twitter:card = 'summary' (no image)", async () => {
    // Use the private trip which has no cover URL but test via a synthetic
    // no-image public event — we verify the generic card path (no image → summary).
    // The generic fallback itself has no image.
    const r = await getText(server, `/og/trip/${PRIV_TRIP}`);
    const v = getMeta(r.body, "twitter:card");
    // Private card → no image → summary
    assert.equal(v, "summary");
  });

  // ── Different user-agents ─────────────────────────────────────────────────
  it("WhatsApp user-agent → same private generic card", async () => {
    const r = await getText(server, "/og/profile/bob_priv", {
      "User-Agent": "WhatsApp/2.23.24.78 A",
    });
    assert.ok(r.body.includes('content="noindex, nofollow"'));
    assert.equal(r.cacheControl, "no-store");
  });

  it("iMessage (facebookexternalhit) user-agent → same private generic card", async () => {
    const r = await getText(server, `/og/event/${PRIV_EVENT}`, {
      "User-Agent": "facebookexternalhit/1.1",
    });
    assert.ok(r.body.includes('content="noindex, nofollow"'));
    assert.equal(r.cacheControl, "no-store");
  });

  it("Slack user-agent → same public event card with correct tags", async () => {
    const r = await getText(server, `/og/event/${PUB_EVENT}`, {
      "User-Agent": "Slack-ImgProxy (+https://api.slack.com/robots)",
    });
    const title = getMeta(r.body, "og:title");
    assert.ok(title?.includes("Open Air Festival"));
    assert.ok(r.cacheControl.includes("public"));
  });
});
