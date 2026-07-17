/**
 * /u/<username> share page — OG metadata visibility tests
 *
 * Locks in the privacy contract of serveProfileSharePage/fetchProfileCard:
 *   - public profile      → personalized og:title/description + per-user og-image URL
 *   - private profile     → generic tags + generic (username-less) og-image URL
 *   - blocked profile     → generic
 *   - unavailable account → generic
 *   - unknown user (404)  → generic
 *   - API failure         → generic
 *
 * Run: node --import tsx/esm --test server/serveProfileShare.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);

process.env.API_ORIGIN = "https://api.test";
const { serveProfileSharePage, fetchProfileCard } = require2("./serve.js");

const APP_NAME = "Travel Buddy";
const GENERIC_TITLE = `${APP_NAME} Passport`;
const GENERIC_DESC = "A traveler&#39;s passport of trips, stamps &amp; postcards.";
const GENERIC_IMAGE = "https://api.test/api/users/_/og-image.png";

// ── Helpers ───────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

/** Stub global fetch to return the given profile-card JSON (or an error). */
function stubFetch(handler: () => Promise<{ ok: boolean; json?: any }>) {
  globalThis.fetch = (async () => {
    const r = await handler();
    return {
      ok: r.ok,
      json: async () => r.json,
    } as any;
  }) as any;
}

function fakeReq() {
  return {
    method: "GET",
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "share.test" },
  } as any;
}

function fakeRes() {
  const chunks: string[] = [];
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      Object.assign(res.headers, headers ?? {});
    },
    end(data?: string) {
      if (data) chunks.push(String(data));
      res.body = chunks.join("");
    },
    body: "",
  };
  return res;
}

async function render(username: string): Promise<{ html: string; headers: Record<string, string> }> {
  const res = fakeRes();
  await serveProfileSharePage(fakeReq(), res, username, APP_NAME);
  assert.equal(res.statusCode, 200);
  return { html: res.body as string, headers: res.headers };
}

const NO_STORE = "no-store, no-cache, must-revalidate";
const GENERIC_CACHE = "public, max-age=300";

function cacheControlOf(headers: Record<string, string>): string {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "cache-control");
  return key ? headers[key] : "";
}

function metaContent(html: string, property: string): string | null {
  const m = new RegExp(
    `<meta (?:property|name)="${property}" content="([^"]*)"`,
  ).exec(html);
  return m ? m[1] : null;
}

async function renderGeneric(username: string): Promise<string> {
  const { html, headers } = await render(username);
  assert.equal(
    cacheControlOf(headers),
    GENERIC_CACHE,
    "generic pages must stay publicly cacheable",
  );
  return html;
}

function assertGeneric(html: string, username: string) {
  assert.equal(metaContent(html, "og:title"), GENERIC_TITLE);
  assert.equal(metaContent(html, "og:description"), GENERIC_DESC);
  assert.equal(metaContent(html, "og:image"), GENERIC_IMAGE);
  assert.equal(metaContent(html, "twitter:image"), GENERIC_IMAGE);
  // Absolutely no personal data anywhere in the page.
  assert.ok(!html.includes("Secret"), "must not leak display name");
  assert.ok(
    !html.includes(`/users/${username}/og-image.png`),
    "must not point at the per-user og-image",
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("serveProfileSharePage OG metadata visibility", () => {
  it("legacy long display name is capped at 40 chars + ellipsis in title/description", async () => {
    const longName =
      "Bartholomew Maximilian Constantine von Hohenzollern-Sigmaringen III";
    stubFetch(async () => ({
      ok: true,
      json: {
        username: "barty",
        displayName: longName,
        tripCount: 1,
        stampCount: 0,
        visibility: "public",
      },
    }));
    const { html } = await render("barty");
    const title = metaContent(html, "og:title");
    assert.ok(title, "og:title present");
    assert.ok(!html.includes(longName), "raw legacy name must not appear");
    const capped = longName.slice(0, 40).trimEnd() + "\u2026";
    assert.equal(title, `${capped} \u00b7 ${APP_NAME} Passport`);
  });

  it("public profile → personalized title, description, and og-image URL", async () => {
    stubFetch(async () => ({
      ok: true,
      json: {
        username: "wanda",
        displayName: "Wanda Wanderer",
        bio: "Chasing sunsets",
        tripCount: 3,
        stampCount: 1,
        visibility: "public",
      },
    }));
    const { html, headers } = await render("wanda");
    assert.equal(
      cacheControlOf(headers),
      NO_STORE,
      "personalized page must send no-store cache headers",
    );
    assert.equal(metaContent(html, "og:title"), `Wanda Wanderer · ${APP_NAME} Passport`);
    assert.equal(
      metaContent(html, "og:description"),
      "3 trips · 1 stamp — Chasing sunsets",
    );
    assert.equal(
      metaContent(html, "og:image"),
      "https://api.test/api/users/wanda/og-image.png",
    );
    assert.equal(metaContent(html, "twitter:title"), `Wanda Wanderer · ${APP_NAME} Passport`);
  });

  it("public profile without bio → stats-only description", async () => {
    stubFetch(async () => ({
      ok: true,
      json: { username: "sam", displayName: "Sam", tripCount: 1, stampCount: 2, visibility: "public" },
    }));
    const { html, headers } = await render("sam");
    assert.equal(cacheControlOf(headers), NO_STORE);
    assert.equal(metaContent(html, "og:description"), `1 trip · 2 stamps on ${APP_NAME}.`);
  });

  it("private profile (private flag) → generic tags and generic og-image", async () => {
    stubFetch(async () => ({
      ok: true,
      json: {
        private: true,
        username: "hidden",
        displayName: "Secret Name",
        tripCount: 0,
        stampCount: 0,
        visibility: "private",
      },
    }));
    assertGeneric(await renderGeneric("hidden"), "hidden");
  });

  it('private profile (visibility:"private" only) → generic', async () => {
    stubFetch(async () => ({
      ok: true,
      json: { username: "hidden2", displayName: "Secret Two", visibility: "private" },
    }));
    assertGeneric(await renderGeneric("hidden2"), "hidden2");
  });

  it("blocked profile → generic", async () => {
    stubFetch(async () => ({ ok: true, json: { blocked: true } }));
    assertGeneric(await renderGeneric("blocky"), "blocky");
  });

  it("unavailable account → generic", async () => {
    stubFetch(async () => ({ ok: true, json: { unavailable: true } }));
    assertGeneric(await renderGeneric("gone"), "gone");
  });

  it("unknown user (API 404) → generic", async () => {
    stubFetch(async () => ({ ok: false }));
    assertGeneric(await renderGeneric("nobody"), "nobody");
  });

  it("API failure (network error) → generic", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as any;
    assertGeneric(await renderGeneric("whoever"), "whoever");
  });
});

// ── Stamp share variant ───────────────────────────────────────────────────────

const STAMP_ID = "3f2b8a1c-9d4e-4f6a-8b2c-1e5d7a9c0b34";

/**
 * Stub fetch with separate handlers for the profile endpoint and the stamp
 * preview endpoint, keyed on the URL.
 */
function stubFetchByUrl(handlers: {
  profile: () => Promise<{ ok: boolean; json?: any }>;
  stamp: () => Promise<{ ok: boolean; json?: any }>;
}) {
  globalThis.fetch = (async (url: string) => {
    const r = String(url).includes("/preview")
      ? await handlers.stamp()
      : await handlers.profile();
    return { ok: r.ok, json: async () => r.json } as any;
  }) as any;
}

async function renderWithStamp(
  username: string,
  stampId: string | null,
): Promise<{ html: string; headers: Record<string, string> }> {
  const res = fakeRes();
  await serveProfileSharePage(fakeReq(), res, username, APP_NAME, stampId);
  assert.equal(res.statusCode, 200);
  return { html: res.body as string, headers: res.headers };
}

const PUBLIC_CARD = {
  username: "wanda",
  displayName: "Wanda Wanderer",
  tripCount: 3,
  stampCount: 1,
  visibility: "public",
};

describe("serveProfileSharePage stamp share variant", () => {
  it("public profile + public stamp → stamp title, description, and stamp og-image", async () => {
    stubFetchByUrl({
      profile: async () => ({ ok: true, json: PUBLIC_CARD }),
      stamp: async () => ({
        ok: true,
        json: { label: "Golden Gate", city: "San Francisco" },
      }),
    });
    const { html, headers } = await renderWithStamp("wanda", STAMP_ID);
    assert.equal(cacheControlOf(headers), NO_STORE, "stamp page must be no-store");
    assert.equal(
      metaContent(html, "og:title"),
      `&quot;Golden Gate&quot; Stamp · ${APP_NAME}`,
    );
    assert.equal(
      metaContent(html, "og:description"),
      `Wanda Wanderer earned the &quot;Golden Gate&quot; passport stamp in San Francisco on ${APP_NAME}.`,
    );
    assert.equal(
      metaContent(html, "og:image"),
      `https://api.test/api/users/wanda/og-image.png?stamp=${STAMP_ID}`,
    );
  });

  it("public profile + 404 from the stamp preview endpoint → falls back to passport title", async () => {
    stubFetchByUrl({
      profile: async () => ({ ok: true, json: PUBLIC_CARD }),
      stamp: async () => ({ ok: false }),
    });
    const { html, headers } = await renderWithStamp("wanda", STAMP_ID);
    assert.equal(cacheControlOf(headers), NO_STORE);
    assert.equal(metaContent(html, "og:title"), `Wanda Wanderer · ${APP_NAME} Passport`);
    assert.ok(!html.includes("Stamp ·"), "must not render the stamp variant");
    assert.equal(
      metaContent(html, "og:image"),
      "https://api.test/api/users/wanda/og-image.png",
      "og-image must not carry the stamp query",
    );
  });

  it("public profile + blank/invalid stamp label → falls back to passport title", async () => {
    stubFetchByUrl({
      profile: async () => ({ ok: true, json: PUBLIC_CARD }),
      stamp: async () => ({ ok: true, json: { label: "   " } }),
    });
    const { html } = await renderWithStamp("wanda", STAMP_ID);
    assert.equal(metaContent(html, "og:title"), `Wanda Wanderer · ${APP_NAME} Passport`);
  });

  it("non-UUID stamp id → passport preview, stamp endpoint never contacted", async () => {
    let stampFetches = 0;
    stubFetchByUrl({
      profile: async () => ({ ok: true, json: PUBLIC_CARD }),
      stamp: async () => {
        stampFetches += 1;
        return { ok: true, json: { label: "Should Not Appear" } };
      },
    });
    const { html } = await renderWithStamp("wanda", "not-a-uuid");
    assert.equal(stampFetches, 0, "invalid stamp id must not hit the preview API");
    assert.equal(metaContent(html, "og:title"), `Wanda Wanderer · ${APP_NAME} Passport`);
    assert.ok(!html.includes("Should Not Appear"));
  });

  for (const [label, profileJson] of [
    ["private", { private: true, displayName: "Secret Name", visibility: "private" }],
    ["blocked", { blocked: true }],
    ["unavailable", { unavailable: true }],
  ] as const) {
    it(`${label} profile + stamp id → generic page, stamp label never leaks`, async () => {
      stubFetchByUrl({
        profile: async () => ({ ok: true, json: profileJson }),
        stamp: async () => ({
          ok: true,
          json: { label: "Secret Stamp Label", city: "Hidden City" },
        }),
      });
      const { html, headers } = await renderWithStamp("hidden", STAMP_ID);
      assert.equal(
        cacheControlOf(headers),
        GENERIC_CACHE,
        "generic page stays cacheable",
      );
      assert.equal(metaContent(html, "og:title"), GENERIC_TITLE);
      assert.equal(metaContent(html, "og:description"), GENERIC_DESC);
      assert.equal(metaContent(html, "og:image"), GENERIC_IMAGE);
      assert.ok(!html.includes("Secret Stamp Label"), "stamp label must not leak");
      assert.ok(!html.includes("Hidden City"), "stamp place must not leak");
      assert.ok(!html.includes("Secret"), "no personal data anywhere");
    });
  }

  it("unknown user (profile 404) + stamp id → generic even if preview returns data", async () => {
    stubFetchByUrl({
      profile: async () => ({ ok: false }),
      stamp: async () => ({ ok: true, json: { label: "Leaky Label" } }),
    });
    const { html } = await renderWithStamp("nobody", STAMP_ID);
    assert.equal(metaContent(html, "og:title"), GENERIC_TITLE);
    assert.ok(!html.includes("Leaky Label"));
  });
});

describe("fetchProfileCard", () => {
  it("returns parsed JSON on success", async () => {
    stubFetch(async () => ({ ok: true, json: { username: "ok" } }));
    assert.deepEqual(await fetchProfileCard("https://x.test", "ok"), { username: "ok" });
  });

  it("returns null on non-OK response", async () => {
    stubFetch(async () => ({ ok: false }));
    assert.equal(await fetchProfileCard("https://x.test", "missing"), null);
  });

  it("returns null (never throws) on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as any;
    assert.equal(await fetchProfileCard("https://x.test", "err"), null);
  });
});
